import { createHash } from "node:crypto";
import { anySignal, isTimeout, raceAbort, timeoutSignal } from "./abort.js";
import type { Logger } from "./history.js";

/**
 * 经验的类别。字段是同一套，每类存的是下次还能用上的部分，不存会过期的结果（某天的统计数字、某次的 Pod 名）：
 * 排查经验存现象、根因、处理办法和排查路径；应答卡存用户怎么描述、怎么判断、怎么回复、什么时候转开发；
 * 数据口径存指标的定义、数据来源和查法；需求结论存讨论出的结论和理由，附需求文档链接
 */
export const KNOWLEDGE_CATEGORIES = {
  incident: "排查经验",
  answer: "应答卡",
  metric: "数据口径",
  decision: "需求结论",
  other: "其他",
} as const;

export type KnowledgeCategory = keyof typeof KNOWLEDGE_CATEGORIES;

/** 标题的字数上限 */
export const MAX_TITLE_CHARS = 80;
/** 表格里编号那一列写进了像密钥的东西时，读出来的编号换成这个 */
const HIDDEN_ID = "（编号里像是有密钥）";
/** 正文每个字段的字数上限 */
export const MAX_FIELD_CHARS = 2000;
/** 写进系统提示词时每条经验最多多少字 */
const PROMPT_ENTRY_CHARS = 1200;
/** 写进系统提示词时每个字段最多多少字：问题写得很长时结论也要放得下 */
const PROMPT_FIELD_CHARS = 400;
/** 写进系统提示词时先列的字段：模型要用的是结论和处理办法 */
const PROMPT_FIRST_FIELDS = ["结论", "怎么处理"];
/** 列表多久重新读一次：多维表格里有人直接改了，过一会儿就能用上 */
const CACHE_MS = 60_000;
/** 读一次整张表最多等多久：飞书接口不认中止信号，卡住的读不能留在缓存里，让后面的检索和保存都跟着等 */
const READ_TIMEOUT_MS = 15_000;
/** 一次给向量模型的条数（百炼 text-embedding-v4 一次最多 10 条） */
const EMBED_BATCH = 10;
/** 算向量时每条最多多少字 */
const EMBED_TEXT_CHARS = 2000;
/** 检索用的文字里，结论、处理办法、问题、排查过程各最多取多少字：哪一项写得很长，别的也要留在里面 */
const INDEX_FIELD_CHARS = 450;
/** 提问最多取多少字去检索 */
const QUERY_CHARS = 1000;
/** 语义相似度到这个数才算相近 */
const SEMANTIC_MIN = 0.5;
/** 没有向量时，关键词得分到这个数才算相近 */
const KEYWORD_MIN = 0.35;
/** 起草时和已有经验的语义相似度到这个数，卡片上提示「很像」 */
const NEAR_DUPLICATE_SEMANTIC = 0.85;
/** 没有向量时，关键词得分到这个数提示「很像」 */
const NEAR_DUPLICATE_KEYWORD = 0.7;
/** 向量服务出错后多久再试 */
const EMBED_RETRY_MS = 10 * 60_000;

/** 一条经验的内容，起草和保存时用 */
export interface KnowledgeDraft {
  category: KnowledgeCategory;
  title: string;
  /** 适用范围：服务、系统、模块或产品功能 */
  scope?: string;
  /** 问题或场景：现象、用户怎么描述、要统计什么、讨论的是什么 */
  question: string;
  /** 结论：根因、判断方法、口径定义、讨论结论 */
  conclusion: string;
  /** 怎么处理：解决办法、回复口径、怎么查数、后续动作 */
  handling?: string;
  /** 依据或排查过程：怎么查出来的、踩过的坑、讨论的理由、需求文档链接 */
  basis?: string;
  /** 关键词：报错原文里的关键字、服务名、用户常用的说法，逗号分隔 */
  keywords?: string;
  /** 错误码，逗号分隔（排查经验才有） */
  errorCodes?: string;
  /** 告警名（告警引起的排查经验才有） */
  alertname?: string;
}

export interface KnowledgeEntry extends KnowledgeDraft {
  /** 经验库编号，如 K12。和群记忆的 #N、aiops 的「案例 #N」「经验 #N」都不是一回事 */
  id: string;
  status: "active" | "archived";
  /** 谁让机器人起草的 */
  proposedBy?: string;
  /** 谁在确认卡片上点了保存 */
  confirmedBy?: string;
  /** 来源：哪个群、哪条消息 */
  source?: string;
  /** 排查经验同步到 aiops 经验库后的编号（aiops 的「经验 #N」） */
  aiopsId?: number;
  /** 哪张确认卡片存的：保存的结果没传回来、再点一次时，靠它认出已经存过 */
  requestId?: string;
  /** 这条取代的旧经验编号。旧的还没归档时（归档那步没做成），别的卡片不能再取代它 */
  replaces?: string;
  /** 取代的旧经验的草稿编号：旧的那一行之后在表格里改了编号也认得出，不会被别的卡片再取代一次 */
  replacesRequestId?: string;
  createdAt: string;
  updatedAt?: string;
  /** 有人直接在表格里写进了像密钥的东西（哪一项里像是有什么）：不拿来检索，也不给模型看 */
  unsafe?: string;
  /**
   * 表格里这一行缺了标题或结论（写到一半、有人清空了），或者哪一项比起草时的字数上限还长（有人在表格里加长了）：
   * 编号、去重照常算它，不拿来检索，也不拿它同步、归档
   */
  incomplete?: string;
  /**
   * 表格里不止一行用了这个编号（有人复制了行、改错了编号）：说「经验 K3」时分不清是哪一行。
   * 和 incomplete 一样编号照常算，这几行都不拿来检索、给模型看、同步、归档
   */
  conflict?: string;
  /**
   * 后端里这一行的行 id（多维表格的 record_id），读表、写进去时带上。归档、记 aiops 编号时按它改读表时核对过的那一行：
   * 不按编号再查一遍，编号随时可能在表格里被改给了别的行
   */
  rowId?: string;
}

export interface KnowledgeMeta {
  proposedBy?: string;
  confirmedBy?: string;
  source?: string;
  /** 确认卡片的草稿编号（UUID）。同一个编号只存一次 */
  requestId?: string;
  /** 要取代的旧经验编号：存之前确认它还有效，免得两张卡片各存一条新的去取代同一条 */
  replaces?: string;
  /**
   * 卡片上给大家看的那一条（要归档的、要取代的）：确认时表格里的这一行和它不一样了（卡片发出后有人在表格里改过），
   * 大家确认的就不是现在这条，卡片作废
   */
  seen?: KnowledgeEntry;
}

export interface SearchOptions {
  limit?: number;
  category?: KnowledgeCategory;
  includeArchived?: boolean;
  /** 用户停止任务：整个检索都中止 */
  signal?: AbortSignal;
  /** 算向量的期限：到了就不等向量，这次只按关键词（不算向量服务出错） */
  semanticDeadline?: AbortSignal;
}

/** 存经验的地方（飞书多维表格）。编号由 KnowledgeBase 分配 */
export interface KnowledgeBackend {
  /** 给人看的位置：多维表格链接；还没建好时为空 */
  location(): Promise<string | undefined>;
  list(): Promise<KnowledgeEntry[]>;
  /** 写进一行，返回这一行的行 id（后端不给时为空） */
  add(entry: KnowledgeEntry): Promise<string | void>;
  /** 改读表时核对过的那一行（按它的 rowId，不按编号重新查） */
  update(row: Pick<KnowledgeEntry, "id" | "rowId">, changes: Partial<Pick<KnowledgeEntry, "status" | "aiopsId">>): Promise<void>;
  /** 发出过的最大编号，表格里删掉的行也算。不记的后端不实现，编号只按表格里现有的往后排 */
  issued?(): Promise<number>;
  /** 写进表格之前先记下要发的编号 */
  issue?(number: number): Promise<void>;
}

/** 把文字转成向量，用来按意思检索 */
export interface Embedder {
  readonly model: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

export interface KnowledgeHit {
  entry: KnowledgeEntry;
  score: number;
  /** 语义相似度；没有向量时为空 */
  semantic?: number;
}

export class KnowledgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeError";
  }
}

/** 卡片上的内容已经不成立了（比如要取代的旧经验已经被别的卡片取代），这张卡片作废，再点也没用 */
export class StaleProposalError extends KnowledgeError {
  constructor(message: string) {
    super(message);
    this.name = "StaleProposalError";
  }
}

/** 要归档的那一行在表格里找不到了（编号和草稿编号都对不上，多半是删掉了） */
export class MissingEntryError extends KnowledgeError {
  constructor(message: string) {
    super(message);
    this.name = "MissingEntryError";
  }
}

export interface KnowledgeBaseOptions {
  embedder?: Embedder;
  logger?: Logger;
  now?: () => Date;
  cacheMs?: number;
  readTimeoutMs?: number;
}

/**
 * 团队经验库：所有群共用，人确认过的结论才存进来。检索按关键词加语义（配了向量模型时），
 * 列表缓存一分钟，向量按内容缓存，内容没变不重算。保存排队进行，编号按发过的最大编号加一（删掉的行的编号不再发）
 */
