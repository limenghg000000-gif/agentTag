import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { STOP_COMMAND } from "./bot.js";
import { type Logger, type ThreadContext, threadKeyOf } from "./history.js";
import type { ChatModel } from "./llm.js";

/** 话题里最后一次 @ 机器人（或机器人接着回过）之后，跟多久 */
export const FOLLOW_WINDOW_MS = 2 * 60 * 60_000;
/** 最多同时跟多少个话题、记多少个静音的话题，超出时先忘掉最早的 */
const MAX_THREADS = 2000;
/** 最多同时判断几条，多的排队（事件断了一阵、补漏轮询一次补上很多条时，别把模型的并发占满） */
const MAX_JUDGING = 3;
/** 排队等判断的最多几条，再多的不判断了（多半是事件断了很久，补上来的都是旧消息） */
const MAX_WAITING = 20;
/** 判断时看话题里最近几条 */
const JUDGE_MESSAGES = 8;
/** 判断时每条最多看多少字 */
const JUDGE_MESSAGE_CHARS = 500;
/** 判断最多等多久，超时算不用回 */
const JUDGE_TIMEOUT_MS = 20_000;

/**
 * 在话题里说这些，这个话题之后只在 @ 它时才回（@ 不 @ 都算）：
 * 「只在 @ 我时回」「@ 你再回」「只有 @ 你才说话」「别插话」「不用回了」「不用你回」「别回了」「闭嘴」「安静点」。
 * 要整句都是这个意思才算：「不用回滚了」「别回退版本」不是
 */
export const MUTE_COMMAND =
  /^(?:(?:以后|之后|后面)?(?:只在|只有|仅在)?\s*@\s*(?:我|你)\s*(?:的时候|时)?\s*(?:你)?(?:再|才)?\s*(?:回|回答|回复|说话)(?:吧|就行|就好)?|别插话了?|不要插话了?|不用(?:你)?回(?:了|复了?)?|别回了|闭嘴|别说话了?|安静(?:点|一点)?)[。.!！~～\s]*$/;

export const MUTED_REPLY = "好的，这个话题里之后只在 @ 我时回。";

export interface ThreadFollowerOptions {
  /** 只跟白名单群里的话题 */
  allowedChatIds: ReadonlySet<string>;
  /** 读话题上文（和回答时用的同一个），判断时看最近几条 */
  context: { load(msg: NormalizedMessage): Promise<ThreadContext> };
  /** 判断用的模型（关着思考调一次） */
  model: ChatModel;
  botName: () => string | undefined;
  /** 机器人自己的 open_id：它自己发的消息不跟（飞书一般不推机器人自己发的，万一推了也不能自己接自己的话） */
  botOpenId: () => string | undefined;
  /** 这个话题里机器人有没有正在做的任务（见 TaskRegistry.busy）。在做时说「停止」直接停，不用判断 */
  busy?: (threadKey: string) => boolean;
  /** 判断要回的消息交给它，和 @ 机器人的消息走同一个处理函数 */
  handle: (msg: NormalizedMessage) => Promise<void>;
  /** 在消息所在的话题里回一句 */
  reply: (msg: NormalizedMessage, markdown: string) => Promise<unknown>;
  logger?: Logger;
  now?: () => number;
}

interface Followed {
  /** 从哪条消息起跟（开始跟的那条 @ 的发送时间）：在它之前发的不跟，补漏轮询回看时不会把开始跟之前的消息翻出来回 */
  since: number;
  /** 最后一次 @ 它或它接着回的时间 */
  lastAt: number;
}

/**
 * 判断排队：同时最多 MAX_JUDGING 条，最多排 MAX_WAITING 条，再多的不判断。
 * 事件断了一阵、补漏轮询一次补上很多条时，别把模型的并发占满，耽误正常回答
 */
export class JudgeQueue {
  private judging = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly maxJudging = MAX_JUDGING,
    private readonly maxWaiting = MAX_WAITING,
  ) {}

  /** 满了时返回 undefined（没跑） */
  async run<T>(task: () => Promise<T>): Promise<{ value: T } | undefined> {
    if (this.judging >= this.maxJudging && this.waiting.length >= this.maxWaiting) {
      return undefined;
    }
    await this.acquire();
    try {
      return { value: await task() };
    } finally {
      this.release();
    }
  }

  get load(): string {
    return `${this.judging} 条在判断、${this.waiting.length} 条在排队`;
  }

  private async acquire(): Promise<void> {
    if (this.judging < this.maxJudging) {
      this.judging++;
      return;
    }
    // 名额由 release 直接转给排队的，judging 不变
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.judging--;
    }
  }
}

/**
 * 话题里跟聊：机器人回答过的话题里，群成员接着说的话不 @ 它也可能是对它说的。
 * 没 @ 的消息先让模型看一眼话题最近几条，判断是不是在跟机器人说话，是的才当成提问处理；
 * 群成员之间说话、表态（好的、收到）不回。只跟话题，群主界面没 @ 它的消息归主动接话（见 ProactiveReplier）。
 * 同一个话题里的消息按收到的顺序一条一条判断、交给处理函数，先说的先排进任务队列（「停止」不会跑到前面那句的前面）
 */
