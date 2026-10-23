import { randomUUID } from "node:crypto";
import type { CardActionEvent, NormalizedMessage, SendInput, SendOptions, SendResult } from "@larksuiteoapi/node-sdk";
import { type Logger, threadKeyOf } from "./history.js";
import { escapeCardMarkdown } from "./markdown.js";
import type { ConfirmPreview } from "./tools/tool.js";

/** 确认卡片按钮上的 action */
export const CONFIRM_ACTION = "confirm_write";
/** 等提问的人确认最多等多久，没点就不做 */
export const CONFIRM_WAIT_MS = 15 * 60_000;
/** 定了的卡片记住多少张：定了以后又有人点（双击、别人在卡片改好之前点了），照定了的结果重画，不说成没做 */
const KEEP_SETTLED = 200;
/** 话题里回过的「确认」「取消」记住多少条：同一条消息补漏轮询和事件各送来一次时，只算第一次 */
const KEEP_ANSWERS = 1000;
/** 话题里回的字要在开始请他确认以后发的；飞书和服务器的时钟可能差一点，放宽几秒 */
const CLOCK_SLACK_MS = 5_000;

/** confirmed 点了确认；cancelled 点了取消；expired 到时间没人确认；stopped 任务停了；unsent 卡片发不出去 */
export type ConfirmOutcome = "confirmed" | "cancelled" | "expired" | "stopped" | "unsent";

export interface ConfirmRequest {
  chatId: string;
  /** 话题标识（见 threadKeyOf）：在话题里回「确认」时按它找 */
  threadKey: string;
  /** 提问的那条消息：卡片发在它的话题里 */
  replyTo: string;
  /** 提问的人的 open_id：只有他能确认 */
  asker: string;
  preview: ConfirmPreview;
  /** 任务停了（说「停止」、点停止按钮）就不等了 */
  signal: AbortSignal;
}

export interface WriteConfirmsOptions {
  send: (to: string, input: SendInput, opts?: SendOptions) => Promise<SendResult>;
  updateCard: (messageId: string, card: object) => Promise<void>;
  logger?: Logger;
  /** 等多久，不填 15 分钟（测试时调短） */
  waitMs?: number;
}

interface Pending {
  id: string;
  request: ConfirmRequest;
  /** 开始请他确认的时间：在这之前发的「好」「确认」不算 */
  askedAt: number;
  /** 卡片消息；发出去以后才有 */
  cardMessageId?: string;
  /** 每画一次加一，按钮上带着它：同一个按钮再点一次飞书 SDK 也不会当成重复的丢掉 */
  rev: number;
  /** 卡片上额外的一句：别人点了不算 */
  note?: string;
  /** 结果定了：卡片还没发出去时先记着，发出去以后再改卡片 */
  outcome?: { result: ConfirmOutcome; by?: string };
  settle(result: ConfirmOutcome, by?: string): void;
}

/** 在话题里回的「确认」「取消」：整句就是这几个字（结尾可以带标点） */
const YES = /^(?:确认|确定|同意|可以|好|好的|行|没问题|做吧|开吧|合吧|改吧|推吧|ok|okay|yes)$/i;
const NO = /^(?:取消|不用了?|算了|不要|别做了?|不做了|不行|no)$/i;
const TRAILING = /[。.!！~～\s]+$/;

/**
 * 改东西之前请提问的人确认（CONFIRM_WRITES）：推代码开合并请求、合并、改已有的飞书文档这类工具调用前，在话题里发一张卡片写清要做什么，
 * 提问的人点「确认」（或者在话题里回「确认」）才做；点「取消」、说「停止」、15 分钟没人确认都不做。
 * 按钮直接走程序，不经过模型：模型、群里别人的话都替不了他点。别人点了在卡片上写一句，不算
 */
export class WriteConfirms {
  private readonly pending = new Map<string, Pending>();
  /** 已经定了的卡片（最近 KEEP_SETTLED 张） */
  private readonly settled = new Map<string, Pending>();
  /** 话题里回过的确认、取消：消息 id → 那次有没有定下等着确认的 */
  private readonly answers = new Map<string, boolean>();
  private readonly logger: Logger;
  private readonly waitMs: number;

  constructor(private readonly opts: WriteConfirmsOptions) {
    this.logger = opts.logger ?? console;
    this.waitMs = opts.waitMs ?? CONFIRM_WAIT_MS;
  }

