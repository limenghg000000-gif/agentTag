import assert from "node:assert/strict";
import { test } from "node:test";
import type { CardActionEvent, SendInput, SendOptions } from "@larksuiteoapi/node-sdk";
import {
  type Embedder,
  formatKnowledge,
  type KnowledgeBackend,
  KnowledgeBase,
  type KnowledgeEntry,
  KnowledgeError,
  normalizeDraft,
  renderHitsForPrompt,
} from "../src/knowledge.js";
import { AiopsLessons, type LessonsMcp, renderAiopsHitsForPrompt } from "../src/knowledge-aiops.js";
import { raceAbort } from "../src/abort.js";
import { readFile } from "node:fs/promises";
import { buildSystemPrompt } from "../src/prompt.js";
import { KNOWLEDGE_ACTION, KnowledgeDesk, PROPOSAL_TTL_MS } from "../src/tools/knowledge.js";

const quiet = { info() {}, warn() {}, error() {} };
const signal = new AbortController().signal;

class MemoryBackend implements KnowledgeBackend {
  entries: KnowledgeEntry[] = [];
  lists = 0;
  failAdd?: Error;
  /** 前几次 update 失败 */
  failUpdates = 0;
  /** 前几次 update 改成功了，但结果没传回来 */
  lostUpdates = 0;

  async location() {
    return "https://example.feishu.cn/base/app1?table=tbl1";
  }

  async list() {
    this.lists++;
    return structuredClone(this.entries);
  }

  async add(entry: KnowledgeEntry) {
    if (this.failAdd) {
      throw this.failAdd;
    }
    this.entries.push(structuredClone(entry));
  }

  async update(id: string, changes: Partial<KnowledgeEntry>) {
    if (this.failUpdates > 0) {
      this.failUpdates--;
      throw new KnowledgeError("飞书接口限流");
    }
    Object.assign(this.entries.find((entry) => entry.id === id)!, changes);
    if (this.lostUpdates > 0) {
      this.lostUpdates--;
      throw new KnowledgeError("socket hang up");
    }
  }
}

const code8 = {
  category: "incident",
  title: "gateway-api 报 code=8：user-rpc 单 Pod 被打满触发降载",
  scope: "gateway-api, user-rpc",
  question: "gateway-api 日志里大量 code=8 ResourceExhausted，接口返回 Success 但 data 为空",
  conclusion: "user-rpc 用 ClusterIP 走 gRPC 长连接，流量固定打到一个 Pod，CPU limit 350m 被打满后 go-zero 降载",
  handling: "未修复。建议改 headless Service 或 k8s:// 服务发现",
  keywords: "code=8，ResourceExhausted、user-rpc",
  error_codes: "8, ResourceExhausted",
};

const dau = {
  category: "metric",
  title: "日活的口径",
  question: "日活怎么统计",
  conclusion: "当天打开过 App 的去重用户数，排除内部测试账号",
  keywords: "日活,DAU",
};

test("起草的经验：去掉空白、检查必填和长度，关键词和错误码统一用逗号分隔", () => {
  const draft = normalizeDraft({ ...code8, title: `  ${code8.title}\n ` });
  assert.equal(draft.title, code8.title);
  assert.equal(draft.keywords, "code=8,ResourceExhausted,user-rpc");
  assert.equal(draft.errorCodes, "8,ResourceExhausted");
  assert.equal(draft.basis, undefined);

  assert.throws(() => normalizeDraft({ ...code8, category: "faq" }), /category 只能是/);
  assert.throws(() => normalizeDraft({ ...code8, conclusion: "  " }), /结论（conclusion）不能为空/);
  assert.throws(() => normalizeDraft({ ...code8, title: "长".repeat(81) }), /标题（title）最多 80 字/);
  assert.throws(() => normalizeDraft({ ...code8, scope: 42 }), /适用范围（scope）要填文字/);
});

test("草稿里有密钥、密码时不让存，错误信息里不复述密钥；只是提到令牌过期的照常", () => {
  for (const secret of [
    "GITLAB_TOKEN=glpat-abcdefghijklmnopqrstu",
    "用 sk-abcdefghijklmnopqrstuvwxyz123 调的接口",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789",
    "OPENAI_KEY 是 sk-proj-abcdefghij0123456789_ABCDEFGHIJ-klmnop",
    "sk-ant-api03-abcdefghijklmnop0123456789",
    "sk-svcacct-AbCdEfGhIj0123456789",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "AccessKeySecret: abcdefghijklmnopqrstuvwxyzABCD",
    "password=correcthorsebatterystaple",
    "mysql://agent:p4ssw0rd@10.0.0.5:3306/aiops",
    "数据库密码：Abc12345678",
    "-----BEGIN RSA PRIVATE KEY-----",
    // 拼出来的，免得源码里出现像真密钥的字符串
    ["xox", "b-1234567890-0987654321-AbCdEfGhIjKlMnOp"].join(""),
    ["xox", "e.xox", "p-1-AbCdEfGhIjKlMnOpQr"].join(""),
    ["xapp", "-1-A0123456789-0123456789-abcdef"].join(""),
    ["https://open.feishu.cn/open-apis/bot/v2/hook/", "3fa85f64-5717-4562-b3fc-2c963f66afa6"].join(""),
    ["https://hooks.slack.com/services/", "T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"].join(""),
    ["AIza", "SyA-abcdefghijklmnopqrstuvwxyz01234"].join(""),
    ["sk", "_live_", "abcdefghijklmnop0123"].join(""),
    ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "abcdefghijklmnopqrstuv"].join("."),
    // token、secret 后面写的值没有数字也算
    "MCP_AIOPS_TOKEN=correcthorsebatterystaple",
    "secret: correct-horse-battery-staple",
    'aiops 配置是 {"token": "CorrectHorseBatteryStaple"}',
    "https://aiops.example.com/mcp?token=correcthorsebattery&ns=prod",
    "FEISHU_APP_SECRET=CorrectHorseBattery。",
    // API Key：写明了是它的，值里有没有数字都算
    "MODEL_API_KEY=correcthorsebatterystaple",
    'const client = new OpenAI({ apiKey: "CorrectHorseBatteryStaple" })',
    "curl -H 'x-api-key: correct-horse-battery-staple'",
    "api_key=abcdef0123456789",
    // 夹着 token、secret 这类词的照样算，只有整个值都是报错、占位用词才不算
    "MCP_AIOPS_TOKEN=prod-secret-abcdefghijkl",
    "token=my-token-value-abcdef",
  ]) {
    assert.throws(
      () => normalizeDraft({ ...code8, basis: secret }),
      (err: Error) => err instanceof KnowledgeError && /不能存密钥和密码/.test(err.message) && !err.message.includes(secret),
      secret,
    );
  }
  assert.ok(normalizeDraft({ ...code8, basis: "报错 token expired，令牌过期后重新登录；密码：***" }));
  assert.ok(normalizeDraft({ ...code8, basis: "密码：请找管理员重置；token=expired_session" }));
  assert.ok(normalizeDraft({ ...code8, basis: "用 sk-learn-preprocessing-pipeline 处理的数据" }));
  assert.ok(normalizeDraft({ ...code8, basis: "这次调用 total_tokens: 123456789" }));
  assert.ok(normalizeDraft({ ...code8, basis: "群机器人的 Webhook 地址在飞书群设置里，xoxo 不是令牌" }));
  for (const prose of [
    "日志里是 token=invalid_signature，换新令牌后好了",
    "MCP_AIOPS_TOKEN=${MCP_AIOPS_TOKEN}，从 .env 读",
    "token=<your-token>、token=your_token_here、access_token=xxxxxxxxxxxx 都是占位",
    "secret=FEISHU_APP_SECRET，在服务器 .env 里",
    "MODEL_API_KEY=${MODEL_API_KEY}，api_key: your_api_key_here",
    "代码里 token := cfg.Token，token = getToken()，secret: config.secret",
    "token: expired. 重新登录就好",
  ]) {
    assert.ok(normalizeDraft({ ...code8, basis: prose }), prose);
  }
});

