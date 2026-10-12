import { readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { FileQueue, writeAtomically } from "./file-store.js";
import { MAX_HISTORY_MESSAGES } from "./history.js";

/** 话题文件多久没记新回答就删掉：每个提问都会开一个新话题，不删的话文件只增不减 */
const KEEP_THREAD_MS = 180 * 24 * 3600_000;
/** 每个群多久清理一次 */
const SWEEP_EVERY_MS = 24 * 3600_000;

interface Entry {
  answer: string;
  /** 记下的时间（毫秒） */
  at: number;
}

/**
 * 卡片即回答时，回答只在卡片里：读话题历史时，飞书接口读不出卡片实体里的文字，机器人自己的卡片还会被当成进度卡片去掉。
 * 这里按话题把「卡片消息 id → 回答」记在本地文件（DATA_DIR/card-answers/<chat_id>/<话题第一条消息 id>.json），读话题历史时换回文字。
 * 按话题分文件：一个话题只留最近的若干条（读话题历史最多也只读最近 60 条消息），群里别的话题再多也挤不掉老话题的回答；
 * 半年没再记新回答的话题文件删掉（记的时候顺便清理，每个群一天最多一次）
 */
export class CardAnswerStore {
  /** 同一个文件的读写排队，避免两次记录互相覆盖 */
  private readonly queue = new FileQueue();
  /** 每个群上一次清理的时间 */
  private readonly sweptAt = new Map<string, number>();

  constructor(
    private readonly dir: string,
    private readonly maxPerThread = MAX_HISTORY_MESSAGES,
    private readonly now: () => number = Date.now,
  ) {}

  /** threadKey 是话题第一条消息的 id（见 threadKeyOf） */
  async save(chatId: string, threadKey: string, messageId: string, answer: string): Promise<void> {
    const file = this.fileOf(chatId, threadKey);
    await this.queue.run(file, async () => {
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
    // 清理失败（比如没权限删）不影响记回答，下次再清
    await this.sweep(chatId).catch(() => {});
  }

  /** 这个话题里这些消息记过回答的，返回消息 id → 回答 */
  async get(chatId: string, threadKey: string, messageIds: readonly string[]): Promise<Map<string, string>> {
    const file = this.fileOf(chatId, threadKey);
    return this.queue.run(file, async () => {
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

  /** 删掉这个群里很久没记新回答的话题文件。每个文件在它自己的队列里查、删，不会删掉刚记进去的 */
  private async sweep(chatId: string): Promise<void> {
    const now = this.now();
    if (now - (this.sweptAt.get(chatId) ?? 0) < SWEEP_EVERY_MS) {
      return;
    }
    this.sweptAt.set(chatId, now);
    const dir = path.join(this.dir, chatId);
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const file = path.join(dir, name);
      await this.queue.run(file, async () => {
        if ((await stat(file)).mtimeMs < now - KEEP_THREAD_MS) {
          await unlink(file);
        }
      }).catch(() => {});
    }
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