export class KnowledgeBase {
  private readonly embedder?: Embedder;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly cacheMs: number;
  private readonly readTimeoutMs: number;
  private cached?: { at: number; entries: Promise<KnowledgeEntry[]> };
  /** 已经警告过的表格行（编号加上缺了什么、哪里像有密钥），同一个问题只警告一次 */
  private readonly warned = new Set<string>();
  private readonly vectors = new Map<string, number[]>();
  /** 上次按哪一次读到的表格清过向量缓存 */
  private prunedFor?: Promise<KnowledgeEntry[]>;
  private embedFailedAt?: number;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly backend: KnowledgeBackend,
    options: KnowledgeBaseOptions = {},
  ) {
    this.embedder = options.embedder;
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => new Date());
    this.cacheMs = options.cacheMs ?? CACHE_MS;
    this.readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  }

  location(): Promise<string | undefined> {
    return this.backend.location();
  }

  async entries(fresh = false): Promise<KnowledgeEntry[]> {
    const at = this.now().getTime();
    if (fresh || !this.cached || at - this.cached.at > this.cacheMs) {
      const entries = this.read();
      this.cached = { at, entries };
      // 读失败、超时都不缓存，下次重新读
      entries.catch(() => {
        if (this.cached?.entries === entries) {
          this.cached = undefined;
        }
      });
    }
    return structuredClone(await this.cached.entries);
  }

  /**
   * 读整张表，超过 readTimeoutMs 就不等了、报错（还在读的那次回来了也不用）。
   * 表格能直接改：缺了标题或结论、改得超长的行（incomplete）、有人写进了密钥的行（unsafe）记下来，编号、去重照常算它们，检索、给模型看时跳过
   */
  private read(): Promise<KnowledgeEntry[]> {
    const timeout = timeoutSignal(this.readTimeoutMs);
    const reading = raceAbort(this.backend.list(), timeout.signal).then(
      (entries) => markConflicts(entries.map((entry) => this.checkRow(entry))),
      (err: unknown) => {
        throw isTimeout(err) ? new KnowledgeError(`读经验库表格超过 ${this.readTimeoutMs / 1000} 秒没读完，这次没读到`) : err;
      },
    );
    void reading.then(timeout.clear, timeout.clear);
    return reading;
  }

  private checkRow(entry: KnowledgeEntry): KnowledgeEntry {
    const missing = [entry.title ? "" : "标题", entry.conclusion ? "" : "结论"].filter(Boolean);
    // 字数上限和起草时一样：表格里改得超长的行放不进卡片和提示词
    const tooLong = draftFields(entry)
      .filter(([, text, limit]) => text !== undefined && text.trim().length > limit)
      .map(([name, , limit]) => `${name}超过了 ${limit} 字`);
    const incomplete = [missing.length > 0 ? `${missing.join("、")}是空的` : "", ...tooLong].filter(Boolean).join("，") || undefined;
    const unsafe = entrySecret(entry);
    const warning = [incomplete && `${incomplete}，请在表格里改好`, unsafe && `${unsafe}，请在表格里删掉`].filter(Boolean).join("；");
    if (!warning) {
      return entry;
    }
    // 编号里就写着密钥的：编号换成 HIDDEN_ID，日志、卡片、报错里写到这一行时都不会写出来。
    // 这一行不检索、不同步、不归档，用不着原来的编号；编号也不是 K 加数字，不影响发新编号
    const id = findSecret(entry.id) ? HIDDEN_ID : entry.id;
    if (!this.warned.has(`${entry.id}\n${warning}`)) {
      this.warned.add(`${entry.id}\n${warning}`);
      this.logger.warn(`经验库：表格里 ${id} 的${warning}。这一行先不拿来检索、也不给模型看`);
    }
    return { ...entry, id, ...(incomplete ? { incomplete } : {}), ...(unsafe ? { unsafe } : {}) };
  }

  /** 按编号取一条；fresh 时不用缓存，重新读表格 */
  async get(id: string, { fresh = false }: { fresh?: boolean } = {}): Promise<KnowledgeEntry | undefined> {
    const wanted = normalizeId(id);
    return (await this.entries(fresh)).find((entry) => normalizeId(entry.id) === wanted);
  }

  /**
   * 之前存进去的那一行（再试一次时用）：先按草稿编号找，找不到再按编号找。两列都能在表格里改，改了其中一列也认得出来，
   * 不会当成没存过再存一行（飞书按 client_token 认出是同一次写入、不建新行，新编号就对不上表格里的那一行了）。
   * 按编号找到的行带着别的草稿编号时不算（见 byRequestOrId）
   */
  async saved(requestId: string, id: string): Promise<KnowledgeEntry | undefined> {
    return byRequestOrId(await this.entries(true), requestId, id);
  }

  /** 按提问找相近的经验，默认只看有效的，按相近程度排序 */
  async search(query: string, { limit = 3, category, includeArchived = false, signal, semanticDeadline }: SearchOptions = {}): Promise<KnowledgeHit[]> {
    const text = query.trim().slice(0, QUERY_CHARS);
    if (!text) {
      return [];
    }
    const entries = await this.entries();
    this.pruneVectors(entries);
    const candidates = entries.filter(
      (entry) => usable(entry) && (includeArchived || entry.status === "active") && (!category || entry.category === category),
    );
    if (candidates.length === 0) {
      return [];
    }
    const semantic = await this.similarities(text, candidates, signal, semanticDeadline);
    return candidates
      .map((entry, i) => scoreEntry(entry, text, semantic?.[i]))
      .filter((hit): hit is KnowledgeHit => hit !== undefined)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** 和草稿很像的已有经验（起草时在卡片上提示，免得存重复的） */
  async similar(draft: KnowledgeDraft, options: Pick<SearchOptions, "signal" | "semanticDeadline"> = {}): Promise<KnowledgeHit | undefined> {
    const [hit] = await this.search(indexText(draft), { ...options, limit: 1 });
    if (!hit) {
      return undefined;
    }
    return (hit.semantic ?? 0) >= NEAR_DUPLICATE_SEMANTIC || (hit.semantic === undefined && hit.score >= NEAR_DUPLICATE_KEYWORD) ? hit : undefined;
  }

  /** 存一条新经验，返回带编号的条目。同一个 requestId 已经存过时不再存，返回存过的那条 */
  save(draft: KnowledgeDraft, meta: KnowledgeMeta = {}): Promise<KnowledgeEntry> {
    return this.exclusive(async () => {
      const entries = await this.entries(true);
      const saved = meta.requestId ? byRequestId(entries, meta.requestId) : undefined;
      if (saved) {
        // 后来在表格里写进了密钥的不写标题
        this.logger.info(`经验库 ${saved.id}${saved.unsafe ? "" : `「${saved.title}」`}上次已经存进去了（草稿 ${meta.requestId}），不重复保存`);
        return saved;
      }
      let replaces: string | undefined;
      let replacesRequestId: string | undefined;
      if (meta.replaces) {
        const wanted = normalizeId(meta.replaces);
        const old = cardTarget(entries, meta.replaces, meta.seen);
        if (old?.status !== "active") {
          throw new StaleProposalError(
            `要取代的经验 ${meta.replaces} ${old ? "已经归档了（可能已经被别的卡片取代）" : "不在经验库里了"}，这张卡片不能再保存。需要的话请重新起草`,
          );
        }
        // 别的卡片已经存了取代它的新经验、只是归档旧的那步没做成：再存一条，就会有两条新的同时有效
        // 取代它的新经验记的是当时的编号：卡片上的编号、它现在的编号都算
        // 旧的那一行之后又改了编号（取代它的新经验记的编号就对不上了）：按它的草稿编号认
        const oldIds = new Set([wanted, normalizeId(old.id)]);
        const successor = entries.find(
          (entry) =>
            entry.status === "active" &&
            ((entry.replaces !== undefined && oldIds.has(normalizeId(entry.replaces))) ||
              (old.requestId !== undefined && entry.replacesRequestId === old.requestId)),
        );
        if (successor) {
          throw new StaleProposalError(
            `经验 ${old.id} 已经有取代它的新经验 ${successor.id}${successor.unsafe ? "" : `「${successor.title}」`}，只是旧的还没归档，这张卡片不能再保存。要改的话请在 ${successor.id} 的基础上重新起草，或者直接归档 ${old.id}`,
          );
        }
        checkSeen(old, meta.seen);
        replaces = old.id;
        replacesRequestId = old.requestId;
      }
      // 表格里删掉的行的编号也不再发：旧消息里提到的 K 编号、aiops 里注明的出处还指着原来那条。
      // 先记下再写表格，写失败了跳过一个号，不会重复
      const issued = (await this.backend.issued?.()) ?? 0;
      const next = entries.reduce((max, entry) => Math.max(max, numberOf(entry.id)), issued) + 1;
      // 再往后发一个也要能精确表示（numberOf、读 issued.json 都按这个认）：不然这次发出去的编号下次就不认了，后面都存不了
      if (!Number.isSafeInteger(next + 1)) {
        throw new KnowledgeError(
          `经验编号已经排到了 K${next - 1}，再发新编号就超出能精确表示的整数了，先不保存。可能有人在表格里填了特别大的编号：请改掉它，再把数据目录里 issued.json 的 highest 改成实际用到的最大编号`,
        );
      }
      await this.backend.issue?.(next);
      const entry: KnowledgeEntry = {
        ...draft,
        id: `K${next}`,
        status: "active",
        ...(meta.proposedBy ? { proposedBy: meta.proposedBy } : {}),
        ...(meta.confirmedBy ? { confirmedBy: meta.confirmedBy } : {}),
        ...(meta.source ? { source: meta.source } : {}),
        ...(meta.requestId ? { requestId: meta.requestId } : {}),
        ...(replaces ? { replaces } : {}),
        ...(replacesRequestId ? { replacesRequestId } : {}),
        createdAt: this.now().toISOString(),
      };
      const rowId = await this.backend.add(entry);
      this.cached = undefined;
      this.logger.info(`经验库 新增 ${entry.id}「${entry.title}」 类别=${entry.category} 发起人=${meta.proposedBy ?? "未知"} 确认人=${meta.confirmedBy ?? "未知"}`);
      return rowId ? { ...entry, rowId } : entry;
    });
  }

  /**
   * 归档一条经验：不再被检索到，表格里还留着，改回「有效」就恢复。
   * 已经归档了的直接返回：上次点确认时表格改成功了、结果没传回来，再点一次要能接着做后面的（归档 aiops 里那条）。
   * 先按卡片上那条的草稿编号认（卡片发出后编号被改了、或者复制出来的行占着旧编号也认得对），没有草稿编号或者找不到时按编号认；
   * 两个都对不上时抛 MissingEntryError
   */
  archive(id: string, meta: KnowledgeMeta = {}): Promise<KnowledgeEntry> {
    return this.exclusive(async () => {
      const entries = await this.entries(true);
      const entry = cardTarget(entries, id, meta.seen);
      if (!entry) {
        // 没有草稿编号的行（表格里手动加的、导入的）认不出是删了，还是改了编号又改了内容：不当成删了，卡片留着
        if (meta.seen && !meta.seen.requestId) {
          throw new KnowledgeError(
            `表格里找不到经验 ${id}。这一行没有草稿编号，认不出是被删了还是改了编号：改了编号的请改回 ${id} 后再点一次卡片上的按钮；确实删了的，点「取消」或「不用了」`,
          );
        }
        throw new MissingEntryError(`经验库里没有 ${id}`);
      }
      // 先对卡片上的内容，再看是不是已经归档了：上次点确认归档成功、结果没传回来的，内容没变照样接着做；
      // 卡片发出后有人改了内容又归档了的，卡片作废，不去归档它现在同步在 aiops 里的那条
      checkSeen(entry, meta.seen);
      if (entry.status === "archived") {
        this.logger.info(`经验库 归档 ${entry.id}：已经是归档状态，不用再改`);
        return entry;
      }
      await this.updateRow(entry, { status: "archived" });
      this.cached = undefined;
      this.logger.info(`经验库 归档 ${entry.id} 确认人=${meta.confirmedBy ?? "未知"}`);
      return { ...entry, status: "archived" };
    });
  }

  /** 在 entry 这一行（读表时核对过的那一行）记下同步到 aiops 后的编号 */
  linkAiops(entry: Pick<KnowledgeEntry, "id" | "rowId" | "conflict">, aiopsId: number): Promise<void> {
    return this.exclusive(async () => {
      await this.updateRow(entry, { aiopsId });
      this.cached = undefined;
    });
  }

  /** 编号和别的行重复的不改：说「经验 K3」时分不清是哪一行 */
  private async updateRow(
    entry: Pick<KnowledgeEntry, "id" | "rowId" | "conflict">,
    changes: Partial<Pick<KnowledgeEntry, "status" | "aiopsId">>,
  ): Promise<void> {
    if (entry.conflict) {
      throw new KnowledgeError(`表格里不止一行的编号是 ${entry.id}，不知道该改哪一行。请先在表格里把重复的编号改掉再试`);
    }
    await this.backend.update(entry, changes);
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.lock.then(run);
    this.lock = result.catch(() => {});
    return result;
  }

  /**
   * 向量缓存只留表格里现在这些行的（改之前的旧内容、删掉的行、改坏了不能检索的行的不留），不然表格一直在改、机器人一直开着，
   * 缓存会越攒越多。归档的行还在表格里、带上 include_archived 还能检索到，留着。表格每重新读一次清一遍
   */
  private pruneVectors(entries: readonly KnowledgeEntry[]): void {
    const read = this.cached?.entries;
    if (!this.embedder || this.vectors.size === 0 || read === this.prunedFor) {
      return;
    }
    this.prunedFor = read;
    const live = new Set(entries.filter(usable).map((entry) => vectorKey(this.embedder!.model, indexText(entry))));
    for (const key of this.vectors.keys()) {
      if (!live.has(key)) {
        this.vectors.delete(key);
      }
    }
  }

  /**
   * 提问和每条经验的余弦相似度；没配向量模型、向量服务出错或者到了期限时返回 undefined，只按关键词。
   * 到期限前算好的经验向量留在缓存里，下次接着算
   */
  private async similarities(
    query: string,
    entries: readonly KnowledgeEntry[],
    signal?: AbortSignal,
    deadline?: AbortSignal,
  ): Promise<number[] | undefined> {
    const { embedder } = this;
    if (!embedder || (this.embedFailedAt !== undefined && this.now().getTime() - this.embedFailedAt < EMBED_RETRY_MS)) {
      return undefined;
    }
    const stop = anySignal(signal, deadline);
    const embed = (texts: string[]) => (stop ? raceAbort(embedder.embed(texts, stop), stop) : embedder.embed(texts));
    try {
      const texts = entries.map(indexText);
      const keys = texts.map((text) => vectorKey(embedder.model, text));
      const byKey = new Map(keys.map((key, i) => [key, texts[i]]));
      // 这次要用的向量先取出来：等向量服务的时候别的检索读到了新表格、清缓存，清掉的是这次还要用的旧内容的向量
      const found = new Map([...byKey.keys()].flatMap((key) => (this.vectors.has(key) ? [[key, this.vectors.get(key)!] as const] : [])));
      const missing = [...byKey.keys()].filter((key) => !found.has(key));
      for (let i = 0; i < missing.length; i += EMBED_BATCH) {
        const batch = missing.slice(i, i + EMBED_BATCH);
        const vectors = await embed(batch.map((key) => byKey.get(key)!));
        batch.forEach((key, j) => {
          found.set(key, vectors[j]);
          this.vectors.set(key, vectors[j]);
        });
      }
      const [queryVector] = await embed([query]);
      return keys.map((key) => cosine(queryVector, found.get(key)!));
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      if (deadline?.aborted) {
        this.logger.warn(`经验库：向量没在期限内算完，这次只按关键词检索`);
        return undefined;
      }
      this.embedFailedAt = this.now().getTime();
      this.logger.warn(`经验库：向量模型 ${embedder.model} 出错，${EMBED_RETRY_MS / 60_000} 分钟内只按关键词检索`, err);
      return undefined;
    }
  }
}

