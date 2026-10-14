import { existsSync, readFileSync } from "node:fs";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { MissedEventAlarm } from "./alarm.js";
import { parseReleaseNotes, UpdateAnnouncer } from "./announce.js";
import { MemoryBackup } from "./backup.js";
import { createCardActionHandler, createMessageHandler } from "./bot.js";
import { CardAnswerStore } from "./card-answers.js";
import { CatchUpPoller, HandledMessages } from "./catchup.js";
import { loadConfig, RELEASE_NOTES_FILE } from "./config.js";
import { createDocsApi, FeishuDocs } from "./docs.js";
import { DuplicateAsks } from "./duplicates.js";
import { createFeishuApi } from "./feishu.js";
import { ThreadFollower } from "./follow.js";
import { createFollowUp } from "./follow-up.js";
import { ThreadContextLoader } from "./history.js";
import { ImageReader } from "./images.js";
import { KnowledgeBase } from "./knowledge.js";
import { AiopsLessons } from "./knowledge-aiops.js";
import { BitableKnowledgeBackend, createBitableApi } from "./knowledge-bitable.js";
import { createOpenAICompatibleEmbedder, createOpenAICompatibleModel, createOpenAICompatibleVisionModel } from "./llm.js";
import { McpHub } from "./mcp.js";
import { MemoryStore } from "./memory.js";
import { ProactiveReplier } from "./proactive.js";
import { RecentThreadStore } from "./recent-threads.js";
import { CodeWorkspaces, createGitHubHost, createGitLabHost, runGit } from "./repo.js";
import { createCardKitApi } from "./stream-card.js";
import { TaskRegistry } from "./tasks.js";
import { CODE_TOOL_NAMES, createCodeTools } from "./tools/code.js";
import { KnowledgeDesk } from "./tools/knowledge.js";
import { createDocTools, DOC_TOOL_NAMES } from "./tools/docs.js";
import { createFetchUrlTool } from "./tools/fetch-url.js";
import { createWebSearchTool } from "./tools/web-search.js";
import { VERSION } from "./version.js";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
const config = loadConfig();

// Channel 是飞书 SDK 在长连接之上的封装：拉取机器人身份、识别 @、按消息 id 去重、丢弃过期重推、Markdown 转富文本发送
const channel = createLarkChannel({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  domain: config.feishu.domain,
  loggerLevel: LoggerLevel.info,
  // 群里没 @ 机器人的消息也交过来，由下面按跟聊和主动接话的规则筛（两个都关时一律不管）；@所有人 不响应；单聊暂不开
  policy: { requireMention: false, dmMode: "disabled" },
  // 关掉按群排队合并：同一个群里几个人同时 @，各自独立处理。同一话题里的任务由 TaskRegistry 排队
  safety: { chatQueue: { enabled: false } },
});

const tasks = new TaskRegistry();
const tools = [
  createFetchUrlTool(),
  ...(config.webSearch ? [createWebSearchTool({ ...config.webSearch, apiKey: config.llm.apiKey })] : []),
];
const memory = new MemoryStore(config.memoryDir);
try {
  await memory.init();
} catch (err) {
  console.error(`群记忆目录 ${config.memoryDir} 建不了或不可写，请检查 DATA_DIR 和目录权限。`, err);
  process.exit(1);
}

const backup =
  config.memoryBackupDays > 0
    ? new MemoryBackup({ memoryDir: config.memoryDir, backupDir: config.memoryBackupDir, keepDays: config.memoryBackupDays })
    : undefined;

