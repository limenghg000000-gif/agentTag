import { readFile } from "node:fs/promises";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { DEFAULT_PROACTIVE_MAX_PER_HOUR } from "./config.js";
import type { FeishuApi } from "./feishu.js";
import { FileQueue, writeAtomically } from "./file-store.js";
import { JudgeQueue, MUTE_COMMAND, remember, withDeadline } from "./follow.js";
import { type Logger, recentChat } from "./history.js";
import type { ChatModel } from "./llm.js";
import { type MemoryStore, renderMemoryForPrompt } from "./memory.js";

/** 每个群每小时最多判断多少条：太热闹的群，后面的不判断，省模型费用 */
export const MAX_JUDGED_PER_HOUR = 120;
const HOUR_MS = 60 * 60_000;
/** 判断时带上之前几条群聊 */
const JUDGE_CHAT_MESSAGES = 10;
/** 判断时每条最多看多少字 */
const JUDGE_MESSAGE_CHARS = 500;
/** 判断时群记忆最多带多少字 */
const JUDGE_MEMORY_CHARS = 3000;
/** 主动回的一句话最多多少字 */
const REPLY_MAX_CHARS = 200;
const JUDGE_TIMEOUT_MS = 20_000;
/** 去掉图片标记以后少于这么多字的不判断（「好」「ok」「👍」） */
const MIN_CHARS = 4;

/** 只是表个态的不判断 */
const ACKNOWLEDGEMENT =
  /^(?:好的?|好滴|好嘞|嗯+|哦+|噢+|收到|了解|明白了?|知道了|可以|行|ok|okay|谢谢(?:大家|你)?|感谢|多谢|辛苦了?|哈+|呵+|赞|👍+|🙏+|\[[^\]]{1,8}\])[!！。.~～\s]*$/i;

/** @ 机器人说这些，这个群不再主动接话：「别主动插话」「不要主动说话」「不用主动回复了」（「只在 @ 我时回」这类也算，见 MUTE_COMMAND） */
export const PAUSE_COMMAND = /^(?:别|不要|不用|停止|关掉)\s*主动\s*(?:插话|说话|回复|回答|回)了?[。.!！~～\s]*$/;
/** @ 机器人说这些，重新打开：「可以主动说话」「恢复主动插话」「不用 @ 你也可以回」 */
export const RESUME_COMMAND =
  /^(?:(?:可以|恢复|重新|打开|开启)\s*主动\s*(?:插话|说话|回复|回答|回)(?:了|吧)?|不用\s*@\s*(?:我|你)?\s*也(?:可以|能)?\s*(?:回|回复|回答|说话)(?:了|吧)?)[。.!！~～\s]*$/;

export interface ProactiveOptions {
  /** 白名单群：别的群里说开关的话不理 */
  allowedChatIds: ReadonlySet<string>;
  /** 打开了主动接话的群（PROACTIVE_CHAT_IDS，只算白名单里的） */
  enabledChatIds: ReadonlySet<string>;
  /** 群里说「别主动插话」以后记在这里，重启后照样不主动接话 */
  stateFile: string;
  api: Pick<FeishuApi, "listChatMessages">;
  /** 群记忆：答案在群记忆里时可以直接答 */
  memory?: Pick<MemoryStore, "list">;
  /** 判断用的模型（关着思考调一次） */
  model: ChatModel;
  botName: () => string | undefined;
  botOpenId: () => string | undefined;
  /** 在这条消息下面开话题回一句 */
  reply: (msg: NormalizedMessage, markdown: string) => Promise<unknown>;
  /** 主动回了以后调用：回复开的话题交给跟聊，群成员接着说不用 @ */
  onReplied?: (msg: NormalizedMessage) => void;
  /** 判断完要回之前再问一下：这条后来发现是话题里「同时发送到群」的副本的话不回（话题里那份归跟聊） */
  superseded?: (msg: NormalizedMessage) => boolean;
  maxPerHour?: number;
  logger?: Logger;
  now?: () => number;
  /** 判断一条最多等多久（读群记忆、群聊加问模型），默认 20 秒 */
  judgeTimeoutMs?: number;
}

