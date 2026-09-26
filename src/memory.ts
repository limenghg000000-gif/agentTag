import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./history.js";

/** 记忆的类别。模型记的时候自己选，列出来时按类别分组 */
export const MEMORY_KINDS = {
  background: "背景",
  decision: "决定",
  convention: "约定",
  person: "成员",
} as const;

export type MemoryKind = keyof typeof MEMORY_KINDS;

/** 每个群最多记多少条，满了要先删掉或合并旧的 */
export const MAX_ENTRIES = 300;
/** 单条记忆的字数上限 */
export const MAX_CONTENT_CHARS = 500;
/** 写进系统提示词的记忆总字数上限，超出时只列最近更新的，其余让模型用工具查 */
export const MAX_PROMPT_MEMORY_CHARS = 8000;

export interface MemoryEntry {
  /** 群内编号，从 1 开始递增，删除后不复用，方便群成员说「忘掉第 3 条」 */
  id: number;
  kind: MemoryKind;
  content: string;
  /** 记下这条时 @ 机器人的人 */
  author?: string;
  authorId?: string;
  /** 记下这条时 @ 机器人的那条消息，方便追溯 */
  sourceMessageId?: string;
  createdAt: string;
  updatedAt?: string;
}

/** 一次写入的来源：谁在哪条消息里让机器人记的 */
export interface MemoryAuthor {
  name?: string;
  openId?: string;
  messageId?: string;
}

interface MemoryFile {
  version: 1;
  chatId: string;
  nextId: number;
  entries: MemoryEntry[];
}

export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryError";
  }
}

/**
 * 按群保存的长期记忆。每个群一个 JSON 文件（<dir>/<chat_id>.json），重启后还在。
 * 同一个群的写入排队进行，先写临时文件再改名，写到一半断电也不会把文件写坏。
 */
export class MemoryStore {
  private readonly cache = new Map<string, Promise<MemoryFile>>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    readonly dir: string,
    private readonly logger: Logger = console,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 建好存放目录，启动时调用，目录不可写时尽早报错 */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  async list(chatId: string): Promise<MemoryEntry[]> {
    return structuredClone((await this.load(chatId)).entries);
  }

  async add(chatId: string, kind: MemoryKind, content: string, author: MemoryAuthor = {}): Promise<{ entry: MemoryEntry; duplicate: boolean }> {
    const text = normalizeContent(content);
    const added = await this.mutate(chatId, (file) => {
      const existing = file.entries.find((e) => e.content === text);
      if (existing) {
        return { result: { entry: existing, duplicate: true }, changed: false };
      }
      if (file.entries.length >= MAX_ENTRIES) {
        throw new MemoryError(`这个群的记忆已经有 ${MAX_ENTRIES} 条，到上限了。请先删掉过时的，或把相关的几条合并成一条`);
      }
      const entry: MemoryEntry = {
        id: file.nextId++,
        kind,
        content: text,
        ...(author.name ? { author: author.name } : {}),
        ...(author.openId ? { authorId: author.openId } : {}),
        ...(author.messageId ? { sourceMessageId: author.messageId } : {}),
        createdAt: this.now().toISOString(),
      };
      file.entries.push(entry);
      return { result: { entry, duplicate: false }, changed: true };
    });
    if (!added.duplicate) {
      this.logChange(chatId, `新增 #${added.entry.id}`, author);
    }
    return added;
  }

  async update(chatId: string, id: number, changes: { content?: string; kind?: MemoryKind }, author: MemoryAuthor = {}): Promise<MemoryEntry> {
    const text = changes.content === undefined ? undefined : normalizeContent(changes.content);
    const updated = await this.mutate(chatId, (file) => {
      const entry = file.entries.find((e) => e.id === id);
      if (!entry) {
        throw new MemoryError(`没有编号为 #${id} 的记忆`);
      }
      if (text !== undefined) {
        entry.content = text;
      }
      if (changes.kind) {
        entry.kind = changes.kind;
      }
      entry.updatedAt = this.now().toISOString();
      if (author.name) {
        entry.author = author.name;
      }
      if (author.openId) {
        entry.authorId = author.openId;
      }
      if (author.messageId) {
        entry.sourceMessageId = author.messageId;
      }
      return { result: { ...entry }, changed: true };
    });
    this.logChange(chatId, `修改 #${id}`, author);
    return updated;
  }

