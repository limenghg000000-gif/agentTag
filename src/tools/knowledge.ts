import { randomUUID } from "node:crypto";
import type { CardActionEvent, SendInput, SendOptions, SendResult } from "@larksuiteoapi/node-sdk";
import { isTimeout, raceAbort, timeoutSignal } from "../abort.js";
import type { Logger } from "../history.js";
import {
  draftOf,
  fieldLines,
  formatKnowledge,
  KNOWLEDGE_CATEGORIES,
  type KnowledgeBase,
  type KnowledgeCategory,
  type KnowledgeDraft,
  type KnowledgeEntry,
  KnowledgeError,
  type KnowledgeHit,
  normalizeDraft,
  renderHitsForPrompt,
  StaleProposalError,
  usable,
} from "../knowledge.js";
import { type AiopsLesson, type AiopsLessons, type AiopsSaveResult, renderAiopsHitsForPrompt } from "../knowledge-aiops.js";
import type { McpTaskContext } from "../mcp.js";
import type { Tool } from "./tool.js";

/** 确认卡片上按钮回传的 action */
export const KNOWLEDGE_ACTION = "knowledge";
/** 确认卡片多久以后点了不算 */
export const PROPOSAL_TTL_MS = 24 * 60 * 60_000;
/** 回答前检索时每个库最多写进提示词几条 */
const LOOKUP_HITS = 3;
/** 回答前检索每个库最多等多久，没查完的那边这次不用（比 bot.ts 里整个检索的上限短，查完的那边来得及用上） */
const LOOKUP_MS = 7000;
/** 检索时算向量最多等多久，到了只按关键词（比上面短，留出读表格和按关键词打分的时间） */
const SEMANTIC_MS = 5000;
/** 起草时查「很像的已有经验」最多等多久 */
const SIMILAR_TIMEOUT_MS = 8000;
/** 同步到 aiops 后在表格里记 aiops 编号，失败时一共试几次、每次隔多久 */
const LINK_ATTEMPTS = 3;
const LINK_RETRY_MS = 2000;
/** 改确认卡片失败时一共试几次（每次隔 retryDelayMs） */
const RENDER_ATTEMPTS = 3;

/** 这次任务的信息 */
export interface KnowledgeTaskContext {
  chatId: string;
  threadKey: string;
  senderId: string;
  askerName?: string;
  messageId: string;
}

/** 回答前检索的结果：写进提示词的文字（没查到相近的为空字符串）、查到的编号和没查成的库 */
export interface KnowledgeLookup {
  text: string;
  ids: string[];
  /** 超时或出错、这次没查成的库（「团队经验库」「aiops 经验库」） */
  missed?: string[];
}

interface Person {
  openId: string;
  name?: string;
}

/** partial：已经改了经验库，后面的步骤（同步 aiops、归档旧的）有没成功的，卡片上可以再试一次 */
type ProposalState = "pending" | "working" | "partial" | "done" | "cancelled" | "superseded" | "stale";

interface ProposalBase {
  id: string;
  chatId: string;
  threadKey: string;
  /** 卡片消息；发出去以后才有 */
  cardMessageId?: string;
  proposer: Person;
  /** 让机器人起草的那条消息 */
  sourceMessageId: string;
  createdAt: number;
  state: ProposalState;
  /** 卡片上额外的一句：别人点了保存、上次保存失败 */
  note?: string;
  /** 做完的步骤，卡片上和话题里的结果 */
  result?: string[];
  /** 没做成的步骤（partial 时有），再点一次补上 */
  unfinished?: string[];
  /** 同一个话题里有几张新草稿的卡片正在发：发的时候点这张不算，免得新旧两张都存了 */
  revising?: number;
}

interface SaveProposal extends ProposalBase {
  kind: "save";
  draft: KnowledgeDraft;
  /** 从 aiops 的「案例 #N」沉淀来的 */
  caseId?: number;
  /** 保存后要归档的旧经验 */
  replaces?: KnowledgeEntry;
  /** 经验库里和草稿很像的一条 */
  similar?: { id: string; title: string };
  /** 排查经验，而且接了 aiops：保存时同步一份过去 */
  syncAiops: boolean;
  /** 写多维表格用的幂等编号（UUID）：点保存失败后再点，已经写进去的不会再写一行 */
  requestId: string;
  /** aiops 给了结果的同步（存了，或者有相近的没存）：再试一次时表格里这一行没改过就不再调 save_lesson */
  synced?: AiopsSaveResult;
  /** synced 是按表格里哪个样子同步的 */
  syncedDraft?: KnowledgeDraft;
  /** 调 save_lesson 出错时发过去的内容：可能已经存进去、只是结果没传回来，再试之前先按这些找一下 */
  aiopsUnsure?: KnowledgeDraft[];
}

/** 起草时定下的内容，发卡片时再补上编号、群、话题这些 */
type ProposalDetail = Omit<SaveProposal, keyof ProposalBase> | Omit<ArchiveProposal, keyof ProposalBase>;

/** 被取代的旧经验在 aiops 里同步的那条怎么办：新的进了 aiops 就归档；新的还没进去先留着，再试一次进了再归档；新的不会进 aiops 了就一直留着 */
type OldLesson = "archive" | "keep-until-synced" | "keep";

interface ArchiveProposal extends ProposalBase {
  kind: "archive";
  target: { type: "team"; entry: KnowledgeEntry } | { type: "aiops"; lesson: AiopsLesson };
  reason?: string;
}

type Proposal = SaveProposal | ArchiveProposal;

/** 点确认以后做完的和没做成的，各是发到卡片和话题里的几行 */
interface Outcome {
  done: string[];
  unfinished: string[];
}

export interface KnowledgeDeskOptions {
  base: KnowledgeBase;
  /** aiops 自带的经验库：排查经验同步过去，回答前也查一次。没接 aiops 时不传 */
  aiops?: AiopsLessons;
  send: (to: string, input: SendInput, opts?: SendOptions) => Promise<SendResult>;
  updateCard: (messageId: string, card: object) => Promise<void>;
  /** 能在卡片上点「保存」「归档」的人（open_id）。不配时群里所有人都能 */
  approvers?: ReadonlySet<string>;
  allowedChatIds: ReadonlySet<string>;
  logger?: Logger;
  now?: () => number;
  /** 回答前检索每个库最多等多久、算向量最多等多久、记 aiops 编号失败后隔多久再试（测试时调短） */
  lookupMs?: number;
  semanticMs?: number;
  retryDelayMs?: number;
}

