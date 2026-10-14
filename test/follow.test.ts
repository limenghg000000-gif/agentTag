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

test("@ 机器人说「别插话」也算，没跟着的话题也记下；不像静音的话、没 @ 也不在跟着的话题里说的不算", async () => {
  const t = setup();
  assert.equal(await t.follower.muteIfAsked(msg("om_2", { mentionedBot: true, content: "别插话" })), true);
  assert.deepEqual(t.replies, [`om_2 ${MUTED_REPLY}`]);
  t.follower.track(msg("om_3", { mentionedBot: true }));
  assert.equal(t.follower.wants(msg("om_4")), false);

  assert.equal(await t.follower.muteIfAsked(msg("om_6", { mentionedBot: true, rootId: "om_x", content: "不用回滚了，先看日志" })), false);
  // 没 @、也不在跟着的话题里说的，不归它管
  assert.equal(await t.follower.muteIfAsked(msg("om_7", { rootId: "om_y", content: "闭嘴" })), false);
});

test("在群里直接 @ 它说「只在 @ 我时回」：它回复这条时开的话题也不跟", async () => {
  const t = setup();
  const top = msg("om_top", { mentionedBot: true, rootId: undefined, threadId: undefined, content: "只在 @ 你时回" });
  assert.equal(await t.follower.muteIfAsked(top), true);
  assert.deepEqual(t.replies, [`om_top ${MUTED_REPLY}`]);
  t.follower.track(msg("om_2", { mentionedBot: true, rootId: "om_top" }));
  assert.equal(t.follower.wants(msg("om_3", { rootId: "om_top" })), false);
});

test("静音的话题过了 2 小时再 @ 它，也不会重新跟（机器人运行期间一直记着）", async () => {
  const t = setup();
  t.follower.track(asked);
  await t.follower.consider(msg("om_2", { content: "别插话" }));
  t.advance(FOLLOW_WINDOW_MS + 1000);
  assert.equal(t.follower.wants(msg("om_3", { createTime: START + FOLLOW_WINDOW_MS })), false);
  t.follower.track(msg("om_4", { mentionedBot: true, createTime: START + FOLLOW_WINDOW_MS }));
  assert.equal(t.follower.wants(msg("om_5", { createTime: START + FOLLOW_WINDOW_MS + 1000 })), false);
});

test("开始跟之前发的消息不跟：补漏轮询回看时翻出 @ 之前没 @ 的消息，不拿来判断", () => {
  const t = setup();
  t.follower.track({ ...asked, rootId: "om_root", messageId: "om_at", createTime: START + 60_000 });
  assert.equal(t.follower.wants(msg("om_before", { createTime: START + 30_000 })), false);
  assert.equal(t.follower.wants(msg("om_after", { createTime: START + 90_000 })), true);
  // 跟着期间再 @ 一次，起点不往后挪：两次 @ 之间的追问照样跟
  t.advance(120_000);
  t.follower.track({ ...asked, rootId: "om_root", messageId: "om_at2", createTime: START + 120_000 });
  assert.equal(t.follower.wants(msg("om_between", { createTime: START + 100_000 })), true);
});

test("同时最多判断 3 条，多的排队；排队的太多时新来的不判断", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let inFlight = 0;
  let peak = 0;
  const logs: string[] = [];
  const handled: string[] = [];
  const follower = new ThreadFollower({
    allowedChatIds: new Set(["oc_1"]),
    context: { load: async () => ({ history: [], source: "none" }) },
    model: {
      model: "fake",
      async chat() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await gate;
        inFlight--;
        return { text: "是", finish: "stop" };
      },
    },
    botName: () => "飞书 CLI",
    botOpenId: () => BOT,
    handle: async (m) => {
      handled.push(m.messageId);
    },
    reply: async () => {},
    logger: { info() {}, warn: (line: string) => logs.push(line), error() {} },
    now: () => START,
  });
  // 24 个不同的话题（同一个话题里的是一条一条判断的，见下一个测试）
  const runs = Array.from({ length: 24 }, (_, i) => {
    follower.track({ ...asked, messageId: `om_root_${i}` });
    return follower.consider(msg(`om_${i}`, { rootId: `om_root_${i}`, threadId: `omt_${i}` }));
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(peak, 3);
  release();
  await Promise.all(runs);
  assert.equal(peak, 3);
  assert.equal(handled.length, 23);
  assert.match(logs.join("\n"), /跟聊：要判断的消息太多（3 条在判断、20 条在排队），这条不判断、不回 message=om_23/);
});

