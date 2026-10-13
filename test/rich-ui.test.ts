import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMON_SUFFIX, compactText } from "../src/mcp-result.js";
import {
  type AnswerSegment,
  type ChartBlock,
  keepVerified,
  mislabeledBytes,
  NumberEvidence,
  segmentElements,
  segmentsAsText,
  splitAnswer,
  streamingAnswer,
  promqlUnit,
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

  // JSON 没写完的块不算，长代码块里的 ```chart 不算
  assert.deepEqual(splitAnswer("开头\n```chart\n{\"type\":\"li").invalid, ["chart"]);
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
  assert.deepEqual(unitFactors("120ms")?.any, [1, 1000]);
  assert.deepEqual(unitFactors("0.25 核")?.any, [1, 1e-3]);
  assert.deepEqual(unitFactors("250 毫核")?.any, [1, 1000]);
  assert.deepEqual(unitFactors("0.06 mCPU")?.any, [1, 1000]);
  assert.deepEqual(unitFactors("62 mcpu")?.any, [1, 1000]);
  assert.deepEqual(unitFactors("1.2 GiB")?.bytes, [1024 ** -3]);
  assert.deepEqual(unitFactors("1.2 GB")?.bytes, [1e-9, 1024 ** -3]);
  assert.deepEqual(unitFactors("256Mi")?.bytes, [1024 ** -2]);
  assert.deepEqual(unitFactors("512 字节")?.bytes, [1]);
  assert.ok(new NumberEvidence(["limits memory 256Mi"]).has(0.25, unitFactors("0.25 GiB"))); // 别的工具写的 MiB → GiB
  assert.ok(new NumberEvidence(['{"value":"0.0000623"}']).has(0.06, unitFactors("0.06 mCPU"))); // 核 → 毫核
  // 浮点误差的余量远小于半格：0 不能当 1e-12 的证据
  assert.ok(!new NumberEvidence(["0"]).has(1e-12));
  assert.ok(!new NumberEvidence(["0"]).has(1e-12, percent));
});

