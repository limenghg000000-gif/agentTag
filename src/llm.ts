import OpenAI from "openai";

/** 模型发起的一次工具调用。arguments 是模型给出的 JSON 字符串，由调用方解析和校验。 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** 提供给模型的工具说明，parameters 是 JSON Schema。 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  /** 不传或为空时模型只能直接回答 */
  tools?: ToolSpec[];
  /** 中止后正在进行的请求会被取消 */
  signal?: AbortSignal;
  /** 这次单独打开或关掉思考；不传用配置里的 */
  thinking?: boolean;
}

/** 一次模型调用用掉的 token，用来看时间花在哪 */
export interface TokenUsage {
  input: number;
  output: number;
  /** 其中花在思考上的（模型开了思考模式时才有） */
  reasoning?: number;
}

export interface ChatResult {
  text: string;
  /**
   * stop：正常结束；length：超出输出长度被截断；filtered：被模型服务的内容审核拦下；
   * tool_calls：模型要调用工具，见 toolCalls
   */
  finish: "stop" | "length" | "filtered" | "tool_calls";
  toolCalls?: ToolCall[];
  /** 模型服务返回了用量时才有 */
  usage?: TokenUsage;
  /** 模型这一轮的思考内容（百炼放在 reasoning_content 里）。开着思考、模型服务返回了才有 */
  reasoning?: string;
}

/** 模型调用层。业务代码只依赖这个接口，换模型服务只需换实现或改环境变量。 */
export interface ChatModel {
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResult>;
}

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /**
   * 思考模式（百炼的 enable_thinking）。不填就不传，用模型服务的默认值。
   * 思考 token 和回答一样按顺序生成，关掉能明显缩短长回答的时间
   */
  thinking?: boolean;
  /**
   * 打开思考时最多思考多少 token（百炼的 thinking_budget），超过后模型立刻开始回答。
   * 不填就不传，用模型自己的上限
   */
  thinkingBudget?: number;
}

export type LlmErrorKind = "auth" | "rate_limit" | "connection" | "api";

/** 各家 SDK 的异常统一翻译成这个类型，上层不必认识具体 SDK。 */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LlmError";
  }
}

/**
 * OpenAI 兼容接口（Chat Completions）的实现。阿里云百炼、Kimi、智谱 GLM、DeepSeek 等都提供这种接口，
 * 换服务只需改 MODEL_BASE_URL / MODEL_API_KEY / MODEL_ID。工具调用用的也是 OpenAI 的 tools 格式。
 */
export function createOpenAICompatibleModel(config: LlmConfig, warn: (message: string) => void = console.warn): ChatModel {
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
  // 百炼默认一轮只调一个工具；打开并行后，互不依赖的几个工具可以一轮发出，少等几轮模型。
  // 这两个参数个别服务或模型不认、报 400 时，去掉重试，之后都不再带
  let parallelToolCalls = true;
  let thinkingSupported = true;
  let budgetSupported = true;
  type Body = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & { enable_thinking?: boolean; thinking_budget?: number };
  const create = async (body: Body, thinkingWanted: boolean | undefined, signal?: AbortSignal): Promise<OpenAI.Chat.ChatCompletion> => {
    for (let attempt = 0; ; attempt++) {
      const thinking = thinkingSupported ? (thinkingWanted ?? config.thinking) : undefined;
      const budget = thinking && budgetSupported ? config.thinkingBudget : undefined;
      const request: Body = {
        ...body,
        ...(body.tools && parallelToolCalls ? { parallel_tool_calls: true } : {}),
        ...(thinking !== undefined ? { enable_thinking: thinking } : {}),
        ...(budget !== undefined ? { thinking_budget: budget } : {}),
      };
      try {
        return await client.chat.completions.create(request, { signal });
      } catch (err) {
        if (attempt < 3 && err instanceof OpenAI.BadRequestError) {
          if (request.parallel_tool_calls && /parallel_tool_calls/i.test(err.message)) {
            parallelToolCalls = false;
            continue;
          }
          if (request.thinking_budget !== undefined && /thinking_budget/i.test(err.message)) {
            warn(`模型 ${config.model} 不支持限制思考长度（${err.message}），之后不再传 thinking_budget`);
            budgetSupported = false;
            continue;
          }
          if (request.enable_thinking !== undefined && /thinking/i.test(err.message)) {
            warn(`模型 ${config.model} 不支持设置思考模式（${err.message}），之后不再传 enable_thinking`);
            thinkingSupported = false;
            continue;
          }
        }
        throw err;
      }
    }
  };

  return {
    model: config.model,
    async chat({ system, messages, tools, signal, thinking }) {
      const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model: config.model,
        messages: [{ role: "system", content: system }, ...messages.map(toOpenAIMessage)],
        ...(tools && tools.length > 0
          ? { tools: tools.map((tool) => ({ type: "function" as const, function: tool })) }
          : {}),
      };
      let completion: OpenAI.Chat.ChatCompletion;
      try {
        completion = await create(body, thinking, signal);
      } catch (err) {
        // 百炼对输入做内容审核，不通过时返回 400 data_inspection_failed
        if (err instanceof OpenAI.BadRequestError && err.code === "data_inspection_failed") {
          return { text: "", finish: "filtered" };
        }
        throw toLlmError(err);
      }

      const choice = completion.choices[0];
      const text = stripThinkTags(choice?.message.content ?? "");
      const usage = toUsage(completion.usage);
      // reasoning_content 不是 OpenAI 的标准字段，百炼、DeepSeek 等开着思考时在这里返回思考内容
      const thought = (choice?.message as { reasoning_content?: unknown } | undefined)?.reasoning_content;
      const reasoning = typeof thought === "string" && thought.trim() ? thought.trim() : undefined;
      const withUsage = <T extends ChatResult>(result: T): T => ({ ...result, ...(usage ? { usage } : {}), ...(reasoning ? { reasoning } : {}) });
      const toolCalls = (choice?.message.tool_calls ?? [])
        .filter((call) => call.type === "function")
        .map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments }));
      // 有的模型带着工具调用返回时 finish_reason 仍是 stop，以是否真的有工具调用为准
      if (toolCalls.length > 0) {
        return withUsage({ text, finish: "tool_calls", toolCalls });
      }
      switch (choice?.finish_reason) {
        case "length":
          return withUsage({ text, finish: "length" });
        case "content_filter":
          return withUsage({ text, finish: "filtered" });
        default:
          return withUsage({ text, finish: "stop" });
      }
    },
  };
}

