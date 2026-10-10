import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMON_SUFFIX, compactText, formatToolResult, MCP_RESULT_LIMIT } from "../src/mcp-result.js";

test("JSON 去掉缩进；summary、warning、hint 挪到最前，其余顺序不变", () => {
  const raw = JSON.stringify({ namespace: "prod", findings: { a: 1 }, hint: "缩小范围", summary: "结论" }, null, 2);
  assert.equal(compactText(raw), '{"summary":"结论","hint":"缩小范围","namespace":"prod","findings":{"a":1}}');
  assert.equal(compactText("[1, 2,\n 3]"), "[1,2,3]");
});

test("短结果原样返回（只去掉首尾空白）", () => {
  assert.equal(compactText("  没有找到  "), "没有找到");
  assert.equal(compactText("{不是 JSON"), "{不是 JSON");
});

test("超长 JSON 按字段截短长字符串和长列表，注明省略了多少；summary 保留，总长不超过上限", () => {
  const logs = Array.from({ length: 300 }, (_, i) => ({ timestamp: String(1783623620513499028n + BigInt(i)), line: `${"错误详情".repeat(400)} #${i}` }));
  const raw = JSON.stringify({ namespace: "prod", findings: { logs: { total: 300, logs } }, summary: "日志: 发现 300 条错误" }, null, 2);

  const out = compactText(raw);

  assert.ok(out.length <= MCP_RESULT_LIMIT, `${out.length}`);
  assert.match(out, new RegExp(`^（结果原本 ${raw.length} 字，超过 ${MCP_RESULT_LIMIT} 字，已按字段截短`));
  const json = JSON.parse(out.slice(out.indexOf("\n") + 1));
  assert.equal(json.summary, "日志: 发现 300 条错误");
  const kept = json.findings.logs.logs;
  assert.match(kept.at(-1), /^…（省略后面 \d+ 项，共 300 项）$/);
  assert.equal(kept[0].timestamp, "1783623620513499028");
  assert.match(kept[0].line, /…（省略 \d+ 字）$/);
});

test("summary 本身特别长时也截短，但别的字段截得再短，它也至少留 3000 字", () => {
  const raw = JSON.stringify({ summary: "结".repeat(5000), detail: Array.from({ length: 200 }, () => "细".repeat(1000)) });
  const json = JSON.parse(compactText(raw).split("\n")[1]);
  assert.equal(json.summary, `${"结".repeat(3000)}…（省略 2000 字）`);
  assert.ok(json.detail[0].length < 1000);
});

test("不是 JSON 的长文本保留开头和结尾，中间注明省略了多少", () => {
  const raw = `开头${"日".repeat(100_000)}结尾结论`;
  const out = compactText(raw);
  assert.ok(out.length <= MCP_RESULT_LIMIT);
  assert.ok(out.startsWith("开头"));
  assert.ok(out.endsWith("结尾结论"));
  assert.match(out, new RegExp(`…（中间省略 \\d+ 字，结果超过 ${MCP_RESULT_LIMIT} 字。要看细节就缩小范围再查）…`));
});

test("多段内容分摊字数；没有文本时用 structuredContent；图片等只说明类型", () => {
  const two = formatToolResult({ content: [{ type: "text", text: "a".repeat(40_000) }, { type: "text", text: "b".repeat(40_000) }] });
  assert.ok(two.length <= MCP_RESULT_LIMIT + 2);
  assert.match(two, /^a+\n…（中间省略/);

  assert.equal(formatToolResult({ content: [], structuredContent: { ok: true } }), '{"ok":true}');
  assert.equal(formatToolResult({ content: [{ type: "image", data: "xx", mimeType: "image/png" }] }), "[图片 image/png，没有展示]");
  assert.equal(formatToolResult({ content: [] }), "（没有返回内容）");
});

