import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { FeishuApiError } from "../src/feishu.js";
import { KnowledgeBase, KnowledgeError, normalizeDraft } from "../src/knowledge.js";
import {
  type BitableApi,
  type BitableField,
  BitableKnowledgeBackend,
  type BitableMember,
  type BitableRecord,
  parseBitableUrl,
} from "../src/knowledge-bitable.js";

const quiet = { info() {}, warn() {}, error() {} };
const dir = await mkdtemp(path.join(tmpdir(), "agenttag-knowledge-"));
after(() => rm(dir, { recursive: true, force: true }));

function fakeBitable() {
  const calls: string[] = [];
  const tables = new Map<string, { fields: BitableField[]; records: BitableRecord[] }>();
  const shared: [BitableMember, string][] = [];
  let next = 0;
  const api: BitableApi & { fail?: Error } = {
    async createApp(name) {
      calls.push(`createApp ${name}`);
      tables.set("tbl_default", { fields: [], records: [] });
      return { appToken: "app1", url: "https://example.feishu.cn/base/app1", defaultTableId: "tbl_default" };
    },
    async createTable(_app, name, fields) {
      calls.push(`createTable ${name}`);
      tables.set("tbl1", { fields: [...fields], records: [] });
      return "tbl1";
    },
    async deleteTable(_app, tableId) {
      calls.push(`deleteTable ${tableId}`);
      tables.delete(tableId);
    },
    async listRecords(_app, tableId) {
      if (api.fail) {
        throw api.fail;
      }
      return structuredClone(tables.get(tableId)?.records ?? []);
    },
    async createRecord(_app, tableId, fields) {
      const recordId = `rec${++next}`;
      tables.get(tableId)!.records.push({ recordId, fields: { ...fields, 保存时间: 1_760_000_000_000 } });
      return recordId;
    },
    async updateRecord(_app, tableId, recordId, fields) {
      Object.assign(tables.get(tableId)!.records.find((r) => r.recordId === recordId)!.fields, fields);
    },
    async addCollaborator(_app, member, perm) {
      shared.push([member, perm]);
    },
    async getUrl() {
      return undefined;
    },
  };
  return { api, calls, tables, shared };
}

const dau = normalizeDraft({ category: "metric", title: "日活的口径", question: "日活怎么统计", conclusion: "当天打开过 App 的去重用户数", keywords: "日活,DAU" });

test("第一次保存时建多维表格：只留经验库这张表，共享给白名单群（只读）和写权限名单里的人（可管理），记进数据目录；重启后接着用", async () => {
  const stateFile = path.join(dir, "first", "bitable.json");
  const { api, calls, tables, shared } = fakeBitable();
  const backend = new BitableKnowledgeBackend({ api, stateFile, share: { chatIds: ["oc_1"], editors: ["ou_admin"] }, logger: quiet });
  const base = new KnowledgeBase(backend, { logger: quiet });

  assert.deepEqual(await base.search("日活"), [], "还没建表时检索不调接口");
  assert.equal(await backend.location(), undefined);
  assert.equal(calls.length, 0);

  const entry = await base.save(dau, { proposedBy: "张三", confirmedBy: "ML", source: "飞书群 oc_1" });
  assert.equal(entry.id, "K1");
  assert.deepEqual(calls, ["createApp AgentTag 经验库", "createTable 经验库", "deleteTable tbl_default"]);
  assert.deepEqual(shared, [
    [{ type: "openchat", id: "oc_1" }, "view"],
    [{ type: "openid", id: "ou_admin" }, "full_access"],
  ]);
  const table = tables.get("tbl1")!;
  const fields: Record<string, unknown> = table.records[0].fields;
  assert.deepEqual(table.fields.map((f) => f.field_name).slice(0, 4), ["标题", "编号", "类别", "状态"]);
  assert.deepEqual({ ...fields }, {
    标题: "日活的口径",
    编号: "K1",
    类别: "数据口径",
    状态: "有效",
    问题或场景: "日活怎么统计",
    结论: "当天打开过 App 的去重用户数",
    关键词: "日活,DAU",
    发起人: "张三",
    确认人: "ML",
    来源: "飞书群 oc_1",
    保存时间: 1_760_000_000_000,
  });
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")), { appToken: "app1", tableId: "tbl1", url: "https://example.feishu.cn/base/app1?table=tbl1" });

  // 重启：读数据目录里记的表，不再建
  const again = new KnowledgeBase(new BitableKnowledgeBackend({ api, stateFile, share: { chatIds: [], editors: [] }, logger: quiet }), { logger: quiet });
  const [hit] = await again.search("DAU 怎么算");
  assert.equal(hit.entry.id, "K1");
  assert.equal(hit.entry.createdAt, new Date(1_760_000_000_000).toISOString());
  await again.linkAiops("K1", 31);
  await again.archive("K1");
  assert.equal(fields["aiops 经验编号"], "31");
  assert.equal(fields["状态"], "已归档");
  assert.equal(calls.filter((c) => c.startsWith("createApp")).length, 1);
});