export class ThreadFollower {
  private readonly threads = new Map<string, Followed>();
  /** 说过「只在 @ 我时回」的话题：机器人运行期间一直记着，不随跟聊过期 */
  private readonly muted = new Set<string>();
  /** 每个话题最后一条在判断的消息「判断完、交出去」的 Promise：同一话题里后来的等它 */
  private readonly turns = new Map<string, Promise<void>>();
  private readonly queue = new JudgeQueue();
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(private readonly opts: ThreadFollowerOptions) {
    this.logger = opts.logger ?? console;
    this.now = opts.now ?? Date.now;
  }

  /** 机器人处理了这条消息（@ 它的、点按钮接着问的、跟聊判断要回的）：之后跟着这个话题 */
  track(msg: NormalizedMessage): void {
    if (!this.opts.allowedChatIds.has(msg.chatId)) {
      return;
    }
    const key = threadKeyOf(msg);
    const now = this.now();
    const followed = this.threads.get(key);
    const since = followed && now - followed.lastAt <= FOLLOW_WINDOW_MS ? followed.since : msg.createTime || now;
    remember(this.threads, key, { since, lastAt: now });
  }

  /**
   * 这条没 @ 机器人的消息要不要判断：白名单群里、在跟着的话题里（没静音、没过期）、
   * 是人发的（发言人是 ou_ 开头的用户，不是机器人或应用）、没 @ 别人（@ 了别人就是对别人说的）、不是 @所有人
   */
  wants(msg: NormalizedMessage, fromApp = false): boolean {
    if (msg.mentionedBot || msg.mentionAll || fromApp || !msg.rootId || !this.opts.allowedChatIds.has(msg.chatId)) {
      return false;
    }
    if (!msg.senderId.startsWith("ou_") || msg.senderId === this.opts.botOpenId()) {
      return false;
    }
    if (msg.mentions.length > 0 || (msg.content.trim() === "" && msg.resources.length === 0)) {
      return false;
    }
    const followed = this.threads.get(msg.rootId);
    if (!followed || this.muted.has(msg.rootId)) {
      return false;
    }
    if (this.now() - followed.lastAt > FOLLOW_WINDOW_MS) {
      this.threads.delete(msg.rootId);
      return false;
    }
    return msg.createTime >= followed.since;
  }

  /**
   * 说「只在 @ 我时回」：这个话题不再跟聊（机器人运行期间一直不跟），回一句。返回 true 表示是这句话、已经处理了。
   * @ 了它说的都算，在群里直接 @ 它说的，就是它回复这条时开的那个话题；
   * 没 @ 它时，只认它在跟着的话题里说的
   */
  async muteIfAsked(msg: NormalizedMessage): Promise<boolean> {
    const replied = this.mute(msg);
    if (!replied) {
      return false;
    }
    await replied;
    return true;
  }

  /**
   * 同 muteIfAsked，不是这句话时同步返回 undefined，是的话马上静音、返回回那一句的 Promise。
   * 给消息处理函数用：不是开关的话时不多等一拍，处理函数照样当场排进任务队列
   */
  mute(msg: NormalizedMessage): Promise<void> | undefined {
    if (!this.opts.allowedChatIds.has(msg.chatId) || !MUTE_COMMAND.test(msg.content.trim())) {
      return undefined;
    }
    if (!msg.mentionedBot && !this.wants(msg)) {
      return undefined;
    }
    const key = threadKeyOf(msg);
    this.threads.delete(key);
    remember(this.muted, key);
    this.logger.info(`跟聊：话题里说了只在 @ 时回，这个话题不再跟聊 chat=${msg.chatId} thread=${key} message=${msg.messageId}`);
    return this.opts.reply(msg, MUTED_REPLY).then(() => undefined);
  }

  /**
   * 判断这条没 @ 机器人的消息是不是在跟它说话，是的话当成提问处理。调用前先用 wants 筛过。
   * 说的是「只在 @ 我时回」的直接静音；机器人正在做事时说「停止」的直接交给处理函数停任务，都不用判断
   */
  async consider(msg: NormalizedMessage): Promise<void> {
    const key = threadKeyOf(msg);
    await this.inTurn(key, () => this.decide(msg, key));
  }

  /**
   * @ 了机器人的消息也按顺序交给处理函数：同一话题里前面没 @ 的还在判断时，等它判断完、交出去再处理这条。
   * 不然「改一下文档」还在判断，后说的「@机器人 停止」先到，没有任务可停，前面那句判断完又开始改
   */
  async answerInTurn(msg: NormalizedMessage, handle: () => Promise<void>): Promise<void> {
    await this.inTurn(threadKeyOf(msg), async () => {
      this.track(msg);
      return { done: handle() };
    });
  }

