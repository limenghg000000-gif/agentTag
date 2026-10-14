import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SendInput } from "@larksuiteoapi/node-sdk";
import {
  compareVersions,
  MAX_ANNOUNCED_VERSIONS,
  parseChangelog,
  pendingVersions,
  renderAnnouncementCard,
  UpdateAnnouncer,
} from "../src/announce.js";

const quiet = { info() {}, warn() {}, error() {} };

const CHANGELOG = `# 更新日志

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

test("读 CHANGELOG：版本、日期、### 之前的说明，去掉 PR 号；没有版本号的段跳过", () => {
  const versions = parseChangelog(CHANGELOG);
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

test("版本号按数字比较，0.10.0 比 0.9.1 新", () => {
  assert.ok(compareVersions("0.10.0", "0.9.1") > 0);
  assert.ok(compareVersions("0.9.0", "0.9.1") < 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("要发哪几版：没发过只发最新的一版；发过就发比上次新的，新的在前；回退或已是最新时不发", () => {
  const versions = parseChangelog(CHANGELOG);
  assert.deepEqual(pendingVersions(versions, undefined).map((v) => v.version), ["0.10.0"]);
  assert.deepEqual(pendingVersions(versions, "0.9.0").map((v) => v.version), ["0.10.0", "0.9.1"]);
  assert.deepEqual(pendingVersions(versions, "0.10.0"), []);
  assert.deepEqual(pendingVersions(versions, "0.11.0"), []);
  assert.deepEqual(pendingVersions([], undefined), []);
});

test("通知卡片：标题带最新版本号，几个版本各列一段，转义尖括号，按钮打开配置的链接", () => {
  const versions = [
    { version: "0.10.0", date: "2026-10-16", notes: "**第十版**\n- 能 <at id=all></at> 了" },
    { version: "0.9.1", notes: "- 修好了" },
  ];
  const card = renderAnnouncementCard(versions, { botName: "飞书 CLI", link: "https://docs.example.com/agenttag", firstTime: true });
  const json = JSON.stringify(card);
  assert.match(json, /飞书 CLI 更新了 · 0\.10\.0/);
  assert.match(json, /\*\*0\.10\.0\*\*/);
  assert.match(json, /\*\*0\.9\.1\*\*/);
  assert.ok(!json.includes("<at"), "说明里的 <at> 不能真的 @ 人");
  assert.match(json, /&lt;at id=all&gt;/);
  assert.match(json, /我是飞书 CLI/);
  assert.match(json, /"default_url":"https:\/\/docs\.example\.com\/agenttag"/);

  // 只有一个版本时标题里有版本号，正文不再写；没配链接时没有按钮
  const single = JSON.stringify(renderAnnouncementCard([versions[1]!], { botName: "飞书 CLI" }));
  assert.ok(!single.includes("**0.9.1**"));
  assert.ok(!single.includes("button"));
  assert.ok(!single.includes("我是"));
});

test("通知卡片最多列几个版本，更早的只说还有几个", () => {
  const versions = Array.from({ length: MAX_ANNOUNCED_VERSIONS + 2 }, (_, i) => ({ version: `0.${20 - i}.0`, notes: `- 第 ${20 - i} 版` }));
  const json = JSON.stringify(renderAnnouncementCard(versions));
  assert.match(json, /还有 2 个更早的版本没列出来/);
  assert.ok(!json.includes(`第 ${20 - MAX_ANNOUNCED_VERSIONS} 版`));
});

async function setup(chatIds = ["oc_a", "oc_b"]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agenttag-announce-"));
  const changelogFile = path.join(dir, "CHANGELOG.md");
  const stateFile = path.join(dir, "announce", "state.json");
  await writeFile(changelogFile, CHANGELOG);
  const sent: { to: string; input: SendInput }[] = [];
  const scheduled: (() => void)[] = [];
  let fail: (to: string, input: SendInput) => boolean | string = () => false;
  const make = () =>
    new UpdateAnnouncer({
      changelogFile,
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
    changelogFile,
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

  await writeFile(t.changelogFile, CHANGELOG.replace("## 未发布", "## 0.11.0 — 2026-10-17\n\n- 新功能 E（#53）\n\n## 未发布"));
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
  assert.match(input.markdown, /飞书 CLI 更新了 · 0\.10\.0/);
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

test("读不到 CHANGELOG 或者里面没有版本时不发", async () => {
  const t = await setup();
  await writeFile(t.changelogFile, "# 更新日志\n\n## 未发布\n\n- 还在做\n");
  await t.make().run();
  assert.equal(t.sent.length, 0);

  const missing = new UpdateAnnouncer({
    changelogFile: path.join(path.dirname(t.changelogFile), "nope.md"),
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
