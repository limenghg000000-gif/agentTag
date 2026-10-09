import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { CallToolResult, Tool as RemoteTool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "../src/config.js";
import { AiopsLessons } from "../src/knowledge-aiops.js";
import { isWriteTool, MAX_MCP_CALLS_PER_TASK, MAX_MCP_CHARS_PER_TASK, McpHub } from "../src/mcp.js";
import { MCP_RESULT_LIMIT } from "../src/mcp-result.js";
import { type FakeMcp, freePort, startFakeMcp } from "./helpers/fake-mcp.js";

const TOKEN = "tok_secret_123";
const INSTRUCTIONS = "服务级问题先调 diagnose_service，再补查 1～3 次。";
const dir = await mkdtemp(path.join(tmpdir(), "agenttag-mcp-"));
const promptFile = path.join(dir, "aiops.md");
await writeFile(promptFile, "<!-- 给维护的人看的 -->\n- 群里回答要短。\n");
after(() => rm(dir, { recursive: true, force: true }));

const servers: FakeMcp[] = [];
const hubs: McpHub[] = [];
after(async () => {
  await Promise.all(hubs.map((hub) => hub.stop()));
  await Promise.all(servers.map((server) => server.close()));
});

function remoteTool(name: string, description: string, properties: Record<string, object> = {}): RemoteTool {
  return { name, description, inputSchema: { type: "object", properties }, annotations: { readOnlyHint: true } };
}

const TOOLS: RemoteTool[] = [
  remoteTool("diagnose_service", "一键排查服务问题", {
    workload: { type: "string", description: "服务名" },
    namespace: { type: "string" },
    scenario: { type: "string", enum: ["resource", "slow_api", "error_log", "overview"] },
  }),
  remoteTool("query_logs", "LogQL 查日志", { logql: { type: "string" } }),
  remoteTool("get_active_alerts", "活跃告警"),
  remoteTool("get_targets_health", "采集目标健康"),
  remoteTool("save_lesson", "沉淀经验", { title: { type: "string" } }),
  remoteTool("archive_lesson", "归档经验", { id: { type: "number" } }),
];

const text = (value: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });

async function fake(options: Partial<Parameters<typeof startFakeMcp>[0]> = {}) {
  const server = await startFakeMcp({ token: TOKEN, instructions: INSTRUCTIONS, tools: [...TOOLS], ...options });
  servers.push(server);
  return server;
}

function config(url: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "aiops",
    url,
    token: TOKEN,
    tools: ["diagnose_service", "query_logs", "get_active_alerts"],
    writeTools: [],
    promptFile,
    timeoutsMs: {},
    labels: { diagnose_service: "诊断", query_logs: "查日志" },
    ...overrides,
  };
}

function recorder() {
  const lines: { level: string; text: string }[] = [];
  const logger = {
    info: (...args: unknown[]) => lines.push({ level: "info", text: args.map(String).join(" ") }),
    warn: (...args: unknown[]) => lines.push({ level: "warn", text: args.map(String).join(" ") }),
    error: (...args: unknown[]) => lines.push({ level: "error", text: args.map(String).join(" ") }),
  };
  return { lines, logger, find: (pattern: RegExp) => lines.find((line) => pattern.test(line.text)) };
}

async function hubFor(configs: McpServerConfig[], options: ConstructorParameters<typeof McpHub>[1] = {}) {
  const hub = new McpHub(configs, { busyRetryMs: [1, 1], ...options });
  hubs.push(hub);
  await hub.start();
  return hub;
}

const task = { chatId: "oc_1", senderId: "ou_1", messageId: "om_1" };
const signal = new AbortController().signal;
const toolOf = (hub: McpHub, name: string) => {
  const tool = hub.tools(task).find((t) => t.spec.name === name);
  assert.ok(tool, `没有 ${name}`);
  return tool;
};

