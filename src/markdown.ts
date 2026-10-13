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
/**
 * 原样的标签，和 ESCAPED_RICH_TAG 认的一模一样（转义前 < 和原文里的 &lt; 都会变成 &lt;，所以中间两样都不能有）：
 * 去掉标签只留文字时用。写歪的标签卡片里照原文显示，这里也不能去掉，不然里面夹的路径、数字躲过检查
 */
const RAW_RICH_TAG = /<(font|text_tag)\s+color\s*=\s*(['"]?)([a-z]+)\2\s*>((?:(?!<|&lt;).)*?)<\/\1\s*>/gi;

/** 标签名和颜色在名单里时，返回统一写法的颜色（gray 写成 grey，灰色的 text_tag 写成 neutral）；不在名单里返回 undefined */
function richColor(tag: string, color: string): string | undefined {
  const name = tag.toLowerCase();
  const grey = color.toLowerCase() === "gray" ? "grey" : color.toLowerCase();
  const value = name === "text_tag" && grey === "grey" ? "neutral" : grey;
  return RICH_COLORS[name].has(value) ? value : undefined;
}

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
      const value = richColor(name, color);
      return value ? `<${name} color='${value}'>${inner}</${name}>` : all;
    });
}

/**
 * 去掉卡片会画出来的 <font>、<text_tag> 标签，只留文字：检查回答里的路径、线上数据时按显示出来的文字看。
 * 只去 richCardLine 会恢复的那种（同一行、颜色在名单里、中间没有别的标签），别的照原文留着
 */
export function stripRichTags(text: string): string {
  return text.replace(RAW_RICH_TAG, (all, tag: string, _quote: string, color: string, inner: string) =>
    richColor(tag, color) ? inner : all,
  );
}

/**
 * 卡片里的回答改成发普通消息（富文本 post）用：post 不认 <font>、<text_tag>，也不画表格。
 * 代码块外的标签去掉只留文字（行内代码里的不动），表格改成列表，每行一条：「- **第一列**：表头 值；表头 值」
 */
export function toPostMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inCode = fence !== undefined;
    const next = nextFence(fence, line);
    fence = next.fence;
    if (inCode || next.marker) {
      out.push(line);
      continue;
    }
    const delimiter = lines[i + 1];
    if (delimiter !== undefined && isTableStart(line, delimiter)) {
      const rows = [line, delimiter];
      let end = i + 2;
      while (end < lines.length && isTableBody(lines[end])) {
        rows.push(lines[end++]);
      }
      out.push(...tableToList(rows.map(stripOutsideInlineCode)));
      i = end - 1;
      continue;
    }
    out.push(stripOutsideInlineCode(line));
  }
  return out.join("\n");
}

const PIPE = /(?<!\\)\|/;
const DELIMITER_CELL = /^:?-+:?$/;

/** 表格的头两行：表头带 |，第二行是 |---|（两边的 | 可有可无，但至少有一个 |），两行格数一样 */
export function isTableStart(head: string, delimiter: string): boolean {
  if (!PIPE.test(head) || !PIPE.test(delimiter)) {
    return false;
  }
  const marks = cellsOf(delimiter);
  return marks.every((cell) => DELIMITER_CELL.test(cell)) && marks.length === cellsOf(head).length;
}

/** 表格往下的行：不是空行、带 |、不是代码块的开头 */
export function isTableBody(line: string): boolean {
  return line.trim() !== "" && PIPE.test(line) && !nextFence(undefined, line).marker;
}

/** 表头、|---|、各行 改成列表 */
function tableToList(rows: string[]): string[] {
  const head = cellsOf(rows[0]);
  return rows.slice(2).map((row) => {
    const cells = cellsOf(row);
    const [first = "", ...rest] = cells;
    const pairs = rest.flatMap((cell, i) => (cell ? [head[i + 1] ? `${head[i + 1]} ${cell}` : cell] : []));
    return `- **${first}**${pairs.length > 0 ? `：${pairs.join("；")}` : ""}`;
  });
}

/** 表格一行的各格（去掉两边的 |，\| 是格子里的竖线） */
export function cellsOf(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/** 一行里行内代码（`…`）先换成占位符再去标签，去完换回来：讲标签写法的例子原样留着 */
function stripOutsideInlineCode(line: string): string {
  if (!line.includes("`")) {
    return stripRichTags(line);
  }
  const spans: string[] = [];
  const masked = line.replace(/(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (span) => `\uE000${spans.push(span) - 1}\uE001`);
  return stripRichTags(masked).replace(/\uE000(\d+)\uE001/g, (all, index: string) => spans[Number(index)] ?? all);
}
