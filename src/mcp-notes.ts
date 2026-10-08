/**
 * 个别 MCP 工具结果的补充说明，排在结果前面交给模型：只写模型容易读错、程序又能算准的事实。
 * 按 MCP_SERVERS 里的服务名和服务端的工具名查。服务端以后自己在结果里写明了，就删掉对应的条目。
 */

/** args 是这次调用的参数，result 是工具返回的全部文本；没什么要补充的返回 undefined */
export type ResultNote = (args: Record<string, unknown>, result: string) => string | undefined;

/** aiops 的 query_logs 不传 limit 时取 50 条，最多 200 条 */
const LOGS_DEFAULT_LIMIT = 50;
const LOGS_MAX_LIMIT = 200;

const TIME_FORMAT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/**
 * aiops 的 query_logs：Loki 按 limit 取最新的若干条（direction=forward 时取最早的），aiops 再去掉空行、超过 200KB 时减半，
 * 结果里没说取到了上限。模型会把这一段当成整段时间：2026-10-08 复测时 27 条全在查询窗口的最后一秒，回答成「最近 1 小时 27 条」。
 * 取到上限时写明只拿到了哪一段。aiops 自己在结果里注明以后删掉。
 */
export function queryLogsNote(args: Record<string, unknown>, result: string): string | undefined {
  const json = parseObject(result);
  if (!json || !Array.isArray(json.logs)) {
    return undefined;
  }
  const kept = json.logs.length;
  const limit = logsLimit(args.limit);
  const skipped = count(json.skipped_empty);
  const original = count(json.original_total);
  const halved = original > kept;
  const full = (halved ? original : kept) + skipped >= limit;
  if (!full && !halved) {
    return undefined;
  }

  const forward = String(args.direction ?? "").toLowerCase() === "forward";
  const which = forward ? "最早" : "最新";
  const other = forward ? "更晚" : "更早";
  const reasons = [
    ...(full ? [`Loki 按 limit=${limit} 取满了${skipped > 0 ? `（其中 ${skipped} 条空行被 aiops 去掉了）` : ""}`] : []),
    ...(halved ? [`结果超过 200KB，aiops 只留了 ${original} 条里的 ${kept} 条`] : []),
  ];
  const stamps = json.logs
    .map((log) => (isObject(log) ? toNs(log.timestamp) : undefined))
    .filter((ns): ns is bigint => ns !== undefined);
  const first = stamps.reduce<bigint | undefined>((min, ns) => (min === undefined || ns < min ? ns : min), undefined);
  const last = stamps.reduce<bigint | undefined>((max, ns) => (max === undefined || ns > max ? ns : max), undefined);
  const window =
    typeof json.query_start === "string" && typeof json.query_end === "string" ? `，查询窗口是 ${json.query_start}～${json.query_end}` : "";
  const span =
    first !== undefined && last !== undefined
      ? `这些日志在 ${formatTime(first)}～${formatTime(last)}（北京时间）${window}，${other}的没取到。`
      : `${other}的没取到。`;
  // 不替模型算续查的时间边界：aiops 去掉的空行、减半丢掉的条数不知道时间，机器人自己还可能把列表截短，
  // 照这些算出来的边界会漏查或者原地打转。准确的续查信息该由 aiops 在结果里给
  return (
    `（机器人注：这次只拿到${which}的 ${kept} 条日志：${reasons.join("；")}。${span}` +
    `只能说这一段里的情况，不能当成整段时间的条数、分布或趋势，也不能说${other}没有。` +
    `要看${other}的，缩小时间范围分段查（同一秒里可能有很多条，分段的边界宁可重叠一点），或者加级别、关键词过滤，按 pod 拆开查` +
    `${halved ? "；这次结果超过 200KB 被减半过，再查时调小 limit" : ""}）`
  );
}

/** 按服务名、工具名查补充说明 */
export const RESULT_NOTES: Readonly<Record<string, Readonly<Record<string, ResultNote>>>> = {
  aiops: { query_logs: queryLogsNote },
};

function logsLimit(value: unknown): number {
  const limit = Math.trunc(Number(value));
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, LOGS_MAX_LIMIT) : LOGS_DEFAULT_LIMIT;
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 19 位纳秒（Loki 原样）、北京时间「2006-01-02 15:04:05」或带时区的 RFC3339，换成纳秒 */
function toNs(value: unknown): bigint | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const text = String(value).trim();
  if (/^\d{19}$/.test(text)) {
    return BigInt(text);
  }
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(text);
  const ms = Date.parse(local ? `${local[1]}T${local[2]}+08:00` : text);
  return Number.isFinite(ms) ? BigInt(ms) * 1_000_000n : undefined;
}

/** 北京时间，精确到毫秒 */
function formatTime(ns: bigint): string {
  const ms = Number(ns / 1_000_000n);
  return `${TIME_FORMAT.format(ms)}.${String(ms % 1000).padStart(3, "0")}`;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text.trim()) as unknown;
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