/**
 * 团队经验库的检索、起草和确认：模型起草后，程序把草稿发成确认卡片；写权限名单里的人点「保存」，程序才把卡片上的内容原样写进去。
 * 草稿存在内存里（卡片按钮只回传草稿编号，回调里的内容不可信），机器人重启后旧卡片点了提示失效。
 * 2026-10-09 gateway code=8 那次机器人三次结论都有错，排查经验又会同步给 aiops 的告警自动排查反复引用，所以只有人确认过的才写
 */
export class KnowledgeDesk {
  private readonly proposals = new Map<string, Proposal>();
  /** 点了确认、还在执行的 */
  private readonly running = new Set<Promise<void>>();
  /** 取代旧经验的保存排队进行 */
  private replacing: Promise<unknown> = Promise.resolve();
  /** 同一个话题里发确认卡片排队进行，键是群和话题 */
  private readonly publishing = new Map<string, Promise<void>>();
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly lookupMs: number;
  private readonly semanticMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: KnowledgeDeskOptions) {
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
    this.lookupMs = options.lookupMs ?? LOOKUP_MS;
    this.semanticMs = options.semanticMs ?? SEMANTIC_MS;
    this.retryDelayMs = options.retryDelayMs ?? LINK_RETRY_MS;
  }

  /**
   * 回答前检索：团队经验库和 aiops 经验库一起查，够相近的写进提示词。已经同步到 aiops 的排查经验只列团队经验库那一条。
   * 每个库最多等 lookupMs（飞书接口不认中止信号，到时间就不等了），向量没算完时团队经验库只按关键词。
   * 一边没查成时用另一边的，查了的都没查成时返回 undefined。用户停止任务时抛出中止错误
   */
  async lookup(query: string, task: McpTaskContext, signal?: AbortSignal): Promise<KnowledgeLookup | undefined> {
    const { base, aiops } = this.options;
    const timeout = timeoutSignal(this.lookupMs);
    const semantic = timeoutSignal(this.semanticMs);
    const deadline = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const queryAiops = aiops?.searchable === true;
      const [team, lessons] = await Promise.allSettled([
        raceAbort(base.search(query, { limit: LOOKUP_HITS, semanticDeadline: semantic.signal, ...(signal ? { signal } : {}) }), deadline),
        queryAiops ? raceAbort(aiops.search(query, task, deadline), deadline) : Promise.resolve([]),
      ]);
      signal?.throwIfAborted();
      const missed: string[] = [];
      for (const [name, result] of [["团队经验库", team], ...(queryAiops ? [["aiops 经验库", lessons] as const] : [])] as const) {
        if (result.status === "rejected") {
          missed.push(name);
          const why = isTimeout(result.reason) ? `超过 ${this.lookupMs / 1000} 秒没查完` : describe(result.reason);
          this.logger.warn(`查${name}没查成 message=${task.messageId}：${why}`);
        }
      }
      // 没接 aiops 时不算 aiops 查成了：团队经验库没查成就是都没查成
      if (team.status === "rejected" && (!queryAiops || lessons.status === "rejected")) {
        return undefined;
      }
      const teamHits = team.status === "fulfilled" ? team.value : [];
      // 只去掉团队经验库这次也查到了的：两边检索方式不一样，团队经验库没查到的那条 aiops 查到了，就用 aiops 的
      const synced = new Set(teamHits.flatMap((hit) => (hit.entry.aiopsId === undefined ? [] : [hit.entry.aiopsId])));
      const aiopsHits = (lessons.status === "fulfilled" ? lessons.value : []).filter((hit) => !synced.has(hit.id)).slice(0, LOOKUP_HITS);
      const parts = [
        teamHits.length > 0 ? renderHitsForPrompt(teamHits) : "",
        aiopsHits.length > 0 ? renderAiopsHitsForPrompt(aiopsHits) : "",
      ].filter(Boolean);
      return {
        text: parts.join("\n\n"),
        ids: [...teamHits.map((hit) => hit.entry.id), ...aiopsHits.map((hit) => `aiops#${hit.id}`)],
        missed,
      };
    } finally {
      timeout.clear();
      semantic.clear();
    }
  }

  /**
   * 查经验、看经验、起草保存和归档的工具。otherTools 是这次任务里模型的其他工具名：
   * 没有 aiops_search_knowledge 时不让模型去调它；没接 aiops 时不提同步、归档 aiops 经验和案例编号
   */
  tools(ctx: KnowledgeTaskContext, otherTools: readonly string[] = []): Tool[] {
    const { base } = this.options;
    // 接了 aiops，而且没发现它缺保存、归档经验的工具（还没连上时照样答应，连上了再同步）
    const withAiops = this.options.aiops !== undefined && !this.options.aiops.lacksWriteTools;
    const categories = Object.entries(KNOWLEDGE_CATEGORIES)
      .map(([key, label]) => `${key} ${label}`)
      .join("、");
    const search: Tool = {
      spec: {
        name: "knowledge_search",
        description:
          "在团队经验库里查相近的经验（排查经验、应答卡、数据口径、需求结论）。回答前程序已经按提问查过一次，" +
          "查到报错原文、错误码、服务名这类新线索后，可以换个说法再查。" +
          (otherTools.includes("aiops_search_knowledge") ? "aiops 自带的经验库用 aiops_search_knowledge 查" : ""),
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "要查的问题、现象或关键词" },
            category: { type: "string", enum: Object.keys(KNOWLEDGE_CATEGORIES), description: `只查某一类：${categories}` },
            include_archived: { type: "boolean", description: "连已归档的一起查，默认不查" },
          },
          required: ["query"],
        },
      },
      describe: (args) => `查经验库：${preview(args.query)}`,
      run: async (args, { signal }) => {
        const query = typeof args.query === "string" ? args.query : "";
        const category = typeof args.category === "string" && Object.hasOwn(KNOWLEDGE_CATEGORIES, args.category) ? (args.category as KnowledgeCategory) : undefined;
        // 读表格的接口不认中止信号：任务停了就不等它。向量服务卡住时到期限就只按关键词
        const semantic = timeoutSignal(this.semanticMs);
        try {
          const hits = await raceAbort(
            base.search(query, {
              limit: 5,
              includeArchived: args.include_archived === true,
              signal,
              semanticDeadline: semantic.signal,
              ...(category ? { category } : {}),
            }),
            signal,
          );
          return hits.length > 0 ? renderHitsForPrompt(hits) : "团队经验库里没有相近的经验。";
        } finally {
          semantic.clear();
        }
      },
    };
    const get: Tool = {
      spec: {
        name: "knowledge_get",
        description: "按编号取团队经验库里的一条经验全文（「经验 K3」里的 K3）",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "经验编号，如 K3" } },
          required: ["id"],
        },
      },
      describe: (args) => `看经验 ${String(args.id ?? "")}`,
      run: async (args, { signal }) => {
        const entry = await raceAbort(base.get(String(args.id ?? "")), signal);
        if (!entry) {
          throw new KnowledgeError(`团队经验库里没有 ${String(args.id ?? "")}`);
        }
        if (!usable(entry)) {
          throw new KnowledgeError(unusableNote(entry));
        }
        const location = await raceAbort(base.location(), signal).catch(() => undefined);
        signal.throwIfAborted();
        return `${formatKnowledge(entry)}${location ? `\n经验库表格：${location}` : ""}`;
      },
    };
    const propose: Tool = {
      spec: {
        name: "knowledge_propose",
        description:
          `起草一条经验，发确认卡片到话题里，等写权限名单里的人点「保存」后才写进团队经验库（飞书多维表格${withAiops ? "；排查经验同时存一份到 aiops 经验库" : ""}）。` +
          `群成员说「沉淀成经验」「记到经验库」「把这次排查总结进经验库」${withAiops ? "「把案例 #N 沉淀为经验」" : ""}时用；你自己的结论没人确认过的不要主动存。` +
          "这里只是起草，调用后经验还没存。同一个话题里再调一次会换成新的草稿（旧卡片作废），用来按群成员的意见修改。",
        parameters: {
          type: "object",
          properties: {
            category: { type: "string", enum: Object.keys(KNOWLEDGE_CATEGORIES), description: `类别：${categories}` },
            title: { type: "string", description: "标题，一句话说清是什么问题、什么结论，80 字以内" },
            scope: { type: "string", description: "适用范围：服务名、系统、模块或产品功能" },
            question: { type: "string", description: "问题或场景：现象、用户一般怎么描述、要统计什么、讨论的是什么" },
            conclusion: { type: "string", description: "结论：根因、判断方法、口径定义、讨论结论" },
            handling: { type: "string", description: "怎么处理：解决办法（修没修、提交和分支）、回复口径、怎么查数、后续动作" },
            basis: { type: "string", description: "依据或排查过程：最短能定位到原因的查法、踩过的坑、讨论的理由、需求文档链接" },
            keywords: { type: "string", description: "关键词，逗号分隔：报错原文里的关键字、服务名、用户常用的说法。检索主要靠它们" },
            error_codes: { type: "string", description: "错误码，逗号分隔（排查经验才填）" },
            alertname: { type: "string", description: "告警名（排查经验、而且是告警引起的才填）" },
            ...(withAiops ? { case_id: { type: "integer", description: "从 aiops 的「案例 #N」沉淀来的，填 N" } } : {}),
            replaces: { type: "string", description: "这条是用来取代某条旧经验的，填旧的编号（如 K3），保存后自动归档旧的" },
          },
          required: ["category", "title", "question", "conclusion"],
        },
      },
      describe: (args) => `起草经验：${preview(args.title)}`,
      run: async (args, { signal }) => {
        const draft = normalizeDraft(args);
        const caseId = optionalInteger(args.case_id, "case_id");
        const replacesId = typeof args.replaces === "string" && args.replaces.trim() ? args.replaces : undefined;
        return this.open(ctx, signal, async () => {
          const replaces = replacesId === undefined ? undefined : await raceAbort(this.activeEntry(replacesId), signal);
          const similar = replaces ? undefined : await this.findSimilar(draft, signal);
          return {
            kind: "save",
            draft,
            syncAiops: draft.category === "incident" && withAiops,
            requestId: randomUUID(),
            ...(caseId === undefined ? {} : { caseId }),
            ...(replaces ? { replaces } : {}),
            ...(similar ? { similar: { id: similar.entry.id, title: similar.entry.title } } : {}),
          };
        });
      },
    };
    const archive: Tool = {
      spec: {
        name: "knowledge_propose_archive",
        description:
          `发确认卡片，归档一条过时或错误的经验（归档后不再被检索到）。${withAiops ? "团队经验库的填 id（如 K3），aiops 经验库里的「经验 #N」填 aiops_id。" : "填编号 id（如 K3）。"}` +
          `群成员说「K3 过时了」${withAiops ? "「归档经验 #N」" : ""}时用，先取出来给大家看。等写权限名单里的人点「归档」后才执行。`,
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "团队经验库的编号，如 K3" },
            ...(withAiops ? { aiops_id: { type: "integer", description: "aiops 经验库「经验 #N」里的 N" } } : {}),
            reason: { type: "string", description: "为什么归档，一句话" },
          },
        },
      },
      describe: (args) => `起草归档经验 ${args.id ? String(args.id) : `aiops #${String(args.aiops_id ?? "")}`}`,
      run: async (args, { signal }) => {
        const id = typeof args.id === "string" && args.id.trim() ? args.id : undefined;
        const aiopsId = optionalInteger(args.aiops_id, "aiops_id");
        if ((id === undefined) === (aiopsId === undefined)) {
          throw new KnowledgeError("id 和 aiops_id 填一个：团队经验库的填 id（如 K3），aiops 经验库的填 aiops_id");
        }
        const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim().slice(0, 300) : undefined;
        return this.open(ctx, signal, async () => {
          const target =
            id !== undefined
              ? { type: "team" as const, entry: await raceAbort(this.activeEntry(id), signal) }
              : { type: "aiops" as const, lesson: await this.activeLesson(aiopsId!, ctx, signal) };
          return { kind: "archive", target, ...(reason ? { reason } : {}) };
        });
      },
    };
    return [search, get, propose, archive];
  }

  /** 处理确认卡片上的按钮。不是经验库的卡片返回 false */
  async handleCardAction(evt: CardActionEvent): Promise<boolean> {
    const value = evt.action.value as { action?: unknown; proposal?: unknown; op?: unknown } | undefined;
    if (value?.action !== KNOWLEDGE_ACTION || typeof value.proposal !== "string" || typeof value.op !== "string") {
      return false;
    }
    if (!this.options.allowedChatIds.has(evt.chatId)) {
      return true;
    }
    const operator: Person = { openId: evt.operator.openId, ...(evt.operator.name ? { name: evt.operator.name } : {}) };
    const proposal = this.proposals.get(value.proposal);
    if (!proposal || proposal.chatId !== evt.chatId) {
      this.logger.info(`经验库卡片 已失效 proposal=${value.proposal} operator=${operator.openId}`);
      await this.options
        .updateCard(evt.messageId, expiredCard("这张卡片已经失效（机器人重启过，或者草稿已经处理完了）。要存的话，在话题里再说一次「沉淀成经验」"))
        .catch((err: unknown) => this.logger.warn("更新经验库卡片失败", err));
      return true;
    }
    if (proposal.state !== "pending" && proposal.state !== "partial") {
      return true;
    }
    if (proposal.revising) {
      this.logger.info(`经验库卡片 新草稿正在发，这张先不处理 proposal=${proposal.id} operator=${operator.openId}`);
      return true;
    }
    if (this.now() - proposal.createdAt > PROPOSAL_TTL_MS) {
      this.proposals.delete(proposal.id);
      if (proposal.state === "partial") {
        giveUp(proposal, "卡片超过 24 小时，下面没做成的不再试了，需要的话请手动处理：");
        await this.render(proposal);
      } else {
        await this.render(proposal, expiredCard("这张卡片超过 24 小时，已经失效。要存的话，在话题里再说一次「沉淀成经验」"));
      }
      return true;
    }
    const approver = !this.options.approvers || this.options.approvers.has(operator.openId);
    const who = operator.name ?? "有人";
    if (value.op === "cancel") {
      if (!approver && operator.openId !== proposal.proposer.openId) {
        proposal.note = `${who}点了取消：只有发起人或写权限名单里的人能取消`;
        await this.render(proposal);
        return true;
      }
      if (proposal.state === "partial") {
        giveUp(proposal, `${who}点了「不用了」，下面没做成的不再试了：`);
      } else {
        proposal.state = "cancelled";
        proposal.result = [`${who}取消了，没有改动经验库`];
      }
      this.proposals.delete(proposal.id);
      this.logger.info(`经验库卡片 取消 proposal=${proposal.id} operator=${operator.openId}`);
      await this.render(proposal);
      return true;
    }
    if (!approver) {
      proposal.note = `${who}点了确认：只有写权限名单里的人能确认，这次没有执行`;
      this.logger.info(`经验库卡片 不在写权限名单里，没有执行 proposal=${proposal.id} operator=${operator.openId}`);
      await this.render(proposal);
      return true;
    }
    // 建表、写表格、同步 aiops 加起来可能要好几秒，放到后台做，按钮回调马上返回（飞书等回调有时限，同一个群的卡片回调还要排队）
    proposal.state = "working";
    proposal.note = undefined;
    const run = this.execute(proposal, operator).finally(() => this.running.delete(run));
    this.running.add(run);
    return true;
  }

  /** 等点了确认的都执行完（测试和退出前用） */
  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running]);
    }
  }

  private async execute(proposal: Proposal, operator: Person): Promise<void> {
    await this.render(proposal);
    const task: McpTaskContext = { chatId: proposal.chatId, senderId: operator.openId, messageId: proposal.sourceMessageId };
    const confirmedBy = operator.name ?? operator.openId;
    let outcome: Outcome;
    try {
      outcome = proposal.kind === "save" ? await this.save(proposal, confirmedBy, task) : await this.archive(proposal, confirmedBy, task);
    } catch (err) {
      if (err instanceof StaleProposalError) {
        proposal.state = "stale";
        proposal.note = err.message;
        this.proposals.delete(proposal.id);
        await this.render(proposal);
        return;
      }
      // 再试一次时第一步就失败了：上次做完的还在，卡片还是「没做完」
      proposal.state = proposal.unfinished ? "partial" : "pending";
      proposal.note = `上次点确认没成功：${describe(err)}。可以再点一次`;
      this.logger.warn(`经验库卡片 执行失败 proposal=${proposal.id}`, err);
      await this.renderButtons(proposal);
      return;
    }
    proposal.result = outcome.done;
    if (outcome.unfinished.length > 0) {
      // 经验库已经改了，后面有步骤没成功：卡片留着「再试一次」。每一步都能重做（表格按草稿编号认、aiops 先找再存、归档过的不再报错），做完的不会做两遍
      proposal.state = "partial";
      proposal.unfinished = outcome.unfinished;
      this.logger.warn(`经验库卡片 有步骤没做成 proposal=${proposal.id}：${outcome.unfinished.join("；")}`);
      await this.renderButtons(proposal);
      return;
    }
    proposal.state = "done";
    proposal.unfinished = undefined;
    this.proposals.delete(proposal.id);
    await this.render(proposal);
    await this.options
      .send(proposal.chatId, { markdown: proposal.result.join("\n") }, { replyTo: proposal.cardMessageId ?? proposal.sourceMessageId, replyInThread: true })
      .catch((err: unknown) => this.logger.warn("经验库：结果没能发到话题里", err));
  }

  /**
   * 保存，排查经验再同步到 aiops，取代旧经验的再归档旧的。存进团队经验库失败时抛错；后面的步骤失败记在 unfinished 里，卡片可以再试一次。
   * 取代旧经验的一张一张来：两张卡片取代同一条时，后点的那张存之前就能看到旧的已经归档了
   */
  private save(proposal: SaveProposal, confirmedBy: string, task: McpTaskContext): Promise<Outcome> {
    if (!proposal.replaces) {
      return this.saveNow(proposal, confirmedBy, task);
    }
    const run = this.replacing.then(() => this.saveNow(proposal, confirmedBy, task));
    this.replacing = run.catch(() => {});
    return run;
  }

  private async saveNow(proposal: SaveProposal, confirmedBy: string, task: McpTaskContext): Promise<Outcome> {
    const { base } = this.options;
    const { draft } = proposal;
    // 再试一次时草稿编号一样，已经写进去的直接返回那一行
    const entry = await base.save(draft, {
      proposedBy: proposal.proposer.name ?? proposal.proposer.openId,
      confirmedBy,
      source: `飞书群 ${proposal.chatId} 的话题（消息 ${proposal.sourceMessageId}）`,
      requestId: proposal.requestId,
      ...(proposal.replaces ? { replaces: proposal.replaces.id, seen: proposal.replaces } : {}),
    });
    // 旧经验按表格里现在的样子来：卡片发出后可能有人在表格里改过它的 aiops 编号
    const replaced = proposal.replaces && ((await base.get(proposal.replaces.id).catch(() => undefined)) ?? proposal.replaces);
    const out: Outcome = { done: [`已存进团队经验库：经验 ${entry.id}「${entry.title || draft.title}」，确认人 ${entry.confirmedBy ?? confirmedBy}。`], unfinished: [] };
    // aiops 里没有新的这条时，不归档被取代的旧经验在 aiops 里的那条，免得 aiops 里这个问题一条都不剩
    const oldLesson = proposal.syncAiops ? await this.syncAiops(proposal, entry, replaced?.aiopsId, confirmedBy, task, out) : "archive";
    if (replaced) {
      await this.archiveReplaced(replaced, confirmedBy, task, oldLesson, out);
    }
    const location = await base.location().catch(() => undefined);
    if (location) {
      out.done.push(`经验库表格：${location}`);
    }
    return out;
  }

  /** 排查经验同步到 aiops，再在表格里记下 aiops 编号；返回被取代的旧经验在 aiops 里那条怎么办 */
  private async syncAiops(
    proposal: SaveProposal,
    entry: KnowledgeEntry,
    replacedLesson: number | undefined,
    confirmedBy: string,
    task: McpTaskContext,
    out: Outcome,
  ): Promise<OldLesson> {
    if (proposal.synced && !(await this.keepSynced(proposal, proposal.synced, entry, confirmedBy, task, out))) {
      return "keep-until-synced";
    }
    if (!proposal.synced) {
      const skip = this.skipSync(entry);
      if (skip) {
        out.done.push(`${skip}，没有同步到 aiops 经验库。`);
        return "keep";
      }
      // 再试一次前有人在表格里清空了标题、结论，或者写进了密钥：不按卡片上的草稿同步，等表格里改好了再试
      if (!usable(entry)) {
        out.unfinished.push(`经验 ${entry.id} 在表格里${entry.incomplete ?? entry.unsafe}，没有同步到 aiops 经验库。请在表格里改好后再点「再试一次」`);
        return "keep-until-synced";
      }
      try {
        proposal.synced = await this.saveLesson(proposal, entry, replacedLesson, confirmedBy, task);
        proposal.syncedDraft = draftOf(entry);
      } catch (err) {
        out.unfinished.push(`没能同步到 aiops 经验库：${describe(err)}`);
        return "keep-until-synced";
      }
    }
    const { synced } = proposal;
    if (!synced.saved) {
      out.done.push(`aiops 经验库里已经有相近的经验 #${synced.duplicate.id}「${synced.duplicate.title}」，没有重复同步。`);
      return "archive";
    }
    out.done.push(`已同步到 aiops 经验库（经验 #${synced.id}），告警自动排查也能用上。`);
    if (entry.aiopsId !== synced.id) {
      try {
        await this.linkAiops(entry, synced.id);
      } catch (err) {
        out.unfinished.push(
          `没能在经验库表格里记下 aiops 编号 #${synced.id}（${describe(err)}）。不记下的话检索时会列出两遍，以后归档 ${entry.id} 时 aiops 里这条也不会跟着归档`,
        );
      }
    }
    return "archive";
  }

  /**
   * 上次已经同步过去、后面的步骤没做成，再试之前有人在表格里改了这一行、归档了或者改了类别：aiops 里那条已经不对了。
   * 是这次存进去的就归档它、忘掉上次的结果，接着按表格里现在的样子来（还该同步的重新存）。归档没成功时返回 false，下次再试
   */
  private async keepSynced(
    proposal: SaveProposal,
    synced: AiopsSaveResult,
    entry: KnowledgeEntry,
    confirmedBy: string,
    task: McpTaskContext,
    out: Outcome,
  ): Promise<boolean> {
    const current = rowDraft(entry);
    const changed = this.rowChange(entry) ?? (current && JSON.stringify(current) === JSON.stringify(proposal.syncedDraft) ? undefined : `经验 ${entry.id} 在表格里改过`);
    if (!changed) {
      return true;
    }
    if (synced.saved) {
      const { aiops } = this.options;
      try {
        if (!aiops?.writable) {
          throw new KnowledgeError(aiops?.lacksWriteTools ? lacksToolsNote(aiops) : "aiops 现在连不上");
        }
        await aiops.archive(synced.id, confirmedBy, task);
      } catch (err) {
        out.unfinished.push(`${changed}，上次同步到 aiops 的经验 #${synced.id} 已经不对了，没能归档：${describe(err)}`);
        return false;
      }
      out.done.push(`${changed}，上次同步到 aiops 的经验 #${synced.id} 已经不对了，已归档。`);
    }
    proposal.synced = undefined;
    proposal.syncedDraft = undefined;
    return true;
  }

  /** 表格里这一行现在不该或者不能同步到 aiops 的原因：再试一次前有人在表格里归档了它、改了类别，或者 aiops 没有写入工具 */
  private skipSync(entry: KnowledgeEntry): string | undefined {
    return this.rowChange(entry) ?? (this.options.aiops?.lacksWriteTools ? lacksToolsNote(this.options.aiops) : undefined);
  }

  /** 表格里这一行已经不是有效的排查经验了：再试一次前有人在表格里归档了它、改了类别 */
  private rowChange(entry: KnowledgeEntry): string | undefined {
    if (entry.status !== "active") {
      return `经验 ${entry.id} 在表格里已经归档了`;
    }
    if (entry.category !== "incident") {
      return `经验 ${entry.id} 在表格里已经改成「${KNOWLEDGE_CATEGORIES[entry.category]}」，不是排查经验了`;
    }
    return undefined;
  }

  /**
   * 写进 aiops。写的是表格里现在这一行（再试一次前可能有人在表格里改过），不是卡片上的草稿。
   * 上次调用出错了（可能已经存进去，只是结果没传回来）时，先找这条团队经验同步过去的，找到了就不再存
   */
  private async saveLesson(
    proposal: SaveProposal,
    entry: KnowledgeEntry,
    replacedLesson: number | undefined,
    confirmedBy: string,
    task: McpTaskContext,
  ): Promise<AiopsSaveResult> {
    const { aiops } = this.options;
    if (!aiops?.writable) {
      throw new KnowledgeError("aiops 现在连不上");
    }
    const draft = draftOf(entry);
    try {
      const existing = proposal.aiopsUnsure ? await aiops.findSynced(proposal.aiopsUnsure, entry.id, task) : undefined;
      if (existing !== undefined) {
        return { saved: true, id: existing };
      }
      const options = { confirmedBy, teamId: entry.id, ...(proposal.caseId === undefined ? {} : { caseId: proposal.caseId }) };
      const synced = await aiops.save(draft, options, task);
      if (!synced.saved && replacedLesson !== undefined && synced.duplicate.id === replacedLesson) {
        // aiops 说很像的正是要取代的那条：本来就是同一个问题的新版本，照样存，旧的后面归档
        const forced = await aiops.save(draft, { ...options, force: true }, task);
        if (!forced.saved) {
          // aiops 不认 force（版本旧）：不能算进了 aiops，不然旧的那条会被归档，aiops 里这个问题一条都不剩
          throw new KnowledgeError(`aiops 说新的这条和要取代的经验 #${replacedLesson} 重复，带上 force 也没有存`);
        }
        return forced;
      }
      return synced;
    } catch (err) {
      if (!proposal.aiopsUnsure?.some((sent) => JSON.stringify(sent) === JSON.stringify(draft))) {
        proposal.aiopsUnsure = [...(proposal.aiopsUnsure ?? []), draft];
      }
      throw err;
    }
  }

  private async archive(proposal: ArchiveProposal, confirmedBy: string, task: McpTaskContext): Promise<Outcome> {
    const { target } = proposal;
    if (target.type === "aiops") {
      await this.options.aiops!.archive(target.lesson.id, confirmedBy, task);
      return {
        done: [`已归档 aiops 经验 #${target.lesson.id}「${target.lesson.title}」，确认人 ${confirmedBy}。以后检索不到它，告警自动排查也不再引用。`],
        unfinished: [],
      };
    }
    // 用归档时表格里的 aiops 编号：上次同步没做成、再试一次时会重新同步、记下新的编号。归档前核对那条是不是从这一条同步过去的
    const entry = await this.options.base.archive(target.entry.id, { confirmedBy, seen: target.entry });
    const out: Outcome = { done: [`已归档经验 ${entry.id}「${entry.title}」，确认人 ${confirmedBy}。以后检索不到它。`], unfinished: [] };
    if (entry.aiopsId !== undefined) {
      await this.archiveLinked(entry.id, entry.aiopsId, confirmedBy, task, out);
    }
    return out;
  }

  /** 在表格里记下同步到 aiops 后的编号，失败隔一会儿再试，都没成功时抛错 */
  private async linkAiops(entry: KnowledgeEntry, aiopsId: number): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.options.base.linkAiops(entry.id, aiopsId);
        return;
      } catch (err) {
        if (attempt >= LINK_ATTEMPTS) {
          this.logger.warn(`经验库：${entry.id} 没能记下 aiops 编号 ${aiopsId}`, err);
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
  }

  /** 保存新经验后归档被取代的旧经验；它在 aiops 里同步的那条按 oldLesson 归档或者留着 */
  private async archiveReplaced(old: KnowledgeEntry, confirmedBy: string, task: McpTaskContext, oldLesson: OldLesson, out: Outcome): Promise<void> {
    let entry: KnowledgeEntry;
    try {
      entry = await this.options.base.archive(old.id, { confirmedBy });
    } catch (err) {
      out.unfinished.push(`旧的经验 ${old.id} 没能归档：${describe(err)}。不归档的话新旧两条都会被检索到`);
      return;
    }
    out.done.push(`旧的经验 ${entry.id}「${entry.title}」已归档。`);
    if (entry.aiopsId === undefined) {
      return;
    }
    if (oldLesson === "keep-until-synced") {
      out.unfinished.push(`aiops 经验库里同步的旧经验 #${entry.aiopsId} 先留着没归档：新的这条进了 aiops 再归档它，不然告警自动排查就查不到这个问题了。`);
      return;
    }
    if (oldLesson === "keep") {
      out.done.push(`aiops 经验库里同步的旧经验 #${entry.aiopsId} 留着没归档：新的这条没有同步过去，归档了 aiops 里就没有这个问题的经验了。`);
      return;
    }
    await this.archiveLinked(entry.id, entry.aiopsId, confirmedBy, task, out);
  }

  /** 团队经验库里归档的排查经验，aiops 里同步的那条也归档。编号是表格里记的：aiops 里那条不是从这一条同步过去的不归档 */
  private async archiveLinked(teamId: string, aiopsId: number, confirmedBy: string, task: McpTaskContext, out: Outcome): Promise<void> {
    const { aiops } = this.options;
    try {
      if (!aiops?.writable) {
        throw new KnowledgeError(aiops?.lacksWriteTools ? lacksToolsNote(aiops) : "aiops 现在连不上");
      }
      await aiops.archiveSynced(aiopsId, teamId, confirmedBy, task);
      out.done.push(`aiops 经验库里同步的经验 #${aiopsId} 也已归档。`);
    } catch (err) {
      out.unfinished.push(`aiops 经验库里同步的经验 #${aiopsId} 没能归档：${describe(err)}`);
    }
  }

  /** 取一条有效的经验；不存在或已归档时抛错，让模型如实转告 */
  private async activeEntry(id: string): Promise<KnowledgeEntry> {
    const entry = await this.options.base.get(id);
    if (!entry) {
      throw new KnowledgeError(`团队经验库里没有 ${id}`);
    }
    if (entry.status !== "active") {
      throw new KnowledgeError(`经验 ${entry.id} 已经归档了`);
    }
    // 卡片上会列出它的内容，群里人人都看得到
    if (!usable(entry)) {
      throw new KnowledgeError(unusableNote(entry));
    }
    return entry;
  }

  private async activeLesson(id: number, ctx: KnowledgeTaskContext, signal: AbortSignal): Promise<AiopsLesson> {
    const { aiops } = this.options;
    if (!aiops?.writable) {
      throw new KnowledgeError(`${aiops?.lacksWriteTools ? lacksToolsNote(aiops) : "aiops 现在连不上"}，现在不能归档 aiops 经验库里的经验`);
    }
    const lesson = await aiops.get(id, { chatId: ctx.chatId, senderId: ctx.senderId, messageId: ctx.messageId }, signal);
    if (lesson.status !== "active") {
      throw new KnowledgeError(`aiops 经验 #${id} 已经归档了`);
    }
    return lesson;
  }

  /** 经验库里和草稿很像的一条；没查成（超时、出错）时卡片上不提示。用户停止任务时抛出中止错误 */
  private async findSimilar(draft: KnowledgeDraft, signal: AbortSignal): Promise<KnowledgeHit | undefined> {
    const timeout = timeoutSignal(SIMILAR_TIMEOUT_MS);
    const semantic = timeoutSignal(this.semanticMs);
    try {
      return await raceAbort(
        this.options.base.similar(draft, { signal, semanticDeadline: semantic.signal }),
        AbortSignal.any([signal, timeout.signal]),
      );
    } catch (err) {
      signal.throwIfAborted();
      this.logger.warn(`经验库：起草时没查成有没有很像的经验，卡片上不提示：${isTimeout(err) ? "超时" : describe(err)}`);
      return undefined;
    } finally {
      timeout.clear();
      semantic.clear();
    }
  }

  /**
   * 同一个话题里的起草一条一条来，从查要取代的、查很像的经验开始排队：模型一次回复里同时起草两条时，一起查、一起发的话，
   * 前一张发出去后被点了确认、后一张还在查或者还在发，后一张发完作废旧卡片时就漏了前一张，两条都会存。
   * 排队以后后一张发的时候前一张已经登记好，先不让点，发出去就作废它
   */
  private open(ctx: KnowledgeTaskContext, signal: AbortSignal, prepare: () => Promise<ProposalDetail>): Promise<string> {
    const key = `${ctx.chatId}\n${ctx.threadKey}`;
    const run = (this.publishing.get(key) ?? Promise.resolve()).then(async () => {
      // 查和发新卡片的时候旧卡片先不让点，发出去了旧卡片作废；没发出去时旧卡片还能用
      const holding = [...this.proposals.values()].filter((old) => old.chatId === ctx.chatId && old.threadKey === ctx.threadKey && old.state === "pending");
      for (const old of holding) {
        old.revising = (old.revising ?? 0) + 1;
      }
      try {
        return await this.publish(ctx, await prepare(), signal);
      } finally {
        for (const old of holding) {
          old.revising = (old.revising ?? 1) - 1;
        }
      }
    });
    const settled = run.then(
      () => {},
      () => {},
    );
    this.publishing.set(key, settled);
    void settled.then(() => {
      if (this.publishing.get(key) === settled) {
        this.publishing.delete(key);
      }
    });
    return run;
  }

  /** 新建草稿、发确认卡片，卡片发出去以后再作废这个话题里还没确认的旧草稿；返回给模型的说明 */
  private async publish(ctx: KnowledgeTaskContext, detail: ProposalDetail, signal: AbortSignal): Promise<string> {
    // 排队、查的时候任务可能停了：停掉的任务不发卡片，发出去的卡片还能被点保存
    signal.throwIfAborted();
    const proposal = {
      ...detail,
      id: randomUUID().slice(0, 8),
      chatId: ctx.chatId,
      threadKey: ctx.threadKey,
      proposer: { openId: ctx.senderId, ...(ctx.askerName ? { name: ctx.askerName } : {}) },
      sourceMessageId: ctx.messageId,
      createdAt: this.now(),
      state: "pending",
    } as Proposal;
    this.sweep();
    const { messageId } = await this.options.send(ctx.chatId, { card: renderProposalCard(proposal) }, { replyTo: ctx.messageId, replyInThread: true });
    proposal.cardMessageId = messageId;
    // 卡片发的时候任务停了：卡片已经发出去，作废它、不登记，停掉的任务发的卡片不能再点保存；旧卡片照旧能用
    if (signal.aborted) {
      proposal.state = "cancelled";
      proposal.result = ["任务已经停了，这张卡片作废，没有改动经验库"];
      this.logger.info(`经验库卡片 发出时任务已经停了，作废 proposal=${proposal.id} chat=${ctx.chatId} message=${ctx.messageId}`);
      await this.render(proposal);
      signal.throwIfAborted();
    }
    const replaced = [...this.proposals.values()].filter((old) => old.chatId === ctx.chatId && old.threadKey === ctx.threadKey && old.state === "pending");
    for (const old of replaced) {
      old.state = "superseded";
      old.result = ["已换成新的草稿，以下面的卡片为准"];
      this.proposals.delete(old.id);
    }
    // 先登记新卡片再去改旧卡片：改卡片要调接口，这期间点新卡片也认。
    // 旧卡片在后台改，不等：等的时候这个话题里排在后面的草稿开始不了，新卡片没被它拦着，被点了确认的话两条都会存
    this.proposals.set(proposal.id, proposal);
    void Promise.all(replaced.map((old) => this.render(old))).catch((err: unknown) => this.logger.warn("更新经验库旧卡片失败", err));
    this.logger.info(
      `经验库卡片 发出 proposal=${proposal.id} ${proposal.kind === "save" ? `保存「${proposal.draft.title}」` : `归档 ${targetLabel(proposal.target)}`} ` +
        `chat=${ctx.chatId} sender=${ctx.senderId} message=${ctx.messageId}`,
    );
    const action = proposal.kind === "save" ? "保存" : "归档";
    const similar = proposal.kind === "save" && proposal.similar ? `卡片上提示了经验库里很像的 ${proposal.similar.id}，请大家确认是不是重复。` : "";
    return (
      `已在话题里发出确认卡片，要等写权限名单里的人点「${action}」才会执行，现在还没有${action}。${similar}` +
      "回答里用一两句话请大家看卡片确认，不要把草稿内容再写一遍，也不要说已经存好了；有要改的请他直接在话题里说。"
    );
  }

  /** 改卡片，失败了隔一会儿再试；都没成功时返回 false */
  private async render(proposal: Proposal, card: object = renderProposalCard(proposal)): Promise<boolean> {
    if (!proposal.cardMessageId) {
      return false;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await this.options.updateCard(proposal.cardMessageId, card);
        return true;
      } catch (err) {
        if (attempt >= RENDER_ATTEMPTS) {
          this.logger.warn("更新经验库卡片失败", err);
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
  }

  /**
   * 执行完又能点了（没做完、上次没成功）：卡片在「正在…」那一步已经去掉了按钮，改不回来的话按钮就没了、没做成的再也补不上。
   * 这时在话题里重新发一张带按钮的，以后按新的这张为准
   */
  private async renderButtons(proposal: Proposal): Promise<void> {
    if ((await this.render(proposal)) || !proposal.cardMessageId) {
      return;
    }
    try {
      const { messageId } = await this.options.send(
        proposal.chatId,
        { card: renderProposalCard(proposal) },
        { replyTo: proposal.cardMessageId, replyInThread: true },
      );
      proposal.cardMessageId = messageId;
      this.logger.info(`经验库卡片 改不了，重新发了一张 proposal=${proposal.id} message=${messageId}`);
    } catch (err) {
      this.logger.warn(`经验库卡片 改不了，重新发也没成功 proposal=${proposal.id}`, err);
    }
  }

  /** 过期的草稿不再留在内存里；做了一半的卡片写上没做成的，免得以后点了只提示失效 */
  private sweep(): void {
    for (const [id, proposal] of this.proposals) {
      if (this.now() - proposal.createdAt > PROPOSAL_TTL_MS) {
        this.proposals.delete(id);
        if (proposal.state === "partial") {
          giveUp(proposal, "卡片超过 24 小时，下面没做成的不再试了，需要的话请手动处理：");
          void this.render(proposal);
        }
      }
    }
  }
}

const HEADERS: Record<ProposalState, { save: string; archive: string; template: string }> = {
  pending: { save: "存进经验库？", archive: "归档这条经验？", template: "blue" },
  working: { save: "正在存进经验库…", archive: "正在归档…", template: "blue" },
  partial: { save: "已存进经验库，还有没做成的", archive: "已归档，还有没做成的", template: "orange" },
  done: { save: "已存进经验库", archive: "已归档", template: "green" },
  cancelled: { save: "已取消", archive: "已取消", template: "grey" },
  superseded: { save: "已换成新的草稿", archive: "已换成新的草稿", template: "grey" },
  stale: { save: "已作废", archive: "已作废", template: "grey" },
};

/** 确认卡片（飞书卡片 JSON 2.0）：草稿全文、说明和按钮；处理完以后去掉按钮，写上结果 */
export function renderProposalCard(proposal: Proposal): object {
  const header = HEADERS[proposal.state];
  const notes: string[] = [];
  let body: [string, string][];
  if (proposal.kind === "save") {
    body = [["类别", KNOWLEDGE_CATEGORIES[proposal.draft.category]], ["标题", proposal.draft.title], ...fieldLines(proposal.draft)];
    if (proposal.caseId !== undefined) {
      notes.push(`来自 aiops 案例 #${proposal.caseId}`);
    }
    if (proposal.replaces) {
      notes.push(`保存后归档旧的经验 ${proposal.replaces.id}「${proposal.replaces.title}」`);
    }
    if (proposal.similar && proposal.state === "pending") {
      notes.push(
        `经验库里已有很像的经验 ${proposal.similar.id}「${proposal.similar.title}」。确实是不同的问题再点「保存」；是同一个问题的更新，请在话题里说，起草时带上要取代的旧编号`,
      );
    }
    if (proposal.syncAiops) {
      notes.push("排查经验会同时存一份到 aiops 经验库，告警自动排查也会引用");
    }
  } else if (proposal.target.type === "team") {
    const { entry } = proposal.target;
    body = [["编号", entry.id], ["类别", KNOWLEDGE_CATEGORIES[entry.category]], ["标题", entry.title], ...fieldLines(entry)];
  } else {
    const { lesson } = proposal.target;
    body = (
      [
        ["编号", `aiops 经验 #${lesson.id}`],
        ["标题", lesson.title],
        ["适用服务", lesson.service],
        ["现象", lesson.symptom],
        ["根因", lesson.root_cause],
        ["处理办法", lesson.solution],
      ] as [string, string | undefined][]
    ).filter((pair): pair is [string, string] => Boolean(pair[1]));
  }
  if (proposal.kind === "archive" && proposal.reason) {
    notes.push(`归档原因：${proposal.reason}`);
  }
  notes.push(`发起人：${proposal.proposer.name ?? proposal.proposer.openId}`);
  if (proposal.state === "pending") {
    notes.push(
      proposal.kind === "save"
        ? "点「保存」后存进团队经验库，所有群都能查到。只有写权限名单里的人能点；要改哪里，直接在话题里说。"
        : "只有写权限名单里的人能点「归档」。",
    );
  }
  if (proposal.state === "partial") {
    notes.push("点「再试一次」补上没做成的，做完的不会再做一遍；只有写权限名单里的人能点。不需要了就点「不用了」。");
  }
  if (proposal.note) {
    notes.push(proposal.note);
  }
  const elements: object[] = [
    { tag: "markdown", content: body.map(([name, value]) => `**${name}**：${value}`).join("\n") },
    { tag: "markdown", content: notes.map((line) => `<font color='grey'>${line}</font>`).join("\n") },
  ];
  if (proposal.result) {
    elements.push({ tag: "markdown", content: proposal.result.join("\n") });
  }
  if (proposal.unfinished) {
    elements.push({ tag: "markdown", content: ["**没做成的**：", ...proposal.unfinished.map((line) => `- ${line}`)].join("\n") });
  }
  if (proposal.state === "pending" || proposal.state === "partial") {
    const op = proposal.kind === "archive" ? "archive" : "save";
    const retry = proposal.state === "partial";
    elements.push(
      button(retry ? "再试一次" : op === "archive" ? "归档" : "保存", op === "archive" && !retry ? "danger" : "primary", {
        action: KNOWLEDGE_ACTION,
        proposal: proposal.id,
        op,
      }),
      button(retry ? "不用了" : "取消", "default", { action: KNOWLEDGE_ACTION, proposal: proposal.id, op: "cancel" }),
    );
  }
  const title = proposal.kind === "save" ? header.save : header.archive;
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: title } },
    header: { title: { tag: "plain_text", content: title }, template: header.template },
    body: { elements },
  };
}

