import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  GRACE_MS,
  MAX_FAILURES,
  MAX_PER_CHAT,
  MAX_PER_CREATOR,
  type RunResult,
  type ScheduledTask,
  Scheduler,
  type SchedulerOptions,
} from "../src/schedules.js";
import { createScheduleTools } from "../src/tools/schedules.js";
import type { Tool } from "../src/tools/tool.js";

const quiet = { info() {}, warn() {}, error() {} };
const bj = (text: string) => Date.parse(`${text.replace(" ", "T")}:00+08:00`);
const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "schedules-"));
  dirs.push(dir);
  return path.join(dir, "schedules.json");
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(overrides: Partial<SchedulerOptions> = {}) {
  const clock = { now: bj("2026-10-21 10:00") };
  const ran: { task: ScheduledTask; late: number }[] = [];
  const notes: { chatId: string; markdown: string }[] = [];
  let result: RunResult = "done";
  const scheduler = new Scheduler({
    allowedChatIds: new Set(["oc_1", "oc_2"]),
    run: async (task, late) => {
      ran.push({ task: { ...task }, late });
      return result;
    },
    notify: async (chatId, markdown) => {
      notes.push({ chatId, markdown });
    },
    logger: quiet,
    now: () => clock.now,
    ...overrides,
  });
  return { scheduler, clock, ran, notes, setResult: (next: RunResult) => (result = next) };
}

const ml = { openId: "ou_ml", name: "ML" };
const base = { chatId: "oc_1", creator: ml, messageId: "om_1" };

test("建周期任务：算好下一次；到点跑一次，先算好再下一次再跑", async () => {
  const { scheduler, clock, ran } = setup();
  const task = scheduler.create({ ...base, prompt: "汇总上周群里的进展", cron: "0 9 * * 1" });
  assert.equal(task.id, 1);
  assert.equal(task.nextRunAt, bj("2026-10-26 09:00"));

  clock.now = bj("2026-10-26 08:59");
  scheduler.tick();
  assert.equal(ran.length, 0);

  clock.now = bj("2026-10-26 09:00") + 20_000;
  scheduler.tick();
  // 先记好下一次：跑到一半重启不会重跑
  assert.equal(task.nextRunAt, bj("2026-11-02 09:00"));
  assert.equal(task.runs, 1);
  await tick();
  assert.equal(ran.length, 1);
  assert.equal(ran[0]!.late, 20_000);
  assert.equal(task.lastResult, "done");
  // 同一分钟再看一次不会重跑
  scheduler.tick();
  await tick();
  assert.equal(ran.length, 1);
});

test("一次性任务跑完就结束；时间已经过了、一年以后、cron 和 at 都填或都不填的报错", () => {
  const { scheduler, clock } = setup();
  const once = scheduler.create({ ...base, prompt: "提醒看发版", at: "2026-10-21 15:00", remind: true });
  assert.equal(once.nextRunAt, bj("2026-10-21 15:00"));
  assert.equal(once.remind, true);
  assert.throws(() => scheduler.create({ ...base, prompt: "x", at: "2026-10-21 09:00" }), /已经过了/);
  assert.throws(() => scheduler.create({ ...base, prompt: "x", at: "2027-12-01 09:00" }), /一年以后/);
  assert.throws(() => scheduler.create({ ...base, prompt: "x", at: "2026-10-22 09:00", cron: "0 9 * * *" }), /只填一个/);
  assert.throws(() => scheduler.create({ ...base, prompt: "x" }), /只填一个/);
  assert.throws(() => scheduler.create({ ...base, prompt: "  ", cron: "0 9 * * *" }), /不能是空的/);
  assert.throws(() => scheduler.create({ ...base, prompt: "x".repeat(1001), cron: "0 9 * * *" }), /最多 1000 字/);

  clock.now = bj("2026-10-21 15:00");
  scheduler.tick();
  assert.equal(once.status, "finished");
  assert.equal(once.nextRunAt, undefined);
  assert.deepEqual(scheduler.list("oc_1"), []);
  assert.deepEqual(scheduler.recentlyEnded("oc_1", 5).map((task) => task.id), [once.id]);
});