test("连上后拉到工具清单和使用说明：只开名单里的只读工具，名字加前缀，说明和参数照搬服务端", async () => {
  const server = await fake();
  const log = recorder();
  const hub = await hubFor([config(server.url, { tools: ["diagnose_service", "query_logs", "save_lesson", "no_such_tool"] })], {
    logger: log.logger,
  });

  const tools = hub.tools(task);
  assert.deepEqual(
    tools.map((tool) => tool.spec.name),
    ["aiops_diagnose_service", "aiops_query_logs"],
  );
  assert.equal(tools[0].spec.description, "一键排查服务问题");
  assert.deepEqual(tools[0].spec.parameters, TOOLS[0].inputSchema);
  assert.ok(tools.every((tool) => !tool.writes));

  const connected = log.find(/MCP aiops：已连上/);
  assert.equal(connected?.level, "info");
  assert.match(connected!.text, /服务端 6 个工具，开了 2 个/);
  assert.match(connected!.text, /fake-aiops 0\.14\.0/);
  assert.match(connected!.text, new RegExp(`服务端使用说明 ${INSTRUCTIONS.length} 字`));
  assert.match(log.find(/没开/)!.text, /get_active_alerts, get_targets_health, archive_lesson（要开就加进 MCP_AIOPS_TOOLS）/);
  assert.equal(log.find(/save_lesson 会写东西/)?.level, "warn");
  assert.equal(log.find(/no_such_tool 服务端没有/)?.level, "warn");
  assert.ok(log.lines.every((line) => !line.text.includes(TOKEN)), "日志里不能有令牌");
});

test("开了 aiops 工具的任务，提示词里带上服务端的使用说明和飞书补充说明；没带它的工具时不提", async () => {
  const server = await fake();
  const hub = await hubFor([config(server.url)], { logger: recorder().logger });

  const prompt = hub.prompt(["web_search", ...hub.tools(task).map((tool) => tool.spec.name)]);
  assert.ok(prompt);
  assert.match(prompt, /## aiops（MCP 服务）/);
  assert.match(prompt, /在你这里都带 aiops_ 前缀（aiops_diagnose_service）/);
  assert.match(prompt, new RegExp(INSTRUCTIONS));
  assert.match(prompt, /群里回答要短/);
  assert.doesNotMatch(prompt, /给维护的人看的/);
  assert.equal(hub.prompt(["web_search"]), undefined);
});

test("调用：JSON 去掉缩进，summary 挪到最前；审计日志记下提问人、群、工具、参数、结果大小和用时", async () => {
  const report = { namespace: "prod", workload: "gateway-api", findings: { logs: { total: 3 } }, summary: "日志: 发现 3 条错误" };
  const server = await fake({ call: () => text(JSON.stringify(report, null, 2)) });
  const log = recorder();
  const hub = await hubFor([config(server.url)], { logger: log.logger });
  const tool = toolOf(hub, "aiops_diagnose_service");

  const output = await tool.run({ workload: "gateway-api", scenario: "error_log" }, { signal });

  assert.equal(output, JSON.stringify({ summary: report.summary, namespace: "prod", workload: "gateway-api", findings: report.findings }));
  assert.deepEqual(server.calls, [{ name: "diagnose_service", args: { workload: "gateway-api", scenario: "error_log" } }]);
  const audit = log.find(/MCP 调用 aiops\.diagnose_service/);
  assert.equal(audit?.level, "info");
  assert.match(
    audit!.text,
    /chat=oc_1 sender=ou_1 message=om_1 参数=\{"workload":"gateway-api","scenario":"error_log"\} 结果=\d+字→\d+字 用时=\d+ms$/,
  );
  assert.equal(tool.describe({ workload: "gateway-api", namespace: "prod", scenario: "error_log" }), "aiops · 诊断 gateway-api（prod，error_log）");
  assert.equal(toolOf(hub, "aiops_get_active_alerts").describe({}), "aiops · get_active_alerts");
});

test("服务端返回 isError 时把错误原文交给模型，审计日志记成出错", async () => {
  const server = await fake({ call: () => text("LogQL 语法错误：缺少 }", true) });
  const log = recorder();
  const hub = await hubFor([config(server.url)], { logger: log.logger });

  await assert.rejects(toolOf(hub, "aiops_query_logs").run({ logql: "{app=" }, { signal }), /aiops 返回错误：LogQL 语法错误：缺少 }/);
  assert.equal(log.find(/MCP 调用 aiops\.query_logs/)?.level, "warn");
  assert.match(log.find(/MCP 调用 aiops\.query_logs/)!.text, /出错/);
});

