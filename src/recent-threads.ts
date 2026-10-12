import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { FileQueue, writeAtomically } from "./file-store.js";

/** 每个群记最近多少个话题 */
export const MAX_THREADS_PER_CHAT = 30;
/** 记下的提问、回答最多多少字：只用来接上下文，不用存全文 */
const MAX_QUESTION_CHARS = 500;
const MAX_ANSWER_CHARS = 4000;

/** 一个话题里机器人答过的问题和回答 */
export interface ThreadSummary {
  /** 话题第一条消息的 id（见 threadKeyOf） */
  threadKey: string;
  /** 这个话题里第一次问的 */
  topic: string;
  /** 最近一次问的和机器人的回答 */
  question: string;
  answer: string;
  /** 最近一次提问的人 */
  askerName?: string;
  /** 话题里问过几次 */
  turns: number;
  /** 最近一次回答的时间（毫秒） */
  at: number;
}

/**
 * 按群记下最近几个话题里机器人答过的问题和回答（DATA_DIR/recent-threads/<chat_id>.json），
 * 群成员在新话题里说「上面那个」「刚才问的」时，模型用 chat_recent_threads 查。
 * 每个话题读的是飞书里的整个话题，别的话题读不到；这里只记机器人自己的问答，不用多开权限
 */
export class RecentThreadStore {
  private readonly queue = new FileQueue();

  constructor(
    private readonly dir: string,
    private readonly maxThreads = MAX_THREADS_PER_CHAT,
    private readonly now: () => number = Date.now,
  ) {}

  /** 记下话题里的一次问答：这个话题挪到最前面，超出上限的最旧的话题删掉 */
  async record(chatId: string, threadKey: string, turn: { question: string; answer: string; askerName?: string }): Promise<void> {
    const file = this.fileOf(chatId);
    await this.queue.run(file, async () => {
      const threads = await readThreads(file);
      const earlier = threads.find((thread) => thread.threadKey === threadKey);
      const question = clip(turn.question, MAX_QUESTION_CHARS);
      const updated: ThreadSummary = {
        threadKey,
        topic: earlier?.topic ?? question,
        question,
        answer: clip(turn.answer, MAX_ANSWER_CHARS),
        ...(turn.askerName ? { askerName: turn.askerName } : {}),
        turns: (earlier?.turns ?? 0) + 1,
        at: this.now(),
      };
      const next = [updated, ...threads.filter((thread) => thread.threadKey !== threadKey)].slice(0, this.maxThreads);
      await writeAtomically(file, JSON.stringify(next));
    });
  }

  /** 这个群最近的话题，从新到旧，不含 exclude（当前话题） */
  async list(chatId: string, exclude?: string): Promise<ThreadSummary[]> {
    const file = this.fileOf(chatId);
    return this.queue.run(file, async () => (await readThreads(file)).filter((thread) => thread.threadKey !== exclude));
  }

  private fileOf(chatId: string): string {
    // chat_id 拼进路径，只允许字母数字、下划线和连字符（oc_xxx）
    if (!/^[\w-]+$/.test(chatId)) {
      throw new Error(`chat_id 格式不对：${chatId}`);
    }
    return path.join(this.dir, `${chatId}.json`);
  }
}

async function readThreads(file: string): Promise<ThreadSummary[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // 文件坏了（比如手改坏了）：挪到一边留着排查，从空的重新记，不然这个群以后每次都记不下
    await rename(file, `${file}.${Date.now()}.bad`);
    return [];
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((item): ThreadSummary[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const { threadKey, topic, question, answer, askerName, turns, at } = item as Record<string, unknown>;
    if (typeof threadKey !== "string" || typeof question !== "string" || typeof answer !== "string") {
      return [];
    }
    return [
      {
        threadKey,
        topic: typeof topic === "string" ? topic : question,
        question,
        answer,
        ...(typeof askerName === "string" && askerName ? { askerName } : {}),
        turns: Number(turns) || 1,
        at: Number(at) || 0,
      },
    ];
  });
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…（后面省略）`;
}
