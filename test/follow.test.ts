import assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { FOLLOW_WINDOW_MS, MUTE_COMMAND, MUTED_REPLY, ThreadFollower } from "../src/follow.js";
import type { ThreadContext } from "../src/history.js";
import type { ChatModel, ChatRequest } from "../src/llm.js";

const START = 1_000_000_000_000;
const BOT = "ou_bot";

function msg(messageId: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId,
    chatId: "oc_1",
    chatType: "group",
    senderId: "ou_1",
    content: "那换成按小时看呢",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    rootId: "om_root",
    threadId: "omt_1",
    createTime: START,
    ...extra,
  };
}

/** @ 了机器人、开了这个话题的那条 */
const asked = msg("om_root", { mentionedBot: true, rootId: undefined, threadId: undefined, content: "最近一小时 gateway 报错多少" });

function setup(judge: string | Error = "是", busy = false) {
  let now = START;
  const requests: ChatRequest[] = [];
  const handled: string[] = [];
  const replies: string[] = [];
  const logs: string[] = [];
  const context: ThreadContext = {
    history: [
      { role: "user", content: "[张三] 最近一小时 gateway 报错多少" },
      { role: "assistant", content: "最近一小时 gateway 报错 132 次，主要是 code=8" },
    ],
    askerName: "张三",
    source: "feishu",
  };
  const model: ChatModel = {
    model: "fake",
    async chat(request) {
      requests.push(request);
      if (judge instanceof Error) {
        throw judge;
      }
      return { text: judge, finish: "stop" };
    },
  };
  const follower = new ThreadFollower({
    allowedChatIds: new Set(["oc_1"]),
    context: { load: async () => context },
    model,
    botName: () => "飞书 CLI",
    botOpenId: () => BOT,
    busy: () => busy,
    handle: async (m) => {
      handled.push(m.messageId);
    },
    reply: async (m, markdown) => {
      replies.push(`${m.messageId} ${markdown}`);
    },
    logger: { info: (line: string) => logs.push(line), warn: (line: string) => logs.push(line), error() {} },
    now: () => now,
  });
  return {
    follower,
    requests,
    handled,
    replies,
    logs,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("回答过的话题里，没 @ 的人发的消息要判断；没回答过的话题、群里直接说的不管", () => {
  const t = setup();
  assert.equal(t.follower.wants(msg("om_2")), false);
  t.follower.track(asked);
  assert.equal(t.follower.wants(msg("om_2")), true);
  // 别的话题、群里直接说的（不在话题里）
  assert.equal(t.follower.wants(msg("om_3", { rootId: "om_other", threadId: "omt_2" })), false);
  assert.equal(t.follower.wants(msg("om_4", { rootId: undefined, threadId: undefined })), false);
});

test("@ 了别人、@所有人、机器人和应用发的、白名单外的群、只发了空消息的不跟", () => {
  const t = setup();
  t.follower.track(asked);
  assert.equal(t.follower.wants(msg("om_2", { mentions: [{ key: "@_user_1", openId: "ou_2", name: "李四" }] })), false);
  assert.equal(t.follower.wants(msg("om_3", { mentionAll: true })), false);
  assert.equal(t.follower.wants(msg("om_4"), true), false);
  assert.equal(t.follower.wants(msg("om_5", { senderId: "" })), false);
  assert.equal(t.follower.wants(msg("om_6", { senderId: "cli_other" })), false);
  assert.equal(t.follower.wants(msg("om_7", { senderId: BOT })), false);
  assert.equal(t.follower.wants(msg("om_8", { chatId: "oc_alert" })), false);
  assert.equal(t.follower.wants(msg("om_9", { content: "  " })), false);
  // 只发了图片的照样要判断
  assert.equal(t.follower.wants(msg("om_10", { content: "", resources: [{ type: "image", fileKey: "img_1" }] })), true);
  // @ 了机器人的不归跟聊管，走原来的回答
  assert.equal(t.follower.wants(msg("om_11", { mentionedBot: true })), false);
});

test("白名单外的群 @ 了也不跟", () => {
  const t = setup();
  t.follower.track({ ...asked, chatId: "oc_alert" });
  assert.equal(t.follower.wants(msg("om_2", { chatId: "oc_alert" })), false);
});

test("最后一次 @ 之后 2 小时不再跟；期间每次 @ 或接着回过都重新算", () => {
  const t = setup();
  t.follower.track(asked);
  t.advance(FOLLOW_WINDOW_MS - 1000);
  t.follower.track(msg("om_2", { mentionedBot: true }));
  t.advance(FOLLOW_WINDOW_MS - 1000);
  assert.equal(t.follower.wants(msg("om_3")), true);
  t.advance(2000);
  assert.equal(t.follower.wants(msg("om_4")), false);
});

test("判断是对机器人说的才交给处理函数：关着思考调一次模型，带上话题最近几条和这条新消息", async () => {
  const t = setup("是");
  t.follower.track(asked);
  await t.follower.consider(msg("om_2"));

  assert.deepEqual(t.handled, ["om_2"]);
  assert.equal(t.requests.length, 1);
  const [request] = t.requests;
  assert.equal(request.thinking, false);
  assert.equal(request.tools, undefined);
  assert.match(request.system, /飞书 CLI/);
  assert.match(request.system, /拿不准时算不是/);
  const transcript = request.messages[0].content;
  assert.match(transcript, /\[张三\] 最近一小时 gateway 报错多少/);
  assert.match(transcript, /\[机器人\] 最近一小时 gateway 报错 132 次/);
  assert.match(transcript, /新消息（没有 @ 机器人）：\[张三\] 那换成按小时看呢$/);
  assert.match(t.logs.join("\n"), /跟聊：没 @ 的话题消息是对机器人说的，接着回.*message=om_2/);
});

test("判断不是对机器人说的（群成员之间说话、表态）不回，只记日志", async () => {
  const t = setup("否");
  t.follower.track(asked);
  await t.follower.consider(msg("om_2", { content: "好的收到" }));
  assert.deepEqual(t.handled, []);
  assert.deepEqual(t.replies, []);
  assert.match(t.logs.join("\n"), /不是对机器人说的，不回.*message=om_2/);
});

test("判断出错时不回：宁可漏回一句，也不在别人说话时插嘴", async () => {
  const t = setup(new Error("百炼超时"));
  t.follower.track(asked);
  await t.follower.consider(msg("om_2"));
  assert.deepEqual(t.handled, []);
  assert.match(t.logs.join("\n"), /跟聊：判断失败，这条不回 message=om_2：百炼超时/);
});

test("机器人正在做这个话题里的事时说「停止」，不用判断直接交给处理函数停任务；没在做时照常判断", async () => {
  const working = setup("否", true);
  working.follower.track(asked);
  await working.follower.consider(msg("om_2", { content: "停止" }));
  assert.deepEqual(working.handled, ["om_2"]);
  assert.equal(working.requests.length, 0);

  const idle = setup("否");
  idle.follower.track(asked);
  await idle.follower.consider(msg("om_3", { content: "停" }));
  assert.deepEqual(idle.handled, []);
  assert.equal(idle.requests.length, 1);
  assert.doesNotMatch(idle.requests[0].messages[0].content, /机器人正在处理/);
});

test("机器人正在做事时，判断的时候告诉模型它还没回完", async () => {
  const t = setup("是", true);
  t.follower.track(asked);
  await t.follower.consider(msg("om_2", { content: "对了，只看 prod 环境" }));
  assert.match(t.requests[0].messages[0].content, /（机器人正在处理这个话题里的事，还没回完）/);
  assert.deepEqual(t.handled, ["om_2"]);
});

test("话题里不 @ 说「只在 @ 我时回」：回一句，之后这个话题不再跟；再 @ 它照常回答，但不会重新跟", async () => {
  const t = setup("是");
  t.follower.track(asked);
  await t.follower.consider(msg("om_2", { content: "只在 @ 你的时候再回吧" }));
  assert.deepEqual(t.replies, [`om_2 ${MUTED_REPLY}`]);
  assert.deepEqual(t.handled, []);
  assert.equal(t.requests.length, 0);
  assert.equal(t.follower.wants(msg("om_3")), false);

  t.follower.track(msg("om_4", { mentionedBot: true }));
  assert.equal(t.follower.wants(msg("om_5")), false);
});

test("@ 机器人说「别插话」也算，没跟着的话题也记下；群里直接说的、不像静音的话不算", async () => {
  const t = setup();
  assert.equal(await t.follower.muteIfAsked(msg("om_2", { mentionedBot: true, content: "别插话" })), true);
  assert.deepEqual(t.replies, [`om_2 ${MUTED_REPLY}`]);
  t.follower.track(msg("om_3", { mentionedBot: true }));
  assert.equal(t.follower.wants(msg("om_4")), false);

  assert.equal(await t.follower.muteIfAsked(msg("om_5", { mentionedBot: true, rootId: undefined, threadId: undefined, content: "别插话" })), false);
  assert.equal(await t.follower.muteIfAsked(msg("om_6", { mentionedBot: true, rootId: "om_x", content: "不用回滚了，先看日志" })), false);
  // 没 @、也不在跟着的话题里说的，不归它管
  assert.equal(await t.follower.muteIfAsked(msg("om_7", { rootId: "om_y", content: "闭嘴" })), false);
});

test("静音的说法：整句是这个意思才算", () => {
  for (const said of ["只在 @ 我时回", "只在@你的时候回复", "@ 你再回", "以后只有 @ 你才说话", "别插话", "不用回了", "不用你回", "别回了", "闭嘴", "安静点！"]) {
    assert.ok(MUTE_COMMAND.test(said), said);
  }
  for (const said of ["不用回滚了", "别回退版本", "@ 你看下这个报错", "回一下张三", "只在测试环境复现"]) {
    assert.ok(!MUTE_COMMAND.test(said), said);
  }
});