function fakeEmbedder(topics: string[]) {
  const calls: string[][] = [];
  const embedder: Embedder & { fail?: boolean } = {
    model: "fake-embedding",
    async embed(texts) {
      calls.push([...texts]);
      if (embedder.fail) {
        throw new Error("embedding 服务挂了");
      }
      return texts.map((text) => [...topics.map((topic) => (text.includes(topic) ? 1 : 0)), 0.05]);
    },
  };
  return { embedder, calls };
}

test("经验库：编号按最大编号加一，记下发起人、确认人和来源；归档后检索不到，不能重复归档", async () => {
  const backend = new MemoryBackend();
  const base = new KnowledgeBase(backend, { logger: quiet, now: () => new Date("2026-10-09T10:00:00Z") });

  const first = await base.save(normalizeDraft(code8), { proposedBy: "张三", confirmedBy: "ML", source: "飞书群 oc_1" });
  const second = await base.save(normalizeDraft(dau));
  assert.equal(first.id, "K1");
  assert.equal(second.id, "K2");
  assert.equal(backend.entries[0].confirmedBy, "ML");
  assert.equal(backend.entries[0].createdAt, "2026-10-09T10:00:00.000Z");
  assert.equal((await base.get("#k1"))?.title, code8.title);

  await base.archive("K1", { confirmedBy: "ML" });
  assert.equal(backend.entries[0].status, "archived");
  assert.deepEqual(await base.search("code=8 ResourceExhausted"), []);
  assert.equal((await base.search("code=8 ResourceExhausted", { includeArchived: true }))[0]?.entry.id, "K1");
  backend.failUpdates = 1;
  assert.equal((await base.archive("K1")).status, "archived", "已经归档了的再归档一次不报错，也不改表格");
  backend.failUpdates = 0;
  await assert.rejects(base.archive("K9"), /经验库里没有 K9/);

  // 有人在表格里删了中间的行，编号还是往后排
  backend.entries.push({ ...backend.entries[1], id: "K7" });
  assert.equal((await base.save(normalizeDraft(dau))).id, "K8");
  assert.match(formatKnowledge(first), /^经验 K1 \[排查经验\]：gateway-api 报 code=8/);
  assert.match(formatKnowledge(first), /（确认人 ML，2026\/10\/9）$/);
});

test("没有向量模型时按关键词检索：关键词、错误码命中加分，中文按两字片段对上说法不同的提问", async () => {
  const backend = new MemoryBackend();
  const base = new KnowledgeBase(backend, { logger: quiet });
  await base.save(normalizeDraft(code8));
  await base.save(normalizeDraft(dau));
  await base.save(normalizeDraft({ category: "answer", title: "收不到验证码", question: "用户说收不到验证码", conclusion: "先查短信通道" }));

  assert.equal((await base.search("网关报错 ResourceExhausted，code=8 是怎么回事"))[0]?.entry.id, "K1");
  assert.equal((await base.search("DAU 怎么算的"))[0]?.entry.id, "K2");
  assert.equal((await base.search("验证码收不到怎么办"))[0]?.entry.id, "K3");
  assert.deepEqual(await base.search("今天中午吃什么"), []);
  assert.deepEqual(await base.search("   "), []);
  assert.equal((await base.search("code=8", { category: "metric" })).length, 0);
});

test("问题写得很长时，只在结论里出现的说法也能检索到", async () => {
  const backend = new MemoryBackend();
  const base = new KnowledgeBase(backend, { logger: quiet });
  await base.save(normalizeDraft({ ...dau, keywords: "", question: "讨论记录：".concat("大家各自说了统计的口径。".repeat(160)), conclusion: "以埋点表 app_open 去重为准" }));
  const hits = await base.search("app_open 去重");
  assert.equal(hits[0]?.entry.id, "K1");
  // 写进提示词时结论在前，每个字段截短，问题再长结论也在
  const rendered = renderHitsForPrompt(hits);
  assert.match(rendered, /^经验 K1 \[数据口径\]：日活的口径\n- 结论：以埋点表 app_open 去重为准\n- 问题或场景：讨论记录：/);
  assert.ok(rendered.length <= 1300, String(rendered.length));
});

test("有向量模型时按意思检索：向量按内容缓存，列表一分钟内不重读；向量服务出错时退回关键词", async () => {
  const backend = new MemoryBackend();
  const { embedder, calls } = fakeEmbedder(["降载", "日活"]);
  let now = new Date("2026-10-09T10:00:00Z");
  const base = new KnowledgeBase(backend, { embedder, logger: quiet, now: () => now });
  await base.save(normalizeDraft(code8));
  await base.save(normalizeDraft(dau));

  const [hit] = await base.search("user-rpc 降载了吗");
  assert.equal(hit.entry.id, "K1");
  assert.ok(hit.semantic! > 0.9);
  assert.equal(calls.length, 2, "第一次：两条经验一批，加上提问");
  await base.search("日活是多少");
  assert.equal(calls.length, 3, "经验的向量缓存住了，只算提问");
  const lists = backend.lists;
  await base.search("降载");
  assert.equal(backend.lists, lists, "一分钟内不重读表格");

  embedder.fail = true;
  assert.equal((await base.search("code=8 ResourceExhausted"))[0]?.entry.id, "K1");
  const failed = calls.length;
  now = new Date(now.getTime() + 5 * 60_000);
  await base.search("code=8");
  assert.equal(calls.length, failed, "出错后 10 分钟内不再调向量模型");
});

test("向量没在期限内算完：这次只按关键词，下次照常调向量模型；用户停止任务时整个检索中止", async () => {
  const backend = new MemoryBackend();
  const { embedder, calls } = fakeEmbedder(["降载"]);
  const base = new KnowledgeBase(backend, { embedder, logger: quiet });
  await base.save(normalizeDraft(code8));
  const embed = embedder.embed;
  // 向量服务卡住，也不认中止信号
  embedder.embed = () => new Promise(() => {});
  const deadline = new AbortController();
  const searching = base.search("code=8 ResourceExhausted", { semanticDeadline: deadline.signal });
  deadline.abort(new DOMException("超时", "TimeoutError"));
  assert.equal((await searching)[0]?.entry.id, "K1", "按关键词照样查到");

  embedder.embed = embed;
  assert.equal((await base.search("user-rpc 降载了吗"))[0]?.semantic !== undefined, true, "期限到了不算向量服务出错，下次照常按意思检索");
  assert.ok(calls.length > 0);

  embedder.embed = () => new Promise(() => {});
  const stop = new AbortController();
  const cancelled = base.search("今天降载了吗", { signal: stop.signal });
  stop.abort();
  await assert.rejects(cancelled, (err: Error) => err.name === "AbortError");
});

test("起草时找很像的已有经验", async () => {
  const backend = new MemoryBackend();
  const { embedder } = fakeEmbedder(["降载", "日活"]);
  const base = new KnowledgeBase(backend, { embedder, logger: quiet });
  await base.save(normalizeDraft(code8));
  assert.equal((await base.similar(normalizeDraft({ ...code8, title: "code=8 又出现了" })))?.entry.id, "K1");
  assert.equal(await base.similar(normalizeDraft(dau)), undefined);
});