test("上限：两次至少隔 1 小时、每群 20 个、每人 10 个、每群每天要干活的最多跑 48 次（纯提醒不算）", () => {
  const { scheduler } = setup();
  assert.throws(() => scheduler.create({ ...base, prompt: "x", cron: "*/30 * * * *" }), /至少隔 60 分钟.*最短只隔 30 分钟/);
  assert.throws(() => scheduler.create({ ...base, prompt: "x", cron: "0 9 31 2 *" }), /8 年内一次都不会跑/);

  for (let i = 0; i < MAX_PER_CREATOR; i++) {
    scheduler.create({ ...base, prompt: `任务 ${i}`, cron: "0 9 * * *" });
  }
  assert.throws(() => scheduler.create({ ...base, chatId: "oc_2", prompt: "再来一个", cron: "0 9 * * *" }), /每人最多建 10 个.*ML已经建满了/);
  for (let i = MAX_PER_CREATOR; i < MAX_PER_CHAT; i++) {
    scheduler.create({ ...base, creator: { openId: `ou_${i}` }, prompt: `任务 ${i}`, cron: "0 9 * * *" });
  }
  assert.throws(() => scheduler.create({ ...base, creator: { openId: "ou_new" }, prompt: "x", cron: "0 9 * * *" }), /这个群已经有 20 个/);

  const other = setup().scheduler;
  other.create({ ...base, prompt: "每小时查告警", cron: "0 * * * *" });
  other.create({ ...base, creator: { openId: "ou_2" }, prompt: "每小时再查一遍日志", cron: "30 * * * *" });
  assert.throws(() => other.create({ ...base, creator: { openId: "ou_3" }, prompt: "每天汇总", cron: "0 18 * * *" }), /每天最多跑 48 次（纯提醒不算），加上这个就要每天约 49 次了/);
  // 纯提醒不调模型，不算
  other.create({ ...base, creator: { openId: "ou_4" }, prompt: "每小时提醒喝水", cron: "15 * * * *", remind: true });
});

test("暂停、恢复、取消：只有建的人和管理员能做，别的群的任务找不到", () => {
  const { scheduler, clock } = setup();
  const task = scheduler.create({ ...base, prompt: "汇总", cron: "0 9 * * 1" });
  const guest = { openId: "ou_guest", name: "访客" };

  assert.throws(() => scheduler.change("oc_1", task.id, "pause", guest, false), /是ML建的，只有建的人和管理员/);
  assert.throws(() => scheduler.change("oc_2", task.id, "pause", ml, false), /这个群里没有定时任务 T1/);

  scheduler.change("oc_1", task.id, "pause", ml, false);
  assert.equal(task.status, "paused");
  assert.equal(task.nextRunAt, undefined);
  assert.throws(() => scheduler.change("oc_1", task.id, "pause", ml, false), /已经是暂停的了/);
  clock.now = bj("2026-10-27 10:00");
  // 管理员能恢复别人建的：从现在算下一次
  scheduler.change("oc_1", task.id, "resume", guest, true);
  assert.equal(task.status, "active");
  assert.equal(task.nextRunAt, bj("2026-11-02 09:00"));
  assert.deepEqual(task.changedBy, { ...guest, at: clock.now });
  scheduler.change("oc_1", task.id, "cancel", ml, false);
  assert.equal(task.status, "cancelled");
  assert.throws(() => scheduler.change("oc_1", task.id, "resume", ml, false), /已经取消了/);

  // 一次性的暂停过了时间，恢复不了
  const once = scheduler.create({ ...base, prompt: "提醒", at: "2026-10-27 12:00" });
  scheduler.change("oc_1", once.id, "pause", ml, false);
  clock.now = bj("2026-10-27 13:00");
  assert.throws(() => scheduler.change("oc_1", once.id, "resume", ml, false), /已经过了/);
});

