import assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { FeishuApi, ThreadMessage } from "../src/feishu.js";
import {
  CHAT_CONTEXT_CHARS,
  CHAT_CONTEXT_HEADER,
  CHAT_CONTEXT_MS,
  isChatContext,
  labelUserMessage,
  MAX_HISTORY_CHARS,
  renderChat,
  ThreadContextLoader,
  toChatMessages,
  unlabelUserMessage,
} from "../src/history.js";

function message(extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: "om_3",
    chatId: "oc_1",
    chatType: "group",
    senderId: "ou_1",
    content: "再短一点",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: 3000,
    ...extra,
  };
}

function item(messageId: string, extra: Partial<ThreadMessage> = {}): ThreadMessage {
  return { messageId, fromBot: false, msgType: "text", content: messageId, createTime: 1000, ...extra };
}

function fakeApi(thread: ThreadMessage[] | Error, single: Record<string, ThreadMessage> = {}) {
  const calls: string[] = [];
  const api: Pick<FeishuApi, "listThreadMessages" | "getMessage"> = {
    async listThreadMessages(threadId) {
      calls.push(`list ${threadId}`);
      if (thread instanceof Error) {
        throw thread;
      }
      return thread;
    },
    async getMessage(messageId) {
      calls.push(`get ${messageId}`);
      return single[messageId];
    },
  };
  return { api, calls };
}

const quiet = { info() {}, warn() {}, error() {} };

test("话题消息整理成对话：标上发言人，机器人连续发的几条合成一条", () => {
  const result = toChatMessages([
    item("a", { senderName: "张三", content: "写个标题" }),
    item("b", { fromBot: true, content: "第一段" }),
    item("c", { fromBot: true, content: "第二段" }),
    item("d", { content: "我觉得还行" }),
  ]);

  assert.deepEqual(result, [
    { role: "user", content: "[张三] 写个标题" },
    { role: "assistant", content: "第一段\n第二段" },
    { role: "user", content: "[群成员] 我觉得还行" },
  ]);
});

test("去掉标的发言人拿回原话：名字里带「]」「] 」、原话里带「] 」都不会去多去少", () => {
  assert.equal(unlabelUserMessage(labelUserMessage("张三", "gateway-api 报 code=8")), "gateway-api 报 code=8");
  assert.equal(unlabelUserMessage(labelUserMessage(undefined, "怎么修？")), "怎么修？");
  assert.equal(unlabelUserMessage(labelUserMessage("A]B", "看下 [x] 这一项")), "看下 [x] 这一项");
  assert.equal(unlabelUserMessage(labelUserMessage("[Ops] Alice Smith", "gateway failed")), "gateway failed");
  assert.equal(unlabelUserMessage(labelUserMessage("Ops] Team\n二组", "[x] done")), "[x] done");
  assert.equal(unlabelUserMessage(labelUserMessage("张三", "[x] 已勾选")), "[x] 已勾选");
  assert.equal(unlabelUserMessage("（中间较早的 3 条消息已省略）"), "（中间较早的 3 条消息已省略）");
});

test("太长的消息截短给模型看，截短前的全文另外留着（只给程序查经验前认密钥用）；没截短的、机器人的不留", () => {
  const long = `开头${"字".repeat(7000)}结尾`;
  const result = toChatMessages([
    item("a", { senderName: "张三", content: long }),
    item("b", { fromBot: true, content: "好".repeat(7000) }),
    item("c", { content: "短的" }),
  ]);
  assert.equal(result[0].role, "user");
  assert.match(result[0].content, /^\[张三\] 开头字+…（后面省略）$/);
  assert.equal(result[0].role === "user" ? result[0].full : undefined, `[张三] ${long}`);
  assert.deepEqual(Object.keys(result[1]), ["role", "content"]);
  assert.deepEqual(result[2], { role: "user", content: "[群成员] 短的" });
});

test("超出字数上限时省略较早的消息，但保留话题第一条", () => {
  const long = "字".repeat(5000);
  const messages = Array.from({ length: 10 }, (_, i) => item(`m${i}`, { senderName: "张三", content: `${i}${long}` }));

  const result = toChatMessages(messages);

  assert.equal(result[0].content.slice(0, 6), "[张三] 0");
  assert.match(result[1].content, /中间较早的 \d+ 条消息已省略/);
  assert.equal(result.at(-1)!.content.slice(0, 6), "[张三] 9");
  const total = result.slice(2).reduce((sum, m) => sum + m.content.length, 0);
  assert.ok(total <= MAX_HISTORY_CHARS);
});

