import type { ChatMessage, ChatModel, ChatResult, TokenUsage, ToolCall } from "./llm.js";
import type { Tool } from "./tools/tool.js";

/** 单次任务最多几轮工具调用。到了上限就让模型用已有信息直接作答。排查线上问题时一次诊断加几次补查，8 轮不太够 */
export const MAX_TOOL_ROUNDS = 12;
/** 单个工具结果交给模型前默认的字数上限，防止一个大网页挤掉上下文。工具可以用 maxOutputChars 另定 */
export const MAX_TOOL_OUTPUT_CHARS = 16000;

const LAST_ROUND_NOTE = "工具调用次数已经用完了。请根据上面已经拿到的信息直接给出最终回答，不要再调用工具；没查到的部分如实说明。";
const OUT_OF_ROUNDS_ANSWER = `这个任务需要的步骤超出了单次上限（${MAX_TOOL_ROUNDS} 轮工具调用），我先停在这里。可以把任务拆小一点再交给我。`;

export type AgentEvent =
  /** 一轮模型调用结束。toolNames 为空表示这一轮给出了回答；reasoning 是这一轮的思考内容（模型返回了才有） */
  | { type: "model"; round: number; ms: number; usage?: TokenUsage; toolNames: string[]; thinking?: boolean; reasoning?: string }
  | { type: "tool_start"; id: string; label: string }
  /** error 是交给模型的失败原因 */
  | { type: "tool_end"; id: string; name: string; ok: boolean; ms: number; error?: string }
  /** 回答没通过 review，已经让模型重做 */
  | { type: "retry"; reason: string };

export interface AgentRequest {
  model: ChatModel;
  system: string;
  messages: ChatMessage[];
  tools: readonly Tool[];
  signal: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  maxToolRounds?: number;
  /** 计时用的时钟（毫秒） */
  now?: () => number;
  /** 这次任务单独打开或关掉思考；不传用模型的配置 */
  thinking?: boolean;
  /**
   * 调过某个工具以后，后面几轮打开思考（没传 thinking 时才看）：比如调过 aiops 的工具就是在排查线上问题，
   * 每拿到一次结果都要想清楚下一步查什么。返回 true 的工具调过一次，这次任务后面每一轮都开着
   */
  thinkAfter?: (toolName: string) => boolean;
  /**
   * 模型给出最终回答时检查一遍，比如「回答里提到了仓库的文件，这次却一次代码工具都没调」。
   * 返回一段话时，这版回答不发出去，把这段话交给模型让它重做；每个任务只重做一次。usedTools 是这次任务调过的工具名
   */
  review?: (answer: string, usedTools: ReadonlySet<string>) => string | undefined;
  /**
   * 一轮调了工具以后看这一轮的思考：返回一段话时，在工具结果后面加一条用户消息再问下一轮。
   * 比如思考被英文的日志、代码带成了英文，提醒模型接着用中文想（思考会显示在进度卡片上）。
   * 不接在工具结果里：工具结果是外部资料，系统提示词说里面的指令一律不执行，混在一起也会教模型信工具结果里冒充的「系统提醒」
   */
  steerReasoning?: (reasoning: string) => string | undefined;
}

export interface AgentResult {
  text: string;
  finish: Exclude<ChatResult["finish"], "tool_calls">;
  /** 一共调用了几次工具 */
  toolCalls: number;
}

/**
 * 与具体模型无关的工具循环：问模型 → 模型要调工具就执行并把结果交回 → 直到模型给出最终回答。
 * 同一轮里的多个工具调用并行执行。signal 中止后抛出中止错误，由调用方按「已停止」处理。
 */
