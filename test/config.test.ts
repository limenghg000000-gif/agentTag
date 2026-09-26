import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { Domain } from "@larksuiteoapi/node-sdk";
import { DEFAULT_MODEL_BASE_URL, DEFAULT_MODEL_ID, loadConfig } from "../src/config.js";

const base = { FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "s", MODEL_API_KEY: "k" };

test("缺少必填环境变量时一次列全", () => {
  assert.throws(() => loadConfig({}), /FEISHU_APP_ID, FEISHU_APP_SECRET, MODEL_API_KEY/);
});

test("默认值：国内飞书、百炼接口、默认模型", () => {
  const config = loadConfig(base);
  assert.equal(config.feishu.domain, Domain.Feishu);
  assert.equal(config.feishu.allowedChatIds.size, 0);
  assert.deepEqual(config.llm, { baseURL: DEFAULT_MODEL_BASE_URL, apiKey: "k", model: DEFAULT_MODEL_ID });
});

test("换模型服务只改环境变量", () => {
  const config = loadConfig({ ...base, FEISHU_DOMAIN: "lark", MODEL_BASE_URL: "https://llm.example.com/v1", MODEL_ID: "kimi-k3" });
  assert.equal(config.feishu.domain, Domain.Lark);
  assert.deepEqual(config.llm, { baseURL: "https://llm.example.com/v1", apiKey: "k", model: "kimi-k3" });
});

test("群白名单按逗号分隔，忽略空格和空项", () => {
  const config = loadConfig({ ...base, FEISHU_ALLOWED_CHAT_IDS: " oc_a, oc_b ,," });
  assert.deepEqual([...config.feishu.allowedChatIds], ["oc_a", "oc_b"]);
});

test("FEISHU_DOMAIN 写错时报错", () => {
  assert.throws(() => loadConfig({ ...base, FEISHU_DOMAIN: "dingtalk" }), /FEISHU_DOMAIN/);
});

test("群记忆默认存在工作目录下的 data/memory，可以用 DATA_DIR 改", () => {
  assert.equal(loadConfig(base).memoryDir, path.resolve("data", "memory"));
  assert.equal(loadConfig({ ...base, DATA_DIR: "/var/lib/agenttag" }).memoryDir, "/var/lib/agenttag/memory");
});
