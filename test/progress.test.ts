import assert from "node:assert/strict";
import { test } from "node:test";
import { CardUpdater, formatDuration, type ProgressState, renderPlainProgressCard, renderProgressCard, STOP_ACTION } from "../src/progress.js";

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