/** 做了一半的卡片不再试了：没做成的写进结果，卡片收起按钮 */
function giveUp(proposal: Proposal, lead: string): void {
  proposal.state = "done";
  proposal.result = [...(proposal.result ?? []), lead, ...(proposal.unfinished ?? []).map((line) => `- ${line}`)];
  proposal.unfinished = undefined;
  proposal.note = undefined;
}

function expiredCard(text: string): object {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "已失效" } },
    header: { title: { tag: "plain_text", content: "已失效" }, template: "grey" },
    body: { elements: [{ tag: "markdown", content: text }] },
  };
}

function button(text: string, type: string, value: Record<string, string>): object {
  return { tag: "button", text: { tag: "plain_text", content: text }, type, size: "small", behaviors: [{ type: "callback", value }] };
}

function targetLabel(target: ArchiveProposal["target"]): string {
  return target.type === "team" ? target.entry.id : `aiops #${target.lesson.id}`;
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const n = typeof value === "string" ? Number(value.replace(/^#/, "")) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new KnowledgeError(`${name} 要填正整数`);
  }
  return n;
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** aiops 少了同步、归档要用的哪些工具 */
function lacksToolsNote(aiops: AiopsLessons): string {
  return `aiops 少了同步、归档经验要用的工具（${aiops.missingWriteTools.join("、")}）`;
}

/** 表格里这一行现在的内容，按起草的规则检查过的；缺了必填的、太长的、写进了密钥的返回 undefined */
function rowDraft(entry: KnowledgeEntry): KnowledgeDraft | undefined {
  if (!usable(entry)) {
    return undefined;
  }
  try {
    return draftOf(entry);
  } catch {
    return undefined;
  }
}

/** 表格里有人写进了密钥、缺了标题或结论的那一条：不给模型看，让人去表格里改 */
function unusableNote(entry: KnowledgeEntry): string {
  if (entry.unsafe) {
    return `经验 ${entry.id} 在表格里被改过，${entry.unsafe}，先不给你看。请群里有写权限的人直接在经验库表格里删掉密钥，回答里不要猜它的内容`;
  }
  return `经验 ${entry.id} 在表格里${entry.incomplete}，先不用它。请群里有写权限的人在经验库表格里补上`;
}
