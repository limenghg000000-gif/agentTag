import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { CardActionEvent, NormalizedMessage, SendInput, SendOptions } from "@larksuiteoapi/node-sdk";
import {
  BLOCKED_OPS_ANSWER,
  blockedCodeAnswer,
  blockUnverifiedOps,
  type BotDeps,
  codeEvidence,
  createCardActionHandler,
  createMessageHandler,
  reviewCodeAnswer,
  reviewOpsAnswer,
  type ThreadContextSource,
  UNVERIFIED_CODE_ANSWER,
  unseenCodeAnswer,
  unseenCodeCitations,
  unverifiedOpsAnswer,
} from "../src/bot.js";
import type { ImageRef, ThreadContext } from "../src/history.js";
import { UNREAD_IMAGE } from "../src/images.js";
import { type ChatMessage, type ChatModel, type ChatRequest, type ChatResult, LlmError } from "../src/llm.js";
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

test("提问里的截图先识别成文字再交给模型，进度卡片上多一步「识别图片」", async () => {
  const { model, requests } = fakeModel(() => ({ text: "好", finish: "stop" }));
  const read: ImageRef[][] = [];
  const { updates, handle } = setup({
    model,
    images: {
      read: async (refs) => {
        read.push([...refs]);
        return new Map([["img_a", "服务名称：prod/gateway-api\n请求requestId：179152518627422277"]]);
      },
    },
  });

  await handle(message("![image](img_a)\n这个线上报警是咋回事", { resources: [{ type: "image", fileKey: "img_a" }] }));

  assert.deepEqual(read, [[{ messageId: "om_1", imageKey: "img_a" }]]);
  const prompt = requests[0].messages.at(-1)!.content;
  assert.match(prompt, /^\[群成员\] \n\[图片内容：机器人用看图模型识别的文字，个别字可能识别错\]\n服务名称：prod\/gateway-api\n请求requestId：179152518627422277\n\[图片内容结束\]\n\n这个线上报警是咋回事$/);
  assert.match(cardText(updates.map((u) => u.card)), /识别图片（1 张）/);
});

test("没配看图模型、或者图片没识别出来时，图片换成「没能看到」的说明，不让模型照着图片编号猜", async () => {
  const { model, requests } = fakeModel(() => ({ text: "好", finish: "stop" }));
  const infos: string[] = [];
  const { handle } = setup({ model, logger: { ...quiet, info: (line: string) => infos.push(line) } });
  const screenshot = () => message("![image](img_a)\n这个线上报警是咋回事", { resources: [{ type: "image", fileKey: "img_a" }] });

  await handle(screenshot());
  assert.equal(requests[0].messages.at(-1)!.content, `[群成员] ${UNREAD_IMAGE}\n这个线上报警是咋回事`);
  assert.match(infos.join("\n"), /提问或话题里有 1 张图片，没配看图模型（MODEL_VISION_ID）/);

  const failed = fakeModel(() => ({ text: "好", finish: "stop" }));
  const { updates, handle: handleFailed } = setup({ model: failed.model, images: { read: async () => new Map() } });
  await handleFailed(screenshot());
  assert.equal(failed.requests[0].messages.at(-1)!.content, `[群成员] ${UNREAD_IMAGE}\n这个线上报警是咋回事`);
  assert.match(cardText(updates.at(-1)!.card), /识别图片（1 张）/);
});

test("提问里自己写的 Markdown 图片语法不是截图，原样交给模型", async () => {
  const { model, requests } = fakeModel(() => ({ text: "好", finish: "stop" }));
  const { handle } = setup({ model, images: { read: async () => new Map() } });

  await handle(message("README 里 ![image](https://example.com/a.png) 这行为啥不显示"));

  assert.equal(requests[0].messages.at(-1)!.content, "[群成员] README 里 ![image](https://example.com/a.png) 这行为啥不显示");
});

test("话题第一条贴了截图，在话题里追问时上文里的截图也换成识别出的文字", async () => {
  const { model, requests } = fakeModel(() => ({ text: "好", finish: "stop" }));
  const read: ImageRef[][] = [];
  const context = fakeContext({
    history: [
      { role: "user", content: "[张三] ![image](img_root)\n这个线上报警是咋回事" },
      { role: "assistant", content: "结论：……" },
    ],
    images: [{ messageId: "om_root", imageKey: "img_root" }],
    source: "feishu",
  });
  const { handle } = setup({
    model,
    context: context.source,
    images: {
      read: async (refs) => {
        read.push([...refs]);
        return new Map([["img_root", "服务名称：prod/gateway-api"]]);
      },
    },
  });

  await handle(message("你确定么？", { rootId: "om_root", threadId: "omt_1" }));

  assert.deepEqual(read, [[{ messageId: "om_root", imageKey: "img_root" }]]);
  assert.match(requests[0].messages[0].content, /^\[张三\] \n\[图片内容：[^\]]*\]\n服务名称：prod\/gateway-api\n\[图片内容结束\]\n\n这个线上报警是咋回事$/);
  assert.equal(requests[0].messages.at(-1)!.content, "[群成员] 你确定么？");
});

