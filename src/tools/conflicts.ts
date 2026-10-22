import { createHash, randomUUID } from "node:crypto";
import type { CardActionEvent, SendInput, SendOptions, SendResult } from "@larksuiteoapi/node-sdk";
import { raceAbort } from "../abort.js";
import type { Logger } from "../history.js";
import {
  draftOf,
  findSensitive,
  type KnowledgeDraft,
  type KnowledgeEntry,
  KnowledgeError,
  normalizeDraft,
  normalizeId,
  sameContent,
} from "../knowledge.js";
import { escapeCardMarkdown } from "../markdown.js";
import { type MemoryEntry, type MemoryStore, normalizeContent } from "../memory.js";
import { clickerName, type NameLookup } from "../operator-names.js";
import { MAX_CARD_BYTES } from "../progress.js";
import type { Tool } from "./tool.js";

/** 冲突卡片上下拉框和按钮回传的 action */
export const CONFLICT_ACTION = "kconflict";
/** 发冲突卡片的工具 */
export const CONFLICT_TOOL = "knowledge_propose_conflicts";
/** 一张卡片最多列几处 */
export const MAX_CONFLICTS = 8;
/** 冲突卡片多久以后点了不算 */
export const CONFLICT_TTL_MS = 24 * 60 * 60_000;
/** 「哪里对不上」最多多少字 */
const TOPIC_CHARS = 80;
/** 卡片上列经验库里现在的结论、怎么处理时每项最多多少字（全文在表格里）；要改成的新内容不截，点同步的人要看到全文 */
const CARD_FIELD_CHARS = 300;

/** 每处选以哪边为准：memory 以群记忆为准（改经验库），knowledge 以经验库为准（改群记忆），skip 先不动 */
export type ConflictSide = "memory" | "knowledge" | "skip";

const SIDES: Record<ConflictSide, string> = {
  memory: "以群记忆为准",
  knowledge: "以经验库为准",
  skip: "先不动",
};

interface Person {
  openId: string;
  name?: string;
}

interface ConflictRow {
  /** 一句话说两边哪里对不上 */
  topic: string;
  /** 发卡片时的群记忆：同步时内容还是这样才改 */
  memory: MemoryEntry;
  /** 发卡片时的经验：同步时表格里还是这样才取代（见 KnowledgeBase.save 的 seen） */
  knowledge: KnowledgeEntry;
  /** 以经验库为准时群记忆改成的内容；为空时删掉这条群记忆 */
  memoryFix?: string;
  /** 以群记忆为准时，取代这条经验的新内容 */
  knowledgeDraft: KnowledgeDraft;
  /** 哪边更新；时间一样或者读不出来时为空 */
  newer?: "memory" | "knowledge";
  pick: ConflictSide;
  /** 同步后这一处的结果 */
  result?: string[];
  /** 同步时这一处没做成（没改、没改完、要另一张卡片接着做） */
  failed?: boolean;
}

/** partial：点了同步，但有的地方没改成 */
type ConflictState = "pending" | "working" | "done" | "partial" | "cancelled" | "superseded";

interface ConflictCard {
  id: string;
  chatId: string;
  threadKey: string;
  /** 卡片消息；发出去以后才有 */
  cardMessageId?: string;
  proposer: Person;
  /** 让机器人发卡片的那条消息 */
  sourceMessageId: string;
  createdAt: number;
  state: ConflictState;
  rows: ConflictRow[];
  /** 卡片上额外的一句：不是写权限名单里的人点了同步、点的时候选择变了 */
  note?: string;
  /** 处理完以后卡片上的一句 */
  result?: string;
}

/** 选了以群记忆为准、写权限名单里的人点了同步：按新内容取代经验库里那条 */
export interface ReplaceRequest {
  chatId: string;
  threadKey: string;
  /** 冲突卡片：没做完、要再试的那张确认卡片回复在它下面 */
  replyTo: string;
  sourceMessageId: string;
  proposer: Person;
  operator: Person;
  draft: KnowledgeDraft;
  replaces: KnowledgeEntry;
  /** 存新经验之前再核对一次赢的那边（群记忆）：卡片发出后改过、删了时返回原因，不存 */
  precheck: () => Promise<string | undefined>;
}

/** 冲突卡片要用的经验库操作（KnowledgeDesk 提供） */
export interface ConflictKnowledge {
  /** 一条有效、能列在卡片上的经验；没有、已归档、用不了时抛错 */
  activeEntry(id: string): Promise<KnowledgeEntry>;
  /** 卡片上列的这条经验在表格里还是这样（有效、内容没改过）；读不了表格时抛错 */
  unchanged(seen: KnowledgeEntry): Promise<boolean>;
  /** 取代旧经验，返回结果的几行和是不是都做完了（没做完的另发一张确认卡片接着做） */
  replace(request: ReplaceRequest): Promise<{ lines: string[]; ok: boolean }>;
  /** 经验库表格的链接 */
  location(): Promise<string | undefined>;
}

