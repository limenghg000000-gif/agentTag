import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { compareVersions, parseReleaseNotes } from "../src/announce.js";
import { RELEASE_NOTES_FILE } from "../src/config.js";

// 两份更新日志的规矩见 CLAUDE.md：技术版 CHANGELOG.md 每个改了行为的 PR 都加一个新版本，package.json 的版本号跟着改；
// 群里看得出变化的，产品版 RELEASE_NOTES.md 再用大白话写同一个版本号

const CHANGELOG_FILE = new URL("../CHANGELOG.md", import.meta.url);
const CATEGORIES = ["新增", "改进", "修复", "安全"];

async function readPackageVersions() {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8")) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };
  return { pkg, lock };
}

/** 技术版每个版本的正文（标题行之后到下一个版本之前） */
function changelogSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const part of text.split(/^(?=## )/m)) {
    const version = /^##\s+\[(\d+\.\d+\.\d+)\]/.exec(part)?.[1];
    if (version) {
      sections.set(version, part.slice(part.indexOf("\n") + 1));
    }
  }
  return sections;
}

function assertDescendingWithDates(file: string, versions: ReturnType<typeof parseReleaseNotes>, example: string) {
  assert.ok(versions.length > 0, `${file} 里要有「${example}」这样的版本`);
  for (let i = 1; i < versions.length; i++) {
    assert.ok(
      compareVersions(versions[i - 1]!.version, versions[i]!.version) > 0,
      `${file}：${versions[i - 1]!.version} 要比下面的 ${versions[i]!.version} 新`,
    );
  }
  for (const v of versions) {
    assert.ok(v.date && /^\d{4}-\d{2}-\d{2}$/.test(v.date), `${file}：${v.version} 的标题要写日期，如「${example}」`);
  }
}

test("CHANGELOG.md 最新的版本和 package.json、package-lock.json 的版本号一样", async () => {
  const versions = parseReleaseNotes(await readFile(CHANGELOG_FILE, "utf8"));
  const { pkg, lock } = await readPackageVersions();
  assert.ok(versions.length > 0, "CHANGELOG.md 里要有「## [x.y.z] - 日期」这样的版本");
  assert.equal(versions[0]!.version, pkg.version, "CHANGELOG.md 加了新版本要把 package.json 的 version 改成一样的");
  assert.equal(lock.version, pkg.version, "package-lock.json 的 version 也要改");
  assert.equal(lock.packages[""]?.version, pkg.version, "package-lock.json 里 packages[\"\"].version 也要改");
});

test("CHANGELOG.md 的版本从新到旧排、写日期，每一版按 新增/改进/修复/安全 分类，每条带 PR 号", async () => {
  const text = await readFile(CHANGELOG_FILE, "utf8");
  assertDescendingWithDates("CHANGELOG.md", parseReleaseNotes(text), "## [0.9.0] - 2026-10-15");
  const sections = changelogSections(text);
  assert.ok(sections.size > 0);
  for (const [version, body] of sections) {
    const headings = [...body.matchAll(/^###\s+(.+?)\s*$/gm)].map((m) => m[1]!);
    assert.ok(headings.length > 0, `CHANGELOG.md：${version} 要有 ### 新增、### 改进、### 修复 或 ### 安全`);
    for (const heading of headings) {
      assert.ok(CATEGORIES.includes(heading), `CHANGELOG.md：${version} 的「### ${heading}」只能是 ${CATEGORIES.join("、")}`);
    }
    const bullets = body.split("\n").filter((line) => line.startsWith("- "));
    assert.ok(bullets.length > 0, `CHANGELOG.md：${version} 至少要有一条「- 」开头的说明`);
    for (const bullet of bullets) {
      assert.match(bullet, /[（(]#\d+(?:[、，, ]+#\d+)*[）)]$/, `CHANGELOG.md：${version} 这条要在结尾写 PR 号，如（#46）：${bullet}`);
    }
  }
});

test("RELEASE_NOTES.md 的版本从新到旧排、写日期，每一版都能在 CHANGELOG.md 里找到，日期一样", async () => {
  const notes = parseReleaseNotes(await readFile(RELEASE_NOTES_FILE, "utf8"));
  const changelog = parseReleaseNotes(await readFile(CHANGELOG_FILE, "utf8"));
  const { pkg } = await readPackageVersions();
  assertDescendingWithDates("RELEASE_NOTES.md", notes, "## 0.9.0 — 2026-10-15");
  const dates = new Map(changelog.map((v) => [v.version, v.date]));
  for (const v of notes) {
    assert.ok(dates.has(v.version), `RELEASE_NOTES.md 的 ${v.version} 在 CHANGELOG.md 里没有，版本号要和技术版对上`);
    assert.equal(v.date, dates.get(v.version), `RELEASE_NOTES.md 的 ${v.version} 和 CHANGELOG.md 的日期要一样`);
    assert.ok(/^- /m.test(v.notes), `RELEASE_NOTES.md：${v.version} 至少要有一条「- 」开头的说明`);
    assert.ok(compareVersions(v.version, pkg.version) <= 0, `RELEASE_NOTES.md 的 ${v.version} 比 package.json 的 ${pkg.version} 还新`);
  }
});

test("程序里的版本号（MCP 握手、启动日志用）就是 package.json 的版本号", async () => {
  const { VERSION } = await import("../src/version.js");
  const { pkg } = await readPackageVersions();
  assert.equal(VERSION, pkg.version);
});