test("同一个话题里按收到的顺序判断、交给处理函数：后说的「停止」不会跑到前面那句前面", async () => {
  const gates = new Map<string, () => void>();
  const judging: string[] = [];
  const handled: string[] = [];
  let running = false;
  const follower = new ThreadFollower({
    allowedChatIds: new Set(["oc_1"]),
    context: { load: async () => ({ history: [], source: "none" }) },
    model: {
      model: "fake",
      async chat(request) {
        const said = String(request.messages[0].content).split("\n").at(-1)!;
        judging.push(said);
        await new Promise<void>((resolve) => gates.set(said, resolve));
        return { text: "是", finish: "stop" };
      },
    },
    botName: () => "飞书 CLI",
    botOpenId: () => BOT,
    // 交给处理函数时同步排进任务队列（和真的处理函数一样），任务做完前这个话题算在忙
    busy: () => running,
    handle: (m) => {
      handled.push(m.content);
      if (m.content !== "停止") {
        running = true;
      }
      return Promise.resolve();
    },
    reply: async () => {},
    logger: { info() {}, warn() {}, error() {} },
    now: () => START,
  });
  follower.track(asked);
  const first = follower.consider(msg("om_2", { content: "把这个结论写进周报文档" }));
  const second = follower.consider(msg("om_3", { content: "停止" }));
  // 第一条还在判断时，第二条不判断、不交出去
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(judging.length, 1);
  assert.match(judging[0], /把这个结论写进周报文档/);
  assert.deepEqual(handled, []);
  gates.get(judging[0])!();
  await Promise.all([first, second]);
  // 第一条交出去以后话题在忙，「停止」不用判断直接交给处理函数，排在后面
  assert.deepEqual(handled, ["把这个结论写进周报文档", "停止"]);
  assert.equal(judging.length, 1);
});

test("同一个话题里后面的判断不等前面的任务做完", async () => {
  let finishTask!: () => void;
  const handled: string[] = [];
  const follower = new ThreadFollower({
    allowedChatIds: new Set(["oc_1"]),
    context: { load: async () => ({ history: [], source: "none" }) },
    model: { model: "fake", chat: async () => ({ text: "是", finish: "stop" }) },
    botName: () => "飞书 CLI",
    botOpenId: () => BOT,
    handle: (m) => {
      handled.push(m.messageId);
      return m.messageId === "om_2" ? new Promise<void>((resolve) => (finishTask = resolve)) : Promise.resolve();
    },
    reply: async () => {},
    logger: { info() {}, warn() {}, error() {} },
    now: () => START,
  });
  follower.track(asked);
  const first = follower.consider(msg("om_2"));
  await follower.consider(msg("om_3", { content: "对了，只看 prod 环境" }));
  assert.deepEqual(handled, ["om_2", "om_3"]);
  finishTask();
  await first;
});

test("静音的说法：整句是这个意思才算", () => {
  for (const said of ["只在 @ 我时回", "只在@你的时候回复", "@ 你再回", "以后只有 @ 你才说话", "别插话", "不用回了", "不用你回", "别回了", "闭嘴", "安静点！"]) {
    assert.ok(MUTE_COMMAND.test(said), said);
  }
  for (const said of ["不用回滚了", "别回退版本", "@ 你看下这个报错", "回一下张三", "只在测试环境复现"]) {
    assert.ok(!MUTE_COMMAND.test(said), said);
  }
});
