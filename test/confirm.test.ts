import assert from "node:assert/strict";
import { test } from "node:test";
import type { CardActionEvent, NormalizedMessage, SendInput, SendOptions } from "@larksuiteoapi/node-sdk";
import { type BotDeps, confirmRefusal, createMessageHandler } from "../src/bot.js";
import { CONFIRM_ACTION, type ConfirmOutcome, type ConfirmRequest, WriteConfirms } from "../src/confirm.js";
import type { ChatModel, ChatRequest, ChatResult } from "../src/llm.js";
import { TaskRegistry } from "../src/tasks.js";
import type { ConfirmPreview, Tool } from "../src/tools/tool.js";

const quiet = { info() {}, warn() {}, error() {} };

type Sent = { to: string; input: SendInput; opts?: SendOptions };

function message(content: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: "om_1",
    chatId: "oc_1",
    chatType: "group",
    senderId: "ou_asker",
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

function desk(options: { waitMs?: number; fail?: boolean } = {}) {
  const sent: Sent[] = [];
  const updates: { messageId: string; card: any }[] = [];
  const confirms = new WriteConfirms({
    send: async (to, input, opts) => {
      if (options.fail) {
        throw new Error("卡片被拒");
      }
      sent.push({ to, input, opts });
      return { messageId: `om_card_${sent.length}` };
    },
    updateCard: async (messageId, card) => {
      updates.push({ messageId, card });
    },
    logger: quiet,
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
  });
  return { confirms, sent, updates };
}

const preview: ConfirmPreview = {
  title: "推代码、开合并请求",
  lines: ["仓库：golang/appservice", "新建分支 bugfix/jd，开合并请求到 master", "标题：<at id=all></at> 修短链"],
};

function request(signal = new AbortController().signal, extra: Partial<ConfirmRequest> = {}): ConfirmRequest {
  return { chatId: "oc_1", threadKey: "om_root", replyTo: "om_q", asker: "ou_asker", preview, signal, ...extra };
}

/** 卡片上的按钮值：确认、取消 */
function buttonValues(card: any): Array<Record<string, string>> {
  const found: Array<Record<string, string>> = [];
  JSON.stringify(card, (key, value) => {
    if (key === "value" && value && typeof value === "object" && value.action === CONFIRM_ACTION) {
      found.push(value);
    }
    return value;
  });
  return found;
}

function click(card: any, op: "yes" | "no", operator = "ou_asker", messageId = "om_card_1", chatId = "oc_1"): CardActionEvent {
  const value = buttonValues(card).find((v) => v.op === op)!;
  return { messageId, chatId, operator: { openId: operator }, action: { value, tag: "button" } };
}

/** 等卡片发出去（send 是异步的） */
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("确认卡片：发在提问的话题里、@ 提问的人，写清要做什么，别处来的尖括号转义；提问的人点「确认」才放行，卡片改成已确认", async () => {
  const { confirms, sent, updates } = desk();
  const pending = confirms.ask(request());
  await tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].opts, { replyTo: "om_q", replyInThread: true });
  const card = (sent[0].input as { card: any }).card;
  const text = JSON.stringify(card);
  assert.match(text, /确认一下：推代码、开合并请求/);
  assert.match(text, /<at id=ou_asker><\/at> 我要做下面这件事，你点「确认」我才做/);
  assert.match(text, /- 仓库：golang\/appservice/);
  assert.match(text, /&lt;at id=all&gt;&lt;\/at&gt; 修短链/);
  assert.doesNotMatch(text, /<at id=all>/);
  assert.match(text, /15 分钟没确认就不做了/);
  assert.deepEqual(buttonValues(card).map((v) => v.op), ["yes", "no"]);

  assert.equal(await confirms.handleCardAction(click(card, "yes")), true);
  assert.equal(await pending, "confirmed");
  await tick();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].messageId, "om_card_1");
  assert.match(JSON.stringify(updates[0].card), /已确认：推代码、开合并请求/);
  assert.match(JSON.stringify(updates[0].card), /确认了，正在做/);
  assert.equal(buttonValues(updates[0].card).length, 0);
});

