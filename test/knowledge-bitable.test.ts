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
  const tokens: (string | undefined)[] = [];
  const restricted: string[] = [];
  let next = 0;
  const api: BitableApi & { fail?: Error; failShare?: (member: BitableMember) => boolean; failRestrict?: boolean } = {
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
    async listFields(_app, tableId) {
      return (tables.get(tableId)?.fields ?? []).map((f) => f.field_name);
    },
    async createField(_app, tableId, field) {
      calls.push(`createField ${field.field_name}`);
      tables.get(tableId)!.fields.push(field);
    },
    async createRecord(_app, tableId, fields, clientToken) {
      tokens.push(clientToken);
      const recordId = `rec${++next}`;
      tables.get(tableId)!.records.push({ recordId, fields: { ...fields, 保存时间: 1_760_000_000_000 } });
      return recordId;
    },
    async updateRecord(_app, tableId, recordId, fields) {
      Object.assign(tables.get(tableId)!.records.find((r) => r.recordId === recordId)!.fields, fields);
    },
    async addCollaborator(_app, member, perm) {
      if (api.failShare?.(member)) {
        throw new FeishuApiError(99991672, "飞书接口返回错误 99991672：应用未开通权限：[docs:permission.member:create]");
      }
      shared.push([member, perm]);
    },
    async updateCollaborator(_app, member, perm) {
      calls.push(`update ${member.id} ${perm}`);
    },
    async removeCollaborator(_app, member) {
      calls.push(`remove ${member.id}`);
    },
    async restrictSharing(app) {
      if (api.failRestrict) {
        throw new FeishuApiError(99991672, "飞书接口返回错误 99991672：应用未开通权限：[docs:permission.setting:write_only]");
      }
      restricted.push(`${app}，此前已共享 ${shared.length} 个`);
    },
    async getUrl() {
      return undefined;
    },
  };
  return { api, calls, tables, shared, tokens, restricted };
}

const dau = normalizeDraft({ category: "metric", title: "日活的口径", question: "日活怎么统计", conclusion: "当天打开过 App 的去重用户数", keywords: "日活,DAU" });

test("第一次保存时建多维表格：只留经验库这张表，先设成只有机器人能管协作者，再共享给白名单群（只读）和写权限名单里的人（可编辑），记进数据目录；重启后接着用", async () => {
  const stateFile = path.join(dir, "first", "bitable.json");
  const { api, calls, tables, shared, restricted } = fakeBitable();
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
    [{ type: "openid", id: "ou_admin" }, "edit"],
  ]);
  assert.deepEqual(restricted, ["app1，此前已共享 0 个"], "共享之前先设好");
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
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")), {
    appToken: "app1",
    tableId: "tbl1",
    url: "https://example.feishu.cn/base/app1?table=tbl1",
    shared: ["openchat:oc_1:view", "openid:ou_admin:edit"],
    restricted: true,
  });

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
  assert.ok(!target.calls.some((c) => c.startsWith("createApp")), "指定了表就不自己建");
  assert.equal(await fixed.location(), "https://example.feishu.cn/base/appX?table=tblX");
  assert.equal(calls.length, 3);
});

test("共享失败的下次保存时再试，后来加进白名单的群也补上；共享失败不影响保存", async () => {
  const stateFile = path.join(dir, "share", "bitable.json");
  const { api, shared } = fakeBitable();
  api.failShare = (member) => member.type === "openchat";
  const first = new BitableKnowledgeBackend({ api, stateFile, share: { chatIds: ["oc_1"], editors: ["ou_admin"] }, logger: quiet });
  assert.equal((await new KnowledgeBase(first, { logger: quiet }).save(dau)).id, "K1");
  assert.deepEqual(shared, [[{ type: "openid", id: "ou_admin" }, "edit"]]);
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).shared, ["openid:ou_admin:edit"]);

  // 开通权限、重启，白名单里又加了一个群：下次保存时补上没共享成的，已经共享过的不再调
  api.failShare = undefined;
  const again = new BitableKnowledgeBackend({ api, stateFile, share: { chatIds: ["oc_1", "oc_2"], editors: ["ou_admin"] }, logger: quiet });
  assert.equal((await new KnowledgeBase(again, { logger: quiet }).save(dau)).id, "K2");
  assert.deepEqual(shared.slice(1), [
    [{ type: "openchat", id: "oc_1" }, "view"],
    [{ type: "openchat", id: "oc_2" }, "view"],
  ]);
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).shared, ["openid:ou_admin:edit", "openchat:oc_1:view", "openchat:oc_2:view"]);
  await new KnowledgeBase(again, { logger: quiet }).save(dau);
  assert.equal(shared.length, 3, "都共享过了就不再调");
});

