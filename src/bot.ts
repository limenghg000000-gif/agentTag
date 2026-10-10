import { posix } from "node:path";
import type { CardActionEvent, NormalizedMessage, SendInput, SendOptions, SendResult } from "@larksuiteoapi/node-sdk";
import { type AgentEvent, type AgentResult, MAX_TOOL_OUTPUT_CHARS, runAgent } from "./agent.js";
import { DuplicateAsks } from "./duplicates.js";
import { imageKeysOf } from "./feishu.js";
import { type ImageRef, labelUserMessage, type Logger, type ThreadContext, threadKeyOf } from "./history.js";
import { inlineImages, pickImages } from "./images.js";
import { type ChatMessage, type ChatModel, LlmError } from "./llm.js";
import { splitMarkdown } from "./markdown.js";
import { type MemoryStore, renderMemoryForPrompt } from "./memory.js";
import {
  CardUpdater,
  type ProgressState,
  type ProgressStep,
  renderPlainProgressCard,
  renderProgressCard,
  STOP_ACTION,
} from "./progress.js";
import { buildSystemPrompt } from "./prompt.js";
import type { TaskRegistry } from "./tasks.js";
import { createMemoryTools } from "./tools/memory.js";
import { type CodeFact, type Tool, ToolError } from "./tools/tool.js";

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
const DOC_TARGET = String.raw`(?:飞书|云)?\s*(?:文档|docx|docs?\b|wiki|知识库)`;
/**
 * 要新建文档：「写成文档」「整理到飞书文档里」「起草一份文档」「建个 doc」「新建文档」「写文档」「记到知识库」。没说的不给新建文档的工具。
 * 说的是已有的文档不算：「总结一下这篇文档」「写一下这篇文档的摘要」「写文档的人是谁」「整理一下这几篇文档」
 */
const DOC_REQUEST = new RegExp(
  [
    String.raw`(?:写|建|创建|新建|生成|做|出|弄|搞|起草|草拟|拟|撰写|准备|整理|汇总|总结|记|存|放|保存|沉淀|输出|导出|发)` +
      String.raw`[^，。,.!?！？\n]{0,8}?(?<![这那该此本每几各])(?:成|到|进|入|在|一[份篇个]?|个|份|篇)\s*(?:一[份篇个])?\s*(?:新的?)?\s*${DOC_TARGET}`,
    String.raw`(?:新建|创建|建|起草|生成|撰写|写)\s*${DOC_TARGET}(?![的里中内])`,
  ].join("|"),
  "i",
);

/**
 * 这次要不要新建文档。也看话题里刚说的：上一条回答在问话（「要整理成飞书文档吗？」「标题叫什么？」），
 * 而这条回答或者它前面那条提问说到了写文档，接着回的「好，建吧」「叫周报」也算。上一条回答已经建好了文档（不是在问话）就不算
 */
