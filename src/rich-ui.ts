import { nextFence } from "./markdown.js";

/**
 * 卡片里的图表和关键数字：模型在回答里写 ```chart、```kpi 代码块（内容是 JSON），回答写完以后换成飞书卡片的图表组件和一排数字小卡片。
 * 图和数字里的每个数都要在这次工具查到的结果里找得到（按写出来的精度四舍五入，允许百分比、字节和核数的换算），
 * 对不上的图不画、对不上的数字卡片不放，免得把编出来的数画成图
 */

export interface ChartBlock {
  kind: "chart";
  type: "line" | "bar" | "pie";
  title: string;
  unit?: string;
  /** 横轴（饼图是各块的名字） */
  x: string[];
  series: { name: string; data: number[] }[];
}

export interface KpiItem {
  label: string;
  value: string;
  level?: "danger" | "warn" | "ok";
}

export interface KpiBlock {
  kind: "kpi";
  items: KpiItem[];
}

export type AnswerSegment = { kind: "markdown"; text: string } | ChartBlock | KpiBlock;

/** 一次回答最多几张图、几个数字卡片，每张图最多几条线、几个点（卡片最大 30 KB，图的数据占地方） */
export const MAX_CHARTS = 3;
const MAX_SERIES = 8;
const MAX_POINTS_PER_CHART = 200;
const MAX_KPIS = 4;
const MAX_LABEL_CHARS = 40;

const UI_LANGS = new Set(["chart", "kpi"]);