interface PausedState {
  /** 群 id → 谁、什么时候说的「别主动插话」 */
  paused: Record<string, { by: string; at: number }>;
}

/**
 * 主动接话（像 Claude Tag 在频道里那样）：打开了的群里，没 @ 机器人的群消息让模型看一眼，大多数不接，
 * 只在两种情况回一句：答案就在群记忆或刚才的聊天里、一两句说得清；有人提了它能帮的事、还没人接，问一句要不要它来。
 * 不会自己开始查（不调工具），每个群每小时最多回几次。群里 @ 它说「别主动插话」就停，「可以主动说话」再打开。
 */
export class ProactiveReplier {
  private paused = new Map<string, { by: string; at: number }>();
  /** 群 id → 说「可以主动说话」那条消息的时间：停着的时候群里说的话，打开以后补漏轮询再看到也不判断 */
  private readonly resumedAt = new Map<string, number>();
  private readonly replies = new Map<string, number[]>();
  private readonly judged = new Map<string, number[]>();
  /** 每个群上一次因为到了上限而跳过时记的日志，一小时只记一次 */
  private readonly capLogged = new Map<string, number>();
  /** 每个群哪天第一次主动回的：当天第一次在后面说一句怎么关 */
  private readonly hinted = new Map<string, string>();
  private readonly queue = new JudgeQueue();
  /** 每个群群主界面最新一条人发的消息：判断完要回之前看一眼，判断的这会儿有人说话了就不接 */
  private readonly latest = new Map<string, { messageId: string; at: number }>();
  /** 有人回复过的消息（话题里回、引用回）：有人接了就不接 */
  private readonly replied = new Set<string>();
  private readonly files = new FileQueue();
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly maxPerHour: number;

  constructor(private readonly opts: ProactiveOptions) {
    this.logger = opts.logger ?? console;
    this.now = opts.now ?? Date.now;
    this.maxPerHour = opts.maxPerHour ?? DEFAULT_PROACTIVE_MAX_PER_HOUR;
  }