export interface ConflictDeskOptions {
  memory: MemoryStore;
  knowledge: ConflictKnowledge;
  send: (to: string, input: SendInput, opts?: SendOptions) => Promise<SendResult>;
  updateCard: (messageId: string, card: object) => Promise<void>;
  /** 这个群的写权限名单：要改经验库（选了以群记忆为准）时只有名单里的人能点同步。没有名单的群谁都不能改经验库 */
  approvers: (chatId: string) => ReadonlySet<string> | undefined;
  /** 这个群能改群记忆的人：要改群记忆（选了以经验库为准）时只有他们能点同步。不传、或者这个群没限定时谁都能 */
  memoryEditors?: (chatId: string) => ReadonlySet<string> | undefined;
  allowedChatIds: ReadonlySet<string>;
  /** 卡片回调里没有点的人的名字：用它找（见 createNameLookup）。不传时找不到名字的写「有人」 */
  nameOf?: NameLookup;
  logger?: Logger;
  now?: () => number;
}

/**
 * 群记忆和团队经验库说法对不上时的冲突卡片：模型把对不上的几处列出来，每处写好两个方向各改成什么；
 * 程序发卡片，群里成员每处选以哪边为准（默认选更新的那边），点「按选择同步」后把输的那边改成和赢的一样。
 * 群记忆是这个群自己的，群里谁都能让机器人改（这个群限定了能改群记忆的人时只有他们），只改群记忆时这些人都能点；经验库所有群共用，要改它时只有这个群写权限名单里的人能点，
 * 而且走和「保存」一样的流程（存新的、归档旧的、排查经验同步 aiops）。
 * 卡片内容存在内存里（按钮只回传卡片编号和选项，回调里的内容不可信），机器人重启后旧卡片点了提示失效
 */
export class ConflictDesk {
  private readonly cards = new Map<string, ConflictCard>();
  private readonly running = new Set<Promise<void>>();
  /** 同一个话题里发冲突卡片排队进行，键是群和话题 */
  private readonly publishing = new Map<string, Promise<unknown>>();
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(private readonly options: ConflictDeskOptions) {
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
  }

  /** 发冲突卡片的工具，按任务所在的群和话题创建 */
  tool(ctx: { chatId: string; threadKey: string; senderId: string; askerName?: string; messageId: string }): Tool {
    return {
      spec: {
        name: CONFLICT_TOOL,
        description:
          "群记忆和团队经验库说法对不上时用：把对不上的几处列成一张卡片发到话题里，群里成员每处选以哪边为准（默认选更新的那边），" +
          "点「按选择同步」后两边改成一样的。回答时发现两边说法不一样、或者群成员说「查一下群记忆和经验库有没有冲突」时，把对不上的都列进同一张。" +
          "这里只是发卡片，调用后两边都还没改。同一个话题里再调一次会换成新的卡片（旧卡片作废）。",
        parameters: {
          type: "object",
          properties: {
            conflicts: {
              type: "array",
              maxItems: MAX_CONFLICTS,
              description: `对不上的几处，最多 ${MAX_CONFLICTS} 处。同一条群记忆、同一条经验只列一次`,
              items: {
                type: "object",
                properties: {
                  memory_id: { type: "integer", description: "群记忆编号，即 #3 里的 3" },
                  knowledge_id: { type: "string", description: "经验编号，如 K3" },
                  topic: { type: "string", description: `一句话说两边哪里对不上，${TOPIC_CHARS} 字以内，如「发版日期：群记忆说周三，经验库说周四」` },
                  memory_fix: {
                    type: "string",
                    description: "选「以经验库为准」时这条群记忆改成什么：整条替换，写成一句能独立看懂的话，和经验库的说法一致；这条群记忆整条都过时了就填空字符串，表示删掉它",
                  },
                  knowledge_conclusion: { type: "string", description: "选「以群记忆为准」时这条经验的「结论」改成什么：整段替换，和群记忆的说法一致" },
                  knowledge_handling: {
                    type: "string",
                    description: "选「以群记忆为准」时「怎么处理」也要跟着改才填（整段替换）；要去掉它填空字符串；不用改不填",
                  },
                },
                required: ["memory_id", "knowledge_id", "topic", "memory_fix", "knowledge_conclusion"],
              },
            },
          },
          required: ["conflicts"],
        },
      },
      describe: (args) => `列出群记忆和经验库对不上的地方${Array.isArray(args.conflicts) ? `（${args.conflicts.length} 处）` : ""}`,
      run: async (args, { signal }) => {
        const key = `${ctx.chatId}\n${ctx.threadKey}`;
        const run = (this.publishing.get(key) ?? Promise.resolve()).then(async () => {
          const rows = await this.prepare(ctx.chatId, args.conflicts, signal);
          return this.publish(ctx, rows, signal);
        });
        const settled = run.catch(() => {});
        this.publishing.set(key, settled);
        void settled.then(() => {
          if (this.publishing.get(key) === settled) {
            this.publishing.delete(key);
          }
        });
        return run;
      },
    };
  }

