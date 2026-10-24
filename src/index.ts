import { existsSync, readFileSync } from "node:fs";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { AdminDesk } from "./admin.js";
import { MissedEventAlarm } from "./alarm.js";
import { parseReleaseNotes, UpdateAnnouncer } from "./announce.js";
import { MemoryBackup } from "./backup.js";
import { type ChatScope, createCardActionHandler, createMessageHandler, dispatchCardAction } from "./bot.js";
import { CardAnswerStore } from "./card-answers.js";
import { CatchUpPoller, HandledMessages } from "./catchup.js";
import { FEATURES_FILE, loadConfig, RELEASE_NOTES_FILE } from "./config.js";
import { CONFIRM_WAIT_MS, WriteConfirms } from "./confirm.js";
import { createDocsApi, FeishuDocs } from "./docs.js";
import { DuplicateAsks } from "./duplicates.js";
import { createChatDirectory, createFeishuApi } from "./feishu.js";
import { JUDGE_MEMORY_CHARS, ThreadFollower } from "./follow.js";
import { createFollowUp } from "./follow-up.js";
import { GroupPolicies } from "./groups.js";
import { ThreadContextLoader } from "./history.js";
import { ImageReader } from "./images.js";
import { type FeatureList, parseFeatures } from "./features.js";
import { KnowledgeBase } from "./knowledge.js";
import { AiopsLessons } from "./knowledge-aiops.js";
import { BitableKnowledgeBackend, createBitableApi } from "./knowledge-bitable.js";
import { createOpenAICompatibleEmbedder, createOpenAICompatibleModel, createOpenAICompatibleVisionModel } from "./llm.js";
import { McpHub } from "./mcp.js";
import { createNameLookup } from "./operator-names.js";
import type { AboutBot } from "./prompt.js";
import { MemoryStore, renderMemoryForPrompt } from "./memory.js";
import { MAX_JUDGED_PER_HOUR, ProactiveReplier } from "./proactive.js";
import { RecentThreadStore } from "./recent-threads.js";
import { GroupSettings } from "./settings.js";
import { alertsCreator, describeSchedule, escapePost, label, mentionWhenDone, type RunResult, type ScheduleActor, type ScheduledTask, Scheduler } from "./schedules.js";
import { createBuildChecker } from "./build.js";
import { CodeWorkspaces, createGitHubHost, createGitLabHost, runGit } from "./repo.js";
import { createCardKitApi } from "./stream-card.js";
import { TaskRegistry } from "./tasks.js";
import { CHAT_HISTORY_TOOL, createChatHistoryTool } from "./tools/chat-history.js";
import { CODE_TOOL_NAMES, createCodeTools } from "./tools/code.js";
import { createScheduleTools, SCHEDULE_TOOL_NAMES } from "./tools/schedules.js";
import { KnowledgeDesk } from "./tools/knowledge.js";
import { createDocTools, DOC_TOOL_NAMES } from "./tools/docs.js";
import { createFetchUrlTool } from "./tools/fetch-url.js";
import { createWebSearchTool } from "./tools/web-search.js";
import { VERSION } from "./version.js";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
const config = loadConfig();
// 管理群的设置卡片上改的各群配置。没开管理群也照样读：卡片上收紧过的群，不会因为关掉管理群就悄悄放宽
const settings = new GroupSettings({ dir: config.settingsDir });
try {
  await settings.init();
} catch (err) {
  console.error(err instanceof Error ? err.message : `群配置目录 ${config.settingsDir} 读不了，请检查 DATA_DIR 和目录权限。`, err);
  process.exit(1);
}
// 按群的配置：每个群用哪些仓库、谁能改、能用哪些 MCP 工具、用不用经验库、主动接话。
// 管理群卡片上改的盖过 .env 里这个群的（GROUPS 加 GROUP_<名字>_…），都没写的项照全局
// 现在开通的群（groups.allowed）：服务器白名单加上管理群卡片上开通的、去掉停用的。各处都拿这一份，卡片上存了以后马上生效
const groups = new GroupPolicies(config, settings);

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
  // 带上原始事件：管理群设置卡片上表单里填的值，SDK 整理过的按钮事件里没有
  includeRawEvent: true,
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
// 管理群卡片上改的配置也每天备份一份，保留天数和群记忆一样
const settingsBackup =
  config.memoryBackupDays > 0 && (config.admin || settings.chatIds().length > 0 || settings.admins().size > 0)
    ? new MemoryBackup({
        memoryDir: config.settingsDir,
        backupDir: config.settingsBackupDir,
        keepDays: config.memoryBackupDays,
        label: "群配置",
        unit: "个文件",
      })
    : undefined;

