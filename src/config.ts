import path from "node:path";
import { fileURLToPath } from "node:url";
import { Domain } from "@larksuiteoapi/node-sdk";
import { type BitableTarget, parseBitableUrl } from "./knowledge-bitable.js";
import type { LlmConfig } from "./llm.js";

export interface Config {
  feishu: {
    appId: string;
    appSecret: string;
    domain: Domain;
    /** 群白名单（chat_id）。为空时不响应任何群。 */
    allowedChatIds: ReadonlySet<string>;
    /** 能让机器人改文档、改代码的人（open_id）。不配时群里所有人都能 */
    writeAllowedUsers?: ReadonlySet<string>;
  };
  llm: LlmConfig;
  /** 群记忆的存放目录（每个群一个 JSON 文件） */
  memoryDir: string;
  /** 补漏轮询的间隔，0 表示不轮询 */
  catchUpIntervalMs: number;
  /** 补漏报警发到哪个群；不填就发到漏了消息的那个群 */
  alertChatId?: string;
  /** 群记忆每日备份的存放目录（每天一个子目录） */
  memoryBackupDir: string;
  /** 群记忆备份保留几天，0 表示不备份 */
  memoryBackupDays: number;
  /** 看图片用的模型（和主模型同一个服务、同一个 Key）。关掉，或者模型服务不是百炼又没配 MODEL_VISION_ID 时为空 */
  vision?: {
    model: string;
    /** 用百炼时关掉思考：抄图片里的文字用不着想，开着只会更慢 */
    thinking?: false;
  };
  /** 联网搜索：百炼原生接口地址和搜索用的模型。关掉或模型服务不是百炼时为空 */
  webSearch?: { url: string; model: string };
  /** 代码仓库：没配 CODE_REPOS 时为空 */
  code?: {
    /** 允许操作的仓库：GitLab 的项目路径（group/project），或 GitHub 的 owner/repo */
    repos: string[];
    /** 给仓库指定的默认分支（CODE_REPOS 里写成 group/project@分支），没点名分支时先看它 */
    branches: Record<string, string>;
    host: { kind: "gitlab"; url: string; token: string } | { kind: "github"; token: string };
    /** 拉代码的工作目录（每个话题一个子目录） */
    workspaceDir: string;
    /** 推代码之前在服务器上编译检查（BUILD_CHECK，默认 on）：Go 用 go build，PHP 用 php -l；没装工具的跳过 */
    build: boolean;
    /** 编译时 go 下载依赖用的代理（BUILD_GOPROXY），不配用 goproxy.cn */
    goproxy?: string;
  };
  /** 通过 MCP 接入的服务（MCP_SERVERS），没配时为空数组 */
  mcp: McpServerConfig[];
  /** 团队经验库（飞书多维表格）。KNOWLEDGE=off 时为空 */
  knowledge?: {
    /** KNOWLEDGE_BITABLE 指定的表。不填时第一次保存经验时机器人自己建一张 */
    bitable?: BitableTarget;
    /** 机器人自己建的表记在这个文件里，重启后接着用 */
    stateFile: string;
    /** 按意思检索用的向量模型（和主模型同一个服务、同一个 Key）。关掉，或者模型服务不是百炼又没配时为空，只按关键词检索 */
    embeddingModel?: string;
  };
  /** 进度卡片上显示模型每轮的思考（SHOW_THINKING，默认 on） */
  showThinking: boolean;
  /** 卡片即回答（STREAM_CARD，默认 on）：思考和回答边生成边写进进度卡片，回答不再另外发 */
  streamCard: boolean;
  /** 话题里跟聊（FOLLOW_THREADS，默认 on）：机器人回答过的话题里，追问不用再 @ */
  followThreads: boolean;
  /** 跟着哪些话题、哪些话题说过「只在 @ 我时回」记在这个文件里，重启后接着用 */
  followStateFile: string;
  /** 带上群里刚才的聊天（CHAT_CONTEXT，默认 on）：在群里直接 @ 时，把这之前半小时内的群聊一起给模型 */
  chatContext: boolean;
  /** 主动接话（PROACTIVE_CHAT_IDS，默认没有群）：这些群里没 @ 的群消息，机器人看情况接一句 */
  proactive: {
    /** 打开了主动接话的群（只算群白名单里的） */
    chatIds: ReadonlySet<string>;
    /** PROACTIVE_CHAT_IDS 里不在群白名单的，不生效，启动时日志里提醒 */
    ignored: string[];
    /** 每个群每小时最多主动回几次（PROACTIVE_MAX_PER_HOUR，默认 3） */
    maxPerHour: number;
    /** 群里说「别主动插话」后记在这个文件里，重启后照样停着 */
    stateFile: string;
  };
  /** 定时任务（SCHEDULED_TASKS，默认 on）：群里 @ 机器人建，到点在原来的群里跑。关掉时为空 */
  schedules?: {
    /** 定时任务记在这个文件里，重启后接着跑 */
    file: string;
  };
  /** 卡片即回答时记下卡片里的回答的目录（每个群一个 JSON 文件），读话题历史时用 */
  cardAnswersDir: string;
  /** 按群记下最近几个话题的问答的目录（每个群一个 JSON 文件），chat_recent_threads 用 */
  recentThreadsDir: string;
  /** 产品功能说明的链接（ANNOUNCE_LINK）：通知卡片上的按钮用，有人问「你能做什么」时回答里也附上。更新通知关掉时也有 */
  featuresLink?: string;
  /** 文档中心的链接（DOCS_LINK）：通知卡片上「文档中心」按钮用。更新通知关掉时也有 */
  docsLink?: string;
  /** 更新通知（ANNOUNCE，默认 on）：部署新版本后把产品更新说明 RELEASE_NOTES.md 里新版本的说明发到群里。关掉时为空 */
  announce?: {
    /** 发到这些群：ANNOUNCE_CHAT_IDS，不填就是白名单里的所有群 */
    chatIds: string[];
    /** chatIds 是从哪个配置来的，启动日志里写明 */
    chatIdsFrom: "ANNOUNCE_CHAT_IDS" | "FEISHU_ALLOWED_CHAT_IDS";
    /** 通知卡片上「产品功能说明」按钮的链接（ANNOUNCE_LINK） */
    link?: string;
    /** 通知卡片上「文档中心」按钮的链接（DOCS_LINK） */
    docsLink?: string;
    /** 每个群发到哪一版记在这个文件里 */
    stateFile: string;
    /** 发到群里的产品更新说明 */
    notesFile: string;
    /** 技术版更新日志，同一版本的内容折叠放在卡片的「技术说明」里 */
    changelogFile: string;
  };
}

