import { Domain } from "@larksuiteoapi/node-sdk";
import type { LlmConfig } from "./llm.js";

export interface Config {
  feishu: {
    appId: string;
    appSecret: string;
    domain: Domain;
  };
  llm: LlmConfig;
}

/** 阿里云百炼 OpenAI 兼容接口（华北2 北京）。百炼建议换成业务空间专属域名，见 README。 */
export const DEFAULT_MODEL_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DEFAULT_MODEL_ID = "qwen3.8-max";

/** 从环境变量读取配置。密钥只从环境变量来，不写进代码和仓库。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "MODEL_API_KEY"].filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`缺少环境变量：${missing.join(", ")}。请参考 .env.example 配置 .env`);
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
    },
    llm: {
      baseURL: env.MODEL_BASE_URL || DEFAULT_MODEL_BASE_URL,
      apiKey: env.MODEL_API_KEY!,
      model: env.MODEL_ID || DEFAULT_MODEL_ID,
    },
  };
}
