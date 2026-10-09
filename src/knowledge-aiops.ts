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
/** 写进提示词时每条经验最多多少字、每一项最多多少字 */
const PROMPT_HIT_CHARS = 1200;
const PROMPT_FIELD_CHARS = 400;

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
  /** 连上过、拿到了服务端的工具清单 */
  connected(server: string): boolean;
  /** 程序自己调工具（不经过模型），返回原文；工具报错时抛错 */
  callDirect(server: string, tool: string, args: Record<string, unknown>, task: McpTaskContext, signal?: AbortSignal): Promise<string>;
}

/**
 * 同步、归档要用的 aiops 工具：存和归档；存的结果没传回来时再试要先检索找那一条；归档报错时、起草归档 aiops 经验时要取详情看状态
 */
const WRITE_TOOLS = ["save_lesson", "archive_lesson", "search_knowledge", "get_knowledge"];

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

  /** 同步、归档要用的工具里 aiops 没有的 */
  get missingWriteTools(): string[] {
    return WRITE_TOOLS.filter((tool) => !this.mcp.hasTool(this.server, tool));
  }

  /** aiops 有同步、归档要用的全部工具 */
  get writable(): boolean {
    return this.missingWriteTools.length === 0;
  }

  /** aiops 连上了，却少了同步、归档要用的工具（版本旧、没配 MySQL）：再试也做不成，不能答应同步。还没连上时不算 */
  get lacksWriteTools(): boolean {
    return this.mcp.connected(this.server) && !this.writable;
  }

  /** 按提问原文检索，返回够相近的（aiops 最多给 5 条，只看有效的） */
  async search(text: string, task: McpTaskContext, signal?: AbortSignal): Promise<AiopsLessonHit[]> {
    const query = text.trim().slice(0, QUERY_CHARS);
    if (!query || !this.searchable) {
      return [];
    }
    return (await this.query({ text: query }, task, signal)).filter((hit) => hit.score >= MIN_PROMPT_SCORE);
  }

  /** 调 search_knowledge，返回 aiops 给的全部命中（最多 5 条，只有有效的） */
  private async query(args: Record<string, unknown>, task: McpTaskContext, signal?: AbortSignal): Promise<AiopsLessonHit[]> {
    const raw = await this.mcp.callDirect(this.server, "search_knowledge", args, task, signal);
    const data = parseJson(raw) as { hits?: unknown } | undefined;
    // 格式不对不能当成没查到：回答前的检索要算没查成，再试同步时要算没找成（不然会再存一条）
    if (!Array.isArray(data?.hits)) {
      throw new KnowledgeError(`aiops 检索返回的格式不对：${raw.slice(0, 200)}`);
    }
    return data.hits.flatMap((hit): AiopsLessonHit[] => {
      const item = hit as Record<string, unknown>;
      const id = lessonId(item.id);
      if (id === undefined || typeof item.title !== "string") {
        return [];
      }
      const score = typeof item.score === "number" ? item.score : 0;
      return [{ id, title: item.title, score, ...pickStrings(item, ["symptom", "root_cause", "solution", "diagnosis_path"]) }];
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
    if (item.id !== undefined && lessonId(item.id) !== id) {
      throw new KnowledgeError(`aiops 取经验 #${id} 时返回的是别的编号：${raw.slice(0, 200)}`);
    }
    return {
      id,
      title: item.title,
      status: typeof item.status === "string" ? item.status : "active",
      ...pickStrings(item, ["service", "symptom", "root_cause", "solution", "diagnosis_path", "keywords"]),
    };
  }

  /** 把一条排查经验写进 aiops。aiops 说和已有的很像时不存，返回那一条；force 时不查重 */
  async save(
    draft: KnowledgeDraft,
    { confirmedBy, caseId, teamId, force }: { confirmedBy: string; caseId?: number; teamId: string; force?: boolean },
    task: McpTaskContext,
  ): Promise<AiopsSaveResult> {
    const args: Record<string, unknown> = {
      title: draft.title,
      root_cause: draft.conclusion,
      symptom: draft.question,
      source: caseId === undefined ? "chat" : "case",
      created_by: `feishu:${confirmedBy}`,
      // 排查过程末尾注明出自团队经验库，aiops 里看到的人知道去哪改，再试一次时也靠它认出已经存过的
      diagnosis_path: [draft.basis, teamSourceNote(teamId)].filter(Boolean).join("\n"),
      ...(caseId === undefined ? {} : { case_id: caseId }),
      ...(draft.scope ? { service: draft.scope } : {}),
      ...(draft.handling ? { solution: draft.handling } : {}),
      ...(draft.keywords ? { keywords: draft.keywords } : {}),
      ...(draft.errorCodes ? { error_codes: draft.errorCodes } : {}),
      ...(draft.alertname ? { alertname: draft.alertname } : {}),
      ...(force ? { force: true } : {}),
    };
    const raw = await this.mcp.callDirect(this.server, "save_lesson", args, task);
    const data = parseJson(raw) as Record<string, unknown> | undefined;
    // 编号要是正的安全整数：超出范围的在解析 JSON 时已经被四舍五入，记下来以后归档会指到别的经验
    const savedId = lessonId(data?.id);
    if (data?.saved === true && savedId !== undefined) {
      this.logger.info(`aiops 经验库 保存 经验 #${savedId}「${draft.title}」（团队经验库 ${teamId}） 确认人=${confirmedBy}`);
      return { saved: true, id: savedId };
    }
    const duplicate = data?.duplicate_of as Record<string, unknown> | undefined;
    const duplicateId = lessonId(duplicate?.id);
    if (data?.saved === false && duplicate && duplicateId !== undefined) {
      return {
        saved: false,
        duplicate: { id: duplicateId, title: String(duplicate.title ?? ""), ...(typeof duplicate.why === "string" ? { why: duplicate.why } : {}) },
      };
    }
    throw new KnowledgeError(`aiops 没有说存没存成功：${raw.slice(0, 300)}`);
  }

  /**
   * 团队经验库里这一条之前同步到 aiops 的经验和当时发过去的内容，看排查过程末尾的出处；没有时返回 undefined。
   * aiops 不能按出处查，只能检索：用当时发过去的内容查（表格后来改过也不影响），带上服务名和关键词让那一条排在前面，不按分数筛
   */
  async findSynced(sent: readonly KnowledgeDraft[], teamId: string, task: McpTaskContext): Promise<{ id: number; draft: KnowledgeDraft } | undefined> {
    for (const draft of sent) {
      const hits = await this.query(
        {
          text: `${draft.title}\n${draft.question}`.slice(0, QUERY_CHARS),
          ...(draft.scope ? { service: draft.scope } : {}),
          ...(draft.keywords ? { keywords: draft.keywords } : {}),
          ...(draft.alertname ? { alertname: draft.alertname } : {}),
        },
        task,
      );
      const found = hits.find((hit) => syncedFrom(hit.diagnosis_path, teamId));
      if (found) {
        return { id: found.id, draft };
      }
    }
    return undefined;
  }

  /**
   * 归档团队经验库里一条经验同步过去的那条。编号是从表格里读的，有编辑权限的人能改成别的：先取出来看排查过程末尾的出处，
   * 不是从这一条同步过去的不归档
   */
  async archiveSynced(id: number, teamId: string, confirmedBy: string, task: McpTaskContext): Promise<void> {
    const lesson = await this.get(id, task);
    if (!syncedFrom(lesson.diagnosis_path, teamId)) {
      throw new KnowledgeError(
        `它不是从 ${teamId} 同步过去的（排查过程末尾没有注明「来自飞书团队经验库 ${teamId}」），可能有人在表格里改了 ${teamId} 的 aiops 编号。请在表格里改正后再点「再试一次」`,
      );
    }
    if (lesson.status !== "active") {
      this.logger.info(`aiops 经验库 经验 #${id} 已经是归档的`);
      return;
    }
    await this.archive(id, confirmedBy, task);
  }

  /** 归档。archive_lesson 只改有效的，对已经归档的报错：报错时看一下，已经归档了（比如上次归档成功、结果没传回来）就算成功 */
  async archive(id: number, confirmedBy: string, task: McpTaskContext): Promise<void> {
    try {
      await this.mcp.callDirect(this.server, "archive_lesson", { id }, task);
    } catch (err) {
      const lesson = await this.get(id, task).catch(() => undefined);
      if (!lesson || lesson.status === "active") {
        throw err;
      }
      this.logger.info(`aiops 经验库 经验 #${id} 已经是归档的`);
      return;
    }
    this.logger.info(`aiops 经验库 归档 经验 #${id} 确认人=${confirmedBy}`);
  }
}

/** aiops 的经验编号：正的安全整数，别的（小数、负数、超出范围被四舍五入过的）不认 */
function lessonId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 同步到 aiops 的经验在排查过程末尾注明的出处 */
function teamSourceNote(teamId: string): string {
  return `（来自飞书团队经验库 ${teamId}）`;
}

/**
 * aiops 里这条经验是不是从团队经验库的这一条同步过去的：排查过程的最后一行正好是出处。
 * 只是在中间引用了别的经验出处的（排查过程里贴了另一条经验）不算
 */
function syncedFrom(diagnosisPath: string | undefined, teamId: string): boolean {
  return diagnosisPath?.trimEnd().split(/\r?\n/).at(-1)?.trim() === teamSourceNote(teamId);
}

/** 写进系统提示词的「aiops 经验库里可能相关的经验」 */
export function renderAiopsHitsForPrompt(hits: readonly AiopsLessonHit[]): string {
  return hits
    .map((hit) => {
      // 根因和处理办法放前面，每一项限长：现象写得很长时也不会把结论挤出去
      const text = [
        `aiops 经验 #${hit.id}：${hit.title}`,
        ...(
          [
            ["根因", hit.root_cause],
            ["处理办法", hit.solution],
            ["现象", hit.symptom],
            ["排查过程", hit.diagnosis_path],
          ] as [string, string | undefined][]
        )
          .filter((pair): pair is [string, string] => Boolean(pair[1]))
          .map(
            ([name, value]) =>
              `- ${name}：${value.length > PROMPT_FIELD_CHARS ? `${value.slice(0, PROMPT_FIELD_CHARS)}…（这一项后面省略，要看全文用 aiops_get_knowledge）` : value}`,
          ),
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