  /** 处理冲突卡片上的下拉框和按钮。不是冲突卡片返回 false */
  async handleCardAction(evt: CardActionEvent): Promise<boolean> {
    const value = evt.action.value as { action?: unknown; card?: unknown; op?: unknown; row?: unknown; v?: unknown } | undefined;
    if (value?.action !== CONFLICT_ACTION || typeof value.card !== "string" || typeof value.op !== "string") {
      return false;
    }
    if (!this.options.allowedChatIds.has(evt.chatId)) {
      return true;
    }
    let operator = person(evt.operator.openId, evt.operator.name);
    const card = this.cards.get(value.card);
    if (!card || card.chatId !== evt.chatId) {
      this.logger.info(`冲突卡片 已失效 card=${value.card} operator=${operator.openId}`);
      await this.options
        .updateCard(evt.messageId, expiredCard("这张卡片已经失效（机器人重启过，或者已经处理完了）。需要的话在话题里再说一次「查一下群记忆和经验库有没有冲突」"))
        .catch((err: unknown) => this.logger.warn("更新冲突卡片失败", err));
      return true;
    }
    // 卡片上要写是谁点的：回调里一般没有名字，去找（找不到写「有人」，不显示 open_id）。
    // 找名字要等，放在下面看卡片状态之前：等的时候卡片可能被换掉、处理掉。选下拉框不用名字
    if (value.op !== "pick") {
      operator = person(operator.openId, await clickerName(evt, card.proposer, this.options.nameOf));
    }
    if (card.state !== "pending" || (card.cardMessageId && evt.messageId !== card.cardMessageId)) {
      return true;
    }
    if (this.now() - card.createdAt > CONFLICT_TTL_MS) {
      this.cards.delete(card.id);
      await this.render(card, expiredCard("这张卡片超过 24 小时，已经失效。需要的话在话题里再说一次「查一下群记忆和经验库有没有冲突」"));
      return true;
    }
    const approver = this.options.approvers(card.chatId)?.has(operator.openId) === true;
    if (value.op === "pick") {
      const index = typeof value.row === "string" ? Number(value.row) : Number.NaN;
      const row = Number.isInteger(index) ? card.rows[index] : undefined;
      const option = evt.action.option;
      if (!row || typeof option !== "string" || !Object.hasOwn(SIDES, option)) {
        return true;
      }
      row.pick = option as ConflictSide;
      card.note = undefined;
      this.logger.info(`冲突卡片 第 ${index + 1} 处选了${SIDES[row.pick]} card=${card.id} operator=${operator.openId}`);
      await this.render(card);
      return true;
    }
    const who = operator.name ?? "有人";
    if (value.op === "cancel") {
      if (!approver && operator.openId !== card.proposer.openId) {
        card.note = `${who}点了取消：只有发起人或写权限名单里的人能取消`;
        await this.render(card);
        return true;
      }
      card.state = "cancelled";
      card.result = `${who}取消了，群记忆和经验库都没改`;
      this.cards.delete(card.id);
      this.logger.info(`冲突卡片 取消 card=${card.id} operator=${operator.openId}`);
      await this.render(card);
      return true;
    }
    if (value.op !== "apply") {
      return true;
    }
    // 点的那张卡片上的选择要是现在记下的：有人刚改了某处的选择、卡片还没刷新过来时，点的人看到的是改之前的
    if (value.v !== picksDigest(card)) {
      card.note = `${who}点的时候卡片上的选择刚被改过，这次没有同步。请核对下面每处的选择后再点「按选择同步」`;
      this.logger.info(`冲突卡片 选择变了，没有同步 card=${card.id} operator=${operator.openId}`);
      await this.render(card);
      return true;
    }
    if (card.rows.every((row) => row.pick === "skip")) {
      card.note = `${who}点了同步：每处都选了「先不动」，没有要改的`;
      await this.render(card);
      return true;
    }
    const changesKnowledge = card.rows.filter((row) => row.pick === "memory").length;
    if (changesKnowledge > 0 && !approver) {
      card.note =
        `${who}点了同步：有 ${changesKnowledge} 处选了「以群记忆为准」，要改经验库（所有群共用），只有写权限名单里的人能点。` +
        "只想改群记忆的话，把那几处改成「以经验库为准」或「先不动」再点";
      this.logger.info(`冲突卡片 要改经验库、不在写权限名单里，没有同步 card=${card.id} operator=${operator.openId}`);
      await this.render(card);
      return true;
    }
    // 这个群限定了谁能改群记忆（MEMORY_EDITORS）：选了以经验库为准的那几处要改群记忆，只有他们能点
    const changesMemory = card.rows.filter((row) => row.pick === "knowledge").length;
    const editors = this.options.memoryEditors?.(card.chatId);
    if (changesMemory > 0 && editors && !editors.has(operator.openId)) {
      card.note =
        `${who}点了同步：有 ${changesMemory} 处选了「以经验库为准」，要改群记忆，这个群只有指定的人能改群记忆。` +
        "只想改经验库的话，把那几处改成「以群记忆为准」或「先不动」再点";
      this.logger.info(`冲突卡片 要改群记忆、不在能改群记忆的名单里，没有同步 card=${card.id} operator=${operator.openId}`);
      await this.render(card);
      return true;
    }
    // 改经验库要存新的、归档旧的、可能还要同步 aiops，放到后台做，回调马上返回
    card.state = "working";
    card.note = undefined;
    const run = this.execute(card, operator).finally(() => this.running.delete(run));
    this.running.add(run);
    return true;
  }

