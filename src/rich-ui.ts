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

/** 回答最后的「接着查」按钮：群成员接下来最可能问的几句话，点了就在话题里接着问 */
export interface ActionsBlock {
  kind: "actions";
  questions: string[];
}

export type AnswerSegment = { kind: "markdown"; text: string } | ChartBlock | KpiBlock | ActionsBlock;

/** 一次回答最多几张图、几个数字卡片，每张图最多几条线、几个点（卡片最大 30 KB，图的数据占地方） */
export const MAX_CHARTS = 3;
const MAX_SERIES = 8;
const MAX_POINTS_PER_CHART = 200;
const MAX_KPIS = 4;
export const MAX_ACTIONS = 3;
/** 按钮上的一句话最多几个字（飞书回调的 value 也有大小限制） */
export const MAX_ACTION_CHARS = 40;
const MAX_LABEL_CHARS = 40;

const UI_LANGS = new Set(["chart", "kpi", "actions"]);

/** 代码块开头那一行写的语言：```chart → chart */
function langOf(line: string): string {
  return line.trim().replace(/^(`{3,}|~{3,})/, "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** 图、数字卡片的代码块开头：缩进不超过 3 个空格（缩进 4 个是缩进代码块，讲写法的例子，不画） */
function uiLang(line: string): string | undefined {
  const lang = langOf(line);
  return /^ {0,3}(?:`{3,}|~{3,})/.test(line) && UI_LANGS.has(lang) ? lang : undefined;
}

/**
 * 把回答拆成几段：普通的 Markdown 和 ```chart、```kpi 块。块里的 JSON 不对、格式不对的不要（记在 invalid 里）。
 * 漏写了收尾 ``` 的块（模型忘了写，或者回答被截断）不能把后面的正文吞掉：见 blockEnd
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
  /** 块到头了（closing 是收尾那一行，没收尾的是 undefined）：返回块后面还要当正文接着拆的行 */
  const finish = (lang: string, body: string[], closing: string | undefined): string[] => {
    const whole = parseBlock(lang, body.join("\n"));
    const end = whole ? { parsed: whole, used: body.length } : blockEnd(lang, body);
    if (end.parsed) {
      flushMarkdown();
      segments.push(end.parsed);
    } else {
      invalid.push(lang);
    }
    const rest = body.slice(end.used);
    // 块在 used 那里就完了：收尾的 ``` 属于后面的正文（多半是后面别的代码块的收尾）
    return rest.length > 0 && closing !== undefined ? [...rest, closing] : rest;
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inCode = fence !== undefined;
    const next = nextFence(fence, line);
    fence = next.fence;
    if (block) {
      if (next.marker && !next.fence) {
        const rest = finish(block.lang, block.lines, line);
        block = undefined;
        if (rest.length > 0) {
          return joinSplits({ segments, invalid }, markdown, splitAnswer([...rest, ...lines.slice(i + 1)].join("\n")));
        }
      } else {
        block.lines.push(line);
      }
      continue;
    }
    const lang = !inCode && next.marker ? uiLang(line) : undefined;
    if (lang) {
      block = { lang, lines: [] };
      continue;
    }
    markdown.push(line);
  }
  if (block) {
    const rest = finish(block.lang, block.lines, undefined);
    if (rest.length > 0) {
      return joinSplits({ segments, invalid }, markdown, splitAnswer(rest.join("\n")));
    }
  }
  flushMarkdown();
  return { segments, invalid };
}

/**
 * 块里的内容不是一个完整的 JSON：多半是漏写了收尾，后面的正文、别的代码块被算进了块里。
 * 前几行能拼成完整的 JSON，块就到那里为止；拼不成（JSON 本身没写完、被截断）的，块到第一个空行为止。
 * used 是块用掉的行数，后面的行放回正文
 */
function blockEnd(lang: string, body: string[]): { parsed?: ReturnType<typeof parseBlock>; used: number } {
  for (let k = 1; k < body.length; k++) {
    const parsed = parseBlock(lang, body.slice(0, k).join("\n"));
    if (parsed) {
      return { parsed, used: k };
    }
  }
  const started = body.findIndex((line) => line.trim() !== "");
  const blank = started < 0 ? -1 : body.findIndex((line, j) => j > started && line.trim() === "");
  return { used: blank < 0 ? body.length : blank };
}