test("从飞书读话题：去掉当前消息、之后的消息和机器人的进度卡片，带出提问人名字", async () => {
  const { api, calls } = fakeApi([
    item("om_root", { senderName: "张三", content: "写个标题", createTime: 1000 }),
    item("om_card", { fromBot: true, msgType: "interactive", content: "进度", createTime: 1500 }),
    item("om_2", { fromBot: true, msgType: "post", content: "《季度总结》", createTime: 2000 }),
    item("om_3", { senderName: "李四", content: "再短一点", createTime: 3000 }),
    item("om_4", { senderName: "王五", content: "后来的消息", createTime: 4000 }),
  ]);

  const context = await new ThreadContextLoader(api, quiet).load(message({ rootId: "om_root", threadId: "omt_1" }));

  assert.deepEqual(calls, ["list omt_1"]);
  assert.equal(context.source, "feishu");
  assert.equal(context.askerName, "李四");
  assert.deepEqual(context.history, [
    { role: "user", content: "[张三] 写个标题" },
    { role: "assistant", content: "《季度总结》" },
  ]);
});

test("带出上文里群成员发的图片（机器人发的不算），引用的消息里的图片也带上", async () => {
  const { api } = fakeApi(
    [
      item("om_root", { senderName: "张三", content: "![image](img_a)\n这个线上报警是咋回事", images: ["img_a"], createTime: 1000 }),
      item("om_2", { fromBot: true, content: "![image](img_bot)", images: ["img_bot"], createTime: 2000 }),
    ],
    { om_q: item("om_q", { senderName: "李四", content: "![image](img_q)", images: ["img_q"] }) },
  );
  const loader = new ThreadContextLoader(api, quiet);

  const inThread = await loader.load(message({ rootId: "om_root", threadId: "omt_1", createTime: 3000 }));
  assert.deepEqual(inThread.images, [{ messageId: "om_root", imageKey: "img_a" }]);

  const quoting = await loader.load(message({ messageId: "om_5", replyToMessageId: "om_q" }));
  assert.deepEqual(quoting.images, [{ messageId: "om_q", imageKey: "img_q" }]);
});

test("话题列表里没有第一条消息时单独读出来补上", async () => {
  const { api, calls } = fakeApi([item("om_2", { fromBot: true, content: "回答" })], {
    om_root: item("om_root", { content: "原问题" }),
  });

  const context = await new ThreadContextLoader(api, quiet).load(message({ rootId: "om_root", threadId: "omt_1" }));

  assert.deepEqual(calls, ["list omt_1", "get om_root"]);
  assert.deepEqual(context.history.map((m) => m.role), ["user", "assistant"]);
});

