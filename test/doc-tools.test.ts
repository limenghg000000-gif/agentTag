import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocBlock } from "../src/doc-render.js";
import { type DocsApi, FeishuDocs } from "../src/docs.js";
import { createDocTools, DOC_PAGE_CHARS, DOC_TOOL_NAMES } from "../src/tools/docs.js";

const DOC = "DocToken1234567890";
const signal = new AbortController().signal;

function docWith(paragraphs: string[]): DocBlock[] {
  const ids = paragraphs.map((_, i) => `p${i}`);
  return [
    { block_id: DOC, block_type: 1, page: { elements: [{ text_run: { content: "长文" } }] }, children: ids },
    ...paragraphs.map((content, i) => ({
      block_id: ids[i],
      parent_id: DOC,
      block_type: 2,
      text: { elements: [{ text_run: { content } }] },
    })),
  ];
}

function setup(blocks: DocBlock[], overrides: Partial<DocsApi> = {}) {
  const edits: unknown[][] = [];
  const api: DocsApi = {
    getWikiNode: async () => ({ objType: "docx", objToken: DOC }),
    listBlocks: async () => blocks,
    createDocument: async () => "newdoc",
    convertMarkdown: async () => ({ firstLevelIds: ["n0"], blocks: [{ block_id: "n0", block_type: 2 }] }),
    insertBlocks: async (...args) => {
      edits.push(["insert", ...args]);
    },
    deleteChildren: async (...args) => {
      edits.push(["delete", ...args]);
    },
    addCollaborator: async () => {},
    getUrl: async () => "https://x.feishu.cn/docx/newdoc",
    ...overrides,
  };
  const tools = createDocTools({ docs: new FeishuDocs(api), chatId: "oc_1", requesterOpenId: "ou_1" });
  const byName = Object.fromEntries(tools.map((tool) => [tool.spec.name, tool]));
  return { tools, byName, edits };
}

test("三个文档工具，名字和导出的列表一致", () => {
  const { tools } = setup([]);
  assert.deepEqual(tools.map((t) => t.spec.name), [...DOC_TOOL_NAMES]);
});

test("读文档：带标题、ID、链接，太长时分段并提示用 offset 接着读", async () => {
  const line = "字".repeat(99);
  const { byName } = setup(docWith(Array.from({ length: 200 }, () => line)));
  const read = byName.feishu_doc_read;

  const first = await read.run({ document: `https://x.feishu.cn/docx/${DOC}` }, { signal });
  assert.match(first, /^标题：长文\n文档 ID：DocToken1234567890\n链接：https:\/\/x\.feishu\.cn\/docx\/DocToken1234567890\n/);
  const note = /全文 (\d+) 字，下面是第 0 到 (\d+) 字，后面还有 \d+ 字，用 offset=(\d+) 接着读/.exec(first);
  assert.ok(note, first);
  const end = Number(note[2]);
  assert.ok(end <= DOC_PAGE_CHARS && end > DOC_PAGE_CHARS - 200);
  assert.equal(note[3], String(end));
  // 断在段落边界上
  assert.match(first, /字\n+$/);

  const second = await read.run({ document: DOC, offset: end }, { signal });
  assert.match(second, new RegExp(`下面是第 ${end} 到 `));
  assert.match(await read.run({ document: DOC, offset: 10 ** 6 }, { signal }), /offset 超出范围/);
});

test("读文档时 with_block_ids 标出块 id；空文档说明是空的", async () => {
  const { byName } = setup(docWith(["第一段"]));
  assert.match(await byName.feishu_doc_read.run({ document: DOC, with_block_ids: true }, { signal }), /<!-- id:p0 -->\n第一段$/);
  const empty = setup(docWith([]));
  assert.match(await empty.byName.feishu_doc_read.run({ document: DOC }, { signal }), /（文档是空的）$/);
});

test("新建文档：返回链接；有没做成的步骤时列出来让模型转告", async () => {
  const ok = setup([]);
  assert.equal(
    await ok.byName.feishu_doc_create.run({ title: "周报", content: "# 本周" }, { signal }),
    "已新建文档「周报」，写入 1 块内容。\n文档 ID：newdoc\n链接：https://x.feishu.cn/docx/newdoc",
  );

  const partial = setup([], {
    addCollaborator: async () => {
      throw new Error("boom");
    },
    getUrl: async () => undefined,
  });
  const text = await partial.byName.feishu_doc_create.run({ title: "周报", content: "# 本周" }, { signal });
  assert.match(text, /与我共享/);
  assert.match(text, /以下步骤没做成，请如实告诉群成员：\n- 没能把文档共享给本群：boom\n- 没能把文档共享给发起人：boom/);
});

