import { readFile } from "node:fs/promises";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { STOP_COMMAND } from "./bot.js";
import { FileQueue, writeAtomically } from "./file-store.js";
import { type Logger, type ThreadContext, threadKeyOf } from "./history.js";
import type { ChatModel } from "./llm.js";

/**
 * 最多同时跟多少个话题、记多少个静音的话题，超出时先忘掉最早的（最后一次 @ 或接着回过最早的那个）。
 * 跟聊不限时间（和 Claude Tag 一样）：回答过的话题隔多久回来接着问都不用 @
 */
const MAX_THREADS = 2000;
/** 最多同时判断几条，多的排队（事件断了一阵、补漏轮询一次补上很多条时，别把模型的并发占满） */
const MAX_JUDGING = 3;
/** 排队等判断的最多几条，再多的不判断了（多半是事件断了很久，补上来的都是旧消息） */
const MAX_WAITING = 20;
/** 判断时看话题里最近几条 */
const JUDGE_MESSAGES = 8;
/** 判断时每条最多看多少字 */
const JUDGE_MESSAGE_CHARS = 500;
/** 同一个话题里最多几条在排队判断，再多的不判断（话题里刷屏时别越积越多、判断完早就过时了） */
const MAX_PENDING_PER_THREAD = 5;
/** 判断最多等多久，超时算不用回 */
const JUDGE_TIMEOUT_MS = 20_000;
/** 判断时群记忆最多带多少字（群里定的规矩、答案都在里面） */
export const JUDGE_MEMORY_CHARS = 3000;

/** 问模型怎么接一条没 @ 的消息用的材料：要开口时打开思考、同样的材料再问一遍，核对出处也看它 */
export interface JudgeAsk {
  system: string;
  /** 群记忆、话题或群聊最近几条和这条消息 */
  content: string;
  /** 给模型看的群记忆（带编号）：说到的「群记忆 #几」要在这里面 */
  memory: string;
  /** 给模型看的经验库里查到的经验编号（「K3」「aiops#5」）：说到的「经验 K3」「aiops 经验 #5」要在这里面 */
  knowledge?: readonly string[];
  /** 这条之前的最近几条（话题里的或群聊，带 [发言人]，机器人说的是 [机器人]）：要开口前查经验库时和这条一起当查询词 */
  recent?: readonly string[];
  /** 这次给没给模型「做」这个选择（群记忆里有不用 @ 也要它去做的规矩，见 hasWorkRule）：没给的，模型说了「做」也不算 */
  work?: boolean;
}

/** 「不用」「不需要」「没」「不用等」这类：后面跟着 @ 的，说的是不用 @ 它 */
const NOT_AT = String.raw`(?:不|没|无|别|免)(?:用|必|需要?|要|有)?\s*(?:等\s*)?`;
/** 规矩里说「不用 @ 也…」「直接帮忙查」：像是没 @ 也要它去做的那类规矩 */
const WORK_RULE = new RegExp([`${NOT_AT}@`, String.raw`(?:直接|主动)(?:帮忙|帮|去|来)?(?:查|排查|处理|看|跟进|定位|解决)`].join("|"));
/** 规矩里说「必须 @ 你再查」「@ 了才查」「只在 @ 你的时候回」：要先 @ 它才做（前面是「不用」「不需要」「没」的不算） */
const MUST_AT_RULE = new RegExp(
  [
    String.raw`(?<!${NOT_AT})(?:必须|一定|得|需要?|要|先)\s*(?:先\s*)?@`,
    String.raw`(?<!${NOT_AT})@[^，。；,;!！?？\n]{0,15}?(?:才|再|之后|以后|的时候|时)`,
    String.raw`只(?:在|有|回|接)[^，。；,;\n]{0,8}@`,
  ].join("|"),
);

/**
 * 群记忆（带编号、一条一行）里有没有不用 @ 也要它去做的规矩（「线上报错不用 @ 你也直接帮忙查」）。有才给模型「做」这个选择。
 * 同一条里又说了要先 @ 它的（「线上报错必须先 @ 你，再直接帮忙查」）不算：模型容易把它看成「直接帮忙查」，没 @ 就去查了
 */