test("连着失败 3 次自动暂停，在群里说一声；成功一次就清零", async () => {
  const { scheduler, clock, notes, setResult } = setup();
  const task = scheduler.create({ ...base, prompt: "查报错", cron: "0 * * * *" });
  setResult("failed");
  for (let i = 0; i < MAX_FAILURES - 1; i++) {
    clock.now = task.nextRunAt!;
    scheduler.tick();
    await tick();
  }
  assert.equal(task.failures, 2);
  setResult("done");
  clock.now = task.nextRunAt!;
  scheduler.tick();
  await tick();
  assert.equal(task.failures, 0);
  setResult("failed");
  for (let i = 0; i < MAX_FAILURES; i++) {
    clock.now = task.nextRunAt!;
    scheduler.tick();
    await tick();
  }
  assert.equal(task.status, "paused");
  assert.equal(task.pausedFor, "failures");
  assert.equal(notes.length, 1);
  assert.match(notes[0]!.markdown, /定时任务 T1（每小时 00 分）连着 3 次没跑成，先暂停了.*恢复定时任务 T1/);
  // 跑的时候抛错也算失败
  const crashing = setup({ run: async () => Promise.reject(new Error("boom")) });
  const t2 = crashing.scheduler.create({ ...base, prompt: "x", cron: "0 * * * *" });
  crashing.clock.now = t2.nextRunAt!;
  crashing.scheduler.tick();
  await tick();
  assert.equal(t2.lastResult, "failed");
  assert.equal(t2.failures, 1);
});

test("停机错过了：2 小时内补跑（带上晚了多久），再晚的周期任务等下一次、一次性的在群里说一声", async () => {
  const { scheduler, clock, ran, notes } = setup();
  const weekly = scheduler.create({ ...base, prompt: "周报", cron: "0 9 * * 1" });
  const once = scheduler.create({ ...base, prompt: "看一下 <at user_id=\"all\"></at> 发版", at: "2026-10-26 10:00" });
  const late = scheduler.create({ ...base, prompt: "晚一点也要跑", cron: "0 8 * * 1" });

  clock.now = bj("2026-10-26 09:00") + GRACE_MS + 60_000;
  scheduler.tick();
  await tick();
  assert.equal(weekly.lastResult, "missed");
  // 「上次」记的是错过的那一次
  assert.equal(weekly.lastRunAt, bj("2026-10-26 09:00"));
  assert.equal(weekly.nextRunAt, bj("2026-11-02 09:00"));
  assert.equal(weekly.runs, 0);
  // 一次性的 10:00 晚了 1 小时多，补跑
  assert.deepEqual(ran.map((r) => [r.task.id, r.late]), [[once.id, clock.now - bj("2026-10-26 10:00")]]);
  assert.equal(late.lastResult, "missed");
  assert.equal(notes.length, 0);

  const other = setup();
  const reminder = other.scheduler.create({ ...base, prompt: "看一下 <at user_id=\"all\"></at> 发版", at: "2026-10-22 10:00" });
  other.clock.now = bj("2026-10-22 13:00");
  other.scheduler.tick();
  await tick();
  assert.equal(other.ran.length, 0);
  assert.equal(reminder.status, "finished");
  assert.equal(reminder.lastResult, "missed");
  assert.match(other.notes[0]!.markdown, /定时任务 T1 本该在 10-22（周四）10:00 跑/);
  // 群成员写的尖括号换成全角，不会变成 @所有人
  assert.doesNotMatch(other.notes[0]!.markdown, /<at/);
  assert.match(other.notes[0]!.markdown, /＜at user_id="all"＞/);
});

