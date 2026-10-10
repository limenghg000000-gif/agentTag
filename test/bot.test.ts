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
  DEFLECTED_ANSWER,
  reviewCodeAnswer,
  reviewDeflectedAnswer,
  reviewOpsAnswer,
  type ThreadContextSource,
  UNVERIFIED_CODE_ANSWER,
  unseenCodeAnswer,
  unverifiedCodeAnswer,
  unseenCodeCitations,
  unverifiedOpsAnswer,
} from "../src/bot.js";
import type { ImageRef, ThreadContext } from "../src/history.js";
import { UNREAD_IMAGE } from "../src/images.js";
import { type ChatMessage, type ChatModel, type ChatRequest, type ChatResult, LlmError } from "../src/llm.js";
import { compactText } from "../src/mcp-result.js";
import { MemoryStore } from "../src/memory.js";
import { STOP_ACTION } from "../src/progress.js";
import { TaskRegistry } from "../src/tasks.js";
import { type CodeLocation, type Tool, type ToolContext, ToolError, ToolOutputBuilder } from "../src/tools/tool.js";

const quiet = { info() {}, warn() {}, error() {} };

/** 假的代码工具结果：一行行文字和这一行里查到的代码位置，像 src/repo.ts 那样把代码位置交给 onFacts、文字交给模型 */
function codeResult(ctx: ToolContext, rows: Array<[string, ...CodeLocation[]]>, repo = "ai/aiops-mcp"): string {
  const out = new ToolOutputBuilder(repo);
  for (const [text, ...locations] of rows) {
    out.line(text, ...locations);
  }
  const { text, facts } = out.build();
  ctx.onFacts?.(facts);
  return text;
}

/** 代码工具记下的代码位置，当作一次工具调用查到的 */
function found(tool: string, locations: CodeLocation[], repo = "ai/aiops-mcp") {
  return { tool, facts: locations.map((location) => ({ ...location, repo, at: 0 })) };
}

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

test("模型返回了思考内容时，进度卡片上显示最新一段，结束后和步骤一起折叠；SHOW_THINKING=off 时不显示", async () => {
  const tool: Tool = {
    spec: { name: "lookup", description: "查资料", parameters: { type: "object", properties: {} } },
    describe: () => "查资料 A",
    run: async () => "资料内容",
  };
  const script = (): ChatResult[] => [
    { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "lookup", arguments: "{}" }], reasoning: "先查资料 A" },
    { text: "总结", finish: "stop", reasoning: "资料够了，可以总结" },
  ];

  let results = script();
  const shown = setup({ model: fakeModel(() => results.shift()!).model, tools: [tool] });
  await shown.handle(message("查一下"));
  assert.ok(shown.updates.some((u) => /最新的思考（第 1 轮.*先查资料 A/.test(cardText(u.card))));
  const final = shown.updates.at(-1)!.card;
  assert.deepEqual(
    final.body.elements[0].elements.map((e: any) => e.content.split("\n").at(-1)),
    ["💭 是模型的思考草稿，里面的猜测没有核实，结论以回答为准", "先查资料 A", "✔️ 查资料 A", "资料够了，可以总结"],
  );
  assert.deepEqual(markdowns(shown.sent), ["总结"]);

  results = script();
  const hidden = setup({ model: fakeModel(() => results.shift()!).model, tools: [tool], showThinking: false });
  await hidden.handle(message("查一下"));
  assert.ok(hidden.updates.length > 0);
  assert.ok(hidden.updates.every((u) => !/💭|先查资料/.test(cardText(u.card))));
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
    run: async (_args, ctx) =>
      codeResult(ctx, [
        ["共 1 处（aiops 分支 @ 9d8e7f6）：", { commit: "9d8e7f6" }],
        ["internal/k8s/tools.go:12: func GetPods()", { path: "internal/k8s/tools.go", lines: [12, 12] }],
      ]),
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
  assert.deepEqual(requests[1].messages.at(-1), { role: "user", content: unverifiedCodeAnswer(["src/index.ts:30"]) });
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
  // 截在 $ 前面：$ 也是路径字符，模型看到的 src/index.ts 是一个更长的路径的前半截
  const bundle = "Error: boom\n    at render (src/index.ts$chunk.js:5:3)";
  const cutBundle: Tool = {
    spec: { name: "aiops_get_bundle", description: "查打包后的堆栈", parameters: { type: "object", properties: {} } },
    describe: () => "aiops · 查打包后的堆栈",
    maxOutputChars: bundle.indexOf("$chunk"),
    run: async () => bundle,
  };
  // 截在 # 前面或者后面：# 后面接着更深的路径，模型看到的 src/index.ts 是 src/index.ts#v2/chunk.js 的前半截；
  // 后面只是锚点（#L5）时路径是完整的
  const hashed = "Error: boom\n    at render (src/index.ts#v2/chunk.js:5:3)";
  const cutTool = (name: string, output: string, limit: number): Tool => ({
    spec: { name, description: "查堆栈", parameters: { type: "object", properties: {} } },
    describe: () => "aiops · 查堆栈",
    maxOutputChars: limit,
    run: async () => output,
  });
  const cutHash = cutTool("aiops_get_hash", hashed, hashed.indexOf("#v2"));
  const cutAfterHash = cutTool("aiops_get_after_hash", hashed, hashed.indexOf("v2/"));
  const anchored = "Error: boom\n    see src/index.ts#L5 for render";
  const cutAnchor = cutTool("aiops_get_anchor", anchored, anchored.indexOf("#L5"));
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
      mcp: { names: ["aiops"], tools: () => [podLogs, longLogs, cutTrace, cutStack, cutBundle, cutHash, cutAfterHash, cutAnchor], prompt: () => undefined },
    });
    await handle(message("order-api 的 Pod 为什么重启"));
    return { requests, replies: markdowns(sent) };
  };

  const fromLogs = await ask(["空 map 写入，panic 在 `internal/logic/order.go:88`"]);
  assert.equal(fromLogs.requests.length, 2);
  assert.deepEqual(fromLogs.replies, ["空 map 写入，panic 在 `internal/logic/order.go:88`"]);

  const guessed = await ask(["panic 在 `internal/logic/order.go:88`，是 `internal/svc/context.go` 里没初始化", "panic 在 `internal/logic/order.go:88`"]);
  assert.equal(guessed.requests.length, 3);
  assert.deepEqual(guessed.requests[2].messages.at(-1), { role: "user", content: unverifiedCodeAnswer(["internal/svc/context.go"]) });
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
  const beforeDollar = await ask(["报错在 `src/index.ts` 里", "报错在 render 里"], "aiops_get_bundle");
  assert.equal(beforeDollar.requests.length, 3);
  assert.deepEqual(beforeDollar.replies, ["报错在 render 里"]);
  for (const tool of ["aiops_get_hash", "aiops_get_after_hash"]) {
    const beforeDeeper = await ask(["报错在 `src/index.ts` 里", "报错在 render 里"], tool);
    assert.equal(beforeDeeper.requests.length, 3, tool);
    assert.deepEqual(beforeDeeper.replies, ["报错在 render 里"], tool);
  }
  const beforeAnchor = await ask(["报错在 `src/index.ts` 里"], "aiops_get_anchor");
  assert.equal(beforeAnchor.requests.length, 2);
  assert.deepEqual(beforeAnchor.replies, ["报错在 `src/index.ts` 里"]);
});