/** 向量缓存的键：向量模型加上检索用的文字 */
function vectorKey(model: string, text: string): string {
  return createHash("sha256").update(`${model}\n${text}`).digest("hex");
}

/** 一条经验用来检索的文字：结论放在问题前面，两者各截一段，总长超了截掉的是问题的末尾 */
function indexText(entry: KnowledgeDraft): string {
  return [
    `${KNOWLEDGE_CATEGORIES[entry.category]}：${entry.title}`,
    entry.scope,
    entry.keywords,
    entry.errorCodes,
    entry.alertname,
    entry.conclusion.slice(0, INDEX_FIELD_CHARS),
    entry.handling?.slice(0, INDEX_FIELD_CHARS),
    entry.question.slice(0, INDEX_FIELD_CHARS),
    entry.basis?.slice(0, INDEX_FIELD_CHARS),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, EMBED_TEXT_CHARS);
}

/**
 * 给一条经验打分，不够相近时返回 undefined。
 * 关键词：经验的关键词、错误码、告警名有几个出现在提问里（最能说明是同一个问题），
 * 加上提问和经验的词、两字片段对上了多少（中文没有空格，「验证码收不到」也能对上「收不到验证码」）。
 * 有向量时以语义相似度为主，关键词命中加分；关键词命中两个以上的，语义不够也算
 */
function scoreEntry(entry: KnowledgeEntry, query: string, semantic: number | undefined): KnowledgeHit | undefined {
  const lower = query.toLowerCase();
  const text = indexText(entry).toLowerCase();
  // 同一个词在关键词、错误码里各写一遍，或者一个是另一个的一部分（ResourceExhausted 和 Exhausted），提问里出现一次只算一个
  const markers = new Set(
    [...splitList(entry.keywords), ...splitList(entry.errorCodes), ...splitList(entry.alertname)]
      .map((word) => word.toLowerCase())
      .filter((word) => word.length >= 2 && lower.includes(word)),
  );
  const keywordHits = [...markers].filter((word) => ![...markers].some((other) => other !== word && other.includes(word))).length;
  const bonus = Math.min(0.6, keywordHits * 0.3);
  if (semantic !== undefined) {
    return semantic >= SEMANTIC_MIN || bonus >= 0.6 ? { entry, score: semantic + bonus / 2, semantic } : undefined;
  }
  // 提问里的词有多少出现在经验里，经验标题里的词有多少出现在提问里，取大的：提问里常带「怎么办」「是怎么回事」这类话
  const coverage = Math.max(overlap(queryTerms(lower), text), overlap(queryTerms(entry.title.toLowerCase()), lower));
  const score = coverage * 0.6 + bonus;
  return score >= KEYWORD_MIN ? { entry, score } : undefined;
}

/** terms 里有几成出现在 text 里 */
function overlap(terms: readonly string[], text: string): number {
  return terms.length > 0 ? terms.filter((term) => text.includes(term)).length / terms.length : 0;
}

/** 提问拆成检索用的词：英文、数字按词，中文按相邻两个字 */
function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const word of query.match(/[a-z0-9][a-z0-9_.=:/-]*[a-z0-9]/g) ?? []) {
    terms.add(word);
  }
  for (const run of query.match(/[一-鿿]+/g) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i++) {
      terms.add(chars[i] + chars[i + 1]);
    }
  }
  return [...terms];
}

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,，、;；\n]+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

function numberOf(id: string): number {
  const match = /^K(\d+)$/.exec(normalizeId(id));
  const number = match ? Number(match[1]) : 0;
  // 表格里有人填了大得离谱的编号（超出能精确表示的整数）：不算，不然加一还是它自己（编号重复）或者变成 KInfinity
  return Number.isSafeInteger(number + 1) ? number : 0;
}

/** 「k12」「K 12」「#K12」都认成 K12 */
export function normalizeId(id: string): string {
  return id.replace(/[#\s]/g, "").toUpperCase();
}

/**
 * 写明了是密钥的名字：token、secret、API Key（MODEL_API_KEY、apiKey、x-api-key）、AccessKey、私钥、Azure 存储的 AccountKey，
 * 也算 secret_key、token_key 这类
 */
const SECRET_LABEL = String.raw`(?:secret|token|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key)(?:[_-]?(?:access[_-]?)?key)?`;
/**
 * 等号、冒号后面到值之前的空白不跨行：下一行是别的配置（.env 里空着的 MCP_AIOPS_TOKEN= 下面一行的 KNOWLEDGE=off）
 * 或者嵌套的子项（k8s 的 secret: 下面一行的 secretName: …），不是它的值。YAML 里值写在下面几行的见 blockValues
 */
const BEFORE_VALUE = String.raw`[^\S\r\n]*`;
/** 名字和值之间：名字可以带引号（{"password": …}），等号、冒号、=>（PHP 数组）都算 */
const ASSIGN = String.raw`["']?[^\S\r\n]*(?:=>|[:=：])${BEFORE_VALUE}`;
/**
 * 引号里的一整段值，中间有空格的口令也是一整段（"correct horse battery staple"），转义的引号（"ab\"cd…"）不算结束；
 * 里面有中文的是说明，不算。带 * 的也取出来，整个打了码的（"******"）由 isMasked 筛掉
 */
const quotedValue = (min: number) =>
  String.raw`"((?:[^"\\\n\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]|\\[^\n]){${min},})"|'((?:[^'\\\n\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]|\\[^\n]){${min},})'`;

/**
 * 打了码的值：连着三个以上的 *，露出来的字符不超过 8 个（******、ab***cd、sk-****wxyz，提示里也让人「换成 ***」）。
 * 只夹着一两个 * 的（Ab*CorrectHorseBatteryStaple9!）、露出一大段的（correct***horsebatterystaple）是密码本身，照样算
 */
function isMasked(value: string): boolean {
  return /\*{3,}/.test(value) && value.replace(/[\s*]/g, "").length <= 8;
}

/**
 * 经验库所有群都能看，排查经验还会同步给 aiops 的告警自动排查，所以明显的密钥、密码不让存。
 * 只拦格式很确定的，免得误伤；手机号这类个人信息靠提示词
 */
/** PEM 私钥（RSA、EC、OPENSSH、PKCS#8，加密的也算）和 OpenPGP 私钥（PGP PRIVATE KEY BLOCK）的开头；公钥、证书不算 */
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;

const SECRET_PATTERNS: [RegExp, string][] = [
  [PRIVATE_KEY_HEADER, "私钥"],
  // PuTTY 的私钥文件（.ppk）：Private-Lines 后面跟的就是私钥（加了密码的也算）。只有开头一行、没有私钥那几行的不算
  [/\bPrivate-Lines:[^\S\r\n]*\d+\s+[A-Za-z0-9+/]{16,}/, "私钥"],
  // age 的私钥（age-keygen 生成的 AGE-SECRET-KEY-1…，抗量子的 AGE-SECRET-KEY-PQ-1…），后面是 bech32 字符。只写了开头的说明不算
  [/\bAGE-SECRET-KEY-(?:[A-Z0-9]+-)?1[02-9AC-HJ-NP-Z]{40,}/i, "私钥"],
  [/\bglpat-[\w-]{16,}/, "GitLab 令牌"],
  // GitLab 别的令牌：OAuth 应用、部署、Runner、CI 任务、流水线触发、Feed、事件、服务账号、功能开关、Agent
  [/\bgl(?:oas|dt|rt|cbt|ptt|ft|imt|soat|ffct|agent)-[\w-]{16,}/, "GitLab 令牌"],
  // 各家平台自带前缀的令牌：npm、PyPI、Docker Hub、Hugging Face、Grafana（服务账号、Cloud）、Vault、DigitalOcean、Shopify、
  // SendGrid、Sentry、Postman、New Relic、Linear、Atlassian、Telegram 机器人、腾讯云 SecretId
  [/\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/, "npm 令牌"],
  [/\bpypi-AgE[\w-]{50,}/, "PyPI 令牌"],
  [/\bdckr_pat_[\w-]{20,}/, "Docker Hub 令牌"],
  [/\bhf_[A-Za-z0-9]{30,}/, "Hugging Face 令牌"],
  [/\bglsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}|\bglc_[A-Za-z0-9+/]{32,}/, "Grafana 令牌"],
  [/\bhv[sb]\.[\w-]{24,}/, "Vault 令牌"],
  [/\bdo[opr]_v1_[a-f0-9]{64}/, "DigitalOcean 令牌"],
  [/\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}/, "Shopify 令牌"],
  [/\bSG\.[\w-]{22}\.[\w-]{43}/, "SendGrid 密钥"],
  [/\bsntry[su]_[\w+/=]{40,}/, "Sentry 令牌"],
  [/\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}/, "Postman 密钥"],
  [/\bNRAK-[A-Z0-9]{27}/, "New Relic 密钥"],
  [/\blin_api_[A-Za-z0-9]{40}/, "Linear 密钥"],
  [/\bATATT3[\w=-]{50,}/, "Atlassian 令牌"],
  [/\b\d{8,10}:AA[\w-]{33}(?![\w-])/, "Telegram 机器人令牌"],
  [/\bAKID[A-Za-z0-9]{28,}/, "云服务的 AccessKey"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "GitHub 令牌"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "GitHub 令牌"],
  // sk-proj-…、sk-ant-api03-…、sk-svcacct-… 中间带连字符的也算，这种要带数字，免得把 sk- 开头的长名字当成密钥
  [/\bsk-(?:[A-Za-z0-9]{20,}|(?=[\w-]*\d)[\w-]{20,})/, "API 密钥"],
  [/\b(?:AKIA|LTAI)[A-Za-z0-9]{12,}/, "云服务的 AccessKey"],
  // Slack 的 xoxb-、xoxp-、xoxe.xoxp-、xapp- 令牌
  [/\bxox(?:e\.xox)?[a-z]-[A-Za-z0-9-]{10,}|\bxapp-\d+-[A-Za-z0-9-]{10,}/, "Slack 令牌"],
  // 拿到地址就能往群里发消息：飞书、Lark、Slack 的群机器人 Webhook
  [/\/open-apis\/bot\/v2\/hook\/[\w-]{8,}|hooks\.slack\.com\/services\/[\w/]{10,}/, "群机器人 Webhook 地址"],
  [/\bAIza[\w-]{35}/, "Google API 密钥"],
  [/\b[rs]k_live_[A-Za-z0-9]{16,}/, "Stripe 密钥"],
  [/\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/, "JWT 令牌"],
  [/\bBearer\s+[\w.~+/-]{20,}/i, "Bearer 令牌"],
];

