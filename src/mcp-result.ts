import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * 单个 MCP 工具结果交给模型前的字数上限。原先是 2.4 万字：2026-10-10 转链排查时 aiops 的 query_logs 返回 50 条日志（每条都带一遍 labels），
 * 截到只剩最新一秒的 12 条，模型照着这 12 条就下了结论；同样的查询 Open WebUI 原样交给模型。现在每项都一样的字段只写一次，上限也放宽
 */
export const MCP_RESULT_LIMIT = 60_000;

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

/** 列表里至少有几项才把每项都一样的字段提出来 */
const HOIST_MIN_ITEMS = 3;
/** 提出来的字段 JSON 至少这么长才提，短的不值得改结构 */
const HOIST_MIN_CHARS = 24;
/** 提出来的字段放在列表前面，键名是列表的键名加上这个后缀 */
export const COMMON_SUFFIX = "（每项都有的字段）";

/**
 * 把一次 MCP 工具调用的结果整理成交给模型的文本。对任何 MCP 服务都适用，不认具体字段的含义：
 * JSON 去掉缩进，summary、warning、hint 这类字段挪到最前；对象列表里每一项都一样的字段只写一次（不丢信息）；
 * 还超长时按字段截短长字符串和长列表，省略处注明省略了多少；不是 JSON 的长文本保留开头和结尾。
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

/** 结果里的全部文本，不截短（判断「服务繁忙」、记日志用） */
export function resultText(result: CallToolResult): string {
  return (result.content ?? []).map(describeContent).join("\n");
}

export function compactText(text: string, limit = MCP_RESULT_LIMIT): string {
  const trimmed = text.trim();
  const json = parseJson(trimmed);
  if (json === undefined) {
    return trimPlain(trimmed, limit);
  }
  const value = hoistCommon(leadFirst(json));
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

/**
 * 重新拼对象用没有原型的空对象：结果里可能有 __proto__、toString 这类键名，
 * 赋给普通对象会被当成原型、用 in 判断时会被继承来的属性冒充，都会丢字段
 */
function record(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function leadFirst(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value;
  }
  const lead = LEAD_KEYS.filter((key) => Object.hasOwn(value, key));
  if (lead.length === 0) {
    return value;
  }
  const out = record();
  for (const key of lead) {
    out[key] = value[key];
  }
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(out, key)) {
      out[key] = item;
    }
  }
  return out;
}

/**
 * 对象列表里每一项都一样的字段提到列表前面，只写一次：键名是「列表名（每项都有的字段）」，各项里去掉这些字段。
 * 值是对象的字段（比如 query_logs 每条日志都带一遍的 labels）只提各项都一样的那部分键，剩下不一样的（pod）留在各项里。
 * 只处理对象里的列表（要有键名放提出来的字段），列表里的值先递归处理
 */
function hoistCommon(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(hoistCommon);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out = record();
  for (const [key, item] of Object.entries(value)) {
    const inner = hoistCommon(item);
    const split = Array.isArray(inner) ? splitCommon(inner) : undefined;
    if (split && !Object.hasOwn(value, `${key}${COMMON_SUFFIX}`)) {
      out[`${key}${COMMON_SUFFIX}`] = split.common;
      out[key] = split.items;
    } else {
      out[key] = inner;
    }
  }
  return out;
}

function splitCommon(list: unknown[]): { common: Record<string, unknown>; items: Record<string, unknown>[] } | undefined {
  if (list.length < HOIST_MIN_ITEMS || !list.every(isPlainObject)) {
    return undefined;
  }
  const items = list as Record<string, unknown>[];
  const [first, ...rest] = items;
  const common = record();
  const sub = new Map<string, string[]>();
  const own = (item: Record<string, unknown>, key: string) => (Object.hasOwn(item, key) ? item[key] : undefined);
  for (const [field, sample] of Object.entries(first)) {
    const flat = JSON.stringify(sample);
    if (rest.every((item) => Object.hasOwn(item, field) && JSON.stringify(item[field]) === flat)) {
      common[field] = sample;
      continue;
    }
    if (isPlainObject(sample) && rest.every((item) => isPlainObject(own(item, field)))) {
      const keys = Object.entries(sample)
        .filter(([key, v]) =>
          rest.every((item) => {
            const inner = item[field] as Record<string, unknown>;
            return Object.hasOwn(inner, key) && JSON.stringify(inner[key]) === JSON.stringify(v);
          }),
        )
        .map(([key]) => key);
      if (keys.length > 0) {
        const part = record();
        for (const key of keys) {
          part[key] = sample[key];
        }
        common[field] = part;
        sub.set(field, keys);
      }
    }
  }
  if (Object.keys(common).length === 0 || JSON.stringify(common).length < HOIST_MIN_CHARS) {
    return undefined;
  }
  const strip = (item: Record<string, unknown>) => {
    const kept = record();
    for (const [field, v] of Object.entries(item)) {
      const keys = sub.get(field);
      if (Object.hasOwn(common, field) && !keys) {
        continue;
      }
      if (keys && isPlainObject(v)) {
        const left = record();
        for (const [key, inner] of Object.entries(v)) {
          if (!keys.includes(key)) {
            left[key] = inner;
          }
        }
        if (Object.keys(left).length > 0) {
          kept[field] = left;
        }
        continue;
      }
      kept[field] = v;
    }
    return kept;
  };
  return { common, items: items.map(strip) };
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
    const out = record();
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
