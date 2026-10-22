import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Domain } from "@larksuiteoapi/node-sdk";
import {
  AIOPS_DEFAULT_TOOLS,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_MODEL_BASE_URL,
  DEFAULT_MODEL_ID,
  DEFAULT_THINKING_BUDGET,
  isMultimodalQwen,
  loadConfig,
} from "../src/config.js";

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

test("看图模型：百炼上默认用主模型（千问 3.5 以后是多模态），主模型不是千问时用千问旗舰；可以单独指定或关掉，别家服务要自己配", () => {
  // 用百炼时看图关掉思考，主模型打开思考也一样
  assert.deepEqual(loadConfig({ ...base, MODEL_THINKING: "on" }).vision, { model: DEFAULT_MODEL_ID, thinking: false });
  assert.deepEqual(loadConfig({ ...base, MODEL_ID: "qwen3.7-plus" }).vision, { model: "qwen3.7-plus", thinking: false });
  assert.deepEqual(loadConfig({ ...base, MODEL_ID: "kimi-k3" }).vision, { model: DEFAULT_MODEL_ID, thinking: false });
  // 纯文本的千问不拿来看图
  for (const text of ["qwen-plus", "qwen3-max", "qwen2.5-72b-instruct", "qwen3-coder-plus"]) {
    assert.deepEqual(loadConfig({ ...base, MODEL_ID: text }).vision, { model: DEFAULT_MODEL_ID, thinking: false }, text);
  }
  for (const multimodal of ["qwen3.5-plus", "qwen3-vl-plus", "qwen-vl-max", "qwen3-omni-flash", "qwen3.8-max"]) {
    assert.equal(isMultimodalQwen(multimodal), true, multimodal);
  }
  assert.deepEqual(loadConfig({ ...base, MODEL_VISION_ID: " qwen3-vl-plus " }).vision, { model: "qwen3-vl-plus", thinking: false });
  assert.equal(loadConfig({ ...base, MODEL_VISION_ID: "OFF" }).vision, undefined);
  assert.equal(loadConfig({ ...base, MODEL_BASE_URL: "https://llm.example.com/v1" }).vision, undefined);
  assert.deepEqual(loadConfig({ ...base, MODEL_BASE_URL: "https://llm.example.com/v1", MODEL_VISION_ID: "glm-5.3v" }).vision, {
    model: "glm-5.3v",
  });
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
    host: { kind: "gitlab", url: "https://git.corp.example.com", token: "glpat-x" },
    workspaceDir: path.resolve("/srv/agenttag", "workspaces"),
    build: true,
  });
  assert.deepEqual(loadConfig({ ...base, CODE_REPOS: "acme/app", GITHUB_TOKEN: "ghp" }).code?.host, { kind: "github", token: "ghp" });
  // 编译检查默认开，BUILD_CHECK=off 关掉；BUILD_GOPROXY 换下载依赖的代理
  const gh = { ...base, CODE_REPOS: "acme/app", GITHUB_TOKEN: "ghp" };
  assert.equal(loadConfig({ ...gh, BUILD_CHECK: "off" }).code?.build, false);
  assert.equal(loadConfig({ ...gh, BUILD_GOPROXY: "https://goproxy.corp,direct" }).code?.goproxy, "https://goproxy.corp,direct");
  assert.throws(() => loadConfig({ ...gh, BUILD_CHECK: "yes" }), /BUILD_CHECK 只能是 on 或 off/);
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "acme/app" }), /GITLAB_URL 和 GITLAB_TOKEN/);
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "acme/app", GITLAB_URL: "https://git.corp" }), /GITLAB_TOKEN/);
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "app", GITLAB_URL: "https://git.corp", GITLAB_TOKEN: "t" }), /项目路径/);
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "a/b/c", GITHUB_TOKEN: "t" }), /owner\/repo/);
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "a/b", GITLAB_URL: "git.corp", GITLAB_TOKEN: "t" }), /GITLAB_URL 要写成/);
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

