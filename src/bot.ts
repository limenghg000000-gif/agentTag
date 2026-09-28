import type { CardActionEvent, NormalizedMessage, SendInput, SendOptions, SendResult } from "@larksuiteoapi/node-sdk";
import { type AgentEvent, type AgentResult, runAgent } from "./agent.js";
import { DuplicateAsks } from "./duplicates.js";
import { labelUserMessage, type Logger, type ThreadContext, threadKeyOf } from "./history.js";
import { type ChatModel, LlmError } from "./llm.js";
import { splitMarkdown } from "./markdown.js";
import { type MemoryStore, renderMemoryForPrompt } from "./memory.js";
import {
  CardUpdater,
  type ProgressState,
  renderPlainProgressCard,
  renderProgressCard,
  STOP_ACTION,
} from "./progress.js";
import { buildSystemPrompt } from "./prompt.js";
import type { TaskRegistry } from "./tasks.js";
import { createMemoryTools } from "./tools/memory.js";
import type { Tool } from "./tools/tool.js";

/**
 * 每条回复的字数上限。SDK 超过 3500 字会自己切分，但切出来的后续片段会发到群主界面而不是话题里，
 * 所以这里先切好，每片都回复到原消息的话题。
 */
const CHUNK_CHARS = 3000;
/** 连长连接之前还不知道机器人名字时用这个 */
const FALLBACK_BOT_NAME = "AI 助手";
/** 在话题里 @ 机器人说这些词时停止任务，而不是当成新问题 */
const STOP_COMMAND = /^(停止|停下|停|别做了|取消|stop|cancel)[。.!！\s]*$/i;

export interface ThreadContextSource {
  load(msg: NormalizedMessage): Promise<ThreadContext>;
  remember(msg: NormalizedMessage, question: string, answer: string): void;
}

/** 按任务创建工具时用得上的信息 */
export interface TaskToolContext {
  chatId: string;
  /** 发起人的 open_id */
  senderId: string;
  messageId: string;
}

export interface BotDeps {
  model: ChatModel;
  tools: readonly Tool[];
  /** 每个任务单独创建的工具，比如新建文档时要共享给当前群和发起人 */
  taskTools?: (task: TaskToolContext) => readonly Tool[];
  /** 只在这些群里响应。为空时不响应任何群。 */
  allowedChatIds: ReadonlySet<string>;
  /** 机器人在飞书里的名字（连上长连接后才拿得到），写进提示词 */
  botName: () => string | undefined;
  context: ThreadContextSource;
  /** 按群保存的长期记忆。不传时不带记忆，也没有记忆工具 */
  memory?: MemoryStore;
  tasks: TaskRegistry;
  send: (to: string, input: SendInput, opts?: SendOptions) => Promise<SendResult>;
  updateCard: (messageId: string, card: object) => Promise<void>;
  logger?: Logger;
  now?: () => number;
  /** 同一张进度卡片两次更新的最小间隔 */
  cardIntervalMs?: number;
}

/**
 * 处理一条已经过 SDK 安全管线的群消息（已去重、已确认 @ 了机器人、@ 占位符已替换成名字）：
 * 在话题里发一张进度卡片，带着话题上下文跑工具循环，结束后更新卡片并把回答发到话题里。
 */
export function createMessageHandler(deps: BotDeps) {
  const { allowedChatIds, tasks, send, logger = console } = deps;
  const duplicates = new DuplicateAsks(deps.now);

  return async (msg: NormalizedMessage): Promise<void> => {
    if (!allowedChatIds.has(msg.chatId)) {
      // 机器人可能也在告警群等业务群里，没加进白名单的群一律不回应，只在日志里打出 chat_id 方便加白
      logger.info(`忽略白名单外的群 chat=${msg.chatId}，要启用请把它加进 FEISHU_ALLOWED_CHAT_IDS 后重启`);
      return;
    }
    logger.info(`收到提问 chat=${msg.chatId} message=${msg.messageId} thread=${threadKeyOf(msg)} sender=${msg.senderId}`);

    // 话题里回复时勾了「同时发送到群」会收到两条一样的 @，只处理话题里那条，写操作不做两遍
    const verdict = duplicates.check(msg);
    if (verdict.action === "skip") {
      logger.info(`跳过重复的提问 message=${msg.messageId}：和 ${verdict.duplicateOf} 是同一个人几秒内发的同一句话（多半勾了「同时发送到群」）`);
      return;
    }
    if ("stopThreadKey" in verdict) {
      const stopped = tasks.stopThread(verdict.stopThreadKey);
      logger.info(
        `message=${msg.messageId} 和群里先到的 ${verdict.duplicateOf} 是同一句话，改为处理话题里这条，停掉副本的任务 ${stopped} 个`,
      );
    }

    const question = msg.content.trim();
    const reply = (markdown: string) =>
      send(msg.chatId, { markdown }, { replyTo: msg.messageId, replyInThread: true });

    if (STOP_COMMAND.test(question)) {
      // 在话题里说「停止」停这个话题的任务；在群里直接说则停这个群的所有任务
      const stopped = msg.rootId ? tasks.stopThread(threadKeyOf(msg)) : tasks.stopChat(msg.chatId);
      logger.info(`停止指令 message=${msg.messageId} 停止了 ${stopped} 个任务`);
      await reply(stopped > 0 ? "好的，已停止。" : "现在没有进行中的任务。");
      return;
    }
    if (!question && !msg.rootId) {
      await reply("在的，@ 我的时候带上问题或要做的事就行。");
      return;
    }

    await runTask(deps, msg, question, reply);
  };
}