test("没说要文档时不给新建文档的工具，提示词让它直接写在回答里；说了要文档才给", async () => {
  const tool = (name: string, writes = false): Tool => ({
    ...(writes ? { writes: true } : {}),
    spec: { name, description: name, parameters: { type: "object", properties: {} } },
    describe: () => name,
    run: async () => "",
  });
  const ask = async (question: string, history: ChatMessage[] = []) => {
    const { model, requests } = fakeModel(() => ({ text: "好", finish: "stop" }));
    const context = fakeContext({ history, source: history.length > 0 ? "feishu" : "none" });
    const taskTools = () => [tool("feishu_doc_read"), tool("feishu_doc_create", true), tool("feishu_doc_edit", true)];
    const { handle } = setup({ model, taskTools, context: context.source });
    await handle(message(question));
    return { tools: requests[0].tools?.map((t) => t.name), system: requests[0].system };
  };
  const withCreate = ["feishu_doc_read", "feishu_doc_create", "feishu_doc_edit"];
  const withoutCreate = ["feishu_doc_read", "feishu_doc_edit"];

  const summary = await ask("把上面的排查结果总结一下");
  assert.deepEqual(summary.tools, withoutCreate);
  assert.match(summary.system, /看起来没说要新建文档，所以没有新建文档的工具：总结、整理这类内容直接写在回答里/);

  for (const question of [
    "把上面的排查结果写成文档",
    "整理成飞书文档发我",
    "建个 doc 记一下",
    "把上面的内容整理到飞书文档里",
    "帮我起草一份文档",
    "新建文档，标题叫周报",
    "帮我写文档",
    "写到一个新的飞书文档里",
  ]) {
    const { tools, system } = await ask(question);
    assert.deepEqual(tools, withCreate, question);
    assert.doesNotMatch(system, /没有新建文档的工具/, question);
  }
  // 说的是已有的文档、或者 docker，不算要新建文档
  for (const question of [
    "总结一下这篇文档 https://example.feishu.cn/docx/abc",
    "写一下这篇文档的摘要",
    "写出这篇文档的问题",
    "整理一下这几篇文档",
    "写文档的人是谁",
    "总结一下 docker 的用法",
  ]) {
    assert.deepEqual((await ask(question)).tools, withoutCreate, question);
  }

  // 话题里刚问过要不要建文档、或者问的是文档标题：接着回的「好」「叫周报」也给
  assert.deepEqual(
    (await ask("好，那就建一个吧", [
      { role: "user", content: "[张三] 把上面的排查结果总结一下" },
      { role: "assistant", content: "总结如下……要我整理成飞书文档吗？" },
    ])).tools,
    withCreate,
  );
  assert.deepEqual(
    (await ask("叫周报", [
      { role: "user", content: "[张三] 把这周的进展写成文档" },
      { role: "assistant", content: "好的，文档标题叫什么？" },
    ])).tools,
    withCreate,
  );
  // 上一条已经建好了文档，不是在问话：这次只说总结，不给
  assert.deepEqual(
    (await ask("把上面的排查结果总结一下", [
      { role: "user", content: "[张三] 写成文档" },
      { role: "assistant", content: "已整理成文档：https://example.feishu.cn/docx/new" },
    ])).tools,
    withoutCreate,
  );
});