  /** 发确认卡片，等提问的人点。卡片发不出去时不做（unsent） */
  ask(request: ConfirmRequest): Promise<ConfirmOutcome> {
    if (request.signal.aborted) {
      return Promise.resolve("stopped");
    }
    return new Promise((resolve) => {
      const id = randomUUID();
      const onAbort = () => entry.settle("stopped");
      const timer = setTimeout(() => entry.settle("expired"), this.waitMs);
      const entry: Pending = {
        id,
        request,
        askedAt: Date.now(),
        rev: 0,
        settle: (result, by) => {
          if (entry.outcome) {
            return;
          }
          entry.outcome = { result, ...(by ? { by } : {}) };
          clearTimeout(timer);
          request.signal.removeEventListener("abort", onAbort);
          this.pending.delete(id);
          this.settled.set(id, entry);
          trim(this.settled, KEEP_SETTLED);
          this.logger.info(`确认卡片：${request.preview.title} ${OUTCOME_LOG[result]}${by ? ` operator=${by}` : ""} message=${request.replyTo}`);
          if (entry.cardMessageId) {
            this.close(entry);
          }
          resolve(result);
        },
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, entry);
      this.opts
        .send(request.chatId, { card: this.card(entry) }, { replyTo: request.replyTo, replyInThread: true })
        .then(({ messageId }) => {
          entry.cardMessageId = messageId;
          // 卡片发出去之前就定了（任务停了）：现在改掉卡片上的按钮
          if (entry.outcome) {
            this.close(entry);
          }
        })
        .catch((err: unknown) => {
          this.logger.error(`确认卡片发不出去，这次不做 message=${request.replyTo}`, err);
          entry.settle("unsent");
        });
    });
  }

  /** 确认卡片上的按钮。不是确认卡片返回 false */
  async handleCardAction(evt: CardActionEvent): Promise<boolean> {
    const value = evt.action.value as { action?: unknown; id?: unknown; op?: unknown } | undefined;
    if (value?.action !== CONFIRM_ACTION || typeof value.id !== "string") {
      return false;
    }
    const done = this.settled.get(value.id);
    if (done) {
      // 已经定了（双击、别人在卡片改好之前点了）：照定了的结果再画一次，不改结果
      if (done.cardMessageId === evt.messageId && done.request.chatId === evt.chatId) {
        this.close(done);
      }
      return true;
    }
    const entry = this.pending.get(value.id);
    if (!entry || entry.cardMessageId !== evt.messageId || entry.request.chatId !== evt.chatId) {
      // 机器人重启过、记不得的旧卡片：按钮换成一句说明，免得以为点了就做了。做没做记不得了，不说没做
      if (!entry) {
        await this.opts
          .updateCard(evt.messageId, closedCard("确认卡片已经失效", "这张卡片已经失效（机器人重启过，或者已经处理过），点了不算。做没做以话题里的回答为准，要做请 @ 我再说一次。", "grey"))
          .catch((err: unknown) => this.logger.warn(`确认卡片：改失效的卡片失败 card=${evt.messageId}`, err));
      }
      return true;
    }
    if (evt.operator.openId !== entry.request.asker) {
      entry.note = `${personTag(evt.operator.openId)} 点的不算：只有提问的 ${personTag(entry.request.asker)} 能确认。`;
      entry.rev++;
      this.logger.info(`确认卡片：不是提问的人点的，不算 operator=${evt.operator.openId} message=${entry.request.replyTo}`);
      await this.opts.updateCard(evt.messageId, this.card(entry)).catch((err: unknown) => this.logger.warn(`确认卡片：更新卡片失败 card=${evt.messageId}`, err));
      return true;
    }
    if (value.op === "yes" || value.op === "no") {
      entry.settle(value.op === "yes" ? "confirmed" : "cancelled", evt.operator.openId);
    }
    return true;
  }

