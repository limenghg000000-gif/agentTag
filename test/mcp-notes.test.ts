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

test("query_logs 取满了 limit：写明只拿到最新一段、起止时间和查询窗口，用纳秒边界提示怎么往前查", () => {
  // 复测时的样子：limit 50，27 条全在 16:43:26 这一秒里，另有 23 条空行被 aiops 去掉
  const second = BigInt(ns("2026-10-08 16:43:26"));
  const logs = Array.from({ length: 27 }, (_, i) => ({ timestamp: `${second + 412_345_678n + BigInt(i) * 10_000_000n}`, line: "x" }));
  const note = queryLogsNote({ logql: "{}" }, result(logs, { skipped_empty: 23, query_start_ns: ns("2026-10-08 15:43:30") }));
  assert.ok(note);
  assert.match(note, /只拿到最新的 27 条日志/);
  assert.match(note, /limit=50 取满了（其中 23 条空行被 aiops 去掉了）/);
  assert.match(note, /2026-10-08 16:43:26\.412～2026-10-08 16:43:26\.672（北京时间），查询窗口是 2026-10-08 15:43:30～2026-10-08 16:43:30/);
  assert.match(note, /不能当成整段时间的条数、分布或趋势，也不能说更早没有/);
  // 不按秒取整：end_time 是这批最早一条再加 1 纳秒，同一秒里更早的几条不会漏
  assert.ok(note.includes(`start_time 填 ${ns("2026-10-08 15:43:30")}、end_time 填 ${second + 412_345_679n}（19 位纳秒）再查，会和这批有一点重叠`));
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

test("query_logs 超过 200KB 被 aiops 减半时也加注；从旧到新取时说的是最早一段，从这批最晚一条接着取", () => {
  const halved = queryLogsNote({ limit: 10 }, result([log("2026-10-08 16:40:00"), log("2026-10-08 16:41:00")], { original_total: 8 }));
  assert.match(halved ?? "", /aiops 只留了 8 条里的 2 条/);
  assert.doesNotMatch(halved ?? "", /取满了/);
  assert.match(halved ?? "", /2026-10-08 16:40:00\.000～2026-10-08 16:41:00\.000/);

  const forward = queryLogsNote(
    { direction: "forward", limit: 2 },
    result([log("2026-10-08 15:44:00"), log("2026-10-08 15:45:10")], { query_end_ns: ns("2026-10-08 16:43:30") }),
  );
  assert.match(forward ?? "", /只拿到最早的 2 条日志/);
  assert.match(forward ?? "", /更晚的没取到/);
  assert.ok(forward?.includes(`start_time 填 ${ns("2026-10-08 15:45:10")}、end_time 填 ${ns("2026-10-08 16:43:30")}（19 位纳秒）`));
});

test("query_logs 的时间换成北京时间字符串以后照样能算，只精确到秒时边界多留一秒；没有时间或不是 JSON 也不出错", () => {
  const beijing = queryLogsNote({ limit: 2 }, result([{ timestamp: "2026-10-08 16:43:26" }, { timestamp: "2026-10-08 16:43:20" }]));
  assert.match(beijing ?? "", /2026-10-08 16:43:20\.000～2026-10-08 16:43:26\.000/);
  assert.ok(beijing?.includes(`start_time 填 ${ns("2026-10-08 15:43:30")}、end_time 填 ${ns("2026-10-08 16:43:21")}`));
  const noTimes = queryLogsNote({ limit: 1 }, result([{ line: "x" }]));
  assert.match(noTimes ?? "", /只拿到最新的 1 条日志：Loki 按 limit=1 取满了。更早的没取到。/);
  assert.match(noTimes ?? "", /缩小时间范围或加级别、关键词过滤再查/);
  assert.equal(queryLogsNote({}, "LogQL 语法错误"), undefined);
  assert.equal(queryLogsNote({}, '{"items":[]}'), undefined);
});

test("query_logs 边界那一刻就占满 limit：不让带着边界原样再查，改成跳过那一刻往前走，或者加过滤、拆开查", () => {
  const t = BigInt(ns("2026-10-08 16:43:26")) + 412_345_678n;
  const same = (n: number) => Array.from({ length: n }, () => ({ timestamp: `${t}`, line: "x" }));
  const start = ns("2026-10-08 15:43:30");

  // 3 条都在同一纳秒：end_time=T+1ns 还是这 3 条，改成 T 之前
  const stuck = queryLogsNote({ limit: 3 }, result(same(3), { query_start_ns: start }));
  assert.match(stuck ?? "", /这批里有 3 条都在 2026-10-08 16:43:26\.412，带着这个边界再查还会取回同一批/);
  assert.ok(stuck?.includes(`要看更早的，start_time 填 ${start}、end_time 填 ${t - 1n}（19 位纳秒）再查，这一刻没取到的会跳过`));
  assert.match(stuck ?? "", /要看全这一刻的，加级别、关键词过滤，或者按 pod 等标签拆开查，或者把 limit 调到 200）$/);
  assert.doesNotMatch(stuck ?? "", /重叠/);

  // 被去掉的空行按最坏情况算在边界上
  assert.match(queryLogsNote({ limit: 5 }, result(same(2), { skipped_empty: 3 })) ?? "", /带着这个边界再查还会取回同一批/);
  // limit 已经是 200 就不再建议调大
  assert.doesNotMatch(queryLogsNote({ limit: 200 }, result(same(200))) ?? "", /limit 调到/);

  // 时间只到秒、整批在同一秒：跳过这一秒
  const seconds = Array.from({ length: 4 }, () => ({ timestamp: "2026-10-08 16:43:26" }));
  const bySecond = queryLogsNote({ limit: 4 }, result(seconds));
  assert.match(bySecond ?? "", /这批里有 4 条都在 2026-10-08 16:43:26\.000 这一秒/);
  assert.ok(bySecond?.includes(`end_time 填 ${BigInt(ns("2026-10-08 16:43:26")) - 1n}（19 位纳秒）再查，这一秒没取到的会跳过`));

  // 从旧到新：start_time 跳过最晚那一刻
  const forward = queryLogsNote({ direction: "forward", limit: 3 }, result(same(3), { query_end_ns: ns("2026-10-08 16:43:30") }));
  assert.ok(forward?.includes(`要看更晚的，start_time 填 ${t + 1n}、end_time 填 ${ns("2026-10-08 16:43:30")}（19 位纳秒）再查，这一刻没取到的会跳过`));
});

test("query_logs 超过 200KB 被减半：丢掉的条数也按最坏情况算进边界；没卡住时建议把 limit 调成装得下的条数", () => {
  const t = BigInt(ns("2026-10-08 16:43:26")) + 412_345_678n;
  const same = (n: number) => Array.from({ length: n }, () => ({ timestamp: `${t}`, line: "x".repeat(10) }));

  // 50 条同一纳秒的长日志，减半留 25 条：按 T+1ns 重叠再查还是这 50 条、再减半，要跳过这一刻
  const stuck = queryLogsNote({ limit: 50 }, result(same(25), { original_total: 50 }));
  assert.match(stuck ?? "", /Loki 按 limit=50 取满了；结果超过 200KB，aiops 只留了 50 条里的 25 条/);
  assert.match(stuck ?? "", /这批里有 25 条都在 2026-10-08 16:43:26\.412，带着这个边界再查还会取回同一批/);
  assert.ok(stuck?.includes(`end_time 填 ${t - 1n}（19 位纳秒）再查，这一刻没取到的会跳过`));
  // 减半过就不建议调大 limit
  assert.doesNotMatch(stuck ?? "", /limit 调到|limit 填/);
  const forward = queryLogsNote({ direction: "forward", limit: 50 }, result(same(25), { original_total: 50 }));
  assert.ok(forward?.includes(`start_time 填 ${t + 1n}、end_time 填 ${ns("2026-10-08 16:43:30")}（19 位纳秒）再查，这一刻没取到的会跳过`));

  // 时间各不相同：照常重叠续查，limit 调成这次留下的条数
  const spread = Array.from({ length: 25 }, (_, i) => log(`2026-10-08 16:43:${String(10 + i).padStart(2, "0")}`));
  const moving = queryLogsNote({ limit: 50 }, result(spread, { original_total: 50 }));
  assert.match(moving ?? "", /会和这批有一点重叠，去掉重复的即可，limit 填 25，免得结果再超过 200KB 被减半；也可以加级别、关键词过滤缩小范围）$/);
});

test("补充说明按服务名和工具名登记：只有 aiops 的 query_logs", () => {
  assert.deepEqual(Object.keys(RESULT_NOTES), ["aiops"]);
  assert.deepEqual(Object.keys(RESULT_NOTES.aiops), ["query_logs"]);
});