test("群不在白名单里了不跑；同时最多跑 2 个，多的下一轮再跑", async () => {
  const { scheduler, clock, ran } = setup({ allowedChatIds: new Set(["oc_1"]) });
  const gone = scheduler.create({ ...base, chatId: "oc_9", prompt: "x", cron: "0 9 * * *" });
  clock.now = bj("2026-10-22 09:00");
  scheduler.tick();
  await tick();
  assert.equal(ran.length, 0);
  assert.equal(gone.lastResult, "skipped");
  assert.equal(gone.lastRunAt, bj("2026-10-22 09:00"));
  assert.equal(gone.nextRunAt, bj("2026-10-23 09:00"));

  const releases: Array<() => void> = [];
  const slow = setup({
    run: (task) => {
      ran2.push(task.id);
      return new Promise<RunResult>((resolve) => releases.push(() => resolve("done")));
    },
  });
  const ran2: number[] = [];
  for (let i = 0; i < 3; i++) {
    slow.scheduler.create({ ...base, creator: { openId: `ou_${i}` }, prompt: `任务 ${i}`, cron: "0 9 * * *" });
  }
  slow.clock.now = bj("2026-10-22 09:00");
  slow.scheduler.tick();
  await tick();
  assert.deepEqual(ran2, [1, 2]);
  releases.shift()!();
  await tick();
  slow.clock.now += 30_000;
  slow.scheduler.tick();
  await tick();
  assert.deepEqual(ran2, [1, 2, 3]);
  releases.forEach((release) => release());
});

test("记在文件里：重启后接着跑，编号接着往下排；文件坏了先备份再从空的开始", async () => {
  const file = await tempFile();
  const first = setup({ file });
  await first.scheduler.init();
  const task = first.scheduler.create({ ...base, prompt: "周报", cron: "0 9 * * 1" });
  first.scheduler.change("oc_1", task.id, "pause", ml, false);
  first.scheduler.create({ ...base, prompt: "提醒", at: "2026-10-22 15:00", remind: true, readOnly: true });
  await first.scheduler.flush();

  const second = setup({ file });
  await second.scheduler.init();
  assert.deepEqual(
    second.scheduler.list("oc_1").map((t) => [t.id, t.status, t.remind ?? false, t.readOnly ?? false]),
    [
      [2, "active", true, true],
      [1, "paused", false, false],
    ],
  );
  assert.equal(second.scheduler.create({ ...base, prompt: "再建一个", cron: "0 18 * * *" }).id, 3);
  await second.scheduler.flush();
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.nextId, 4);
  assert.equal(saved.tasks.length, 3);

  await writeFile(file, "{坏了", "utf8");
  const errors: unknown[] = [];
  const broken = setup({ file, logger: { ...quiet, error: (...args: unknown[]) => errors.push(args) } });
  await broken.scheduler.init();
  assert.deepEqual(broken.scheduler.list("oc_1"), []);
  assert.equal(errors.length, 1);
  const files = await readdir(path.dirname(file));
  assert.ok(files.some((name) => name.startsWith("schedules.json.bad-")));
});