test("aiops 结果里转义过的报错堆栈（\\n\\t/build/...）照样算查到：2026-10-10 转链排查的回答就是因为认不出被拦下的", async () => {
  const codeSearch: Tool = {
    spec: { name: "code_search", description: "搜代码", parameters: { type: "object", properties: {} } },
    describe: () => "搜代码",
    run: async () => "",
  };
  // Go 的报错堆栈：日志行里的换行、缩进是 JSON 转义（\n\t），整理 aiops 结果时又 JSON.stringify 一次，路径前面紧挨着 \t 的 t
  const stack =
    "get similar goods by channel fail\nyuebai-api-app/services/goods.(*TaoBao).similarGoods\n\t/build/services/goods/tb.go:8220 +0x5c4\n" +
    "yuebai-api-app/controller/convert.ConvertLink\n\t/build/controller/convert/convert_link.go:98 +0x1b4";
  const once = compactText(JSON.stringify({ logs: [{ msg: stack }] }));
  // 日志行本身是 JSON 字符串、aiops 原样返回时转义两层
  const twice = compactText(JSON.stringify({ logs: [{ line: JSON.stringify({ level: "error", content: stack }) }] }));
  assert.match(once, /\\n\\t\/build\/services\/goods\/tb\.go:8220/);
  assert.match(twice, /\\\\n\\\\t\/build\/services\/goods\/tb\.go:8220/);
  const ask = async (output: string, answers: string[]) => {
    const queryLogs: Tool = {
      spec: { name: "aiops_query_logs", description: "查日志", parameters: { type: "object", properties: {} } },
      describe: () => "aiops · 查日志",
      run: async () => output,
    };
    const results: ChatResult[] = [
      { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "aiops_query_logs", arguments: "{}" }] },
      ...answers.map((text): ChatResult => ({ text, finish: "stop" })),
    ];
    const { model, requests } = fakeModel(() => results.shift()!);
    const { sent, handle } = setup({
      model,
      taskTools: () => [codeSearch],
      codeRepos: ["ai/aiops-mcp"],
      mcp: { names: ["aiops"], tools: () => [queryLogs], prompt: () => undefined },
    });
    await handle(message("用户反馈转链失败，排查一下"));
    return { requests, replies: markdowns(sent) };
  };

  const answer = "同款推荐失败，报在 `services/goods/tb.go:8220`，是从 `controller/convert/convert_link.go:98` 调进来的";
  for (const output of [once, twice]) {
    const cited = await ask(output, [answer]);
    assert.equal(cited.requests.length, 2);
    assert.deepEqual(cited.replies, [answer]);
  }
  // 还原转义只是认出分界：行号对不上、堆栈里没有的文件照样打回
  for (const output of [once, twice]) {
    const wrong = await ask(output, ["报在 `services/goods/tb.go:8221`，`services/goods/jd.go` 也有", "报在 `services/goods/tb.go:8220`"]);
    assert.equal(wrong.requests.length, 3);
    assert.deepEqual(wrong.requests[2].messages.at(-1), {
      role: "user",
      content: unverifiedCodeAnswer(["services/goods/tb.go:8221", "services/goods/jd.go"]),
    });
    assert.deepEqual(wrong.replies, ["报在 `services/goods/tb.go:8220`"]);
  }
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

test("读剧本不算查过线上，剧本里举例的路径也不算证据；调过 aiops 的工具以后后面几轮打开思考", async () => {
  const playbook: Tool = {
    spec: { name: "aiops_playbook", description: "读剧本", parameters: { type: "object", properties: { name: { type: "string" } } } },
    instructionsOnly: true,
    describe: () => "aiops · 读剧本 转链",
    run: async () => "（以下是 aiops 服务端下发的剧本「convert_link」）转链服务 product-service-api 在 prod。崩溃堆栈例：/build/internal/cache/map.go:42",
  };
  const queryLogs: Tool = {
    spec: { name: "aiops_query_logs", description: "查日志", parameters: { type: "object", properties: {} } },
    describe: () => "aiops · 查日志",
    run: async () => '{"logs":[{"line":"isv.parse-result-invalid"}]}',
  };
  const results: ChatResult[] = [
    { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "aiops_playbook", arguments: '{"name":"convert_link"}' }] },
    // 只读了剧本就给出线上结论：打回重做
    { text: "结论：最近 1 小时转链失败 3 次，都是 isv.parse-result-invalid（把握：中）", finish: "stop" },
    { text: "", finish: "tool_calls", toolCalls: [{ id: "c2", name: "aiops_query_logs", arguments: "{}" }] },
    { text: "结论：这条链接返回 isv.parse-result-invalid，商品可能已下架（把握：中）", finish: "stop" },
  ];
  const { model, requests } = fakeModel(() => results.shift()!);
  const mcp = {
    names: ["aiops"],
    tools: () => [playbook, queryLogs],
    prompt: () => undefined,
    thinksAfter: (name: string) => name.startsWith("aiops_"),
  };
  const { sent, handle } = setup({ model, mcp });

  await handle(message("用户反馈转链失败，排查一下 https://c.tb.cn/h.8AYbSqZ7SeriAVy"));

  assert.equal(requests.length, 4);
  assert.deepEqual(requests[2].messages.at(-1), { role: "user", content: unverifiedOpsAnswer(["aiops"]) });
  assert.deepEqual(
    requests.map((req) => req.thinking),
    [undefined, true, true, true],
  );
  assert.deepEqual(markdowns(sent), ["结论：这条链接返回 isv.parse-result-invalid，商品可能已下架（把握：中）"]);
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

test("回答照抄了剧本里的核对记录（提交号）：打回时点名是哪处，去掉以后照常发出", async () => {
  // 2026-10-10 复测转链：剧本开头写着「按 golang/appservice 的 master，提交 fa02ac8 核对」，模型抄进了回答，整条被拦
  const queryLogs: Tool = {
    spec: { name: "aiops_query_logs", description: "查日志", parameters: { type: "object", properties: {} } },
    describe: () => "aiops · 查日志",
    run: async () => '{"logs":["淘口令生成：链接不符合规范"]}',
  };
  const results: ChatResult[] = [
    { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "aiops_query_logs", arguments: "{}" }] },
    { text: "淘宝返回「淘口令生成：链接不符合规范」（错误码表按 appservice 提交 fa02ac8 核对）", finish: "stop" },
    { text: "淘宝返回「淘口令生成：链接不符合规范」", finish: "stop" },
  ];
  const { model, requests } = fakeModel(() => results.shift()!);
  const { sent, handle } = setup({
    model,
    taskTools: () => [{ ...queryLogs, spec: { ...queryLogs.spec, name: "code_search" } }],
    codeRepos: ["ai/aiops-mcp"],
    mcp: { names: ["aiops"], tools: () => [queryLogs], prompt: () => undefined },
  });

  await handle(message("转链失败了，排查一下"));

  assert.equal(requests.length, 3);
  assert.match(requests[2].messages.at(-1)!.content, /引用了这些代码位置：fa02ac8.*去掉这几处，其余查到的结论照常写/);
  assert.deepEqual(markdowns(sent), ["淘宝返回「淘口令生成：链接不符合规范」"]);
});

test("回答被模型服务的内容审核拦下时，卡片上前面几轮的思考也去掉", async () => {
  const tool: Tool = {
    spec: { name: "lookup", description: "查资料", parameters: { type: "object", properties: {} } },
    describe: () => "查资料 A",
    run: async () => "资料内容",
  };
  const results: ChatResult[] = [
    { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "lookup", arguments: "{}" }], reasoning: "先查资料 A" },
    { text: "", finish: "filtered" },
  ];
  const { sent, updates, handle } = setup({ model: fakeModel(() => results.shift()!).model, tools: [tool] });

  await handle(message("查一下"));

  assert.match(markdowns(sent)[0], /内容审核拦下/);
  assert.doesNotMatch(cardText(updates.at(-1)!.card), /💭|先查资料 A/);
});

test("回答因为没查证被拦下时，卡片上的思考也去掉", async () => {
  const queryLogs: Tool = {
    spec: { name: "aiops_query_logs", description: "查日志", parameters: { type: "object", properties: {} } },
    describe: () => "aiops · 查日志",
    run: async () => '{"logs":[]}',
  };
  const results: ChatResult[] = [
    { text: "结论：gateway-api（prod）最近 1 小时没有 error 级别日志（把握：中）", finish: "stop", reasoning: "不用查，直接说没有报错" },
    { text: "结论：gateway-api（prod）最近 1 小时没有 error 级别日志（把握：中）", finish: "stop", reasoning: "还是不查了" },
  ];
  const { model } = fakeModel(() => results.shift()!);
  const { sent, updates, handle } = setup({ model, mcp: { names: ["aiops"], tools: () => [queryLogs], prompt: () => undefined } });

  await handle(message("prod"));

  assert.deepEqual(markdowns(sent), [BLOCKED_OPS_ANSWER]);
  // 被打回的那一轮的思考：打回紧跟在这一轮后面，卡片还没推出去就去掉了，过程中也不显示
  assert.ok(!updates.some((u) => /不用查/.test(cardText(u.card))));
  assert.doesNotMatch(cardText(updates.at(-1)!.card), /💭|不用查|还是不查了/);
});

test("引用了没查到的代码位置被拦下时，卡片上的思考也去掉", async () => {
  const codeSearch: Tool = {
    spec: { name: "code_search", description: "搜代码", parameters: { type: "object", properties: {} } },
    describe: () => "搜代码",
    run: async () => "没有结果",
  };
  const results: ChatResult[] = [
    { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "code_search", arguments: "{}" }], reasoning: "搜一下 user.go" },
    { text: "问题在 src/user.go:99", finish: "stop", reasoning: "多半是 src/user.go:99" },
    { text: "问题在 src/user.go:99", finish: "stop", reasoning: "就是 src/user.go:99" },
  ];
  const { model } = fakeModel(() => results.shift()!);
  const { sent, updates, handle } = setup({ model, tools: [codeSearch], codeRepos: ["ai/aiops-mcp"] });

  await handle(message("user 服务为什么报错"));

  assert.deepEqual(markdowns(sent), [blockedCodeAnswer(["ai/aiops-mcp"])]);
  assert.doesNotMatch(cardText(updates.at(-1)!.card), /💭|user\.go/);
});