test("确认卡片：别人点的不算，卡片上写一句、接着等；提问的人点「取消」就不做", async () => {
  const { confirms, sent, updates } = desk();
  const pending = confirms.ask(request());
  await tick();
  const card = (sent[0].input as { card: any }).card;
  assert.equal(await confirms.handleCardAction(click(card, "yes", "ou_other")), true);
  assert.equal(updates.length, 1);
  assert.match(JSON.stringify(updates[0].card), /点的不算：只有提问的 .*ou_asker.* 能确认/);
  assert.equal(buttonValues(updates[0].card).length, 2, "还能接着点");
  // 别的群里冒充这张卡片的点击也不算
  assert.equal(await confirms.handleCardAction(click(card, "yes", "ou_asker", "om_card_1", "oc_2")), true);
  assert.equal(await confirms.handleCardAction(click(card, "no")), true);
  assert.equal(await pending, "cancelled");
  await tick();
  assert.match(JSON.stringify(updates.at(-1)!.card), /没做：推代码、开合并请求/);
});

test("确认卡片：提问的人在同一个话题里回「确认」也算，别人回的、别的话题里回的、话没说完的都不算", async () => {
  const { confirms } = desk();
  const pending = confirms.ask(request());
  await tick();
  assert.equal(confirms.answer(message("确认", { messageId: "om_a", senderId: "ou_other", threadId: "omt_1", rootId: "om_root" })), false);
  assert.equal(confirms.answer(message("确认", { messageId: "om_b", threadId: "omt_2", rootId: "om_root2" })), false);
  assert.equal(confirms.answer(message("确认", { messageId: "om_c", chatId: "oc_2", threadId: "omt_1", rootId: "om_root" })), false);
  assert.equal(confirms.answer(message("确认一下这个分支对不对", { messageId: "om_d", threadId: "omt_1", rootId: "om_root" })), false);
  assert.equal(confirms.answer(message("确认。", { messageId: "om_e", threadId: "omt_1", rootId: "om_root", mentionedBot: false })), true);
  assert.equal(await pending, "confirmed");
  // 定了以后再回不算，照常当提问
  assert.equal(confirms.answer(message("确认", { messageId: "om_f", threadId: "omt_1", rootId: "om_root" })), false);
});

test("确认卡片：回「算了」就是取消", async () => {
  const { confirms } = desk();
  const pending = confirms.ask(request());
  await tick();
  assert.equal(confirms.answer(message("算了！", { threadId: "omt_1", rootId: "om_root" })), true);
  assert.equal(await pending, "cancelled");
});

