import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerFitsCard,
  ASK_ACTION,
  CardUpdater,
  ELEMENT,
  formatDuration,
  MAX_CARD_ANSWER_CHARS,
  MAX_CARD_BYTES,
  type ProgressState,
  renderPlainProgressCard,
  renderProgressCard,
  STOP_ACTION,
} from "../src/progress.js";
import { splitAnswer } from "../src/rich-ui.js";

const state = (extra: Partial<ProgressState>): ProgressState => ({ phase: "thinking", steps: [], startedAt: 0, ...extra });
const text = (card: object) => JSON.stringify(card);

test("进行中的卡片显示状态、步骤和停止按钮", () => {
  const card = renderProgressCard(
    state({ steps: [{ id: "1", label: "读取网页 a.com/<x>", status: "ok" }, { id: "2", label: "读取网页 b.com", status: "running" }] }),
    "task-1",
    5000,
  ) as any;

  assert.equal(card.schema, "2.0");
  const [status, button] = card.body.elements;
  assert.equal(status.content, "⏳ 正在执行…\n✔️ 读取网页 a.com/&lt;x&gt;\n▶️ 读取网页 b.com");
  assert.deepEqual(button.behaviors, [{ type: "callback", value: { action: STOP_ACTION, task: "task-1" } }]);
  assert.match(text(renderProgressCard(state({ phase: "queued" }), "t")), /排队中/);
});

test("结束后收成一行，步骤放进折叠面板，没有按钮", () => {
  const done = renderProgressCard(
    state({ phase: "done", endedAt: 75_000, steps: [{ id: "1", label: "读取网页 a.com", status: "ok" }] }),
    "t",
  ) as any;
  const [panel] = done.body.elements;
  assert.equal(done.body.elements.length, 1);
  assert.equal(panel.tag, "collapsible_panel");
  assert.equal(panel.header.title.content, "✅ 已完成 · 1 步 · 用时 1 分 15 秒");
  assert.equal(done.config.summary.content, "已完成");
  // 卡片撑满聊天窗口，简单版本也一样
  assert.equal(done.config.width_mode, "fill");
  assert.equal((renderPlainProgressCard(state({ phase: "done", endedAt: 0 })) as any).config.width_mode, "fill");

  const stopped = renderProgressCard(state({ phase: "stopped", endedAt: 3000 }), "t") as any;
  assert.deepEqual(stopped.body.elements, [{ tag: "markdown", content: "⏹️ 已停止 · 用时 3 秒" }]);
  assert.doesNotMatch(text(renderPlainProgressCard(state({ phase: "failed", endedAt: 0 }))), /collapsible_panel|button/);
});

test("步骤太多时只列出最近的", () => {
  const steps = Array.from({ length: 15 }, (_, i) => ({ id: `${i}`, label: `第 ${i} 步`, status: "ok" as const }));
  const card = renderProgressCard(state({ steps }), "t") as any;
  assert.match(card.body.elements[0].content, /前面还有 3 步\n✔️ 第 3 步/);
});

test("进行中在步骤下面显示最新一段思考：标明是草稿，太长时留开头和结尾，尖括号转义", () => {
  const long = `开头${"想".repeat(2000)}<font>结尾：先按链接 ID 搜 req_id`;
  const card = renderProgressCard(
    state({
      steps: [{ id: "1", label: "aiops · 查日志", status: "running" }],
      thoughts: [
        { round: 1, ms: 2000, text: "旧的思考", at: 0 },
        { round: 2, ms: 4000, text: long, at: 1 },
      ],
    }),
    "t",
  ) as any;

  const [, thought, button] = card.body.elements;
  assert.equal(button.tag, "button");
  assert.equal(thought.text_size, "notation");
  assert.match(thought.content, /^\*\*💭 最新的思考（第 2 轮，4 秒，草稿，结论以回答为准）\*\*\n开头想+\n…（中间省略 \d+ 字）…\n想+&lt;font&gt;结尾：先按链接 ID 搜 req_id$/);
  assert.ok(thought.content.length < 1000);
  assert.doesNotMatch(text(card), /旧的思考/);

  // 按字符切：emoji 不会被切成两半
  const emoji = renderProgressCard(state({ thoughts: [{ round: 1, ms: 0, text: "😀".repeat(900), at: 0 }] }), "t") as any;
  assert.doesNotMatch(text(emoji), /\\ud83d/i);
  assert.match(emoji.body.elements[1].content, /中间省略 100 字/);
});

