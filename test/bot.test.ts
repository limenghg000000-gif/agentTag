import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { CardActionEvent, NormalizedMessage, SendInput, SendOptions } from "@larksuiteoapi/node-sdk";
import { type BotDeps, createCardActionHandler, createMessageHandler, type ThreadContextSource } from "../src/bot.js";
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