export interface McpServerConfig {
  /** 服务名，也是交给模型的工具名前缀，如 aiops → aiops_diagnose_service */
  name: string;
  /** Streamable HTTP 地址 */
  url: string;
  /** 用 Authorization: Bearer 头发送，不拼进地址 */
  token?: string;
  /** 开哪些工具（服务端的工具名）；"*" 表示服务端的全部工具。会写东西的工具这一版一律不开 */
  tools: readonly string[] | "*";
  /** 额外算作「会写东西」的工具。名字里带 create、save、delete 这类动词的不用列，程序自己认 */
  writeTools: readonly string[];
  /** 这个服务的使用说明文件，开了它的工具时写进系统提示词；文件不存在就不写 */
  promptFile: string;
  /** 单独指定超时的工具（毫秒），其余用默认的 60 秒 */
  timeoutsMs: Readonly<Record<string, number>>;
  /** 进度卡片上的步骤名，如 diagnose_service → 诊断；没列的显示工具原名 */
  labels: Readonly<Record<string, string>>;
  /** 调过这个服务的工具（包括读剧本）以后，这次任务后面几轮打开思考（MCP_<名字>_THINKING，默认 on） */
  thinking: boolean;
}

/** 阿里云百炼 OpenAI 兼容接口（华北2 北京）。百炼建议换成业务空间专属域名，见 README。 */
export const DEFAULT_MODEL_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DEFAULT_MODEL_ID = "qwen3.8-max";
/** 团队经验库按意思检索用的百炼向量模型 */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-v4";
/** 用百炼时，打开思考后最多思考多少 token */
export const DEFAULT_THINKING_BUDGET = 4000;
/** 数据目录，相对路径按启动时的工作目录算 */
export const DEFAULT_DATA_DIR = "data";
/** 每个群每小时最多主动接几次话（PROACTIVE_MAX_PER_HOUR 不填时） */
export const DEFAULT_PROACTIVE_MAX_PER_HOUR = 3;
/** 补漏轮询默认每 10 秒一次 */
export const DEFAULT_CATCHUP_INTERVAL_SECONDS = 10;
/** 群记忆备份默认保留 14 天 */
export const DEFAULT_MEMORY_BACKUP_DAYS = 14;