test("有代码工具时，没读代码就说仓库内容的回答被打回去，查过之后才发出", async () => {
  const codeSearch: Tool = {
    spec: { name: "code_search", description: "搜代码", parameters: { type: "object", properties: {} } },
    describe: () => "搜代码",
    run: async () => "共 1 处（aiops 分支 @ 9d8e7f6）：\ninternal/k8s/tools.go:12: func GetPods()",
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
  // 一整行的 JSON 被截断在 user.go:123 的「12」处
  const json = '{"logs":[{"msg":"panic: nil map","caller":"internal/logic/order.go:88"},{"caller":"internal/logic/user.go:123"}]}';
  const longLogs: Tool = {
    spec: { name: "aiops_query_logs", description: "查日志", parameters: { type: "object", properties: {} } },
    describe: () => "aiops · 查日志",
    maxOutputChars: json.indexOf("user.go:123") + "user.go:12".length,
    run: async () => json,
  };
  // 正好截在路径后面的冒号前：路径是完整的
  const trace = "panic at internal/logic/pay.go:123 +0x1d";
  const cutTrace: Tool = {
    spec: { name: "aiops_get_trace", description: "查链路", parameters: { type: "object", properties: {} } },
    describe: () => "aiops · 查链路",
    maxOutputChars: trace.indexOf(":123"),
    run: async () => trace,
  };
  // 截在路径中间：模型看到的 src/index.ts 其实是 src/index.tsx 的前半截
  const stack = "Error: boom\n    at render (src/index.tsx:5:3)";
  const cutStack: Tool = {
    spec: { name: "aiops_get_stack", description: "查堆栈", parameters: { type: "object", properties: {} } },
    describe: () => "aiops · 查堆栈",
    maxOutputChars: stack.indexOf("x:5"),
    run: async () => stack,
  };
  const ask = async (answers: string[], tool = "aiops_get_pod_logs") => {
    const results: ChatResult[] = [
      { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: tool, arguments: "{}" }] },
      ...answers.map((text): ChatResult => ({ text, finish: "stop" })),
    ];
    const { model, requests } = fakeModel(() => results.shift()!);
    const { sent, handle } = setup({
      model,
      taskTools: () => [codeSearch],
      codeRepos: ["ai/aiops-mcp"],
      mcp: { names: ["aiops"], tools: () => [podLogs, longLogs, cutTrace, cutStack], prompt: () => undefined },
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

  // 截断以前的部分照样算，截断处被切开的「user.go:12」不算（其实是 123 行）
  const clipped = await ask(["panic 在 `internal/logic/order.go:88`，`internal/logic/user.go:12` 也报错", "panic 在 `internal/logic/order.go:88`"], "aiops_query_logs");
  assert.equal(clipped.requests.length, 3);
  assert.match(String(clipped.requests[1].messages.at(-1)?.content), /user\.go:12/);
  assert.deepEqual(clipped.replies, ["panic 在 `internal/logic/order.go:88`"]);
  // 切在行号里：路径照样算，只是不算哪一行
  const pathOnly = await ask(["`internal/logic/user.go` 也报错"], "aiops_query_logs");
  assert.equal(pathOnly.requests.length, 2);
  const beforeColon = await ask(["panic 在 `internal/logic/pay.go` 里"], "aiops_get_trace");
  assert.equal(beforeColon.requests.length, 2);
  assert.deepEqual(beforeColon.replies, ["panic 在 `internal/logic/pay.go` 里"]);
  const halfPath = await ask(["报错在 `src/index.ts` 里", "报错在 render 里"], "aiops_get_stack");
  assert.equal(halfPath.requests.length, 3);
  assert.deepEqual(halfPath.replies, ["报错在 render 里"]);
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

test("线上数据检查：提问像在问线上服务，一个工具都没成功调过就打回，不管回答怎么写；成功调过工具、或者提问和线上无关时放行", () => {
  const flagged = unverifiedOpsAnswer(["aiops"]);
  // 复测时没调工具编出来的定位候选：没有时间、Pod 名、条数，只看回答认不出来
  const madeUp = "network-tester 在多个命名空间都有部署，请确认要诊断哪个：default、kube-system、monitoring";
  for (const question of ["诊断一下 network-tester", "product-service-api 最近一小时报错多吗", "现在有哪些告警", "prod 的 Pod 有没有在重启", "CPU 高吗"]) {
    const review = (...names: string[]) => reviewOpsAnswer(question, ["aiops"], new Set(names));
    assert.equal(review()(madeUp), flagged, question);
    assert.equal(review()("一切正常"), flagged, question);
    // 只成功调了群记忆工具不算查过
    assert.equal(review("memory_search")(madeUp), flagged, question);
    // 成功调过 aiops，或者成功调过读代码这类别的工具，都放行
    assert.equal(review("aiops_find_service")(madeUp), undefined, question);
    assert.equal(review("code_search")(madeUp), undefined, question);
  }
  for (const question of ["谢谢", "总结一下上面说的", "就选 argocd"]) {
    assert.equal(reviewOpsAnswer(question, ["aiops"], new Set())("好的"), undefined, question);
  }
});

test("线上数据检查：提问看不出是线上问题时，没成功调过工具就给出时间、Pod、条数、就绪数、「没有报错」也打回；数据来自提问时放行", () => {
  // 选了命名空间以后的追问，提问里只有命名空间
  const ok = (...names: string[]) => reviewOpsAnswer("就选 argocd", ["aiops"], new Set(names));
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
    "最近 1 小时没有 error 级别日志",
    "未发现 panic 日志",
    "network-tester 在 default、kube-system 都有部署，查哪个？",
    "已自动定位到 prod",
    "default：1/1 就绪（Deployment）",
    "prod：Ready 4/4",
    "3/3 Running",
    // Markdown 包着的就绪数
    "- default：**1/1** 就绪",
    "- prod（Ready: **4/4**）",
    "- staging：`2/2` 就绪",
  ]) {
    assert.equal(ok()(answer), flagged, answer);
  }
  assert.equal(ok("memory_search")("15:39:19 有一条 warning"), flagged);
  assert.equal(ok("aiops_query_logs")("15:39:19 有一条 warning"), undefined);
  assert.equal(ok("code_search")("提交时间 2026-10-07 18:22:10"), undefined);
  // 反问、解释概念、只说到分钟的时间都不算线上数据
  assert.equal(ok()("要查哪个服务？"), undefined);
  assert.equal(ok()("退出码 137 一般是 OOMKilled，下午 3:30 前后看看内存"), undefined);
  assert.equal(ok()("kubectl get pods 里 READY 列的 1/2 表示两个容器只有一个就绪"), undefined);
  assert.equal(ok()("Rust 没有 exception 机制，用 Result 返回错误"), undefined);
  // 提问里本来就有的数字不算
  const polish = reviewOpsAnswer("把这句润色一下：本周发布 3 次，成功率 95%", ["aiops"], new Set());
  assert.equal(polish("本周共发布 3 次，成功率达到 95%。"), undefined);
  // 提问里的就绪数换了大小写、顺序、空格也不算
  const concept = reviewOpsAnswer("READY 1/2 是什么意思", ["aiops"], new Set());
  assert.equal(concept("Ready 1/2 表示两个容器里只有一个就绪"), undefined);
  assert.equal(concept("1/2 Ready 表示两个容器里只有一个就绪"), undefined);
  assert.equal(concept("1 / 2 ready 表示两个容器里只有一个就绪"), undefined);
  assert.equal(concept("1/2 表示一个就绪，prod 那边现在是 4/4 就绪"), flagged);
  assert.equal(reviewOpsAnswer("READY 11/20 是什么意思", ["aiops"], new Set())("1/2 就绪"), flagged);
});

test("打回重做以后还是没查证就给出线上数据：不发出去，换成说明，话题里记下的也是说明", async () => {
  const queryLogs: Tool = {
    spec: { name: "aiops_query_logs", description: "查日志", parameters: { type: "object", properties: {} } },
    describe: () => "aiops · 查日志",
    run: async () => '{"logs":[]}',
  };
  // 2026-10-08 复测：用户回了「prod」，模型两次都没调工具，第二次照样编出了查询结果
  const results: ChatResult[] = [
    { text: "结论：gateway-api（prod）最近 1 小时没有 error 级别日志（把握：中）", finish: "stop" },
    { text: "结论：gateway-api（prod）最近 1 小时没有 error 级别日志（把握：中）。按 detected_level 查询返回 0 条，宽泛关键词查到 50 条", finish: "stop" },
  ];
  const { model, requests } = fakeModel(() => results.shift()!);
  const context = fakeContext();
  const { sent, handle } = setup({ model, context: context.source, mcp: { names: ["aiops"], tools: () => [queryLogs], prompt: () => undefined } });

  await handle(message("prod"));

  assert.equal(requests.length, 2);
  assert.deepEqual(markdowns(sent), [BLOCKED_OPS_ANSWER]);
  assert.deepEqual(context.remembered, [{ question: "[群成员] prod", answer: BLOCKED_OPS_ANSWER }]);
});

test("打回重做以后没再给线上数据、查过工具、或者是整理之前内容的请求时，照常发出", async () => {
  const queryLogs: Tool = {
    spec: { name: "aiops_query_logs", description: "查日志", parameters: { type: "object", properties: {} } },
    describe: () => "aiops · 查日志",
    run: async () => '{"logs":[]}',
  };
  const ask = async (question: string, answers: ChatResult[]) => {
    const { model } = fakeModel(() => answers.shift()!);
    const { sent, handle } = setup({ model, mcp: { names: ["aiops"], tools: () => [queryLogs], prompt: () => undefined } });
    await handle(message(question));
    return markdowns(sent);
  };
  const withData = "最近 1 小时有 27 条报错，集中在 16:43:26";

  // 重做以后改成反问
  assert.deepEqual(await ask("prod", [{ text: withData, finish: "stop" }, { text: "要查哪个服务？", finish: "stop" }]), ["要查哪个服务？"]);
  // 重做时查了
  assert.deepEqual(
    await ask("prod", [
      { text: withData, finish: "stop" },
      { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "aiops_query_logs", arguments: "{}" }] },
      { text: withData, finish: "stop" },
    ]),
    [withData],
  );
  // 整理话题里之前的回答
  assert.deepEqual(await ask("总结一下上面查到的情况", [{ text: withData, finish: "stop" }, { text: withData, finish: "stop" }]), [withData]);
});