test("确认卡片：同一个话题里同时有几张等他确认，回「确认」一张也不放行、卡片上请他点那张；点了的那张才做；回「取消」全不做", async () => {
  const { confirms, sent, updates } = desk();
  const outcomes: Record<string, ConfirmOutcome> = {};
  const track = (name: string, pending: Promise<ConfirmOutcome>) => pending.then((result) => (outcomes[name] = result));
  const first = track("first", confirms.ask(request()));
  const second = track("second", confirms.ask(request(undefined, { preview: { title: "修改文档内容", lines: ["文档：「周报」"] } })));
  await tick();
  const inThread = { threadId: "omt_1", rootId: "om_root" };
  const yes = message("确认", { ...inThread, messageId: "om_yes" });
  assert.equal(confirms.answer(yes), true, "这句不当成提问");
  await tick();
  assert.deepEqual(outcomes, {}, "一张也没放行");
  assert.deepEqual(updates.map((u) => u.messageId).sort(), ["om_card_1", "om_card_2"]);
  for (const { card } of updates) {
    assert.match(JSON.stringify(card), /有 2 张卡片等你确认，回「确认」分不清是哪一张/);
    assert.equal(buttonValues(card).length, 2, "按钮还在");
  }
  // 同一条「确认」又送来一次：照第一次的结果，还是不放行
  assert.equal(confirms.answer(yes), true);
  await tick();
  assert.deepEqual(outcomes, {});
  // 在第二张上点确认：只做第二张
  assert.equal(await confirms.handleCardAction(click(updates.find((u) => u.messageId === "om_card_2")!.card, "yes", "ou_asker", "om_card_2")), true);
  await second;
  assert.deepEqual(outcomes, { second: "confirmed" });
  // 只剩一张了：回「好」就是这张
  assert.equal(confirms.answer(message("好", { ...inThread, messageId: "om_ok" })), true);
  await first;
  assert.deepEqual(outcomes, { second: "confirmed", first: "confirmed" });
  assert.equal(sent.length, 2);

  const other = desk();
  const a = other.confirms.ask(request());
  const b = other.confirms.ask(request());
  await tick();
  assert.equal(other.confirms.answer(message("取消", { ...inThread, messageId: "om_no" })), true);
  assert.deepEqual(await Promise.all([a, b]), ["cancelled", "cancelled"]);
});

test("确认卡片：到时间没人确认不做，卡片上写清；任务停了不做；卡片发不出去不做", async () => {
  const expiring = desk({ waitMs: 10 });
  assert.equal(await expiring.confirms.ask(request()), "expired");
  await tick();
  assert.match(JSON.stringify(expiring.updates.at(-1)!.card), /没人确认，这件事没做。要做请 @ 我再说一次/);

  const stopping = desk();
  const controller = new AbortController();
  const pending = stopping.confirms.ask(request(controller.signal));
  await tick();
  controller.abort();
  assert.equal(await pending, "stopped");
  await tick();
  assert.match(JSON.stringify(stopping.updates.at(-1)!.card), /任务停了，这件事没做/);

  const stopped = new AbortController();
  stopped.abort();
  assert.equal(await desk().confirms.ask(request(stopped.signal)), "stopped");

  assert.equal(await desk({ fail: true }).confirms.ask(request()), "unsent");
});

test("确认卡片：重启后点旧卡片，卡片改成已经失效；不是确认卡片的按钮不管", async () => {
  const { confirms, updates } = desk();
  const stale: CardActionEvent = {
    messageId: "om_old",
    chatId: "oc_1",
    operator: { openId: "ou_asker" },
    action: { value: { action: CONFIRM_ACTION, id: "gone", op: "yes", r: "0" }, tag: "button" },
  };
  assert.equal(await confirms.handleCardAction(stale), true);
  assert.equal(updates[0].messageId, "om_old");
  assert.match(JSON.stringify(updates[0].card), /这张卡片已经失效.*点了不算。做没做以话题里的回答为准/);
  assert.doesNotMatch(JSON.stringify(updates[0].card), /这件事没做/, "记不得了，不说没做");
  assert.equal(await confirms.handleCardAction({ ...stale, action: { value: { action: "stop_task" }, tag: "button" } }), false);
});

test("确认卡片：确认了以后又有人点（双击、别人在卡片改好之前点了），照定了的结果重画，不说成没做", async () => {
  const { confirms, sent, updates } = desk();
  const pending = confirms.ask(request());
  await tick();
  const card = (sent[0].input as { card: any }).card;
  await confirms.handleCardAction(click(card, "yes"));
  assert.equal(await pending, "confirmed");
  await tick();
  assert.equal(await confirms.handleCardAction(click(card, "no", "ou_other")), true);
  assert.equal(await confirms.handleCardAction(click(card, "no")), true);
  await tick();
  assert.equal(updates.length, 3);
  for (const update of updates) {
    assert.match(JSON.stringify(update.card), /已确认：推代码、开合并请求/);
    assert.doesNotMatch(JSON.stringify(update.card), /没做|失效/);
  }
  // 别的群里冒充这张卡片的点击不重画
  assert.equal(await confirms.handleCardAction(click(card, "no", "ou_asker", "om_card_1", "oc_2")), true);
  assert.equal(updates.length, 3);
});