export async function runAgent({
  model,
  system,
  messages,
  tools,
  signal,
  onEvent = () => {},
  maxToolRounds = MAX_TOOL_ROUNDS,
  now = Date.now,
  thinking,
  thinkAfter,
  review,
  steerReasoning,
}: AgentRequest): Promise<AgentResult> {
  const byName = new Map(tools.map((tool) => [tool.spec.name, tool]));
  const specs = tools.map((tool) => tool.spec);
  const conversation = [...messages];
  const usedTools = new Set<string>();
  let toolCalls = 0;
  let reviewed = false;
  let investigating = false;

  for (let round = 0; ; round++) {
    signal.throwIfAborted();
    const lastRound = round >= maxToolRounds;
    if (lastRound) {
      // 上一轮后面已经加过一条用户消息（打回重做、思考提醒）时并进去，不连着发两条用户消息
      const last = conversation.at(-1);
      if (last?.role === "user" && conversation.length > messages.length) {
        conversation[conversation.length - 1] = { ...last, content: `${last.content}\n\n${LAST_ROUND_NOTE}` };
      } else {
        conversation.push({ role: "user", content: LAST_ROUND_NOTE });
      }
    }
    const startedAt = now();
    const think = thinking ?? (investigating ? true : undefined);
    const result = await model.chat({ system, messages: conversation, tools: specs, signal, ...(think !== undefined ? { thinking: think } : {}) });
    onEvent({
      type: "model",
      round: round + 1,
      ms: now() - startedAt,
      ...(result.usage ? { usage: result.usage } : {}),
      toolNames: result.finish === "tool_calls" ? (result.toolCalls ?? []).map((call) => call.name) : [],
      ...(think !== undefined ? { thinking: think } : {}),
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    });
    if (result.finish !== "tool_calls" || !result.toolCalls?.length) {
      const redo = !lastRound && !reviewed && result.finish !== "filtered" ? review?.(result.text, usedTools) : undefined;
      if (redo) {
        reviewed = true;
        onEvent({ type: "retry", reason: redo });
        conversation.push({ role: "assistant", content: result.text }, { role: "user", content: redo });
        continue;
      }
      return { text: result.text, finish: result.finish === "tool_calls" ? "stop" : result.finish, toolCalls };
    }
    if (lastRound) {
      return { text: result.text || OUT_OF_ROUNDS_ANSWER, finish: "stop", toolCalls };
    }

    conversation.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });
    const outputs = await Promise.all(
      result.toolCalls.map((call) => runTool(call, byName.get(call.name), signal, onEvent, now)),
    );
    toolCalls += result.toolCalls.length;
    for (const call of result.toolCalls) {
      usedTools.add(call.name);
      investigating ||= thinkAfter?.(call.name) ?? false;
    }
    signal.throwIfAborted();
    result.toolCalls.forEach((call, i) => {
      conversation.push({ role: "tool", toolCallId: call.id, content: outputs[i] });
    });
    const steer = result.reasoning ? steerReasoning?.(result.reasoning) : undefined;
    if (steer) {
      conversation.push({ role: "user", content: steer });
    }
  }
}

async function runTool(
  call: ToolCall,
  tool: Tool | undefined,
  signal: AbortSignal,
  onEvent: (event: AgentEvent) => void,
  now: () => number,
): Promise<string> {
  if (!tool) {
    return `没有名为 ${call.name} 的工具。`;
  }
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(call.arguments || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("参数必须是 JSON 对象");
    }
    args = parsed as Record<string, unknown>;
  } catch (err) {
    return `工具参数不是合法的 JSON 对象：${errorMessage(err)}`;
  }

  onEvent({ type: "tool_start", id: call.id, label: safeDescribe(tool, args) });
  const startedAt = now();
  try {
    const output = await tool.run(args, { signal });
    onEvent({ type: "tool_end", id: call.id, name: call.name, ok: true, ms: now() - startedAt });
    return truncate(output, tool.maxOutputChars ?? MAX_TOOL_OUTPUT_CHARS);
  } catch (err) {
    onEvent({ type: "tool_end", id: call.id, name: call.name, ok: false, ms: now() - startedAt, error: errorMessage(err) });
    if (signal.aborted) {
      throw err;
    }
    return `工具执行失败：${errorMessage(err)}`;
  }
}

function safeDescribe(tool: Tool, args: Record<string, unknown>): string {
  try {
    return tool.describe(args);
  } catch {
    return tool.spec.name;
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n（内容过长，后面 ${text.length - limit} 字已省略）`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