test("折线图、柱状图里对不上的点不超过一成：只空掉这几个点，图照画，图下说一句；饼图、横轴、点多了整张不画", () => {
  const x = Array.from({ length: 20 }, (_, i) => `21:${String(i * 3).padStart(2, "0")}`);
  const data = x.map((_, i) => 170 + i);
  const evidence = new NumberEvidence([JSON.stringify(data.slice(0, 19))]);
  const chart = (type: "line" | "bar" | "pie", values = [...data.slice(0, 19), 179.74], labels = x): AnswerSegment[] => [
    { kind: "chart", type, title: "union 内存", unit: "MiB", x: labels, series: [{ name: "union", data: values }] },
  ];

  const line = keepVerified(chart("line"), evidence);
  assert.equal(line.segments.length, 2);
  const kept = line.segments[0] as ChartBlock;
  assert.deepEqual(kept.series[0].data, [...data.slice(0, 19), null]);
  assert.deepEqual(line.segments[1], { kind: "markdown", text: "📊 图「union 内存」里有 1 个点和这次查到的结果对不上，这几个点没画。" });
  assert.match(line.dropped[0], /图「union 内存」有 1 个点在查询结果里找不到（如 179.74），只空掉这几个点/);
  const [element] = segmentElements([kept], (text) => ({ md: text })) as any[];
  assert.equal(element.chart_spec.invalidType, "break");
  assert.deepEqual(element.chart_spec.data.values.at(-1), { x: "21:57", value: null, series: "union" });
  // 没空掉点的折线图不加 invalidType
  assert.equal((segmentElements(keepVerified(chart("line", data.slice(0, 19).concat(170)), evidence).segments, (text) => ({ md: text })) as any[])[0].chart_spec.invalidType, undefined);

  assert.equal(keepVerified(chart("bar"), evidence).segments[0].kind, "chart");
  // 饼图少一块，比例就变了
  assert.equal(keepVerified(chart("pie"), evidence).segments[0].kind, "markdown");
  // 对不上的点超过一成
  assert.equal(keepVerified(chart("line", [...data.slice(0, 17), 1, 2, 3]), evidence).segments[0].kind, "markdown");
  // 横轴上的数对不上
  const numbered = x.map((_, i) => String(1000 + i));
  assert.equal(keepVerified(chart("line", data.slice(0, 19).concat(170), numbered), evidence).segments[0].kind, "markdown");
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
  // 带千分位、单位的数也要查得到；时间不算
  const xs = (x: string[], output: string) =>
    keepVerified([{ kind: "chart", type: "bar", title: "t", x, series: [{ name: "a", data: x.map(() => 39) }] }], new NumberEvidence([output])).segments[0].kind;
  assert.equal(xs(["1,000"], "39"), "markdown");
  assert.equal(xs(["1,000"], "1000 39"), "chart");
  assert.equal(xs(["500 ms"], "39"), "markdown");
  assert.equal(xs(["500 ms"], "0.5 39"), "chart");
  assert.equal(xs(["50%"], "0.5 39"), "chart");
  assert.equal(xs(["19:00", "2026-10-12", "pod-a"], "39"), "chart");

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

test("漏写了收尾 ``` 的图、数字卡片块不吞掉后面的正文：JSON 写完的地方就是块的结尾，JSON 没写完的到空行为止", () => {
  // 漏写收尾，后面是标题、表格、建议：都留着
  const report = ["结论：没有风险", "```kpi", kpiJson, "", "#### 明细", "| Pod | CPU |", "| --- | --- |", "| a | 41% |", "", "建议：观察"].join("\n");
  const split = splitAnswer(report);
  assert.deepEqual(split.invalid, []);
  assert.deepEqual(
    split.segments.map((s) => s.kind),
    ["markdown", "kpi", "markdown"],
  );
  assert.equal((split.segments[2] as { text: string }).text, "#### 明细\n| Pod | CPU |\n| --- | --- |\n| a | 41% |\n\n建议：观察");

  // 漏写收尾，后面别的代码块的收尾 ``` 不算这块的：代码块原样留着
  const code = ["```chart", chartJson, "说明", "```go", "x := 1", "```", "结尾"].join("\n");
  const withCode = splitAnswer(code);
  assert.deepEqual(
    withCode.segments.map((s) => s.kind),
    ["chart", "markdown"],
  );
  assert.equal((withCode.segments[1] as { text: string }).text, "说明\n```go\nx := 1\n```\n结尾");

  // 被截断：JSON 没写完，后面的截断说明留着
  const cut = splitAnswer('```chart\n{"type":"line","ti\n\n（回答太长，后面被截断了）');
  assert.deepEqual(cut, { segments: [{ kind: "markdown", text: "（回答太长，后面被截断了）" }], invalid: ["chart"] });

  // JSON 不对、写了收尾的块：和原来一样整块不要
  assert.deepEqual(splitAnswer("开头\n```kpi\n{坏的\n```\n结尾"), {
    segments: [{ kind: "markdown", text: "开头\n结尾" }],
    invalid: ["kpi"],
  });
});

test("全角数字、全角 ％、数学减号先换成半角再核对；横轴上 +5%、$1,000 这种带符号的数也要查得到", () => {
  const kpi = (value: string, output: string) =>
    keepVerified([{ kind: "kpi", items: [{ label: "x", value }] }], new NumberEvidence([output])).segments.length === 1;
  assert.ok(!kpi("９９％", "nothing here"));
  assert.ok(kpi("９９％", "ratio 0.99"));
  assert.ok(kpi("99％", "ratio 0.99"));
  assert.ok(!kpi("−99%", "ratio 0.99"));
  assert.ok(kpi("−99%", "delta -0.99"));
  assert.ok(kpi("1.2 ＧｉＢ", String(1.2 * 1024 ** 3)));
  assert.ok(!kpi("102", "10²"));
  // 写出来的精度：末尾的 0 也算
  assert.ok(!kpi("0.000%", "error_percent 0.4"));
  assert.ok(kpi("0.000%", "error_ratio 0.0000041"));
  assert.ok(kpi("41.20%", "0.4120"));
  assert.ok(!kpi("41.20%", "0.4126"));
  assert.ok(kpi("1.50e-7", "1.5e-7"));
  // 1.50e3 写到十位；1500、1e9 按个位；1e309 是 Infinity，当查不到
  assert.ok(kpi("1.50e3", "1496"));
  assert.ok(!kpi("1500", "1496"));
  assert.ok(!kpi("1e309", "1 2 3"));

  const xs = (x: string, output: string) =>
    keepVerified([{ kind: "chart", type: "bar", title: "t", x: [x], series: [{ name: "a", data: [39] }] }], new NumberEvidence([output])).segments[0].kind;
  assert.equal(xs("+5%", "39"), "markdown");
  assert.equal(xs("+5%", "0.05 39"), "chart");
  assert.equal(xs("$1,000", "39"), "markdown");
  assert.equal(xs("$1,000", "1000 39"), "chart");
  assert.equal(xs("１,０００", "39"), "markdown");
  assert.equal(xs("￥1,000", "39"), "markdown");
  assert.equal(xs("￥1,000", "1000 39"), "chart");
});

test("「接着查」按钮：```actions 里的问题尖括号换成全角、合成一行，太长的不要，最多 3 个，放在最后", () => {
  const actions = JSON.stringify(["union 最近 1 小时的内存趋势", "<at id=all></at>pc-goods-site\n有没有重启过", "union 最近 1 小时的内存趋势", "很".repeat(41), 3, "a", "b"]);
  const { segments, invalid } = splitAnswer(["结论", "```actions", actions, "```"].join("\n"));
  assert.deepEqual(invalid, []);
  assert.deepEqual(segments[1], { kind: "actions", questions: ["union 最近 1 小时的内存趋势", "＜at id=all＞＜/at＞pc-goods-site 有没有重启过", "a"] });
  // 比较符号留着：去掉的话问的就变了
  assert.deepEqual(splitAnswer('```actions\n["查 CPU > 80% 的 Pod","延迟 < 500ms 的接口"]\n```').segments[0], {
    kind: "actions",
    questions: ["查 CPU ＞ 80% 的 Pod", "延迟 ＜ 500ms 的接口"],
  });
  assert.deepEqual(splitAnswer('```actions\n{"q":"x"}\n```').invalid, ["actions"]);
  assert.deepEqual(splitAnswer('```actions\n["很' + "很".repeat(40) + '"]\n```').invalid, ["actions"]);

  // 生成时不占位
  assert.equal(streamingAnswer(["结论", "```actions", actions, "```"].join("\n")), "结论");

  // 只留第一组
  const twice: AnswerSegment[] = [segments[1], { kind: "actions", questions: ["再来"] }];
  assert.deepEqual(keepVerified(twice, new NumberEvidence([])).segments, [segments[1]]);

  // 按钮在最后，前面一行提示；不给回传值时不放按钮
  const elements = segmentElements([segments[1], segments[0]], (text) => ({ md: text }), (q) => ({ action: "ask", q })) as any[];
  assert.deepEqual(elements[0], { md: "结论" });
  assert.equal(elements[1].content, "可以接着查：");
  assert.deepEqual(
    elements.slice(2).map((el) => [el.tag, el.text.content, el.behaviors[0].value]),
    [
      ["button", "union 最近 1 小时的内存趋势", { action: "ask", q: "union 最近 1 小时的内存趋势" }],
      ["button", "＜at id=all＞＜/at＞pc-goods-site 有没有重启过", { action: "ask", q: "＜at id=all＞＜/at＞pc-goods-site 有没有重启过" }],
      ["button", "a", { action: "ask", q: "a" }],
    ],
  );
  assert.deepEqual(segmentElements(segments, (text) => ({ md: text })), [{ md: "结论" }]);
  assert.equal(segmentsAsText([segments[0], { kind: "actions", questions: ["x", "y"] }]), "结论\n\n可以接着问：「x」「y」");
});

test("数字卡片：标签里带上服务名（30 来个字）不截断，值只写数和单位", () => {
  const label = "CPU 占 limit 最高 · yuebai-user-rpc";
  const kpi = splitAnswer("```kpi\n" + JSON.stringify([{ label, value: "50%", level: "ok" }]) + "\n```").segments[0];
  assert.deepEqual(kpi, { kind: "kpi", items: [{ label, value: "50%", level: "ok" }] });
});

test("PromQL 查回来的数按查询认单位：CPU 的 rate 是核数，*_bytes 是字节，limits 按 resource 标签；有加减乘除、别的函数的认不出", () => {
  const cpu = 'sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="prod", pod=~"union-.*", container!=""}[5m]))';
  assert.equal(promqlUnit(cpu), "cores");
  assert.equal(promqlUnit('topk(5, sum(rate(container_cpu_usage_seconds_total{namespace="prod"}[5m])) by (pod))'), "cores");
  assert.equal(promqlUnit('max_over_time(sum by (pod)(irate(container_cpu_usage_seconds_total[1m]))[1h:5m])'), "cores");
  assert.equal(promqlUnit('sum by (pod) (container_memory_working_set_bytes{namespace="prod", pod=~"union-.*", container!=""})'), "bytes");
  assert.equal(promqlUnit('sum by (pod, resource) (kube_pod_container_resource_limits{namespace="prod", pod=~"union-.*"})'), "resource");
  assert.equal(promqlUnit('sum by (pod) (kube_pod_container_resource_limits{resource="cpu", pod=~"union-.*"})'), "cores");
  assert.equal(promqlUnit('kube_pod_container_resource_requests{resource="memory"}'), "bytes");
  // 算过的、认不出的：按不知道单位算
  for (const query of [
    `100 * ${cpu} / sum by (pod) (kube_pod_container_resource_limits{resource="cpu"})`,
    `${cpu} * 1000`,
    "increase(container_cpu_usage_seconds_total[1h])",
    "container_cpu_usage_seconds_total",
    'count by (pod) (container_memory_working_set_bytes)',
    'sum(rate(http_requests_total{code=~"5.."}[5m]))',
    'rate(container_cpu_cfs_throttled_periods_total[5m])',
    'sum(rate({app="union"} |= "error" [5m]))',
    'container_memory_working_set_bytes offset -5m',
    'sum by (pod) (container_memory_working_set_bytes) > bool 1e8',
    'sum(rate(container_cpu_usage_seconds_total[5m])) or sum(container_memory_working_set_bytes)',
  ]) {
    assert.equal(promqlUnit(query), undefined, query);
  }
});

test("2026-10-12 union：CPU 查回来是核数，写成「占 limit %」的图和数字卡片不画；写成 mCPU、在查询里算好百分比的照画；内存字节换成 MiB 照画", () => {
  const series = (pods: Record<string, string[]>, extra: Record<string, string> = {}) =>
    Object.entries(pods).map(([pod, values]) => ({ metric: { pod, ...extra }, values: values.map((v, i) => [1760279000 + i * 300, v]) }));
  const range = (query: string, pods: Record<string, string[]>) =>
    JSON.stringify({ query, step_seconds: 300, query_start: "2026-10-12T14:23:00Z", query_end: "2026-10-12T15:23:00Z", data: { resultType: "matrix", result: series(pods) } });
  const cpu = range('sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="prod", pod=~"union-.*", container!=""}[5m]))', {
    "union-l6qqx": ["0.00241", "0.0332", "0.00262"],
    "union-2v7gp": ["0.00238", "0.0120", "0.00251"],
  });
  const memory = range('sum by (pod) (container_memory_working_set_bytes{namespace="prod", pod=~"union-.*", container!=""})', {
    "union-sxllq": ["188430745", "188431000", "188432000"],
  });
  const limits = JSON.stringify({
    query: 'sum by (pod, resource) (kube_pod_container_resource_limits{namespace="prod", pod=~"union-.*"})',
    data: { resultType: "vector", result: [
      { metric: { pod: "union-l6qqx", resource: "cpu" }, value: [1760282600, "0.256"] },
      { metric: { pod: "union-l6qqx", resource: "memory" }, value: [1760282600, "268435456"] },
    ] },
  });
  const evidence = new NumberEvidence([cpu, memory, limits]);
  const chart = (unit: string | undefined, data: number[][], title = "union 各 Pod CPU 占 limit"): AnswerSegment[] => [
    { kind: "chart", type: "line", title, ...(unit ? { unit } : {}), x: ["22:23", "22:28", "22:33"], series: data.map((d, i) => ({ name: `p${i}`, data: d })) },
  ];
  const drawn = (segments: AnswerSegment[]) => keepVerified(segments, evidence).segments[0].kind === "chart";
  const kpi = (label: string, value: string) => keepVerified([{ kind: "kpi", items: [{ label, value }] }], evidence).segments.length === 1;

  // 测试群里的写法：核数原样当百分比
  assert.ok(!drawn(chart("%", [[0.0024, 0.0332, 0.0026], [0.0024, 0.012, 0.0025]])));
  assert.ok(!drawn(chart(undefined, [[0.0024, 0.0332, 0.0026], [0.0024, 0.012, 0.0025]], "union 各 Pod CPU 占 limit（%）")));
  assert.ok(!kpi("CPU 占 limit 最高 · l6qqx", "0.03%"));
  assert.ok(!kpi("CPU 峰值", "0.0332 mCPU"));
  // 换算对的照画
  assert.ok(drawn(chart("mCPU", [[2.4, 33.2, 2.6], [2.4, 12, 2.5]])));
  assert.ok(drawn(chart("核", [[0.0024, 0.0332, 0.0026], [0.0024, 0.012, 0.0025]])));
  assert.ok(drawn(chart(undefined, [[0.0024, 0.0332, 0.0026], [0.0024, 0.012, 0.0025]], "union 各 Pod CPU")));
  assert.ok(kpi("CPU 峰值 · l6qqx", "33 mCPU"));
  assert.ok(kpi("CPU limit", "0.256 核"));
  assert.ok(kpi("内存 limit", "256 MiB"));
  assert.ok(!kpi("内存 limit", "0.256 MiB"));
  assert.ok(drawn(chart("MiB", [[179.7, 179.7, 179.7]], "union 内存")));
  // 字节数原样当 MiB、当百分比：不画
  assert.ok(!kpi("内存", "188430745 MiB"));
  assert.ok(!drawn(chart("%", [[179.7, 179.7, 179.7]], "union 内存")));
  // 在 PromQL 里算好的百分比照画
  const percent = new NumberEvidence([
    range('100 * sum by (pod) (rate(container_cpu_usage_seconds_total{pod=~"union-.*"}[5m])) / sum by (pod) (kube_pod_container_resource_limits{resource="cpu", pod=~"union-.*"})', {
      "union-l6qqx": ["0.941", "12.97", "1.02"],
    }),
  ]);
  assert.equal(keepVerified(chart("%", [[0.94, 12.97, 1.02]]), percent).segments[0].kind, "chart");
  // 时间戳、步长这些不是样本的数照旧当不知道单位的数；截断了的结果照样认得出样本
  assert.ok(new NumberEvidence([cpu]).has(300));
  assert.ok(!new NumberEvidence([cpu.slice(0, cpu.indexOf("0.0332") + 8)]).has(0.0332, unitFactors("%")));
  // 一次结果里有两条查询：分不清，按不知道单位算（和以前一样）
  assert.ok(new NumberEvidence([`[${cpu},${cpu}]`]).has(0.0332, unitFactors("%")));
});

test("折线图：一条线、点不多时在点上标数；几条线或点多时不标", () => {
  const spec = (series: number, points: number) => {
    const x = Array.from({ length: points }, (_, i) => `t${i}`);
    const chart: ChartBlock = { kind: "chart", type: "line", title: "t", x, series: Array.from({ length: series }, (_, s) => ({ name: `s${s}`, data: x.map(() => 1) })) };
    return (segmentElements([chart], () => ({})) as any[])[0].chart_spec;
  };
  assert.deepEqual(spec(1, 12).label, { visible: true });
  assert.deepEqual(spec(1, 13).label, { visible: false });
  assert.deepEqual(spec(3, 7).label, { visible: false });
  const bar: ChartBlock = { kind: "chart", type: "bar", title: "t", x: ["a"], series: [{ name: "s", data: [1] }] };
  assert.equal((segmentElements([bar], () => ({})) as any[])[0].chart_spec.label, undefined);
});

test("Codex：标题只认末尾括号里的单位，「核心」「秒杀」「百分位」不是单位；resource 几种混着、写正则时按每条序列认；提出来的公共标签也认", () => {
  // 标题
  for (const word of ["核心接口", "秒杀活动 QPS", "P99 百分位延迟", "数据核对"]) {
    assert.equal(unitFactors(word), undefined, word);
  }
  assert.ok(unitFactors("0.25 核") && unitFactors("0.25核") && unitFactors("CPU 核数") && unitFactors("耗时（秒）") && unitFactors("12 秒"));
  const drawn = (title: string, output: string) =>
    keepVerified([{ kind: "chart", type: "bar", title, x: ["a"], series: [{ name: "s", data: [0.25] }] }], new NumberEvidence([output])).segments[0].kind === "chart";
  assert.ok(!drawn("核心接口 QPS", "qps 250"));
  assert.ok(drawn("union CPU（核）", "limits cpu 250m"));
  assert.ok(drawn("union CPU (cores)", "limits cpu 250m"));

  // 几种 resource 混着、写正则：按每条序列的标签
  assert.equal(promqlUnit('kube_pod_container_resource_limits{resource="cpu"} or kube_pod_container_resource_limits{resource="memory"}'), "resource");
  assert.equal(promqlUnit('sum by (pod) (kube_pod_container_resource_limits{resource=~"cpu"})'), "resource");
  const mixed = JSON.stringify({
    query: 'kube_pod_container_resource_limits{resource="cpu"} or kube_pod_container_resource_limits{resource="memory"}',
    data: { result: [
      { metric: { pod: "a", resource: "cpu" }, value: [1760282600, "0.256"] },
      { metric: { pod: "a", resource: "memory" }, value: [1760282600, "268435456"] },
    ] },
  });
  assert.ok(new NumberEvidence([mixed]).has(256, unitFactors("MiB")));
  assert.ok(!new NumberEvidence([mixed]).has(0.256, unitFactors("MiB")));

  // 三条以上都是 resource="cpu"：resource 被提到公共字段里
  const hoisted = compactText(
    JSON.stringify({
      query: 'sum by (pod, resource) (kube_pod_container_resource_requests{namespace="prod", resource=~"cpu"})',
      data: { resultType: "vector", result: ["a", "b", "c"].map((pod, i) => ({ metric: { namespace: "prod", pod, resource: "cpu" }, value: [1760282600, String(0.25 * (i + 1))] })) },
    }),
  );
  assert.ok(hoisted.includes(COMMON_SUFFIX));
  const evidence = new NumberEvidence([hoisted]);
  assert.ok(!evidence.has(0.25, unitFactors("%")));
  assert.ok(!evidence.has(0.5, unitFactors("%")));
  assert.ok(evidence.has(250, unitFactors("mCPU")));
  assert.ok(evidence.has(0.75, unitFactors("核")));
});

test("Codex 第二轮：CPU 计数器一半套 rate、一半没套的认不出；limits 按 unit 标签、ephemeral_storage 认字节", () => {
  assert.equal(promqlUnit("rate(container_cpu_usage_seconds_total[5m]) or container_cpu_usage_seconds_total"), undefined);
  assert.equal(promqlUnit("rate(container_cpu_usage_seconds_total[5m]) or irate(container_cpu_usage_seconds_total[1m])"), "cores");
  const limits = JSON.stringify({
    query: 'kube_pod_container_resource_limits{namespace="prod", pod=~"union-.*"}',
    data: { result: [
      { metric: { pod: "a", resource: "ephemeral_storage", unit: "byte" }, value: [1760282600, "2147483648"] },
      { metric: { pod: "a", resource: "nvidia_com_gpu", unit: "integer" }, value: [1760282600, "1"] },
      { metric: { pod: "b", resource: "ephemeral-storage" }, value: [1760282600, "1073741824"] },
      { metric: { pod: "b", resource: "cpu", unit: "core" }, value: [1760282600, "0.5"] },
    ] },
  });
  const evidence = new NumberEvidence([limits]);
  assert.ok(evidence.has(2, unitFactors("GiB")));
  assert.ok(!evidence.has(2147483648, unitFactors("%")));
  assert.ok(evidence.has(1, unitFactors("GiB")));
  assert.ok(!evidence.has(1073741824, unitFactors("%")));
  assert.ok(evidence.has(500, unitFactors("mCPU")));
  assert.ok(!evidence.has(0.5, unitFactors("%")));
  assert.ok(evidence.has(1, unitFactors("个"))); // GPU 个数不知道单位，照旧
});

test("Codex 第三轮：resource 写死成 ephemeral_storage 也算字节；百分率、百分数是百分比；每个 Pod 的值一样被提到公共字段里也认得出单位", () => {
  assert.equal(promqlUnit('sum by (pod) (kube_pod_container_resource_limits{resource="ephemeral_storage"})'), "bytes");
  assert.equal(promqlUnit('sum by (pod) (kube_pod_container_resource_limits{resource="nvidia_com_gpu"})'), "resource");
  for (const unit of ["百分率", "百分数", "百分比", "%"]) {
    assert.deepEqual(unitFactors(unit)?.cores, [], unit);
  }
  assert.equal(unitFactors("P99 百分位"), undefined);

  // 三个 Pod 的 CPU limit 都是 0.256：value 整个提到「result（每项都有的字段）」里，在第一条序列前面
  const hoisted = compactText(
    JSON.stringify({
      query: 'sum by (pod) (kube_pod_container_resource_limits{namespace="prod", pod=~"union-.*", resource="cpu"})',
      data: { resultType: "vector", result: ["a", "b", "c"].map((pod) => ({ metric: { pod }, value: [1760282600, "0.256"] })) },
    }),
  );
  assert.ok(hoisted.indexOf(COMMON_SUFFIX) < hoisted.indexOf('"metric"'));
  const evidence = new NumberEvidence([hoisted]);
  assert.ok(!evidence.has(0.256, unitFactors("%")));
  assert.ok(evidence.has(256, unitFactors("mCPU")));
  assert.ok(evidence.has(1760282600)); // 时间戳照旧
});

test("2026-10-13 union：字节除以 100 万的数标成 MiB、GiB 不画；标 MB 的两种换算都认", () => {
  const memory = JSON.stringify({
    query: 'sum by (pod) (container_memory_working_set_bytes{namespace="prod", pod=~"union-.*", container!=""})',
    data: { resultType: "matrix", result: [{ metric: { pod: "union-2v7gp" }, values: [[1760279000, "153511526"], [1760280800, "153511526"]] }] },
  });
  const evidence = new NumberEvidence([memory]);
  // 153511526 字节 = 146.4 MiB = 153.5 MB
  assert.ok(evidence.has(146.4, unitFactors("MiB")));
  assert.ok(!evidence.has(153.5, unitFactors("MiB")));
  assert.ok(evidence.has(153.5, unitFactors("MB")));
  assert.ok(evidence.has(146.4, unitFactors("MB")));
  assert.ok(evidence.has(0.143, unitFactors("GiB")));
  assert.ok(!evidence.has(0.154, unitFactors("GiB")));
  const kpi = (value: string) => keepVerified([{ kind: "kpi", items: [{ label: "内存 · 2v7gp", value }] }], evidence).segments.length === 1;
  assert.ok(kpi("146.4 MiB"));
  assert.ok(!kpi("153.5 MiB"));
  // 别的工具写的 MiB（不知道单位的数）照旧哪级换过来都认
  assert.ok(new NumberEvidence(["memory 153.5 MB"]).has(153.5, unitFactors("MiB")));
});

test("2026-10-13 union：正文里写成 MiB、GiB 的数只有按 1000 换算才对得上查到的字节数时认出来；对得上的、算出来的、代码里的不算", () => {
  const memory = JSON.stringify({
    query: 'sum by (pod) (container_memory_working_set_bytes{namespace="prod", pod=~"union-.*", container!=""})',
    data: { resultType: "matrix", result: [
      { metric: { pod: "union-2v7gp" }, values: [[1760279400, "144949248"], [1760281200, "153182208"]] },
      { metric: { pod: "union-sxllq" }, values: [[1760279400, "188430745"], [1760281200, "188430745"]] },
    ] },
  });
  const evidence = new NumberEvidence([memory, "limits memory 256Mi"]);
  const found = (text: string) => mislabeledBytes(text, evidence);

  // 测试群里的原话
  assert.deepEqual(found("2v7gp 在 10-12 21:50~22:20 之间从 144.9 MiB 一次性跳到 153.2 MiB（+8 MiB），之后 11 小时完全不动"), [
    { written: "144.9 MiB", raw: 144949248, binary: "138.2 MiB" },
    { written: "153.2 MiB", raw: 153182208, binary: "146.1 MiB" },
  ]);
  // 按 1024 算对的、别的工具里本来就是这个数的、算出来的差值不算
  assert.deepEqual(found("sxllq 179.7 MiB，距 limit 256 MiB 还有约 76 MiB"), []);
  // GiB、Mi 写法、表格里、全角数字也一样；写成 MB 的不算
  assert.deepEqual(found("| 2v7gp | 0.153 GiB |"), [{ written: "0.153 GiB", raw: 153182208, binary: "0.143 GiB" }]);
  assert.deepEqual(found("当前 153.2Mi"), [{ written: "153.2 MiB", raw: 153182208, binary: "146.1 MiB" }]);
  assert.equal(found("当前 １５３.２ MiB").length, 1);
  assert.deepEqual(found("当前 153.2 MB"), []);
  // 同一个数写两遍只算一次；代码里的不算；精度太粗、两种换算都对得上的不算
  assert.equal(found("153.2 MiB，还是 153.2 MiB").length, 1);
  assert.deepEqual(found("`153.2 MiB` 和\n```\n153.2 MiB\n```"), []);
  assert.deepEqual(found("大约 0.1 GiB"), []);
  // ~~~ 代码块里的不算；行内代码前后的照样查
  assert.deepEqual(found("~~~yaml\nmemory: 153.2 MiB\n~~~"), []);
  assert.equal(found("`limit` 当前 153.2 MiB").length, 1);
  // 两个反引号的行内代码、跨行的行内代码也不算；空行隔开的不算一段行内代码
  assert.deepEqual(found("``memory: 153.2 MiB``"), []);
  assert.deepEqual(found("`limits:\nmemory: 153.2 MiB`"), []);
  assert.equal(found("`a\n\n153.2 MiB`").length, 1);
  // 表头写了单位、格子里只写数（可以加粗）的也算；按 1024 算对的、表头写 MB 的、格子里不止一个数的不算
  assert.deepEqual(found("| Pod | 内存 (MiB) |\n|---|---:|\n| 2v7gp | **153.2** |\n| sxllq | 179.7 |"), [
    { written: "153.2 MiB", raw: 153182208, binary: "146.1 MiB" },
  ]);
  assert.deepEqual(found("| Pod | Memory/GiB |\n| --- | --- |\n| 2v7gp | 0.153 |"), [{ written: "0.153 GiB", raw: 153182208, binary: "0.143 GiB" }]);
  assert.deepEqual(found("| Pod | 内存 (MB) |\n|---|---|\n| 2v7gp | 153.2 |"), []);
  assert.deepEqual(found("| Pod | 内存 (MiB) |\n|---|---|\n| 2v7gp | 153.2 / 256 |"), []);
  assert.deepEqual(found("| Pod | 内存 (MiB) |\n|---|---|\n| 2v7gp | `153.2` |"), []);
  // 带千分位的照样认；写得特别细的不会因为 toFixed 出错
  const big = new NumberEvidence([JSON.stringify({ query: "sum(container_memory_working_set_bytes)", data: { result: [{ metric: {}, value: [1, "1531800000"] }] } })]);
  assert.deepEqual(mislabeledBytes("合计 1,531.8 MiB", big), [{ written: "1,531.8 MiB", raw: 1531800000, binary: "1460.8 MiB" }]);
  assert.equal(mislabeledBytes(`合计 1531.8${"0".repeat(120)} MiB`, big).length, 1);
  // 认不出单位的查询（算过的）里的字节数不算：不知道它是不是字节
  const unknown = new NumberEvidence([JSON.stringify({ query: "sum(container_memory_working_set_bytes) / 2", data: { result: [{ metric: {}, value: [1, "153182208"] }] } })]);
  assert.deepEqual(mislabeledBytes("153.2 MiB", unknown), []);
});
