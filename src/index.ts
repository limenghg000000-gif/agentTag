import { existsSync } from "node:fs";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { MissedEventAlarm } from "./alarm.js";
import { MemoryBackup } from "./backup.js";
import { createCardActionHandler, createMessageHandler } from "./bot.js";
import { CatchUpPoller, HandledMessages } from "./catchup.js";
import { loadConfig } from "./config.js";
import { createFeishuApi } from "./feishu.js";
import { ThreadContextLoader } from "./history.js";
import { createOpenAICompatibleModel } from "./llm.js";
import { MemoryStore } from "./memory.js";
import { TaskRegistry } from "./tasks.js";
import { createFetchUrlTool } from "./tools/fetch-url.js";

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
const tools = [createFetchUrlTool()];
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
const handleMessage = createMessageHandler({
  model: createOpenAICompatibleModel(config.llm),
  tools,
  allowedChatIds: config.feishu.allowedChatIds,
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
channel.on("cardAction", createCardActionHandler({ tasks, allowedChatIds: config.feishu.allowedChatIds }));
channel.on("error", (err) => console.error(`[feishu] ${err.code}: ${err.message}`));

try {
  await channel.connect();
} catch (err) {
  console.error("连接飞书失败：请检查 FEISHU_APP_ID / FEISHU_APP_SECRET，以及应用是否已开启机器人能力并发布版本。", err);
  process.exit(1);
}
console.log(
  `飞书长连接已建立，机器人「${channel.botIdentity?.name}」，模型 ${config.llm.model}，` +
    `工具 ${tools.map((tool) => tool.spec.name).join(", ")}，群记忆存放在 ${config.memoryDir}`,
);
if (config.catchUpIntervalMs > 0 && config.feishu.allowedChatIds.size > 0) {
  catchUp.start();
  console.log(
    `补漏轮询已开启，每 ${config.catchUpIntervalMs / 1000} 秒检查一次白名单群里有没有漏掉的 @；` +
      `30 分钟内补上 2 条以上会在${config.alertChatId ? `群 ${config.alertChatId}` : "漏消息的群"}里报警`,
  );
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
  await channel.disconnect();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
