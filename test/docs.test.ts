import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { DocBlock } from "../src/doc-render.js";
import {
  type ConvertedBlocks,
  createDocsApi,
  DocError,
  type DocsApi,
  FeishuDocs,
  MAX_BLOCKS_PER_INSERT,
  parseDocRef,
} from "../src/docs.js";
import { FeishuApiError } from "../src/feishu.js";

const para = (id: string, parent: string, content = id): DocBlock => ({
  block_id: id,
  parent_id: parent,
  block_type: 2,
  text: { elements: [{ text_run: { content } }] },
});

const DOC = "DocToken1234567890";

/** 文档下面三段 a、b、c，b 下面挂着 b1 */
const sampleBlocks = (): DocBlock[] => [
  { block_id: DOC, block_type: 1, page: { elements: [{ text_run: { content: "标题" } }] }, children: ["a", "b", "c"] },
  para("a", DOC),
  { ...para("b", DOC), children: ["b1"] },
  para("b1", "b"),
  para("c", DOC),
];

function converted(count: number): ConvertedBlocks {
  const blocks = Array.from({ length: count }, (_, i) => para(`n${i}`, ""));
  return { firstLevelIds: blocks.map((b) => b.block_id), blocks };
}

function fakeApi(overrides: Partial<DocsApi> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    <A extends unknown[], R>(method: string, impl: (...args: A) => Promise<R>) =>
    (...args: A) => {
      calls.push({ method, args });
      return impl(...args);
    };
  const api: DocsApi = {
    getWikiNode: record("getWikiNode", async () => ({ objType: "docx", objToken: DOC, title: "标题" })),
    listBlocks: record("listBlocks", async () => sampleBlocks()),
    createDocument: record("createDocument", async () => "newdoc"),
    convertMarkdown: record("convertMarkdown", async () => converted(2)),
    insertBlocks: record("insertBlocks", async () => {}),
    deleteChildren: record("deleteChildren", async () => {}),
    addCollaborator: record("addCollaborator", async () => {}),
    getUrl: record("getUrl", async () => "https://x.feishu.cn/docx/newdoc"),
  };
  for (const [key, impl] of Object.entries(overrides)) {
    (api as any)[key] = record(key, impl as any);
  }
  const of = (method: string) => calls.filter((c) => c.method === method).map((c) => c.args);
  return { api, calls, of };
}

test("解析文档链接：新版文档、知识库、直接给 ID、其他类型", () => {
  assert.deepEqual(parseDocRef("https://x.feishu.cn/docx/AbCdEfGh12345678?from=from_copylink"), {
    kind: "docx",
    token: "AbCdEfGh12345678",
    origin: "https://x.feishu.cn",
  });
  assert.deepEqual(parseDocRef(" https://x.feishu.cn/wiki/WikiToken1234#part "), {
    kind: "wiki",
    token: "WikiToken1234",
    origin: "https://x.feishu.cn",
  });
  assert.deepEqual(parseDocRef("AbCdEfGh1234567890"), { kind: "docx", token: "AbCdEfGh1234567890" });
  assert.equal(parseDocRef("https://x.feishu.cn/sheets/Sheet1234567").kind, "sheet");
  assert.throws(() => parseDocRef("周报"), DocError);
  assert.throws(() => parseDocRef("https://example.com/about"), /认不出/);
});

test("读知识库链接：先换成背后的文档再读，带上原链接", async () => {
  const { api, of } = fakeApi();
  const doc = await new FeishuDocs(api).read("https://x.feishu.cn/wiki/WikiToken1234");
  assert.deepEqual(of("getWikiNode"), [["WikiToken1234"]]);
  assert.deepEqual(of("listBlocks"), [[DOC]]);
  assert.equal(doc.documentId, DOC);
  assert.equal(doc.title, "标题");
  assert.equal(doc.url, "https://x.feishu.cn/wiki/WikiToken1234");
  assert.equal(doc.markdown, "a\n\nb\nb1\n\nc");
});