  /** 删除几条记忆，返回删掉的和没找到的编号 */
  async remove(chatId: string, ids: readonly number[], author: MemoryAuthor = {}): Promise<{ removed: MemoryEntry[]; missing: number[] }> {
    const result = await this.mutate(chatId, (file) => {
      const wanted = new Set(ids);
      const removed = file.entries.filter((e) => wanted.has(e.id));
      const missing = [...wanted].filter((id) => !removed.some((e) => e.id === id));
      file.entries = file.entries.filter((e) => !wanted.has(e.id));
      return { result: { removed, missing }, changed: removed.length > 0 };
    });
    if (result.removed.length > 0) {
      this.logChange(chatId, `删除 ${result.removed.map((e) => `#${e.id}`).join(" ")}`, author);
    }
    return result;
  }

  /** 改动记进日志备查。只记编号和操作人，不记内容：被要求忘掉的东西不该留在日志里 */
  private logChange(chatId: string, action: string, author: MemoryAuthor): void {
    this.logger.info(`群记忆 chat=${chatId} ${action} 操作人=${author.openId ?? "未知"} message=${author.messageId ?? "未知"}`);
  }

  private load(chatId: string): Promise<MemoryFile> {
    let loaded = this.cache.get(chatId);
    if (!loaded) {
      loaded = this.read(chatId);
      this.cache.set(chatId, loaded);
      // 读失败（比如磁盘错误）不缓存，下次重试
      loaded.catch(() => this.cache.delete(chatId));
    }
    return loaded;
  }

  private async read(chatId: string): Promise<MemoryFile> {
    const file = this.fileOf(chatId);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, chatId, nextId: 1, entries: [] };
      }
      throw err;
    }
    try {
      return parseMemoryFile(raw, chatId);
    } catch (err) {
      // 文件坏了不能直接当成空的覆盖掉：挪到一边留着人工恢复，这个群从空记忆重新开始
      const aside = `${file}.corrupt-${Date.now()}`;
      await rename(file, aside);
      this.logger.error(`群记忆文件损坏，已挪到 ${aside}，这个群的记忆从空开始：${(err as Error).message}`);
      return { version: 1, chatId, nextId: 1, entries: [] };
    }
  }

  /** 同一个群的修改排队执行：在副本上改，写盘成功后才替换内存里的版本 */
  private mutate<T>(chatId: string, change: (file: MemoryFile) => { result: T; changed: boolean }): Promise<T> {
    const previous = this.locks.get(chatId) ?? Promise.resolve();
    const run = previous.then(async () => {
      const draft = structuredClone(await this.load(chatId));
      const { result, changed } = change(draft);
      if (changed) {
        await this.write(draft);
        this.cache.set(chatId, Promise.resolve(draft));
      }
      return result;
    });
    const settled = run.catch(() => {});
    this.locks.set(chatId, settled);
    void settled.then(() => {
      if (this.locks.get(chatId) === settled) {
        this.locks.delete(chatId);
      }
    });
    return run;
  }

  private async write(file: MemoryFile): Promise<void> {
    await this.init();
    const target = this.fileOf(file.chatId);
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private fileOf(chatId: string): string {
    // chat_id 形如 oc_xxx，只允许字母数字下划线和横线，防止拼出目录外的路径
    if (!/^[\w-]+$/.test(chatId)) {
      throw new MemoryError(`不合法的群 id：${chatId}`);
    }
    return path.join(this.dir, `${chatId}.json`);
  }
}

