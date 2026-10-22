import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { GroupPolicies, isRepoPattern } from "../src/groups.js";

const env = {
  FEISHU_APP_ID: "cli_x",
  FEISHU_APP_SECRET: "s",
  MODEL_API_KEY: "k",
  FEISHU_ALLOWED_CHAT_IDS: "oc_test,oc_ops,oc_plain",
  GITLAB_URL: "https://lab.corp",
  GITLAB_TOKEN: "t",
  CODE_REPOS: "ai/aiops-mcp@aiops,ai/agent-tag",
  WRITE_ALLOWED_USERS: "ou_ml",
  MCP_SERVERS: "aiops=https://aiops.example.com/mcp",
  GROUPS: "test=oc_test,ops=oc_ops",
  GROUP_TEST_CODE_REPOS: "golang/*,AI/agent-tag",
  GROUP_TEST_WRITE_ALLOWED_USERS: "ou_a",
  GROUP_TEST_MEMORY_EDITORS: "ou_a",
  GROUP_TEST_MCP: "off",
  GROUP_TEST_KNOWLEDGE: "off",
  GROUP_OPS_WRITE_ALLOWED_USERS: "none",
  GROUP_OPS_MCP_AIOPS_TOOLS: "query_logs,search_knowledge",
};

test("没单独配的群用全局那份；配了的群逐项覆盖，没写的项照全局", () => {
  const groups = new GroupPolicies(loadConfig(env));
  const plain = groups.of("oc_plain");
  assert.equal(plain.name, undefined);
  assert.deepEqual(plain.codeRepos, ["ai/aiops-mcp", "ai/agent-tag"]);
  assert.deepEqual(plain.writeAllowed, new Set(["ou_ml"]));
  assert.equal(plain.memoryEditors, undefined);
  assert.deepEqual(plain.mcp, new Map([["aiops", "*"]]));
  assert.equal(plain.knowledge, true);

  const test = groups.of("oc_test");
  assert.equal(test.name, "test");
  assert.deepEqual(test.codeRepos, ["golang/*", "AI/agent-tag"]);
  assert.deepEqual(test.writeAllowed, new Set(["ou_a"]));
  assert.deepEqual(test.memoryEditors, new Set(["ou_a"]));
  assert.deepEqual(test.mcp, new Map());
  assert.equal(test.knowledge, false);

  // ops 只写了写权限名单（谁都不能）和 aiops 的工具：仓库、经验库照全局
  const ops = groups.of("oc_ops");
  assert.deepEqual(ops.codeRepos, ["ai/aiops-mcp", "ai/agent-tag"]);
  assert.deepEqual(ops.writeAllowed, new Set());
  assert.deepEqual(ops.mcp, new Map([["aiops", ["query_logs", "search_knowledge"]]]));
  assert.equal(ops.knowledge, true);
});

test("全局没开经验库、没写写权限名单时，配了的群也没有", () => {
  const groups = new GroupPolicies(loadConfig({ ...env, KNOWLEDGE: "off", WRITE_ALLOWED_USERS: "", GROUP_TEST_KNOWLEDGE: "" }));
  assert.equal(groups.of("oc_test").knowledge, false);
  assert.equal(groups.of("oc_plain").knowledge, false);
  assert.equal(groups.of("oc_plain").writeAllowed, undefined);
  assert.deepEqual(groups.of("oc_test").writeAllowed, new Set(["ou_a"]));
});

test("所有群写到的仓库合在一起（不分大小写去重），给代码工作目录用", () => {
  assert.deepEqual(new GroupPolicies(loadConfig(env)).repoEntries(), ["ai/aiops-mcp", "ai/agent-tag", "golang/*"]);
  assert.deepEqual(new GroupPolicies(loadConfig(env)).repoEntries().filter(isRepoPattern), ["golang/*"]);
});

test("经验库表格只共享给用经验库的群，能管理表格的是这些群里能点「保存」的人", () => {
  assert.deepEqual(new GroupPolicies(loadConfig(env)).knowledgeShare(), { chatIds: ["oc_ops", "oc_plain"], editors: ["ou_ml"] });
  const shared = new GroupPolicies(loadConfig({ ...env, GROUP_TEST_KNOWLEDGE: "", GROUP_OPS_WRITE_ALLOWED_USERS: "ou_b" })).knowledgeShare();
  assert.deepEqual(shared, { chatIds: ["oc_test", "oc_ops", "oc_plain"], editors: ["ou_a", "ou_b", "ou_ml"] });
});

test("启动日志写明每个单独配过的群用的是什么", () => {
  const lines = new GroupPolicies(loadConfig(env)).describe();
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^群 test（oc_test）单独配置：仓库 golang\/\*, AI\/agent-tag；写权限 1 人；改群记忆 1 人；MCP 不开；经验库 不用$/);
  assert.match(lines[1], /^群 ops（oc_ops）单独配置：仓库 同全局；写权限 没人；改群记忆 同全局；MCP aiops（2 个工具）；经验库 同全局$/);
});