test("知识库节点是电子表格、链接是旧版文档时说明不支持", async () => {
  const { api } = fakeApi({ getWikiNode: async () => ({ objType: "sheet", objToken: "s1" }) });
  const docs = new FeishuDocs(api);
  await assert.rejects(docs.read("https://x.feishu.cn/wiki/WikiToken1234"), /电子表格.*只支持/);
  await assert.rejects(docs.read("https://x.feishu.cn/docs/OldDoc12345678"), /旧版飞书文档/);
});

test("append：图片转成链接后转换，插到文末（不带位置）", async () => {
  const { api, of } = fakeApi();
  const { summary, url } = await new FeishuDocs(api).edit("https://x.feishu.cn/docx/doc1AAAAAAAA", {
    action: "append",
    markdown: "## 小结\n![架构图](https://example.com/a.png)",
  });
  assert.deepEqual(of("convertMarkdown"), [["## 小结\n[架构图](https://example.com/a.png)"]]);
  const [[documentId, parentId, ids, descendants, index]] = of("insertBlocks");
  assert.equal(documentId, "doc1AAAAAAAA");
  assert.equal(parentId, "doc1AAAAAAAA");
  assert.deepEqual(ids, ["n0", "n1"]);
  assert.equal((descendants as DocBlock[]).length, 2);
  assert.equal(index, undefined);
  assert.equal(of("listBlocks").length, 0);
  assert.equal(summary, "已在文档末尾追加 2 块内容。");
  assert.equal(url, "https://x.feishu.cn/docx/doc1AAAAAAAA");
});

test("insert_before / insert_after 按块在父块里的位置插入", async () => {
  const { api, of } = fakeApi();
  const docs = new FeishuDocs(api);
  await docs.edit(DOC, { action: "insert_before", blockId: "b", markdown: "x" });
  await docs.edit(DOC, { action: "insert_after", blockId: "b", markdown: "x" });
  await docs.edit(DOC, { action: "insert_after", blockId: "b1", markdown: "x" });
  assert.deepEqual(
    of("insertBlocks").map(([, parent, , , index]) => [parent, index]),
    [[DOC, 1], [DOC, 2], ["b", 1]],
  );
});

test("replace 先插入新内容再删掉旧的一段，delete 只删", async () => {
  const { api, calls } = fakeApi();
  const docs = new FeishuDocs(api);
  const { summary } = await docs.edit(DOC, { action: "replace", blockId: "b", endBlockId: "c", markdown: "新内容" });
  assert.equal(summary, "已把 2 块旧内容替换成 2 块新内容。");
  const writes = calls.filter((c) => c.method === "insertBlocks" || c.method === "deleteChildren");
  assert.deepEqual(
    writes.map((c) => [c.method, c.args[1], ...(c.method === "insertBlocks" ? [c.args[4]] : c.args.slice(2))]),
    [
      ["insertBlocks", DOC, 3],
      ["deleteChildren", DOC, 1, 3],
    ],
  );

  calls.length = 0;
  assert.equal((await docs.edit(DOC, { action: "delete", blockId: "a" })).summary, "已删除 1 块内容。");
  assert.deepEqual(calls.filter((c) => c.method === "deleteChildren")[0].args, [DOC, DOC, 0, 1]);
  assert.equal(calls.filter((c) => c.method === "convertMarkdown").length, 0);
});

test("块 id 不对、范围跨层、倒序、对根块操作时给出能照着改的错误", async () => {
  const { api, of } = fakeApi();
  const docs = new FeishuDocs(api);
  await assert.rejects(docs.edit(DOC, { action: "delete", blockId: "zzz" }), /没有块 zzz.*with_block_ids=true/);
  await assert.rejects(docs.edit(DOC, { action: "delete", blockId: "a", endBlockId: "b1" }), /不在同一层/);
  await assert.rejects(docs.edit(DOC, { action: "delete", blockId: "c", endBlockId: "a" }), /范围要从前往后/);
  await assert.rejects(docs.edit(DOC, { action: "replace", blockId: DOC, markdown: "x" }), /根块/);
  await assert.rejects(docs.edit(DOC, { action: "replace", markdown: "x" }), /需要 block_id/);
  await assert.rejects(docs.edit(DOC, { action: "append", markdown: "  " }), /内容是空的/);
  assert.equal(of("insertBlocks").length + of("deleteChildren").length, 0);
});

