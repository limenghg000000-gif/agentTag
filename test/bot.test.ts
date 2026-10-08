import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { CardActionEvent, NormalizedMessage, SendInput, SendOptions } from "@larksuiteoapi/node-sdk";
import {
  type BotDeps,
  createCardActionHandler,
  createMessageHandler,
  reviewCodeAnswer,
  reviewOpsAnswer,
  type ThreadContextSource,
  UNVERIFIED_CODE_ANSWER,
  unverifiedOpsAnswer,
} from "../src/bot.js";
import type { ThreadContext } from "../src/history.js";
import { type ChatModel, type ChatRequest, type ChatResult, LlmError } from "../src/llm.js";
import { MemoryStore } from "../src/memory.js";
import { STOP_ACTION } from "../src/progress.js";
import { TaskRegistry } from "../src/tasks.js";
import type { Tool } from "../src/tools/tool.js";

const quiet = { info() {}, warn() {}, error() {} };

function message(content: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: "om_1",
    chatId: "oc_1",
    chatType: "group",
    senderId: "ou_1",
    content,
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: Date.now(),
    ...extra,
  };
}

function fakeModel(respond: (req: ChatRequest) => ChatResult | Promise<ChatResult>) {
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    model: "fake",
    async chat(req) {
      requests.push({ ...req, messages: [...req.messages] });
      return respond(req);
    },
  };
  return { model, requests };
}

function fakeContext(context: Partial<ThreadContext> = {}) {
  const remembered: { question: string; answer: string }[] = [];
  const source: ThreadContextSource = {
    async load() {
      return { history: [], source: "none", ...context };
    },
    remember(_msg, question, answer) {
      remembered.push({ question, answer });
    },
  };
  return { source, remembered };
}

type Sent = { to: string; input: SendInput; opts?: SendOptions };

function setup(overrides: Partial<BotDeps> = {}) {
  const sent: Sent[] = [];
  const updates: { messageId: string; card: any }[] = [];
  const deps: BotDeps = {
    model: fakeModel(() => ({ text: "**答案**", finish: "stop" })).model,
    tools: [],
    allowedChatIds: new Set(["oc_1"]),
    botName: () => "飞书 CLI",
    context: fakeContext().source,
    tasks: new TaskRegistry(),
    send: async (to, input, opts) => {
      sent.push({ to, input, opts });
      return { messageId: `om_reply_${sent.length}` };
    },
    updateCard: async (messageId, card) => {
      updates.push({ messageId, card });
    },
    logger: quiet,
    cardIntervalMs: 0,
    ...overrides,
  };
  return { deps, sent, updates, handle: createMessageHandler(deps) };
}

const markdowns = (sent: Sent[]) => sent.filter((s) => "markdown" in s.input).map((s) => (s.input as { markdown: string }).markdown);
const cards = (sent: Sent[]) => sent.filter((s) => "card" in s.input).map((s) => (s.input as { card: any }).card);
const inThread = { replyTo: "om_1", replyInThread: true };
const cardText = (card: any) => JSON.stringify(card);

test("先在话题里发进度卡片，结束后把卡片改成已完成，再把回答发到话题里", async () => {
  const { model, requests } = fakeModel(() => ({ text: "**答案**", finish: "stop" }));
  const { sent, updates, handle } = setup({ model });

  await handle(message("  今天周几？ "));

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].messages, [{ role: "user", content: "[群成员] 今天周几？" }]);
  assert.equal(sent.length, 2);
  assert.ok("card" in sent[0].input);
  assert.deepEqual(sent[0].opts, inThread);
  assert.match(cardText(cards(sent)[0]), /思考中/);
  assert.match(cardText(cards(sent)[0]), /停止/);
  assert.deepEqual(sent[1], { to: "oc_1", input: { markdown: "**答案**" }, opts: inThread });
  const last = updates.at(-1)!;
  assert.equal(last.messageId, "om_reply_1");
  assert.match(cardText(last.card), /已完成/);
  assert.doesNotMatch(cardText(last.card), /停止/);
});

test("提示词里写着机器人在飞书里的名字", async () => {
  const { model, requests } = fakeModel(() => ({ text: "好", finish: "stop" }));
  const { handle } = setup({ model });

  await handle(message("怎么找你帮忙？"));

  assert.match(requests[0].system, /「飞书 CLI」/);
  assert.match(requests[0].system, /@飞书 CLI/);
});