test("确认卡片：话题里回的同一条「确认」只算一次（补漏轮询和事件各送来一次），开始请他确认之前发的也不算", async () => {
  const { confirms } = desk();
  const first = confirms.ask(request());
  await tick();
  const yes = message("确认", { messageId: "om_yes", threadId: "omt_1", rootId: "om_root", mentionedBot: false });
  assert.equal(confirms.answer(yes), true);
  assert.equal(await first, "confirmed");
  // 任务接着往下做，又要确认下一件事；先前那条「确认」又送来一次：照第一次的结果返回，不去定这一件
  const second = confirms.ask(request());
  await tick();
  assert.equal(confirms.answer(yes), true);
  // 开始请他确认之前就发了的「好」，补漏轮询这会儿才送来：不算
  assert.equal(confirms.answer(message("好", { messageId: "om_old_ok", threadId: "omt_1", rootId: "om_root", createTime: Date.now() - 60_000 })), false);
  // 第一次送来时没有等着确认的、当成了提问的，再送来一次也不算确认
  const idle = desk();
  const early = message("好", { messageId: "om_early", threadId: "omt_1", rootId: "om_root" });
  assert.equal(idle.confirms.answer(early), false);
  const later = idle.confirms.ask(request());
  await tick();
  assert.equal(idle.confirms.answer(early), false);
  assert.equal(idle.confirms.answer(message("好", { messageId: "om_ok", threadId: "omt_1", rootId: "om_root" })), true);
  assert.equal(await later, "confirmed");
  assert.equal(confirms.answer(message("取消", { messageId: "om_no", threadId: "omt_1", rootId: "om_root" })), true);
  assert.equal(await second, "cancelled");
});

test("确认卡片：卡片还没发出去时回的「好」不算（他还没看到要做什么）；发不出去照样不做", async () => {
  let deliver!: (result: { messageId: string }) => void;
  let reject!: (err: Error) => void;
  const make = () =>
    new WriteConfirms({
      send: () =>
        new Promise((resolve, fail) => {
          deliver = resolve;
          reject = fail;
        }),
      updateCard: async () => {},
      logger: quiet,
    });
  const confirms = make();
  const inThread = { threadId: "omt_1", rootId: "om_root" };
  const pending = confirms.ask(request());
  assert.equal(confirms.waiting(message("好", inThread)), true, "补漏轮询也要拿来看");
  assert.equal(confirms.waiting(message("好", { ...inThread, senderId: "ou_other" })), false);
  assert.equal(confirms.answer(message("好", { ...inThread, messageId: "om_early" })), false);
  deliver({ messageId: "om_card_1" });
  await tick();
  assert.equal(confirms.answer(message("好", { ...inThread, messageId: "om_after" })), true);
  assert.equal(await pending, "confirmed");

  const failing = make();
  const unsent = failing.ask(request());
  assert.equal(failing.answer(message("好", { ...inThread, messageId: "om_early2" })), false);
  reject(new Error("卡片被拒"));
  assert.equal(await unsent, "unsent");
});

// ---- 机器人跑任务时怎么用确认 ----

function fakeModel(results: ChatResult[]) {
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    model: "fake",
    async chat(req) {
      requests.push({ ...req, messages: [...req.messages] });
      return results.shift() ?? { text: "好了", finish: "stop" };
    },
  };
  return { model, requests };
}

