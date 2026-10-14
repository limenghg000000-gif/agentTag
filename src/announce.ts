import { readFile } from "node:fs/promises";
import type { SendInput, SendResult } from "@larksuiteoapi/node-sdk";
import { writeAtomically } from "./file-store.js";
import type { Logger } from "./history.js";
import { escapeCardMarkdown } from "./markdown.js";

/** CHANGELOG.md 里的一个版本 */
export interface ChangelogVersion {
  version: string;
  /** 标题行版本号后面写的日期，没写时为空 */
  date?: string;
  /** 发到群里的说明：标题行之后、第一个 ### 小标题之前的部分，去掉了 PR 号 */
  notes: string;
}

/** 一张通知卡片最多列几个版本，更早的只说还有几个 */
export const MAX_ANNOUNCED_VERSIONS = 5;
/** 一张通知卡片里说明的总字数上限，超了后面的版本只说还有几个 */
const MAX_NOTES_CHARS = 3000;
/** 发失败的群过一阵再试 */
export const ANNOUNCE_RETRY_MS = 10 * 60_000;
/** 一个群一次部署最多试这么多次，还发不出去就等下次重启 */
export const ANNOUNCE_MAX_ATTEMPTS = 6;

const VERSION_HEADING = /^##\s+v?(\d+)\.(\d+)\.(\d+)(?:\s*[—–-]+\s*(.*?))?\s*$/;
/** 二级标题（「## 」开头），不含「### 」 */
const H2 = /^##\s/;
const H3 = /^###\s/;
/** 结尾的 PR 号：（#26）、(#35、#37)、（#40, #41） */
const PR_REFS = /\s*[（(]\s*#\d+(?:\s*[、，,]\s*#\d+)*\s*[）)]/g;

/**
 * 读 CHANGELOG.md：每个「## 0.8.0 — 2026-10-14」开头的段是一个版本，按文件里的先后返回（最新的在最上面）。
 * 「## 未发布」这类没有版本号的段跳过。每段只取 ### 小标题之前的部分，### 下面（比如「### 管理员」）是不发群里的说明
 */
export function parseChangelog(text: string): ChangelogVersion[] {
  const versions: ChangelogVersion[] = [];
  let current: { version: string; date?: string; lines: string[]; cut: boolean } | undefined;
  const flush = () => {
    if (current) {
      const notes = current.lines.join("\n").replace(PR_REFS, "").trim();
      versions.push({ version: current.version, ...(current.date ? { date: current.date } : {}), notes });
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (H2.test(line)) {
      flush();
      const match = VERSION_HEADING.exec(line);
      current = match
        ? { version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`, date: match[4] || undefined, lines: [], cut: false }
        : undefined;
      continue;
    }
    if (!current || current.cut) {
      continue;
    }
    if (H3.test(line)) {
      current.cut = true;
      continue;
    }
    current.lines.push(line.trimEnd());
  }
  flush();
  return versions;
}

/** 按数字比较两个 x.y.z 版本号：a 新返回正数，一样返回 0 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * 这个群要发哪几个版本（新的在前）。没发过（lastAnnounced 为空）只发最新的一版，免得把以前的全倒进群里；
 * 发过就发比上次新的所有版本。回退到旧版本时什么都不发
 */
export function pendingVersions(versions: readonly ChangelogVersion[], lastAnnounced: string | undefined): ChangelogVersion[] {
  const sorted = [...versions].sort((a, b) => compareVersions(b.version, a.version));
  if (sorted.length === 0) {
    return [];
  }
  if (lastAnnounced === undefined) {
    return [sorted[0]!];
  }
  return sorted.filter((v) => compareVersions(v.version, lastAnnounced) > 0);
}

export interface AnnouncementOptions {
  botName?: string;
  /** 「看全部功能」按钮打开的链接 */
  link?: string;
  /** 这个群第一次收到更新通知：末尾介绍一句自己 */
  firstTime?: boolean;
}

/** 更新通知卡片（飞书卡片 JSON 2.0）。versions 新的在前 */
export function renderAnnouncementCard(versions: readonly ChangelogVersion[], options: AnnouncementOptions = {}): object {
  const name = options.botName || "机器人";
  const shown: ChangelogVersion[] = [];
  let chars = 0;
  for (const v of versions) {
    // 第一个版本再长也要列出来，后面的放不下就只说还有几个
    if (shown.length >= MAX_ANNOUNCED_VERSIONS || (shown.length > 0 && chars + v.notes.length > MAX_NOTES_CHARS)) {
      break;
    }
    shown.push(v);
    chars += v.notes.length;
  }
  const title = `${name} 更新了 · ${versions[0]?.version ?? ""}`;
  const elements: object[] = shown.map((v) => ({
    tag: "markdown",
    // 只有一个版本时标题里已经有版本号了，不再写一遍
    content: [
      ...(versions.length > 1 ? [`**${v.version}**${v.date ? ` <font color='grey'>${escapeCardMarkdown(v.date)}</font>` : ""}`] : []),
      escapeCardMarkdown(v.notes),
    ].join("\n"),
  }));
  const rest = versions.length - shown.length;
  const footer = [
    ...(rest > 0 ? [`还有 ${rest} 个更早的版本没列出来，见更新日志。`] : []),
    options.firstTime
      ? `我是${escapeCardMarkdown(name)}，在群里 @ 我就能提问、派活。以后每次更新，我都会在这里说一声。`
      : "有问题、想让我做什么，照常在群里 @ 我。",
  ];
  elements.push({ tag: "markdown", content: footer.map((line) => `<font color='grey'>${line}</font>`).join("\n") });
  if (options.link) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "看全部功能" },
      type: "primary",
      size: "small",
      behaviors: [{ type: "open_url", default_url: options.link }],
    });
  }
  return {
    schema: "2.0",
    config: { width_mode: "fill", summary: { content: title } },
    header: { title: { tag: "plain_text", content: title }, template: "blue" },
    body: { elements },
  };
}

/** 卡片发不出去时（比如飞书客户端太旧）退回的纯文本 */
export function renderAnnouncementMarkdown(versions: readonly ChangelogVersion[], options: AnnouncementOptions = {}): string {
  const name = options.botName || "机器人";
  const shown = versions.slice(0, MAX_ANNOUNCED_VERSIONS);
  const lines = [`**${name} 更新了 · ${versions[0]?.version ?? ""}**`];
  for (const v of shown) {
    if (versions.length > 1) {
      lines.push("", `**${v.version}**${v.date ? ` ${v.date}` : ""}`);
    } else {
      lines.push("");
    }
    lines.push(v.notes);
  }
  if (versions.length > shown.length) {
    lines.push("", `还有 ${versions.length - shown.length} 个更早的版本没列出来，见更新日志。`);
  }
  if (options.link) {
    lines.push("", `全部功能：${options.link}`);
  }
  return lines.join("\n");
}

interface AnnounceState {
  /** 每个群发到了哪一版 */
  chats: Record<string, string>;
}

export interface UpdateAnnouncerOptions {
  /** CHANGELOG.md 的位置 */
  changelogFile: string;
  /** 记每个群发到哪一版的文件 */
  stateFile: string;
  /** 发到这些群 */
  chatIds: readonly string[];
  send: (to: string, input: SendInput) => Promise<SendResult>;
  botName?: () => string | undefined;
  link?: string;
  logger?: Logger;
  retryMs?: number;
  maxAttempts?: number;
  /** 过一段时间再执行，测试时可以换掉 */
  schedule?: (fn: () => void, ms: number) => void;
}

/**
 * 更新通知：机器人启动时（部署新版本要重启）把 CHANGELOG.md 里这个群还没收到过的版本发到群里，
 * 发到了就记下这个群收到了哪一版，以后重启不再发。发不出去的群过 10 分钟再试，最多试 6 次
 */
export class UpdateAnnouncer {
  private readonly opts: UpdateAnnouncerOptions;
  private readonly logger: Logger;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private stopped = false;
  private running?: Promise<void>;

  constructor(opts: UpdateAnnouncerOptions) {
    this.opts = opts;
    this.logger = opts.logger ?? console;
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        setTimeout(fn, ms).unref();
      });
  }

  /** 发一轮。出错只记日志，不影响机器人别的功能 */
  run(): Promise<void> {
    this.running = this.attempt(this.opts.chatIds, 1).catch((err: unknown) => this.logger.error("更新通知：发送失败", err));
    return this.running;
  }

  /** 退出前调用：不再重试，等正在发的发完 */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  private async attempt(chatIds: readonly string[], attempt: number): Promise<void> {
    if (this.stopped || chatIds.length === 0) {
      return;
    }
    let text: string;
    try {
      text = await readFile(this.opts.changelogFile, "utf8");
    } catch (err) {
      this.logger.warn(`更新通知：读不到 ${this.opts.changelogFile}，这次不发`, err);
      return;
    }
    const versions = parseChangelog(text);
    if (versions.length === 0) {
      this.logger.warn(`更新通知：${this.opts.changelogFile} 里没有「## x.y.z」这样的版本，这次不发`);
      return;
    }
    const state = await this.loadState();
    const failed: string[] = [];
    for (const chatId of chatIds) {
      if (this.stopped) {
        return;
      }
      const last = state.chats[chatId];
      const pending = pendingVersions(versions, last);
      if (pending.length === 0) {
        continue;
      }
      const options: AnnouncementOptions = {
        ...(this.opts.botName?.() ? { botName: this.opts.botName() } : {}),
        ...(this.opts.link ? { link: this.opts.link } : {}),
        firstTime: last === undefined,
      };
      const list = pending.map((v) => v.version).join("、");
      if (!(await this.sendTo(chatId, pending, options))) {
        failed.push(chatId);
        continue;
      }
      // 发到了先记下来，后面的群出错、进程退出都不会让这个群再收一遍
      state.chats[chatId] = pending[0]!.version;
      try {
        await writeAtomically(this.opts.stateFile, `${JSON.stringify(state, null, 2)}\n`);
      } catch (err) {
        this.logger.error(`更新通知：已发到群 ${chatId}，但记不下来（${this.opts.stateFile}），下次重启会再发一遍`, err);
      }
      this.logger.info(`更新通知：已发到群 ${chatId}，版本 ${list}`);
    }
    if (failed.length === 0) {
      return;
    }
    if (attempt >= (this.opts.maxAttempts ?? ANNOUNCE_MAX_ATTEMPTS)) {
      this.logger.warn(`更新通知：群 ${failed.join(", ")} 试了 ${attempt} 次还是发不出去，下次重启再发`);
      return;
    }
    const retryMs = this.opts.retryMs ?? ANNOUNCE_RETRY_MS;
    this.logger.warn(`更新通知：群 ${failed.join(", ")} 没发出去，${Math.round(retryMs / 60_000)} 分钟后再试`);
    this.schedule(() => {
      this.running = this.attempt(failed, attempt + 1).catch((err: unknown) => this.logger.error("更新通知：发送失败", err));
    }, retryMs);
  }

  /** 先发卡片，卡片发不出去再发一次纯文本。都失败返回 false */
  private async sendTo(chatId: string, versions: ChangelogVersion[], options: AnnouncementOptions): Promise<boolean> {
    try {
      await this.opts.send(chatId, { card: renderAnnouncementCard(versions, options) });
      return true;
    } catch (err) {
      this.logger.warn(`更新通知：卡片发不到群 ${chatId}，改发文字`, err);
    }
    try {
      await this.opts.send(chatId, { markdown: renderAnnouncementMarkdown(versions, options) });
      return true;
    } catch (err) {
      this.logger.warn(`更新通知：发不到群 ${chatId}`, err);
      return false;
    }
  }

  private async loadState(): Promise<AnnounceState> {
    let text: string;
    try {
      text = await readFile(this.opts.stateFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(`更新通知：读不了 ${this.opts.stateFile}，当作哪个群都没发过（每个群只会收到最新的一版）`, err);
      }
      return { chats: {} };
    }
    try {
      const parsed = JSON.parse(text) as Partial<AnnounceState>;
      const chats: Record<string, string> = {};
      for (const [chatId, version] of Object.entries(parsed.chats ?? {})) {
        if (typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)) {
          chats[chatId] = version;
        }
      }
      return { chats };
    } catch (err) {
      this.logger.warn(`更新通知：${this.opts.stateFile} 写坏了，当作哪个群都没发过（每个群只会收到最新的一版）`, err);
      return { chats: {} };
    }
  }
}
