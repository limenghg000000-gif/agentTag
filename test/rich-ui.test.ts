import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AnswerSegment,
  type ChartBlock,
  keepVerified,
  NumberEvidence,
  segmentElements,
  segmentsAsText,
  splitAnswer,
  streamingAnswer,
  unitFactors,
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

test("查到的数：按写出来的精度四舍五入；按写出来的单位认百分比、字节、核数的换算，认不出单位的只认原数", () => {
  const evidence = new NumberEvidence(['{"cpu":0.4123,"mem_bytes":944242688,"cores":0.25}', "restarts 0, ready 3/3"]);
  const percent = unitFactors("41%")!;
  const mib = unitFactors("MiB")!;
  assert.ok(evidence.has(0.4123));
  assert.ok(evidence.has(41.2, percent)); // 0.4123 × 100
  assert.ok(evidence.has(41, percent));
  assert.ok(!evidence.has(41.3, percent));
  assert.ok(!evidence.has(41.2)); // 没写单位：不乘 100
  assert.ok(evidence.has(900.5, mib)); // 字节 → MiB
  assert.ok(evidence.has(0.9, unitFactors("0.9 GiB"))); // → GiB
  assert.ok(!evidence.has(900.5)); // 没写单位：不换算
  assert.ok(evidence.has(250, unitFactors("250m"))); // 核 → 毫核
  assert.ok(!evidence.has(250, percent));
  assert.ok(evidence.has(0));
  assert.ok(!evidence.has(73, percent));
  // 单位
  assert.equal(unitFactors("120 次"), undefined);
  assert.equal(unitFactors("5 min"), undefined);
  assert.deepEqual(unitFactors("120ms"), [1, 1000]);
  assert.deepEqual(unitFactors("0.25 核"), [1, 1e-3]);
  assert.deepEqual(unitFactors("250 毫核"), [1, 1000]);
  // 浮点误差的余量远小于半格：0 不能当 1e-12 的证据
  assert.ok(!new NumberEvidence(["0"]).has(1e-12));
  assert.ok(!new NumberEvidence(["0"]).has(1e-12, percent));
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
    [line, bar, pie, { kind: "kpi", items: [{ label: "CPU <最高>", value: "10~20%", level: "danger" }] }],
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
  // Markdown 符号换成长得像的字，不能删掉（删了「10~20%」就成了「1020%」）
  assert.equal(kpiEl.columns[0].elements[0].content, "<font color='red'>**10～20%**</font>");
  assert.equal(kpiEl.flex_mode, "bisect");
  assert.equal(kpiEl.columns[0].elements[1].content, "CPU &lt;最高>");

  assert.equal(
    segmentsAsText([{ kind: "markdown", text: "结论" }, { kind: "kpi", items: [{ label: "CPU", value: "41%" }, { label: "重启", value: "0" }] }, line]),
    "结论\n\n**CPU** 41% · **重启** 0\n\n📊 CPU（这里显示不了图）",
  );
});

test("查到的数：很小的数按科学计数法的最后一位算精度，整数按个位算", () => {
  const zero = new NumberEvidence(["error_rate 0"]);
  assert.ok(!zero.has(1e-7)); // 以前按小数点数位数，1e-7 算成 0 位小数，0 就对上了
  assert.ok(!new NumberEvidence(["1.6e-7"]).has(1e-7));
  assert.ok(new NumberEvidence(["1.04e-7"]).has(1e-7));
  assert.ok(new NumberEvidence(["0.00000012"]).has(1.2e-7));
  assert.ok(new NumberEvidence(["1000.4"]).has(1000));
  assert.ok(!new NumberEvidence(["1001"]).has(1000));
  assert.ok(!new NumberEvidence(["1500000000"]).has(1e9));
});

test("数字卡片：1,234、1e9 各算一个数；10~20%、10-20 是两个数", () => {
  const verdict = (value: string, output: string) =>
    keepVerified([{ kind: "kpi", items: [{ label: "x", value }] }], new NumberEvidence([output])).segments.length === 1;
  assert.ok(!verdict("1,234 次", "a 1 b 234"));
  assert.ok(verdict("1,234 次", "count 1234"));
  assert.ok(!verdict("1e9", "1 9"));
  assert.ok(verdict("1e9", "1000000000"));
  assert.ok(verdict("10~20%", "10 20"));
  assert.ok(verdict("10-20%", "10 20"));
  assert.ok(verdict("-5%", "-5"));
});

