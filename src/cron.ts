/**
 * 定时任务的时间：5 段 cron（分 时 日 月 星期）和一次性的「2026-10-22 15:00」，都按北京时间算。
 * 北京时间是 UTC+8、没有夏令时，墙上时间加减 8 小时就是 UTC，不用查时区表
 */

const OFFSET_MS = 8 * 60 * 60_000;
const MINUTE_MS = 60_000;
/** 往后最多找多久：2 月 29 号这种几年才有一次的，两年内碰不到就算没有 */
const HORIZON_DAYS = 366 * 2;

export interface Cron {
  /** 原文（空白规整过） */
  expr: string;
  /** 从小到大 */
  minutes: number[];
  hours: number[];
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 是周日 */
  weekdays: ReadonlySet<number>;
  /** 几号写的是 * */
  anyDay: boolean;
  /** 星期写的是 * */
  anyWeekday: boolean;
}

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKDAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"];

/** 解析 5 段 cron，写错了抛错，错误信息是一句给模型看的中文 */
export function parseCron(text: string): Cron {
  const expr = text.trim().replace(/\s+/g, " ");
  const fields = expr.split(" ");
  if (fields.length !== 5) {
    throw new Error(`cron 要写 5 段（分 时 日 月 星期，用空格隔开），比如每周一 9 点是「0 9 * * 1」，现在是「${expr}」`);
  }
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const weekdays = parseField(weekday, 0, 7, "星期", WEEKDAY_NAMES);
  // 星期里 7 和 0 都是周日
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return {
    expr,
    minutes: [...parseField(minute, 0, 59, "分")].sort((a, b) => a - b),
    hours: [...parseField(hour, 0, 23, "时")].sort((a, b) => a - b),
    days: parseField(day, 1, 31, "日"),
    months: parseField(month, 1, 12, "月", MONTH_NAMES),
    weekdays,
    anyDay: day === "*" || day === "?",
    anyWeekday: weekday === "*" || weekday === "?",
  };
}

/** 一段：*、5、1-5、*\/15、1-30/2、1,15，星期和月份也认 MON、JAN 这类英文缩写 */
function parseField(text: string, min: number, max: number, name: string, names?: readonly string[]): Set<number> {
  const values = new Set<number>();
  const value = (raw: string): number => {
    const index = names?.indexOf(raw.toUpperCase()) ?? -1;
    const n = index >= 0 ? index + (min === 1 ? 1 : 0) : /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(`cron 的「${name}」那段只能写 ${min}～${max}，「${raw}」不对`);
    }
    return n;
  };
  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || (stepText !== undefined && !/^\d+$/.test(stepText))) {
      throw new Error(`cron 的「${name}」那段「${part}」写错了：/ 后面要写正整数`);
    }
    let from: number;
    let to: number;
    if (range === "*" || range === "?") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [a = "", b = ""] = range.split("-");
      from = value(a);
      to = value(b);
      if (from > to) {
        throw new Error(`cron 的「${name}」那段「${part}」写反了：前面的要比后面的小`);
      }
    } else {
      from = value(range);
      // 「5/10」是从 5 起每 10 个
      to = stepText === undefined ? from : max;
    }
    for (let n = from; n <= to; n += step) {
      values.add(n);
    }
  }
  return values;
}

/** 这一天（北京时间的日期，按 UTC 存）合不合：几号和星期都限定了时，按 cron 的老规矩满足一样就算 */
function dayMatches(cron: Cron, date: Date): boolean {
  if (!cron.months.has(date.getUTCMonth() + 1)) {
    return false;
  }
  const day = cron.days.has(date.getUTCDate());
  const weekday = cron.weekdays.has(date.getUTCDay());
  if (cron.anyDay && cron.anyWeekday) {
    return true;
  }
  if (cron.anyDay) {
    return weekday;
  }
  if (cron.anyWeekday) {
    return day;
  }
  return day || weekday;
}

/** after 之后（不含）下一次的时间，两年内都没有时返回 undefined */
export function nextRun(cron: Cron, after: number): number | undefined {
  // 北京时间的墙上时间当成 UTC 来算，从 after 的下一分钟开始找
  let local = Math.floor((after + OFFSET_MS) / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const date = new Date(local);
    if (dayMatches(cron, date)) {
      const hour = date.getUTCHours();
      const minute = date.getUTCMinutes();
      for (const h of cron.hours) {
        if (h < hour) {
          continue;
        }
        const m = cron.minutes.find((m) => h > hour || m >= minute);
        if (m !== undefined) {
          return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, m) - OFFSET_MS;
        }
      }
    }
    local = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  }
  return undefined;
}

/** 从 after 起往后最多 count 次的时间（两年内） */
export function upcomingRuns(cron: Cron, after: number, count: number): number[] {
  const runs: number[] = [];
  let t: number | undefined = after;
  while (runs.length < count && (t = nextRun(cron, t)) !== undefined) {
    runs.push(t);
  }
  return runs;
}