test("重做以后的最后一道检查：哪些回答不发出去", () => {
  const block = (question: string, answer: string, attempted = false, succeeded: string[] = []) =>
    blockUnverifiedOps(question, ["aiops"], new Set(succeeded), answer, attempted);
  // 只在线上数据里出现的：带秒的时间、日期加时间、定位结果
  assert.equal(block("prod", "宽泛关键词查到 50 条，时间 2026-10-08 17:03～18:03"), true);
  assert.equal(block("诊断一下 network-tester", "network-tester 在 default、kube-system、monitoring 都有部署，请选择命名空间"), true);
  assert.equal(block("诊断一下 network-tester", "network-tester 在 default、kube-system、monitoring 都有部署。请问查哪个？"), true);
  assert.equal(block("gateway-api 呢", "已自动定位到 prod，gateway-api 运行正常"), true);
  assert.equal(block("prod", "Pod gateway-api-6978f9454f-tnc56 重启了"), true);
  // 写成线上结论的，举例的句子也照样查
  assert.equal(block("prod", "结论：例如 gateway-api-6978f9454f-tnc56 已重启（把握：中）"), true);
  // 数量、「没有报错」写成线上结论时拦
  assert.equal(block("prod", "结论：最近 1 小时没有报错（把握：中）"), true);
  assert.equal(block("prod", "结论：宽泛关键词查到 50 条（把握：中）"), true);
  // 查过就放行；只调了群记忆不算
  assert.equal(block("prod", "结论：宽泛关键词查到 50 条（把握：中）", true, ["aiops_query_logs"]), false);
  assert.equal(block("prod", "结论：宽泛关键词查到 50 条（把握：中）", true, ["memory_search"]), true);
  // 整理之前的内容放行；要求重新查的不放行
  assert.equal(block("总结一下上面查到的情况", "结论：最近 1 小时有 27 条报错（把握：中）"), false);
  assert.equal(block("不要总结旧结果，重新排查 gateway-api 的告警", "结论：最近 1 小时有 27 条报错（把握：中）"), true);
  const made = "结论：gateway-api 在 2026-10-08 17:03:26 出现 50 条报错（把握：中）";
  assert.equal(block("排查 gateway-api 最近一小时的报错并总结原因", made), true);
  assert.equal(block("总结 gateway-api 的报错原因", made), true);
  assert.equal(block("把上面 gateway-api 的排查结果总结一下", made), false);
  assert.equal(block("把上面的排查结果重新整理一下", made), false);
  assert.equal(block("现在把上面的排查结果翻译成英文", made), false);
  assert.equal(block("gateway-api 现在怎么样了，总结一下", made), true);
  assert.equal(block("翻译成英文", "Conclusion: 50 errors since 2026-10-08 17:03:26"), false);
  assert.equal(block("总结以上内容", made), false);
  assert.equal(block("总结一下 gateway-api 5 分钟以上的慢请求", made), true);
  assert.equal(block("这段时间 gateway-api 的报错总结一下", made), true);
  // 调过工具都失败了：说调用失败的那句不算，剩下的照样查
  assert.equal(block("product-service-api 最近一小时报错多吗", "aiops 连续 3 次查询都超时，无法确认线上状态", true), false);
  assert.equal(block("product-service-api 最近一小时报错多吗", "结论：aiops 查询 3 次都超时，无法确认（把握：低）", true), false);
  assert.equal(block("product-service-api 最近一小时报错多吗", "结论：最近一小时有 50 条请求超时，CPU 使用率 95%（把握：中）", true), true);
  assert.equal(block("product-service-api 最近一小时报错多吗", "结论：aiops 查询超时了，不过最近一小时有 50 条报错（把握：中）", true), true);
  assert.equal(block("product-service-api 最近一小时报错多吗", "结论：日志查询返回 50 条请求超时（把握：中）", true), true);
  assert.equal(block("product-service-api 最近一小时报错多吗", "aiops 查询超时了（把握：中），不过最近一小时有 50 条报错", true), true);
  // 没调过工具时说「查询 3 次都超时」也是编的
  assert.equal(block("product-service-api 最近一小时报错多吗", "结论：aiops 查询 3 次都超时（把握：低）"), true);
  // 概念解释、单位换算、反问照常发
  assert.equal(block("1GiB 是多少字节", "1GiB = 1024MiB = 1073741824 字节。"), false);
  // 「先给结论」是所有回答的写法，只有带把握的才算线上结论
  assert.equal(block("1GiB 是多少字节", "结论：1GiB = 1024MiB = 1073741824 字节。"), false);
  assert.equal(block("Pod 内存 limit 怎么设", "要把握好余量：一般 512MiB 到 2GiB"), false);
  assert.equal(block("Pod 副本数怎么定", "要把握高峰期流量：一般 3 个副本起步"), false);
  assert.equal(block("prod", "结论：最近 1 小时 27 条报错（把握：中等）"), true);
  assert.equal(block("prod", "**结论**：最近 1 小时 27 条报错（**把握**：中）"), true);
  assert.equal(block("Go 有异常机制吗", "Go 没有异常机制，错误靠返回值"), false);
  assert.equal(block("Go 的时间格式怎么写", "Go 用参考时间写格式：2006-01-02 15:04:05"), false);
  // 问的是时间本身：回答里的时间是算出来、举例的，写成线上结论时才拦
  assert.equal(block("UTC 的 08:00:00 对应北京时间几点？", "北京时间为 16:00:00。"), false);
  assert.equal(block("UTC 的 08:00:00 对应北京时间几点？", "结论：北京时间为 16:00:00（把握：高）"), false);
  assert.equal(block("现在是几月几日几点？", "现在是北京时间 2026-10-09 09:30。"), false);
  assert.equal(block("一小时后是几点？", "一小时后是北京时间 10:30:00。"), false);
  assert.equal(block("3 天后是星期几", "2026-10-12 00:00 是星期一"), false);
  assert.equal(block("gateway-api 什么时候开始报错的", "结论：从 15:31:22 开始报错（把握：中）"), true);
  assert.equal(block("时间戳 1696752000 是北京时间几点", "2023-10-08 16:00:00"), false);
  assert.equal(block("Python 怎么格式化时间", "strftime('%Y-%m-%d %H:%M:%S') 输出类似 2024-01-01 12:00:00"), false);
  assert.equal(block("gateway-api 15:30 以后有报错吗", "结论：15:31:22 起有 3 条 error 日志（把握：中）"), true);
  assert.equal(block("prod", "15:31:22 起有 3 条 error 日志"), true);
  assert.equal(block("命名空间有什么用", "可以把同一个服务部署在多个命名空间里，隔开测试和生产"), false);
  assert.equal(block("Pod 内存 limit 一般设多少", "一般 512MiB 到 2GiB，CPU 0.5 核起步，看压测结果调"), false);
  assert.equal(block("Pod 重启一般什么原因", "常见原因是 OOM、探针失败、镜像拉取失败"), false);
  // 讲概念时举的 Pod 名、「节点都有部署」「会自动定位到」
  assert.equal(
    block("Deployment 的 Pod 名称是怎么生成的", "例如 gateway-api-6978f9454f-tnc56 中，gateway-api 是 Deployment 名，6978f9454f 是模板哈希，tnc56 是随机后缀"),
    false,
  );
  assert.equal(block("DaemonSet 和 Deployment 有什么区别？", "DaemonSet 确保符合条件的节点都有部署；Deployment 则维护指定数量的副本"), false);
  assert.equal(block("DaemonSet 是干什么的", "让 worker、master 节点上都有部署一份，比如日志采集"), false);
  assert.equal(block("aiops 不写命名空间会怎样", "aiops 会自动定位到唯一的命名空间，有好几个时列出候选让你选"), false);
});

