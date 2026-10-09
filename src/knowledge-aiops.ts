import type { Logger } from "./history.js";
import { type KnowledgeDraft, KnowledgeError } from "./knowledge.js";
import type { McpTaskContext } from "./mcp.js";

/** 回答前检索时，提问最多取多少字 */
const QUERY_CHARS = 800;
/**
 * aiops 检索的得分到这个数才写进提示词。只传提问原文时，aiops 只按两路打分：经验里的错误码出现在提问里 +8，
 * 语义相似度不低于 0.55 时加相似度×10。所以这个数大致等于「语义相似度 0.55 以上，或者错误码对上了」
 */
const MIN_PROMPT_SCORE = 5.5;
/** 写进提示词时每条经验最多多少字 */
const PROMPT_HIT_CHARS = 1200;

/** aiops 检索返回的一条经验 */
export interface AiopsLessonHit {
  id: number;
  title: string;
  score: number;
  symptom?: string;
  root_cause?: string;
  solution?: string;
  diagnosis_path?: string;
}

/** aiops 经验库里的一条经验（get_knowledge 返回的字段） */
export interface AiopsLesson {
  id: number;
  title: string;
  status: string;
  service?: string;
  symptom?: string;
  root_cause?: string;
  solution?: string;
  diagnosis_path?: string;
  keywords?: string;
}

export type AiopsSaveResult = { saved: true; id: number } | { saved: false; duplicate: { id: number; title: string; why?: string } };

/** McpHub 里要用的几个方法 */
export interface LessonsMcp {
  /** 服务端有没有这个工具（不管开没开给模型） */
  hasTool(server: string, tool: string): boolean;
  /** 程序自己调工具（不经过模型），返回原文；工具报错时抛错 */
  callDirect(server: string, tool: string, args: Record<string, unknown>, task: McpTaskContext, signal?: AbortSignal): Promise<string>;
}

/**
 * aiops 自带的经验库（MySQL），告警自动排查和 Open WebUI 也在用，只存排查经验。
 * 团队经验库里的排查经验保存时同步一份过去，回答前也在这里查一次
 */
export class AiopsLessons {
  private readonly logger: Logger;

  constructor(
    private readonly mcp: LessonsMcp,
    private readonly server = "aiops",
    logger?: Logger,
  ) {
    this.logger = logger ?? console;
  }

  /** aiops 连上了、有检索工具 */
  get searchable(): boolean {
    return this.mcp.hasTool(this.server, "search_knowledge");
  }

  /** aiops 有保存和归档工具 */
  get writable(): boolean {
    return this.mcp.hasTool(this.server, "save_lesson") && this.mcp.hasTool(this.server, "archive_lesson");
  }

  /** 按提问原文检索，返回够相近的（aiops 最多给 5 条，只看有效的） */
  async search(text: string, task: McpTaskContext, signal?: AbortSignal): Promise<AiopsLessonHit[]> {
    const query = text.trim().slice(0, QUERY_CHARS);
    if (!query || !this.searchable) {
      return [];
    }
    const raw = await this.mcp.callDirect(this.server, "search_knowledge", { text: query }, task, signal);
    const data = parseJson(raw) as { hits?: unknown } | undefined;
    if (!Array.isArray(data?.hits)) {
      return [];
    }
    return data.hits.flatMap((hit): AiopsLessonHit[] => {
      const item = hit as Record<string, unknown>;
      if (typeof item.id !== "number" || typeof item.title !== "string") {
        return [];
      }
      const score = typeof item.score === "number" ? item.score : 0;
      return score >= MIN_PROMPT_SCORE
        ? [{ id: item.id, title: item.title, score, ...pickStrings(item, ["symptom", "root_cause", "solution", "diagnosis_path"]) }]
        : [];
    });
  }