const feishuApi = createFeishuApi(channel.rawClient, config.feishu.appId, () => channel.botIdentity);
// 关掉 STREAM_CARD 以后，之前写在卡片里的回答照样能从这里读回话题历史
const cardAnswers = new CardAnswerStore(config.cardAnswersDir);
// 群成员在新话题里说「上面那个」时，模型用 chat_recent_threads 看本群最近几个话题的问答
const recentThreads = new RecentThreadStore(config.recentThreadsDir);
const docs = new FeishuDocs(createDocsApi(channel.rawClient), () => channel.botIdentity?.name ?? "机器人");
const workspaces = config.code ? await openCodeWorkspaces(config.code) : undefined;
// MCP 服务在后台连接，连上之前（或连不上时）的提问没有它的工具，不耽误机器人启动
const mcp = config.mcp.length > 0 ? new McpHub(config.mcp) : undefined;
void mcp?.start();
// 团队经验库存在飞书多维表格里：回答前先查，起草后发确认卡片，写权限名单里的人点了才写；排查经验同步一份到 aiops 经验库
const knowledgeTable = config.knowledge
  ? new BitableKnowledgeBackend({
      api: createBitableApi(channel.rawClient),
      stateFile: config.knowledge.stateFile,
      ...(config.knowledge.bitable ? { target: config.knowledge.bitable } : {}),
      share: {
        chatIds: [...config.feishu.allowedChatIds],
        editors: [...(config.feishu.writeAllowedUsers ?? [])],
      },
    })
  : undefined;
const knowledge = config.knowledge
  ? new KnowledgeDesk({
      base: new KnowledgeBase(
        knowledgeTable!,
        config.knowledge.embeddingModel
          ? { embedder: createOpenAICompatibleEmbedder({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey, model: config.knowledge.embeddingModel }) }
          : {},
      ),
      ...(mcp?.names.includes("aiops") ? { aiops: new AiopsLessons(mcp, "aiops") } : {}),
      send: (to, input, opts) => channel.send(to, input, opts),
      updateCard: (messageId, card) => channel.updateCard(messageId, card),
      ...(config.feishu.writeAllowedUsers ? { approvers: config.feishu.writeAllowedUsers } : {}),
      allowedChatIds: config.feishu.allowedChatIds,
    })
  : undefined;
// 提问里的截图先交给看图模型转成文字
const images = config.vision
  ? new ImageReader({
      download: (messageId, imageKey) => feishuApi.downloadImage(messageId, imageKey),
      vision: createOpenAICompatibleVisionModel({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey, ...config.vision }),
    })
  : undefined;
const model = createOpenAICompatibleModel(config.llm);
/** 在这条消息下面开话题回一句（跟聊、主动接话的简短回复） */
const replyInThread = (msg: NormalizedMessage, markdown: string) =>
  channel.send(msg.chatId, { markdown }, { replyTo: msg.messageId, replyInThread: true });
// 在群里直接 @ 时带上群里刚才的聊天（CHAT_CONTEXT）
const context = new ThreadContextLoader(feishuApi, console, undefined, cardAnswers, config.chatContext);
const handleMessage = createMessageHandler({
  model,
  tools,
  // 文档和代码工具按任务创建：新建的文档要共享给当前群和发起人，代码的工作目录按话题分
  taskTools: ({ chatId, senderId, threadKey, askerName }) => [
    ...createDocTools({ docs, chatId, requesterOpenId: senderId }),
    ...(workspaces
      ? createCodeTools({ workspaces, threadKey, askerName, botName: () => channel.botIdentity?.name ?? "机器人" })
      : []),
  ],
  allowedChatIds: config.feishu.allowedChatIds,
  // 群主界面说「别主动插话」开关主动接话，话题里说「只在 @ 我时回」停掉跟聊（下面创建，收到消息时已经有了）
  command: (msg) => proactive.toggle(msg) ?? follower?.mute(msg),
  ...(workspaces ? { codeRepos: workspaces.repos } : {}),
  ...(config.feishu.writeAllowedUsers ? { writeAllowed: config.feishu.writeAllowedUsers } : {}),
  ...(mcp ? { mcp } : {}),
  ...(knowledge ? { knowledge } : {}),
  ...(images ? { images } : {}),
  showThinking: config.showThinking,
  about: aboutBot(),
  ...(config.streamCard ? { cardKit: createCardKitApi(channel.rawClient), cardAnswers } : {}),
  botName: () => channel.botIdentity?.name,
  context,
  recentThreads,
  memory,
  tasks,
  send: (to, input, opts) => channel.send(to, input, opts),
  updateCard: (messageId, card) => channel.updateCard(messageId, card),
});

