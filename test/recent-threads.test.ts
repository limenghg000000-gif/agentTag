import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { MAX_THREADS_PER_CHAT, RecentThreadStore } from "../src/recent-threads.js";
import { createRecentThreadsTool, RECENT_THREADS_TOOL } from "../src/tools/recent-threads.js";

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "recent-threads-"));
  dirs.push(dir);
  return dir;
}

function clock(start = Date.UTC(2026, 9, 12, 6, 0)) {
  let now = start;
  return { now: () => now, tick: (ms = 60_000) => (now += ms) };
}

const signal = new AbortController().signal;

test("同一个话题再问时挪到最前面：第一次问的留作话题，最近一次的问答和次数更新", async () => {
  const dir = await tempDir();
  const time = clock();
  const store = new RecentThreadStore(dir, MAX_THREADS_PER_CHAT, time.now);

  await store.record("oc_1", "om_a", { question: "礼金链接为什么转不了", answer: "因为 A", askerName: "ML" });
  time.tick();
  await store.record("oc_1", "om_b", { question: "code=8 是什么", answer: "网关超时" });
  time.tick();
  await store.record("oc_1", "om_a", { question: "能不能把这段逻辑去掉", answer: "可以，但要产品确认", askerName: "小王" });

  const threads = await store.list("oc_1");
  assert.deepEqual(
    threads.map((t) => [t.threadKey, t.topic, t.question, t.answer, t.askerName, t.turns]),
    [
      ["om_a", "礼金链接为什么转不了", "能不能把这段逻辑去掉", "可以，但要产品确认", "小王", 2],
      ["om_b", "code=8 是什么", "code=8 是什么", "网关超时", undefined, 1],
    ],
  );
  assert.equal(threads[0].at, time.now());
  // 当前话题不列
  assert.deepEqual(
    (await store.list("oc_1", "om_a")).map((t) => t.threadKey),
    ["om_b"],
  );
  // 别的群看不到
  assert.deepEqual(await store.list("oc_2"), []);
});

test("每个群只留最近的若干个话题；提问、回答太长时截短", async () => {
  const dir = await tempDir();
  const store = new RecentThreadStore(dir, 2);

  await store.record("oc_1", "om_1", { question: "一", answer: "答一" });
  await store.record("oc_1", "om_2", { question: "二", answer: "答二" });
  await store.record("oc_1", "om_3", { question: "问".repeat(600), answer: "答".repeat(5000) });

  const threads = await store.list("oc_1");
  assert.deepEqual(
    threads.map((t) => t.threadKey),
    ["om_3", "om_2"],
  );
  assert.equal(threads[0].question, `${"问".repeat(500)}…（后面省略）`);
  assert.equal(threads[0].answer, `${"答".repeat(4000)}…（后面省略）`);
});

test("同时记同一个群的几个话题不会互相覆盖", async () => {
  const dir = await tempDir();
  const store = new RecentThreadStore(dir);

  await Promise.all(Array.from({ length: 8 }, (_, i) => store.record("oc_1", `om_${i}`, { question: `问${i}`, answer: `答${i}` })));

  assert.equal((await store.list("oc_1")).length, 8);
});

test("文件坏了就挪到一边、从空的重新记；chat_id 不对时报错", async () => {
  const dir = await tempDir();
  const store = new RecentThreadStore(dir);
  await writeFile(path.join(dir, "oc_1.json"), "{坏了", "utf8");

  assert.deepEqual(await store.list("oc_1"), []);
  await store.record("oc_1", "om_1", { question: "问", answer: "答" });

  const names = await readdir(dir);
  assert.ok(names.some((name) => /^oc_1\.json\.\d+\.bad$/.test(name)));
  assert.equal(JSON.parse(await readFile(path.join(dir, "oc_1.json"), "utf8")).length, 1);
  await assert.rejects(store.record("../oc_1", "om_1", { question: "问", answer: "答" }), /chat_id 格式不对/);
});

test("工具只列本群、不含当前话题，从新到旧，带上时间、提问人和回答；之前的回答不算这次的证据", async () => {
  const dir = await tempDir();
  const time = clock();
  const store = new RecentThreadStore(dir, MAX_THREADS_PER_CHAT, time.now);
  await store.record("oc_1", "om_a", { question: "礼金链接为什么转不了", answer: "第一行\n第二行", askerName: "ML" });
  time.tick();
  await store.record("oc_1", "om_b", { question: "code=8 是什么", answer: "网关超时" });
  time.tick();
  await store.record("oc_1", "om_b", { question: "那怎么修", answer: "改成 k8s 服务发现" });
  await store.record("oc_1", "om_now", { question: "给产品解释一下上面那个", answer: "…" });
  await store.record("oc_2", "om_x", { question: "别的群的事", answer: "别的群的回答" });
  const tool = createRecentThreadsTool({ store, chatId: "oc_1", threadKey: "om_now" });

  assert.equal(tool.spec.name, RECENT_THREADS_TOOL);
  assert.equal(tool.instructionsOnly, true);
  assert.equal(tool.describe({}), "看本群最近的话题");
  const output = await tool.run({}, { signal });

  assert.match(output, /^本群最近 2 个话题（不含当前话题，从新到旧）。这些是你之前的回答，不一定对/);
  assert.ok(output.indexOf("code=8") < output.indexOf("礼金"));
  assert.match(output, /1\. 10\/12 14:02，问（这个话题里问了 2 次）\n {3}第一次问：code=8 是什么\n {3}最近一次问：那怎么修\n {3}你的回答：改成 k8s 服务发现/);
  assert.match(output, /2\. 10\/12 14:00，ML 问（这个话题里问了 1 次）\n {3}问：礼金链接为什么转不了\n {3}你的回答：第一行\n {3}第二行/);
  assert.doesNotMatch(output, /上面那个|别的群/);
});

test("工具按关键词筛、按 limit 限条数，回答太长只列开头；没有时说明", async () => {
  const dir = await tempDir();
  const store = new RecentThreadStore(dir);
  for (let i = 0; i < 12; i++) {
    await store.record("oc_1", `om_${i}`, { question: `问题 ${i}`, answer: i === 11 ? "长".repeat(2000) : `回答 ${i}` });
  }
  await store.record("oc_1", "om_coupon", { question: "优惠券为什么没了", answer: "礼金链接不走取券逻辑" });
  const tool = createRecentThreadsTool({ store, chatId: "oc_1", threadKey: "om_now" });

  const found = await tool.run({ keyword: " 礼金 " }, { signal });
  assert.match(found, /^本群最近 1 个话题/);
  assert.match(found, /优惠券为什么没了/);
  assert.equal(tool.describe({ keyword: "礼金" }), "查本群之前的话题：礼金");

  assert.match(await tool.run({ limit: 2 }, { signal }), /^本群最近 2 个话题/);
  assert.match(await tool.run({ limit: 50 }, { signal }), /^本群最近 10 个话题/);
  assert.match(await tool.run({ limit: "很多" }, { signal }), /^本群最近 5 个话题/);
  assert.match(await tool.run({ keyword: "问题 11" }, { signal }), new RegExp(`你的回答：${"长".repeat(1500)}…（后面省略）`));

  assert.equal(
    await tool.run({ keyword: "没有的词" }, { signal }),
    `本群最近的话题里没有提到「没有的词」的（只记了最近 ${MAX_THREADS_PER_CHAT} 个你答过的话题）。`,
  );
  const empty = createRecentThreadsTool({ store, chatId: "oc_9", threadKey: "om_now" });
  assert.equal(await empty.run({}, { signal }), "本群还没有别的话题的记录（只记你答过的话题）。");
});
