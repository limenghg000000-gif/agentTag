import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  MAX_CONTENT_CHARS,
  MAX_ENTRIES,
  type MemoryEntry,
  MemoryError,
  MemoryStore,
  renderMemoryForPrompt,
  searchMemory,
} from "../src/memory.js";
import { createMemoryTools } from "../src/tools/memory.js";
import type { Tool } from "../src/tools/tool.js";

const quiet = { info() {}, warn() {}, error() {} };
const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agenttag-memory-"));
  dirs.push(dir);
  return path.join(dir, "memory");
}

function fixedClock(iso = "2026-09-26T08:00:00Z") {
  return () => new Date(iso);
}

function entry(id: number, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id, kind: "background", content, createdAt: "2026-09-01T00:00:00Z", ...extra };
}

test("记下的内容写到群自己的文件里，重启后还在，编号接着往下排", async () => {
  const dir = await tempDir();
  const store = new MemoryStore(dir, quiet, fixedClock());
  await store.add("oc_a", "decision", "  发版固定在每周三\n下午 ", { name: "张三", openId: "ou_zhang", messageId: "om_1" });
  await store.add("oc_a", "convention", "周报用飞书文档写");

  const reopened = new MemoryStore(dir, quiet);
  const entries = await reopened.list("oc_a");
  assert.deepEqual(entries[0], {
    id: 1,
    kind: "decision",
    content: "发版固定在每周三 下午",
    author: "张三",
    authorId: "ou_zhang",
    sourceMessageId: "om_1",
    createdAt: "2026-09-26T08:00:00.000Z",
  });
  assert.equal(entries.length, 2);
  const { entry: third } = await reopened.add("oc_a", "background", "仓库是 agentTag");
  assert.equal(third.id, 3);
  assert.deepEqual(await readdir(dir), ["oc_a.json"]);
});

test("不同群的记忆互相看不到", async () => {
  const store = new MemoryStore(await tempDir(), quiet);
  await store.add("oc_a", "background", "A 群的事");
  await store.add("oc_b", "background", "B 群的事");

  assert.deepEqual((await store.list("oc_a")).map((e) => e.content), ["A 群的事"]);
  assert.deepEqual((await store.list("oc_b")).map((e) => e.content), ["B 群的事"]);
});

test("同一个群并发写入不会互相覆盖", async () => {
  const dir = await tempDir();
  const store = new MemoryStore(dir, quiet);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.add("oc_a", "background", `第 ${i} 条`)));

  const entries = await new MemoryStore(dir, quiet).list("oc_a");
  assert.equal(entries.length, 20);
  assert.deepEqual(new Set(entries.map((e) => e.id)).size, 20);
});

test("重复的内容不再记一遍", async () => {
  const store = new MemoryStore(await tempDir(), quiet);
  const first = await store.add("oc_a", "decision", "发版固定在每周三");
  const again = await store.add("oc_a", "decision", "发版固定在每周三 ");

  assert.equal(again.duplicate, true);
  assert.equal(again.entry.id, first.entry.id);
  assert.equal((await store.list("oc_a")).length, 1);
});

test("修改和删除按编号来，删掉的编号不再复用", async () => {
  const dir = await tempDir();
  const store = new MemoryStore(dir, quiet, fixedClock("2026-09-27T08:00:00Z"));
  await store.add("oc_a", "decision", "发版固定在每周三");
  await store.add("oc_a", "background", "测试环境在 test.example.com");

  const updated = await store.update("oc_a", 1, { content: "发版改到每周四" }, { name: "李四" });
  assert.equal(updated.content, "发版改到每周四");
  assert.equal(updated.author, "李四");
  assert.equal(updated.updatedAt, "2026-09-27T08:00:00.000Z");

  const { removed, missing } = await store.remove("oc_a", [2, 9]);
  assert.deepEqual(removed.map((e) => e.id), [2]);
  assert.deepEqual(missing, [9]);
  const { entry } = await store.add("oc_a", "background", "新的一条");
  assert.equal(entry.id, 3);
  assert.deepEqual((await new MemoryStore(dir, quiet).list("oc_a")).map((e) => e.id), [1, 3]);
  await assert.rejects(store.update("oc_a", 2, { content: "x" }), MemoryError);
});

test("内容为空、太长或记满了时拒绝，并说明原因", async () => {
  const store = new MemoryStore(await tempDir(), quiet);
  await assert.rejects(store.add("oc_a", "background", "  "), /不能为空/);
  await assert.rejects(store.add("oc_a", "background", "字".repeat(MAX_CONTENT_CHARS + 1)), /最多 500 字/);

  await Promise.all(Array.from({ length: MAX_ENTRIES }, (_, i) => store.add("oc_a", "background", `第 ${i} 条`)));
  await assert.rejects(store.add("oc_a", "background", "再来一条"), /到上限了/);
});