test("调了 aiops 和搜索都失败（超时、工具不存在）时不算查过，给出线上结论照样打回", async () => {
  const failing = (name: string): Tool => ({
    spec: { name, description: name, parameters: { type: "object", properties: {} } },
    describe: () => name,
    run: async () => {
      throw new Error("超时");
    },
  });
  const results: ChatResult[] = [
    {
      text: "",
      finish: "tool_calls",
      toolCalls: [
        { id: "c1", name: "aiops_query_logs", arguments: "{}" },
        { id: "c2", name: "web_search", arguments: "{}" },
        { id: "c3", name: "no_such_tool", arguments: "{}" },
      ],
    },
    { text: "最近 1 小时没有查到报错日志", finish: "stop" },
    { text: "aiops 这次查询超时了，暂时没法确认，请稍后再试", finish: "stop" },
  ];
  const { model, requests } = fakeModel(() => results.shift()!);
  const { sent, handle } = setup({
    model,
    tools: [failing("web_search")],
    mcp: { names: ["aiops"], tools: () => [failing("aiops_query_logs")], prompt: () => undefined },
  });

  await handle(message("product-service-api 最近一小时报错多吗"));

  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].messages.at(-1), { role: "user", content: unverifiedOpsAnswer(["aiops"]) });
  assert.deepEqual(markdowns(sent), ["aiops 这次查询超时了，暂时没法确认，请稍后再试"]);
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

test("代码回答检查：调过代码工具也要核对，回答里的文件、行号和提交号得在工具结果里出现过", () => {
  const seen = codeEvidence(["ai/aiops-mcp"], [{ tool: "code_search", output: "共 1 处（master 分支 @ 3f2a1c9）：\ninternal/k8s/tools.go:12: func GetPods()" }]);
  const review = reviewCodeAnswer("k8s 工具在哪定义", ["ai/aiops-mcp", "ai/agent-tag"], seen);
  const searched = new Set(["code_search"]);
  assert.equal(review("定义在 `internal/k8s/tools.go:12`（master 分支 @ 3f2a1c9）", searched), undefined);
  // 写成「仓库名/路径」「./路径」也认
  assert.equal(review("在 ai/aiops-mcp/internal/k8s/tools.go 第 12 行", searched), undefined);
  assert.equal(review("在 ./internal/k8s/tools.go:12", searched), undefined);
  // 文件是真的，行号是编的
  assert.equal(review("在 internal/k8s/tools.go:99", searched), unseenCodeAnswer(["internal/k8s/tools.go:99"], ["ai/aiops-mcp", "ai/agent-tag"]));
  // 2026-10-09：调了一次代码工具，回答里的仓库提交和文件都是编的
  const made = "code=8 是用户不存在（ai/agent-tag master @ 2c6a7d9，`yuebai-user/rpc/internal/logic/common/userlogic.go:35`）";
  assert.equal(
    review(made, searched),
    unseenCodeAnswer(["yuebai-user/rpc/internal/logic/common/userlogic.go:35", "2c6a7d9"], ["ai/aiops-mcp", "ai/agent-tag"]),
  );
  assert.match(unseenCodeAnswer(["a/b.go"], ["ai/aiops-mcp"]), /工具结果里都没有出现：a\/b\.go.*直说读不到这部分代码/);
  // 群成员在提问里写的路径不算查证：没读代码就照着提问讲，照样要先读
  assert.equal(reviewCodeAnswer("src/foo.ts:10 是干嘛的", ["ai/aiops-mcp"], seen)("src/foo.ts:10 是初始化配置", new Set()), UNVERIFIED_CODE_ANSWER);
});

test("代码引用按行认：搜索结果、报错堆栈里的「路径:行号」，读文件时读到的那一行", () => {
  const read = "src/app.ts（master 分支 @ 3f2a1c9，共 80 行，下面是第 1 到 40 行）\n1| import x\n35| export function start() {}";
  const seen = codeEvidence(
    [],
    [
      { tool: "code_read_file", output: read },
      { tool: "aiops_query_logs", output: 'Traceback\n  File "app/jobs/sync.py", line 88, in run' },
      { tool: "aiops_query_logs", output: "panic\n\tinternal/logic/order.go:88 +0x1d" },
    ],
  );
  assert.equal(seen("src/app.ts", 35), true);
  assert.equal(seen("src/app.ts", 60), false);
  assert.equal(seen("src/app.ts", 3), false);
  assert.equal(seen("src/app.ts"), true);
  assert.equal(seen("app/jobs/sync.py", 88), true);
  assert.equal(seen("internal/logic/order.go", 88), true);
  assert.equal(seen("internal/logic/order.go", 8), false);
  assert.equal(seen("src/other.ts"), false);
});

test("代码引用的路径要整段对上，改文件的结果里写的行也认", () => {
  const seen = codeEvidence(
    [],
    [
      { tool: "code_list_files", output: "共 3 个文件（master 分支 @ 3f2a1c9）：\nsrc/index.tsx\npkg/mysrc/util.ts\nsrc/app.ts.map" },
      { tool: "code_search", output: "共 1 处（master 分支 @ 3f2a1c9）：\npkg/src/nested.ts:12: export const x = 1" },
      { tool: "code_edit_file", output: "已修改 src/foo.ts 第 10 行起的内容。" },
      { tool: "code_edit_file", output: "已新建 src/util/new.ts（12 行）。" },
      { tool: "aiops_query_logs", output: "goroutine 1 [running]:\n/app/internal/logic/order.go:88 +0x1d" },
      { tool: "aiops_query_logs", output: "Error: boom\n    at start (/app/src/server.ts:12:5)" },
      { tool: "aiops_query_logs", output: "caller=./internal/svc/ctx.go:21" },
    ],
  );
  // 结果里只有 src/index.tsx、pkg/mysrc/util.ts、src/app.ts.map、pkg/src/nested.ts，不能认 src/index.ts、src/util.ts、src/app.ts、src/nested.ts
  assert.equal(seen("src/index.tsx"), true);
  assert.equal(seen("src/index.ts"), false);
  assert.equal(seen("src/util.ts"), false);
  assert.equal(seen("src/app.ts"), false);
  assert.equal(seen("pkg/src/nested.ts", 12), true);
  assert.equal(seen("src/nested.ts"), false);
  assert.equal(seen("src/nested.ts", 12), false);
  // 堆栈里写的全路径（绝对路径）照样认
  assert.equal(seen("internal/logic/order.go", 88), true);
  assert.equal(seen("src/server.ts", 12), true);
  assert.equal(seen("src/foo.ts", 10), true);
  assert.equal(seen("src/foo.ts", 11), false);
  assert.equal(seen("src/util/new.ts", 12), true);
  assert.equal(seen("src/util/new.ts", 13), false);
  assert.equal(seen("internal/svc/ctx.go", 21), true);
  // 提交号可以只写前几位，不能在查到的后面再编几位
  const commit = codeEvidence([], [{ tool: "code_search", output: "共 1 处（master 分支 @ 3f2a1c9d8e7b）：\na/b.go:1: x" }]);
  assert.equal(commit("3f2a1c9"), true);
  assert.equal(commit("3f2a1c9d8e7b"), true);
  assert.equal(commit("3f2a1c9d8e7bdeadbeef"), false);
});

