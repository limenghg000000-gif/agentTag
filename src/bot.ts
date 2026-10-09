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
    // 记下这次成功跑完的工具和 MCP 工具的结果，检查回答时只认成功拿到的结果（调用失败、工具不存在都不算查过）。
    // 回答里引用的文件路径出现在 MCP 结果里（比如 aiops 查到的报错堆栈），就不算没查证
    const succeeded = new Set<string>();
    const evidence: string[] = [];
    const mcpTools = deps.mcp?.tools(taskContext) ?? [];
    const mcpNames = new Set(mcpTools.map((tool) => tool.spec.name));
    const allTools = [...tools, ...(deps.taskTools?.(taskContext) ?? []), ...mcpTools, ...(memory?.tools ?? [])].map(
      (tool): Tool => ({
        ...tool,
        run: async (args, ctx) => {
          const output = await tool.run(args, ctx);
          succeeded.add(tool.spec.name);
          if (mcpNames.has(tool.spec.name)) {
            evidence.push(output);
          }
          return output;
        },
      }),
    );
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
      ...(deps.mcp?.names.length ? [reviewOpsAnswer(question, deps.mcp.names, succeeded)] : []),
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
    if (deps.mcp?.names.length && result.finish !== "filtered" && blockUnverifiedOps(question, deps.mcp.names, succeeded, result.text, result.toolCalls > 0)) {
      logger.warn(`回答打回重做以后还是没查证就给出了线上数据，没有发出 message=${msg.messageId}`);
      answer = BLOCKED_OPS_ANSWER;
    }
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

// 回答里像线上数据的写法分三类，OPS_DATA 是三类合起来。打回重做（reviewOpsAnswer）三类都认；
// 重做后的最后一道检查（blockUnverifiedOps）：Pod 名、定位结果有就拦；时间一般也是有就拦，问的是时间本身（换算、时区、格式）时
// 只在问线上服务、回答又写成线上结论时才拦；数量这类只在回答写成线上结论时才拦。
// 定位结果和就绪数：2026-10-08 复测时，模型没调工具就照着话题里前两次的定位结果，编出 network-tester 在三个命名空间「1/1 就绪」让用户选

/** 带秒的时间（15:39:19）、日期加时间（2026-10-08 15:39） */
const OPS_TIME_PATTERNS = [
  String.raw`(?<!\d)\d{1,2}:\d{2}:\d{2}(?!\d)`,
  String.raw`\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}`,
];
/** 只在线上数据里出现的写法：K8s Pod 名（gateway-api-6978f9454f-tnc56）、「都有部署」「自动定位到」这类定位结果 */
const OPS_STRONG_PATTERNS = [
  String.raw`\b[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8,10}-[a-z0-9]{5}\b`,
  // 定位结果：「在多个命名空间都有部署」「default、kube-system 都有部署」「已自动定位到 prod」
  String.raw`都有部署|自动定位到`,
];
/** 概念解释、单位换算里也常见的写法：带单位的数量（47 条、95%、120ms、3.1 cores）、就绪数（1/1 就绪）、「多个命名空间」、「没有报错」「没有 error 级别日志」 */
const OPS_WEAK_PATTERNS = [
  String.raw`\d+(?:\.\d+)?\s*(?:条|次|%|ms|毫秒|cores?|核|[KMG]i?B|个?\s*(?:Pod|副本|实例|容器))`,
  // 中间可能夹着 Markdown 的加粗、行内代码：**1/1** 就绪、Ready: `4/4`
  String.raw`\d+\s*/\s*\d+[*_\x60\s]*(?:就绪|ready|running|副本)`,
  String.raw`(?:就绪|ready)[*_\x60\s]*[:：]?[*_\x60\s]*\d+\s*/\s*\d+`,
  String.raw`多个命名空间`,
  // 英文要带上级别、日志这类词，「Rust 没有 exception 机制」不算
  String.raw`(?:没有|无|未)(?:查到|发现|明显|任何)?的?\s*(?:报错|错误|异常|告警|重启|(?:error|exception|panic|fatal)\s*(?:级别|日志|记录))`,
];
const OPS_DATA = new RegExp([...OPS_TIME_PATTERNS, ...OPS_STRONG_PATTERNS, ...OPS_WEAK_PATTERNS].join("|"), "gi");
const OPS_TIME = new RegExp(OPS_TIME_PATTERNS.join("|"), "gi");
const OPS_STRONG = new RegExp(OPS_STRONG_PATTERNS.join("|"), "gi");
const OPS_WEAK = new RegExp(OPS_WEAK_PATTERNS.join("|"), "gi");
/**
 * 按提示词写成的线上结论带着把握：「结论：…（把握：中）」。只认把握：「先给结论」是所有回答的写法，
 * 「结论：1GiB = 1024MiB」不算；「把握好内存 limit」「把握高峰期」这类说法也不算
 */
