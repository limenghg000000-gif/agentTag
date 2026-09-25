import type { NormalizedMessage, SendInput, SendOptions, SendResult } from "@larksuiteoapi/node-sdk";
import { type ChatModel, LlmError } from "./llm.js";
import { splitMarkdown } from "./markdown.js";

const SYSTEM_PROMPT = `你是团队的 AI 助手，作为成员加入了这个飞书群。群里的人 @ 你提问或派活，你的回答会发在那条消息的话题里。
- 用提问者使用的语言回答，先给结论，需要时再展开。
- 可以用 Markdown：粗体、列表、链接、引用和代码块。飞书消息不渲染表格，需要对比时用列表。`;

/**
 * 每条回复的字数上限。SDK 超过 3500 字会自己切分，但切出来的后续片段会发到群主界面而不是话题里，
 * 所以这里先切好，每片都回复到原消息的话题。
 */
const CHUNK_CHARS = 3000;

export interface BotDeps {
  model: ChatModel;
  send: (to: string, input: SendInput, opts?: SendOptions) => Promise<SendResult>;
  logger?: Pick<Console, "info" | "error">;
}

/**
 * 处理一条已经过 SDK 安全管线的群消息（已去重、已确认 @ 了机器人、@ 占位符已替换成名字）：
 * 问模型，把回答发到这条消息的话题里。
 */
export function createMessageHandler({ model, send, logger = console }: BotDeps) {
  return async (msg: NormalizedMessage): Promise<void> => {
    logger.info(`收到提问 chat=${msg.chatId} message=${msg.messageId} sender=${msg.senderId}`);

    const question = msg.content.trim();
    let answer: string;
    if (!question) {
      answer = "在的，@ 我的时候带上问题或要做的事就行。";
    } else {
      try {
        const result = await model.chat({ system: SYSTEM_PROMPT, messages: [{ role: "user", content: question }] });
        answer = toReply(result.text, result.finish);
      } catch (err) {
        logger.error(`调用模型失败 message=${msg.messageId}`, err);
        answer = `抱歉，这次没能完成：${describeError(err)}。`;
      }
    }

    for (const chunk of splitMarkdown(answer, CHUNK_CHARS)) {
      await send(msg.chatId, { markdown: chunk }, { replyTo: msg.messageId, replyInThread: true });
    }
    logger.info(`已回复 message=${msg.messageId}`);
  };
}

function toReply(text: string, finish: "stop" | "length" | "filtered"): string {
  if (finish === "filtered") {
    return "抱歉，这个问题被模型服务的内容审核拦下了，换个说法试试。";
  }
  if (finish === "length") {
    return `${text}\n\n（回答太长，后面被截断了）`;
  }
  return text || "（模型没有返回内容）";
}

/** 把调用模型的异常翻译成能发到群里的一句话，不带密钥等敏感信息。 */
function describeError(err: unknown): string {
  if (!(err instanceof LlmError)) {
    return "内部错误";
  }
  switch (err.kind) {
    case "auth":
      return "模型服务的 API Key 无效或没有权限";
    case "rate_limit":
      return "模型服务被限流了，请稍后再试";
    case "connection":
      return "连不上模型服务，请检查网络或 MODEL_BASE_URL";
    case "api":
      return "模型服务返回错误";
  }
}