/** 假的改文档工具：记下真改了几次 */
function docEdit(confirm?: Tool["confirm"]) {
  const runs: Record<string, unknown>[] = [];
  const tool: Tool = {
    spec: { name: "feishu_doc_edit", description: "改文档", parameters: { type: "object", properties: {} } },
    writes: true,
    ...(confirm !== undefined ? { confirm } : {}),
    describe: () => "在文档末尾追加内容",
    run: async (args) => {
      runs.push(args);
      return "已在文档末尾追加 1 块内容。";
    },
  };
  return { tool, runs };
}

function botSetup(tools: Tool[], results: ChatResult[], outcomes: ConfirmOutcome[], overrides: Partial<BotDeps> = {}) {
  const { model, requests } = fakeModel(results);
  const asked: ConfirmRequest[] = [];
  const deps: BotDeps = {
    model,
    tools: [],
    taskTools: () => tools,
    allowedChatIds: new Set(["oc_1"]),
    botName: () => "飞书 CLI",
    context: { load: async () => ({ history: [], source: "none" }), remember() {} },
    tasks: new TaskRegistry(),
    send: async (_to, _input) => ({ messageId: "om_reply" }),
    updateCard: async () => {},
    logger: quiet,
    cardIntervalMs: 0,
    confirms: {
      ask: async (req) => {
        asked.push(req);
        return outcomes.shift() ?? "confirmed";
      },
    },
    ...overrides,
  };
  return { handle: createMessageHandler(deps), requests, asked };
}

const appendCall = (id: string) => ({
  id,
  name: "feishu_doc_edit",
  arguments: JSON.stringify({ document: "https://x.feishu.cn/docx/AbCdEfGh123", action: "append", content: "周五发版" }),
});
const toolResult = (req: ChatRequest) => req.messages.filter((m) => m.role === "tool").map((m) => m.content);

test("改文档前请提问的人确认：卡片上写工具给的要做什么，他确认了才改；提示词里说了程序会发卡片、不用自己先问", async () => {
  const preview: ConfirmPreview = { title: "在文档末尾追加内容", lines: ["文档：「周报」", "写进去的内容：周五发版"] };
  const edit = docEdit(async () => preview);
  const { handle, asked, requests } = botSetup(
    [edit.tool],
    [{ text: "", finish: "tool_calls", toolCalls: [appendCall("c1")] }, { text: "已追加到周报。", finish: "stop" }],
    ["confirmed"],
  );
  await handle(message("把「周五发版」追加到文档 https://x.feishu.cn/docx/AbCdEfGh123", { rootId: "om_root", threadId: "omt_1" }));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].chatId, "oc_1");
  assert.equal(asked[0].replyTo, "om_1");
  assert.equal(asked[0].asker, "ou_asker");
  assert.equal(asked[0].threadKey, "om_root");
  assert.deepEqual(asked[0].preview, preview);
  assert.equal(edit.runs.length, 1);
  assert.match(requests[0].system, /feishu_doc_edit 真去做之前，程序会先在话题里发一张卡片写清要做什么，等提问的人点「确认」才做/);
});

test("提问的人点了取消：不改，告诉模型照实说没做；同一次任务里再调同一个工具不再发卡片，直接拒", async () => {
  const edit = docEdit(async () => ({ title: "在文档末尾追加内容", lines: ["文档：「周报」"] }));
  const { handle, asked, requests } = botSetup(
    [edit.tool],
    [
      { text: "", finish: "tool_calls", toolCalls: [appendCall("c1")] },
      { text: "", finish: "tool_calls", toolCalls: [appendCall("c2")] },
      { text: "好的，没改。", finish: "stop" },
    ],
    ["cancelled"],
  );
  await handle(message("把「周五发版」追加到文档 https://x.feishu.cn/docx/AbCdEfGh123"));
  assert.equal(asked.length, 1);
  assert.equal(edit.runs.length, 0);
  assert.deepEqual(toolResult(requests[1]), [`工具执行失败：${confirmRefusal("cancelled")}`]);
  assert.equal(toolResult(requests[2])[1], `工具执行失败：${confirmRefusal("cancelled", true)}`);
  assert.match(confirmRefusal("cancelled"), /点了「取消」.*这件事没做。照实告诉他没做/);
});