// 话题里跟聊：机器人回答过的话题里，没 @ 它的追问先判断是不是对它说的，是才回
const follower = config.followThreads
  ? new ThreadFollower({
      allowedChatIds: config.feishu.allowedChatIds,
      context,
      model,
      botName: () => channel.botIdentity?.name,
      botOpenId: () => channel.botIdentity?.openId,
      busy: (threadKey) => tasks.busy(threadKey),
      // 没 @ 的话不给改文档、改代码的工具：要改就 @ 机器人直接说
      handle: (msg) => handleMessage(msg, { unaddressed: true }),
      reply: replyInThread,
    })
  : undefined;
// 主动接话：PROACTIVE_CHAT_IDS 里的群，群主界面没 @ 的消息看情况接一句；接了以后那个话题交给跟聊
const proactive = new ProactiveReplier({
  allowedChatIds: config.feishu.allowedChatIds,
  enabledChatIds: config.proactive.chatIds,
  stateFile: config.proactive.stateFile,
  maxPerHour: config.proactive.maxPerHour,
  api: feishuApi,
  memory,
  model,
  botName: () => channel.botIdentity?.name,
  botOpenId: () => channel.botIdentity?.openId,
  reply: replyInThread,
  onReplied: (msg) => follower?.track(msg),
  // 话题里勾了「同时发送到群」的追问，群里那份不再主动接话：话题里那份归跟聊
  superseded: (msg) => unaddressedTwins.hasThreadTwin(msg),
});
await proactive.init();
/** @ 了机器人的消息：照常回答（开关类的话由 command 先处理），之后跟着这个话题；同一话题里排在还在判断的没 @ 的消息后面 */
const answerMention = (msg: NormalizedMessage): Promise<void> =>
  follower ? follower.answerInTurn(msg, () => handleMessage(msg)) : handleMessage(msg);
/** 没 @ 机器人的群消息归谁判断：跟着的话题里的归跟聊，群主界面的归主动接话，都不要就不管 */
const listenerFor = (msg: NormalizedMessage, fromApp = false) =>
  follower?.wants(msg, fromApp) ? follower : proactive.wants(msg, fromApp) ? proactive : undefined;
// 话题里勾了「同时发送到群」，没 @ 的话也会收到两份：只判断一份
const unaddressedTwins = new DuplicateAsks(Date.now, true);
const considerUnaddressed = async (msg: NormalizedMessage, listener: { consider(msg: NormalizedMessage): Promise<void> }) => {
  const verdict = unaddressedTwins.check(msg);
  if (verdict.action === "skip") {
    console.log(`没 @ 的消息 ${msg.messageId} 和 ${verdict.duplicateOf} 是同一句话（多半勾了「同时发送到群」），只判断一份`);
    return;
  }
  await listener.consider(msg);
};

