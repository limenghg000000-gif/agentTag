import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { threadKeyOf } from "./history.js";

/** 同一个人同一句话，发送时间相差这么多毫秒以内算作重复 */
export const DUPLICATE_WINDOW_MS = 10_000;
/** 记录保留多久（按收到的时间），要比轮询补漏的延迟长 */
const KEEP_MS = 5 * 60_000;

export type DuplicateVerdict =
  /** 正常处理 */
  | { action: "handle" }
  /** 正常处理，另外要停掉先到的那份副本的任务（它在 stopThreadKey 这个话题里） */
  | { action: "handle"; stopThreadKey: string; duplicateOf: string }
  /** 是重复的，跳过 */
  | { action: "skip"; duplicateOf: string };

interface Seen {
  messageId: string;
  threadKey: string;
  inThread: boolean;
  sentAt: number;
  seenAt: number;
}

/**
 * 在话题里回复时勾了「同时发送到群」，飞书会在群里再发一条同样内容的新消息，机器人会收到两条 @。
 * 两条都处理的话，写文档这类操作会做两遍，群里那条的回复还会被飞书拒绝。
 * 这里认出这种副本：同一个群、同一个人、同样的内容、发送时间相差 10 秒以内，只处理一条，话题里的优先。
 */
export class DuplicateAsks {
  private readonly seen = new Map<string, Seen[]>();

  /**
   * copiesOnly：只把「一条在话题里、一条在群主界面」的认成重复（「同时发送到群」的样子）。
   * 没 @ 的短话（「继续」）同一个人在两个话题里各说一遍，不能当成重复
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly copiesOnly = false,
  ) {}

  check(msg: NormalizedMessage): DuplicateVerdict {
    const now = this.now();
    this.prune(now);
    const key = keyOf(msg);
    const entry: Seen = {
      messageId: msg.messageId,
      threadKey: threadKeyOf(msg),
      inThread: Boolean(msg.rootId),
      sentAt: msg.createTime || now,
      seenAt: now,
    };
    const list = this.seen.get(key) ?? [];
    const twin = list.find(
      (s) =>
        s.messageId !== entry.messageId &&
        Math.abs(s.sentAt - entry.sentAt) <= DUPLICATE_WINDOW_MS &&
        (!this.copiesOnly || s.inThread !== entry.inThread),
    );
    list.push(entry);
    this.seen.set(key, list);
    if (!twin) {
      return { action: "handle" };
    }
    // 先到的是群里的副本、后到的是话题里的原消息：改为处理话题里的这条，停掉副本
    if (entry.inThread && !twin.inThread) {
      return { action: "handle", stopThreadKey: twin.threadKey, duplicateOf: twin.messageId };
    }
    return { action: "skip", duplicateOf: twin.messageId };
  }

  /** 这条（群里的）消息后来又收到了话题里的同一句：它是「同时发送到群」的副本，话题里那条已经交给别处处理 */
  hasThreadTwin(msg: NormalizedMessage): boolean {
    const sentAt = msg.createTime || this.now();
    return (this.seen.get(keyOf(msg)) ?? []).some(
      (s) => s.inThread && s.messageId !== msg.messageId && Math.abs(s.sentAt - sentAt) <= DUPLICATE_WINDOW_MS,
    );
  }

  private prune(now: number): void {
    for (const [key, list] of this.seen) {
      const kept = list.filter((s) => now - s.seenAt <= KEEP_MS);
      if (kept.length > 0) {
        this.seen.set(key, kept);
      } else {
        this.seen.delete(key);
      }
    }
  }
}

function keyOf(msg: NormalizedMessage): string {
  return `${msg.chatId}\u0000${msg.senderId}\u0000${msg.content.replace(/\s+/g, " ").trim()}`;
}
