import { existsSync } from "node:fs";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { createMessageHandler } from "./bot.js";
import { loadConfig } from "./config.js";
import { createOpenAICompatibleModel } from "./llm.js";

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
  // 群里只响应 @ 机器人的消息，@所有人 不响应；阶段 0 先不开单聊
  policy: { requireMention: true, dmMode: "disabled" },
  // 关掉按群排队合并：同一个群里几个人同时 @，各自独立回答，互不等待
  safety: { chatQueue: { enabled: false } },
});

channel.on("message", createMessageHandler({
  model: createOpenAICompatibleModel(config.llm),
  send: (to, input, opts) => channel.send(to, input, opts),
}));
channel.on("error", (err) => console.error(`[feishu] ${err.code}: ${err.message}`));

try {
  await channel.connect();
} catch (err) {
  console.error("连接飞书失败：请检查 FEISHU_APP_ID / FEISHU_APP_SECRET，以及应用是否已开启机器人能力并发布版本。", err);
  process.exit(1);
}
console.log(`飞书长连接已建立，机器人「${channel.botIdentity?.name}」，模型 ${config.llm.model}`);

const shutdown = async () => {
  await channel.disconnect();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
