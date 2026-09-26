import OpenAI from "openai";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
}

export interface ChatResult {
  text: string;
  /** stop：正常结束；length：超出输出长度被截断；filtered：被模型服务的内容审核拦下 */
  finish: "stop" | "length" | "filtered";
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
 * 换服务只需改 MODEL_BASE_URL / MODEL_API_KEY / MODEL_ID。
 */
export function createOpenAICompatibleModel(config: LlmConfig): ChatModel {
  const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });

  return {
    model: config.model,
    async chat({ system, messages }) {
      let completion: OpenAI.Chat.ChatCompletion;
      try {
        completion = await client.chat.completions.create({
          model: config.model,
          messages: [{ role: "system", content: system }, ...messages],
        });
      } catch (err) {
        // 百炼对输入做内容审核，不通过时返回 400 data_inspection_failed
        if (err instanceof OpenAI.BadRequestError && err.code === "data_inspection_failed") {
          return { text: "", finish: "filtered" };
        }
        throw toLlmError(err);
      }

      const choice = completion.choices[0];
      const text = choice?.message.content?.trim() ?? "";
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

function toLlmError(err: unknown): unknown {
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
