import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MemoryBackup } from "../src/backup.js";
import { ADMINS_TARGET, GroupSettings, parseSettings } from "../src/settings.js";

const quiet = { info() {}, warn() {}, error() {} };
const record = { by: "ou_ml", byName: "ML", targetName: "运营群", changes: [{ field: "写权限", before: "照服务器上的配置", after: "只有这 1 人：ou_b" }] };

async function setup() {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), "agenttag-settings-")), "settings");
  const settings = new GroupSettings({ dir, logger: quiet, now: () => new Date("2026-10-22T10:00:00Z") });
  await settings.init();
  return { dir, settings };
}

test("没有配置文件时从空的开始；存了以后重启读得回来，改动记录追加一行", async () => {
  const { dir, settings } = await setup();
  assert.equal(settings.override("oc_ops"), undefined);
  assert.equal(settings.version("oc_ops"), 0);

  assert.equal(await settings.saveGroup("oc_ops", { writeAllowed: ["ou_b", "ou_b"], mcp: {}, proactive: true }, 0, record), "saved");
  assert.deepEqual(settings.override("oc_ops"), { writeAllowed: ["ou_b"], proactive: true }, "重复的人去掉，空的 mcp 不存");
  assert.equal(settings.version("oc_ops"), 1);
  assert.equal(await settings.saveAdmins(["ou_a", "ou_a"], 0, { ...record, targetName: "管理员名单" }), "saved");

  const again = new GroupSettings({ dir, logger: quiet });
  await again.init();
  assert.deepEqual(again.override("oc_ops"), { writeAllowed: ["ou_b"], proactive: true });
  assert.deepEqual([...again.admins()], ["ou_a"]);
  assert.equal(again.version(ADMINS_TARGET), 1);
  assert.deepEqual(again.chatIds(), ["oc_ops"]);

  const log = (await readFile(path.join(dir, "changes.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(log.length, 2);
  assert.deepEqual(log[0], { at: "2026-10-22T10:00:00.000Z", target: "oc_ops", ...record });
  assert.equal(log[1].target, ADMINS_TARGET);
});

test("打开卡片以后别人改过（版本号对不上）的不存，什么都不改", async () => {
  const { settings } = await setup();
  await settings.saveGroup("oc_ops", { knowledge: false }, 0, record);
  assert.equal(await settings.saveGroup("oc_ops", { knowledge: true }, 0, record), "stale");
  assert.deepEqual(settings.override("oc_ops"), { knowledge: false });
  assert.equal(await settings.saveAdmins(["ou_a"], 3, record), "stale");
  assert.equal(settings.admins().size, 0);
});

test("全部改回照服务器上的配置：这个群从配置文件里去掉，版本号照样往上加", async () => {
  const { settings } = await setup();
  await settings.saveGroup("oc_ops", { codeRepos: [] }, 0, record);
  assert.equal(await settings.saveGroup("oc_ops", {}, 1, record), "saved");
  assert.equal(settings.override("oc_ops"), undefined);
  assert.deepEqual(settings.chatIds(), []);
  assert.equal(settings.version("oc_ops"), 2);
});

test("配置文件写坏了启动时报错，不当成空的（卡片上收紧过的群会悄悄放宽）", async () => {
  const { dir } = await setup();
  await writeFile(path.join(dir, "groups.json"), "{ not json");
  await assert.rejects(new GroupSettings({ dir, logger: quiet }).init(), /群配置文件 .*groups\.json 格式不对（不是 JSON）/);
});

test("配置文件逐项核对：不认识的项、不是 open_id 的人、不对的工具写法都整个不认", () => {
  const bad = (value: unknown) => () => parseSettings(JSON.stringify(value), "groups.json");
  assert.throws(bad([]), /不是对象/);
  assert.throws(bad({ admins: ["张三"] }), /admins 要是 open_id 的列表/);
  assert.throws(bad({ groups: { oc_a: { writers: [] } } }), /群 oc_a：不认识 writers/);
  assert.throws(bad({ groups: { oc_a: { writeAllowed: ["ou_a", 1] } } }), /writeAllowed 要是 open_id 的列表/);
  assert.throws(bad({ groups: { oc_a: { mcp: { aiops: "some" } } } }), /mcp\.aiops 要是 all、off 或工具名的列表/);
  assert.throws(bad({ groups: { oc_a: { proactive: "yes" } } }), /proactive 要是 true 或 false/);
  assert.throws(bad({ groups: { oc_a: { enabled: 1 } } }), /enabled 要是 true 或 false/);
  assert.deepEqual(parseSettings(JSON.stringify({ groups: { oc_a: { enabled: false, knowledge: true } } }), "groups.json").groups, { oc_a: { enabled: false, knowledge: true } });
  assert.throws(bad({ versions: { oc_a: -1 } }), /versions 要是不小于 0 的整数/);
  assert.deepEqual(parseSettings("{}", "groups.json"), { admins: [], groups: {}, versions: {} });
});

test("配置文件和群记忆一样每天备份，日志里写「群配置」", async () => {
  const { dir, settings } = await setup();
  await settings.saveGroup("oc_ops", { proactive: false }, 0, record);
  const logs: string[] = [];
  const backup = new MemoryBackup({
    memoryDir: dir,
    backupDir: path.join(dir, "..", "backup", "settings"),
    keepDays: 14,
    label: "群配置",
    unit: "个文件",
    logger: { ...quiet, info: (line: string) => logs.push(line) },
    now: () => new Date(2026, 9, 22, 5, 0),
  });
  const day = await backup.runOnce();
  assert.ok(day);
  assert.match(await readFile(path.join(day, "groups.json"), "utf8"), /"proactive": false/);
  assert.match(logs[0], /^群配置已备份到 .*2026-10-22（1 个文件）/);
});