/** 写明了是密钥、密码的名字后面的值（取出来的组里有一个是值），整个打了码的（isMasked）不算 */
const LABELED_SECRETS: [RegExp, string][] = [
  // 连接地址里的密码（postgres://deploy:…@db），没写用户名的也算（redis://:…@cache）；打了码的（postgres://deploy:******@db）不算
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:([^\s@/]+)@/gi, "带密码的连接地址"],
  // AccessKey 的 Secret（AWS_SECRET_ACCESS_KEY、阿里云 AccessKeySecret）：写明了是它的，值里没有数字也算
  [
    new RegExp(String.raw`(?:secret[_-]?access[_-]?key|access[_-]?key[_-]?secret)[^\S\r\n]*[:=：]${BEFORE_VALUE}([^\s,，;；\u4e00-\u9fff]{16,})`, "gi"),
    "云服务的 AccessKey Secret",
  ],
  // 写明了是密码的，值里没有数字也算（correcthorsebatterystaple、{"password": "correct horse battery staple"}）；中文说明（「密码：请找管理员重置」）不算
  [new RegExp(String.raw`(?:password|passwd|pwd|密码|口令)${ASSIGN}(?:${quotedValue(6)}|["']?([^\s"',，;；\u4e00-\u9fff]{6,}))`, "gi"), "密码"],
  // 写明了是密钥的，值里带数字的都算（不带数字的见下面的 TOKEN_ASSIGNMENT）
  [new RegExp(String.raw`${SECRET_LABEL}[^\S\r\n]*[:=：]${BEFORE_VALUE}(?=[^\s,，;；]*\d)([^\s,，;；]{8,})`, "gi"), "密码或令牌"],
];

/**
 * 写明了是密钥的名字后面直接写的值，没有数字也算（MCP_AIOPS_TOKEN=correcthorsebatterystaple、MODEL_API_KEY=correct.horse.battery.staple，
 * 这些配置什么样的值都能填）。引号里的值取引号里的一整段（"correct horse battery staple"）；没引号的到空白、引号、逗号分号、右括号、中文为止，
 * 中间的标点都算（abc:def!ghi），紧跟着 ( [ { < \ 的不算：那是代码、占位或者路径（getToken()、${MCP_AIOPS_TOKEN}、<token>、os.environ["X"]）
 */
const VALUE_CHAR = String.raw`[^\s"'\`,;()[\]{}<>\\\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]`;
const VALUE_END = String.raw`(?=$|[\s"'\`,;)\]}>\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])`;
/** 密码的简写：DB_PASS、smtp.pass、redis-pass，要有分隔符（bypass、compass 不算） */
const PASS_ALIAS = String.raw`[_.-]pass`;
const TOKEN_ASSIGNMENT = new RegExp(String.raw`(?:${SECRET_LABEL}|${PASS_ALIAS})${ASSIGN}(?:${quotedValue(8)}|["']?(${VALUE_CHAR}{8,})${VALUE_END})`, "gi");
/**
 * .env、shell、YAML 里不带引号的值也可以有空格（process.loadEnvFile 认到行尾，YAML 的普通标量也是），所以取到行尾。
 * 中文、反引号、行内注释（空格加 #）、同一行的下一个赋值（, refresh_token=…）前面截断，那是说明不是值；
 * 整个打了码的、值短于 8 个字符的不算（token=******、token=xxx），在 findSecret 里筛。
 * 引号开头的不在这里取（等号后面的空白也不让它退回去取），由 quotedValue 取引号里的
 */
const LINE_VALUE = String.raw`[ \t]*(?![ \t"'])([^\n\`\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+?)(?=[ \t]+#|(?:[,;][ \t]*|[ \t]+)[\w.-]+[ \t]*=|[ \t]*(?:$|[\n\`\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]))`;
/**
 * 大写的密钥变量（MCP_AIOPS_TOKEN=…、DB_PASSWORD=…）在句子中间也算（「设置 GITLAB_TOKEN=… 后重启」）；
 * 单独的 PWD 是当前目录、PASS 是一个词，前面带别的词的（MYSQL_PWD、DB_PASS）才是密码
 */
const ENV_ASSIGNMENT = new RegExp(
  String.raw`\b(?:(?:[A-Z0-9]+_)*(?:SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|ACCOUNT_?KEY|PASSWORD|PASSWD)|(?:[A-Z0-9]+_)+(?:PWD|PASS))(?:_[A-Z0-9]+)*[ \t]*=${LINE_VALUE}`,
  "gm",
);
/**
 * 一行开头的配置项，大小写都算：db_password=…、export api_key=…、YAML 的 api_key: …、- token: …、spring.datasource.password=…。
 * 名字要以密钥的词结尾（token_ttl、tokenizer 说的不是密钥）；句子中间小写的 token=…、token: … 是报错原文，不在这里认
 */
const CONFIG_KEY = String.raw`[\w.-]*(?:${SECRET_LABEL}|password|passwd|[_.-]pwd|${PASS_ALIAS})\d*`;
const LINE_ASSIGNMENT = new RegExp(String.raw`^[ \t]*(?:export[ \t]+|-[ \t]+)?${CONFIG_KEY}[ \t]*(?:=|:(?!:))${LINE_VALUE}`, "gim");
/**
 * YAML 里值写在下面几行的配置项：块写法（api_key: |-、api_key: >）或者冒号后面空着、下一行缩进着写。
 * 第 1 组是这一行的缩进，第 2 组是块写法的标记（| 或 >，可带 - + 和数字）
 */
