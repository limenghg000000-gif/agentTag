import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_HISTORY_MESSAGES } from "./history.js";

interface Entry {
  answer: string;
  /** 记下的时间（毫秒） */
  at: number;
}

/**
 * 卡片即回答时，回答只在卡片里：读话题历史时，飞书接口读不出卡片实体里的文字，机器人自己的卡片还会被当成进度卡片去掉。
 * 这里按话题把「卡片消息 id → 回答」记在本地文件（DATA_DIR/card-answers/<chat_id>/<话题第一条消息 id>.json），读话题历史时换回文字。
 * 按话题分文件：一个话题只留最近的若干条（读话题历史最多也只读最近 60 条消息），群里别的话题再多也挤不掉老话题的回答
 */
export class CardAnswerStore {
  /** 同一个文件的读写排队，避免两次记录互相覆盖 */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dir: string,
    private readonly maxPerThread = MAX_HISTORY_MESSAGES,
    private readonly now: () => number = Date.now,
  ) {}

  /** threadKey 是话题第一条消息的 id（见 threadKeyOf） */
  async save(chatId: string, threadKey: string, messageId: string, answer: string): Promise<void> {
    const file = this.fileOf(chatId, threadKey);
    return this.queued(file, async () => {
      const entries = await readEntries(file);
      entries.delete(messageId);
      entries.set(messageId, { answer, at: this.now() });
      for (const oldest of entries.keys()) {
        if (entries.size <= this.maxPerThread) {
          break;
        }
        entries.delete(oldest);
      }
      await writeAtomically(file, JSON.stringify(Object.fromEntries(entries)));
    });
  }

  /** 这个话题里这些消息记过回答的，返回消息 id → 回答 */
  async get(chatId: string, threadKey: string, messageIds: readonly string[]): Promise<Map<string, string>> {
    const file = this.fileOf(chatId, threadKey);
    return this.queued(file, async () => {
      const entries = await readEntries(file);
      const found = new Map<string, string>();
      for (const id of messageIds) {
        const entry = entries.get(id);
        if (entry) {
          found.set(id, entry.answer);
        }
      }
      return found;
    });
  }

  private queued<T>(file: string, run: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(file) ?? Promise.resolve()).catch(() => {}).then(run);
    this.queues.set(file, next);
    const clear = () => {
      if (this.queues.get(file) === next) {
        this.queues.delete(file);
      }
    };
    next.then(clear, clear);
    return next;
  }

  private fileOf(chatId: string, threadKey: string): string {
    // id 拼进路径，只允许字母数字、下划线和连字符（oc_xxx、om_xxx）
    if (!/^[\w-]+$/.test(chatId)) {
      throw new Error(`chat_id 格式不对：${chatId}`);
    }
    if (!/^[\w-]+$/.test(threadKey)) {
      throw new Error(`话题 id 格式不对：${threadKey}`);
    }
    return path.join(this.dir, chatId, `${threadKey}.json`);
  }
}

async function readEntries(file: string): Promise<Map<string, Entry>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return new Map();
    }
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // 文件坏了（比如手改坏了）：挪到一边留着排查，从空的重新记，不然这个话题以后每次都记不下
    await rename(file, `${file}.${Date.now()}.bad`);
    return new Map();
  }
  const entries = new Map<string, Entry>();
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [id, entry] of Object.entries(data)) {
      if (entry && typeof entry.answer === "string") {
        entries.set(id, { answer: entry.answer, at: Number(entry.at) || 0 });
      }
    }
  }
  return entries;
}

/** 先写临时文件再改名，写到一半断电也不会留下半个文件 */
async function writeAtomically(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, file);
}
