import { posix } from "node:path";
import type { CardActionEvent, NormalizedMessage, SendInput, SendOptions, SendResult } from "@larksuiteoapi/node-sdk";
import { raceAbort, timeoutSignal } from "./abort.js";
import { type AgentEvent, type AgentResult, MAX_TOOL_OUTPUT_CHARS, runAgent } from "./agent.js";
import { DuplicateAsks } from "./duplicates.js";
import { asksForFeatures, availableFeatures, type FeatureList, renderFeaturesCard, renderFeaturesMarkdown, RICH_UI_FEATURE, VISION_FEATURE } from "./features.js";
import { imageKeysOf } from "./feishu.js";
import { CARD_DONE_NOTICE, type ImageRef, labelUserMessage, type Logger, type ThreadContext, threadKeyOf, unlabelUserMessage } from "./history.js";
import { inlineImages, pickImages } from "./images.js";
import { type ChatMessage, type ChatModel, LlmError, stripThinkTags } from "./llm.js";
import { splitMarkdown, stripRichTags, toPostMarkdown } from "./markdown.js";
import {
  type AnswerSegment,
  describeBlockProblem,
  hasUiBlocks,
  keepVerified,
  mislabeledBytes,
  NumberEvidence,
  reviewUiBlocks,
  segmentsAsText,
  splitAnswer,
} from "./rich-ui.js";
import { type MemoryStore, renderMemoryForPrompt } from "./memory.js";
import {
  answerFitsCard,
  CardUpdater,
  finalCards,
  type ProgressCard,
  type ProgressState,
  type ProgressStep,
  renderProgressCard,
  ASK_ACTION,
  STOP_ACTION,
  visibleThought,
} from "./progress.js";
import { type AboutBot, buildSystemPrompt } from "./prompt.js";
import type { RecentThreadStore } from "./recent-threads.js";
import { type CardKitApi, StreamingCard } from "./stream-card.js";
import type { TaskRegistry } from "./tasks.js";
import { containsSecret, maskPersonal } from "./knowledge.js";
import { CONFLICT_TOOL } from "./tools/conflicts.js";
import type { KnowledgeDesk, KnowledgeLookup } from "./tools/knowledge.js";
import { createMemoryTools } from "./tools/memory.js";
import { createRecentThreadsTool, RECENT_THREADS_TOOL } from "./tools/recent-threads.js";
import { type CodeFact, type Tool, ToolError } from "./tools/tool.js";

/**
 * 每条回复的字数上限。SDK 超过 3500 字会自己切分，但切出来的后续片段会发到群主界面而不是话题里，
 * 所以这里先切好，每片都回复到原消息的话题。
 */
const CHUNK_CHARS = 3000;
/** 流式卡片建不了（比如没开 cardkit:card:write 权限）以后，这么久之内先用原来的进度卡片，不每次都试 */
const CARDKIT_RETRY_MS = 10 * 60_000;
/** 卡片即回答时，任务跑了这么久以上，回答写完后在话题里补一句提醒（提问人多半已经去忙别的了） */
const NOTIFY_AFTER_MS = 60_000;
/** 连长连接之前还不知道机器人名字时用这个 */
const FALLBACK_BOT_NAME = "AI 助手";
/** 在话题里 @ 机器人说这些词时停止任务，而不是当成新问题 */
const STOP_COMMAND = /^(停止|停下|停|别做了|取消|stop|cancel)[。.!！\s]*$/i;
/** 提问里带这些词时，这次任务打开思考（默认关着，回答快一半） */
export const DEEP_THINKING = /深度思考|仔细(想|思考|分析)|认真(想|思考|分析)/;
// 只说「知识库」「经验库」指的是团队经验库（knowledge_propose 起草、确认后存进多维表格），说「飞书知识库」才是飞书文档
const DOC_TARGET = String.raw`(?:(?:飞书|云)?\s*(?:文档|docx|docs?\b|wiki)|飞书\s*知识库)`;
/**
 * 要新建文档：「写成文档」「整理到飞书文档里」「起草一份文档」「建个 doc」「新建文档」「写文档」「记到飞书知识库」。没说的不给新建文档的工具。
 * 「沉淀到知识库」「记到经验库」说的是团队经验库，不给新建文档的工具，免得模型建一篇文档了事
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
  /** questionFull：提问截短前的全文（和 question 一样时可以不给） */
  remember(msg: NormalizedMessage, question: string, answer: string, questionFull?: string): void;
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
  /** 按群记下最近几个话题的问答。不传时不记，也没有 chat_recent_threads 工具 */
  recentThreads?: Pick<RecentThreadStore, "record" | "list">;
  tasks: TaskRegistry;
  send: (to: string, input: SendInput, opts?: SendOptions) => Promise<SendResult>;
  updateCard: (messageId: string, card: object) => Promise<void>;
  logger?: Logger;
  now?: () => number;
  /** 同一张进度卡片两次更新的最小间隔 */
  cardIntervalMs?: number;
  /** 进度卡片上显示模型每轮的思考（SHOW_THINKING）。不传时显示 */
  showThinking?: boolean;
  /**
   * 有人问「你能做什么」「最近更新了什么」时用：产品功能说明的链接、最新一版的更新说明、产品功能清单。
   * 有功能清单时，只问「你能做什么」这类话直接回功能卡片，不问模型
   */
  about?: AboutBot;
  /**
   * 卡片即回答（STREAM_CARD）：进度卡片用飞书卡片实体，思考和回答边生成边写进卡片，回答不再另外发。
   * 不传、或者卡片实体建不了时，和以前一样：进度卡片只显示进度，回答另外发
   */
  cardKit?: CardKitApi;
  /** 卡片即回答时记下卡片里的回答，读话题历史时用（飞书读不出卡片里的文字） */
  cardAnswers?: { save(chatId: string, threadKey: string, messageId: string, answer: string): Promise<void> };
  /** 流式卡片两次请求的最小间隔 */
  streamIntervalMs?: number;
  /** 配置的代码仓库（CODE_REPOS）。用来检查回答是不是没读代码就说了仓库里的内容 */
  codeRepos?: readonly string[];
  /** 能让机器人改文档、改代码的人（open_id）。不传时群里所有人都能 */
  writeAllowed?: ReadonlySet<string>;
  /** 把提问和话题里的图片识别成文字。不传时图片换成「没能看到」的说明 */
  images?: { read(refs: readonly ImageRef[], signal?: AbortSignal): Promise<ReadonlyMap<string, string>> };
  /** 团队经验库：回答前先检索，起草后发确认卡片。不传时没有这些 */
  knowledge?: Pick<KnowledgeDesk, "lookup" | "tools">;
  /** 回答前查经验库最多等多久，不填 8 秒（测试时调短） */
  knowledgeLookupMs?: number;
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
  const cardKit: CardKitHealth = { downUntil: 0 };

  return async (msg: NormalizedMessage, options: TaskOptions = {}): Promise<void> => {
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

    // 点「接着查」按钮问的不当成指令：按钮上的话是模型写的，写个「停止」不能停掉话题里别的任务
    if (!options.readOnly && STOP_COMMAND.test(question)) {
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
    // 只问「你能做什么」这类话：不问模型，直接回功能卡片。按钮问的不算（按钮上的话是模型写的）
    if (!options.readOnly && deps.about?.features && asksForFeatures(question)) {
      await sendFeatures(deps, msg, question, deps.about.features);
      return;
    }

    await runTask(deps, msg, question, reply, cardKit, options);
  };
}

export interface TaskOptions {
  /** 只给读的工具（点「接着查」按钮问的） */
  readOnly?: boolean;
}

/**
 * 回功能卡片：产品功能清单里机器人现在用得上的那几项。卡片发不出去时改发文字版（重复一条说明不要紧，总比没回强）；
 * 文字版记进话题历史（本地记的上文和卡片回答都记），话题里接着问「第 4 个怎么用」时模型看得到（飞书读不出卡片里的字）
 */
async function sendFeatures(deps: BotDeps, msg: NormalizedMessage, question: string, list: FeatureList): Promise<void> {
  const { send, logger = console } = deps;
  const shown = availableFeatures(list, configuredTools(deps, msg));
  const options = { botName: deps.botName() || FALLBACK_BOT_NAME, ...(deps.about?.featuresLink ? { link: deps.about.featuresLink } : {}) };
  const text = renderFeaturesMarkdown(shown, options);
  const to = { replyTo: msg.messageId, replyInThread: true };
  let messageId: string;
  try {
    ({ messageId } = await send(msg.chatId, { card: renderFeaturesCard(shown, options) }, to));
  } catch (err) {
    logger.error(`功能卡片发不出去，改发文字 message=${msg.messageId}`, err);
    ({ messageId } = await send(msg.chatId, { markdown: text }, to));
  }
  logger.info(`问能做什么，回了功能卡片（${shown.features.length} 项） message=${msg.messageId}`);
  deps.context.remember(msg, labelUserMessage(undefined, question), text);
  await deps.cardAnswers?.save(msg.chatId, threadKeyOf(msg), messageId, text).catch((err: unknown) => {
    logger.warn(`功能卡片的文字版没记下来，话题里接着问时模型看不到 message=${msg.messageId}`, err);
  });
}

/**
 * 机器人现在用得上的工具：和回答时一样现建一套看名字（MCP 没连上的服务没有工具，没配写权限名单时经验库没有起草的工具），
 * 群记忆只写开头 memory_；配了看图的模型加上「看图」，开着流式卡片加上「智能卡片」
 */
function configuredTools(deps: BotDeps, msg: NormalizedMessage): string[] {
  const task: TaskToolContext = { chatId: msg.chatId, threadKey: threadKeyOf(msg), senderId: msg.senderId, messageId: msg.messageId };
  const mcpTools = deps.mcp?.tools(task) ?? [];
  const knowledgeTools = deps.knowledge?.tools(task, mcpTools.map((tool) => tool.spec.name)) ?? [];
  return [
    ...[...deps.tools, ...(deps.taskTools?.(task) ?? []), ...mcpTools, ...knowledgeTools].map((tool) => tool.spec.name),
    ...(deps.memory ? ["memory_"] : []),
    ...(deps.recentThreads ? [RECENT_THREADS_TOOL] : []),
    ...(deps.images ? [VISION_FEATURE] : []),
    ...(deps.cardKit ? [RICH_UI_FEATURE] : []),
  ];
}

/** 流式卡片最近一次建不了以后，到什么时候之前先不用 */
interface CardKitHealth {
  downUntil: number;
}

