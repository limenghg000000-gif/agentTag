import assert from "node:assert/strict";
import { test } from "node:test";
import { type DocBlock, renderDocument } from "../src/doc-render.js";

const run = (content: string, style?: object) => ({ text_run: { content, ...(style ? { text_element_style: style } : {}) } });
const text = (id: string, parent: string, content: string): DocBlock => ({
  block_id: id,
  parent_id: parent,
  block_type: 2,
  text: { elements: [run(content)] },
});

const blocks: DocBlock[] = [
  {
    block_id: "doc1",
    block_type: 1,
    page: { elements: [run("周报")] },
    children: ["h1", "p1", "b1", "b2", "o1", "o2", "t1", "c1", "q1", "d1", "tbl", "img", "x1"],
  },
  { block_id: "h1", parent_id: "doc1", block_type: 4, heading2: { elements: [run("本周进展")] } },
  {
    block_id: "p1",
    parent_id: "doc1",
    block_type: 2,
    text: {
      elements: [
        run("完成了 "),
        run("登录页 ", { bold: true }),
        run("详见"),
        run("设计稿", { link: { url: "https%3A%2F%2Fexample.com%2Fa%3Fb%3D1" } }),
        { mention_user: { user_id: "ou_x" } },
        { mention_doc: { title: "需求", url: "https%3A%2F%2Fx.feishu.cn%2Fdocx%2Fabc" } },
      ],
    },
  },
  { block_id: "b1", parent_id: "doc1", block_type: 12, bullet: { elements: [run("甲")] }, children: ["b1a"] },
  { block_id: "b1a", parent_id: "b1", block_type: 12, bullet: { elements: [run("甲的子项")] } },
  { block_id: "b2", parent_id: "doc1", block_type: 12, bullet: { elements: [run("乙")] } },
  { block_id: "o1", parent_id: "doc1", block_type: 13, ordered: { style: { sequence: "3" }, elements: [run("第三步")] } },
  { block_id: "o2", parent_id: "doc1", block_type: 13, ordered: { style: { sequence: "auto" }, elements: [run("第四步")] } },
  { block_id: "t1", parent_id: "doc1", block_type: 17, todo: { style: { done: true }, elements: [run("发版")] } },
  { block_id: "c1", parent_id: "doc1", block_type: 14, code: { elements: [run("npm test\nnpm run build\n")] } },
  { block_id: "q1", parent_id: "doc1", block_type: 15, quote: { elements: [run("引用", { italic: true })] } },
  { block_id: "d1", parent_id: "doc1", block_type: 22, divider: {} },
  {
    block_id: "tbl",
    parent_id: "doc1",
    block_type: 31,
    table: { cells: ["c11", "c12", "c21", "c22"], property: { row_size: 2, column_size: 2 } },
    children: ["c11", "c12", "c21", "c22"],
  },
  { block_id: "c11", parent_id: "tbl", block_type: 32, table_cell: {}, children: ["c11t"] },
  { block_id: "c12", parent_id: "tbl", block_type: 32, table_cell: {}, children: ["c12t"] },
  { block_id: "c21", parent_id: "tbl", block_type: 32, table_cell: {}, children: ["c21t", "c21u"] },
  { block_id: "c22", parent_id: "tbl", block_type: 32, table_cell: {}, children: [] },
  text("c11t", "c11", "名称"),
  text("c12t", "c12", "数量"),
  text("c21t", "c21", "a|b"),
  text("c21u", "c21", "第二段"),
  { block_id: "img", parent_id: "doc1", block_type: 27, image: { token: "img_token" } },
  { block_id: "x1", parent_id: "doc1", block_type: 999, sheet: { token: "s" } },
];

test("文档块转成 Markdown：标题、行内样式、链接解码、嵌套列表、有序编号、待办、代码、引用、表格", () => {
  const { title, markdown } = renderDocument(blocks);
  assert.equal(title, "周报");
  assert.equal(
    markdown,
    [
      "## 本周进展",
      "",
      "完成了 **登录页** 详见[设计稿](https://example.com/a?b=1)@某人[需求](https://x.feishu.cn/docx/abc)",
      "",
      "- 甲",
      "  - 甲的子项",
      "- 乙",
      "3. 第三步",
      "4. 第四步",
      "- [x] 发版",
      "",
      "```",
      "npm test",
      "npm run build",
      "```",
      "",
      "> *引用*",
      "",
      "---",
      "",
      "| 名称 | 数量 |",
      "| --- | --- |",
      "| a\\|b<br>第二段 |  |",
      "",
      "[图片]",
      "",
      "[内嵌电子表格]",
    ].join("\n"),
  );
});

test("withIds 时每块前标出块 id，嵌套的列表项也标", () => {
  const { markdown } = renderDocument(
    [
      { block_id: "doc1", block_type: 1, page: { elements: [] }, children: ["p1", "b1"] },
      text("p1", "doc1", "第一段"),
      { block_id: "b1", parent_id: "doc1", block_type: 12, bullet: { elements: [run("项")] }, children: ["b1a"] },
      { block_id: "b1a", parent_id: "b1", block_type: 12, bullet: { elements: [run("子项")] } },
    ],
    { withIds: true },
  );
  assert.equal(
    markdown,
    ["<!-- id:p1 -->", "第一段", "", "<!-- id:b1 -->", "- 项", "  <!-- id:b1a -->", "  - 子项"].join("\n"),
  );
});

test("没有页面块时返回空", () => {
  assert.deepEqual(renderDocument([text("p1", "doc1", "孤儿")]), { title: "", markdown: "" });
});