test(`一次插入超过 ${MAX_BLOCKS_PER_INSERT} 块时分批，位置顺延`, async () => {
  const { api, of } = fakeApi({ convertMarkdown: async () => converted(1500) });
  await new FeishuDocs(api).edit(DOC, { action: "insert_after", blockId: "a", markdown: "很长" });
  const inserts = of("insertBlocks");
  assert.deepEqual(
    inserts.map(([, , ids, descendants, index]) => [(ids as string[]).length, (descendants as DocBlock[]).length, index]),
    [
      [1000, 1000, 1],
      [500, 500, 1001],
    ],
  );
});

test("嵌套块和它的子块放在同一批里", async () => {
  const blocks: DocBlock[] = [
    { ...para("l1", ""), children: ["l1a", "l1b"] },
    para("l1a", ""),
    para("l1b", ""),
    para("p2", ""),
  ];
  const { api, of } = fakeApi({ convertMarkdown: async () => ({ firstLevelIds: ["l1", "p2"], blocks }) });
  await new FeishuDocs(api).edit(DOC, { action: "append", markdown: "- x\n  - y" });
  const [[, , ids, descendants]] = of("insertBlocks");
  assert.deepEqual(ids, ["l1", "p2"]);
  assert.deepEqual((descendants as DocBlock[]).map((b) => b.block_id), ["l1", "l1a", "l1b", "p2"]);
});

test("新建文档：写入内容，共享给本群（可编辑）和发起人（可管理），返回链接", async () => {
  const { api, of } = fakeApi();
  const result = await new FeishuDocs(api).create("周报", "# 本周\n内容", { chatId: "oc_1", openId: "ou_1" });
  assert.deepEqual(of("createDocument"), [["周报"]]);
  assert.equal(of("insertBlocks")[0][1], "newdoc");
  assert.deepEqual(of("addCollaborator"), [
    ["newdoc", { type: "openchat", id: "oc_1" }, "edit"],
    ["newdoc", { type: "openid", id: "ou_1" }, "full_access"],
  ]);
  assert.deepEqual(result, { documentId: "newdoc", url: "https://x.feishu.cn/docx/newdoc", blocks: 2, problems: [] });
});

test("新建文档时共享失败、拿不到链接：照样返回，列出没做成的步骤，用见过的域名拼链接", async () => {
  const { api } = fakeApi({
    addCollaborator: async (_id, member) => {
      if (member.type === "openchat") {
        throw new FeishuApiError(99991672, "飞书接口返回错误 99991672：应用尚未开通所需的应用身份权限：[docs:permission.member:create]");
      }
    },
    getUrl: async () => {
      throw new FeishuApiError(99991672, "缺权限");
    },
  });
  const docs = new FeishuDocs(api);
  const withoutOrigin = await docs.create("周报", "", { chatId: "oc_1" });
  assert.equal(withoutOrigin.url, undefined);
  assert.equal(withoutOrigin.blocks, 0);
  assert.equal(withoutOrigin.problems.length, 1);
  assert.match(withoutOrigin.problems[0], /没能把文档共享给本群：机器人缺少飞书应用权限.*docs:permission\.member:create/);

  await docs.read("https://abc.feishu.cn/docx/doc1AAAAAAAA");
  assert.equal((await docs.create("周报", "", { chatId: "oc_1" })).url, "https://abc.feishu.cn/docx/newdoc");
});

