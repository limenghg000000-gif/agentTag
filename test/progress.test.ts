import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CardUpdater,
  formatDuration,
  MAX_CARD_BYTES,
  type ProgressState,
  renderPlainProgressCard,
  renderProgressCard,
  STOP_ACTION,
} from "../src/progress.js";

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