const feishuApi = createFeishuApi(channel.rawClient, config.feishu.appId, () => channel.botIdentity);
// 卡片按钮回调里没有点的人的名字：经验库卡片、管理群设置卡片上写「谁点了」时去话题和通讯录里找
const nameOf = createNameLookup(feishuApi);
// 关掉 STREAM_CARD 以后，之前写在卡片里的回答照样能从这里读回话题历史
const cardAnswers = new CardAnswerStore(config.cardAnswersDir);
// 群成员在新话题里说「上面那个」时，模型用 chat_recent_threads 看本群最近几个话题的问答
const recentThreads = new RecentThreadStore(config.recentThreadsDir);
const docs = new FeishuDocs(createDocsApi(channel.rawClient), () => channel.botIdentity?.name ?? "机器人");
const workspaces = config.code ? await openCodeWorkspaces(config.code, groups.repoEntries()) : undefined;
// MCP 服务在后台连接，连上之前（或连不上时）的提问没有它的工具，不耽误机器人启动
const mcp = config.mcp.length > 0 ? new McpHub(config.mcp) : undefined;
void mcp?.start();
// 团队经验库存在飞书多维表格里：回答前先查，起草后发确认卡片，写权限名单里的人点了才写；排查经验同步一份到 aiops 经验库
const knowledgeTable = config.knowledge
  ? new BitableKnowledgeBackend({
      api: createBitableApi(channel.rawClient),
      stateFile: config.knowledge.stateFile,
      ...(config.knowledge.bitable ? { target: config.knowledge.bitable } : {}),
      // 共享给用经验库的群（只读）和这些群里能点「保存」的人；每次调整时按现在的（管理群里改了名单不用重启）
      share: () => groups.knowledgeShare(),
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
      // 谁能点「保存」「归档」、谁能改群记忆、能不能用 aiops 经验库、还用不用经验库，都按卡片所在的群（每次点都重新取，管理群里改了马上算）
      scope: (chatId) => {
        const policy = groups.of(chatId);
        return {
          ...(policy.writeAllowed ? { approvers: policy.writeAllowed } : {}),
          ...(policy.memoryEditors ? { memoryEditors: policy.memoryEditors } : {}),
          aiops: groups.usesAiopsLessons(chatId),
          knowledge: policy.knowledge,
        };
      },
      allowedChatIds: groups.allowed,
      // 群记忆和经验库说法对不上时发冲突卡片，选好以哪边为准后两边一起改
      memory,
      // 卡片按钮回调里没有点的人的名字，卡片上写「谁点了」、记确认人时去话题和通讯录里找
      nameOf,
    })
  : undefined;