test("对象列表里每项都一样的字段只写一次：整个字段一样的提出来，对象字段只提一样的那几个键，不丢信息", () => {
  const labels = (pod: string) => ({ app: "product-service-api", namespace: "prod", job: "prod/product-service-api", pod });
  const raw = JSON.stringify({
    total: 3,
    logs: [
      { timestamp: "1", labels: labels("p-1"), line: "a", stream: "stdout" },
      { timestamp: "2", labels: labels("p-2"), line: "b", stream: "stdout" },
      { timestamp: "3", labels: labels("p-1"), line: "c", stream: "stdout" },
    ],
  });

  const json = JSON.parse(compactText(raw));

  assert.deepEqual(Object.keys(json), ["total", `logs${COMMON_SUFFIX}`, "logs"]);
  assert.deepEqual(json[`logs${COMMON_SUFFIX}`], {
    labels: { app: "product-service-api", namespace: "prod", job: "prod/product-service-api" },
    stream: "stdout",
  });
  assert.deepEqual(json.logs, [
    { timestamp: "1", labels: { pod: "p-1" }, line: "a" },
    { timestamp: "2", labels: { pod: "p-2" }, line: "b" },
    { timestamp: "3", labels: { pod: "p-1" }, line: "c" },
  ]);
});

test("不到 3 项、提出来的太短、不是对象列表、键名已被占用时不提；嵌套的列表也提", () => {
  const two = JSON.stringify({ logs: [{ namespace: "prod-namespace-long", a: 1 }, { namespace: "prod-namespace-long", a: 2 }] });
  assert.equal(compactText(two), two);
  const short = JSON.stringify({ logs: [{ ns: "p", a: 1 }, { ns: "p", a: 2 }, { ns: "p", a: 3 }] });
  assert.equal(compactText(short), short);
  const strings = JSON.stringify({ logs: ["same-same-same-same-same", "same-same-same-same-same", "same-same-same-same-same"] });
  assert.equal(compactText(strings), strings);
  const taken = JSON.stringify({
    [`logs${COMMON_SUFFIX}`]: 1,
    logs: [{ namespace: "prod-namespace-long", a: 1 }, { namespace: "prod-namespace-long", a: 2 }, { namespace: "prod-namespace-long", a: 3 }],
  });
  assert.equal(compactText(taken), taken);

  const nested = JSON.parse(
    compactText(JSON.stringify({ findings: { pods: [{ ns: "prod-namespace-long", n: 1 }, { ns: "prod-namespace-long", n: 2 }, { ns: "prod-namespace-long", n: 3 }] } })),
  );
  assert.deepEqual(nested.findings, { [`pods${COMMON_SUFFIX}`]: { ns: "prod-namespace-long" }, pods: [{ n: 1 }, { n: 2 }, { n: 3 }] });
});

test("50 条带 labels 的日志：每条都一样的 labels 只写一次，上限以内全部留下（2026-10-10 转链排查只剩 12 条）", () => {
  const logs = Array.from({ length: 50 }, (_, i) => ({
    timestamp: String(1791622679000000000n + BigInt(i) * 1000000n),
    labels: {
      app: "product-service-api",
      container: "product-service-api",
      filename: "/var/log/pods/prod_product-service-api/0.log",
      job: "prod/product-service-api",
      namespace: "prod",
      node_name: "cn-beijing.10.0.1.23",
      pod: `product-service-api-7d9f-${i % 3}`,
      service_name: "product-service-api",
      stream: "stdout",
    },
    line: JSON.stringify({ req_id: `req-${i}`, level: "info", msg: "convert link", request_body: "x".repeat(700) }),
  }));
  const raw = JSON.stringify({ total: 50, query_start: "2026-10-10 12:38:00", logs }, null, 2);
  assert.ok(raw.length > 50_000);

  const out = compactText(raw);

  assert.ok(!out.startsWith("（结果原本"), out.slice(0, 80));
  const json = JSON.parse(out);
  assert.equal(json.logs.length, 50);
  assert.equal(json[`logs${COMMON_SUFFIX}`].labels.app, "product-service-api");
  assert.deepEqual(json.logs[49].labels, { pod: "product-service-api-7d9f-1" });
});
