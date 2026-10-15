import type { CardActionEvent } from "@larksuiteoapi/node-sdk";
import type { FeishuApi } from "./feishu.js";
import type { Logger } from "./history.js";

/** 找点卡片的人的名字：openId 是点的人，cardMessageId 是点的那张卡片。找不到返回 undefined，不抛错 */
export type NameLookup = (openId: string, cardMessageId: string) => Promise<string | undefined>;

/** 点卡片的人的名字：回调里带了就用；点的是让机器人发卡片的那个人，用他提问时的名字；不然用 lookup 找 */
export async function clickerName(
  evt: Pick<CardActionEvent, "messageId" | "operator">,
  proposer: { openId: string; name?: string },
  lookup: NameLookup | undefined,
): Promise<string | undefined> {
  if (evt.operator.name) {
    return evt.operator.name;
  }
  if (proposer.name && proposer.openId === evt.operator.openId) {
    return proposer.name;
  }
  return lookup?.(evt.operator.openId, evt.messageId).catch(() => undefined);
}

export interface NameLookupOptions {
  logger?: Logger;
  /** 最多等多久：卡片回调要在几秒内返回，找不到名字也不能拖住 */
  timeoutMs?: number;
  /** 记住多少个人的名字 */
  maxKnown?: number;
}

/**
 * 卡片按钮回调里飞书只给点的人的 open_id，不给名字。卡片上写「谁点了」、经验库记确认人时用这个找名字：
 * 先看记住的；再在卡片所在的话题里找这个人最近说过的话；话题里没说过话的，查通讯录（要 contact:user.base:readonly，
 * 而且这个人在应用的通讯录范围里）。都找不到返回 undefined，调用方写「有人」，不把 open_id 当名字显示
 */
export function createNameLookup(
  api: Pick<FeishuApi, "getMessage" | "listThreadMessages" | "getUserName">,
  { logger = console, timeoutMs = 1500, maxKnown = 500 }: NameLookupOptions = {},
): NameLookup {
  const known = new Map<string, string>();
  let contactWarned = false;

  const remember = (openId: string, name: string) => {
    known.delete(openId);
    known.set(openId, name);
    if (known.size > maxKnown) {
      known.delete(known.keys().next().value!);
    }
  };

  const find = async (openId: string, cardMessageId: string): Promise<string | undefined> => {
    try {
      const card = await api.getMessage(cardMessageId);
      if (card?.threadId) {
        const messages = await api.listThreadMessages(card.threadId, 60);
        const name = messages.findLast((m) => !m.fromBot && m.senderId === openId && m.senderName)?.senderName;
        if (name) {
          return name;
        }
      }
    } catch (err) {
      logger.warn(`找点卡片的人的名字：读话题失败 card=${cardMessageId}`, err);
    }
    try {
      return await api.getUserName(openId);
    } catch (err) {
      // 多半是没开通讯录权限或这个人不在通讯录范围里，每次都会这样，只记一次
      if (!contactWarned) {
        contactWarned = true;
        logger.warn("找点卡片的人的名字：查通讯录失败（要 contact:user.base:readonly 权限，人要在应用的通讯录范围里），只在话题里找", err);
      }
      return undefined;
    }
  };

  return async (openId, cardMessageId) => {
    const cached = known.get(openId);
    if (cached) {
      return cached;
    }
    // 超时了也接着找完，找到的记下来，下次点就有了
    const found = find(openId, cardMessageId).then((name) => {
      if (name) {
        remember(openId, name);
      }
      return name;
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, timeoutMs, undefined);
    });
    try {
      return await Promise.race([found, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}