test("没配写权限名单时群也给可编辑；用 KNOWLEDGE_BITABLE 指定的表时不自己建", async () => {
  const { api, calls, shared } = fakeBitable();
  const backend = new BitableKnowledgeBackend({
    api,
    stateFile: path.join(dir, "edit", "bitable.json"),
    share: { chatIds: ["oc_1"], editors: [], chatPerm: "edit" },
    logger: quiet,
  });
  await new KnowledgeBase(backend, { logger: quiet }).save(dau);
  assert.deepEqual(shared, [[{ type: "openchat", id: "oc_1" }, "edit"]]);

  const target = fakeBitable();
  target.tables.set("tblX", { fields: [], records: [] });
  const fixed = new BitableKnowledgeBackend({
    api: target.api,
    stateFile: path.join(dir, "fixed", "bitable.json"),
    target: { appToken: "appX", tableId: "tblX", url: "https://example.feishu.cn/base/appX?table=tblX" },
    share: { chatIds: ["oc_1"], editors: [] },
    logger: quiet,
  });
  await new KnowledgeBase(fixed, { logger: quiet }).save(dau);
  assert.equal(target.calls.length, 0);
  assert.equal(await fixed.location(), "https://example.feishu.cn/base/appX?table=tblX");
  assert.equal(calls.length, 3);
});

test("表格里有人手动加的行：文本列是分段数组也能读，没编号的用行号，没有标题或结论的跳过；类别认不出算其他", async () => {
  const { api, tables } = fakeBitable();
  tables.set("tblX", {
    fields: [],
    records: [
      { recordId: "recA", fields: { 标题: [{ type: "text", text: "退款" }, { type: "text", text: "多久到账" }], 结论: "3 个工作日", 类别: "常见问题" } },
      { recordId: "recB", fields: { 标题: "写到一半" } },
      { recordId: "recC", fields: { 标题: "已归档的", 结论: "旧的", 状态: "已归档", 编号: "K5" } },
    ],
  });
  const backend = new BitableKnowledgeBackend({ api, stateFile: path.join(dir, "manual.json"), target: { appToken: "appX", tableId: "tblX" }, share: { chatIds: [], editors: [] } });
  const entries = await backend.list();
  assert.deepEqual(
    entries.map((e) => [e.id, e.title, e.category, e.status]),
    [
      ["recA", "退款多久到账", "other", "active"],
      ["K5", "已归档的", "other", "archived"],
    ],
  );
  // 编号接着表里最大的 K 编号往后排
  assert.equal((await new KnowledgeBase(backend, { logger: quiet }).save(dau)).id, "K6");
});

test("飞书接口的错误翻译成能转告的话：缺权限时说要开 bitable:app", async () => {
  const { api } = fakeBitable();
  api.fail = new FeishuApiError(99991672, "飞书接口返回错误 99991672：应用未开通权限：[bitable:app]");
  const backend = new BitableKnowledgeBackend({ api, stateFile: path.join(dir, "err.json"), target: { appToken: "appX", tableId: "tblX" }, share: { chatIds: [], editors: [] } });
  await assert.rejects(backend.list(), (err: Error) => err instanceof KnowledgeError && /多维表格权限（bitable:app）/.test(err.message));
  api.fail = new FeishuApiError(1254302, "飞书接口返回错误 1254302：no permission", 403);
  await assert.rejects(backend.list(), /添加文档应用/);
});

test("KNOWLEDGE_BITABLE 要填打开数据表时浏览器里的链接", () => {
  assert.deepEqual(parseBitableUrl("https://example.feishu.cn/base/AbCd123?table=tblXyZ&view=vew1"), {
    appToken: "AbCd123",
    tableId: "tblXyZ",
    url: "https://example.feishu.cn/base/AbCd123?table=tblXyZ",
  });
  assert.throws(() => parseBitableUrl("AbCd123"), /要填多维表格的链接/);
  assert.throws(() => parseBitableUrl("https://example.feishu.cn/base/AbCd123"), /\?table=tbl/);
  assert.throws(() => parseBitableUrl("https://example.feishu.cn/wiki/AbCd123?table=tblX"), /\/base\/<app_token>/);
});
