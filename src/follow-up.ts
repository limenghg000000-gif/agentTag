import type { CardActionEvent, NormalizedMessage, SendInput, SendOptions, SendResult } from "@larksuiteoapi/node-sdk";
import type { FeishuApi } from "./feishu.js";
import type { Logger } from "./history.js";
import { actionQuestion } from "./rich-ui.js";

/** 点了按钮以后，机器人替点的人在话题里发的那句。读话题历史时认出来，当成这个人问的 */
const FOLLOW_UP = /^👉 (?:(.+?) )?接着问：(.+)$/s;

/** 同一张卡片上的同一个按钮，多长时间内再点（或者别人也点）不重复问 */
export const FOLLOW_UP_DEDUPE_MS = 60_000;

export function followUpText(name: string | undefined, question: string): string {
  const who = name?.replace(/[<>*_`~\[\]]/g, "").trim();
  return `👉 ${who ? `${who} ` : ""}接着问：${question}`;
}

/** 机器人发的一条消息是不是替人接着问的那句：是的话返回谁问的、问了什么 */
export function parseFollowUp(content: string): { name?: string; question: string } | undefined {
  const match = FOLLOW_UP.exec(content.trim());
  return match ? { ...(match[1] ? { name: match[1] } : {}), question: match[2].trim() } : undefined;
}

export interface FollowUpDeps {
  api: Pick<FeishuApi, "getMessage" | "listThreadMessages">;
  send: (to: string, input: SendInput, opts?: SendOptions) => Promise<SendResult>;
  /** 处理一条提问（就是群消息的处理函数）；按钮来的问题只查不改 */
  handle: (msg: NormalizedMessage, options: { readOnly: boolean }) => Promise<void>;
  logger?: Logger;
  now?: () => number;
}

/**
 * 回答下面「接着查」按钮：在卡片所在的话题里替点的人发一句「👉 某某 接着问：…」，再当成这个人在话题里问的去处理。
 * 按钮上的话是模型写的，所以这样问的只给读的工具。
 */
export function createFollowUp({ api, send, handle, logger = console, now = Date.now }: FollowUpDeps) {
  const clicked = new Map<string, number>();
  return async (evt: CardActionEvent, value: unknown): Promise<void> => {
    const question = actionQuestion(value);
    if (!question) {
      return;
    }
    const at = now();
    for (const [key, time] of clicked) {
      if (at - time > FOLLOW_UP_DEDUPE_MS) {
        clicked.delete(key);
      }
    }
    const key = `${evt.messageId}\n${question}`;
    if (clicked.has(key)) {
      logger.info(`接着查按钮 card=${evt.messageId} operator=${evt.operator.openId}：这个按钮刚点过，不重复问`);
      return;
    }
    clicked.set(key, at);

    const card = await api.getMessage(evt.messageId);
    if (!card) {
      logger.warn(`接着查按钮 card=${evt.messageId}：读不到这张卡片，没法接着问`);
      return;
    }
    const name = evt.operator.name || (card.threadId ? await nameIn(api, card.threadId, evt.operator.openId, logger) : undefined);
    const posted = await send(evt.chatId, { markdown: followUpText(name, question) }, { replyTo: evt.messageId, replyInThread: true });
    logger.info(`接着查按钮 card=${evt.messageId} operator=${evt.operator.openId} message=${posted.messageId}`);
    const msg: NormalizedMessage = {
      messageId: posted.messageId,
      chatId: evt.chatId,
      chatType: "group",
      senderId: evt.operator.openId,
      ...(name ? { senderName: name } : {}),
      content: question,
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      rootId: card.rootId ?? evt.messageId,
      ...(card.threadId ? { threadId: card.threadId } : {}),
      replyToMessageId: evt.messageId,
      createTime: now(),
    };
    await handle(msg, { readOnly: true });
  };
}

/** 卡片回调里一般没有名字：在话题里找这个人最近说过的话，拿他的名字。找不到就算了 */
async function nameIn(api: FollowUpDeps["api"], threadId: string, openId: string, logger: Logger): Promise<string | undefined> {
  try {
    const messages = await api.listThreadMessages(threadId, 60);
    return messages.findLast((m) => m.senderId === openId && m.senderName)?.senderName;
  } catch (err) {
    logger.warn(`接着查按钮：读话题找名字失败 thread=${threadId}`, err);
    return undefined;
  }
}