test("带上话题上下文和提问人名字，并记下这一轮问答", async () => {
  const { model, requests } = fakeModel(() => ({ text: "改好了", finish: "stop" }));
  const context = fakeContext({
    history: [
      { role: "user", content: "[张三] 帮我写个标题" },
      { role: "assistant", content: "《季度总结》" },
    ],
    askerName: "张三",
    source: "feishu",
  });
  const { handle } = setup({ model, context: context.source });

  await handle(message("再短一点", { rootId: "om_root", threadId: "omt_1" }));

  assert.deepEqual(requests[0].messages, [
    { role: "user", content: "[张三] 帮我写个标题" },
    { role: "assistant", content: "《季度总结》" },
    { role: "user", content: "[张三] 再短一点" },
  ]);
  assert.deepEqual(context.remembered, [{ question: "[张三] 再短一点", answer: "改好了" }]);
});

test("调用工具时卡片上列出步骤", async () => {
  const tool: Tool = {
    spec: { name: "lookup", description: "查资料", parameters: { type: "object", properties: {} } },
    describe: () => "查资料 A",
    run: async () => "资料内容",
  };
  const results: ChatResult[] = [
    { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "lookup", arguments: "{}" }] },
    { text: "总结", finish: "stop" },
  ];
  const { model } = fakeModel(() => results.shift()!);
  const { sent, updates, handle } = setup({ model, tools: [tool] });

  await handle(message("查一下"));

  assert.ok(updates.some((u) => /查资料 A/.test(cardText(u.card)) && /停止/.test(cardText(u.card))));
  const final = cardText(updates.at(-1)!.card);
  assert.match(final, /已完成 · 1 步/);
  assert.match(final, /collapsible_panel/);
  assert.deepEqual(markdowns(sent), ["总结"]);
});

test("只 @ 不带内容时给出提示，不调用模型也不发卡片", async () => {
  const { model, requests } = fakeModel(() => ({ text: "", finish: "stop" }));
  const { sent, handle } = setup({ model });

  await handle(message(""));

  assert.equal(requests.length, 0);
  assert.equal(sent.length, 1);
  assert.match(markdowns(sent)[0], /带上问题/);
});

test("在话题里只 @ 不带内容时，结合上文回答", async () => {
  const { model, requests } = fakeModel(() => ({ text: "好的", finish: "stop" }));
  const { handle } = setup({ model });

  await handle(message("", { rootId: "om_root", threadId: "omt_1" }));

  assert.equal(requests.length, 1);
  assert.match((requests[0].messages.at(-1) as { content: string }).content, /没有写别的内容/);
});

test("回答被截断或被内容审核拦下时如实说明", async () => {
  const results: ChatResult[] = [{ text: "前半段", finish: "length" }, { text: "", finish: "filtered" }];
  const { model } = fakeModel(() => results.shift()!);
  const { sent, handle } = setup({ model });

  await handle(message("写长一点"));
  await handle(message("敏感问题"));

  assert.match(markdowns(sent)[0], /^前半段\n\n（回答太长/);
  assert.match(markdowns(sent)[1], /内容审核/);
});

test("模型调用失败时卡片标成出错，并在话题里说明原因", async () => {
  const { model } = fakeModel(() => {
    throw new LlmError("connection", "boom");
  });
  const { sent, updates, handle } = setup({ model });

  await handle(message("你好"));

  assert.deepEqual(markdowns(sent), ["抱歉，这次没能完成：连不上模型服务，请检查网络或 MODEL_BASE_URL。"]);
  assert.match(cardText(updates.at(-1)!.card), /出错了/);
});

test("进度卡片发不出去时照样回答", async () => {
  const sent: Sent[] = [];
  const { handle } = setup({
    send: async (to, input, opts) => {
      if ("card" in input) {
        throw new Error("card rejected");
      }
      sent.push({ to, input, opts });
      return { messageId: "om_reply" };
    },
  });

  await handle(message("你好"));

  assert.deepEqual(markdowns(sent), ["**答案**"]);
});

test("长回答拆成多条，全部回复在同一个话题里", async () => {
  const long = Array.from({ length: 400 }, (_, i) => `第 ${i} 行：这是一段比较长的回答内容`).join("\n");
  const { model } = fakeModel(() => ({ text: long, finish: "stop" }));
  const { sent, handle } = setup({ model });

  await handle(message("写长一点"));

  assert.ok(markdowns(sent).length > 1);
  for (const { opts } of sent) {
    assert.deepEqual(opts, inThread);
  }
});