const BLOCK_KEY = new RegExp(String.raw`^([ \t]*)(?:-[ \t]+)?["']?${CONFIG_KEY}["']?[ \t]*:[ \t]*([|>][1-9+-]{0,2})?[ \t]*(?:#.*)?$`, "i");
/** 冒号后面空着时，下面缩进的是一个子项（name: …）或者列表（- …）就不是它的值，是嵌套的配置（k8s 的 secret: 下面写 secretName），子项各自按行检查 */
const NESTED_LINE = /^[ \t]*(?:-(?:[ \t]|$)|["']?[\w.-]+["']?[ \t]*:(?:[ \t]|$))/;
/** 整行是注释（# 生产库）。冒号后面空着时，值前面、中间的注释行跳过（YAML 里注释行不是值的一部分，缩进多少都行）；块写法（|、>）里的 # 是值本身 */
const COMMENT_LINE = /^[ \t]*#/;
/** 值里中文、反引号、行内注释以后是说明 */
const NOTE_START = /[`\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]|[ \t]#/;
/** 块写法（|、>）里没有注释，# 是值本身（|\n  #Abc…），只有中文、反引号以后算说明 */
const BLOCK_NOTE_START = /[`\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

/** YAML 里写在下面几行的值：下面缩进比配置项深的几行连起来。整个打了码的不算 */
function blockValues(text: string): string[] {
  const lines = text.split(/\r?\n/);
  return lines.flatMap((line, i) => {
    const key = BLOCK_KEY.exec(line);
    if (!key) {
      return [];
    }
    const body: string[] = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() === "" || (!key[2] && COMMENT_LINE.test(next))) {
        continue;
      }
      if (/^[ \t]*/.exec(next)![0].length <= key[1].length || (body.length === 0 && !key[2] && NESTED_LINE.test(next))) {
        break;
      }
      const note = (key[2] ? BLOCK_NOTE_START : NOTE_START).exec(next);
      body.push((note ? next.slice(0, note.index) : next).trim());
    }
    const value = body.join(" ").trim();
    return value.length >= 8 && !isMasked(value) ? [value] : [];
  });
}
/**
 * YAML 里引号里的值折到下面几行的（password: "correct horse\n  battery staple"）：下面的行要缩进，折行的地方算一个空格；
 * 双引号里行尾的 \ 也是续行。只在一行里的由 quotedValue 取。第 1 组是双引号里的，第 2 组是单引号里的
 */
const YAML_FOLDED_QUOTE = new RegExp(
  String.raw`^[ \t]*(?:-[ \t]+)?["']?${CONFIG_KEY}["']?[ \t]*:[ \t]*` +
    String.raw`(?:"((?:[^"\\\r\n]|\\(?:[^\r\n]|\r?\n[ \t]*(?![ \t]))|\r?\n[ \t]+(?![ \t]))*)"|'((?:[^'\r\n]|''|\r?\n[ \t]+(?![ \t]))*)')`,
  "gim",
);

/** 折到下面几行的 YAML 引号里的值，连成一行。有中文的是说明，不算 */
function foldedQuotedValues(text: string): string[] {
  return [...text.matchAll(YAML_FOLDED_QUOTE)].flatMap(([, double, single]) => {
    const raw = double ?? single;
    if (!raw.includes("\n")) {
      return [];
    }
    const value = raw
      .replace(/\\\r?\n[ \t]*/g, "")
      .replace(/[ \t]*\r?\n[ \t]*/g, " ")
      .trim();
    return value.length >= 6 && !/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(value) ? [value] : [];
  });
}

/**
 * 命令行里写在密钥选项后面、隔着空格的值：deployctl --password correcthorsebatterystaple、--api-key "…"、Go 的 -token …；
 * 也算 exec 数组（["deployctl", "--token", "…"]）、YAML 的 args 列表（- --token 下一行 - …）、行尾 \ 续到下一行的，
 * 以及 shell 里用 \ 转义的空格（correct\ horse\ battery）。
 * 选项名要以密钥的词结尾（--password-stdin、--token-file 不算）；值以 - 开头的是下一个选项（--no-password --verbose）
 */
const CLI_OPTION = new RegExp(
  String.raw`(?<![\w.-])--?${CONFIG_KEY}(?:["']?[ \t]+|["'][ \t]*,[ \t]*|["']?[ \t]*\r?\n[ \t]*-[ \t]+|["']?[ \t]*\\\r?\n[ \t]*)` +
    String.raw`(?:${quotedValue(6)}|(?![-"'])((?:${VALUE_CHAR}|\\[^\n]){6,})${VALUE_END})`,
  "gi",
);
/** 选项后面是 name=… 的（docker build --secret id=npmrc,src=…）是另一个赋值，里面的密钥由别的规则拦；base64 结尾补的 = 不算 */
const OPTION_SPEC = /^[A-Za-z_][\w.-]*=(?!=|$)/;
/** curl 里不带值、能和 -u 并着写的短选项（-s、-S、-L、-k、-v 这些） */
const CURL_FLAGS = "[#0-46aBfgGhIijJklLMNnOpqRsSvVZ]*";
/** 选项和值之间的空白，行尾 \ 续到下一行的也算 */
const CURL_GAP = String.raw`[ \t]+|[ \t]*\\\r?\n[ \t]*`;
/**
 * curl 的 -u、--user、-U、--proxy-user 后面写的「用户名:密码」（curl -u svc:… https://…，行尾 \ 续行的也算）：取冒号后面的密码。
 * 短选项的值可以紧贴着写（-usvc:…、-Uproxy:…），前面也可以并着不带值的短选项（-sSu svc:…）。
 * 只认 curl 的：别的命令的 -u、--user 是用户名或者 uid:gid（docker run -u 1000:1000、sudo -u postgres）。
 * 只写了用户名的（curl -u admin，curl 会问密码）不算。第 1 组是双引号里的，第 2 组是单引号里的，第 3 组是没引号的
 */
const CURL_USER = new RegExp(
  String.raw`\bcurl\b(?:[^\n]|\\\r?\n)*?(?<![\w.-])(?:-${CURL_FLAGS}[uU](?:${CURL_GAP})?|--(?:proxy-)?user(?:${CURL_GAP}|=))` +
    String.raw`(?:"[^"\n:]*:([^"\n]*)"|'[^'\n:]*:([^'\n]*)'|[^\s"':]*:([^\s"']+))`,
  "g",
);

/** curl 命令里的密码；有中文的是说明，不算 */
function curlPasswords(text: string): string[] {
  return [...text.matchAll(CURL_USER)].flatMap(([, double, single, bare]) => {
    const value = (double ?? single ?? bare).trim();
    return value.length >= 6 && !/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(value) ? [value] : [];
  });
}
/** .netrc 一条记录里成对出现的关键字（machine、default 开始一条新的） */
const NETRC_KEYS = new Set(["login", "password", "account", "port"]);

/**
 * .netrc 里的密码：machine 主机 login 用户 password 密码，写在一行或者分几行都行。按「关键字 值」成对读，密码不短于 6 个字符才算。
 * 可以不写 login（用户名写在地址里，curl 照样用这条的密码）。没有 login 时，主机要像主机名（带点、冒号或数字，或者 localhost），
 * 或者密码不全是小写字母，「machine learning password resetting」「default password rotation」这样的句子对不上
 */
function netrcPasswords(text: string): string[] {
  const tokens = text.split(/\s+/);
  const found: string[] = [];
  tokens.forEach((token, i) => {
    if (token !== "machine" && token !== "default") {
      return;
    }
    const record = new Map<string, string>();
    for (let j = token === "machine" ? i + 2 : i + 1; j + 1 < tokens.length && NETRC_KEYS.has(tokens[j]); j += 2) {
      record.set(tokens[j], tokens[j + 1]);
    }
    const password = record.get("password");
    const host = token === "machine" && /[.:\d]|^localhost$/i.test(tokens[i + 1] ?? "");
    if (password !== undefined && password.length >= 6 && (record.has("login") || host || !/^[a-z]+$/.test(password))) {
      found.push(password);
    }
  });
  return found;
}
/**
 * PostgreSQL 的密码文件（~/.pgpass）里的一行：主机:端口:库:用户:密码，没有写明是密码的名字。字段里的 : 和 \ 用 \ 转义（\: \\），
 * 前四段可以是 *；密码取到空白、引号或者中文为止。第 1 组是主机，第 2 组是端口，第 3 组是密码
 */
const PGPASS_ENTRY =
  /(?<![^\s"'`\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])((?:[^\s:\\]|\\.)+):(\d{1,5}|\*):(?:[^\s:\\]|\\.)+:(?:[^\s:\\]|\\.)+:((?:[^\s"'`\\\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]|\\.)+)(?=$|[\s"'`\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])/g;

/**
 * .pgpass 里的密码。这种一行几段冒号的写法 Redis 的 key 也会用（order:1001:item:detail:summary），所以主机要像主机
 * （带点、localhost、*、套接字目录），或者端口是 PostgreSQL 默认的 5432，或者这段文字里提到了 .pgpass 文件，才算
 */
function pgpassPasswords(text: string): string[] {
  // 提到的是密码文件（~/.pgpass、PGPASSFILE），不是 PGPASSWORD 这个变量
  const named = /\.pgpass(?!\w)|\bPGPASSFILE\b/i.test(text);
  return [...text.matchAll(PGPASS_ENTRY)].flatMap(([, host, port, raw]) => {
    if (!named && port !== "5432" && !/\.|^(?:localhost|\*)$|^\//i.test(host)) {
      return [];
    }
    const value = raw.replace(/\\(.)/g, "$1");
    return value.length >= 6 ? [value] : [];
  });
}
/**
 * 属性引用的最后一段是密钥的名字（cfg.Token、settings.apiKey、process.env.MODEL_API_KEY、cfg.redis_pass）：说的是值从哪读，不是值本身。
 * pass 和 PASS_ALIAS 一样要用 _ 隔开或者就是这一段（compass、bypass 不是，correct.horse.compass 是密码）
 */
const CREDENTIAL_NAME = new RegExp(String.raw`^(?:\w*(?:password|passwd|pwd|${SECRET_LABEL})|(?:\w*_)?pass)$`, "i");
/**
 * 报错原文、占位符里用的词。整个值都由这些词组成时不算密钥（token=expired_session、your_token_here、token: signature is invalid）；
 * 夹着别的词的照样算（prod-secret-abcdefghijkl、my correct horse battery staple）
 */
const PLACEHOLDER_WORD =
  /^(?:expired?|expires|invalid|missing|revoked|empty|null|nil|none|undefined|unset|required|mismatch(?:ed)?|errors?|denied|unauthori[sz]ed|forbidden|not|found|notfound|timeout|timed|out|stale|bad|wrong|fail(?:ed|ure|s)?|malformed|unknown|absent|disabled|session|signature|token|key|secret|access|api|auth|app|user|id|value|format|request|header|password|passwd|pwd|pass|placeholder|is|are|was|were|be|been|has|have|had|do|does|did|no|cannot|can|could|the|a|an|of|for|to|from|in|on|with|by|and|or|please|again|login|relogin|retry|provided|given|received|options?|arguments?|args?|parameters?|params?|flags?|switch|instead|prompts?|redacted|masked|hidden|example|sample|dummy|your|my|here|x{3,})$/i;
/** 环境变量名（FEISHU_APP_SECRET、MODEL_API_KEY）：说的是值放在哪，不是值本身 */
const ENV_NAME = /^[A-Z]+(?:_[A-Z]+)+$/;
/** 整个值是 a.b.c 这样的属性引用 */
const PROPERTY_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

/** 写在密钥名字后面的值是不是占位：打了码的、环境变量名、读密钥的属性引用、说密钥放在哪的地址，或者整个由报错、占位用词组成 */
function isPlaceholder(raw: string): boolean {
  // 句末的标点不算值的一部分（token: expired.、token=expired!）
  const value = raw.replace(/[.!?:]+$/, "");
  if (isMasked(value)) {
    return true;
  }
  // 地址里带的密码、查询参数里的 token=… 由别的规则拦；变量引用（$NAME、${NAME}，Terraform 的 ${var.db_password}）、尖括号占位（<your-token>）、模板（{{ .Values.token }}）
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^\$\{?[A-Za-z_]\w*\}?$/.test(value) || /^\$\{[A-Za-z_][\w.]*\}$/.test(value) || /^<[^<>]+>$/.test(value) || /^\$?\{\{.*\}\}$/.test(value)) {
    return true;
  }
  // 家目录、当前目录、变量、Windows 盘符开头的文件路径（--private-key ~/.ssh/deploy.pem、$HOME/.npmrc、C:\keys\deploy.pem）：说的是值放在哪个文件
  if (/^(?:(?:~|\.{1,2}|\$\{?[A-Za-z_]\w*\}?)\/|[A-Za-z]:\\)\S*$/.test(value)) {
    return true;
  }
  const last = value.slice(value.lastIndexOf(".") + 1);
  if (PROPERTY_PATH.test(value) && (CREDENTIAL_NAME.test(last) || ENV_NAME.test(last))) {
    return true;
  }
  // 词之间的 * 是 Markdown 的加粗（**expired**），夹在字母中间的（Ab*Correct）分出来的不是占位词，照样算
  return ENV_NAME.test(value) || value.split(/[\s_+/~=.,;:!?*-]+/).every((part) => part === "" || PLACEHOLDER_WORD.test(part));
}

/** HTTP Basic 认证（Authorization: Basic …）：后面是「用户名:密码」的 base64 */
const BASIC_AUTH = /\bBasic\s+([A-Za-z0-9+/]{8,}={0,2})(?![\w+/=])/gi;

/** 解出来是「用户名:密码」才算，「Basic configuration」这类英文解出来是乱码 */
function isBasicCredential(value: string): boolean {
  return /^[^\x00-\x1f\x7f\ufffd:]+:[^\x00-\x1f\x7f\ufffd]+$/.test(Buffer.from(value, "base64").toString("utf8"));
}

/**
 * Authorization 头（Proxy-Authorization、X-Authorization、CGI 的 HTTP_AUTHORIZATION，JSON 里的 "Authorization": "…"、
 * curl -H 'Authorization: …'、转义的 \"Authorization\" 也算）后面这一行，第 1 组
 */
const AUTHORIZATION_HEADER = /(?<![\w-])(?:[A-Za-z0-9]+[-_])*authorization\\?["']?[^\S\r\n]*[:=：][^\S\r\n]*\\?["']?([^\r\n]*)/gi;
/** 头的值：第 1 组是第一段，有第 2 段时第 1 组是认证方式、第 2 组是凭据，第 3 组是后面的。一段到空白、引号、逗号分号、括号、中文为止 */
const AUTHORIZATION_VALUE = new RegExp(String.raw`^(${VALUE_CHAR}+)(?:[^\S\r\n]+(${VALUE_CHAR}+))?(.*)$`);

/**
 * Authorization 头里的凭据：Bearer 以外的认证方式（Token …、SSWS …、ApiKey …、Negotiate …）后面的那段，拿到就能调接口。
 * 凭据带数字的都算；不带数字的，要整个头只有「认证方式 凭据」（后面是行尾、引号、逗号分号、中文），认证方式也不是报错里的词
 * （Authorization: invalid credentials、failed verification 是说明，Token、Key 是真的认证方式）。
 * 没写认证方式直接写的令牌，要不短于 16 个字符、带数字和小写字母（Authorization: Negotiate、SCRAM-SHA-256 说的是认证方式）。
 * Basic 由 BASIC_AUTH 解开看；带认证参数的（Signature keyId="…",signature="…"、Digest … response="…"、AWS4-HMAC-SHA256 … Signature=…）
 * 看 authorizationParams；后面紧跟着 ( [ { < \ 的是代码、占位（Bearer {access_token}、SSWS {{apiToken}}）
 */
function authorizationCredentials(text: string): string[] {
  return [...text.matchAll(AUTHORIZATION_HEADER)].flatMap(([, line]) => [...authorizationParams(line), ...schemeCredential(line)]);
}

/**
 * 认证参数里本身就是凭据的：签名（HTTP Signature 的 signature、AWS 的 Signature、OAuth 1.0 的 oauth_signature、sig）、Digest 的 response、
 * Hawk 的 mac，和写明是令牌、密钥、密码的（oauth_token、access_token、client_secret、api_key、x-api-key）。拿到它们就能重放请求、离线猜密码或者直接调接口。
 * keyId、Credential（AWS 的访问密钥 ID）、nonce、realm、algorithm 这些不是
 */
const AUTHORIZATION_PARAM_NAME =
  /^(?:(?:oauth_)?signature|sig|response|mac|[\w.-]*(?:token|secret|secret[_-]?key|password|passwd|pwd|api[_-]?key|private[_-]?key))$/i;
/** 认证参数 name="value"、name=value（JSON 里转义的 name=\"value\" 也算，不带引号的到空白、逗号分号、中文为止）：第 1 组是名字，第 2、3、4 组是值 */
const AUTHORIZATION_PARAM = /(?<![\w.-])([A-Za-z][\w.-]*)[^\S\r\n]*=[^\S\r\n]*(?:\\?"([^"\\\r\n]*)\\?"|'([^'\r\n]*)'|([^\s,;"'\\\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+))/g;

/** Authorization 头这一行里是凭据的认证参数的值：不短于 8 个字符、中间没有空格（"see above" 这种是说明）、不是占位 */
function authorizationParams(line: string): string[] {
  return [...line.matchAll(AUTHORIZATION_PARAM)].flatMap(([, name, doubled, single, bare]) => {
    const value = doubled ?? single ?? bare ?? "";
    return AUTHORIZATION_PARAM_NAME.test(name) && value.length >= 8 && !/\s/.test(value) && !isPlaceholder(value) ? [value] : [];
  });
}

/** Authorization 头的「认证方式 凭据」或者只有凭据的那种（见 authorizationCredentials） */
function schemeCredential(line: string): string[] {
  const parts = AUTHORIZATION_VALUE.exec(line);
  if (!parts) {
    return [];
  }
  const [, first, second, rest] = parts;
  const scheme = second === undefined ? undefined : first;
  const value = second ?? first;
  if (/^basic$/i.test(scheme ?? "") || /=(?!=*$)/.test(value) || /^(?:["'`][^\s"'`,;)\]}>\\]|[([{<]|\\(?!["']))/.test(rest)) {
    return [];
  }
  if (scheme === undefined) {
    return value.length >= 16 && /\d/.test(value) && /[a-z]/.test(value) ? [value] : [];
  }
  const whole = /^(?:\\?["'`]|[^\S\r\n]*(?:$|[,;)\]}\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]))/.test(rest);
  const prose = PLACEHOLDER_WORD.test(scheme) && !/^(?:token|key)$/i.test(scheme);
  return value.length >= 8 && (/\d/.test(value) || (whole && !prose)) ? [value] : [];
}

/**
 * 带签名的临时访问地址（Azure SAS 的 sig=、AWS 预签名的 X-Amz-Signature=、阿里云 OSS 的 Signature=、x-oss-signature=）：
 * 过期前谁拿到都能访问。参数名最后一段是 sig 或 signature，值不短于 16 个字符，到 &、空白、括号、中文为止；变量、占位（xxxx）、打了码的不算
 */
const SIGNED_URL = /[?&](?:[\w.-]*[_.-])?(?:sig|signature)=([^&\s#"'`<>()[\]\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]{16,})/gi;
/** Cookie、Set-Cookie 头（JSON 里的 "Cookie": "…" 也算）后面的「名字=值; 名字=值」，到行尾或引号为止 */
const COOKIE_HEADER = /\b(?:set-)?cookie["']?[^\S\r\n]*:[^\S\r\n]*["']?([^\r\n"']+)/gi;
/**
 * curl 的 -b、--cookie 后面的 Cookie（-b cookies.txt 是文件，里面没有 =，取出来也不算）。和 -u 一样，短选项的值可以紧贴着写（-bsessionid=…），
 * 前面也可以并着不带值的短选项（-sSb 'sid=…'），行尾 \ 续到下一行的也算（没引号的值不以 \ 开头）。第 1 组是双引号里的，第 2 组是单引号里的，第 3 组是没引号的
 */
const CURL_COOKIE = new RegExp(
  String.raw`\bcurl\b(?:[^\n]|\\\r?\n)*?(?<![\w.-])(?:-${CURL_FLAGS}b(?:${CURL_GAP})?|--cookie(?:${CURL_GAP}|=))(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'\\][^\s"']*))`,
  "g",
);
/** Set-Cookie 里的属性，不是 Cookie 本身 */
const COOKIE_ATTRIBUTES = new Set(["expires", "max-age", "domain", "path", "samesite", "priority", "partitioned", "secure", "httponly"]);

/**
 * Cookie 里的值：登录态（sessionid、PHPSESSID、laravel_session、connect.sid…）拿到就能冒充登录的人。名字五花八门，
 * 不按名字挑，不短于 8 个字符的都算；值里不能有空白、逗号、引号、中文（RFC 6265），到这些为止，后面是说明
 */
function cookieValues(text: string): string[] {
  const lists = [
    ...[...text.matchAll(COOKIE_HEADER)].map(([, list]) => list),
    ...[...text.matchAll(CURL_COOKIE)].map(([, double, single, bare]) => double ?? single ?? bare),
  ];
  return lists.flatMap((list) =>
    list.split(";").flatMap((pair) => {
      const match = /^\s*([^=\s]+)=\s*"?([^\s",;\\\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]*)/.exec(pair);
      return match && !COOKIE_ATTRIBUTES.has(match[1].toLowerCase()) && match[2].length >= 8 ? [match[2]] : [];
    }),
  );
}
/**
 * 名字以 auth 结尾的配置项：Docker config.json 的 "auth"、.npmrc 的 _auth、basicAuth 这些，值是「用户名:密码」的 base64；
 * Yarn 的 npmAuthIdent 也可以直接写「用户名:密码」。第 1 组是名字，第 2 组是值
 */
const AUTH_FIELD = new RegExp(String.raw`(?<![\w.-])["']?(\w*auth(?:[_-]?ident)?)${ASSIGN}["']?([^\s"',;，；]+)`, "gi");
/**
 * Kubernetes 镜像仓库的 Secret（.dockerconfigjson: …）：整个 config.json 编成了 base64，要解开再查。
 * 也认 YAML 块写法（.dockerconfigjson: |- 下一行缩进着写，可以折成几行）
 */
const DOCKER_CONFIG =
  /\.docker(?:configjson|cfg)["']?[^\S\r\n]*[:=][^\S\r\n]*(?:[|>][-+0-9]*[^\S\r\n]*\r?\n[ \t]+)?["']?([A-Za-z0-9+/]{16,}(?:\r?\n[ \t]+[A-Za-z0-9+/]+)*={0,2})(?![\w+/=])/gi;

/**
 * base64 编码过的密钥：kubeconfig 的 client-key-data、Kubernetes Secret 里 data 下的值（tls.key、DATABASE_URL、.env）、
 * echo … | base64 -d 这些。不按名字认，不短于 16 个字符的一段 base64 都解开看（YAML 里折成几行的连起来）：
 * 不短于 64 个字符、解出来是 PEM 或 DER 私钥的算私钥；解出来是文字的按同样的规则再查一遍（解出来的比原文短，递归会停下来）。
 * 解出来是乱码的（普通的长单词、哈希、摘要）不算
 */
const BASE64_RUN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/]{16,}(?:\r?\n[ \t]+[A-Za-z0-9+/]+)*={0,2}(?![A-Za-z0-9+/=_-])/g;

function encodedSecret(text: string): string | undefined {
  for (const [run] of text.matchAll(BASE64_RUN)) {
    const encoded = run.replace(/\s+/g, "");
    const bytes = Buffer.from(encoded, "base64");
    if (encoded.length >= 64 && (PRIVATE_KEY_HEADER.test(bytes.toString("latin1")) || isDerPrivateKey(bytes))) {
      return "私钥";
    }
    const decoded = printableText(bytes);
    const label = decoded === undefined ? undefined : findSecret(decoded);
    if (label) {
      return `base64 编码的${label}`;
    }
  }
  return undefined;
}

/** 解出来的字节是不是一段文字（合法的 UTF-8，除了换行、制表符没有控制字符）；不是时返回 undefined */
function printableText(bytes: Buffer): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) ? undefined : text;
}

