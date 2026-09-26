import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { FeishuApi, ThreadMessage } from "./feishu.js";
import type { ChatMessage } from "./llm.js";

/** 最多带上话题里最近多少条消息 */
export const MAX_HISTORY_MESSAGES = 60;
/** 话题上下文的总字数上限，超出时从较早的消息开始省略（话题第一条始终保留） */
export const MAX_HISTORY_CHARS = 24000;
/** 单条消息的字数上限 */
const MAX_MESSAGE_CHARS = 6000;

export type Logger = Pick<Console, "info" | "warn" | "error">;

/**
 * 话题的会话标识：话题第一条消息的 id。第一次在群里 @ 机器人时消息本身就是话题的第一条，
 * 之后话题里的消息 rootId 都指向它。
 */
export function threadKeyOf(msg: NormalizedMessage): string {
  return msg.rootId ?? msg.messageId;
}

export interface ThreadContext {
  /** 当前提问之前的对话，已按模型的格式整理好 */
  history: ChatMessage[];
  /** 提问人的名字，拿不到时为空 */
  askerName?: string;
  /** feishu：从飞书读到了整个话题；local：只有机器人自己记下的问答；none：没有上文 */
  source: "feishu" | "local" | "none";
}

/**
 * 读取话题上下文。优先用飞书「获取会话历史消息」接口读整个话题（需要 im:message.group_msg 权限，
 * 能看到话题里所有人的发言）；读不到时退回本地记录，只含之前 @ 机器人的问题和它的回答，重启后清空。
 */
export class ThreadContextLoader {
  private readonly local = new Map<string, ChatMessage[]>();
  private warned = false;

  constructor(
    private readonly api: Pick<FeishuApi, "listThreadMessages" | "getMessage">,
    private readonly logger: Logger = console,
    private readonly maxLocalThreads = 500,
  ) {}

  async load(msg: NormalizedMessage): Promise<ThreadContext> {
    const key = threadKeyOf(msg);
    if (msg.threadId) {
      try {
        return await this.loadFromFeishu(msg, msg.threadId);
      } catch (err) {
        this.warnOnce(err);
      }
    }

    const history = [...(this.local.get(key) ?? [])];
    // 不在话题里、而是用「回复」引用了一条消息：把被回复的消息也带上
    if (!msg.threadId && msg.replyToMessageId && history.length === 0) {
      try {
        const quoted = await this.api.getMessage(msg.replyToMessageId);
        if (quoted) {
          history.push(...toChatMessages([quoted]));
        }
      } catch (err) {
        this.warnOnce(err);
      }
    }
    // 不在话题里时拿不到话题列表里的发言人名字，单独读一下这条消息。名字只是锦上添花，读不到就算了
    const askerName = (await this.api.getMessage(msg.messageId).catch(() => undefined))?.senderName;
    return { history, ...(askerName ? { askerName } : {}), source: history.length > 0 ? "local" : "none" };
  }

  /** 记下一轮问答，读不到飞书话题时用 */
  remember(msg: NormalizedMessage, question: string, answer: string): void {
    const key = threadKeyOf(msg);
    const turns = this.local.get(key) ?? [];
    turns.push({ role: "user", content: question }, { role: "assistant", content: answer });
    // 只保留最近的若干轮，Map 按插入顺序，删掉最早的话题
    this.local.delete(key);
    this.local.set(key, turns.slice(-40));
    if (this.local.size > this.maxLocalThreads) {
      this.local.delete(this.local.keys().next().value!);
    }
  }

  private async loadFromFeishu(msg: NormalizedMessage, threadId: string): Promise<ThreadContext> {
    const all = await this.api.listThreadMessages(threadId, MAX_HISTORY_MESSAGES);
    const askerName = all.find((m) => m.messageId === msg.messageId)?.senderName;
    const earlier = all.filter(
      (m) =>
        m.messageId !== msg.messageId &&
        (m.createTime === 0 || m.createTime <= msg.createTime) &&
        // 机器人自己的进度卡片不算对话内容
        !(m.fromBot && m.msgType === "interactive"),
    );
    if (msg.rootId && !earlier.some((m) => m.messageId === msg.rootId) && msg.rootId !== msg.messageId) {
      const root = await this.api.getMessage(msg.rootId).catch(() => undefined);
      if (root) {
        earlier.unshift(root);
      }
    }
    return { history: toChatMessages(earlier), askerName, source: earlier.length > 0 ? "feishu" : "none" };
  }

  private warnOnce(err: unknown): void {
    if (this.warned) {
      return;
    }
    this.warned = true;
    this.logger.warn(
      `读取话题历史失败，先只用机器人自己记下的问答作为上下文（通常是缺少 im:message.group_msg 权限）：${describeFeishuError(err)}`,
    );
  }
}

/** 用户消息前标上发言人，方便模型分清话题里是谁说的 */
export function labelUserMessage(name: string | undefined, content: string): string {
  return `[${name || "群成员"}] ${content}`;
}

/**
 * 把话题消息整理成对话：机器人的回复是 assistant，其他人的消息是 user 并标上发言人；
 * 机器人连续发的几条（长回答被拆开）合成一条。超出字数上限时省略较早的消息，但保留话题第一条。
 */
export function toChatMessages(messages: ThreadMessage[]): ChatMessage[] {
  const rendered = messages.map((m) => ({
    fromBot: m.fromBot,
    content: clip(m.fromBot ? m.content : labelUserMessage(m.senderName, m.content)),
  }));

  let total = 0;
  let start = rendered.length;
  while (start > 0 && total + rendered[start - 1].content.length <= MAX_HISTORY_CHARS) {
    total += rendered[--start].content.length;
  }
  let kept = rendered.slice(start);
  if (start > 0) {
    const omitted = start - 1;
    kept = [
      rendered[0],
      ...(omitted > 0 ? [{ fromBot: false, content: `（中间较早的 ${omitted} 条消息已省略）` }] : []),
      ...kept,
    ];
  }

  const result: ChatMessage[] = [];
  for (const m of kept) {
    const last = result.at(-1);
    if (m.fromBot && last?.role === "assistant") {
      last.content += `\n${m.content}`;
    } else {
      result.push(m.fromBot ? { role: "assistant", content: m.content } : { role: "user", content: m.content });
    }
  }
  return result;
}

function clip(text: string): string {
  return text.length <= MAX_MESSAGE_CHARS ? text : `${text.slice(0, MAX_MESSAGE_CHARS)}…（后面省略）`;
}

/** 飞书 SDK 抛出的请求异常里带着接口返回的 code 和 msg，取出来方便排查 */
export function describeFeishuError(err: unknown): string {
  const data = (err as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
  if (data?.code !== undefined) {
    return `code=${data.code} ${data.msg ?? ""}`.trim();
  }
  return err instanceof Error ? err.message : String(err);
}
