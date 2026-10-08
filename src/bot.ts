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
/** 提问里带这些词时，这次任务打开思考（默认关着，回答快一半） */
export const DEEP_THINKING = /深度思考|仔细(想|思考|分析)|认真(想|思考|分析)/;

export interface ThreadContextSource {
  load(msg: NormalizedMessage): Promise<ThreadContext>;
  remember(msg: NormalizedMessage, question: string, answer: string): void;
}

/** 按任务创建工具时用得上的信息 */
export interface TaskToolContext {
  chatId: string;
  /** 话题标识，见 threadKeyOf */
  threadKey: string;
  /** 发起人的 open_id */
  senderId: string;
  /** 发起人的名字，拿不到时为空 */
  askerName?: string;
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
  /** 配置的代码仓库（CODE_REPOS）。用来检查回答是不是没读代码就说了仓库里的内容 */
  codeRepos?: readonly string[];
  /** 能让机器人改文档、改代码的人（open_id）。不传时群里所有人都能 */
  writeAllowed?: ReadonlySet<string>;
  /** 通过 MCP 接入的工具（如 aiops）。每个任务单独一套，调用次数按任务算 */
  mcp?: {
    /** 配置的 MCP 服务名（如 aiops），工具名以「服务名_」开头 */
    readonly names: readonly string[];
    tools(task: TaskToolContext): readonly Tool[];
    /** 这些工具的使用说明，写进系统提示词。toolNames 是这次任务的全部工具名 */
    prompt(toolNames: readonly string[]): string | undefined;
  };
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
    const taskContext: TaskToolContext = {
      chatId: msg.chatId,
      threadKey: threadKeyOf(msg),
      senderId: msg.senderId,
      askerName: context.askerName,
      messageId: msg.messageId,
    };
    // MCP 工具的结果记下来：回答里引用的文件路径出现在这些结果里（比如 aiops 查到的报错堆栈），就不算没查证
    const evidence: string[] = [];
    const mcpTools = (deps.mcp?.tools(taskContext) ?? []).map(
      (tool): Tool => ({
        ...tool,
        run: async (args, ctx) => {
          const output = await tool.run(args, ctx);
          evidence.push(output);
          return output;
        },
      }),
    );
    const allTools = [...tools, ...(deps.taskTools?.(taskContext) ?? []), ...mcpTools, ...(memory?.tools ?? [])];
    // 不在写权限名单里的人：不给改文档、改代码的工具，模型想改也改不了
    const readOnly = deps.writeAllowed !== undefined && !deps.writeAllowed.has(msg.senderId) && allTools.some((tool) => tool.writes);
    const taskTools = readOnly ? allTools.filter((tool) => !tool.writes) : allTools;
    if (readOnly) {
      logger.info(`发起人不在写权限名单里，这次只给读的工具 message=${msg.messageId} sender=${msg.senderId}`);
    }
    const prompt = labelUserMessage(context.askerName, question || "（@ 了你，没有写别的内容）");
    const deep = DEEP_THINKING.test(question);
    if (deep) {
      logger.info(`这次打开深度思考 message=${msg.messageId}`);
    }
    const toolNames = taskTools.map((tool) => tool.spec.name);
    const reviews = [
      ...(taskTools.some((tool) => tool.spec.name.startsWith(CODE_TOOL_PREFIX))
        ? [reviewCodeAnswer(question, deps.codeRepos ?? [], (path) => evidence.some((output) => output.includes(path)))]
        : []),
      // 按配置的服务装，不看这次有没有工具：服务连不上时模型照样可能照搬话题里之前的数据
      ...(deps.mcp?.names.length ? [reviewOpsAnswer(question, deps.mcp.names, () => evidence.length > 0)] : []),
    ];
    result = await runAgent({
      model,
      ...(deep ? { thinking: true } : {}),
      system: buildSystemPrompt({
        botName: deps.botName() || FALLBACK_BOT_NAME,
        now: new Date(now()),
        toolNames,
        memory: memory?.prompt,
        readOnly,
        extra: deps.mcp?.prompt(toolNames),
      }),
      messages: [...context.history, { role: "user", content: prompt }],
      tools: taskTools,
      signal: task.signal,
      ...(reviews.length > 0
        ? {
            // 几项检查都没过时一起告诉模型：重做只有一次，只说一项的话，另一项重做后就没人查了
            review: (answer: string, usedTools: ReadonlySet<string>) =>
              reviews
                .map((review) => review(answer, usedTools))
                .filter(Boolean)
                .join("\n") || undefined,
          }
        : {}),
      onEvent: (event) => {
        logEvent(logger, msg.messageId, event);
        if (event.type === "tool_start" || event.type === "tool_end") {
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
  } else if (event.type === "retry") {
    logger.warn(`回答没通过检查，已让模型重做 message=${messageId}：${event.reason.slice(0, 60)}…`);
  } else if (event.type === "tool_end") {
    if (event.ok) {
      logger.info(`工具 ${event.name} message=${messageId} 用时=${event.ms}ms`);
    } else {
      logger.warn(`工具 ${event.name} 失败 message=${messageId} 用时=${event.ms}ms：${event.error ?? "未知原因"}`);
    }
  }
}

const CODE_TOOL_PREFIX = "code_";
/** 回答里像仓库文件路径的写法：至少一层目录加常见代码文件后缀，如 src/index.ts、internal/k8s/client.go */
const CODE_PATHS =
  /(?:^|[\s`'"(（:：])((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|go|py|java|kt|rs|rb|php|c|cc|cpp|h|hpp|cs|swift|vue|sql|sh|ya?ml|toml|proto))\b/g;
export const UNVERIFIED_CODE_ANSWER =
  "（系统检查）你的回答涉及代码仓库的内容，但这次一次代码工具都没调用，这些内容没有经过查证。" +
  "如果问题和配置的仓库有关，先用 code_list_files、code_search、code_read_file 查清楚，再只按查到的内容重新回答，写明文件和行号，查不到就直说；" +
  "如果和仓库无关，去掉没查证的文件路径后重新回答。不要提这段检查。";

/**
 * 模型不读代码就回答仓库的问题时（问题或回答提到了配置的仓库、或者回答里写了代码文件路径，这次却没调任何代码工具），
 * 让它先查再答。模型关着思考时容易照着常见的项目结构编出文件和行号。
 * seenInEvidence 认的文件路径不算：排查线上问题时文件和行号来自 aiops 查到的报错日志和堆栈，不是编的；
 * 只放过工具结果里真出现过的路径，回答里多写一个结果里没有的路径照样打回
 */
export function reviewCodeAnswer(question: string, repos: readonly string[], seenInEvidence: (path: string) => boolean = () => false) {
  return (answer: string, usedTools: ReadonlySet<string>): string | undefined => {
    if ([...usedTools].some((name) => name.startsWith(CODE_TOOL_PREFIX))) {
      return undefined;
    }
    const text = `${question}\n${answer}`.toLowerCase();
    const mentionsRepo = repos.some((repo) => {
      const full = repo.toLowerCase();
      const short = full.split("/").pop() ?? full;
      return text.includes(full) || (short.length >= 5 && text.includes(short));
    });
    const unverifiedPath = [...answer.matchAll(CODE_PATHS)].some((match) => !seenInEvidence(match[1]));
    return mentionsRepo || unverifiedPath ? UNVERIFIED_CODE_ANSWER : undefined;
  };
}

/**
 * 回答里像线上数据的写法：带秒的时间（15:39:19）、日期加时间（2026-10-08 15:39）、K8s Pod 名（gateway-api-6978f9454f-tnc56）、
 * 带单位的数量（47 条、93 个 Pod、95%、120ms、3.1 cores）、「没有报错」「无异常」这类结论
 */
const OPS_DATA = new RegExp(
  [
    String.raw`(?<!\d)\d{1,2}:\d{2}:\d{2}(?!\d)`,
    String.raw`\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}`,
    String.raw`\b[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8,10}-[a-z0-9]{5}\b`,
    String.raw`\d+(?:\.\d+)?\s*(?:条|次|%|ms|毫秒|cores?|核|[KMG]i?B|个?\s*(?:Pod|副本|实例|容器))`,
    String.raw`(?:没有|无|未)(?:查到|发现|明显|任何)?的?(?:报错|错误|异常|告警|重启)`,
  ].join("|"),
  "gi",
);

export function unverifiedOpsAnswer(servers: readonly string[]): string {
  const tools = servers.map((name) => `${name}_`).join("、");
  return (
    "（系统检查）你的回答里有线上数据或结论（具体时间、Pod 名、日志条数、「没有报错」这类），但这次没有成功调用过工具，这些内容没有经过查证。" +
    `问线上服务的情况，每次都要用 ${tools} 开头的工具重新查，话题里之前的回答只能当线索，不能照搬其中的数据。` +
    "先查，再只按这次查到的结果回答；这次没有这些工具或者调用失败了，就如实说明现在查不了，不要给出数据。" +
    "如果这个问题本来就不用查线上（比如解释概念、整理用户自己给的内容），照原来的意思再回答一次就行。不要提这段检查。"
  );
}

/**
 * 配了 MCP 服务（如 aiops）的任务里，模型没成功调过工具就给出时间、Pod 名、条数、「没有报错」这类线上数据时，让它先查再答。
 * 同一话题里接着问另一个服务时，模型容易照着上一次的回答编出日志和 Pod。
 * mcpSucceeded 说这次有没有 MCP 工具调用成功过：调用失败（超时、到上限、服务繁忙）不算查过。
 * 调过别的工具（读代码、读文档、搜索）的不管，数据可能来自那里；只调了群记忆工具的照样打回。
 * 提问里本来就有的数字和说法不算（比如让机器人润色一段带数字的文字）
 */
export function reviewOpsAnswer(question: string, servers: readonly string[], mcpSucceeded: () => boolean) {
  const prefixes = servers.map((name) => `${name}_`);
  return (answer: string, usedTools: ReadonlySet<string>): string | undefined => {
    const otherTools = [...usedTools].some((name) => !name.startsWith("memory_") && !prefixes.some((prefix) => name.startsWith(prefix)));
    if (mcpSucceeded() || otherTools) {
      return undefined;
    }
    const unverified = [...answer.matchAll(OPS_DATA)].some((match) => !question.includes(match[0]));
    return unverified ? unverifiedOpsAnswer(servers) : undefined;
  };
}

function applyEvent(state: ProgressState, event: Extract<AgentEvent, { type: "tool_start" | "tool_end" }>): void {
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