/** 看图片的模型：按要求把一张图片转成文字。主模型不一定能看图，所以单独配一个 */
export interface VisionModel {
  readonly model: string;
  describe(image: { data: Buffer; mimeType: string }, instruction: string, signal?: AbortSignal): Promise<string>;
}

/**
 * OpenAI 兼容接口的看图实现：图片用 base64 的 data URL 放进 image_url，百炼的千问等模型都认这种格式。
 * thinking 为 false 时关掉思考（百炼的 enable_thinking），抄文字用不着想；模型不认这个参数就去掉重试，之后都不再带
 */
export function createOpenAICompatibleVisionModel(config: Pick<LlmConfig, "baseURL" | "apiKey" | "model" | "thinking">): VisionModel {
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
  let thinkingSupported = true;
  return {
    model: config.model,
    async describe(image, instruction, signal) {
      type Body = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & { enable_thinking?: boolean };
      const body: Body = {
        model: config.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data.toString("base64")}` } },
              { type: "text", text: instruction },
            ],
          },
        ],
      };
      for (let attempt = 0; ; attempt++) {
        const thinking = thinkingSupported ? config.thinking : undefined;
        try {
          const completion = await client.chat.completions.create(
            { ...body, ...(thinking !== undefined ? { enable_thinking: thinking } : {}) },
            { signal },
          );
          return stripThinkTags(completion.choices[0]?.message.content ?? "");
        } catch (err) {
          if (attempt === 0 && thinking !== undefined && err instanceof OpenAI.BadRequestError && /thinking/i.test(err.message)) {
            thinkingSupported = false;
            continue;
          }
          throw toLlmError(err);
        }
      }
    },
  };
}

/**
 * 千问多轮调工具时偶尔把思考漏进正文（aiops 的模型代理也专门处理过），发到群里前去掉：
 * 正文以一段思考开头、以 </think> 结束（开头的 <think> 有时在模板里，正文里看不到），后面还有正文时，去掉这段思考；
 * 其余零散的标签只去掉标签本身、保留文字，免得误删回答
 */
export function stripThinkTags(text: string): string {
  let out = text.replace(/<think>\s*<\/think>/g, "");
  const end = out.indexOf("</think>");
  const start = out.indexOf("<think>");
  const leading = start === -1 || start > end || !out.slice(0, start).trim();
  if (end !== -1 && leading && out.slice(end + "</think>".length).trim()) {
    out = out.slice(end + "</think>".length);
  }
  return out.replace(/<\/?think>/g, "").trim();
}

function toOpenAIMessage(message: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    case "assistant":
      if (!message.toolCalls?.length) {
        return { role: "assistant", content: message.content };
      }
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
  }
}

function toUsage(usage: OpenAI.CompletionUsage | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
    ...(reasoning ? { reasoning } : {}),
  };
}

function toLlmError(err: unknown): unknown {
  // 主动中止（用户点了停止）原样抛出，由上层按「已停止」处理
  if (err instanceof OpenAI.APIUserAbortError) {
    return err;
  }
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new LlmError("auth", err.message, { cause: err });
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new LlmError("rate_limit", err.message, { cause: err });
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new LlmError("connection", err.message, { cause: err });
  }
  if (err instanceof OpenAI.APIError) {
    return new LlmError("api", `${err.status ?? ""} ${err.message}`.trim(), { cause: err });
  }
  return err;
}