/** 前面拆好的（加上还没放进去的正文 markdown）接上后面接着拆的 */
function joinSplits(
  head: { segments: AnswerSegment[]; invalid: string[] },
  markdown: string[],
  tail: { segments: AnswerSegment[]; invalid: string[] },
): { segments: AnswerSegment[]; invalid: string[] } {
  const pending = markdown.join("\n");
  const segments = [...head.segments];
  if (pending.trim()) {
    segments.push({ kind: "markdown", text: pending.replace(/^\n+|\n+$/g, "") });
  }
  return { segments: [...segments, ...tail.segments], invalid: [...head.invalid, ...tail.invalid] };
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
    const lang = !inCode && next.marker ? uiLang(line) : undefined;
    if (lang) {
      // 按钮放在最后，生成时不用占位
      if (lang !== "actions") {
        out.push(lang === "chart" ? "📊 图表画好后显示在这里…" : "📌 关键数字整理好后显示在这里…");
      }
      hidden = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function parseBlock(lang: string, body: string): ChartBlock | KpiBlock | ActionsBlock | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  return lang === "chart" ? parseChart(json) : lang === "kpi" ? parseKpi(json) : parseActions(json);
}

function parseActions(json: unknown): ActionsBlock | undefined {
  if (!Array.isArray(json)) {
    return undefined;
  }
  const questions = [...new Set(json.map(actionQuestion))].filter((item): item is string => item !== undefined);
  return questions.length === 0 ? undefined : { kind: "actions", questions: questions.slice(0, MAX_ACTIONS) };
}

/**
 * 按钮上的一句话：去掉尖括号（点了以后这句话会发到话题里，不能变成 @所有人）、合成一行；
 * 太长的不要（截断了的问题点了也问不清楚）
 */
export function actionQuestion(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const question = value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return question && Array.from(question).length <= MAX_ACTION_CHARS ? question : undefined;
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

/** 图上的名字（横轴的值、系列名）：太长时掐掉中间，Pod 名这类前面一样、结尾不一样的才分得清 */
function label(value: unknown, max = MAX_LABEL_CHARS): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const chars = Array.from(value.trim());
  if (chars.length <= max) {
    return chars.join("");
  }
  const tail = Math.floor((max - 1) / 2);
  return `${chars.slice(0, max - 1 - tail).join("")}…${chars.slice(-tail).join("")}`;
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
  const x = raw.x.map((value) => label(value));
  // 横轴的值重了（掐短以后一样也算）：几个点会叠在一起
  if (x.length === 0 || x.some((value) => value === undefined) || new Set(x).size !== x.length) {
    return undefined;
  }
  const series: ChartBlock["series"] = [];
  for (const item of raw.series) {
    if (!item || typeof item !== "object") {
      return undefined;
    }
    const { name, data } = item as Record<string, unknown>;
    const seriesName = label(name) ?? (raw.series.length === 1 ? title : undefined);
    if (!seriesName || !Array.isArray(data) || data.length !== x.length || !data.every((n) => typeof n === "number" && Number.isFinite(n))) {
      return undefined;
    }
    series.push({ name: seriesName, data: data as number[] });
  }
  if (series.length === 0 || series.length > MAX_SERIES || series.length * x.length > MAX_POINTS_PER_CHART || (type === "pie" && series.length !== 1)) {
    return undefined;
  }
  // 系列名重了（掐短以后一样也算）：几条线会画成一条，图例也分不清
  if (new Set(series.map((item) => item.name)).size !== series.length) {
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
 * 全角字符（数字、％、－、ＭｉＢ）和数学减号（−）换成半角，再拆数、认单位：「９９％」是 99%，「−5」是 -5。
 * 不用 NFKC：它会把「10²」变成 102
 */
function halfWidth(text: string): string {
  return text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\u2212/g, "-");
}

/** 数字卡片里写的数、工具结果里的数：1,234 是一个数，.5 是 0.5；10-20 里的 - 不当负号 */
const NUMBER = /(?<![\d.])-?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?/gi;

/**
 * 写出来的单位决定查到的数能怎么换算过来（查到的数 × 倍数 = 写出来的数）。认不出单位的只认原数，
 * 免得一个比例 0.412 既能当 0.4% 又能当 41.2%、一个字节数原样当成 MiB
 */
export function unitFactors(raw: string | undefined): readonly number[] | undefined {
  if (!raw) {
    return undefined;
  }
  const text = halfWidth(raw);
  if (/%|百分/.test(text)) {
    return [1, 100];
  }
  if (/(?<![A-Za-z])(?:[KMGT]i?B?|[kmgt]B|bytes?)(?![A-Za-z])|字节/.test(text)) {
    return [1, 1e-3, 1e-6, 1e-9, 1e-12, 1 / 1024, 1 / 1024 ** 2, 1 / 1024 ** 3, 1 / 1024 ** 4];
  }
  if (/(?<![A-Za-z])m(?![A-Za-z])|毫核|millicores?/.test(text)) {
    return [1, 1000];
  }
  if (/核|cores?(?![A-Za-z])/.test(text)) {
    return [1, 1e-3];
  }
  if (/(?<![A-Za-z])ms(?![A-Za-z])|毫秒/.test(text)) {
    return [1, 1000];
  }
  if (/(?<![A-Za-z])s(?![A-Za-z])|秒/.test(text)) {
    return [1, 1e-3];
  }
  return undefined;
}

/** 工具结果里的数（原样，不换算），排好序，按区间查；换算按写出来的单位在查的时候做 */
export class NumberEvidence {
  private readonly values: Float64Array;

  constructor(outputs: readonly string[]) {
    const found: number[] = [];
    for (const raw of outputs) {
      const output = halfWidth(raw);
      // 两种拆法都算：「1,234」既是 1234，也可能是 JSON 数组里的 1 和 234
      for (const match of [...output.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi), ...output.matchAll(NUMBER)]) {
        const n = Number(match[0].replace(/,/g, ""));
        if (Number.isFinite(n)) {
          found.push(n);
        }
      }
    }
    this.values = Float64Array.from(found).sort();
  }

  /**
   * v 是不是哪个查到的数（按 factors 里的一个倍数换算以后）按 v 写出来的精度四舍五入的结果：
   * v 写成 41.2、单位是 % 时，看有没有 41.15 到 41.25 之间的数，或者 0.4115 到 0.4125 之间的数。
   * 卡片里写成文字的数由 half 给出写出来的精度（0.000 是 ±0.0005，转成数就成了 0，按 0 算会放宽到 ±0.5）
   */
  has(v: number, factors: readonly number[] = [1], half = halfStep(v)): boolean {
    // 浮点误差只放几个 ulp，远小于半格：0 不能当成 1e-12 的证据
    const slack = 8 * Number.EPSILON * Math.abs(v);
    return factors.some((factor) => this.within((v - half - slack) / factor, (v + half + slack) / factor));
  }

  private within(lo: number, hi: number): boolean {
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

/**
 * v 按写出来的最后一位四舍五入时的半格：41.2 → 0.05，1e-7 → 5e-8；整数（包括 1000、1e9）按个位算 → 0.5。
 * 用科学计数法数位数：很小的数 String() 出来是 1e-7 这样，按小数点数不出位数
 */
function halfStep(v: number): number {
  return writtenHalf(v.toExponential());
}

/** 写出来的数（41.20、0.000、1.5e-7）最后一位的半格：小数点后写了几位就按几位算，末尾的 0 也算 */
function writtenHalf(token: string): number {
  const [mantissa, exponent = "0"] = token.toLowerCase().split("e");
  const decimals = (mantissa.split(".")[1] ?? "").length;
  return 0.5 * 10 ** Math.min(0, Number(exponent) - decimals);
}

/**
 * 数字卡片的值里写的数和写出来的精度：「41%」「1.2 GiB」「1,234」「1e9」「.5」各是一个数；「10~20%」「10-20」是 10 和 20
 */
function numbersIn(value: string): { n: number; half: number }[] {
  return [...halfWidth(value).matchAll(NUMBER)].map((match) => {
    const token = match[0].replace(/,/g, "");
    return { n: Number(token), half: writtenHalf(token) };
  });
}

/**
 * 横轴上写成数的值（时间戳、编号，带千分位、单位的也算：1,000、500 ms、50%）：和图里的数一样要查得到。
 * 19:00、10-12 这种时间、日期不算（后面还跟着数）
 */
const NUMERIC_LABEL = new RegExp(`^\\s*[-+$¥€£~≈<>≤≥]?\\s*${NUMBER.source}\\s*[^\\d\\s]{0,8}\\s*$`, "i");

/**
 * 只留下数都查得到的图和数字卡片。dropped 记下去掉了什么，写日志用。
 * 图里的数全都要对得上，对不上的图换成一句说明；数字卡片一个个看，对不上的去掉，值里没有数的（「正常」）照留
 */
export function keepVerified(segments: AnswerSegment[], evidence: NumberEvidence): { segments: AnswerSegment[]; dropped: string[] } {
  const dropped: string[] = [];
  const kept: AnswerSegment[] = [];
  let charts = 0;
  let kpis = 0;
  for (const segment of segments) {
    if (segment.kind === "chart") {
      const factors = unitFactors(segment.unit) ?? [1];
      const missing = [
        ...segment.x.filter((value) => NUMERIC_LABEL.test(halfWidth(value))).flatMap((value) => numbersIn(value).filter(({ n, half }) => !evidence.has(n, unitFactors(value) ?? [1], half)).map(({ n }) => n)),
        ...segment.series.flatMap((s) => s.data).filter((n) => !evidence.has(n, factors)),
      ];
      if (missing.length > 0) {
        dropped.push(`图「${segment.title}」有 ${missing.length} 个数在查询结果里找不到（如 ${missing.slice(0, 3).join("、")}）`);
        kept.push({ kind: "markdown", text: `📊 图「${segment.title}」里有数和这次查到的结果对不上，没画出来。` });
        continue;
      }
      if (++charts > MAX_CHARTS) {
        dropped.push(`图「${segment.title}」超过 ${MAX_CHARTS} 张`);
        continue;
      }
    } else if (segment.kind === "actions") {
      if (kept.some((item) => item.kind === "actions")) {
        dropped.push("多写了一组按钮");
        continue;
      }
    } else if (segment.kind === "kpi") {
      const items = segment.items.filter((item) => {
        const factors = unitFactors(item.value) ?? unitFactors(item.label) ?? [1];
        const ok = numbersIn(item.value).every(({ n, half }) => evidence.has(n, factors, half));
        if (!ok) {
          dropped.push(`数字卡片「${item.label} ${item.value}」在查询结果里找不到`);
        }
        return ok;
      });
      // 几组数字卡片加起来也最多 MAX_KPIS 个
      const room = items.slice(0, Math.max(0, MAX_KPIS - kpis));
      if (room.length < items.length) {
        dropped.push(`数字卡片超过 ${MAX_KPIS} 个：${items.slice(room.length).map((item) => item.label).join("、")}`);
      }
      kpis += room.length;
      if (room.length === 0) {
        continue;
      }
      kept.push({ kind: "kpi", items: room });
      continue;
    }
    kept.push(segment);
  }
  return { segments: kept, dropped };
}

const LEVEL_COLOR: Record<NonNullable<KpiItem["level"]>, string> = { danger: "red", warn: "orange", ok: "green" };

/**
 * 卡片里的组件：markdown 段交给 renderMarkdown（转义、限长），图换成图表组件，数字卡片换成一排分栏，
 * 「接着查」换成按钮放在最后（askValue 给出按钮回传的值；不给时不放按钮）
 */
export function segmentElements(segments: AnswerSegment[], renderMarkdown: (text: string) => object, askValue?: (question: string) => object): object[] {
  const elements: object[] = [];
  const buttons: object[] = [];
  for (const segment of segments) {
    if (segment.kind === "markdown") {
      elements.push(renderMarkdown(segment.text));
    } else if (segment.kind === "kpi") {
      elements.push(kpiElement(segment));
    } else if (segment.kind === "chart") {
      elements.push(chartElement(segment));
    } else if (askValue) {
      buttons.push(...segment.questions.map((question) => askButton(question, askValue(question))));
    }
  }
  if (buttons.length > 0) {
    elements.push({ tag: "markdown", text_size: "notation", content: "可以接着查：" }, ...buttons);
  }
  return elements;
}

function askButton(question: string, value: object): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content: question },
    type: "default",
    size: "small",
    width: "fill",
    behaviors: [{ type: "callback", value }],
  };
}

/** Markdown 符号换成长得像的全角字：直接去掉会把「10~20%」连成「1020%」 */
const LOOKALIKE: Record<string, string> = { "*": "＊", _: "＿", "~": "～", "`": "ˋ", "[": "［", "]": "］" };

/** 数字卡片里的文字：模型写的，转义尖括号，会被当成 Markdown 的符号换成长得像的字 */
function plain(value: string): string {
  return value.replace(/</g, "&lt;").replace(/[*_~`[\]]/g, (char) => LOOKALIKE[char]);
}

function kpiElement({ items }: KpiBlock): object {
  return {
    tag: "column_set",
    // 手机上窄：3 个一行放得下；2 个、4 个两个一行
    flex_mode: items.length === 3 ? "trisect" : "bisect",
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
      if (segment.kind === "actions") {
        return `可以接着问：${segment.questions.map((question) => `「${plain(question)}」`).join("")}`;
      }
      return `📊 ${segment.title}（这里显示不了图）`;
    })
    .join("\n\n");
}

/** 回答里有没有要画成组件的块 */
export function hasUiBlocks(segments: AnswerSegment[]): boolean {
  return segments.some((segment) => segment.kind !== "markdown");
}
