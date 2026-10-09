import { createHash } from "node:crypto";
import { anySignal, raceAbort } from "./abort.js";
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
/** 一次给向量模型的条数（百炼 text-embedding-v4 一次最多 10 条） */
const EMBED_BATCH = 10;
/** 算向量时每条最多多少字 */
const EMBED_TEXT_CHARS = 2000;
/** 检索用的文字里，问题和结论各最多取多少字：问题写得很长时结论也要留在里面 */
const INDEX_FIELD_CHARS = 800;
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
  createdAt: string;
  updatedAt?: string;
}

export interface KnowledgeMeta {
  proposedBy?: string;
  confirmedBy?: string;
  source?: string;
  /** 确认卡片的草稿编号（UUID）。同一个编号只存一次 */
  requestId?: string;
  /** 要取代的旧经验编号：存之前确认它还有效，免得两张卡片各存一条新的去取代同一条 */
  replaces?: string;
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
  add(entry: KnowledgeEntry): Promise<void>;
  update(id: string, changes: Partial<Pick<KnowledgeEntry, "status" | "aiopsId">>): Promise<void>;
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

export interface KnowledgeBaseOptions {
  embedder?: Embedder;
  logger?: Logger;
  now?: () => Date;
  cacheMs?: number;
}

/**
 * 团队经验库：所有群共用，人确认过的结论才存进来。检索按关键词加语义（配了向量模型时），
 * 列表缓存一分钟，向量按内容缓存，内容没变不重算。保存排队进行，编号按已有的最大编号加一
 */
export class KnowledgeBase {
  private readonly embedder?: Embedder;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly cacheMs: number;
  private cached?: { at: number; entries: Promise<KnowledgeEntry[]> };
  private readonly vectors = new Map<string, number[]>();
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
  }

  location(): Promise<string | undefined> {
    return this.backend.location();
  }

  async entries(fresh = false): Promise<KnowledgeEntry[]> {
    const at = this.now().getTime();
    if (fresh || !this.cached || at - this.cached.at > this.cacheMs) {
      const entries = this.backend.list();
      this.cached = { at, entries };
      // 读失败不缓存，下次重试
      entries.catch(() => {
        if (this.cached?.entries === entries) {
          this.cached = undefined;
        }
      });
    }
    return structuredClone(await this.cached.entries);
  }

  async get(id: string): Promise<KnowledgeEntry | undefined> {
    const wanted = normalizeId(id);
    return (await this.entries()).find((entry) => entry.id.toUpperCase() === wanted);
  }