test("结束后思考和步骤按先后折进面板：每段思考后面跟着这一轮调的工具，步骤全部列出", () => {
  const steps = Array.from({ length: 14 }, (_, i) => ({ id: `${i}`, label: `第 ${i} 步`, status: "ok" as const }));
  const card = renderProgressCard(
    state({
      phase: "done",
      endedAt: 9000,
      steps,
      thoughts: [
        { round: 2, ms: 3000, text: "按 req_id 再查一次", at: 1 },
        { round: 3, ms: 5000, text: "可以下结论了", at: 14 },
      ],
    }),
    "t",
  ) as any;

  const [panel] = card.body.elements;
  assert.equal(card.body.elements.length, 1);
  assert.equal(panel.tag, "collapsible_panel");
  assert.equal(panel.expanded, false);
  assert.equal(panel.header.title.content, "✅ 已完成 · 14 步 · 用时 9 秒");
  assert.deepEqual(
    panel.elements.map((e: any) => e.content.split("\n")[0]),
    ["💭 是模型的思考草稿，里面的猜测没有核实，结论以回答为准", "✔️ 第 0 步", "**💭 第 2 轮，3 秒**", "✔️ 第 1 步", "**💭 第 3 轮，5 秒**"],
  );
  assert.equal(panel.elements[3].content.split("\n").length, 13);
  assert.doesNotMatch(text(card), /前面还有/);
});

test("没有步骤、只有思考时也折进面板", () => {
  const card = renderProgressCard(state({ phase: "done", endedAt: 1000, thoughts: [{ round: 1, ms: 1000, text: "想好了", at: 0 }] }), "t") as any;
  assert.equal(card.body.elements[0].tag, "collapsible_panel");
  assert.match(text(card), /想好了/);
});

test("卡片超过大小上限时，从最早的一段思考开始去掉正文，只留标题", () => {
  const thoughts = Array.from({ length: 8 }, (_, i) => ({ round: i + 1, ms: 1000, text: `第${i + 1}段${"思".repeat(1500)}`, at: i }));
  const steps = thoughts.map((_, i) => ({ id: `${i}`, label: `第 ${i} 步`, status: "ok" as const }));
  const card = renderProgressCard(state({ phase: "done", endedAt: 1000, steps, thoughts }), "t") as any;

  assert.ok(Buffer.byteLength(text(card)) <= MAX_CARD_BYTES);
  const contents: string[] = card.body.elements[0].elements.map((e: any) => e.content);
  assert.ok(contents.includes("**💭 第 1 轮，1 秒**\n（太长，卡片里放不下）"));
  assert.ok(contents.some((c) => c.startsWith("**💭 第 8 轮，1 秒**\n第8段思")));
});

test("思考正文全去掉还放不下时（步骤太多）不显示思考，和以前一样只列最近的步骤", () => {
  const steps = Array.from({ length: 200 }, (_, i) => ({ id: `${i}`, label: `aiops · 查日志 ${"x".repeat(150)} ${i}`, status: "ok" as const }));
  const card = renderProgressCard(state({ phase: "done", endedAt: 1000, steps, thoughts: [{ round: 1, ms: 1000, text: "想", at: 0 }] }), "t") as any;

  assert.ok(Buffer.byteLength(text(card)) <= MAX_CARD_BYTES);
  assert.doesNotMatch(text(card), /💭/);
  assert.match(card.body.elements[0].elements[0].content, /^…前面还有 188 步/);
});

test("formatDuration", () => {
  assert.equal(formatDuration(400), "0 秒");
  assert.equal(formatDuration(59_400), "59 秒");
  assert.equal(formatDuration(125_000), "2 分 5 秒");
});

test("CardUpdater 合并短时间内的多次更新，结束时推送最终状态，之后的更新忽略", async () => {
  const patched: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const updater = new CardUpdater(async (card) => {
    patched.push((card as { v: string }).v);
    if (patched.length === 1) {
      await gate;
    }
  }, { error() {} }, 0);

  updater.update({ v: "1" });
  await tick();
  updater.update({ v: "2" });
  updater.update({ v: "3" });
  release();
  await tick();
  updater.update({ v: "4" });
  await updater.finish({ v: "final" });
  updater.update({ v: "late" });
  await tick();

  assert.deepEqual(patched, ["1", "3", "final"]);
});