test("打回重做以后通过了：被打回的那一轮的思考不留在卡片上，前面几轮的照样留", async () => {
  const codeSearch: Tool = {
    spec: { name: "code_search", description: "搜代码", parameters: { type: "object", properties: {} } },
    describe: () => "搜代码",
    run: async () => "没有结果",
  };
  const ask = async (rejected: ChatResult) => {
    const results: ChatResult[] = [
      { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "code_search", arguments: "{}" }], reasoning: "搜一下用户服务" },
      rejected,
      { text: "代码里没搜到相关的位置", finish: "stop", reasoning: "查不到就直说" },
    ];
    const { model } = fakeModel(() => results.shift()!);
    const { sent, updates, handle } = setup({ model, tools: [codeSearch], codeRepos: ["ai/aiops-mcp"] });
    await handle(message("user 服务为什么报错"));
    return { replies: markdowns(sent), updates };
  };

  const { replies, updates } = await ask({ text: "问题在 src/user.go:99", finish: "stop", reasoning: "多半是 src/user.go:99" });
  assert.deepEqual(replies, ["代码里没搜到相关的位置"]);
  const final = cardText(updates.at(-1)!.card);
  assert.match(final, /搜一下用户服务/);
  assert.match(final, /查不到就直说/);
  assert.doesNotMatch(final, /多半是/);
  // 被打回的那一轮没有思考时，不去动前面几轮的
  const quiet = await ask({ text: "问题在 src/user.go:99", finish: "stop" });
  assert.deepEqual(quiet.replies, ["代码里没搜到相关的位置"]);
  assert.match(cardText(quiet.updates.at(-1)!.card), /搜一下用户服务[\s\S]*查不到就直说/);
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

test("排查过以后把问题推到服务之外的结论，打回一次让模型先拿代码核对", () => {
  const review = (...names: string[]) => reviewDeflectedAnswer(["aiops"], new Set(names));
  const deflecting = [
    "淘宝拒绝了这个链接，不是服务故障，建议用户在商品详情页重新分享",
    "结论：并非服务端问题（把握：中）",
    "这不是我们的 bug，是淘宝平台限制",
    "服务本身没有问题",
    "属于淘宝平台的限制",
    "淘宝拒绝了这个链接，不过建议用户重新分享",
    "淘宝无法识别，建议用户换个链接再试",
    "属于用户侧问题",
    "这个无需修复",
    // 同一句里有举例的分句，说结论的分句照样算
    "示例链接被淘宝拒绝，不是服务故障",
  ];
  for (const answer of deflecting) {
    assert.equal(review("aiops_query_logs")(answer), DEFLECTED_ANSWER, answer);
    // 调过代码工具也算在排查，调用失败的也算
    assert.equal(review("code_search")(answer), DEFLECTED_ANSWER, answer);
    // 没排查过（没调工具、只调了群记忆）的不管，那是别的检查的事
    assert.equal(review()(answer), undefined, answer);
    assert.equal(review("memory_search")(answer), undefined, answer);
  }
  const fine = [
    // 看状态、没说到服务、说某条线索不是根因
    "gateway-api 现在没有异常，最近 1 小时错误率 0.1%",
    "这次 Pod 重启不是故障，是正常的滚动发布",
    "URL 解析失败那条 warn 不是故障原因，是同款推荐支路的连带报错",
    "这条报错不是服务问题所在，真正的原因在主流程",
    "不是系统故障导致的",
    // 排除外部原因、说是我们自己的问题
    "这不是淘宝平台限制，是我们解析 pages-fast 的 bug，要修代码",
    "不是用户侧的问题，是转链服务没处理这种链接",
    "不是代码问题，是配置里的超时设成了 1s，改配置就行",
    "问题在转链服务没处理 pages-fast 这种落地页，要修代码",
    // 否定、假设、修好以后让用户重试
    "修好以后不需要用户重新分享",
    "不建议让用户重新分享，应该在解析阶段识别",
    "除非服务故障，这个接口不会返回 code=8",
    "已修复并部署，通知用户重试即可",
    // 举例的分句
    "比如回答「不是服务故障」之前，要先搜代码",
  ];
  for (const answer of fine) {
    assert.equal(review("aiops_query_logs")(answer), undefined, answer);
  }
});

test("2026-10-10 转链排查那种回答：只看日志就说不是服务故障，和「没调代码工具」一起打回，重做后照常发", async () => {
  const codeSearch: Tool = {
    spec: { name: "code_search", description: "搜代码", parameters: { type: "object", properties: {} } },
    describe: () => "搜代码",
    run: async () => "",
  };
  const queryLogs: Tool = {
    spec: { name: "aiops_query_logs", description: "查日志", parameters: { type: "object", properties: {} } },
    describe: () => "aiops · 查日志",
    run: async () => JSON.stringify({ logs: [{ msg: "TaoBao CreatePassWord code params sub_code=26 链接不符合规范" }] }),
  };
  const first = "淘宝返回 sub_code 26，链接不符合规范。这不是服务故障，建议用户在商品详情页重新分享。";
  const second = "当时失败是淘宝拒绝了 pages-fast 半屏详情页链接；现在 master 的 tb.go 已经从 topIds 取商品 id，要看线上是否部署了这一版。";
  const results: ChatResult[] = [
    { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "aiops_query_logs", arguments: "{}" }] },
    { text: first, finish: "stop" },
    { text: second, finish: "stop" },
  ];
  const { model, requests } = fakeModel(() => results.shift()!);
  const { sent, handle } = setup({
    model,
    taskTools: () => [codeSearch],
    codeRepos: ["golang/appservice"],
    mcp: { names: ["aiops"], tools: () => [queryLogs], prompt: () => undefined },
  });

  await handle(message("用户反馈 appservice 转链失败，排查一下"));

  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].messages.at(-1), { role: "user", content: `${UNVERIFIED_CODE_ANSWER}\n${DEFLECTED_ANSWER}` });
  assert.deepEqual(markdowns(sent), [second]);
});

test("没有代码工具时不查推出去的结论：要模型去搜代码，它也搜不了", async () => {
  const queryLogs: Tool = {
    spec: { name: "aiops_query_logs", description: "查日志", parameters: { type: "object", properties: {} } },
    describe: () => "aiops · 查日志",
    run: async () => JSON.stringify({ logs: [{ msg: "sub_code=26 链接不符合规范" }] }),
  };
  const answer = "淘宝返回 sub_code 26，不是服务故障";
  const results: ChatResult[] = [
    { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "aiops_query_logs", arguments: "{}" }] },
    { text: answer, finish: "stop" },
  ];
  const { model, requests } = fakeModel(() => results.shift()!);
  const { sent, handle } = setup({ model, mcp: { names: ["aiops"], tools: () => [queryLogs], prompt: () => undefined } });

  await handle(message("用户反馈转链失败，排查一下"));

  assert.equal(requests.length, 2);
  assert.deepEqual(markdowns(sent), [answer]);
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

  assert.deepEqual(requests[1].messages.at(-1), { role: "user", content: `${unverifiedCodeAnswer(["internal/logic/order.go:88"])}\n${unverifiedOpsAnswer(["aiops"])}` });
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
  assert.equal(general("入口在 cmd/server/main.go", new Set(["web_search"])), unverifiedCodeAnswer(["cmd/server/main.go"]));
  // 和仓库无关的一般问题不管
  assert.equal(general("用 systemctl 重启，配置写在 tsconfig.json", new Set()), undefined);
  assert.equal(reviewCodeAnswer("今天周几", ["ai/api"])("周一，api 文档见 https://x.com/a/b.js", new Set()), undefined);
  // 文件和行号来自 aiops 查到的崩溃日志：只放过结果里真出现过的路径
  const logs = ["panic: nil map\n\tinternal/logic/order.go:88 +0x1d"];
  const seen = (path: string) => logs.some((output) => output.includes(path));
  const crash = reviewCodeAnswer("order-api 的 Pod 为什么重启", ["ai/aiops-mcp"], seen);
  assert.equal(crash("panic 在 internal/logic/order.go:88", new Set(["aiops_get_pod_logs"])), undefined);
  assert.equal(crash("panic 在 internal/logic/order.go:88，入口在 cmd/server/main.go", new Set(["aiops_get_pod_logs"])), unverifiedCodeAnswer(["cmd/server/main.go"]));
  assert.equal(crash("panic 在 internal/logic/order.go:88", new Set(["web_search"])), undefined);
  assert.equal(reviewCodeAnswer("order-api 的 Pod 为什么重启", ["ai/aiops-mcp"])("panic 在 internal/logic/order.go:88", new Set()), unverifiedCodeAnswer(["internal/logic/order.go:88"]));
  // 问的是配置的仓库，结果里出现过路径也不算读过代码
  const repoQuestion = reviewCodeAnswer("aiops-mcp 里 k8s 工具在哪定义", ["ai/aiops-mcp"], () => true);
  assert.equal(repoQuestion("在 internal/tools/k8s.go", new Set(["aiops_list_namespaces"])), UNVERIFIED_CODE_ANSWER);
});