test("SHOW_THINKING：默认在进度卡片上显示思考，off 关掉，写错时报错", () => {
  assert.equal(loadConfig(base).showThinking, true);
  assert.equal(loadConfig({ ...base, SHOW_THINKING: " OFF " }).showThinking, false);
  assert.equal(loadConfig({ ...base, SHOW_THINKING: "on" }).showThinking, true);
  assert.throws(() => loadConfig({ ...base, SHOW_THINKING: "yes" }), /SHOW_THINKING 只能是 on 或 off/);
});

test("FOLLOW_THREADS、CHAT_CONTEXT：默认开，off 关掉，写错时报错", () => {
  assert.equal(loadConfig(base).followThreads, true);
  assert.equal(loadConfig(base).chatContext, true);
  assert.equal(loadConfig({ ...base, FOLLOW_THREADS: " OFF " }).followThreads, false);
  assert.equal(loadConfig({ ...base, CHAT_CONTEXT: "off" }).chatContext, false);
  assert.throws(() => loadConfig({ ...base, FOLLOW_THREADS: "yes" }), /FOLLOW_THREADS 只能是 on 或 off/);
  assert.throws(() => loadConfig({ ...base, CHAT_CONTEXT: "1" }), /CHAT_CONTEXT 只能是 on 或 off/);
  // 跟着的话题记在 DATA_DIR 下，重启后接着跟
  assert.equal(loadConfig(base).followStateFile, path.resolve("data", "follow.json"));
  assert.equal(loadConfig({ ...base, DATA_DIR: "/srv/bot" }).followStateFile, path.resolve("/srv/bot", "follow.json"));
});

test("PROACTIVE_CHAT_IDS：默认没有群；只算群白名单里的，别的列出来提醒；PROACTIVE_MAX_PER_HOUR 不填就不限", () => {
  const off = loadConfig(base).proactive;
  assert.equal(off.chatIds.size, 0);
  assert.deepEqual(off.ignored, []);
  assert.equal(off.maxPerHour, Number.POSITIVE_INFINITY);
  assert.equal(off.stateFile, path.resolve("data", "proactive.json"));

  const on = loadConfig({
    ...base,
    FEISHU_ALLOWED_CHAT_IDS: "oc_1,oc_2",
    PROACTIVE_CHAT_IDS: " oc_2 , oc_9,oc_2 ",
    PROACTIVE_MAX_PER_HOUR: "5",
    DATA_DIR: "/srv/bot",
  }).proactive;
  assert.deepEqual([...on.chatIds], ["oc_2"]);
  assert.deepEqual(on.ignored, ["oc_9"]);
  assert.equal(on.maxPerHour, 5);
  assert.equal(on.stateFile, path.resolve("/srv/bot", "proactive.json"));

  for (const bad of ["0", "61", "2.5", "很多"]) {
    assert.throws(() => loadConfig({ ...base, PROACTIVE_MAX_PER_HOUR: bad }), /PROACTIVE_MAX_PER_HOUR 要填 1～60 的整数/);
  }
});

test("MCP_SERVERS：不配时没有 MCP 服务；配了 aiops 时默认开 20 个只读工具（含 promote_case），令牌从 MCP_AIOPS_TOKEN 读", () => {
  assert.deepEqual(loadConfig(base).mcp, []);
  const [aiops, ...rest] = loadConfig({ ...base, MCP_SERVERS: " aiops=https://aiops.example.com/mcp ", MCP_AIOPS_TOKEN: " t0k " }).mcp;
  assert.equal(rest.length, 0);
  assert.equal(aiops.name, "aiops");
  assert.equal(aiops.url, "https://aiops.example.com/mcp");
  assert.equal(aiops.token, "t0k");
  assert.deepEqual(aiops.tools, AIOPS_DEFAULT_TOOLS);
  assert.equal(aiops.tools.length, 20);
  assert.ok(aiops.tools.includes("find_service"));
  // promote_case 只生成经验草稿、不落库，模型能直接用；真正写经验库要走确认卡片
  assert.ok(aiops.tools.includes("promote_case"));
  assert.deepEqual(aiops.writeTools, []);
  assert.ok(!(aiops.tools as readonly string[]).includes("save_lesson"));
  assert.ok(!(aiops.tools as readonly string[]).includes("archive_lesson"));
  assert.equal(aiops.timeoutsMs.diagnose_service, 120_000);
  assert.equal(aiops.labels.diagnose_service, "诊断");
  // 默认的使用说明文件在项目里
  assert.equal(aiops.promptFile, path.resolve("prompts", "mcp", "aiops.md"));
  assert.ok(existsSync(aiops.promptFile));
});

