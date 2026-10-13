import assert from "node:assert/strict";
import { test } from "node:test";
import { cellTag, richCardCell, richCardLine, splitMarkdown, splitTables, stripRichTags, toPostMarkdown } from "../src/markdown.js";

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
  assert.equal(stripRichTags("<FONT color=Gray>x</FONT> <text_tag color='grey'>已下线</text_tag>"), "x 已下线");
  // 卡片照原文显示的写歪的标签也照原文留着，里面夹的路径要让检查看得到
  for (const kept of [
    "<font data-x='src/user.go:99'>x</font>",
    "<font color='pink'>src/user.go:99</font>",
    "<font color='red' data-x='src/user.go:99'>x</font>",
    "<font color='red'><at id=all></at></font>",
    "<text_tag color='red'>a</font>",
    "<font color='red'>写到一半",
    "</font>src/user.go:99",
  ]) {
    assert.equal(stripRichTags(kept), kept);
  }
});

test("灰色的 text_tag 写成 neutral；写 grey、gray 的也认", () => {
  assert.equal(richCardLine("<text_tag color='grey'>已下线</text_tag>"), "<text_tag color='neutral'>已下线</text_tag>");
  assert.equal(richCardLine("<text_tag color=gray>已下线</text_tag>"), "<text_tag color='neutral'>已下线</text_tag>");
  assert.equal(richCardLine("<font color='neutral'>x</font>"), "&lt;font color='neutral'>x&lt;/font>");
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

test("改成普通消息：两边不写 | 的表格也变列表，表格到空行、没有 | 的行、代码块为止", () => {
  assert.equal(
    toPostMarkdown(["Pod | CPU", "--- | ---", "api-1 | <font color='red'>92%</font>", "api-2 | 40%", "", "后面一段"].join("\n")),
    ["- **api-1**：CPU 92%", "- **api-2**：CPU 40%", "", "后面一段"].join("\n"),
  );
  assert.equal(toPostMarkdown("| Pod | CPU\n|---|---\napi-1 | 92%\n说明一下"), "- **api-1**：CPU 92%\n说明一下");
  assert.equal(toPostMarkdown("Pod | CPU\n--- | ---\napi-1 | 92%\n```a|b\n| x | y |\n```"), "- **api-1**：CPU 92%\n```a|b\n| x | y |\n```");
  // 格数对不上、第二行不是 ---、没有 | 的 ---（那是分隔线）：都不是表格
  for (const text of ["a | b | c\n--- | ---\nx | y | z", "a | b\nx | y", "标题\n---", "a | b\n- | x"]) {
    assert.equal(toPostMarkdown(text), text);
  }
});

test("改成普通消息：行内代码里讲标签写法的例子原样留着，代码外的标签照样去掉", () => {
  assert.equal(
    toPostMarkdown("用 `<text_tag color='red'>高风险</text_tag>` 标风险，比如 <text_tag color='red'>高风险</text_tag>"),
    "用 `<text_tag color='red'>高风险</text_tag>` 标风险，比如 高风险",
  );
  assert.equal(toPostMarkdown("看 <font color='red'>`src/a.ts`</font>:12"), "看 `src/a.ts`:12");
  assert.equal(toPostMarkdown("``a `<font color='red'>x</font>` b``"), "``a `<font color='red'>x</font>` b``");
  // 没有收尾的反引号不算代码
  assert.equal(toPostMarkdown("``a <font color='red'>x</font>`"), "``a x`");
  assert.equal(toPostMarkdown("| 写法 | 效果 |\n|---|---|\n| `<font color='red'>x</font>` | <font color='red'>x</font> |"), "- **`<font color='red'>x</font>`**：效果 x");
});

test("拆出表格：代码块外的表格单独拿出来，前后的文字去掉空行；对齐按 |:---:| 认，格数按表头补齐、多的不要", () => {
  const text = ["结论", "", "| Pod | CPU | 内存 |", "|:---|:---:|---:|", "| api-1 | 92% |", "| api-2 \\| x | 40% | 1 | 多的 |", "", "下一步"].join("\n");
  assert.deepEqual(splitTables(text, 5), [
    { kind: "text", text: "结论" },
    {
      kind: "table",
      table: {
        header: ["Pod", "CPU", "内存"],
        align: ["left", "center", "right"],
        rows: [
          ["api-1", "92%", ""],
          ["api-2 | x", "40%", "1"],
        ],
      },
    },
    { kind: "text", text: "下一步" },
  ]);
  // 没写冒号的列不定对齐；两边不写 | 的也算
  assert.deepEqual(splitTables("a | b\n--- | ---\nx | y", 5), [{ kind: "table", table: { header: ["a", "b"], align: [undefined, undefined], rows: [["x", "y"]] } }]);
});

test("拆出表格：代码块里的、只有表头的不拆；最多拆 max 张，后面的留在文字里", () => {
  const fenced = "```\n| a | b |\n|---|---|\n| x | y |\n```";
  assert.deepEqual(splitTables(fenced, 5), [{ kind: "text", text: fenced }]);
  assert.deepEqual(splitTables("| a | b |\n|---|---|\n\n说明", 5), [{ kind: "text", text: "| a | b |\n|---|---|\n\n说明" }]);
  const two = "| a |\n|---|\n| 1 |\n\n| b |\n|---|\n| 2 |";
  const parts = splitTables(two, 1);
  assert.deepEqual(parts.map((part) => part.kind), ["table", "text"]);
  assert.deepEqual(parts[1], { kind: "text", text: "| b |\n|---|\n| 2 |" });
  assert.deepEqual(splitTables(two, 0), [{ kind: "text", text: two }]);
  assert.deepEqual(splitTables("", 5), []);
});

test("表格的格子：尖括号转义，名单里的 <font> 放过，<text_tag> 换成同色的字（灰色标签换成 grey）", () => {
  assert.equal(richCardCell("<font color='red'>92%</font> <at id=all></at>"), "<font color='red'>92%</font> &lt;at id=all>&lt;/at>");
  assert.equal(richCardCell("<text_tag color='red'>高风险</text_tag> 内存"), "<font color='red'>高风险</font> 内存");
  assert.equal(richCardCell('<text_tag color="neutral">未知</text_tag>'), "<font color='grey'>未知</font>");
  assert.equal(richCardCell("<font color='pink'>x</font>"), "&lt;font color='pink'>x&lt;/font>");
  assert.equal(richCardCell("**api-1** `a<b`"), "**api-1** `a&lt;b`");
});

test("表格的格子：只有一个 <text_tag> 时取出字和颜色", () => {
  assert.deepEqual(cellTag(" <text_tag color='green'>正常</text_tag> "), { text: "正常", color: "green" });
  assert.deepEqual(cellTag("<text_tag color='grey'>未知</text_tag>"), { text: "未知", color: "neutral" });
  for (const cell of ["<text_tag color='red'>高</text_tag> 92%", "<text_tag color='pink'>x</text_tag>", "<text_tag color='red'> </text_tag>", "<font color='red'>高</font>", "正常", ""]) {
    assert.equal(cellTag(cell), undefined, cell);
  }
});
