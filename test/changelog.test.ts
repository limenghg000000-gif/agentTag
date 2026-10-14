import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { compareVersions, parseChangelog } from "../src/announce.js";
import { CHANGELOG_FILE } from "../src/config.js";

// 更新日志的规矩见 CLAUDE.md：每个改了群里能看到的行为的 PR 在最上面加一个新版本，package.json 的版本号跟着改

test("CHANGELOG.md 最新的版本和 package.json、package-lock.json 的版本号一样", async () => {
  const versions = parseChangelog(await readFile(CHANGELOG_FILE, "utf8"));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8")) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };
  assert.ok(versions.length > 0, "CHANGELOG.md 里要有「## x.y.z — 日期」这样的版本");
  assert.equal(versions[0]!.version, pkg.version, "加了新版本要把 package.json 的 version 改成一样的");
  assert.equal(lock.version, pkg.version, "package-lock.json 的 version 也要改");
  assert.equal(lock.packages[""]?.version, pkg.version, "package-lock.json 里 packages[\"\"].version 也要改");
});

test("CHANGELOG.md 的版本从新到旧排、不重复，每一版都有要发到群里的说明", async () => {
  const versions = parseChangelog(await readFile(CHANGELOG_FILE, "utf8"));
  for (let i = 1; i < versions.length; i++) {
    assert.ok(
      compareVersions(versions[i - 1]!.version, versions[i]!.version) > 0,
      `${versions[i - 1]!.version} 要比下面的 ${versions[i]!.version} 新`,
    );
  }
  for (const v of versions) {
    assert.ok(/^- /m.test(v.notes), `${v.version} 在 ### 之前要有至少一条「- 」开头的说明`);
    assert.ok(v.date && /^\d{4}-\d{2}-\d{2}$/.test(v.date), `${v.version} 的标题要写日期：## ${v.version} — 2026-10-14`);
  }
});

test("程序里的版本号（MCP 握手、启动日志用）就是 package.json 的版本号", async () => {
  const { VERSION } = await import("../src/version.js");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});