test("MCP 服务的工具名单、写工具、说明文件都能用 MCP_<名字>_ 开头的变量改", () => {
  const [aiops, other] = loadConfig({
    ...base,
    MCP_SERVERS: "aiops=https://aiops.example.com/mcp,Other=http://10.0.0.5:8080/mcp",
    MCP_AIOPS_TOOLS: "diagnose_service, get_dashboard",
    MCP_AIOPS_WRITE_TOOLS: "get_dashboard",
    MCP_AIOPS_PROMPT: "custom/aiops.md",
    MCP_OTHER_TOOLS: "*",
  }).mcp;
  assert.deepEqual(aiops.tools, ["diagnose_service", "get_dashboard"]);
  assert.deepEqual(aiops.writeTools, ["get_dashboard"]);
  assert.equal(aiops.promptFile, path.resolve("custom/aiops.md"));
  assert.equal(aiops.thinking, true);
  assert.equal(loadConfig({ ...base, MCP_SERVERS: "aiops=https://a.example.com/mcp", MCP_AIOPS_THINKING: "off" }).mcp[0].thinking, false);
  assert.throws(() => loadConfig({ ...base, MCP_SERVERS: "aiops=https://a.example.com/mcp", MCP_AIOPS_THINKING: "yes" }), /MCP_AIOPS_THINKING 只能是 on 或 off/);
  assert.equal(other.name, "other");
  assert.equal(other.tools, "*");
  assert.equal(other.token, undefined);
  assert.deepEqual(other.timeoutsMs, {});
});

test("MCP_SERVERS 写错时报错：格式不对、名字重复、地址带令牌、别的服务没写开哪些工具", () => {
  assert.throws(() => loadConfig({ ...base, MCP_SERVERS: "https://aiops.example.com/mcp" }), /名字=地址/);
  assert.throws(() => loadConfig({ ...base, MCP_SERVERS: "ai-ops=https://a.example.com/mcp" }), /名字只用字母和数字/);
  assert.throws(() => loadConfig({ ...base, MCP_SERVERS: "aiops=aiops.example.com" }), /完整地址/);
  assert.throws(() => loadConfig({ ...base, MCP_SERVERS: "aiops=ftp://a.example.com" }), /http 或 https/);
  assert.throws(() => loadConfig({ ...base, MCP_SERVERS: "aiops=https://a/mcp,AIOPS=https://b/mcp" }), /aiops 写了两次/);
  assert.throws(() => loadConfig({ ...base, MCP_SERVERS: "aiops=https://a.example.com/mcp?t=secret" }), /带了令牌.*MCP_AIOPS_TOKEN/);
  assert.throws(() => loadConfig({ ...base, MCP_SERVERS: "aiops=https://user:pw@a.example.com/mcp" }), /带了令牌/);
  assert.throws(() => loadConfig({ ...base, MCP_SERVERS: "grafana=https://g.example.com/mcp" }), /MCP_GRAFANA_TOOLS/);
  assert.throws(() => loadConfig({ ...base, MCP_SERVERS: "aiops=https://a/mcp", MCP_AIOPS_TOOLS: "a b" }), /MCP_AIOPS_TOOLS.*a b/);
  assert.throws(() => loadConfig({ ...base, MCP_SERVERS: "aiops=https://a/mcp", MCP_AIOPS_TOOLS: " , " }), /MCP_AIOPS_TOOLS 里没有工具名/);
  assert.throws(() => loadConfig({ ...base, MCP_SERVERS: "code=https://a/mcp", MCP_CODE_TOOLS: "*" }), /和内置工具的前缀（code_）重了/);
  for (const param of ["api_key", "signature", "X-Amz-Signature", "authToken", "access_key", "sig", "credential"]) {
    assert.throws(() => loadConfig({ ...base, MCP_SERVERS: `aiops=https://a.example.com/mcp?${param}=x` }), /带了令牌/, param);
  }
  // 参数名里只是含有 key 这几个字母的不算令牌
  assert.equal(loadConfig({ ...base, MCP_SERVERS: "aiops=https://a.example.com/mcp?monkey=1" }).mcp[0].url, "https://a.example.com/mcp?monkey=1");
});