test("改文档：校验参数，结果带上文档链接", async () => {
  const { byName, edits } = setup(docWith(["a", "b"]));
  const edit = byName.feishu_doc_edit;
  await assert.rejects(edit.run({ document: DOC, action: "rewrite" }, { signal }), /action 只能是/);
  await assert.rejects(edit.run({ document: DOC, action: "toString" }, { signal }), /action 只能是/);
  assert.equal(edit.describe({ action: "toString" }), "修改飞书文档");
  await assert.rejects(edit.run({ document: DOC, action: "replace", block_id: "p0" }, { signal }), /需要 content/);
  assert.equal(edits.length, 0);

  const url = `https://x.feishu.cn/docx/${DOC}`;
  assert.equal(
    await edit.run({ document: url, action: "replace", block_id: "p0", content: "新的 a" }, { signal }),
    `已把 1 块旧内容替换成 1 块新内容。\n链接：${url}`,
  );
  assert.equal(await edit.run({ document: DOC, action: "delete", block_id: " p1 " }, { signal }), "已删除 1 块内容。\n链接：https://x.feishu.cn/docx/newdoc");
  assert.deepEqual(edits.map((e) => e[0]), ["insert", "delete", "delete"]);
  assert.equal(edit.describe({ action: "append" }), "在文档末尾追加内容");
});

test("改文档前请发起人确认：卡片上写哪篇、怎么改、要动的那段原文和要写进去的内容；原文被人改了认得出来；新建文档不用确认", async () => {
  const blocks = docWith(["第一段", "第二段\n有两行", "第三段"]);
  const { byName, edits } = setup(blocks);
  assert.equal(byName.feishu_doc_create.confirm, false);
  const confirm = byName.feishu_doc_edit.confirm;
  assert.equal(typeof confirm, "function");
  const preview = (args: Record<string, unknown>) => (confirm as Exclude<typeof confirm, false | undefined>)(args, { signal });
  const url = `https://x.feishu.cn/docx/${DOC}`;

  const replace = (await preview({ document: url, action: "replace", block_id: "p1", end_block_id: "p2", content: "新的\n一段" }))!;
  assert.equal(replace.title, "修改文档内容");
  assert.deepEqual(replace.lines, [`文档：「长文」 ${url}`, "换掉的原文：第二段 ↵ 有两行 ↵ 第三段", "写进去的内容：新的 ↵ 一段"]);
  assert.equal(await replace.unchanged!(), true);
  // 确认以后有人在文档里改了那一段
  (blocks[2] as unknown as { text: unknown }).text = { elements: [{ text_run: { content: "别人改过的第二段" } }] };
  assert.equal(await replace.unchanged!(), false);

  const removed = (await preview({ document: DOC, action: "delete", block_id: "p0" }))!;
  assert.deepEqual(removed.lines, ["文档：「长文」 https://x.feishu.cn/docx/newdoc", "删掉的原文：第一段"]);
  assert.equal(await removed.unchanged!(), true);
  // 确认以后有人改了那一段里渲染不出来的东西（@ 的人、图片这类换了，字面一样）：也要重新确认
  const first = blocks.find((block) => block.block_id === "p0") as unknown as { text: { style?: unknown } };
  first.text.style = { align: 2 };
  assert.deepEqual((await preview({ document: DOC, action: "delete", block_id: "p0" }))!.lines, removed.lines, "卡片上看到的原文一样");
  assert.equal(await removed.unchanged!(), false);
  const before = (await preview({ document: DOC, action: "insert_before", block_id: "p2", content: "插一句" }))!;
  assert.equal(before.lines[1], "插在这段前面：第三段");
  // 追加不碰已有的内容，不用核对原文
  const append = (await preview({ document: DOC, action: "append", content: "x".repeat(400) }))!;
  assert.equal(append.title, "在文档末尾追加内容");
  assert.equal(append.unchanged, undefined);
  assert.match(append.lines[1], /^写进去的内容：x{300}…（共 400 字）$/);
  // 参数不对、块找不到：不发卡片，直接报错
  await assert.rejects(preview({ document: DOC, action: "replace", block_id: "p0" }), /需要 content/);
  await assert.rejects(preview({ document: DOC, action: "delete", block_id: "nope" }), /文档里没有块 nope/);
  assert.equal(edits.length, 0, "确认前什么都没改");
});