function fakeMcp(handlers: Record<string, (args: Record<string, unknown>) => string>) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const mcp: LessonsMcp = {
    hasTool: (_server, tool) => tool in handlers,
    async callDirect(_server, tool, args) {
      calls.push({ tool, args });
      return handlers[tool](args);
    },
  };
  return { mcp, calls };
}

const task = { chatId: "oc_1", senderId: "ou_1", messageId: "om_1" };

test("aiops 经验库：检索只留够相近的；排查经验同步过去时字段对上，注明出自团队经验库；疑似重复时不存", async () => {
  const { mcp, calls } = fakeMcp({
    search_knowledge: () =>
      JSON.stringify({ hits: [{ id: 12, title: "user-rpc 降载", score: 9.1, root_cause: "单 Pod" }, { id: 13, title: "不太像", score: 3 }, { title: "没编号" }] }),
    get_knowledge: () => JSON.stringify({ knowledge: { id: 12, title: "user-rpc 降载", status: "archived" } }),
    save_lesson: (args) => (args.title === "重复的" ? JSON.stringify({ saved: false, duplicate_of: { id: 12, title: "user-rpc 降载", why: "错误码相同" } }) : JSON.stringify({ saved: true, id: 31 })),
    archive_lesson: () => JSON.stringify({ archived: true }),
  });
  const lessons = new AiopsLessons(mcp, "aiops", quiet);
  assert.ok(lessons.searchable && lessons.writable);

  assert.deepEqual(await lessons.search("code=8", task), [{ id: 12, title: "user-rpc 降载", score: 9.1, root_cause: "单 Pod" }]);
  assert.equal((await lessons.get(12, task)).status, "archived");

  const draft = normalizeDraft(code8);
  assert.deepEqual(await lessons.save(draft, { confirmedBy: "ML", teamId: "K1", caseId: 7 }, task), { saved: true, id: 31 });
  const saved = calls.find((call) => call.tool === "save_lesson")!.args;
  assert.equal(saved.root_cause, draft.conclusion);
  assert.equal(saved.symptom, draft.question);
  assert.equal(saved.service, draft.scope);
  assert.equal(saved.solution, draft.handling);
  assert.equal(saved.error_codes, "8,ResourceExhausted");
  assert.equal(saved.source, "case");
  assert.equal(saved.case_id, 7);
  assert.equal(saved.created_by, "feishu:ML");
  assert.equal(saved.diagnosis_path, "（来自飞书团队经验库 K1）");
  assert.equal(saved.force, undefined);

  assert.deepEqual(await lessons.save({ ...draft, title: "重复的" }, { confirmedBy: "ML", teamId: "K2" }, task), {
    saved: false,
    duplicate: { id: 12, title: "user-rpc 降载", why: "错误码相同" },
  });
  await lessons.save(draft, { confirmedBy: "ML", teamId: "K3", force: true }, task);
  assert.equal(calls.filter((call) => call.tool === "save_lesson").at(-1)!.args.force, true);
});

function deskSetup({
  aiops = true,
  approvers = new Set(["ou_admin"]),
  saveLesson = () => JSON.stringify({ saved: true, id: 31 }),
  searchLessons = () => JSON.stringify({ hits: [{ id: 31, title: "已同步的", score: 9 }, { id: 40, title: "Open WebUI 存的", score: 8 }] }),
}: {
  aiops?: boolean;
  approvers?: ReadonlySet<string>;
  saveLesson?: (args: Record<string, unknown>) => string;
  searchLessons?: (args: Record<string, unknown>) => string;
} = {}) {
  const control = { failSend: false };
  const backend = new MemoryBackend();
  const base = new KnowledgeBase(backend, { logger: quiet, readTimeoutMs: 200 });
  const sent: { to: string; input: SendInput; opts?: SendOptions }[] = [];
  const updates: { messageId: string; card: any }[] = [];
  const { mcp, calls } = fakeMcp({
    search_knowledge: searchLessons,
    get_knowledge: (args) => JSON.stringify({ id: args.id, title: "Open WebUI 存的", status: "active", root_cause: "旧结论" }),
    save_lesson: saveLesson,
    archive_lesson: () => JSON.stringify({ archived: true }),
  });
  let now = 1_000_000;
  const desk = new KnowledgeDesk({
    base,
    ...(aiops ? { aiops: new AiopsLessons(mcp, "aiops", quiet) } : {}),
    send: async (to, input, opts) => {
      if (control.failSend) {
        throw new Error("飞书发送失败");
      }
      sent.push({ to, input, opts });
      return { messageId: `om_card_${sent.length}` };
    },
    updateCard: async (messageId, card) => {
      updates.push({ messageId, card });
    },
    approvers,
    allowedChatIds: new Set(["oc_1"]),
    logger: quiet,
    now: () => now,
    retryDelayMs: 0,
  });
  const ctx = { chatId: "oc_1", threadKey: "om_root", senderId: "ou_1", askerName: "张三", messageId: "om_1" };
  const tool = (name: string) => desk.tools(ctx).find((t) => t.spec.name === name)!;
  const click = (card: any, op: string, openId = "ou_admin", name = "ML"): CardActionEvent => {
    const buttons = JSON.stringify(card).match(/"value":\{[^}]*\}/g)!.map((v) => JSON.parse(v.slice(8)));
    const value = buttons.find((v) => v.op === op);
    assert.ok(value, `卡片上没有 ${op} 按钮`);
    return { messageId: "om_card_1", chatId: "oc_1", operator: { openId, name }, action: { tag: "button", value } };
  };
  const lastCard = () => updates.at(-1)!.card;
  return { backend, base, desk, sent, updates, calls, tool, click, lastCard, control, advance: (ms: number) => (now += ms) };
}

const cardText = (card: any) => JSON.stringify(card);

test("起草：发确认卡片到话题里，卡片上是草稿全文和保存、取消按钮；告诉模型还没存", async () => {
  const { desk, sent, tool } = deskSetup();
  assert.deepEqual(
    desk.tools({ chatId: "oc_1", threadKey: "t", senderId: "ou_1", messageId: "om_1" }).map((t) => t.spec.name),
    ["knowledge_search", "knowledge_get", "knowledge_propose", "knowledge_propose_archive"],
  );

  const result = await tool("knowledge_propose").run(code8, { signal });
  assert.match(result, /还没有保存/);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].opts, { replyTo: "om_1", replyInThread: true });
  const card = (sent[0].input as { card: any }).card;
  assert.equal(card.header.title.content, "存进经验库？");
  assert.match(cardText(card), /\*\*类别\*\*：排查经验/);
  assert.match(cardText(card), /\*\*结论\*\*：user-rpc 用 ClusterIP/);
  assert.match(cardText(card), /排查经验会同时存一份到 aiops 经验库/);
  assert.match(cardText(card), /发起人：张三/);
  assert.match(cardText(card), new RegExp(`"action":"${KNOWLEDGE_ACTION}"`));

  await assert.rejects(tool("knowledge_propose").run({ ...code8, basis: "token=glpat-abcdefghijklmnopqrstu" }, { signal }), /不能存密钥和密码/);
  assert.equal(sent.length, 1, "有密钥的草稿不发卡片");
});