/** 让模型卡住，直到任务被停止 */
function blockingModel() {
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const model: ChatModel = {
    model: "fake",
    chat: ({ signal }) =>
      new Promise((_, reject) => {
        started();
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  };
  return { model, running };
}

test("在话题里 @ 机器人说「停止」会停掉这个话题的任务，卡片标成已停止，不发回答", async () => {
  const { model, running } = blockingModel();
  const { sent, updates, handle } = setup({ model });

  const task = handle(message("写一篇长文"));
  await running;
  await handle(message("停止", { messageId: "om_2", rootId: "om_1", threadId: "omt_1" }));
  await task;

  assert.deepEqual(markdowns(sent), ["好的，已停止。"]);
  assert.match(cardText(updates.at(-1)!.card), /已停止/);
});

test("没有进行中的任务时说「停止」如实告知", async () => {
  const { sent, handle } = setup();

  await handle(message("停止", { rootId: "om_0", threadId: "omt_0" }));

  assert.deepEqual(markdowns(sent), ["现在没有进行中的任务。"]);
});

test("点卡片上的停止按钮停掉对应任务", async () => {
  const { model, running } = blockingModel();
  const { deps, sent, updates, handle } = setup({ model });
  const onCardAction = createCardActionHandler({ tasks: deps.tasks, allowedChatIds: deps.allowedChatIds, logger: quiet });

  const task = handle(message("写一篇长文"));
  await running;
  const value = JSON.parse(cardText(cards(sent)[0])).body.elements[1].behaviors[0].value;
  assert.equal(value.action, STOP_ACTION);
  const click: CardActionEvent = {
    messageId: "om_reply_1",
    chatId: "oc_1",
    operator: { openId: "ou_2" },
    action: { tag: "button", value },
  };
  await onCardAction({ ...click, chatId: "oc_other" });
  assert.equal(deps.tasks.size, 1);
  await onCardAction(click);
  await task;

  assert.deepEqual(markdowns(sent), []);
  assert.match(cardText(updates.at(-1)!.card), /已停止/);
  assert.equal(deps.tasks.size, 0);
});

test("同一话题里的追问排队，等上一个回答发出后再处理", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const model: ChatModel = {
    model: "fake",
    async chat({ messages }) {
      const question = (messages.at(-1) as { content: string }).content;
      order.push(`问：${question}`);
      if (question.includes("第一问")) {
        await gate;
      }
      return { text: `答：${question}`, finish: "stop" };
    },
  };
  const { sent, handle } = setup({ model });

  const first = handle(message("第一问"));
  await new Promise((resolve) => setImmediate(resolve));
  const second = handle(message("第二问", { messageId: "om_2", rootId: "om_1", threadId: "omt_1" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(cardText(cards(sent)[1]), /排队中/);
  release();
  await Promise.all([first, second]);

  assert.deepEqual(order, ["问：[群成员] 第一问", "问：[群成员] 第二问"]);
  assert.deepEqual(markdowns(sent), ["答：[群成员] 第一问", "答：[群成员] 第二问"]);
});

test("白名单外的群直接忽略，不调用模型也不回复", async () => {
  const { model, requests } = fakeModel(() => ({ text: "不该出现", finish: "stop" }));
  const logs: string[] = [];
  const logger = { ...quiet, info: (line: string) => logs.push(line) };
  const { sent, handle } = setup({ model, logger });

  await handle(message("你好", { chatId: "oc_alarm" }));

  assert.equal(requests.length, 0);
  assert.equal(sent.length, 0);
  assert.match(logs.join("\n"), /oc_alarm/);
});

test("白名单为空时不响应任何群", async () => {
  const { model, requests } = fakeModel(() => ({ text: "不该出现", finish: "stop" }));
  const { sent, handle } = setup({ model, allowedChatIds: new Set() });

  await handle(message("你好"));

  assert.equal(requests.length, 0);
  assert.equal(sent.length, 0);
});

const memoryDirs: string[] = [];
after(() => Promise.all(memoryDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function memoryStore(): Promise<MemoryStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "agenttag-bot-memory-"));
  memoryDirs.push(dir);
  return new MemoryStore(dir, quiet);
}

test("把这个群的记忆写进提示词，别的群的记忆不会带进来", async () => {
  const memory = await memoryStore();
  await memory.add("oc_1", "decision", "发版固定在每周三", { name: "张三" });
  await memory.add("oc_other", "background", "别的群的秘密");
  const { model, requests } = fakeModel(() => ({ text: "周三", finish: "stop" }));
  const { handle } = setup({ model, memory });

  await handle(message("我们哪天发版？"));

  const system = requests[0].system;
  assert.match(system, /## 群记忆/);
  assert.match(system, /【决定】\n- #1 发版固定在每周三（张三，/);
  assert.doesNotMatch(system, /别的群的秘密/);
  assert.deepEqual(requests[0].tools?.map((t) => t.name), ["memory_save", "memory_update", "memory_delete"]);
});

test("群里还没有记忆时也告诉模型可以记", async () => {
  const { model, requests } = fakeModel(() => ({ text: "好", finish: "stop" }));
  const { handle } = setup({ model, memory: await memoryStore() });

  await handle(message("你好"));

  assert.match(requests[0].system, /（这个群还没有记忆）/);
  assert.match(requests[0].system, /memory_save/);
});

test("模型记下的内容带上提问人和来源消息，卡片上显示这一步，换个话题也能用上", async () => {
  const memory = await memoryStore();
  const results: ChatResult[] = [
    {
      text: "",
      finish: "tool_calls",
      toolCalls: [{ id: "c1", name: "memory_save", arguments: JSON.stringify({ content: "发版固定在每周三", kind: "decision" }) }],
    },
    { text: "好的。已记住：发版固定在每周三", finish: "stop" },
    { text: "每周三", finish: "stop" },
  ];
  const { model, requests } = fakeModel(() => results.shift()!);
  const context = fakeContext({ askerName: "张三" });
  const { sent, updates, handle } = setup({ model, memory, context: context.source });

  await handle(message("记住：以后发版固定在每周三", { senderId: "ou_zhang" }));
  await handle(message("哪天发版？", { messageId: "om_9" }));

  const [saved] = await memory.list("oc_1");
  assert.equal(saved.content, "发版固定在每周三");
  assert.equal(saved.author, "张三");
  assert.equal(saved.authorId, "ou_zhang");
  assert.equal(saved.sourceMessageId, "om_1");
  assert.ok(updates.some((u) => /记住：发版固定在每周三/.test(cardText(u.card))));
  assert.deepEqual(markdowns(sent), ["好的。已记住：发版固定在每周三", "每周三"]);
  assert.match(requests.at(-1)!.system, /#1 发版固定在每周三（张三，/);
});

test("读不到群记忆时照常回答，只是不带记忆", async () => {
  const memory = await memoryStore();
  memory.list = async () => {
    throw new Error("disk error");
  };
  const errors: string[] = [];
  const { model, requests } = fakeModel(() => ({ text: "答案", finish: "stop" }));
  const { sent, handle } = setup({ model, memory, logger: { ...quiet, error: (line: string) => errors.push(line) } });

  await handle(message("你好"));

  assert.deepEqual(markdowns(sent), ["答案"]);
  assert.doesNotMatch(requests[0].system, /群记忆/);
  assert.match(errors[0], /读取群记忆失败/);
});

test("按任务创建的工具拿到当前群和发起人，和其他工具一起交给模型，提示词里带上文档规则", async () => {
  const contexts: unknown[] = [];
  const docTool = (name: string): Tool => ({
    spec: { name, description: name, parameters: { type: "object", properties: {} } },
    describe: () => name,
    run: async () => "",
  });
  const { model, requests } = fakeModel(() => ({ text: "好", finish: "stop" }));
  const { handle } = setup({
    model,
    tools: [docTool("fetch_url")],
    taskTools: (task) => {
      contexts.push(task);
      return [docTool("feishu_doc_read")];
    },
    memory: await memoryStore(),
  });

  await handle(message("看下这篇文档", { senderId: "ou_zhang" }));

  assert.deepEqual(contexts, [
    { chatId: "oc_1", threadKey: "om_1", senderId: "ou_zhang", askerName: undefined, messageId: "om_1" },
  ]);
  assert.deepEqual(requests[0].tools?.map((t) => t.name), [
    "fetch_url",
    "feishu_doc_read",
    "memory_save",
    "memory_update",
    "memory_delete",
  ]);
  assert.match(requests[0].system, /飞书文档链接（\/docx\/、\/wiki\/ 等）用 feishu_doc_read 读，不要用 fetch_url/);
});

test("MCP 工具按任务创建，拿到当前群和发起人；它的使用说明写进提示词", async () => {
  const contexts: unknown[] = [];
  const seen: string[][] = [];
  const mcpTool: Tool = {
    spec: { name: "aiops_get_active_alerts", description: "活跃告警", parameters: { type: "object", properties: {} } },
    describe: () => "aiops · 查活跃告警",
    run: async () => "[]",
  };
  const { model, requests } = fakeModel(() => ({ text: "没有告警", finish: "stop" }));
  const { handle } = setup({
    model,
    mcp: {
      names: ["aiops"],
      tools: (task) => {
        contexts.push(task);
        return [mcpTool];
      },
      prompt: (names) => {
        seen.push([...names]);
        return "## aiops（MCP 服务）\n先调 diagnose_service";
      },
    },
  });

  await handle(message("现在有哪些告警", { senderId: "ou_li" }));

  assert.deepEqual(contexts, [{ chatId: "oc_1", threadKey: "om_1", senderId: "ou_li", askerName: undefined, messageId: "om_1" }]);
  assert.deepEqual(requests[0].tools?.map((t) => t.name), ["aiops_get_active_alerts"]);
  assert.deepEqual(seen, [["aiops_get_active_alerts"]]);
  assert.match(requests[0].system, /## aiops（MCP 服务）\n先调 diagnose_service/);
});

test("勾了「同时发送到群」时群里多出的那份一样的提问跳过，不调用模型也不回复", async () => {
  const { model, requests } = fakeModel(() => ({ text: "追加好了", finish: "stop" }));
  const logs: string[] = [];
  const { sent, handle } = setup({ model, logger: { ...quiet, info: (line: string) => logs.push(line) } });

  await handle(message("在文档末尾追加一行", { messageId: "om_t", rootId: "om_root", threadId: "omt_1" }));
  await handle(message("在文档末尾追加一行", { messageId: "om_g" }));

  assert.equal(requests.length, 1);
  assert.deepEqual(markdowns(sent), ["追加好了"]);
  assert.ok(sent.every((s) => s.opts?.replyTo === "om_t"));
  assert.match(logs.join("\n"), /跳过重复的提问 message=om_g：和 om_t/);
});

test("群里那份副本先到时，停掉它的任务，改为回答话题里那条", async () => {
  let calls = 0;
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const model: ChatModel = {
    model: "fake",
    chat: ({ signal }) => {
      calls++;
      if (calls === 1) {
        return new Promise((_, reject) => {
          started();
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return Promise.resolve({ text: "追加好了", finish: "stop" });
    },
  };
  const { sent, updates, handle } = setup({ model });

  const copy = handle(message("在文档末尾追加一行", { messageId: "om_g" }));
  await running;
  await handle(message("在文档末尾追加一行", { messageId: "om_t", rootId: "om_root", threadId: "omt_1" }));
  await copy;

  assert.equal(calls, 2);
  assert.deepEqual(
    sent.filter((s) => "markdown" in s.input).map((s) => s.opts?.replyTo),
    ["om_t"],
  );
  assert.deepEqual(markdowns(sent), ["追加好了"]);
  // 副本的进度卡片（第一张）标成已停止
  assert.ok(updates.some((u) => u.messageId === "om_reply_1" && /已停止/.test(cardText(u.card))));
});

test("日志里记下每轮模型调用和每次工具调用的用时", async () => {
  const tool: Tool = {
    spec: { name: "lookup", description: "查资料", parameters: { type: "object", properties: {} } },
    describe: () => "查资料 A",
    run: async () => "资料内容",
  };
  const results: ChatResult[] = [
    {
      text: "",
      finish: "tool_calls",
      toolCalls: [{ id: "c1", name: "lookup", arguments: "{}" }],
      usage: { input: 1500, output: 20, reasoning: 12 },
    },
    { text: "总结", finish: "stop", usage: { input: 1600, output: 300 } },
  ];
  const { model } = fakeModel(() => results.shift()!);
  const logs: string[] = [];
  const { handle } = setup({ model, tools: [tool], logger: { ...quiet, info: (line: string) => logs.push(line) } });

  await handle(message("查一下"));

  const text = logs.join("\n");
  assert.match(text, /模型第1轮 message=om_1 用时=\d+ms 输入=1500 输出=20 其中思考=12 → 调用 lookup/);
  assert.match(text, /工具 lookup message=om_1 用时=\d+ms/);
  assert.match(text, /模型第2轮 message=om_1 用时=\d+ms 输入=1600 输出=300 → 给出回答/);
});

test("提问里说「深度思考」时这次任务打开思考，平时不指定", async () => {
  const { model, requests } = fakeModel(() => ({ text: "好", finish: "stop" }));
  const { handle } = setup({ model });

  await handle(message("深度思考一下：这个架构有什么隐患？"));
  await handle(message("今天周几", { messageId: "om_2" }));
  await handle(message("认真分析下这两个方案", { messageId: "om_3" }));

  assert.equal(requests[0].thinking, true);
  assert.equal(requests[1].thinking, undefined);
  assert.equal(requests[2].thinking, true);
});

test("配了写权限名单：名单外的人只拿到读的工具，提示词说明没权限；名单里的人工具齐全；不配时所有人都能写", async () => {
  const tool = (name: string, writes = false): Tool => ({
    ...(writes ? { writes: true } : {}),
    spec: { name, description: name, parameters: { type: "object", properties: {} } },
    describe: () => name,
    run: async () => "",
  });
  const taskTools = () => [tool("feishu_doc_read"), tool("feishu_doc_edit", true), tool("code_search"), tool("code_open_pr", true)];
  const logs: string[] = [];

  const guarded = fakeModel(() => ({ text: "好", finish: "stop" }));
  const { handle } = setup({
    model: guarded.model,
    taskTools,
    writeAllowed: new Set(["ou_admin"]),
    logger: { ...quiet, info: (line: string) => logs.push(line) },
  });
  await handle(message("把这篇文档改一下", { senderId: "ou_guest" }));
  assert.deepEqual(guarded.requests[0].tools?.map((t) => t.name), ["feishu_doc_read", "code_search"]);
  assert.match(guarded.requests[0].system, /这次提问的人没有让你改东西的权限（管理员在 WRITE_ALLOWED_USERS 里配置）/);
  assert.match(logs.join("\n"), /发起人不在写权限名单里，这次只给读的工具 message=om_1 sender=ou_guest/);

  await handle(message("把这篇文档改一下", { messageId: "om_2", senderId: "ou_admin" }));
  assert.deepEqual(guarded.requests[1].tools?.map((t) => t.name), ["feishu_doc_read", "feishu_doc_edit", "code_search", "code_open_pr"]);
  assert.doesNotMatch(guarded.requests[1].system, /WRITE_ALLOWED_USERS/);

  const open = fakeModel(() => ({ text: "好", finish: "stop" }));
  await setup({ model: open.model, taskTools }).handle(message("改一下", { senderId: "ou_guest" }));
  assert.equal(open.requests[0].tools?.length, 4);
  assert.doesNotMatch(open.requests[0].system, /WRITE_ALLOWED_USERS/);
});

test("有代码工具时，没读代码就说仓库内容的回答被打回去，查过之后才发出", async () => {
  const codeSearch: Tool = {
    spec: { name: "code_search", description: "搜代码", parameters: { type: "object", properties: {} } },
    describe: () => "搜代码",
    run: async () => "internal/k8s/tools.go:12: func GetPods()",
  };
  const results: ChatResult[] = [
    { text: "在 ai/aiops-mcp 里，K8s tool 注册在 `src/index.ts:30-36`", finish: "stop" },
    { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "code_search", arguments: "{}" }] },
    { text: "定义在 `internal/k8s/tools.go:12`", finish: "stop" },
  ];
  const { model, requests } = fakeModel(() => results.shift()!);
  const warnings: string[] = [];
  const { sent, handle } = setup({
    model,
    taskTools: () => [codeSearch],
    codeRepos: ["ai/aiops-mcp", "ai/agent-tag"],
    logger: { ...quiet, warn: (line: string) => warnings.push(line) },
  });

  await handle(message("在 ai/aiops-mcp 里搜一下 k8s 相关的 tool 在哪里定义？"));

  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].messages.at(-1), { role: "user", content: UNVERIFIED_CODE_ANSWER });
  assert.deepEqual(markdowns(sent), ["定义在 `internal/k8s/tools.go:12`"]);
  assert.match(warnings.join("\n"), /回答没通过检查，已让模型重做 message=om_1/);
});

test("回答里的文件路径出现在 MCP 工具结果里（比如报错堆栈）就放行，结果里没有的路径照样打回", async () => {
  const codeSearch: Tool = {
    spec: { name: "code_search", description: "搜代码", parameters: { type: "object", properties: {} } },
    describe: () => "搜代码",
    run: async () => "",
  };
  const podLogs: Tool = {
    spec: { name: "aiops_get_pod_logs", description: "Pod 日志", parameters: { type: "object", properties: {} } },
    describe: () => "aiops · 查 Pod 日志",
    run: async () => "panic: nil map\n\tinternal/logic/order.go:88 +0x1d",
  };
  const ask = async (answers: string[]) => {
    const results: ChatResult[] = [
      { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "aiops_get_pod_logs", arguments: "{}" }] },
      ...answers.map((text): ChatResult => ({ text, finish: "stop" })),
    ];
    const { model, requests } = fakeModel(() => results.shift()!);
    const { sent, handle } = setup({
      model,
      taskTools: () => [codeSearch],
      codeRepos: ["ai/aiops-mcp"],
      mcp: { names: ["aiops"], tools: () => [podLogs], prompt: () => undefined },
    });
    await handle(message("order-api 的 Pod 为什么重启"));
    return { requests, replies: markdowns(sent) };
  };

  const fromLogs = await ask(["空 map 写入，panic 在 `internal/logic/order.go:88`"]);
  assert.equal(fromLogs.requests.length, 2);
  assert.deepEqual(fromLogs.replies, ["空 map 写入，panic 在 `internal/logic/order.go:88`"]);

  const guessed = await ask(["panic 在 `internal/logic/order.go:88`，是 `internal/svc/context.go` 里没初始化", "panic 在 `internal/logic/order.go:88`"]);
  assert.equal(guessed.requests.length, 3);
  assert.deepEqual(guessed.requests[2].messages.at(-1), { role: "user", content: UNVERIFIED_CODE_ANSWER });
  assert.deepEqual(guessed.replies, ["panic 在 `internal/logic/order.go:88`"]);
});

test("有 aiops 工具时，一个工具都没调就给出线上数据的回答被打回去，查过之后才发出", async () => {
  const queryLogs: Tool = {
    spec: { name: "aiops_query_logs", description: "查日志", parameters: { type: "object", properties: {} } },
    describe: () => "aiops · 查日志",
    run: async () => '{"logs":[]}',
  };
  const results: ChatResult[] = [
    { text: "product-service-api 最近 1 小时只有 2 条 warning（15:47:33~15:47:34），分布在 gateway-api-6978f9454f-tnc56", finish: "stop" },
    { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "aiops_query_logs", arguments: "{}" }] },
    { text: "最近 1 小时没有查到报错日志", finish: "stop" },
  ];
  const { model, requests } = fakeModel(() => results.shift()!);
  const { sent, handle } = setup({ model, mcp: { names: ["aiops"], tools: () => [queryLogs], prompt: () => undefined } });

  await handle(message("查一下 product-service-api 最近一小时的报错日志"));

  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].messages.at(-1), { role: "user", content: unverifiedOpsAnswer(["aiops"]) });
  assert.match(unverifiedOpsAnswer(["aiops"]), /每次都要用 aiops_ 开头的工具重新查/);
  assert.deepEqual(markdowns(sent), ["最近 1 小时没有查到报错日志"]);
});

