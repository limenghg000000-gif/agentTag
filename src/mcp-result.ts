import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** 单个 MCP 工具结果交给模型前的字数上限 */
export const MCP_RESULT_LIMIT = 24_000;

/** 顶层有这些字段就挪到最前，结论和提示先给模型看（比如诊断报告的 summary 原本在最后） */
const LEAD_KEYS = [
  "summary",
  "conclusion",
  "message",
  "error",
  "warning",
  "warnings",
  "hint",
  "hints",
  "notice",
  "note",
  "notes",
  "info",
  "resolved_namespace",
  "resolved_by",
];
/** 挪到最前的字段至少留这么多，别的字段截得再短也不低于它 */
const LEAD_LEVEL = { text: 3000, items: 30 };
/** 结果超长时按比例收紧：每个字符串最多留几个字、每个列表最多留几项，从最宽松到最紧 */
const LOOSEST = { text: 4000, items: 400 };
const TIGHTEST = { text: 60, items: 2 };

interface Level {
  text: number;
  items: number;
}

function levelAt(scale: number): Level {
  return {
    text: Math.max(TIGHTEST.text, Math.round(LOOSEST.text * scale)),
    items: Math.max(TIGHTEST.items, Math.round(LOOSEST.items * scale)),
  };
}

/**
 * 把一次 MCP 工具调用的结果整理成交给模型的文本。对任何 MCP 服务都适用，不认具体字段的含义：
 * JSON 去掉缩进，summary、warning、hint 这类字段挪到最前；还超长时按字段截短长字符串和长列表，省略处注明省略了多少；
 * 不是 JSON 的长文本保留开头和结尾。
 */
export function formatToolResult(result: CallToolResult, limit = MCP_RESULT_LIMIT): string {
  const parts = (result.content ?? []).map(describeContent).filter((part) => part.trim());
  if (parts.length === 0) {
    return result.structuredContent ? compactText(JSON.stringify(result.structuredContent), limit) : "（没有返回内容）";
  }
  if (parts.length === 1) {
    return compactText(parts[0], limit);
  }
  const share = Math.floor(limit / parts.length);
  return parts.map((part) => compactText(part, share)).join("\n\n");
}

/**
 * 结果里的全部文本，不截短（判断「服务繁忙」、报错、记日志、程序调用时用）。
 * 只放在 structuredContent 里、没有文字的（MCP 规范允许，报错的也可能这样）按 JSON 返回
 */
export function resultText(result: CallToolResult): string {
  const text = (result.content ?? []).map(describeContent).join("\n");
  return !text.trim() && result.structuredContent ? JSON.stringify(result.structuredContent) : text;
}

export function compactText(text: string, limit = MCP_RESULT_LIMIT): string {
  const trimmed = text.trim();
  const json = parseJson(trimmed);
  if (json === undefined) {
    return trimPlain(trimmed, limit);
  }
  const value = leadFirst(json);
  const flat = JSON.stringify(value);
  if (flat.length <= limit) {
    return flat;
  }
  const render = (level: Level) =>
    `（结果原本 ${trimmed.length} 字，超过 ${limit} 字，已按字段截短：长字符串只留前 ${level.text} 字，长列表只留前 ${level.items} 项，省略处有标注。` +
    `要看细节就缩小时间范围、加过滤条件或调小 limit 再查）\n${JSON.stringify(shrink(value, level, true))}`;
  // 找放得下的最宽松的一档：越宽松结果越长，二分查找
  let best = render(levelAt(1));
  if (best.length <= limit) {
    return best;
  }
  best = render(TIGHTEST);
  if (best.length > limit) {
    return trimPlain(flat, limit);
  }
  let [low, high] = [0, 1];
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2;
    const out = render(levelAt(mid));
    if (out.length <= limit) {
      [best, low] = [out, mid];
    } else {
      high = mid;
    }
  }
  return best;
}

function describeContent(item: CallToolResult["content"][number]): string {
  switch (item.type) {
    case "text":
      return item.text;
    case "image":
      return `[图片 ${item.mimeType}，没有展示]`;
    case "audio":
      return `[音频 ${item.mimeType}，没有展示]`;
    case "resource_link":
      return `[资源 ${item.name} ${item.uri}]`;
    case "resource":
      return "text" in item.resource && typeof item.resource.text === "string"
        ? item.resource.text
        : `[二进制资源 ${item.resource.uri}，没有展示]`;
    default:
      return "";
  }
}

function parseJson(text: string): unknown {
  if (!text.startsWith("{") && !text.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leadFirst(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value;
  }
  const lead = LEAD_KEYS.filter((key) => key in value);
  if (lead.length === 0) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of lead) {
    out[key] = value[key];
  }
  for (const [key, item] of Object.entries(value)) {
    if (!(key in out)) {
      out[key] = item;
    }
  }
  return out;
}

function shrink(value: unknown, level: Level, top = false): unknown {
  if (typeof value === "string") {
    return value.length > level.text ? `${cut(value, level.text)}…（省略 ${value.length - level.text} 字）` : value;
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, level.items).map((item) => shrink(item, level));
    return value.length > level.items ? [...kept, `…（省略后面 ${value.length - level.items} 项，共 ${value.length} 项）`] : kept;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const lead = top && LEAD_KEYS.includes(key);
      out[key] = shrink(item, lead ? { text: Math.max(level.text, LEAD_LEVEL.text), items: Math.max(level.items, LEAD_LEVEL.items) } : level);
    }
    return out;
  }
  return value;
}

/** 不是 JSON 的长文本：保留开头七成、结尾三成（有的结论写在最后） */
function trimPlain(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  // 留 80 字给中间的省略说明
  const room = Math.max(0, limit - 80);
  const head = cut(text, Math.floor(room * 0.7));
  const tail = text.slice(text.length - Math.floor(room * 0.3)).replace(/^[\udc00-\udfff]/, "");
  const omitted = text.length - head.length - tail.length;
  return `${head}\n…（中间省略 ${omitted} 字，结果超过 ${limit} 字。要看细节就缩小范围再查）…\n${tail}`;
}

/** 截前 n 个字，不把代理对（emoji 等）切成两半 */
function cut(text: string, n: number): string {
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}