  /** 等点了同步的都执行完（测试和退出前用） */
  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running]);
    }
  }

  /** 检查模型列的每一处，算出哪边更新、默认选哪边。有一处不对就整张不发，告诉模型改哪里 */
  private async prepare(chatId: string, raw: unknown, signal: AbortSignal): Promise<ConflictRow[]> {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new KnowledgeError("conflicts 要列至少一处对不上的地方");
    }
    if (raw.length > MAX_CONFLICTS) {
      throw new KnowledgeError(`一张卡片最多列 ${MAX_CONFLICTS} 处，现在 ${raw.length} 处：先列最要紧的 ${MAX_CONFLICTS} 处，处理完再发下一张`);
    }
    const memories = await this.options.memory.list(chatId);
    const rows: ConflictRow[] = [];
    for (const [index, item] of raw.entries()) {
      const at = `第 ${index + 1} 处`;
      if (!item || typeof item !== "object") {
        throw new KnowledgeError(`${at}要填 memory_id、knowledge_id、topic、memory_fix、knowledge_conclusion`);
      }
      const args = item as Record<string, unknown>;
      const memoryId = memoryIdOf(args.memory_id, at);
      const memory = memories.find((entry) => entry.id === memoryId);
      if (!memory) {
        throw new KnowledgeError(`${at}：这个群没有编号为 #${memoryId} 的群记忆`);
      }
      if (rows.some((row) => row.memory.id === memoryId)) {
        throw new KnowledgeError(`${at}：群记忆 #${memoryId} 列了不止一次。和几条经验都对不上时只列最主要的那条，处理完再发下一张`);
      }
      const knowledgeId = typeof args.knowledge_id === "string" ? args.knowledge_id.trim() : "";
      if (!knowledgeId) {
        throw new KnowledgeError(`${at}：缺少 knowledge_id（经验编号，如 K3）`);
      }
      signal.throwIfAborted();
      const knowledge = await raceAbort(this.options.knowledge.activeEntry(knowledgeId), signal).catch((err: unknown) => {
        throw err instanceof KnowledgeError ? new KnowledgeError(`${at}：${err.message}`) : err;
      });
      if (rows.some((row) => normalizeId(row.knowledge.id) === normalizeId(knowledge.id))) {
        throw new KnowledgeError(`${at}：经验 ${knowledge.id} 列了不止一次。和几条群记忆都对不上时只列最主要的那条，处理完再发下一张`);
      }
      const topic = typeof args.topic === "string" ? args.topic.replace(/\s+/g, " ").trim() : "";
      if (!topic) {
        throw new KnowledgeError(`${at}：缺少 topic（一句话说两边哪里对不上）`);
      }
      if (topic.length > TOPIC_CHARS) {
        throw new KnowledgeError(`${at}：topic 最多 ${TOPIC_CHARS} 字，现在 ${topic.length} 字`);
      }
      const memoryFix = this.memoryFix(args.memory_fix, memory, at);
      const knowledgeDraft = replacementDraft(knowledge, args, at);
      // 卡片群里人人看得到，同步时还会写进群记忆、经验库：像有密钥、手机号、身份证号的不发
      for (const [name, text] of [
        ["topic", topic],
        ["memory_fix", memoryFix ?? ""],
      ] as const) {
        const sensitive = findSensitive(text);
        if (sensitive) {
          throw new KnowledgeError(`${at}：${name} 里像是有${sensitive}。卡片群里人人看得到：去掉或者打码后再发，回答里也不要复述它`);
        }
      }
      const newer = newerSide(memory, knowledge);
      rows.push({ topic, memory, knowledge, ...(memoryFix !== undefined ? { memoryFix } : {}), knowledgeDraft, ...(newer ? { newer } : {}), pick: newer ?? "skip" });
    }
    return rows;
  }

  /** 以经验库为准时群记忆改成的内容：空字符串表示删掉；和现在一样的不算改 */
  private memoryFix(value: unknown, memory: MemoryEntry, at: string): string | undefined {
    if (typeof value !== "string") {
      throw new KnowledgeError(`${at}：memory_fix 要填文字（这条群记忆整条都过时了就填空字符串）`);
    }
    if (!value.trim()) {
      return undefined;
    }
    let text: string;
    try {
      text = normalizeContent(value);
    } catch (err) {
      throw new KnowledgeError(`${at}：memory_fix ${describe(err)}`);
    }
    if (text === memory.content) {
      throw new KnowledgeError(`${at}：memory_fix 和群记忆 #${memory.id} 现在的内容一样。以经验库为准时，要写成和经验库一致的说法`);
    }
    return text;
  }

  private async publish(
    ctx: { chatId: string; threadKey: string; senderId: string; askerName?: string; messageId: string },
    rows: ConflictRow[],
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    this.sweep();
    const card: ConflictCard = {
      id: randomUUID().slice(0, 8),
      chatId: ctx.chatId,
      threadKey: ctx.threadKey,
      proposer: person(ctx.senderId, ctx.askerName),
      sourceMessageId: ctx.messageId,
      createdAt: this.now(),
      state: "pending",
      rows,
    };
    const rendered = renderConflictCard(card);
    if (Buffer.byteLength(JSON.stringify(rendered)) > MAX_CARD_BYTES) {
      throw new KnowledgeError("列的几处合起来太长，卡片放不下（飞书卡片有大小上限）：少列几处分成两张，或者把 memory_fix、knowledge_conclusion 写精炼些");
    }
    const { messageId } = await this.options.send(ctx.chatId, { card: rendered }, { replyTo: ctx.messageId, replyInThread: true });
    card.cardMessageId = messageId;
    if (signal.aborted) {
      card.state = "cancelled";
      card.result = "任务已经停了，这张卡片作废，群记忆和经验库都没改";
      await this.render(card);
      signal.throwIfAborted();
    }
    const replaced = [...this.cards.values()].filter((old) => old.chatId === ctx.chatId && old.threadKey === ctx.threadKey && old.state === "pending");
    for (const old of replaced) {
      old.state = "superseded";
      old.result = "已换成新的冲突卡片，以下面那张为准";
      this.cards.delete(old.id);
    }
    this.cards.set(card.id, card);
    void Promise.all(replaced.map((old) => this.render(old))).catch(() => {});
    this.logger.info(
      `冲突卡片 发出 card=${card.id} ${rows.map((row) => `#${row.memory.id}↔${row.knowledge.id}`).join(" ")} chat=${ctx.chatId} sender=${ctx.senderId} message=${ctx.messageId}`,
    );
    const defaults = rows.map((row, index) => `第 ${index + 1} 处默认${SIDES[row.pick]}`).join("，");
    return (
      `已在话题里发出冲突卡片，列了 ${rows.length} 处（${defaults}）。要等群里成员选好、点「按选择同步」才会改，现在两边都还没改；` +
      "选了以群记忆为准的要改经验库，只有写权限名单里的人能点。回答里按更新的那边说，用一两句话请大家看卡片选，不要把卡片内容再写一遍，也不要说已经改好了。"
    );
  }

  private async execute(card: ConflictCard, operator: Person): Promise<void> {
    await this.render(card);
    const confirmer = operator.name ?? "有人";
    let changedKnowledge = false;
    for (const row of card.rows) {
      if (row.pick === "skip") {
        row.result = ["先不动"];
        continue;
      }
      if (row.pick === "knowledge") {
        const { line, ok } = await this.syncMemory(card, row, operator);
        row.result = [line];
        row.failed = !ok;
        continue;
      }
      try {
        // 赢的那边（群记忆）卡片发出后改过、删了：卡片上的新结论是按旧的写的，不拿它去改经验库。
        // 经验库存新经验前（排在别的取代后面也是轮到时）、没存成另发的确认卡片上点保存时都再核对一次
        const precheck = async (): Promise<string | undefined> => {
          const current = (await this.options.memory.list(card.chatId)).find((entry) => entry.id === row.memory.id);
          return current?.content === row.memory.content
            ? undefined
            : `群记忆 #${row.memory.id} 在卡片发出后改过或者删了，卡片上的新结论是按旧的写的，没改经验 ${row.knowledge.id}`;
        };
        const { lines, ok } = await this.options.knowledge.replace({
          chatId: card.chatId,
          threadKey: card.threadKey,
          replyTo: card.cardMessageId ?? card.sourceMessageId,
          sourceMessageId: card.sourceMessageId,
          proposer: card.proposer,
          operator,
          draft: row.knowledgeDraft,
          replaces: row.knowledge,
          precheck,
        });
        row.result = lines;
        row.failed = !ok;
        changedKnowledge = true;
      } catch (err) {
        this.logger.warn(`冲突卡片 经验 ${row.knowledge.id} 没改成 card=${card.id}`, err);
        row.result = [`经验 ${row.knowledge.id} 没改成：${describe(err)}`];
        row.failed = true;
      }
    }
    const failed = card.rows.filter((row) => row.failed).length;
    card.state = failed > 0 ? "partial" : "done";
    this.cards.delete(card.id);
    card.result =
      `${confirmer}点了「按选择同步」` +
      (failed > 0 ? `，有 ${failed} 处没同步成（见每处的结果），需要的话改好后在话题里再说一次「查一下群记忆和经验库有没有冲突」` : "");
    if (changedKnowledge) {
      const location = await this.options.knowledge.location().catch(() => undefined);
      if (location) {
        card.result += `。经验库表格：${location}`;
      }
    }
    this.logger.info(`冲突卡片 已同步 card=${card.id} ${card.rows.map((row) => `#${row.memory.id}↔${row.knowledge.id}=${row.pick}`).join(" ")} operator=${operator.openId}`);
    await this.render(card);
    const lines = card.rows.map((row, index) => `第 ${index + 1} 处（${row.topic}）：${(row.result ?? []).join(" ")}`);
    await this.options
      .send(card.chatId, { markdown: [...lines, card.result].map(escapeCardMarkdown).join("\n") }, { replyTo: card.cardMessageId ?? card.sourceMessageId, replyInThread: true })
      .catch((err: unknown) => this.logger.warn("冲突卡片：结果没能发到话题里", err));
  }

  /**
   * 以经验库为准：群记忆改成和经验库一样（或者删掉）。卡片发出后这条群记忆改过、删了不动它；
   * 赢的那边（经验）在表格里改过、归档了也不动：卡片上群记忆要改成的内容是按旧的经验写的
   */
  private async syncMemory(card: ConflictCard, row: ConflictRow, operator: Person): Promise<{ line: string; ok: boolean }> {
    const { id } = row.memory;
    try {
      if (!(await this.options.knowledge.unchanged(row.knowledge))) {
        return { line: `经验 ${row.knowledge.id} 在卡片发出后在表格里改过或者归档了，卡片上群记忆要改成的是按旧的写的，没改群记忆 #${id}`, ok: false };
      }
      const outcome = await this.options.memory.replaceIf(card.chatId, id, row.memory.content, row.memoryFix, {
        ...(operator.name ? { name: operator.name } : {}),
        openId: operator.openId,
        messageId: card.sourceMessageId,
      });
      if (outcome === "changed") {
        return { line: `群记忆 #${id} 在卡片发出后改过或者删了，没动它`, ok: false };
      }
      return { line: outcome === "removed" ? `以经验库为准，已删掉群记忆 #${id}` : `以经验库为准，群记忆 #${id} 已改成：${row.memoryFix}`, ok: true };
    } catch (err) {
      this.logger.warn(`冲突卡片 群记忆 #${id} 没改成 card=${card.id}`, err);
      return { line: `群记忆 #${id} 没改成：${describe(err)}`, ok: false };
    }
  }

  private async render(card: ConflictCard, rendered: object = renderConflictCard(card)): Promise<void> {
    if (!card.cardMessageId) {
      return;
    }
    await this.options.updateCard(card.cardMessageId, rendered).catch((err: unknown) => this.logger.warn("更新冲突卡片失败", err));
  }

  /** 过期的卡片不再留在内存里 */
  private sweep(): void {
    for (const [id, card] of this.cards) {
      if (this.now() - card.createdAt > CONFLICT_TTL_MS) {
        this.cards.delete(id);
      }
    }
  }
}