test("线上数据检查：没成功调过工具就给出时间、Pod、条数、「没有报错」时打回；调过工具、没有线上数据、或者调的是别的工具时放行", () => {
  let succeeded = false;
  const review = reviewOpsAnswer("product-service-api 最近一小时报错多吗", ["aiops"], () => succeeded);
  const flagged = unverifiedOpsAnswer(["aiops"]);
  for (const answer of [
    "15:39:19 有一条 warning",
    "最新 Pod 创建于 2026-10-08 15:40",
    "Pod gateway-api-6978f9454f-tnc56 重启了",
    "最近 1 小时没有查到报错日志",
    "有 47 条错误日志",
    "CPU 使用率 95%",
    "93 个 Pod 都在运行",
    "无明显异常",
  ]) {
    assert.equal(review(answer, new Set()), flagged, answer);
  }
  assert.equal(review("15:39:19 有一条 warning", new Set(["memory_search"])), flagged);
  // 调了 aiops 但失败了（超时、到上限）不算查过
  assert.equal(review("15:39:19 有一条 warning", new Set(["aiops_query_logs"])), flagged);
  succeeded = true;
  assert.equal(review("15:39:19 有一条 warning", new Set(["aiops_query_logs"])), undefined);
  succeeded = false;
  assert.equal(review("提交时间 2026-10-07 18:22:10", new Set(["code_search"])), undefined);
  // 反问、解释概念、只说到分钟的时间都不算线上数据
  assert.equal(review("gateway-api 在 prod、staging、test 都有，查哪个？", new Set()), undefined);
  assert.equal(review("退出码 137 一般是 OOMKilled，下午 3:30 前后看看内存", new Set()), undefined);
  // 提问里本来就有的数字不算
  const polish = reviewOpsAnswer("把这句润色一下：本周发布 3 次，成功率 95%", ["aiops"], () => false);
  assert.equal(polish("本周共发布 3 次，成功率达到 95%。", new Set()), undefined);
});

