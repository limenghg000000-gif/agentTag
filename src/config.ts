import path from "node:path";
import { Domain } from "@larksuiteoapi/node-sdk";
import type { LlmConfig } from "./llm.js";

export interface Config {
  feishu: {
    appId: string;
    appSecret: string;
    domain: Domain;
    /** 群白名单（chat_id）。为空时不响应任何群。 */
    allowedChatIds: ReadonlySet<string>;
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
  /** 联网搜索：百炼原生接口地址和搜索用的模型。关掉或模型服务不是百炼时为空 */
  webSearch?: { url: string; model: string };
  /** 代码仓库：没配 CODE_REPOS 时为空 */
  code?: {
    /** 允许操作的仓库：GitLab 的项目路径（group/project），或 GitHub 的 owner/repo */
    repos: string[];
    host: { kind: "gitlab"; url: string; token: string } | { kind: "github"; token: string };
    /** 拉代码的工作目录（每个话题一个子目录） */
    workspaceDir: string;
  };
}

/** 阿里云百炼 OpenAI 兼容接口（华北2 北京）。百炼建议换成业务空间专属域名，见 README。 */
export const DEFAULT_MODEL_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DEFAULT_MODEL_ID = "qwen3.8-max";
/** 数据目录，相对路径按启动时的工作目录算 */
export const DEFAULT_DATA_DIR = "data";
/** 补漏轮询默认每 10 秒一次 */
export const DEFAULT_CATCHUP_INTERVAL_SECONDS = 10;
/** 群记忆备份默认保留 14 天 */
export const DEFAULT_MEMORY_BACKUP_DAYS = 14;

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

  const code = loadCodeConfig(env);

  const domainName = (env.FEISHU_DOMAIN ?? "feishu").toLowerCase();
  if (domainName !== "feishu" && domainName !== "lark") {
    throw new Error(`FEISHU_DOMAIN 只能是 feishu 或 lark，当前为 ${env.FEISHU_DOMAIN}`);
  }

  return {
    feishu: {
      appId: env.FEISHU_APP_ID!,
      appSecret: env.FEISHU_APP_SECRET!,
      domain: domainName === "lark" ? Domain.Lark : Domain.Feishu,
      allowedChatIds: new Set(
        (env.FEISHU_ALLOWED_CHAT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean),
      ),
    },
    llm: { baseURL, apiKey: env.MODEL_API_KEY!, model },
    memoryDir: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR, "memory"),
    catchUpIntervalMs: catchUpSeconds * 1000,
    alertChatId: env.ALERT_CHAT_ID?.trim() || undefined,
    memoryBackupDir: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR, "backup", "memory"),
    memoryBackupDays: backupDays,
    webSearch: searchUrl ? { url: searchUrl, model: env.WEB_SEARCH_MODEL || model } : undefined,
    code: code && { ...code, workspaceDir: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR, "workspaces") },
  };
}

/** 代码仓库：配了 GITLAB_URL 就接 GitLab，否则配了 GITHUB_TOKEN 接 GitHub */
function loadCodeConfig(env: NodeJS.ProcessEnv): Omit<NonNullable<Config["code"]>, "workspaceDir"> | undefined {
  const repos = (env.CODE_REPOS ?? "").split(",").map((r) => r.trim().replace(/\.git$/, "")).filter(Boolean);
  if (repos.length === 0) {
    return undefined;
  }
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
    return { repos, host: { kind: "gitlab", url: gitlabUrl, token: env.GITLAB_TOKEN } };
  }
  if (env.GITHUB_TOKEN) {
    const bad = repos.find((r) => !/^[\w.-]+\/[\w.-]+$/.test(r));
    if (bad) {
      throw new Error(`CODE_REPOS 要写成 owner/repo，多个用逗号分隔，这一项不对：${bad}`);
    }
    return { repos, host: { kind: "github", token: env.GITHUB_TOKEN } };
  }
  throw new Error("配了 CODE_REPOS 就要配 GITLAB_URL 和 GITLAB_TOKEN（接 GitHub 时配 GITHUB_TOKEN）");
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
