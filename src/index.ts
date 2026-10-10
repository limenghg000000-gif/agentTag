import { existsSync } from "node:fs";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { MissedEventAlarm } from "./alarm.js";
import { MemoryBackup } from "./backup.js";
import { createCardActionHandler, createMessageHandler } from "./bot.js";
import { CatchUpPoller, HandledMessages } from "./catchup.js";
import { loadConfig } from "./config.js";
import { createDocsApi, FeishuDocs } from "./docs.js";
import { createFeishuApi } from "./feishu.js";
import { ThreadContextLoader } from "./history.js";
import { ImageReader } from "./images.js";
import { KnowledgeBase } from "./knowledge.js";
import { AiopsLessons } from "./knowledge-aiops.js";
import { BitableKnowledgeBackend, createBitableApi } from "./knowledge-bitable.js";
import { createOpenAICompatibleEmbedder, createOpenAICompatibleModel, createOpenAICompatibleVisionModel } from "./llm.js";
import { McpHub } from "./mcp.js";
import { MemoryStore } from "./memory.js";
import { CodeWorkspaces, createGitHubHost, createGitLabHost, runGit } from "./repo.js";
import { TaskRegistry } from "./tasks.js";
import { CODE_TOOL_NAMES, createCodeTools } from "./tools/code.js";
import { KnowledgeDesk } from "./tools/knowledge.js";
import { createDocTools, DOC_TOOL_NAMES } from "./tools/docs.js";
import { createFetchUrlTool } from "./tools/fetch-url.js";
import { createWebSearchTool } from "./tools/web-search.js";

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
  // 群里只响应 @ 机器人的消息，@所有人 不响应；单聊暂不开
  policy: { requireMention: true, dmMode: "disabled" },
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
        chatPerm: config.feishu.writeAllowedUsers ? "view" : "edit",
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
const handleMessage = createMessageHandler({
  model: createOpenAICompatibleModel(config.llm),
  tools,
  // 文档和代码工具按任务创建：新建的文档要共享给当前群和发起人，代码的工作目录按话题分
  taskTools: ({ chatId, senderId, threadKey, askerName }) => [
    ...createDocTools({ docs, chatId, requesterOpenId: senderId }),
    ...(workspaces
      ? createCodeTools({ workspaces, threadKey, askerName, botName: () => channel.botIdentity?.name ?? "机器人" })
      : []),
  ],
  allowedChatIds: config.feishu.allowedChatIds,
  ...(workspaces ? { codeRepos: workspaces.repos } : {}),
  ...(config.feishu.writeAllowedUsers ? { writeAllowed: config.feishu.writeAllowedUsers } : {}),
  ...(mcp ? { mcp } : {}),
  ...(knowledge ? { knowledge } : {}),
  ...(images ? { images } : {}),
  botName: () => channel.botIdentity?.name,
  context: new ThreadContextLoader(feishuApi),
  memory,
  tasks,
  send: (to, input, opts) => channel.send(to, input, opts),
  updateCard: (messageId, card) => channel.updateCard(messageId, card),
});

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
    return handleMessage(msg);
  },
  intervalMs: config.catchUpIntervalMs || undefined,
});
channel.on("message", async (msg: NormalizedMessage) => {
  if (!handled.claim(msg.messageId)) {
    // 轮询已经补上了这条：事件只是晚到，不是被别处分走
    alarm.arrivedLate(msg.messageId);
    console.log(`事件晚到，这条已由轮询处理 message=${msg.messageId}`);
    return;
  }
  catchUp.watch(msg);
  await handleMessage(msg);
});
channel.on("cardAction", createCardActionHandler({ tasks, allowedChatIds: config.feishu.allowedChatIds, ...(knowledge ? { knowledge } : {}) }));
channel.on("error", (err) => console.error(`[feishu] ${err.code}: ${err.message}`));

try {
  await channel.connect();
} catch (err) {
  console.error("连接飞书失败：请检查 FEISHU_APP_ID / FEISHU_APP_SECRET，以及应用是否已开启机器人能力并发布版本。", err);
  process.exit(1);
}
console.log(
  `飞书长连接已建立，机器人「${channel.botIdentity?.name}」，模型 ${config.llm.model}，` +
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
if (config.feishu.allowedChatIds.size === 0) {
  console.warn("FEISHU_ALLOWED_CHAT_IDS 未配置，不会响应任何群。在要启用的群里 @ 机器人，日志会打出该群的 chat_id。");
} else {
  console.log(`已启用的群：${[...config.feishu.allowedChatIds].join(", ")}`);
}

const shutdown = async () => {
  // 停掉进行中的任务，让它们把卡片更新成「已停止」再退出
  await catchUp.stop();
  await backup?.stop();
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
