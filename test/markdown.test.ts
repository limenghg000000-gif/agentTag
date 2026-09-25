import assert from "node:assert/strict";
import { test } from "node:test";
import { splitMarkdown } from "../src/markdown.js";

test("短文本原样返回", () => {
  assert.deepEqual(splitMarkdown("你好", 100), ["你好"]);
});

test("长文本按行切分，每片不超过上限且不丢内容", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `第 ${i} 行内容`);
  const chunks = splitMarkdown(lines.join("\n"), 60);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 60, `片段过长：${chunk.length}`);
  }
  assert.equal(chunks.join("\n"), lines.join("\n"));
});

test("切点落在代码块里时补上结束标记并在下一片重新打开", () => {
  const code = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`);
  const text = ["开头说明", "```ts", ...code, "```", "结尾说明"].join("\n");
  const chunks = splitMarkdown(text, 120);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    const fences = chunk.split("\n").filter((line) => line.startsWith("```")).length;
    assert.equal(fences % 2, 0, `代码块没有闭合：\n${chunk}`);
  }
  assert.ok(chunks[1].startsWith("```ts"));
});

test("超长单行按字符硬切", () => {
  const chunks = splitMarkdown("字".repeat(250), 100);
  assert.deepEqual(chunks.map((c) => c.length), [100, 100, 50]);
});