/** 代码块开头那一行写的语言：```chart → chart */
function langOf(line: string): string {
  return line.trim().replace(/^(`{3,}|~{3,})/, "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/**
 * 把回答拆成几段：普通的 Markdown 和 ```chart、```kpi 块。块里的 JSON 不对、格式不对的不要（记在 invalid 里），
 * 没写完的块（回答被截断）也不要
 */
export function splitAnswer(text: string): { segments: AnswerSegment[]; invalid: string[] } {
  const segments: AnswerSegment[] = [];
  const invalid: string[] = [];
  let markdown: string[] = [];
  let block: { lang: string; lines: string[] } | undefined;
  let fence: string | undefined;
  const flushMarkdown = () => {
    const joined = markdown.join("\n");
    if (joined.trim()) {
      segments.push({ kind: "markdown", text: joined.replace(/^\n+|\n+$/g, "") });
    }
    markdown = [];
  };
  for (const line of text.split("\n")) {
    const inCode = fence !== undefined;
    const next = nextFence(fence, line);
    fence = next.fence;
    if (block) {
      if (next.marker && !next.fence) {
        const parsed = parseBlock(block.lang, block.lines.join("\n"));
        if (parsed) {
          flushMarkdown();
          segments.push(parsed);
        } else {
          invalid.push(block.lang);
        }
        block = undefined;
      } else {
        block.lines.push(line);
      }
      continue;
    }
    if (!inCode && next.marker && UI_LANGS.has(langOf(line))) {
      block = { lang: langOf(line), lines: [] };
      continue;
    }
    markdown.push(line);
  }
  if (block) {
    invalid.push(block.lang);
  }
  flushMarkdown();
  return { segments, invalid };
}

/** 生成中的回答：图和数字卡片的代码块（写完的、没写完的）换成一行说明，不把 JSON 显示出来 */
export function streamingAnswer(text: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  let hidden = false;
  for (const line of text.split("\n")) {
    const inCode = fence !== undefined;
    const next = nextFence(fence, line);
    fence = next.fence;
    if (hidden) {
      hidden = !(next.marker && !next.fence);
      continue;
    }
    if (!inCode && next.marker && UI_LANGS.has(langOf(line))) {
      out.push(langOf(line) === "chart" ? "📊 图表画好后显示在这里…" : "📌 关键数字整理好后显示在这里…");
      hidden = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function parseBlock(lang: string, body: string): ChartBlock | KpiBlock | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  return lang === "chart" ? parseChart(json) : parseKpi(json);
}

function text(value: unknown, max = MAX_LABEL_CHARS): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const chars = Array.from(value.trim());
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

function parseChart(json: unknown): ChartBlock | undefined {
  if (!json || typeof json !== "object") {
    return undefined;
  }
  const raw = json as Record<string, unknown>;
  const type = raw.type === "line" || raw.type === "bar" || raw.type === "pie" ? raw.type : undefined;
  const title = text(raw.title, 60);
  if (!type || !title || !Array.isArray(raw.x) || !Array.isArray(raw.series)) {
    return undefined;
  }
  const x = raw.x.map((label) => text(label));
  if (x.length === 0 || x.some((label) => label === undefined)) {
    return undefined;
  }
  const series: ChartBlock["series"] = [];
  for (const item of raw.series) {
    if (!item || typeof item !== "object") {
      return undefined;
    }
    const { name, data } = item as Record<string, unknown>;
    const label = text(name) ?? (raw.series.length === 1 ? title : undefined);
    if (!label || !Array.isArray(data) || data.length !== x.length || !data.every((n) => typeof n === "number" && Number.isFinite(n))) {
      return undefined;
    }
    series.push({ name: label, data: data as number[] });
  }
  if (series.length === 0 || series.length > MAX_SERIES || series.length * x.length > MAX_POINTS_PER_CHART || (type === "pie" && series.length !== 1)) {
    return undefined;
  }
  const unit = text(raw.unit, 12);
  return { kind: "chart", type, title, ...(unit ? { unit } : {}), x: x as string[], series };
}

function parseKpi(json: unknown): KpiBlock | undefined {
  if (!Array.isArray(json) || json.length === 0) {
    return undefined;
  }
  const items: KpiItem[] = [];
  for (const item of json.slice(0, MAX_KPIS)) {
    if (!item || typeof item !== "object") {
      return undefined;
    }
    const raw = item as Record<string, unknown>;
    const label = text(raw.label, 20);
    const value = text(raw.value, 16);
    if (!label || !value) {
      return undefined;
    }
    const level = raw.level === "danger" || raw.level === "warn" || raw.level === "ok" ? raw.level : undefined;
    items.push({ label, value, ...(level ? { level } : {}) });
  }
  return { kind: "kpi", items };
}

/**
 * 工具结果里的数，加上常见的换算（比例 ×100 成百分比；字节换成 KiB、MiB、GiB、KB、MB、GB；核换成毫核、毫核换成核），排好序，按区间查
 */
export class NumberEvidence {
  private readonly values: Float64Array;

  constructor(outputs: readonly string[]) {
    const factors = [1, 100, 1 / 1024, 1 / 1024 ** 2, 1 / 1024 ** 3, 1e-3, 1e-6, 1e-9, 1000];
    const found: number[] = [];
    for (const output of outputs) {
      for (const match of output.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)) {
        const n = Number(match[0]);
        if (Number.isFinite(n)) {
          for (const factor of factors) {
            found.push(n * factor);
          }
        }
      }
    }
    this.values = Float64Array.from(found).sort();
  }

  /** v 是不是哪个查到的数按 v 写出来的精度四舍五入的结果（v 写成 41.2 就看有没有 41.15 到 41.25 之间的数） */
  has(v: number): boolean {
    const digits = decimalsOf(v);
    const half = 0.5 * 10 ** -digits;
    // 浮点误差：0.4123 × 100 不一定正好是 41.23
    const lo = v - half - 1e-9 * Math.max(1, Math.abs(v));
    const hi = v + half + 1e-9 * Math.max(1, Math.abs(v));
    let left = 0;
    let right = this.values.length;
    while (left < right) {
      const mid = (left + right) >> 1;
      if (this.values[mid] < lo) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    return left < this.values.length && this.values[left] <= hi;
  }
}

function decimalsOf(v: number): number {
  const [, fraction = ""] = String(v).split(".");
  return Math.min(fraction.length, 6);
}

/** 数字卡片的值里写的数：「41%」「1.2 GiB」「0 次」 */
function numbersIn(value: string): number[] {
  return [...value.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

/**
 * 只留下数都查得到的图和数字卡片。dropped 记下去掉了什么，写日志用。
 * 图里的数全都要对得上，对不上的图换成一句说明；数字卡片一个个看，对不上的去掉，值里没有数的（「正常」）照留
 */
export function keepVerified(segments: AnswerSegment[], evidence: NumberEvidence): { segments: AnswerSegment[]; dropped: string[] } {
  const dropped: string[] = [];
  const kept: AnswerSegment[] = [];
  let charts = 0;
  for (const segment of segments) {
    if (segment.kind === "chart") {
      const missing = segment.series.flatMap((s) => s.data).filter((n) => !evidence.has(n));
      if (missing.length > 0) {
        dropped.push(`图「${segment.title}」有 ${missing.length} 个数在查询结果里找不到（如 ${missing.slice(0, 3).join("、")}）`);
        kept.push({ kind: "markdown", text: `📊 图「${segment.title}」里有数和这次查到的结果对不上，没画出来。` });
        continue;
      }
      if (++charts > MAX_CHARTS) {
        dropped.push(`图「${segment.title}」超过 ${MAX_CHARTS} 张`);
        continue;
      }
    } else if (segment.kind === "kpi") {
      const items = segment.items.filter((item) => {
        const ok = numbersIn(item.value).every((n) => evidence.has(n));
        if (!ok) {
          dropped.push(`数字卡片「${item.label} ${item.value}」在查询结果里找不到`);
        }
        return ok;
      });
      if (items.length === 0) {
        continue;
      }
      kept.push({ kind: "kpi", items });
      continue;
    }
    kept.push(segment);
  }
  return { segments: kept, dropped };
}

const LEVEL_COLOR: Record<NonNullable<KpiItem["level"]>, string> = { danger: "red", warn: "orange", ok: "green" };

/** 卡片里的组件：markdown 段交给 renderMarkdown（转义、限长），图换成图表组件，数字卡片换成一排分栏 */
export function segmentElements(segments: AnswerSegment[], renderMarkdown: (text: string) => object): object[] {
  return segments.map((segment) => {
    if (segment.kind === "markdown") {
      return renderMarkdown(segment.text);
    }
    if (segment.kind === "kpi") {
      return kpiElement(segment);
    }
    return chartElement(segment);
  });
}

/** 数字卡片里的文字：模型写的，转义尖括号，去掉会被当成 Markdown 的符号 */
function plain(value: string): string {
  return value.replace(/</g, "&lt;").replace(/[*_~`[\]]/g, "");
}