test("群 id 里有路径字符时拒绝，不会写到目录外", async () => {
  const store = new MemoryStore(await tempDir(), quiet);
  await assert.rejects(store.add("../oc_a", "background", "x"), /不合法的群 id/);
});

test("文件损坏时挪到一边留着，这个群从空记忆重新开始", async () => {
  const dir = await tempDir();
  const errors: string[] = [];
  const store = new MemoryStore(dir, { ...quiet, error: (line: string) => errors.push(line) });
  await store.init();
  await writeFile(path.join(dir, "oc_a.json"), "{ 写坏了");

  assert.deepEqual(await store.list("oc_a"), []);
  await store.add("oc_a", "background", "新的一条");
  const files = (await readdir(dir)).sort();
  assert.equal(files.length, 2);
  assert.match(files[1], /^oc_a\.json\.corrupt-\d+$/);
  assert.equal(await readFile(path.join(dir, files[1]), "utf8"), "{ 写坏了");
  assert.match(errors[0], /损坏/);
});

test("记忆文件只有程序自己能读写", async () => {
  const dir = await tempDir();
  const store = new MemoryStore(dir, quiet);
  await store.add("oc_a", "background", "内部信息");
  assert.equal((await stat(path.join(dir, "oc_a.json"))).mode & 0o777, 0o600);
});

test("日志里只记编号和操作人，不记内容", async () => {
  const logs: string[] = [];
  const store = new MemoryStore(await tempDir(), { ...quiet, info: (line: string) => logs.push(line) });
  await store.add("oc_a", "background", "机密内容", { openId: "ou_zhang", messageId: "om_1" });
  await store.remove("oc_a", [1], { openId: "ou_li", messageId: "om_2" });

  assert.deepEqual(logs, [
    "群记忆 chat=oc_a 新增 #1 操作人=ou_zhang message=om_1",
    "群记忆 chat=oc_a 删除 #1 操作人=ou_li message=om_2",
  ]);
});

test("写进提示词时按类别分组，带编号、记录人和日期", () => {
  const { text, omitted } = renderMemoryForPrompt([
    entry(1, "仓库是 agentTag"),
    entry(2, "发版固定在每周三", { kind: "decision", author: "张三", createdAt: "2026-09-26T08:00:00Z" }),
    entry(3, "张三负责后端", { kind: "person" }),
  ]);

  assert.equal(omitted, 0);
  assert.equal(
    text,
    [
      "【背景】",
      "- #1 仓库是 agentTag（2026/9/1）",
      "【决定】",
      "- #2 发版固定在每周三（张三，2026/9/26）",
      "【成员】",
      "- #3 张三负责后端（2026/9/1）",
    ].join("\n"),
  );
});