function docRequested(question: string, history: readonly ChatMessage[]): boolean {
  if (DOC_REQUEST.test(question)) {
    return true;
  }
  const reply = history.at(-1);
  if (reply?.role !== "assistant" || !/[？?]\s*$/.test(reply.content.trim())) {
    return false;
  }
  const asked = history.slice(0, -1).reverse().find((m) => m.role === "user");
  return DOC_REQUEST.test(reply.content) || (asked !== undefined && DOC_REQUEST.test(asked.content));
}

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
  /** 进度卡片上显示模型每轮的思考（SHOW_THINKING）。不传时显示 */
  showThinking?: boolean;
  /** 配置的代码仓库（CODE_REPOS）。用来检查回答是不是没读代码就说了仓库里的内容 */
  codeRepos?: readonly string[];
  /** 能让机器人改文档、改代码的人（open_id）。不传时群里所有人都能 */
  writeAllowed?: ReadonlySet<string>;
  /** 把提问和话题里的图片识别成文字。不传时图片换成「没能看到」的说明 */
  images?: { read(refs: readonly ImageRef[], signal?: AbortSignal): Promise<ReadonlyMap<string, string>> };
  /** 通过 MCP 接入的工具（如 aiops）。每个任务单独一套，调用次数按任务算 */
  mcp?: {
    /** 配置的 MCP 服务名（如 aiops），工具名以「服务名_」开头 */
    readonly names: readonly string[];
    tools(task: TaskToolContext): readonly Tool[];
    /** 这些工具的使用说明，写进系统提示词。toolNames 是这次任务的全部工具名 */
    prompt(toolNames: readonly string[]): string | undefined;
    /** 调过这个工具以后，这次任务后面几轮打开思考 */
    thinksAfter?(name: string): boolean;
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
    // 主模型只看文字：图片先识别成文字再放进提问和上文。2026-10-09 有人贴告警截图问「这个线上报警是咋回事」，
    // 模型只看到一行图片编号，自己挑了别的服务去查
    const images = await readImages(deps, msg, context, task.signal, state, () => card?.update(render()));
    const known = new Set([...imageKeysOf(msg), ...(context.images ?? []).map((ref) => ref.imageKey)]);
    const asked = inlineImages(question, images, known);
    const history = context.history.map((m) => (m.role === "user" ? { ...m, content: inlineImages(m.content, images, known) } : m));
    const memory = await loadGroupMemory(deps, msg, context.askerName);
    memoryCount = memory?.count;
    const taskContext: TaskToolContext = {
      chatId: msg.chatId,
      threadKey: threadKeyOf(msg),
      senderId: msg.senderId,
      askerName: context.askerName,
      messageId: msg.messageId,
    };
    // 记下这次成功跑完的工具和它们的结果，检查回答时只认成功拿到的结果（调用失败、工具不存在都不算查过）。
    // 回答里引用的文件路径、行号、提交号要查到过（代码工具查到的代码位置，或者 aiops 查到的报错堆栈里写着），才算查证过
    const succeeded = new Set<string>();
    const attempted = new Set<string>();
    const evidence: ToolEvidence[] = [];
    const mcpTools = deps.mcp?.tools(taskContext) ?? [];
    const allTools = [...tools, ...(deps.taskTools?.(taskContext) ?? []), ...mcpTools, ...(memory?.tools ?? [])].map(
      (tool): Tool => ({
        ...tool,
        run: async (args, ctx) => {
          // 剧本这类说明不是查到的数据：不算查过线上，里面举例的路径（/build/internal/cache/map.go:42）也不能拿来当证据
          if (tool.instructionsOnly) {
            return tool.run(args, ctx);
          }
          attempted.add(tool.spec.name);
          const code = isCodeTool(tool.spec.name);
          let facts: CodeFact[] = [];
          let output: string;
          try {
            output = await tool.run(args, { ...ctx, onFacts: (found) => (facts = [...facts, ...found]) });
          } catch (err) {
            // 代码工具找到了文件、只是读不了（太大、二进制）：报错里带着这个文件，算查到了路径，不算查到哪一行
            if (err instanceof ToolError) {
              evidence.push({ tool: tool.spec.name, facts: err.facts });
            }
            throw err;
          }
          succeeded.add(tool.spec.name);
          // 和 runAgent 交给模型时一样截短：截断处以后的模型没看到，不算
          const limit = tool.maxOutputChars ?? MAX_TOOL_OUTPUT_CHARS;
          evidence.push(
            code
              ? { tool: tool.spec.name, facts: output.length <= limit ? facts : facts.filter((fact) => fact.at <= limit) }
              : { tool: tool.spec.name, output: seenByModel(output, limit) },
          );
          return output;
        },
      }),
    );
    // 不在写权限名单里的人：不给改文档、改代码的工具，模型想改也改不了
    const readOnly = deps.writeAllowed !== undefined && !deps.writeAllowed.has(msg.senderId) && allTools.some((tool) => tool.writes);
    // 没说要文档时不给新建文档的工具：2026-10-09 复测时，只说了「把上面的排查结果总结一下」，模型就自己建了一篇飞书文档
    const createDoc = docRequested(question, context.history);
    const taskTools = allTools.filter((tool) => !(readOnly && tool.writes) && (createDoc || tool.spec.name !== "feishu_doc_create"));
    if (readOnly) {
      logger.info(`发起人不在写权限名单里，这次只给读的工具 message=${msg.messageId} sender=${msg.senderId}`);
    }
    const prompt = labelUserMessage(context.askerName, asked || "（@ 了你，没有写别的内容）");
    const deep = DEEP_THINKING.test(question);
    if (deep) {
      logger.info(`这次打开深度思考 message=${msg.messageId}`);
    }
    const toolNames = taskTools.map((tool) => tool.spec.name);
    const hasCodeTools = taskTools.some((tool) => tool.spec.name.startsWith(CODE_TOOL_PREFIX));
    const seen = codeEvidence(deps.codeRepos ?? [], evidence);
    const reviews = [
      ...(hasCodeTools ? [reviewCodeAnswer(asked, deps.codeRepos ?? [], seen)] : []),
      // 按配置的服务装，不看这次有没有工具：服务连不上时模型照样可能照搬话题里之前的数据
      ...(deps.mcp?.names.length ? [reviewOpsAnswer(asked, deps.mcp.names, succeeded)] : []),
      ...(hasCodeTools ? [reviewDeflectedAnswer(deps.mcp?.names ?? [], attempted)] : []),
    ];
    const thinksAfter = deps.mcp?.thinksAfter?.bind(deps.mcp);
    // 最近一次模型调用是第几轮：打回重做（retry）紧跟在给出那版回答的这一轮后面
    let lastRound = 0;
    result = await runAgent({
      model,
      ...(deep ? { thinking: true } : {}),
      ...(thinksAfter ? { thinkAfter: thinksAfter } : {}),
      system: buildSystemPrompt({
        botName: deps.botName() || FALLBACK_BOT_NAME,
        now: new Date(now()),
        toolNames,
        memory: memory?.prompt,
        readOnly,
        extra: deps.mcp?.prompt(toolNames),
      }),
      messages: [...history, { role: "user", content: prompt }],
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
        if (event.type === "model") {
          lastRound = event.round;
        }
        if (event.type === "tool_start" || event.type === "tool_end") {
          applyEvent(state, event);
          card?.update(render());
        } else if (event.type === "model" && event.reasoning && deps.showThinking !== false) {
          (state.thoughts ??= []).push({ round: event.round, ms: event.ms, text: event.reasoning, at: state.steps.length });
          card?.update(render());
        } else if (event.type === "retry" && state.thoughts?.some((thought) => thought.round === lastRound)) {
          // 被打回的那版回答是紧挨着的上一轮想出来的，多半就是没查证的说法：重做通过以后卡片上也不留这一轮的思考
          state.thoughts = state.thoughts.filter((thought) => thought.round !== lastRound);
          card?.update(render());
        }
      },
    });
    answer = toReply(result.text, result.finish);
    let blockedCode = false;
    if (deps.mcp?.names.length && result.finish !== "filtered" && blockUnverifiedOps(asked, deps.mcp.names, succeeded, result.text, result.toolCalls > 0)) {
      logger.warn(`回答打回重做以后还是没查证就给出了线上数据，没有发出 message=${msg.messageId}`);
      answer = BLOCKED_OPS_ANSWER;
    }
    if (hasCodeTools && result.finish !== "filtered" && answer !== BLOCKED_OPS_ANSWER) {
      // 打回重做时群成员自己写的路径不算查证（要模型先去读代码）；重做以后照着提问复述一遍（「order.go:88 所在的服务读不到」）不拦。
      // 这次读过代码、或者问的是配置的仓库时，回答里每个路径都得是真的；不然只拦带行号的，举例写的路径（「可以写在 k8s/deployment.yaml 里」）照常发
      const userText = [asked, ...history.flatMap((m) => (m.role === "user" ? [m.content] : []))].join("\n");
      const repos = deps.codeRepos ?? [];
      const investigating = [...attempted].some(isCodeTool) || mentionsRepo(`${asked}\n${result.text}`, repos);
      // 群成员写成「仓库名/路径」（ai/aiops-mcp/src/foo.ts，仓库名不分大小写）、回答里写 src/foo.ts 的也算照着复述。
      // 仓库名要在路径开头：vendor/ai/aiops-mcp/src/foo.ts、node_modules/@ai/aiops-mcp/src/foo.ts 都不是这个仓库里的 src/foo.ts
      // 一次替换完：去掉一个仓库名以后，后面紧跟着的另一个仓库名（ai/aiops-mcp/ai/agent-tag/src/foo.ts）不能再当成路径开头去掉；
      // 仓库名互相包含时去掉最长的那个（长的排前面），和 codeEvidence 一样；前面的 ./、/ 一起去掉（./ai/aiops-mcp/src/foo.ts），和 repoPath 一样
      const longestFirst = [...repos].sort((a, b) => b.length - a.length).map(escapeRegExp);
      const unprefixed =
        repos.length === 0 ? userText : userText.replace(new RegExp(`${NOT_GLUED}(?:\\.?\\/+)?(?:${longestFirst.join("|")})/`, "gi"), " ");
      // 带行号的要群成员写的也是这一行（问的是 src/foo.ts，回答写 src/foo.ts:99 不算照着复述）
      const inQuestion = (text: string, line?: number) =>
        [userText, unprefixed].some((said) => (line === undefined ? mentions(said, text) : mentionsLine(said, text, line)));
      const unseen = unseenCodeCitations(result.text, (text, line, branch, sentence) => seen(text, line, branch, sentence) || inQuestion(text, line)).filter(
        (cite) => cite.located || investigating,
      );
      if (unseen.length > 0) {
        logger.warn(`回答打回重做以后还是引用了没查到的代码位置，没有发出 message=${msg.messageId}：${unseen.map((cite) => cite.text).join("、")}`);
        answer = blockedCodeAnswer(deps.codeRepos ?? []);
        blockedCode = true;
      }
    }
    // 回答因为没查证被拦下时，思考里多半也是这些没查证的说法，卡片上不再留着；被模型服务的内容审核拦下时也一样
    if (answer === BLOCKED_OPS_ANSWER || blockedCode || result.finish === "filtered") {
      state.thoughts = undefined;
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
 * 识别提问和话题上文里的图片，返回 image_key → 文字。识别时进度卡片上多一步「识别图片」。
 * 没配看图模型、或者一张都没识别出来时返回空的，图片在提问里换成「没能看到」的说明
 */
async function readImages(
  deps: BotDeps,
  msg: NormalizedMessage,
  context: ThreadContext,
  signal: AbortSignal,
  state: ProgressState,
  refresh: () => void,
): Promise<ReadonlyMap<string, string>> {
  const { logger = console, now = Date.now } = deps;
  const asked = imageKeysOf(msg).map((imageKey) => ({ messageId: msg.messageId, imageKey }));
  const historyText = context.history.flatMap((m) => (m.role === "user" ? [m.content] : [])).join("\n");
  const refs = pickImages(asked, context.images ?? [], historyText);
  if (refs.length === 0) {
    return new Map();
  }
  if (!deps.images) {
    logger.info(`提问或话题里有 ${refs.length} 张图片，没配看图模型（MODEL_VISION_ID），图片内容没有交给模型 message=${msg.messageId}`);
    return new Map();
  }
  const step: ProgressStep = { id: "images", label: `识别图片（${refs.length} 张）`, status: "running" };
  state.steps.push(step);
  refresh();
  const startedAt = now();
  const results = await deps.images.read(refs, signal);
  step.status = results.size > 0 ? "ok" : "error";
  refresh();
  logger.info(`识别图片 ${results.size}/${refs.length} 张 用时=${now() - startedAt}ms message=${msg.messageId}`);
  return results;
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
    const think = event.thinking ? " 思考=开" : "";
    logger.info(`模型第${event.round}轮 message=${messageId} 用时=${event.ms}ms${think}${usage} → ${next}`);
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
/**
 * 路径和前后文字的分界：空白、引号、括号、Markdown 的 * 和 |、, ; = : #、中文标点、汉字和假名、全角字符、各种符号和 emoji
 * （# ; , ' 和括号夹在路径字符中间时除外，见 SOFT_DELIM）。
 * 别的字符都算路径的一部分（字母数字和 . _ - / @ + ! ~ $ % \ 等，Go 模块的 @ 和 !、pnpm 的 +）：
 * 不一个个列路径里能有什么字符，没想到的字符也算在路径里，紧挨着它的是一个更长的路径的一截（pkg$v1/src/foo.ts 不是 v1/src/foo.ts）
 */
const PATH_DELIM = "\\s\"'`()\\[\\]<>{}*|,;=:#\\u2010-\\u2027\\u2190-\\u2bff\\u3000-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef\\ud800-\\udfff";
/** 路径里的一个字符：前面紧挨着这样的字符的，是一个更长的路径的后半截 */
const PATH_CHAR = `[^${PATH_DELIM}]`;
/**
 * 分界字符里，Git 文件名里也常有的 # ; , ' 和括号：一个或连着几个，两边都紧挨着路径字符时是路径的一部分
 * （pkg#v1/src/foo.ts、Next.js 的 app/(auth)/login/page.tsx、app/[[...slug]]/page.tsx），不然是分界（(src/a.ts)、src/a.ts#L3、'src/a.ts'）。
 * = 和 : 一直是分界：日志里的 caller=src/a.ts:3、"file":"src/a.ts" 要能认出 src/a.ts
 */
const SOFT_DELIM = "#;,'()\\[\\]{}";
/** 两边都紧挨着路径字符（中间可以隔着别的 SOFT_DELIM 字符）、算路径一部分的 SOFT_DELIM 字符 */
const GLUED = `(?<=${PATH_CHAR}[${SOFT_DELIM}]*)[${SOFT_DELIM}](?=[${SOFT_DELIM}]*${PATH_CHAR})`;
/** 路径从这儿开始：前面没有紧挨着路径字符，也没有紧挨着跟在路径字符后面的 SOFT_DELIM 字符（pkg#v1/src/foo.ts、pkg##v1/src/foo.ts 里的 v1/src/foo.ts 不是开头） */
const NOT_GLUED = `(?<!${PATH_CHAR}[${SOFT_DELIM}]*)`;
/** 目录名、文件名里的一个字符 */
const NAME_CHAR = `(?:[^${PATH_DELIM}/]|${GLUED})`;
/**
 * 路径到这儿完了：后面是分界字符或者到头了；中间可以隔着句号、叹号、问号这些标点（src/a.ts。src/a.ts!）。
 * 后面紧挨着的 SOFT_DELIM 字符接着的是更深的路径时（src/a.ts#v2/b.ts、src/a.ts,src/b.ts）没完，是一个更长的路径的前半截；
 * 只是行号、参数的照样算完了（src/a.ts#L3、PHP 堆栈的 /app/src/a.php(12)）
 */
const PATH_END = `(?=$|[${PATH_DELIM}]|[.!?]+(?:$|[${PATH_DELIM}]))(?![${SOFT_DELIM}]+(?=${PATH_CHAR})(?:${NAME_CHAR})*\\/)`;
/**
 * 回答里像仓库文件路径的写法：至少一层目录加常见代码文件后缀，如 src/index.ts、internal/k8s/client.go。
 * 按整段路径认（pkg@v1/src/foo.ts、pkg$v1/src/foo.ts、pkg#v1/src/foo.ts 不拿后半截 v1/src/foo.ts 充数）；
 * 后面紧挨着路径字符的不是代码文件（src/foo.ts@backup、a.ts.map），~ 开头的是家目录下的文件（~/.config/x.yaml）
 */
const CODE_EXT = "(?:ts|tsx|js|jsx|mjs|go|py|java|kt|rs|rb|php|c|cc|cpp|h|hpp|cs|swift|vue|sql|sh|ya?ml|toml|proto)";
const CODE_PATHS = new RegExp(`${NOT_GLUED}(?!~)((?:${NAME_CHAR}+\\/)+${NAME_CHAR}+\\.${CODE_EXT})${PATH_END}`, "g");
/**
 * 反引号、加粗、引号里带空格的路径（`src/my files/app.ts:12`、**src/my files/app.ts**:12、"src/my files/app.ts":12）：
 * CODE_PATHS 只认得出空格后面那段，这种先按整段认（见 unseenCodeCitations）。目录和文件名里能有的字符和 CODE_PATHS 一样，
 * 词之间可以是连着几个空格、制表符、全角空格；后面是收尾的符号，或者 LINE_AFTER_PATH 认的行号写法（:12、：12、#L12、 第 12 行）
 */
const SPACED_CODE_PATHS = new RegExp(
  `(?<=[\`*"“「『])((?:${NAME_CHAR}+(?:[^\\S\\r\\n]+${NAME_CHAR}+)*\\/)+${NAME_CHAR}+(?:[^\\S\\r\\n]+${NAME_CHAR}+)*\\.${CODE_EXT})(?=[\`*"”」』:：#]|\\s*(?:的)?\\s*第\\s*\\d)`,
  "g",
);
/**
 * Markdown 的下划线、删除线包着的路径（_src/a.ts_:12、__src/a.ts__、~~src/a.ts~~，中间也可以带空格）：_ 和 ~ 也是路径字符，
 * CODE_PATHS 会把两头的符号算进路径里、认不出来。前面是分界、两头是一样的一对符号时，中间按一整段路径认（见 unseenCodeCitations）
 */
const WRAPPED_CODE_PATHS = new RegExp(
  `(?<=(?:^|[${PATH_DELIM}])([_~]{1,2}))(?![_~])((?:${NAME_CHAR}+(?:[^\\S\\r\\n]+${NAME_CHAR}+)*\\/)+${NAME_CHAR}+(?:[^\\S\\r\\n]+${NAME_CHAR}+)*\\.${CODE_EXT})` +
    `(?=\\1(?:$|[${PATH_DELIM}]|[.!?]+(?:$|[${PATH_DELIM}])))`,
  "g",
);
/**
 * 回答里明说是 Git 分支的路径（分支名可以长得像路径）：前面写着「切到」「切换到」「checkout」「on/to branch」「分支：」「branch:」，
 * 或者后面跟着「分支」「branch」再接「上」「@」、标点或者到头了，或者后面跟着「@ 提交号」，
 * 如「`feature/foo.ts` 分支上」「on the `feature/foo.ts` branch.」「切到 feature/foo.ts」「feature/foo.ts @ 3f2a1c9」。
 * 「分支」「branch」也常说代码里的分支（src/a.ts 分支覆盖率、分支逻辑、branch condition、分支 src/a.ts 里），这些不算
 */
const BRANCH_BEFORE = /(?:(?:切到|切换到)\s*(?:分支)?|\bcheckout|\b(?:on|to)\s+branch|(?:分支|\bbranch)\s*[:：])\s*[`'"“「*]*$/i;
const BRANCH_AFTER =
  /^[`'"”」*]*\s*(?:(?:分支|branch\b)(?=\s*(?:$|@|上|[，。、；：！？,;:?）)」』"'`*]|[.!](?!\w)))|@\s*[0-9a-f]{7,40}(?![0-9a-z]))/i;
/**
 * 路径后面跟着的行号：internal/k8s/client.go:35、:140-146（取第一行）、#L12、 第 35 行；
 * 中间可以隔着 Markdown 的收尾符号：`src/foo.ts`:99、**src/foo.ts**:99、「src/foo.ts」第 99 行
 */
const LINE_AFTER_PATH = /^[`*_~'"”」』]*(?:[:：]\s*(\d+)|#L(\d+)|\s*(?:的)?\s*第\s*(\d+))/;
/** 回答里写的提交号：「master 分支 @ 3f2a1c9」「提交 3f2a1c9」「commit **3f2a1c9**」，7～40 位十六进制，字母和数字都有；前后可以有引号和 Markdown 的符号 */
const COMMIT_REFS = /(?:@|\bcommit\b|提交|版本)[`'"“「『*_~]*\s*[:：]?\s*[`'"“「『*_~]*((?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40})(?![0-9a-z])/gi;
/** 一句话到这儿完了：换行、句号、叹号、问号、分号（英文的句号、叹号、问号后面要跟着空白或者到头了，v1.2 里的点不算） */
const SENTENCE_END = /[\n。！？；;]|[.!?](?=\s|$)/g;
/** 一句话里的一小句到这儿完了：逗号、顿号 */
const CLAUSE_END = /[，,、]/g;
/**
 * 反引号、加粗、引号里带空格的一整段读起来是命令、不是路径：开头是常见的命令（go、kubectl、cat，或者 bin/、.bin/ 下面的这些命令，如 vendor/bin/phpunit），
 * 或者有以 - 开头的参数（-f），或者最后一个词前面就有一个完整的代码文件（cp src/a.ts src/c.ts、src/a.ts or src/c.ts）。
 * 别的（`src/my files/app.ts`、`my dir/app.ts`）按一个带空格的路径整段认
 */
const COMMANDS =
  "go|gofmt|node|npm|npx|pnpm|yarn|bun|deno|tsx|tsc|jest|vitest|eslint|prettier|python3?|pip3?|pytest|php|composer|phpunit|java|mvn|gradle|cargo|rustc|make|" +
  "docker|kubectl|helm|git|bash|sh|zsh|source|cat|less|more|head|tail|grep|rg|sed|awk|vim?|nano|code|open|cp|mv|rm|ls|cd|mkdir|touch|chmod|chown|curl|wget|ssh|scp|jq|sudo|env";
const COMMAND_WORD = new RegExp(`^(?:(?:\\S*\\/)?\\.?bin\\/)?(?:${COMMANDS})$`);
const CODE_FILE_WORD = new RegExp(`\\.${CODE_EXT}$`);

function looksLikeCommand(span: string): boolean {
  const words = span.split(/\s+/);
  return COMMAND_WORD.test(words[0]) || words.some((word) => word.startsWith("-")) || words.slice(0, -1).some((word) => CODE_FILE_WORD.test(word));
}

export const UNVERIFIED_CODE_ANSWER =
  "（系统检查）你的回答涉及代码仓库的内容，但这次一次代码工具都没调用，这些内容没有经过查证。" +
  "如果问题和配置的仓库有关，先用 code_list_files、code_search、code_read_file 查清楚，再只按查到的内容重新回答，写明文件和行号，查不到就直说；" +
  "如果和仓库无关，去掉没查证的文件路径后重新回答。不要提这段检查。";

/**
 * 没调代码工具，回答里却有没查证的文件、提交号时，点名是哪几处让模型重做。2026-10-10 复测转链：模型把剧本里的核对记录
 * （「提交 fa02ac8」）抄进了回答，打回时只说「去掉没查证的文件路径」，它不知道是哪处，重做后照样带着，整条回答被拦
 */
export function unverifiedCodeAnswer(cites: readonly string[]): string {
  if (cites.length === 0) {
    return UNVERIFIED_CODE_ANSWER;
  }
  return (
    `（系统检查）你的回答引用了这些代码位置：${cites.join("、")}，但这次一次代码工具都没调用，它们没有经过查证；` +
    "排查剧本和使用说明里写的文件路径、提交号是写说明的人核对时用的，也不算这次查到过。" +
    "如果问题和配置的仓库有关，先用 code_list_files、code_search、code_read_file 查清楚，再只按查到的内容重新回答，写明文件和行号，查不到就直说；" +
    "如果和仓库无关，去掉这几处，其余查到的结论照常写，重新回答。不要提这段检查。"
  );
}

/** 调过代码工具，回答里却引用了工具结果里没有的文件、提交号时，让模型重做 */
export function unseenCodeAnswer(cites: readonly string[], repos: readonly string[]): string {
  return (
    `（系统检查）你的回答引用了这些代码位置，但它们在这次的工具结果里都没有出现：${cites.join("、")}。` +
    "只能引用工具结果里真出现过的文件、行号和提交号，读失败、没搜到的路径也不算，不用写出来。先用 code_search、code_read_file 查到再写；" +
    `要查的代码不在能读的仓库（${repos.join("、")}）里时，直说读不到这部分代码，不要拿别的仓库里的文件或常见的项目结构来回答。不要提这段检查。`
  );
}

/** 打回重做以后还是引用了没查到的代码位置时，换成这句发出去 */
export function blockedCodeAnswer(repos: readonly string[]): string {
  return (
    "这次没能给出结论：回答里引用的文件、行号或提交号在查到的代码里找不到，为免误导没有发出来。" +
    `要查的代码可能不在机器人能读的仓库里（现在能读：${repos.join("、")}），需要的话请把仓库加进来，或者换个问法再问一次。`
  );
}

export interface CodeCitation {
  /** 回答里写的文件路径（带行号的连行号一起，如 src/foo.ts:35）或提交号 */
  text: string;
  /** 带了行号的路径、或者提交号：写得这么具体就是在说「查过」，不会是举例 */
  located: boolean;
}

/** 提交号所在的这句话里它前面和后面的部分（ai/agent-tag master @ 3f2a1c9 里的「ai/agent-tag master」，commit 3f2a1c9 in ai/agent-tag 里的「 in ai/agent-tag」） */
export interface Sentence {
  before: string;
  after: string;
}

/** 认不认得回答里的路径、提交号；line 是路径后面写的行号，branch 是回答里明说了这是个分支（见 BRANCH_BEFORE），sentence 是提交号所在的这句话 */
export type CitationCheck = (text: string, line?: number, branch?: boolean, sentence?: Sentence) => boolean;

/**
 * 回答里引用、但 seen 认不出来的代码位置（文件路径、行号和提交号）。
 * 2026-10-09 复测：问 gateway-api 和用户服务的代码，模型只调了一次工具，就写出「ai/agent-tag master @ 2c6a7d9」
 * 和 userlogic.go:35 这些仓库里根本没有的提交和文件，把握写高
 */
export function unseenCodeCitations(answer: string, seen: CitationCheck): CodeCitation[] {
  const lineAfter = (end: number) => {
    const at = LINE_AFTER_PATH.exec(answer.slice(end));
    return at ? Number(at[1] ?? at[2] ?? at[3]) : undefined;
  };
  const branchAt = (start: number, end: number) =>
    BRANCH_BEFORE.test(answer.slice(Math.max(0, start - 12), start)) || BRANCH_AFTER.test(answer.slice(end));
  const cites = new Map<string, CodeCitation>();
  const check = (path: string, line: number | undefined, start: number) => {
    if (!seen(path, line, branchAt(start, start + path.length))) {
      const text = line === undefined ? path : `${path}:${line}`;
      cites.set(text, { text, located: line !== undefined });
    }
  };
  // 反引号、加粗、引号里带空格的一整段（`src/my files/app.ts`、`src/my files/app.ts:12`）按整段认，
  // 里面空格后面那段（files/app.ts）不能拿来充数。读起来是命令的（`go run cmd/main.go`、`vendor/bin/phpunit tests/UserTest.php`，
  // 见 looksLikeCommand）没写行号、整段也没查到过时，按 CODE_PATHS 一个个认
  const spans: Array<[number, number]> = [];
  for (const match of answer.matchAll(SPACED_CODE_PATHS)) {
    const path = match[1];
    const line = lineAfter(match.index + path.length);
    if (/\s/.test(path) && (line !== undefined || seen(path, line) || !looksLikeCommand(path))) {
      spans.push([match.index, match.index + path.length]);
      check(path, line, match.index);
    }
  }
  // 下划线、删除线包着的：中间是一个路径的按整段认；中间带空格的和上面一样，读起来是命令的、没写行号也没查到过的，里面的路径一个个认
  for (const match of answer.matchAll(WRAPPED_CODE_PATHS)) {
    const path = match[2];
    const line = lineAfter(match.index + path.length);
    spans.push([match.index, match.index + path.length]);
    if (!/\s/.test(path) || line !== undefined || seen(path, line) || !looksLikeCommand(path)) {
      check(path, line, match.index);
    } else {
      for (const piece of path.matchAll(CODE_PATHS)) {
        const at = match.index + piece.index;
        check(piece[1], lineAfter(at + piece[1].length), at);
      }
    }
  }
  for (const match of answer.matchAll(CODE_PATHS)) {
    if (!spans.some(([from, to]) => match.index >= from && match.index < to)) {
      check(match[1], lineAfter(match.index + match[1].length), match.index);
    }
  }
  // 提交号所在的这句话：写着仓库名的，只认这个仓库里查到的提交（见 codeEvidence）
  const sentence = (start: number, end: number): Sentence => {
    const before = answer.slice(0, start);
    const after = answer.slice(end);
    const from = [...before.matchAll(SENTENCE_END)].at(-1);
    const to = new RegExp(SENTENCE_END.source).exec(after);
    return { before: before.slice(from === undefined ? 0 : from.index + 1), after: to === null ? after : after.slice(0, to.index) };
  };
  for (const match of answer.matchAll(COMMIT_REFS)) {
    if (!seen(match[1], undefined, undefined, sentence(match.index, match.index + match[0].length))) {
      cites.set(match[1], { text: match[1], located: true });
    }
  }
  return [...cites.values()];
}

/** 一次工具调用查到的：代码工具是它记下的代码位置（见 CodeFact），别的工具是模型看到的原文 */
export interface ToolEvidence {
  tool: string;
  output?: string;
  facts?: readonly CodeFact[];
}

/**
 * 按这次的工具结果认引用：路径、提交号查到过就算；带行号的还要那一行真的查到过。
 * 代码工具的结果只认工具自己记下的代码位置（CodeFact）：读到的文件和每一行、搜到的每处「文件:行号」、列出的文件、改过的文件和改动后的行、
 * diff 和开 PR 时改动了的文件、结果里写明的提交号。工具按它实际查到的记，不从给模型看的文字里反解析，
 * 读到、搜到的代码正文里写的路径、行号、提交号也就不算：仓库里的测试和文档常常写着别的路径，机器人自己的仓库 ai/agent-tag 的测试里
 * 就有 2026-10-09 编出来的那几个引用。
 * 别的工具（aiops 查到的日志、报错堆栈）没有固定格式，按原文找：路径要整段对上，前面是绝对路径的也算（/app/src/a.ts:12）。
 * 没查到的（「没有这个文件：src/foo.ts」、没搜到、没有匹配的文件）不算：从回答的字面上分不清是在说「它不存在」，
 * 还是没查到以后照样讲它写了什么。照实说找不到的回答，打回重做时会被告知别写这个路径；路径是群成员自己问的，重做以后照着复述也不拦（见 runTask）。
 * 回答里写成「./路径」时去掉前缀再找，路径和读文件时一样整理（src/./a.ts 就是 src/a.ts）；
 * 写成「仓库名/路径」（ai/aiops-mcp/internal/x.go）时，只认在这个仓库里查到的，日志里写的照样去掉仓库名再找；
 * 提交号所在的这句话里写着仓库名的（ai/agent-tag master @ 3f2a1c9、commit 3f2a1c9 in ai/agent-tag），也只认这个仓库里查到的提交（见 commitRepo）
 */
export function codeEvidence(repos: readonly string[], results: readonly ToolEvidence[]): CitationCheck {
  // 任务进行中结果还会变多，按条数缓存
  let cache: { size: number; facts: CodeFacts } | undefined;
  return (cite, line, branch, sentence) => {
    if (cache?.size !== results.length) {
      cache = { size: results.length, facts: codeFacts(results) };
    }
    const facts = cache.facts;
    const named = sentence !== undefined && COMMIT_ID.test(cite) ? commitRepo(sentence, repos) : undefined;
    const written = named === undefined ? cite : `${named}/${cite}`;
    // 文件名里可以真有反斜杠（src/foo\bar.ts）：先按原样找，再把 \ 当成 / 找（Windows 的写法）
    return [...new Set([repoPath(written), repoPath(written.replace(/\\/g, "/"))])].some((text) => {
      // 开头是仓库名的，整段当路径找时也只认这个仓库里查到的：别的仓库里恰好有个叫 ai/aiops-mcp/src/foo.ts 的文件不算。
      // 仓库名互相包含时（team/backend、team/backend/api）只按最长的那个算：team/backend/api/src/x.ts 说的是 team/backend/api 里的
      const prefix = longestRepoPrefix(text, repos);
      const forms: Array<{ path: string; repos?: string[] }> = [
        { path: text, repos: prefix === undefined ? undefined : [prefix] },
        ...(prefix === undefined ? [] : [{ path: text.slice(prefix.length + 1), repos: [prefix] }]),
      ];
      return matchesFacts(facts, forms, line, branch);
    });
  };
}

/** 按 forms 里的几种写法（整段、去掉仓库名的）在查到的里找 */
function matchesFacts(facts: CodeFacts, forms: Array<{ path: string; repos?: string[] }>, line?: number, branch?: boolean): boolean {
  return forms.some(({ path, repos: scope }) => {
    const inRepo = (found: { repo: string }) => scope === undefined || scope.includes(found.repo);
    let found: boolean;
    if (COMMIT_ID.test(path)) {
      // 回答里的提交号可以是查到的提交号的前几位，不能比查到的长：多出来的几位是编的
      const sha = path.toLowerCase();
      found = facts.commits.some((seen) => inRepo(seen) && seen.sha.startsWith(sha));
    } else {
      // 分支名可以长得像路径（feature/foo.ts）：回答里明说是分支的，查到过这个分支也算；别的只按文件认，分支不能给文件作证。
      // 「分支」也可能说的是代码里的分支（src/a.ts 分支覆盖率），所以明说是分支的，查到过这个文件照样算
      found =
        (facts.files.get(path) ?? []).some(
          (seen) => inRepo(seen) && (line === undefined || (seen.lines !== undefined && line >= seen.lines[0] && line <= seen.lines[1])),
        ) ||
        (branch === true && line === undefined && facts.branches.some((seen) => inRepo(seen) && seen.name === path));
    }
    return found || facts.text.some((output) => (line === undefined ? mentions(output, path) : hasLine(output, path, line)));
  });
}

/**
 * 提交号是哪个仓库的：这句话里写着的配置的仓库名。先看提交号所在的这一小句（逗号、顿号隔开），前面离它最近的，没有再看后面离它最近的；
 * 这一小句里没写再看整句，也是先前面后后面。都没写的（master @ 3f2a1c9）不限仓库
 */
function commitRepo({ before, after }: Sentence, repos: readonly string[]): string | undefined {
  const clauseStart = [...before.matchAll(CLAUSE_END)].at(-1);
  const clauseEnd = new RegExp(CLAUSE_END.source).exec(after);
  return (
    lastRepo(before.slice(clauseStart === undefined ? 0 : clauseStart.index + 1), repos) ??
    firstRepo(clauseEnd === null ? after : after.slice(0, clauseEnd.index), repos) ??
    lastRepo(before, repos) ??
    firstRepo(after, repos)
  );
}

/**
 * text 里写着的配置的仓库名（小写）和位置：前面不能紧挨着路径字符（pkg#ai/aiops-mcp 不是这个仓库），后面可以接 /路径；
 * 后面紧挨着的括号、# 这些照样算写的是这个仓库（ai/agent-tag(master) @ 3f2a1c9）
 */
function repoMentions(text: string, repos: readonly string[]): Array<{ repo: string; start: number; end: number }> {
  return repos
    .map((name) => name.toLowerCase())
    .flatMap((repo) =>
      [...text.matchAll(new RegExp(`${NOT_GLUED}${escapeRegExp(repo)}(?![^${PATH_DELIM}/])`, "gi"))].map((match) => ({
        repo,
        start: match.index,
        end: match.index + match[0].length,
      })),
    );
}

/** text 里离结尾最近的配置的仓库名；同一处对得上几个时取最长的 */
function lastRepo(text: string, repos: readonly string[]): string | undefined {
  return repoMentions(text, repos).reduce<{ repo: string; end: number } | undefined>(
    (best, seen) => (best === undefined || seen.end > best.end || (seen.end === best.end && seen.repo.length > best.repo.length) ? seen : best),
    undefined,
  )?.repo;
}

/** text 里离开头最近的配置的仓库名；同一处对得上几个时取最长的 */
function firstRepo(text: string, repos: readonly string[]): string | undefined {
  return repoMentions(text, repos).reduce<{ repo: string; start: number } | undefined>(
    (best, seen) => (best === undefined || seen.start < best.start || (seen.start === best.start && seen.repo.length > best.repo.length) ? seen : best),
    undefined,
  )?.repo;
}

/** path 开头写着的配置的仓库名（小写）；几个都对得上时取最长的 */
function longestRepoPrefix(path: string, repos: readonly string[]): string | undefined {
  return repos
    .map((repo) => repo.toLowerCase())
    .filter((repo) => path.toLowerCase().startsWith(`${repo}/`))
    .reduce<string | undefined>((longest, repo) => (longest === undefined || repo.length > longest.length ? repo : longest), undefined);
}

/** 这次查到的：代码工具记下的文件（和查到的行）、提交号、分支，按仓库分；别的工具的原文 */
interface CodeFacts {
  files: Map<string, Array<{ repo: string; lines?: [number, number] }>>;
  commits: Array<{ repo: string; sha: string }>;
  branches: Array<{ repo: string; name: string }>;
  text: string[];
}

function codeFacts(results: readonly ToolEvidence[]): CodeFacts {
  const facts: CodeFacts = { files: new Map(), commits: [], branches: [], text: [] };
  for (const { tool, output, facts: found } of results) {
    // 代码工具的结果文字一概不认，只认它记下的代码位置
    if (!isCodeTool(tool)) {
      if (output !== undefined) {
        facts.text.push(...unescapedForms(output));
      }
      continue;
    }
    for (const fact of found ?? []) {
      const repo = fact.repo.toLowerCase();
      if ("commit" in fact) {
        facts.commits.push({ repo, sha: fact.commit.toLowerCase() });
      } else if ("branch" in fact) {
        facts.branches.push({ repo, name: fact.branch });
      } else {
        facts.files.set(fact.path, [...(facts.files.get(fact.path) ?? []), { repo, lines: fact.lines }]);
      }
    }
  }
  return facts;
}

const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
const JSON_ESCAPED: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * aiops 结果里的报错堆栈常常是转义过的：日志行里的换行、缩进写成 \n\t，整理结果时又 JSON.stringify 一次，
 * 路径前面紧挨着的是 \t 里的 t（\n\t/build/services/goods/tb.go:8220），就认不出是绝对路径；日志行本身是 JSON 字符串时还会转义两层（\\n\\t）。
 * 2026-10-10 转链排查时回答引用的堆栈位置就是因为这个被当成没查证、整段拦下。
 * 按 JSON 的转义还原一层、两层，和原文一起拿来找：还原只是把转义符变回空白、引号这些分界，不会多出原文里没有的路径
 */
function unescapedForms(output: string): string[] {
  const forms = [output];
  for (let i = 0; i < 2 && forms[i].includes("\\"); i++) {
    const next = forms[i].replace(JSON_ESCAPE, (_, hex: string | undefined, char: string) =>
      hex !== undefined ? String.fromCharCode(parseInt(hex, 16)) : (JSON_ESCAPED[char] ?? char),
    );
    if (next === forms[i]) {
      break;
    }
    forms.push(next);
  }
  return forms;
}

/** text 里有没有这个路径或提交号：提交号可以只写前几位，按前缀认；路径要整段对上 */
function mentions(text: string, cite: string): boolean {
  return COMMIT_ID.test(cite) ? text.includes(cite) : containsPath(text, cite);
}

const COMMIT_ID = /^[0-9a-f]{7,40}$/i;
/**
 * 在没有固定格式的结果里（aiops 的日志、堆栈）找路径：前后不能紧挨着别的路径字符（mysrc/a.ts、pkg/src/a.ts、pkg@src/a.ts、pkg#src/a.ts、src/a.tsx 都不是 src/a.ts），
 * 前后的分界和回答里认路径（CODE_PATHS）一样。
 * 前面是绝对路径的算，报错堆栈里写的是全路径（/app/src/a.ts:12、File "/app/src/a.py"）；写成 ./src/a.ts 的也算。
 * 绝对路径前面的引号、括号要是分界（(/app/src/a.ts:12)），夹在路径字符中间的（x(/app/src/a.ts）是一个更长的路径的一截，不是绝对路径。
 * 绝对路径前面那几级目录名里可以有 @、+、! 这些字符：Go 模块缓存（/go/pkg/mod/github.com/!acme/svc@v1.2.3/...）、pnpm（.pnpm/@acme+svc@1.0.0/...）
 */
const PATH_START = `(?:${NOT_GLUED}|(?<=(?:^|[\\s"\`（=]|(?<!${PATH_CHAR}[${SOFT_DELIM}]*)['(])/(?:[^\\s/"'\`()（）<>]+/)*)|(?<=(?:^|[\\s"\`（=]|(?<!${PATH_CHAR}[${SOFT_DELIM}]*)['(])\\./))`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 按 path 在 text 里找、前后的分界和 containsPath 一样的正则；先认 path 本身，再看前后（长长一串 SOFT_DELIM 字符时不用每处都往前看一遍） */
function pathPattern(path: string, after: string, flags?: string): RegExp {
  const literal = escapeRegExp(path);
  return new RegExp(`(?=${literal})${PATH_START}${literal}${after}`, flags);
}

function containsPath(text: string, path: string): boolean {
  return pathPattern(path, PATH_END).test(text);
}

/** text 里有没有写 path 的第 line 行，写法和回答里认行号的一样（path:35、path#L35、path 第 35 行） */
function mentionsLine(text: string, path: string, line: number): boolean {
  for (const match of text.matchAll(pathPattern(path, PATH_END, "g"))) {
    const at = LINE_AFTER_PATH.exec(text.slice(match.index + match[0].length));
    if (at && Number(at[1] ?? at[2] ?? at[3]) === line) {
      return true;
    }
  }
  return false;
}

/** 这段没有固定格式的结果里有没有 path 的第 line 行：path:35，或者 Python 堆栈的 "path", line 35 */
function hasLine(output: string, path: string, line: number): boolean {
  return pathPattern(path, `(?::|", line )${line}(?!\\d)`).test(output);
}

/**
 * 别的工具（aiops）结果里模型看到的部分：和 runAgent 交给模型时一样截短。被截掉的不算查到，截断处被切开的也去掉：
 * 切在行号里（src/foo.ts:12 后面其实还有个 3）只去掉行号，路径是完整的；切在路径里（src/foo.t、src/a.ts 后面其实是 #v2/b.ts）整个去掉；
 * 正好切在路径结尾（src/foo.ts 后面是 :123、#L3）路径是完整的，都留着
 */
function seenByModel(output: string, limit: number): string {
  if (output.length <= limit) {
    return output;
  }
  const kept = output.slice(0, limit);
  // 截断处后面在原文里是路径的结尾（见 PATH_END）：没有切开路径
  const end = new RegExp(PATH_END, "y");
  end.lastIndex = limit;
  if (end.test(output)) {
    return kept;
  }
  // 往前找到被切开的这一段：路径字符、冒号、SOFT_DELIM 字符。这一段开头的 SOFT_DELIM 字符前面不是路径字符，是分界，一起去掉也不影响认路径
  const part = new RegExp(`${PATH_CHAR}|[:${SOFT_DELIM}]`);
  let start = limit;
  while (start > 0 && part.test(output[start - 1])) {
    start--;
  }
  // 冒号是分界，最后一个冒号前面的路径是完整的
  const colon = kept.lastIndexOf(":");
  return colon >= start ? kept.slice(0, colon) : kept.slice(0, start);
}

/** 回答里写的路径和 src/repo.ts 读写文件时一样整理（见 Workspace.relative）：去掉前后的空格和开头的 ./、/，合并多余的 / 和 ./（反斜杠见 codeEvidence） */
function repoPath(file: string): string {
  return posix.normalize(file.trim().replace(/^\.?\/+/, ""));
}

function isCodeTool(name: string): boolean {
  return name.startsWith(CODE_TOOL_PREFIX);
}

/** 提问或回答里提到了配置的仓库（全名，或者 5 个字以上的最后一段名字） */
function mentionsRepo(text: string, repos: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return repos.some((repo) => {
    const full = repo.toLowerCase();
    const short = full.split("/").pop() ?? full;
    return lower.includes(full) || (short.length >= 5 && lower.includes(short));
  });
}

/**
 * 有代码工具时检查回答：
 * - 一次代码工具都没调，问题或回答却提到了配置的仓库、或者回答里写了没查证的文件路径：让它先查再答。模型关着思考时容易照着常见的项目结构编出文件和行号。
 * - 调过代码工具，回答里还是写了工具结果里没有的文件、行号、提交号：让它只按查到的重写。只看「调没调过」不够，调一次什么都没查到照样能编。
 * seen 认的不算没查证：排查线上问题时文件和行号来自 aiops 查到的报错日志和堆栈，代码工具读到的也在里面；
 * 只放过结果里真出现过的，回答里多写一个结果里没有的照样打回。群成员在提问里写的路径不算查证，照样要先读代码
 */
export function reviewCodeAnswer(question: string, repos: readonly string[], seen: CitationCheck = () => false) {
  return (answer: string, usedTools: ReadonlySet<string>): string | undefined => {
    const unseen = unseenCodeCitations(answer, seen);
    if ([...usedTools].some(isCodeTool)) {
      return unseen.length > 0 ? unseenCodeAnswer(unseen.map((cite) => cite.text), repos) : undefined;
    }
    return mentionsRepo(`${question}\n${answer}`, repos) || unseen.length > 0 ? unverifiedCodeAnswer(unseen.map((cite) => cite.text)) : undefined;
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
/** 一般只在线上数据里出现的写法：K8s Pod 名（gateway-api-6978f9454f-tnc56）、「都有部署」「自动定位到」这类定位结果 */
const OPS_STRONG_PATTERNS = [
  String.raw`\b[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{8,10}-[a-z0-9]{5}\b`,
  // 定位结果：「在多个命名空间都有部署」「default、kube-system 都有部署」「已自动定位到 prod」。要说到命名空间、列出名字，
  // 或者定位到具体的名字：「DaemonSet 确保节点都有部署」「aiops 会自动定位到唯一的命名空间」是在讲概念
  String.raw`(?:命名空间|namespace|、)[^。；;！!？?\n]*(?<!节点上?)都有部署|(?<!节点上?)都有部署[^。；;！!？?\n]*(?:命名空间|namespace)`,
  String.raw`已自动定位到|自动定位到了?\s*[*\x60「“]*[a-z]`,
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
/**
 * 问的就是时间本身：提问里带着时间，问几点、几号、什么时候，问「一小时后」这类相对时间，或者说到换算、时区、时间戳、格式。
 * 回答里的时间是算出来或者举例的（「UTC 08:00:00 是北京时间几点」答「16:00:00」）；现在几点模型从系统提示词里就知道
 */
const TIME_QUESTION = new RegExp(
  [
    String.raw`(?<!\d)\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}`,
    String.raw`几点|几号|几月|几日|哪天|哪一天|星期几|周几|礼拜几|什么时[间候]|日期|多久|多长时间`,
    String.raw`(?:\d+|[一二两三四五六七八九十半]+)\s*个?\s*(?:秒|分钟?|小时|钟头|天|日|周|星期|礼拜|月|年)(?:以?后|以?前|之后|之前)`,
    String.raw`时间戳|timestamp|时区|time\s*zone|utc|gmt|换算|转换|格式|format|strftime|strptime`,
  ].join("|"),
  "i",
);
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

/** 「不是服务故障的原因」「不是服务问题所在」「不是系统故障导致的」说的是某条线索不是根因，不是把问题推出去 */
const NOT_CAUSE = String.raw`(?!\s*(?:的|原因|根因|根源|源头|点|所在|导致|引起|造成))`;
/** 否定的前面：「不是淘宝平台限制」「不属于用户侧问题」说的是排除了外部原因 */
const NOT_BEFORE = String.raw`(?<!(?:不|非|并非|并不)(?:是|属于|在)?)`;
/** 我们这边的主语。「代码」「接口」不算：「不是代码问题，是配置里的超时设成了 1s」说的还是服务自己的问题 */
const OUR_SIDE = String.raw`(?:我们|我方)?的?(?:服务端?|系统|后端|我们|我方)`;

/**
 * 把问题推到服务之外的结论：「不是服务故障」「服务本身没有问题」「属于淘宝平台限制」「用户侧问题」「无需修复」。
 * 要说到是谁的问题：「服务没有异常」这类看状态的、「这次重启不是故障，是正常发版」这类没说到服务的都不算
 */
const DEFLECTING = new RegExp(
  [
    String.raw`(?:不是|并非|并不是|不属于|(?<![除是])非)${OUR_SIDE}(?:本身)?的?\s*(?:故障|问题|bug|缺陷)${NOT_CAUSE}`,
    String.raw`(?:(?:服务端?|系统|后端)本身|(?:我们|我方)(?:这边|这里|侧))(?:没有|没|无|不存在|并无)\s*(?:问题|故障|bug)`,
    String.raw`${NOT_BEFORE}用户(?:侧|端|自己|自身)的?(?:问题|原因|操作)`,
    String.raw`${NOT_BEFORE}(?:属于|是)(?:淘宝|天猫|京东|拼多多|抖音|微信|支付宝|第三方|上游|对方|外部)(?:平台)?(?:侧|方|端|那边)?的?(?:限制|问题|原因|规则|策略|风控)`,
    String.raw`(?:无需|无须|不用|不需要|没必要)(?:我们|开发)?(?:修复|修改?)`,
  ].join("|"),
  "i",
);
/**
 * 让用户自己重来：「建议用户在商品详情页重新分享」「让用户换个链接再试」。「不建议让用户重新分享」「修好以后不需要用户重新分享」不算；
 * 同一句里说了已经修了、部署了（「已修复并部署，通知用户重试即可」）也不算
 */
const USER_REDO = new RegExp(
  String.raw`(?<!(?:不|不要|不用|不必|无需|无须|没必要)(?:建议|要|用|必|需)?)(?:建议|请|让|需要|可以|引导|提示|告诉|通知)用户[^。；;！!？?\n]{0,20}?(?:重新|再次|重试|再试|换个|换一个|换成|改用|手动)`,
);
const FIXED = /修复|修好|已修|改好|部署|上线|发版|hotfix/i;

/** 回答里有没有把问题推出去的结论。举例的分句（「比如回答『不是服务故障』之前…」）不算 */
function deflects(answer: string): boolean {
  return answer.split(/(?<=[。；;！!？?\n])/).some((sentence) => {
    const stated = sentence
      .split(/(?<=[，,])/)
      .filter((clause) => !EXAMPLE.test(clause))
      .join("");
    return DEFLECTING.test(stated) || (USER_REDO.test(stated) && !FIXED.test(sentence));
  });
}

export const DEFLECTED_ANSWER =
  "（系统检查）你的回答把问题归到了服务之外（比如「不是服务故障」「建议用户重新操作」「属于平台限制」）。这类结论会让大家不再往下查，下之前要拿代码核对清楚：\n" +
  "1. 拿失败请求的特征（链接的域名和关键参数、报错原文、错误码）搜代码，从入口沿主流程看这种输入在哪一步被处理或拒绝，不要只看报错附近的几行；\n" +
  "2. 日志是当时线上那一版打的，代码可能已经改过：能查提交历史、线上版本就查，查不了就在结论里写明看的是哪个分支的代码；\n" +
  "3. 结论分开写：当时为什么失败（带日志时间）、现在的代码处不处理、线上部署了没有。\n" +
  "核对完还是服务之外的问题，就照常这么写，并写明核对了哪些代码（只写这次用代码工具查到的文件和行号）；读不到相关代码就直说没法确认是不是服务的问题。不要提这段检查。";

/**
 * 排查过（调过线上工具或代码工具，成没成功都算）以后，回答把问题推到服务之外时，打回一次，让模型先拿代码核对。
 * 2026-10-10 转链排查：模型只看日志就定了「淘宝拒绝、不是服务故障，让用户重新分享」，被打回补查代码时 5 次搜索都在同款推荐那条支路上，
 * 没拿链接里的 pages-fast、topIds 搜一下，漏掉了当天已经合进 master 的修复。这类结论会让用户和开发都不再往下查。
 * 只在有代码工具时装（要模型去搜代码）；核对完还是这个结论就照常发（重做只有一次）
 */
export function reviewDeflectedAnswer(servers: readonly string[], attempted: ReadonlySet<string>) {
  const prefixes = servers.map((name) => `${name}_`);
  return (answer: string): string | undefined => {
    const investigated = [...attempted].some((name) => isCodeTool(name) || prefixes.some((prefix) => name.startsWith(prefix)));
    return investigated && deflects(answer) ? DEFLECTED_ANSWER : undefined;
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
// 「重新整理」「现在把上面的翻译成英文」里的「重新」「现在」说的是改写这个动作，不算要重新查
const LIVE_REQUEST =
  /重新(?!总结|整理|汇总|归纳|概括|润色|翻译|改写|复述|写|组织|排版)|再查|再看|现在(?!把|帮|请|就|给)|目前|最新|实时|查一下|查查|(?:排查|诊断|查询|检查|定位)(?!结果|过程|情况|结论|记录|报告|出|到|的)/;
/** 说工具调用失败的那一句（「aiops 连续 3 次查询都超时」），这句里的次数说的是调用本身 */
const TOOL_FAILURE_CLAUSE = /(?:aiops|工具|调用|查询)[^，,。；;\n]{0,12}(?:超时|失败|出错|连不上|繁忙)/i;

export const BLOCKED_OPS_ANSWER =
  "这次没能给出结论：回答里有线上的数据，但这次一个工具都没有成功调用过，这些数据没有经过查证，为免误导没有发出来。请再问一次。";

/**
 * 打回重做以后还是没查证就给出线上数据时，这个回答不发出去，换成 BLOCKED_OPS_ANSWER。
 * 2026-10-08 复测：用户回了「prod」以后模型两次都没调工具，第二次打回重做后照样编出了三次查询的结果。
 * Pod 名、定位结果这类只在线上数据里出现的，有就拦（举例的句子除外）；带秒的时间也拦，问的是时间换算、时区、格式时，只在问线上服务又写成线上结论时才拦。
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
  const conclusion = OPS_CONCLUSION.test(answer);
  const reported = attempted ? withoutToolFailures(answer) : answer;
  // 举例的句子不算（「例如 gateway-api-6978f9454f-tnc56 中，6978f9454f 是模板哈希」）；写成线上结论的照样整段查
  const text = conclusion ? reported : withoutExamples(reported);
  const live = (pattern: RegExp) => hasUnverified(pattern, question, text);
  const liveTime = !TIME_QUESTION.test(question) || (conclusion && OPS_QUESTION.test(question));
  return live(OPS_STRONG) || (liveTime && live(OPS_TIME)) || (conclusion && live(OPS_WEAK));
}

function rewriteOnly(question: string): boolean {
  return REWRITE_REQUEST.test(question) && !LIVE_REQUEST.test(question) && (EARLIER_CONTENT.test(question) || !OPS_QUESTION.test(question));
}

/** 举例的句子 */
const EXAMPLE = /例如|比如|譬如|举例|举个例子|示例|样例|为例|假如|假设|e\.g\.|for example/i;

function withoutExamples(text: string): string {
  return text
    .split(/(?<=[。；;！!？?\n])/)
    .filter((sentence) => !EXAMPLE.test(sentence))
    .join("");
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