test("代码回答检查：调过代码工具也要核对，回答里的文件、行号和提交号得在工具结果里出现过", () => {
  const seen = codeEvidence(["ai/aiops-mcp", "ai/agent-tag"], [found("code_search", [{ commit: "3f2a1c9" }, { path: "internal/k8s/tools.go", lines: [12, 12] }])]);
  const review = reviewCodeAnswer("k8s 工具在哪定义", ["ai/aiops-mcp", "ai/agent-tag"], seen);
  const searched = new Set(["code_search"]);
  assert.equal(review("定义在 `internal/k8s/tools.go:12`（master 分支 @ 3f2a1c9）", searched), undefined);
  // 写成「仓库名/路径」「./路径」也认
  assert.equal(review("在 ai/aiops-mcp/internal/k8s/tools.go 第 12 行", searched), undefined);
  assert.equal(review("在 ./internal/k8s/tools.go:12", searched), undefined);
  // 写明了仓库的，要是在这个仓库里查到的
  assert.equal(review("在 AI/AIOPS-MCP/internal/k8s/tools.go:12", searched), undefined);
  assert.equal(
    review("在 ai/agent-tag/internal/k8s/tools.go:12", searched),
    unseenCodeAnswer(["ai/agent-tag/internal/k8s/tools.go:12"], ["ai/aiops-mcp", "ai/agent-tag"]),
  );
  // 整段当路径找也只认写明的仓库：ai/agent-tag 里恰好有个 ai/aiops-mcp/src/foo.ts，不能当成 ai/aiops-mcp 里的 src/foo.ts；日志里写的照样认
  const nested = codeEvidence(["ai/aiops-mcp", "ai/agent-tag"], [found("code_list_files", [{ path: "ai/aiops-mcp/src/foo.ts" }], "ai/agent-tag")]);
  assert.equal(nested("ai/aiops-mcp/src/foo.ts"), false);
  assert.equal(nested("ai/agent-tag/ai/aiops-mcp/src/foo.ts"), true);
  const own = codeEvidence(["ai/aiops-mcp", "ai/agent-tag"], [found("code_list_files", [{ path: "src/foo.ts" }], "ai/aiops-mcp")]);
  assert.equal(own("ai/aiops-mcp/src/foo.ts"), true);
  // 仓库名互相包含时只按最长的那个算：team/backend 里的 api/src/x.ts 不能给 team/backend/api/src/x.ts 作证
  for (const repos of [
    ["team/backend", "team/backend/api"],
    ["team/backend/api", "team/backend"],
  ]) {
    const outer = codeEvidence(repos, [found("code_read_file", [{ path: "api/src/x.ts", lines: [3, 3] }], "team/backend")]);
    assert.equal(outer("team/backend/api/src/x.ts", 3), false, repos.join());
    assert.equal(outer("team/backend/api/src/x.ts"), false, repos.join());
    assert.equal(outer("team/backend/API/src/x.ts", 3), false, repos.join());
    assert.equal(outer("Team/Backend/api/src/x.ts", 3), false, repos.join());
    const inner = codeEvidence(repos, [found("code_read_file", [{ path: "src/x.ts", lines: [3, 3] }], "team/backend/api")]);
    assert.equal(inner("team/backend/api/src/x.ts", 3), true, repos.join());
    assert.equal(inner("team/backend/src/x.ts", 3), false, repos.join());
  }
  const logged = codeEvidence(["ai/aiops-mcp"], [{ tool: "aiops_query_logs", output: "caller=ai/aiops-mcp/src/foo.ts:3" }]);
  assert.equal(logged("ai/aiops-mcp/src/foo.ts", 3), true);
  // 分支名可以长得像路径：回答里明说是分支的，列出来的分支照样认，在哪个仓库列的就是哪个仓库的；分支没有行号，也不能给同名的文件作证
  const branched = codeEvidence(
    ["ai/aiops-mcp", "ai/agent-tag"],
    [found("code_branches", [{ branch: "feature/foo.ts" }], "ai/aiops-mcp"), found("code_list_files", [{ path: "src/a.ts" }], "ai/aiops-mcp")],
  );
  assert.equal(branched("feature/foo.ts", undefined, true), true);
  assert.equal(branched("ai/aiops-mcp/feature/foo.ts", undefined, true), true);
  assert.equal(branched("ai/agent-tag/feature/foo.ts", undefined, true), false);
  assert.equal(branched("feature/foo.ts"), false);
  assert.equal(branched("feature/foo.ts", 3, true), false);
  assert.equal(branched("src/a.ts", undefined, true), true);
  assert.equal(
    codeEvidence([], [{ tool: "aiops_query_logs", facts: [{ branch: "feature/foo.ts", repo: "ai/aiops-mcp", at: 0 }] }])("feature/foo.ts", undefined, true),
    false,
  );
  // 回答里写明是 Git 分支（前面写「切到」「checkout」「on branch」「分支：」，后面跟「分支」「branch」再接标点或「上」，或者「@ 提交号」）
  // 才按分支认；同名当文件讲的照样拦
  for (const answer of [
    "在 `feature/foo.ts` 分支上",
    "已切到 feature/foo.ts",
    "已切到分支 feature/foo.ts",
    "git checkout feature/foo.ts",
    "On branch feature/foo.ts",
    "branch: `feature/foo.ts`",
    "分支：feature/foo.ts",
    "看的是 **feature/foo.ts** 分支",
    "on the `feature/foo.ts` branch.",
    "the `feature/foo.ts` branch, not main",
    "feature/foo.ts @ 3f2a1c9 上没有改动",
  ]) {
    assert.deepEqual(unseenCodeCitations(answer, (text, line, branch) => branched(text, line, branch) || text === "3f2a1c9"), [], answer);
  }
  assert.deepEqual(unseenCodeCitations("`feature/foo.ts` 关掉了鉴权", branched), [{ text: "feature/foo.ts", located: false }]);
  // 说的是代码里的分支（分支覆盖率、分支逻辑、branch condition），不是 Git 分支
  for (const answer of [
    "`feature/foo.ts` 分支覆盖率为 0%",
    "feature/foo.ts 分支逻辑有问题",
    "`feature/foo.ts` branch coverage is 0%",
    "`feature/foo.ts` branch condition disables authentication",
    "the else branch feature/foo.ts disables authentication",
    "分支 feature/foo.ts 关掉了鉴权",
    "`feature/foo.ts` branch.go 里",
  ]) {
    assert.deepEqual(unseenCodeCitations(answer, branched), [{ text: "feature/foo.ts", located: false }], answer);
  }
  assert.deepEqual(unseenCodeCitations("切到 `feature/foo.ts:3`", branched), [{ text: "feature/foo.ts:3", located: true }]);
  // 文件是真的，行号是编的
  assert.equal(review("在 internal/k8s/tools.go:99", searched), unseenCodeAnswer(["internal/k8s/tools.go:99"], ["ai/aiops-mcp", "ai/agent-tag"]));
  // 2026-10-09：调了一次代码工具，回答里的仓库提交和文件都是编的
  const made = "code=8 是用户不存在（ai/agent-tag master @ 2c6a7d9，`yuebai-user/rpc/internal/logic/common/userlogic.go:35`）";
  assert.equal(
    review(made, searched),
    unseenCodeAnswer(["yuebai-user/rpc/internal/logic/common/userlogic.go:35", "2c6a7d9"], ["ai/aiops-mcp", "ai/agent-tag"]),
  );
  assert.match(unseenCodeAnswer(["a/b.go"], ["ai/aiops-mcp"]), /工具结果里都没有出现：a\/b\.go.*直说读不到这部分代码/);
  // 没调代码工具时也点名是哪几处，模型才知道去掉什么；只是提到了仓库、没写具体位置时还是原来那段
  assert.match(unverifiedCodeAnswer(["fa02ac8", "a/b.go:3"]), /引用了这些代码位置：fa02ac8、a\/b\.go:3.*剧本和使用说明里写的文件路径、提交号.*去掉这几处，其余查到的结论照常写/);
  assert.equal(unverifiedCodeAnswer([]), UNVERIFIED_CODE_ANSWER);
  // 群成员在提问里写的路径不算查证：没读代码就照着提问讲，照样要先读
  assert.equal(reviewCodeAnswer("src/foo.ts:10 是干嘛的", ["ai/aiops-mcp"], seen)("src/foo.ts:10 是初始化配置", new Set()), unverifiedCodeAnswer(["src/foo.ts:10"]));
});