function parseMemoryFile(raw: string, chatId: string): MemoryFile {
  const data = JSON.parse(raw) as Partial<MemoryFile>;
  if (data.version !== 1 || !Array.isArray(data.entries) || typeof data.nextId !== "number") {
    throw new Error("格式不对");
  }
  const entries = data.entries.filter(
    (e): e is MemoryEntry => typeof e?.id === "number" && typeof e.content === "string" && e.kind in MEMORY_KINDS,
  );
  const nextId = Math.max(data.nextId, ...entries.map((e) => e.id + 1));
  return { version: 1, chatId, nextId, entries };
}

/** 去掉首尾空白，换行合成一行（记忆在提示词里一条一行），检查长度 */
export function normalizeContent(content: string): string {
  const text = content.replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ").trim();
  if (!text) {
    throw new MemoryError("记忆内容不能为空");
  }
  if (text.length > MAX_CONTENT_CHARS) {
    throw new MemoryError(`单条记忆最多 ${MAX_CONTENT_CHARS} 字，现在 ${text.length} 字。请写得更精炼，或拆成几条`);
  }
  return text;
}

const DATE_FORMAT = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric" });

/** 一条记忆写成一行：#3 决定：发版固定在每周三（张三，2026/9/26） */
export function formatEntry(entry: MemoryEntry, withKind = true): string {
  const date = DATE_FORMAT.format(new Date(entry.updatedAt ?? entry.createdAt));
  const meta = entry.author ? `${entry.author}，${date}` : date;
  return `#${entry.id} ${withKind ? `${MEMORY_KINDS[entry.kind]}：` : ""}${entry.content}（${meta}）`;
}

/**
 * 把群记忆整理成写进系统提示词的文本，按类别分组。超出字数上限时优先保留最近更新的，
 * omitted 是没列出来的条数，这时要给模型查记忆的工具。
 */
export function renderMemoryForPrompt(entries: readonly MemoryEntry[], budget = MAX_PROMPT_MEMORY_CHARS): { text: string; omitted: number } {
  const newestFirst = [...entries].sort((a, b) => recency(b) - recency(a) || b.id - a.id);
  const kept: MemoryEntry[] = [];
  let used = 0;
  for (const entry of newestFirst) {
    const line = formatEntry(entry, false);
    if (used + line.length > budget) {
      break;
    }
    used += line.length + 1;
    kept.push(entry);
  }

  const sections: string[] = [];
  for (const [kind, label] of Object.entries(MEMORY_KINDS)) {
    const lines = kept
      .filter((e) => e.kind === kind)
      .sort((a, b) => a.id - b.id)
      .map((e) => `- ${formatEntry(e, false)}`);
    if (lines.length > 0) {
      sections.push(`【${label}】\n${lines.join("\n")}`);
    }
  }
  return { text: sections.join("\n"), omitted: entries.length - kept.length };
}

function recency(entry: MemoryEntry): number {
  return Date.parse(entry.updatedAt ?? entry.createdAt) || 0;
}

/**
 * 关键词检索：查询按空格和标点拆成词，整词出现得分最高；中文没有空格，
 * 整词没出现时按两字片段的重合比例给部分分，这样「什么时候发版」也能找到「每周三发版」。
 */
export function searchMemory(entries: readonly MemoryEntry[], query: string, limit = 20): MemoryEntry[] {
  const terms = query.toLowerCase().split(/[\s,，。、;；:：!！?？"'“”‘’()（）]+/).filter(Boolean);
  if (terms.length === 0) {
    return [];
  }
  const scored = entries.map((entry) => {
    const text = `${MEMORY_KINDS[entry.kind]} ${entry.content} ${entry.author ?? ""}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (text.includes(term)) {
        score += 1;
        continue;
      }
      const grams = bigrams(term);
      if (grams.length > 0) {
        score += (grams.filter((g) => text.includes(g)).length / grams.length) * 0.8;
      }
    }
    return { entry, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.id - a.entry.id)
    .slice(0, limit)
    .map((s) => s.entry);
}

function bigrams(term: string): string[] {
  const chars = [...term];
  const grams: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) {
    grams.push(chars[i] + chars[i + 1]);
  }
  return grams;
}