test("共享跟着名单走：启动时把移出白名单的群、移出写权限名单的人的权限撤掉，权限变了的改掉；用 KNOWLEDGE_BITABLE 指定的表时不动", async () => {
  const stateFile = path.join(dir, "revoke", "bitable.json");
  const { api, calls } = fakeBitable();
  const first = new BitableKnowledgeBackend({ api, stateFile, share: { chatIds: ["oc_1", "oc_2"], editors: ["ou_admin", "ou_old"] }, logger: quiet });
  await new KnowledgeBase(first, { logger: quiet }).save(dau);

  // 重启：oc_2 和 ou_old 移出了名单；写权限名单清空后群改成可编辑
  const restarted = new BitableKnowledgeBackend({ api, stateFile, share: { chatIds: ["oc_1"], editors: [], chatPerm: "edit" }, logger: quiet });
  await restarted.syncSharing();
  assert.deepEqual(calls.slice(3), ["update oc_1 edit", "remove oc_2", "remove ou_admin", "remove ou_old"]);
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).shared, ["openchat:oc_1:edit"]);
  await restarted.syncSharing();
  assert.equal(calls.length, 7, "名单没变就不再调");

  const target = fakeBitable();
  const fixed = new BitableKnowledgeBackend({
    api: target.api,
    stateFile: path.join(dir, "fixed-sync", "bitable.json"),
    target: { appToken: "appX", tableId: "tblX" },
    share: { chatIds: ["oc_1"], editors: [] },
    logger: quiet,
  });
  await fixed.syncSharing();
  assert.equal(target.calls.length, 0);
});

test("撤权限失败（没开 docs:permission.member:delete）时警告写明缺的权限，记录留着，下次启动再撤", async () => {
  const stateFile = path.join(dir, "revoke-fail", "bitable.json");
  const { api, calls } = fakeBitable();
  await new KnowledgeBase(new BitableKnowledgeBackend({ api, stateFile, share: { chatIds: ["oc_1"], editors: ["ou_old"] }, logger: quiet }), { logger: quiet }).save(dau);
  const remove = api.removeCollaborator.bind(api);
  api.removeCollaborator = async () => {
    throw new FeishuApiError(99991672, "飞书接口返回错误 99991672：应用未开通权限：[docs:permission.member:delete]");
  };
  const warnings: string[] = [];
  const logger = { ...quiet, warn: (message: string) => void warnings.push(message) };
  await new BitableKnowledgeBackend({ api, stateFile, share: { chatIds: ["oc_1"], editors: [] }, logger }).syncSharing();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /撤掉 ou_old .*要用应用权限 docs:permission\.member:delete/);
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).shared, ["openchat:oc_1:view", "openid:ou_old:edit"]);

  api.removeCollaborator = remove;
  await new BitableKnowledgeBackend({ api, stateFile, share: { chatIds: ["oc_1"], editors: [] }, logger: quiet }).syncSharing();
  assert.deepEqual(calls.slice(-1), ["remove ou_old"]);
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).shared, ["openchat:oc_1:view"]);
});

test("设置谁能管协作者失败（没开 docs:permission.setting:write_only）时先不共享给任何人，警告写明缺的权限；开了以后下次启动设好再共享", async () => {
  const stateFile = path.join(dir, "restrict-fail", "bitable.json");
  const { api, shared, restricted } = fakeBitable();
  api.failRestrict = true;
  const warnings: string[] = [];
  const logger = { ...quiet, warn: (message: string) => void warnings.push(message) };
  await new KnowledgeBase(new BitableKnowledgeBackend({ api, stateFile, share: { chatIds: ["oc_1"], editors: [] }, logger }), { logger: quiet }).save(dau);
  assert.equal(shared.length, 0, "没限制好之前不共享");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /只有机器人能加、移除协作者.*要用应用权限 docs:permission\.setting:write_only/);
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).restricted, undefined);

  api.failRestrict = false;
  await new BitableKnowledgeBackend({ api, stateFile, share: { chatIds: ["oc_1"], editors: [] }, logger: quiet }).syncSharing();
  assert.deepEqual(restricted, ["app1，此前已共享 0 个"]);
  assert.equal(shared.length, 1);
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.restricted, true);
  assert.deepEqual(state.shared, ["openchat:oc_1:view"]);
  await new BitableKnowledgeBackend({ api, stateFile, share: { chatIds: ["oc_1"], editors: [] }, logger: quiet }).syncSharing();
  assert.equal(restricted.length, 1, "设好了就不再调");
});