const HEADERS: Record<ConflictState, { title: (card: ConflictCard) => string; template: string }> = {
  pending: { title: (card) => `群记忆和经验库有 ${card.rows.length} 处对不上`, template: "orange" },
  working: { title: () => "正在同步群记忆和经验库…", template: "blue" },
  // 选了「先不动」的那几处两边还是对不上，不能说都同步了
  done: {
    title: (card) => {
      const skipped = card.rows.filter((row) => row.pick === "skip").length;
      return skipped > 0 ? `已按选择同步，有 ${skipped} 处先不动` : "群记忆和经验库已同步";
    },
    template: "green",
  },
  partial: { title: () => "群记忆和经验库没全同步成", template: "orange" },
  cancelled: { title: () => "已取消", template: "grey" },
  superseded: { title: () => "已换成新的卡片", template: "grey" },
};

/**
 * 冲突卡片（飞书卡片 JSON 2.0）：每处列出两边现在的说法、哪边更新、选了以后各改成什么，下面一个下拉框选以哪边为准；
 * 最后是「按选择同步」「取消」。群记忆、经验库、模型写的内容都转义尖括号（escapeCardMarkdown），卡片自己的格式不转
 */
export function renderConflictCard(card: ConflictCard): object {
  const pending = card.state === "pending";
  const elements: object[] = [];
  card.rows.forEach((row, index) => {
    const { memory, knowledge } = row;
    const lines = [
      `**第 ${index + 1} 处：${escapeCardMarkdown(row.topic)}**`,
      `**群记忆 #${memory.id}**（${memoryMeta(memory)}）：${escapeCardMarkdown(memory.content)}`,
      `**经验 ${escapeCardMarkdown(knowledge.id)}**「${escapeCardMarkdown(knowledge.title)}」（${timeOf(knowledge)}）：` +
        [["结论", knowledge.conclusion], ["怎么处理", knowledge.handling]]
          .filter((pair): pair is [string, string] => Boolean(pair[1]))
          .map(([name, value]) => `${name}：${escapeCardMarkdown(clipped(value))}`)
          .join("；"),
    ];
    if (pending) {
      const draft = row.knowledgeDraft;
      const handlingChanged = (draft.handling ?? "") !== (knowledge.handling ?? "");
      lines.push(
        grey(
          row.newer === "memory"
            ? "群记忆这条更新，默认以群记忆为准"
            : row.newer === "knowledge"
              ? "经验库这条更新，默认以经验库为准"
              : "分不出哪边更新，默认先不动",
        ),
        grey(`选「以经验库为准」：${row.memoryFix === undefined ? `删掉群记忆 #${memory.id}` : `群记忆 #${memory.id} 改成「${row.memoryFix}」`}`),
        grey(
          `选「以群记忆为准」：经验 ${knowledge.id} 换成新的一条，结论改成「${draft.conclusion}」` +
            (handlingChanged ? (draft.handling ? `，怎么处理改成「${draft.handling}」` : "，去掉怎么处理") : "") +
            `，其他照旧，旧的 ${knowledge.id} 归档`,
        ),
      );
    }
    elements.push({ tag: "markdown", content: lines.join("\n") });
    if (pending) {
      elements.push({
        tag: "select_static",
        placeholder: { tag: "plain_text", content: "选以哪边为准" },
        initial_option: row.pick,
        options: (Object.keys(SIDES) as ConflictSide[]).map((side) => ({ text: { tag: "plain_text", content: SIDES[side] }, value: side })),
        behaviors: [{ type: "callback", value: { action: CONFLICT_ACTION, card: card.id, op: "pick", row: String(index) } }],
      });
    }
    if (row.result) {
      elements.push({ tag: "markdown", content: `**结果**：${escapeCardMarkdown(row.result.join(" "))}` });
    }
  });
  const notes = [`发起人：${card.proposer.name ?? card.proposer.openId}`];
  if (pending) {
    notes.push(
      "每处默认选的是更新的那边，可以改。选好后点「按选择同步」，输的那边改成和赢的一样。" +
        "只改群记忆的话群里谁都能点；有选「以群记忆为准」的要改经验库（所有群共用），只有写权限名单里的人能点。",
    );
  }
  if (card.note) {
    notes.push(card.note);
  }
  elements.push({ tag: "markdown", content: notes.map((line) => grey(line)).join("\n") });
  if (card.result) {
    elements.push({ tag: "markdown", content: escapeCardMarkdown(card.result) });
  }
  if (pending) {
    elements.push(
      button("按选择同步", "primary", { action: CONFLICT_ACTION, card: card.id, op: "apply", v: picksDigest(card) }),
      button("取消", "default", { action: CONFLICT_ACTION, card: card.id, op: "cancel" }),
    );
  }
  const title = HEADERS[card.state].title(card);
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: title } },
    header: { title: { tag: "plain_text", content: title }, template: HEADERS[card.state].template },
    body: { elements },
  };
}

