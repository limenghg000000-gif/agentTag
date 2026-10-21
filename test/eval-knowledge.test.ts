import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { evaluate, parseAsks, recentAsks } from "../src/eval-knowledge.js";
import { type Embedder, type KnowledgeBackend, KnowledgeBase, type KnowledgeEntry, normalizeDraft } from "../src/knowledge.js";

const quiet = { info() {}, warn() {}, error() {} };

function memoryBackend(): KnowledgeBackend & { entries: KnowledgeEntry[] } {
  const backend = {
    entries: [] as KnowledgeEntry[],
    location: async () => undefined,
    list: async () => structuredClone(backend.entries),
    add: async (entry: KnowledgeEntry) => {
      backend.entries.push(structuredClone(entry));
    },
    update: async () => {},
  };
  return backend;
}

/** 提问和经验里出现同一个话题词时向量重合；都没有时只剩一个很小的公共分量 */
const embedder: Embedder = {
  model: "fake-embedding",
  async embed(texts) {
    return texts.map((text) => [text.includes("降载") ? 1 : 0, text.includes("日活") ? 1 : 0, 0.05]);
  },
};

test("提问文件：一行一个，「=>」后面标应该查到的编号或「无」；重复的、像有密钥的去掉，手机号打码", () => {
  const asks = parseAsks(
    ["user-rpc 降载了吗 => K1", "日活怎么算 => k2，#K1", "今天几号 => 无", "随便问问", "随便问问", "", "MCP_AIOPS_TOKEN=correcthorsebatterystaple", "13812345678 收不到短信"].join("\n"),
    () => {},
  );
  assert.deepEqual(
    asks.map((ask) => [ask.text, ask.expected]),
    [
      ["user-rpc 降载了吗", ["K1"]],
      ["日活怎么算", ["K2", "K1"]],
      ["今天几号", []],
      ["随便问问", undefined],
      ["*** 收不到短信", undefined],
    ],
  );
});

test("最近话题里的提问：读各群的文件，话题的第一个问题和最近一次问的都算，新的在前；坏了的文件跳过、不动它", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-knowledge-"));
  await writeFile(
    path.join(dir, "oc_1.json"),
    JSON.stringify([
      { threadKey: "a", topic: "老问题", question: "老问题", answer: "x", at: 1 },
      { threadKey: "b", topic: "新话题", question: "接着问的", answer: "y", at: 2 },
    ]),
  );
  await writeFile(path.join(dir, "oc_2.json"), "{坏了");
  const warned: string[] = [];
  const asks = await recentAsks(dir, (text) => warned.push(text));
  assert.deepEqual(
    asks.map((ask) => ask.text),
    ["新话题", "接着问的", "老问题"],
  );
  assert.deepEqual(warned, ["跳过读不了的 oc_2.json"]);
  assert.deepEqual(await recentAsks(path.join(dir, "没有这个目录")), []);
});

test("检索测试的输出：几档门槛的统计、标注的查对了几条、每个提问的前 3 名和是否会写进提示词", async () => {
  const backend = memoryBackend();
  const base = new KnowledgeBase(backend, { embedder, logger: quiet });
  await base.save(normalizeDraft({ category: "incident", title: "user-rpc 降载", question: "降载了怎么办", conclusion: "扩容", keywords: "降载" }));
  await base.save(normalizeDraft({ category: "metric", title: "日活的口径", question: "日活怎么统计", conclusion: "去重用户数", keywords: "日活,DAU" }));
  const lines = await evaluate(base, parseAsks("user-rpc 降载了吗 => K1\n今天中午吃什么 => 无"), "来自提问文件", "fake-embedding");
  assert.deepEqual(lines.slice(0, 3), ["经验库有效的 2 条：", "  K1 user-rpc 降载", "  K2 日活的口径"]);
  assert.ok(lines.includes("提问 2 个（来自提问文件）。按意思检索用 fake-embedding。"));
  // 0.6 这档（现在的门槛）：降载那句查到 K1（对），吃饭那句什么都没查到
  assert.ok(lines.includes("门槛    有查到的提问   平均每问查到   查到的里对的   该查到的查到了"));
  assert.ok(lines.includes("0.50    1/2          0.5            1/1            1/1"));
  assert.ok(lines.includes("0.60    1/2          0.5            1/1            1/1  ←现在"));
  assert.ok(lines.includes("1.  ✓K1 1.00+1   K2 0.00  ｜ user-rpc 降载了吗  应查到：K1"));
  assert.ok(lines.includes("2.   K1 0.05   K2 0.05  ｜ 今天中午吃什么  应查到：无"));
});