test("写权限名单里的人点保存：存进经验库，排查经验同步到 aiops 并记下编号，卡片变成已存，话题里发一句结果", async () => {
  const { backend, desk, sent, calls, tool, click, lastCard } = deskSetup();
  await tool("knowledge_propose").run({ ...code8, case_id: 7 }, { signal });
  const card = (sent[0].input as { card: any }).card;

  // 不在名单里的人点了不执行
  assert.equal(await desk.handleCardAction(click(card, "save", "ou_2", "李四")), true);
  await desk.idle();
  assert.equal(backend.entries.length, 0);
  assert.match(cardText(lastCard()), /李四点了确认：只有写权限名单里的人能确认，这次没有执行/);

  await desk.handleCardAction(click(card, "save"));
  await desk.idle();
  assert.equal(backend.entries.length, 1);
  const [entry] = backend.entries;
  assert.equal(entry.id, "K1");
  assert.equal(entry.proposedBy, "张三");
  assert.equal(entry.confirmedBy, "ML");
  assert.equal(entry.source, "飞书群 oc_1 的话题（消息 om_1）");
  assert.equal(entry.aiopsId, 31);
  assert.equal(calls.find((call) => call.tool === "save_lesson")!.args.case_id, 7);
  assert.equal(lastCard().header.title.content, "已存进经验库");
  assert.doesNotMatch(cardText(lastCard()), /"tag":"button"/);
  const reply = sent.at(-1)!;
  assert.deepEqual(reply.opts, { replyTo: "om_card_1", replyInThread: true });
  const text = (reply.input as { markdown: string }).markdown;
  assert.match(text, /已存进团队经验库：经验 K1「gateway-api 报 code=8/);
  assert.match(text, /已同步到 aiops 经验库（经验 #31）/);
  assert.match(text, /经验库表格：https:\/\/example\.feishu\.cn\/base\/app1\?table=tbl1/);

  // 再点一次：草稿已经处理完，卡片提示失效
  await desk.handleCardAction(click(card, "save"));
  await desk.idle();
  assert.equal(backend.entries.length, 1);
  assert.equal(lastCard().header.title.content, "已失效");
});

test("点了保存马上返回，后台执行；执行中再点不会存两遍", async () => {
  const { backend, desk, sent, click, tool, lastCard } = deskSetup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const add = backend.add.bind(backend);
  backend.add = async (entry) => {
    await gate;
    return add(entry);
  };
  await tool("knowledge_propose").run(dau, { signal });
  const card = (sent[0].input as { card: any }).card;
  assert.equal(await desk.handleCardAction(click(card, "save")), true);
  assert.equal(await desk.handleCardAction(click(card, "save", "ou_admin2")), true);
  assert.equal(backend.entries.length, 0);
  release();
  await desk.idle();
  assert.equal(backend.entries.length, 1);
  assert.equal(lastCard().header.title.content, "已存进经验库");
});

test("别的类别不同步到 aiops；没接 aiops 时排查经验也照常存", async () => {
  const one = deskSetup();
  await one.tool("knowledge_propose").run(dau, { signal });
  await one.desk.handleCardAction(one.click((one.sent[0].input as { card: any }).card, "save"));
  await one.desk.idle();
  assert.equal(one.backend.entries[0].category, "metric");
  assert.ok(!one.calls.some((call) => call.tool === "save_lesson"));

  const two = deskSetup({ aiops: false });
  await two.tool("knowledge_propose").run(code8, { signal });
  assert.doesNotMatch(cardText((two.sent[0].input as { card: any }).card), /aiops/);
  await two.desk.handleCardAction(two.click((two.sent[0].input as { card: any }).card, "save"));
  await two.desk.idle();
  assert.equal(two.backend.entries[0].aiopsId, undefined);
  assert.doesNotMatch((two.sent.at(-1)!.input as { markdown: string }).markdown, /aiops/);
});

test("保存失败时卡片回到待确认，写上原因，可以再点", async () => {
  const { backend, desk, sent, click, tool, lastCard } = deskSetup();
  await tool("knowledge_propose").run(dau, { signal });
  backend.failAdd = new KnowledgeError("机器人缺少飞书应用的多维表格权限（bitable:app）");
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.equal(lastCard().header.title.content, "存进经验库？");
  assert.match(cardText(lastCard()), /上次点确认没成功：机器人缺少飞书应用的多维表格权限/);

  backend.failAdd = undefined;
  await desk.handleCardAction(click(lastCard(), "save"));
  await desk.idle();
  assert.equal(backend.entries.length, 1);
});

test("保存的结果没传回来、再点一次：同一张卡片不会存两遍", async () => {
  const { backend, desk, sent, click, tool, lastCard } = deskSetup();
  await tool("knowledge_propose").run(dau, { signal });
  const add = backend.add.bind(backend);
  backend.add = async (entry) => {
    await add(entry);
    throw new KnowledgeError("飞书接口超时");
  };
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.match(cardText(lastCard()), /上次点确认没成功：飞书接口超时/);

  backend.add = add;
  await desk.handleCardAction(click(lastCard(), "save"));
  await desk.idle();
  assert.equal(backend.entries.length, 1);
  assert.ok(backend.entries[0].requestId);
  assert.equal(lastCard().header.title.content, "已存进经验库");
  assert.match((sent.at(-1)!.input as { markdown: string }).markdown, /已存进团队经验库：经验 K1「日活的口径」/);
});

test("改草稿时新卡片没发出去，旧卡片还能用", async () => {
  const { backend, desk, sent, updates, click, tool, control } = deskSetup();
  await tool("knowledge_propose").run(dau, { signal });
  control.failSend = true;
  await assert.rejects(tool("knowledge_propose").run({ ...dau, title: "日活的口径（改）" }, { signal }), /飞书发送失败/);
  control.failSend = false;
  assert.ok(!updates.some((u) => u.card.header.title.content === "已换成新的草稿"));
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.equal(backend.entries[0]?.title, "日活的口径");
});

test("任务停了就不发确认卡片：起草时查很像的经验、取要归档的经验时停止都不发", async () => {
  const { base, backend, sent, tool } = deskSetup();
  await base.save(normalizeDraft(dau));
  // 表格读不出来，卡住
  backend.list = () => new Promise(() => {});
  const stop = new AbortController();
  const proposing = tool("knowledge_propose").run(code8, { signal: stop.signal });
  const archiving = tool("knowledge_propose_archive").run({ id: "K1" }, { signal: stop.signal });
  stop.abort();
  await assert.rejects(proposing, (err: Error) => err.name === "AbortError");
  await assert.rejects(archiving, (err: Error) => err.name === "AbortError");
  assert.equal(sent.length, 0);
});

test("发起人可以取消，别人不行；同一个话题再起草时旧卡片作废；超过 24 小时点了提示失效", async () => {
  const { backend, desk, sent, updates, click, tool, lastCard, advance } = deskSetup();
  await tool("knowledge_propose").run(dau, { signal });
  const first = (sent[0].input as { card: any }).card;
  await desk.handleCardAction(click(first, "cancel", "ou_2", "李四"));
  await desk.idle();
  assert.match(cardText(lastCard()), /只有发起人或写权限名单里的人能取消/);
  await desk.handleCardAction(click(first, "cancel", "ou_1", "张三"));
  await desk.idle();
  assert.equal(lastCard().header.title.content, "已取消");

  await tool("knowledge_propose").run(dau, { signal });
  await tool("knowledge_propose").run({ ...dau, title: "日活的口径（改）" }, { signal });
  const superseded = updates.find((u) => u.messageId === "om_card_2" && u.card.header.title.content === "已换成新的草稿");
  assert.ok(superseded, "旧卡片换成「已换成新的草稿」");
  await desk.handleCardAction({ ...click((sent[1].input as { card: any }).card, "save"), messageId: "om_card_2" });
  await desk.idle();
  assert.equal(backend.entries.length, 0);

  advance(PROPOSAL_TTL_MS + 1);
  await desk.handleCardAction(click((sent[2].input as { card: any }).card, "save"));
  await desk.idle();
  assert.equal(backend.entries.length, 0);
  assert.equal(lastCard().header.title.content, "已失效");
});

test("起草时经验库里有很像的，卡片上提示；带 replaces 时保存后归档旧的，连同 aiops 里同步的那条", async () => {
  const { backend, base, desk, sent, calls, click, tool } = deskSetup();
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);

  await tool("knowledge_propose").run({ ...code8, title: "gateway-api 报 code=8（第二次）" }, { signal });
  assert.match(cardText((sent[0].input as { card: any }).card), /经验库里已有很像的经验 K1/);

  await tool("knowledge_propose").run({ ...code8, title: "gateway-api 报 code=8（已修复）", replaces: "K1" }, { signal });
  const card = (sent[1].input as { card: any }).card;
  assert.match(cardText(card), /保存后归档旧的经验 K1/);
  assert.doesNotMatch(cardText(card), /已有很像的经验/);
  await desk.handleCardAction({ ...click(card, "save"), messageId: "om_card_2" });
  await desk.idle();
  assert.equal(backend.entries.find((e) => e.id === "K1")!.status, "archived");
  assert.equal(backend.entries.find((e) => e.id === "K2")!.status, "active");
  assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 31 }]);
  assert.match((sent.at(-1)!.input as { markdown: string }).markdown, /旧的经验 K1「.*」已归档。\naiops 经验库里同步的经验 #31 也已归档。/);

  await assert.rejects(tool("knowledge_propose").run({ ...code8, replaces: "K1" }, { signal }), /经验 K1 已经归档了/);
});