  /** 读出之前说过「别主动插话」的群。文件不在就是都没停；读坏了打一行警告，按都没停算 */
  async init(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.opts.stateFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(`主动接话：读不了 ${this.opts.stateFile}，先按所有群都没停算`, err);
      }
      return;
    }
    try {
      const state = JSON.parse(raw) as PausedState;
      this.paused = new Map(Object.entries(state.paused ?? {}));
    } catch (err) {
      this.logger.warn(`主动接话：${this.opts.stateFile} 格式不对，先按所有群都没停算`, err);
    }
  }

  /** 群里人发的每条消息（@ 不 @ 都算）都报给它：判断完要回之前，看判断的这会儿有没有人接了话 */
  noteActivity(msg: NormalizedMessage): void {
    if (!this.opts.enabledChatIds.has(msg.chatId) || !msg.senderId.startsWith("ou_") || msg.senderId === this.opts.botOpenId()) {
      return;
    }
    if (msg.rootId) {
      remember(this.replied, msg.rootId);
    }
    const at = msg.createTime || this.now();
    const last = this.latest.get(msg.chatId);
    if (!inTopic(msg) && (!last || at >= last.at)) {
      this.latest.set(msg.chatId, { messageId: msg.messageId, at });
    }
  }

  /** 这条之后群主界面又有人说了话，或者有人回复了这条 */
  private movedOn(msg: NormalizedMessage): boolean {
    const last = this.latest.get(msg.chatId);
    return this.replied.has(msg.messageId) || (last !== undefined && last.messageId !== msg.messageId && last.at > msg.createTime);
  }

  /** 这个群现在主动接话：在 PROACTIVE_CHAT_IDS 里，也没人说过「别主动插话」 */
  active(chatId: string): boolean {
    return this.opts.enabledChatIds.has(chatId) && !this.paused.has(chatId);
  }

  /**
   * 这条没 @ 机器人的消息要不要判断：主动接话的群里、群主界面的（话题里的归跟聊）、人发的、没 @ 别人、
   * 不是 @所有人、去掉图片还有几个字、不只是表个态
   */
  wants(msg: NormalizedMessage, fromApp = false): boolean {
    if (msg.mentionedBot || msg.mentionAll || fromApp || msg.threadId || !this.active(msg.chatId)) {
      return false;
    }
    if (msg.createTime && msg.createTime < (this.resumedAt.get(msg.chatId) ?? 0)) {
      return false;
    }
    if (!msg.senderId.startsWith("ou_") || msg.senderId === this.opts.botOpenId() || msg.mentions.length > 0) {
      return false;
    }
    const text = msg.content.replace(/!\[image\]\([^)]*\)/g, "").trim();
    return text.length >= MIN_CHARS && !ACKNOWLEDGEMENT.test(text);
  }

  /**
   * 群主界面 @ 机器人说「别主动插话」「只在 @ 我时回」「可以主动说话」：开关这个群的主动接话，回一句。返回 true 表示处理了。
   * 「只在 @ 我时回」只在打开了主动接话的群里算（别的群里它是在说这个话题，交给跟聊）
   */
  async toggleIfAsked(msg: NormalizedMessage): Promise<boolean> {
    const replied = this.toggle(msg);
    if (!replied) {
      return false;
    }
    await replied;
    return true;
  }

  /**
   * 同 toggleIfAsked，不是开关的话时同步返回 undefined，是的话马上开关、返回存文件和回那一句的 Promise。
   * 给消息处理函数用：不是开关的话时不多等一拍，处理函数照样当场排进任务队列
   */
  toggle(msg: NormalizedMessage): Promise<void> | undefined {
    if (!msg.mentionedBot || inTopic(msg) || !this.opts.allowedChatIds.has(msg.chatId)) {
      return undefined;
    }
    const text = msg.content.trim();
    const enabled = this.opts.enabledChatIds.has(msg.chatId);
    const pause = PAUSE_COMMAND.test(text) || (enabled && MUTE_COMMAND.test(text));
    const resume = RESUME_COMMAND.test(text);
    if (!pause && !resume) {
      return undefined;
    }
    if (!enabled) {
      return this.opts
        .reply(msg, "这个群没开主动接话，我本来就只在被 @ 时回（我回答过的话题里，追问不用 @）。要打开，请管理员把这个群加进 PROACTIVE_CHAT_IDS。")
        .then(() => undefined);
    }
    if (pause) {
      this.paused.set(msg.chatId, { by: msg.senderId, at: this.now() });
    } else {
      this.paused.delete(msg.chatId);
      this.resumedAt.set(msg.chatId, msg.createTime || this.now());
    }
    this.logger.info(`主动接话：${pause ? "停了" : "打开了"} chat=${msg.chatId} sender=${msg.senderId}`);
    return this.saveAndReply(msg, pause);
  }

  private async saveAndReply(msg: NormalizedMessage, pause: boolean): Promise<void> {
    try {
      await this.save();
    } catch (err) {
      // 存不下来也照样生效，只是重启后恢复原样
      this.logger.error(`主动接话：保存开关失败，重启后会恢复原样 chat=${msg.chatId}`, err);
    }
    await this.opts.reply(
      msg,
      pause
        ? "好的，这个群里我不主动接话了，只在被 @ 时回（我回答过的话题里，追问照样不用 @）。要重新打开，@ 我说「可以主动说话」。"
        : `好的，这个群里我会看情况主动接一句：有人问的事群记忆或刚才的聊天里有答案，或者提了我能帮的事，每小时最多 ${this.maxPerHour} 次。不想要了就 @ 我说「别主动插话」。`,
    );
  }

  /** 判断要不要接这条（调用前先用 wants 筛过），要接就在它下面开话题回一句 */
  async consider(msg: NormalizedMessage): Promise<void> {
    const chatId = msg.chatId;
    if (recent(this.replies, chatId, this.now()) >= this.maxPerHour) {
      this.logCap(chatId, `这一小时已经主动回了 ${this.maxPerHour} 次`);
      return;
    }
    if (recent(this.judged, chatId, this.now()) >= MAX_JUDGED_PER_HOUR) {
      this.logCap(chatId, `这一小时已经判断了 ${MAX_JUDGED_PER_HOUR} 条`);
      return;
    }
    // 先占上一次判断的名额（几条同时来时不超过上限）；排不上队、排队时停了的没问模型，退回来
    const judgedAt = this.now();
    push(this.judged, chatId, judgedAt);
    const startedAt = this.now();
    let said: string | undefined;
    let paused = false;
    try {
      // 在判断队列里排着的这会儿可能有人说了「别主动插话」：轮到时再看一遍，停了就不再把这条发给模型
      const judged = await this.queue.run(() => {
        if (!this.wants(msg)) {
          paused = true;
          return Promise.resolve(undefined);
        }
        return this.judge(msg);
      });
      if (paused) {
        unpush(this.judged, chatId, judgedAt);
        this.logger.info(`主动接话：排队的这会儿群里说了别主动插话，这条不判断 chat=${chatId} message=${msg.messageId}`);
        return;
      }
      if (!judged) {
        unpush(this.judged, chatId, judgedAt);
        this.logger.warn(`主动接话：要判断的消息太多（${this.queue.load}），这条不判断 message=${msg.messageId}`);
        return;
      }
      said = judged.value;
    } catch (err) {
      this.logger.warn(`主动接话：判断失败，这条不接 message=${msg.messageId}：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.logger.info(`主动接话：${said ? "接一句" : "不接"} chat=${chatId} message=${msg.messageId} 用时=${this.now() - startedAt}ms`);
    // 判断的这会儿可能有人说了「别主动插话」，或者别的消息先回了、到了上限，或者话题里的原消息到了
    if (!said || !this.active(chatId) || recent(this.replies, chatId, this.now()) >= this.maxPerHour || this.opts.superseded?.(msg)) {
      return;
    }
    // 判断的这会儿群里又有人说话、或者有人回了这条：可能已经有人接了，判断时没看到，不接
    if (this.movedOn(msg)) {
      this.logger.info(`主动接话：判断的这会儿群里又有人说话了，这条不接 chat=${chatId} message=${msg.messageId}`);
      return;
    }
    // 先占上这一次（几条同时判断完时不超过上限），发不出去再退回来
    const at = this.now();
    push(this.replies, chatId, at);
    const today = new Date(at).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
    const hinting = this.hinted.get(chatId) !== today;
    const hint = hinting ? "\n\n（没 @ 我，我看到了就接一句。不需要的话 @ 我说「别主动插话」。）" : "";
    try {
      await this.opts.reply(msg, said + hint);
    } catch (err) {
      unpush(this.replies, chatId, at);
      this.logger.warn(`主动接话：回复发不出去 chat=${chatId} message=${msg.messageId}`, err);
      return;
    }
    if (hinting) {
      this.hinted.set(chatId, today);
    }
    this.opts.onReplied?.(msg);
  }

  /** 问模型接不接，接的话返回要说的那句话（尖括号换成全角：不能变成 @所有人 这类标签） */
  /** 读群记忆、群聊也算在时限里：飞书接口卡住时照样按时结束，不一直占着判断的名额 */
  private judge(msg: NormalizedMessage): Promise<string | undefined> {
    return withDeadline(this.opts.judgeTimeoutMs ?? JUDGE_TIMEOUT_MS, (signal) => this.judgeWithin(msg, signal));
  }

  private async judgeWithin(msg: NormalizedMessage, signal: AbortSignal): Promise<string | undefined> {
    const [memory, chat] = await Promise.all([
      this.opts.memory
        ? this.opts.memory
            .list(msg.chatId)
            .then((entries) => renderMemoryForPrompt(entries, JUDGE_MEMORY_CHARS).text)
            .catch(() => "")
        : Promise.resolve(""),
      recentChat(this.opts.api, msg, JUDGE_CHAT_MESSAGES).catch(() => []),
    ]);
    const content = [
      "群记忆：",
      memory || "（没有）",
      "",
      "刚才的群聊：",
      ...(chat.length > 0 ? chat.map((m) => `[${m.senderName || "群成员"}] ${clip(m.content)}`) : ["（没有）"]),
      "",
      `新消息（没有 @ 你）：[${msg.senderName || "群成员"}] ${clip(msg.content.trim())}`,
    ].join("\n");
    const result = await this.opts.model.chat({
      system: judgePrompt(this.opts.botName() || "机器人"),
      messages: [{ role: "user", content }],
      thinking: false,
      signal,
    });
    const said = /^[\s*「"']*接\s*[:：]\s*([\s\S]+)$/.exec(result.text.trim())?.[1].trim();
    if (!said) {
      return undefined;
    }
    const line = said.replace(/</g, "＜").replace(/>/g, "＞");
    return line.length <= REPLY_MAX_CHARS ? line : `${line.slice(0, REPLY_MAX_CHARS)}…`;
  }

  private logCap(chatId: string, reason: string): void {
    const last = this.capLogged.get(chatId);
    if (last !== undefined && this.now() - last < HOUR_MS) {
      return;
    }
    this.capLogged.set(chatId, this.now());
    this.logger.info(`主动接话：${reason}，这一小时后面的先不判断 chat=${chatId}`);
  }

  /** 排队写：几个群同时开关时，写文件不互相覆盖（每次写的都是写的那一刻的状态） */
  private async save(): Promise<void> {
    await this.files.run(this.opts.stateFile, () => {
      const state: PausedState = { paused: Object.fromEntries(this.paused) };
      return writeAtomically(this.opts.stateFile, `${JSON.stringify(state, null, 2)}\n`);
    });
  }
}

/** 一小时内的次数（顺手删掉一小时以前的） */
function recent(times: Map<string, number[]>, chatId: string, now: number): number {
  const kept = (times.get(chatId) ?? []).filter((at) => now - at < HOUR_MS);
  times.set(chatId, kept);
  return kept.length;
}

function push(times: Map<string, number[]>, chatId: string, at: number): void {
  times.set(chatId, [...(times.get(chatId) ?? []), at]);
}

function unpush(times: Map<string, number[]>, chatId: string, at: number): void {
  const list = times.get(chatId) ?? [];
  const index = list.lastIndexOf(at);
  if (index >= 0) {
    times.set(chatId, [...list.slice(0, index), ...list.slice(index + 1)]);
  }
}

/**
 * 是话题里的回复（不是群主界面的消息）。不能只看 threadId：群主界面的消息有人回复后变成话题的第一条，
 * 补漏轮询读到它时也带着 threadId；引用回复只有 rootId
 */
function inTopic(msg: NormalizedMessage): boolean {
  return Boolean(msg.rootId && msg.threadId);
}

function clip(text: string): string {
  return text.length <= JUDGE_MESSAGE_CHARS ? text : `${text.slice(0, JUDGE_MESSAGE_CHARS)}…`;
}

function judgePrompt(botName: string): string {
  return [
    `你是飞书群里的机器人「${botName}」，能查线上问题、读代码、读写飞书文档、记群里的约定。群成员一般 @ 你派活。`,
    "下面这条群消息没有 @ 你。判断你要不要主动接一句。大多数时候不接。",
    "只在两种情况接：",
    "1. 有人问了问题，答案就在下面的群记忆或刚才的群聊里，一两句话说得清：直接回答，说明出处（「群记忆 #3」「刚才张三说的」）。",
    "2. 有人明确说了一件你能帮上的事（查线上报错、看代码、整理文档、找以前定过的事），群里还没人接：用一句话问要不要你来，说清你会怎么帮。不要自己开始查，也不要先给结论。",
    "不接的：闲聊、表态、通知、转发、群成员之间已经在处理的事、意思不清楚的、你帮不上的。拿不准就不接。",
    "不能编：线上数据、代码位置、数字、结论只能照抄群记忆或刚才群聊里的原文；没有的话最多只问要不要帮忙。",
    "只输出一行。不接就输出「不接」；接就输出「接：」加上要发的话，不超过 100 字。",
  ].join("\n");
}