test("程序自己调用（经验库检索和同步）：没开给模型的工具也能调，审计日志注明是程序调用；工具报错、没有这个工具时抛错", async () => {
  const server = await fake({ call: (name) => (name === "archive_lesson" ? text("经验 #9 不存在", true) : text(JSON.stringify({ saved: true, id: 31 }))) });
  const log = recorder();
  const hub = await hubFor([config(server.url)], { logger: log.logger });

  assert.ok(hub.hasTool("aiops", "save_lesson"));
  assert.ok(!hub.hasTool("aiops", "no_such_tool"));
  assert.ok(!hub.hasTool("other", "save_lesson"));
  assert.ok(!hub.tools(task).some((tool) => tool.spec.name === "aiops_save_lesson"), "写工具不给模型");

  assert.equal(await hub.callDirect("aiops", "save_lesson", { title: "t" }, task), JSON.stringify({ saved: true, id: 31 }));
  assert.deepEqual(server.calls.at(-1), { name: "save_lesson", args: { title: "t" } });
  assert.match(log.find(/MCP 调用 aiops\.save_lesson/)!.text, /（程序调用） chat=oc_1 sender=ou_1 .*结果=\d+字/);

  await assert.rejects(hub.callDirect("aiops", "archive_lesson", { id: 9 }, task), /aiops 返回错误：经验 #9 不存在/);
  await assert.rejects(hub.callDirect("aiops", "no_such_tool", {}, task), /aiops 没有 no_such_tool 这个工具/);
  await assert.rejects(hub.callDirect("other", "save_lesson", {}, task), /other 现在连不上/);
});

test("程序自己调用：读的工具要在配置里开了才调（管理员没开 search_knowledge 时回答前不查 aiops 经验库、也不答应同步），写工具不看这个清单；配成 * 的都能调", async () => {
  const lessonTools = [...TOOLS, remoteTool("search_knowledge", "检索经验"), remoteTool("get_knowledge", "经验详情")];
  const server = await fake({ tools: lessonTools, call: () => text(JSON.stringify({ hits: [] })) });
  const quiet = recorder().logger;
  const hub = await hubFor([config(server.url)], { logger: quiet });
  assert.ok(!hub.hasTool("aiops", "get_targets_health"), "服务端有、配置里没开的读工具");
  await assert.rejects(hub.callDirect("aiops", "get_targets_health", {}, task), /aiops 的 get_targets_health 没开（要开就加进 MCP_AIOPS_TOOLS）/);
  assert.ok(hub.hasTool("aiops", "query_logs"));
  assert.ok(hub.hasTool("aiops", "save_lesson") && hub.hasTool("aiops", "archive_lesson"), "写工具由确认卡片把关，不用开给模型");

  const lessons = new AiopsLessons(hub, "aiops", quiet);
  assert.equal(lessons.searchable, false);
  assert.deepEqual(await lessons.search("gateway-api 报 code=8", task), []);
  assert.equal(lessons.lacksWriteTools, true, "再试同步时要用的检索、取详情没开，不答应同步");
  assert.deepEqual(lessons.missingWriteTools, ["search_knowledge", "get_knowledge"]);
  assert.equal(server.calls.length, 0);

  const opened = await hubFor([config(server.url, { tools: ["query_logs", "search_knowledge", "get_knowledge"] })], { logger: quiet });
  assert.equal(new AiopsLessons(opened, "aiops", quiet).writable, true);
  const all = await hubFor([config(server.url, { tools: "*" })], { logger: quiet });
  assert.ok(all.hasTool("aiops", "get_targets_health") && all.hasTool("aiops", "search_knowledge"));
  assert.deepEqual(await new AiopsLessons(all, "aiops", quiet).search("gateway-api 报 code=8", task), []);
  assert.deepEqual(server.calls.map((call) => call.name), ["search_knowledge"]);
});

test("程序自己调用：有 structuredContent 时按它的 JSON 返回，文字部分是给人看的说明也一样；没有文字时也是", async () => {
  const server = await fake({ call: () => ({ content: [], structuredContent: { saved: true, id: 31 } }) });
  const hub = await hubFor([config(server.url)], { logger: recorder().logger });
  assert.equal(await hub.callDirect("aiops", "save_lesson", { title: "t" }, task), JSON.stringify({ saved: true, id: 31 }));

  const both = await fake({ call: () => ({ content: [{ type: "text", text: "已存为经验 #31" }], structuredContent: { saved: true, id: 31 } }) });
  const hub2 = await hubFor([config(both.url)], { logger: recorder().logger });
  assert.equal(await hub2.callDirect("aiops", "save_lesson", { title: "t" }, task), JSON.stringify({ saved: true, id: 31 }));
});

test("报错只放在 structuredContent 里、没有文字时：照样认出服务繁忙去重试，报错和审计日志里带上它", async () => {
  let busy = 1;
  const server = await fake({
    call: (name) =>
      name === "archive_lesson"
        ? { content: [], structuredContent: { error: "经验 #9 不存在" }, isError: true }
        : busy-- > 0
          ? { content: [], structuredContent: { error: "服务繁忙，请稍后重试" }, isError: true }
          : { content: [], structuredContent: { saved: true, id: 31 } },
  });
  const log = recorder();
  const hub = await hubFor([config(server.url)], { logger: log.logger });
  assert.equal(await hub.callDirect("aiops", "save_lesson", { title: "t" }, task), JSON.stringify({ saved: true, id: 31 }));
  assert.equal(server.calls.filter((call) => call.name === "save_lesson").length, 2);
  assert.match(log.find(/MCP 调用 aiops\.save_lesson/)!.text, /繁忙重试=1$/);

  await assert.rejects(hub.callDirect("aiops", "archive_lesson", { id: 9 }, task), /aiops 返回错误：\{"error":"经验 #9 不存在"\}/);
  assert.match(log.find(/MCP 调用 aiops\.archive_lesson/)!.text, /出错 结果=\d+字：\{"error":"经验 #9 不存在"\}/);
});

test("程序自己调用：报错原文里像有密钥时，报错（会列在卡片上）和审计日志里都不带原文；模型调用的报错照常给原文", async () => {
  const leaked = `连接失败：mysql://aiops:${["Correct", "Horse", "Battery9"].join("")}@db:3306/aiops`;
  const server = await fake({ call: () => text(leaked, true) });
  const log = recorder();
  const hub = await hubFor([config(server.url)], { logger: log.logger });

  const err = await hub.callDirect("aiops", "archive_lesson", { id: 9 }, task).then(
    () => assert.fail("应该报错"),
    (error: Error) => error,
  );
  assert.equal(err.message, "aiops 返回错误：（报错原文里像是有密钥，不列出来）");
  const audit = log.find(/MCP 调用 aiops\.archive_lesson/)!.text;
  assert.match(audit, /出错 结果=\d+字：（报错原文里像是有密钥，不列出来）/);
  assert.ok(!audit.includes("CorrectHorse"));

  await assert.rejects(toolOf(hub, "aiops_query_logs").run({ logql: "{app=\"x\"}" }, { signal }), (error: Error) => error.message.includes(leaked));
});

test("服务繁忙时退避重试 2 次；还忙就告诉模型", async () => {
  let busy = 2;
  const server = await fake({
    call: (name) => (name === "get_active_alerts" || busy-- > 0 ? text("服务繁忙，请稍后重试", true) : text('{"items":[]}')),
  });
  const log = recorder();
  const hub = await hubFor([config(server.url)], { logger: log.logger });

  assert.equal(await toolOf(hub, "aiops_query_logs").run({ logql: "{app=\"a\"}" }, { signal }), '{"items":[]}');
  assert.equal(server.calls.length, 3);
  assert.match(log.find(/MCP 调用 aiops\.query_logs/)!.text, /繁忙重试=2$/);

  await assert.rejects(toolOf(hub, "aiops_get_active_alerts").run({}, { signal }), /aiops 服务繁忙（并发满了），重试 2 次还是不行/);
  assert.equal(server.calls.filter((call) => call.name === "get_active_alerts").length, 3);
});

test("aiops 的 query_logs 取满了 limit：结果前面加机器人注，审计日志里记一笔；别的服务同名工具不加", async () => {
  const logs = Array.from({ length: 3 }, () => ({ timestamp: "1791448406000000000", line: "searchV2 fail" }));
  const body = JSON.stringify({ total: 3, query_start: "2026-10-08 15:43:30", query_end: "2026-10-08 16:43:30", logs });
  const server = await fake({ call: () => text(body) });
  const log = recorder();
  const hub = await hubFor([config(server.url)], { logger: log.logger });

  const output = await toolOf(hub, "aiops_query_logs").run({ logql: '{app="a"}', limit: 3 }, { signal });
  assert.match(output, /^（机器人注：这次只拿到最新的 3 条日志：Loki 按 limit=3 取满了。这些日志在 2026-10-08 16:33:26\.000～2026-10-08 16:33:26\.000/);
  assert.ok(output.endsWith(`\n${body}`));
  assert.match(log.find(/MCP 调用 aiops\.query_logs/)!.text, /→\d+字 加了机器人注 用时=/);
  // 没取满不加
  assert.equal(await toolOf(hub, "aiops_query_logs").run({ logql: '{app="a"}', limit: 4 }, { signal }), body);

  const other = await hubFor([config(server.url, { name: "ops" })], { logger: recorder().logger });
  assert.equal(await toolOf(other, "ops_query_logs").run({ logql: '{app="a"}', limit: 3 }, { signal }), body);
});

test("超过工具的时限就报超时，提示缩小范围", async () => {
  const server = await fake({
    call: (_name, _args, abort) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(text("{}")), 5000);
        abort.addEventListener("abort", () => clearTimeout(timer));
      }),
  });
  const hub = await hubFor([config(server.url, { timeoutsMs: { diagnose_service: 100 } })], { logger: recorder().logger });

  await assert.rejects(
    toolOf(hub, "aiops_diagnose_service").run({ workload: "a" }, { signal }),
    /aiops 的 diagnose_service 超时（0\.1 秒没返回）。可以缩小时间范围/,
  );
});