test("团队经验库：默认打开，表记在 data/knowledge 下，百炼上用 text-embedding-v4；可以指定多维表格、换或关掉向量模型、整个关掉", () => {
  assert.deepEqual(loadConfig(base).knowledge, {
    stateFile: path.resolve("data", "knowledge", "bitable.json"),
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
  });
  assert.equal(loadConfig({ ...base, KNOWLEDGE: "off" }).knowledge, undefined);
  assert.equal(loadConfig({ ...base, KNOWLEDGE: " ON " }).knowledge?.embeddingModel, "text-embedding-v4");
  assert.throws(() => loadConfig({ ...base, KNOWLEDGE: "false" }), /KNOWLEDGE 只能是 on 或 off/);

  const custom = loadConfig({
    ...base,
    DATA_DIR: "/srv/agenttag",
    KNOWLEDGE_BITABLE: "https://example.feishu.cn/base/AbC123?table=tblX1&view=vew1",
    KNOWLEDGE_EMBEDDING_MODEL: "text-embedding-v3",
  }).knowledge;
  assert.deepEqual(custom, {
    bitable: { appToken: "AbC123", tableId: "tblX1", url: "https://example.feishu.cn/base/AbC123?table=tblX1" },
    stateFile: "/srv/agenttag/knowledge/bitable.json",
    embeddingModel: "text-embedding-v3",
  });
  assert.throws(() => loadConfig({ ...base, KNOWLEDGE_BITABLE: "https://example.feishu.cn/base/AbC123" }), /KNOWLEDGE_BITABLE/);
  assert.equal(loadConfig({ ...base, KNOWLEDGE_EMBEDDING_MODEL: "off" }).knowledge?.embeddingModel, undefined);
  // 别家模型服务不知道有什么向量模型，不配就只按关键词
  assert.equal(loadConfig({ ...base, MODEL_BASE_URL: "https://llm.example.com/v1" }).knowledge?.embeddingModel, undefined);
  // knowledge_ 是经验库工具的前缀，MCP 服务不能叫这个名字
  assert.throws(() => loadConfig({ ...base, MCP_SERVERS: "knowledge=https://kb.example.com/mcp", MCP_KNOWLEDGE_TOOLS: "*" }), /和内置工具的前缀/);
});

