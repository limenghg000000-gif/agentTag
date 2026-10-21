import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { compareVersions, parseReleaseNotes, resolveNotesLink } from "../src/announce.js";
import { RELEASE_NOTES_FILE } from "../src/config.js";

// 两份更新日志的规矩见 CLAUDE.md：平时合并的改动写在两份文件最上面的「## 未发布」，不改版本号；
// 说「发版」时把「未发布」改成一个版本，package.json 的版本号跟着改，群里只收到一张卡片

const CHANGELOG_FILE = new URL("../CHANGELOG.md", import.meta.url);
const CATEGORIES = ["新增", "改进", "修复", "安全"];
const UNRELEASED = "未发布";
/** 从这一版起，产品版要按「新功能」「改进和修复」两块写厚：每个新功能写能做什么、谁用得上、这么说，改进和修复写以前、现在 */
const DETAILED_NOTES_FROM = "0.20.0";
const NEW_FEATURES = "**新功能**";
const FIXES = "**改进和修复**";
/** 单独一行的文档链接，卡片上做成按钮，不算说明 */
const LINK_LINE = /^\s*(?:[-*]\s+)?\[[^[\]\n]+\]\([^()\s]+\)\s*$/;
const PR_REF = /[（(]#\d+(?:[、，, ]+#\d+)*[）)]$/;

/** 按「## 」切开的每一段：标题（「## 」后面的字）和正文 */
function h2Sections(text: string): { title: string; body: string }[] {
  return text
    .split(/^(?=## )/m)
    .filter((part) => part.startsWith("## "))
    .map((part) => ({ title: part.slice(3, part.indexOf("\n") === -1 ? undefined : part.indexOf("\n")).trim(), body: part.slice(part.indexOf("\n") + 1) }));
}

/** 「## 未发布」只能有一个，而且在所有版本上面；返回它的正文，没有时为空 */
function unreleased(file: string, text: string): string | undefined {
  const sections = h2Sections(text);
  const found = sections.filter((section) => section.title === UNRELEASED);
  assert.ok(found.length <= 1, `${file}：「## ${UNRELEASED}」只能有一个`);
  if (found.length === 0) {
    return undefined;
  }
  assert.equal(sections[0]!.title, UNRELEASED, `${file}：「## ${UNRELEASED}」要放在所有版本上面`);
  return found[0]!.body;
}

/** 技术版一段（一个版本或「未发布」）：按 新增/改进/修复/安全 分类，每条带 PR 号 */
function assertChangelogBody(label: string, body: string, allowEmpty: boolean) {
  const headings = [...body.matchAll(/^###\s+(.+?)\s*$/gm)].map((m) => m[1]!);
  const bullets = body.split("\n").filter((line) => line.startsWith("- "));
  if (allowEmpty && headings.length === 0 && bullets.length === 0) {
    return;
  }
  assert.ok(headings.length > 0, `CHANGELOG.md：${label} 要有 ### 新增、### 改进、### 修复 或 ### 安全`);
  for (const heading of headings) {
    assert.ok(CATEGORIES.includes(heading), `CHANGELOG.md：${label} 的「### ${heading}」只能是 ${CATEGORIES.join("、")}`);
  }
  assert.ok(bullets.length > 0, `CHANGELOG.md：${label} 至少要有一条「- 」开头的说明`);
  for (const bullet of bullets) {
    assert.match(bullet, PR_REF, `CHANGELOG.md：${label} 这条要在结尾写 PR 号，如（#46）：${bullet}`);
  }
}

/**
 * 产品版写厚了没有（一个版本或「未发布」的正文）。版本要先有一行加粗的一句话；下面分「**新功能**」「**改进和修复**」两块：
 * 每个新功能一段，加粗的名字下面有「- 能做什么：」「- 谁用得上：」「- 这么说：」（带「」括起来的原话）；
 * 改进和修复每条「- **名字**：以前……；现在……」
 */
function assertDetailedNotes(label: string, body: string, headline: boolean) {
  const lines: string[] = [];
  for (const line of body.split("\n")) {
    if (/^###\s/.test(line)) {
      break;
    }
    if (line.trim() && !LINK_LINE.test(line)) {
      lines.push(line.trimEnd());
    }
  }
  if (lines.length === 0 && !headline) {
    return;
  }
  const where = `RELEASE_NOTES.md：${label}`;
  if (headline) {
    const first = lines.shift() ?? "";
    assert.ok(/^\*\*[^*]+\*\*$/.test(first) && first !== NEW_FEATURES && first !== FIXES, `${where} 第一行要是加粗的一句话，说这一版带来了什么`);
  }
  assert.ok(lines.includes(NEW_FEATURES) || lines.includes(FIXES), `${where} 要分「${NEW_FEATURES}」「${FIXES}」两块写`);
  let group: string | undefined;
  let feature: { name: string; lines: string[] } | undefined;
  const features: { name: string; lines: string[] }[] = [];
  for (const line of lines) {
    if (line === NEW_FEATURES || line === FIXES) {
      group = line;
      feature = undefined;
      continue;
    }
    assert.ok(group, `${where}：「${line}」要写在「${NEW_FEATURES}」或「${FIXES}」下面`);
    if (group === NEW_FEATURES) {
      if (/^\*\*[^*]+\*\*$/.test(line)) {
        feature = { name: line, lines: [] };
        features.push(feature);
        continue;
      }
      assert.ok(feature && line.startsWith("- "), `${where}：新功能先写一行加粗的名字，下面每条「- 」开头：${line}`);
      feature.lines.push(line);
    } else {
      assert.match(line, /^- \*\*[^*]+\*\*：/, `${where}：改进和修复每条写成「- **名字**：以前……；现在……」：${line}`);
      assert.ok(line.includes("以前") && line.includes("现在"), `${where}：改进和修复要写清以前是什么样、现在是什么样：${line}`);
    }
  }
  for (const { name, lines: items } of features) {
    for (const label of ["能做什么", "谁用得上", "这么说"]) {
      assert.ok(
        items.some((item) => item.startsWith(`- ${label}：`)),
        `${where}：新功能 ${name} 下面要有一条「- ${label}：」`,
      );
    }
    assert.match(items.find((item) => item.startsWith("- 这么说："))!, /「[^」]+」/, `${where}：新功能 ${name} 的「这么说」要写能直接在群里说的原话，用「」括起来`);
  }
}

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
    assertChangelogBody(version, body, false);
  }
});

test("两份更新日志最上面的「## 未发布」：平时合并的写在这里，技术版按分类带 PR 号，产品版按发版的写法写厚", async () => {
  const changelog = unreleased("CHANGELOG.md", await readFile(CHANGELOG_FILE, "utf8"));
  if (changelog !== undefined) {
    assertChangelogBody(UNRELEASED, changelog, true);
  }
  const notes = unreleased("RELEASE_NOTES.md", await readFile(RELEASE_NOTES_FILE, "utf8"));
  if (notes !== undefined) {
    assertDetailedNotes(UNRELEASED, notes, false);
  }
});

test(`RELEASE_NOTES.md 从 ${DETAILED_NOTES_FROM} 起每一版写厚：一句话、新功能写能做什么谁用得上怎么说、改进和修复写以前现在`, async () => {
  for (const { title, body } of h2Sections(await readFile(RELEASE_NOTES_FILE, "utf8"))) {
    const version = parseReleaseNotes(`## ${title}\n`)[0]?.version;
    if (version && compareVersions(version, DETAILED_NOTES_FROM) >= 0) {
      assertDetailedNotes(version, body, true);
    }
  }
});

test("产品版写厚的检查本身：缺了「谁用得上」、修复没写以前现在、没分块的都报出来", () => {
  const good = "**能定时做事了**\n\n**新功能**\n\n**定时任务**\n- 能做什么：到点做事\n- 谁用得上：要定期看告警的同事\n- 这么说：「每周一早上 9 点汇总」\n\n[怎么用](功能说明)\n\n**改进和修复**\n\n- **重启不忘话题**：以前重启后要重新 @；现在照样记得。\n";
  assertDetailedNotes("例子", good, true);
  assertDetailedNotes(UNRELEASED, good.slice(good.indexOf(NEW_FEATURES)), false);
  assertDetailedNotes(UNRELEASED, "\n", false);
  for (const bad of [
    good.replace("- 谁用得上：要定期看告警的同事\n", ""),
    good.replace("「每周一早上 9 点汇总」", "每周一早上 9 点汇总"),
    good.replace("以前重启后要重新 @；现在照样记得", "重启后照样记得"),
    good.replace("- **重启不忘话题**：", "- 重启不忘话题："),
    "**能定时做事了**\n\n- 能定时做事了\n",
    "**新功能**\n\n**定时任务**\n- 能做什么：到点做事\n",
  ]) {
    assert.throws(() => assertDetailedNotes("例子", bad, true));
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

test("RELEASE_NOTES.md 里的文档链接写「文档中心」「功能说明」（可以带 #小节）或 https 地址，不放 GitHub 地址", async () => {
  const notes = parseReleaseNotes(await readFile(RELEASE_NOTES_FILE, "utf8"));
  const options = { link: "https://features.example.com/", docsLink: "https://docs.example.com/" };
  for (const v of notes) {
    for (const link of v.links ?? []) {
      assert.ok(resolveNotesLink(link.target, options), `RELEASE_NOTES.md：${v.version} 的链接「${link.text}」打不开：${link.target}`);
      assert.ok(!/github\.com/i.test(link.target), `RELEASE_NOTES.md：${v.version} 的链接不要放 GitHub 地址，同事看得到：${link.target}`);
    }
  }
});

test("程序里的版本号（MCP 握手、启动日志用）就是 package.json 的版本号", async () => {
  const { VERSION } = await import("../src/version.js");
  const { pkg } = await readPackageVersions();
  assert.equal(VERSION, pkg.version);
});