  /** 按提问找相近的经验，默认只看有效的，按相近程度排序 */
  async search(query: string, { limit = 3, category, includeArchived = false, signal, semanticDeadline }: SearchOptions = {}): Promise<KnowledgeHit[]> {
    const text = query.trim().slice(0, QUERY_CHARS);
    if (!text) {
      return [];
    }
    const candidates = (await this.entries()).filter(
      (entry) => (includeArchived || entry.status === "active") && (!category || entry.category === category),
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
      const saved = meta.requestId ? entries.find((entry) => entry.requestId === meta.requestId) : undefined;
      if (saved) {
        this.logger.info(`经验库 ${saved.id}「${saved.title}」上次已经存进去了（草稿 ${meta.requestId}），不重复保存`);
        return saved;
      }
      if (meta.replaces) {
        const old = entries.find((entry) => entry.id.toUpperCase() === normalizeId(meta.replaces!));
        if (old?.status !== "active") {
          throw new StaleProposalError(
            `要取代的经验 ${meta.replaces} ${old ? "已经归档了（可能已经被别的卡片取代）" : "不在经验库里了"}，这张卡片不能再保存。需要的话请重新起草`,
          );
        }
      }
      const next = Math.max(0, ...entries.map((entry) => numberOf(entry.id))) + 1;
      const entry: KnowledgeEntry = {
        ...draft,
        id: `K${next}`,
        status: "active",
        ...(meta.proposedBy ? { proposedBy: meta.proposedBy } : {}),
        ...(meta.confirmedBy ? { confirmedBy: meta.confirmedBy } : {}),
        ...(meta.source ? { source: meta.source } : {}),
        ...(meta.requestId ? { requestId: meta.requestId } : {}),
        createdAt: this.now().toISOString(),
      };
      await this.backend.add(entry);
      this.cached = undefined;
      this.logger.info(`经验库 新增 ${entry.id}「${entry.title}」 类别=${entry.category} 发起人=${meta.proposedBy ?? "未知"} 确认人=${meta.confirmedBy ?? "未知"}`);
      return entry;
    });
  }

  /**
   * 归档一条经验：不再被检索到，表格里还留着，改回「有效」就恢复。
   * 已经归档了的直接返回：上次点确认时表格改成功了、结果没传回来，再点一次要能接着做后面的（归档 aiops 里那条）
   */
  archive(id: string, meta: KnowledgeMeta = {}): Promise<KnowledgeEntry> {
    return this.exclusive(async () => {
      const entry = (await this.entries(true)).find((e) => e.id.toUpperCase() === normalizeId(id));
      if (!entry) {
        throw new KnowledgeError(`经验库里没有 ${id}`);
      }
      if (entry.status === "archived") {
        this.logger.info(`经验库 归档 ${entry.id}：已经是归档状态，不用再改`);
        return entry;
      }
      await this.backend.update(entry.id, { status: "archived" });
      this.cached = undefined;
      this.logger.info(`经验库 归档 ${entry.id} 确认人=${meta.confirmedBy ?? "未知"}`);
      return { ...entry, status: "archived" };
    });
  }

  /** 记下同步到 aiops 后的编号 */
  linkAiops(id: string, aiopsId: number): Promise<void> {
    return this.exclusive(async () => {
      await this.backend.update(id, { aiopsId });
      this.cached = undefined;
    });
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.lock.then(run);
    this.lock = result.catch(() => {});
    return result;
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
      const keys = texts.map((text) => createHash("sha256").update(`${embedder.model}\n${text}`).digest("hex"));
      const byKey = new Map(keys.map((key, i) => [key, texts[i]]));
      const missing = [...byKey.keys()].filter((key) => !this.vectors.has(key));
      for (let i = 0; i < missing.length; i += EMBED_BATCH) {
        const batch = missing.slice(i, i + EMBED_BATCH);
        const vectors = await embed(batch.map((key) => byKey.get(key)!));
        batch.forEach((key, j) => this.vectors.set(key, vectors[j]));
      }
      const [queryVector] = await embed([query]);
      return keys.map((key) => cosine(queryVector, this.vectors.get(key)!));
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

/** 一条经验用来检索的文字：结论放在问题前面，两者各截一段，总长超了截掉的是问题的末尾 */
function indexText(entry: KnowledgeDraft): string {
  return [
    `${KNOWLEDGE_CATEGORIES[entry.category]}：${entry.title}`,
    entry.scope,
    entry.keywords,
    entry.errorCodes,
    entry.alertname,
    entry.conclusion.slice(0, INDEX_FIELD_CHARS),
    entry.question.slice(0, INDEX_FIELD_CHARS),
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
  const markers = [...splitList(entry.keywords), ...splitList(entry.errorCodes), ...splitList(entry.alertname)];
  const keywordHits = markers.filter((word) => word.length >= 2 && lower.includes(word.toLowerCase())).length;
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
  const match = /^K(\d+)$/i.exec(id);
  return match ? Number(match[1]) : 0;
}

/** 「k12」「K 12」「#K12」都认成 K12 */
export function normalizeId(id: string): string {
  return id.replace(/[#\s]/g, "").toUpperCase();
}

/**
 * 经验库所有群都能看，排查经验还会同步给 aiops 的告警自动排查，所以明显的密钥、密码不让存。
 * 只拦格式很确定的，免得误伤；手机号这类个人信息靠提示词
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "私钥"],
  [/\bglpat-[\w-]{16,}/, "GitLab 令牌"],
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
  // AccessKey 的 Secret（AWS_SECRET_ACCESS_KEY、阿里云 AccessKeySecret）：写明了是它的，值里没有数字也算
  [/(?:secret[_-]?access[_-]?key|access[_-]?key[_-]?secret)\s*[:=：]\s*[^\s,，;；*\u4e00-\u9fff]{16,}/i, "云服务的 AccessKey Secret"],
  [/\bBearer\s+[\w.~+/-]{20,}/i, "Bearer 令牌"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i, "带密码的连接地址"],
  // 写明了是密码的，值里没有数字也算（correcthorsebatterystaple）；中文说明（「密码：请找管理员重置」）和 *** 不算
  [/(?:password|passwd|pwd|密码|口令)\s*[:=：]\s*[^\s,，;；*\u4e00-\u9fff]{6,}/i, "密码"],
  // token、secret（也算 secret_key、token_key 这类）后面常跟报错原文（token=expired_session），要带数字才算
  [/(?:secret|token)(?:[_-]?(?:access[_-]?)?key)?\s*[:=：]\s*(?=[^\s,，;；*]*\d)[^\s,，;；*]{8,}/i, "密码或令牌"],
];

/** 去掉首尾空白、检查必填、长度和密钥 */
export function normalizeDraft(draft: Record<string, unknown>): KnowledgeDraft {
  const category = draft.category;
  if (typeof category !== "string" || !Object.hasOwn(KNOWLEDGE_CATEGORIES, category)) {
    throw new KnowledgeError(`category 只能是 ${Object.keys(KNOWLEDGE_CATEGORIES).join("、")} 之一`);
  }
  const field = (key: string, name: string, limit: number, required: boolean): string | undefined => {
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
    const secret = SECRET_PATTERNS.find(([pattern]) => pattern.test(text));
    if (secret) {
      throw new KnowledgeError(
        `${name}（${key}）里像是有${secret[1]}。经验库所有群都能看到，不能存密钥和密码：去掉或者换成 *** 再起草，回答里也不要复述它`,
      );
    }
    return text;
  };
  const optional = (key: string, name: string) => field(key, name, MAX_FIELD_CHARS, false);
  const result: KnowledgeDraft = {
    category: category as KnowledgeCategory,
    title: field("title", "标题", MAX_TITLE_CHARS, true)!.replace(/\s*\n\s*/g, " "),
    question: field("question", "问题或场景", MAX_FIELD_CHARS, true)!,
    conclusion: field("conclusion", "结论", MAX_FIELD_CHARS, true)!,
  };
  const scope = optional("scope", "适用范围");
  const handling = optional("handling", "怎么处理");
  const basis = optional("basis", "依据或排查过程");
  const keywords = optional("keywords", "关键词");
  const errorCodes = optional("error_codes", "错误码");
  const alertname = optional("alertname", "告警名");
  return {
    ...result,
    ...(scope ? { scope } : {}),
    ...(handling ? { handling } : {}),
    ...(basis ? { basis } : {}),
    ...(keywords ? { keywords: splitList(keywords).join(",") } : {}),
    ...(errorCodes ? { errorCodes: splitList(errorCodes).join(",") } : {}),
    ...(alertname ? { alertname } : {}),
  };
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