test("更新通知：默认开，发到白名单里的所有群；ANNOUNCE_CHAT_IDS 只能是白名单里的群", () => {
  const allowed = { ...base, FEISHU_ALLOWED_CHAT_IDS: "oc_a, oc_b" };
  const config = loadConfig(allowed);
  assert.deepEqual(config.announce?.chatIds, ["oc_a", "oc_b"]);
  assert.equal(config.announce?.link, undefined);
  assert.equal(config.announce?.stateFile, path.resolve("data", "announce", "state.json"));
  assert.equal(config.announce?.chatIdsFrom, "FEISHU_ALLOWED_CHAT_IDS");
  assert.ok(existsSync(config.announce!.notesFile), "RELEASE_NOTES.md 在项目根目录");
  assert.ok(existsSync(config.announce!.changelogFile), "CHANGELOG.md 在项目根目录");

  const listed = loadConfig({ ...allowed, ANNOUNCE_CHAT_IDS: "oc_b,oc_b" }).announce;
  assert.deepEqual(listed?.chatIds, ["oc_b"]);
  assert.equal(listed?.chatIdsFrom, "ANNOUNCE_CHAT_IDS");
  assert.throws(() => loadConfig({ ...allowed, ANNOUNCE_CHAT_IDS: "oc_b,oc_x" }), /ANNOUNCE_CHAT_IDS 里的群 oc_x 不在 FEISHU_ALLOWED_CHAT_IDS 里/);
  assert.equal(loadConfig({ ...allowed, ANNOUNCE: "off" }).announce, undefined);
  assert.equal(loadConfig({ ...allowed, ANNOUNCE: " OFF ", ANNOUNCE_CHAT_IDS: "oc_x" }).announce, undefined);
  assert.throws(() => loadConfig({ ...allowed, ANNOUNCE: "no" }), /ANNOUNCE 只能是 on 或 off/);
  // 白名单为空时没有群可发
  assert.deepEqual(loadConfig(base).announce?.chatIds, []);
});

test("更新通知的「产品功能说明」链接要是 https 地址", () => {
  assert.equal(loadConfig({ ...base, ANNOUNCE_LINK: " https://docs.example.com/agenttag " }).announce?.link, "https://docs.example.com/agenttag");
  assert.throws(() => loadConfig({ ...base, ANNOUNCE_LINK: "http://docs.example.com" }), /ANNOUNCE_LINK 要写成 https/);
  assert.throws(() => loadConfig({ ...base, ANNOUNCE_LINK: "docs.example.com" }), /ANNOUNCE_LINK 要写成 https/);
  // 更新通知关掉时，有人问「你能做什么」照样附这个链接
  const off = loadConfig({ ...base, ANNOUNCE: "off", ANNOUNCE_LINK: "https://docs.example.com/agenttag" });
  assert.equal(off.announce, undefined);
  assert.equal(off.featuresLink, "https://docs.example.com/agenttag");
  assert.throws(() => loadConfig({ ...base, ANNOUNCE: "off", ANNOUNCE_LINK: "http://docs.example.com" }), /ANNOUNCE_LINK 要写成 https/);
});

test("更新通知的「文档中心」链接（DOCS_LINK）要是 https 地址，不填就没有", () => {
  const config = loadConfig({ ...base, DOCS_LINK: " https://docs.example.com/center " });
  assert.equal(config.docsLink, "https://docs.example.com/center");
  assert.equal(config.announce?.docsLink, "https://docs.example.com/center");
  assert.equal(loadConfig(base).announce?.docsLink, undefined);
  assert.throws(() => loadConfig({ ...base, DOCS_LINK: "http://docs.example.com" }), /DOCS_LINK 要写成 https/);
  assert.throws(() => loadConfig({ ...base, ANNOUNCE: "off", DOCS_LINK: "docs.example.com" }), /DOCS_LINK 要写成 https/);
});

test("SCHEDULED_TASKS：默认开，记在 DATA_DIR/schedules.json；off 关掉，写错时报错", () => {
  assert.equal(loadConfig(base).schedules?.file, path.resolve("data", "schedules.json"));
  assert.equal(loadConfig({ ...base, DATA_DIR: "/srv/bot" }).schedules?.file, "/srv/bot/schedules.json");
  assert.equal(loadConfig({ ...base, SCHEDULED_TASKS: " OFF " }).schedules, undefined);
  assert.throws(() => loadConfig({ ...base, SCHEDULED_TASKS: "yes" }), /SCHEDULED_TASKS 只能是 on 或 off/);
});

const groupBase = {
  ...base,
  FEISHU_ALLOWED_CHAT_IDS: "oc_test,oc_ops,oc_other",
  GITLAB_URL: "https://lab.corp",
  GITLAB_TOKEN: "t",
  MCP_SERVERS: "aiops=https://aiops.example.com/mcp",
};