test("代码引用按行认：搜索结果、报错堆栈里的「路径:行号」，读文件时读到的那一行", () => {
  const seen = codeEvidence(
    [],
    [
      found("code_read_file", [{ path: "src/app.ts" }, { path: "src/app.ts", lines: [1, 1] }, { path: "src/app.ts", lines: [35, 35] }]),
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
  // 行号写在反引号、加粗、引号外面的，照样按行认
  for (const answer of ["见 `src/app.ts`:60", "见 **src/app.ts**:60", "见 `src/app.ts`#L60", "见 `src/app.ts` 第 60 行", "见「src/app.ts」第 60 行"]) {
    assert.deepEqual(unseenCodeCitations(answer, seen), [{ text: "src/app.ts:60", located: true }], answer);
  }
  assert.deepEqual(unseenCodeCitations("见 `src/app.ts`:35", seen), []);
  // 收尾符号后面不是行号的，只是路径
  assert.deepEqual(unseenCodeCitations("见 `src/app.ts`，`src/other.ts`:3", seen), [{ text: "src/other.ts:3", located: true }]);
  assert.deepEqual(unseenCodeCitations("见 `src/app.ts`：入口", seen), []);
});

test("代码引用的路径要整段对上，改文件记下的行也认", () => {
  const seen = codeEvidence(
    [],
    [
      found("code_list_files", [{ commit: "3f2a1c9" }, { path: "src/index.tsx" }, { path: "pkg/mysrc/util.ts" }, { path: "src/app.ts.map" }]),
      found("code_search", [{ path: "pkg/src/nested.ts", lines: [12, 12] }]),
      found("code_edit_file", [{ path: "src/foo.ts", lines: [10, 10] }]),
      found("code_edit_file", [{ path: "src/util/new.ts", lines: [1, 12] }]),
      { tool: "aiops_query_logs", output: "goroutine 1 [running]:\n/app/internal/logic/order.go:88 +0x1d" },
      { tool: "aiops_query_logs", output: "Error: boom\n    at start (/app/src/server.ts:12:5)" },
      { tool: "aiops_query_logs", output: "caller=./internal/svc/ctx.go:21" },
      { tool: "aiops_query_logs", output: "panic: boom\n/go/pkg/mod/github.com/!acme/svc@v1.2.3/internal/repo/user.go:42 +0x1d" },
      { tool: "aiops_query_logs", output: "Error: boom\n    at f (/app/node_modules/.pnpm/@acme+web@1.0.0/node_modules/@acme/web/lib/handler.js:7:3)" },
      { tool: "aiops_query_logs", output: "caller=vendor/svc@v1.2.3/internal/repo/order.go:9" },
      { tool: "aiops_query_logs", output: "at vendor/pkg@src/glued.ts:10 and vendor/pkg+lib/glued.go:3 and mod/!x!lib/glued.py:4" },
      { tool: "aiops_query_logs", output: "loaded src/tail.ts@v2 and src/tail.go+x, then failed in src/end.ts!" },
      { tool: "aiops_query_logs", output: "at pkg$src/dollar.ts:10 and vendor\\lib/back.go:3 and x%2Flib/pct.py:4 and src/last.ts$ and src/q.ts?" },
      { tool: "aiops_query_logs", output: "at pkg#src/hash.ts:10 and x;(lib/semi.go:3 and src/gl.ts#v2/chunk.js and src/gl2.ts#(v2/chunk.js and files=src/c1.ts,src/c2.ts and call(/app/src/call.ts:8) and call(./src/dot.ts:6)" },
      { tool: "aiops_query_logs", output: "see src/anchor.ts#L3, caller=src/eq.ts:5, boom (src/paren.ts:7) and 'src/quoted.ts':2\n#0 /var/www/src/a.php(12): foo()" },
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
  // 绝对路径前面的目录名里有 @、+、! 的（Go 模块缓存、pnpm）照样认；不是绝对路径的，前面多一段照样不认
  assert.equal(seen("internal/repo/user.go", 42), true);
  assert.equal(seen("lib/handler.js", 7), true);
  assert.equal(seen("internal/repo/order.go"), false);
  assert.equal(seen("internal/repo/order.go", 9), false);
  // 前面紧挨着 @、+、! 的也是更长的路径的后半截
  assert.equal(seen("src/glued.ts", 10), false);
  assert.equal(seen("lib/glued.go", 3), false);
  assert.equal(seen("lib/glued.py", 4), false);
  // 后面紧挨着 @、+ 的也不是这个文件；句末的叹号是标点
  assert.equal(seen("src/tail.ts"), false);
  assert.equal(seen("src/tail.go"), false);
  assert.equal(seen("src/end.ts"), true);
  // 别的字符（$、\、%）也一样：不在分界字符里的都算路径的一部分；句末的问号是标点
  assert.equal(seen("src/dollar.ts", 10), false);
  assert.equal(seen("lib/back.go", 3), false);
  assert.equal(seen("lib/pct.py", 4), false);
  assert.equal(seen("src/last.ts"), false);
  assert.equal(seen("src/q.ts"), true);
  // 夹在路径字符中间的 # ; , ( 也是路径的一部分：前面紧挨着的是更长的路径的后半截，后面接着更深的路径的是前半截，x(/app/... 不是绝对路径
  assert.equal(seen("src/hash.ts", 10), false);
  assert.equal(seen("src/hash.ts"), false);
  assert.equal(seen("lib/semi.go", 3), false);
  assert.equal(seen("src/gl.ts"), false);
  assert.equal(seen("src/gl2.ts"), false);
  assert.equal(seen("src/c1.ts"), false);
  assert.equal(seen("src/c2.ts"), false);
  assert.equal(seen("src/call.ts", 8), false);
  assert.equal(seen("src/dot.ts", 6), false);
  // 不夹在中间的照样是分界：锚点、等号、括号、引号、PHP 堆栈的 (12)
  assert.equal(seen("src/anchor.ts"), true);
  assert.equal(seen("src/eq.ts", 5), true);
  assert.equal(seen("src/paren.ts", 7), true);
  assert.equal(seen("src/quoted.ts"), true);
  assert.equal(seen("src/a.php"), true);
  // 提交号可以只写前几位，不能在查到的后面再编几位
  const commit = codeEvidence([], [found("code_search", [{ commit: "3f2a1c9d8e7b" }])]);
  assert.equal(commit("3f2a1c9"), true);
  assert.equal(commit("3f2a1c9d8e7b"), true);
  assert.equal(commit("3f2a1c9d8e7bdeadbeef"), false);
  // 提交号前面同一句话里写着仓库名的，只认这个仓库里查到的提交；离提交号最近的那个仓库名算数
  const scoped = codeEvidence(["ai/aiops-mcp", "ai/agent-tag"], [found("code_search", [{ commit: "3f2a1c9" }], "ai/aiops-mcp")]);
  for (const answer of [
    "ai/agent-tag master @ 3f2a1c9",
    "AI/Agent-Tag 的 master 分支 @ 3f2a1c9",
    "ai/agent-tag/internal 在 master @ 3f2a1c9 上",
    "在 ai/agent-tag 里查到，提交 3f2a1c9",
    "ai/aiops-mcp 查完了。ai/agent-tag 在 master @ 3f2a1c9",
    "ai/aiops-mcp 里查到了，ai/agent-tag 在 master @ 3f2a1c9",
    // pkg#ai/aiops-mcp 不是仓库名 ai/aiops-mcp，离提交号最近的仓库名还是 ai/agent-tag
    "ai/agent-tag 里查到了，pkg#ai/aiops-mcp 在 master @ 3f2a1c9",
    // 仓库名后面紧挨着的括号是写分支，照样只认这个仓库里的提交
    "ai/agent-tag(master) @ 3f2a1c9",
    // 仓库名写在提交号后面的也算；提交号所在的这一小句里写着的，比整句里别处写着的优先
    "commit 3f2a1c9 in ai/agent-tag",
    "提交 3f2a1c9 在 ai/agent-tag 上",
    "master @ 3f2a1c9（ai/agent-tag）",
    "ai/aiops-mcp 里没找到，提交 3f2a1c9 在 ai/agent-tag 上",
    "提交 3f2a1c9 改了登录逻辑，在 ai/agent-tag 里",
  ]) {
    assert.deepEqual(unseenCodeCitations(answer, scoped), [{ text: "3f2a1c9", located: true }], answer);
  }
  for (const answer of [
    "ai/aiops-mcp master @ 3f2a1c9",
    "master @ 3f2a1c9",
    "ai/agent-tag 和 ai/aiops-mcp 都看了，aiops 在 master @ 3f2a1c9",
    "ai/agent-tag 查完了。master @ 3f2a1c9",
    "ai/agent-tagger @ 3f2a1c9",
    "commit 3f2a1c9 in ai/aiops-mcp",
    "ai/aiops-mcp master @ 3f2a1c9，和 ai/agent-tag 不一样",
    "ai/aiops-mcp master @ 3f2a1c9 而 ai/agent-tag 没改",
    "提交 3f2a1c9 在 ai/aiops-mcp 上。ai/agent-tag 没改",
    "commit 3f2a1c9 in ai/aiops-mcp and ai/agent-tag",
    "ai/aiops-mcp 里，提交 3f2a1c9 没问题，ai/agent-tag 也看了",
    "提交 3f2a1c9 改了登录。ai/agent-tag 没改",
    "提交 3f2a1c9 改了登录，ai/aiops-mcp 和 ai/agent-tag 都要合",
  ]) {
    assert.deepEqual(unseenCodeCitations(answer, scoped), [], answer);
  }
  // 文件名里真有反斜杠的按原样认；写成 Windows 的反斜杠的，当成 / 也认
  const slashes = codeEvidence([], [found("code_list_files", [{ path: "src/foo\\bar.ts" }, { path: "internal/k8s/client.go" }])]);
  assert.deepEqual(unseenCodeCitations("见 `src/foo\\bar.ts` 和 internal/k8s\\client.go", slashes), []);
  assert.deepEqual(unseenCodeCitations("见 src/foo/bar.ts", slashes), [{ text: "src/foo/bar.ts", located: false }]);
});

test("代码引用：反引号里带空格的路径按整段认，读起来是命令的里面的路径一个个认", () => {
  const seen = codeEvidence(
    [],
    [
      found("code_read_file", [{ path: "src/my files/app.ts" }, { path: "src/my files/app.ts", lines: [2, 2] }]),
      found("code_diff", [{ path: "src/a.ts" }, { path: "src/c.ts" }, { path: "cmd/main.go" }, { path: "etc/user.yaml" }]),
    ],
  );
  // 整段查到过的按整段认；同一个整段写了没查到的行号，整段报出来，不只报空格后面那段
  assert.deepEqual(unseenCodeCitations("在 `src/my files/app.ts:2`", seen), []);
  assert.deepEqual(unseenCodeCitations("在 `src/my files/app.ts:3`", seen), [{ text: "src/my files/app.ts:3", located: true }]);
  assert.deepEqual(unseenCodeCitations("在 files/app.ts 和 `files/app.ts`", seen), [{ text: "files/app.ts", located: false }]);
  // 只查到 files/app.ts：前面编了一段带空格的目录，不能拿空格后面那段充数
  const suffix = codeEvidence([], [found("code_read_file", [{ path: "files/app.ts" }, { path: "files/app.ts", lines: [2, 2] }])]);
  assert.deepEqual(unseenCodeCitations("在 `src/my files/app.ts:2`", suffix), [{ text: "src/my files/app.ts:2", located: true }]);
  assert.deepEqual(unseenCodeCitations("在 `files/app.ts:2`", suffix), []);
  // 词之间连着几个空格、制表符、全角空格的一样按整段认
  for (const path of ["src/my  files/app.ts", "src/my\tfiles/app.ts", "src/my\u3000files/app.ts", "src/my \u00a0files/app.ts"]) {
    assert.deepEqual(unseenCodeCitations(`在 \`${path}:2\``, suffix), [{ text: `${path}:2`, located: true }], JSON.stringify(path));
  }
  // 行号写成全角冒号、#L、「第 N 行」的一样按整段认
  for (const cite of ["src/my files/app.ts：2", "src/my files/app.ts#L2", "src/my files/app.ts 第 2 行", "src/my files/app.ts 的第 2 行"]) {
    assert.deepEqual(unseenCodeCitations(`在 \`${cite}\``, suffix), [{ text: "src/my files/app.ts:2", located: true }], cite);
  }
  assert.deepEqual(unseenCodeCitations("在 `src/my files/app.ts`:2", suffix), [{ text: "src/my files/app.ts:2", located: true }]);
  // 加粗、引号里的一样按整段认
  for (const answer of [
    "在 **src/my files/app.ts**:2",
    "在 **src/my files/app.ts:2**",
    '在 "src/my files/app.ts":2',
    "在 “src/my files/app.ts”:2",
    "在「src/my files/app.ts」第 2 行",
    "在『src/my files/app.ts』:2",
  ]) {
    assert.deepEqual(unseenCodeCitations(answer, suffix), [{ text: "src/my files/app.ts:2", located: true }], answer);
  }
  // 加粗的中文句子里的路径照常一个个认：汉字不算路径
  assert.deepEqual(unseenCodeCitations("**改了 src/a.ts 和 src/c.ts**", seen), []);
  // 换行不算：代码块的语言名和下一行的路径（```ts 换行 files/app.ts:2）不是一个路径
  assert.deepEqual(unseenCodeCitations("```ts\nfiles/app.ts:2\n```", suffix), []);
  // 整段里带 @、+、! 的一样按整段认
  for (const path of ["pkg@v1/my files/app.ts", "lib/@acme+web/my files/app.ts", "github.com/!acme/my files/app.ts", "pkg#v1/my files/app.ts", "app/(auth)/my files/app.ts"]) {
    assert.deepEqual(unseenCodeCitations(`在 \`${path}:2\``, suffix), [{ text: `${path}:2`, located: true }], path);
  }
  const special = codeEvidence([], [found("code_read_file", [{ path: "pkg@v1/my files/app.ts", lines: [2, 2] }])]);
  assert.deepEqual(unseenCodeCitations("在 `pkg@v1/my files/app.ts:2`", special), []);
  // 不带行号的也按整段认：只查到 files/app.ts、dir/app.ts，不能拿来给编出来的整段作证
  for (const answer of ["`src/my files/app.ts` 里有 bug", "**src/my files/app.ts** 里有 bug", '"src/my files/app.ts" 里有 bug', "`my dir/app.ts` 里有 bug", "`src/go dir/app.ts` 里有 bug"]) {
    const path = /[`*"]+([^`*"]+)/.exec(answer)![1];
    assert.deepEqual(unseenCodeCitations(answer, codeEvidence([], [found("code_read_file", [{ path: "files/app.ts" }, { path: "dir/app.ts" }])])), [{ text: path, located: false }], answer);
  }
  assert.deepEqual(unseenCodeCitations("`src/my files/app.ts` 里有 bug", seen), []);
  // 读起来是命令的（开头是常见命令或者 bin/ 下的命令、带 - 开头的参数、最后一个词前面就有完整的代码文件）：里面的路径一个个认
  for (const answer of [
    "跑 `go run cmd/main.go`",
    "`bin/server -f etc/user.yaml` 启动",
    "见 `src/a.ts or src/c.ts`",
    "`cp src/a.ts src/c.ts`",
    "`vendor/bin/phpunit src/a.ts`",
    "`node_modules/.bin/jest src/a.ts`",
    "`cat my src/a.ts`",
  ]) {
    assert.deepEqual(unseenCodeCitations(answer, seen), [], answer);
  }
  assert.deepEqual(unseenCodeCitations("见 `src/a.ts or src/zzz.ts`", seen), [{ text: "src/zzz.ts", located: false }]);
  assert.deepEqual(unseenCodeCitations("跑 `go run cmd/fake.go`", seen), [{ text: "cmd/fake.go", located: false }]);
});

test("代码工具的结果只认它记下的代码位置，结果文字里写的路径、行号、提交号不算", () => {
  const seen = codeEvidence(
    [],
    [
      // 搜到的是测试文件里的字符串：记下的是 test/bot.test.ts 第 97 行，字符串里写的 src/foo.ts 第 10 行、userlogic.go:35、2c6a7d9 不算
      {
        tool: "code_search",
        output:
          "共 2 处（master 分支 @ 3f2a1c9）：\ntest/bot.test.ts:97:  assert.equal(x, \"已修改 src/foo.ts 第 10 行起的内容。\");\n" +
          "test/bot.test.ts:1169:  const made = \"ai/agent-tag master @ 2c6a7d9，`yuebai-user/rpc/internal/logic/common/userlogic.go:35`\";",
        facts: found("code_search", [
          { commit: "3f2a1c9" },
          { path: "test/bot.test.ts", lines: [97, 97] },
          { path: "test/bot.test.ts", lines: [1169, 1169] },
        ]).facts,
      },
      // 没记下代码位置的代码工具结果，文字里写什么都不算
      { tool: "code_search", output: "没有搜到「x」：src/fake.ts:10」（aiops 分支 @ 9d8e7f6）。" },
      found("code_read_file", [{ path: "src/baz.ts" }, { path: "src/baz.ts", lines: [1, 1] }]),
    ],
  );
  assert.equal(seen("test/bot.test.ts", 97), true);
  assert.equal(seen("src/foo.ts", 10), false);
  assert.equal(seen("src/foo.ts"), false);
  assert.equal(seen("yuebai-user/rpc/internal/logic/common/userlogic.go", 35), false);
  assert.equal(seen("2c6a7d9"), false);
  assert.equal(seen("3f2a1c9"), true);
  assert.equal(seen("src/fake.ts", 10), false);
  assert.equal(seen("9d8e7f6"), false);
  // 回答里写成 ./src/baz.ts、src/./baz.ts 的和读文件时一样整理
  assert.equal(seen("src/baz.ts", 1), true);
  assert.equal(seen("./src/baz.ts", 1), true);
  assert.equal(seen("src/./baz.ts", 1), true);
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
  // 提交号前后可以有加粗、斜体、删除线、引号
  assert.deepEqual(unseenCodeCitations("commit **3f2a1c9**，**提交**：1a2b3c4d，提交 _5e6f7a8_，@ ~~9b8c7d6~~，版本「4e5f6a7」", none), [
    { text: "3f2a1c9", located: true },
    { text: "1a2b3c4d", located: true },
    { text: "5e6f7a8", located: true },
    { text: "9b8c7d6", located: true },
    { text: "4e5f6a7", located: true },
  ]);
  // 中文紧挨着的、加粗的、写在等号后面的路径照样认；网址里的、.ts.map 这类不是代码文件的不认
  assert.deepEqual(unseenCodeCitations("问题在internal/logic/userlogic.go:35，见**rpc/x.go:3**，caller=src/a.ts", none), [
    { text: "internal/logic/userlogic.go:35", located: true },
    { text: "rpc/x.go:3", located: true },
    { text: "src/a.ts", located: false },
  ]);
  assert.deepEqual(unseenCodeCitations("https://lab.example.com/ai/agent-tag/-/blob/master/src/bot.ts#L12 和 dist/a.ts.map", none), []);
  // 路径里的 @、+、! 是路径的一部分，整段认，不拿后半截充数；后面紧挨着 @ 的不是代码文件，家目录下的文件不认，句末的叹号是标点
  assert.deepEqual(unseenCodeCitations("读了 `pkg@v1/src/foo.ts:9`，见 github.com/!acme/svc@v1.2.3/internal/x.go，还有 lib/@acme+web/a.js", none), [
    { text: "pkg@v1/src/foo.ts:9", located: true },
    { text: "github.com/!acme/svc@v1.2.3/internal/x.go", located: false },
    { text: "lib/@acme+web/a.js", located: false },
  ]);
  assert.deepEqual(unseenCodeCitations("`src/foo.ts@backup`，编辑 ~/.config/x.yaml 或 ~deploy/conf/app.yaml、~deploy#v1/conf/app.yaml", none), []);
  assert.deepEqual(unseenCodeCitations("注意 src/a.ts!", none), [{ text: "src/a.ts", located: false }]);
  // 不一个个列路径字符：$、\、% 这些也算在路径里，整段认
  const tail = codeEvidence([], [found("code_read_file", [{ path: "v1/src/foo.ts", lines: [9, 9] }])]);
  assert.deepEqual(unseenCodeCitations("读了 `pkg$v1/src/foo.ts:9`、pkg\\v1/src/foo.ts:9 和 pkg%v1/src/foo.ts:9", tail), [
    { text: "pkg$v1/src/foo.ts:9", located: true },
    { text: "pkg\\v1/src/foo.ts:9", located: true },
    { text: "pkg%v1/src/foo.ts:9", located: true },
  ]);
  assert.deepEqual(unseenCodeCitations("见 v1/src/foo.ts:9", tail), []);
  // Git 文件名里可以有 # ; , ' 和括号：夹在路径字符中间时是路径的一部分，整段认，不拿后半截充数
  // 连着几个的也一样（pkg##v1/src/foo.ts）
  assert.deepEqual(unseenCodeCitations("读了 `pkg#v1/src/foo.ts:9`、pkg##v1/src/foo.ts:9、pkg;v1/src/foo.ts:9、pkg,v1/src/foo.ts:9、pkg'v1/src/foo.ts:9、pkg{v1}/src/foo.ts:9 和 x(v1/src/foo.ts:9", tail), [
    { text: "pkg#v1/src/foo.ts:9", located: true },
    { text: "pkg##v1/src/foo.ts:9", located: true },
    { text: "pkg;v1/src/foo.ts:9", located: true },
    { text: "pkg,v1/src/foo.ts:9", located: true },
    { text: "pkg'v1/src/foo.ts:9", located: true },
    { text: "pkg{v1}/src/foo.ts:9", located: true },
    { text: "x(v1/src/foo.ts:9", located: true },
  ]);
  // 不夹在路径字符中间的照样是分界；= 和 : 一直是分界
  assert.deepEqual(
    unseenCodeCitations("见 (v1/src/foo.ts:9)、'v1/src/foo.ts:9'、v1/src/foo.ts#L9、[v1/src/foo.ts:9]、v1/src/foo.ts:9, v1/src/foo.ts:9; caller=v1/src/foo.ts:9", tail),
    [],
  );
  // 后面紧挨着的 # , 接着更深的路径的，是一个更长的路径：整段认
  assert.deepEqual(unseenCodeCitations("见 v1/src/foo.ts#v2/x.ts:9 和 v1/src/foo.ts,v1/src/bar.ts", tail), [
    { text: "v1/src/foo.ts#v2/x.ts:9", located: true },
    { text: "v1/src/foo.ts,v1/src/bar.ts", located: false },
  ]);
  // Next.js 的路由目录整段认
  assert.deepEqual(unseenCodeCitations("改 app/(auth)/login/page.tsx、`app/[id]/page.tsx:3` 和 app/[[...slug]]/page.tsx", none), [
    { text: "app/(auth)/login/page.tsx", located: false },
    { text: "app/[id]/page.tsx:3", located: true },
    { text: "app/[[...slug]]/page.tsx", located: false },
  ]);
  const routes = codeEvidence([], [found("code_read_file", [{ path: "app/(auth)/login/page.tsx", lines: [3, 3] }])]);
  assert.deepEqual(unseenCodeCitations("见 `app/(auth)/login/page.tsx:3`", routes), []);
  // Markdown 的下划线、删除线包着的路径：两头一样的一对符号不算路径的一部分
  assert.deepEqual(unseenCodeCitations("见 _src/missing.ts_:10、__src/bold.ts__、~~src/old.ts~~:3 和 _src/my files/app.ts_", none), [
    { text: "src/missing.ts:10", located: true },
    { text: "src/bold.ts", located: false },
    { text: "src/old.ts:3", located: true },
    { text: "src/my files/app.ts", located: false },
  ]);
  const wrapped = codeEvidence([], [found("code_read_file", [{ path: "src/missing.ts", lines: [10, 10] }, { path: "__tests__/a.test.ts" }, { path: "cmd/main.go" }])]);
  assert.deepEqual(unseenCodeCitations("见 _src/missing.ts_:10，__tests__/a.test.ts 也看了", wrapped), []);
  // 前面紧挨着路径字符的、两头不成对的不是包着的符号；包着的命令里的路径一个个认
  assert.deepEqual(unseenCodeCitations("见 x_src/fake.ts_:10、_src/fake.ts__ 和 __src/fake.ts_", none), []);
  assert.deepEqual(unseenCodeCitations("跑 _go run cmd/main.go_ 和 _go run cmd/fake.go_", wrapped), [{ text: "cmd/fake.go", located: false }]);
  // 紧挨着汉字、全角标点、符号、emoji 的照样认出来；句末的省略号、问号是标点
  assert.deepEqual(unseenCodeCitations("见v1/src/foo.ts:9，（v1/src/foo.ts:9）→v1/src/foo.ts:9 👉v1/src/foo.ts:9 •v1/src/foo.ts:9", tail), []);
  assert.deepEqual(unseenCodeCitations("见v1/src/bar.ts:9 👉v1/src/baz.ts 是 v1/src/qux.ts? 还有 v1/src/end.ts...", tail), [
    { text: "v1/src/bar.ts:9", located: true },
    { text: "v1/src/baz.ts", located: false },
    { text: "v1/src/qux.ts", located: false },
    { text: "v1/src/end.ts", located: false },
  ]);
});

test("调过代码工具还编出仓库里没有的文件：打回重做，重做后还编就不发出", async () => {
  const codeSearch: Tool = {
    spec: { name: "code_search", description: "搜代码", parameters: { type: "object", properties: {} } },
    describe: () => "搜代码",
    run: async (_args, ctx) => codeResult(ctx, [["没有搜到「getUserCenterFromRemote」（master 分支 @ 1a2b3c4）。", { commit: "1a2b3c4" }]]),
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
    run: async (_args, ctx) =>
      codeResult(ctx, [
        ["共 2 个文件（master 分支 @ 1a2b3c4）：", { commit: "1a2b3c4" }],
        ["src/index.ts", { path: "src/index.ts" }],
        ["x".repeat(60)],
        ["src/hidden/tail.ts", { path: "src/hidden/tail.ts" }],
      ]),
  };
  const readBig: Tool = {
    spec: { name: "code_read_big", description: "读大文件", parameters: { type: "object", properties: {} } },
    describe: () => "读大文件",
    run: async () => {
      throw new ToolError("src/generated.ts 有 2048 KB，太大了不读，用 code_search 搜需要的部分", [{ repo: "ai/aiops-mcp", path: "src/generated.ts", at: 0 }]);
    },
  };
  const searchPath: Tool = {
    spec: { name: "code_find", description: "按路径搜", parameters: { type: "object", properties: {} } },
    describe: () => "按路径搜",
    run: async () => "没有搜到「src/legacy/user.ts」（master 分支 @ 1a2b3c4）。",
  };
  // 不是代码工具：报错里带着代码位置也不算查到这个文件
  const otherTool: Tool = {
    spec: { name: "aiops_get_file", description: "别的工具", parameters: { type: "object", properties: {} } },
    describe: () => "别的工具",
    run: async () => {
      throw new ToolError("src/legacy/user.ts 是目录", [{ repo: "ai/aiops-mcp", path: "src/legacy/user.ts", at: 0 }]);
    },
  };
  const made =
    "结论：code=8 是 user-rpc 定义的「用户不存在」（把握：高）。依据：ai/agent-tag master @ 2c6a7d9，`yuebai-user/rpc/internal/logic/common/userlogic.go:35`";
  const ask = async (
    answers: string[],
    {
      question = "去 gateway-api 和 user-rpc 服务代码去排查一下",
      tool = "code_search",
      also = [] as string[],
      repos = ["ai/aiops-mcp", "ai/agent-tag"],
    } = {},
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
      codeRepos: repos,
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
  for (const question of [
    "ai/aiops-mcp/src/legacy/user.ts 第 10 行是干嘛的",
    "AI/AIOPS-MCP/src/legacy/user.ts 第 10 行是干嘛的",
    // 前面带 ./ 或 / 的也是仓库开头，和回答里的写法一样整理
    "./ai/aiops-mcp/src/legacy/user.ts 第 10 行是干嘛的",
    "/ai/aiops-mcp/src/legacy/user.ts 第 10 行是干嘛的",
    // 前面的括号不夹在路径字符中间，是分界
    "(ai/aiops-mcp/src/legacy/user.ts 第 10 行)是干嘛的",
  ]) {
    const prefixed = await ask([missing, missing], { question, tool: "code_read_file" });
    assert.equal(prefixed.requests.length, 3, question);
    assert.deepEqual(prefixed.replies, [missing], question);
  }
  // 仓库名要在路径开头才去掉：vendor/ai/aiops-mcp/src/legacy/user.ts 不是这个仓库里的 src/legacy/user.ts
  for (const question of [
    "vendor/ai/aiops-mcp/src/legacy/user.ts 第 10 行是干嘛的",
    "node_modules/@ai/aiops-mcp/src/legacy/user.ts 第 10 行是干嘛的",
    // 只去掉开头的一个仓库名：去掉 ai/aiops-mcp/ 以后露出来的 ai/agent-tag/ 不再去掉
    "ai/aiops-mcp/ai/agent-tag/src/legacy/user.ts 第 10 行是干嘛的",
    // 前面紧挨着的不管是什么路径字符（\、$），仓库名都不在路径开头
    "vendor\\ai/aiops-mcp/src/legacy/user.ts 第 10 行是干嘛的",
    "pkg$ai/aiops-mcp/src/legacy/user.ts 第 10 行是干嘛的",
    // Git 文件名里的 # ; , 和括号夹在路径字符中间时也是路径的一部分
    "pkg#ai/aiops-mcp/src/legacy/user.ts 第 10 行是干嘛的",
    "pkg##ai/aiops-mcp/src/legacy/user.ts 第 10 行是干嘛的",
    "x(ai/aiops-mcp/src/legacy/user.ts 第 10 行是干嘛的",
  ]) {
    const vendored = await ask([missing, missing], { question, tool: "code_read_file" });
    assert.deepEqual(vendored.replies, [blockedCodeAnswer(["ai/aiops-mcp", "ai/agent-tag"])], question);
  }
  // 仓库名互相包含时去掉最长的那个：问的是 team/backend/api 里的 src/legacy/user.ts，不是 team/backend 里的 api/src/legacy/user.ts
  for (const repos of [
    ["team/backend", "team/backend/api"],
    ["team/backend/api", "team/backend"],
  ]) {
    const question = "team/backend/api/src/legacy/user.ts 第 10 行是干嘛的";
    const longest = await ask([missing, missing], { question, tool: "code_read_file", repos });
    assert.deepEqual(longest.replies, [missing], repos.join());
    const shorter = "api/src/legacy/user.ts 第 10 行在仓库里找不到";
    const outer = await ask([shorter, shorter], { question, tool: "code_read_file", repos });
    assert.deepEqual(outer.replies, [blockedCodeAnswer(repos)], repos.join());
  }
  // 照着复述要连行号一起：问的是第 10 行（或者没写行号），回答写的是第 99 行，不算复述
  for (const otherLine of ["`src/legacy/user.ts:99` 初始化配置", "`src/legacy/user.ts`:99 初始化配置", "**src/legacy/user.ts**:99 初始化配置"]) {
    for (const question of ["src/legacy/user.ts 第 10 行是干嘛的", "src/legacy/user.ts 是干嘛的"]) {
      const moved = await ask([otherLine, otherLine], { question, tool: "code_read_file" });
      assert.deepEqual(moved.replies, [blockedCodeAnswer(["ai/aiops-mcp", "ai/agent-tag"])], `${question} / ${otherLine}`);
    }
  }
  const sameLine = await ask(["`src/legacy/user.ts:10` 读不到", "`src/legacy/user.ts:10` 读不到"], {
    question: "src/legacy/user.ts:10 是干嘛的",
    tool: "code_read_file",
  });
  assert.deepEqual(sameLine.replies, ["`src/legacy/user.ts:10` 读不到"]);
  // 群成员把行号写在反引号外面（`src/legacy/user.ts`:10），一样是问的第 10 行
  const askedOutside = await ask(["`src/legacy/user.ts:10` 读不到", "`src/legacy/user.ts:10` 读不到"], {
    question: "`src/legacy/user.ts`:10 是干嘛的",
    tool: "code_read_file",
  });
  assert.deepEqual(askedOutside.replies, ["`src/legacy/user.ts:10` 读不到"]);

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
  // 出自别的工具（比如 MCP）的，不算查到文件
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

test("代码工具的结果被截断时，截断处以后的代码位置不算，切开的那一行也不算（文件名里可以有空格）", async () => {
  const output = "共 2 个文件（master 分支 @ 1a2b3c4）：\nsrc/index.ts\nsrc/foo.ts backup\nsrc/b.ts";
  const ask = async (limit: number, answers: string[]) => {
    const listFiles: Tool = {
      spec: { name: "code_list_files", description: "列文件", parameters: { type: "object", properties: {} } },
      describe: () => "列文件",
      maxOutputChars: limit,
      run: async (_args, ctx) =>
        codeResult(ctx, [
          ["共 2 个文件（master 分支 @ 1a2b3c4）：", { commit: "1a2b3c4" }],
          ["src/index.ts", { path: "src/index.ts" }],
          ["src/foo.ts backup", { path: "src/foo.ts backup" }],
          ["src/b.ts", { path: "src/b.ts" }],
        ]),
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

test("代码工具的结果截在一行中间时，这一行里已经露出来的代码位置照样算", async () => {
  const header = "共 1 处（master 分支 @ 1a2b3c4）：";
  const row = "src/a.ts:2";
  const ask = async (limit: number, answers: string[]) => {
    const codeSearch: Tool = {
      spec: { name: "code_search", description: "搜代码", parameters: { type: "object", properties: {} } },
      describe: () => "搜代码",
      maxOutputChars: limit,
      run: async (_args, ctx) => {
        const out = new ToolOutputBuilder("ai/aiops-mcp")
          .parts("共 1 处（", ["master 分支 @ 1a2b3c4", { commit: "1a2b3c4" }, { branch: "master" }], "）：")
          .parts([row, { path: "src/a.ts", lines: [2, 2] }], `:${"x".repeat(200)}`);
        const { text, facts } = out.build();
        ctx.onFacts?.(facts);
        return text;
      },
    };
    const results: ChatResult[] = [
      { text: "", finish: "tool_calls", toolCalls: [{ id: "c1", name: "code_search", arguments: "{}" }] },
      ...answers.map((text): ChatResult => ({ text, finish: "stop" })),
    ];
    const { model, requests } = fakeModel(() => results.shift()!);
    const { sent, handle } = setup({ model, taskTools: () => [codeSearch], codeRepos: ["ai/aiops-mcp"] });
    await handle(message("ai/aiops-mcp 里 hello 在哪"));
    return { requests, replies: markdowns(sent) };
  };

  // 搜到的那一行很长，截在匹配的代码中间：「src/a.ts:2」模型已经看到了
  const cut = await ask(header.length + 1 + row.length + 50, ["在 src/a.ts:2"]);
  assert.equal(cut.requests.length, 2);
  assert.deepEqual(cut.replies, ["在 src/a.ts:2"]);
  // 截在「src/a.ts:」处，行号还没露出来，不算
  const early = await ask(header.length + 1 + row.length - 1, ["在 src/a.ts:2", "没找到"]);
  assert.equal(early.requests.length, 3);
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