test("aiops 连不上、这次没有它的工具时，照搬话题里之前的数据也会被打回", async () => {
  const results: ChatResult[] = [
    { text: "最近 1 小时只有 2 条 warning（15:47:33~15:47:34）", finish: "stop" },
    { text: "aiops 现在连不上，暂时查不了，请稍后再试", finish: "stop" },
  ];
  const { model, requests } = fakeModel(() => results.shift()!);
  const { sent, handle } = setup({ model, mcp: { names: ["aiops"], tools: () => [], prompt: () => "## aiops（MCP 服务）\n- aiops 现在连不上" } });

  await handle(message("product-service-api 最近一小时报错多吗"));

  assert.deepEqual(requests[1].messages.at(-1), { role: "user", content: unverifiedOpsAnswer(["aiops"]) });
  assert.deepEqual(markdowns(sent), ["aiops 现在连不上，暂时查不了，请稍后再试"]);
});

test("代码和线上数据两项检查都没过时，重做时一起告诉模型", async () => {
  const codeSearch: Tool = {
    spec: { name: "code_search", description: "搜代码", parameters: { type: "object", properties: {} } },
    describe: () => "搜代码",
    run: async () => "",
  };
  const results: ChatResult[] = [
    { text: "panic 在 internal/logic/order.go:88，15:39:19 重启了一次", finish: "stop" },
    { text: "需要先查一下", finish: "stop" },
  ];
  const { model, requests } = fakeModel(() => results.shift()!);
  const { handle } = setup({
    model,
    taskTools: () => [codeSearch],
    codeRepos: ["ai/aiops-mcp"],
    mcp: { names: ["aiops"], tools: () => [], prompt: () => undefined },
  });

  await handle(message("order-api 为什么重启"));

  assert.deepEqual(requests[1].messages.at(-1), { role: "user", content: `${UNVERIFIED_CODE_ANSWER}\n${unverifiedOpsAnswer(["aiops"])}` });
});

