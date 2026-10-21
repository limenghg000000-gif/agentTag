import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SendInput } from "@larksuiteoapi/node-sdk";
import {
  compareVersions,
  MAX_ANNOUNCED_VERSIONS,
  MAX_CARD_BYTES,
  MAX_NOTES_CHARS,
  MAX_TECH_CHARS,
  MAX_TECH_TOTAL_CHARS,
  parseChangelogTech,
  parseReleaseNotes,
  pendingVersions,
  MAX_VERSION_LINKS,
  renderAnnouncementCard,
  renderAnnouncementMarkdown,
  resolveNotesLink,
  UpdateAnnouncer,
} from "../src/announce.js";

const quiet = { info() {}, warn() {}, error() {} };

const NOTES = `# 产品更新说明

说明文字，不属于任何版本。

## 未发布

- 还在做的，不发

## 0.10.0 — 2026-10-16

**第十版**

- 新功能 A（#50）
- 新功能 B（#51、#52）

### 管理员

- 新配置 X，不发群里

## 0.9.1 — 2026-10-15

**修了问题**

- 修好了 C (#49)

## 0.9.0

**第九版**

- 新功能 D（#47, #48）
`;

test("读产品更新说明：版本、日期、### 之前的说明，去掉 PR 号；没有版本号的段跳过", () => {
  const versions = parseReleaseNotes(NOTES);
  assert.deepEqual(
    versions.map((v) => [v.version, v.date]),
    [
      ["0.10.0", "2026-10-16"],
      ["0.9.1", "2026-10-15"],
      ["0.9.0", undefined],
    ],
  );
  assert.equal(versions[0]!.notes, "**第十版**\n\n- 新功能 A\n- 新功能 B");
  assert.equal(versions[1]!.notes, "**修了问题**\n\n- 修好了 C");
  assert.equal(versions[2]!.notes, "**第九版**\n\n- 新功能 D");
  assert.ok(versions.every((v) => !v.notes.includes("不发")));
});

test("也认开源项目常用的「## [0.9.0] - 日期」标题", () => {
  const versions = parseReleaseNotes("## [Unreleased]\n\n- 不发\n\n## [0.9.0] - 2026-10-15\n\n- 新功能（#47）\n\n## [0.8.0]\n\n- 旧功能\n");
  assert.deepEqual(
    versions.map((v) => [v.version, v.date, v.notes]),
    [
      ["0.9.0", "2026-10-15", "- 新功能"],
      ["0.8.0", undefined, "- 旧功能"],
    ],
  );
});

