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
    llm: {
      baseURL: env.MODEL_BASE_URL || DEFAULT_MODEL_BASE_URL,
      apiKey: env.MODEL_API_KEY!,
      model: env.MODEL_ID || DEFAULT_MODEL_ID,
    },
    memoryDir: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR, "memory"),
    catchUpIntervalMs: catchUpSeconds * 1000,
    alertChatId: env.ALERT_CHAT_ID?.trim() || undefined,
    memoryBackupDir: path.resolve(env.DATA_DIR || DEFAULT_DATA_DIR, "backup", "memory"),
    memoryBackupDays: backupDays,
  };
}