test("GROUPS：不配时没有按群的配置；配了的群逐项读 GROUP_<名字>_…，没写的项不读（照全局）", () => {
  assert.deepEqual(loadConfig(base).groups, []);
  const config = loadConfig({
    ...groupBase,
    CODE_REPOS: "ai/aiops-mcp@aiops,ai/agent-tag",
    WRITE_ALLOWED_USERS: "ou_ml",
    GROUPS: " test=oc_test , Ops=oc_ops ",
    GROUP_TEST_CODE_REPOS: "golang/*, php/gateway@master",
    GROUP_TEST_WRITE_ALLOWED_USERS: "ou_a, ou_b",
    GROUP_TEST_MEMORY_EDITORS: "none",
    GROUP_TEST_MCP: "aiops",
    GROUP_TEST_MCP_AIOPS_TOOLS: "diagnose_service, find_service",
    GROUP_TEST_KNOWLEDGE: "off",
    // 和群配置无关的变量不管
    GROUP_ID: "1000",
  });
  const [test, ops] = config.groups;
  assert.equal(test.name, "test");
  assert.equal(test.chatId, "oc_test");
  assert.deepEqual(test.codeRepos, ["golang/*", "php/gateway"]);
  assert.deepEqual(test.writeAllowedUsers, new Set(["ou_a", "ou_b"]));
  assert.deepEqual(test.memoryEditors, new Set());
  assert.deepEqual(test.mcp, new Map([["aiops", ["diagnose_service", "find_service"]]]));
  assert.equal(test.knowledge, false);
  assert.deepEqual(ops, { name: "ops", chatId: "oc_ops" });
  // 群里指定的分支和全局的合在一起，全局的仓库清单不变
  assert.deepEqual(config.code?.repos, ["ai/aiops-mcp", "ai/agent-tag"]);
  assert.deepEqual(config.code?.branches, { "ai/aiops-mcp": "aiops", "php/gateway": "master" });
});

test("GROUPS 写错时报错：格式不对、名字或群重复、群不在白名单里", () => {
  assert.throws(() => loadConfig({ ...groupBase, GROUPS: "oc_test" }), /名字=群的 chat_id/);
  assert.throws(() => loadConfig({ ...groupBase, GROUPS: "team-a=oc_test" }), /名字只用字母和数字/);
  assert.throws(() => loadConfig({ ...groupBase, GROUPS: "test=" }), /名字=群的 chat_id/);
  assert.throws(() => loadConfig({ ...groupBase, GROUPS: "test=oc_test,TEST=oc_ops" }), /test 写了两次/);
  assert.throws(() => loadConfig({ ...groupBase, GROUPS: "test=oc_test,ops=oc_test" }), /群 oc_test 写了两次（test 和 ops）/);
  assert.throws(() => loadConfig({ ...groupBase, GROUPS: "x=oc_x" }), /x 的群 oc_x 不在 FEISHU_ALLOWED_CHAT_IDS 里/);
});

test("GROUP_ 变量名写错时报错，不悄悄照全局：群名拼错、项拼错", () => {
  const groups = { ...groupBase, GROUPS: "test=oc_test" };
  assert.throws(() => loadConfig({ ...groups, GROUP_TSET_WRITE_ALLOWED_USERS: "ou_a" }), /GROUP_TSET_WRITE_ALLOWED_USERS 里的群名 tset 不在 GROUPS 里/);
  assert.throws(() => loadConfig({ ...groups, GROUP_TEST_CODE_REPO: "ai/x" }), /GROUP_TEST_CODE_REPO 不认识/);
  // 小写、大小写混着写的变量程序读不到，也要报错
  assert.throws(() => loadConfig({ ...groups, GROUP_test_MEMORY_EDITORS: "none" }), /GROUP_test_MEMORY_EDITORS 要写成全大写的 GROUP_TEST_MEMORY_EDITORS/);
  assert.throws(() => loadConfig({ ...groups, GROUP_TEST_mcp: "off" }), /要写成全大写的 GROUP_TEST_MCP/);
  assert.throws(() => loadConfig({ ...groups, Group_Ops_Write_Allowed_Users: "ou_a" }), /要写成全大写的 GROUP_OPS_WRITE_ALLOWED_USERS/);
  // 和按群配置不沾边的 GROUP_ 变量不管
  assert.equal(loadConfig({ ...groups, group_id: "x", GROUP_build_NUMBER: "3" }).groups.length, 1);
  assert.throws(() => loadConfig({ ...base, GROUP_OPS_MCP: "off" }), /群名 ops 不在 GROUPS 里/);
  // 空的当没写
  assert.deepEqual(loadConfig({ ...groups, GROUP_TSET_CODE_REPOS: " " }).groups, [{ name: "test", chatId: "oc_test" }]);
});

