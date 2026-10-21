import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCron, formatTime, nextRun, parseAt, parseCron, runsInWeek, shortestGapMinutes, upcomingRuns } from "../src/cron.js";

/** 北京时间的墙上时间 → 毫秒 */
const bj = (text: string) => Date.parse(`${text.replace(" ", "T")}:00+08:00`);

test("按北京时间算下一次：每周一 9 点，服务器是 UTC 也一样", () => {
  const cron = parseCron("0 9 * * 1");
  // 2026-10-21 是周三
  assert.equal(nextRun(cron, bj("2026-10-21 10:53")), bj("2026-10-26 09:00"));
  // 正好在那一分钟：算下一次，不重复
  assert.equal(nextRun(cron, bj("2026-10-26 09:00")), bj("2026-11-02 09:00"));
  assert.equal(nextRun(cron, bj("2026-10-26 08:59")), bj("2026-10-26 09:00"));
});

test("几种常见写法：工作日、几个时间点、每 2 小时、每月几号、星期 7 和英文缩写", () => {
  assert.equal(nextRun(parseCron("30 10 * * 1-5"), bj("2026-10-24 12:00")), bj("2026-10-26 10:30"));
  assert.deepEqual(upcomingRuns(parseCron("0 9,18 * * *"), bj("2026-10-21 10:00"), 3), [
    bj("2026-10-21 18:00"),
    bj("2026-10-22 09:00"),
    bj("2026-10-22 18:00"),
  ]);
  assert.equal(nextRun(parseCron("0 */2 * * *"), bj("2026-10-21 23:30")), bj("2026-10-22 00:00"));
  assert.equal(nextRun(parseCron("0 10 1 * *"), bj("2026-10-21 10:00")), bj("2026-11-01 10:00"));
  assert.equal(nextRun(parseCron("0 9 * * 7"), bj("2026-10-21 10:00")), bj("2026-10-25 09:00"));
  assert.equal(nextRun(parseCron("0 9 * * SUN"), bj("2026-10-21 10:00")), bj("2026-10-25 09:00"));
  assert.equal(nextRun(parseCron("0 9 1 JAN *"), bj("2026-10-21 10:00")), bj("2027-01-01 09:00"));
  // 几号和星期都写了：满足一样就算（cron 的老规矩）
  assert.equal(nextRun(parseCron("0 9 1 * 5"), bj("2026-10-21 10:00")), bj("2026-10-23 09:00"));
  // 8 年内碰不到的；2 月 29 号刚过完也找得到下一个闰年
  assert.equal(nextRun(parseCron("0 9 31 2 *"), bj("2026-10-21 10:00")), undefined);
  assert.equal(nextRun(parseCron("0 9 29 2 *"), bj("2028-03-01 10:00")), bj("2032-02-29 09:00"));
});

test("写错的 cron 报出哪一段不对", () => {
  assert.throws(() => parseCron("0 9 * *"), /5 段/);
  assert.throws(() => parseCron("0 25 * * *"), /「时」那段只能写 0～23/);
  assert.throws(() => parseCron("0 9 * * 8"), /「星期」那段/);
  assert.throws(() => parseCron("*/0 9 * * *"), /正整数/);
  assert.throws(() => parseCron("0 9-5 * * *"), /写反了/);
  assert.throws(() => parseCron("0 9 * * MONDAY"), /「星期」那段/);
  assert.throws(() => parseCron("*/2/3 9 * * *"), /\/ 只能有一个/);
  assert.throws(() => parseCron("0 1-2-3 * * *"), /只能有一个 -/);
});

test("相邻两次最短隔多久、一周跑几次", () => {
  const now = bj("2026-10-21 10:00");
  assert.equal(shortestGapMinutes(parseCron("*/30 * * * *"), now), 30);
  assert.equal(shortestGapMinutes(parseCron("0,30 9 * * *"), now), 30);
  assert.equal(shortestGapMinutes(parseCron("0 * * * *"), now), 60);
  assert.equal(shortestGapMinutes(parseCron("0 9 * * 1"), now), 7 * 24 * 60);
  assert.equal(runsInWeek(parseCron("0 * * * *"), now), 168);
  assert.equal(runsInWeek(parseCron("0 9 * * 1-5"), now), 5);
});

test("一次性的时间按北京时间读，不存在的日期报错", () => {
  assert.equal(parseAt("2026-10-22 15:00"), bj("2026-10-22 15:00"));
  assert.equal(parseAt("2026/10/22 15:00"), bj("2026-10-22 15:00"));
  assert.equal(parseAt("2026-10-22T15:00:30"), bj("2026-10-22 15:00") + 30_000);
  assert.throws(() => parseAt("2026-10-22 15:00:61"), /不存在/);
  assert.equal(parseAt("2026-10-22 9：05"), bj("2026-10-22 09:05"));
  assert.throws(() => parseAt("2026-02-30 09:00"), /不存在/);
  assert.throws(() => parseAt("2026-10-22 25:00"), /不存在/);
  assert.throws(() => parseAt("明天下午三点"), /2026-10-22 15:00/);
});

test("用大白话说时间", () => {
  const now = bj("2026-10-21 10:00");
  assert.equal(formatTime(bj("2026-10-26 09:00"), now), "10-26（周一）09:00");
  assert.equal(formatTime(bj("2027-01-01 09:00"), now), "2027-01-01（周五）09:00");
  assert.equal(describeCron(parseCron("0 9 * * 1")), "每周一 09:00");
  assert.equal(describeCron(parseCron("30 10 * * 1-5")), "工作日（周一到周五） 10:30");
  assert.equal(describeCron(parseCron("0 9,18 * * *")), "每天 09:00、18:00");
  assert.equal(describeCron(parseCron("0 10 1,15 * *")), "每月 1 号、15 号 10:00");
  assert.equal(describeCron(parseCron("5 * * * *")), "每小时 05 分");
  assert.equal(describeCron(parseCron("0 */2 * * *")), "每 2 小时（00:00、02:00、04:00…）");
  assert.equal(describeCron(parseCron("0 9 * * 6,0")), "每周末 09:00");
  assert.equal(describeCron(parseCron("0 * * * 1-5")), "工作日（周一到周五） 每小时 00 分");
  // 说不清的写原文
  assert.equal(describeCron(parseCron("0 9 1 1 *")), "cron「0 9 1 1 *」");
});
