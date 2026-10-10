import type { Logger } from "./history.js";
import { findSensitive, type KnowledgeDraft, KnowledgeError, MAX_TITLE_CHARS, normalizeId, StaleProposalError } from "./knowledge.js";
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
/** aiops 说重复时那一条的原因最多留多少字（标题按起草时的上限） */
const DUPLICATE_WHY_CHARS = 300;

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
  /** 告警匹配用的错误码、告警名。get_knowledge 返回了这一项（空的也算）才有，没返回时是 undefined */
  error_codes?: string;
  alertname?: string;
}

export type AiopsSaveResult = { saved: true; id: number } | { saved: false; duplicate: { id: number; title: string; why?: string } };

/** 发给 save_lesson 的一次：内容，和排查过程末尾注明的出处（当时这一行在团队经验库里的编号） */
export interface AiopsSent {
  draft: KnowledgeDraft;
  teamId: string;
}

/** 找回来的之前同步过去的那条：aiops 里的编号、按什么内容存的、出处注明的是哪个编号 */
export interface AiopsSynced {
  id: number;
  draft: KnowledgeDraft;
  teamId: string;
}

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

  /**
   * 按提问原文检索，返回够相近的（aiops 最多给 5 条，只看有效的）。aiops 里的经验别处（告警自动排查、Open WebUI）也能存，
   * 不经过团队经验库起草时的检查：像是写进了密钥或个人信息（手机号、身份证号）的不返回，不给模型看，群里也就看不到
   */
  async search(text: string, task: McpTaskContext, signal?: AbortSignal): Promise<AiopsLessonHit[]> {
    const query = text.trim().slice(0, QUERY_CHARS);
    if (!query || !this.searchable) {
      return [];
    }
    return (await this.query({ text: query }, task, signal)).filter((hit) => {
      if (hit.score < MIN_PROMPT_SCORE) {
        return false;
      }
      const sensitive = lessonSensitive(hit);
      if (sensitive) {
        this.logger.warn(`aiops 经验 #${hit.id} 里像是写进了${sensitive}，这次不给模型看。请 aiops 的管理员删掉这部分内容`);
        return false;
      }
      return true;
    });
  }

  /** 调 search_knowledge，返回 aiops 给的全部命中（最多 5 条，只有有效的） */
  private async query(args: Record<string, unknown>, task: McpTaskContext, signal?: AbortSignal): Promise<AiopsLessonHit[]> {
    const raw = await this.mcp.callDirect(this.server, "search_knowledge", args, task, signal);
    const data = parseJson(raw) as { hits?: unknown } | undefined;
    // 格式不对不能当成没查到：回答前的检索要算没查成，再试同步时要算没找成（不然会再存一条）
    if (!Array.isArray(data?.hits)) {
      throw new KnowledgeError(`aiops 检索返回的格式不对：${excerpt(raw, 200)}`);
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
      throw new KnowledgeError(`aiops 经验库里取不到经验 #${id}：${excerpt(raw, 200)}`);
    }
    if (item.id !== undefined && lessonId(item.id) !== id) {
      throw new KnowledgeError(`aiops 取经验 #${id} 时返回的是别的编号：${excerpt(raw, 200)}`);
    }
    return {
      id,
      title: item.title,
      status: typeof item.status === "string" ? item.status : "active",
      ...pickStrings(item, ["service", "symptom", "root_cause", "solution", "diagnosis_path", "keywords"]),
      // 空的也留着：和「没返回这一项」分开，在 aiops 里清空了也认得出改过
      ...Object.fromEntries(MATCH_FIELDS.flatMap((key) => (typeof item[key] === "string" ? [[key, item[key]]] : []))),
    };
  }

  /** 把一条排查经验写进 aiops。aiops 说和已有的很像时不存，返回那一条；force 时不查重 */
  async save(
    draft: KnowledgeDraft,
    { confirmedBy, caseId, teamId, force }: { confirmedBy: string; caseId?: number; teamId: string; force?: boolean },
    task: McpTaskContext,
  ): Promise<AiopsSaveResult> {
    const args: Record<string, unknown> = {
      ...lessonContent(draft, teamId),
      source: caseId === undefined ? "chat" : "case",
      created_by: `feishu:${confirmedBy}`,
      ...(caseId === undefined ? {} : { case_id: caseId }),
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
      // 那一条可能是别的地方（Open WebUI）存的、写进了密钥或个人信息：标题、原因要列在卡片上给群里看，像有这些的不要。
      // 也可能很长：只留开头（先查密钥再截，截断处不会把密钥切成认不出的两半），卡片太大飞书不收，就一直停在「正在存进经验库…」
      const title = String(duplicate.title ?? "");
      const leaked = findSensitive(title);
      if (leaked) {
        this.logger.warn(`aiops 经验 #${duplicateId} 的标题里像是写进了${leaked}，卡片上不列它的标题。请 aiops 的管理员删掉这部分内容`);
      }
      const why = typeof duplicate.why === "string" && !findSensitive(duplicate.why) ? duplicate.why : undefined;
      return {
        saved: false,
        duplicate: { id: duplicateId, title: leaked ? "" : clip(title, MAX_TITLE_CHARS), ...(why !== undefined ? { why: clip(why, DUPLICATE_WHY_CHARS) } : {}) },
      };
    }
    throw new KnowledgeError(`aiops 没有说存没存成功：${excerpt(raw, 300)}`);
  }

  /**
   * 团队经验库里这一条之前同步到 aiops 的经验和当时发过去的内容，看排查过程末尾的出处；没有时返回 undefined。teamId 是这一行现在的编号，
   * 出处也可能是发过去那次的编号（之后表格里改了编号）。
   * aiops 不能按出处查，只能检索：用当时发过去的内容查（表格后来改过也不影响），带上服务名和关键词让那一条排在前面，不按分数筛。
   * 找到的那条之后可能在 aiops 里被改过：和 ownDuplicate 一样取出全文对一遍
   */
  async findSynced(sent: readonly AiopsSent[], teamId: string, task: McpTaskContext): Promise<AiopsSynced | undefined> {
    const teamIds = [teamId, ...sent.map((one) => one.teamId)];
    for (const { draft } of sent) {
      const hits = await this.query(
        {
          text: `${draft.title}\n${draft.question}`.slice(0, QUERY_CHARS),
          ...(draft.scope ? { service: draft.scope } : {}),
          ...(draft.keywords ? { keywords: draft.keywords } : {}),
          ...(draft.alertname ? { alertname: draft.alertname } : {}),
        },
        task,
      );
      for (const hit of hits.filter((hit) => teamIds.some((id) => syncedFrom(hit.diagnosis_path, id)))) {
        const own = await this.ownDuplicate(hit.id, sent, teamId, task);
        if (own) {
          return own;
        }
      }
    }
    return undefined;
  }

  /**
   * aiops 里的经验 #id 是不是团队经验库这一条之前同步过去、还有效的（排查过程最后一行是出处）：findSynced 检索到的，
   * 或者 aiops 说和它重复的（上次存进去了、结果没传回来，检索又没排到它）。是的话返回它和发过去的内容里对得上的那份。
   * 出处是发过去那次的编号、内容也一样的就是那次存的（之后表格里改了编号也认得出）；内容都对不上的（在 aiops 里改过），
   * 只认出处是这一行现在编号（teamId）的，按 aiops 里存的内容算，和表格里的不一样时会归档它、按表格重新同步：
   * 以前的编号可能已经被别的行用了，光凭出处认不出是不是这一条的。不是的返回 undefined
   */
  async ownDuplicate(id: number, sent: readonly AiopsSent[], teamId: string, task: McpTaskContext): Promise<AiopsSynced | undefined> {
    const lesson = await this.get(id, task);
    if (lesson.status !== "active") {
      return undefined;
    }
    const match = sent.find((one) => syncedFrom(lesson.diagnosis_path, one.teamId) && sameLesson(lesson, lessonContent(one.draft, one.teamId)));
    if (match) {
      return { id, draft: match.draft, teamId: match.teamId };
    }
    if (!syncedFrom(lesson.diagnosis_path, teamId)) {
      return undefined;
    }
    const stored = (key: LessonField) => (lesson[key] ?? "").trim();
    const basis = stored("diagnosis_path").split(/\r?\n/).slice(0, -1).join("\n").trim();
    return {
      id,
      draft: {
        category: "incident",
        title: lesson.title,
        question: stored("symptom"),
        conclusion: stored("root_cause"),
        ...(lesson.service ? { scope: lesson.service } : {}),
        ...(lesson.solution ? { handling: lesson.solution } : {}),
        ...(basis ? { basis } : {}),
        ...(lesson.keywords ? { keywords: lesson.keywords } : {}),
        ...(lesson.error_codes?.trim() ? { errorCodes: lesson.error_codes.trim() } : {}),
        ...(lesson.alertname?.trim() ? { alertname: lesson.alertname.trim() } : {}),
      },
      teamId,
    };
  }

  /**
   * 归档团队经验库里一条经验同步过去的那条。编号是从表格里读的，有编辑权限的人能改成别的：先取出来看排查过程末尾的出处，
   * 不是从这一条同步过去的不归档。teamIds 是这一条现在的编号，以及卡片上的编号（卡片发出后这一行的编号被改了，出处还是原来的）
   */
  async archiveSynced(id: number, teamIds: readonly string[], confirmedBy: string, task: McpTaskContext): Promise<void> {
    const lesson = await this.get(id, task);
    const teamId = teamIds[0];
    if (!teamIds.some((candidate) => syncedFrom(lesson.diagnosis_path, candidate))) {
      const source = sourceId(lesson.diagnosis_path);
      // 出处是别的编号：可能是 aiops 编号填错了，也可能是这一行同步以后在表格里改过编号（出处还是同步时的编号，分不出是哪种）
      throw new KnowledgeError(
        source
          ? `它的出处是 ${source}，不是 ${teamId}（排查过程末尾注明的是「来自飞书团队经验库 ${source}」）。可能有人在表格里改了 ${teamId} 的 aiops 编号，请改正后再点「再试一次」；如果是同步以后在表格里把 ${source} 的编号改成了 ${teamId}，请点「不用了」，再让机器人起草归档 aiops 经验 #${id}`
          : `它不是从 ${teamId} 同步过去的（排查过程末尾没有注明「来自飞书团队经验库 ${teamId}」），可能有人在表格里改了 ${teamId} 的 aiops 编号。请在表格里改正后再点「再试一次」`,
      );
    }
    if (lesson.status !== "active") {
      this.logger.info(`aiops 经验库 经验 #${id} 已经是归档的`);
      return;
    }
    await this.archive(id, confirmedBy, task);
  }

  /**
   * 归档卡片上的那条：先取出来和卡片上的核对，卡片发出后在 aiops 里改过的不归档（卡片作废）。
   * 已经归档了的（上次归档成功、结果没传回来，或者别人归档了）算成功
   */
  async archiveSeen(seen: AiopsLesson, confirmedBy: string, task: McpTaskContext): Promise<void> {
    const current = await this.get(seen.id, task);
    if (current.status !== "active") {
      this.logger.info(`aiops 经验库 经验 #${seen.id} 已经是归档的`);
      return;
    }
    if (!sameLesson(current, seen)) {
      throw new StaleProposalError(`aiops 经验 #${seen.id} 在卡片发出后改过，卡片上的已经不是现在这条，这张卡片不能再用。需要的话请按现在的内容重新起草`);
    }
    await this.archive(seen.id, confirmedBy, task);
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

/** 存进 aiops 的内容里 get_knowledge 也会返回的几项：认上次存进去的是哪一份、卡片发出后改没改过时比这些 */
const LESSON_FIELDS = ["title", "symptom", "root_cause", "solution", "service", "diagnosis_path", "keywords", "error_codes", "alertname"] as const;
type LessonField = (typeof LESSON_FIELDS)[number];
/** 告警匹配用的两项：get_knowledge 没返回这一项时（不知道存的是什么）不比，别的项照样比 */
const MATCH_FIELDS = ["error_codes", "alertname"] as const;

/** aiops 里存的这条和 content（发过去的内容，或者卡片上那时的这条）是不是一样 */
function sameLesson(lesson: AiopsLesson, content: Partial<Record<LessonField, string>>): boolean {
  return LESSON_FIELDS.every(
    (key) => ((MATCH_FIELDS as readonly string[]).includes(key) && lesson[key] === undefined) || (lesson[key] ?? "").trim() === (content[key] ?? "").trim(),
  );
}

/** 一条团队经验存进 aiops 时各项的内容 */
function lessonContent(draft: KnowledgeDraft, teamId: string): Partial<Record<LessonField, string>> & { title: string } {
  return {
    title: draft.title,
    root_cause: draft.conclusion,
    symptom: draft.question,
    // 排查过程末尾注明出自团队经验库，aiops 里看到的人知道去哪改，再试一次时也靠它认出已经存过的
    diagnosis_path: [draft.basis, teamSourceNote(teamId)].filter(Boolean).join("\n"),
    ...(draft.scope ? { service: draft.scope } : {}),
    ...(draft.handling ? { solution: draft.handling } : {}),
    ...(draft.keywords ? { keywords: draft.keywords } : {}),
    ...(draft.errorCodes ? { error_codes: draft.errorCodes } : {}),
    ...(draft.alertname ? { alertname: draft.alertname } : {}),
  };
}

/**
 * aiops 里这条经验的标题、现象、根因、处理办法、排查过程这些里像是有密钥还是个人信息（手机号、身份证号）；都没有时返回 undefined。
 * 别处存的经验没经过起草时的检查，给模型看、列在卡片上之前和团队经验库的草稿一样查
 */
export function lessonSensitive(lesson: AiopsLessonHit | AiopsLesson): string | undefined {
  // 检索结果里没有服务名、关键词
  const { title, symptom, root_cause, solution, diagnosis_path, service, keywords, error_codes, alertname }: Partial<AiopsLesson> = lesson;
  for (const value of [title, symptom, root_cause, solution, diagnosis_path, service, keywords, error_codes, alertname]) {
    const sensitive = value === undefined ? undefined : findSensitive(value);
    if (sensitive) {
      return sensitive;
    }
  }
  return undefined;
}

/** 别处来的一段文字放进卡片：换行和连续空白并成一个空格，超过 chars 字的截掉 */
export function clip(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > chars ? `${flat.slice(0, chars)}…` : flat;
}

/** 报错里带上 aiops 返回的原文（前 chars 个字符）：报错会列在卡片上给群里看，原文里像有密钥或个人信息的不带 */
function excerpt(raw: string, chars: number): string {
  return findSensitive(raw) ? "（返回的内容里像是有密钥或个人信息，不列出来）" : raw.slice(0, chars);
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
export function syncedFrom(diagnosisPath: string | undefined, teamId: string): boolean {
  const id = sourceId(diagnosisPath);
  // 编号按团队经验库里的规则比（表格里把 K1 改成 k1、#K1、K 1 还是同一条）
  return id !== undefined && normalizeId(id) === normalizeId(teamId);
}

/** 排查过程最后一行注明的出处里的团队经验编号；最后一行不是出处时返回 undefined */
function sourceId(diagnosisPath: string | undefined): string | undefined {
  const last = diagnosisPath?.trimEnd().split(/\r?\n/).at(-1)?.trim() ?? "";
  return /^（来自飞书团队经验库 ([^）]+)）$/.exec(last)?.[1];
}

/**
 * 写进系统提示词的「aiops 经验库里可能相关的经验」。省略处不写用哪个工具看全文：模型不一定有 aiops_get_knowledge（MCP_AIOPS_TOOLS 可以不开），
 * 有的时候提示词里另外说
 */
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
              `- ${name}：${value.length > PROMPT_FIELD_CHARS ? `${value.slice(0, PROMPT_FIELD_CHARS)}…（这一项后面省略）` : value}`,
          ),
      ].join("\n");
      return text.length > PROMPT_HIT_CHARS ? `${text.slice(0, PROMPT_HIT_CHARS)}…（后面省略）` : text;
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
