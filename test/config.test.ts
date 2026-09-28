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
  // 百炼默认关掉思考
  assert.deepEqual(config.llm, { baseURL: DEFAULT_MODEL_BASE_URL, apiKey: "k", model: DEFAULT_MODEL_ID, thinking: false });
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

test("联网搜索：百炼的兼容接口换成同域名的原生接口，可以单独指定模型或关掉", () => {
  assert.deepEqual(loadConfig(base).webSearch, {
    url: "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
    model: DEFAULT_MODEL_ID,
  });
  assert.deepEqual(
    loadConfig({
      ...base,
      MODEL_BASE_URL: "https://ws123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/",
      WEB_SEARCH_MODEL: "qwen3.8-flash",
    }).webSearch,
    { url: "https://ws123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/text-generation/generation", model: "qwen3.8-flash" },
  );
  // 主模型不是千问时，搜索仍用千问旗舰；是千问时跟着主模型
  assert.equal(loadConfig({ ...base, MODEL_ID: "kimi-k3" }).webSearch?.model, DEFAULT_MODEL_ID);
  assert.equal(loadConfig({ ...base, MODEL_ID: "qwen3.7-plus" }).webSearch?.model, "qwen3.7-plus");
  assert.equal(loadConfig({ ...base, WEB_SEARCH: "off" }).webSearch, undefined);
  assert.equal(loadConfig({ ...base, MODEL_BASE_URL: "https://llm.example.com/v1" }).webSearch, undefined);
  assert.throws(() => loadConfig({ ...base, WEB_SEARCH: "yes" }), /WEB_SEARCH 只能是 on 或 off/);
});

test("代码仓库：配了 GITLAB_URL 接 GitLab（项目路径可以多层），否则 GITHUB_TOKEN 接 GitHub，缺令牌时报错", () => {
  assert.equal(loadConfig(base).code, undefined);
  const gitlab = loadConfig({
    ...base,
    CODE_REPOS: "team/backend/api.git, team/web",
    GITLAB_URL: "https://git.corp.example.com",
    GITLAB_TOKEN: "glpat-x",
    DATA_DIR: "/srv/agenttag",
  }).code;
  assert.deepEqual(gitlab, {
    repos: ["team/backend/api", "team/web"],
    host: { kind: "gitlab", url: "https://git.corp.example.com", token: "glpat-x" },
    workspaceDir: path.resolve("/srv/agenttag", "workspaces"),
  });
  assert.deepEqual(loadConfig({ ...base, CODE_REPOS: "acme/app", GITHUB_TOKEN: "ghp" }).code?.host, { kind: "github", token: "ghp" });
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "acme/app" }), /GITLAB_URL 和 GITLAB_TOKEN/);
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "acme/app", GITLAB_URL: "https://git.corp" }), /GITLAB_TOKEN/);
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "app", GITLAB_URL: "https://git.corp", GITLAB_TOKEN: "t" }), /项目路径/);
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "a/b/c", GITHUB_TOKEN: "t" }), /owner\/repo/);
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "a/b", GITLAB_URL: "git.corp", GITLAB_TOKEN: "t" }), /GITLAB_URL 要写成/);
});

test("MODEL_THINKING 可以打开或关掉思考；别家服务默认不传；写错时报错", () => {
  assert.equal(loadConfig({ ...base, MODEL_THINKING: "on" }).llm.thinking, true);
  assert.equal(loadConfig({ ...base, MODEL_THINKING: "OFF" }).llm.thinking, false);
  assert.equal(loadConfig({ ...base, MODEL_BASE_URL: "https://llm.example.com/v1" }).llm.thinking, undefined);
  assert.equal(loadConfig({ ...base, MODEL_BASE_URL: "https://llm.example.com/v1", MODEL_THINKING: "off" }).llm.thinking, false);
  assert.throws(() => loadConfig({ ...base, MODEL_THINKING: "yes" }), /MODEL_THINKING 只能是 on 或 off/);
});
