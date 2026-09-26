import assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedMessage, SendInput, SendOptions } from "@larksuiteoapi/node-sdk";
import { createMessageHandler } from "../src/bot.js";
import { type ChatModel, type ChatRequest, type ChatResult, LlmError } from "../src/llm.js";

const quiet = { info() {}, error() {} };

function message(content: string): NormalizedMessage {
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
  };
}

function fakeModel(respond: (req: ChatRequest) => ChatResult | Promise<ChatResult>) {
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    model: "fake",
    async chat(req) {
      requests.push(req);
      return respond(req);
    },
  };
  return { model, requests };
}

function recorder() {
  const sent: { to: string; input: SendInput; opts?: SendOptions }[] = [];
  const send = async (to: string, input: SendInput, opts?: SendOptions) => {
    sent.push({ to, input, opts });
    return { messageId: `om_reply_${sent.length}` };
  };
  return { sent, send };
}

const markdownOf = (input: SendInput) => (input as { markdown: string }).markdown;
const inThread = { replyTo: "om_1", replyInThread: true };
const allowedChatIds = new Set(["oc_1"]);

test("把问题交给模型，并在原消息的话题里回复", async () => {
  const { sent, send } = recorder();
  const { model, requests } = fakeModel(() => ({ text: "**答案**", finish: "stop" }));

  await createMessageHandler({ model, allowedChatIds, send, logger: quiet })(message("  今天周几？ "));

  assert.equal(requests.length, 1);
  assert.ok(requests[0].system.length > 0);
  assert.deepEqual(requests[0].messages, [{ role: "user", content: "今天周几？" }]);
  assert.deepEqual(sent, [{ to: "oc_1", input: { markdown: "**答案**" }, opts: inThread }]);
});

test("只 @ 不带内容时给出提示，不调用模型", async () => {
  const { sent, send } = recorder();
  const { model, requests } = fakeModel(() => ({ text: "", finish: "stop" }));

  await createMessageHandler({ model, allowedChatIds, send, logger: quiet })(message(""));

  assert.equal(requests.length, 0);
  assert.match(markdownOf(sent[0].input), /带上问题/);
});

test("回答被截断或被内容审核拦下时如实说明", async () => {
  const { sent, send } = recorder();
  const results: ChatResult[] = [{ text: "前半段", finish: "length" }, { text: "", finish: "filtered" }];
  const { model } = fakeModel(() => results.shift()!);
  const handle = createMessageHandler({ model, allowedChatIds, send, logger: quiet });

  await handle(message("写长一点"));
  await handle(message("敏感问题"));

  assert.match(markdownOf(sent[0].input), /^前半段\n\n（回答太长/);
  assert.match(markdownOf(sent[1].input), /内容审核/);
});

test("模型调用失败时在话题里说明原因", async () => {
  const { sent, send } = recorder();
  const { model } = fakeModel(() => { throw new LlmError("connection", "boom"); });

  await createMessageHandler({ model, allowedChatIds, send, logger: quiet })(message("你好"));

  assert.equal(sent.length, 1);
  assert.match(markdownOf(sent[0].input), /连不上模型服务/);
  assert.deepEqual(sent[0].opts, inThread);
});

test("长回答拆成多条，全部回复在同一个话题里", async () => {
  const { sent, send } = recorder();
  const long = Array.from({ length: 400 }, (_, i) => `第 ${i} 行：这是一段比较长的回答内容`).join("\n");
  const { model } = fakeModel(() => ({ text: long, finish: "stop" }));

  await createMessageHandler({ model, allowedChatIds, send, logger: quiet })(message("写长一点"));

  assert.ok(sent.length > 1);
  for (const { opts } of sent) {
    assert.deepEqual(opts, inThread);
  }
});

test("白名单外的群直接忽略，不调用模型也不回复", async () => {
  const { sent, send } = recorder();
  const { model, requests } = fakeModel(() => ({ text: "不该出现", finish: "stop" }));
  const logs: string[] = [];
  const logger = { info: (line: string) => logs.push(line), error() {} };

  await createMessageHandler({ model, allowedChatIds, send, logger })({ ...message("你好"), chatId: "oc_alarm" });

  assert.equal(requests.length, 0);
  assert.equal(sent.length, 0);
  assert.match(logs.join("\n"), /oc_alarm/);
});

test("白名单为空时不响应任何群", async () => {
  const { sent, send } = recorder();
  const { model, requests } = fakeModel(() => ({ text: "不该出现", finish: "stop" }));

  await createMessageHandler({ model, allowedChatIds: new Set(), send, logger: quiet })(message("你好"));

  assert.equal(requests.length, 0);
  assert.equal(sent.length, 0);
});