test("图：横轴写成数的值（时间戳、编号）也要查得到；系列名、横轴值掐短时留着结尾，重了的不画", () => {
  const ts = JSON.stringify({ type: "line", title: "QPS", x: [1728700000, 1728700060], series: [{ name: "a", data: [41.2, 39] }] });
  const chart = splitAnswer("```chart\n" + ts + "\n```").segments;
  assert.deepEqual((chart[0] as ChartBlock).x, ["1728700000", "1728700060"]);
  assert.equal(keepVerified(chart, new NumberEvidence(["41.2 39"])).segments[0].kind, "markdown");
  assert.equal(keepVerified(chart, new NumberEvidence(["[1728700000,\"41.2\"],[1728700060,\"39\"]"])).segments[0].kind, "chart");

  const pod = (suffix: string) => `pc-goods-site-deployment-canary-7d9f8b6c5-${suffix}`;
  const pods = JSON.stringify({ type: "bar", title: "CPU", x: ["now"], series: [{ name: pod("abcde"), data: [1] }, { name: pod("fghij"), data: [2] }] });
  const names = (splitAnswer("```chart\n" + pods + "\n```").segments[0] as ChartBlock).series.map((s) => s.name);
  assert.equal(new Set(names).size, 2);
  assert.ok(names.every((name) => Array.from(name).length === 40 && name.includes("…")), names.join());
  assert.match(names[0], /abcde$/);

  for (const bad of [
    { type: "bar", title: "t", x: ["now"], series: [{ name: "a", data: [1] }, { name: "a", data: [2] }] },
    { type: "bar", title: "t", x: ["x".repeat(50) + "1", "x".repeat(50) + "1"], series: [{ name: "a", data: [1, 2] }] },
    { type: "line", title: "t", x: ["19:00", "19:00"], series: [{ name: "a", data: [1, 2] }] },
  ]) {
    assert.deepEqual(splitAnswer("```chart\n" + JSON.stringify(bad) + "\n```").invalid, ["chart"], JSON.stringify(bad));
  }
});

test("查到的数里 1,234 也算 1234；数字卡片里 .5 是 0.5；几组数字卡片加起来最多 4 个；缩进 4 格的 ```chart 是讲写法的例子", () => {
  const kpi = (value: string, output: string) =>
    keepVerified([{ kind: "kpi", items: [{ label: "x", value }] }], new NumberEvidence([output])).segments.length === 1;
  assert.ok(kpi("1,234 次", "total 1,234"));
  assert.ok(kpi("1234 次", "total 1,234"));
  assert.ok(!kpi(".5%", "nothing here"));
  assert.ok(kpi(".5%", "ratio 0.005"));

  const blocks: AnswerSegment[] = [
    { kind: "kpi", items: [1, 2, 3].map((n) => ({ label: `a${n}`, value: String(n) })) },
    { kind: "kpi", items: [4, 5, 6].map((n) => ({ label: `b${n}`, value: String(n) })) },
  ];
  const capped = keepVerified(blocks, new NumberEvidence(["1 2 3 4 5 6"]));
  assert.deepEqual(
    capped.segments.map((s) => (s.kind === "kpi" ? s.items.map((item) => item.label) : [])),
    [["a1", "a2", "a3"], ["b4"]],
  );
  assert.match(capped.dropped.join("\n"), /数字卡片超过 4 个：b5、b6/);

  const example = "写法如下：\n\n    ```chart\n    " + chartJson + "\n    ```";
  assert.deepEqual(splitAnswer(example), { segments: [{ kind: "markdown", text: example }], invalid: [] });
  assert.equal(streamingAnswer(example), example);
  assert.equal(splitAnswer("   ```chart\n" + chartJson + "\n   ```").segments[0].kind, "chart");
});