test(`一次任务里最多调 ${MAX_MCP_CALLS_PER_TASK} 次；同样的参数不重复调；失败的调用不复用；换个任务重新计数`, async () => {
  let fail = false;
  const server = await fake({ call: (_name, args) => (fail ? text("出错了", true) : text(JSON.stringify({ echo: args }))) });
  const hub = await hubFor([config(server.url)], { logger: recorder().logger });

  // 参数顺序不同也算同样的调用
  const tools = hub.tools(task);
  const logs = tools.find((t) => t.spec.name === "aiops_query_logs")!;
  const first = await logs.run({ logql: "q", limit: 20 }, { signal });
  const again = await logs.run({ limit: 20, logql: "q" }, { signal });
  assert.equal(server.calls.length, 1);
  assert.equal(again, `（这次任务里已经用同样的参数调过 query_logs，没有再调，下面是 0 秒前那次的结果）\n${first}`);

  fail = true;
  await assert.rejects(logs.run({ logql: "bad" }, { signal }));
  fail = false;
  await logs.run({ logql: "bad" }, { signal });
  assert.equal(server.calls.length, 3);

  for (let i = 3; i < MAX_MCP_CALLS_PER_TASK; i++) {
    await logs.run({ logql: `q${i}` }, { signal });
  }
  assert.equal(server.calls.length, MAX_MCP_CALLS_PER_TASK);
  const alerts = tools.find((t) => t.spec.name === "aiops_get_active_alerts")!;
  await assert.rejects(alerts.run({}, { signal }), /已经调了 10 次，到上限了，这次没有执行/);
  assert.equal(server.calls.length, MAX_MCP_CALLS_PER_TASK);

  await toolOf(hub, "aiops_get_active_alerts").run({}, { signal });
  assert.equal(server.calls.length, MAX_MCP_CALLS_PER_TASK + 1);
});

