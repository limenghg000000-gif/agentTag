import assert from "node:assert/strict";
import { test } from "node:test";
import { richCardLine, splitMarkdown, stripRichTags, toPostMarkdown } from "../src/markdown.js";

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

test("卡片回答的一行：放过名单里的 <font>、<text_tag>，别的尖括号转义；# ～ ### 标题降成 ####", () => {
  assert.equal(richCardLine("CPU <font color='red'>92%</font> <text_tag color=\"red\">高风险</text_tag>"), "CPU <font color='red'>92%</font> <text_tag color='red'>高风险</text_tag>");
  // 不加引号、大写、gray 都认，统一写成小写单引号
  assert.equal(richCardLine("<FONT color=Gray>x</FONT>"), "<font color='grey'>x</font>");
  // 颜色不在名单里、标签不认识、没有结尾、里面夹着别的标签：照样转义
  assert.equal(richCardLine("<font color='pink'>x</font>"), "&lt;font color='pink'>x&lt;/font>");
  assert.equal(richCardLine("<at id=all></at> <b>x</b>"), "&lt;at id=all>&lt;/at> &lt;b>x&lt;/b>");
  assert.equal(richCardLine("<font color='red'>写到一半"), "&lt;font color='red'>写到一半");
  assert.equal(
    richCardLine("<font color='red'><at id=all></at></font>"),
    "&lt;font color='red'>&lt;at id=all>&lt;/at>&lt;/font>",
  );
  assert.equal(richCardLine("<text_tag color='red'>a</font>"), "&lt;text_tag color='red'>a&lt;/font>");
  // 标题
  assert.equal(richCardLine("# 大促巡检"), "#### 大促巡检");
  assert.equal(richCardLine("### 风险"), "#### 风险");
  assert.equal(richCardLine("#### 风险"), "#### 风险");
  assert.equal(richCardLine("#3 是群记忆"), "#3 是群记忆");
});

test("去掉 <font>、<text_tag> 标签只留文字", () => {
  assert.equal(stripRichTags("看 <font color='red'>`src/a.ts`</font>:12 和 <text_tag color='red'>高风险</text_tag>"), "看 `src/a.ts`:12 和 高风险");
  assert.equal(stripRichTags("<at id=all></at>"), "<at id=all></at>");
});

test("改成普通消息：表格变列表，标签去掉，代码块里不动", () => {
  const answer = [
    "结论：<text_tag color='red'>高风险</text_tag>",
    "",
    "| 服务 | 副本 | 内存 |",
    "| --- | :-: | ---: |",
    "| union | 3 | <font color='red'>70%</font> |",
    "| pc-goods-site | 10 | |",
    "",
    "```",
    "| a | b |",
    "|---|---|",
    "<font color='red'>x</font>",
    "```",
    "| 不是表格 |",
  ].join("\n");
  assert.equal(
    toPostMarkdown(answer),
    [
      "结论：高风险",
      "",
      "- **union**：副本 3；内存 70%",
      "- **pc-goods-site**：副本 10",
      "",
      "```",
      "| a | b |",
      "|---|---|",
      "<font color='red'>x</font>",
      "```",
      "| 不是表格 |",
    ].join("\n"),
  );
  assert.equal(toPostMarkdown("| a \\| b | c |\n|-|-|\n| x \\| y | z |"), "- **x | y**：c z");
});