// 管理群（CONFIG_CHAT_ID）：管理员说「配置」（@ 不 @ 都行），程序回设置卡片（不经过模型），点「确认」存进 settings、下一条消息起生效
const admin = config.admin
  ? new AdminDesk({
      chatIds: config.admin.chatIds,
      owners: config.admin.owners,
      settings,
      groups,
      // 只能在服务器上接入了的仓库、全局开了的工具里挑
      repos: () => (workspaces ? [...workspaces.repos, ...workspaces.patterns] : []),
      mcpServers: config.mcp.map((server) => server.name),
      mcpTools: (server) => {
        const listed = config.mcp.find((item) => item.name === server)?.tools;
        return mcp?.enabledTools(server) ?? (listed && listed !== "*" ? listed : undefined);
      },
      knowledge: config.knowledge !== undefined,
      directory: createChatDirectory(channel.rawClient),
      send: (to, input, opts) => channel.send(to, input, opts),
      updateCard: (messageId, card) => channel.updateCard(messageId, card),
      nameOf,
      // 写权限名单、经验库开关、开通停用改了：机器人建的经验库表格按新名单调整共享
      onSaved: () => void knowledgeTable?.syncSharing().catch((err: unknown) => console.warn("经验库：调整多维表格的共享失败", err)),
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
// 改东西前先确认（CONFIRM_WRITES）：推代码开合并请求、合并、改已有的飞书文档之前，在话题里发卡片请提问的人点「确认」
const confirms = config.confirmWrites
  ? new WriteConfirms({ send: (to, input, opts) => channel.send(to, input, opts), updateCard: (messageId, card) => channel.updateCard(messageId, card) })
  : undefined;
/** 等着确认的人在话题里回了「确认」「取消」：按这句定，这句不再当成提问 */
const confirmedByText = (msg: NormalizedMessage) => confirms?.answer(msg) ?? false;
const answerMessage = createMessageHandler({
  model,
  tools,
  ...(confirms ? { confirms } : {}),
  // 文档和代码工具按任务创建：新建的文档要共享给当前群和发起人，代码的工作目录按话题分，只给这个群的仓库
  taskTools: ({ chatId, senderId, threadKey, askerName, messageId }) => {
    const policy = groups.of(chatId);
    const repos = codeReposOf(chatId);
    return [
      ...createDocTools({ docs, chatId, requesterOpenId: senderId }),
      // 读本群一段时间的聊天记录（周报、「今天大家讨论了什么」）：只能读本群，读过以后这次不能再改已有的文档和代码
      createChatHistoryTool({ api: feishuApi, chatId, cardAnswers }),
      ...(workspaces && repos.length > 0
        ? createCodeTools({ workspaces, repos, threadKey, askerName, botName: () => channel.botIdentity?.name ?? "机器人" })
        : []),
      // 定时任务记在提问的人名下，到点按他的权限跑；暂停、取消别人建的要在这个群的写权限名单里（没配名单时谁都能）
      ...(scheduler
        ? createScheduleTools({
            scheduler,
            chatId,
            senderId,
            ...(askerName ? { askerName } : {}),
            messageId,
            canManageAll: !policy.writeAllowed || policy.writeAllowed.has(senderId),
          })
        : []),
    ];
  },
  allowedChatIds: groups.allowed,
  // 群主界面说「别主动插话」开关主动接话，话题里说「只在 @ 我时回」停掉跟聊（下面创建，收到消息时已经有了）
  command: (msg) => proactive.toggle(msg) ?? follower?.mute(msg),
  // 仓库、写权限名单、能改群记忆的人、MCP 工具、经验库按消息所在的群取
  scope: chatScope,
  ...(images ? { images } : {}),
  chatAlong: config.followThreads || config.chatContext || [...groups.allowed].some((chatId) => groups.of(chatId).proactive),
  showThinking: config.showThinking,
  about: aboutBot(),
  ...(config.streamCard ? { cardKit: createCardKitApi(channel.rawClient) } : {}),
  // 卡片里的回答飞书读不出来，记下来读话题历史时用：流式卡片的回答、功能卡片（不开流式卡片也会回）
  cardAnswers,
  botName: () => channel.botIdentity?.name,
  context,
  recentThreads,
  memory,
  tasks,
  send: (to, input, opts) => channel.send(to, input, opts),
  updateCard: (messageId, card) => channel.updateCard(messageId, card),
});
/**
 * 机器人要回答的消息（@ 它的、跟聊接着回的、照规矩去做的、点按钮接着问的）都从这里走：先告诉主动接话它在这个群里说话了，
 * 重新数群里的消息、重新算 10 天（太热闹、太久没动静先不看了的群，有人 @ 它以后接着看）
 */
const handleMessage: typeof answerMessage = (msg, options) => {
  proactive.spoke(msg.chatId);
  return answerMessage(msg, options);
};

// 话题里跟聊：机器人回答过的话题里，没 @ 它的追问先判断是不是对它说的，是才回
const follower = config.followThreads
  ? new ThreadFollower({
      allowedChatIds: groups.allowed,
      context,
      model,
      botName: () => channel.botIdentity?.name,
      botOpenId: () => channel.botIdentity?.openId,
      busy: (threadKey) => tasks.busy(threadKey),
      // 没 @ 的话不给改文档、改代码的工具：要改就 @ 机器人直接说
      handle: (msg) => handleMessage(msg, { unaddressed: true }),
      reply: replyInThread,
      // 判断时带上群记忆：群里定的规矩（哪类消息不用 @ 也要回）、答案都在里面
      memory: (chatId) => memory.list(chatId).then((entries) => renderMemoryForPrompt(entries, JUDGE_MEMORY_CHARS).text),
      // 不是对它说的、答案在群记忆里（或者是群里定过规矩的那类事）：开了主动接话的群里，再想一遍、核对出处后接一句（去做）
      chimeIn: {
        // 开着主动接话、群里没说「别主动插话」、这个群也还在看（太热闹、太久没动静的先不看）
        active: (chatId) => proactive.listening(chatId),
        speak: (msg, ask, said) => proactive.speakInTopic(msg, ask, said),
        // 群里定过规矩的那类事：同样再想一遍、算每小时的次数，再像被 @ 一样去做
        work: (msg, ask) => proactive.workInTopic(msg, ask),
      },
      // 跟着的、静音的话题记在文件里：部署重启后，回答过的话题里接着问照样不用 @
      stateFile: config.followStateFile,
    })
  : undefined;
// 主动接话：PROACTIVE_CHAT_IDS 里的群，群主界面没 @ 的消息看情况接一句；接了以后那个话题交给跟聊。
// 跟着的话题里不是对它说的话，答案在群记忆里时也接一句
const proactive = new ProactiveReplier({
  allowedChatIds: groups.allowed,
  // PROACTIVE_CHAT_IDS 里的群，和管理群卡片上打开的群（每次都问，卡片上改了马上生效）
  enabledChatIds: { has: (chatId) => groups.allowed.has(chatId) && groups.of(chatId).proactive },
  stateFile: config.proactive.stateFile,
  maxPerHour: config.proactive.maxPerHour,
  api: feishuApi,
  memory,
  model,
  botName: () => channel.botIdentity?.name,
  botOpenId: () => channel.botIdentity?.openId,
  reply: replyInThread,
  // 机器人没跟着的话题里的消息：判断时看话题最近几条
  topic: context,
  skipTopic: (threadKey) => follower?.owns(threadKey) ?? false,
  // 群记忆里定过规矩的那类事：像被 @ 一样去做，只给读的工具；之后跟着这个话题
  work: (msg) => answerUnaddressed(msg),
  // 像提问、像报错的看一眼之前查经验库，别的要开口说话的再想一遍之前查（和回答前自动查的同一个；查询词里手机号这类打码，像密钥的不发到 aiops）。
  // 关掉经验库的群不查
  ...(knowledge
    ? {
        knowledge: async (query: string, msg: NormalizedMessage, signal: AbortSignal, options: { secret: boolean }) =>
          groups.of(msg.chatId).knowledge
            ? knowledge.lookup(query, { chatId: msg.chatId, senderId: msg.senderId, messageId: msg.messageId }, signal, options)
            : undefined,
      }
    : {}),
  onReplied: (msg) => follower?.track(msg),
  followsThreads: follower !== undefined,
  // 话题里勾了「同时发送到群」的追问，群里那份不再主动接话：话题里那份归跟聊
  superseded: (msg) => unaddressedTwins.hasThreadTwin(msg),
  topicBusy: (threadKey) => tasks.busy(threadKey),
});
await proactive.init();
await follower?.init();
// 定时任务：群里 @ 机器人建，记在 data/schedules.json；到点在原来的群里发一条，按建的人的权限跑（连上飞书以后才开始看）
const scheduler = config.schedules
  ? new Scheduler({
      file: config.schedules.file,
      allowedChatIds: groups.allowed,
      run: (task, late) => runScheduledTask(task, late),
      // 要 @ 的只会是建任务的人：@ 由这里拼，模型写的字里的尖括号都换成了全角，@ 不了别人
      notify: (chatId, markdown, mention) => channel.send(chatId, { markdown }, mention ? mentionOf(mention) : undefined),
    })
  : undefined;

/** @ 一个人（定时任务只 @ 建的人） */
function mentionOf(actor: ScheduleActor): { mentions: Array<{ key: string; openId: string; name: string }> } {
  return { mentions: [{ key: "", openId: actor.openId, name: actor.name ? escapePost(actor.name) : "" }] };
}
try {
  await scheduler?.init();
} catch (err) {
  console.error(`定时任务文件 ${config.schedules?.file} 读不了，请检查 DATA_DIR 和目录权限（不用定时任务可以设 SCHEDULED_TASKS=off）。`, err);
  process.exit(1);
}

/**
 * 定时任务到点：在原来的群里发一条「⏰ 定时任务 T3」（纯提醒 @ 建的人），纯提醒到这里就完了；
 * 要做事的把这条当成建任务的人 @ 机器人说了建任务时写好的那句话，交给同一个处理函数，按他现在的权限跑，回答发在这条下面的话题里。
 * 建的人说了「有异常 @ 我」的，模型查到异常时调 schedule_alert_creator，跑完以后在话题里 @ 建的人。
 * 建的时候模型漏填了、任务内容里写着「有异常 @ 我」的也算
 */
async function runScheduledTask(task: ScheduledTask, late: number): Promise<RunResult> {
  const creator = task.creator.name ? escapePost(task.creator.name) : undefined;
  const about = `定时任务 ${label(task)} · ${describeSchedule(task)}${creator ? ` · ${creator}建的` : ""}`;
  const lateNote = late >= 5 * 60_000 ? `\n（比定的时间晚了 ${Math.round(late / 60_000)} 分钟：那会儿机器人在重启或者在忙）` : "";
  // 纯提醒发提醒时 @ 建的人；要做事的不在开始查之前 @，做完了再看要不要 @（mentionWhenDone、有异常 @）
  if (task.remind) {
    await channel.send(task.chatId, { markdown: `⏰ **提醒**：${escapePost(task.prompt)}\n（${about}）${lateNote}` }, mentionOf(task.creator));
    return "done";
  }
  const { messageId } = await channel.send(task.chatId, { markdown: `⏰ **${about}**\n${escapePost(task.prompt)}${lateNote}` });
  const msg: NormalizedMessage = {
    messageId,
    chatId: task.chatId,
    chatType: "group",
    senderId: task.creator.openId,
    ...(task.creator.name ? { senderName: task.creator.name } : {}),
    content: task.prompt,
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
  };
  // 结果话题里接着问不用 @（和回答过的话题一样）
  follower?.track(msg);
  // 跑完时 onEnd 里改（TypeScript 看不到回调里的赋值，写成 as）
  let result = "failed" as RunResult;
  const alerts: string[] = [];
  const alertOn = alertsCreator(task);
  if (alertOn && !task.alertCreator) {
    console.info(`定时任务：${label(task)} 建的时候没记「有异常 @ 建的人」，任务内容里写着，这次照样查到异常 @ 他`);
  }
  await handleMessage(msg, {
    scheduled: {
      label: label(task),
      schedule: describeSchedule(task),
      ...(task.creator.name ? { creatorName: task.creator.name } : {}),
      ...(task.readOnly ? { readOnly: true } : {}),
      ...(task.appendDoc ? { appendDoc: task.appendDoc } : {}),
      ...(alertOn
        ? {
            alert: (summary: string) => {
              if (!alerts.includes(summary)) {
                alerts.push(summary);
              }
            },
          }
        : {}),
      onEnd: (phase) => (result = phase),
    },
  });
  // 查到异常、回答也发出来了：在结果话题里 @ 建的人。没跑成的由 Scheduler @ 他说没跑成，这里不再 @
  if (alerts.length > 0 && result === "done") {
    const found = alerts.slice(0, 3).map((summary) => `- ${escapePost(summary)}`).join("\n");
    await channel
      .send(task.chatId, { markdown: `⚠️ 定时任务 ${label(task)} 查到异常（你说过有异常 @ 你）：\n${found}\n详情看上面的回答。` }, {
        replyTo: messageId,
        replyInThread: true,
        ...mentionOf(task.creator),
      })
      .catch((err: unknown) => console.warn(`定时任务：${label(task)} 有异常 @ 建的人的消息没发出去`, err));
  }
  // 一次性的、没说「有异常 @ 我」的：做完了在结果话题里 @ 建的人来看
  if (result === "done" && mentionWhenDone(task)) {
    await channel
      .send(task.chatId, { markdown: `✅ 定时任务 ${label(task)} 做完了，结果看上面的回答。` }, {
        replyTo: messageId,
        replyInThread: true,
        ...mentionOf(task.creator),
      })
      .catch((err: unknown) => console.warn(`定时任务：${label(task)} 做完了 @ 建的人的消息没发出去`, err));
  }
  return result;
}
/**
 * 没 @ 机器人、照群里定的规矩要它处理的消息：只给读的工具，记、改、删群记忆也不给；之后跟着这个话题；
 * 同一话题里排在还在判断的消息后面
 */
const answerUnaddressed = (msg: NormalizedMessage): Promise<void> =>
  follower
    ? follower.answerInTurn(msg, () => handleMessage(msg, { unaddressed: true, proactive: true }), false)
    : handleMessage(msg, { unaddressed: true, proactive: true });
/**
 * @ 了机器人的消息：管理群里说「配置」的由程序回设置卡片；别的照常回答（开关类的话由 command 先处理），之后跟着这个话题；
 * 同一话题里排在还在判断的没 @ 的消息后面
 */
const answerMention = async (msg: NormalizedMessage): Promise<void> => {
  if (await admin?.handleMessage(msg)) {
    return;
  }
  return follower ? follower.answerInTurn(msg, () => handleMessage(msg)) : handleMessage(msg);
};
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
  chatIds: groups.allowed,
  handled,
  handle: (msg) => {
    alarm.record(msg);
    if (confirmedByText(msg)) {
      return Promise.resolve();
    }
    return answerMention(msg);
  },
  // 补上的消息也让主动接话知道群里有人说过话（判断完要回之前看一眼）
  observe: (msg) => proactive.noteActivity(msg),
  follow: {
    // 等着确认的人在话题里回的话：跟聊关着、这个话题不跟了也要拿来看
    wants: (msg, fromApp) => listenerFor(msg, fromApp) !== undefined || (!fromApp && (confirms?.waiting(msg) ?? false)),
    consider: async (msg) => {
      if (confirmedByText(msg)) {
        return;
      }
      const listener = listenerFor(msg);
      if (listener) {
        await considerUnaddressed(msg, listener);
      }
    },
  },
  intervalMs: config.catchUpIntervalMs || undefined,
});
channel.on("message", async (msg: NormalizedMessage) => {
  // 原始事件只有卡片按钮要用（includeRawEvent），消息的不留
  delete (msg as { raw?: unknown }).raw;
  // 主动接话判断完要回之前，看判断的这会儿群里有没有人接了话
  proactive.noteActivity(msg);
  // 等着确认的人在话题里回了「确认」「取消」（@ 没 @ 都算）：话题里的任务正等着他，这句不排进队列
  if (confirmedByText(msg)) {
    handled.claim(msg.messageId);
    return;
  }
  if (!msg.mentionedBot) {
    // 管理群里整句就是「配置…」的：不 @ 也回设置卡片，回之前先占住这条，补漏轮询不会再交给模型（别的话照下面的规矩）
    if (await admin?.handleUnaddressed(msg, (messageId) => handled.claim(messageId))) {
      return;
    }
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
    // 也让主动接话知道话题里有人说了话：判断着要按群记忆接的那句不再插进来
    proactive.noteActivity(msg);
    // 和 @ 的消息一样排在同一话题里还在判断的消息后面，之后跟着这个话题
    return follower ? follower.answerInTurn(msg, () => handleMessage(msg, options), false) : handleMessage(msg, options);
  },
});
const onCardAction = createCardActionHandler({ tasks, allowedChatIds: groups.allowed, followUp, ...(knowledge ? { knowledge } : {}) });
// 每次点都记一行，先回飞书再处理（见 dispatchCardAction）
channel.on("cardAction", (evt) =>
  dispatchCardAction(evt, async () => {
    // 确认卡片上的按钮：只认提问的人点的，点了马上放行（话题里的任务正等着）
    if (await confirms?.handleCardAction(evt)) {
      return;
    }
    // 管理群设置卡片上的按钮先看（管理群不在白名单里也认）
    if (await admin?.handleCardAction(evt)) {
      return;
    }
    await onCardAction(evt);
  }),
);
// 有人给机器人没被 @ 时说的话点了表情：算有人理（要在飞书开发者后台订阅「消息被 reaction」事件才收得到，没订阅就只看回复和 @）
channel.on("reaction", (evt) => proactive.noteReaction(evt.messageId, evt.operator.openId, evt.emojiType, evt.action));
channel.on("error", (err) => console.error(`[feishu] ${err.code}: ${err.message}`));