test("代码引用：带空格的路径、diff 和开 PR 结果里的改动统计", () => {
  const seen = codeEvidence(
    [],
    [
      { tool: "code_list_files", output: "共 1 个文件（master 分支 @ 3f2a1c9）：\nsrc/my files/app.ts" },
      { tool: "code_read_file", output: "src/my files/app.ts（共 2 行，下面是第 1 到 2 行）\n1| a\n2| b" },
      // 模型传的路径前后带空格：工具读的是整理过的 src/foo.ts，结果里写的是原样
      { tool: "code_read_file", output: " src/foo.ts （共 1 行，下面是第 1 到 1 行）\n1| a" },
      // 统计整体 trim 过：只改了一个文件时，唯一的一行前面没有空格
      { tool: "code_open_pr", output: "已开合并请求 !11：https://lab.example.com/x/-/merge_requests/11\n\n改动统计：\nsrc/one.ts | 1 +\n 1 file changed, 1 insertion(+)" },
      {
        tool: "code_open_pr",
        output:
          "已开合并请求 !12：https://lab.example.com/x/-/merge_requests/12\n\n改动统计：\nsrc/a.ts | 3 ++-\n assets/logo.png | Bin 0 -> 1234 bytes\n" +
          " .../deep/name.ts | 1 +\n 3 files changed, 3 insertions(+), 1 deletion(-)",
      },
      // 统计在空行以前；diff 里的上下文行也以空格开头，长得像统计的不算
      {
        tool: "code_diff",
        output:
          "src/c.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n\ndiff --git a/src/c.ts b/src/c.ts\n@@ -1,3 +1,3 @@\n fake/path.ts | 9 +\n-x\n+y\n" +
          "diff --git a/src/my dir/d.ts b/src/my dir/d.ts",
      },
    ],
  );
  // 反引号里带空格的路径按整段认；空格后面那段（files/app.ts）是另一个路径，不认
  assert.deepEqual(unseenCodeCitations("在 `src/my files/app.ts:2`", seen), []);
  assert.deepEqual(unseenCodeCitations("在 `src/my files/app.ts:3`", seen), [{ text: "files/app.ts:3", located: true }]);
  assert.deepEqual(unseenCodeCitations("在 files/app.ts 和 `files/app.ts`", seen), [{ text: "files/app.ts", located: false }]);
  // 反引号里是几个路径，整段不是一个路径时照常一个个认
  assert.deepEqual(unseenCodeCitations("见 `src/a.ts or src/c.ts`", seen), []);
  assert.deepEqual(unseenCodeCitations("见 `src/a.ts or src/zzz.ts`", seen), [{ text: "src/zzz.ts", located: false }]);
  assert.equal(seen("src/my files/app.ts", 2), true);
  assert.equal(seen("files/app.ts"), false);
  assert.equal(seen("src/foo.ts", 1), true);
  assert.equal(seen("src/one.ts"), true);
  assert.equal(seen("src/a.ts"), true);
  assert.equal(seen("src/a.ts", 1), false);
  assert.equal(seen("assets/logo.png"), true);
  assert.equal(seen("deep/name.ts"), false);
  assert.equal(seen("src/c.ts"), true);
  assert.equal(seen("fake/path.ts"), false);
  assert.equal(seen("src/my dir/d.ts"), true);
});

test("代码工具的结果只认工具自己写的部分，读到、搜到的代码正文里写的路径、行号、提交号不算", () => {
  const seen = codeEvidence(
    [],
    [
      // 搜到的是测试文件里的字符串：认 test/bot.test.ts 第 97 行，不认字符串里写的 src/foo.ts 第 10 行、userlogic.go:35、2c6a7d9
      {
        tool: "code_search",
        output:
          "共 2 处（master 分支 @ 3f2a1c9）：\ntest/bot.test.ts:97:  assert.equal(x, \"已修改 src/foo.ts 第 10 行起的内容。\");\n" +
          "test/bot.test.ts:1169:  const made = \"ai/agent-tag master @ 2c6a7d9，`yuebai-user/rpc/internal/logic/common/userlogic.go:35`\";",
      },
      { tool: "code_read_file", output: "./src/bar.ts（共 3 行，下面是第 1 到 3 行）\n1| // 见 src/other.ts:2\n2| export {};\n3| " },
      // 没搜到时照抄的搜索内容里写什么都不算，结尾的提交号算
      { tool: "code_search", output: "没有搜到「x」：src/fake.ts:10」（aiops 分支 @ 9d8e7f6）。" },
      // 搜多个分支：每组开头的分支和提交号算，搜到的那行正文里写的不算
      {
        tool: "code_search",
        output: "在 2 个分支上共搜到 2 处：\n【master 分支 @ 1a2b3c4，1 处】\nsrc/a.ts:3: // 【dev 分支 @ 2c6a7d9，1 处】\n【dev 分支 @ 5e6f7a8，1 处】\nsrc/b.ts:4: y",
      },
      // 读文件时路径写成 src/./baz.ts，和读文件时一样整理成 src/baz.ts
      { tool: "code_read_file", output: "src/./baz.ts（共 1 行，下面是第 1 到 1 行）\n1| export {};" },
    ],
  );
  assert.equal(seen("test/bot.test.ts", 97), true);
  assert.equal(seen("src/foo.ts", 10), false);
  assert.equal(seen("src/foo.ts"), false);
  assert.equal(seen("yuebai-user/rpc/internal/logic/common/userlogic.go", 35), false);
  assert.equal(seen("2c6a7d9"), false);
  assert.equal(seen("3f2a1c9"), true);
  // 读文件时写成 ./src/bar.ts 的照样认；正文里写的 src/other.ts:2 不算
  assert.equal(seen("src/bar.ts"), true);
  assert.equal(seen("src/bar.ts", 2), true);
  assert.equal(seen("src/other.ts", 2), false);
  assert.equal(seen("src/fake.ts", 10), false);
  assert.equal(seen("9d8e7f6"), true);
  assert.equal(seen("1a2b3c4"), true);
  assert.equal(seen("5e6f7a8"), true);
  assert.equal(seen("src/a.ts", 3), true);
  assert.equal(seen("src/b.ts", 4), true);
  assert.equal(seen("src/baz.ts", 1), true);
  assert.equal(seen("./src/baz.ts", 1), true);
});

