import assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { FeishuApi, ThreadMessage } from "../src/feishu.js";
import { MAX_HISTORY_CHARS, ThreadContextLoader, toChatMessages } from "../src/history.js";

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