test("记忆太多时只列最近更新的，并告诉模型还有几条没列", () => {
  const entries = Array.from({ length: 50 }, (_, i) =>
    entry(i + 1, `第 ${i + 1} 条 ${"字".repeat(80)}`, { createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }),
  );
  entries[0].updatedAt = "2026-12-31T00:00:00Z";

  const { text, omitted } = renderMemoryForPrompt(entries, 1000);

  assert.ok(omitted > 0);
  assert.ok(text.length <= 1100);
  assert.match(text, /#1 第 1 条/);
  assert.match(text, /#50 第 50 条/);
  assert.doesNotMatch(text, /#2 第 2 条/);
});

test("按关键词查记忆：整词命中排前面，中文不分词也能找到", () => {
  const entries = [
    entry(1, "测试环境在 test.example.com"),
    entry(2, "每周三下午发版", { kind: "decision" }),
    entry(3, "发版前要跑完回归测试", { kind: "convention" }),
    entry(4, "张三负责后端", { kind: "person" }),
  ];

  assert.deepEqual(searchMemory(entries, "发版").map((e) => e.id), [3, 2]);
  assert.deepEqual(searchMemory(entries, "什么时候发版").map((e) => e.id), [3, 2]);
  assert.deepEqual(searchMemory(entries, "回归测试 发版").map((e) => e.id), [3, 2, 1]);
  assert.deepEqual(searchMemory(entries, "报销流程"), []);
  assert.deepEqual(searchMemory(entries, "后端 负责人").map((e) => e.id), [4]);
  assert.deepEqual(searchMemory(entries, "TEST.example"), [entries[0]]);
  assert.deepEqual(searchMemory(entries, "  "), []);
});

function toolsFor(store: MemoryStore, chatId = "oc_a", includeSearch = true) {
  const tools = createMemoryTools({ store, chatId, author: { name: "张三", openId: "ou_zhang", messageId: "om_1" }, includeSearch });
  const byName = new Map(tools.map((tool) => [tool.spec.name, tool]));
  const signal = new AbortController().signal;
  return {
    names: tools.map((tool) => tool.spec.name),
    tool: (name: string) => byName.get(name) as Tool,
    run: (name: string, args: Record<string, unknown>) => (byName.get(name) as Tool).run(args, { signal }),
  };
}

test("记忆工具：记下、修改、删除，写明来源；只作用于当前群", async () => {
  const store = new MemoryStore(await tempDir(), quiet, fixedClock());
  const tools = toolsFor(store);

  assert.match(await tools.run("memory_save", { content: "发版固定在每周三", kind: "decision" }), /^已记住：#1 决定：发版固定在每周三（张三，2026\/9\/26）$/);
  assert.match(await tools.run("memory_save", { content: "发版固定在每周三", kind: "decision" }), /^已经记过了/);
  assert.match(await tools.run("memory_update", { id: "#1", content: "发版改到每周四" }), /已修改：#1 决定：发版改到每周四/);
  await tools.run("memory_save", { content: "张三负责后端", kind: "person" });
  assert.equal(await tools.run("memory_delete", { ids: [2, 7] }), "已删除：\n#2 成员：张三负责后端（张三，2026/9/26）\n没有这些编号的记忆：#7");

  assert.deepEqual(await store.list("oc_b"), []);
  const [only] = await store.list("oc_a");
  assert.equal(only.authorId, "ou_zhang");
  assert.equal(only.sourceMessageId, "om_1");
});

test("记忆工具：参数不对时报错，交给模型重试", async () => {
  const tools = toolsFor(new MemoryStore(await tempDir(), quiet));

  await assert.rejects(tools.run("memory_save", { content: "x", kind: "secret" }), /kind 只能是/);
  await assert.rejects(tools.run("memory_save", { kind: "decision" }), /缺少 content/);
  await assert.rejects(tools.run("memory_update", { id: 0, content: "x" }), /不是合法的记忆编号/);
  await assert.rejects(tools.run("memory_update", { id: 5, content: "x" }), /没有编号为 #5 的记忆/);
  await assert.rejects(tools.run("memory_delete", { ids: [] }), /非空/);
});

test("查记忆工具：有关键词时检索，没有时从新到旧分页列出", async () => {
  const store = new MemoryStore(await tempDir(), quiet, fixedClock());
  const tools = toolsFor(store);
  assert.equal(await tools.run("memory_search", {}), "这个群还没有记忆。");

  for (let i = 1; i <= 35; i++) {
    await store.add("oc_a", "background", `第 ${i} 条`);
  }
  await store.add("oc_a", "decision", "每周三下午发版");

  assert.match(await tools.run("memory_search", { query: "发版" }), /^#36 决定：每周三下午发版/);
  assert.match(await tools.run("memory_search", { query: "报销" }), /没有找到/);
  const firstPage = await tools.run("memory_search", {});
  assert.match(firstPage, /^共 36 条记忆，下面是第 1 到 30 条/);
  assert.match(firstPage, /还有 6 条，用 offset=30 继续列。$/);
  const secondPage = await tools.run("memory_search", { offset: 30 });
  assert.match(secondPage, /第 31 到 36 条/);
  assert.match(secondPage, /#1 背景：第 1 条/);
});

test("提示词里列全了记忆时不提供查记忆的工具；卡片上的步骤说明写清楚做了什么", async () => {
  const store = new MemoryStore(await tempDir(), quiet);
  assert.deepEqual(toolsFor(store, "oc_a", false).names, ["memory_save", "memory_update", "memory_delete"]);

  const tools = toolsFor(store);
  assert.equal(tools.tool("memory_save").describe({ content: "发版固定在每周三" }), "记住：发版固定在每周三");
  assert.equal(tools.tool("memory_update").describe({ id: 3 }), "修改记忆 #3");
  assert.equal(tools.tool("memory_delete").describe({ ids: [1, 2] }), "删除记忆 #1 #2");
  assert.equal(tools.tool("memory_search").describe({ query: "发版" }), "查记忆：发版");
  assert.equal(tools.tool("memory_search").describe({}), "列出群记忆");
});