test("取代旧的排查经验：aiops 说和旧的那条很像时照样存一条新的再归档旧的；新的没进 aiops 时旧的在 aiops 里那条先留着，再试一次进了 aiops 才归档", async () => {
  const replace = async (saveLesson: (args: Record<string, unknown>) => string) => {
    const setup = deskSetup({ saveLesson });
    await setup.base.save(normalizeDraft(code8));
    await setup.base.linkAiops("K1", 31);
    await setup.tool("knowledge_propose").run({ ...code8, title: "gateway-api 报 code=8（已修复）", replaces: "K1" }, { signal });
    await setup.desk.handleCardAction(setup.click((setup.sent[0].input as { card: any }).card, "save"));
    await setup.desk.idle();
    return setup;
  };
  const markdown = (setup: { sent: { input: SendInput }[] }) => (setup.sent.at(-1)!.input as { markdown: string }).markdown;

  const dup = await replace((args) =>
    args.force ? JSON.stringify({ saved: true, id: 32 }) : JSON.stringify({ saved: false, duplicate_of: { id: 31, title: "旧的", why: "错误码相同" } }),
  );
  assert.equal(dup.backend.entries.find((e) => e.id === "K2")!.aiopsId, 32);
  assert.deepEqual(dup.calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 31 }]);
  assert.match(markdown(dup), /已同步到 aiops 经验库（经验 #32）/);

  let up = false;
  const down = await replace(() => {
    if (!up) {
      throw new Error("aiops 现在连不上");
    }
    return JSON.stringify({ saved: true, id: 33 });
  });
  assert.equal(down.backend.entries.find((e) => e.id === "K1")!.status, "archived");
  assert.equal(down.calls.filter((call) => call.tool === "archive_lesson").length, 0);
  const partial = down.lastCard();
  assert.equal(partial.header.title.content, "已存进经验库，还有没做成的");
  assert.match(cardText(partial), /没能同步到 aiops 经验库：aiops 现在连不上/);
  assert.match(cardText(partial), /aiops 经验库里同步的旧经验 #31 先留着没归档/);
  assert.match(cardText(partial), /"content":"再试一次"/);
  assert.equal(down.sent.length, 1, "没做完时话题里不发结果");

  up = true;
  await down.desk.handleCardAction(down.click(partial, "save"));
  await down.desk.idle();
  assert.deepEqual(
    down.backend.entries.map((e) => [e.id, e.status, e.aiopsId]),
    [
      ["K1", "archived", 31],
      ["K2", "active", 33],
    ],
  );
  assert.deepEqual(down.calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 31 }]);
  assert.equal(down.lastCard().header.title.content, "已存进经验库");
  assert.match(markdown(down), /已同步到 aiops 经验库（经验 #33）[\s\S]*旧的经验 K1「.*」已归档。\naiops 经验库里同步的经验 #31 也已归档。/);
});

test("取代旧经验时归档旧的失败：卡片留着再试一次，新的不会存两遍，aiops 也不再存一条", async () => {
  const { backend, base, desk, sent, calls, click, tool, lastCard } = deskSetup({ saveLesson: () => JSON.stringify({ saved: true, id: 32 }) });
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);
  await tool("knowledge_propose").run({ ...code8, title: "gateway-api 报 code=8（已修复）", replaces: "K1" }, { signal });
  const update = backend.update.bind(backend);
  let limited = true;
  backend.update = async (id, changes) => {
    if (id === "K1" && limited) {
      throw new KnowledgeError("飞书接口限流");
    }
    return update(id, changes);
  };
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.deepEqual(
    backend.entries.map((e) => [e.id, e.status]),
    [
      ["K1", "active"],
      ["K2", "active"],
    ],
  );
  const partial = lastCard();
  assert.equal(partial.header.title.content, "已存进经验库，还有没做成的");
  assert.match(cardText(partial), /旧的经验 K1 没能归档：飞书接口限流/);
  assert.match(cardText(partial), /已存进团队经验库：经验 K2/);

  limited = false;
  await desk.handleCardAction(click(partial, "save"));
  await desk.idle();
  assert.deepEqual(
    backend.entries.map((e) => [e.id, e.status, e.aiopsId]),
    [
      ["K1", "archived", 31],
      ["K2", "active", 32],
    ],
  );
  assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 1);
  assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 31 }]);
  assert.equal(lastCard().header.title.content, "已存进经验库");
  assert.match((sent.at(-1)!.input as { markdown: string }).markdown, /旧的经验 K1「.*」已归档/);
});

test("同步到 aiops 时结果没传回来：再试一次先找到已经存进去的那条，不再存一条", async () => {
  const lessons: { id: number; title: string; score: number; diagnosis_path: string }[] = [
    { id: 50, title: "另一条团队经验同步的", score: 9, diagnosis_path: "（来自飞书团队经验库 K10）" },
  ];
  let lose = true;
  const { backend, desk, sent, calls, click, tool, lastCard } = deskSetup({
    saveLesson: (args) => {
      lessons.push({ id: 31, title: String(args.title), score: 9.8, diagnosis_path: String(args.diagnosis_path) });
      if (lose) {
        lose = false;
        throw new Error("socket hang up");
      }
      return JSON.stringify({ saved: true, id: 31 });
    },
    searchLessons: () => JSON.stringify({ hits: lessons }),
  });
  await tool("knowledge_propose").run(code8, { signal });
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  const partial = lastCard();
  assert.match(cardText(partial), /没能同步到 aiops 经验库：socket hang up/);
  assert.equal(backend.entries[0].aiopsId, undefined);

  await desk.handleCardAction(click(partial, "save"));
  await desk.idle();
  assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 1);
  assert.equal(backend.entries.length, 1);
  assert.equal(backend.entries[0].aiopsId, 31);
  assert.equal(lastCard().header.title.content, "已存进经验库");
  assert.match((sent.at(-1)!.input as { markdown: string }).markdown, /已同步到 aiops 经验库（经验 #31）/);
});

