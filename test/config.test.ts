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

test("补漏轮询默认每 10 秒一次，可以改间隔或设成 0 关掉，写错时报错", () => {
  assert.equal(loadConfig(base).catchUpIntervalMs, 10_000);
  assert.equal(loadConfig({ ...base, CATCHUP_INTERVAL_SECONDS: "30" }).catchUpIntervalMs, 30_000);
  assert.equal(loadConfig({ ...base, CATCHUP_INTERVAL_SECONDS: "0" }).catchUpIntervalMs, 0);
  assert.throws(() => loadConfig({ ...base, CATCHUP_INTERVAL_SECONDS: "abc" }), /CATCHUP_INTERVAL_SECONDS/);
  assert.throws(() => loadConfig({ ...base, CATCHUP_INTERVAL_SECONDS: "1" }), /CATCHUP_INTERVAL_SECONDS/);
});

test("补漏报警默认发到漏消息的群，可以用 ALERT_CHAT_ID 指定", () => {
  assert.equal(loadConfig(base).alertChatId, undefined);
  assert.equal(loadConfig({ ...base, ALERT_CHAT_ID: " oc_ops " }).alertChatId, "oc_ops");
});

test("群记忆默认每天备份到 data/backup/memory，保留 14 天，可以改天数或设成 0 关掉", () => {
  assert.equal(loadConfig(base).memoryBackupDir, path.resolve("data", "backup", "memory"));
  assert.equal(loadConfig({ ...base, DATA_DIR: "/var/lib/agenttag" }).memoryBackupDir, "/var/lib/agenttag/backup/memory");
  assert.equal(loadConfig(base).memoryBackupDays, 14);
  assert.equal(loadConfig({ ...base, MEMORY_BACKUP_DAYS: "30" }).memoryBackupDays, 30);
  assert.equal(loadConfig({ ...base, MEMORY_BACKUP_DAYS: "0" }).memoryBackupDays, 0);
  assert.throws(() => loadConfig({ ...base, MEMORY_BACKUP_DAYS: "1.5" }), /MEMORY_BACKUP_DAYS/);
  assert.throws(() => loadConfig({ ...base, MEMORY_BACKUP_DAYS: "-1" }), /MEMORY_BACKUP_DAYS/);
});