test("一次任务里结果的总字数快用完时，后面的结果截得更短", async () => {
  const big = JSON.stringify({ items: Array.from({ length: 2000 }, (_, i) => `第 ${i} 行日志 ${"x".repeat(40)}`) });
  const server = await fake({ call: () => text(big) });
  const hub = await hubFor([config(server.url)], { logger: recorder().logger });
  const logs = hub.tools(task).find((t) => t.spec.name === "aiops_query_logs")!;

  const sizes: number[] = [];
  for (let i = 0; i < 8; i++) {
    sizes.push((await logs.run({ logql: `q${i}` }, { signal })).length);
  }
  assert.ok(sizes[0] > 15_000 && sizes[0] <= MCP_RESULT_LIMIT, `${sizes[0]}`);
  assert.ok(sizes.at(-1)! <= 6000, `${sizes.at(-1)}`);
  assert.ok(sizes.reduce((a, b) => a + b, 0) <= MAX_MCP_CHARS_PER_TASK + 6000);
});

test("同一轮并行调用时先占住字数，加起来也不超过一次任务的总字数", async () => {
  const big = JSON.stringify({ items: Array.from({ length: 2000 }, (_, i) => `第 ${i} 行日志 ${"x".repeat(40)}`) });
  const server = await fake({ call: () => text(big) });
  const hub = await hubFor([config(server.url)], { logger: recorder().logger });
  const logs = hub.tools(task).find((t) => t.spec.name === "aiops_query_logs")!;

  const results = await Promise.all(Array.from({ length: MAX_MCP_CALLS_PER_TASK }, (_, i) => logs.run({ logql: `q${i}` }, { signal })));
  const total = results.reduce((sum, result) => sum + result.length, 0);
  // 前 6 个各占 24000 字，第 7 个占到 15 万；后面 3 个每个最少还给 6000 字。不先占的话 10 个都按 24000 字截
  assert.ok(total <= MAX_MCP_CHARS_PER_TASK + 3 * 6000, `${total}`);
  assert.equal(results.filter((result) => result.length <= 6000).length, 4);
});