test("到点先把下一次写进文件再跑；跑到一半重启的，上次的结果记成被停止", async () => {
  const file = await tempFile();
  const saved: Array<[number | undefined, string]> = [];
  let release!: () => void;
  const first = setup({
    file,
    run: async () => {
      const state = JSON.parse(await readFile(file, "utf8"));
      saved.push(...state.tasks.map((t: ScheduledTask) => [t.nextRunAt, t.status] as [number | undefined, string]));
      return new Promise<RunResult>((resolve) => (release = () => resolve("done")));
    },
  });
  await first.scheduler.init();
  const weekly = first.scheduler.create({ ...base, prompt: "周报", cron: "0 9 * * 1" });
  first.clock.now = bj("2026-10-26 09:00");
  first.scheduler.tick();
  // 写文件要等磁盘：最多等 5 秒
  for (let i = 0; i < 500 && saved.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // 跑的时候文件里已经是下一次了，重启不会把这次再跑一遍
  assert.deepEqual(saved, [[bj("2026-11-02 09:00"), "active"]]);
  assert.equal(first.scheduler.list("oc_1")[0]!.id, weekly.id);

  // 这时候机器人重启了：读回来的「上次」没有结果，算被停止
  const second = setup({ file });
  await second.scheduler.init();
  const [restored] = second.scheduler.list("oc_1");
  assert.equal(restored!.lastRunAt, bj("2026-10-26 09:00"));
  assert.equal(restored!.lastResult, "stopped");
  release();
  await first.scheduler.stop();
});

test("停下时不再看新到点的，等正在跑的记完结果", async () => {
  let release!: () => void;
  const { scheduler, clock } = setup({ run: () => new Promise<RunResult>((resolve) => (release = () => resolve("stopped"))), tickMs: 10 });
  const task = scheduler.create({ ...base, prompt: "x", cron: "0 9 * * *" });
  clock.now = bj("2026-10-22 09:00");
  scheduler.start();
  await tick();
  assert.equal(task.runs, 1);
  const stopped = scheduler.stop();
  release();
  await stopped;
  assert.equal(task.lastResult, "stopped");
  // 被停止不算失败
  assert.equal(task.failures, 0);
});

/** 跑一个工具 */
async function call(tool: Tool | undefined, args: Record<string, unknown>, writable?: boolean): Promise<string> {
  assert.ok(tool);
  return tool.run(args, { signal: new AbortController().signal, ...(writable !== undefined ? { writable } : {}) });
}

test("工具：建好照实说时间和怎么取消；只能看、改本群的；别人建的要管理员才能停", async () => {
  const { scheduler } = setup();
  const tools = (senderId: string, canManageAll: boolean, chatId = "oc_1") =>
    new Map(
      createScheduleTools({
        scheduler,
        chatId,
        senderId,
        askerName: senderId === "ou_ml" ? "ML" : "访客",
        messageId: "om_1",
        canManageAll,
        now: () => bj("2026-10-21 10:00"),
      }).map((tool) => [tool.spec.name, tool]),
    );
  const mine = tools("ou_ml", false);
  const created = await call(mine.get("schedule_create"), { task: "汇总上周群里的进展", cron: "0 9 * * 1" }, true);
  assert.match(created, /已建好定时任务 T1（到点去做）：每周一 09:00（北京时间），下次是 10-26（周一）09:00/);
  assert.match(created, /取消定时任务 T1/);
  assert.equal(scheduler.list("oc_1")[0]!.readOnly, undefined);
  assert.equal(scheduler.list("oc_1")[0]!.creator.name, "ML");

  // 这次没有改文档的工具（不在写权限名单里、带着群聊）：记成只读
  const reminder = await call(mine.get("schedule_create"), { task: "看发版", at: "2026-10-22 15:00", remind: true }, false);
  assert.match(reminder, /T2（纯提醒）：10-22（周四）15:00 一次/);
  assert.equal(scheduler.list("oc_1").find((t) => t.id === 2)!.readOnly, true);
  await assert.rejects(call(mine.get("schedule_create"), { task: "x", cron: "*/10 * * * *" }, true), /至少隔 60 分钟/);

  const listed = await call(mine.get("schedule_list"), {});
  assert.match(listed, /这个群有 2 个定时任务/);
  assert.match(listed, /T2 · 10-22（周四）15:00 一次 · 纯提醒 · 看发版 · ML建的 · 下次 10-22（周四）15:00（已跑 0 次）/);
  assert.equal(await call(tools("ou_ml", false, "oc_2").get("schedule_list"), {}), "这个群还没有定时任务。");

  const guest = tools("ou_guest", false);
  await assert.rejects(call(guest.get("schedule_change"), { id: "T1", action: "cancel" }), /只有建的人和管理员/);
  await assert.rejects(call(tools("ou_ml", false, "oc_2").get("schedule_change"), { id: "T1", action: "cancel" }), /这个群里没有定时任务 T1/);
  await assert.rejects(call(mine.get("schedule_change"), { id: "第一个", action: "cancel" }), /编号/);
  assert.match(await call(mine.get("schedule_change"), { id: "#1", action: "pause" }), /已暂停定时任务 T1/);
  assert.match(await call(tools("ou_guest", true).get("schedule_change"), { id: 1, action: "resume" }), /已恢复定时任务 T1：每周一 09:00，汇总上周群里的进展。下次是/);
  assert.match(await call(mine.get("schedule_change"), { id: "t1", action: "cancel" }), /已取消定时任务 T1/);
  assert.match(await call(mine.get("schedule_list"), {}), /最近跑完、取消了的：\n- T1 .*已取消/);
});
