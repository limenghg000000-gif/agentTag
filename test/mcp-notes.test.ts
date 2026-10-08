import assert from "node:assert/strict";
import { test } from "node:test";
import { queryLogsNote, RESULT_NOTES } from "../src/mcp-notes.js";

/** 北京时间 → Loki 的 19 位纳秒字符串 */
const ns = (beijing: string) => `${BigInt(Date.parse(`${beijing.replace(" ", "T")}+08:00`)) * 1_000_000n}`;
const log = (beijing: string) => ({ timestamp: ns(beijing), labels: { app: "product-service-api" }, line: "searchV2 fail" });
const result = (logs: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    total: logs.length,
    query: '{namespace="prod",app="product-service-api"} |~ "error"',
    query_start: "2026-10-08 15:43:30",
    query_end: "2026-10-08 16:43:30",
    logs,
    ...extra,
  });
const times = (n: number, beijing: string) => Array.from({ length: n }, () => log(beijing));

test("query_logs 取满了 limit：写明只拿到最新一段、起止时间（到毫秒）和查询窗口，不能当成整段时间", () => {
  // 复测时的样子：limit 50，27 条全在 16:43:26 这一秒里，另有 23 条空行被 aiops 去掉
  const second = BigInt(ns("2026-10-08 16:43:26"));
  const logs = Array.from({ length: 27 }, (_, i) => ({ timestamp: `${second + 412_345_678n + BigInt(i) * 10_000_000n}`, line: "x" }));
  const note = queryLogsNote({ logql: "{}" }, result(logs, { skipped_empty: 23 }));
  assert.ok(note);
  assert.match(note, /只拿到最新的 27 条日志：Loki 按 limit=50 取满了（其中 23 条空行被 aiops 去掉了）/);
  assert.match(note, /这些日志在 2026-10-08 16:43:26\.412～2026-10-08 16:43:26\.672（北京时间），查询窗口是 2026-10-08 15:43:30～2026-10-08 16:43:30，更早的没取到/);
  assert.match(note, /不能当成整段时间的条数、分布或趋势，也不能说更早没有/);
  assert.match(note, /要看更早的，缩小时间范围分段查（同一秒里可能有很多条，分段的边界宁可重叠一点），或者加级别、关键词过滤，按 pod 拆开查）$/);
  // 不替模型算续查边界
  assert.doesNotMatch(note, /start_time|end_time|19 位纳秒/);
});

test("query_logs 没取满就不加注；limit 按参数算，超过 200 按 200", () => {
  assert.equal(queryLogsNote({ limit: 100 }, result(times(60, "2026-10-08 16:00:00"))), undefined);
  assert.equal(queryLogsNote({}, result(times(49, "2026-10-08 16:00:00"))), undefined);
  assert.equal(queryLogsNote({}, result([])), undefined);
  assert.match(queryLogsNote({ limit: 20 }, result(times(20, "2026-10-08 16:00:00"))) ?? "", /limit=20 取满了/);
  assert.match(queryLogsNote({ limit: "30" }, result(times(30, "2026-10-08 16:00:00"))) ?? "", /limit=30 取满了/);
  assert.equal(queryLogsNote({ limit: 500 }, result(times(199, "2026-10-08 16:00:00"))), undefined);
  assert.match(queryLogsNote({ limit: 500 }, result(times(200, "2026-10-08 16:00:00"))) ?? "", /limit=200 取满了/);
});

test("query_logs 超过 200KB 被 aiops 减半：写明留了几条，按减半前的条数判断取满，提示调小 limit", () => {
  const notFull = queryLogsNote({ limit: 10 }, result([log("2026-10-08 16:40:00"), log("2026-10-08 16:41:00")], { original_total: 8 }));
  assert.match(notFull ?? "", /只拿到最新的 2 条日志：结果超过 200KB，aiops 只留了 8 条里的 2 条。/);
  assert.match(notFull ?? "", /2026-10-08 16:40:00\.000～2026-10-08 16:41:00\.000/);
  assert.match(notFull ?? "", /；这次结果超过 200KB 被减半过，再查时调小 limit）$/);

  const full = queryLogsNote({ limit: 50 }, result(times(25, "2026-10-08 16:43:26"), { original_total: 50 }));
  assert.match(full ?? "", /Loki 按 limit=50 取满了；结果超过 200KB，aiops 只留了 50 条里的 25 条/);
});

test("query_logs 从旧到新取时说的是最早一段、更晚的没取到", () => {
  const forward = queryLogsNote({ direction: "forward", limit: 2 }, result([log("2026-10-08 15:44:00"), log("2026-10-08 15:45:10")]));
  assert.match(forward ?? "", /只拿到最早的 2 条日志/);
  assert.match(forward ?? "", /更晚的没取到/);
  assert.match(forward ?? "", /也不能说更晚没有。要看更晚的/);
});

test("query_logs 的时间换成北京时间字符串以后照样能算；没有时间或不是 JSON 也不出错", () => {
  const beijing = queryLogsNote({ limit: 2 }, result([{ timestamp: "2026-10-08 16:43:26" }, { timestamp: "2026-10-08 16:43:20" }]));
  assert.match(beijing ?? "", /2026-10-08 16:43:20\.000～2026-10-08 16:43:26\.000/);
  const noTimes = queryLogsNote({ limit: 1 }, result([{ line: "x" }]));
  assert.match(noTimes ?? "", /只拿到最新的 1 条日志：Loki 按 limit=1 取满了。更早的没取到。/);
  assert.equal(queryLogsNote({}, "LogQL 语法错误"), undefined);
  assert.equal(queryLogsNote({}, '{"items":[]}'), undefined);
});

test("补充说明按服务名和工具名登记：只有 aiops 的 query_logs", () => {
  assert.deepEqual(Object.keys(RESULT_NOTES), ["aiops"]);
  assert.deepEqual(Object.keys(RESULT_NOTES.aiops), ["query_logs"]);
});