async function runTask(
  deps: BotDeps,
  msg: NormalizedMessage,
  question: string,
  reply: (markdown: string) => Promise<SendResult>,
  cardKit: CardKitHealth,
  options: TaskOptions,
): Promise<void> {
  const { model, tools, tasks, send, updateCard, logger = console, now = Date.now, cardIntervalMs = 1000 } = deps;
  const task = tasks.create(msg.chatId, threadKeyOf(msg));
  // 提问的时间：排队的时间也算进「等了多久」
  const askedAt = now();
  const state: ProgressState = { phase: task.queued ? "queued" : "thinking", steps: [], startedAt: askedAt };
  // 卡片即回答：回答边生成边写进卡片
  let streaming = false;
  const render = () => renderProgressCard(state, task.id, now(), { streaming });

  // 进度卡片发不出去（比如卡片格式被拒）不影响回答，只是看不到进度、不能点停止
  let card: ProgressCard | undefined;
  let cardMessageId: string | undefined;
  // 流式卡片建好了、消息却发不出去：原来的卡片能发出去的话，问题出在流式卡片上，先停用一阵
  let streamCardRejected = false;
  if (deps.cardKit && now() >= cardKit.downUntil) {
    const initial = renderProgressCard(state, task.id, now(), { streaming: true });
    let cardId: string | undefined;
    try {
      cardId = await deps.cardKit.create(initial);
    } catch (err) {
      cardKit.downUntil = now() + CARDKIT_RETRY_MS;
      logger.error(
        `建流式卡片失败，${CARDKIT_RETRY_MS / 60_000} 分钟内先用原来的进度卡片、回答另外发（看看有没有开 cardkit:card:write 权限） message=${msg.messageId}`,
        err,
      );
    }
    if (cardId) {
      try {
        const { messageId } = await send(
          msg.chatId,
          { card: { type: "card", data: { card_id: cardId } } },
          { replyTo: msg.messageId, replyInThread: true },
        );
        card = new StreamingCard(deps.cardKit, cardId, initial, logger, deps.streamIntervalMs, cardIntervalMs);
        cardMessageId = messageId;
        streaming = true;
      } catch (err) {
        logger.error(`发送流式卡片失败，这次用原来的进度卡片 message=${msg.messageId}`, err);
        streamCardRejected = true;
      }
    }
  }
  if (!card) {
    try {
      const { messageId } = await send(msg.chatId, { card: render() }, { replyTo: msg.messageId, replyInThread: true });
      card = new CardUpdater((next) => updateCard(messageId, next), logger, cardIntervalMs);
      if (streamCardRejected) {
        cardKit.downUntil = now() + CARDKIT_RETRY_MS;
        logger.error(`原来的进度卡片发得出去、流式卡片发不出去，${CARDKIT_RETRY_MS / 60_000} 分钟内先不用流式卡片 message=${msg.messageId}`);
      }
    } catch (err) {
      logger.error(`发送进度卡片失败 message=${msg.messageId}`, err);
    }
  }

  let answer: string | undefined;
  let result: AgentResult | undefined;
  let source = "none";
  let memoryCount: number | undefined;
  // 这次交给模型的工具有几个：模型一个工具都没调时，分得清是没给它工具还是它自己没调
  let toolCount: number | undefined;
  // 这次成功拿到的工具结果：检查回答里的代码位置、图里的数时用
  const evidence: ToolEvidence[] = [];
  // 核对过的回答（拆成段）：回答定下来时就核对，记下来的、显示的都用它
  let segments: AnswerSegment[] | undefined;
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
    // 截短前的全文（图片文字不截、上文的长消息用原文）只拿来在查经验前认密钥，不给模型
    const askedFull = inlineImages(question, images, known, true);
    const history = context.history.map((m): ChatMessage => {
      if (m.role !== "user") {
        return m;
      }
      const content = inlineImages(m.content, images, known);
      const full = inlineImages(m.full ?? m.content, images, known, true);
      return { role: "user", content, ...(full !== content ? { full } : {}) };
    });
    const memory = await loadGroupMemory(deps, msg, context.askerName);
    memoryCount = memory?.count;
    const taskContext: TaskToolContext = {
      chatId: msg.chatId,
      threadKey: threadKeyOf(msg),
      senderId: msg.senderId,
      askerName: context.askerName,
      messageId: msg.messageId,
    };
    // 点「接着查」按钮问的：按钮上的话是模型写的，只给读的工具，群记忆也不让记、改、删（模型可以把「记住…」写成按钮），也不能切分支
    const followUp = options.readOnly === true;
    // 只是整理话题里已经有的内容（总结、讲给谁听、换个说法）：不查经验库、不给查询的工具，直接按上文写。按钮上的话是接着要查的新问题，不算
    const restate =
      !followUp &&
      restatesEarlier(question, history, [deps.botName() || FALLBACK_BOT_NAME, ...msg.mentions.flatMap((mention) => (mention.name ? [mention.name] : []))]);
    if (restate) {
      logger.info(`整理话题里之前的内容，这次不查经验库、不给查询的工具 message=${msg.messageId}`);
    }
    // 经验库一个话题只自动查成一次：这个话题已经查成过（不管查没查到），后面的追问不再查（查到的经验那次回答已经用上了），
    // 追问里有新线索时模型自己用 knowledge_search 查。没查成过的（超时、出错、只查成一边、那次是整理不查、重启后记不得）照样查。
    // 追问里明说要查经验库、知识库的也照样先查
    const topics = lookedUpTopics(deps);
    const lookupSkipped = !restate && topics.has(taskContext.threadKey) && !ASKS_KNOWLEDGE.test(question);
    if (lookupSkipped) {
      logger.info(`这个话题查过经验库了，这次追问不再自动查 message=${msg.messageId}`);
    }
    const knowledge =
      restate || lookupSkipped
        ? undefined
        : await lookupKnowledge(deps, taskContext, askedFull, history, task.signal, state, () => card?.update(render()));
    if (knowledge && !knowledge.missed?.length) {
      rememberLookup(topics, taskContext.threadKey);
    }
    // 记下这次成功跑完的工具和它们的结果，检查回答时只认成功拿到的结果（调用失败、工具不存在都不算查过）。
    // 回答里引用的文件路径、行号、提交号要查到过（代码工具查到的代码位置，或者 aiops 查到的报错堆栈里写着），才算查证过
    const succeeded = new Set<string>();
    const attempted = new Set<string>();
    // 这次工具结果的原文（模型看到的部分）：回答里写的合并请求编号要在这里、话题里或提问里出现过。模型自己写进群记忆的不算
    const toolTexts: string[] = [];
    // code_merge 真的合进去了（不算调用失败、设成流水线通过后自动合并的）：回答里说「已合并」要有它
    let mergedNow = false;
    const mcpTools = deps.mcp?.tools(taskContext) ?? [];
    const knowledgeTools = deps.knowledge?.tools(taskContext, mcpTools.map((tool) => tool.spec.name)) ?? [];
    // MCP 服务（aiops）读代码时给的永久链接算查到的代码；网页、搜索结果里的链接是别人的仓库，不算
    const mcpNames = new Set(mcpTools.map((tool) => tool.spec.name));
    const recentThreadTools = deps.recentThreads
      ? [createRecentThreadsTool({ store: deps.recentThreads, chatId: msg.chatId, threadKey: threadKeyOf(msg) })]
      : [];
    // 整理之前内容时写文档、记群记忆、起草经验：写进去的内容和回答一样，只能用话题里之前写过的代码位置和数据（回答里多半只有个链接，检查不到写进去的）
    const checkRestatedWrite = (tool: Tool, args: Record<string, unknown>) => {
      // 整理时读文档、网页只读这次的提问和话题里给过的链接：模型自己想到的网页读进来会被当成依据，里面的数据就能混进整理
      const link = restate ? RESTATE_READS.get(tool.spec.name) : undefined;
      if (link !== undefined) {
        const value = typeof args[link] === "string" ? args[link].trim().replace(/\/+$/, "") : "";
        if (!value || ![asked, ...history.map((m) => m.content)].some((text) => text.includes(value))) {
          throw new Error("这次是整理话题里之前的内容，只能读这次的提问和话题里给过的文档、网页链接。没给过的不要读，按之前的回答写。");
        }
      }
      if (restate && (tool.writes || MEMORY_WRITE_TOOLS.has(tool.spec.name) || KNOWLEDGE_DRAFT_TOOLS.has(tool.spec.name))) {
        const added = restatedAdditions(stringArgs(args), saidBefore(), restateScope);
        if (added.length > 0) {
          throw new Error(restatedWriteNote(added));
        }
      }
    };
    const allTools = [...tools, ...(deps.taskTools?.(taskContext) ?? []), ...mcpTools, ...(memory?.tools ?? []), ...recentThreadTools].map(
      (tool): Tool => ({
        ...tool,
        run: async (args, ctx) => {
          // code_branches 的 switch_to 会改这个话题后面看代码、改代码、开合并请求用的分支
          if (followUp && tool.spec.name === BRANCHES_TOOL && args.switch_to) {
            throw new Error("这次是点「接着查」按钮问的，只能查，不能切换分支。只看别的分支，用其他代码工具的 branch 参数");
          }
          checkRestatedWrite(tool, args);
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
          if (tool.spec.name === MERGE_TOOL && /^已合并|已经合并过了/.test(output)) {
            mergedNow = true;
          }
          // 和 runAgent 交给模型时一样截短：截断处以后的模型没看到，不算
          const limit = tool.maxOutputChars ?? MAX_TOOL_OUTPUT_CHARS;
          if (!MEMORY_WRITE_TOOLS.has(tool.spec.name)) {
            toolTexts.push(seenByModel(output, limit));
          }
          const seenFacts = output.length <= limit ? facts : facts.filter((fact) => fact.at <= limit);
          evidence.push(
            code
              ? {
                  tool: tool.spec.name,
                  facts: seenFacts,
                  // 读文件、搜索读到的代码拿来核对图和数字卡片里的数（副本数、资源配置）；代码位置只认 facts。
                  // 别的代码工具（提交记录、文件列表、改代码、看改动）的结果不算
                  ...(CODE_SOURCE_TOOLS.has(tool.spec.name) ? { output: codeContent(seenByModel(output, limit), seenFacts) } : {}),
                }
              : {
                  tool: tool.spec.name,
                  output: seenByModel(output, limit),
                  ...(mcpNames.has(tool.spec.name) ? { links: true } : {}),
                  ...(tool.writes || MODEL_ECHO_TOOLS.has(tool.spec.name) ? { echo: true } : {}),
                },
          );
          return output;
        },
      }),
    ).concat(
      // 经验库的工具不记进上面几样：查到的是以前确认过的结论，不是这次实时查到的数据，也不是这次读到的代码。
      // 只查了经验库就给出线上结论、引用文件行号，照样要打回。查到的原文记下来，里面写着的合并请求编号回答里可以写
      knowledgeTools.map(
        (tool): Tool => ({
          ...tool,
          run: async (args, ctx) => {
            checkRestatedWrite(tool, args);
            const output = await tool.run(args, ctx);
            if (!KNOWLEDGE_DRAFT_TOOLS.has(tool.spec.name)) {
              toolTexts.push(seenByModel(output, tool.maxOutputChars ?? MAX_TOOL_OUTPUT_CHARS));
            }
            return output;
          },
        }),
      ),
    );
    const hasWrites = allTools.some((tool) => tool.writes);
    // 不在写权限名单里的人：不给改文档、改代码的工具，模型想改也改不了
    const noPermission = hasWrites && deps.writeAllowed !== undefined && !deps.writeAllowed.has(msg.senderId);
    const readOnly = noPermission || followUp;
    // 没说要文档时不给新建文档的工具：2026-10-09 复测时，只说了「把上面的排查结果总结一下」，模型就自己建了一篇飞书文档
    const createDoc = docRequested(question, context.history);
    const taskTools = allTools.filter(
      (tool) =>
        !(readOnly && tool.writes) &&
        !(followUp && (MEMORY_WRITE_TOOLS.has(tool.spec.name) || KNOWLEDGE_DRAFT_TOOLS.has(tool.spec.name))) &&
        !(restate && !RESTATE_TOOLS.has(tool.spec.name)) &&
        // 合并只在发起人这句话明确要合并时给：群记忆、话题里别人的话、合并请求描述里写着「直接合掉」也不会让它去合
        (tool.spec.name !== MERGE_TOOL || asksToMerge(question)) &&
        (createDoc || tool.spec.name !== "feishu_doc_create"),
    );
    toolCount = taskTools.length;
    if (followUp) {
      logger.info(`点按钮接着问的，这次只给读的工具，第 1 轮先调工具 message=${msg.messageId} sender=${msg.senderId}`);
    } else if (noPermission) {
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
    // 通过 aiops 读过代码（结果里有代码永久链接）也算读过代码：不然模型用 aiops 按线上版本读了代码、提到仓库，还会被要求再用代码工具读一遍
    const readCode = () => evidence.some(linksCode);
    // 整理之前内容时核对哪几样：配了代码工具（这次给没给都算）就核对代码位置，配了 MCP 服务就核对线上数据
    const restateScope = { code: allTools.some((tool) => tool.spec.name.startsWith(CODE_TOOL_PREFIX)), ops: Boolean(deps.mcp?.names.length) };
    // 整理之前内容时的依据：这次的提问、话题里之前写过的（之前的回答、群成员说的）和这次读到的文档网页。检查时再取，读到的才算上
    const saidBefore = () => [asked, ...history.map((m) => m.content), ...evidenceOutputs(evidence)].join("\n");
    // 合并请求编号的依据：这次的提问、话题里之前的消息和这次的工具结果。检查时再取，查到的才算上
    // 群记忆、回答前查到的经验里写着的编号也算（群成员记下的「uat 的合并请求是 !360」）
    const requestsKnown = () =>
      [asked, ...history.map((m) => m.content), memory?.prompt.text ?? "", knowledge?.text ?? "", ...toolTexts].join("\n");
    const requests = { known: requestsKnown, canOpen: toolNames.includes(OPEN_PR_TOOL), canMerge: toolNames.includes(MERGE_TOOL), merged: () => mergedNow };
    const reviews = [
      ...(restate
        ? [reviewRestatedAnswer(saidBefore, restateScope)]
        : [
            ...(hasCodeTools ? [reviewCodeAnswer(asked, deps.codeRepos ?? [], seen, readCode, requests)] : []),
            // 按配置的服务装，不看这次有没有工具：服务连不上时模型照样可能照搬话题里之前的数据
            ...(deps.mcp?.names.length ? [reviewOpsAnswer(asked, deps.mcp.names, succeeded)] : []),
            ...(deps.mcp?.names.length && hasCodeTools ? [reviewDeflectedAnswer(deps.mcp.names, attempted)] : []),
          ]),
      reviewByteUnits(evidence),
      // 卡片上画图时才查：不画图时 ```chart 是用户要的代码示例
      ...(streaming ? [reviewUiBlocks] : []),
    ];
    const thinksAfter = deps.mcp?.thinksAfter?.bind(deps.mcp);
    // 卡片上显示思考、不是用英文问的（群里一般说中文）：每次查完、下一轮要思考之前，提醒模型用中文想。
    // 系统提示词开头虽然写了，隔着几万字英文的日志、代码，模型常常就用英文想了（2026-10-12 转链排查的第 3 轮）；
    // 等它想成英文再提醒，卡片上已经有一轮英文
    const steer =
      deps.showThinking !== false && card && askedInChinese(question)
        ? ({ reasoning, thinkingNext }: { reasoning?: string; thinkingNext: boolean }) => {
            // 提醒过还是想成了英文的记一行，看提醒管不管用。只看卡片上显示的那部分：思考很长时卡片只显示开头和结尾
            if (reasoning !== undefined && writtenInEnglish(reasoning, visibleThought)) {
              logger.info(`思考是英文${thinkingNext ? "，提醒模型接着用中文想" : ""} message=${msg.messageId}`);
            }
            return thinkingNext ? THINK_IN_CHINESE : undefined;
          }
        : undefined;
    // 最近一次模型调用是第几轮：打回重做（retry）紧跟在给出那版回答的这一轮后面
    let lastRound = 0;
    // 流式时这一轮到目前为止的正文：这一轮没调工具的话，就是给出的回答
    let liveText = "";
    result = await runAgent({
      model,
      ...(deep ? { thinking: true } : {}),
      // 按钮上的话是接着要查的新问题，第 1 轮就要求调工具：2026-10-13 点「接着查」问 product-service-api 最近 1 小时的错误日志，
      // 可用工具 30 个，模型两轮都没调工具，照着话题里之前的回答写了线上数据，整条回答被拦
      ...(followUp ? { requireTool: true } : {}),
      ...(thinksAfter ? { thinkAfter: thinksAfter } : {}),
      ...(steer ? { steer } : {}),
      system: buildSystemPrompt({
        botName: deps.botName() || FALLBACK_BOT_NAME,
        now: new Date(now()),
        toolNames,
        memory: memory?.prompt,
        readOnly: noPermission,
        followUp,
        restate,
        extra: deps.mcp?.prompt(toolNames),
        showThinking: deps.showThinking !== false,
        richText: streaming,
        ...(deps.about
          ? {
              about: deps.about.features
                ? {
                    ...deps.about,
                    features: availableFeatures(deps.about.features, [
                      ...toolNames,
                      ...(deps.images ? [VISION_FEATURE] : []),
                      ...(streaming ? [RICH_UI_FEATURE] : []),
                    ]),
                  }
                : deps.about,
            }
          : {}),
        ...(deps.knowledge
          ? {
              knowledge: {
                // 整理之前内容时没查经验库，提示词里不说查到没查到
                ...(restate
                  ? {}
                  : lookupSkipped
                  ? { skipped: true }
                  : knowledge
                  ? {
                      hits: knowledge.text,
                      ...(knowledge.aiops ? { aiopsHits: true } : {}),
                      ...(knowledge.missed?.length ? { missed: knowledge.missed } : {}),
                      ...(knowledge.aiopsSkipped ? { aiopsSkipped: true } : {}),
                    }
                  : { failed: true }),
                // 起草的工具是按钮问的才拿掉的，提示词叫人直接 @；本来就没有（没配写权限名单）时照实说存不了
                ...(followUp && allTools.some((tool) => KNOWLEDGE_DRAFT_TOOLS.has(tool.spec.name)) ? { draftsHidden: true } : {}),
              },
            }
          : {}),
      }),
      messages: [...history, { role: "user", content: prompt }],
      tools: taskTools,
      signal: task.signal,
      ...(streaming ? { stream: true } : {}),
      ...(reviews.length > 0
        ? {
            // 几项检查都没过时一起告诉模型：重做只有一次，只说一项的话，另一项重做后就没人查了
            // 按显示出来的文字检查：<font>、<text_tag> 标签去掉
            review: (answer: string, usedTools: ReadonlySet<string>) =>
              reviews
                .map((review) => review(stripRichTags(answer), usedTools))
                .filter(Boolean)
                .join("\n") || undefined,
          }
        : {}),
      onEvent: (event) => {
        if (event.type === "delta") {
          liveText = event.text;
          const reasoning = deps.showThinking !== false ? event.reasoning : "";
          if (reasoning || event.text) {
            state.live = { round: event.round, reasoning, text: event.text };
            card?.update(render());
          }
          return;
        }
        logEvent(logger, msg.messageId, event);
        if (event.type === "model") {
          lastRound = event.round;
          if (streaming) {
            // 这一轮想完了：思考收进 thoughts（下面），没调工具的话正文就是这一版回答（还没检查完）
            state.live = undefined;
            state.answer = event.toolNames.length === 0 ? stripThinkTags(liveText) || undefined : undefined;
            if (state.answer) {
              state.answerNote = undefined;
            }
            liveText = "";
            if (!event.reasoning || deps.showThinking === false) {
              card?.update(render());
            }
          }
        }
        if (event.type === "retry" && streaming) {
          // 卡片里那一版回答没通过检查：换成说明，重做的回答写出来以后替换它
          state.answer = undefined;
          state.answerNote = "这一版回答没通过检查，正在重做…";
          card?.update(render());
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
    // 最后一道检查也按显示出来的文字看：<font>、<text_tag> 标签去掉
    const shown = stripRichTags(result.text);
    let blockedCode = false;
    // 整理之前内容时：重做以后回答里还有话题里之前没写过的代码位置、线上数据（条数、百分比这类也算），不发出去
    const restatedAdded = restate && result.finish !== "filtered" ? restatedAdditions(shown, saidBefore(), restateScope) : [];
    if (restatedAdded.length > 0) {
      logger.warn(`整理之前的内容，重做以后还是添了之前没写过的内容，没有发出 message=${msg.messageId}：${restatedAdded.join("、")}`);
      answer = BLOCKED_RESTATE_ANSWER;
    }
    if (!restate && deps.mcp?.names.length && result.finish !== "filtered" && blockUnverifiedOps(asked, deps.mcp.names, succeeded, shown, result.toolCalls > 0)) {
      logger.warn(`回答打回重做以后还是没查证就给出了线上数据，没有发出 message=${msg.messageId}`);
      answer = BLOCKED_OPS_ANSWER;
    }
    if (hasCodeTools && result.finish !== "filtered" && answer !== BLOCKED_OPS_ANSWER) {
      // 打回重做时群成员自己写的路径不算查证（要模型先去读代码）；重做以后照着提问复述一遍（「order.go:88 所在的服务读不到」）不拦。
      // 这次读过代码、或者问的是配置的仓库时，回答里每个路径都得是真的；不然只拦带行号的，举例写的路径（「可以写在 k8s/deployment.yaml 里」）照常发
      const userText = [asked, ...history.flatMap((m) => (m.role === "user" ? [m.content] : []))].join("\n");
      const repos = deps.codeRepos ?? [];
      const investigating = [...attempted].some(isCodeTool) || readCode() || mentionsRepo(`${asked}\n${shown}`, repos);
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
      const unseen = unseenCodeCitations(shown, (text, line, branch, sentence) => seen(text, line, branch, sentence) || inQuestion(text, line)).filter(
        (cite) => cite.located || investigating,
      );
      if (unseen.length > 0) {
        logger.warn(`回答打回重做以后还是引用了没查到的代码位置，没有发出 message=${msg.messageId}：${unseen.map((cite) => cite.text).join("、")}`);
        answer = blockedCodeAnswer(deps.codeRepos ?? []);
        blockedCode = true;
      } else {
        const madeUp = madeUpRequestRefs(shown, requestsKnown());
        if (madeUp.length > 0) {
          logger.warn(`回答打回重做以后还是写了查不到的合并请求编号，没有发出 message=${msg.messageId}：${madeUp.join("、")}`);
          answer = blockedRequestAnswer(madeUp);
          blockedCode = true;
        }
      }
    }
    // 回答因为没查证被拦下时，思考里多半也是这些没查证的说法，卡片上不再留着；被模型服务的内容审核拦下时也一样
    if (answer === BLOCKED_OPS_ANSWER || answer === BLOCKED_RESTATE_ANSWER || blockedCode || result.finish === "filtered") {
      state.thoughts = undefined;
    }
    state.phase = "done";
    // 回答里的图和数字卡片：数都要在这次查到的结果里找得到，对不上的不画；记下来的也是核对过的（对不上的数后面的提问不能再看到）
    segments = verifiedSegments(answer, evidence, logger, msg.messageId, streaming);
    const verified = segmentsAsText(segments);
    deps.context.remember(msg, prompt, verified, labelUserMessage(context.askerName, askedFull || "（@ 了你，没有写别的内容）"));
    // 被拦下、被审核拦下的回答里没有结论，不记
    if (answer !== BLOCKED_OPS_ANSWER && answer !== BLOCKED_RESTATE_ANSWER && !blockedCode && result.finish !== "filtered") {
      await rememberThread(deps, msg, asked, verified, context.askerName);
    }
  } catch (err) {
    segments = undefined;
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
  // 卡片即回答：卡片里换成最终的回答（被拦下、出错时是对应的说明；停止了就不留草稿）
  state.live = undefined;
  state.answerNote = undefined;
  state.answer = answer;
  const displayed = answer === undefined ? [] : (segments ?? verifiedSegments(answer, evidence, logger, msg.messageId, streaming));
  state.answerSegments = displayed;
  const displayedText = segmentsAsText(displayed);
  try {
    const landed = await card?.finish(...finalCards(state, task.id, now(), { streaming }));
    if (answer !== undefined) {
      if (streaming && landed && cardMessageId && answerFitsCard(displayedText)) {
        await rememberCardAnswer(deps, msg, cardMessageId, displayedText);
        // 更新卡片不发通知：等得久的（排队加处理）补一句，提问人才知道处理完了
        if (state.endedAt - askedAt >= NOTIFY_AFTER_MS) {
          await reply(CARD_DONE_NOTICE);
        }
      } else {
        // 没用流式卡片、卡片最后没更新上、或者回答太长卡片里只放了开头：和以前一样另外发全文
        for (const chunk of splitMarkdown(toPostMarkdown(displayedText), CHUNK_CHARS)) {
          await reply(chunk);
        }
      }
    }
  } finally {
    tasks.finish(task);
  }
  logger.info(
    `${state.phase === "stopped" ? "已停止" : "已回复"} message=${msg.messageId} 上下文=${source} ` +
      `${memoryCount === undefined ? "" : `记忆=${memoryCount}条 `}` +
      `${toolCount === undefined ? "" : `可用工具=${toolCount} `}` +
      `工具调用=${result?.toolCalls ?? state.steps.length} 用时=${state.endedAt - state.startedAt}ms`,
  );
}

/** 拆出回答里的图和数字卡片，数对不上查询结果的去掉；去掉了什么、哪些块格式不对写日志 */
function verifiedSegments(answer: string, evidence: readonly ToolEvidence[], logger: Logger, messageId: string, rich: boolean): AnswerSegment[] {
  // 打回重做以后正文里还是有按 1000 换算却写成 MiB 的数：可能是模型自己算的、碰巧对上，照发，记一行看打回管不管用
  const numbers = new NumberEvidence(evidenceOutputs(evidence));
  const mislabeled = mislabeledBytes(answer, numbers);
  if (mislabeled.length > 0) {
    logger.warn(`回答里写成 MiB、GiB 的数按 1000 换算才对得上查询结果 message=${messageId}：${mislabeled.map((item) => `${item.written}（${item.raw} 字节 = ${item.binary}）`).join("、")}`);
  }
  // 没教模型写图和数字卡片（不是流式卡片）时，回答里的 ```chart 是用户要的代码示例，原样留着
  if (!rich) {
    return answer.trim() ? [{ kind: "markdown", text: answer }] : [];
  }
  const { segments, invalid } = splitAnswer(answer);
  if (invalid.length > 0) {
    logger.warn(`回答里的代码块格式不对，没画 message=${messageId}：${invalid.map(describeBlockProblem).join("；")}`);
  }
  if (!hasUiBlocks(segments)) {
    return segments;
  }
  const checked = keepVerified(segments, numbers);
  if (checked.dropped.length > 0) {
    logger.warn(`回答里的图、数字卡片对不上查询结果，没画 message=${messageId}：${checked.dropped.join("；")}`);
  }
  return checked.segments;
}

/** 拿来核对数的工具结果：模型自己写进去的（写文档、记记忆）不算 */
function evidenceOutputs(evidence: readonly ToolEvidence[]): string[] {
  return evidence.flatMap((item) => (item.output === undefined || item.echo ? [] : [item.output]));
}

/**
 * 回答里写成 MiB、GiB 的数，查到的字节数按 1000 换算才对得上：打回让模型核对单位。
 * 2026-10-13 测试群：「2v7gp 从 144.9 MiB 跳到 153.2 MiB」其实是 MB，表格里同一个 Pod 最高才 146.4 MiB
 */
export function reviewByteUnits(evidence: readonly ToolEvidence[]) {
  return (answer: string): string | undefined => {
    const mislabeled = mislabeledBytes(answer, new NumberEvidence(evidenceOutputs(evidence)));
    if (mislabeled.length === 0) {
      return undefined;
    }
    const items = mislabeled.map((item) => `${item.written}（查到的 ${item.raw} 字节按 1024 换算是 ${item.binary}）`).join("、");
    return (
      `回答里这几个数写成了 MiB/GiB，可查到的字节数按 1024 换算对不上，按 1000 换算（MB/GB）才对得上：${items}。` +
      "字节换 MiB 要除以 1048576，换 GiB 要除以 1073741824。是从查到的字节数换算来的，改成按 1024 换算的数；是自己算出来的（平均值、合计、差值），确认算对了就保留。其余内容不用改，重新给出完整的回答。"
    );
  };
}

/** 记下这个话题的问答，之后别的话题用 chat_recent_threads 查。记不下只是别的话题查不到这次，不影响这次回答 */
async function rememberThread(deps: BotDeps, msg: NormalizedMessage, question: string, answer: string, askerName: string | undefined): Promise<void> {
  try {
    await deps.recentThreads?.record(msg.chatId, threadKeyOf(msg), { question, answer, ...(askerName ? { askerName } : {}) });
  } catch (err) {
    (deps.logger ?? console).error(`记下话题问答失败 message=${msg.messageId}`, err);
  }
}

/** 记下卡片里的回答，之后读话题历史时用。记不下只是这个话题后面的提问看不到这条回答，不影响这次 */
async function rememberCardAnswer(deps: BotDeps, msg: NormalizedMessage, cardMessageId: string, answer: string): Promise<void> {
  try {
    await deps.cardAnswers?.save(msg.chatId, threadKeyOf(msg), cardMessageId, answer);
  } catch (err) {
    (deps.logger ?? console).error(`记下卡片里的回答失败 message=${msg.messageId} card=${cardMessageId}`, err);
  }
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
 * 自动查经验库用的文字：这次的提问，话题里最近几轮提问（新的在前），最后是话题的第一个问题。
 * 两个库都只取前面一段去查（LOOKUP_QUERY_CHARS），所以这次的提问放最前面；拼起来不超过那一段，第一个问题不会被挤出去：
 * 这次的提问很长（追问时贴了一大段日志）就截短，中间几轮每轮限长，放得下几轮放几轮。
 * 只追问一句「怎么修？」时，上一轮给的错误码、服务名也能带上。
 * 上文里每句话前面标的发言人去掉：名字对查经验没用，也不该发给 aiops、记进它的调用日志。
 * 每轮用截短前的全文（asked 也是）；secret 是用到的几轮里有没有像密钥的
 */
function lookupQuery(asked: string, history: readonly ChatMessage[]): { query: string; secret: boolean } {
  const asks = history.flatMap((m) => (m.role === "user" ? [unlabelUserMessage(m.full ?? m.content)] : []));
  const recent = asks.slice(1).slice(-LOOKUP_RECENT_TURNS).reverse();
  // 截短前先用每轮的全文认密钥、给手机号身份证号打码：截在一半就认不出来了（<password>… 的结尾截掉了、号码只剩半截），会发到 aiops。
  // 给模型看的上文早就截短了（长消息、长的图片文字），截掉的后半段可能正是认出前面是密钥的那部分（data 在前、kind: Secret 在后的 Secret），所以用全文
  const secret = [asked, ...recent, ...asks.slice(0, 1)].some(containsSecret);
  const current = maskPersonal(asked);
  if (asks.length === 0) {
    return { query: current, secret };
  }
  const first = maskPersonal(asks[0]).slice(0, LOOKUP_TURN_CHARS);
  const parts = [current.slice(0, LOOKUP_QUERY_CHARS - first.length - 1)];
  let used = parts[0].length + 1 + first.length;
  for (const turn of recent) {
    const text = maskPersonal(turn).slice(0, LOOKUP_TURN_CHARS);
    if (used + text.length + 1 > LOOKUP_QUERY_CHARS) {
      break;
    }
    parts.push(text);
    used += text.length + 1;
  }
  return { query: [...new Set([...parts, first])].join("\n"), secret };
}

/**
 * 回答前先在团队经验库（和 aiops 经验库）里查一次，由程序保证查，不靠模型自觉：提问原文（话题里的追问带上前几轮和第一个问题）去检索，
 * 够相近的几条写进提示词。查到了在进度卡片上多一步「查经验库」。返回 undefined 表示没查成（超时、出错），不耽误回答
 */
async function lookupKnowledge(
  deps: BotDeps,
  task: TaskToolContext,
  asked: string,
  history: readonly ChatMessage[],
  signal: AbortSignal,
  state: ProgressState,
  refresh: () => void,
): Promise<KnowledgeLookup | undefined> {
  const { knowledge, logger = console } = deps;
  if (!knowledge) {
    return undefined;
  }
  const { query, secret } = lookupQuery(asked, history);
  // 经验库自己按库限时；这里再给整个检索一个上限：飞书接口不认中止信号，卡住了也不能拖住回答
  const timeout = timeoutSignal(deps.knowledgeLookupMs ?? KNOWLEDGE_LOOKUP_MS);
  try {
    const found = await raceAbort(knowledge.lookup(query, task, signal, { secret }), AbortSignal.any([signal, timeout.signal]));
    if (!found) {
      return undefined;
    }
    logger.info(`查经验库 message=${task.messageId} 相近的 ${found.ids.length} 条${found.ids.length > 0 ? `：${found.ids.join(" ")}` : ""}`);
    if (found.ids.length > 0) {
      state.steps.push({ id: "knowledge", label: `查经验库（找到 ${found.ids.length} 条相近的经验）`, status: "ok" });
      refresh();
    }
    return found;
  } catch (err) {
    if (signal.aborted) {
      throw err;
    }
    logger.warn(`查经验库失败，这次不带经验 message=${task.messageId}：${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  } finally {
    timeout.clear();
  }
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
    const think = `${event.thinking ? " 思考=开" : ""}${event.requireTool ? " 要求调工具" : ""}`;
    logger.info(`模型第${event.round}轮 message=${messageId} 用时=${event.ms}ms${think}${usage} → ${next}`);
  } else if (event.type === "retry") {
    logger.warn(`回答没通过检查，已让模型重做 message=${messageId}：${event.reason.slice(0, 60)}…`);
  } else if (event.type === "compacted") {
    logger.warn(`模型说输入太长，第${event.round}轮把 ${event.results} 个工具结果压短（省掉 ${event.chars} 字）后重试 message=${messageId}`);
  } else if (event.type === "tool_end") {
    if (event.ok) {
      logger.info(`工具 ${event.name} message=${messageId} 用时=${event.ms}ms`);
    } else {
      logger.warn(`工具 ${event.name} 失败 message=${messageId} 用时=${event.ms}ms：${event.error ?? "未知原因"}`);
    }
  }
}

/** 回答前查经验库最多等多久，查不完就先不带经验回答 */
const KNOWLEDGE_LOOKUP_MS = 8000;
/** 查经验库时除了第一个问题，再带上话题里最近几轮提问 */
const LOOKUP_RECENT_TURNS = 3;
/** 带上的每轮提问最多取多少字 */
const LOOKUP_TURN_CHARS = 200;
/** 查经验库的文字最多多长：两个库只取前面一段去查（aiops 800 字，团队经验库 1000 字），按短的算 */
const LOOKUP_QUERY_CHARS = 800;

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
 * 回答里的绝对路径（报错堆栈里的 /app/internal/logic/user.go:35、Go 模块缓存 /go/pkg/mod/…/x.go）：CODE_PATHS 只认相对路径，
 * 绝对路径整段都认不出来，原先回答里写 /app/src/user.ts:99 一概不查。和 CODE_PATHS 一样至少一层目录、按整段认；
 * 前面要是分界：x(/app/…、~/.config/x.yaml、./src/a.ts 里的 / 前面紧挨着路径字符，不是绝对路径的开头
 */
const ABS_CODE_PATHS = new RegExp(`${NOT_GLUED}(\\/(?:${NAME_CHAR}+\\/)+${NAME_CHAR}+\\.${CODE_EXT})${PATH_END}`, "g");
/**
 * 反引号、加粗、引号里带空格的路径（`src/my files/app.ts:12`、**src/my files/app.ts**:12、"src/my files/app.ts":12）：
 * CODE_PATHS 只认得出空格后面那段，这种先按整段认（见 unseenCodeCitations）。目录和文件名里能有的字符和 CODE_PATHS 一样，
 * 词之间可以是连着几个空格、制表符、全角空格；后面是收尾的符号，或者 LINE_AFTER_PATH 认的行号写法（:12、：12、#L12、 第 12 行）
 */
const SPACED_CODE_PATHS = new RegExp(
  `(?<=[\`*"“「『])(\\/?(?:${NAME_CHAR}+(?:[^\\S\\r\\n]+${NAME_CHAR}+)*\\/)+${NAME_CHAR}+(?:[^\\S\\r\\n]+${NAME_CHAR}+)*\\.${CODE_EXT})(?=[\`*"”」』:：#]|\\s*(?:的)?\\s*第\\s*\\d)`,
  "g",
);
/**
 * Markdown 的下划线、删除线包着的路径（_src/a.ts_:12、__src/a.ts__、~~src/a.ts~~，中间也可以带空格）：_ 和 ~ 也是路径字符，
 * CODE_PATHS 会把两头的符号算进路径里、认不出来。前面是分界、两头是一样的一对符号时，中间按一整段路径认（见 unseenCodeCitations）
 */
const WRAPPED_CODE_PATHS = new RegExp(
  `(?<=(?:^|[${PATH_DELIM}])([_~]{1,2}))(?![_~])(\\/?(?:${NAME_CHAR}+(?:[^\\S\\r\\n]+${NAME_CHAR}+)*\\/)+${NAME_CHAR}+(?:[^\\S\\r\\n]+${NAME_CHAR}+)*\\.${CODE_EXT})` +
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
      for (const pieces of [CODE_PATHS, ABS_CODE_PATHS]) {
        for (const piece of path.matchAll(pieces)) {
          const at = match.index + piece.index;
          check(piece[1], lineAfter(at + piece[1].length), at);
        }
      }
    }
  }
  for (const paths of [CODE_PATHS, ABS_CODE_PATHS]) {
    for (const match of answer.matchAll(paths)) {
      if (!spans.some(([from, to]) => match.index >= from && match.index < to)) {
        check(match[1], lineAfter(match.index + match[1].length), match.index);
      }
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

/**
 * 结果里的内容是模型自己写进去的工具：记忆（记的、查的都是之前模型写的）、最近话题（之前的回答）。
 * 它们结果里的数不算查到的数：模型先记一句「CPU 99%」，不能再拿回执里的 99 去画图
 */
const MODEL_ECHO_TOOLS: ReadonlySet<string> = new Set(["memory_save", "memory_update", "memory_delete", "memory_search", RECENT_THREADS_TOOL]);

/** 结果里有代码原文的代码工具 */
const CODE_SOURCE_TOOLS: ReadonlySet<string> = new Set(["code_read_file", "code_search"]);

/**
 * 代码工具结果里真正是代码的部分：工具记下的每一行代码（读文件的「12|」、搜索的「文件:12」后面）到行尾的内容，去掉分隔的空格或冒号。
 * 只认 facts 记下的行，不从文字里认格式：行号、共几行、提交号、文件名不算读到的数（读了第 12 行，模型编一个 12 也对得上），
 * 「没有搜到「foo:12: limit 99」」这类把搜的词原样写回来的也不算
 */
export function codeContent(output: string, facts: readonly CodeFact[]): string {
  const starts = new Set(facts.flatMap((fact) => ("lines" in fact && fact.lines && fact.lines[0] === fact.lines[1] ? [fact.at] : [])));
  return [...starts]
    .sort((a, b) => a - b)
    .flatMap((at) => {
      const end = output.indexOf("\n", at);
      const rest = output.slice(at, end === -1 ? undefined : end);
      return /^[ :]/.test(rest) ? [rest.slice(1)] : [];
    })
    .join("\n");
}

/** 列分支、切分支的代码工具：点按钮问的不让切（见 runTask 里的 followUp） */
const BRANCHES_TOOL = "code_branches";
const OPEN_PR_TOOL = "code_open_pr";
const MERGE_TOOL = "code_merge";

/** 每个机器人记在内存里的「哪些话题查成过经验库」，重启就忘（忘了就再查一次，多查不出错） */
const LOOKED_UP_TOPICS = new WeakMap<BotDeps, Map<string, number>>();
/** 最多记这么多个话题、记这么久，超了忘掉最早的 */
const LOOKED_UP_TOPICS_MAX = 2000;
const LOOKED_UP_TOPICS_MS = 7 * 24 * 60 * 60 * 1000;

function lookedUpTopics(deps: BotDeps): { has(key: string): boolean; map: Map<string, number> } {
  let map = LOOKED_UP_TOPICS.get(deps);
  if (!map) {
    map = new Map();
    LOOKED_UP_TOPICS.set(deps, map);
  }
  const topics = map;
  return {
    map: topics,
    has(key) {
      const at = topics.get(key);
      return at !== undefined && Date.now() - at < LOOKED_UP_TOPICS_MS;
    },
  };
}

function rememberLookup(topics: { map: Map<string, number> }, key: string): void {
  topics.map.delete(key);
  topics.map.set(key, Date.now());
  for (const oldest of topics.map.keys()) {
    if (topics.map.size <= LOOKED_UP_TOPICS_MAX) {
      break;
    }
    topics.map.delete(oldest);
  }
}

/** 追问里明说要查经验库：照样先自动查一次。「飞书知识库」说的是飞书文档，不算 */
const ASKS_KNOWLEDGE = /经验库|(?<!飞书\s*)知识库/;

/** 改群记忆的工具：点按钮问的不给（见 runTask 里的 followUp） */
const MEMORY_WRITE_TOOLS: ReadonlySet<string> = new Set(["memory_save", "memory_update", "memory_delete"]);
/** 起草存进、归档经验库的确认卡片的工具：点按钮问的也不给（按钮上的话是模型写的，可以写成「沉淀成经验」） */
const KNOWLEDGE_DRAFT_TOOLS: ReadonlySet<string> = new Set(["knowledge_propose", "knowledge_propose_archive", CONFLICT_TOOL]);

/** 一次工具调用查到的：代码工具是它记下的代码位置（见 CodeFact）和模型看到的原文（只核对数），别的工具是模型看到的原文 */
export interface ToolEvidence {
  tool: string;
  output?: string;
  facts?: readonly CodeFact[];
  /** 结果里的内容是模型自己写进去的（写操作的回执、记忆、之前的回答）：里面的数不能当图和数字卡片的依据 */
  echo?: boolean;
  /** output 里的代码永久链接（见 codeLinks）算查到的代码：MCP 服务的结果是，网页、搜索结果不是 */
  links?: boolean;
}

/**
 * 按这次的工具结果认引用：路径、提交号查到过就算；带行号的还要那一行真的查到过。
 * 代码工具的结果只认工具自己记下的代码位置（CodeFact）：读到的文件和每一行、搜到的每处「文件:行号」、列出的文件、改过的文件和改动后的行、
 * diff 和开 PR 时改动了的文件、结果里写明的提交号。工具按它实际查到的记，不从给模型看的文字里反解析，
 * 读到、搜到的代码正文里写的路径、行号、提交号也就不算：仓库里的测试和文档常常写着别的路径，机器人自己的仓库 ai/agent-tag 的测试里
 * 就有 2026-10-09 编出来的那几个引用。
 * 别的工具（aiops 查到的日志、报错堆栈）没有固定格式，按原文找：路径要整段对上，前面是绝对路径的也算（/app/src/a.ts:12）。
 * 回答里写的就是绝对路径时，日志、堆栈里要有这整个绝对路径；代码工具查到的是仓库里的相对路径，去掉前面几级目录以后对得上就算
 * （容器里的 /app/src/a.ts:12 就是读到的 src/a.ts 第 12 行）。
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
    return [...new Set([written, written.replace(/\\/g, "/")])].some((raw) => {
      // 绝对路径（/app/src/a.ts）：日志、堆栈里要整段对上，别的绝对路径（/build/app/src/a.ts）、相对路径（src/a.ts）不算；
      // 代码工具查到的是仓库里的相对路径，按去掉前面几级目录以后的认（/app/src/a.ts 的 app/src/a.ts、src/a.ts，至少留一层目录）。
      // 日志里的绝对路径不一定整理过（PHP 报错里的 /var/www/html/../vendor/autoload.php），回答照抄的也要认：按原样和整理后的都找
      const absolute = /^\s*\/(?!\/)/.test(raw) ? posix.normalize(raw.trim()) : undefined;
      const forms: Array<{ path: string; repos?: string[] }> = [];
      for (const text of absolute === undefined ? [repoPath(raw)] : innerPaths(absolute)) {
        // 开头是仓库名的，整段当路径找时也只认这个仓库里查到的：别的仓库里恰好有个叫 ai/aiops-mcp/src/foo.ts 的文件不算。
        // 仓库名互相包含时（team/backend、team/backend/api）只按最长的那个算：team/backend/api/src/x.ts 说的是 team/backend/api 里的。
        // 绝对路径里有仓库名的（/ai/agent-tag/src/x.ts），更短的那几段（src/x.ts）不再拿去别的仓库里找
        const prefix = longestRepoPrefix(text, repos);
        forms.push({ path: text, repos: prefix === undefined ? undefined : [prefix] });
        if (prefix !== undefined) {
          forms.push({ path: text.slice(prefix.length + 1), repos: [prefix] });
          break;
        }
      }
      return matchesFacts(facts, forms, line, branch, absolute === undefined ? undefined : [...new Set([raw.trim(), absolute])]);
    });
  };
}

/**
 * 绝对路径最多去掉开头这么多级目录。容器、构建机、模块缓存的前缀（/app、/var/www/html、/home/runner/work/x/x、/go/pkg/mod/…@v1.2.3）没有这么深；
 * 不设上限时每一段都拼一遍，回答里写一个几万字、几万级的路径，查一次就要几秒、几百 MB
 */
const MAX_DROPPED_DIRS = 32;

/** 绝对路径去掉开头几级目录以后的各段，从长到短，至少留一层目录：/app/src/a.ts → app/src/a.ts、src/a.ts */
function innerPaths(absolute: string): string[] {
  const parts = absolute.split("/").filter(Boolean);
  return parts.slice(0, Math.min(parts.length - 1, MAX_DROPPED_DIRS + 1)).map((_, i) => parts.slice(i).join("/"));
}

/**
 * 按 forms 里的几种写法（整段、去掉仓库名的）在查到的里找。texts 是在没有固定格式的结果（日志、堆栈）里找的写法，
 * 不传就是 forms 里的这几种；绝对路径只按它整段找
 */
function matchesFacts(
  facts: CodeFacts,
  forms: Array<{ path: string; repos?: string[] }>,
  line?: number,
  branch?: boolean,
  texts: readonly string[] = forms.map((form) => form.path),
): boolean {
  const known = forms.some(({ path, repos: scope }) => {
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
    return found;
  });
  return known || facts.text.some((output) => texts.some((path) => (line === undefined ? mentions(output, path) : hasLine(output, path, line))));
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
  for (const { tool, output, facts: found, links } of results) {
    // 代码工具的结果文字一概不认，只认它记下的代码位置
    if (!isCodeTool(tool)) {
      if (output !== undefined) {
        const forms = unescapedForms(output);
        facts.text.push(...forms);
        const found = links ? [...new Map(forms.flatMap(codeLinks).map((link) => [JSON.stringify(link), link])).values()] : [];
        // 只有标了一段行的链接才要看「行号|」
        const marked = found.some((link) => link.lines && link.lines[0] !== link.lines[1]) ? markedLines(forms) : undefined;
        for (const link of found) {
          const shown = shownLines(link.lines, marked).map((lines) => ({ repo: link.repo, lines }));
          facts.files.set(link.path, [...(facts.files.get(link.path) ?? []), { repo: link.repo }, ...shown]);
          if (COMMIT_ID.test(link.ref)) {
            facts.commits.push({ repo: link.repo, sha: link.ref.toLowerCase() });
          }
        }
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

/**
 * 代码平台上文件的永久链接：GitLab 的 https://主机/组/项目/-/blob/<提交或分支>/<路径>#L12-20，GitHub 的 https://github.com/owner/repo/blob/<提交>/<路径>#L12-L20。
 * aiops 的代码工具（get_repo_file、search_code）按线上版本读到代码时都附这样的链接，写明了读的是哪个仓库、哪个提交、哪个文件的哪几行；
 * 结果里的行号写在代码前面（「2468| ...」），回答里的「tb.go:2468」在原文里找不到，只能按链接认。
 * 认链接不认字段名：aiops 的代码工具还在开发，字段可能改，链接是代码平台自己的格式。
 * 结果太长被截短时，链接可能断在中间（…#L2440-24…（省略 2 字））：后面紧跟着省略号、字母数字的不认，断在行号里的只认文件。
 * 只认 GitLab 的 /-/blob/ 和 github.com 的 /blob/：日志里别的网址（对象存储 https://oss…/img/blob/abc1234/a.php、用户分享的链接）路径里也可能有 blob，不是代码。
 * 路径里不收中文标点和 , ; { }：链接后面紧跟着「，见上」时不能把标点算进路径
 */
const CODE_LINK =
  /https?:\/\/(?:github\.com\/([^\s/"'`<>()（）…\\#?]+\/[^\s/"'`<>()（）…\\#?]+)\/blob|[^\s/"'`<>()（）…\\]+\/([^\s"'`<>()（）…\\#?]+?)\/-\/blob)\/([^\s/"'`<>()（）…\\#?]+)\/([^\s"'`<>()（）…\\#?，。；：、！？「」『』【】,;{}]+)(?:\?[^\s"'`<>()（）…\\#]*)?(?:#L(\d+)(?:-L?(\d+))?)?(?![\w\-…])/gi;

interface CodeLink {
  /** 仓库（小写） */
  repo: string;
  /** 链接里的提交号或分支 */
  ref: string;
  path: string;
  /** 链接标了行（#L12、#L12-20）时，起止行 */
  lines?: [number, number];
}

function codeLinks(text: string): CodeLink[] {
  const links: CodeLink[] = [];
  for (const match of text.matchAll(CODE_LINK)) {
    const [, github, gitlab, ref, file, from, to] = match;
    const repo = github ?? gitlab;
    let decoded: string;
    try {
      // 链接写在句末时，后面的英文句号、冒号不是路径的一部分（中文标点本来就不收进路径）
      decoded = decodeURIComponent(from === undefined ? file.replace(/[.:!]+$/, "") : file);
    } catch {
      continue;
    }
    const start = from === undefined ? undefined : Number(from);
    // 止行比起行小的不是正常的范围，只认起行
    const end = to === undefined || start === undefined || Number(to) < start ? start : Number(to);
    links.push({
      repo: repo.toLowerCase(),
      ref,
      path: repoPath(decoded),
      ...(start !== undefined && end !== undefined ? { lines: [start, end] as [number, number] } : {}),
    });
  }
  return links;
}

/** 结果里带行号的代码行（aiops 读代码、搜代码的结果写成「2468| ...」）的行号。转义过的结果（\n2468|）在还原过的那份里认 */
function markedLines(forms: readonly string[]): Set<number> {
  const marked = new Set<number>();
  for (const form of forms) {
    for (const match of form.matchAll(/(?<![\w.])(\d{1,7})\|/g)) {
      marked.add(Number(match[1]));
    }
  }
  return marked;
}

/**
 * 链接标的行里，哪些算查到了：只标一行的（搜代码命中的那一行）算；标了一段的（读文件），只算结果里真有「行号|」的那几行，连着的并成一段。
 * 结果太长时长字段会被截短（见 compactText），链接还在、后面的代码已经没了：那些行模型没看到。
 * 结果里一个「行号|」都没有时（aiops 改了代码的写法），没法按行核对，照链接标的整段算，不因为格式变了就把引用全打回。
 * 「行号|」不分是哪个文件的：一次结果里有几段代码时，别的文件的行号也会算上，这一点放宽
 */
function shownLines(lines: [number, number] | undefined, marked: ReadonlySet<number> | undefined): Array<[number, number]> {
  if (lines === undefined) {
    return [];
  }
  if (lines[0] === lines[1] || marked === undefined || marked.size === 0) {
    return [lines];
  }
  const runs: Array<[number, number]> = [];
  for (const line of [...marked].filter((n) => n >= lines[0] && n <= lines[1]).sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && last[1] === line - 1) {
      last[1] = line;
    } else {
      runs.push([line, line]);
    }
  }
  return runs;
}

/** 这次结果里有 MCP 服务读代码给的永久链接：算读过代码 */
function linksCode(item: ToolEvidence): boolean {
  return item.links === true && item.output !== undefined && unescapedForms(item.output).some((form) => codeLinks(form).length > 0);
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
 * 方括号紧挨着的绝对路径一直算：ThinkPHP 的报错日志写成「[0]报错信息[/var/www/html/app/a.php:46]」，信息末尾紧挨着 [。
 * 2026-10-13 点「接着查」问 gateway-api 的 error 日志，回答引用的 app/utils/Redirect.php:46 等 3 处没认出来，查了 12 步的回答整条被拦
 * 绝对路径前面那几级目录名里可以有 @、+、! 这些字符：Go 模块缓存（/go/pkg/mod/github.com/!acme/svc@v1.2.3/...）、pnpm（.pnpm/@acme+svc@1.0.0/...）
 */
const PATH_START = `(?:${NOT_GLUED}|(?<=(?:^|[\\s"\`（=[]|(?<!${PATH_CHAR}[${SOFT_DELIM}]*)['(])/(?:[^\\s/"'\`()（）<>]+/)*)|(?<=(?:^|[\\s"\`（=]|(?<!${PATH_CHAR}[${SOFT_DELIM}]*)['(])\\./))`;

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

/** 这段没有固定格式的结果里有没有 path 的第 line 行：path:35，Python 堆栈的 "path", line 35，PHP 堆栈的 path(35) */
function hasLine(output: string, path: string, line: number): boolean {
  return pathPattern(path, `(?::${line}(?!\\d)|", line ${line}(?!\\d)|\\(${line}\\))`).test(output);
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
 * 只放过结果里真出现过的，回答里多写一个结果里没有的照样打回。群成员在提问里写的路径不算查证，照样要先读代码。
 * readCode：通过 aiops 这类 MCP 服务读过代码（结果里有代码永久链接），和调过代码工具一样只核对引用
 */
export function reviewCodeAnswer(
  question: string,
  repos: readonly string[],
  seen: CitationCheck = () => false,
  readCode: () => boolean = () => false,
  requests?: RequestCheck,
) {
  const act = requests?.canOpen === true && asksToOpenRequest(question);
  return (answer: string, usedTools: ReadonlySet<string>): string | undefined => {
    const unseen = unseenCodeCitations(answer, seen);
    const usedCode = [...usedTools].some(isCodeTool) || readCode();
    const madeUp = requests ? madeUpRequestRefs(answer, requests.known()) : [];
    // 让把做好的修改开合并请求、合到别的分支，却没调 code_open_pr：编了编号、说开好了、一个代码工具没调就答。
    // 打回时叫它直接去开，不叫它去搜代码（下面那两句会让它把之前的结论从头查一遍）
    // 能合并时，一个都没调就说合好了的也打回
    if (
      act &&
      !usedTools.has(OPEN_PR_TOOL) &&
      !usedTools.has(MERGE_TOOL) &&
      (madeUp.length > 0 ||
        OPENED_CLAIM.test(answer) ||
        (requests.canMerge === true && MERGED_CLAIM.test(answer)) ||
        (!usedCode && (unseen.length > 0 || mentionsRepo(`${question}\n${answer}`, repos))))
    ) {
      return openRequestAnswer(madeUp, unseen.map((cite) => cite.text), requests.canMerge === true);
    }
    // 开了合并请求、没调 code_merge（或者调了没合成、只设成了自动合并）就说合好了
    if (act && requests.canMerge === true && !(requests.merged?.() ?? usedTools.has(MERGE_TOOL)) && MERGED_CLAIM.test(answer)) {
      return mergedClaimAnswer();
    }
    const notes = [
      usedCode
        ? unseen.length > 0
          ? unseenCodeAnswer(unseen.map((cite) => cite.text), repos)
          : undefined
        : mentionsRepo(`${question}\n${answer}`, repos) || unseen.length > 0
          ? unverifiedCodeAnswer(unseen.map((cite) => cite.text))
          : undefined,
      madeUp.length > 0 ? madeUpRequestAnswer(madeUp) : undefined,
    ].filter((note): note is string => note !== undefined);
    return notes.length > 0 ? notes.join("\n") : undefined;
  };
}

/** 核对回答里的合并请求编号要用的：已知的文字（提问、话题里之前的消息、这次的工具结果），这次能不能开合并请求 */
export interface RequestCheck {
  known: () => string;
  canOpen: boolean;
  /** 这次有 code_merge（机器人能合并允许开发者合并的分支） */
  canMerge?: boolean;
  /** code_merge 这次真的合进去了（调用失败、只设成流水线通过后自动合并的不算） */
  merged?: () => boolean;
}

/**
 * 让机器人把做好的修改开合并请求、合到别的分支、合并：「提个 PR」「开个 MR」「把这个 PR 合并到 uat」「也合到 uat」「把 !354 合了」。
 * 问合没合的不算（「合到 uat 了吗」「有没有合并到 uat」）
 */
export function asksToOpenRequest(question: string): boolean {
  // 「把 !354 合了」「帮我合了」末尾的「了」是叫它去做，不是说已经合了：只看有没有问的字眼
  if (MERGE_IMPERATIVE.test(question)) {
    return !MERGE_QUESTION.test(question);
  }
  return (OPEN_REQUEST_ASK.test(question) || MERGE_ASK.test(question)) && !REQUEST_STATUS_QUESTION.test(question);
}

/** 发起人这句话明确要合并：「合到 uat」「合并到 uat」「把 !354 合了」「合并一下」。只说「提个 PR」「开个 MR 到 uat」的不算 */
export function asksToMerge(question: string): boolean {
  return !MERGE_REFUSED.test(question) && asksToOpenRequest(question) && (MERGE_IMPERATIVE.test(question) || MERGE_ASK.test(question) || MERGE_INTO.test(question));
}

/** 说了不要合：「不要把 !354 合了」「先别合到 uat，只开 MR」「暂时不用合并」 */
const MERGE_REFUSED = /(?:不要|别|不用|无需|不需要|先不|暂时不|暂不|不必)[^，。,;；\n]{0,20}?合/;
const MERGE_INTO = /(?:合并|合)到\s*[a-z0-9]/i;
// 两段 \s* 中间的可选词要和后面的 \s* 包在一起：分开写时一长串空白会被两段 \s* 来回分，卡住几秒
const OPEN_REQUEST_ASK = /(?:开|提|建|发起?)\s*(?:(?:一?个|一下)\s*)?(?:(?:mr|pr)(?![a-z])|合并请求)|(?:合并|合)到\s*[a-z0-9][\w./-]*/i;
/** 让合并：「直接合」「帮我合并」「把 !354 合了」，和「合并一下」「合并吧」。「配合一下」「适合吧」不算，所以后面两种要写全「合并」 */
const MERGE_IMPERATIVE = /(?:直接|帮我|给我|麻烦你?)\s*合(?:并|进)?|把\s*[!！]\d+\s*合/;
const MERGE_ASK = /合并(?:一下|掉|吧)/;
const MERGE_QUESTION = /有没有|是否|是不是|了[吗么没]|[吗么][?？。.]?\s*$|没有[?？]?\s*$|[?？]\s*$/;
const REQUEST_STATUS_QUESTION = /有没有|是否|是不是|了[吗么没]|没有[?？]?\s*$|了[?？。.]?\s*$/;
/**
 * 回答里说已经开好了合并请求：「已开合并请求」「已经帮你开好了到 uat 的 MR」「PR 已提」。
 * 「之前开过」「之前已经开了」说的是以前的
 */
const OPENED_CLAIM =
  /(?<!之前|此前|以前|上次|原来|早先)(?:已经?|帮你|给你)\s*(?:(?:帮你|给你)\s*)?(?:开|提|创建|建|发起)(?!过)(?:好|了)*[^。；;\n]{0,20}?(?:合并请求|merge\s*request|(?<![a-z])(?:mr|pr)(?![a-z]))|(?:合并请求|(?<![a-z])(?:mr|pr)(?![a-z]))[^。；;\n]{0,6}?已经?(?:开|提|创建|建)(?!过)/i;

/**
 * 回答里说已经合好了：「已合并到 uat」「已经合进 uat 了」「帮你合好了」。「之前已经合了」说的是以前的
 */
const MERGED_CLAIM = /(?<!之前|此前|以前|上次|原来|早先|是否|有没有)(?:已经?|帮你|给你)\s*(?:(?:帮你|给你)\s*)?合(?:并|进|到|好|入|了|掉)/;

/** GitLab 合并请求的编号（!353）和链接里的编号（/merge_requests/353） */
const REQUEST_REF = /(?<![\w!])!([1-9]\d{0,6})(?!\d)|\/merge_requests\/([1-9]\d{0,6})(?!\d)/g;

/**
 * 回答里写的合并请求编号，在已知的文字里一次都没出现过的（编出来的）。
 * 回答里的代码块、行内代码不看（「if (!1)」），只写着一个编号的行内代码（「`!354`」）照样看
 */
export function madeUpRequestRefs(answer: string, known: string): string[] {
  const numbers = (text: string) => [...text.matchAll(REQUEST_REF)].map((match) => match[1] ?? match[2]);
  const said = new Set(numbers(known));
  const prose = answer.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`([^`\n]*)`/g, (span, inner: string) => (/^\s*!\d+\s*$/.test(inner) ? inner : " "));
  return [...new Set(numbers(prose).filter((number) => !said.has(number)))].map((number) => `!${number}`);
}

const OPEN_REQUEST_HINT =
  "群成员是让你把已经做好的修改开合并请求或合到别的分支：这是要你动手，不是重新排查，不用再搜代码、读代码去核对之前的结论。" +
  "是这个话题自己的改动，直接调 code_open_pr，target 填要合到的分支；是别的话题或别人开的合并请求，先用 code_requests 找到编号，再调 code_open_pr（from 填编号，target 填分支）。" +
  "按它返回的编号和链接回答；开不了（报错、冲突、这个分支上已经开过）就照实说是什么原因。";

const MERGE_HINT =
  "群成员要合并的，开好以后（已经开过的直接）用 code_merge 填编号合掉；它只合机器人自己开的、开到允许开发者合并的分支的，拒绝了就照它返回的原因说，没调 code_merge 不能说已经合好了。";

/** 没调 code_merge 就说合好了 */
export function mergedClaimAnswer(): string {
  return `（系统检查）你这次没有用 code_merge 合成（没调、调了出错，或者只设成了流水线通过后自动合并），回答里却说已经合好了。${MERGE_HINT}没合成就照实说开了哪个、为什么没合。其余内容不用改，重新给出完整的回答，不要提这段检查。`;
}

/** 让开合并请求、合并，却没调 code_open_pr、code_merge 就答了：叫它直接去开、去合 */
export function openRequestAnswer(madeUp: readonly string[], cites: readonly string[], canMerge = false): string {
  return (
    `（系统检查）你这次没有调用 code_open_pr${canMerge ? " 和 code_merge" : ""}` +
    (madeUp.length > 0 ? `，回答里的 ${madeUp.join("、")} 在这次的工具结果、话题和提问里都找不到，是编出来的` : `，这个合并请求没有开出来${canMerge ? "，也没有合并" : ""}`) +
    (cites.length > 0 ? `；回答里还写了没查过的代码位置：${cites.join("、")}，不要写` : "") +
    `。${OPEN_REQUEST_HINT}${canMerge ? MERGE_HINT : ""}不要提这段检查。`
  );
}

/** 回答里有查不到的合并请求编号 */
export function madeUpRequestAnswer(madeUp: readonly string[]): string {
  return (
    `（系统检查）回答里的 ${madeUp.join("、")} 在这次的工具结果、话题和提问里都找不到，是编出来的。` +
    "合并请求的编号和链接只写工具返回的、话题里写过的；不确定是哪个就用 code_requests 查，查不到就说没找到。其余内容不用改，重新给出完整的回答，不要提这段检查。"
  );
}

/** 打回重做以后还是写了查不到的合并请求编号时，换成这句发出去 */
export function blockedRequestAnswer(madeUp: readonly string[]): string {
  return `这次没能给出结论：回答里写的合并请求 ${madeUp.join("、")} 查不到，为免误导没有发出来。请再说一次，要开合并请求可以说清楚开到哪个分支。`;
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
    "先查，再只按这次查到的结果回答；调用次数每次提问都重新算，话题里之前说过额度用完、到上限的，这次照样能查。这次没有这些工具或者调用失败了，就如实说明现在查不了，不要给出数据。" +
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

/** 「不是服务故障的原因」「不是服务问题所在」说的是某条线索不是根因，不是把问题推出去（「不是服务故障导致的」是） */
const NOT_CAUSE = String.raw`(?!\s*(?:的|原因|根因|根源|源头|点|所在))`;
/** 否定、拿不准的前面：「不是淘宝平台限制」「不属于用户侧问题」说的是排除了外部原因，「不排除是」「可能是」还没下结论 */
const NOT_BEFORE = String.raw`(?<!(?:不|非|并非|并不|排除|可能|也许|或许|怀疑|是否)(?:是|属于|在)?)`;
/** 我们这边的主语。「代码」「接口」不算：「不是代码问题，是配置里的超时设成了 1s」说的还是服务自己的问题 */
const OUR_SIDE = String.raw`(?:我们|我方)?的?(?:服务端?|系统|后端|我们|我方)`;

/** 外部：平台、第三方、上游 */
const OUTSIDE = String.raw`(?:淘宝|天猫|京东|拼多多|抖音|微信|支付宝|第三方|上游|对方|外部)(?:平台|服务)?(?:侧|方|端|那边)?`;

/**
 * 把问题推到服务之外的结论：「不是服务故障」「服务本身没有问题」「跟我们无关」「属于淘宝平台限制」「用户侧问题」「无需修复」。
 * 要说到是谁的问题：「服务没有异常」这类看状态的、「这次重启不是故障，是正常发版」这类没说到服务的都不算；
 * 只提到外部原因、同一句里说是我们没处理的（「根因是淘宝风控返回的 code 我们没处理」）也不算
 */
const DEFLECTING = new RegExp(
  [
    // 「是不是服务故障」「如果不是服务故障」「是否」是在问、在假设
    String.raw`(?:(?<![是果否])不是|并非|并不是|不属于|(?<![除是])非)${OUR_SIDE}(?:本身)?的?\s*(?:故障|问题|bug|缺陷)${NOT_CAUSE}`,
    String.raw`(?:(?:服务端?|系统|后端)本身|(?:我们|我方)(?:这边|这里|侧))(?:没有|没|无|不存在|并无)\s*(?:问题|故障|bug)`,
    String.raw`(?:跟|和|与)(?:我们|我方|服务端?|系统|后端)(?:这边|本身)?(?:无关|没关系|没有关系)`,
    String.raw`(?:没有|没|无)\s*(?:问题|故障|bug)[，,]?\s*是${OUTSIDE}`,
    String.raw`${NOT_BEFORE}用户(?:侧|端|自己|自身)的?(?:问题|原因)|用户操作(?:不当|失误|有误|错误)`,
    String.raw`${NOT_BEFORE}属于${OUTSIDE}的?(?:限制|问题|原因|规则|策略|风控)`,
    String.raw`${NOT_BEFORE}(?:是|在)${OUTSIDE}的?(?:限制|问题)`,
    String.raw`(?:无需|无须|不用|不需要|没必要)(?:我们|开发)?修复`,
  ].join("|"),
  "i",
);
/**
 * 让用户自己重来：「建议用户在商品详情页重新分享」「让用户换个链接再试」。否定的（「不建议让用户重新分享」「不应该让用户重新分享」）不算；
 * 同一句里说了已经修了、等修好上线（「已修复并部署，通知用户重试即可」「等修复上线后通知用户重试」）也不算；「而不是让用户重新分享」「避免让用户…」是反过来说的
 */
const USER_REDO = new RegExp(
  String.raw`(?<!(?:不|(?<![特识区个类级])别|勿|无需|无须|没必要)(?:应该?|能|可以?|该|要|用|必|需|建议)?|而不是|不要再|别再|不再|避免)(?:建议|请|让|需要|可以|引导|提示|告诉|通知)用户[^。；;！!？?\n]{0,20}?(?:重新|再次|重试|再试|换个|换一个|换成|改用)`,
);
const FIXED = /已经?(?:修复|修好|改好|部署|上线|发版)|等[^，,。；;]{0,8}(?:修复|修好|改好|部署|上线|发版)/;
/** 这句话里修没修好、上没上线还没确定（「是否已部署未确认」「不确定是否已修复」「已修复，待确认上线」）：这时让用户重试还是推出去 */
const UNSURE = /是否|是不是|有没有|有无|不确定|不能确定|无法确定|没法确定|无法确认|没法确认|未确认|待确认|还没确认|尚未确认|不清楚/;

/** 回答里有没有把问题推出去的结论。问句（「系统本身没有问题吗？」）、举例的分句（「比如回答『不是服务故障』之前…」）不算 */
function deflects(answer: string): boolean {
  return answer.split(/(?<=[。；;！!？?\n])/).some((sentence) => {
    if (/(?:[？?]|[吗呢][。！!]?)\s*$/.test(sentence)) {
      return false;
    }
    const stated = sentence
      .split(/(?<=[，,])/)
      .filter((clause) => !EXAMPLE.test(clause))
      .join("");
    return DEFLECTING.test(stated) || (USER_REDO.test(stated) && !(FIXED.test(sentence) && !UNSURE.test(sentence)));
  });
}

/**
 * 每次查完、下一轮要思考之前加在工具结果后面的提醒。2026-10-10 转链排查：第 2 轮还是中文，第 3 轮读完一大段英文日志就一直用英文想，
 * 进度卡片上整段英文，群里看着费劲。系统提示词里也写了，但模型想用什么语言跟着最近读到的内容走，离得近的提醒更管用。
 * 原来等想成英文了才提醒，2026-10-12 那次第 3 轮还是先出了一轮英文，所以改成每轮都提前提醒
 */
export const THINK_IN_CHINESE = "（系统提醒，不用回复这句）接下来的思考请用中文写：思考会显示在进度卡片上给群里的人看。代码、日志、报错原文、函数名、命令照原样引用，不用翻译。";

/** 代码块整块去掉：里面的反引号不成对也不会错开后面的配对 */
const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
/** 引号、反引号、书名号里引用的原文：英文思考里引用的中文报错、商品名，中文思考里引用的英文日志 */
const QUOTED_TEXT = /`[^`\n]*`|「[^」]*」|“[^”]*”|【[^】]*】|"[^"\n]*"/g;
/** 连着的一串可见 ASCII 字符。只吃 ASCII，网址后面直接跟着的汉字、全角标点不受影响 */
const ASCII_RUN = /[\x21-\x7e]+/g;
/** 代码标点：带它的 ASCII 串是网址、路径、函数调用（time.Now()）、key=value、日志时间、图片和文件占位符 */
const CODE_PUNCT = /[._/\\()[\]{}=;:<>|]/;
/** 英文行文才有的虚词，大小写照行文的写法（单独的小写 i 多半是循环变量）。带代码标点的词先去掉了，wg.Wait()、time.Now() 不算 */
const ENGLISH_PROSE = /\b(?:[Tt]he|I|[Ll]et|[Mm]e|[Ww]e|[Nn]eed|[Ss]hould|[Nn]ow|[Ss]o|[Oo]kay|[Ww]ait|[Mm]aybe|[Bb]ut|[Ww]hich|[Tt]here|[Tt]hen|[Ss]eems|[Ll]ooks)\b/g;
/** 英文提问里几乎总有的词 */
const ENGLISH_QUESTION = /\b(?:what|why|how|when|where|who|which|is|are|was|were|does|do|did|can|could|would|should|please|I|my|we|our|you|your|it|this|that|the|a|an)\b/i;

/** 去掉带代码标点的 ASCII 串。先整串匹配再判断，不用一个正则回溯着找，几十 KB 的长串也是线性的 */
function dropCodeTokens(text: string): string {
  return text.replace(ASCII_RUN, (run) => (CODE_PUNCT.test(run) ? " " : run));
}

/**
 * 思考是不是用英文写的：去掉代码块、引用的原文和带代码标点的词以后，英文虚词至少 3 个，而且汉字数不到虚词数的 8 倍。
 * 中文思考里引用的英文日志、路径、函数名不带这些虚词；英文思考里没加引号提到的商品名、中文报错也压不过虚词。
 * visible 取实际显示的那部分：先在整段上去掉代码块再取，截断不会把代码块切成两半
 */
export function writtenInEnglish(text: string, visible: (text: string) => string = (all) => all): boolean {
  const plain = dropCodeTokens(visible(text.replace(FENCED_CODE, " ")).replace(QUOTED_TEXT, " "));
  const han = plain.match(/\p{Script=Han}/gu)?.length ?? 0;
  const prose = plain.match(ENGLISH_PROSE)?.length ?? 0;
  return prose >= 3 && han < prose * 8;
}

/**
 * 提问是不是该按中文算：有汉字，或者没有英文提问的常用词（只 @ 了一下、只贴了告警名、链接）；
 * 有日文假名、韩文的不算。@ 的名字、网址、带代码标点的词不看。群里一般说中文，拿不准时按中文
 */
export function askedInChinese(question: string): boolean {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(question)) {
    return false;
  }
  const plain = dropCodeTokens(question.replace(/@\S+/g, " "));
  return /\p{Script=Han}/u.test(plain) || !ENGLISH_QUESTION.test(plain);
}

export const DEFLECTED_ANSWER =
  "（系统检查）你的回答把问题归到了服务之外（比如「不是服务故障」「建议用户重新操作」「属于平台限制」）。这类结论会让大家不再往下查，下之前要拿代码核对清楚：\n" +
  "1. 拿失败请求的特征（链接的域名和关键参数、报错原文、错误码）搜代码，从入口沿主流程看这种输入在哪一步被处理或拒绝，不要只看报错附近的几行；\n" +
  "2. 日志是当时线上那一版打的，代码可能已经改过：用 code_log 按同样的特征查最近的提交，看是不是已经修过，能查线上版本就查，查不了就在结论里写明看的是哪个分支的代码；\n" +
  "3. 结论分开写：当时为什么失败（带日志时间）、现在的代码处不处理、线上部署了没有。\n" +
  "核对完还是服务之外的问题，就照常这么写，并写明核对了哪些代码（只写这次实际读到、搜到的文件和行号）；读不到相关代码就直说没法确认是不是服务的问题。不要提这段检查。";

/**
 * 排查线上问题（调过 aiops 这类 MCP 服务的工具，成没成功都算）以后，回答把问题推到服务之外时，打回一次，让模型先拿代码核对。
 * 2026-10-10 转链排查：模型只看日志就定了「淘宝拒绝、不是服务故障，让用户重新分享」，被打回补查代码时 5 次搜索都在同款推荐那条支路上，
 * 没拿链接里的 pages-fast、topIds 搜一下，漏掉了当天已经合进 master 的修复。这类结论会让用户和开发都不再往下查。
 * 只问代码、没查线上的（「前端不需要修改」）不管。只在有代码工具时装（要模型去搜代码）；核对完还是这个结论就照常发。
 * 重做只有一次：这一项用掉以后，重做的回答里再有没查证的引用就直接拦下，所以提示里要模型只写这次实际读到、搜到的文件和行号
 */
export function reviewDeflectedAnswer(servers: readonly string[], attempted: ReadonlySet<string>) {
  const prefixes = servers.map((name) => `${name}_`);
  return (answer: string): string | undefined => {
    const investigated = [...attempted].some((name) => prefixes.some((prefix) => name.startsWith(prefix)));
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
  /重新(?!总结|整理|汇总|归纳|概括|润色|翻译|改写|复述|写|组织|排版|说|讲|解释|梳理|表述|描述|简化|精简|提炼|转述)|再查|再看|现在(?!把|帮|请|就|给)|目前|最新|实时|查一下|查查|(?:排查|诊断|查询|检查|定位)(?!结果|过程|情况|结论|记录|报告|出|到|的)/;
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

/** 整理、改写已经有的内容：REWRITE_REQUEST 之外，还有讲给谁听、换个说法、用大白话讲（eli5）、精简这类 */
const RESTATE_REQUEST = new RegExp(
  [
    REWRITE_REQUEST.source,
    String.raw`简化|精简|提炼|浓缩|摘要|转述|转告|通俗|大白话|白话|说人话|讲人话|(?:解释|说明)一下|eli5|explain like|tl;?dr|summari[sz]e|summary|translate|rephrase|rewrite|simplify`,
    String.raw`(?:讲|说|解释)给[^，。,.!?！？\n]{1,20}听`,
    String.raw`换(?:个|一种|一个)?(?:说法|方式|角度|口吻|讲法)`,
  ].join("|"),
  "i",
);
const TIME_AMOUNT = String.raw`(?:\d+|[一二两三四五六七八九十半几]+)`;
/**
 * 要看现在的数据：LIVE_REQUEST 之外，带数的时间窗口（「最近 1 小时」「过去 30 分钟」「近三天」「这两天」「2 小时内」），「重查」「复查」「核实」。
 * 只说「今天」「昨天」的不算：「把今天查到的总结一下」是整理
 */
const FRESH_REQUEST = new RegExp(
  [
    String.raw`(?:最近|过去|近|这|前)\s*${TIME_AMOUNT}\s*(?:个\s*)?(?:秒|分钟?|小时|钟头|天|日|周|星期|礼拜|月)`,
    String.raw`${TIME_AMOUNT}\s*(?:个\s*)?(?:秒钟?|分钟|小时|钟头|天|周|星期|礼拜|月)(?:以内|之内|内|以来)`,
    "重查|复查|核实",
  ].join("|"),
);
/**
 * 一句话里夹着要改东西：「修复代码后总结一下」「改代码」「开个 MR」「合并到 uat」。分成几段说的（「总结一下，然后删除这个文件」）见 CLAUSE_BREAK。
 * 说的是之前的方案、过程（「把修复方案总结一下」「总结一下修复后的结果」「讲给负责修复的同事听」）不算；「开发」多半说的是人（「讲给开发同事听」），不算
 */
const NEW_WORK = new RegExp(
  [
    String.raw`(?:修复|修好|修掉|修一下|改掉|改好|重构|优化|实现|上线|发版|部署|重启|回滚)(?!方案|办法|建议|思路|计划|过程|记录|情况|结果|原理|方式|逻辑|细节|架构|时间|空间|方向|点|项|的|了|后的|前的|完的)`,
    String.raw`(?:开|提|建)个?\s*(?:mr|pr|合并请求)`,
    // 「合并到 uat」「也合到 master」「合到 release/1.2」是再开一个合并请求；「合并到飞书文档里」「合到一起」是整理
    String.raw`(?:合并|合)到\s*(?:[a-z][\w./-]*|主干|主分支|测试分支|预发分支?)`,
    String.raw`(?:改|修改)一?下?(?:代码|配置)`,
  ].join("|"),
  "i",
);
/** 提问里的英文词（服务名常不带连字符：appservice、gateway）；整理的说法、常见英文词不算 */
const ASCII_WORDS = /[a-z][a-z0-9_.]{2,}/gi;
const RESTATE_WORDS = new RegExp(
  "^(?:" +
    [
      // 整理的说法和常见英文虚词（「summarize the above for the team」）
      "eli5|tldr|explain|like|five|translate|rephrase|rewrite|simplify|summary|summari[sz]e|english|chinese|simple|plain|short|brief|briefly",
      "the|above|this|that|these|those|please|for|and|with|into|our|your|team|previous|earlier|answer|result|results|version|words|bullet|points",
      // 讲给谁听、写成什么格式（「讲给 SRE 同事听」「整理成 JSON」）
      "sre|devops|ops|dev|devs|ceo|cto|boss|json|yaml|csv|ppt|pdf|excel|word|html|table|markdown|emoji",
    ].join("|") +
    ")$",
  "i",
);
/**
 * 提问拆成几段（标点和「然后」「再」「顺便」这类连接词隔开），每段都要是整理：整理的说法、讲给谁听 / 写成什么样、客气话。
 * 有一段是别的事（「总结一下上面的原因，然后删除这个文件」「概括一下，再跑一下测试」）就不算只整理，照常给工具：
 * 认不出的说法宁可照常查，也不能把要改东西、要查的请求当成整理拿掉工具。「、」不拆：「讲给 @A、@B 听」是一段
 */
const CLAUSE_BREAK = /[，,。;；!！?？\n]|\.(?!\S)|然后|接着|之后|顺便|另外|并且|(?<!合)并|同时|还要|还得|再(?!次)/;
/** 说讲给谁、写成什么样的一段（「写成飞书文档」「让运营也看得懂」「发给运营」「控制在三句话」） */
const FORMAT_CLAUSE = /用|以|按|写成|做成|整理成|弄成|变成|转成|发给|发到|讲给|说给|让|分点|列成|控制在|不超过|篇幅|字数|合并成|合成|合到一起|(?:合并|合|放|写|整理|汇总)(?:到|进)|(?:讲|说|写)得?(?:简单|短|通俗|清楚|明白|详细|具体|口语|正式|轻松)|简单|短一?点|通俗|口语/;
/** 讲给谁、写成什么样的那段里不能有要动手、要查的词（「然后用 aiops 查一下」「用新的写法替换这个函数」） */
const ACTION_WORD = /查|看|搜|读|找|修|改|删|加|建|开|提交|合并|部署|重启|回滚|跑|执行|运行|测|对比|比较|分析|排查|诊断|定位|确认|检查|核对|更新|调整|新增|添加|替换|升级|迁移|实现|重构|优化|处理|解决/;
/** 这些说的是读的人看不看得懂、怎么排版，不是要动手 */
// 「合并到飞书文档里」：合并到分支（「合并到 uat」）NEW_WORK 先认出来了
const HARMLESS_PHRASES = /看得懂|看懂|听得懂|听懂|看得明白|看明白|加粗|合并成|合到一起|(?:合并|合)(?:到|进)/g;
/** 客气话、称呼（@ 的名字去掉以后剩下的「各位同事」） */
const FILLER_CLAUSE = /^(?:谢谢|多谢|辛苦了?|麻烦了?|拜托|好的|ok|嗯|请|各位|大家|同事们?|各位同事)$/i;

function restateClausesOnly(asked: string): boolean {
  return asked
    .replace(/tl;\s*dr/gi, "tldr")
    .split(CLAUSE_BREAK)
    .map((clause) => clause.replace(/[\s~～…]+/g, ""))
    .every(
      (clause) =>
        clause === "" ||
        RESTATE_REQUEST.test(clause) ||
        FILLER_CLAUSE.test(clause) ||
        (FORMAT_CLAUSE.test(clause) && !ACTION_WORD.test(clause.replace(HARMLESS_PHRASES, ""))),
    );
}
/**
 * 要查的对象：线上服务、日志这类（OPS_QUESTION），和代码、配置这类。话题里之前没出现过的，说明问的是新东西，不算整理。
 * 文档、网页链接不算：整理时照样给读文档、网页的工具（「总结成飞书文档」也不能因为说了文档就重查）
 */
const NEW_TARGET = new RegExp(`${OPS_QUESTION.source}|代码|仓库|分支|提交|文件|函数|配置`, "i");
const TARGET_TERMS = new RegExp(NEW_TARGET.source, "gi");

/**
 * 这次只是整理话题里已经有的内容（总结、换个说法、讲给谁听、翻译、精简），不用重新查。
 * 2026-10-14 测试群：转链排查答完以后，有人在同一个话题里 @ 机器人「用 eli5 方式总结给 @某某 同事」，机器人把查经验库、读剧本、查日志、读代码、查提交整个重来了一遍：
 * 提示词说话题里之前的回答不算查证、要重新查，回答前查到的经验也要先核对；模型直接整理的话，回答里的时间、Pod 数、仓库名又会被检查打回去查。
 * 要满足：话题里有上文；提问说的是整理、改写；没说要重新查、看现在的情况，也没说整理完还要分析、查别的；
 * 提问里说到的服务名、日志、代码、配置这类对象话题里之前都出现过（「把 product-service-api 这个问题总结给大家」说的还是之前那个，
 * 「整理一下 gateway 的部署配置」「总结一下上面，再看看 payment-service」问到了新的服务、要读配置，就不是只整理）
 */
export function restatesEarlier(question: string, history: readonly ChatMessage[], names: readonly string[] = []): boolean {
  if (
    history.length === 0 ||
    !RESTATE_REQUEST.test(question) ||
    LIVE_REQUEST.test(question) ||
    FRESH_REQUEST.test(question) ||
    NEW_WORK.test(question)
  ) {
    return false;
  }
  const said = history.map((m) => m.content).join("\n").toLowerCase();
  // @ 的人名、机器人名不算（「@飞书 CLI」「@John」）
  const asked = names.reduce((text, name) => (name ? text.split(`@${name}`).join(" ") : text), question);
  if (!restateClausesOnly(asked)) {
    return false;
  }
  // 话题里没出现过的英文词多半是新的服务名、仓库名（「总结一下 appservice 的报错」，之前聊的是 gateway-api）
  const newWord = (asked.match(ASCII_WORDS) ?? []).some((word) => !RESTATE_WORDS.test(word) && !said.includes(word.toLowerCase()));
  // 「上面的排查结果」说的是之前排查出来的，不是要排查新东西
  const target = asked.replace(/(?:排查|诊断)(?=结果|过程|情况|结论|记录|报告)/g, " ");
  return !newWord && !NEW_TARGET.test(target.replace(TARGET_TERMS, (term) => (said.includes(term.toLowerCase()) ? " " : term)));
}

/** 工具参数里的文字（写文档的正文、记忆的内容） */
function stringArgs(args: Record<string, unknown>): string {
  return Object.values(args)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

export function restatedWriteNote(added: readonly string[]): string {
  const shown = added.slice(0, MAX_RESTATED_ADDITIONS).map((text) => (text.length > 80 ? `${text.slice(0, 80)}…` : text));
  return (
    `这次是整理话题里之前的内容，可要写进去的内容里这些在话题里之前的消息中都找不到：${shown.join("、")}${added.length > shown.length ? " 等" : ""}。` +
    "只写之前的回答和大家说过的话里写过的事实、数据和代码位置，改好再调一次；没写过的就写之前没查到。"
  );
}

/** 整理之前内容时给模型的工具：读群成员给的文档、网页，按要求写成文档、记进群记忆、起草经验。查线上、查代码、搜网页、查经验库、看别的话题的都不给 */
const RESTATE_TOOLS: ReadonlySet<string> = new Set([
  "feishu_doc_read",
  "feishu_doc_create",
  "feishu_doc_edit",
  "fetch_url",
  "memory_search",
  "memory_save",
  "memory_update",
  "memory_delete",
  "knowledge_propose",
  "knowledge_propose_archive",
]);

/** 整理时能读的文档、网页工具，和放链接的参数 */
const RESTATE_READS: ReadonlyMap<string, string> = new Map([
  ["feishu_doc_read", "document"],
  ["fetch_url", "url"],
]);

/** 回答里最多列几处添上的内容 */
const MAX_RESTATED_ADDITIONS = 10;

/**
 * 整理之前内容时，回答里添上的、话题里之前没写过的东西：代码位置（code：配了代码工具时）和线上数据（ops：配了 MCP 服务时，时间、Pod 名、条数这类）。
 * known 是话题里之前的内容（之前的回答、群成员说的）、这次的提问和这次读到的文档网页
 */
export function restatedAdditions(answer: string, known: string, { code, ops }: { code: boolean; ops: boolean }): string[] {
  const cites = code
    ? unseenCodeCitations(answer, (cite, line) => (line === undefined ? mentions(known, cite) : mentionsLine(known, cite, line))).map((cite) => cite.text)
    : [];
  const said = ops ? valueForm(known) : "";
  // 每种写法分开找：「prod、xx-6978f9454f-zzzzz 在 15:39:20 OOM 了 999 次、staging 都有部署」整段是定位结果，里面的 Pod 名、时间、次数也要一个个对
  const data = ops
    ? RESTATE_OPS_PATTERNS.flatMap((pattern) => [...answer.matchAll(pattern)])
        .sort((a, b) => a.index - b.index)
        .map((match) => match[0])
        .filter((text) => !saidValue(said, text) && !TIME_LAYOUT.test(text))
    : [];
  return [...new Set([...cites, ...data])];
}

const RESTATE_OPS_PATTERNS = [...OPS_TIME_PATTERNS, ...OPS_STRONG_PATTERNS, ...OPS_WEAK_PATTERNS].map((pattern) => new RegExp(pattern, "gi"));

/** 比较数据用的写法：去掉空白、不分大小写，时间的小时去掉开头的 0（09:01:48 和 9:01:48 是同一个时间） */
function valueForm(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase().replace(/(?<![\d:])0(\d:\d{2})/g, "$1");
}

/**
 * 这个数据之前写过：整个数对得上才算，15%、14 个 Pod 里的 5%、4 个 Pod 不算（前后紧挨着数字、小数点的不算）；
 * 就绪数只看比值（之前写的是「**1/1** 就绪」，回答写「1/1 就绪」）；只有整个就是就绪数时才这样，一长段里带着个比值的不算
 */
function saidValue(said: string, text: string): boolean {
  const value = valueForm(text);
  const exact = new RegExp(`(?<![\\d.])${escapeRegExp(value)}${/\d$/.test(value) ? "(?!\\.?\\d)" : ""}`);
  const ratio = /(\d+)\/(\d+)/.exec(value);
  if (exact.test(said)) {
    return true;
  }
  // 之前写的也要是就绪数：之前是「请求成功 1/1」，回答写「Ready: 1/1」不算
  const pair = ratio === null ? "" : `${ratio[1]}/${ratio[2]}`;
  return (
    ratio !== null &&
    READINESS_REST.test(value.replace(ratio[0], "")) &&
    new RegExp(
      `(?:就绪|ready)[*_\x60:：]*(?<![\\d.])${pair}(?!\\d)|(?<![\\d.])${pair}(?!\\d)[*_\x60]*(?:就绪|ready|running|副本)`,
    ).test(said)
  );
}

/** 就绪数去掉比值后剩下的：就绪、ready 这类词和 Markdown 符号 */
const READINESS_REST = /^[*_\x60:：]*(?:就绪|ready|running|副本)?[*_\x60:：]*$/i;

export const BLOCKED_RESTATE_ANSWER =
  "这次没能整理好：整理出来的回答里有话题里之前没写过的数据或代码位置，为免误导没有发出来。可以再说一次；要看最新情况，请说「重新查」。";

export function restatedAnswerNote(added: readonly string[]): string {
  const shown = added.slice(0, MAX_RESTATED_ADDITIONS).map((text) => (text.length > 80 ? `${text.slice(0, 80)}…` : text));
  return (
    `（系统检查）这次是整理话题里之前的内容，可回答里这些在话题里之前的消息中都找不到：${shown.join("、")}${added.length > shown.length ? " 等" : ""}。` +
    "只用之前的回答和大家说过的话里写过的事实、数据和代码位置，不要添新的，也不要自己推算新的数；之前没写到的就说之前没查到，要最新情况请对方说「重新查」。" +
    "其余内容不用改，重新给出完整的回答，不要提这段检查。"
  );
}

/**
 * 整理之前内容时检查回答（代替 reviewCodeAnswer、reviewOpsAnswer：那两项会叫模型去查，这次没给查的工具）：
 * 代码位置和线上数据都得是话题里之前写过的，添了新的就打回一次，让模型只用写过的。known 在检查时再取，这次读到的文档网页也算
 */
export function reviewRestatedAnswer(known: () => string, scope: { code: boolean; ops: boolean }) {
  return (answer: string): string | undefined => {
    const added = restatedAdditions(answer, known(), scope);
    return added.length > 0 ? restatedAnswerNote(added) : undefined;
  };
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
  /** 经验库的确认卡片 */
  knowledge?: Pick<KnowledgeDesk, "handleCardAction">;
  /** 回答下面的「接着查」按钮（见 createFollowUp）。不传时不处理 */
  followUp?: (evt: CardActionEvent, question: unknown) => Promise<void>;
  logger?: Logger;
}

/** 处理卡片上的按钮：经验库确认卡片的「保存」「归档」「取消」，回答下面的「接着查」，进度卡片的「停止」（停止后卡片由任务自己更新成「已停止」） */
export function createCardActionHandler({ tasks, allowedChatIds, knowledge, followUp, logger = console }: CardActionDeps) {
  return async (evt: CardActionEvent): Promise<void> => {
    if (await knowledge?.handleCardAction(evt)) {
      return;
    }
    const value = evt.action.value as { action?: unknown; task?: unknown; q?: unknown } | undefined;
    if (!allowedChatIds.has(evt.chatId)) {
      return;
    }
    if (value?.action === ASK_ACTION && followUp) {
      // 不等它跑完：SDK 按群排队处理按钮，等着的话这个群的停止按钮要等接着问的任务跑完才轮得到
      followUp(evt, value.q).catch((err) => logger.error(`接着查按钮处理失败 card=${evt.messageId}`, err));
      return;
    }
    if (value?.action !== STOP_ACTION || typeof value.task !== "string") {
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
    case "too_long":
      return "要看的内容超出了模型一次能读的长度，可以把问题拆小一点，或者说清楚服务、时间范围再问";
  }
}
