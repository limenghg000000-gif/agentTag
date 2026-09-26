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
}

export interface ChatResult {
  text: string;
  /**
   * stop：正常结束；length：超出输出长度被截断；filtered：被模型服务的内容审核拦下；
   * tool_calls：模型要调用工具，见 toolCalls
   */
  finish: "stop" | "length" | "filtered" | "tool_calls";
  toolCalls?: ToolCall[];
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
export function createOpenAICompatibleModel(config: LlmConfig): ChatModel {
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });

  return {
    model: config.model,
    async chat({ system, messages, tools, signal }) {
      let completion: OpenAI.Chat.ChatCompletion;
      try {
        completion = await client.chat.completions.create(
          {
            model: config.model,
            messages: [{ role: "system", content: system }, ...messages.map(toOpenAIMessage)],
            ...(tools && tools.length > 0
              ? { tools: tools.map((tool) => ({ type: "function" as const, function: tool })) }
              : {}),
          },
          { signal },
        );
      } catch (err) {
        // 百炼对输入做内容审核，不通过时返回 400 data_inspection_failed
        if (err instanceof OpenAI.BadRequestError && err.code === "data_inspection_failed") {
          return { text: "", finish: "filtered" };
        }
        throw toLlmError(err);
      }

      const choice = completion.choices[0];
      const text = choice?.message.content?.trim() ?? "";
      const toolCalls = (choice?.message.tool_calls ?? [])
        .filter((call) => call.type === "function")
        .map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments }));
      // 有的模型带着工具调用返回时 finish_reason 仍是 stop，以是否真的有工具调用为准
      if (toolCalls.length > 0) {
        return { text, finish: "tool_calls", toolCalls };
      }
      switch (choice?.finish_reason) {
        case "length":
          return { text, finish: "length" };
        case "content_filter":
          return { text, finish: "filtered" };
        default:
          return { text, finish: "stop" };
      }
    },
  };
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