// 事件和补漏轮询可能拿到同一条消息，谁先认领谁处理
const handled = new HandledMessages();
const alarm = new MissedEventAlarm({
  notify: (chatId, text) => channel.send(chatId, { markdown: text }),
  chatId: config.alertChatId,
});
const catchUp = new CatchUpPoller({
  api: feishuApi,
  chatIds: config.feishu.allowedChatIds,
  handled,
  handle: (msg) => {
    alarm.record(msg);
    return answerMention(msg);
  },
  // 补上的消息也让主动接话知道群里有人说过话（判断完要回之前看一眼）
  observe: (msg) => proactive.noteActivity(msg),
  follow: {
    wants: (msg, fromApp) => listenerFor(msg, fromApp) !== undefined,
    consider: async (msg) => {
      const listener = listenerFor(msg);
      if (listener) {
        await considerUnaddressed(msg, listener);
      }
    },
  },
  intervalMs: config.catchUpIntervalMs || undefined,
});
channel.on("message", async (msg: NormalizedMessage) => {
  // 主动接话判断完要回之前，看判断的这会儿群里有没有人接了话
  proactive.noteActivity(msg);
  if (!msg.mentionedBot) {
    // 没 @ 机器人的：只看跟聊在跟的话题里的、打开了主动接话的群主界面的，别的（包括白名单外的群）一律不管，也不记日志
    const listener = listenerFor(msg);
    if (!listener || !handled.claim(msg.messageId)) {
      return;
    }
    catchUp.watch(msg);
    await considerUnaddressed(msg, listener);
    return;
  }
  if (!handled.claim(msg.messageId)) {
    // 轮询已经补上了这条：事件只是晚到，不是被别处分走
    alarm.arrivedLate(msg.messageId);
    console.log(`事件晚到，这条已由轮询处理 message=${msg.messageId}`);
    return;
  }
  catchUp.watch(msg);
  await answerMention(msg);
});
// 回答下面的「接着查」按钮：机器人替点的人在话题里发一句，再当成他问的处理（只给读的工具）
const followUp = createFollowUp({
  api: feishuApi,
  send: (to, input, opts) => channel.send(to, input, opts),
  handle: (msg, options) => {
    // 和收到的消息一样记进补漏轮询：点按钮可能让一个已经不再跟踪的话题又活了，后面的 @ 漏了事件还能补上
    catchUp.watch(msg);
    // 和 @ 的消息一样排在同一话题里还在判断的消息后面，之后跟着这个话题
    return follower ? follower.answerInTurn(msg, () => handleMessage(msg, options), false) : handleMessage(msg, options);
  },
});
channel.on("cardAction", createCardActionHandler({ tasks, allowedChatIds: config.feishu.allowedChatIds, followUp, ...(knowledge ? { knowledge } : {}) }));
channel.on("error", (err) => console.error(`[feishu] ${err.code}: ${err.message}`));