test("CardUpdater 最终状态推送失败时改用简单版本", async () => {
  const patched: string[] = [];
  const updater = new CardUpdater(async (card) => {
    const v = (card as { v: string }).v;
    patched.push(v);
    if (v === "fancy") {
      throw new Error("unsupported");
    }
  }, { error() {} }, 0);

  await updater.finish({ v: "fancy" }, { v: "plain" });

  assert.deepEqual(patched, ["fancy", "plain"]);
});

const streaming = { streaming: true };

test("卡片即回答：进行中状态、思考、回答各是一个带 element_id 的组件，生成时要求打开流式模式", () => {
  const card = renderProgressCard(
    state({ live: { round: 2, reasoning: "先查 <日志>", text: "结论：服务正常" }, thoughts: [{ round: 1, ms: 1000, text: "第一轮", at: 0 }] }),
    "t",
    0,
    streaming,
  ) as any;

  const [status, thought, answer, button] = card.body.elements;
  assert.deepEqual(
    card.body.elements.map((e: any) => e.element_id),
    [ELEMENT.status, ELEMENT.thought, ELEMENT.answer, ELEMENT.stop],
  );
  assert.equal(status.content, "✍️ 正在写回答…");
  assert.equal(thought.content, "**💭 第 2 轮，正在想…（草稿，结论以回答为准）**\n先查 &lt;日志&gt;");
  assert.equal(answer.content, "结论：服务正常");
  assert.equal(button.tag, "button");
  assert.equal(card.config.streaming_mode, true);
  assert.equal(card.config.streaming_config.print_strategy, "fast");
  // 只在想、还没写回答时不开流式模式：开着时停止按钮可能点不了，深度思考能想好几分钟
  const thinking = renderProgressCard(state({ live: { round: 1, reasoning: "想", text: "" } }), "t", 0, streaming) as any;
  assert.equal(thinking.config.streaming_mode, false);
  assert.match(text(thinking), /正在想/);

  // 这一轮想完、去调工具：不要求流式，思考换成最新一段，回答位置空着
  const between = renderProgressCard(state({ thoughts: [{ round: 1, ms: 1000, text: "第一轮", at: 0 }] }), "t", 0, streaming) as any;
  assert.equal(between.config.streaming_mode, false);
  assert.deepEqual(
    between.body.elements.map((e: any) => e.element_id),
    [ELEMENT.status, ELEMENT.thought, ELEMENT.stop],
  );
  // 不是卡片即回答时和以前一样，不带 element_id 和流式配置
  assert.doesNotMatch(text(renderProgressCard(state({ live: { round: 1, reasoning: "", text: "答" } }), "t")), /element_id|streaming/);
});

test("卡片即回答：还在 <think> 里的正文不显示；没有正文时显示重做说明或上一版回答", () => {
  const thinking = renderProgressCard(state({ live: { round: 1, reasoning: "", text: "<think>想一想" } }), "t", 0, streaming) as any;
  assert.doesNotMatch(text(thinking), /想一想|正在写回答/);
  const after = renderProgressCard(state({ live: { round: 1, reasoning: "", text: "<think>想</think>答案" } }), "t", 0, streaming) as any;
  assert.equal(after.body.elements[1].content, "答案");

  const redo = renderProgressCard(state({ answerNote: "这一版回答没通过检查，正在重做…" }), "t", 0, streaming) as any;
  assert.equal(redo.body.elements[1].content, "这一版回答没通过检查，正在重做…");
  const draft = renderProgressCard(state({ answer: "上一版" }), "t", 0, streaming) as any;
  assert.equal(draft.body.elements[1].content, "上一版");
});

test("卡片即回答：结束后步骤和思考折进面板，下面是回答；预览是回答开头；代码块外的尖括号转义", () => {
  const answer = `结论 <at id=all></at>\n\`\`\`go\nif a < b {}\n\`\`\`\n${"很长的说明".repeat(20)}`;
  const card = renderProgressCard(
    state({ phase: "done", endedAt: 3000, steps: [{ id: "1", label: "查日志", status: "ok" }], answer }),
    "t",
    0,
    streaming,
  ) as any;

  const [panel, body] = card.body.elements;
  assert.equal(panel.tag, "collapsible_panel");
  assert.equal(body.element_id, ELEMENT.answer);
  assert.match(body.content, /^结论 &lt;at id=all>&lt;\/at>\n```go\nif a < b \{\}\n```\n很长的说明/);
  assert.equal(card.config.streaming_mode, false);
  assert.match(card.config.summary.content, /^结论 <at id=all><\/at> ```go if a < b \{\} ``` 很长的说明.*…$/);
  assert.equal(Array.from(card.config.summary.content).length, 50);
  assert.doesNotMatch(text(card), /button/);

  // 没有步骤时上面是一行结果
  const quick = renderProgressCard(state({ phase: "done", endedAt: 1000, answer: "好的" }), "t", 0, streaming) as any;
  assert.deepEqual(
    quick.body.elements.map((e: any) => e.content),
    ["✅ 已完成 · 用时 1 秒", "好的"],
  );
  // 停止了没有回答；简单版本也带回答
  assert.equal((renderProgressCard(state({ phase: "stopped", endedAt: 0 }), "t", 0, streaming) as any).body.elements.length, 1);
  const plain = renderPlainProgressCard(state({ phase: "done", endedAt: 0, answer: "好的" }), 0, streaming) as any;
  assert.equal(plain.body.elements.at(-1).content, "好的");
});