async function runTask(
  deps: BotDeps,
  msg: NormalizedMessage,
  question: string,
  reply: (markdown: string) => Promise<SendResult>,
): Promise<void> {
  const { model, tools, tasks, send, updateCard, logger = console, now = Date.now, cardIntervalMs = 1000 } = deps;
  const task = tasks.create(msg.chatId, threadKeyOf(msg));
  const state: ProgressState = { phase: task.queued ? "queued" : "thinking", steps: [], startedAt: now() };
  const render = () => renderProgressCard(state, task.id, now());

  // 进度卡片发不出去（比如卡片格式被拒）不影响回答，只是看不到进度、不能点停止
  let card: CardUpdater | undefined;
  try {
    const { messageId } = await send(msg.chatId, { card: render() }, { replyTo: msg.messageId, replyInThread: true });
    card = new CardUpdater((next) => updateCard(messageId, next), logger, cardIntervalMs);
  } catch (err) {
    logger.error(`发送进度卡片失败 message=${msg.messageId}`, err);
  }

  let answer: string | undefined;
  let result: AgentResult | undefined;
  let source = "none";
  let memoryCount: number | undefined;
  try {
    if (!(await task.waitTurn())) {
      throw new Error("stopped while queued");
    }
    if (state.phase === "queued") {
      state.phase = "thinking";
      state.startedAt = now();
      card?.update(render());
    }

    const context = await deps.context.load(msg);
    source = context.source;
    const memory = await loadGroupMemory(deps, msg, context.askerName);
    memoryCount = memory?.count;
    const taskTools = [
      ...tools,
      ...(deps.taskTools?.({ chatId: msg.chatId, senderId: msg.senderId, messageId: msg.messageId }) ?? []),
      ...(memory?.tools ?? []),
    ];
    const prompt = labelUserMessage(context.askerName, question || "（@ 了你，没有写别的内容）");
    result = await runAgent({
      model,
      system: buildSystemPrompt({
        botName: deps.botName() || FALLBACK_BOT_NAME,
        now: new Date(now()),
        toolNames: taskTools.map((tool) => tool.spec.name),
        memory: memory?.prompt,
      }),
      messages: [...context.history, { role: "user", content: prompt }],
      tools: taskTools,
      signal: task.signal,
      onEvent: (event) => {
        logEvent(logger, msg.messageId, event);
        if (event.type !== "model") {
          applyEvent(state, event);
          card?.update(render());
        }
      },
    });
    answer = toReply(result.text, result.finish);
    state.phase = "done";
    deps.context.remember(msg, prompt, answer);
  } catch (err) {
    if (task.signal.aborted) {
      state.phase = "stopped";
    } else {
      logger.error(`处理失败 message=${msg.messageId}`, err);
      state.phase = "failed";
      answer = `抱歉，这次没能完成：${describeError(err)}。`;
    }
  }

  state.endedAt = now();
  for (const step of state.steps) {
    if (step.status === "running") {
      step.status = "error";
    }
  }
  try {
    await card?.finish(render(), renderPlainProgressCard(state, now()));
    if (answer !== undefined) {
      for (const chunk of splitMarkdown(answer, CHUNK_CHARS)) {
        await reply(chunk);
      }
    }
  } finally {
    tasks.finish(task);
  }
  logger.info(
    `${state.phase === "stopped" ? "已停止" : "已回复"} message=${msg.messageId} 上下文=${source} ` +
      `${memoryCount === undefined ? "" : `记忆=${memoryCount}条 `}` +
      `工具调用=${result?.toolCalls ?? state.steps.length} 用时=${state.endedAt - state.startedAt}ms`,
  );
}

