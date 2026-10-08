import assert from "node:assert/strict";
import { test } from "node:test";
import { compactText, formatToolResult, MCP_RESULT_LIMIT } from "../src/mcp-result.js";

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
  const logs = Array.from({ length: 300 }, (_, i) => ({ timestamp: "1783623620513499028", line: `${"错误详情".repeat(400)} #${i}` }));
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
  const raw = `开头${"日".repeat(50_000)}结尾结论`;
  const out = compactText(raw);
  assert.ok(out.length <= MCP_RESULT_LIMIT);
  assert.ok(out.startsWith("开头"));
  assert.ok(out.endsWith("结尾结论"));
  assert.match(out, /…（中间省略 \d+ 字，结果超过 24000 字。要看细节就缩小范围再查）…/);
});

test("多段内容分摊字数；没有文本时用 structuredContent；图片等只说明类型", () => {
  const two = formatToolResult({ content: [{ type: "text", text: "a".repeat(20_000) }, { type: "text", text: "b".repeat(20_000) }] });
  assert.ok(two.length <= MCP_RESULT_LIMIT + 2);
  assert.match(two, /^a+\n…（中间省略/);

  assert.equal(formatToolResult({ content: [], structuredContent: { ok: true } }), '{"ok":true}');
  assert.equal(formatToolResult({ content: [{ type: "image", data: "xx", mimeType: "image/png" }] }), "[图片 image/png，没有展示]");
  assert.equal(formatToolResult({ content: [] }), "（没有返回内容）");
});
