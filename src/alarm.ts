import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { Logger } from "./history.js";

/** 最近这段时间里补上这么多条才报警，偶尔一条可能只是推送慢 */
export const ALARM_THRESHOLD = 2;
export const ALARM_WINDOW_MS = 30 * 60_000;
/** 补上之后再等这么久，事件还没到才算被别处拿走（晚到的事件不算） */
export const ALARM_CONFIRM_MS = 60_000;
/** 报过一次之后，这么久内不再重复报 */
export const ALARM_COOLDOWN_MS = 60 * 60_000;

export interface MissedEventAlarmOptions {
  /** 发一条消息到群里 */
  notify: (chatId: string, text: string) => Promise<unknown>;
  /** 报警发到这个群；不填就发到漏了消息的那个群 */
  chatId?: string;
  logger?: Logger;
  now?: () => number;
  /** 过一段时间再执行，测试时可以换掉 */
  schedule?: (fn: () => void, ms: number) => void;
}

/**
 * 补漏报警。正常情况下事件都会送到，轮询一条也补不上；补上的多了，说明有别的程序连着同一个飞书应用在分走事件，
 * 在群里提醒一次，别等到有人发现「机器人怎么有时不回」才去查。
 */
export class MissedEventAlarm {
  private readonly notify: (chatId: string, text: string) => Promise<unknown>;
  private readonly chatId?: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;
  /** 轮询补上、事件一直没到的消息：消息 id → 补上的时间 */
  private readonly missed = new Map<string, number>();
  private lastAlarmAt = -Infinity;

  constructor(opts: MissedEventAlarmOptions) {
    this.notify = opts.notify;
    this.chatId = opts.chatId;
    this.logger = opts.logger ?? console;
    this.now = opts.now ?? Date.now;
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        setTimeout(fn, ms).unref();
      });
  }

  /** 轮询补上了一条消息 */
  record(msg: NormalizedMessage): void {
    this.missed.set(msg.messageId, this.now());
    this.schedule(() => this.check(msg.chatId), ALARM_CONFIRM_MS);
  }

  /** 事件晚到了：这条不是被别处拿走，只是推送慢，不算 */
  arrivedLate(messageId: string): void {
    this.missed.delete(messageId);
  }

  /** 够数就报警，返回这次有没有报 */
  check(missedInChatId: string): boolean {
    const now = this.now();
    let confirmed = 0;
    for (const [messageId, at] of this.missed) {
      if (now - at > ALARM_WINDOW_MS) {
        this.missed.delete(messageId);
      } else if (now - at >= ALARM_CONFIRM_MS) {
        confirmed++;
      }
    }
    if (confirmed < ALARM_THRESHOLD || now - this.lastAlarmAt < ALARM_COOLDOWN_MS) {
      return false;
    }
    this.lastAlarmAt = now;
    const target = this.chatId ?? missedInChatId;
    this.logger.warn(`补漏报警：最近 30 分钟有 ${confirmed} 条 @ 的事件没送到，已在群 ${target} 提醒`);
    void this.notify(target, alarmText(confirmed)).catch((err) =>
      this.logger.error(`补漏报警发送失败 chat=${target}`, err),
    );
    return true;
  }
}

function alarmText(count: number): string {
  return [
    `⚠️ 补漏报警：最近 30 分钟有 ${count} 条 @ 我的消息，飞书没有把事件推给我，是轮询补上的，所以回复晚了几秒。`,
    "多半是有别的程序也用这个飞书应用连着长连接，在分走消息。可以在服务器上运行 `journalctl --user -u agenttag-feishu | grep 补漏` 看是哪几条。",
    "1 小时内不再重复提醒。",
  ].join("\n\n");
}