/**
 * 读出这个群的记忆写进提示词，并给这次任务配一套只能读写这个群记忆的工具。
 * 读失败（比如磁盘出错）时这次任务不带记忆，照常回答。
 */
async function loadGroupMemory(deps: BotDeps, msg: NormalizedMessage, askerName: string | undefined) {
  const { memory: store, logger = console } = deps;
  if (!store) {
    return undefined;
  }
  try {
    const entries = await store.list(msg.chatId);
    const prompt = renderMemoryForPrompt(entries);
    const tools = createMemoryTools({
      store,
      chatId: msg.chatId,
      author: { name: askerName, openId: msg.senderId, messageId: msg.messageId },
      includeSearch: prompt.omitted > 0,
    });
    return { prompt, tools, count: entries.length };
  } catch (err) {
    logger.error(`读取群记忆失败 chat=${msg.chatId}，这次不带记忆`, err);
    return undefined;
  }
}

/** 每轮模型调用和每次工具调用各记一行，用来看一次回复的时间花在哪 */
function logEvent(logger: Logger, messageId: string, event: AgentEvent): void {
  if (event.type === "model") {
    const usage = event.usage
      ? ` 输入=${event.usage.input} 输出=${event.usage.output}${event.usage.reasoning ? ` 其中思考=${event.usage.reasoning}` : ""}`
      : "";
    const next = event.toolNames.length > 0 ? `调用 ${event.toolNames.join(", ")}` : "给出回答";
    logger.info(`模型第${event.round}轮 message=${messageId} 用时=${event.ms}ms${usage} → ${next}`);
  } else if (event.type === "tool_end") {
    if (event.ok) {
      logger.info(`工具 ${event.name} message=${messageId} 用时=${event.ms}ms`);
    } else {
      logger.warn(`工具 ${event.name} 失败 message=${messageId} 用时=${event.ms}ms：${event.error ?? "未知原因"}`);
    }
  }
}

function applyEvent(state: ProgressState, event: Exclude<AgentEvent, { type: "model" }>): void {
  if (event.type === "tool_start") {
    state.steps.push({ id: event.id, label: event.label, status: "running" });
    return;
  }
  const step = state.steps.find((s) => s.id === event.id && s.status === "running");
  if (step) {
    step.status = event.ok ? "ok" : "error";
  }
}

export interface CardActionDeps {
  tasks: TaskRegistry;
  allowedChatIds: ReadonlySet<string>;
  logger?: Logger;
}

/** 处理进度卡片上的按钮。停止后卡片由任务自己更新成「已停止」。 */
export function createCardActionHandler({ tasks, allowedChatIds, logger = console }: CardActionDeps) {
  return async (evt: CardActionEvent): Promise<void> => {
    const value = evt.action.value as { action?: unknown; task?: unknown } | undefined;
    if (value?.action !== STOP_ACTION || typeof value.task !== "string" || !allowedChatIds.has(evt.chatId)) {
      return;
    }
    const stopped = tasks.stop(value.task, evt.chatId);
    logger.info(`停止按钮 task=${value.task} operator=${evt.operator.openId} ${stopped ? "已停止" : "任务已经结束"}`);
  };
}

function toReply(text: string, finish: AgentResult["finish"]): string {
  if (finish === "filtered") {
    return "抱歉，这个问题被模型服务的内容审核拦下了，换个说法试试。";
  }
  if (finish === "length") {
    return `${text}\n\n（回答太长，后面被截断了）`;
  }
  return text || "（模型没有返回内容）";
}

/** 把调用模型的异常翻译成能发到群里的一句话，不带密钥等敏感信息。 */
function describeError(err: unknown): string {
  if (!(err instanceof LlmError)) {
    return "内部错误";
  }
  switch (err.kind) {
    case "auth":
      return "模型服务的 API Key 无效或没有权限";
    case "rate_limit":
      return "模型服务被限流了，请稍后再试";
    case "connection":
      return "连不上模型服务，请检查网络或 MODEL_BASE_URL";
    case "api":
      return "模型服务返回错误";
  }
}