/** 选「以群记忆为准」时取代这条经验的新内容：结论（和要改的怎么处理）换成模型写的，其他照旧，按起草的规则检查 */
function replacementDraft(entry: KnowledgeEntry, args: Record<string, unknown>, at: string): KnowledgeDraft {
  let old: KnowledgeDraft;
  try {
    old = draftOf(entry);
  } catch (err) {
    throw new KnowledgeError(`${at}：经验 ${entry.id} 在表格里的内容不符合起草的规则（${describe(err)}），请先在表格里改好`);
  }
  if (typeof args.knowledge_conclusion !== "string" || !args.knowledge_conclusion.trim()) {
    throw new KnowledgeError(`${at}：缺少 knowledge_conclusion（以群记忆为准时经验的结论改成什么）`);
  }
  if (args.knowledge_handling !== undefined && args.knowledge_handling !== null && typeof args.knowledge_handling !== "string") {
    throw new KnowledgeError(`${at}：knowledge_handling 要填文字`);
  }
  let draft: KnowledgeDraft;
  try {
    draft = normalizeDraft({
      category: old.category,
      title: old.title,
      scope: old.scope,
      question: old.question,
      conclusion: args.knowledge_conclusion,
      // 填了空字符串就是去掉「怎么处理」；不填照旧
      handling: typeof args.knowledge_handling === "string" ? args.knowledge_handling : old.handling,
      basis: old.basis,
      keywords: old.keywords,
      error_codes: old.errorCodes,
      alertname: old.alertname,
    });
  } catch (err) {
    throw new KnowledgeError(`${at}：${describe(err)}`);
  }
  if (sameContent(draft, old)) {
    throw new KnowledgeError(`${at}：knowledge_conclusion 和经验 ${entry.id} 现在的结论一样。以群记忆为准时，要写成和群记忆一致的说法`);
  }
  return draft;
}