/**
 * aiops 第一批开放的只读工具（阶段 3.5 方案第 4 条）。服务端新加的工具要在 MCP_AIOPS_TOOLS 里点名才开。
 * 先不开：get_log_labels（和 get_label_values 重复）、get_targets_health（采集目标体检）、两个资源配额工具（diagnose_service 里已经在用）、
 * 两个 Grafana 工具（只返回面板名称和链接）；会写东西的 save_lesson、archive_lesson、create_annotation 不给模型：
 * 沉淀和归档经验由模型起草、群成员在确认卡片上点了以后程序去调（tools/knowledge.ts），create_annotation 暂时不接。
 * promote_case 只读出案例、生成草稿，不写东西，给模型用来起草
 */
export const AIOPS_DEFAULT_TOOLS = [
  "diagnose_service",
  "find_service",
  "list_namespaces",
  "list_pods",
  "describe_pod",
  "get_pod_logs",
  "get_events",
  "list_deployments",
  "query_logs",
  "get_label_values",
  "query_metrics",
  "query_metrics_range",
  "get_service_metrics",
  "get_active_alerts",
  "search_traces",
  "get_trace",
  "search_knowledge",
  "get_case",
  "get_knowledge",
  "promote_case",
] as const;

/** 已知 MCP 服务的默认配置。别的服务要在 MCP_<名字>_TOOLS 里写明开哪些工具 */
const MCP_SERVER_DEFAULTS: Record<string, Pick<McpServerConfig, "tools" | "writeTools" | "timeoutsMs" | "labels">> = {
  aiops: {
    tools: AIOPS_DEFAULT_TOOLS,
    // 写工具名字里都带动词（save、archive、create），程序自己认
    writeTools: [],
    // 服务端 diagnose_service 最长跑 90 秒，其余工具 30 秒
    timeoutsMs: { diagnose_service: 120_000 },
    labels: {
      diagnose_service: "诊断",
      find_service: "定位服务",
      list_namespaces: "列出命名空间",
      list_pods: "查看 Pod",
      describe_pod: "查看 Pod 详情",
      get_pod_logs: "查看 Pod 日志",
      get_events: "查看 K8s 事件",
      list_deployments: "查看 Deployment",
      query_logs: "查日志",
      get_label_values: "查日志标签",
      query_metrics: "查指标",
      query_metrics_range: "查指标趋势",
      get_service_metrics: "查服务有哪些指标",
      get_active_alerts: "查活跃告警",
      search_traces: "搜链路",
      get_trace: "查看链路",
      search_knowledge: "查知识库",
      get_case: "查看案例",
      get_knowledge: "查看经验",
      promote_case: "案例转经验草稿",
    },
  },
};

/** 内置工具名的前缀（code_read_file、memory_save 等），MCP 服务不能用这些名字 */
const RESERVED_MCP_NAMES = new Set(["code", "memory", "feishu", "web", "fetch", "knowledge"]);
/** 地址里像令牌的参数名：t（aiops 的写法），或者按 _ - . 和大小写拆开后有一段像密钥，如 api_key、X-Amz-Signature、authToken */
const SECRET_PARAM_PARTS = /^(token|secret|key|apikey|auth|authorization|password|passwd|pwd|sig|signature|credential|credentials|session|jwt|bearer)$/;

function isSecretParam(param: string): boolean {
  const parts = param.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_.-]+/);
  return param === "t" || parts.some((part) => SECRET_PARAM_PARTS.test(part));
}

