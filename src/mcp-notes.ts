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
  // 减半丢掉的条数：时间不知道，和去掉的空行一样，判断边界会不会卡住时按最坏情况算
  const dropped = halved ? original - kept : 0;
  const full = kept + dropped + skipped >= limit;
  if (!full && !halved) {
    return undefined;
  }

  const forward = String(args.direction ?? "").toLowerCase() === "forward";
  const which = forward ? "最早" : "最新";
  const reasons = [
    ...(full ? [`Loki 按 limit=${limit} 取满了${skipped > 0 ? `（其中 ${skipped} 条空行被 aiops 去掉了）` : ""}`] : []),
    ...(halved ? [`结果超过 200KB，aiops 只留了 ${original} 条里的 ${kept} 条`] : []),
  ];
  const stamps = json.logs.map((log) => (isObject(log) ? toNs(log.timestamp) : undefined));
  const known = stamps.filter((ns): ns is bigint => ns !== undefined);
  const first = known.reduce<bigint | undefined>((min, ns) => (min === undefined || ns < min ? ns : min), undefined);
  const last = known.reduce<bigint | undefined>((max, ns) => (max === undefined || ns > max ? ns : max), undefined);
  const window =
    typeof json.query_start === "string" && typeof json.query_end === "string" ? `，查询窗口是 ${json.query_start}～${json.query_end}` : "";
  const span =
    first !== undefined && last !== undefined
      ? `这些日志在 ${formatTime(first)}～${formatTime(last)}（北京时间）${window}，${forward ? "更晚" : "更早"}的没取到。`
      : `${forward ? "更晚" : "更早"}的没取到。`;
  // 接着查的边界用 19 位纳秒（aiops 的入参认），不按秒取整：同一秒里常有几十条，取整会漏掉或者重复取回同一批。
  // 平常让边界多带回这批的头一条，宁可重复也不漏；时间只精确到秒时多留一秒。
  // 可边界上那一刻已经取回的条数（去掉的空行、减半丢掉的条数按最坏情况也算进去）占满 limit 时，带着边界再查还是同一批，
  // 只能跳过那一刻往前走（Loki 的 end 不含本身，填前 1 纳秒更稳），或者加过滤、拆开查
  const precise = json.logs.every((log) => isObject(log) && /^\d{19}$/.test(String(log.timestamp).trim()));
  const bump = precise ? 1n : 1_000_000_000n;
  const moment = precise ? "这一刻" : "这一秒";
  let next = "要看其余的，缩小时间范围或加级别、关键词过滤再查";
  if (first !== undefined && last !== undefined) {
    const later = forward ? "更晚" : "更早";
    const start = toNs(json.query_start_ns) ?? toNs(json.query_start);
    const end = toNs(json.query_end_ns) ?? toNs(json.query_end);
    const bounds = (from: bigint | undefined, to: bigint | undefined) =>
      `${from !== undefined ? `start_time 填 ${from}` : "start_time 不变"}、${to !== undefined ? `end_time 填 ${to}` : "end_time 不变"}（19 位纳秒）`;
    const edge = forward ? last : first;
    const atEdge = known.filter((ns) => (forward ? ns === last : ns < first + bump)).length;
    if (atEdge + skipped + dropped >= limit) {
      next =
        `这批里有 ${atEdge} 条都在 ${formatTime(edge)}${precise ? "" : " 这一秒"}，带着这个边界再查还会取回同一批。` +
        `要看${later}的，${forward ? bounds(last + bump, end) : bounds(start, first - 1n)}再查，${moment}没取到的会跳过；` +
        `要看全${moment}的，加级别、关键词过滤，或者按 pod 等标签拆开查${!halved && limit < LOGS_MAX_LIMIT ? `，或者把 limit 调到 ${LOGS_MAX_LIMIT}` : ""}`;
    } else {
      next =
        `要看${later}的，${forward ? bounds(last, end) : bounds(start, first + bump)}再查，会和这批有一点重叠，去掉重复的即可` +
        `${halved ? `，limit 填 ${kept}，免得结果再超过 200KB 被减半` : ""}；也可以加级别、关键词过滤缩小范围`;
    }
  }
  return (
    `（机器人注：这次只拿到${which}的 ${kept} 条日志：${reasons.join("；")}。${span}` +
    `只能说这一段里的情况，不能当成整段时间的条数、分布或趋势，也不能说${forward ? "更晚" : "更早"}没有。${next}）`
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
