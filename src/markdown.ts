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