  /** 排在同一话题里前一条后面：等它判断完、交出去（处理函数同步排进任务队列），再做这一步 */
  private async inTurn(key: string, step: () => Promise<{ done: Promise<void> } | undefined>): Promise<void> {
    const previous = this.turns.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => (release = resolve));
    this.turns.set(key, turn);
    let started: { done: Promise<void> } | undefined;
    try {
      await previous;
      started = await step();
    } finally {
      release();
      if (this.turns.get(key) === turn) {
        this.turns.delete(key);
      }
    }
    // 任务本身不挡后面的判断：后面的消息照样判断，要回的在任务队列里排在这个后面
    await started?.done;
  }

  /** 判断这一条，要回的交给处理函数，返回它的 Promise（包一层：不在这里等任务做完） */
  private async decide(msg: NormalizedMessage, key: string): Promise<{ done: Promise<void> } | undefined> {
    const muting = this.mute(msg);
    if (muting) {
      await muting;
      return undefined;
    }
    const busy = this.opts.busy?.(key) ?? false;
    // 机器人正在做这个话题里的事，有人说「停止」：不用判断，交给处理函数停掉。没在做时可能是对别人说的，照常判断
    if (busy && STOP_COMMAND.test(msg.content.trim())) {
      this.track(msg);
      return { done: this.opts.handle(msg) };
    }
    const startedAt = this.now();
    let answer: boolean;
    try {
      const judged = await this.queue.run(() => this.judge(msg, busy));
      if (!judged) {
        this.logger.warn(`跟聊：要判断的消息太多（${this.queue.load}），这条不判断、不回 message=${msg.messageId}`);
        return undefined;
      }
      answer = judged.value;
    } catch (err) {
      // 拿不准就不回：判断失败时宁可漏回一句，也不在别人说话时插嘴
      this.logger.warn(`跟聊：判断失败，这条不回 message=${msg.messageId}：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    this.logger.info(
      `跟聊：没 @ 的话题消息${answer ? "是对机器人说的，接着回" : "不是对机器人说的，不回"} chat=${msg.chatId} thread=${msg.rootId} ` +
        `message=${msg.messageId} 用时=${this.now() - startedAt}ms`,
    );
    if (!answer) {
      return undefined;
    }
    this.track(msg);
    return { done: this.opts.handle(msg) };
  }

  private async judge(msg: NormalizedMessage, busy: boolean): Promise<boolean> {
    const context = await this.opts.context.load(msg);
    const recent = context.history.slice(-JUDGE_MESSAGES).map((m) => {
      const text = m.role === "assistant" ? `[机器人] ${m.content}` : m.content;
      return text.length <= JUDGE_MESSAGE_CHARS ? text : `${text.slice(0, JUDGE_MESSAGE_CHARS)}…`;
    });
    const asker = context.askerName || msg.senderName || "群成员";
    const content = msg.content.trim() || "（只发了图片或文件）";
    const transcript = [
      "话题里最近的消息：",
      ...(recent.length > 0 ? recent : ["（读不到）"]),
      ...(busy ? ["（机器人正在处理这个话题里的事，还没回完）"] : []),
      "",
      `新消息（没有 @ 机器人）：[${asker}] ${content.length <= JUDGE_MESSAGE_CHARS ? content : `${content.slice(0, JUDGE_MESSAGE_CHARS)}…`}`,
    ].join("\n");
    const timeout = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
    const result = await this.opts.model.chat({
      system: judgePrompt(this.opts.botName() || "机器人"),
      messages: [{ role: "user", content: transcript }],
      thinking: false,
      signal: timeout,
    });
    return /^[「"'*\s]*是/.test(result.text);
  }
}

/** 记进 Map 或 Set：先删再加，最近的排到最后，超出 MAX_THREADS 时删掉最早的 */
export function remember<V>(store: Map<string, V> | Set<string>, key: string, value?: V): void {
  store.delete(key);
  if (store instanceof Map) {
    store.set(key, value as V);
  } else {
    store.add(key);
  }
  if (store.size > MAX_THREADS) {
    store.delete(store.keys().next().value!);
  }
}

function judgePrompt(botName: string): string {
  return [
    `你在判断飞书群一个话题里的新消息是不是在跟群里的机器人「${botName}」说话。`,
    "机器人之前在这个话题里回答过问题，所以群成员接着跟它说话时可能不再 @ 它。",
    "话题里 [机器人] 开头的是机器人说的，其他是群成员说的，方括号里是发言人。",
    "算在跟机器人说话、要它回应的：接着机器人的回答追问，让它继续做、换个做法、再查一下，纠正它说的，补充它要的信息。",
    "不算的：群成员之间互相说话、商量、分工，只是表个态（好的、收到、谢谢、👍、哈哈），和机器人在做的事无关的闲聊。",
    "拿不准时算不是。只回答一个字：是，或者 否。",
  ].join("\n");
}
