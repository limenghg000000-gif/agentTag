import type { ToolEvidence } from "./bot.js";
import type { Tool } from "./tools/tool.js";

export const EARLIER_RESULTS_TOOL = "topic_earlier_results";

/** 每个话题最多留多少字的结果（超了先丢最早查到的）、最多留几个话题、留多久 */
const MAX_CHARS_PER_TOPIC = 300_000;
const MAX_TOPICS = 50;
const KEEP_MS = 24 * 60 * 60 * 1000;
/** 系统提示里最多列几条（最近的几条），进度卡片上那句话最多多少字 */
export const MAX_LISTED_RESULTS = 30;
const MAX_DESCRIBE_CHARS = 200;
/** 结果原文前面加的说明（第几条、几点查的）留出来的字数 */
const HEADER_CHARS = 1000;

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** 话题里之前查到的一条工具结果 */
export interface EarlierResult {
  /** 当时调的工具（aiops_query_logs 这类） */
  tool: string;
  /** 进度卡片上那句话（「aiops · 查日志 {app="product-service-api"}」） */
  describe: string;
  /** 查到的时间（毫秒） */
  at: number;
  /** 当时交给模型的原文（截短后的） */
  text: string;
  /** 当时记的证据：再拿出来用时原样算进这次的证据，回答里的数据、代码位置照样能核对 */
  evidence: ToolEvidence;
}

/**
 * 按话题记下之前几次回答时查到的工具结果（只放在内存里，重启就没了）。
 * 2026-10-16 测试群：查完转链日志的回答只给了结论，追问「不在推广中的链接发出来」时，链接只在上次的工具结果里、话题里没有，
 * 模型只能把日志重新查一遍（6 次 aiops 调用，又开了思考）。记下来以后，追问要的是上次查到的东西时按编号取原文就能答
 */
export class EarlierResults {
  private readonly topics = new Map<string, EarlierResult[]>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits = { chars: MAX_CHARS_PER_TOPIC, topics: MAX_TOPICS, keepMs: KEEP_MS },
  ) {}

  /** 这个话题之前查到的结果，从早到晚。超过保留时间的不算 */
  list(key: string): readonly EarlierResult[] {
    const results = this.topics.get(key);
    if (!results) {
      return [];
    }
    const fresh = results.filter((result) => this.now() - result.at < this.limits.keepMs);
    if (fresh.length === 0) {
      this.topics.delete(key);
    } else if (fresh.length < results.length) {
      this.topics.set(key, fresh);
    }
    return fresh;
  }

  /** 记下这次查到的结果，接在之前的后面；话题挪到最新，超出上限的先丢最早的结果、最久没用的话题 */
  add(key: string, results: readonly EarlierResult[]): void {
    if (results.length === 0) {
      return;
    }
    const kept = [...this.list(key), ...results.map((result) => ({ ...result, describe: clip(result.describe, MAX_DESCRIBE_CHARS) }))];
    let chars = kept.reduce((sum, result) => sum + sizeOf(result), 0);
    while (kept.length > 1 && chars > this.limits.chars) {
      chars -= sizeOf(kept.shift() as EarlierResult);
    }
    this.topics.delete(key);
    this.topics.set(key, kept);
    for (const oldest of this.topics.keys()) {
      if (this.topics.size <= this.limits.topics) {
        break;
      }
      this.topics.delete(oldest);
    }
  }
}

function sizeOf(result: EarlierResult): number {
  const { output } = result.evidence;
  return result.text.length + (output !== undefined && output !== result.text ? output.length : 0);
}

/** 系统提示里列出来的那几行：编号、时间、调的什么、多少字。编号就是取原文时的 index */
export function listEarlierResults(results: readonly EarlierResult[]): string[] {
  const start = Math.max(0, results.length - MAX_LISTED_RESULTS);
  return results.slice(start).map((result, i) => `${start + i + 1}. ${TIME_FORMAT.format(result.at)} ${result.describe}（${result.text.length} 字）`);
}

export interface EarlierResultsToolOptions {
  results: readonly EarlierResult[];
  /** 取到了一条：调用方把它的证据算进这次 */
  onUse(result: EarlierResult): void;
  now?: () => number;
}

/** 按编号取这个话题之前查到的结果原文。每个任务按所在的话题单独创建，看不到别的话题 */
export function createEarlierResultsTool({ results, onUse, now = Date.now }: EarlierResultsToolOptions): Tool {
  const longest = results.reduce((max, result) => Math.max(max, result.text.length), 0);
  return {
    spec: {
      name: EARLIER_RESULTS_TOOL,
      description:
        "按编号取这个话题里之前查到的工具结果原文（之前回答时查日志、查指标、读代码拿到的原始结果，编号见系统提示里「这个话题之前查到过的结果」）。" +
        "追问要的是之前查到的东西时用，比如把链接、订单号、报错原文发出来、列全、看某一条的详情：取到原文照着回答，不用重新查。" +
        "结果是当时查到的，不是现在的情况；要最新情况时照常用别的工具查。",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer", minimum: 1, description: "取第几条，一次取一条；要几条就在同一轮里调几次" },
        },
        required: ["index"],
      },
    },
    maxOutputChars: longest + HEADER_CHARS,
    describe: (args) => `看之前查到的第 ${indexOf(args) ?? "?"} 条结果`,
    async run(args) {
      const index = indexOf(args);
      const result = index === undefined ? undefined : results[index - 1];
      if (!result || index === undefined) {
        throw new Error(
          results.length > 0 ? `没有这一条：之前查到的结果编号是 1～${results.length}` : "这个话题之前没有查到过结果，要查就用别的工具查",
        );
      }
      onUse(result);
      return (
        `第 ${index} 条：${TIME_FORMAT.format(result.at)}（${ago(now() - result.at)}）查到的，当时调的是「${result.describe}」。` +
        "下面是当时拿到的原文，不是现在的情况，回答里用到时说明是那时查到的：\n\n" +
        result.text
      );
    },
  };
}

/** 多久以前：一小时以内按分钟说，再久按小时说 */
function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 60 ? `${minutes} 分钟前` : `约 ${Math.round(minutes / 60)} 小时前`;
}

function indexOf(args: Record<string, unknown>): number | undefined {
  const value = typeof args.index === "string" ? Number(args.index.trim()) : args.index;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
