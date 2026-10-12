import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** 每个群最多记多少条，更早的删掉（读话题历史最多也只读最近 60 条消息） */
const MAX_ANSWERS_PER_CHAT = 300;

interface Entry {
  answer: string;
  /** 记下的时间（毫秒） */
  at: number;
}

/**
 * 卡片即回答时，回答只在卡片里：读话题历史时，飞书接口读不出卡片实体里的文字，机器人自己的卡片还会被当成进度卡片去掉。
 * 这里按群把「卡片消息 id → 回答」记在本地文件（DATA_DIR/card-answers/<chat_id>.json），读话题历史时换回文字
 */
export class CardAnswerStore {
  private readonly loaded = new Map<string, Promise<Map<string, Entry>>>();
  private readonly writing = new Map<string, Promise<void>>();

  constructor(
    private readonly dir: string,
    private readonly maxPerChat = MAX_ANSWERS_PER_CHAT,
    private readonly now: () => number = Date.now,
  ) {}

  async save(chatId: string, messageId: string, answer: string): Promise<void> {
    const file = this.fileOf(chatId);
    const entries = await this.load(chatId);
    entries.delete(messageId);
    entries.set(messageId, { answer, at: this.now() });
    for (const oldest of entries.keys()) {
      if (entries.size <= this.maxPerChat) {
        break;
      }
      entries.delete(oldest);
    }
    // 同一个群的写入排队，后一次写的是最新的全部内容
    const previous = this.writing.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => writeAtomically(file, JSON.stringify(Object.fromEntries(entries))));
    this.writing.set(chatId, next);
    try {
      await next;
    } finally {
      if (this.writing.get(chatId) === next) {
        this.writing.delete(chatId);
      }
    }
  }

  /** 这些消息里记过回答的，返回消息 id → 回答 */
  async get(chatId: string, messageIds: readonly string[]): Promise<Map<string, string>> {
    const entries = await this.load(chatId);
    const found = new Map<string, string>();
    for (const id of messageIds) {
      const entry = entries.get(id);
      if (entry) {
        found.set(id, entry.answer);
      }
    }
    return found;
  }

  private load(chatId: string): Promise<Map<string, Entry>> {
    let entries = this.loaded.get(chatId);
    if (!entries) {
      entries = readEntries(this.fileOf(chatId));
      this.loaded.set(chatId, entries);
      // 读失败（文件坏了、没权限）下次再读，不把失败记住
      entries.catch(() => this.loaded.delete(chatId));
    }
    return entries;
  }

  private fileOf(chatId: string): string {
    // chat_id 拼进文件名，只允许字母数字、下划线和连字符（oc_xxx）
    if (!/^[\w-]+$/.test(chatId)) {
      throw new Error(`chat_id 格式不对：${chatId}`);
    }
    return path.join(this.dir, `${chatId}.json`);
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
  const data: unknown = JSON.parse(text);
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