try {
  await channel.connect();
} catch (err) {
  console.error("连接飞书失败：请检查 FEISHU_APP_ID / FEISHU_APP_SECRET，以及应用是否已开启机器人能力并发布版本。", err);
  process.exit(1);
}
console.log(
  `飞书长连接已建立，版本 ${VERSION}，机器人「${channel.botIdentity?.name}」，模型 ${config.llm.model}，` +
    `工具 ${[...tools.map((tool) => tool.spec.name), ...DOC_TOOL_NAMES, CHAT_HISTORY_TOOL, ...(workspaces ? CODE_TOOL_NAMES : []), ...(scheduler ? SCHEDULE_TOOL_NAMES : [])].join(", ")}，` +
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
  confirms
    ? `改东西前先确认：推代码开合并请求、合并、改已有的飞书文档之前，在话题里发卡片请提问的人点「确认」，${CONFIRM_WAIT_MS / 60_000} 分钟没确认就不做（CONFIRM_WRITES=off 可以关掉）`
    : "改东西前不确认（CONFIRM_WRITES=off）：有写权限的人说了要改，推代码、合并、改文档直接做",
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
// PROACTIVE_CHAT_IDS 里的，加上管理群卡片上打开的（卡片上关掉的不算）
const proactiveChats = [...groups.allowed].filter((chatId) => groups.of(chatId).proactive);
if (proactiveChats.length > 0) {
  const paused = proactiveChats.filter((chatId) => !proactive.active(chatId));
  const quiet = proactiveChats.filter((chatId) => proactive.active(chatId) && !proactive.listening(chatId));
  console.log(
    `主动接话：群 ${proactiveChats.join(", ")} 里没 @ 的消息看情况接一句，` +
      (Number.isFinite(config.proactive.maxPerHour)
        ? `每个群每小时最多 ${config.proactive.maxPerHour} 次`
        : `不限回几次（每个群每小时最多判断 ${MAX_JUDGED_PER_HOUR} 条）`) +
      (paused.length > 0 ? `；${paused.join(", ")} 有人说过「别主动插话」，现在停着（@ 机器人说「可以主动说话」再打开）` : "") +
      (quiet.length > 0 ? `；${quiet.join(", ")} 太热闹或太久没人 @，先不看了（@ 机器人一次接着看）` : ""),
  );
} else {
  console.log("主动接话没开：只回 @ 机器人的消息和跟着的话题（PROACTIVE_CHAT_IDS 填群的 chat_id，或者在管理群的设置卡片上可以打开）");
}
if (config.proactive.ignored.length > 0) {
  console.warn(`PROACTIVE_CHAT_IDS 里这些群不在 FEISHU_ALLOWED_CHAT_IDS 里，不生效：${config.proactive.ignored.join(", ")}`);
}
// 开着管理群时现在没开通的群也可能在卡片上开通：轮询每次按 groups.allowed 现在的群查
if (config.catchUpIntervalMs > 0 && (groups.allowed.size > 0 || config.admin)) {
  catchUp.start();
  console.log(
    `补漏轮询已开启，每 ${config.catchUpIntervalMs / 1000} 秒检查一次开通了的群里有没有漏掉的 @；` +
      `30 分钟内补上 2 条以上会在${config.alertChatId ? `群 ${config.alertChatId}` : "漏消息的群"}里报警`,
  );
}
console.log(
  config.feishu.writeAllowedUsers
    ? `写权限：只有 ${config.feishu.writeAllowedUsers.size} 人能让机器人改文档、改代码（WRITE_ALLOWED_USERS），其他人只能问和读`
    : "写权限：群里所有人都能让机器人改文档、改代码。要限制就在 WRITE_ALLOWED_USERS 里填允许的人的 open_id",
);
console.log(
  config.feishu.memoryEditors
    ? `改群记忆：只有 ${config.feishu.memoryEditors.size} 人能让机器人记、改、删群记忆（MEMORY_EDITORS），其他人只能看`
    : "改群记忆：群里所有人都能让机器人记、改、删（和 Claude Tag 一样）。要限制就在 MEMORY_EDITORS 里填允许的人的 open_id",
);
if (config.webSearch) {
  console.log(`联网搜索已开启，用百炼的 ${config.webSearch.model} 搜索`);
} else {
  console.log("联网搜索没开：WEB_SEARCH=off，或者 MODEL_BASE_URL 不是百炼的 OpenAI 兼容接口（web_search 只支持百炼）");
}
if (workspaces) {
  console.log(
    `代码仓库已配置（${workspaces.host.name}）：${[...workspaces.repos, ...workspaces.patterns].join(", ")}，工作目录在 ${config.code!.workspaceDir}` +
      (config.groups.length > 0
        ? `；没单独配仓库的群${config.code!.repos.length > 0 ? `用 ${config.code!.repos.join(", ")}` : "没有代码工具"}`
        : ""),
  );
  void checkRepos(workspaces);
  if (workspaces.patterns.length > 0) {
    // 通配（group/*）下的项目从 GitLab 上列：启动时列一次，之后每 30 分钟再列一次，群组里新建的项目不用重启
    void workspaces.refreshPatterns();
    setInterval(() => void workspaces.refreshPatterns(), 30 * 60_000).unref();
  }
}
for (const line of groups.describe()) {
  console.log(line);
}
if (config.admin) {
  const adminChats = [...config.admin.chatIds];
  const outside = adminChats.filter((chatId) => !groups.allowed.has(chatId));
  console.log(
    `管理群：在群 ${adminChats.join(", ")} 里说「配置」（@ 不 @ 机器人都行），回设置卡片改各群的配置，点「确认」马上生效` +
      (adminChats.length > 1 ? "，改动通知发在改的那个群里" : "") +
      `；所有者 ${config.admin.owners.size} 人（CONFIG_OWNERS），管理员 ${settings.admins().size} 人。` +
      `卡片上改的存在 ${settings.file}，每次改动记在 ${settings.logFile}` +
      (outside.length > 0 ? `（${outside.join(", ")} 不在白名单里：在这${outside.length > 1 ? "些" : "个"}群里只回「配置」）` : ""),
  );
} else if (settings.chatIds().length > 0) {
  console.log(`管理群没开（CONFIG_CHAT_ID），以前在卡片上改过的 ${settings.chatIds().length} 个群照样按 ${settings.file} 来`);
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
if (scheduler) {
  scheduler.start();
  console.log(
    `定时任务：群里 @ 机器人说「每周一 9 点汇总上周进展」「明天下午 3 点提醒我…」就能建，记在 ${config.schedules!.file}；` +
      "到点在原来的群里发一条、按建的人的权限跑（不改代码），每 30 秒看一次（SCHEDULED_TASKS=off 关掉）",
  );
} else {
  console.log("定时任务：已关闭（SCHEDULED_TASKS=off）");
}
if (backup) {
  backup.start();
  console.log(`群记忆每天备份一次到 ${config.memoryBackupDir}，保留最近 ${config.memoryBackupDays} 天`);
}
if (settingsBackup) {
  settingsBackup.start();
  console.log(`管理群改的群配置每天备份一次到 ${config.settingsBackupDir}，保留最近 ${config.memoryBackupDays} 天`);
}
// 部署新版本要重启：连上飞书后把 RELEASE_NOTES.md 里各群还没收到过的版本发过去，在后台做。
// 没配 ANNOUNCE_CHAT_IDS 时发现在开通的所有群（包括卡片上开通的）；卡片上停用了的群不发
const announceChats = config.announce
  ? config.announce.chatIdsFrom === "ANNOUNCE_CHAT_IDS"
    ? config.announce.chatIds.filter((chatId) => groups.allowed.has(chatId))
    : [...groups.allowed]
  : [];
const announcer =
  config.announce && announceChats.length > 0
    ? new UpdateAnnouncer({
        ...config.announce,
        chatIds: announceChats,
        send: (to, input) => channel.send(to, input),
        botName: () => channel.botIdentity?.name,
      })
    : undefined;
if (announcer) {
  void announcer.run();
  const { chatIdsFrom } = config.announce!;
  const chatIds = announceChats;
  console.log(
    `更新通知：新版本部署后，把 RELEASE_NOTES.md 里还没发过的版本发到 ${chatIds.length} 个群 ${chatIds.join(", ")}` +
      (chatIdsFrom === "ANNOUNCE_CHAT_IDS"
        ? "（按 ANNOUNCE_CHAT_IDS）"
        : "（没配 ANNOUNCE_CHAT_IDS，发开通了的所有群）") +
      "，ANNOUNCE=off 关掉",
  );
} else if (!config.announce) {
  console.log("更新通知：已关闭（ANNOUNCE=off）");
}
if (groups.allowed.size === 0) {
  console.warn(
    config.admin
      ? "还没开通任何群，不会响应任何群。在管理群里 @ 机器人说「配置」开通，或者在 FEISHU_ALLOWED_CHAT_IDS 里加群。"
      : "FEISHU_ALLOWED_CHAT_IDS 未配置，不会响应任何群。在要启用的群里 @ 机器人，日志会打出该群的 chat_id。",
  );
} else {
  const carded = [...groups.allowed].filter((chatId) => !groups.onServer(chatId));
  const stopped = [...config.feishu.allowedChatIds].filter((chatId) => !groups.allowed.has(chatId));
  console.log(
    `已启用的群：${[...groups.allowed].join(", ")}` +
      (carded.length > 0 ? `（其中 ${carded.join(", ")} 是在管理群的卡片上开通的）` : "") +
      (stopped.length > 0 ? `；白名单里的 ${stopped.join(", ")} 在管理群的卡片上停用了` : ""),
  );
}

const shutdown = async () => {
  // 不再看新到点的定时任务；正在跑的下面停掉，等它记完结果再退出
  const schedulerStopped = scheduler?.stop();
  // 停掉进行中的任务，让它们把卡片更新成「已停止」再退出
  await catchUp.stop();
  await backup?.stop();
  await settingsBackup?.stop();
  // 正在发的更新通知发完再退出（最多等 5 秒），没发完的下次启动再发
  await Promise.race([announcer?.stop(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  tasks.stopAll();
  await tasks.idle(5000);
  await Promise.race([schedulerStopped, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  // 已经点了确认、正在写经验库的，写完再退出（最多等 10 秒）
  await Promise.race([knowledge?.idle(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  await mcp?.stop();
  await channel.disconnect();
  // 跟着的话题、主动接话数的消息正在写文件的，写完再退出
  await follower?.flush();
  await proactive.flush();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

/**
 * 有人问「你能做什么」「最近更新了什么」时用：产品功能说明的链接、产品更新说明里最新的一版、产品功能清单
 * （部署新版本要重启，启动时读一次就够）
 */
function aboutBot(): AboutBot {
  let latest: ReturnType<typeof parseReleaseNotes>[number] | undefined;
  try {
    latest = parseReleaseNotes(readFileSync(RELEASE_NOTES_FILE, "utf8"))[0];
  } catch (err) {
    console.warn(`读不到 ${RELEASE_NOTES_FILE}，被问到最近更新了什么时答不上来`, err);
  }
  let features: FeatureList | undefined;
  try {
    features = parseFeatures(readFileSync(FEATURES_FILE, "utf8"));
  } catch (err) {
    console.warn(`读不到 ${FEATURES_FILE}，被问到「你能做什么」时不回功能卡片，交给模型按工具说`, err);
  }
  return {
    ...(config.featuresLink ? { featuresLink: config.featuresLink } : {}),
    ...(latest ? { latest } : {}),
    ...(features?.features.length ? { features } : {}),
  };
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

/** 这个群能操作的具体仓库：按群配置的清单展开通配（还没从 GitLab 列出来的通配暂时没有） */
function codeReposOf(chatId: string): string[] {
  const entries = groups.of(chatId).codeRepos;
  return workspaces && entries.length > 0 ? workspaces.resolve(entries) : [];
}

/** 这个群回答时用的仓库、写权限名单、能改群记忆的人、MCP 工具和经验库（按群配置，群里没写的项照全局） */
function chatScope(chatId: string): ChatScope {
  const policy = groups.of(chatId);
  const repos = codeReposOf(chatId);
  const scopedMcp = mcp?.scoped(policy.mcp);
  return {
    ...(repos.length > 0 ? { codeRepos: repos } : {}),
    ...(policy.writeAllowed ? { writeAllowed: policy.writeAllowed } : {}),
    ...(policy.memoryEditors ? { memoryEditors: policy.memoryEditors } : {}),
    ...(scopedMcp ? { mcp: scopedMcp } : {}),
    ...(knowledge && policy.knowledge ? { knowledge } : {}),
  };
}

/** 代码仓库工具要用 git。没装 git 时不开这些工具，别的照常。repos 是全局和各群写到的所有仓库 */
async function openCodeWorkspaces(code: NonNullable<typeof config.code>, repos: readonly string[]): Promise<CodeWorkspaces | undefined> {
  try {
    await runGit(["--version"]);
  } catch (err) {
    console.error("配了 CODE_REPOS，但服务器上跑不了 git，代码仓库工具先不开", err);
    return undefined;
  }
  const host = code.host.kind === "gitlab" ? createGitLabHost(code.host.url, code.host.token) : createGitHubHost(code.host.token);
  const workspaces = new CodeWorkspaces({
    root: code.workspaceDir,
    host,
    repos,
    branches: code.branches,
    ...(code.build ? { build: createBuildChecker(code.goproxy ? { goproxy: code.goproxy } : {}) } : {}),
  });
  // 几天没用的话题工作目录，启动时和之后每天清一次
  const sweep = () => workspaces.sweep().catch((err) => console.error("清理代码工作目录失败", err));
  void sweep();
  setInterval(sweep, 24 * 60 * 60_000).unref();
  return workspaces;
}