test("没做成的卡片：点「不用了」或者超过 24 小时就不再试，结果里写上没做成的", async () => {
  const fail = () => {
    throw new Error("aiops 现在连不上");
  };
  const quit = deskSetup({ saveLesson: fail });
  await quit.tool("knowledge_propose").run(code8, { signal });
  await quit.desk.handleCardAction(quit.click((quit.sent[0].input as { card: any }).card, "save"));
  await quit.desk.idle();
  const partial = quit.lastCard();
  await quit.desk.handleCardAction(quit.click(partial, "cancel", "ou_2", "李四"));
  assert.match(cardText(quit.lastCard()), /只有发起人或写权限名单里的人能取消/);
  await quit.desk.handleCardAction(quit.click(partial, "cancel", "ou_1", "张三"));
  const given = quit.lastCard();
  assert.equal(given.header.title.content, "已存进经验库");
  assert.match(cardText(given), /已存进团队经验库：经验 K1/);
  assert.match(cardText(given), /张三点了「不用了」，下面没做成的不再试了：\\n- 没能同步到 aiops 经验库：aiops 现在连不上/);
  assert.doesNotMatch(cardText(given), /"tag":"button"/);
  assert.equal(quit.backend.entries.length, 1);

  const late = deskSetup({ saveLesson: fail });
  await late.tool("knowledge_propose").run(code8, { signal });
  await late.desk.handleCardAction(late.click((late.sent[0].input as { card: any }).card, "save"));
  await late.desk.idle();
  late.advance(PROPOSAL_TTL_MS + 1);
  await late.desk.handleCardAction(late.click(late.lastCard(), "save"));
  await late.desk.idle();
  assert.equal(late.lastCard().header.title.content, "已存进经验库");
  assert.match(cardText(late.lastCard()), /卡片超过 24 小时，下面没做成的不再试了/);
  assert.equal(late.calls.filter((call) => call.tool === "save_lesson").length, 1);
});

test("两张卡片取代同一条经验：先点的存好并归档旧的，后点的不再存（同时点也一样）", async () => {
  for (const together of [false, true]) {
    const { backend, base, desk, sent, updates, click } = deskSetup();
    await base.save(normalizeDraft(code8));
    const other = { chatId: "oc_1", threadKey: "om_other", senderId: "ou_2", askerName: "李四", messageId: "om_2" };
    await desk.tools({ chatId: "oc_1", threadKey: "om_root", senderId: "ou_1", askerName: "张三", messageId: "om_1" }).find((t) => t.spec.name === "knowledge_propose")!
      .run({ ...code8, title: "gateway-api 报 code=8（张三改的）", replaces: "K1" }, { signal });
    await desk.tools(other).find((t) => t.spec.name === "knowledge_propose")!.run({ ...code8, title: "gateway-api 报 code=8（李四改的）", replaces: "K1" }, { signal });
    const [first, second] = sent.map((s) => (s.input as { card: any }).card);
    await desk.handleCardAction(click(first, "save"));
    if (!together) {
      await desk.idle();
    }
    await desk.handleCardAction({ ...click(second, "save"), messageId: "om_card_2" });
    await desk.idle();
    assert.deepEqual(
      backend.entries.map((e) => [e.id, e.status]),
      [
        ["K1", "archived"],
        ["K2", "active"],
      ],
      together ? "同时点" : "先后点",
    );
    assert.equal(backend.entries[1].title, "gateway-api 报 code=8（张三改的）");
    const voided = updates.filter((u) => u.messageId === "om_card_2").at(-1)!.card;
    assert.equal(voided.header.title.content, "已作废");
    assert.match(cardText(voided), /要取代的经验 K1 已经归档了（可能已经被别的卡片取代），这张卡片不能再保存/);
    assert.doesNotMatch(cardText(voided), /"保存"/);
  }
});

test("取代旧经验时归档旧的没做成：别的卡片不能再取代那条旧的，免得两条新的同时有效", async () => {
  const { backend, base, desk, sent, updates, click } = deskSetup({ aiops: false });
  await base.save(normalizeDraft(dau));
  const other = { chatId: "oc_1", threadKey: "om_other", senderId: "ou_2", askerName: "李四", messageId: "om_2" };
  await desk.tools({ chatId: "oc_1", threadKey: "om_root", senderId: "ou_1", askerName: "张三", messageId: "om_1" }).find((t) => t.spec.name === "knowledge_propose")!
    .run({ ...dau, title: "日活的口径（张三改的）", replaces: "K1" }, { signal });
  await desk.tools(other).find((t) => t.spec.name === "knowledge_propose")!.run({ ...dau, title: "日活的口径（李四改的）", replaces: "K1" }, { signal });
  const [first, second] = sent.map((s) => (s.input as { card: any }).card);
  const update = backend.update.bind(backend);
  let limited = true;
  backend.update = async (id, changes) => {
    if (id === "K1" && limited) {
      throw new KnowledgeError("飞书接口限流");
    }
    return update(id, changes);
  };
  await desk.handleCardAction(click(first, "save"));
  await desk.idle();
  const partial = updates.filter((u) => u.messageId === "om_card_1").at(-1)!.card;
  assert.equal(partial.header.title.content, "已存进经验库，还有没做成的");
  assert.equal(backend.entries[1].replaces, "K1", "表格里记下新的这条取代的是哪条");

  limited = false;
  await desk.handleCardAction({ ...click(second, "save"), messageId: "om_card_2" });
  await desk.idle();
  const voided = updates.filter((u) => u.messageId === "om_card_2").at(-1)!.card;
  assert.equal(voided.header.title.content, "已作废");
  assert.match(cardText(voided), /经验 K1 已经有取代它的新经验 K2「日活的口径（张三改的）」，只是旧的还没归档，这张卡片不能再保存/);
  assert.deepEqual(
    backend.entries.map((e) => [e.id, e.status]),
    [
      ["K1", "active"],
      ["K2", "active"],
    ],
  );

  await desk.handleCardAction(click(partial, "save"));
  await desk.idle();
  assert.deepEqual(
    backend.entries.map((e) => [e.id, e.status]),
    [
      ["K1", "archived"],
      ["K2", "active"],
    ],
  );
  // 取代它的那条归档了，旧的又能被取代
  await base.archive("K2");
  await update("K1", { status: "active" });
  const again = await base.save(normalizeDraft({ ...dau, title: "日活的口径（王五改的）" }), { replaces: "k1" });
  assert.deepEqual([again.id, again.replaces], ["K3", "K1"]);
});

test("归档、取代时用表格里现在的 aiops 编号：卡片发出后有人在表格里改了编号，归档改过的那条", async () => {
  const { backend, base, desk, sent, calls, click, tool } = deskSetup();
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);
  await tool("knowledge_propose_archive").run({ id: "K1" }, { signal });
  backend.entries[0].aiopsId = 35;
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "archive"));
  await desk.idle();
  assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 35 }]);

  const replace = deskSetup();
  await replace.base.save(normalizeDraft(code8));
  await replace.base.linkAiops("K1", 31);
  await replace.tool("knowledge_propose").run({ ...code8, title: "gateway-api 报 code=8（已修复）", replaces: "K1" }, { signal });
  replace.backend.entries[0].aiopsId = 35;
  await replace.desk.handleCardAction(replace.click((replace.sent[0].input as { card: any }).card, "save"));
  await replace.desk.idle();
  assert.deepEqual(replace.calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 35 }]);
});