  async get(id: number, task: McpTaskContext, signal?: AbortSignal): Promise<AiopsLesson> {
    const raw = await this.mcp.callDirect(this.server, "get_knowledge", { id }, task, signal);
    const data = parseJson(raw) as Record<string, unknown> | undefined;
    // get_knowledge 有的版本把条目放在 knowledge 字段里
    const item = (data && typeof data.knowledge === "object" && data.knowledge !== null ? data.knowledge : data) as Record<string, unknown> | undefined;
    if (!item || typeof item.title !== "string") {
      throw new KnowledgeError(`aiops 经验库里取不到经验 #${id}：${raw.slice(0, 200)}`);
    }
    return {
      id: typeof item.id === "number" ? item.id : id,
      title: item.title,
      status: typeof item.status === "string" ? item.status : "active",
      ...pickStrings(item, ["service", "symptom", "root_cause", "solution", "diagnosis_path", "keywords"]),
    };
  }

  /** 把一条排查经验写进 aiops。aiops 说和已有的很像时不存，返回那一条 */
  async save(
    draft: KnowledgeDraft,
    { confirmedBy, caseId, teamId }: { confirmedBy: string; caseId?: number; teamId: string },
    task: McpTaskContext,
  ): Promise<AiopsSaveResult> {
    const args: Record<string, unknown> = {
      title: draft.title,
      root_cause: draft.conclusion,
      symptom: draft.question,
      source: caseId === undefined ? "chat" : "case",
      created_by: `feishu:${confirmedBy}`,
      // 排查过程末尾注明出自团队经验库，aiops 里看到的人知道去哪改
      diagnosis_path: [draft.basis, `（来自飞书团队经验库 ${teamId}）`].filter(Boolean).join("\n"),
      ...(caseId === undefined ? {} : { case_id: caseId }),
      ...(draft.scope ? { service: draft.scope } : {}),
      ...(draft.handling ? { solution: draft.handling } : {}),
      ...(draft.keywords ? { keywords: draft.keywords } : {}),
      ...(draft.errorCodes ? { error_codes: draft.errorCodes } : {}),
      ...(draft.alertname ? { alertname: draft.alertname } : {}),
    };
    const raw = await this.mcp.callDirect(this.server, "save_lesson", args, task);
    const data = parseJson(raw) as Record<string, unknown> | undefined;
    if (data?.saved === true && typeof data.id === "number") {
      this.logger.info(`aiops 经验库 保存 经验 #${data.id}「${draft.title}」（团队经验库 ${teamId}） 确认人=${confirmedBy}`);
      return { saved: true, id: data.id };
    }
    const duplicate = data?.duplicate_of as Record<string, unknown> | undefined;
    if (data?.saved === false && duplicate && typeof duplicate.id === "number") {
      return {
        saved: false,
        duplicate: { id: duplicate.id, title: String(duplicate.title ?? ""), ...(typeof duplicate.why === "string" ? { why: duplicate.why } : {}) },
      };
    }
    throw new KnowledgeError(`aiops 没有说存没存成功：${raw.slice(0, 300)}`);
  }

  async archive(id: number, confirmedBy: string, task: McpTaskContext): Promise<void> {
    await this.mcp.callDirect(this.server, "archive_lesson", { id }, task);
    this.logger.info(`aiops 经验库 归档 经验 #${id} 确认人=${confirmedBy}`);
  }
}

/** 写进系统提示词的「aiops 经验库里可能相关的经验」 */
export function renderAiopsHitsForPrompt(hits: readonly AiopsLessonHit[]): string {
  return hits
    .map((hit) => {
      const text = [
        `aiops 经验 #${hit.id}：${hit.title}`,
        ...([
          ["现象", hit.symptom],
          ["根因", hit.root_cause],
          ["处理办法", hit.solution],
          ["排查过程", hit.diagnosis_path],
        ] as const)
          .filter(([, value]) => value)
          .map(([name, value]) => `- ${name}：${value}`),
      ].join("\n");
      return text.length > PROMPT_HIT_CHARS ? `${text.slice(0, PROMPT_HIT_CHARS)}…（后面省略，要看全文用 aiops_get_knowledge）` : text;
    })
    .join("\n\n");
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function pickStrings<K extends string>(item: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) {
      out[key] = value;
    }
  }
  return out;
}
