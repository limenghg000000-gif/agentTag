import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { Domain } from "@larksuiteoapi/node-sdk";
import { DEFAULT_MODEL_BASE_URL, DEFAULT_MODEL_ID, DEFAULT_THINKING_BUDGET, loadConfig } from "../src/config.js";

const base = { FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "s", MODEL_API_KEY: "k" };

test("缺少必填环境变量时一次列全", () => {
  assert.throws(() => loadConfig({}), /FEISHU_APP_ID, FEISHU_APP_SECRET, MODEL_API_KEY/);
});

test("默认值：国内飞书、百炼接口、默认模型", () => {
  const config = loadConfig(base);
  assert.equal(config.feishu.domain, Domain.Feishu);
  assert.equal(config.feishu.allowedChatIds.size, 0);
  // 百炼默认关掉思考
  assert.deepEqual(config.llm, {
    baseURL: DEFAULT_MODEL_BASE_URL,
    apiKey: "k",
    model: DEFAULT_MODEL_ID,
    thinking: false,
    thinkingBudget: DEFAULT_THINKING_BUDGET,
  });
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
    branches: {},
    host: {
      kind: "gitlab",
      url: "https://git.corp.example.com",
      tokens: {
        "team/backend/api": { token: "glpat-x", env: "GITLAB_TOKEN" },
        "team/web": { token: "glpat-x", env: "GITLAB_TOKEN" },
      },
    },
    workspaceDir: path.resolve("/srv/agenttag", "workspaces"),
  });
  assert.deepEqual(loadConfig({ ...base, CODE_REPOS: "acme/app", GITHUB_TOKEN: "ghp" }).code?.host, { kind: "github", token: "ghp" });
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "acme/app" }), /GITLAB_URL 和 GITLAB_TOKEN/);
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "acme/app", GITLAB_URL: "https://git.corp" }), /acme\/app 没有令牌.*GITLAB_TOKEN_ACME/);
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "app", GITLAB_URL: "https://git.corp", GITLAB_TOKEN: "t" }), /项目路径/);
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "a/b/c", GITHUB_TOKEN: "t" }), /owner\/repo/);
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "a/b", GITLAB_URL: "git.corp", GITLAB_TOKEN: "t" }), /GITLAB_URL 要写成/);
});

test("GitLab 令牌可以按群组或项目单独配，没配的用 GITLAB_TOKEN；都没有时报错", () => {
  const tokens = (env: NodeJS.ProcessEnv) => {
    const host = loadConfig({ ...base, GITLAB_URL: "https://lab.corp", ...env }).code?.host;
    assert.equal(host?.kind, "gitlab");
    return host.kind === "gitlab" ? host.tokens : {};
  };
  assert.deepEqual(
    tokens({
      CODE_REPOS: "ai/aiops-mcp@aiops, ai/agent-tag, golang/app-service, golang/pay/core",
      GITLAB_TOKEN: "all",
      GITLAB_TOKEN_AI_AIOPS_MCP: "only-aiops",
      GITLAB_TOKEN_golang: "golang-group",
      GITLAB_TOKEN_GOLANG_PAY: " ",
    }),
    {
      "ai/aiops-mcp": { token: "only-aiops", env: "GITLAB_TOKEN_AI_AIOPS_MCP" },
      "ai/agent-tag": { token: "all", env: "GITLAB_TOKEN" },
      "golang/app-service": { token: "golang-group", env: "GITLAB_TOKEN_golang" },
      "golang/pay/core": { token: "golang-group", env: "GITLAB_TOKEN_golang" },
    },
  );
  // 不配 GITLAB_TOKEN 也行，只要每个仓库都有自己的
  assert.deepEqual(tokens({ CODE_REPOS: "ai/agent-tag", GITLAB_TOKEN_AI: "ai-group" }), {
    "ai/agent-tag": { token: "ai-group", env: "GITLAB_TOKEN_AI" },
  });
  assert.throws(
    () => tokens({ CODE_REPOS: "ai/agent-tag, golang/app", GITLAB_TOKEN_AI: "ai-group" }),
    /golang\/app 没有令牌.*GITLAB_TOKEN_GOLANG（golang 群组的）、GITLAB_TOKEN_GOLANG_APP（只给这个项目）/,
  );
});

test("CODE_REPOS 可以给仓库指定默认分支：group/project@分支", () => {
  const code = loadConfig({
    ...base,
    CODE_REPOS: "ai/aiops-mcp@aiops, ai/agent-tag, team/web.git@release/2.0",
    GITLAB_URL: "https://lab.corp",
    GITLAB_TOKEN: "t",
  }).code;
  assert.deepEqual(code?.repos, ["ai/aiops-mcp", "ai/agent-tag", "team/web"]);
  assert.deepEqual(code?.branches, { "ai/aiops-mcp": "aiops", "team/web": "release/2.0" });
  assert.throws(
    () => loadConfig({ ...base, CODE_REPOS: "ai/aiops-mcp@../x", GITLAB_URL: "https://lab.corp", GITLAB_TOKEN: "t" }),
    /分支名不对/,
  );
});

test("WRITE_ALLOWED_USERS：不配时所有人都能写，配了只有名单里的 open_id 能写，写错时报错", () => {
  assert.equal(loadConfig(base).feishu.writeAllowedUsers, undefined);
  assert.deepEqual(loadConfig({ ...base, WRITE_ALLOWED_USERS: " ou_a1, ou_b2 ," }).feishu.writeAllowedUsers, new Set(["ou_a1", "ou_b2"]));
  assert.throws(() => loadConfig({ ...base, WRITE_ALLOWED_USERS: "赵作武" }), /open_id（ou_ 开头）.*赵作武/);
});

test("MODEL_THINKING 可以打开或关掉思考；别家服务默认不传；写错时报错", () => {
  assert.equal(loadConfig({ ...base, MODEL_THINKING: "on" }).llm.thinking, true);
  assert.equal(loadConfig({ ...base, MODEL_THINKING: "OFF" }).llm.thinking, false);
  assert.equal(loadConfig({ ...base, MODEL_BASE_URL: "https://llm.example.com/v1" }).llm.thinking, undefined);
  assert.equal(loadConfig({ ...base, MODEL_BASE_URL: "https://llm.example.com/v1", MODEL_THINKING: "off" }).llm.thinking, false);
  assert.throws(() => loadConfig({ ...base, MODEL_THINKING: "yes" }), /MODEL_THINKING 只能是 on 或 off/);
});

test("MODEL_THINKING_BUDGET 限制思考长度：百炼默认 4000，0 表示不限，别家服务默认不传，写错时报错", () => {
  assert.equal(loadConfig(base).llm.thinkingBudget, 4000);
  assert.equal(loadConfig({ ...base, MODEL_THINKING_BUDGET: "8000" }).llm.thinkingBudget, 8000);
  assert.equal(loadConfig({ ...base, MODEL_THINKING_BUDGET: "0" }).llm.thinkingBudget, undefined);
  assert.equal(loadConfig({ ...base, MODEL_BASE_URL: "https://llm.example.com/v1" }).llm.thinkingBudget, undefined);
  assert.throws(() => loadConfig({ ...base, MODEL_THINKING_BUDGET: "很多" }), /MODEL_THINKING_BUDGET/);
  assert.throws(() => loadConfig({ ...base, MODEL_THINKING_BUDGET: "-1" }), /MODEL_THINKING_BUDGET/);
});