test("确认以后要做的事变了（同一轮里又改了代码）：不做，叫模型弄好再调一次", async () => {
  const edit = docEdit(async () => ({ title: "推代码", lines: [], unchanged: async () => false }));
  const { handle, requests } = botSetup(
    [edit.tool],
    [{ text: "", finish: "tool_calls", toolCalls: [appendCall("c1")] }, { text: "没推。", finish: "stop" }],
    ["confirmed"],
  );
  await handle(message("把「周五发版」追加到文档 https://x.feishu.cn/docx/AbCdEfGh123"));
  assert.equal(edit.runs.length, 0);
  assert.match(toolResult(requests[1])[0], /他确认以后，要做的事变了.*这次没做/);
});

test("确认以后、核对的这会儿点了停止：不做", async () => {
  const tasks = new TaskRegistry();
  const edit = docEdit(async () => ({
    title: "替换文档内容",
    lines: [],
    unchanged: async () => {
      tasks.stopAll();
      return true;
    },
  }));
  const { handle } = botSetup([edit.tool], [{ text: "", finish: "tool_calls", toolCalls: [appendCall("c1")] }, { text: "没改。", finish: "stop" }], ["confirmed"], { tasks });
  await handle(message("把「周五发版」追加到文档 https://x.feishu.cn/docx/AbCdEfGh123"));
  assert.equal(edit.runs.length, 0);
});

test("不用确认的：工具说了不用（只改工作目录、新建文档）、这次其实不改什么（已经合并过）、没开确认的，都直接做", async () => {
  for (const confirm of [false as const, async () => undefined]) {
    const edit = docEdit(confirm);
    const { handle, asked, requests } = botSetup(
      [edit.tool],
      [{ text: "", finish: "tool_calls", toolCalls: [appendCall("c1")] }, { text: "好了。", finish: "stop" }],
      [],
    );
    await handle(message("把「周五发版」追加到文档 https://x.feishu.cn/docx/AbCdEfGh123"));
    assert.equal(asked.length, 0);
    assert.equal(edit.runs.length, 1);
    if (confirm === false) {
      assert.doesNotMatch(requests[0].system, /真去做之前，程序会先在话题里发一张卡片/);
    }
  }
  const edit = docEdit(async () => ({ title: "x", lines: [] }));
  const { handle, requests } = botSetup(
    [edit.tool],
    [{ text: "", finish: "tool_calls", toolCalls: [appendCall("c1")] }, { text: "好了。", finish: "stop" }],
    [],
    { confirms: undefined },
  );
  await handle(message("把「周五发版」追加到文档 https://x.feishu.cn/docx/AbCdEfGh123"));
  assert.equal(edit.runs.length, 1);
  assert.doesNotMatch(requests[0].system, /真去做之前，程序会先在话题里发一张卡片/);
});

test("定时任务到点追加到建任务时点名的那篇：没人看着，不发确认卡片", async () => {
  const edit = docEdit(async () => ({ title: "在文档末尾追加内容", lines: [] }));
  const { handle, asked, requests } = botSetup(
    [edit.tool],
    [{ text: "", finish: "tool_calls", toolCalls: [appendCall("c1")] }, { text: "已追加。", finish: "stop" }],
    [],
  );
  await handle(message("每周五汇总进展，追加到周报文档 https://x.feishu.cn/docx/AbCdEfGh123"), {
    scheduled: { label: "T1", schedule: "每周五 18:00", appendDoc: "https://x.feishu.cn/docx/AbCdEfGh123" },
  });
  assert.equal(asked.length, 0);
  assert.equal(edit.runs.length, 1);
  assert.doesNotMatch(requests[0].system, /真去做之前，程序会先在话题里发一张卡片/);
});