  /**
   * 提问的人在话题里回了「确认」「取消」：这个话题里等他确认的都按这句定，返回 true（这句不再当成提问）。
   * 只认他本人在同一个话题里、开始请他确认以后发的、整句就是这几个字的（@ 没 @ 都算）。
   * 同一条消息只算一次：补漏轮询和事件各送来一次时，第二次照第一次的结果返回，不去定后来又等着确认的
   */
  answer(msg: NormalizedMessage): boolean {
    const text = msg.content.trim().replace(TRAILING, "");
    const result: ConfirmOutcome | undefined = YES.test(text) ? "confirmed" : NO.test(text) ? "cancelled" : undefined;
    if (!result) {
      return false;
    }
    const seen = this.answers.get(msg.messageId);
    if (seen !== undefined) {
      return seen;
    }
    const threadKey = threadKeyOf(msg);
    const waiting = [...this.pending.values()].filter(
      (entry) =>
        entry.request.chatId === msg.chatId &&
        entry.request.threadKey === threadKey &&
        entry.request.asker === msg.senderId &&
        !entry.outcome &&
        !(msg.createTime > 0 && msg.createTime < entry.askedAt - CLOCK_SLACK_MS),
    );
    for (const entry of waiting) {
      entry.settle(result, msg.senderId);
    }
    this.answers.set(msg.messageId, waiting.length > 0);
    trim(this.answers, KEEP_ANSWERS);
    return waiting.length > 0;
  }

  /** 定了以后改卡片：按钮去掉，写清做没做 */
  private close(entry: Pending): void {
    const { result, by } = entry.outcome!;
    const { title, lines } = entry.request.preview;
    const who = by ? personTag(by) : "";
    const [heading, body, template] =
      result === "confirmed"
        ? [`已确认：${title}`, `${who} 确认了，正在做：\n${bullets(lines)}`, "green"]
        : result === "cancelled"
          ? [`没做：${title}`, `${who} 取消了，这件事没做。`, "grey"]
          : result === "expired"
            ? [`没做：${title}`, `${Math.round(this.waitMs / 60_000)} 分钟没人确认，这件事没做。要做请 @ 我再说一次。`, "grey"]
            : [`没做：${title}`, "任务停了，这件事没做。", "grey"];
    this.opts
      .updateCard(entry.cardMessageId!, closedCard(heading, body, template))
      .catch((err: unknown) => this.logger.warn(`确认卡片：更新卡片失败 card=${entry.cardMessageId}`, err));
  }

  private card(entry: Pending): object {
    const { title, lines } = entry.request.preview;
    const value = (op: string) => ({ action: CONFIRM_ACTION, id: entry.id, op, r: String(entry.rev) });
    const minutes = Math.round(this.waitMs / 60_000);
    return card(`确认一下：${title}`, "orange", [
      markdown(`<at id=${entry.request.asker}></at> 我要做下面这件事，你点「确认」我才做：\n${bullets(lines)}`),
      ...(entry.note ? [markdown(entry.note)] : []),
      markdown(grey(`在话题里回「确认」「取消」也行。只有提问的人能确认，${minutes} 分钟没确认就不做了。`)),
      buttons([actionButton("确认", "primary", value("yes")), actionButton("取消", "default", value("no"))]),
    ]);
  }
}

const OUTCOME_LOG: Record<ConfirmOutcome, string> = {
  confirmed: "提问的人确认了",
  cancelled: "提问的人取消了，不做",
  expired: "没人确认，到时间不做了",
  stopped: "任务停了，不做",
  unsent: "卡片发不出去，不做",
};

/** 只留最近放进去的 max 个 */
function trim(map: Map<string, unknown>, max: number): void {
  while (map.size > max) {
    map.delete(map.keys().next().value!);
  }
}

/** 要做的事一行一条：别处来的文字（分支名、文件名、文档内容）转义后放进卡片 */
function bullets(lines: readonly string[]): string {
  return lines.map((line) => `- ${escapeCardMarkdown(line)}`).join("\n");
}

function personTag(openId: string): string {
  return `<person id='${openId}' show_name=true show_avatar=false style='normal'></person>`;
}

function grey(text: string): string {
  return `<font color='grey'>${escapeCardMarkdown(text)}</font>`;
}

function markdown(content: string): object {
  return { tag: "markdown", content };
}

function actionButton(text: string, type: string, value: Record<string, string>): object {
  return { tag: "button", text: { tag: "plain_text", content: text }, type, size: "small", behaviors: [{ type: "callback", value }] };
}

function buttons(list: readonly object[]): object {
  return { tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: list.map((button) => ({ tag: "column", width: "auto", elements: [button] })) };
}

function card(title: string, template: string, elements: readonly object[]): object {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: title } },
    header: { title: { tag: "plain_text", content: title }, template },
    body: { elements },
  };
}

function closedCard(title: string, body: string, template: string): object {
  return card(title, template, [markdown(body)]);
}