test("飞书接口错误翻译成能转告的话：没有文档权限时教怎么加文档应用", async () => {
  const forbidden = new FeishuApiError(1770032, "飞书接口返回错误 1770032：forbidden", 403);
  const { api } = fakeApi({
    listBlocks: async () => {
      throw forbidden;
    },
  });
  await assert.rejects(
    new FeishuDocs(api, () => "飞书 CLI").read("doc1AAAAAAAAAAAAAA"),
    (err: Error) => err instanceof DocError && /添加文档应用.*「飞书 CLI」.*分享给机器人所在的群/.test(err.message),
  );
});

test("同一篇文档的修改排队执行，后一次按前一次改完的块位置来", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { api } = fakeApi({
    listBlocks: async () => {
      order.push("list");
      return sampleBlocks();
    },
    deleteChildren: async () => {
      order.push("delete:start");
      await gate;
      order.push("delete:end");
    },
  });
  const docs = new FeishuDocs(api);
  const first = docs.edit(DOC, { action: "delete", blockId: "a" });
  const second = docs.edit(DOC, { action: "delete", blockId: "c" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["list", "delete:start", "delete:end", "list", "delete:start", "delete:end"]);
});

function fakeClient(handlers: Record<string, (payload: any) => Promise<any>>) {
  const calls: Record<string, any[]> = {};
  const handler = (name: string) => async (payload: any) => {
    (calls[name] ??= []).push(payload);
    return handlers[name](payload);
  };
  const client = {
    wiki: { v2: { space: { getNode: handler("getNode") } } },
    docx: {
      v1: {
        document: { create: handler("create"), convert: handler("convert") },
        documentBlock: { list: handler("list") },
        documentBlockDescendant: { create: handler("descendant") },
        documentBlockChildren: { batchDelete: handler("batchDelete") },
      },
    },
    drive: { v1: { permissionMember: { create: handler("member") }, meta: { batchQuery: handler("meta") } } },
  } as unknown as Client;
  return { client, calls };
}

test("接口层：转换结果去掉 parent_id 和表格 merge_info，块分页读完", async () => {
  const pages = [
    { code: 0, data: { items: [{ block_id: "doc1", block_type: 1 }], has_more: true, page_token: "p2" } },
    { code: 0, data: { items: [{ block_id: "a", block_type: 2 }], has_more: false } },
  ];
  const { client, calls } = fakeClient({
    convert: async () => ({
      code: 0,
      data: {
        first_level_block_ids: ["t"],
        blocks: [
          { block_id: "t", parent_id: "", block_type: 31, table: { property: { row_size: 1, column_size: 1, merge_info: [{}] } } },
        ],
      },
    }),
    list: async () => pages.shift(),
  });
  const api = createDocsApi(client);
  assert.deepEqual(await api.convertMarkdown("| a |\n| - |"), {
    firstLevelIds: ["t"],
    blocks: [{ block_id: "t", block_type: 31, table: { property: { row_size: 1, column_size: 1 } } }],
  });
  assert.deepEqual((await api.listBlocks("doc1")).map((b) => b.block_id), ["doc1", "a"]);
  assert.deepEqual(calls.list.map((p) => p.params.page_token), [undefined, "p2"]);
});

test("接口层：SDK 抛出的 HTTP 错误和返回的非零 code 都换成 FeishuApiError", async () => {
  const { client, calls } = fakeClient({
    list: async () => {
      throw Object.assign(new Error("Request failed with status code 403"), {
        response: { status: 403, data: { code: 1770032, msg: "forbidden" } },
      });
    },
    member: async () => ({ code: 1063001, msg: "Invalid parameter" }),
  });
  const api = createDocsApi(client);
  await assert.rejects(
    api.listBlocks("doc1"),
    (err: unknown) => err instanceof FeishuApiError && err.code === 1770032 && err.status === 403,
  );
  await assert.rejects(api.addCollaborator("doc1", { type: "openchat", id: "oc_1" }, "edit"), /1063001/);
  assert.deepEqual(calls.member[0], {
    path: { token: "doc1" },
    params: { type: "docx", need_notification: false },
    data: { member_type: "openchat", member_id: "oc_1", perm: "edit", type: "chat" },
  });
});