test("GROUP_<名字>_CODE_REPOS：off 是不开代码；GitLab 能写 group/*；只有群里配了仓库时也接代码仓库", () => {
  const off = loadConfig({ ...groupBase, CODE_REPOS: "ai/agent-tag", GROUPS: "test=oc_test", GROUP_TEST_CODE_REPOS: "OFF" });
  assert.deepEqual(off.groups[0].codeRepos, []);
  const only = loadConfig({ ...groupBase, GROUPS: "test=oc_test", GROUP_TEST_CODE_REPOS: "ai/*" });
  assert.deepEqual(only.code?.repos, []);
  assert.deepEqual(only.groups[0].codeRepos, ["ai/*"]);
  assert.deepEqual(only.code?.host, { kind: "gitlab", url: "https://lab.corp", token: "t" });
  assert.deepEqual(loadConfig({ ...groupBase, CODE_REPOS: "ai/tools/*" }).code?.repos, ["ai/tools/*"]);
});

test("仓库清单写错时报错：通配带分支、GitHub 写通配、* 不在最后、同一个仓库两处分支不一样、群里配了仓库却没配 GitLab", () => {
  const groups = { ...groupBase, GROUPS: "test=oc_test" };
  assert.throws(() => loadConfig({ ...groups, GROUP_TEST_CODE_REPOS: "ai/*@master" }), /通配的不能指定分支/);
  assert.throws(() => loadConfig({ ...base, CODE_REPOS: "acme/*", GITHUB_TOKEN: "g" }), /通配只支持 GitLab/);
  assert.throws(() => loadConfig({ ...groups, GROUP_TEST_CODE_REPOS: "ai/*/x" }), /项目路径/);
  assert.throws(() => loadConfig({ ...groups, GROUP_TEST_CODE_REPOS: "a*/x/*" }), /通配要写成 group\/\*/);
  assert.throws(
    () => loadConfig({ ...groups, CODE_REPOS: "ai/x@master", GROUP_TEST_CODE_REPOS: "AI/x@uat" }),
    /GROUP_TEST_CODE_REPOS 里 AI\/x 指定的分支 uat 和别处写的 master 不一样/,
  );
  // 两处写的一样没关系
  assert.deepEqual(loadConfig({ ...groups, CODE_REPOS: "ai/x@master", GROUP_TEST_CODE_REPOS: "ai/x@master" }).code?.branches, { "ai/x": "master" });
  assert.throws(
    () => loadConfig({ ...base, FEISHU_ALLOWED_CHAT_IDS: "oc_test", GROUPS: "test=oc_test", GROUP_TEST_CODE_REPOS: "ai/x" }),
    /配了 GROUP_TEST_CODE_REPOS 就要配 GITLAB_URL 和 GITLAB_TOKEN/,
  );
});

