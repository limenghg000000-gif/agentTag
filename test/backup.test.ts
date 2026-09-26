import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MemoryBackup } from "../src/backup.js";

const quiet = { info() {}, warn() {}, error() {} };

async function setup(keepDays = 14) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenttag-backup-"));
  const memoryDir = path.join(root, "memory");
  const backupDir = path.join(root, "backup", "memory");
  await mkdir(memoryDir);
  let now = new Date(2026, 8, 27, 5, 0);
  const logs: string[] = [];
  const backup = new MemoryBackup({
    memoryDir,
    backupDir,
    keepDays,
    logger: { ...quiet, info: (line: string) => logs.push(line) },
    now: () => now,
  });
  return {
    backup,
    memoryDir,
    backupDir,
    logs,
    setDay: (day: number) => {
      now = new Date(2026, 8, day, 5, 0);
    },
  };
}

test("每天第一次检查时备份所有群的记忆文件，同一天不重复备份", async () => {
  const t = await setup();
  await writeFile(path.join(t.memoryDir, "oc_a.json"), '{"entries":[1]}');
  await writeFile(path.join(t.memoryDir, "oc_b.json"), '{"entries":[2]}');

  const dir = await t.backup.runOnce();
  assert.equal(dir, path.join(t.backupDir, "2026-09-27"));
  assert.deepEqual((await readdir(dir!)).sort(), ["oc_a.json", "oc_b.json"]);
  assert.equal(await readFile(path.join(dir!, "oc_a.json"), "utf8"), '{"entries":[1]}');
  assert.equal((await stat(path.join(dir!, "oc_a.json"))).mode & 0o777, 0o600);
  assert.match(t.logs[0], /群记忆已备份到 .*2026-09-27（2 个群）/);

  // 同一天再改记忆也不会覆盖当天的备份
  await writeFile(path.join(t.memoryDir, "oc_a.json"), '{"entries":[]}');
  assert.equal(await t.backup.runOnce(), undefined);
  assert.equal(await readFile(path.join(dir!, "oc_a.json"), "utf8"), '{"entries":[1]}');
});

test("不备份写了一半的临时文件和 .corrupt- 文件", async () => {
  const t = await setup();
  await writeFile(path.join(t.memoryDir, "oc_a.json"), "{}");
  await writeFile(path.join(t.memoryDir, "oc_a.json.1234.tmp"), "{");
  await writeFile(path.join(t.memoryDir, "oc_b.json.corrupt-1700000000000"), "oops");

  const dir = await t.backup.runOnce();
  assert.deepEqual(await readdir(dir!), ["oc_a.json"]);
});

test("只保留最近几天的备份，清掉上次中途退出留下的临时目录", async () => {
  const t = await setup(3);
  await writeFile(path.join(t.memoryDir, "oc_a.json"), "{}");
  await mkdir(path.join(t.backupDir, ".tmp-leftover"), { recursive: true });
  for (const day of [23, 24, 25, 26]) {
    t.setDay(day);
    await t.backup.runOnce();
  }
  t.setDay(27);
  await t.backup.runOnce();

  assert.deepEqual((await readdir(t.backupDir)).sort(), ["2026-09-25", "2026-09-26", "2026-09-27"]);
  assert.match(t.logs.at(-1)!, /删掉了 1 份超过 3 天的旧备份/);
});

test("还没有任何群记忆时也能跑", async () => {
  const t = await setup();
  const dir = await t.backup.runOnce();
  assert.deepEqual(await readdir(dir!), []);
});