test("同步到 aiops 后记编号失败会再试；几次都不行时卡片可以再试一次，aiops 里不再存一条", async () => {
  const once = deskSetup();
  await once.tool("knowledge_propose").run(code8, { signal });
  once.backend.failUpdates = 1;
  await once.desk.handleCardAction(once.click((once.sent[0].input as { card: any }).card, "save"));
  await once.desk.idle();
  assert.equal(once.backend.entries[0].aiopsId, 31);
  assert.doesNotMatch((once.sent.at(-1)!.input as { markdown: string }).markdown, /手动|没能在经验库表格里/);

  const never = deskSetup();
  await never.tool("knowledge_propose").run(code8, { signal });
  never.backend.failUpdates = 99;
  await never.desk.handleCardAction(never.click((never.sent[0].input as { card: any }).card, "save"));
  await never.desk.idle();
  assert.equal(never.backend.entries[0].aiopsId, undefined);
  const partial = never.lastCard();
  assert.equal(partial.header.title.content, "已存进经验库，还有没做成的");
  assert.match(cardText(partial), /没能在经验库表格里记下 aiops 编号 #31（飞书接口限流）/);

  never.backend.failUpdates = 0;
  await never.desk.handleCardAction(never.click(partial, "save"));
  await never.desk.idle();
  assert.equal(never.backend.entries[0].aiopsId, 31);
  assert.equal(never.calls.filter((call) => call.tool === "save_lesson").length, 1);
  assert.equal(never.lastCard().header.title.content, "已存进经验库");
});

test("aiops 归档：archive_lesson 报错时看一下，已经归档了就算成功，还有效的照样报错", async () => {
  let status = "archived";
  const { mcp } = fakeMcp({
    archive_lesson: () => {
      throw new Error("经验不存在或已归档");
    },
    get_knowledge: (args) => JSON.stringify({ id: args.id, title: "user-rpc 降载", status }),
  });
  const lessons = new AiopsLessons(mcp, "aiops", quiet);
  await lessons.archive(12, "ML", task);
  status = "active";
  await assert.rejects(lessons.archive(12, "ML", task), /经验不存在或已归档/);
});

test("aiops 经验写进提示词：根因和处理办法在前面，每一项限长，现象写得很长也看得到根因", () => {
  const text = renderAiopsHitsForPrompt([
    { id: 12, title: "user-rpc 降载", score: 9, symptom: "接口返回空".repeat(300), root_cause: "单 Pod 被打满", solution: "改 headless Service", diagnosis_path: "看 Pod CPU" },
  ]);
  assert.match(text, /^aiops 经验 #12：user-rpc 降载\n- 根因：单 Pod 被打满\n- 处理办法：改 headless Service\n- 现象：/);
  assert.match(text, /- 现象：(接口返回空)+…（这一项后面省略，要看全文用 aiops_get_knowledge）\n- 排查过程：看 Pod CPU/);
});

test("模型查经验库、看经验时任务停了不等表格", async () => {
  const { base, backend, tool } = deskSetup();
  await base.save(normalizeDraft(dau));
  backend.list = () => new Promise(() => {});
  const stop = new AbortController();
  const searching = tool("knowledge_search").run({ query: "日活" }, { signal: stop.signal });
  const getting = tool("knowledge_get").run({ id: "K1" }, { signal: stop.signal });
  stop.abort();
  await assert.rejects(searching, (err: Error) => err.name === "AbortError");
  await assert.rejects(getting, (err: Error) => err.name === "AbortError");
});

test("读表格卡住时这次报错、不留在缓存里：回答前检索超时后模型再查，不会一直等那次读", async () => {
  const backend = new MemoryBackend();
  const base = new KnowledgeBase(backend, { logger: quiet, readTimeoutMs: 30 });
  await base.save(normalizeDraft(dau));
  const list = backend.list.bind(backend);
  backend.list = () => new Promise(() => {});
  // 回答前检索到时间就不等了，那次读还挂着
  const lookup = new AbortController();
  const abandoned = raceAbort(base.search("日活"), lookup.signal);
  lookup.abort();
  await assert.rejects(abandoned, (err: Error) => err.name === "AbortError");
  // 模型接着调 knowledge_search：用的是缓存里那次读，到了读表格的期限就报错
  await assert.rejects(base.search("日活"), /读经验库表格超过 0.03 秒没读完/);
  // 报错的那次不留在缓存里，表格好了马上能查到
  backend.list = list;
  assert.deepEqual(
    (await base.search("日活")).map((hit) => hit.entry.id),
    ["K1"],
  );
});

test("归档：团队经验库的按编号，aiops 经验库的按 aiops_id；两个都填或都不填报错", async () => {
  const { backend, base, desk, sent, calls, click, tool } = deskSetup();
  await base.save(normalizeDraft(dau));
  await assert.rejects(tool("knowledge_propose_archive").run({}, { signal }), /id 和 aiops_id 填一个/);
  await assert.rejects(tool("knowledge_propose_archive").run({ id: "K1", aiops_id: 3 }, { signal }), /id 和 aiops_id 填一个/);

  await tool("knowledge_propose_archive").run({ id: "k1", reason: "口径改了" }, { signal });
  const card = (sent[0].input as { card: any }).card;
  assert.equal(card.header.title.content, "归档这条经验？");
  assert.match(cardText(card), /归档原因：口径改了/);
  await desk.handleCardAction(click(card, "archive"));
  await desk.idle();
  assert.equal(backend.entries[0].status, "archived");

  await tool("knowledge_propose_archive").run({ aiops_id: 40 }, { signal });
  const lessonCard = (sent.at(-1)!.input as { card: any }).card;
  assert.match(cardText(lessonCard), /aiops 经验 #40/);
  await desk.handleCardAction({ ...click(lessonCard, "archive"), messageId: "om_card_3" });
  await desk.idle();
  assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 40 }]);
});

test("归档时表格改成功了、结果没传回来：再点一次照常完成，aiops 里同步的那条也归档", async () => {
  const { backend, base, desk, sent, calls, click, tool, lastCard } = deskSetup();
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);
  await tool("knowledge_propose_archive").run({ id: "K1", reason: "已修复" }, { signal });
  const card = (sent[0].input as { card: any }).card;
  backend.lostUpdates = 1;
  await desk.handleCardAction(click(card, "archive"));
  await desk.idle();
  assert.equal(backend.entries[0].status, "archived");
  assert.match(cardText(lastCard()), /上次点确认没成功：socket hang up/);
  assert.equal(calls.filter((call) => call.tool === "archive_lesson").length, 0);

  await desk.handleCardAction(click(card, "archive"));
  await desk.idle();
  assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 31 }]);
  assert.match((sent.at(-1)!.input as { markdown: string }).markdown, /已归档经验 K1.*\naiops 经验库里同步的经验 #31 也已归档/);
});

test("回答前检索：团队经验库这次没查到的，aiops 查到了它同步过去的那条照样列出", async () => {
  const { base, desk } = deskSetup();
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);
  const found = await desk.lookup("完全不相干的一句话", task);
  assert.deepEqual(found?.ids, ["aiops#31", "aiops#40"]);
});

