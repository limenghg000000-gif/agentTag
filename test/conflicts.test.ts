import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CardActionEvent, SendInput, SendOptions } from "@larksuiteoapi/node-sdk";
import { type KnowledgeBackend, KnowledgeBase, type KnowledgeEntry } from "../src/knowledge.js";
import { MemoryStore } from "../src/memory.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { CONFLICT_ACTION, CONFLICT_TOOL, CONFLICT_TTL_MS, MAX_CONFLICTS } from "../src/tools/conflicts.js";
import { KnowledgeDesk } from "../src/tools/knowledge.js";

const quiet = { info() {}, warn() {}, error() {} };
const signal = new AbortController().signal;

class TableBackend implements KnowledgeBackend {
  entries: KnowledgeEntry[] = [];
  failAdd?: Error;

  async location() {
    return "https://example.feishu.cn/base/app1?table=tbl1";
  }

  async list() {
    return structuredClone(this.entries);
  }

  async add(entry: KnowledgeEntry) {
    if (this.failAdd) {
      throw this.failAdd;
    }
    this.entries.push(structuredClone(entry));
  }

  async update(row: Pick<KnowledgeEntry, "id">, changes: Partial<KnowledgeEntry>) {
    Object.assign(this.entries.find((entry) => entry.id === row.id)!, changes);
  }
}

/** 经验库里的发版经验：10 月 10 日存的 */
const release: KnowledgeEntry = {
  id: "K1",
  category: "decision",
  title: "发版时间",
  question: "每周什么时候发版",
  conclusion: "发版改到每周四下午",
  handling: "周四上午封板",
  status: "active",
  confirmedBy: "ML",
  createdAt: "2026-10-10T06:00:00.000Z",
};

/** 经验库里的告警经验：10 月 1 日存的，比群记忆旧 */
const alarm: KnowledgeEntry = {
  id: "K2",
  category: "answer",
  title: "收不到验证码",
  question: "用户说收不到验证码",
  conclusion: "先查短信通道",
  status: "active",
  createdAt: "2026-10-01T06:00:00.000Z",
};