test("调用遇到 HTTP 404 时马上重连一次，不等定时刷新", async () => {
  const server = await fake();
  const log = recorder();
  let clock = 0;
  const hub = await hubFor([config(server.url)], { logger: log.logger, retryMs: [60_000], now: () => clock });
  const tool = toolOf(hub, "aiops_get_active_alerts");
  server.token = "tok_rotated_789";
  // 两次重连至少隔 30 秒
  clock += 30_000;

  await assert.rejects(tool.run({}, { signal }), /拒绝了请求（HTTP 404）：可能是机器人配置的 aiops 令牌或地址不对/);
  for (let i = 0; i < 100 && !log.find(/刷新失败/); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(log.find(/MCP aiops 刷新失败/)!.text, /HTTP 404，令牌或地址不对.*先沿用上次的工具清单/);
  // 刷新失败也沿用上次的清单
  assert.equal(hub.tools(task).length, 3);
});

test("离上次连接不到 30 秒时调用出错，等满 30 秒再重连，不丢掉这次重连", async () => {
  const server = await fake();
  const log = recorder();
  let clock = 0;
  const hub = await hubFor([config(server.url)], { logger: log.logger, retryMs: [60_000], now: () => clock });
  const tool = toolOf(hub, "aiops_get_active_alerts");
  server.token = "tok_rotated_789";
  clock += 30_000 - 50;

  await assert.rejects(tool.run({}, { signal }), /HTTP 404/);
  assert.equal(log.find(/刷新失败/), undefined);
  for (let i = 0; i < 100 && !log.find(/刷新失败/); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(log.find(/MCP aiops 刷新失败/)!.text, /HTTP 404，令牌或地址不对/);
});

test("停止任务时中止进行中的调用", async () => {
  let reached!: () => void;
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  const server = await fake({
    call: (_name, _args, abort) =>
      new Promise((resolve) => {
        reached();
        const timer = setTimeout(() => resolve(text("{}")), 5000);
        abort.addEventListener("abort", () => clearTimeout(timer));
      }),
  });
  const log = recorder();
  const hub = await hubFor([config(server.url)], { logger: log.logger });
  const controller = new AbortController();

  const run = toolOf(hub, "aiops_diagnose_service").run({ workload: "a" }, { signal: controller.signal });
  await arrived;
  controller.abort();

  await assert.rejects(run);
  assert.match(log.find(/MCP 调用 aiops\.diagnose_service/)!.text, /已停止/);
});

test("服务端回 SSE 时也能读", async () => {
  const server = await fake({ json: false, call: () => text('{"ok":true}') });
  const hub = await hubFor([config(server.url)], { logger: recorder().logger });

  assert.equal(await toolOf(hub, "aiops_get_active_alerts").run({}, { signal }), '{"ok":true}');
});

test("连不上不影响启动，提示词里说明连不上；之后自动重试连上", async () => {
  const port = await freePort();
  const log = recorder();
  const hub = await hubFor([config(`http://127.0.0.1:${port}/mcp`)], { logger: log.logger, retryMs: [50] });

  assert.deepEqual(hub.tools(task), []);
  assert.ok(!hub.connected("aiops"), "还没连上");
  assert.match(hub.prompt([]) ?? "", /aiops 现在连不上（程序在自动重连），这次没有 aiops_ 开头的工具/);
  assert.equal(log.find(/MCP aiops 连不上/)?.level, "warn");
  assert.match(log.find(/MCP aiops 连不上/)!.text, /0\.05 秒后重试；机器人照常运行，这期间没有 aiops 的工具/);

  const server = await fake({ port });
  for (let i = 0; i < 100 && hub.tools(task).length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(hub.tools(task).length, 3);
  assert.ok(hub.connected("aiops"));
  assert.ok(!hub.connected("other"));
  assert.ok(log.find(/MCP aiops：已连上/));
  assert.ok(server.initializes >= 1);
});

test("连上了但一个工具都没开时，提示词里也说明，免得模型凭空回答", async () => {
  const server = await fake();
  const hub = await hubFor([config(server.url, { tools: ["no_such_tool"] })], { logger: recorder().logger });

  assert.deepEqual(hub.tools(task), []);
  assert.match(hub.prompt([]) ?? "", /aiops 连上了，但一个工具都没开（管理员在 MCP_AIOPS_TOOLS 里配置），这次没有 aiops_ 开头的工具/);
});

test("服务端要求按 MCP 任务方式调用的工具不开；工具清单分页重复时算连不上，不一直拉", async () => {
  const report: RemoteTool = { ...remoteTool("build_report", "生成报告"), execution: { taskSupport: "required" } };
  const server = await fake({ tools: [...TOOLS, report] });
  const log = recorder();
  const hub = await hubFor([config(server.url, { tools: ["query_logs", "build_report"] })], { logger: log.logger });
  assert.deepEqual(
    hub.tools(task).map((tool) => tool.spec.name),
    ["aiops_query_logs"],
  );
  assert.equal(log.find(/build_report 只能按 MCP 任务（tasks）方式调用/)?.level, "warn");
  // 程序直接调用也不认它：经验库不会以为能同步，卡片上不答应
  assert.ok(!hub.hasTool("aiops", "build_report"));
  await assert.rejects(hub.callDirect("aiops", "build_report", {}, task), /aiops 没有 build_report 这个工具/);

  let pages = 0;
  const looping = await fake({
    list: () => {
      pages++;
      return { tools: [], nextCursor: "same" };
    },
  });
  const loopLog = recorder();
  const loopHub = await hubFor([config(looping.url)], { logger: loopLog.logger, retryMs: [60_000] });
  assert.deepEqual(loopHub.tools(task), []);
  assert.match(loopLog.find(/MCP aiops 连不上/)!.text, /工具清单分页出错/);
  assert.equal(pages, 2);
});

test("有状态的服务端：断开时结束会话；日志里的地址不带查询参数的值", async () => {
  const server = await fake({ stateful: true });
  const log = recorder();
  const hub = await hubFor([config(`${server.url}?region=cn-hz`)], { logger: log.logger });
  assert.equal(hub.tools(task).length, 3);
  assert.equal(server.sessions.size, 1);
  assert.match(log.find(/已连上/)!.text, /\/mcp\?region=…，/);
  assert.ok(log.lines.every((line) => !line.text.includes("cn-hz")));

  await hub.stop();
  assert.equal(server.deleted, 1);
  assert.equal(server.sessions.size, 0);
});

test("令牌不对时（aiops 回 404）按「令牌或地址不对」记日志，日志里没有令牌", async () => {
  const server = await fake();
  const log = recorder();
  const hub = await hubFor([config(server.url, { token: "tok_wrong_456" })], { logger: log.logger, retryMs: [60_000] });

  assert.deepEqual(hub.tools(task), []);
  assert.match(log.find(/MCP aiops 连不上/)!.text, /HTTP 404，令牌或地址不对（检查 MCP_AIOPS_TOKEN 和 MCP_SERVERS 里的地址）/);
  assert.ok(log.lines.every((line) => !line.text.includes("tok_wrong_456") && !line.text.includes(TOKEN)));
});

test("定时刷新：服务端新加的工具列进日志但不自动打开，使用说明换成新的", async () => {
  const server = await fake();
  const log = recorder();
  const hub = await hubFor([config(server.url)], { logger: log.logger, refreshMs: 30 });

  server.tools = [...TOOLS, remoteTool("get_repo_file", "读仓库文件")];
  for (let i = 0; i < 100 && !log.find(/get_repo_file/); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(log.lines.filter((line) => /没开/.test(line.text)).at(-1)!.text, /get_repo_file/);
  assert.deepEqual(
    hub.tools(task).map((tool) => tool.spec.name),
    ["aiops_diagnose_service", "aiops_query_logs", "aiops_get_active_alerts"],
  );
  assert.ok(server.initializes >= 2, "每次刷新都重新 initialize，拿到最新的使用说明");
});

test("MCP_AIOPS_TOOLS=* 开服务端的全部工具，会写东西的和没标成只读的除外", async () => {
  const unmarked: RemoteTool = { name: "get_dashboard", description: "看板", inputSchema: { type: "object", properties: {} } };
  const server = await fake({ tools: [...TOOLS, unmarked] });
  const log = recorder();
  const hub = await hubFor([config(server.url, { tools: "*", writeTools: ["get_targets_health"] })], { logger: log.logger });

  assert.deepEqual(
    hub.tools(task).map((tool) => tool.spec.name),
    ["aiops_diagnose_service", "aiops_query_logs", "aiops_get_active_alerts"],
  );
  assert.match(log.find(/会写东西/)!.text, /get_targets_health, save_lesson, archive_lesson, get_dashboard 会写东西（或服务端没标成只读）/);
});

test("服务端标了 readOnlyHint=false 的工具，点名要开也不开；点名开的工具没有标注时照开", async () => {
  const tools: RemoteTool[] = [
    { ...remoteTool("ack_alert", "确认告警"), annotations: { readOnlyHint: false } },
    { name: "get_dashboard", description: "看板", inputSchema: { type: "object", properties: {} } },
  ];
  const server = await fake({ tools });
  const log = recorder();
  const hub = await hubFor([config(server.url, { tools: ["ack_alert", "get_dashboard"] })], { logger: log.logger });

  assert.deepEqual(
    hub.tools(task).map((tool) => tool.spec.name),
    ["aiops_get_dashboard"],
  );
  assert.equal(log.find(/ack_alert 会写东西/)?.level, "warn");
});

test("会写东西的工具：配置里点名的，加上名字里带写操作动词的", () => {
  for (const name of ["save_lesson", "archive_lesson", "create_annotation", "delete-pod", "restartDeployment", "scale", "silence_alert"]) {
    assert.equal(isWriteTool(name), true, name);
  }
  for (const name of ["diagnose_service", "find_service", "get_active_alerts", "query_metrics_range", "get_asset", "describe_pod", "settings_get"]) {
    assert.equal(isWriteTool(name), false, name);
  }
  assert.equal(isWriteTool("promote_case", ["promote_case"]), true);
});
