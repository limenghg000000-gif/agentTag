import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskRegistry } from "../src/tasks.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("同一话题的任务依次执行，不同话题互不影响", async () => {
  const tasks = new TaskRegistry();
  const a = tasks.create("oc_1", "t1");
  const b = tasks.create("oc_1", "t1");
  const other = tasks.create("oc_1", "t2");
  assert.equal(a.queued, false);
  assert.equal(b.queued, true);
  assert.equal(other.queued, false);

  let bStarted = false;
  void b.waitTurn().then(() => (bStarted = true));
  assert.equal(await other.waitTurn(), true);
  assert.equal(await a.waitTurn(), true);
  await tick();
  assert.equal(bStarted, false);

  tasks.finish(a);
  await tick();
  assert.equal(bStarted, true);
});

test("排队中的任务被停止后立即返回，但后面的任务仍要等前面的都结束", async () => {
  const tasks = new TaskRegistry();
  const a = tasks.create("oc_1", "t1");
  const b = tasks.create("oc_1", "t1");
  const c = tasks.create("oc_1", "t1");

  const bTurn = b.waitTurn();
  assert.equal(tasks.stop(b.id), true);
  assert.equal(await bTurn, false);
  tasks.finish(b);

  let cStarted = false;
  void c.waitTurn().then(() => (cStarted = true));
  await tick();
  assert.equal(cStarted, false);
  tasks.finish(a);
  await tick();
  assert.equal(cStarted, true);
});

test("按话题、按群停止，停止按钮只对本群的任务生效", () => {
  const tasks = new TaskRegistry();
  const a = tasks.create("oc_1", "t1");
  const b = tasks.create("oc_1", "t1");
  const c = tasks.create("oc_1", "t2");
  const d = tasks.create("oc_2", "t3");

  assert.equal(tasks.stop(d.id, "oc_1"), false);
  assert.equal(tasks.stopThread("t1"), 2);
  assert.ok(a.signal.aborted && b.signal.aborted && !c.signal.aborted);
  assert.equal(tasks.stopThread("t1"), 0);
  assert.equal(tasks.stopChat("oc_1"), 1);
  assert.equal(tasks.stopAll(), 1);
  assert.ok(d.signal.aborted);
});

test("idle 等所有任务结束", async () => {
  const tasks = new TaskRegistry();
  const a = tasks.create("oc_1", "t1");
  let idle = false;
  const waiting = tasks.idle(10_000).then(() => (idle = true));
  await tick();
  assert.equal(idle, false);
  tasks.finish(a);
  await waiting;
  assert.equal(tasks.size, 0);
});