test("版本号按数字比较，0.10.0 比 0.9.1 新", () => {
  assert.ok(compareVersions("0.10.0", "0.9.1") > 0);
  assert.ok(compareVersions("0.9.0", "0.9.1") < 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("要发哪几版：没发过只发最新的一版；发过就发比上次新的，新的在前；回退或已是最新时不发", () => {
  const versions = parseReleaseNotes(NOTES);
  assert.deepEqual(pendingVersions(versions, undefined).map((v) => v.version), ["0.10.0"]);
  assert.deepEqual(pendingVersions(versions, "0.9.0").map((v) => v.version), ["0.10.0", "0.9.1"]);
  assert.deepEqual(pendingVersions(versions, "0.10.0"), []);
  assert.deepEqual(pendingVersions(versions, "0.11.0"), []);
  assert.deepEqual(pendingVersions([], undefined), []);
});

test("通知卡片：标题带最新版本号，几个版本各写「x.y.z 更新了什么」，转义尖括号，按钮打开配置的链接", () => {
  const versions = [
    { version: "0.10.0", date: "2026-10-16", notes: "**第十版**\n- 能 <at id=all></at> 了" },
    { version: "0.9.1", notes: "- 修好了" },
  ];
  const card = renderAnnouncementCard(versions, { botName: "飞书 CLI", link: "https://docs.example.com/agenttag", firstTime: true });
  const json = JSON.stringify(card);
  assert.match(json, /AgentTag 更新了 · 0\.10\.0/);
  assert.match(json, /\*\*0\.10\.0 更新了什么\*\*/);
  assert.match(json, /\*\*0\.9\.1 更新了什么\*\*/);
  assert.ok(!json.includes("本次更新了什么"));
  assert.ok(!json.includes("<at"), "说明里的 <at> 不能真的 @ 人");
  assert.match(json, /&lt;at id=all&gt;/);
  assert.match(json, /我是飞书 CLI/);
  assert.match(json, /"default_url":"https:\/\/docs\.example\.com\/agenttag"/);
  assert.match(json, /产品功能说明/);

  // 只有一个版本时写「本次更新了什么」和版本号、日期；没配链接时没有按钮
  const single = JSON.stringify(renderAnnouncementCard([versions[0]!], { botName: "飞书 CLI" }));
  assert.match(single, /\*\*本次更新了什么\*\*.*版本 0\.10\.0 · 2026-10-16/);
  assert.ok(!single.includes("button"));
  assert.ok(!single.includes("我是"));
  assert.match(JSON.stringify(renderAnnouncementCard([versions[1]!])), /版本 0\.9\.1(?! ·)/);
});

test("版本说明里单独一行的链接拿出来做按钮，最多 MAX_VERSION_LINKS 个，多的和句子里的链接留在说明里", () => {
  const extra = Array.from({ length: MAX_VERSION_LINKS + 1 }, (_, i) => `- [文档 ${i + 1}](文档中心#s${i + 1})`).join("\n");
  const [v] = parseReleaseNotes(
    `## 0.13.0 — 2026-10-16\n\n**能看文档了**\n\n- 新功能，详见 [说明](https://a.example.com)（#57）\n\n[改代码怎么用](功能说明#guide-f-code)\n${extra}\n`,
  );
  assert.deepEqual(v!.links?.map((link) => [link.text, link.target]), [
    ["改代码怎么用", "功能说明#guide-f-code"],
    ["文档 1", "文档中心#s1"],
    ["文档 2", "文档中心#s2"],
  ]);
  assert.equal(v!.notes, `**能看文档了**\n\n- 新功能，详见 [说明](https://a.example.com)\n\n- [文档 3](文档中心#s3)\n- [文档 4](文档中心#s4)`);
  assert.equal(parseReleaseNotes("## 0.9.0\n\n- 没有链接\n")[0]!.links, undefined);
});

test("说明按单独一行的链接切成几段，记下每个链接在哪", () => {
  const [v] = parseReleaseNotes(
    "## 0.20.0 — 2026-10-22\n\n**能定时做事了**\n\n**新功能**\n\n**定时任务**\n- 能做什么：到点做事（#69）\n\n[定时任务怎么用](功能说明#guide-f-schedule)\n\n**读群聊**\n- 能做什么：总结群里聊了什么\n\n[读群聊怎么用](文档中心)\n",
  );
  assert.deepEqual(v!.parts, [
    "**能定时做事了**\n\n**新功能**\n\n**定时任务**\n- 能做什么：到点做事",
    "**读群聊**\n- 能做什么：总结群里聊了什么",
    "",
  ]);
  assert.equal(v!.notes, "**能定时做事了**\n\n**新功能**\n\n**定时任务**\n- 能做什么：到点做事\n\n**读群聊**\n- 能做什么：总结群里聊了什么");
  assert.equal(parseReleaseNotes("## 0.9.0\n\n- 没有链接\n")[0]!.parts, undefined);
});

test("通知卡片：每个新功能的文档按钮放在它那一段下面，挨着的放一排，打不开的不放；说明截短过的按钮都放最后", () => {
  const [v] = parseReleaseNotes(
    "## 0.20.0 — 2026-10-22\n\n**能定时做事了**\n\n**定时任务**\n- 能做什么：到点做事\n\n[定时任务怎么用](功能说明)\n[没配的](http://x)\n[常见问题](文档中心#faq)\n\n**读群聊**\n- 能做什么：总结\n",
  );
  const options = { link: "https://features.example.com", docsLink: "https://docs.example.com" };
  const card = renderAnnouncementCard([v!], options) as { body: { elements: { tag: string; content?: string; columns?: unknown[] }[] } };
  const elements = card.body.elements;
  assert.deepEqual(
    elements.map((e) => e.tag),
    ["markdown", "column_set", "markdown", "markdown", "column_set"],
  );
  assert.match(elements[0]!.content!, /本次更新了什么[\s\S]*\*\*定时任务\*\*\n- 能做什么：到点做事$/);
  assert.equal(elements[1]!.columns!.length, 2, "定时任务下面两个按钮放一排，没配的那个不放");
  assert.match(JSON.stringify(elements[1]), /定时任务怎么用[\s\S]*https:\/\/features\.example\.com[\s\S]*常见问题[\s\S]*https:\/\/docs\.example\.com#faq/);
  assert.equal(elements[2]!.content, "**读群聊**\n- 能做什么：总结");

  // 说明太长截短过：整段在前，按钮放最后
  const long = { ...v!, notes: `${v!.notes}\n${"- 很长很长的一句说明\n".repeat(MAX_NOTES_CHARS / 10)}` };
  const cut = (renderAnnouncementCard([long], options) as { body: { elements: { tag: string }[] } }).body.elements.map((e) => e.tag);
  assert.deepEqual(cut, ["markdown", "column_set", "markdown", "column_set"]);
});

test("通知卡片放满了也在飞书 30 KB 以内", () => {
  const notes = Array.from({ length: MAX_NOTES_CHARS }, (_, i) => (i % 40 === 39 ? "\n" : i % 7 === 0 ? "<" : "说")).join("");
  const tech = Array.from({ length: MAX_TECH_CHARS * 2 }, (_, i) => (i % 40 === 39 ? "\n" : i % 7 === 0 ? "<" : "改")).join("");
  const versions = Array.from({ length: MAX_ANNOUNCED_VERSIONS }, (_, i) => ({
    version: `0.${30 - i}.0`,
    date: "2026-10-22",
    notes,
    tech,
    links: [{ text: "怎么用怎么用怎么用怎么用怎么用怎么用", target: "文档中心#a" }],
  }));
  const card = renderAnnouncementCard(versions, { botName: "飞书 CLI", link: "https://features.example.com", docsLink: "https://docs.example.com" });
  const bytes = Buffer.byteLength(JSON.stringify(card));
  assert.ok(bytes <= MAX_CARD_BYTES, `卡片 ${bytes} 字节，飞书上限 30 KB`);

  // 全是尖括号：每个转义成 4 个字节，字数没超但字节超了，从最后一版起去掉技术说明
  const angle = (n: number) => Array.from({ length: n }, (_, i) => (i % 40 === 39 ? "\n" : "<")).join("");
  const worst = [
    { version: "0.31.0", notes: angle(MAX_NOTES_CHARS / 2), tech: angle(MAX_TECH_TOTAL_CHARS / 2) },
    { version: "0.30.0", notes: angle(MAX_NOTES_CHARS / 2), tech: angle(MAX_TECH_TOTAL_CHARS / 2) },
  ];
  const full = renderAnnouncementCard(worst, { docsLink: "https://docs.example.com" });
  const fullJson = JSON.stringify(full);
  assert.ok(Buffer.byteLength(fullJson) <= MAX_CARD_BYTES, `卡片 ${Buffer.byteLength(fullJson)} 字节`);
  assert.equal(fullJson.match(/collapsible_panel/g)?.length, 1, "第二版的技术说明去掉，第一版的留着");
  assert.match(fullJson, /技术说明（0\.31\.0/);
});

test("文档链接：「文档中心」「功能说明」换成配置的地址（# 换成写的小节），https 原样用，别的、没配的不放", () => {
  const options = { link: "https://features.example.com/page#old", docsLink: "https://docs.example.com/page" };
  assert.equal(resolveNotesLink("文档中心", options), "https://docs.example.com/page");
  assert.equal(resolveNotesLink("文档中心#guide-f-code", options), "https://docs.example.com/page#guide-f-code");
  assert.equal(resolveNotesLink("功能说明#guide-f-about", options), "https://features.example.com/page#guide-f-about");
  assert.equal(resolveNotesLink("https://x.example.com/a?b=1", options), "https://x.example.com/a?b=1");
  assert.equal(resolveNotesLink("文档中心", { link: options.link }), undefined);
  assert.equal(resolveNotesLink("http://x.example.com", options), undefined);
  assert.equal(resolveNotesLink("javascript:alert(1)", options), undefined);
  assert.equal(resolveNotesLink("文档中心#a b", options), undefined);
  assert.equal(resolveNotesLink("别的文档", options), undefined);
});

test("通知卡片：标题用产品名 AgentTag；每版的文档按钮放在这一版说明下面；最下面一排是「产品功能说明」「文档中心」", () => {
  const versions = [
    { version: "0.13.0", notes: "- 新功能", links: [{ text: "怎么用", target: "文档中心#guide-f-about" }, { text: "没配的", target: "http://x" }] },
    { version: "0.12.1", notes: "- 修好了" },
  ];
  const options = { botName: "飞书 CLI", link: "https://features.example.com", docsLink: "https://docs.example.com" };
  const card = renderAnnouncementCard(versions, options) as { header: { title: { content: string } }; body: { elements: { tag: string }[] } };
  assert.equal(card.header.title.content, "AgentTag 更新了 · 0.13.0");
  const json = JSON.stringify(card);
  const buttons = [...json.matchAll(/"content":"([^"]+)"},"type":"(\w+)","size":"small","behaviors":\[\{"type":"open_url","default_url":"([^"]+)"/g)].map(
    (m) => [m[1], m[2], m[3]],
  );
  assert.deepEqual(buttons, [
    ["怎么用", "default", "https://docs.example.com#guide-f-about"],
    ["产品功能说明", "primary", "https://features.example.com"],
    ["文档中心", "default", "https://docs.example.com"],
  ]);
  assert.deepEqual(
    card.body.elements.map((element) => element.tag),
    ["markdown", "column_set", "markdown", "markdown", "column_set"],
  );
  // 只配了一个链接时只放那一个
  const onlyDocs = JSON.stringify(renderAnnouncementCard([versions[1]!], { docsLink: "https://docs.example.com" }));
  assert.match(onlyDocs, /文档中心/);
  assert.ok(!onlyDocs.includes("产品功能说明"));

  const markdown = renderAnnouncementMarkdown(versions, options);
  assert.match(markdown, /^\*\*AgentTag 更新了 · 0\.13\.0\*\*/);
  assert.match(markdown, /- 新功能\n怎么用：https:\/\/docs\.example\.com#guide-f-about/);
  assert.match(markdown, /产品功能说明：https:\/\/features\.example\.com\n文档中心：https:\/\/docs\.example\.com$/);
  assert.ok(!markdown.includes("没配的"));
});

test("读技术版更新日志：版本号对应整段内容，分类小标题换成加粗，没有版本号的段跳过", () => {
  const tech = parseChangelogTech(
    "# 更新日志\n\n说明\n\n## [Unreleased]\n\n- 不要\n\n## [0.9.0] - 2026-10-15\n\n### 新增\n\n- 功能 A（#47）\n\n### 修复\n\n- 问题 B（#48）\n\n## [0.8.0] - 2026-10-14\n\n### 改进\n\n- 改进 C（#46）\n",
  );
  assert.deepEqual([...tech.keys()], ["0.9.0", "0.8.0"]);
  assert.equal(tech.get("0.9.0"), "**新增**\n\n- 功能 A（#47）\n\n**修复**\n\n- 问题 B（#48）");
  assert.equal(tech.get("0.8.0"), "**改进**\n\n- 改进 C（#46）");
});

test("通知卡片：有技术说明的版本下面放一个默认收起的「技术说明」，尖括号转义；太长的截短，加起来超了后面的不放", () => {
  const card = renderAnnouncementCard([{ version: "0.9.0", notes: "- 新功能", tech: "**新增**\n- 支持 <at id=all></at>（#47）" }]) as {
    body: { elements: { tag: string; expanded?: boolean; elements?: { content: string }[] }[] };
  };
  const panel = card.body.elements.find((e) => e.tag === "collapsible_panel");
  assert.ok(panel, "要有折叠面板");
  assert.equal(panel.expanded, false);
  assert.match(panel.elements![0]!.content, /支持 &lt;at id=all&gt;&lt;\/at&gt;（#47）/);
  assert.match(JSON.stringify(card), /技术说明（0\.9\.0，给开发看）/);
  // 没有技术说明的版本不放面板
  assert.ok(!JSON.stringify(renderAnnouncementCard([{ version: "0.9.0", notes: "- 新功能" }])).includes("collapsible_panel"));

  const longTech = Array.from({ length: 200 }, (_, i) => `- 第 ${i} 条技术改动，写得很长很长很长`).join("\n");
  const shortTech = Array.from({ length: 40 }, (_, i) => `- 第 ${i} 条小改动，写得很长很长很长`).join("\n");
  assert.ok(longTech.length > MAX_TECH_CHARS && MAX_TECH_CHARS + shortTech.length <= MAX_TECH_TOTAL_CHARS);
  const versions = [
    { version: "0.12.0", notes: "- 改了", tech: longTech },
    { version: "0.11.0", notes: "- 改了", tech: shortTech },
    { version: "0.10.0", notes: "- 改了", tech: longTech },
  ];
  const json = JSON.stringify(renderAnnouncementCard(versions));
  assert.equal(json.match(/collapsible_panel/g)?.length, 2, "第一版截短，第二版放得下，第三版加起来超了上限不放");
  // 没配文档中心就不说去文档中心看，配了才说
  assert.match(json, /太长了没列全）/);
  assert.ok(!json.includes("文档中心"));
  assert.match(JSON.stringify(renderAnnouncementCard(versions, { docsLink: "https://docs.example.com" })), /太长了没列全，见文档中心的更新日志）/);
  // 退回的文字不带技术说明
  assert.ok(!renderAnnouncementMarkdown(versions).includes("技术改动"));
});

test("通知卡片最多列几个版本，更早的只说还有几个", () => {
  const versions = Array.from({ length: MAX_ANNOUNCED_VERSIONS + 2 }, (_, i) => ({ version: `0.${20 - i}.0`, notes: `- 第 ${20 - i} 版` }));
  const json = JSON.stringify(renderAnnouncementCard(versions));
  assert.match(json, /还有 2 个更早的版本没列出来。/);
  assert.match(JSON.stringify(renderAnnouncementCard(versions, { docsLink: "https://docs.example.com" })), /还有 2 个更早的版本没列出来，见文档中心的更新日志。/);
  assert.ok(!json.includes(`第 ${20 - MAX_ANNOUNCED_VERSIONS} 版`));
});

test("退回的文字和卡片列一样多的版本、一样的字数上限，尖括号换成全角", () => {
  const long = Array.from({ length: 200 }, (_, i) => `- 第 ${i} 条很长很长很长很长很长很长的说明`).join("\n");
  const versions = [
    { version: "0.12.0", notes: `${long}\n- 能 <at id=all></at> 了` },
    { version: "0.11.0", notes: "- 上一版" },
  ];
  const text = renderAnnouncementMarkdown(versions, { botName: "飞书 CLI" });
  assert.ok(!text.includes("<"), "Markdown 里的 <at> 也会 @所有人");
  assert.ok(text.length < MAX_NOTES_CHARS + 500, `退回的文字太长：${text.length} 字`);
  assert.match(text, /太长了没列全/);
  // 第一版已经占满字数，第二版只说还有几个，和卡片一样
  assert.match(text, /还有 1 个更早的版本没列出来/);
  assert.ok(!text.includes("上一版"));
  const card = JSON.stringify(renderAnnouncementCard(versions, { botName: "飞书 CLI" }));
  assert.match(card, /还有 1 个更早的版本没列出来/);
  assert.match(card, /太长了没列全/);

  assert.match(renderAnnouncementMarkdown([{ version: "0.1.0", notes: "- 能 <at id=all></at> 了" }]), /＜at id=all＞＜\/at＞/);
});

test("退回的文字末尾也和卡片一样：第一次收到时介绍一句自己，以后说照常 @ 我", () => {
  const versions = [{ version: "0.8.0", notes: "- 新功能" }];
  const first = renderAnnouncementMarkdown(versions, { botName: "飞书 CLI", firstTime: true });
  assert.match(first, /我是飞书 CLI，在群里 @ 我就能提问、派活。以后每次更新，我都会在这里说一声。/);
  const later = renderAnnouncementMarkdown(versions, { botName: "飞书 CLI" });
  assert.match(later, /有问题、想让我做什么，照常在群里 @ 我。/);
  assert.ok(!later.includes("我是飞书 CLI"));
  // 机器人名字里的尖括号也换成全角
  assert.match(renderAnnouncementMarkdown(versions, { botName: "<at id=all></at>", firstTime: true }), /我是＜at id=all＞＜\/at＞/);
});

async function setup(chatIds = ["oc_a", "oc_b"]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agenttag-announce-"));
  const notesFile = path.join(dir, "RELEASE_NOTES.md");
  const stateFile = path.join(dir, "announce", "state.json");
  await writeFile(notesFile, NOTES);
  const sent: { to: string; input: SendInput }[] = [];
  const scheduled: (() => void)[] = [];
  let fail: (to: string, input: SendInput) => boolean | string = () => false;
  const make = () =>
    new UpdateAnnouncer({
      notesFile,
      stateFile,
      chatIds,
      send: async (to, input) => {
        const failure = fail(to, input);
        if (failure) {
          // 飞书 SDK 的 LarkChannelError 带 code：format_error、send_timeout、rate_limited……
          throw Object.assign(new Error("飞书报错"), { code: typeof failure === "string" ? failure : "unknown" });
        }
        sent.push({ to, input });
        return { messageId: `om_${sent.length}`, chatId: to } as never;
      },
      botName: () => "飞书 CLI",
      logger: quiet,
      schedule: (fn) => {
        scheduled.push(fn);
      },
    });
  return {
    notesFile,
    stateFile,
    sent,
    scheduled,
    make,
    setFail: (fn: typeof fail) => {
      fail = fn;
    },
    state: async () => JSON.parse(await readFile(stateFile, "utf8")) as { chats: Record<string, string> },
  };
}

test("第一次启动每个群只发最新的一版并记下来，再启动不重发；有了新版本只发新的", async () => {
  const t = await setup();
  await t.make().run();
  assert.deepEqual(t.sent.map((s) => s.to), ["oc_a", "oc_b"]);
  assert.match(JSON.stringify(t.sent[0]!.input), /更新了 · 0\.10\.0/);
  assert.ok(!JSON.stringify(t.sent[0]!.input).includes("0.9.1"));
  assert.deepEqual((await t.state()).chats, { oc_a: "0.10.0", oc_b: "0.10.0" });

  await t.make().run();
  assert.equal(t.sent.length, 2, "重启不重发");

  await writeFile(t.notesFile, NOTES.replace("## 未发布", "## 0.11.0 — 2026-10-17\n\n- 新功能 E（#53）\n\n## 未发布"));
  await t.make().run();
  assert.equal(t.sent.length, 4);
  const card = JSON.stringify(t.sent[2]!.input);
  assert.match(card, /更新了 · 0\.11\.0/);
  assert.match(card, /新功能 E/);
  assert.ok(!card.includes("#53"));
  assert.deepEqual((await t.state()).chats, { oc_a: "0.11.0", oc_b: "0.11.0" });
});

test("一个群发不出去不影响别的群，过一阵再试，试够次数就等下次重启", async () => {
  const t = await setup();
  t.setFail((to) => to === "oc_a");
  await t.make().run();
  assert.deepEqual(t.sent.map((s) => s.to), ["oc_b"]);
  assert.deepEqual((await t.state()).chats, { oc_b: "0.10.0" });
  assert.equal(t.scheduled.length, 1);

  // 再试一次就好了：只补发没发出去的群
  t.setFail(() => false);
  t.scheduled.shift()!();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(t.sent.map((s) => s.to), ["oc_b", "oc_a"]);
  assert.deepEqual((await t.state()).chats, { oc_a: "0.10.0", oc_b: "0.10.0" });
  assert.equal(t.scheduled.length, 0);
});

test("一直发不出去时最多试 6 次", async () => {
  const t = await setup(["oc_a"]);
  t.setFail(() => true);
  await t.make().run();
  for (let i = 0; i < 10 && t.scheduled.length > 0; i++) {
    t.scheduled.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(t.scheduled.length, 0);
  assert.equal(t.sent.length, 0);
  await assert.rejects(t.state());
});

test("飞书说卡片格式不对时改发文字", async () => {
  const t = await setup(["oc_a"]);
  t.setFail((_, input) => ("card" in input ? "format_error" : false));
  await t.make().run();
  assert.equal(t.sent.length, 1);
  const input = t.sent[0]!.input as { markdown: string };
  assert.match(input.markdown, /AgentTag 更新了 · 0\.10\.0/);
  assert.match(input.markdown, /新功能 A/);
  assert.deepEqual((await t.state()).chats, { oc_a: "0.10.0" });
});

test("卡片超时、限流时不改发文字（卡片可能已经发出去了），过一阵再发卡片", async () => {
  const t = await setup(["oc_a"]);
  t.setFail((_, input) => ("card" in input ? "send_timeout" : false));
  await t.make().run();
  assert.equal(t.sent.length, 0);
  assert.equal(t.scheduled.length, 1);

  t.setFail(() => false);
  t.scheduled.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(t.sent.length, 1);
  assert.ok("card" in t.sent[0]!.input);
});

test("配了技术版更新日志时，卡片上带同一版本的技术说明；读不到也照发，只是不带", async () => {
  const t = await setup(["oc_a"]);
  const changelogFile = path.join(path.dirname(t.notesFile), "CHANGELOG.md");
  await writeFile(changelogFile, "## [0.10.0] - 2026-10-16\n\n### 新增\n\n- 技术改动 X（#50）\n\n## [0.9.1] - 2026-10-15\n\n### 修复\n\n- 技术改动 Y（#49）\n");
  const sent: SendInput[] = [];
  const make = (file: string, stateFile: string) =>
    new UpdateAnnouncer({
      notesFile: t.notesFile,
      changelogFile: file,
      stateFile,
      chatIds: ["oc_a"],
      send: async (_to, input) => {
        sent.push(input);
        return { messageId: "om_1", chatId: "oc_a" } as never;
      },
      logger: quiet,
    });
  await make(changelogFile, t.stateFile).run();
  const json = JSON.stringify(sent[0]);
  assert.match(json, /本次更新了什么/);
  assert.match(json, /技术改动 X（#50）/);
  assert.ok(!json.includes("技术改动 Y"), "只放这次发的版本的技术说明");

  await make(path.join(path.dirname(t.notesFile), "nope.md"), path.join(path.dirname(t.stateFile), "other.json")).run();
  assert.equal(sent.length, 2);
  assert.ok(!JSON.stringify(sent[1]).includes("collapsible_panel"));
});

test("读不到产品更新说明或者里面没有版本时不发", async () => {
  const t = await setup();
  await writeFile(t.notesFile, "# 产品更新说明\n\n## 未发布\n\n- 还在做\n");
  await t.make().run();
  assert.equal(t.sent.length, 0);

  const missing = new UpdateAnnouncer({
    notesFile: path.join(path.dirname(t.notesFile), "nope.md"),
    stateFile: t.stateFile,
    chatIds: ["oc_a"],
    send: async () => {
      throw new Error("不该发");
    },
    logger: quiet,
  });
  await missing.run();
});

test("记录文件写坏了：当作没发过，每个群只发最新的一版", async () => {
  const t = await setup(["oc_a"]);
  await t.make().run();
  await writeFile(t.stateFile, "{坏了");
  await t.make().run();
  assert.equal(t.sent.length, 2);
  assert.ok(!JSON.stringify(t.sent[1]!.input).includes("0.9.1"));
});

test("停下以后不再重试", async () => {
  const t = await setup(["oc_a"]);
  t.setFail(() => true);
  const announcer = t.make();
  await announcer.run();
  await announcer.stop();
  t.setFail(() => false);
  t.scheduled.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(t.sent.length, 0);
});