test("没查到的代码位置：带行号的路径和提交号算「说查过」，举例的路径不算", () => {
  const none = () => false;
  assert.deepEqual(
    unseenCodeCitations("ErrUserNotFound 在 rpc/logic/user.go:35，降级在 app/gateway/remote.go 第 47 行，对照 k8s/deployment.yaml，提交 9c1e2f3a", none),
    [
      { text: "rpc/logic/user.go:35", located: true },
      { text: "app/gateway/remote.go:47", located: true },
      { text: "k8s/deployment.yaml", located: false },
      { text: "9c1e2f3a", located: true },
    ],
  );
  // 全是数字的（requestId）、没有数字的英文单词不算提交号
  assert.deepEqual(unseenCodeCitations("requestId @ 179152518627422277，版本 deadbeef", none), []);
});

test("调过代码工具还编出仓库里没有的文件：打回重做，重做后还编就不发出", async () => {
  const codeSearch: Tool = {
    spec: { name: "code_search", description: "搜代码", parameters: { type: "object", properties: {} } },
    describe: () => "搜代码",
    run: async () => "没有搜到「getUserCenterFromRemote」（master 分支 @ 1a2b3c4）。",
  };
  const codeRead: Tool = {
    spec: { name: "code_read_file", description: "读代码", parameters: { type: "object", properties: {} } },
    describe: () => "读代码",
    run: async () => {
      throw new Error("没有这个文件：src/legacy/user.ts。可以先用 code_list_files 或 code_search 找找");
    },
  };
  const longList: Tool = {
    spec: { name: "code_list_files", description: "列文件", parameters: { type: "object", properties: {} } },
    describe: () => "列文件",
    maxOutputChars: 50,
    run: async () => `共 2 个文件（master 分支 @ 1a2b3c4）：\nsrc/index.ts\n${"x".repeat(60)}\nsrc/hidden/tail.ts`,
  };
  const readBig: Tool = {
    spec: { name: "code_read_big", description: "读大文件", parameters: { type: "object", properties: {} } },
    describe: () => "读大文件",
    run: async () => {
      throw new Error("src/generated.ts 有 2048 KB，太大了不读，用 code_search 搜需要的部分");
    },
  };
  const searchPath: Tool = {
    spec: { name: "code_find", description: "按路径搜", parameters: { type: "object", properties: {} } },
    describe: () => "按路径搜",
    run: async () => "没有搜到「src/legacy/user.ts」（master 分支 @ 1a2b3c4）。",
  };
  // 不是代码工具：报错写成「路径 是目录」也不算查到这个文件
  const otherTool: Tool = {
    spec: { name: "aiops_get_file", description: "别的工具", parameters: { type: "object", properties: {} } },
    describe: () => "别的工具",
    run: async () => {
      throw new Error("src/legacy/user.ts 是目录");
    },
  };
  const made =
    "结论：code=8 是 user-rpc 定义的「用户不存在」（把握：高）。依据：ai/agent-tag master @ 2c6a7d9，`yuebai-user/rpc/internal/logic/common/userlogic.go:35`";
  const ask = async (
    answers: string[],
    { question = "去 gateway-api 和 user-rpc 服务代码去排查一下", tool = "code_search", also = [] as string[] } = {},
  ) => {
    const results: ChatResult[] = [
      {
        text: "",
        finish: "tool_calls",
        toolCalls: [tool, ...also].map((name, i) => ({ id: `c${i + 1}`, name, arguments: "{}" })),
      },
      ...answers.map((text): ChatResult => ({ text, finish: "stop" })),
    ];
    const { model, requests } = fakeModel(() => results.shift()!);
    const warnings: string[] = [];
    const { sent, handle } = setup({
      model,
      taskTools: () => [codeSearch, codeRead, longList, searchPath, readBig, otherTool],
      codeRepos: ["ai/aiops-mcp", "ai/agent-tag"],
      logger: { ...quiet, warn: (line: string) => warnings.push(line) },
    });
    await handle(message(question));
    return { requests, replies: markdowns(sent), warnings: warnings.join("\n") };
  };

  const stillMade = await ask([made, made]);
  assert.equal(stillMade.requests.length, 3);
  assert.match(String(stillMade.requests[2].messages.at(-1)?.content), /2c6a7d9/);
  assert.deepEqual(stillMade.replies, [blockedCodeAnswer(["ai/aiops-mcp", "ai/agent-tag"])]);
  assert.match(
    stillMade.warnings,
    /还是引用了没查到的代码位置，没有发出 message=om_1：yuebai-user\/rpc\/internal\/logic\/common\/userlogic\.go:35、2c6a7d9/,
  );

  // 重做后去掉了行号，只说「实现在某个文件里」：读过代码的这次，路径也得是真的
  const noLine = await ask([made, "实现在 `yuebai-user/rpc/internal/logic/common/userlogic.go` 里"]);
  assert.deepEqual(noLine.replies, [blockedCodeAnswer(["ai/aiops-mcp", "ai/agent-tag"])]);

  const honest = await ask([made, "gateway-api 和 user-rpc 的代码不在机器人能读的仓库（ai/aiops-mcp、ai/agent-tag）里，读不到。"]);
  assert.deepEqual(honest.replies, ["gateway-api 和 user-rpc 的代码不在机器人能读的仓库（ai/aiops-mcp、ai/agent-tag）里，读不到。"]);

  // 工具报错（「没有这个文件」）不算查到：照实说找不到也要重做一次，路径是群成员自己问的，重做以后照着复述就发出
  const missing = "src/legacy/user.ts 第 10 行在仓库里找不到，没有这个文件";
  const asked = await ask([missing, missing], { question: "src/legacy/user.ts 第 10 行是干嘛的", tool: "code_read_file" });
  assert.equal(asked.requests.length, 3);
  assert.match(String(asked.requests[2].messages.at(-1)?.content), /读失败、没搜到的路径也不算/);
  assert.deepEqual(asked.replies, [missing]);
  // 群成员写的是「仓库名/路径」，回答里写的是仓库里的路径，也算照着复述
  for (const question of ["ai/aiops-mcp/src/legacy/user.ts 第 10 行是干嘛的", "AI/AIOPS-MCP/src/legacy/user.ts 第 10 行是干嘛的"]) {
    const prefixed = await ask([missing, missing], { question, tool: "code_read_file" });
    assert.equal(prefixed.requests.length, 3, question);
    assert.deepEqual(prefixed.replies, [missing], question);
  }

  // 读失败、没搜到以后照样讲这个文件写了什么，或者自己猜的路径读失败了还写着：打回重做，重做后还这么写就不发出
  for (const [claim, tool] of [
    ["`src/legacy/user.ts:10` 初始化配置", "code_read_file"],
    ["`src/legacy/user.ts:10` 没找到 bug，但该行初始化了配置", "code_read_file"],
    ["`src/legacy/user.ts:10` 初始化配置", "code_find"],
    ["src/legacy/user.ts 不存在", "code_read_file"],
  ]) {
    const failedRead = await ask([claim, claim], { tool });
    assert.equal(failedRead.requests.length, 3, claim);
    assert.match(String(failedRead.requests[2].messages.at(-1)?.content), /src\/legacy\/user\.ts/);
    assert.deepEqual(failedRead.replies, [blockedCodeAnswer(["ai/aiops-mcp", "ai/agent-tag"])], claim);
  }
  // 文件太大读不了：报错说明文件是有的，说它太大不算编；编它第几行写了什么照样拦
  const tooBig = await ask(["src/generated.ts 太大，读不了"], { tool: "code_read_big" });
  assert.equal(tooBig.requests.length, 2);
  assert.deepEqual(tooBig.replies, ["src/generated.ts 太大，读不了"]);
  const bigLine = await ask(["src/generated.ts:10 初始化配置", "src/generated.ts:10 初始化配置"], { tool: "code_read_big" });
  assert.deepEqual(bigLine.replies, [blockedCodeAnswer(["ai/aiops-mcp", "ai/agent-tag"])]);
  // 同样的报错出自别的工具（比如 MCP），不算查到文件
  const notCode = await ask(["src/legacy/user.ts 是个目录", "src/legacy/user.ts 是个目录"], { also: ["aiops_get_file"] });
  assert.equal(notCode.requests.length, 3);
  assert.deepEqual(notCode.replies, [blockedCodeAnswer(["ai/aiops-mcp", "ai/agent-tag"])]);

  // code_search 搜的是文件内容：没搜到这个路径，不能拿来说没有这个文件
  const notSearched = await ask(["实现在 src/legacy/user.ts 里", "仓库里不存在 src/legacy/user.ts"], { tool: "code_find" });
  assert.equal(notSearched.requests.length, 3);
  assert.deepEqual(notSearched.replies, [blockedCodeAnswer(["ai/aiops-mcp", "ai/agent-tag"])]);
  // 没搜到时结果里的分支和提交号照样算查到的
  const emptySearch = await ask(["查的是 master 分支 @ 1a2b3c4。没有找到 getUserCenterFromRemote。"]);
  assert.equal(emptySearch.requests.length, 2);
  assert.deepEqual(emptySearch.replies, ["查的是 master 分支 @ 1a2b3c4。没有找到 getUserCenterFromRemote。"]);

  // 结果里被截掉、模型没看到的路径不算查到
  const clipped = await ask(["入口在 src/index.ts，另外 src/hidden/tail.ts 里有初始化", "入口在 src/index.ts"], { tool: "code_list_files" });
  assert.equal(clipped.requests.length, 3);
  assert.match(String(clipped.requests[2].messages.at(-1)?.content), /src\/hidden\/tail\.ts/);
  assert.deepEqual(clipped.replies, ["入口在 src/index.ts"]);
});

