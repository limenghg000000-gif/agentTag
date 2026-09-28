/**
 * 把飞书新版文档（docx）的块转成 Markdown 给模型读。
 * 块结构见飞书文档「数据结构概述」：页面块是根，其余块通过 children 挂在它下面；
 * 块的类型按块上有哪个字段来认（text、heading1、bullet……），不依赖 block_type 编号。
 */

/** 文档里的一个块，只列出用到的字段，其余按块类型放在同名字段里 */
export interface DocBlock {
  block_id: string;
  parent_id?: string;
  children?: string[];
  block_type: number;
  [field: string]: unknown;
}

interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  inline_code?: boolean;
  link?: { url?: string };
}

interface TextElement {
  text_run?: { content?: string; text_element_style?: TextStyle };
  mention_user?: { user_id?: string };
  mention_doc?: { title?: string; url?: string };
  equation?: { content?: string };
  reminder?: { expire_time?: string };
  file?: unknown;
  link_preview?: { url?: string; title?: string };
}

interface TextBody {
  style?: { done?: boolean; sequence?: string };
  elements?: TextElement[];
}

const HEADINGS = ["heading1", "heading2", "heading3", "heading4", "heading5", "heading6", "heading7", "heading8", "heading9"];
const LIST_KINDS = new Set(["bullet", "ordered", "todo"]);

/** 读不了内容、只能标个名字的块 */
const PLACEHOLDERS: Record<string, string> = {
  image: "[图片]",
  sheet: "[内嵌电子表格]",
  bitable: "[内嵌多维表格]",
  board: "[画板]",
  mindnote: "[思维导图]",
  diagram: "[流程图]",
  chat_card: "[群名片]",
  okr: "[OKR]",
  task: "[任务]",
  isv: "[第三方小组件]",
  jira_issue: "[Jira 问题]",
  sub_page_list: "[子页面目录]",
  wiki_catalog: "[知识库目录]",
  agenda: "[议程]",
};

/** 块的种类：按块上带的字段认 */
export function kindOf(block: DocBlock): string {
  if (block.block_type === 1 || block.page) {
    return "page";
  }
  for (const key of [
    "text", ...HEADINGS, "bullet", "ordered", "code", "quote", "todo", "callout", "divider", "table", "table_cell",
    "grid", "grid_column", "quote_container", "file", "iframe", "link_preview", ...Object.keys(PLACEHOLDERS),
  ]) {
    if (block[key] !== undefined) {
      return key;
    }
  }
  return "unknown";
}

export interface RenderOptions {
  /** 每块前标出块 id（改文档时要用） */
  withIds?: boolean;
}

export interface RenderedDocument {
  title: string;
  markdown: string;
}