/** 使用说明文件默认放在项目的 prompts/mcp/<服务名>.md（src 和 dist 都在项目根目录下一层） */
const PROMPTS_DIR = fileURLToPath(new URL("../prompts/mcp/", import.meta.url));
/** 产品更新说明在项目根目录，部署时跟着 git pull 更新 */
export const RELEASE_NOTES_FILE = fileURLToPath(new URL("../RELEASE_NOTES.md", import.meta.url));
/** 技术版更新日志，同一版本的内容折叠放在通知卡片的「技术说明」里 */
export const CHANGELOG_FILE = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
/** 产品功能清单：有人问「你能做什么」时回的功能卡片就按它画 */
export const FEATURES_FILE = fileURLToPath(new URL("../FEATURES.md", import.meta.url));

/** 从环境变量读取配置。密钥只从环境变量来，不写进代码和仓库。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "MODEL_API_KEY"].filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`缺少环境变量：${missing.join(", ")}。请参考 .env.example 配置 .env`);
  }

  const catchUpSeconds = Number(env.CATCHUP_INTERVAL_SECONDS || DEFAULT_CATCHUP_INTERVAL_SECONDS);
  if (!Number.isFinite(catchUpSeconds) || catchUpSeconds < 0 || (catchUpSeconds > 0 && catchUpSeconds < 2)) {
    throw new Error(`CATCHUP_INTERVAL_SECONDS 要么是 0（不轮询），要么不小于 2，当前为 ${env.CATCHUP_INTERVAL_SECONDS}`);
  }

  const backupDays = Number(env.MEMORY_BACKUP_DAYS || DEFAULT_MEMORY_BACKUP_DAYS);
  if (!Number.isInteger(backupDays) || backupDays < 0) {
    throw new Error(`MEMORY_BACKUP_DAYS 要填不小于 0 的整数（0 表示不备份），当前为 ${env.MEMORY_BACKUP_DAYS}`);
  }

  const webSearch = (env.WEB_SEARCH || "on").toLowerCase();
  if (webSearch !== "on" && webSearch !== "off") {
    throw new Error(`WEB_SEARCH 只能是 on 或 off，当前为 ${env.WEB_SEARCH}`);
  }
  const baseURL = env.MODEL_BASE_URL || DEFAULT_MODEL_BASE_URL;
  const model = env.MODEL_ID || DEFAULT_MODEL_ID;
  const searchUrl = webSearch === "on" ? bailianGenerationUrl(baseURL) : undefined;
  // 看图：主模型能看图时（千问 3.5 以后、VL、Omni），百炼上默认用主模型看图；别的（Kimi、GLM，或 qwen-plus、qwen3-max 这类纯文本千问）
  // 用千问旗舰。别家服务要自己在 MODEL_VISION_ID 里写能看图的模型
  const visionEnv = env.MODEL_VISION_ID?.trim();
  const visionModel =
    visionEnv?.toLowerCase() === "off"
      ? undefined
      : visionEnv || (isBailian(baseURL) ? (isMultimodalQwen(model) ? model : DEFAULT_MODEL_ID) : undefined);

  // 百炼默认关掉思考：同样的回答快一半左右。别家服务不传，用它的默认值
  const thinkingEnv = env.MODEL_THINKING?.trim().toLowerCase();
  if (thinkingEnv && thinkingEnv !== "on" && thinkingEnv !== "off") {
    throw new Error(`MODEL_THINKING 只能是 on 或 off，当前为 ${env.MODEL_THINKING}`);
  }
  const thinking = thinkingEnv ? thinkingEnv === "on" : isBailian(baseURL) ? false : undefined;
  // 打开思考时限制思考长度，免得一个问题想好几分钟。百炼默认 4000 token（按每秒 30～40 个约 2 分钟），0 表示不限
  const budgetEnv = env.MODEL_THINKING_BUDGET?.trim();
  const budget = budgetEnv ? Number(budgetEnv) : isBailian(baseURL) ? DEFAULT_THINKING_BUDGET : 0;
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error(`MODEL_THINKING_BUDGET 要填不小于 0 的整数（0 表示不限），当前为 ${env.MODEL_THINKING_BUDGET}`);
  }

  const showThinking = (env.SHOW_THINKING?.trim() || "on").toLowerCase();
  if (showThinking !== "on" && showThinking !== "off") {
    throw new Error(`SHOW_THINKING 只能是 on 或 off，当前为 ${env.SHOW_THINKING}`);
  }

  const streamCard = (env.STREAM_CARD?.trim() || "on").toLowerCase();
  if (streamCard !== "on" && streamCard !== "off") {
    throw new Error(`STREAM_CARD 只能是 on 或 off，当前为 ${env.STREAM_CARD}`);
  }

  const followThreads = (env.FOLLOW_THREADS?.trim() || "on").toLowerCase();
  if (followThreads !== "on" && followThreads !== "off") {
    throw new Error(`FOLLOW_THREADS 只能是 on 或 off，当前为 ${env.FOLLOW_THREADS}`);
  }

  const chatContext = (env.CHAT_CONTEXT?.trim() || "on").toLowerCase();
  if (chatContext !== "on" && chatContext !== "off") {
    throw new Error(`CHAT_CONTEXT 只能是 on 或 off，当前为 ${env.CHAT_CONTEXT}`);
  }

  const schedules = (env.SCHEDULED_TASKS?.trim() || "on").toLowerCase();
  if (schedules !== "on" && schedules !== "off") {
    throw new Error(`SCHEDULED_TASKS 只能是 on 或 off，当前为 ${env.SCHEDULED_TASKS}`);
  }

  const proactiveMax = Number(env.PROACTIVE_MAX_PER_HOUR?.trim() || DEFAULT_PROACTIVE_MAX_PER_HOUR);
  if (!Number.isInteger(proactiveMax) || proactiveMax < 1 || proactiveMax > 60) {
    throw new Error(`PROACTIVE_MAX_PER_HOUR 要填 1～60 的整数，当前为 ${env.PROACTIVE_MAX_PER_HOUR}`);
  }

  const code = loadCodeConfig(env);
  const knowledgeEnv = env.KNOWLEDGE?.trim().toLowerCase();
  if (knowledgeEnv && !["on", "off"].includes(knowledgeEnv)) {
    throw new Error(`KNOWLEDGE 只能是 on 或 off，当前为 ${env.KNOWLEDGE}`);
  }
  const knowledgeOff = knowledgeEnv === "off";
  const writers = (env.WRITE_ALLOWED_USERS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const badWriter = writers.find((id) => !/^ou_[\w-]+$/.test(id));
  if (badWriter) {
    throw new Error(`WRITE_ALLOWED_USERS 要填飞书用户的 open_id（ou_ 开头），多个用逗号分隔，这一项不对：${badWriter}`);
  }

  const allowedChatIds = new Set((env.FEISHU_ALLOWED_CHAT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  const featuresLink = loadLink(env, "ANNOUNCE_LINK");
  const docsLink = loadLink(env, "DOCS_LINK");
  const announce = loadAnnounceConfig(env, allowedChatIds, featuresLink, docsLink);

  const domainName = (env.FEISHU_DOMAIN ?? "feishu").toLowerCase();
  if (domainName !== "feishu" && domainName !== "lark") {
    throw new Error(`FEISHU_DOMAIN 只能是 feishu 或 lark，当前为 ${env.FEISHU_DOMAIN}`);
  }

  const proactiveChatIds = [...new Set((env.PROACTIVE_CHAT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean))];

  return {
    feishu: {
      appId: env.FEISHU_APP_ID!,
      appSecret: env.FEISHU_APP_SECRET!,
      domain: domainName === "lark" ? Domain.Lark : Domain.Feishu,
      allowedChatIds,
      ...(writers.length > 0 ? { writeAllowedUsers: new Set(writers) } : {}),
    },
    llm: {
      baseURL,
      apiKey: env.MODEL_API_KEY!,
      model,
      ...(thinking !== undefined ? { thinking } : {}),
      ...(budget > 0 ? { thinkingBudget: budget } : {}),
    },
    memoryDir: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR, "memory"),
    catchUpIntervalMs: catchUpSeconds * 1000,
    alertChatId: env.ALERT_CHAT_ID?.trim() || undefined,
    memoryBackupDir: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR, "backup", "memory"),
    memoryBackupDays: backupDays,
    ...(visionModel ? { vision: { model: visionModel, ...(isBailian(baseURL) ? { thinking: false as const } : {}) } } : {}),
    // 百炼的联网搜索只有千问模型支持：主模型换成 Kimi、GLM、DeepSeek 等时，搜索仍用千问旗舰
    webSearch: searchUrl
      ? { url: searchUrl, model: env.WEB_SEARCH_MODEL || (/^qwen/i.test(model) ? model : DEFAULT_MODEL_ID) }
      : undefined,
    code: code && { ...code, workspaceDir: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR, "workspaces") },
    mcp: loadMcpConfig(env),
    showThinking: showThinking === "on",
    streamCard: streamCard === "on",
    followThreads: followThreads === "on",
    followStateFile: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR, "follow.json"),
    chatContext: chatContext === "on",
    proactive: {
      chatIds: new Set(proactiveChatIds.filter((id) => allowedChatIds.has(id))),
      ignored: proactiveChatIds.filter((id) => !allowedChatIds.has(id)),
      maxPerHour: proactiveMax,
      stateFile: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR, "proactive.json"),
    },
    ...(schedules === "on" ? { schedules: { file: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR, "schedules.json") } } : {}),
    cardAnswersDir: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR, "card-answers"),
    recentThreadsDir: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR, "recent-threads"),
    ...(knowledgeOff ? {} : { knowledge: loadKnowledgeConfig(env, baseURL) }),
    ...(featuresLink ? { featuresLink } : {}),
    ...(docsLink ? { docsLink } : {}),
    ...(announce ? { announce } : {}),
  };
}

/** ANNOUNCE_LINK（产品功能说明）、DOCS_LINK（文档中心）：要是 https 地址 */
function loadLink(env: NodeJS.ProcessEnv, name: "ANNOUNCE_LINK" | "DOCS_LINK"): string | undefined {
  const link = env[name]?.trim();
  if (!link) {
    return undefined;
  }
  let url: URL | undefined;
  try {
    url = new URL(link);
  } catch {
    url = undefined;
  }
  if (url?.protocol !== "https:") {
    throw new Error(`${name} 要写成 https://… 这样的完整地址，当前为 ${link}`);
  }
  return link;
}