test("代码工具的结果被截断时，切开的最后一行整行不算（文件名里可以有空格）", async () => {
  const output = "共 2 个文件（master 分支 @ 1a2b3c4）：\nsrc/index.ts\nsrc/foo.ts backup\nsrc/b.ts";
  const ask = async (limit: number, answers: string[]) => {
    const listFiles: Tool = {
      spec: { name: "code_list_files", description: "列文件", parameters: { type: "object", properties: {} } },
      describe: () => "列文件",
      maxOutputChars: limit,
      run: async () => output,
    };
    const results: ChatResult[] = [
      { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "code_list_files", arguments: "{}" }] },
      ...answers.map((text): ChatResult => ({ text, finish: "stop" })),
    ];
    const { model, requests } = fakeModel(() => results.shift()!);
    const { sent, handle } = setup({ model, taskTools: () => [listFiles], codeRepos: ["ai/aiops-mcp"] });
    await handle(message("ai/aiops-mcp 的入口在哪"));
    return { requests, replies: markdowns(sent) };
  };

  // 正好截在「src/foo.ts」后面，模型看到的像是一个完整的路径
  const cut = await ask(output.indexOf(" backup"), ["入口在 `src/index.ts`，配置在 `src/foo.ts`", "入口在 `src/index.ts`"]);
  assert.equal(cut.requests.length, 3);
  assert.match(String(cut.requests[2].messages.at(-1)?.content), /src\/foo\.ts/);
  assert.deepEqual(cut.replies, ["入口在 `src/index.ts`"]);
  // 正好截在换行处：最后一行是完整的，照样算
  const atNewline = await ask(output.indexOf("\nsrc/foo.ts"), ["入口在 `src/index.ts`"]);
  assert.equal(atNewline.requests.length, 2);
});

test("没读代码、也没问仓库时，重做后还写着举例的路径照常发出", async () => {
  const codeSearch: Tool = {
    spec: { name: "code_search", description: "搜代码", parameters: { type: "object", properties: {} } },
    describe: () => "搜代码",
    run: async () => "",
  };
  const results: ChatResult[] = [
    { text: "可以把配置写在 k8s/deployment.yaml 里", finish: "stop" },
    { text: "比如写在 k8s/deployment.yaml 里，用 envFrom 引用 ConfigMap", finish: "stop" },
  ];
  const { model, requests } = fakeModel(() => results.shift()!);
  const { sent, handle } = setup({ model, taskTools: () => [codeSearch], codeRepos: ["ai/aiops-mcp"] });
  await handle(message("K8s 里环境变量一般怎么配"));
  assert.equal(requests.length, 2);
  assert.deepEqual(markdowns(sent), ["比如写在 k8s/deployment.yaml 里，用 envFrom 引用 ConfigMap"]);
});