const OPS_CONCLUSION = /把握[*_\x60\s]*[:：]?[*_\x60\s]*[高中低]等?(?![\u4e00-\u9fff])/;
/** 问的就是时间本身：提问里带着时间，或者说到换算、时区、时间戳、格式。回答里的时间是算出来或者举例的（「UTC 08:00:00 是北京时间几点」答「16:00:00」） */
const TIME_QUESTION = /(?<!\d)\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|时间戳|timestamp|时区|time\s*zone|utc|gmt|换算|转换|格式|format|strftime|strptime/i;
/** Go 的时间格式样例，讲时间格式时常出现，不是线上的时间 */
const TIME_LAYOUT = /2006-01-02|15:04:05/;

/**
 * 提问像是在问线上服务：带连字符的服务名（network-tester、product-service-api），或者说到日志、告警、Pod、重启、指标这类。
 * 宽一点没关系：只有一个工具都没成功调过的回答才会因为它多重做一次，确实不用查的，模型照原来的意思再答一次
 */
const OPS_QUESTION = /[a-z][a-z0-9]*(?:-[a-z0-9]+)+|日志|报错|告警|异常|pod|重启|崩溃|oom|cpu|内存|超时|5xx|诊断|排查|命名空间|namespace|副本|链路|指标|监控/i;

export function unverifiedOpsAnswer(servers: readonly string[]): string {
  const tools = servers.map((name) => `${name}_`).join("、");
  return (
    "（系统检查）这个问题像是在问线上服务，或者你的回答里有线上的情况（命名空间候选、具体时间、Pod 名、日志条数、「没有报错」这类），但这次没有成功调用过工具，没有经过查证。" +
    `问线上服务的情况，每次都要用 ${tools} 开头的工具重新查，话题里之前的回答只能当线索，不能照搬其中的命名空间、Pod 和数据。` +
    "先查，再只按这次查到的结果回答；这次没有这些工具或者调用失败了，就如实说明现在查不了，不要给出数据。" +
    "如果这个问题本来就不用查线上（比如解释概念、整理用户自己给的内容），照原来的意思再回答一次就行。不要提这段检查。"
  );
}

/**
 * 配了 MCP 服务（如 aiops）的任务里，模型一个工具都没成功调过，提问又像在问线上服务，或者回答里有时间、Pod 名、条数、
 * 「没有报错」这类线上数据时，让它先查再答。
 * 同一话题里接着问另一个服务时，模型容易照着之前的回答编：2026-10-08 先是照搬了别的服务的日志和 Pod，
 * 后来又照着前两次的定位结果编出了命名空间候选。只认回答的写法总会漏掉新的编法，所以提问像线上问题就要求查过。
 * succeeded 是这次成功跑完的工具：调用失败（超时、到上限、服务繁忙、工具不存在）不算查过。
 * 成功调过别的工具（读代码、读文档、搜索）的不管，数据可能来自那里；只调了群记忆工具的照样打回。
 * 提问里本来就有的数字和说法不算（比如让机器人润色一段带数字的文字）
 */
export function reviewOpsAnswer(question: string, servers: readonly string[], succeeded: ReadonlySet<string>) {
  return (answer: string): string | undefined => {
    if (checkedLive(servers, succeeded)) {
      return undefined;
    }
    return OPS_QUESTION.test(question) || hasUnverified(OPS_DATA, question, answer) ? unverifiedOpsAnswer(servers) : undefined;
  };
}

/**
 * 只是整理话题里之前的回答（「总结一下上面查到的情况」「翻译成英文」），内容不用重新查。用户自己给的文字不用靠这条，提问里有的数字本来就不算。
 * 要指着之前的内容，或者没提服务、日志这类线上对象；带着「重新」「现在」「排查」这类词的还是要查
 * （「别总结旧的，重新排查」「排查 gateway-api 最近一小时的报错并总结原因」）。「排查结果」「查到的」这类说的是之前查过的，不算
 */
const REWRITE_REQUEST = /总结|整理|汇总|归纳|概括|润色|翻译|改写|复述/;
// 「以上」「之前」「刚才」也用来说数量和时间（「5 分钟以上的慢请求」「刚才的报错」「这段时间」），要跟着内容、结果这类词才算
const EARLIER_CONTENT =
  /上面|上述|你的回答|这段(?!时间)|(?:以上|前面|之前|刚才|刚刚)(?:查到|说|聊|讲|提到|的(?:回答|结果|内容|情况|信息|结论)|内容|信息|结果|情况|结论)/;