/** ANNOUNCE=off 关掉；ANNOUNCE_CHAT_IDS 只能是白名单里的群 */
function loadAnnounceConfig(
  env: NodeJS.ProcessEnv,
  allowedChatIds: ReadonlySet<string>,
  link: string | undefined,
  docsLink: string | undefined,
): Config["announce"] {
  const switchEnv = (env.ANNOUNCE?.trim() || "on").toLowerCase();
  if (switchEnv !== "on" && switchEnv !== "off") {
    throw new Error(`ANNOUNCE 只能是 on 或 off，当前为 ${env.ANNOUNCE}`);
  }
  if (switchEnv === "off") {
    return undefined;
  }
  const listed = (env.ANNOUNCE_CHAT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const outside = listed.find((id) => !allowedChatIds.has(id));
  if (outside) {
    throw new Error(`ANNOUNCE_CHAT_IDS 里的群 ${outside} 不在 FEISHU_ALLOWED_CHAT_IDS 里：更新通知只发白名单里的群`);
  }
  return {
    chatIds: listed.length > 0 ? [...new Set(listed)] : [...allowedChatIds],
    chatIdsFrom: listed.length > 0 ? "ANNOUNCE_CHAT_IDS" : "FEISHU_ALLOWED_CHAT_IDS",
    ...(link ? { link } : {}),
    ...(docsLink ? { docsLink } : {}),
    stateFile: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR, "announce", "state.json"),
    notesFile: RELEASE_NOTES_FILE,
    changelogFile: CHANGELOG_FILE,
  };
}

