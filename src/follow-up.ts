import type { CardActionEvent, NormalizedMessage, SendInput, SendOptions, SendResult } from "@larksuiteoapi/node-sdk";
import type { FeishuApi } from "./feishu.js";
import type { Logger } from "./history.js";
import { actionQuestion } from "./rich-ui.js";

/** 点了按钮以后，机器人替点的人在话题里发的那句。读话题历史时认出来，当成这个人问的。只有一行 */
const FOLLOW_UP = /^👉 (?:([^\n]+?) )?接着问：([^\n]+)$/;

/** 同一张卡片上的同一个按钮，多长时间内再点（或者别人也点）不重复问 */
export const FOLLOW_UP_DEDUPE_MS = 60_000;

export function followUpText(name: string | undefined, question: string): string {
  const who = name?.replace(/[<>*_`~\[\]]/g, "").trim();
  return `👉 ${who ? `${who} ` : ""}接着问：${question}`;
}

/**
 * 机器人发的一条消息是不是替人接着问的那句：是的话返回谁问的、问了什么。
 * 问题要是按钮上放得下的那种（一行、40 字以内、没有尖括号）：普通回答碰巧以「👉 」开头、写到「接着问：」的，不当成群成员问的
 */
export function parseFollowUp(content: string): { name?: string; question: string } | undefined {
  const match = FOLLOW_UP.exec(content.trim());
  const question = match?.[2].trim();
  if (!match || !question || actionQuestion(question) !== question) {
    return undefined;
  }
  return { ...(match[1] ? { name: match[1] } : {}), question };
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

    // 读卡片、发「接着问」这两步没成功时不算点过：过一会儿再点还能问
    const asked = await post(evt, question).catch((err: unknown) => {
      clicked.delete(key);
      throw err;
    });
    if (!asked) {
      clicked.delete(key);
      return;
    }
    const { card, name, messageId } = asked;
    logger.info(`接着查按钮 card=${evt.messageId} operator=${evt.operator.openId} message=${messageId}`);
    const msg: NormalizedMessage = {
      messageId,
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

  /** 读出按钮所在的卡片，在它的话题里发「👉 某某 接着问：…」。读不到卡片时返回 undefined */
  async function post(evt: CardActionEvent, question: string) {
    const card = await api.getMessage(evt.messageId);
    if (!card) {
      logger.warn(`接着查按钮 card=${evt.messageId}：读不到这张卡片，没法接着问`);
      return undefined;
    }
    const name = evt.operator.name || (card.threadId ? await nameIn(api, card.threadId, evt.operator.openId, logger) : undefined);
    const { messageId } = await send(evt.chatId, { markdown: followUpText(name, question) }, { replyTo: evt.messageId, replyInThread: true });
    return { card, name, messageId };
  }
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