/** 把整篇文档的块转成 Markdown。blocks 是「获取文档所有块」接口返回的全部块，顺序不限 */
export function renderDocument(blocks: readonly DocBlock[], options: RenderOptions = {}): RenderedDocument {
  const byId = new Map(blocks.map((block) => [block.block_id, block]));
  const page = blocks.find((block) => kindOf(block) === "page");
  if (!page) {
    return { title: "", markdown: "" };
  }
  const renderer = new Renderer(byId, options);
  const title = inline((page.page as TextBody | undefined)?.elements, true).trim();
  return { title, markdown: renderer.children(page.children).join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

class Renderer {
  constructor(
    private readonly byId: ReadonlyMap<string, DocBlock>,
    private readonly options: RenderOptions,
  ) {}

  /** 一组兄弟块：列表项之间不空行，其余块之间空一行 */
  children(ids: readonly string[] | undefined): string[] {
    const lines: string[] = [];
    let prevKind: string | undefined;
    let ordinal = 0;
    for (const id of ids ?? []) {
      const block = this.byId.get(id);
      if (!block) {
        continue;
      }
      const kind = kindOf(block);
      ordinal = kind === "ordered" ? (prevKind === "ordered" ? ordinal + 1 : startOf(block)) : 0;
      const rendered = this.block(block, kind, ordinal);
      if (rendered.length === 0) {
        continue;
      }
      if (prevKind !== undefined && !(LIST_KINDS.has(kind) && LIST_KINDS.has(prevKind))) {
        lines.push("");
      }
      if (this.options.withIds) {
        lines.push(`<!-- id:${block.block_id} -->`);
      }
      lines.push(...rendered);
      prevKind = kind;
    }
    return lines;
  }

  private block(block: DocBlock, kind: string, ordinal: number): string[] {
    const body = block[kind] as TextBody | undefined;
    const text = () => inline(body?.elements);
    const nested = (indent: string) => indentLines(this.children(block.children), indent);

    const heading = HEADINGS.indexOf(kind);
    if (heading >= 0) {
      return [`${"#".repeat(Math.min(heading + 1, 6))} ${text()}`, ...this.children(block.children)];
    }
    switch (kind) {
      case "text":
        return [...text().split("\n"), ...this.children(block.children)];
      case "bullet":
        return [`- ${text()}`, ...nested("  ")];
      case "ordered":
        return [`${ordinal}. ${text()}`, ...nested("   ")];
      case "todo":
        return [`- [${body?.style?.done ? "x" : " "}] ${text()}`, ...nested("  ")];
      case "code":
        return ["```", ...inline(body?.elements, true).replace(/\n$/, "").split("\n"), "```"];
      case "quote":
        return quoteLines([...text().split("\n"), ...this.children(block.children)]);
      case "callout":
      case "quote_container":
        return quoteLines(this.children(block.children));
      case "divider":
        return ["---"];
      case "table":
        return this.table(block);
      case "file":
        return [`[附件：${(block.file as { name?: string }).name ?? "未命名"}]`];
      case "iframe":
        return [link("内嵌网页", (block.iframe as { component?: { url?: string } }).component?.url)];
      case "link_preview": {
        const preview = block.link_preview as { url?: string; title?: string };
        return [link(preview.title || "链接", preview.url)];
      }
      case "grid":
      case "grid_column":
      case "table_cell":
      case "unknown":
        return this.children(block.children);
      default:
        return [PLACEHOLDERS[kind] ?? "[暂不支持读取的内容]"];
    }
  }

  /** 表格转成 Markdown 表格，单元格里的多段内容用 <br> 连起来 */
  private table(block: DocBlock): string[] {
    const table = block.table as { cells?: string[]; property?: { row_size?: number; column_size?: number } };
    const cells = table.cells ?? block.children ?? [];
    const columns = table.property?.column_size || 1;
    const rows: string[][] = [];
    for (let i = 0; i < cells.length; i += columns) {
      rows.push(
        cells.slice(i, i + columns).map((id) => {
          const cell = this.byId.get(id);
          const content = cell ? new Renderer(this.byId, {}).children(cell.children) : [];
          return content.filter((line) => line.trim()).join("<br>").replace(/\|/g, "\\|");
        }),
      );
    }
    if (rows.length === 0) {
      return [];
    }
    const row = (values: string[]) => `| ${values.join(" | ")} |`;
    return [row(rows[0]), row(rows[0].map(() => "---")), ...rows.slice(1).map(row)];
  }
}

function startOf(block: DocBlock): number {
  const sequence = Number((block.ordered as TextBody | undefined)?.style?.sequence);
  return Number.isInteger(sequence) && sequence > 0 ? sequence : 1;
}

function indentLines(lines: string[], indent: string): string[] {
  return lines.map((line) => (line ? indent + line : line));
}

function quoteLines(lines: string[]): string[] {
  return lines.map((line) => (line ? `> ${line}` : ">"));
}

/** 行内元素转成 Markdown。plain 为 true 时不加粗体、链接等标记（代码块、标题栏用） */
export function inline(elements: readonly TextElement[] | undefined, plain = false): string {
  return (elements ?? [])
    .map((el) => {
      if (el.text_run) {
        const content = el.text_run.content ?? "";
        return plain ? content : styled(content, el.text_run.text_element_style);
      }
      if (el.mention_user) {
        return "@某人";
      }
      if (el.mention_doc) {
        return plain ? el.mention_doc.title ?? "" : link(el.mention_doc.title || "文档", el.mention_doc.url);
      }
      if (el.equation) {
        return `$${(el.equation.content ?? "").trim()}$`;
      }
      if (el.reminder) {
        return `[提醒：${formatTime(el.reminder.expire_time)}]`;
      }
      if (el.link_preview) {
        return plain ? el.link_preview.title ?? "" : link(el.link_preview.title || "链接", el.link_preview.url);
      }
      if (el.file) {
        return "[附件]";
      }
      return "";
    })
    .join("");
}

function styled(content: string, style: TextStyle | undefined): string {
  if (!style || !content.trim()) {
    return content;
  }
  // 标记要贴着文字，首尾空白挪到标记外面，否则 Markdown 不认
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(content)!;
  let out = style.inline_code ? `\`${core}\`` : core;
  if (style.link?.url) {
    out = link(out, style.link.url);
  }
  if (style.bold) {
    out = `**${out}**`;
  }
  if (style.italic) {
    out = `*${out}*`;
  }
  if (style.strikethrough) {
    out = `~~${out}~~`;
  }
  return lead + out + trail;
}

/** 文档里的链接是 URL 编码过的（https%3A%2F%2F…），先解开 */
function link(label: string, url: string | undefined): string {
  if (!url) {
    return label;
  }
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // 编码不完整时原样用
  }
  return `[${label}](${decoded})`;
}

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatTime(ms: string | undefined): string {
  const time = Number(ms);
  return Number.isFinite(time) && time > 0 ? TIME_FORMAT.format(new Date(time)) : "未知时间";
}