/** KNOWLEDGE_BITABLE 是多维表格链接；KNOWLEDGE_EMBEDDING_MODEL 不配时百炼用 text-embedding-v4，off 表示只按关键词检索 */
function loadKnowledgeConfig(env: NodeJS.ProcessEnv, baseURL: string): NonNullable<Config["knowledge"]> {
  const bitable = env.KNOWLEDGE_BITABLE?.trim();
  const embeddingEnv = env.KNOWLEDGE_EMBEDDING_MODEL?.trim();
  const embeddingModel =
    embeddingEnv?.toLowerCase() === "off" ? undefined : embeddingEnv || (isBailian(baseURL) ? DEFAULT_EMBEDDING_MODEL : undefined);
  return {
    ...(bitable ? { bitable: parseBitableUrl(bitable) } : {}),
    stateFile: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR, "knowledge", "bitable.json"),
    ...(embeddingModel ? { embeddingModel } : {}),
  };
}

/** MCP_SERVERS=aiops=https://aiops.example.com/mcp,别的=…，每个服务的其他设置用 MCP_<名字>_ 开头的变量 */
function loadMcpConfig(env: NodeJS.ProcessEnv): McpServerConfig[] {
  const entries = (env.MCP_SERVERS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const names = new Set<string>();
  return entries.map((entry) => {
    const eq = entry.indexOf("=");
    const name = (eq > 0 ? entry.slice(0, eq) : "").trim().toLowerCase();
    const url = entry.slice(eq + 1).trim();
    if (!/^[a-z][a-z0-9]*$/.test(name)) {
      throw new Error(`MCP_SERVERS 要写成「名字=地址」，名字只用字母和数字，多个用逗号分隔，这一项不对：${entry}`);
    }
    if (names.has(name)) {
      throw new Error(`MCP_SERVERS 里 ${name} 写了两次`);
    }
    if (RESERVED_MCP_NAMES.has(name)) {
      throw new Error(`MCP_SERVERS 里的名字 ${name} 和内置工具的前缀（${name}_）重了，换一个名字`);
    }
    names.add(name);
    const key = `MCP_${name.toUpperCase()}`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`MCP_SERVERS 里 ${name} 的地址要写成 https://… 这样的完整地址`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`MCP_SERVERS 里 ${name} 的地址要用 http 或 https`);
    }
    // 令牌写进地址容易被各处日志记下来，只从 MCP_<名字>_TOKEN 读，用请求头发送
    if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some(isSecretParam)) {
      throw new Error(`MCP_SERVERS 里 ${name} 的地址带了令牌，请去掉，把令牌写进 ${key}_TOKEN`);
    }

    const defaults = MCP_SERVER_DEFAULTS[name];
    const toolsEnv = env[`${key}_TOOLS`]?.trim();
    const tools = toolsEnv === "*" ? "*" : toolsEnv ? toolList(toolsEnv, `${key}_TOOLS`, true) : defaults?.tools;
    if (!tools) {
      throw new Error(`配了 MCP 服务 ${name}，要在 ${key}_TOOLS 里写开哪些工具（服务端的工具名，逗号分隔；* 表示全部）`);
    }
    const prompt = env[`${key}_PROMPT`]?.trim();
    const token = env[`${key}_TOKEN`]?.trim();
    const thinking = env[`${key}_THINKING`]?.trim().toLowerCase();
    if (thinking && thinking !== "on" && thinking !== "off") {
      throw new Error(`${key}_THINKING 只能是 on 或 off，当前为 ${env[`${key}_THINKING`]}`);
    }
    return {
      name,
      url: parsed.href,
      ...(token ? { token } : {}),
      tools,
      writeTools: [...(defaults?.writeTools ?? []), ...toolList(env[`${key}_WRITE_TOOLS`] ?? "", `${key}_WRITE_TOOLS`)],
      promptFile: prompt ? path.resolve(prompt) : path.join(PROMPTS_DIR, `${name}.md`),
      timeoutsMs: defaults?.timeoutsMs ?? {},
      labels: defaults?.labels ?? {},
      thinking: thinking !== "off",
    };
  });
}