const LIVE_REQUEST = /重新|再查|再看|现在|目前|最新|实时|查一下|查查|(?:排查|诊断|查询|检查|定位)(?!结果|过程|情况|结论|记录|报告|出|到|的)/;
/** 说工具调用失败的那一句（「aiops 连续 3 次查询都超时」），这句里的次数说的是调用本身 */
const TOOL_FAILURE_CLAUSE = /(?:aiops|工具|调用|查询)[^，,。；;\n]{0,12}(?:超时|失败|出错|连不上|繁忙)/i;

export const BLOCKED_OPS_ANSWER =
  "这次没能给出结论：回答里有线上的数据，但这次一个工具都没有成功调用过，这些数据没有经过查证，为免误导没有发出来。请再问一次。";

/**
 * 打回重做以后还是没查证就给出线上数据时，这个回答不发出去，换成 BLOCKED_OPS_ANSWER。
 * 2026-10-08 复测：用户回了「prod」以后模型两次都没调工具，第二次打回重做后照样编出了三次查询的结果。
 * Pod 名、定位结果这类只在线上数据里出现的，有就拦；带秒的时间也拦，问的是时间换算、时区、格式时，只在问线上服务又写成线上结论时才拦。
 * 数量、就绪数、「没有报错」这类概念解释里也常见的，只在写成线上结论（带「把握：中」这类把握）时才拦，
 * 「结论：1GiB = 1024MiB」「Go 没有异常机制」「北京时间为 16:00:00」照常发。
 * 只是整理之前回答的请求放行（数据来自话题里之前的回答）。调过工具都失败了时，说调用失败的那一句不算，剩下的照样查。
 * attempted 是这次有没有调过工具，不管成没成功
 */
export function blockUnverifiedOps(
  question: string,
  servers: readonly string[],
  succeeded: ReadonlySet<string>,
  answer: string,
  attempted = false,
): boolean {
  if (checkedLive(servers, succeeded) || rewriteOnly(question)) {
    return false;
  }
  const text = attempted ? withoutToolFailures(answer) : answer;
  const live = (pattern: RegExp) => hasUnverified(pattern, question, text);
  const conclusion = OPS_CONCLUSION.test(answer);
  const liveTime = !TIME_QUESTION.test(question) || (conclusion && OPS_QUESTION.test(question));
  return live(OPS_STRONG) || (liveTime && live(OPS_TIME)) || (conclusion && live(OPS_WEAK));
}

function rewriteOnly(question: string): boolean {
  return REWRITE_REQUEST.test(question) && !LIVE_REQUEST.test(question) && (EARLIER_CONTENT.test(question) || !OPS_QUESTION.test(question));
}

/** 去掉说工具调用失败的分句；分句里除了「N 次」还有别的数据（「查询返回 50 条请求超时」）就留着 */
function withoutToolFailures(answer: string): string {
  return answer
    .split(/(?<=[，,。；;\n])/)
    .filter((clause) => !(TOOL_FAILURE_CLAUSE.test(clause) && !hasUnverified(OPS_DATA, "", clause.replace(/\d+\s*次/g, ""))))
    .join("");
}

/** 成功调过 MCP 工具，或者成功调过群记忆以外的别的工具，都算有依据 */
function checkedLive(servers: readonly string[], succeeded: ReadonlySet<string>): boolean {
  const prefixes = servers.map((name) => `${name}_`);
  return [...succeeded].some((name) => !name.startsWith("memory_") || prefixes.some((prefix) => name.startsWith(prefix)));
}

function hasUnverified(pattern: RegExp, question: string, answer: string): boolean {
  return [...answer.matchAll(pattern)].some((match) => !inQuestion(question, match[0]) && !TIME_LAYOUT.test(match[0]));
}

/** 提问里本来就有的说法：不分大小写、不管空格；就绪数只看比值（问「READY 1/2 是什么意思」，答「1/2 Ready 表示…」） */
function inQuestion(question: string, text: string): boolean {
  const compact = (value: string) => value.replace(/\s+/g, "").toLowerCase();
  const ratio = /(\d+)\s*\/\s*(\d+)/.exec(text);
  return compact(question).includes(compact(text)) || (ratio !== null && new RegExp(`(?<!\\d)${ratio[1]}/${ratio[2]}(?!\\d)`).test(compact(question)));
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
