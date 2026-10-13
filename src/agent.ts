import { type ChatMessage, type ChatModel, type ChatResult, LlmError, type TokenUsage, type ToolCall } from "./llm.js";
import type { Tool } from "./tools/tool.js";

/** 单次任务最多几轮工具调用。到了上限就让模型用已有信息直接作答。排查线上问题时一次诊断加几次补查，8 轮不太够 */
export const MAX_TOOL_ROUNDS = 12;
/** 单个工具结果交给模型前默认的字数上限，防止一个大网页挤掉上下文。工具可以用 maxOutputChars 另定 */
export const MAX_TOOL_OUTPUT_CHARS = 16000;

/**
 * 模型服务说输入太长时，按顺序试这几档：先把最近 2 轮以前的工具结果压到只留开头，还不行就连最近的也压，最后只留很短的开头。
 * 不预先估 token：各家模型的上下文窗口和分词都不一样，以服务的报错为准，换模型也不用另配窗口大小
 */
const COMPACT_LEVELS = [
  { keepRounds: 2, headChars: 2000 },
  { keepRounds: 0, headChars: 2000 },
  { keepRounds: 0, headChars: 300 },
] as const;

const LAST_ROUND_NOTE = "工具调用次数已经用完了。请根据上面已经拿到的信息直接给出最终回答，不要再调用工具；没查到的部分如实说明。";
const OUT_OF_ROUNDS_ANSWER = `这个任务需要的步骤超出了单次上限（${MAX_TOOL_ROUNDS} 轮工具调用），我先停在这里。可以把任务拆小一点再交给我。`;

export type AgentEvent =
  /** 一轮模型调用结束。toolNames 为空表示这一轮给出了回答；reasoning 是这一轮的思考内容（模型返回了才有） */
  | { type: "model"; round: number; ms: number; usage?: TokenUsage; toolNames: string[]; thinking?: boolean; reasoning?: string }
  | { type: "tool_start"; id: string; label: string }
  /** error 是交给模型的失败原因 */
  | { type: "tool_end"; id: string; name: string; ok: boolean; ms: number; error?: string }
  /** 回答没通过 review，已经让模型重做 */
  | { type: "retry"; reason: string }
  /** 模型服务说输入太长，压短了 results 个工具结果（一共省掉 chars 字）后重试这一轮 */
  | { type: "compacted"; round: number; results: number; chars: number }
  /** 流式时模型这一轮到目前为止的思考和正文（stream 打开时才有） */
  | { type: "delta"; round: number; reasoning: string; text: string };

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
   * 一轮调了工具以后：返回一段话时，在工具结果后面加一条用户消息再问下一轮。比如下一轮要思考，提醒模型用中文想（思考会显示在进度卡片上）。
   * reasoning 是这一轮的思考（模型返回了才有）；thinkingNext 是下一轮开着思考（这次任务打开了，或者没指定、这一轮返回了思考）。
   * 不接在工具结果里：工具结果是外部资料，系统提示词说里面的指令一律不执行，混在一起也会教模型信工具结果里冒充的「系统提醒」
   */
  steer?: (round: { reasoning?: string; thinkingNext: boolean }) => string | undefined;
  /** 流式调用模型，边生成边发 delta 事件（比如在卡片上边想边显示） */
  stream?: boolean;
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
  steer,
  stream,
}: AgentRequest): Promise<AgentResult> {
  const byName = new Map(tools.map((tool) => [tool.spec.name, tool]));
  const specs = tools.map((tool) => tool.spec);
  const conversation = [...messages];
  const usedTools = new Set<string>();
  /** 压短过的工具结果的原文（按在 conversation 里的位置），再压时从原文取开头 */
  const originals = new Map<number, string>();
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
    const onDelta = stream ? (soFar: { reasoning: string; text: string }) => onEvent({ type: "delta", round: round + 1, ...soFar }) : undefined;
    let result: ChatResult;
    for (let level = 0; ; ) {
      try {
        result = await model.chat({
          system,
          messages: conversation,
          tools: specs,
          signal,
          ...(think !== undefined ? { thinking: think } : {}),
          ...(onDelta ? { onDelta } : {}),
        });
        break;
      } catch (err) {
        if (!(err instanceof LlmError && err.kind === "too_long")) {
          throw err;
        }
        // 找下一档真能压掉东西的；都压不动（比如第一轮还没有工具结果）就照原样报错，由调用方告诉用户
        let saved = { results: 0, chars: 0 };
        while (saved.results === 0 && level < COMPACT_LEVELS.length) {
          saved = compactToolResults(conversation, originals, COMPACT_LEVELS[level++]);
        }
        if (saved.results === 0) {
          throw err;
        }
        signal.throwIfAborted();
        onEvent({ type: "compacted", round: round + 1, ...saved });
      }
    }
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
        // 重做这一轮起打开思考（没指定时）：2026-10-13 点「接着查」按钮问 product-service-api 最近 1 小时的错误日志，
        // 模型没调工具就照着话题和群记忆答了；打回时写明了要先用 aiops 查，不思考的第二轮还是没调工具，整条回答被拦
        investigating = true;
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
    const nextThink = thinking ?? (investigating ? true : undefined);
    const note = steer?.({
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      thinkingNext: nextThink ?? result.reasoning !== undefined,
    });
    if (note) {
      conversation.push({ role: "user", content: note });
    }
  }
}

/**
 * 把较早的工具结果压到只留开头：最近 keepRounds 轮调了工具的结果原样留着，更早的只留 headChars 字，后面写明省略了多少、需要就重新查。
 * 只会越压越短，不会把压过的再放长。返回这次压短了几个结果、一共省掉多少字
 */
export function compactToolResults(
  conversation: ChatMessage[],
  originals: Map<number, string>,
  { keepRounds, headChars }: { keepRounds: number; headChars: number },
): { results: number; chars: number } {
  let cutoff = conversation.length;
  for (let kept = 0; kept < keepRounds && cutoff > 0; ) {
    cutoff--;
    const message = conversation[cutoff];
    if (message.role === "assistant" && message.toolCalls?.length) {
      kept++;
    }
  }
  let results = 0;
  let chars = 0;
  for (let i = 0; i < cutoff; i++) {
    const message = conversation[i];
    if (message.role !== "tool") {
      continue;
    }
    const original = originals.get(i) ?? message.content;
    if (original.length <= headChars) {
      continue;
    }
    const content = `${original.slice(0, headChars)}\n\n（上下文快放不下了，这个结果只留了开头 ${headChars} 字，后面 ${original.length - headChars} 字已省略；要用后面的内容请重新查）`;
    if (content.length >= message.content.length) {
      continue;
    }
    originals.set(i, original);
    chars += message.content.length - content.length;
    results++;
    conversation[i] = { ...message, content };
  }
  return { results, chars };
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