test("卡片即回答：回答太长时卡片里只放开头（切在代码块里先合上），说明全文另外发", () => {
  const long = `\`\`\`\n${"x".repeat(MAX_CARD_ANSWER_CHARS)}\n\`\`\``;
  assert.equal(answerFitsCard(long), false);
  assert.equal(answerFitsCard("短"), true);
  const card = renderProgressCard(state({ phase: "done", endedAt: 0, answer: long }), "t", 0, streaming) as any;
  const content: string = card.body.elements.at(-1).content;
  assert.ok(content.endsWith("x\n```\n\n…（回答较长，全文另外发在下面）"));
  assert.ok(Buffer.byteLength(text(card)) <= MAX_CARD_BYTES);
});

test("卡片即回答：代码块按 CommonMark 认，```x``` 和缩进 4 格的不算开头；代码块里只转义 <at；> 开头的引用照常显示", () => {
  const render = (answer: string) =>
    (renderProgressCard(state({ phase: "done", endedAt: 0, answer }), "t", 0, streaming) as any).body.elements.at(-1).content as string;

  assert.equal(render("```x```\n<at id=all></at>"), "```x```\n&lt;at id=all>&lt;/at>");
  assert.equal(render("    ```\n<at id=all></at>"), "    ```\n&lt;at id=all>&lt;/at>");
  assert.equal(
    render("> 引用\n````go\nm := map[string]<-chan int{}\n<at id=all></at>\n```\n<font>\n````\n<b>"),
    "> 引用\n````go\nm := map[string]<-chan int{}\n&lt;at id=all>&lt;/at>\n```\n<font>\n````\n&lt;b>",
  );
  assert.equal(render("~~~\na<b\n~~~\na<b"), "~~~\na<b\n~~~\na&lt;b");
});

test("卡片即回答：回答里的表格、小标题、<font>、<text_tag> 照样显示，预览去掉标签和标题符号", () => {
  const answer = "# 结论 <text_tag color='red'>高风险</text_tag>\n\n| 服务 | CPU |\n|---|---|\n| union | <font color='red'>92%</font> |\n<at id=all></at>";
  const card = renderProgressCard(state({ phase: "done", endedAt: 0, answer }), "t", 0, streaming) as any;
  assert.equal(
    card.body.elements.at(-1).content,
    "#### 结论 <text_tag color='red'>高风险</text_tag>\n\n| 服务 | CPU |\n|---|---|\n| union | <font color='red'>92%</font> |\n&lt;at id=all>&lt;/at>",
  );
  assert.match(card.config.summary.content, /^结论 高风险 \| 服务 \| CPU \|/);
});