test("加协作者前先记进数据目录：加上了但结果没传回来时记成不确定，移出名单后照样撤；还在名单里的下次再加一次确认", async () => {
  const stateFile = path.join(dir, "journal", "bitable.json");
  const { api, calls, shared } = fakeBitable();
  const add = api.addCollaborator.bind(api);
  const recorded: string[][] = [];
  // 飞书加上了，但结果没传回来
  api.addCollaborator = async (app, member, perm) => {
    recorded.push(JSON.parse(await readFile(stateFile, "utf8")).shared);
    await add(app, member, perm);
    throw new Error("socket hang up");
  };
  await new KnowledgeBase(new BitableKnowledgeBackend({ api, stateFile, share: { chatIds: ["oc_1", "oc_2"], editors: [] }, logger: quiet }), { logger: quiet }).save(dau);
  assert.deepEqual(recorded, [["openchat:oc_1:view"], ["openchat:oc_1:view", "openchat:oc_2:view"]], "调接口之前已经记下了");
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).pending, ["openchat:oc_1", "openchat:oc_2"]);

  // 重启：oc_2 移出了名单，oc_1 还在
  api.addCollaborator = add;
  await new BitableKnowledgeBackend({ api, stateFile, share: { chatIds: ["oc_1"], editors: [] }, logger: quiet }).syncSharing();
  assert.deepEqual(calls.slice(-1), ["remove oc_2"]);
  assert.equal(shared.filter(([member]) => member.id === "oc_1").length, 2, "结果不明的再加一次");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(state.shared, ["openchat:oc_1:view"]);
  assert.equal(state.pending, undefined);
});

test("保存时把草稿编号带给飞书（client_token）并写进表格；点保存重试时同一个草稿编号不再写一行", async () => {
  const { api, tables, tokens } = fakeBitable();
  tables.set("tblX", { fields: [], records: [] });
  const backend = new BitableKnowledgeBackend({ api, stateFile: path.join(dir, "token.json"), target: { appToken: "appX", tableId: "tblX" }, share: { chatIds: [], editors: [] } });
  const base = new KnowledgeBase(backend, { logger: quiet });
  const requestId = "0f8e2a3c-7a51-4b8e-9d0c-1f2e3d4c5b6a";
  // 第一次：飞书写进去了，但结果没传回来
  const create = api.createRecord.bind(api);
  api.createRecord = async (...args) => {
    await create(...args);
    throw new FeishuApiError(0, "socket hang up");
  };
  await assert.rejects(base.save(dau, { requestId }), /socket hang up/);
  api.createRecord = create;
  const retried = await base.save(dau, { requestId });
  assert.equal(retried.id, "K1");
  assert.equal(tables.get("tblX")!.records.length, 1);
  assert.deepEqual(tokens, [requestId]);
  assert.equal(tables.get("tblX")!.records[0].fields["草稿编号"], requestId);
  assert.equal((await backend.list())[0].requestId, requestId);
});

test("KNOWLEDGE_BITABLE 指定的表缺列时，第一次写之前补上；已有的列不动，同一次启动只查一次", async () => {
  const { api, calls, tables } = fakeBitable();
  tables.set("tblX", { fields: [{ field_name: "标题", type: 1 }, { field_name: "结论", type: 1 }], records: [] });
  const backend = new BitableKnowledgeBackend({ api, stateFile: path.join(dir, "schema.json"), target: { appToken: "appX", tableId: "tblX" }, share: { chatIds: [], editors: [] }, logger: quiet });
  const base = new KnowledgeBase(backend, { logger: quiet });
  await base.save(dau);
  const created = calls.filter((c) => c.startsWith("createField"));
  assert.ok(created.includes("createField 草稿编号") && created.includes("createField 编号") && created.includes("createField 保存时间"));
  assert.ok(!created.includes("createField 标题") && !created.includes("createField 结论"));
  assert.deepEqual(new Set(tables.get("tblX")!.fields.map((f) => f.field_name)).size, tables.get("tblX")!.fields.length);
  await base.save(dau);
  assert.equal(calls.filter((c) => c.startsWith("createField")).length, created.length);
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

test("表格里有两行编号相同（有人复制了行）时不去改它们，免得改错行", async () => {
  const { api, tables } = fakeBitable();
  tables.set("tblX", {
    fields: [],
    records: [
      { recordId: "recA", fields: { 标题: "日活的口径", 结论: "去重用户数", 编号: "K1" } },
      { recordId: "recB", fields: { 标题: "日活的口径（副本）", 结论: "去重用户数", 编号: "K1" } },
      { recordId: "recC", fields: { 标题: "留存的口径", 结论: "次日还打开", 编号: "K2" } },
    ],
  });
  const backend = new BitableKnowledgeBackend({ api, stateFile: path.join(dir, "dup.json"), target: { appToken: "appX", tableId: "tblX" }, share: { chatIds: [], editors: [] }, logger: quiet });
  const base = new KnowledgeBase(backend, { logger: quiet });
  await assert.rejects(base.archive("K1"), /不止一行的编号是 K1/);
  assert.equal(tables.get("tblX")!.records[0].fields["状态"], undefined);
  await base.archive("K2");
  assert.equal(tables.get("tblX")!.records[2].fields["状态"], "已归档");
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
