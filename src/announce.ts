import { readFile } from "node:fs/promises";
import type { SendInput, SendResult } from "@larksuiteoapi/node-sdk";
import { writeAtomically } from "./file-store.js";
import type { Logger } from "./history.js";
import { escapeCardMarkdown } from "./markdown.js";

/** 产品更新说明（RELEASE_NOTES.md）里的一个版本 */
export interface ReleaseNotesVersion {
  version: string;
  /** 标题行版本号后面写的日期，没写时为空 */
  date?: string;
  /** 发到群里的说明：标题行之后、第一个 ### 小标题之前的部分，去掉了 PR 号 */
  notes: string;
  /** 技术版 CHANGELOG.md 里同一版本的内容，卡片上折叠放在「技术说明」里；没有时为空 */
  tech?: string;
  /** 说明里单独一行写的文档链接，卡片上在原来那一行的位置做成按钮；没有时为空 */
  links?: ReleaseNotesLink[];
  /**
   * 有文档链接时，说明按链接切开的几段：parts[i] 在第 i 个链接前面，最后一段在最后一个链接后面（可能是空的）。
   * 卡片照这个顺序放，每个新功能的按钮跟在它那一段下面
   */
  parts?: string[];
}

/**
 * 版本说明里单独一行的链接「[改代码怎么用](https://…)」：target 是 https 地址，
 * 或者「文档中心」「功能说明」（后面可以带 #小节），发的时候换成 DOCS_LINK、ANNOUNCE_LINK，仓库里不用写死地址
 */
export interface ReleaseNotesLink {
  text: string;
  target: string;
}

/** 产品名：通知卡片的标题用它，不用飞书里机器人的名字（以后可能换机器人） */
export const PRODUCT_NAME = "AgentTag";

/** 一张通知卡片最多列几个版本，更早的只说还有几个 */
export const MAX_ANNOUNCED_VERSIONS = 5;
/**
 * 一张通知卡片里说明的总字数上限，超了后面的版本只说还有几个。攒几个改动一起发的一版，每个新功能都写能做什么、谁用得上、怎么说，
 * 所以放得比较宽；加上技术说明，卡片也在飞书的 30 KB 以内
 */
export const MAX_NOTES_CHARS = 4500;
/** 一张卡片里技术说明加起来最多多少字，超了放不下的版本不放 */
export const MAX_TECH_TOTAL_CHARS = 3500;
/** 一个版本的技术说明最多放多少字：攒一批发的一版，一张卡片常常就它一版，给它整份的量 */
export const MAX_TECH_CHARS = MAX_TECH_TOTAL_CHARS;
/** 飞书卡片 JSON 最多 30 KB，留点余量 */
export const MAX_CARD_BYTES = 28_000;
/** 发失败的群过一阵再试 */
export const ANNOUNCE_RETRY_MS = 10 * 60_000;
/** 一个群一次部署最多试这么多次，还发不出去就等下次重启 */
export const ANNOUNCE_MAX_ATTEMPTS = 6;