try {
  await channel.connect();
} catch (err) {
  console.error("连接飞书失败：请检查 FEISHU_APP_ID / FEISHU_APP_SECRET，以及应用是否已开启机器人能力并发布版本。", err);
  process.exit(1);
}
console.log(
  `飞书长连接已建立，版本 ${VERSION}，机器人「${channel.botIdentity?.name}」，模型 ${config.llm.model}，` +
    `工具 ${[...tools.map((tool) => tool.spec.name), ...DOC_TOOL_NAMES, ...(workspaces ? CODE_TOOL_NAMES : [])].join(", ")}，` +
    `群记忆存放在 ${config.memoryDir}`,
);
console.log(
  images
    ? `看图：提问里的图片先用 ${images.model} 识别成文字（MODEL_VISION_ID=off 可以关掉）`
    : "看图：没配看图模型，提问里的图片模型看不到，会请对方贴文字（MODEL_VISION_ID 填能看图的模型就能打开）",
);
if (config.llm.thinking !== undefined) {
  const budget = config.llm.thinkingBudget ? `，打开时最多想 ${config.llm.thinkingBudget} token` : "";
  console.log(`思考模式：${config.llm.thinking ? "开（回答更慢）" : "关（MODEL_THINKING=on 可以打开）"}${budget}`);
}
console.log(
  config.streamCard
    ? "卡片即回答：思考和回答边生成边写进进度卡片（要开 cardkit:card:write 权限，建不了卡片时自动退回原来的方式），STREAM_CARD=off 可以关掉"
    : "卡片即回答没开（STREAM_CARD=off）：进度卡片只显示进度，回答另外发",
);
console.log(
  follower
    ? "话题里跟聊：回答过的话题里，没 @ 的追问先判断是不是对机器人说的，是才回；话题里说「只在 @ 我时回」就不跟了（FOLLOW_THREADS=off 可以关掉）"
    : "话题里跟聊没开（FOLLOW_THREADS=off）：只回 @ 机器人的消息",
);
console.log(
  config.chatContext
    ? "群里直接 @ 时带上之前半小时内的群聊（最多 20 条），「看下上面那个报错」接得上（CHAT_CONTEXT=off 可以关掉）"
    : "群里直接 @ 时不带群聊（CHAT_CONTEXT=off）",
);
if (config.proactive.chatIds.size > 0) {
  const paused = [...config.proactive.chatIds].filter((chatId) => !proactive.active(chatId));
  console.log(
    `主动接话：群 ${[...config.proactive.chatIds].join(", ")} 里没 @ 的消息看情况接一句，每个群每小时最多 ${config.proactive.maxPerHour} 次` +
      (paused.length > 0 ? `；${paused.join(", ")} 有人说过「别主动插话」，现在停着（@ 机器人说「可以主动说话」再打开）` : ""),
  );
} else {
  console.log("主动接话没开：只回 @ 机器人的消息和跟着的话题（PROACTIVE_CHAT_IDS 填群的 chat_id 可以打开）");
}
if (config.proactive.ignored.length > 0) {
  console.warn(`PROACTIVE_CHAT_IDS 里这些群不在 FEISHU_ALLOWED_CHAT_IDS 里，不生效：${config.proactive.ignored.join(", ")}`);
}
if (config.catchUpIntervalMs > 0 && config.feishu.allowedChatIds.size > 0) {
  catchUp.start();
  console.log(
    `补漏轮询已开启，每 ${config.catchUpIntervalMs / 1000} 秒检查一次白名单群里有没有漏掉的 @；` +
      `30 分钟内补上 2 条以上会在${config.alertChatId ? `群 ${config.alertChatId}` : "漏消息的群"}里报警`,
  );
}
console.log(
  config.feishu.writeAllowedUsers
    ? `写权限：只有 ${config.feishu.writeAllowedUsers.size} 人能让机器人改文档、改代码（WRITE_ALLOWED_USERS），其他人只能问和读`
    : "写权限：群里所有人都能让机器人改文档、改代码。要限制就在 WRITE_ALLOWED_USERS 里填允许的人的 open_id",
);
if (config.webSearch) {
  console.log(`联网搜索已开启，用百炼的 ${config.webSearch.model} 搜索`);
} else {
  console.log("联网搜索没开：WEB_SEARCH=off，或者 MODEL_BASE_URL 不是百炼的 OpenAI 兼容接口（web_search 只支持百炼）");
}
if (workspaces) {
  console.log(`代码仓库已配置（${workspaces.host.name}）：${workspaces.repos.join(", ")}，工作目录在 ${config.code!.workspaceDir}`);
  void checkRepos(workspaces);
}
if (mcp) {
  console.log(`MCP 服务：${mcp.names.join(", ")}，在后台连接，连上后日志里有一行「MCP <名字>：已连上」`);
}
if (config.knowledge) {
  // 机器人建的表按现在的白名单群和写权限名单调整共享（移出名单的撤掉权限），在后台做
  void knowledgeTable?.syncSharing().catch((err: unknown) => console.warn("经验库：调整多维表格的共享失败", err));
  console.log(
    `团队经验库：存在飞书多维表格里（${config.knowledge.bitable?.url ?? "第一次保存经验时机器人自己建表"}），每个提问回答前先查一次` +
      `（${config.knowledge.embeddingModel ? `关键词加向量模型 ${config.knowledge.embeddingModel}` : "只按关键词"}）；` +
      "群里说「沉淀成经验」时机器人起草、发确认卡片，" +
      (config.feishu.writeAllowedUsers
        ? "写权限名单里的人点「保存」才写入"
        : "但没配写权限名单（WRITE_ALLOWED_USERS），现在只能查、不能存：经验库所有群共用，要先限定谁能确认") +
      (mcp?.names.includes("aiops") ? "；排查经验同步一份到 aiops 经验库" : ""),
  );
} else {
  console.log("团队经验库：已关闭（KNOWLEDGE=off）");
}
if (backup) {
  backup.start();
  console.log(`群记忆每天备份一次到 ${config.memoryBackupDir}，保留最近 ${config.memoryBackupDays} 天`);
}
// 部署新版本要重启：连上飞书后把 RELEASE_NOTES.md 里各群还没收到过的版本发过去，在后台做
const announcer =
  config.announce && config.announce.chatIds.length > 0
    ? new UpdateAnnouncer({
        ...config.announce,
        send: (to, input) => channel.send(to, input),
        botName: () => channel.botIdentity?.name,
      })
    : undefined;