/** 相邻两次最短隔几分钟（只看往后几十次，够认出「每 30 分钟」「9 点和 9 点半」这类）；只有一次时是 Infinity */
export function shortestGapMinutes(cron: Cron, after: number): number {
  const runs = upcomingRuns(cron, after, 60);
  let gap = Infinity;
  for (let i = 1; i < runs.length; i++) {
    gap = Math.min(gap, (runs[i]! - runs[i - 1]!) / MINUTE_MS);
  }
  return gap;
}

/** 往后 7 天里跑几次（估每天跑几次用） */
export function runsInWeek(cron: Cron, after: number): number {
  const end = after + 7 * 24 * 60 * MINUTE_MS;
  return upcomingRuns(cron, after, 7 * 24 * 60).filter((t) => t <= end).length;
}

/**
 * 一次性的时间：北京时间「2026-10-22 15:00」，也认「2026/10/22 15:00」「2026-10-22T15:00」和带秒的。
 * 写错了、日期不存在（2 月 30 号）时抛错，错误信息是一句给模型看的中文
 */
export function parseAt(text: string): number {
  const match = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[\sT]+(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?)?\s*$/.exec(text);
  if (!match) {
    throw new Error(`一次性的时间要写成北京时间「2026-10-22 15:00」这样，现在是「${text}」`);
  }
  const [, y, mo, d, h = "9", mi = "0"] = match;
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  const date = new Date(local);
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(mo) - 1 ||
    date.getUTCDate() !== Number(d) ||
    date.getUTCHours() !== Number(h) ||
    date.getUTCMinutes() !== Number(mi)
  ) {
    throw new Error(`「${text}」这个时间不存在`);
  }
  return local - OFFSET_MS;
}

/** 北京时间「10-27（周一）09:00」，不是今年的带上年份 */
export function formatTime(ms: number, now = Date.now()): string {
  const date = new Date(ms + OFFSET_MS);
  const year = date.getUTCFullYear();
  const day = `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const sameYear = new Date(now + OFFSET_MS).getUTCFullYear() === year;
  return `${sameYear ? "" : `${year}-`}${day}（周${WEEKDAY_CN[date.getUTCDay()]}）${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** 用大白话说 cron：「每周一 09:00」「工作日 10:30」「每天 09:00、18:00」「每 2 小时（整点）」。说不清的写原文 */
export function describeCron(cron: Cron): string {
  const everyMonth = cron.months.size === 12;
  const days = cron.anyDay && cron.anyWeekday
    ? "每天"
    : cron.anyDay
      ? describeWeekdays(cron.weekdays)
      : cron.anyWeekday
        ? `每月 ${[...cron.days].sort((a, b) => a - b).map((d) => `${d} 号`).join("、")}`
        : undefined;
  const times = describeTimes(cron);
  if (!days || !times || !everyMonth) {
    return `cron「${cron.expr}」`;
  }
  // 「每天 每小时 05 分」只说后半句
  return days === "每天" && times.startsWith("每") ? times : `${days} ${times}`;
}

function describeWeekdays(weekdays: ReadonlySet<number>): string {
  const sorted = [1, 2, 3, 4, 5, 6, 0].filter((d) => weekdays.has(d));
  if (sorted.length === 5 && sorted.every((d) => d >= 1 && d <= 5)) {
    return "工作日（周一到周五）";
  }
  if (sorted.length === 2 && weekdays.has(0) && weekdays.has(6)) {
    return "每周末";
  }
  return `每周${sorted.map((d) => WEEKDAY_CN[d]).join("、")}`;
}

function describeTimes(cron: Cron): string | undefined {
  if (cron.hours.length === 24 && cron.minutes.length === 1) {
    return `每小时 ${pad(cron.minutes[0]!)} 分`;
  }
  const step = evenStep(cron.hours);
  if (step && step > 1 && cron.minutes.length === 1 && cron.hours[0]! < step) {
    return `每 ${step} 小时（${cron.hours.map((h) => `${pad(h)}:${pad(cron.minutes[0]!)}`).slice(0, 3).join("、")}…）`;
  }
  const count = cron.hours.length * cron.minutes.length;
  if (count > 6) {
    return undefined;
  }
  return cron.hours.flatMap((h) => cron.minutes.map((m) => `${pad(h)}:${pad(m)}`)).join("、");
}

/** 0、2、4…22 这种一整天等间隔的，返回间隔 */
function evenStep(hours: readonly number[]): number | undefined {
  if (hours.length < 3) {
    return undefined;
  }
  const step = hours[1]! - hours[0]!;
  const even = hours.every((h, i) => i === 0 || h - hours[i - 1]! === step);
  return even && hours.at(-1)! + step > 23 ? step : undefined;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