/** Kubernetes Secret 的清单（kind: Secret，JSON 里的 "kind": "Secret" 也算；SecretProviderClass 这些不算） */
const SECRET_KIND = /["']?\bkind["']?[^\S\r\n]*:[^\S\r\n]*["']?Secret["']?(?![\w-])/;
/** YAML 里 data:、binaryData:、stringData: 这一行（后面没有值，值在下面缩进着写）：第 1 组是缩进，第 2 组是哪一项 */
const SECRET_DATA_BLOCK = /^([ \t]*)(?:-[ \t]+)?(data|binaryData|stringData)[ \t]*:[ \t]*(?:#.*)?$/;
/** YAML 里缩进着的「名字: 值」：第 1 组是名字，第 2、3、4 组是值 */
const SECRET_DATA_LINE = /^[ \t]+["']?([^\s"':#][^"':]*?)["']?[ \t]*:[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s#]+))[ \t]*(?:#.*)?$/;
/** JSON、YAML 流式写法的 "data": {…}：第 1 组是哪一项，第 2 组是大括号里的 */
const SECRET_DATA_OBJECT = /["']?\b(data|binaryData|stringData)["']?[^\S\r\n]*:[^\S\r\n]*\{([^{}]*)\}/g;
const SECRET_DATA_PAIR = /["']?([\w.-]+)["']?\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s,}]+))/g;
/** Secret 里名字明说不是密钥的：用户名、地址、端口、库名、命名空间、CA 和证书（解出来是文字的照样按别的规则查） */
const PUBLIC_SECRET_KEY =
  /^(?:[\w.-]*[_.-])?(?:user(?:name)?|login|email|host(?:name)?|port|database|db_?name|namespace|region|endpoint|url|uri|address|bucket)$|(?:^|[_.-])ca(?:\.crt|\.pem|-bundle)?$|\.crt$/i;

/** Secret 清单里 data、binaryData、stringData 下的每一项：[哪一项, 名字, 值] */
function secretDataEntries(text: string): [string, string, string][] {
  const entries: [string, string, string][] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const block = SECRET_DATA_BLOCK.exec(line);
    if (!block) {
      return;
    }
    // 列表项（- data:）里的名字比「-」多缩进两格。只看下一层的「名字: 值」；值是块写法的（db: |、config.yaml: >-），
    // 下面缩进更深的几行连起来才是值（| 按行连，> 折成一行）
    const indent = block[1].length + (/^[ \t]*-/.test(line) ? 2 : 0);
    let child: number | undefined;
    let scalar: { name: string; lines: string[]; folded: boolean } | undefined;
    const flush = () => {
      if (scalar) {
        entries.push([block[2], scalar.name, scalar.lines.join(scalar.folded ? " " : "\n")]);
        scalar = undefined;
      }
    };
    for (const next of lines.slice(i + 1)) {
      if (!next.trim()) {
        continue;
      }
      const depth = /^[ \t]*/.exec(next)![0].length;
      if (scalar && child !== undefined && depth > child) {
        scalar.lines.push(next.trim());
        continue;
      }
      flush();
      if (/^[ \t]*#/.test(next)) {
        continue;
      }
      if (depth <= indent) {
        break;
      }
      child ??= depth;
      const pair = depth === child ? SECRET_DATA_LINE.exec(next) : null;
      if (!pair) {
        continue;
      }
      const value = pair[2] ?? pair[3] ?? pair[4];
      if (pair[4] !== undefined && /^[|>][-+0-9]*$/.test(value)) {
        scalar = { name: pair[1], lines: [], folded: value.startsWith(">") };
      } else {
        entries.push([block[2], pair[1], value]);
      }
    }
    flush();
  });
  for (const [, section, body] of text.matchAll(SECRET_DATA_OBJECT)) {
    for (const [, name, double, single, bare] of body.matchAll(SECRET_DATA_PAIR)) {
      entries.push([section, name, double ?? single ?? bare]);
    }
  }
  return entries;
}

/**
 * Kubernetes Secret 清单里的值本身就是密钥，名字叫什么都一样（DATABASE_URL、db、config）：data、binaryData 下的解开 base64，
 * stringData 下的直接看。名字明说不是密钥的（username、host、ca.crt 这些）不算，但解出来的文字里有密钥的照样算；
 * 不短于 6 个字符、不是占位的才算（"true"、"password" 这种不算）
 */
function secretManifestValue(text: string): boolean {
  if (!SECRET_KIND.test(text)) {
    return false;
  }
  return secretDataEntries(text).some(([section, name, value]) => {
    let plain: string | undefined = value;
    if (section !== "stringData") {
      // 块写法折成几行的 base64 连起来
      const encoded = value.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        return false;
      }
      const bytes = Buffer.from(encoded, "base64");
      plain = printableText(bytes);
      // 解出来不是文字的（keystore、DER 证书这些二进制）：名字不像是公开信息的算
      if (plain === undefined) {
        return bytes.length >= 6 && !PUBLIC_SECRET_KEY.test(name);
      }
    }
    if (findSecret(`${name}: ${plain}`) !== undefined) {
      return true;
    }
    const trimmed = plain.trim();
    return !PUBLIC_SECRET_KEY.test(name) && trimmed.length >= 6 && !isPlaceholder(trimmed);
  });
}

/**
 * DER 编码的私钥：最外面的 SEQUENCE 里先是版本号 0 或 1（INTEGER），后面跟着 RSA 的 INTEGER、PKCS#8 的算法 SEQUENCE
 * 或者 EC 的 OCTET STRING。证书、公钥的 SEQUENCE 里第一项是 SEQUENCE，加密过的 PKCS#8 也是，不算
 */
function isDerPrivateKey(bytes: Buffer): boolean {
  if (bytes[0] !== 0x30 || bytes.length < 2) {
    return false;
  }
  let i = 2;
  if (bytes[1] & 0x80) {
    const lengthBytes = bytes[1] & 0x7f;
    if (lengthBytes < 1 || lengthBytes > 3) {
      return false;
    }
    i += lengthBytes;
  }
  return bytes[i] === 0x02 && bytes[i + 1] === 0x01 && (bytes[i + 2] === 0x00 || bytes[i + 2] === 0x01) && [0x02, 0x30, 0x04].includes(bytes[i + 3]);
}

/** auth 配置项里写的是不是登录用的用户名和密码 */
function isAuthCredential(name: string, value: string): boolean {
  if (/^[A-Za-z0-9+/]{8,}={0,2}$/.test(value) && isBasicCredential(value)) {
    return true;
  }
  // 直接写的「用户名:密码」只认 npmAuthIdent 这类：别的 auth 后面的冒号是地址（oauth: https://…）
  const password = /ident$/i.test(name) ? /^[^:]+:(.{6,})$/.exec(value)?.[1] : undefined;
  return password !== undefined && !isPlaceholder(password);
}

/**
 * TOML、Python 里三个引号的多行字符串（password = """correct horse battery staple"""、api_key = '''…'''），值可以跨好几行。
 * 转义的引号（"""ab\"""cd…"""）不算结束。第 1 组是三个双引号里的，第 2 组是三个单引号里的
 */
const TRIPLE_QUOTED = new RegExp(
  String.raw`${CONFIG_KEY}["']?[^\S\r\n]*=[^\S\r\n]*(?:"""((?:\\[\s\S]|"(?!"")|[^"\\])*)"""|'''((?:\\[\s\S]|'(?!'')|[^'\\])*)''')`,
  "gi",
);

/**
 * 三个引号里的值：开头紧跟的换行去掉，行尾 \ 续到下一行的连起来，换行和连续的空白算一个空格。
 * 和单个引号里的一样，有中文的是说明，整个打了码的，不算
 */
function tripleQuotedValues(text: string): string[] {
  return [...text.matchAll(TRIPLE_QUOTED)].flatMap(([, double, single]) => {
    const value = (double ?? single)
      .replace(/^\r?\n/, "")
      .replace(/\\\r?\n\s*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return value.length >= 6 && !/[　-〿一-鿿＀-￯]/.test(value) && !isMasked(value) ? [value] : [];
  });
}

/**
 * Terraform/HCL、shell、Ruby 的 heredoc（password = <<EOT … EOT、<<-EOT、<<~EOS、<<'EOF'），值写在下面几行，到只有结束标记的那一行为止
 * （EOT-not-the-end 这种以标记开头的行还是内容）；后面截断了、没有结束标记的，到最后都算。第 2 组是结束标记，第 3 组是中间的内容
 */
const HEREDOC = new RegExp(
  String.raw`${CONFIG_KEY}["']?[^\S\r\n]*[=:][^\S\r\n]*<<[-~]?(["']?)([A-Za-z_]\w*)\1[^\S\r\n]*\r?\n([\s\S]*?)(?:\r?\n[^\S\r\n]*\2[^\S\r\n]*(?=\r?\n|$)|$)`,
  "gi",
);

/** heredoc 里的值：换行和连续的空白算一个空格。和引号里的一样，有中文的是说明，整个打了码的，不算 */
function heredocValues(text: string): string[] {
  return [...text.matchAll(HEREDOC)].flatMap(([, , , body]) => {
    const value = body.replace(/\s+/g, " ").trim();
    return value.length >= 6 && !/[　-〿一-鿿＀-￯]/.test(value) && !isMasked(value) ? [value] : [];
  });
}

/**
 * XML 配置里名字是密钥的元素（Maven settings.xml 的 <password>…</password>、<api-key><![CDATA[…]]></api-key>），可以带命名空间和属性。
 * 第 2 组是 CDATA 里的，第 3 组是直接写的
 */
const XML_ELEMENT = new RegExp(String.raw`<((?:[\w.-]+:)?${CONFIG_KEY})(?:\s[^<>]*)?>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*</\1\s*>`, "gi");
/**
 * 连在一起的一串「名字="值"」属性（一个 XML 标签里的全部属性）。属性的先后不限，值里可以有 >、可以换行，所以一个个属性往后接，不靠 > 断开
 */
const XML_ATTRIBUTES = /[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*')(?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*/g;
const XML_ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** 带属性的开始标签。第 1 组是全部属性，第 2 组是自闭合的 / */
const XML_OPEN_TAG = /<[\w.:-]+((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))+)\s*(\/?)>/g;
/**
 * 开始标签后面紧跟的内容（从 lastIndex 开始匹配）：CDATA 里的、Spring 的 <value> 子元素里的（CDATA 或直接写的），或者直接写的文字。
 * 第 1 到 4 组，有一个是值
 */
const XML_BODY = new RegExp(
  String.raw`\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|<(?:[\w.-]+:)?value(?:\s[^<>]*)?>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))|([^<]*))`,
  "iy",
);
const CONFIG_NAME = new RegExp(String.raw`^${CONFIG_KEY}$`, "i");

/** 一串属性按名字（小写、去掉命名空间前缀）取值 */
function xmlAttributes(attributes: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const [, name, double, single] of attributes.matchAll(XML_ATTRIBUTE)) {
    values.set(name.replace(/^.*:/, "").toLowerCase(), double ?? single);
  }
  return values;
}

/** key 或 name 属性是密钥的名字（ApiKey、db.password） */
function namesCredential(attributes: Map<string, string>): boolean {
  return [attributes.get("key"), attributes.get("name")].some((key) => key !== undefined && CONFIG_NAME.test(key.trim()));
}

/**
 * XML 里用名字属性标明是密钥的配置项的值：写在 value 属性里的（.NET 的 <add key="ApiKey" value="…"/>、Spring 的 <property name="password" value="…"/>，
 * value 写在 key 前面的也算），和写在元素里面的（Java 的 <entry key="password">…</entry>、Spring 的 <property name="password"><value>…</value></property>，可以是 CDATA）
 */
function xmlNamedValues(text: string): string[] {
  const values: string[] = [];
  for (const [attributes] of text.matchAll(XML_ATTRIBUTES)) {
    const parsed = xmlAttributes(attributes);
    const value = parsed.get("value");
    if (value !== undefined && namesCredential(parsed)) {
      values.push(value);
    }
  }
  for (const tag of text.matchAll(XML_OPEN_TAG)) {
    if (tag[2] || !namesCredential(xmlAttributes(tag[1]))) {
      continue;
    }
    XML_BODY.lastIndex = tag.index + tag[0].length;
    const body = XML_BODY.exec(text);
    const value = body?.slice(1).find((group) => group !== undefined);
    if (value !== undefined) {
      values.push(value);
    }
  }
  return values;
}

/** XML 注释（<!-- 生产库 -->） */
const XML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * XML 元素和属性里的值：换行和连续的空白算一个空格。和引号里的一样，有中文的是说明，整个打了码的，不算。
 * 去掉注释再看一遍：值前面、中间夹着注释的（<password>ab<!-- x -->cd</password>）连起来才是值；原文也看，注释掉的配置里的密钥照样算
 */
function xmlValues(text: string): string[] {
  const texts = text.includes("<!--") ? [text, text.replace(XML_COMMENT, "")] : [text];
  const raws = texts.flatMap((xml) => [...[...xml.matchAll(XML_ELEMENT)].map(([, , cdata, plain]) => cdata ?? plain), ...xmlNamedValues(xml)]);
  return raws.flatMap((raw) => {
    const value = raw.replace(/\s+/g, " ").trim();
    return value.length >= 6 && !/[　-〿一-鿿＀-￯]/.test(value) && !isMasked(value) ? [value] : [];
  });
}

/** 这段文字里是不是像有密钥（拦草稿、表格里的行用的同一套规则） */
export function containsSecret(text: string): boolean {
  return findSecret(text) !== undefined;
}

/** 转义的换行、回车、制表符；引号、反斜杠、斜杠去掉反斜杠就是它自己 */
const ESCAPED: Record<string, string> = { n: "\n", r: "\r", t: "\t" };

/** 草稿里像是密钥的是哪一种；没有时返回 undefined */
function findSecret(text: string): string | undefined {
  const known =
    SECRET_PATTERNS.find(([pattern]) => pattern.test(text)) ??
    LABELED_SECRETS.find(([pattern]) => [...text.matchAll(pattern)].some((match) => !isMasked(match.slice(1).find((value) => value !== undefined) ?? "")));
  if (known) {
    return known[1];
  }
  if ([...text.matchAll(BASIC_AUTH)].some(([, value]) => isBasicCredential(value))) {
    return "HTTP Basic 认证的用户名和密码";
  }
  if (authorizationCredentials(text).some((value) => !isPlaceholder(value))) {
    return "Authorization 头里的凭据";
  }
  if ([...text.matchAll(AUTH_FIELD)].some(([, name, value]) => isAuthCredential(name, value))) {
    return "仓库登录用的用户名和密码";
  }
  // 解开的 config.json 比原文短，递归会停下来
  const dockerConfig = [...text.matchAll(DOCKER_CONFIG)]
    .map(([, value]) => findSecret(Buffer.from(value.replace(/\s+/g, ""), "base64").toString("utf8")))
    .find((label) => label !== undefined);
  if (dockerConfig) {
    return dockerConfig;
  }
  const encoded = encodedSecret(text);
  if (encoded) {
    return encoded;
  }
  if (secretManifestValue(text)) {
    return "Kubernetes Secret 里的值";
  }
  if ([...text.matchAll(SIGNED_URL)].some(([, value]) => !isPlaceholder(value))) {
    return "带签名的临时访问地址";
  }
  if (cookieValues(text).some((value) => !isPlaceholder(value))) {
    return "Cookie 里的登录态";
  }
  const values = [
    ...[...text.matchAll(TOKEN_ASSIGNMENT)].map(([, double, single, bare]) => double ?? single ?? bare),
    ...[...text.matchAll(ENV_ASSIGNMENT), ...text.matchAll(LINE_ASSIGNMENT)].flatMap(([, value]) => (value.length >= 8 ? [value] : [])),
    ...blockValues(text),
    ...foldedQuotedValues(text),
    ...tripleQuotedValues(text),
    ...heredocValues(text),
    ...xmlValues(text),
    ...curlPasswords(text),
    ...netrcPasswords(text),
    ...pgpassPasswords(text),
    // shell 里转义的空格（correct\ horse）还原成空格再看是不是占位
    ...[...text.matchAll(CLI_OPTION)].flatMap(([, double, single, bare]) =>
      bare === undefined ? [double ?? single] : OPTION_SPEC.test(bare) ? [] : [bare.replace(/\\(?=[ \t])/g, "")],
    ),
  ];
  if (values.some((value) => !isPlaceholder(value))) {
    return "密码或令牌";
  }
  // 字符串里套着转义过的 JSON（payload="{\"password\":\"…\"}"）：反斜杠夹在名字、引号和值中间，上面的规则都对不上。
  // 去掉一层转义再看一遍，套了几层就递归几次（每次都变短，会停下来）
  const unescaped = text.replace(/\\(["'\\/nrt])/g, (_, char: string) => ESCAPED[char] ?? char);
  return unescaped === text ? undefined : findSecret(unescaped);
}

/** 表格里这一行哪一项里像是有密钥；没有时返回 undefined。编号、确认人这些也会写进检索结果，有编辑权限的人也能改，一起查 */
function entrySecret(entry: KnowledgeEntry): string | undefined {
  const fields: [string, string | undefined][] = [
    ["编号", entry.id],
    ["标题", entry.title],
    ["适用范围", entry.scope],
    ["问题或场景", entry.question],
    ["结论", entry.conclusion],
    ["怎么处理", entry.handling],
    ["依据或排查过程", entry.basis],
    ["关键词", entry.keywords],
    ["错误码", entry.errorCodes],
    ["告警名", entry.alertname],
    ["发起人", entry.proposedBy],
    ["确认人", entry.confirmedBy],
    ["来源", entry.source],
    ["取代的经验", entry.replaces],
  ];
  for (const [name, text] of fields) {
    const secret = text ? findSecret(text) : undefined;
    if (secret) {
      return `${name}里像是有${secret}`;
    }
  }
  return undefined;
}

/** 起草时有字数上限的那几项：[名字, 内容, 上限]。表格里读到的行也按它查 */
function draftFields(draft: KnowledgeDraft): [string, string | undefined, number][] {
  return [
    ["标题", draft.title, MAX_TITLE_CHARS],
    ["适用范围", draft.scope, MAX_FIELD_CHARS],
    ["问题或场景", draft.question, MAX_FIELD_CHARS],
    ["结论", draft.conclusion, MAX_FIELD_CHARS],
    ["怎么处理", draft.handling, MAX_FIELD_CHARS],
    ["依据或排查过程", draft.basis, MAX_FIELD_CHARS],
    ["关键词", draft.keywords, MAX_FIELD_CHARS],
    ["错误码", draft.errorCodes, MAX_FIELD_CHARS],
    ["告警名", draft.alertname, MAX_FIELD_CHARS],
  ];
}

/** 去掉首尾空白、检查必填、长度和密钥 */
export function normalizeDraft(draft: Record<string, unknown>): KnowledgeDraft {
  const category = draft.category;
  if (typeof category !== "string" || !Object.hasOwn(KNOWLEDGE_CATEGORIES, category)) {
    throw new KnowledgeError(`category 只能是 ${Object.keys(KNOWLEDGE_CATEGORIES).join("、")} 之一`);
  }
  // shape：存进去之前怎么改写（标题合成一行，关键词、错误码统一用逗号分隔）。改写前后都查一遍密钥：
  // 「API_KEY=」换行写值时原文第一行是空的赋值，合成一行后就成了「API_KEY= 值」
  const field = (key: string, name: string, limit: number, required: boolean, shape: (text: string) => string = (text) => text): string | undefined => {
    const value = draft[key];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new KnowledgeError(`${name}（${key}）要填文字`);
    }
    const text = (value ?? "").trim();
    if (!text) {
      if (required) {
        throw new KnowledgeError(`${name}（${key}）不能为空`);
      }
      return undefined;
    }
    if (text.length > limit) {
      throw new KnowledgeError(`${name}（${key}）最多 ${limit} 字，现在 ${text.length} 字，请写得更精炼`);
    }
    const shaped = shape(text);
    const secret = findSecret(text) ?? (shaped === text ? undefined : findSecret(shaped));
    if (secret) {
      throw new KnowledgeError(
        `${name}（${key}）里像是有${secret}。经验库所有群都能看到，不能存密钥和密码：去掉或者换成 *** 再起草，回答里也不要复述它`,
      );
    }
    return shaped;
  };
  const optional = (key: string, name: string) => field(key, name, MAX_FIELD_CHARS, false);
  const result: KnowledgeDraft = {
    category: category as KnowledgeCategory,
    title: field("title", "标题", MAX_TITLE_CHARS, true, (text) => text.replace(/\s*\n\s*/g, " "))!,
    question: field("question", "问题或场景", MAX_FIELD_CHARS, true)!,
    conclusion: field("conclusion", "结论", MAX_FIELD_CHARS, true)!,
  };
  const scope = optional("scope", "适用范围");
  const handling = optional("handling", "怎么处理");
  const basis = optional("basis", "依据或排查过程");
  const list = (text: string) => splitList(text).join(",");
  const keywords = field("keywords", "关键词", MAX_FIELD_CHARS, false, list);
  const errorCodes = field("error_codes", "错误码", MAX_FIELD_CHARS, false, list);
  const alertname = optional("alertname", "告警名");
  return {
    ...result,
    ...(scope ? { scope } : {}),
    ...(handling ? { handling } : {}),
    ...(basis ? { basis } : {}),
    ...(keywords ? { keywords } : {}),
    ...(errorCodes ? { errorCodes } : {}),
    ...(alertname ? { alertname } : {}),
  };
}

/**
 * 表格里现在这一条的内容，按起草的规则再检查一遍（必填、长度、密钥）。同步到 aiops 用它：
 * 卡片没做完时可能有人在表格里直接改过这一行，同步过去的要和表格一致，改进去的密钥也不能带过去
 */
export function draftOf(entry: KnowledgeEntry): KnowledgeDraft {
  return normalizeDraft({
    category: entry.category,
    title: entry.title,
    scope: entry.scope,
    question: entry.question,
    conclusion: entry.conclusion,
    handling: entry.handling,
    basis: entry.basis,
    keywords: entry.keywords,
    error_codes: entry.errorCodes,
    alertname: entry.alertname,
  });
}

/** 卡片发出后表格里这一行改过（或者缺了标题、结论，被写进了密钥）：卡片上的已经不是现在这条，作废 */
function checkSeen(entry: KnowledgeEntry, seen: KnowledgeEntry | undefined): void {
  if (seen && (!usable(entry) || !sameContent(entry, seen))) {
    throw new StaleProposalError(`经验 ${entry.id} 在卡片发出后在表格里改过，卡片上的已经不是现在这条，这张卡片不能再用。需要的话请按现在的内容重新起草`);
  }
}

/**
 * 卡片上那一条现在是表格里的哪一行：先按草稿编号（卡片发出后编号被改了、或者复制出来的行占着旧编号也认得对），再按编号。
 * 没有草稿编号的行（表格里手动加的、导入的）按编号找不到时，按内容找：正好一行和卡片上的一样，就是改了编号的那一行；
 * 好几行一样分不清时报错。都找不到返回 undefined
 */
function cardTarget(entries: readonly KnowledgeEntry[], id: string, seen: KnowledgeEntry | undefined): KnowledgeEntry | undefined {
  const found = byRequestOrId(entries, seen?.requestId, id);
  if (found || !seen || seen.requestId) {
    return found;
  }
  const same = entries.filter((entry) => !entry.requestId && sameContent(entry, seen));
  if (same.length > 1) {
    const ids = same.map((row) => row.id).filter((rowId) => !containsSecret(rowId));
    throw new KnowledgeError(
      `表格里找不到经验 ${id}，内容和它一样的有 ${same.length} 行${ids.length > 0 ? `（经验 ${ids.join("、")}）` : ""}，分不清是哪一行。请把其中一行的编号改回 ${id} 后再点一次卡片上的按钮`,
    );
  }
  return same[0];
}

/**
 * 草稿编号是 requestId 的那一行，没有草稿编号或者找不到时按编号找。按编号找到的行带着别的草稿编号时不算：
 * 那是另一次保存的行，后来被改成了这个编号（原来那行删了），拿它接着同步、归档就做到别的经验上了
 */
function byRequestOrId(entries: readonly KnowledgeEntry[], requestId: string | undefined, id: string): KnowledgeEntry | undefined {
  const wanted = normalizeId(id);
  return (
    (requestId ? byRequestId(entries, requestId) : undefined) ??
    entries.find((entry) => normalizeId(entry.id) === wanted && (!requestId || !entry.requestId))
  );
}

/**
 * 草稿编号是 requestId 的那一行。表格里复制出来的行带着同一个草稿编号、后来又改了编号时，编号查重认不出来，
 * 随便挑一行可能挑到内容不相干的那行，后面同步、归档就做到别的行上了：分不清时报错，让人在表格里清掉复制出来的那行的草稿编号
 */
function byRequestId(entries: readonly KnowledgeEntry[], requestId: string): KnowledgeEntry | undefined {
  const rows = entries.filter((entry) => entry.requestId === requestId);
  if (rows.length > 1) {
    // 编号里写进了密钥的不列出来，卡片上群里人人都看得到
    const ids = rows.map((row) => row.id).filter((rowId) => !containsSecret(rowId));
    throw new KnowledgeError(
      `表格里有 ${rows.length} 行的「草稿编号」一样${ids.length > 0 ? `（经验 ${ids.join("、")}）` : ""}，多半是复制出来的行，分不清哪一行是卡片上的那条。请把复制出来的那几行的草稿编号清空后再点一次卡片上的按钮`,
    );
  }
  return rows[0];
}

/** 这一行能拿来检索、给模型看、起草卡片：没缺标题或结论，没被写进密钥，编号也没和别的行重复 */
export function usable(entry: KnowledgeEntry): boolean {
  return !entry.unsafe && !entry.incomplete && !entry.conflict;
}

/** 表格里编号重复的几行（不分大小写，「#K12」「K 12」和「K12」也算同一个）都标上 conflict */
function markConflicts(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = normalizeId(entry.id);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return entries.map((entry) => (counts.get(normalizeId(entry.id))! > 1 ? { ...entry, conflict: "和别的行用了同一个编号" } : entry));
}

/** 卡片上给大家看的那些内容（类别、标题、问题、结论这些）和表格里现在的一样不一样；aiops 编号、状态不算 */
export function sameContent(a: KnowledgeDraft, b: KnowledgeDraft): boolean {
  const keys = ["category", "title", "scope", "question", "conclusion", "handling", "basis", "keywords", "errorCodes", "alertname"] as const;
  return keys.every((key) => (a[key] ?? "") === (b[key] ?? ""));
}

const DATE_FORMAT = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric" });

/** 一条经验写成文字：标题一行，下面按字段列出，最后一行是状态、确认人和日期 */
export function formatKnowledge(
  entry: KnowledgeEntry,
  { limit, fieldChars, first = [] }: { limit?: number; fieldChars?: number; first?: readonly string[] } = {},
): string {
  const meta = [
    entry.status === "archived" ? "已归档" : "",
    entry.confirmedBy ? `确认人 ${entry.confirmedBy}` : "",
    DATE_FORMAT.format(new Date(entry.createdAt)),
    entry.aiopsId ? `aiops 里是经验 #${entry.aiopsId}` : "",
  ].filter(Boolean);
  const fields = fieldLines(entry);
  const text = [
    `经验 ${entry.id} [${KNOWLEDGE_CATEGORIES[entry.category]}]：${entry.title}`,
    ...[...fields.filter(([name]) => first.includes(name)), ...fields.filter(([name]) => !first.includes(name))].map(
      ([name, value]) =>
        `- ${name}：${fieldChars !== undefined && value.length > fieldChars ? `${value.slice(0, fieldChars)}…（这一项后面省略，要看全文用 knowledge_get）` : value}`,
    ),
    `（${meta.join("，")}）`,
  ].join("\n");
  return limit !== undefined && text.length > limit ? `${text.slice(0, limit)}…（后面省略，要看全文用 knowledge_get）` : text;
}

/** 正文字段：[名字, 内容]，没填的不列 */
export function fieldLines(entry: KnowledgeDraft): [string, string][] {
  const fields: [string, string | undefined][] = [
    ["适用范围", entry.scope],
    ["问题或场景", entry.question],
    ["结论", entry.conclusion],
    ["怎么处理", entry.handling],
    ["依据或排查过程", entry.basis],
    ["关键词", entry.keywords],
    ["错误码", entry.errorCodes],
    ["告警名", entry.alertname],
  ];
  return fields.filter((pair): pair is [string, string] => Boolean(pair[1]));
}

/** 写进系统提示词的「可能相关的经验」 */
export function renderHitsForPrompt(hits: readonly KnowledgeHit[]): string {
  return hits
    .map((hit) => formatKnowledge(hit.entry, { limit: PROMPT_ENTRY_CHARS, fieldChars: PROMPT_FIELD_CHARS, first: PROMPT_FIRST_FIELDS }))
    .join("\n\n");
}