function toolList(value: string, key: string, required = false): string[] {
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  const bad = names.find((name) => !/^[\w.-]+$/.test(name));
  if (bad) {
    throw new Error(`${key} 要写服务端的工具名，多个用逗号分隔，这一项不对：${bad}`);
  }
  if (required && names.length === 0) {
    throw new Error(`${key} 里没有工具名，要写服务端的工具名，多个用逗号分隔（* 表示全部）`);
  }
  return names;
}

/** 代码仓库：配了 GITLAB_URL 就接 GitLab，否则配了 GITHUB_TOKEN 接 GitHub */
function loadCodeConfig(env: NodeJS.ProcessEnv): Omit<NonNullable<Config["code"]>, "workspaceDir"> | undefined {
  const entries = (env.CODE_REPOS ?? "").split(",").map((r) => r.trim()).filter(Boolean);
  if (entries.length === 0) {
    return undefined;
  }
  // 每一项可以写成 group/project@分支，给这个仓库指定默认看的分支
  const branches: Record<string, string> = {};
  const repos = entries.map((entry) => {
    const at = entry.lastIndexOf("@");
    const repo = (at > 0 ? entry.slice(0, at) : entry).trim().replace(/\.git$/, "");
    if (at > 0) {
      const branch = entry.slice(at + 1).trim();
      if (!/^[\p{L}\p{N}_.\/+-]+$/u.test(branch) || branch.startsWith("-") || branch.includes("..")) {
        throw new Error(`CODE_REPOS 里 ${entry} 的分支名不对，要写成 group/project@分支`);
      }
      branches[repo] = branch;
    }
    return repo;
  });
  const buildEnv = env.BUILD_CHECK?.trim().toLowerCase();
  if (buildEnv && buildEnv !== "on" && buildEnv !== "off") {
    throw new Error(`BUILD_CHECK 只能是 on 或 off，当前为 ${env.BUILD_CHECK}`);
  }
  const goproxy = env.BUILD_GOPROXY?.trim();
  const build = { build: buildEnv !== "off", ...(goproxy ? { goproxy } : {}) };
  const gitlabUrl = env.GITLAB_URL?.trim();
  if (gitlabUrl) {
    if (!/^https?:\/\/[^/\s]+/.test(gitlabUrl)) {
      throw new Error(`GITLAB_URL 要写成 https://gitlab.example.com 这样的地址，当前为 ${gitlabUrl}`);
    }
    if (!env.GITLAB_TOKEN) {
      throw new Error("配了 GITLAB_URL 就要配 GITLAB_TOKEN（要 api 权限的访问令牌）");
    }
    const bad = repos.find((r) => !/^[\w.-]+(\/[\w.-]+)+$/.test(r));
    if (bad) {
      throw new Error(`CODE_REPOS 要写成 GitLab 的项目路径（如 group/project），多个用逗号分隔，这一项不对：${bad}`);
    }
    return { repos, branches, host: { kind: "gitlab", url: gitlabUrl, token: env.GITLAB_TOKEN }, ...build };
  }
  if (env.GITHUB_TOKEN) {
    const bad = repos.find((r) => !/^[\w.-]+\/[\w.-]+$/.test(r));
    if (bad) {
      throw new Error(`CODE_REPOS 要写成 owner/repo，多个用逗号分隔，这一项不对：${bad}`);
    }
    return { repos, branches, host: { kind: "github", token: env.GITHUB_TOKEN }, ...build };
  }
  throw new Error("配了 CODE_REPOS 就要配 GITLAB_URL 和 GITLAB_TOKEN（接 GitHub 时配 GITHUB_TOKEN）");
}

/** 能看图的千问：3.5 以后的版本（联网搜索时 qwen3.8-max 只认多模态接口），以及名字里带 vl、omni 的 */
export function isMultimodalQwen(model: string): boolean {
  const id = model.toLowerCase();
  if (!id.startsWith("qwen")) {
    return false;
  }
  if (/[-.](vl|omni)([-.]|$)/.test(id)) {
    return true;
  }
  const version = /^qwen(\d+(?:\.\d+)?)/.exec(id);
  return version !== null && Number(version[1]) >= 3.5;
}

function isBailian(baseURL: string): boolean {
  try {
    return /(^|\.)aliyuncs\.com$/.test(new URL(baseURL).hostname);
  } catch {
    return false;
  }
}

/**
 * 百炼 OpenAI 兼容接口地址 → 同一域名下的原生文本生成接口（联网搜索要用它才拿得到来源）。
 * 不是百炼的地址时返回 undefined。
 */
export function bailianGenerationUrl(baseURL: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return undefined;
  }
  if (!/(^|\.)aliyuncs\.com$/.test(url.hostname) || !/^\/compatible-mode\/v1\/?$/.test(url.pathname)) {
    return undefined;
  }
  return `${url.origin}/api/v1/services/aigc/text-generation/generation`;
}