export function hasWorkRule(memory: string): boolean {
  // 一条记忆里有换行的，后面几行也算这一条
  return memory
    .split(/\n(?=- #\d+ |【)/)
    .some((entry) => /^- #\d+ /.test(entry) && WORK_RULE.test(entry) && !MUST_AT_RULE.test(entry));
}

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
  /** 这个群的群记忆（已经排好、带编号，最多 JUDGE_MEMORY_CHARS 字）：群里定的规矩和答案都在里面，判断时一起看 */
  memory?: (chatId: string) => Promise<string>;
  botName: () => string | undefined;
  /** 机器人自己的 open_id：它自己发的消息不跟（飞书一般不推机器人自己发的，万一推了也不能自己接自己的话） */
  botOpenId: () => string | undefined;
  /** 这个话题里机器人有没有正在做的任务（见 TaskRegistry.busy）。在做时说「停止」直接停，不用判断 */
  busy?: (threadKey: string) => boolean;
  /** 判断要回的消息交给它，和 @ 机器人的消息走同一个处理函数 */
  handle: (msg: NormalizedMessage) => Promise<void>;
  /** 在消息所在的话题里回一句 */
  reply: (msg: NormalizedMessage, markdown: string) => Promise<unknown>;
  /**
   * 话题里不是对机器人说的、答案在群记忆里时接一句（见 ProactiveReplier.speakInTopic），是群里定过规矩要它处理的那类事时去做。
   * active 说这个群能不能这样接（开了主动接话、没停），能的话判断时多给模型两个选择「接：」「做」；
   * 模型选了就交给 speak、work：再想一遍、核对出处、算每小时的次数。机器人正在做这个话题里的事、群记忆是空的时不给这两个选择
   */
  chimeIn?: {
    active: (chatId: string) => boolean;
    speak: (msg: NormalizedMessage, ask: JudgeAsk, said: string) => Promise<void>;
    /** 不是对机器人说的，但正是群记忆里定过规矩要它处理的那类事：再想一遍、算每小时的次数后像被 @ 一样去做（见 ProactiveReplier.workInTopic） */
    work: (msg: NormalizedMessage, ask: JudgeAsk) => Promise<void>;
  };
  logger?: Logger;
  now?: () => number;
  /** 判断一条最多等多久（读话题上文加问模型），默认 20 秒 */
  judgeTimeoutMs?: number;
  /** 跟着的话题和说过「只在 @ 我时回」的话题记在这个文件里，重启后接着跟、照样不跟。不给就只记在内存里 */
  stateFile?: string;
}

/** 写进 stateFile 的内容：跟着的话题和静音的话题，都按最近的排在后面 */
interface FollowState {
  threads?: Record<string, Followed>;
  muted?: string[];
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
  /** 说过「只在 @ 我时回」的话题：一直记着（配了 stateFile 时重启后也记着），不随跟聊过期 */
  private readonly muted = new Set<string>();
  /** 每个话题最后一条在判断的消息「判断完、交出去」的 Promise：同一话题里后来的等它 */
  private readonly turns = new Map<string, Promise<void>>();
  /** 每个话题里排着队、还没判断完的没 @ 的消息有几条 */
  private readonly pending = new Map<string, number>();
  /** 交进来的顺序号；话题里 @ 机器人说「停止」「只在 @ 我时回」时记下它的号，排在它前面、还没交出去的没 @ 的消息作废 */
  private seq = 0;
  private readonly cancelledBefore = new Map<string, number>();
  private readonly queue = new JudgeQueue();
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly files = new FileQueue();
  /** 已经排上、还没开始写的那次：开始写时取当时的状态，这期间再有变化不用再排一次 */
  private saveQueued = false;
  private lastSave: Promise<void> = Promise.resolve();

  constructor(private readonly opts: ThreadFollowerOptions) {
    this.logger = opts.logger ?? console;
    this.now = opts.now ?? Date.now;
  }

  /**
   * 读出重启前跟着的话题和静音的话题。文件不在就是都没有；读坏了打一行警告，从空的开始。
   * 补漏轮询只看启动以后发的消息，停机那会儿话题里说的不会翻出来回
   */
  async init(): Promise<void> {
    const file = this.opts.stateFile;
    if (!file) {
      return;
    }
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(`跟聊：读不了 ${file}，重启前跟着的话题要再 @ 一次才接着跟`, err);
      }
      return;
    }
    let state: FollowState;
    try {
      state = JSON.parse(raw) as FollowState;
      if (typeof state !== "object" || state === null) {
        throw new Error("不是 JSON 对象");
      }
    } catch (err) {
      this.logger.warn(`跟聊：${file} 格式不对，重启前跟着的话题要再 @ 一次才接着跟`, err);
      return;
    }
    for (const key of Array.isArray(state.muted) ? state.muted : []) {
      if (typeof key === "string") {
        remember(this.muted, key);
      }
    }
    const threads = Object.entries(state.threads ?? {})
      .filter(
        ([key, followed]) => typeof followed?.since === "number" && typeof followed.lastAt === "number" && !this.muted.has(key),
      )
      .sort(([, a], [, b]) => a.lastAt - b.lastAt);
    for (const [key, followed] of threads) {
      remember(this.threads, key, { since: followed.since, lastAt: followed.lastAt });
    }
    this.logger.info(`跟聊：接着跟重启前回答过的 ${this.threads.size} 个话题，${this.muted.size} 个话题说过只在 @ 时回`);
  }

  /** 等排着的写文件做完（测试和退出前用） */
  flush(): Promise<void> {
    return this.lastSave;
  }

  /** 机器人处理了这条消息（@ 它的、点按钮接着问的、跟聊判断要回的）：之后跟着这个话题 */
  track(msg: NormalizedMessage): void {
    if (!this.opts.allowedChatIds.has(msg.chatId)) {
      return;
    }
    const key = threadKeyOf(msg);
    const now = this.now();
    const since = this.threads.get(key)?.since ?? (msg.createTime || now);
    remember(this.threads, key, { since, lastAt: now });
    this.save();
  }

  /** 这个话题归跟聊管：在跟着，或者说过「只在 @ 我时回」（主动接话不碰这些话题） */
  owns(threadKey: string): boolean {
    return this.threads.has(threadKey) || this.muted.has(threadKey);
  }

  /**
   * 这条没 @ 机器人的消息要不要判断：白名单群里、在跟着的话题里（没静音）、
   * 是人发的（发言人是 ou_ 开头的用户，不是机器人或应用）、没 @ 别人（@ 了别人就是对别人说的）、不是 @所有人。
   * 要真在话题里（rootId 和 threadId 都有）：群主界面引用回复话题第一条的，只有 rootId，那是群主界面的消息，不归跟聊
   */
  wants(msg: NormalizedMessage, fromApp = false): boolean {
    if (msg.mentionedBot || msg.mentionAll || fromApp || !msg.rootId || !msg.threadId || !this.opts.allowedChatIds.has(msg.chatId)) {
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
    return msg.createTime >= followed.since;
  }

  /**
   * 说「只在 @ 我时回」：这个话题不再跟聊（一直不跟，配了 stateFile 时重启后也不跟），回一句。返回 true 表示是这句话、已经处理了。
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
    this.save();
    this.logger.info(`跟聊：话题里说了只在 @ 时回，这个话题不再跟聊 chat=${msg.chatId} thread=${key} message=${msg.messageId}`);
    return this.opts.reply(msg, MUTED_REPLY).then(() => undefined);
  }

  /**
   * 判断这条没 @ 机器人的消息是不是在跟它说话，是的话当成提问处理。调用前先用 wants 筛过。
   * 说的是「只在 @ 我时回」的直接静音；机器人正在做事时说「停止」的直接交给处理函数停任务，都不用判断
   */
  async consider(msg: NormalizedMessage): Promise<void> {
    const key = threadKeyOf(msg);
    const text = msg.content.trim();
    // 「只在 @ 我时回」、机器人正在做事时的「停止」不排队、不受下面的上限挡：排在前面的不再判断、不交出去，这条马上处理。
    // 排满了的时候正是最需要停的时候
    if (MUTE_COMMAND.test(text) || (STOP_COMMAND.test(text) && (this.opts.busy?.(key) ?? false))) {
      remember(this.cancelledBefore, key, ++this.seq);
      const muting = this.mute(msg);
      if (muting) {
        await muting;
        return;
      }
      this.track(msg);
      await this.opts.handle(msg);
      return;
    }
    const pending = this.pending.get(key) ?? 0;
    if (pending >= MAX_PENDING_PER_THREAD) {
      this.logger.warn(`跟聊：这个话题里还有 ${pending} 条没判断完，这条不判断、不回 thread=${key} message=${msg.messageId}`);
      return;
    }
    this.pending.set(key, pending + 1);
    const order = ++this.seq;
    await this.inTurn(key, async () => {
      try {
        return await this.decide(msg, key, order);
      } finally {
        const left = (this.pending.get(key) ?? 1) - 1;
        if (left > 0) {
          this.pending.set(key, left);
        } else {
          this.pending.delete(key);
        }
      }
    });
  }

  /**
   * @ 了机器人的消息也按顺序交给处理函数：同一话题里前面没 @ 的还在判断时，等它判断完、交出去再处理这条。
   * 「@机器人 停止」「@机器人 只在 @ 我时回」不排队：前面排着的（没 @ 的判断、@ 了还没交出去的）都作废，这条马上处理，
   * 不用干等正在判断的那条（最多 20 秒）。不然「改一下文档」还在判断，后说的停止先处理了，前面那句判断完又开始改。
   * commands 是 false 时（点「接着查」按钮问的，按钮上的话是模型写的）不当成停止、静音
   */
  async answerInTurn(msg: NormalizedMessage, handle: () => Promise<void>, commands = true): Promise<void> {
    const key = threadKeyOf(msg);
    const text = msg.content.trim();
    if (commands && (STOP_COMMAND.test(text) || MUTE_COMMAND.test(text))) {
      remember(this.cancelledBefore, key, ++this.seq);
      this.track(msg);
      await handle();
      return;
    }
    const order = ++this.seq;
    await this.inTurn(key, async () => {
      if (this.cancelled(key, order)) {
        this.logger.info(`跟聊：排着的时候话题里有人 @ 机器人说了停止或只在 @ 时回，这条不处理了 message=${msg.messageId}`);
        return undefined;
      }
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
  private async decide(msg: NormalizedMessage, key: string, order: number): Promise<{ done: Promise<void> } | undefined> {
    // 排队的这会儿可能有人说了「只在 @ 我时回」「停止」，或者跟聊过期了：轮到它时再看一遍
    if (this.cancelled(key, order) || !this.wants(msg)) {
      return undefined;
    }
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
    let verdict: Verdict;
    try {
      // 在全局判断队列里排着的这会儿也可能有人说了「只在 @ 我时回」「停止」：轮到时再看一遍，不再把这条发给模型
      let dropped = false;
      const judged = await this.queue.run(() => {
        if (this.cancelled(key, order) || !this.wants(msg)) {
          dropped = true;
          return Promise.resolve<Verdict>({ answer: false });
        }
        return this.judge(msg, busy);
      });
      if (dropped) {
        this.logger.info(`跟聊：排队判断的这会儿话题里有人说了停止或只在 @ 时回，这条不判断了 message=${msg.messageId}`);
        return undefined;
      }
      if (!judged) {
        this.logger.warn(`跟聊：要判断的消息太多（${this.queue.load}），这条不判断、不回 message=${msg.messageId}`);
        return undefined;
      }
      verdict = judged.value;
    } catch (err) {
      // 拿不准就不回：判断失败时宁可漏回一句，也不在别人说话时插嘴
      this.logger.warn(`跟聊：判断失败，这条不回 message=${msg.messageId}：${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    const outcome = verdict.answer
      ? "是对机器人说的，接着回"
      : verdict.work
        ? "不是对机器人说的，是群里定过规矩要它处理的那类事，看要不要去做"
        : verdict.said
          ? "不是对机器人说的，答案在群记忆里，看要不要接一句"
          : "不是对机器人说的，不回";
    this.logger.info(
      `跟聊：没 @ 的话题消息${outcome} chat=${msg.chatId} thread=${msg.rootId} message=${msg.messageId} 用时=${this.now() - startedAt}ms`,
    );
    if (this.cancelled(key, order)) {
      this.logger.info(`跟聊：判断的这会儿话题里有人 @ 机器人说了停止或只在 @ 时回，这条不接着回 message=${msg.messageId}`);
      return undefined;
    }
    if (!verdict.answer) {
      // 不是对它说的、答案在群记忆里（或者是群里定过规矩的那类事）：交给主动接话，再想一遍、核对出处、算每小时的次数后接一句（去做）。
      // 不挡话题里后面的消息判断，也不算机器人回答过
      const chimeIn = this.opts.chimeIn;
      if (!chimeIn || !verdict.ask) {
        return undefined;
      }
      if (verdict.work) {
        return { done: chimeIn.work(msg, verdict.ask) };
      }
      return verdict.said ? { done: chimeIn.speak(msg, verdict.ask, verdict.said) } : undefined;
    }
    this.track(msg);
    return { done: this.opts.handle(msg) };
  }

  private cancelled(key: string, order: number): boolean {
    return order < (this.cancelledBefore.get(key) ?? 0);
  }

  /** 读话题上文也算在时限里：飞书接口卡住时，这条判断照样按时结束，不一直占着判断的名额、挡着话题里后面的消息 */
  private judge(msg: NormalizedMessage, busy: boolean): Promise<Verdict> {
    return withDeadline(this.opts.judgeTimeoutMs ?? JUDGE_TIMEOUT_MS, (signal) => this.judgeWithin(msg, busy, signal));
  }

  /**
   * 带着话题最近几条和群记忆判断，三选一：是对机器人说的（接着回）、不是但答案在群记忆里（接一句）、都不是（不回）。
   * 群记忆里群里定的规矩（哪类消息不用 @ 也要它回、哪类别管）也在这里起作用
   */
  private async judgeWithin(msg: NormalizedMessage, busy: boolean, signal: AbortSignal): Promise<Verdict> {
    const [context, memory] = await Promise.all([
      this.opts.context.load(msg),
      this.opts.memory ? this.opts.memory(msg.chatId).catch(() => "") : Promise.resolve(""),
    ]);
    const recent = context.history.slice(-JUDGE_MESSAGES).map((m) => clip(m.role === "assistant" ? `[机器人] ${m.content}` : m.content));
    const asker = context.askerName || msg.senderName || "群成员";
    const content = [
      ...(memory ? ["群记忆：", memory, ""] : []),
      "话题里最近的消息：",
      ...(recent.length > 0 ? recent : ["（读不到）"]),
      ...(busy ? ["（机器人正在处理这个话题里的事，还没回完）"] : []),
      "",
      `新消息（没有 @ 机器人）：[${asker}] ${clip(msg.content.trim() || "（只发了图片或文件）")}`,
    ].join("\n");
    // 话题里正在做事时不接群记忆的话：别在它回答的前后插一句
    const chime = Boolean(memory) && !busy && (this.opts.chimeIn?.active(msg.chatId) ?? false);
    // 「做」只在群记忆里有不用 @ 也要它去做的规矩时给：规矩说要先 @ 它的，没 @ 不去做
    const work = chime && hasWorkRule(memory);
    const system = judgePrompt(this.opts.botName() || "机器人", chime, work);
    const result = await this.opts.model.chat({ system, messages: [{ role: "user", content }], thinking: false, signal });
    if (/^[「"'*\s]*是/.test(result.text)) {
      return { answer: true };
    }
    if (!chime) {
      return { answer: false };
    }
    const ask = { system, content, memory, recent, work };
    if (work && /^[\s*「"']*做[」"'\s。.!！]*$/.test(result.text.trim())) {
      return { answer: false, work: true, ask };
    }
    const said = /^[\s*「"']*接\s*[:：]\s*([\s\S]+)$/.exec(result.text.trim())?.[1].trim();
    return said ? { answer: false, said, ask } : { answer: false };
  }

  /** 记下跟着、静音的话题（配了 stateFile 时）。写失败只打警告：最多是重启后要再 @ 一次 */
  private save(): void {
    const file = this.opts.stateFile;
    if (!file || this.saveQueued) {
      return;
    }
    this.saveQueued = true;
    this.lastSave = this.files
      .run(file, () => {
        this.saveQueued = false;
        return writeAtomically(file, `${JSON.stringify(this.snapshot())}\n`);
      })
      .catch((err) => {
        this.saveQueued = false;
        this.logger.warn(`跟聊：写 ${file} 失败，重启后跟着的话题要再 @ 一次才接着跟`, err);
      });
  }

  private snapshot(): FollowState {
    return { threads: Object.fromEntries(this.threads), muted: [...this.muted] };
  }
}

/**
 * 限时做一件事：到点就按超时报错，同时取消 run 里用 signal 的请求（问模型）；没用 signal 的（读飞书）到点也不再等。
 * 用自己的计时器而不是 AbortSignal.timeout：后者的计时器不拦着进程退出
 */
export async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`超过 ${ms / 1000} 秒`);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
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

/**
 * 跟聊判断的结果：answer 是对机器人说的；不是的话，said 是模型想按群记忆接的那句，work 是群里定过规矩要它处理的那类事
 * （ask 是这次判断的材料，再想一遍用）
 */
interface Verdict {
  answer: boolean;
  said?: string;
  work?: boolean;
  ask?: JudgeAsk;
}

function clip(text: string): string {
  return text.length <= JUDGE_MESSAGE_CHARS ? text : `${text.slice(0, JUDGE_MESSAGE_CHARS)}…`;
}

/**
 * chime：这个群能不能按群记忆接一句（开了主动接话），能的话多给一个选择「接：」；
 * work：群记忆里有不用 @ 也要它去做的规矩（见 hasWorkRule），再多给一个选择「做」
 */
function judgePrompt(botName: string, chime: boolean, work: boolean): string {
  return [
    `你在判断飞书群一个话题里的新消息要不要群里的机器人「${botName}」回应。`,
    "机器人之前在这个话题里回答过问题，所以群成员接着跟它说话时可能不再 @ 它。",
    "话题里 [机器人] 开头的是机器人说的，其他是群成员说的，方括号里是发言人。给了群记忆的话，里面群里定的规矩（哪类消息别管）优先照着做。",
    "回答「是」：在跟机器人说话、要它回应的，比如接着机器人的回答追问，让它继续做、换个做法、再查一下，纠正它说的，补充它要的信息。",
    ...(work
      ? [
          "回答「做」：不是在跟机器人说话，但群记忆里有规矩说这类事不用 @ 也要它处理（比如「线上报错不用 @ 你也直接帮忙查」），这条正是这类事。规矩说的是要 @ 它才处理的（比如「线上报错必须 @ 你再查」），没 @ 它就不算。",
        ]
      : []),
    ...(chime
      ? [
          "回答「接：」加上要说的一句话：不是在跟机器人说话，但有人问了问题、在找一件事，或者说的和群记忆对不上，而答案就在群记忆里、一两句话说得清。直接说，写明出处（「群记忆 #3」），只能照抄群记忆里的原文，不超过 100 字。",
        ]
      : []),
    `回答「否」：群成员之间互相说话、商量、分工，只是表个态（好的、收到、谢谢、👍、哈哈），和机器人在做的事无关的闲聊${chime ? "，群记忆里也没有答案、也不归规矩管的；群记忆里规矩说要 @ 它才处理的那类事，没 @ 它又不是在跟它说话的，也回答「否」" : ""}。`,
    `拿不准时回答「否」。只输出一行：${chime ? `是、否${work ? "、做" : ""}，或者「接：」加一句话` : "一个字，是或者否"}。`,
  ].join("\n");
}