test("GROUP_<名字>_WRITE_ALLOWED_USERS、MEMORY_EDITORS：none 是谁都不能，写的要是 open_id；全局 MEMORY_EDITORS 不配时谁都能改群记忆", () => {
  const groups = { ...groupBase, GROUPS: "test=oc_test" };
  assert.deepEqual(loadConfig({ ...groups, GROUP_TEST_WRITE_ALLOWED_USERS: "None" }).groups[0].writeAllowedUsers, new Set());
  assert.throws(() => loadConfig({ ...groups, GROUP_TEST_WRITE_ALLOWED_USERS: "赵作武" }), /GROUP_TEST_WRITE_ALLOWED_USERS 要填飞书用户的 open_id.*赵作武/);
  assert.throws(() => loadConfig({ ...groups, GROUP_TEST_MEMORY_EDITORS: "ou_a,someone" }), /GROUP_TEST_MEMORY_EDITORS.*someone/);
  assert.equal(loadConfig(base).feishu.memoryEditors, undefined);
  assert.deepEqual(loadConfig({ ...base, MEMORY_EDITORS: "ou_a, ou_b" }).feishu.memoryEditors, new Set(["ou_a", "ou_b"]));
  assert.throws(() => loadConfig({ ...base, MEMORY_EDITORS: "x" }), /MEMORY_EDITORS 要填飞书用户的 open_id/);
});

test("GROUP_<名字>_MCP：off 是不能用；只写工具时其他服务照全局；工具只能在全局开了的里挑", () => {
  const groups = { ...groupBase, MCP_SERVERS: "aiops=https://a.example.com/mcp,other=https://b.example.com/mcp", MCP_OTHER_TOOLS: "*", GROUPS: "test=oc_test" };
  assert.equal(loadConfig(groups).groups[0].mcp, undefined);
  assert.deepEqual(loadConfig({ ...groups, GROUP_TEST_MCP: "off" }).groups[0].mcp, new Map());
  assert.deepEqual(loadConfig({ ...groups, GROUP_TEST_MCP: "Other" }).groups[0].mcp, new Map([["other", "*"]]));
  assert.deepEqual(
    loadConfig({ ...groups, GROUP_TEST_MCP_AIOPS_TOOLS: "query_logs" }).groups[0].mcp,
    new Map<string, readonly string[] | "*">([
      ["aiops", ["query_logs"]],
      ["other", "*"],
    ]),
  );
  // 全局是 * 的服务，按群写什么工具名都行（服务端有没有到连上时才知道）
  assert.deepEqual(loadConfig({ ...groups, GROUP_TEST_MCP_OTHER_TOOLS: "anything" }).groups[0].mcp?.get("other"), ["anything"]);
  assert.throws(() => loadConfig({ ...groups, GROUP_TEST_MCP: "grafana" }), /GROUP_TEST_MCP 里的 grafana 不在 MCP_SERVERS 里/);
  assert.throws(() => loadConfig({ ...groups, GROUP_TEST_MCP_AIOPS_TOOLS: "save_lesson" }), /save_lesson 全局没开（MCP_AIOPS_TOOLS）/);
  assert.throws(() => loadConfig({ ...groups, GROUP_TEST_MCP: "other", GROUP_TEST_MCP_AIOPS_TOOLS: "query_logs" }), /不在这个群能用的服务里/);
  assert.throws(() => loadConfig({ ...groups, GROUP_TEST_MCP: "off", GROUP_TEST_MCP_AIOPS_TOOLS: "query_logs" }), /GROUP_TEST_MCP=off/);
  assert.throws(() => loadConfig({ ...groups, GROUP_TEST_MCP_GRAFANA_TOOLS: "x" }), /不在这个群能用的服务里/);
});

test("GROUP_<名字>_KNOWLEDGE：off 是这个群不用经验库；全局关着时群里开不了", () => {
  const groups = { ...groupBase, GROUPS: "test=oc_test" };
  assert.equal(loadConfig({ ...groups, GROUP_TEST_KNOWLEDGE: "OFF" }).groups[0].knowledge, false);
  assert.equal(loadConfig({ ...groups, GROUP_TEST_KNOWLEDGE: "on" }).groups[0].knowledge, true);
  assert.throws(() => loadConfig({ ...groups, KNOWLEDGE: "off", GROUP_TEST_KNOWLEDGE: "on" }), /全局 KNOWLEDGE=off/);
  assert.throws(() => loadConfig({ ...groups, GROUP_TEST_KNOWLEDGE: "yes" }), /GROUP_TEST_KNOWLEDGE 只能是 on 或 off/);
});
