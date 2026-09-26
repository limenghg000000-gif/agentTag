import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { FeishuApi } from "./feishu.js";
import { describeFeishuError, type Logger } from "./history.js";

/** 两次轮询的默认间隔 */
export const DEFAULT_CATCHUP_INTERVAL_MS = 10_000;
/** 消息发出后等这么久还没从事件收到，才由轮询补上，免得和正常到达的事件抢 */
export const CATCHUP_GRACE_MS = 3_000;
/** 只补最近这么久内发的消息 */
export const CATCHUP_LOOKBACK_MS = 5 * 60_000;
/** 机器人参与过的话题，最后一次有动静之后继续盯多久 */
export const THREAD_WATCH_MS = 2 * 60 * 60_000;
/** 每个群、每个话题每次读多少条 */
const PAGE_SIZE = 30;

/**
 * 已经处理（或正在处理）的消息 id。事件和轮询都要先在这里认领，同一条消息只处理一次。
 * 只记最近的若干条，够覆盖轮询回看的时间窗。
 */
export class HandledMessages {
  private readonly ids = new Set<string>();

  constructor(private readonly max = 5000) {}

  /** 第一次认领返回 true；已经被认领过返回 false */
  claim(messageId: string): boolean {
    if (this.ids.has(messageId)) {
      return false;
    }
    this.ids.add(messageId);
    if (this.ids.size > this.max) {
      this.ids.delete(this.ids.values().next().value!);
    }
    return true;
  }

  has(messageId: string): boolean {
    return this.ids.has(messageId);
  }
}

export interface CatchUpOptions {
  api: Pick<FeishuApi, "listRecentMessages">;
  /** 只轮询这些群（群白名单） */
  chatIds: ReadonlySet<string>;
  handled: HandledMessages;
  /** 补上的消息交给它处理，和事件走同一个处理函数 */
  handle: (msg: NormalizedMessage) => Promise<void>;
  intervalMs?: number;
  logger?: Logger;
  now?: () => number;
  /** 只补这个时间之后发的消息（启动时间），重启后不会去回复很久以前的 @ */
  since?: number;
}

/**
 * 轮询补漏。同一个飞书应用如果还有别的程序连着长连接，飞书会把每个事件随机推给其中一个，
 * 推给别人的 @ 机器人就收不到。这里定时读白名单群和机器人参与过的话题里的新消息，
 * 找出 @ 了机器人、却没从事件收到的，补上处理。
 */
export class CatchUpPoller {
  private readonly api: Pick<FeishuApi, "listRecentMessages">;
  private readonly chatIds: ReadonlySet<string>;
  private readonly handled: HandledMessages;
  private readonly handle: (msg: NormalizedMessage) => Promise<void>;
  private readonly intervalMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly since: number;
  /** 盯着的话题：话题 id → 最后一次有动静的时间 */
  private readonly threads = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private failing = false;

  constructor(opts: CatchUpOptions) {
    this.api = opts.api;
    this.chatIds = opts.chatIds;
    this.handled = opts.handled;
    this.handle = opts.handle;
    this.intervalMs = opts.intervalMs ?? DEFAULT_CATCHUP_INTERVAL_MS;
    this.logger = opts.logger ?? console;
    this.now = opts.now ?? Date.now;
    this.since = opts.since ?? this.now();
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  /** 停止轮询，等进行中的那一轮读完 */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.polling;
  }

  /** 机器人处理了一条话题里的消息后调用，之后也盯着这个话题里的追问 */
  watch(msg: NormalizedMessage): void {
    if (msg.threadId && this.chatIds.has(msg.chatId)) {
      this.threads.set(msg.threadId, this.now());
    }
  }

  get watchedThreads(): number {
    return this.threads.size;
  }

  /** 读一轮，返回补上了几条 */
  async pollOnce(): Promise<number> {
    const now = this.now();
    const from = Math.max(this.since, now - CATCHUP_LOOKBACK_MS);
    const until = now - CATCHUP_GRACE_MS;
    let picked = 0;

    for (const chatId of this.chatIds) {
      for (const { message, fromBot } of await this.api.listRecentMessages("chat", chatId, PAGE_SIZE, from)) {
        // 机器人回复过的消息会变成话题的第一条，接着盯这个话题里的追问
        if (message.threadId && this.handled.has(message.messageId)) {
          this.threads.set(message.threadId, now);
        }
        picked += this.pickUp(message, fromBot, from, until);
      }
    }
    for (const [threadId, lastActive] of this.threads) {
      if (now - lastActive > THREAD_WATCH_MS) {
        this.threads.delete(threadId);
        continue;
      }
      for (const { message, fromBot } of await this.api.listRecentMessages("thread", threadId, PAGE_SIZE)) {
        picked += this.pickUp(message, fromBot, from, until);
      }
    }
    return picked;
  }

  private tick(): void {
    // 上一轮还没读完（比如飞书接口慢）就跳过这一轮
    if (this.polling) {
      return;
    }
    this.polling = this.pollOnce()
      .then(() => {
        if (this.failing) {
          this.failing = false;
          this.logger.info("补漏轮询恢复正常");
        }
      })
      .catch((err) => {
        // 接口一直失败时只提示一次，恢复后再提示
        if (!this.failing) {
          this.failing = true;
          this.logger.warn(`补漏轮询读取消息失败，先跳过：${describeFeishuError(err)}`);
        }
      })
      .finally(() => {
        this.polling = undefined;
      });
  }

  private pickUp(message: NormalizedMessage, fromBot: boolean, from: number, until: number): number {
    // 和事件那边的规则一致：只处理白名单群里 @ 了机器人的消息，@所有人 不算
    if (fromBot || !message.mentionedBot || message.mentionAll || !this.chatIds.has(message.chatId)) {
      return 0;
    }
    if (message.createTime < from || message.createTime > until || !this.handled.claim(message.messageId)) {
      return 0;
    }
    this.logger.info(`补漏：事件没送到，由轮询补上 chat=${message.chatId} message=${message.messageId}`);
    this.watch(message);
    // 不等任务做完，任务可能要跑一两分钟，别耽误下一轮轮询
    void this.handle(message).catch((err) => this.logger.error(`补漏处理失败 message=${message.messageId}`, err));
    return 1;
  }
}