test("卡片即回答：生成时图的代码块显示成一行说明；结束后按段画成图和数字卡片；放不下、简单版本时换成文字", () => {
  const chart = '{"type":"line","title":"CPU","x":["a","b"],"series":[{"name":"p","data":[1,2]}]}';
  const answer = `结论\n\`\`\`kpi\n[{"label":"CPU","value":"2%"}]\n\`\`\`\n\`\`\`chart\n${chart}\n\`\`\`\n下一步`;
  const live = renderProgressCard(state({ live: { round: 1, reasoning: "", text: answer } }), "t", 0, streaming) as any;
  assert.equal(live.body.elements.find((e: any) => e.element_id === ELEMENT.answer).content, "结论\n📌 关键数字整理好后显示在这里…\n📊 图表画好后显示在这里…\n下一步");

  const segments = splitAnswer(answer).segments;
  const done = renderProgressCard(state({ phase: "done", endedAt: 0, answer, answerSegments: segments }), "t", 0, streaming) as any;
  assert.deepEqual(
    done.body.elements.map((e: any) => e.tag),
    ["markdown", "markdown", "column_set", "chart", "markdown"],
  );
  assert.equal(done.body.elements[1].content, "结论");
  assert.equal(done.config.summary.content, "结论 **CPU** 2% 📊 CPU（这里显示不了图） 下一步");

  // 简单版本、没核对过（answerSegments 为空）时都是文字
  const plain = renderPlainProgressCard(state({ phase: "done", endedAt: 0, answer, answerSegments: segments }), 0, streaming) as any;
  assert.equal(plain.body.elements.at(-1).content, "结论\n\n**CPU** 2%\n\n📊 CPU（这里显示不了图）\n\n下一步");
  const unchecked = renderProgressCard(state({ phase: "done", endedAt: 0, answer }), "t", 0, streaming) as any;
  assert.doesNotMatch(text(unchecked), /"tag":"chart"/);

  // 图的数据太多、卡片放不下：图换成文字
  const big = JSON.stringify({ type: "line", title: "大图", x: Array.from({ length: 25 }, (_, i) => `第${i}个时间点`.padEnd(38, "长")), series: Array.from({ length: 8 }, (_, s) => ({ name: `系列${s}`.padEnd(38, "名"), data: Array(25).fill(123456.789) })) });
  const bigAnswer = `结论\n\`\`\`chart\n${big}\n\`\`\``;
  const bigSegments = splitAnswer(bigAnswer).segments;
  assert.equal(bigSegments[1].kind, "chart");
  const tooBig = renderProgressCard(state({ phase: "done", endedAt: 0, answer: bigAnswer, answerSegments: bigSegments }), "t", 0, streaming) as any;
  assert.ok(Buffer.byteLength(text(tooBig)) <= MAX_CARD_BYTES);
  assert.match(tooBig.body.elements.at(-1).content, /📊 大图（这里显示不了图）/);
});

test("卡片即回答：图太大换成文字时用核对过的那几段，对不上被去掉的数字卡片不回来；没核对过时不显示数字卡片", () => {
  const big = JSON.stringify({ type: "line", title: "大图", x: Array.from({ length: 25 }, (_, i) => `第${i}个时间点`.padEnd(38, "长")), series: Array.from({ length: 8 }, (_, s) => ({ name: `系列${s}`.padEnd(38, "名"), data: Array(25).fill(123456.789) })) });
  const answer = `结论\n\`\`\`kpi\n[{"label":"CPU","value":"41%"},{"label":"内存","value":"88%"}]\n\`\`\`\n\`\`\`chart\n${big}\n\`\`\``;
  const parsed = splitAnswer(answer).segments;
  const verified = parsed.map((segment) => (segment.kind === "kpi" ? { ...segment, items: segment.items.slice(0, 1) } : segment));
  const card = renderProgressCard(state({ phase: "done", endedAt: 0, answer, answerSegments: verified }), "t", 0, streaming) as any;
  const content = card.body.elements.at(-1).content;
  assert.match(content, /\*\*CPU\*\* 41%/);
  assert.match(content, /📊 大图（这里显示不了图）/);
  assert.doesNotMatch(text(card), /88%/);

  const unchecked = renderProgressCard(state({ phase: "done", endedAt: 0, answer }), "t", 0, streaming) as any;
  assert.doesNotMatch(text(unchecked), /41%|88%/);
});

test("卡片即回答：回答最后的「接着查」按钮回传要问的话；生成时、简单版本里不放按钮", () => {
  const answer = '结论\n```actions\n["union 有没有重启"]\n```';
  const live = renderProgressCard(state({ live: { round: 1, reasoning: "", text: answer } }), "t", 0, streaming) as any;
  assert.doesNotMatch(text(live), /ask_followup/);

  const segments = splitAnswer(answer).segments;
  const done = renderProgressCard(state({ phase: "done", endedAt: 0, answer, answerSegments: segments }), "t", 0, streaming) as any;
  const button = done.body.elements.at(-1);
  assert.equal(button.tag, "button");
  assert.equal(button.text.content, "union 有没有重启");
  assert.deepEqual(button.behaviors, [{ type: "callback", value: { action: ASK_ACTION, q: "union 有没有重启" } }]);
  assert.equal(done.body.elements.at(-2).content, "可以接着查：");

  const plain = renderPlainProgressCard(state({ phase: "done", endedAt: 0, answer, answerSegments: segments }), 0, streaming) as any;
  assert.equal(plain.body.elements.at(-1).content, "结论\n\n可以接着问：「union 有没有重启」");
});