if (announcer) {
  void announcer.run();
  const { chatIds, chatIdsFrom } = config.announce!;
  console.log(
    `更新通知：新版本部署后，把 RELEASE_NOTES.md 里还没发过的版本发到 ${chatIds.length} 个群 ${chatIds.join(", ")}` +
      (chatIdsFrom === "ANNOUNCE_CHAT_IDS"
        ? "（按 ANNOUNCE_CHAT_IDS）"
        : "（没配 ANNOUNCE_CHAT_IDS，发白名单里的所有群）") +
      "，ANNOUNCE=off 关掉",
  );
} else if (!config.announce) {
  console.log("更新通知：已关闭（ANNOUNCE=off）");
}
if (config.feishu.allowedChatIds.size === 0) {
  console.warn("FEISHU_ALLOWED_CHAT_IDS 未配置，不会响应任何群。在要启用的群里 @ 机器人，日志会打出该群的 chat_id。");
} else {
  console.log(`已启用的群：${[...config.feishu.allowedChatIds].join(", ")}`);
}

const shutdown = async () => {
  // 停掉进行中的任务，让它们把卡片更新成「已停止」再退出
  await catchUp.stop();
  await backup?.stop();
  // 正在发的更新通知发完再退出（最多等 5 秒），没发完的下次启动再发
  await Promise.race([announcer?.stop(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  tasks.stopAll();
  await tasks.idle(5000);
  // 已经点了确认、正在写经验库的，写完再退出（最多等 10 秒）
  await Promise.race([knowledge?.idle(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  await mcp?.stop();
  await channel.disconnect();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

/** 有人问「你能做什么」「最近更新了什么」时用：产品功能说明的链接、产品更新说明里最新的一版（部署新版本要重启，启动时读一次就够） */
function aboutBot(): { featuresLink?: string; latest?: ReturnType<typeof parseReleaseNotes>[number] } {
  let latest: ReturnType<typeof parseReleaseNotes>[number] | undefined;
  try {
    latest = parseReleaseNotes(readFileSync(RELEASE_NOTES_FILE, "utf8"))[0];
  } catch (err) {
    console.warn(`读不到 ${RELEASE_NOTES_FILE}，被问到最近更新了什么时答不上来`, err);
  }
  return { ...(config.featuresLink ? { featuresLink: config.featuresLink } : {}), ...(latest ? { latest } : {}) };
}

/** 启动时逐个检查令牌能不能访问配置的仓库，结果写进日志，免得配错了要等到群里用时才发现 */
async function checkRepos(workspaces: CodeWorkspaces): Promise<void> {
  const check = workspaces.host.checkAccess?.bind(workspaces.host);
  if (!check) {
    return;
  }
  await Promise.all(
    workspaces.repos.map(async (repo) => {
      try {
        const branch = workspaces.branches[repo];
        console.log(`代码仓库 ${repo}：${await check(repo)}${branch ? `，机器人默认看 ${branch} 分支` : ""}`);
      } catch (err) {
        console.warn(`代码仓库 ${repo} 访问不了：${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
}

/** 代码仓库工具要用 git。没装 git 时不开这些工具，别的照常 */
async function openCodeWorkspaces(code: NonNullable<typeof config.code>): Promise<CodeWorkspaces | undefined> {
  try {
    await runGit(["--version"]);
  } catch (err) {
    console.error("配了 CODE_REPOS，但服务器上跑不了 git，代码仓库工具先不开", err);
    return undefined;
  }
  const host = code.host.kind === "gitlab" ? createGitLabHost(code.host.url, code.host.token) : createGitHubHost(code.host.token);
  const workspaces = new CodeWorkspaces({ root: code.workspaceDir, host, repos: code.repos, branches: code.branches });
  // 几天没用的话题工作目录，启动时和之后每天清一次
  const sweep = () => workspaces.sweep().catch((err) => console.error("清理代码工作目录失败", err));
  void sweep();
  setInterval(sweep, 24 * 60 * 60_000).unref();
  return workspaces;
}