/** 版本标题：「## 0.8.0 — 2026-10-14」，也认开源项目常用的「## [0.8.0] - 2026-10-14」 */
const VERSION_HEADING = /^##\s+\[?v?(\d+)\.(\d+)\.(\d+)\]?(?:\s*[—–-]+\s*(.*?))?\s*$/;
/** 二级标题（「## 」开头），不含「### 」 */
const H2 = /^##\s/;
const H3 = /^###\s/;
/** 结尾的 PR 号：（#26）、(#35、#37)、（#40, #41） */
const PR_REFS = /\s*[（(]\s*#\d+(?:\s*[、，,]\s*#\d+)*\s*[）)]/g;
/** 单独一行的链接，前面可以有「- 」：「[改代码怎么用](文档中心#guide-f-code)」。按钮上的字最多 20 个 */
const LINK_LINE = /^\s*(?:[-*]\s+)?\[([^[\]\n]{1,20})\]\(([^()\s<>]+)\)\s*$/;
/** 一个版本下面最多几个文档按钮，多的照原样留在说明里 */
export const MAX_VERSION_LINKS = 3;

/**
 * 读产品更新说明（RELEASE_NOTES.md）：每个「## 0.8.0 — 2026-10-14」开头的段是一个版本，按文件里的先后返回（最新的在最上面）。
 * 「## 未发布」这类没有版本号的段跳过（平时合并的改动先写在那里，发版时才定版本号）。每段只取 ### 小标题之前的部分，结尾的 PR 号去掉；
 * 单独一行的链接（最多 MAX_VERSION_LINKS 个）从说明里拿出来，放进 links，说明按它们切开放进 parts
 */
export function parseReleaseNotes(text: string): ReleaseNotesVersion[] {
  const versions: ReleaseNotesVersion[] = [];
  let current: { version: string; date?: string; lines: string[]; parts: string[][]; links: ReleaseNotesLink[]; cut: boolean } | undefined;
  const clean = (lines: readonly string[]) => lines.join("\n").replace(PR_REFS, "").replace(/\n{3,}/g, "\n\n").trim();
  const flush = () => {
    if (current) {
      versions.push({
        version: current.version,
        ...(current.date ? { date: current.date } : {}),
        notes: clean(current.lines),
        ...(current.links.length > 0 ? { links: current.links, parts: current.parts.map(clean) } : {}),
      });
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (H2.test(line)) {
      flush();
      const match = VERSION_HEADING.exec(line);
      current = match
        ? {
            version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
            date: match[4] || undefined,
            lines: [],
            parts: [[]],
            links: [],
            cut: false,
          }
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
    const link = LINK_LINE.exec(line);
    if (link && current.links.length < MAX_VERSION_LINKS) {
      current.links.push({ text: link[1]!.trim(), target: link[2]! });
      current.parts.push([]);
      continue;
    }
    current.lines.push(line.trimEnd());
    current.parts.at(-1)!.push(line.trimEnd());
  }
  flush();
  return versions;
}

/** 文档链接的写法：「文档中心」「功能说明」，后面可以带 #小节（字母、数字、- _ . ~） */
const NAMED_TARGET = /^(文档中心|功能说明)(#[\w.~-]+)?$/;

/**
 * 版本说明里的链接换成能打开的地址：https 地址原样用；「文档中心」「功能说明」换成配置的 DOCS_LINK、ANNOUNCE_LINK（原来带的 # 去掉，换成这里写的小节）。
 * 没配对应的链接、或者写的不是这两种的，不放按钮
 */
export function resolveNotesLink(target: string, options: Pick<AnnouncementOptions, "link" | "docsLink">): string | undefined {
  const named = NAMED_TARGET.exec(target);
  if (named) {
    const base = named[1] === "文档中心" ? options.docsLink : options.link;
    return base ? `${base.replace(/#.*$/, "")}${named[2] ?? ""}` : undefined;
  }
  try {
    return new URL(target).protocol === "https:" ? target : undefined;
  } catch {
    return undefined;
  }
}

/** 这个版本能放的文档按钮：按钮上的字和打开的地址 */
function versionLinks(v: ReleaseNotesVersion, options: AnnouncementOptions): { text: string; url: string }[] {
  return (v.links ?? []).flatMap((link) => {
    const url = resolveNotesLink(link.target, options);
    return url ? [{ text: link.text, url }] : [];
  });
}

type NotesSegment = { text: string } | { buttons: { text: string; url: string }[] };

/**
 * 一个版本在卡片上按什么顺序放：说明的一段、这段下面的文档按钮、下一段……挨着的按钮放一排，打不开的链接不放。
 * 说明被截短过（parts 和 notes 对不上了）时，整段说明在前、按钮都放最后
 */
function notesSegments(v: ReleaseNotesVersion, options: AnnouncementOptions): NotesSegment[] {
  const links = v.links ?? [];
  const parts = v.parts?.length === links.length + 1 ? v.parts : undefined;
  if (!parts) {
    const buttons = versionLinks(v, options);
    return [...(v.notes ? [{ text: v.notes }] : []), ...(buttons.length > 0 ? [{ buttons }] : [])];
  }
  const segments: NotesSegment[] = [];
  const add = (segment: NotesSegment) => {
    const last = segments.at(-1);
    if ("text" in segment) {
      if (!segment.text) {
        return;
      }
      if (last && "text" in last) {
        last.text = `${last.text}\n\n${segment.text}`;
        return;
      }
    } else if (last && "buttons" in last) {
      last.buttons.push(...segment.buttons);
      return;
    }
    segments.push(segment);
  };
  parts.forEach((part, i) => {
    add({ text: part });
    const link = links[i];
    const url = link ? resolveNotesLink(link.target, options) : undefined;
    if (link && url) {
      add({ buttons: [{ text: link.text, url }] });
    }
  });
  return segments;
}

/**
 * 读技术版更新日志（CHANGELOG.md）：版本号 → 这一版的全部内容（「### 新增」这类分类小标题换成加粗），
 * 放进通知卡片折叠的「技术说明」里。没有版本号的段跳过
 */
export function parseChangelogTech(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: { version: string; lines: string[] } | undefined;
  const flush = () => {
    if (current && !sections.has(current.version)) {
      const body = current.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (body) {
        sections.set(current.version, body);
      }
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (H2.test(line)) {
      flush();
      const match = VERSION_HEADING.exec(line);
      current = match ? { version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`, lines: [] } : undefined;
      continue;
    }
    if (current) {
      const h3 = /^###\s+(.+?)\s*$/.exec(line);
      current.lines.push(h3 ? `**${h3[1]}**` : line.trimEnd());
    }
  }
  flush();
  return sections;
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
export function pendingVersions(versions: readonly ReleaseNotesVersion[], lastAnnounced: string | undefined): ReleaseNotesVersion[] {
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
  /** 「产品功能说明」按钮打开的链接（ANNOUNCE_LINK） */
  link?: string;
  /** 「文档中心」按钮打开的链接（DOCS_LINK） */
  docsLink?: string;
  /** 这个群第一次收到更新通知：末尾介绍一句自己 */
  firstTime?: boolean;
}

/**
 * 一条通知里列哪几个版本（卡片和退回的文字一样）：最多 MAX_ANNOUNCED_VERSIONS 个、说明加起来不超过 MAX_NOTES_CHARS 字，
 * 后面的只说还有几个。第一个版本再长也要列，太长就按行截短
 */
function shownVersions(versions: readonly ReleaseNotesVersion[], options: AnnouncementOptions): ReleaseNotesVersion[] {
  const see = seeFull(options);
  const shown: ReleaseNotesVersion[] = [];
  let chars = 0;
  for (const v of versions) {
    if (shown.length >= MAX_ANNOUNCED_VERSIONS || (shown.length > 0 && chars + v.notes.length > MAX_NOTES_CHARS)) {
      break;
    }
    shown.push(v.notes.length > MAX_NOTES_CHARS ? { ...v, notes: truncateText(v.notes, MAX_NOTES_CHARS, see), parts: undefined } : v);
    chars += v.notes.length;
  }
  // 技术说明另算一份字数：每版最多 MAX_TECH_CHARS 字，加起来超了 MAX_TECH_TOTAL_CHARS 的那版不放
  let techChars = 0;
  return shown.map((v) => {
    if (!v.tech) {
      return v;
    }
    const tech = v.tech.length > MAX_TECH_CHARS ? truncateText(v.tech, MAX_TECH_CHARS, see) : v.tech;
    if (techChars + tech.length > MAX_TECH_TOTAL_CHARS) {
      const { tech: _dropped, ...rest } = v;
      return rest;
    }
    techChars += tech.length;
    return { ...v, tech };
  });
}

/** 说明、技术说明、更早的版本放不下时，让大家去哪看全的：配了文档中心才说，没配不指一个打不开的地方 */
function seeFull(options: AnnouncementOptions): string {
  return options.docsLink ? "，见文档中心的更新日志" : "";
}

/** 按行截短，连同末尾「没列全」那句不超过 max 字；第一行就超了按字截 */
function truncateText(text: string, max: number, seeAlso: string): string {
  const tail = `\n…（太长了没列全${seeAlso}）`;
  const room = max - tail.length;
  const kept: string[] = [];
  let chars = 0;
  for (const line of text.split("\n")) {
    if (chars + line.length + 1 > room) {
      break;
    }
    kept.push(line);
    chars += line.length + 1;
  }
  const head = kept.length > 0 ? kept.join("\n") : [...text].slice(0, room).join("");
  return `${head}${tail}`;
}

/** 每个版本说明上面的一行：只有一个版本时是「本次更新了什么」，几个版本时写明是哪一版 */
function versionHeading(v: ReleaseNotesVersion, single: boolean, date: (text: string) => string): string {
  const when = [`版本 ${v.version}`, ...(v.date ? [v.date] : [])].join(" · ");
  return single ? `**本次更新了什么**　${date(when)}` : `**${v.version} 更新了什么**${v.date ? `　${date(v.date)}` : ""}`;
}

/** 卡片和退回的文字末尾都有的几句：还有几个版本没列、第一次收到通知时介绍一句自己 */
function footerLines(name: string, rest: number, options: AnnouncementOptions): string[] {
  return [
    ...(rest > 0 ? [`还有 ${rest} 个更早的版本没列出来${seeFull(options)}。`] : []),
    options.firstTime
      ? `我是${name}，在群里 @ 我就能提问、派活。以后每次更新，我都会在这里说一声。`
      : "有问题、想让我做什么，照常在群里 @ 我。",
  ];
}

/** 卡片最下面的按钮：产品功能说明、文档中心，配了哪个放哪个 */
function footerLinks(options: AnnouncementOptions): { text: string; url: string; primary?: boolean }[] {
  return [
    ...(options.link ? [{ text: "产品功能说明", url: options.link, primary: true }] : []),
    ...(options.docsLink ? [{ text: "文档中心", url: options.docsLink }] : []),
  ];
}

/** 一排打开链接的按钮，手机上放不下自动换行 */
function buttonRow(buttons: readonly { text: string; url: string; primary?: boolean }[]): object {
  return {
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: "8px",
    columns: buttons.map((button) => ({
      tag: "column",
      width: "auto",
      elements: [
        {
          tag: "button",
          text: { tag: "plain_text", content: button.text },
          type: button.primary ? "primary" : "default",
          size: "small",
          behaviors: [{ type: "open_url", default_url: button.url }],
        },
      ],
    })),
  };
}

/**
 * 更新通知卡片（飞书卡片 JSON 2.0）。versions 新的在前。字数上限按字算，尖括号转义、中文三个字节，
 * 极端情况下整张卡片还会超过 MAX_CARD_BYTES：从最后一版起去掉技术说明，直到放得下（不带技术说明的卡片一定放得下）
 */
export function renderAnnouncementCard(versions: readonly ReleaseNotesVersion[], options: AnnouncementOptions = {}): object {
  let shown = shownVersions(versions, options);
  let card = cardJson(versions, shown, options);
  for (let i = shown.length - 1; i >= 0 && Buffer.byteLength(JSON.stringify(card)) > MAX_CARD_BYTES; i--) {
    if (shown[i]!.tech) {
      shown = shown.map((v, j) => (j === i ? { ...v, tech: undefined } : v));
      card = cardJson(versions, shown, options);
    }
  }
  return card;
}

function cardJson(versions: readonly ReleaseNotesVersion[], shown: readonly ReleaseNotesVersion[], options: AnnouncementOptions): object {
  const name = options.botName || "机器人";
  const title = `${PRODUCT_NAME} 更新了 · ${versions[0]?.version ?? ""}`;
  const grey = (text: string) => `<font color='grey'>${escapeCardMarkdown(text)}</font>`;
  const elements: object[] = shown.flatMap((v) => {
    // 说明和每个新功能的文档按钮按写的顺序放，这一版的标题写在第一段说明前面
    const segments = notesSegments(v, options);
    const first = segments[0];
    const lead = first && "text" in first ? first.text : "";
    const body = [
      { tag: "markdown", content: [versionHeading(v, versions.length === 1, grey), escapeCardMarkdown(lead)].filter(Boolean).join("\n") },
      ...segments
        .slice(lead ? 1 : 0)
        .map((segment) => ("buttons" in segment ? buttonRow(segment.buttons) : { tag: "markdown", content: escapeCardMarkdown(segment.text) })),
    ];
    return [
      ...body,
      // 技术说明给开发同事看，默认收起
      ...(v.tech
        ? [
            {
              tag: "collapsible_panel",
              expanded: false,
              header: {
                title: { tag: "markdown", content: `<font color='grey'>技术说明（${escapeCardMarkdown(v.version)}，给开发看）</font>` },
                icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
                icon_position: "right",
                icon_expanded_angle: -180,
              },
              elements: [{ tag: "markdown", content: escapeCardMarkdown(v.tech) }],
            },
          ]
        : []),
    ];
  });
  const footer = footerLines(escapeCardMarkdown(name), versions.length - shown.length, options);
  elements.push({ tag: "markdown", content: footer.map((line) => `<font color='grey'>${line}</font>`).join("\n") });
  const links = footerLinks(options);
  if (links.length > 0) {
    elements.push(buttonRow(links));
  }
  return {
    schema: "2.0",
    config: { width_mode: "fill", summary: { content: title } },
    header: { title: { tag: "plain_text", content: title }, template: "blue" },
    body: { elements },
  };
}

/**
 * 飞书说卡片格式不对时退回的文字，列的版本和末尾的几句都和卡片一样，技术说明不放（文字消息放不下那么长）。
 * 尖括号换成全角：Markdown 里的 <at id=all></at> 也会 @所有人
 */
export function renderAnnouncementMarkdown(versions: readonly ReleaseNotesVersion[], options: AnnouncementOptions = {}): string {
  const name = options.botName || "机器人";
  const shown = shownVersions(versions, options);
  const lines = [`**${PRODUCT_NAME} 更新了 · ${versions[0]?.version ?? ""}**`];
  for (const v of shown) {
    lines.push("", versionHeading(v, versions.length === 1, (text) => text), v.notes);
    lines.push(...versionLinks(v, options).map((link) => `${link.text}：${link.url}`));
  }
  lines.push("", ...footerLines(name, versions.length - shown.length, options));
  const links = footerLinks(options);
  if (links.length > 0) {
    lines.push("", ...links.map((link) => `${link.text}：${link.url}`));
  }
  return lines.join("\n").replace(/</g, "＜").replace(/>/g, "＞");
}

interface AnnounceState {
  /** 每个群发到了哪一版 */
  chats: Record<string, string>;
}

export interface UpdateAnnouncerOptions {
  /** 产品更新说明 RELEASE_NOTES.md 的位置 */
  notesFile: string;
  /** 技术版 CHANGELOG.md 的位置，同一版本的内容折叠放在卡片的「技术说明」里；读不到就不放 */
  changelogFile?: string;
  /** 记每个群发到哪一版的文件 */
  stateFile: string;
  /** 发到这些群 */
  chatIds: readonly string[];
  send: (to: string, input: SendInput) => Promise<SendResult>;
  botName?: () => string | undefined;
  /** 「产品功能说明」按钮（ANNOUNCE_LINK） */
  link?: string;
  /** 「文档中心」按钮（DOCS_LINK） */
  docsLink?: string;
  logger?: Logger;
  retryMs?: number;
  maxAttempts?: number;
  /** 过一段时间再执行，测试时可以换掉 */
  schedule?: (fn: () => void, ms: number) => void;
}

/**
 * 更新通知：机器人启动时（部署新版本要重启）把产品更新说明 RELEASE_NOTES.md 里这个群还没收到过的版本发到群里，
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
      text = await readFile(this.opts.notesFile, "utf8");
    } catch (err) {
      this.logger.warn(`更新通知：读不到 ${this.opts.notesFile}，这次不发`, err);
      return;
    }
    const notes = parseReleaseNotes(text);
    if (notes.length === 0) {
      this.logger.warn(`更新通知：${this.opts.notesFile} 里没有「## x.y.z」这样的版本，这次不发`);
      return;
    }
    const tech = await this.loadTech();
    const versions = notes.map((v) => (tech.has(v.version) ? { ...v, tech: tech.get(v.version)! } : v));
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
        ...(this.opts.docsLink ? { docsLink: this.opts.docsLink } : {}),
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

  /**
   * 先发卡片，飞书说卡片格式不对（format_error）时改发一次纯文本。超时、限流、没权限这类不改发文字：
   * 超时的卡片可能其实发出去了，再发文字群里就有两条，交给过一阵再试。发不出去返回 false
   */
  private async sendTo(chatId: string, versions: ReleaseNotesVersion[], options: AnnouncementOptions): Promise<boolean> {
    try {
      await this.opts.send(chatId, { card: renderAnnouncementCard(versions, options) });
      return true;
    } catch (err) {
      if ((err as { code?: unknown } | undefined)?.code !== "format_error") {
        this.logger.warn(`更新通知：卡片发不到群 ${chatId}`, err);
        return false;
      }
      this.logger.warn(`更新通知：飞书说卡片格式不对，改发文字到群 ${chatId}`, err);
    }
    try {
      await this.opts.send(chatId, { markdown: renderAnnouncementMarkdown(versions, options) });
      return true;
    } catch (err) {
      this.logger.warn(`更新通知：发不到群 ${chatId}`, err);
      return false;
    }
  }

  /** 技术版更新日志里每个版本的内容；没配或读不到时为空，通知照发，只是不带技术说明 */
  private async loadTech(): Promise<Map<string, string>> {
    if (!this.opts.changelogFile) {
      return new Map();
    }
    try {
      return parseChangelogTech(await readFile(this.opts.changelogFile, "utf8"));
    } catch (err) {
      this.logger.warn(`更新通知：读不到 ${this.opts.changelogFile}，这次不带技术说明`, err);
      return new Map();
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
