const FENCE = /^\s*```/;

/**
 * 把较长的 Markdown 按行切成不超过 limit 字的片段，逐条发送。
 * 切点落在代码块内部时，先补上结束标记，下一片再重新打开，保证每片单独渲染都正确。
 * 单行超过 limit 时按字符硬切。
 */
export function splitMarkdown(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let buf: string[] = [];
  let size = 0;
  let openFence: string | null = null;

  const flush = () => {
    const body = buf.join("\n");
    chunks.push(openFence === null ? body : `${body}\n\`\`\``);
    buf = openFence === null ? [] : [openFence];
    size = openFence === null ? 0 : openFence.length;
  };

  for (const line of text.split("\n")) {
    for (const piece of chop(line, limit)) {
      const onlyReopenedFence = openFence !== null && buf.length === 1;
      if (buf.length > 0 && !onlyReopenedFence && size + 1 + piece.length > limit) {
        flush();
      }
      size += (buf.length > 0 ? 1 : 0) + piece.length;
      buf.push(piece);
    }
    if (FENCE.test(line)) {
      openFence = openFence === null ? line.trim() : null;
    }
  }
  if (buf.length > 0) {
    chunks.push(buf.join("\n"));
  }
  return chunks.filter((chunk) => chunk.trim() !== "");
}

function chop(line: string, limit: number): string[] {
  if (line.length <= limit) {
    return [line];
  }
  // 按码点切，避免把 emoji 等代理对切成两半
  const chars = Array.from(line);
  const pieces: string[] = [];
  for (let i = 0; i < chars.length; i += limit) {
    pieces.push(chars.slice(i, i + limit).join(""));
  }
  return pieces;
}

/**
 * 代码块开头：3 个以上反引号或波浪号；反引号开头的后面不能再有反引号（```x``` 是行内代码）。
 * 前面的空白不限（列表里的代码块会缩进）：认错了也只是代码块里的 < 不转义，<at 在代码块里照样转义
 */
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})(.*?)\r?$/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?$/;

/** 按 CommonMark 的规则走一行：返回这一行之后还在不在代码块里（fence 是开头那串符号），以及这一行是不是代码块的开头或结尾 */
export function nextFence(fence: string | undefined, line: string): { fence: string | undefined; marker: boolean } {
  if (fence) {
    const close = FENCE_CLOSE.exec(line)?.[1];
    return close && close[0] === fence[0] && close.length >= fence.length ? { fence: undefined, marker: true } : { fence, marker: false };
  }
  const open = FENCE_OPEN.exec(line);
  if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
    return { fence: open[1], marker: true };
  }
  return { fence: undefined, marker: false };
}

/**
 * 卡片（JSON 2.0）的富文本里允许模型用的两种标签和颜色：<font color='red'>92%</font>、<text_tag color='red'>高风险</text_tag>。
 * 只认开头结尾在同一行、中间没有别的标签的；别的尖括号一律转义（工具结果里冒充的 <at id=all></at> 不能变成 @所有人）
 */
const RICH_COLORS: Record<string, ReadonlySet<string>> = {
  font: new Set(["red", "orange", "yellow", "green", "blue", "grey"]),
  text_tag: new Set(["red", "orange", "yellow", "green", "blue", "neutral"]),
};
/** 转义以后的标签：&lt;font color='red'>…&lt;/font> */
const ESCAPED_RICH_TAG = /&lt;(font|text_tag)\s+color\s*=\s*(['"]?)([a-z]+)\2\s*>((?:(?!&lt;).)*?)&lt;\/\1\s*>/gi;
/** 原样的标签，开头和结尾分开认：去掉标签只留文字时用 */
const RICH_TAG = /<\/?(?:font|text_tag)\b[^<>]*>/gi;

/**
 * 卡片里回答的一行（代码块外）：# ～ ### 的标题降成 ####（卡片里一级标题字太大），尖括号转义，
 * 再把允许的标签恢复回来（颜色统一写成单引号；颜色不在名单里的照样转义，显示成原文）
 */
export function richCardLine(line: string): string {
  return line
    .replace(/^( {0,3})#{1,3}(?=[ \t])/, "$1####")
    .replace(/</g, "&lt;")
    .replace(ESCAPED_RICH_TAG, (all, tag: string, _quote: string, color: string, inner: string) => {
      const name = tag.toLowerCase();
      const value = color.toLowerCase() === "gray" ? "grey" : color.toLowerCase();
      return RICH_COLORS[name].has(value) ? `<${name} color='${value}'>${inner}</${name}>` : all;
    });
}

/** 去掉 <font>、<text_tag> 标签，只留文字：检查回答里的路径、线上数据时按显示出来的文字看 */
export function stripRichTags(text: string): string {
  return text.replace(RICH_TAG, "");
}

/**
 * 卡片里的回答改成发普通消息（富文本 post）用：post 不认 <font>、<text_tag>，也不画表格。
 * 代码块外的标签去掉只留文字，表格改成列表，每行一条：「- **第一列**：表头 值；表头 值」
 */
export function toPostMarkdown(text: string): string {
  const out: string[] = [];
  let table: string[] = [];
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const inCode = fence !== undefined;
    const next = nextFence(fence, line);
    fence = next.fence;
    if (!inCode && !next.marker && TABLE_ROW.test(line)) {
      table.push(stripRichTags(line));
      continue;
    }
    out.push(...tableToList(table));
    table = [];
    out.push(inCode || next.marker ? line : stripRichTags(line));
  }
  out.push(...tableToList(table));
  return out.join("\n");
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;

/** 一段 | 开头结尾的行：第二行是 |---| 的才是表格，改成列表；不是的原样留着 */
function tableToList(rows: string[]): string[] {
  if (rows.length < 2 || !cellsOf(rows[1]).every((cell) => /^:?-+:?$/.test(cell))) {
    return rows;
  }
  const head = cellsOf(rows[0]);
  return rows.slice(2).map((row) => {
    const cells = cellsOf(row);
    const [first = "", ...rest] = cells;
    const pairs = rest.flatMap((cell, i) => (cell ? [head[i + 1] ? `${head[i + 1]} ${cell}` : cell] : []));
    return `- **${first}**${pairs.length > 0 ? `：${pairs.join("；")}` : ""}`;
  });
}

function cellsOf(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}
