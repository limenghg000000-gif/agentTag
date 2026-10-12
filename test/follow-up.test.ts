import assert from "node:assert/strict";
import { test } from "node:test";
import type { CardActionEvent, NormalizedMessage, SendInput, SendOptions } from "@larksuiteoapi/node-sdk";
import type { FeishuApi, ThreadMessage } from "../src/feishu.js";
import { createFollowUp, FOLLOW_UP_DEDUPE_MS, followUpText, parseFollowUp } from "../src/follow-up.js";

const quiet = { info() {}, warn() {}, error() {} };

function click(q: unknown, operator: CardActionEvent["operator"] = { openId: "ou_li" }): CardActionEvent {
  return { messageId: "om_card", chatId: "oc_1", operator, action: { tag: "button", value: { action: "ask_followup", q } } };
}

function setup(thread: ThreadMessage[] = []) {
  let time = 10_000;
  const calls: string[] = [];
  const sent: { to: string; input: SendInput; opts?: SendOptions }[] = [];
  const handled: { msg: NormalizedMessage; options: { readOnly: boolean } }[] = [];
  const api: Pick<FeishuApi, "getMessage" | "listThreadMessages"> = {
    async getMessage(messageId) {
      calls.push(`get ${messageId}`);
      return messageId === "om_card"
        ? { messageId, fromBot: true, msgType: "interactive", content: "", createTime: 1, threadId: "omt_1", rootId: "om_root" }
        : undefined;
    },
    async listThreadMessages(threadId) {
      calls.push(`list ${threadId}`);
      return thread;
    },
  };
  const followUp = createFollowUp({
    api,
    send: async (to, input, opts) => {
      sent.push({ to, input, ...(opts ? { opts } : {}) });
      return { messageId: `om_ask${sent.length}` } as never;
    },
    handle: async (msg, options) => {
      handled.push({ msg, options });
    },
    logger: quiet,
    now: () => time,
  });
  return { followUp, calls, sent, handled, advance: (ms: number) => (time += ms) };
}

test("点「接着查」：在话题里替点的人发一句，再当成他在话题里问的处理，只给读的工具", async () => {
  const { followUp, calls, sent, handled } = setup([
    { messageId: "om_root", fromBot: false, senderName: "李四", senderId: "ou_li", msgType: "text", content: "union 内存", createTime: 1 },
  ]);

  await followUp(click("union 最近 1 小时的内存趋势"), "union 最近 1 小时的内存趋势");

  assert.deepEqual(calls, ["get om_card", "list omt_1"]);
  assert.deepEqual(sent, [
    { to: "oc_1", input: { markdown: "👉 李四 接着问：union 最近 1 小时的内存趋势" }, opts: { replyTo: "om_card", replyInThread: true } },
  ]);
  assert.equal(handled.length, 1);
  assert.deepEqual(handled[0].options, { readOnly: true });
  const msg = handled[0].msg;
  assert.equal(msg.messageId, "om_ask1");
  assert.equal(msg.senderId, "ou_li");
  assert.equal(msg.senderName, "李四");
  assert.equal(msg.content, "union 最近 1 小时的内存趋势");
  assert.equal(msg.rootId, "om_root");
  assert.equal(msg.threadId, "omt_1");
  assert.equal(msg.mentionedBot, true);
  assert.equal(msg.createTime, 10_000);
});

test("点「接着查」：回调里带名字就不去话题里找；找不到名字也照样问", async () => {
  const named = setup();
  await named.followUp(click("q1", { openId: "ou_li", name: "李四" }), "q1");
  assert.deepEqual(named.calls, ["get om_card"]);
  assert.equal((named.sent[0].input as { markdown: string }).markdown, "👉 李四 接着问：q1");

  const nameless = setup([{ messageId: "om_x", fromBot: false, senderName: "王五", senderId: "ou_wang", msgType: "text", content: "", createTime: 1 }]);
  await nameless.followUp(click("q1"), "q1");
  assert.equal((nameless.sent[0].input as { markdown: string }).markdown, "👉 接着问：q1");
  assert.equal(nameless.handled[0].msg.senderName, undefined);
});

test("点「接着查」：同一个按钮 1 分钟内再点（别人点也算）不重复问；回传的话不对的不问", async () => {
  const { followUp, sent, advance } = setup();
  await followUp(click("q1"), "q1");
  await followUp(click("q1", { openId: "ou_wang" }), "q1");
  await followUp(click("q2"), "q2");
  assert.equal(sent.length, 2);
  advance(FOLLOW_UP_DEDUPE_MS + 1);
  await followUp(click("q1"), "q1");
  assert.equal(sent.length, 3);

  for (const bad of [undefined, 42, "", "很".repeat(41)]) {
    await followUp(click(bad), bad);
  }
  assert.equal(sent.length, 3);
  // 尖括号去掉，不会变成 @所有人
  await followUp(click("<at id=all></at>看看"), "<at id=all></at>看看");
  assert.equal((sent[3].input as { markdown: string }).markdown, "👉 接着问：at id=all/at看看");
});

test("替人接着问的那句：写出来、认回去；名字里的 Markdown 符号和尖括号去掉", () => {
  assert.deepEqual(parseFollowUp(followUpText("李四", "union 有没有重启")), { name: "李四", question: "union 有没有重启" });
  assert.deepEqual(parseFollowUp(followUpText(undefined, "union 有没有重启")), { question: "union 有没有重启" });
  assert.equal(followUpText("<b>**李四**</b>", "q"), "👉 b李四/b 接着问：q");
  assert.equal(parseFollowUp("处理完了，结果在上面的卡片里。"), undefined);
});
