import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ChartBlock,
  keepVerified,
  NumberEvidence,
  segmentElements,
  segmentsAsText,
  splitAnswer,
  streamingAnswer,
} from "../src/rich-ui.js";

const chartJson = '{"type":"line","title":"CPU","unit":"%","x":["19:00","19:05"],"series":[{"name":"pod-a","data":[41.2,39]}]}';
const kpiJson = '[{"label":"CPU 最高","value":"41%","level":"ok"},{"label":"重启","value":"0 次"}]';

test("拆回答：```chart、```kpi 换成图和数字卡片，别的代码块、格式不对的、没写完的不当图", () => {
  const answer = ["结论：没有风险", "```kpi", kpiJson, "```", "", "```chart", chartJson, "```", "说明", "```json", '{"a":1}', "```", "```chart", "{坏的", "```"].join("\n");
  const { segments, invalid } = splitAnswer(answer);
  assert.deepEqual(
    segments.map((s) => s.kind),
    ["markdown", "kpi", "chart", "markdown"],
  );
  assert.deepEqual(segments[0], { kind: "markdown", text: "结论：没有风险" });
  assert.deepEqual(segments[1], {
    kind: "kpi",
    items: [
      { label: "CPU 最高", value: "41%", level: "ok" },
      { label: "重启", value: "0 次" },
    ],
  });
  assert.deepEqual(segments[2], { kind: "chart", type: "line", title: "CPU", unit: "%", x: ["19:00", "19:05"], series: [{ name: "pod-a", data: [41.2, 39] }] });
  assert.equal((segments[3] as { text: string }).text, '说明\n```json\n{"a":1}\n```');
  assert.deepEqual(invalid, ["chart"]);

  // 没写完的块、长代码块里的 ```chart 不算
  assert.deepEqual(splitAnswer("开头\n```chart\n" + chartJson).invalid, ["chart"]);
  const nested = "````md\n```chart\n" + chartJson + "\n```\n````";
  assert.deepEqual(splitAnswer(nested).segments, [{ kind: "markdown", text: nested }]);
  // 数据和横轴对不上、饼图多个系列、点太多：不要
  for (const bad of [
    '{"type":"line","title":"t","x":["a"],"series":[{"name":"s","data":[1,2]}]}',
    '{"type":"pie","title":"t","x":["a"],"series":[{"name":"s","data":[1]},{"name":"u","data":[2]}]}',
    '{"type":"area","title":"t","x":["a"],"series":[{"name":"s","data":[1]}]}',
    JSON.stringify({ type: "line", title: "t", x: Array.from({ length: 201 }, (_, i) => String(i)), series: [{ name: "s", data: Array(201).fill(1) }] }),
  ]) {
    assert.deepEqual(splitAnswer("```chart\n" + bad + "\n```").invalid, ["chart"], bad);
  }
});

test("生成中的回答：图和数字卡片的代码块换成一行说明", () => {
  assert.equal(streamingAnswer("结论\n```chart\n{\"type\":"), "结论\n📊 图表画好后显示在这里…");
  assert.equal(streamingAnswer("结论\n```kpi\n[]\n```\n后面"), "结论\n📌 关键数字整理好后显示在这里…\n后面");
  assert.equal(streamingAnswer("```go\nx := 1\n```"), "```go\nx := 1\n```");
});

test("查到的数：按写出来的精度四舍五入，认百分比、字节、核数的换算", () => {
  const evidence = new NumberEvidence(['{"cpu":0.4123,"mem_bytes":944242688,"cores":0.25}', "restarts 0, ready 3/3"]);
  assert.ok(evidence.has(0.4123));
  assert.ok(evidence.has(41.2)); // 0.4123 × 100
  assert.ok(evidence.has(41));
  assert.ok(!evidence.has(41.3));
  assert.ok(evidence.has(900.5)); // 字节 → MiB
  assert.ok(evidence.has(0.9)); // → GiB
  assert.ok(evidence.has(250)); // 核 → 毫核
  assert.ok(evidence.has(0));
  assert.ok(!evidence.has(73));
});

test("只画数都查得到的图：对不上的图换成说明，数字卡片对不上的去掉", () => {
  const evidence = new NumberEvidence(["cpu 41.2 39.0 restarts 0"]);
  const { segments } = splitAnswer(["```kpi", '[{"label":"CPU 最高","value":"41%"},{"label":"内存","value":"77%"},{"label":"状态","value":"正常"}]', "```", "```chart", chartJson, "```", "```chart", chartJson.replace("39", "38"), "```"].join("\n"));
  const result = keepVerified(segments, evidence);
  assert.deepEqual(result.segments[0], { kind: "kpi", items: [{ label: "CPU 最高", value: "41%" }, { label: "状态", value: "正常" }] });
  assert.equal(result.segments[1].kind, "chart");
  assert.deepEqual(result.segments[2], { kind: "markdown", text: "📊 图「CPU」里有数和这次查到的结果对不上，没画出来。" });
  assert.equal(result.dropped.length, 2);
  assert.match(result.dropped[1], /图「CPU」有 1 个数在查询结果里找不到（如 38）/);

  // 最多 3 张图
  const many = splitAnswer(Array(4).fill("```chart\n" + chartJson + "\n```").join("\n")).segments;
  assert.equal(keepVerified(many, evidence).segments.filter((s) => s.kind === "chart").length, 3);
});

test("卡片组件：折线图、多系列柱状图、饼图、数字卡片；文字版", () => {
  const line = splitAnswer("```chart\n" + chartJson + "\n```").segments[0] as ChartBlock;
  const bar: ChartBlock = { kind: "chart", type: "bar", title: "内存", x: ["a", "b"], series: [{ name: "用量", data: [1, 2] }, { name: "limit", data: [3, 4] }] };
  const pie: ChartBlock = { kind: "chart", type: "pie", title: "占比", x: ["a", "b"], series: [{ name: "s", data: [1, 2] }] };
  const [lineEl, barEl, pieEl, kpiEl] = segmentElements(
    [line, bar, pie, { kind: "kpi", items: [{ label: "CPU <最高>", value: "**41%**", level: "danger" }] }],
    () => ({}),
  ) as any[];
  assert.equal(lineEl.tag, "chart");
  assert.equal(lineEl.chart_spec.title.text, "CPU（%）");
  assert.deepEqual(lineEl.chart_spec.data.values, [
    { x: "19:00", value: 41.2, series: "pod-a" },
    { x: "19:05", value: 39, series: "pod-a" },
  ]);
  assert.equal(lineEl.chart_spec.xField, "x");
  assert.deepEqual(barEl.chart_spec.xField, ["x", "series"]);
  assert.equal(barEl.chart_spec.legends.visible, true);
  assert.deepEqual(pieEl.chart_spec.data.values, [
    { name: "a", value: 1 },
    { name: "b", value: 2 },
  ]);
  assert.equal(kpiEl.tag, "column_set");
  assert.equal(kpiEl.columns[0].elements[0].content, "<font color='red'>**41%**</font>");
  assert.equal(kpiEl.columns[0].elements[1].content, "CPU &lt;最高>");

  assert.equal(
    segmentsAsText([{ kind: "markdown", text: "结论" }, { kind: "kpi", items: [{ label: "CPU", value: "41%" }, { label: "重启", value: "0" }] }, line]),
    "结论\n\n**CPU** 41% · **重启** 0\n\n📊 CPU（这里显示不了图）",
  );
});