async function setup({ approvers = new Set(["ou_admin"]), memory = true }: { approvers?: ReadonlySet<string> | null; memory?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "conflicts-"));
  const backend = new TableBackend();
  backend.entries.push(structuredClone(release), structuredClone(alarm));
  const base = new KnowledgeBase(backend, { logger: quiet, cacheMs: 0 });
  let clock = Date.parse("2026-10-05T06:00:00.000Z");
  const store = new MemoryStore(dir, quiet, () => new Date(clock));
  // 群记忆 #1 是 10 月 5 日记的（比 K1 旧、比 K2 新），#2 也是
  await store.add("oc_1", "decision", "发版固定在每周三", { name: "张三" });
  await store.add("oc_1", "convention", "收不到验证码先让用户重启手机", { name: "李四" });
  const sent: { to: string; input: SendInput; opts?: SendOptions }[] = [];
  const updates: { messageId: string; card: any }[] = [];
  let now = 1_000_000;
  const desk = new KnowledgeDesk({
    base,
    send: async (to, input, opts) => {
      sent.push({ to, input, opts });
      return { messageId: `om_card_${sent.length}` };
    },
    updateCard: async (messageId, card) => {
      updates.push({ messageId, card });
    },
    ...(approvers ? { approvers } : {}),
    allowedChatIds: new Set(["oc_1"]),
    ...(memory ? { memory: store } : {}),
    logger: quiet,
    now: () => now,
    retryDelayMs: 0,
  });
  const ctx = { chatId: "oc_1", threadKey: "om_root", senderId: "ou_1", askerName: "张三", messageId: "om_1" };
  const tool = () => desk.tools(ctx).find((t) => t.spec.name === CONFLICT_TOOL)!;
  /** 最新的冲突卡片：改过的按最后一次改的，没改过的按发出去的 */
  const card = () => updates.findLast((one) => one.messageId === "om_card_1")?.card ?? (sent[0].input as { card: any }).card;
  const elements = (c: any): any[] => c.body.elements;
  const selects = (c: any) => elements(c).filter((e) => e.tag === "select_static");
  const buttonValue = (c: any, op: string) => elements(c).find((e) => e.tag === "button" && e.behaviors[0].value.op === op)?.behaviors[0].value;
  const event = (value: unknown, openId: string, name: string, extra: Partial<CardActionEvent["action"]> = {}, messageId = "om_card_1"): CardActionEvent => ({
    messageId,
    chatId: "oc_1",
    operator: { openId, name },
    action: { tag: "button", value, ...extra },
  });
  const pick = (row: number, option: string, openId = "ou_2", name = "李四") =>
    desk.handleCardAction(event(selects(card())[row].behaviors[0].value, openId, name, { tag: "select_static", option }));
  const apply = async (openId = "ou_admin", name = "ML") => {
    await desk.handleCardAction(event(buttonValue(card(), "apply"), openId, name));
    await desk.idle();
  };
  const both = [
    { memory_id: 1, knowledge_id: "K1", topic: "发版日期：群记忆说周三，经验库说周四", memory_fix: "发版固定在每周四下午", knowledge_conclusion: "发版固定在每周三" },
    {
      memory_id: 2,
      knowledge_id: "K2",
      topic: "收不到验证码先做什么",
      memory_fix: "",
      knowledge_conclusion: "先让用户重启手机，还收不到再查短信通道",
      knowledge_handling: "重启后仍收不到转给开发",
    },
  ];
  return {
    dir,
    backend,
    store,
    desk,
    sent,
    updates,
    tool,
    card,
    elements,
    selects,
    buttonValue,
    event,
    pick,
    apply,
    both,
    advance: (ms: number) => (now += ms),
    setClock: (iso: string) => (clock = Date.parse(iso)),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const text = (card: any) => JSON.stringify(card);

test("冲突卡片：有群记忆、配了写权限名单才给工具；提示词说对不上时按新的回答、发卡片让大家选", async () => {
  const s = await setup();
  try {
    assert.ok(s.tool(), "有群记忆和写权限名单时给冲突卡片的工具");
    const prompt = buildSystemPrompt({
      botName: "飞书 CLI",
      now: new Date("2026-10-14T09:00:00Z"),
      toolNames: ["memory_save", "knowledge_search", "knowledge_propose", CONFLICT_TOOL],
      memory: { text: "", omitted: 0 },
      knowledge: { hits: "" },
    });
    assert.match(prompt, /群记忆和团队经验库.*说法对不上时，按日期新的那边回答，回答里说一句两边不一致/);
    assert.match(prompt, new RegExp(`再调 ${CONFLICT_TOOL} 把对不上的几处列成一张卡片`));
    assert.match(prompt, /不要自己用 memory_update、memory_delete 或 knowledge_propose 只改一边/);
    assert.match(prompt, /查一下群记忆和经验库有没有冲突/);
    // 没有这个工具（点按钮问的、没配写权限名单）：照样按新的回答，不提卡片
    const plain = buildSystemPrompt({
      botName: "飞书 CLI",
      now: new Date("2026-10-14T09:00:00Z"),
      toolNames: ["memory_save", "knowledge_search"],
      memory: { text: "", omitted: 0 },
      knowledge: { hits: "" },
    });
    assert.match(plain, /说法对不上时，按日期新的那边回答/);
    assert.doesNotMatch(plain, new RegExp(CONFLICT_TOOL));
  } finally {
    await s.cleanup();
  }
  for (const options of [{ memory: false }, { approvers: null }]) {
    const other = await setup(options);
    try {
      assert.equal(other.tool(), undefined, `${JSON.stringify(options)} 时不给冲突卡片的工具`);
    } finally {
      await other.cleanup();
    }
  }
});

test("冲突卡片：每处列出两边的说法和选了以后各改成什么，默认选更新的那边；告诉模型两边都还没改", async () => {
  const s = await setup();
  try {
    const result = await s.tool().run({ conflicts: s.both }, { signal });
    assert.match(result, /列了 2 处（第 1 处默认以经验库为准，第 2 处默认以群记忆为准）/);
    assert.match(result, /现在两边都还没改/);
    assert.equal(s.sent.length, 1);
    assert.deepEqual(s.sent[0].opts, { replyTo: "om_1", replyInThread: true });
    const card = s.card();
    assert.equal(card.header.title.content, "群记忆和经验库有 2 处对不上");
    assert.match(text(card), /第 1 处：发版日期：群记忆说周三，经验库说周四/);
    assert.match(text(card), /\*\*群记忆 #1\*\*（张三，2026\/10\/5 14:00）：发版固定在每周三/);
    assert.match(text(card), /\*\*经验 K1\*\*「发版时间」（保存于 2026\/10\/10 14:00）：结论：发版改到每周四下午；怎么处理：周四上午封板/);
    assert.match(text(card), /经验库这条更新，默认以经验库为准/);
    assert.match(text(card), /选「以经验库为准」：群记忆 #1 改成「发版固定在每周四下午」/);
    assert.match(text(card), /选「以群记忆为准」：经验 K1 换成新的一条，结论改成「发版固定在每周三」，其他照旧，旧的 K1 归档/);
    assert.match(text(card), /群记忆这条更新，默认以群记忆为准/);
    assert.match(text(card), /选「以经验库为准」：删掉群记忆 #2/);
    assert.match(text(card), /结论改成「先让用户重启手机，还收不到再查短信通道」，怎么处理改成「重启后仍收不到转给开发」/);
    assert.match(text(card), /只改群记忆的话群里谁都能点；有选「以群记忆为准」的要改经验库（所有群共用），只有写权限名单里的人能点/);
    const selects = s.selects(card);
    assert.deepEqual(
      selects.map((one) => one.initial_option),
      ["knowledge", "memory"],
    );
    assert.deepEqual(
      selects[0].options.map((option: any) => [option.value, option.text.content]),
      [
        ["memory", "以群记忆为准"],
        ["knowledge", "以经验库为准"],
        ["skip", "先不动"],
      ],
    );
    assert.deepEqual(selects[1].behaviors[0].value, { action: CONFLICT_ACTION, card: s.buttonValue(card, "apply").card, op: "pick", row: "1" });
    assert.ok(s.buttonValue(card, "cancel"));
    // 只是发了卡片：两边都没改
    assert.equal((await s.store.list("oc_1")).length, 2);
    assert.equal(s.backend.entries.length, 2);
  } finally {
    await s.cleanup();
  }
});

test("冲突卡片：列的不对时不发卡片，告诉模型第几处哪里不对", async () => {
  const s = await setup();
  try {
    const [first, second] = s.both;
    const cases: [unknown, RegExp][] = [
      [[], /要列至少一处/],
      [Array.from({ length: MAX_CONFLICTS + 1 }, () => first), new RegExp(`一张卡片最多列 ${MAX_CONFLICTS} 处`)],
      [[{ ...first, memory_id: 9 }], /第 1 处：这个群没有编号为 #9 的群记忆/],
      [[first, { ...second, memory_id: 1 }], /第 2 处：群记忆 #1 列了不止一次/],
      [[first, { ...second, knowledge_id: "k1" }], /第 2 处：经验 K1 列了不止一次/],
      [[{ ...first, knowledge_id: "K9" }], /第 1 处：团队经验库里没有 K9/],
      [[{ ...first, memory_fix: "发版固定在每周三" }], /memory_fix 和群记忆 #1 现在的内容一样/],
      [[{ ...first, knowledge_conclusion: "发版改到每周四下午" }], /knowledge_conclusion 和经验 K1 现在的结论一样/],
      [[{ ...first, memory_fix: `发版找 ${["138", "0013", "8000"].join("")} 确认` }], /第 1 处：memory_fix 里像是有手机号/],
      [[{ ...first, knowledge_conclusion: ["token=glpat-", "abcdefghijklmnopqrstu"].join("") }], /第 1 处：结论（conclusion）里像是有/],
      [[{ ...first, topic: "" }], /第 1 处：缺少 topic/],
      [[{ ...first, memory_fix: "长".repeat(501) }], /第 1 处：memory_fix 单条记忆最多 500 字/],
    ];
    for (const [conflicts, error] of cases) {
      await assert.rejects(s.tool().run({ conflicts }, { signal }), error);
    }
    s.backend.entries[0].status = "archived";
    await assert.rejects(s.tool().run({ conflicts: [first] }, { signal }), /第 1 处：经验 K1 已经归档了/);
    assert.equal(s.sent.length, 0, "列的不对时不发卡片");
  } finally {
    await s.cleanup();
  }
});

test("冲突卡片：群里谁都能改每处的选择；点同步时卡片上的选择刚变过就不执行", async () => {
  const s = await setup();
  try {
    await s.tool().run({ conflicts: s.both }, { signal });
    const before = s.card();
    assert.equal(await s.pick(1, "skip"), true);
    assert.deepEqual(
      s.selects(s.card()).map((one) => one.initial_option),
      ["knowledge", "skip"],
    );
    // 选项不是这三个的、行号不对的不算
    await s.pick(0, "everything");
    await s.desk.handleCardAction(s.event({ ...s.selects(s.card())[0].behaviors[0].value, row: "7" }, "ou_2", "李四", { tag: "select_static", option: "skip" }));
    assert.deepEqual(
      s.selects(s.card()).map((one) => one.initial_option),
      ["knowledge", "skip"],
    );
    // 点的是改选择之前的卡片上的「按选择同步」
    await s.desk.handleCardAction(s.event(s.buttonValue(before, "apply"), "ou_admin", "ML"));
    await s.desk.idle();
    assert.match(text(s.card()), /ML点的时候卡片上的选择刚被改过，这次没有同步/);
    assert.equal((await s.store.list("oc_1"))[0].content, "发版固定在每周三");
    assert.equal(s.backend.entries.length, 2);
  } finally {
    await s.cleanup();
  }
});

test("冲突卡片：只改群记忆时群里谁都能点同步；以经验库为准的群记忆改成卡片上的内容，先不动的不改", async () => {
  const s = await setup();
  try {
    s.setClock("2026-10-14T08:00:00.000Z");
    await s.tool().run({ conflicts: s.both }, { signal });
    await s.pick(1, "skip");
    await s.apply("ou_2", "李四");
    const memories = await s.store.list("oc_1");
    assert.equal(memories[0].content, "发版固定在每周四下午");
    assert.equal(memories[0].author, "李四");
    assert.equal(memories[0].updatedAt, "2026-10-14T08:00:00.000Z");
    assert.equal(memories[1].content, "收不到验证码先让用户重启手机", "先不动的不改");
    assert.equal(s.backend.entries.length, 2, "经验库没动");
    const card = s.card();
    assert.equal(card.header.title.content, "群记忆和经验库已同步");
    assert.equal(s.selects(card).length, 0);
    assert.doesNotMatch(text(card), /"tag":"button"/);
    assert.match(text(card), /以经验库为准，群记忆 #1 已改成：发版固定在每周四下午/);
    assert.match(text(card), /\*\*结果\*\*：先不动/);
    const reply = s.sent.at(-1)!;
    assert.deepEqual(reply.opts, { replyTo: "om_card_1", replyInThread: true });
    assert.match((reply.input as { markdown: string }).markdown, /第 1 处（发版日期：群记忆说周三，经验库说周四）：以经验库为准，群记忆 #1 已改成/);
    assert.match((reply.input as { markdown: string }).markdown, /李四点了「按选择同步」/);
    // 处理完了再点：卡片失效
    await s.desk.handleCardAction(s.event(s.buttonValue((s.sent[0].input as { card: any }).card, "apply"), "ou_2", "李四"));
    assert.equal(s.updates.at(-1)!.card.header.title.content, "已失效");
  } finally {
    await s.cleanup();
  }
});

test("冲突卡片：有选以群记忆为准的（要改经验库）只有写权限名单里的人能点同步", async () => {
  const s = await setup();
  try {
    await s.tool().run({ conflicts: s.both }, { signal });
    await s.apply("ou_2", "李四");
    assert.match(text(s.card()), /李四点了同步：有 1 处选了「以群记忆为准」，要改经验库（所有群共用），只有写权限名单里的人能点/);
    assert.equal((await s.store.list("oc_1"))[0].content, "发版固定在每周三", "一处都没改");
    assert.equal(s.backend.entries.length, 2);
    // 都选先不动：没有要改的
    await s.pick(0, "skip");
    await s.pick(1, "skip");
    await s.apply();
    assert.match(text(s.card()), /ML点了同步：每处都选了「先不动」，没有要改的/);
  } finally {
    await s.cleanup();
  }
});

test("冲突卡片：写权限名单里的人点同步，以群记忆为准的经验换成新的一条、旧的归档；以经验库为准的群记忆删掉", async () => {
  const s = await setup();
  try {
    await s.tool().run({ conflicts: s.both }, { signal });
    // 第 1 处改成以群记忆为准，第 2 处改成以经验库为准（memory_fix 为空：删掉群记忆 #2）
    await s.pick(0, "memory");
    await s.pick(1, "knowledge");
    await s.apply();
    const [k1, k2, k3, k4] = s.backend.entries;
    assert.equal(k1.status, "archived", "旧的 K1 归档");
    assert.equal(k2.status, "active", "第 2 处以经验库为准，K2 不动");
    assert.equal(k3.id, "K3");
    assert.equal(k3.conclusion, "发版固定在每周三");
    assert.equal(k3.handling, "周四上午封板", "没让改的照旧");
    assert.equal(k3.title, "发版时间");
    assert.equal(k3.replaces, "K1");
    assert.equal(k3.confirmedBy, "ML");
    assert.equal(k3.proposedBy, "张三");
    assert.equal(k4, undefined);
    const memories = await s.store.list("oc_1");
    assert.deepEqual(
      memories.map((m) => m.id),
      [1],
      "群记忆 #2 删掉了，#1 以群记忆为准不动",
    );
    assert.equal(memories[0].content, "发版固定在每周三");
    const card = s.card();
    assert.match(text(card), /已存进团队经验库：经验 K3「发版时间」，确认人 ML/);
    assert.match(text(card), /旧的经验 K1「发版时间」已归档/);
    assert.match(text(card), /以经验库为准，已删掉群记忆 #2/);
    assert.match(text(card), /ML点了「按选择同步」。经验库表格：https:\/\/example\.feishu\.cn\/base\/app1\?table=tbl1/);
    assert.equal(text(card).match(/经验库表格/g)?.length, 1, "表格链接只列一次");
  } finally {
    await s.cleanup();
  }
});

test("冲突卡片：卡片发出后群记忆、经验改过的不动它们", async () => {
  const s = await setup();
  try {
    await s.tool().run({ conflicts: s.both }, { signal });
    await s.pick(1, "knowledge");
    await s.store.update("oc_1", 1, { content: "发版固定在每周五" });
    s.backend.entries[1].conclusion = "先查短信通道的回执";
    await s.pick(0, "knowledge");
    await s.pick(1, "memory");
    await s.apply();
    const memories = await s.store.list("oc_1");
    assert.equal(memories[0].content, "发版固定在每周五");
    assert.equal(s.backend.entries.length, 2, "K2 改过，没取代它");
    assert.equal(s.backend.entries[1].status, "active");
    assert.match(text(s.card()), /群记忆 #1 在卡片发出后改过或者删了，没动它/);
    assert.match(text(s.card()), /经验 K2 在卡片发出后在表格里改过/);
  } finally {
    await s.cleanup();
  }
});

test("冲突卡片：存新经验没成功时另发一张确认卡片，写权限名单里的人在那张上再点保存", async () => {
  const s = await setup();
  try {
    await s.tool().run({ conflicts: [s.both[0]] }, { signal });
    await s.pick(0, "memory");
    s.backend.failAdd = new Error("飞书接口限流");
    await s.apply();
    assert.match(text(s.card()), /经验 K1 没改成：飞书接口限流。话题里另发了一张确认卡片，可以在那张上再点「保存」/);
    const retry = s.sent.find((one) => (one.input as { card?: any }).card?.header?.title?.content === "存进经验库？")!;
    assert.ok(retry, "另发了一张确认卡片");
    assert.deepEqual(retry.opts, { replyTo: "om_card_1", replyInThread: true });
    assert.match(text((retry.input as { card: any }).card), /冲突卡片上点的同步没存成：飞书接口限流/);
    s.backend.failAdd = undefined;
    const save = (retry.input as { card: any }).card.body.elements.find((e: any) => e.tag === "button" && e.behaviors[0].value.op === "save").behaviors[0].value;
    const messageId = `om_card_${s.sent.indexOf(retry) + 1}`;
    // 不在写权限名单里的人点了不算
    await s.desk.handleCardAction(s.event(save, "ou_2", "李四", {}, messageId));
    await s.desk.idle();
    assert.equal(s.backend.entries.length, 2);
    await s.desk.handleCardAction(s.event(save, "ou_admin", "ML", {}, messageId));
    await s.desk.idle();
    assert.equal(s.backend.entries.length, 3);
    assert.equal(s.backend.entries[2].conclusion, "发版固定在每周三");
    assert.equal(s.backend.entries[0].status, "archived");
  } finally {
    await s.cleanup();
  }
});

test("冲突卡片：发起人或写权限名单里的人能取消；同一个话题再发一张旧的作废；过期、别的群、重启后的卡片不处理", async () => {
  const s = await setup();
  try {
    await s.tool().run({ conflicts: s.both }, { signal });
    const first = s.buttonValue(s.card(), "cancel");
    await s.desk.handleCardAction(s.event(first, "ou_2", "李四"));
    assert.match(text(s.card()), /李四点了取消：只有发起人或写权限名单里的人能取消/);
    // 别的群点的不处理
    const before = s.updates.length;
    await s.desk.handleCardAction({ ...s.event(first, "ou_1", "张三"), chatId: "oc_other" });
    assert.equal(s.updates.length, before);
    // 再发一张：旧的作废
    await s.tool().run({ conflicts: [s.both[0]] }, { signal });
    assert.equal(s.updates.findLast((one) => one.messageId === "om_card_1")!.card.header.title.content, "已换成新的卡片");
    const second = (s.sent[1].input as { card: any }).card;
    await s.desk.handleCardAction(s.event(s.buttonValue(second, "cancel"), "ou_1", "张三", {}, "om_card_2"));
    assert.equal(s.updates.at(-1)!.card.header.title.content, "已取消");
    assert.match(text(s.updates.at(-1)!.card), /张三取消了，群记忆和经验库都没改/);
    // 超过 24 小时
    await s.tool().run({ conflicts: [s.both[0]] }, { signal });
    const third = (s.sent[2].input as { card: any }).card;
    s.advance(CONFLICT_TTL_MS + 1);
    await s.desk.handleCardAction(s.event(s.buttonValue(third, "apply"), "ou_admin", "ML", {}, "om_card_3"));
    assert.match(text(s.updates.at(-1)!.card), /这张卡片超过 24 小时，已经失效/);
    assert.equal((await s.store.list("oc_1"))[0].content, "发版固定在每周三");
    // 重启后（内存里没有这张卡片）
    await s.desk.handleCardAction(s.event({ action: CONFLICT_ACTION, card: "gone", op: "apply", v: "x" }, "ou_admin", "ML", {}, "om_old"));
    assert.equal(s.updates.at(-1)!.messageId, "om_old");
    assert.match(text(s.updates.at(-1)!.card), /这张卡片已经失效/);
  } finally {
    await s.cleanup();
  }
});

test("冲突卡片：分不出哪边更新时默认先不动", async () => {
  const s = await setup();
  try {
    s.backend.entries[0].createdAt = (await s.store.list("oc_1"))[0].createdAt;
    await s.tool().run({ conflicts: [s.both[0]] }, { signal });
    assert.equal(s.selects(s.card())[0].initial_option, "skip");
    assert.match(text(s.card()), /分不出哪边更新，默认先不动/);
  } finally {
    await s.cleanup();
  }
});