function kpiElement({ items }: KpiBlock): object {
  return {
    tag: "column_set",
    flex_mode: "bisect",
    horizontal_spacing: "8px",
    columns: items.map((item) => {
      const value = `**${plain(item.value)}**`;
      return {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_spacing: "2px",
        elements: [
          { tag: "markdown", text_align: "center", text_size: "heading", content: item.level ? `<font color='${LEVEL_COLOR[item.level]}'>${value}</font>` : value },
          { tag: "markdown", text_align: "center", text_size: "notation", content: plain(item.label) },
        ],
      };
    }),
  };
}

function chartElement(chart: ChartBlock): object {
  const title = chart.unit ? `${chart.title}（${chart.unit}）` : chart.title;
  if (chart.type === "pie") {
    return {
      tag: "chart",
      aspect_ratio: "4:3",
      chart_spec: {
        type: "pie",
        title: { text: title },
        data: { values: chart.x.map((name, i) => ({ name, value: chart.series[0].data[i] })) },
        categoryField: "name",
        valueField: "value",
        outerRadius: 0.8,
        label: { visible: true },
        legends: { visible: true, orient: "bottom" },
      },
    };
  }
  const values = chart.series.flatMap((s) => s.data.map((value, i) => ({ x: chart.x[i], value, series: s.name })));
  return {
    tag: "chart",
    aspect_ratio: "16:9",
    chart_spec: {
      type: chart.type,
      title: { text: title },
      data: { values },
      // 柱状图几组并排：横轴按「横轴值 + 系列」分组
      xField: chart.type === "bar" && chart.series.length > 1 ? ["x", "series"] : "x",
      yField: "value",
      seriesField: "series",
      legends: { visible: chart.series.length > 1, orient: "bottom" },
    },
  };
}

/** 发普通消息、卡片放不下图、或者带图的卡片发不出去时：图换成一句说明，数字卡片换成一行 */
export function segmentsAsText(segments: AnswerSegment[]): string {
  return segments
    .map((segment) => {
      if (segment.kind === "markdown") {
        return segment.text;
      }
      if (segment.kind === "kpi") {
        return segment.items.map((item) => `**${plain(item.label)}** ${plain(item.value)}`).join(" · ");
      }
      return `📊 ${segment.title}（这里显示不了图）`;
    })
    .join("\n\n");
}

/** 回答里有没有要画成组件的块 */
export function hasUiBlocks(segments: AnswerSegment[]): boolean {
  return segments.some((segment) => segment.kind !== "markdown");
}