test("回答前检索：两个库一起查，已同步到 aiops 的只列团队经验库那条；一个库出错不影响另一个，都出错时返回空", async () => {
  const { base, desk } = deskSetup();
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);

  const found = await desk.lookup("gateway-api 报 code=8 ResourceExhausted", task);
  assert.deepEqual(found?.ids, ["K1", "aiops#40"]);
  assert.match(found!.text, /^经验 K1 \[排查经验\]/);
  assert.match(found!.text, /aiops 经验 #40：Open WebUI 存的/);
  assert.doesNotMatch(found!.text, /aiops 经验 #31/);

  const none = deskSetup({ aiops: false });
  assert.deepEqual(await none.desk.lookup("今天中午吃什么", task), { text: "", ids: [], missed: [] });

  const broken = new KnowledgeDesk({
    base: new KnowledgeBase({ location: async () => undefined, list: async () => Promise.reject(new Error("飞书接口限流")), add: async () => {}, update: async () => {} }, { logger: quiet }),
    aiops: new AiopsLessons(
      {
        hasTool: () => true,
        callDirect: async () => {
          throw new Error("aiops 现在连不上");
        },
      },
      "aiops",
      quiet,
    ),
    send: async () => ({ messageId: "x" }),
    updateCard: async () => {},
    allowedChatIds: new Set(["oc_1"]),
    logger: quiet,
  });
  assert.equal(await broken.lookup("code=8", task), undefined);
});

test("回答前检索每个库限时：表格卡住了照样用 aiops 的结果；没接 aiops、aiops 没连上时团队经验库没查成就返回空", async () => {
  const hanging: KnowledgeBackend = { location: async () => undefined, list: () => new Promise(() => {}), add: async () => {}, update: async () => {} };
  const lessons = new AiopsLessons(fakeMcp({ search_knowledge: () => JSON.stringify({ hits: [{ id: 40, title: "Open WebUI 存的", score: 8 }] }) }).mcp, "aiops", quiet);
  const make = (aiops?: AiopsLessons) =>
    new KnowledgeDesk({
      base: new KnowledgeBase(hanging, { logger: quiet, readTimeoutMs: 200 }),
      ...(aiops ? { aiops } : {}),
      send: async () => ({ messageId: "x" }),
      updateCard: async () => {},
      allowedChatIds: new Set(["oc_1"]),
      logger: quiet,
      lookupMs: 20,
    });
  const found = await make(lessons).lookup("code=8", task);
  assert.deepEqual(found?.ids, ["aiops#40"]);
  assert.deepEqual(found?.missed, ["团队经验库"]);

  assert.equal(await make().lookup("code=8", task), undefined);
  const disconnected = new AiopsLessons({ hasTool: () => false, callDirect: async () => "" }, "aiops", quiet);
  assert.equal(await make(disconnected).lookup("code=8", task), undefined);

  const stop = new AbortController();
  const pending = make(lessons).lookup("code=8", task, stop.signal);
  stop.abort();
  await assert.rejects(pending, (err: Error) => err.name === "AbortError");
});

test("不是经验库的卡片、不在白名单里的群，经验库不处理", async () => {
  const { desk, sent, click, tool, backend } = deskSetup();
  assert.equal(await desk.handleCardAction({ messageId: "m", chatId: "oc_1", operator: { openId: "ou_admin" }, action: { tag: "button", value: { action: "stop", task: "t" } } }), false);
  await desk.idle();
  await tool("knowledge_propose").run(dau, { signal });
  assert.equal(await desk.handleCardAction({ ...click((sent[0].input as { card: any }).card, "save"), chatId: "oc_other" }), true);
  await desk.idle();
  assert.equal(backend.entries.length, 0);
});

test("类别只认经验库的几类：constructor、toString、__proto__ 这类名字不算", async () => {
  for (const category of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.throws(() => normalizeDraft({ ...dau, category }), /category 只能是/, category);
  }
  const { base, tool } = deskSetup();
  await base.save(normalizeDraft(dau));
  assert.match(await tool("knowledge_search").run({ query: "日活", category: "toString" }, { signal }), /K1/, "不认的类别不拿来过滤");
});

test("「把案例 #N 沉淀为经验」按 aiops 开了的工具说：有 promote_case 用它，没有就用 get_case 自己整理", () => {
  const prompt = (toolNames: string[]) => buildSystemPrompt({ botName: "飞书 CLI", now: new Date(0), toolNames, knowledge: { hits: "" } });
  const promote = prompt(["knowledge_propose", "aiops_get_case", "aiops_promote_case"]);
  assert.match(promote, /先用 aiops_promote_case 拿草稿/);
  const getCase = prompt(["knowledge_propose", "aiops_get_case"]);
  assert.doesNotMatch(getCase, /aiops_promote_case/);
  assert.match(getCase, /用 aiops_get_case 取出案例，自己整理成草稿再调 knowledge_propose，带上 case_id/);
  assert.doesNotMatch(prompt(["knowledge_propose"]), /「把案例 #N 沉淀为经验」：/);
});

test("没接 aiops 时：经验库的工具说明和提示词都不提 aiops 的工具和经验库，免得模型去调不存在的工具", () => {
  const ctx = { chatId: "oc_1", threadKey: "om_root", senderId: "ou_1", askerName: "张三", messageId: "om_1" };
  const specs = (desk: KnowledgeDesk, other: string[] = []) => JSON.stringify(desk.tools(ctx, other).map((tool) => tool.spec));
  const plain = deskSetup({ aiops: false }).desk;
  assert.doesNotMatch(specs(plain), /aiops/);
  const withAiops = deskSetup().desk;
  // 接了 aiops，但这次模型没有 aiops_search_knowledge（比如 aiops 没连上）：不让模型去调它
  assert.doesNotMatch(specs(withAiops), /aiops_search_knowledge/);
  assert.match(specs(withAiops), /aiops_id/);
  assert.match(specs(withAiops, ["aiops_search_knowledge"]), /aiops 自带的经验库用 aiops_search_knowledge 查/);

  const prompt = (toolNames: string[], knowledge: { hits?: string; missed?: string[]; failed?: boolean }) =>
    buildSystemPrompt({ botName: "飞书 CLI", now: new Date(0), toolNames, knowledge });
  const team = ["knowledge_search", "knowledge_get", "knowledge_propose", "knowledge_propose_archive"];
  for (const knowledge of [{ hits: "经验 K1 …" }, { hits: "", missed: ["团队经验库"] }, { failed: true }]) {
    const text = prompt(team, knowledge);
    assert.doesNotMatch(text.slice(text.indexOf("## 团队经验库")), /aiops/, JSON.stringify(knowledge));
  }
  const both = prompt([...team, "aiops_search_knowledge", "aiops_get_knowledge"], { hits: "经验 K1 …" });
  assert.match(both, /参考 aiops 经验 #N/);
  assert.match(both, /aiops 的用 aiops_get_knowledge/);
});

test("模型查经验库时向量服务卡住：到期限就只按关键词，不一直等", async () => {
  const backend = new MemoryBackend();
  const { embedder } = fakeEmbedder(["日活"]);
  const base = new KnowledgeBase(backend, { embedder, logger: quiet });
  await base.save(normalizeDraft(dau));
  // 向量服务卡住，也不认中止信号
  embedder.embed = () => new Promise(() => {});
  const desk = new KnowledgeDesk({
    base,
    send: async () => ({ messageId: "x" }),
    updateCard: async () => {},
    allowedChatIds: new Set(["oc_1"]),
    logger: quiet,
    semanticMs: 20,
  });
  const ctx = { chatId: "oc_1", threadKey: "om_root", senderId: "ou_1", askerName: "张三", messageId: "om_1" };
  const search = desk.tools(ctx).find((tool) => tool.spec.name === "knowledge_search")!;
  assert.match(await search.run({ query: "日活" }, { signal }), /经验 K1/);
});

test("aiops 的说明在经验库关掉时也成立：只在有起草工具时让模型用，没有时直说做不了", async () => {
  const text = await readFile(new URL("../prompts/mcp/aiops.md", import.meta.url), "utf8");
  assert.match(text, /你的工具里有 knowledge_propose、knowledge_propose_archive 时，沉淀经验、归档经验用它们起草/);
  assert.match(text, /没有这两个工具时（经验库没开），有人要沉淀或归档经验，直说现在做不了/);
});