/** 哪边更新：群记忆按修改（没改过按记下）的时间，经验按表格里的修改时间（没有按保存时间） */
function newerSide(memory: MemoryEntry, knowledge: KnowledgeEntry): "memory" | "knowledge" | undefined {
  const a = Date.parse(memory.updatedAt ?? memory.createdAt);
  const b = Date.parse(knowledge.updatedAt ?? knowledge.createdAt);
  // 表格里读不出保存时间时记的是 1970 年，不拿它比
  if (!(a > 0) || !(b > 0) || a === b) {
    return undefined;
  }
  return a > b ? "memory" : "knowledge";
}

function memoryIdOf(value: unknown, at: string): number {
  // 模型有时把编号写成 "#3" 或 "3"
  const id = typeof value === "string" ? Number(value.replace(/^#/, "")) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new KnowledgeError(`${at}：memory_id 不是合法的群记忆编号`);
  }
  return id;
}

/** 卡片上每处的选择和卡片编号的摘要，放在「按选择同步」里：点的时候和现在记下的比，不一样就是点了没刷新的卡片 */
function picksDigest(card: ConflictCard): string {
  return createHash("sha256")
    .update(JSON.stringify([card.id, card.rows.map((row) => row.pick)]))
    .digest("hex")
    .slice(0, 16);
}

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatTime(iso: string): string {
  const time = Date.parse(iso);
  return time > 0 ? TIME_FORMAT.format(new Date(time)) : "时间不详";
}

function memoryMeta(memory: MemoryEntry): string {
  const time = formatTime(memory.updatedAt ?? memory.createdAt);
  return memory.author ? `${escapeCardMarkdown(memory.author)}，${time}` : time;
}

function timeOf(entry: KnowledgeEntry): string {
  return entry.updatedAt ? `修改于 ${formatTime(entry.updatedAt)}` : `保存于 ${formatTime(entry.createdAt)}`;
}

function clipped(value: string): string {
  return value.length > CARD_FIELD_CHARS ? `${value.slice(0, CARD_FIELD_CHARS)}…（后面省略，全文见经验库表格）` : value;
}

function grey(text: string): string {
  return `<font color='grey'>${escapeCardMarkdown(text)}</font>`;
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

/** 飞书里的名字会写进群记忆、日志：像是有密钥或个人信息的不用，只留 open_id */
function person(openId: string, name: string | undefined): Person {
  return { openId, ...(name && !findSensitive(name) ? { name } : {}) };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
