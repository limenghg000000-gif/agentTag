import type { Tool } from "./tool.js";

const TIMEOUT_MS = 60_000;
/** 搜索结果摘要交给模型前的字数上限 */
const MAX_ANSWER_CHARS = 6000;
const MAX_SOURCES = 10;

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "full" });

export interface WebSearchOptions {
  /** 百炼原生文本生成接口，如 https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation */
  url: string;
  apiKey: string;
  model: string;
  now?: () => Date;
}

/** 百炼原生接口的返回（只列用到的字段） */
interface GenerationResponse {
  code?: string;
  message?: string;
  output?: {
    choices?: { message?: { content?: string } }[];
    text?: string;
    search_info?: { search_results?: { index?: number; title?: string; url?: string; site_name?: string }[] };
  };
}

/**
 * 联网搜索。用百炼模型自带的联网搜索（enable_search，强制搜索）让模型按搜索结果整理一段摘要，连同来源链接交给主模型。
 * 走百炼原生接口而不是 OpenAI 兼容接口：兼容接口不返回搜索来源。
 */
export function createWebSearchTool({ url, apiKey, model, now = () => new Date() }: WebSearchOptions): Tool {
  return {
    spec: {
      name: "web_search",
      description:
        "联网搜索，返回整理好的搜索结果和来源链接。需要最新信息（新闻、版本、价格、政策、近期事件）或你不确定的事实时使用。" +
        "已经知道具体网址时用 fetch_url 读原文；不要用 fetch_url 打开搜索引擎的网址。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要搜什么，写成一个具体的问题或关键词，比如「Node.js 24 LTS 发布日期」" },
          deep: { type: "boolean", description: "问题复杂、需要多方来源时设为 true，会搜得更全但更慢" },
        },
        required: ["query"],
      },
    },
    describe: (args) => `搜索：${preview(args.query)}`,
    async run(args, { signal }) {
      if (typeof args.query !== "string" || !args.query.trim()) {
        throw new Error("缺少 query 参数");
      }
      const query = args.query.trim();
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          signal: AbortSignal.any([signal, timeout]),
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            input: {
              messages: [
                {
                  role: "system",
                  content:
                    `你是联网搜索助手，今天是${TIME_FORMAT.format(now())}。根据搜索结果，用中文简洁地整理和问题相关的事实，` +
                    "保留数字、日期、名称和版本号，每条后面用 [编号] 标出来源。搜索结果里没有的不要编，没搜到就直说。",
                },
                { role: "user", content: query },
              ],
            },
            parameters: {
              result_format: "message",
              enable_search: true,
              search_options: {
                forced_search: true,
                enable_source: true,
                enable_citation: true,
                citation_format: "[<number>]",
                search_strategy: args.deep === true ? "max" : "turbo",
              },
            },
          }),
        });
      } catch (err) {
        if (timeout.aborted && !signal.aborted) {
          throw new Error(`搜索超时（${TIMEOUT_MS / 1000} 秒）`);
        }
        throw err;
      }

      const body = (await res.json().catch(() => ({}))) as GenerationResponse;
      if (!res.ok || body.code) {
        throw new Error(describeError(res.status, body));
      }
      return format(query, body);
    },
  };
}

function format(query: string, body: GenerationResponse): string {
  const answer = (body.output?.choices?.[0]?.message?.content ?? body.output?.text ?? "").trim();
  const sources = (body.output?.search_info?.search_results ?? []).filter((s) => s.url).slice(0, MAX_SOURCES);
  const lines = [`搜索「${query}」的结果：`, ""];
  lines.push(answer.length > MAX_ANSWER_CHARS ? `${answer.slice(0, MAX_ANSWER_CHARS)}…（后面省略）` : answer || "（没有返回内容）");
  lines.push("");
  if (sources.length > 0) {
    lines.push("来源：", ...sources.map((s, i) => `[${s.index ?? i + 1}] ${s.title || s.site_name || "网页"} ${s.url}`));
  } else {
    lines.push("（这次没有返回搜索来源，上面的内容可能不是联网搜到的，引用前请核实，或换个说法再搜）");
  }
  return lines.join("\n");
}

function describeError(status: number, body: GenerationResponse): string {
  if (status === 401 || status === 403 || body.code === "InvalidApiKey") {
    return "搜索失败：百炼的 API Key 无效或没有权限";
  }
  if (status === 429 || body.code === "Throttling" || body.code?.startsWith("Throttling")) {
    return "搜索失败：百炼限流了，稍后再试";
  }
  if (body.code === "DataInspectionFailed" || body.code === "data_inspection_failed") {
    return "搜索失败：搜索内容被百炼的内容审核拦下了，换个说法试试";
  }
  return `搜索失败：百炼返回 HTTP ${status}${body.code ? ` ${body.code}` : ""}${body.message ? `：${body.message}` : ""}`;
}

function preview(value: unknown): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}