test("读不到飞书话题时退回本地记下的问答，并只提示一次", async () => {
  const { api } = fakeApi(new Error("code=230027 Lack of necessary permissions"));
  const warnings: string[] = [];
  const loader = new ThreadContextLoader(api, { ...quiet, warn: (line: string) => warnings.push(line) });
  const first = message({ messageId: "om_1", createTime: 1000 });
  loader.remember(first, "[群成员] 写个标题", "《季度总结》");

  const inThread = message({ rootId: "om_1", threadId: "omt_1" });
  const context = await loader.load(inThread);
  await loader.load(inThread);

  assert.equal(context.source, "local");
  assert.deepEqual(context.history, [
    { role: "user", content: "[群成员] 写个标题" },
    { role: "assistant", content: "《季度总结》" },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /im:message\.group_msg/);

  // 提问里的图片文字截短过：截短前的全文也记下（和给模型看的一样时不记）
  const second = message({ messageId: "om_5", createTime: 1000 });
  loader.remember(second, "[群成员] 截短的", "好", "[群成员] 截短前的全文");
  loader.remember(second, "[群成员] 没截短", "好", "[群成员] 没截短");
  assert.deepEqual((await loader.load(message({ rootId: "om_5", threadId: "omt_5" }))).history, [
    { role: "user", content: "[群成员] 截短的", full: "[群成员] 截短前的全文" },
    { role: "assistant", content: "好" },
    { role: "user", content: "[群成员] 没截短" },
    { role: "assistant", content: "好" },
  ]);
});

test("在群里直接 @ 时单独读这条消息拿到提问人名字，读不到就不带名字", async () => {
  const { api, calls } = fakeApi([], { om_3: item("om_3", { senderName: "张三" }) });
  const context = await new ThreadContextLoader(api, quiet).load(message());

  assert.deepEqual(calls, ["get om_3"]);
  assert.deepEqual(context, { history: [], askerName: "张三", source: "none" });

  const failing: typeof api = { ...api, getMessage: async () => Promise.reject(new Error("no permission")) };
  assert.deepEqual(await new ThreadContextLoader(failing, quiet).load(message()), { history: [], source: "none" });
});

test("在群里直接 @ 时没有上文；用「回复」引用消息时带上被引用的消息", async () => {
  const { api } = fakeApi([], { om_quoted: item("om_quoted", { senderName: "张三", content: "明天下午开会" }) });
  const loader = new ThreadContextLoader(api, quiet);

  assert.deepEqual(await loader.load(message()), { history: [], source: "none" });
  const quoted = await loader.load(message({ rootId: "om_quoted", replyToMessageId: "om_quoted" }));
  assert.deepEqual(quoted.history, [{ role: "user", content: "[张三] 明天下午开会" }]);
});

/** 北京时间 2026-10-14 10:30 */
const AT = Date.UTC(2026, 9, 14, 2, 30);
const minutesBefore = (n: number) => AT - n * 60_000;

function chatApi(chat: ThreadMessage[] | Error, single: Record<string, ThreadMessage> = {}) {
  const { api, calls } = fakeApi([], single);
  return {
    calls,
    api: {
      ...api,
      async listChatMessages(chatId: string, sinceMs: number, untilMs: number, limit: number) {
        calls.push(`chat ${chatId} since=${sinceMs} until=${untilMs} limit=${limit}`);
        if (chat instanceof Error) {
          throw chat;
        }
        return chat;
      },
    },
  };
}

test("在群里直接 @ 时带上之前半小时内的群聊：标上发言人和北京时间，不带机器人发的、这条之后的、这条本身", async () => {
  const { api, calls } = chatApi([
    item("om_c1", { senderName: "张三", content: "gateway 又报 code=8 了", createTime: minutesBefore(9) }),
    item("om_card", { fromBot: true, msgType: "interactive", content: "进度卡片", createTime: minutesBefore(8) }),
    item("om_c2", { senderName: "李四", content: "![image](img_1)", images: ["img_1"], createTime: minutesBefore(8) }),
    item("om_3", { senderName: "王五", content: "看下上面那个报错", createTime: AT }),
    item("om_later", { senderName: "张三", content: "我先去吃饭", createTime: AT + 1000 }),
  ]);
  const loader = new ThreadContextLoader(api, quiet, undefined, undefined, true);
  const context = await loader.load(message({ content: "看下上面那个报错", createTime: AT }));

  assert.equal(calls[0], `chat oc_1 since=${AT - CHAT_CONTEXT_MS} until=${AT} limit=21`);
  assert.deepEqual(context.history, [
    { role: "user", content: `${CHAT_CONTEXT_HEADER}\n[张三 10:21] gateway 又报 code=8 了\n[李四 10:22] ![image](img_1)` },
  ]);
  assert.equal(isChatContext(context.history[0]), true);
  assert.deepEqual(context.images, [{ messageId: "om_c2", imageKey: "img_1" }]);
  assert.equal(context.source, "chat");
  assert.equal(context.chatMessages, 2);
});

test("群聊和「回复」引用的消息一起带上时，被引用的那条不在群聊里重复", async () => {
  const quoted = item("om_quoted", { senderName: "张三", content: "明天下午开会", createTime: minutesBefore(5) });
  const { api } = chatApi([quoted, item("om_c1", { senderName: "李四", content: "收到", createTime: minutesBefore(4) })], { om_quoted: quoted });
  const loader = new ThreadContextLoader(api, quiet, undefined, undefined, true);
  const context = await loader.load(message({ createTime: AT, rootId: "om_quoted", replyToMessageId: "om_quoted" }));

  assert.deepEqual(context.history, [
    { role: "user", content: `${CHAT_CONTEXT_HEADER}\n[李四 10:26] 收到` },
    { role: "user", content: "[张三] 明天下午开会" },
  ]);
  assert.equal(context.source, "local");
});

test("没开 CHAT_CONTEXT、在话题里 @ 的都不读群聊；读群聊失败时只提示一次，照常回答", async () => {
  const off = chatApi([item("om_c1", { createTime: minutesBefore(1) })]);
  assert.deepEqual(await new ThreadContextLoader(off.api, quiet).load(message({ createTime: AT })), { history: [], source: "none" });
  assert.ok(!off.calls.some((call) => call.startsWith("chat")));

  const inThread = chatApi([item("om_c1", { createTime: minutesBefore(1) })]);
  await new ThreadContextLoader(inThread.api, quiet, undefined, undefined, true).load(message({ createTime: AT, threadId: "omt_1", rootId: "om_1" }));
  assert.ok(!inThread.calls.some((call) => call.startsWith("chat")));

  const warnings: string[] = [];
  const failing = chatApi(new Error("no permission"));
  const loader = new ThreadContextLoader(failing.api, { ...quiet, warn: (line: string) => warnings.push(line) }, undefined, undefined, true);
  assert.deepEqual(await loader.load(message({ createTime: AT })), { history: [], source: "none" });
  await loader.load(message({ createTime: AT }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /读取群里刚才的聊天失败，这次只看提问本身：no permission/);
});

test("群聊太长时省略较早的，单条太长的截短", () => {
  const long = "很".repeat(2000);
  const messages = Array.from({ length: 10 }, (_, i) => item(`om_${i}`, { senderName: `人${i}`, content: long, createTime: minutesBefore(10 - i) }));
  const text = renderChat(messages);
  assert.ok(text.length <= CHAT_CONTEXT_CHARS + CHAT_CONTEXT_HEADER.length + 40);
  assert.match(text, /^（下面是群里在这次 @ 你之前的聊天/);
  assert.match(text, /（更早的 \d+ 条省略）/);
  assert.match(text, /\[人9 10:29\] 很+…（后面省略）$/);
  assert.ok(!text.includes("[人0 "));
});

test("卡片即回答：机器人的卡片记过回答的换成回答，没记过的（进度卡片）照样去掉", async () => {
  const { api } = fakeApi([
    item("om_1", { senderName: "张三", content: "@机器人 查一下" }),
    item("om_card_1", { fromBot: true, msgType: "interactive", content: "请升级至最新版本客户端" }),
    item("om_card_old", { fromBot: true, msgType: "interactive", content: "✅ 已完成" }),
    item("om_answer_old", { fromBot: true, content: "以前另外发的回答" }),
    item("om_notice", { fromBot: true, msgType: "post", content: "处理完了，结果在上面的卡片里。" }),
    item("om_3", { createTime: 3000 }),
  ]);
  const asked: { chatId: string; threadKey: string; ids: readonly string[] }[] = [];
  const loader = new ThreadContextLoader(api, quiet, 500, {
    async get(chatId, threadKey, ids) {
      asked.push({ chatId, threadKey, ids });
      return new Map([["om_card_1", "卡片里的回答"]]);
    },
  });

  const context = await loader.load(message({ rootId: "om_1", threadId: "omt_1" }));

  assert.deepEqual(asked, [{ chatId: "oc_1", threadKey: "om_1", ids: ["om_card_1", "om_card_old"] }]);
  assert.deepEqual(context.history, [
    { role: "user", content: "[张三] @机器人 查一下" },
    { role: "assistant", content: "卡片里的回答\n以前另外发的回答" },
  ]);

  // 读不出记下的回答时照常读话题，只是没有卡片里的回答
  const broken = new ThreadContextLoader(api, quiet, 500, {
    get: async () => {
      throw new Error("disk");
    },
  });
  assert.deepEqual((await broken.load(message({ rootId: "om_1", threadId: "omt_1" }))).history, [
    { role: "user", content: "[张三] @机器人 查一下" },
    { role: "assistant", content: "以前另外发的回答" },
  ]);
});

test("点「接着查」按钮的问题：机器人替人发的那句算那个人问的；提问人名字用按钮那边拿到的", async () => {
  const { api } = fakeApi([
    item("om_root", { senderName: "张三", content: "union 内存", createTime: 1000 }),
    item("om_card", { fromBot: true, msgType: "interactive", content: "进度", createTime: 1500 }),
    item("om_ask1", { fromBot: true, senderName: "机器人", msgType: "post", content: "👉 李四 接着问：union 有没有重启", createTime: 2000 }),
    item("om_ans", { fromBot: true, msgType: "post", content: "没有重启", createTime: 2500 }),
    item("om_ask2", { fromBot: true, senderName: "机器人", msgType: "post", content: "👉 接着问：内存趋势", createTime: 3000 }),
  ]);

  const context = await new ThreadContextLoader(api, quiet).load(
    message({ messageId: "om_ask2", senderName: "李四", content: "内存趋势", rootId: "om_root", threadId: "omt_1", createTime: 3000 }),
  );

  assert.equal(context.askerName, "李四");
  assert.deepEqual(context.history, [
    { role: "user", content: "[张三] union 内存" },
    { role: "user", content: "[李四] union 有没有重启" },
    { role: "assistant", content: "没有重启" },
  ]);
});