test("代码回答检查：调过代码工具、或者和仓库无关时放行", () => {
  const review = reviewCodeAnswer("ai/agent-tag 的 README 讲了什么", ["ai/aiops-mcp", "ai/agent-tag"]);
  assert.equal(review("README 说……", new Set(["code_read_file"])), undefined);
  assert.equal(review("README 说……", new Set()), UNVERIFIED_CODE_ANSWER);
  // 只写了仓库最后一段名字也算提到
  const byShortName = reviewCodeAnswer("aiops-mcp 用什么语言写的", ["ai/aiops-mcp"]);
  assert.equal(byShortName("Go", new Set()), UNVERIFIED_CODE_ANSWER);
  // 没提仓库，但回答里写了代码文件路径
  const general = reviewCodeAnswer("这个服务怎么启动", ["ai/aiops-mcp"]);
  assert.equal(general("入口在 cmd/server/main.go", new Set(["web_search"])), UNVERIFIED_CODE_ANSWER);
  // 和仓库无关的一般问题不管
  assert.equal(general("用 systemctl 重启，配置写在 tsconfig.json", new Set()), undefined);
  assert.equal(reviewCodeAnswer("今天周几", ["ai/api"])("周一，api 文档见 https://x.com/a/b.js", new Set()), undefined);
  // 文件和行号来自 aiops 查到的崩溃日志：只放过结果里真出现过的路径
  const logs = ["panic: nil map\n\tinternal/logic/order.go:88 +0x1d"];
  const seen = (path: string) => logs.some((output) => output.includes(path));
  const crash = reviewCodeAnswer("order-api 的 Pod 为什么重启", ["ai/aiops-mcp"], seen);
  assert.equal(crash("panic 在 internal/logic/order.go:88", new Set(["aiops_get_pod_logs"])), undefined);
  assert.equal(crash("panic 在 internal/logic/order.go:88，入口在 cmd/server/main.go", new Set(["aiops_get_pod_logs"])), UNVERIFIED_CODE_ANSWER);
  assert.equal(crash("panic 在 internal/logic/order.go:88", new Set(["web_search"])), undefined);
  assert.equal(reviewCodeAnswer("order-api 的 Pod 为什么重启", ["ai/aiops-mcp"])("panic 在 internal/logic/order.go:88", new Set()), UNVERIFIED_CODE_ANSWER);
  // 问的是配置的仓库，结果里出现过路径也不算读过代码
  const repoQuestion = reviewCodeAnswer("aiops-mcp 里 k8s 工具在哪定义", ["ai/aiops-mcp"], () => true);
  assert.equal(repoQuestion("在 internal/tools/k8s.go", new Set(["aiops_list_namespaces"])), UNVERIFIED_CODE_ANSWER);
});
