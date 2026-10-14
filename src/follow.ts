import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { STOP_COMMAND } from "./bot.js";
import { type Logger, type ThreadContext, threadKeyOf } from "./history.js";
import type { ChatModel } from "./llm.js";

/** 话题里最后一次 @ 机器人（或机器人接着回过）之后，跟多久 */
export const FOLLOW_WINDOW_MS = 2 * 60 * 60_000;
/** 最多同时跟多少个话题，超出时先忘掉最早的 */
const MAX_THREADS = 2000;
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
  lastAt: number;
  /** 有人说了「只在 @ 我时回」 */
  muted: boolean;
}

/**
 * 话题里跟聊：机器人回答过的话题里，群成员接着说的话不 @ 它也可能是对它说的。
 * 没 @ 的消息先让模型看一眼话题最近几条，判断是不是在跟机器人说话，是的才当成提问处理；
 * 群成员之间说话、表态（好的、收到）不回。只跟话题，群里没 @ 它的消息一律不回。
 */
export class ThreadFollower {
  private readonly threads = new Map<string, Followed>();
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
    const muted = this.threads.get(key)?.muted ?? false;
    // Map 按插入顺序：先删再加，最近有动静的排到最后，超出上限时删掉最早的
    this.threads.delete(key);
    this.threads.set(key, { lastAt: this.now(), muted });
    if (this.threads.size > MAX_THREADS) {
      this.threads.delete(this.threads.keys().next().value!);
    }
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
    if (!followed) {
      return false;
    }
    if (this.now() - followed.lastAt > FOLLOW_WINDOW_MS) {
      this.threads.delete(msg.rootId);
      return false;
    }
    return !followed.muted;
  }

  /**
   * 话题里说「只在 @ 我时回」（@ 不 @ 它都算）：这个话题不再跟聊，回一句。返回 true 表示是这句话、已经处理了。
   * 没 @ 它时，只认它在跟着的话题里说的；群里直接说的不算（群里本来就只在 @ 它时回）
   */
  async muteIfAsked(msg: NormalizedMessage): Promise<boolean> {
    if (!msg.rootId || !this.opts.allowedChatIds.has(msg.chatId) || !MUTE_COMMAND.test(msg.content.trim())) {
      return false;
    }
    if (!msg.mentionedBot && !this.wants(msg)) {
      return false;
    }
    const key = msg.rootId;
    this.threads.delete(key);
    this.threads.set(key, { lastAt: this.now(), muted: true });
    this.logger.info(`跟聊：话题里说了只在 @ 时回，这个话题不再跟聊 chat=${msg.chatId} thread=${key} message=${msg.messageId}`);
    await this.opts.reply(msg, MUTED_REPLY);
    return true;
  }

  /**
   * 判断这条没 @ 机器人的消息是不是在跟它说话，是的话当成提问处理。调用前先用 wants 筛过。
   * 说的是「只在 @ 我时回」的直接静音；机器人正在做事时说「停止」的直接交给处理函数停任务，都不用判断
   */
  async consider(msg: NormalizedMessage): Promise<void> {
    if (await this.muteIfAsked(msg)) {
      return;
    }
    const busy = this.opts.busy?.(threadKeyOf(msg)) ?? false;
    // 机器人正在做这个话题里的事，有人说「停止」：不用判断，交给处理函数停掉。没在做时可能是对别人说的，照常判断
    if (busy && STOP_COMMAND.test(msg.content.trim())) {
      this.track(msg);
      await this.opts.handle(msg);
      return;
    }
    const startedAt = this.now();
    let answer: boolean;
    try {
      answer = await this.judge(msg, busy);
    } catch (err) {
      // 拿不准就不回：判断失败时宁可漏回一句，也不在别人说话时插嘴
      this.logger.warn(`跟聊：判断失败，这条不回 message=${msg.messageId}：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.logger.info(
      `跟聊：没 @ 的话题消息${answer ? "是对机器人说的，接着回" : "不是对机器人说的，不回"} chat=${msg.chatId} thread=${msg.rootId} ` +
        `message=${msg.messageId} 用时=${this.now() - startedAt}ms`,
    );
    if (!answer) {
      return;
    }
    this.track(msg);
    await this.opts.handle(msg);
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
