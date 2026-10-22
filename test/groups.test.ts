import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { type CardSettings, GroupPolicies, isRepoPattern } from "../src/groups.js";
import type { GroupOverride } from "../src/settings.js";

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

test("aiops 经验库：按群收窄过工具的，全局开给模型的检索和取详情都要开着才用", () => {
  const of = (tools: string, global?: string) =>
    new GroupPolicies(loadConfig({ ...env, GROUP_OPS_MCP_AIOPS_TOOLS: tools, ...(global ? { MCP_AIOPS_TOOLS: global } : {}) })).usesAiopsLessons("oc_ops");
  // 全局默认的工具里有 get_knowledge：只开检索不够（程序归档前、同步时会替这个群取经验详情）
  assert.equal(of("query_logs,search_knowledge"), false);
  assert.equal(of("search_knowledge,get_knowledge"), true);
  assert.equal(of("query_logs"), false);
  // 全局本来就没开 get_knowledge 给模型的，只看检索
  assert.equal(of("search_knowledge", "query_logs,search_knowledge"), true);
  const groups = new GroupPolicies(loadConfig(env));
  assert.equal(groups.usesAiopsLessons("oc_plain"), true, "没单独配的群同全局");
  assert.equal(groups.usesAiopsLessons("oc_test"), false, "MCP 不开的群不用");
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

test("管理群卡片上改过的项盖过 .env 里的，没改的照旧；白名单外的群不看卡片", () => {
  const cards: Record<string, GroupOverride> = {
    oc_ops: { writeAllowed: ["ou_b", "ou_c"], mcp: { aiops: ["query_logs", "not_global"] }, proactive: true },
    oc_test: { codeRepos: [], memoryEditors: [], knowledge: true, mcp: { aiops: "all" } },
    oc_other: { writeAllowed: [] },
  };
  const groups = new GroupPolicies(loadConfig({ ...env, FEISHU_ALLOWED_CHAT_IDS: "oc_test,oc_ops,oc_plain" }), cardsOf(cards));
  const ops = groups.of("oc_ops");
  assert.deepEqual(ops.writeAllowed, new Set(["ou_b", "ou_c"]));
  // 工具只能在全局开了的里挑：全局没开的去掉
  assert.deepEqual(ops.mcp, new Map([["aiops", ["query_logs"]]]));
  assert.equal(ops.proactive, true);
  assert.deepEqual(ops.codeRepos, ["ai/aiops-mcp", "ai/agent-tag"], "仓库没在卡片上改，照 .env");

  const test = groups.of("oc_test");
  assert.deepEqual(test.codeRepos, []);
  assert.deepEqual(test.memoryEditors, new Set());
  assert.deepEqual(test.writeAllowed, new Set(["ou_a"]), "写权限没在卡片上改，照 .env 里这个群的");
  assert.equal(test.knowledge, true, "卡片上打开经验库盖过 GROUP_TEST_KNOWLEDGE=off");
  assert.deepEqual(test.mcp, new Map([["aiops", "*"]]), "卡片上全开盖过 GROUP_TEST_MCP=off");

  // 只看服务器上的配置（卡片上「照服务器上的配置（现在：…）」用）
  assert.deepEqual(groups.of("oc_ops", { card: false }).writeAllowed, new Set());
  assert.equal(groups.of("oc_other").writeAllowed?.size, 1, "白名单外的群不看卡片");
  assert.equal(groups.carded("oc_other"), undefined);
  assert.deepEqual(groups.carded("oc_ops"), cards.oc_ops);
});

test("全局关着经验库时卡片上打开也不算；卡片上改过的群每次取都是最新的", () => {
  let card: GroupOverride | undefined = { knowledge: true };
  const groups = new GroupPolicies(loadConfig({ ...env, KNOWLEDGE: "off" }), { override: () => card, chatIds: () => (card ? ["oc_plain"] : []) });
  assert.equal(groups.of("oc_plain").knowledge, false);
  card = { proactive: true };
  assert.equal(groups.of("oc_plain").proactive, true);
  card = undefined;
  assert.equal(groups.of("oc_plain").proactive, false);
});

test("preview：换成卡片上的选择以后用的配置；空的就是全照服务器上的配置", () => {
  const groups = new GroupPolicies(loadConfig(env), cardsOf({ oc_ops: { writeAllowed: ["ou_z"] } }));
  assert.deepEqual(groups.preview("oc_ops", { writeAllowed: ["ou_b"] }).writeAllowed, new Set(["ou_b"]));
  assert.deepEqual(groups.preview("oc_ops", {}).writeAllowed, new Set(), "空的照 .env：GROUP_OPS_WRITE_ALLOWED_USERS=none");
});

test("经验库表格共享按卡片上改过的名单算", () => {
  const groups = new GroupPolicies(loadConfig(env), cardsOf({ oc_ops: { writeAllowed: ["ou_b"], knowledge: false } }));
  assert.deepEqual(groups.knowledgeShare(), { chatIds: ["oc_plain"], editors: ["ou_ml"] });
});

test("启动日志加一行卡片上改过的群（写几个人，不写是谁）", () => {
  const groups = new GroupPolicies(loadConfig(env), cardsOf({ oc_plain: { writeAllowed: ["ou_b", "ou_c"], mcp: { aiops: "off" }, proactive: true } }));
  const lines = groups.describe();
  assert.equal(lines.length, 3);
  assert.equal(lines[2], "群 oc_plain（oc_plain）在管理群的卡片上改过：写权限 2 人；MCP aiops 不开；主动接话 开");
});

test("开通的群：服务器白名单加上卡片上开通的、去掉停用的；存了以后 refresh 原地改，拿着它的地方马上看得到", () => {
  const cards: Record<string, GroupOverride> = {
    oc_new: { enabled: true, codeRepos: [], writeAllowed: [] },
    oc_test: { enabled: false, knowledge: true },
    oc_left: { writeAllowed: ["ou_b"] },
  };
  const groups = new GroupPolicies(loadConfig({ ...env, FEISHU_ALLOWED_CHAT_IDS: "oc_test,oc_ops,oc_plain" }), cardsOf(cards));
  const allowed = groups.allowed;
  assert.deepEqual([...allowed].sort(), ["oc_new", "oc_ops", "oc_plain"]);
  assert.equal(groups.onServer("oc_test"), true);
  assert.equal(groups.onServer("oc_new"), false);
  // 卡片上开通的群按卡片上定的；停用的、没开通的不看卡片
  assert.deepEqual(groups.of("oc_new").codeRepos, []);
  assert.deepEqual(groups.of("oc_new").writeAllowed, new Set());
  assert.equal(groups.carded("oc_test"), undefined);
  assert.equal(groups.carded("oc_left"), undefined);
  assert.deepEqual(groups.knowledgeShare().chatIds.sort(), ["oc_new", "oc_ops", "oc_plain"]);

  const lines = groups.describe().filter((line) => line.includes("卡片上改过"));
  assert.deepEqual(lines, [
    "群 oc_new（oc_new）在管理群的卡片上改过：开通；仓库 不开；写权限 没人",
    "群 test（oc_test）在管理群的卡片上改过：停用；经验库 用",
    "群 oc_left（oc_left）在管理群的卡片上改过：没开通；写权限 1 人",
  ]);

  cards.oc_test = { knowledge: true };
  delete cards.oc_new;
  groups.refresh();
  assert.equal(groups.allowed, allowed, "还是同一个 Set");
  assert.deepEqual([...allowed].sort(), ["oc_ops", "oc_plain", "oc_test"]);
});

function cardsOf(cards: Record<string, GroupOverride>): CardSettings {
  return { override: (chatId) => cards[chatId], chatIds: () => Object.keys(cards) };
}
