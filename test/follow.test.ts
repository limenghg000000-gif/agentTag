import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { MUTE_COMMAND, MUTED_REPLY, ThreadFollower } from "../src/follow.js";

const DAY = 24 * 60 * 60_000;
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

function setup(
  judge: string | Error = "是",
  busy = false,
  declined?: (msg: NormalizedMessage, recent: readonly string[]) => Promise<void>,
  stateFile?: string,
) {
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
    ...(declined ? { declined } : {}),
    ...(stateFile ? { stateFile } : {}),
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
  // 群主界面引用回复话题第一条的：只有 rootId、没有 threadId，是群主界面的消息，不归跟聊
  assert.equal(t.follower.wants(msg("om_5", { threadId: undefined })), false);
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

test("回答过的话题一直跟，不限时间（和 Claude Tag 一样）：隔了几个小时、几天回来接着问都不用 @", () => {
  const t = setup();
  t.follower.track(asked);
  t.advance(2 * 60 * 60_000 + 43 * 60_000);
  assert.equal(t.follower.wants(msg("om_2", { createTime: START + 2 * 60 * 60_000 + 43 * 60_000 })), true);
  t.advance(30 * DAY);
  assert.equal(t.follower.wants(msg("om_3", { createTime: START + 31 * DAY })), true);
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

test("判断不是对机器人说的：交给 declined 看群记忆，带上判断时读到的话题最近几条；判断失败、机器人在做事时不交", async () => {
  const declined: Array<{ id: string; recent: readonly string[] }> = [];
  const onDeclined = async (m: NormalizedMessage, recent: readonly string[]) => {
    declined.push({ id: m.messageId, recent });
  };
  const t = setup("否", false, onDeclined);
  t.follower.track(asked);
  await t.follower.consider(msg("om_2", { content: "测试库地址是哪个来着" }));
  assert.deepEqual(t.handled, []);
  assert.deepEqual(declined, [
    { id: "om_2", recent: ["[张三] 最近一小时 gateway 报错多少", "[机器人] 最近一小时 gateway 报错 132 次，主要是 code=8"] },
  ]);
  // 是对它说的照常回答，不交
  const yes = setup("是", false, onDeclined);
  yes.follower.track(asked);
  await yes.follower.consider(msg("om_3"));
  assert.deepEqual(yes.handled, ["om_3"]);
  // 判断失败的、机器人在做事时的不交
  await setup(new Error("百炼超时"), false, onDeclined).follower.consider(msg("om_4"));
  const busy = setup("否", true, onDeclined);
  busy.follower.track(asked);
  await busy.follower.consider(msg("om_5"));
  assert.deepEqual(
    declined.map((d) => d.id),
    ["om_2"],
  );
});

test("判断出错时不回：宁可漏回一句，也不在别人说话时插嘴", async () => {
  const t = setup(new Error("百炼超时"));
  t.follower.track(asked);
  await t.follower.consider(msg("om_2"));
  assert.deepEqual(t.handled, []);
  assert.match(t.logs.join("\n"), /跟聊：判断失败，这条不回 message=om_2：百炼超时/);
});

test("读话题上文卡住也算在判断时限里：到点就不回，不一直占着判断的名额", async () => {
  const askedRoot = asked;
  const handled: string[] = [];
  const logs: string[] = [];
  let calls = 0;
  const follower = new ThreadFollower({
    allowedChatIds: new Set(["oc_1"]),
    context: { load: () => new Promise(() => {}) },
    model: {
      model: "fake",
      chat: async () => {
        calls++;
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
    judgeTimeoutMs: 20,
  });
  follower.track(askedRoot);
  await follower.consider(msg("om_2"));
  assert.deepEqual(handled, []);
  assert.equal(calls, 0);
  assert.match(logs.join("\n"), /跟聊：判断失败，这条不回 message=om_2/);
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

test("静音的话题过了几天再 @ 它，也不会重新跟", async () => {
  const t = setup();
  t.follower.track(asked);
  await t.follower.consider(msg("om_2", { content: "别插话" }));
  t.advance(3 * DAY);
  assert.equal(t.follower.wants(msg("om_3", { createTime: START + 3 * DAY })), false);
  t.follower.track(msg("om_4", { mentionedBot: true, createTime: START + 3 * DAY }));
  assert.equal(t.follower.wants(msg("om_5", { createTime: START + 3 * DAY + 1000 })), false);
});

test("配了记录文件：重启后接着跟回答过的话题，说过「只在 @ 我时回」的照样不跟", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "follow-"));
  const file = path.join(dir, "follow.json");
  try {
    const before = setup("是", false, undefined, file);
    before.follower.track(asked);
    before.follower.track(msg("om_muted_at", { mentionedBot: true, rootId: "om_muted", threadId: "omt_9" }));
    await before.follower.consider(msg("om_quiet", { rootId: "om_muted", threadId: "omt_9", content: "别插话" }));
    await before.follower.flush();
    const saved = JSON.parse(await readFile(file, "utf8")) as { threads: Record<string, unknown>; muted: string[] };
    assert.deepEqual(Object.keys(saved.threads), ["om_root"]);
    assert.deepEqual(saved.muted, ["om_muted"]);

    // 重启：新的跟聊从文件里接着跟
    const after = setup("是", false, undefined, file);
    after.advance(60_000);
    await after.follower.init();
    assert.equal(after.follower.wants(msg("om_2", { createTime: START + 60_000 })), true);
    // 开始跟的起点也接着用：@ 之前发的照样不跟
    assert.equal(after.follower.wants(msg("om_old", { createTime: START - 1000 })), false);
    // 静音的话题重启后再 @ 它，也不会重新跟
    after.follower.track(msg("om_muted_at2", { mentionedBot: true, rootId: "om_muted", threadId: "omt_9", createTime: START + 60_000 }));
    assert.equal(after.follower.wants(msg("om_3", { rootId: "om_muted", threadId: "omt_9", createTime: START + 61_000 })), false);
    assert.ok(after.logs.some((line) => line.includes("接着跟重启前回答过的 1 个话题，1 个话题说过只在 @ 时回")));
    await after.follower.flush();

    // 停了几天才重启的照样跟
    const late = setup("是", false, undefined, file);
    late.advance(3 * DAY);
    await late.follower.init();
    assert.equal(late.follower.wants(msg("om_4", { createTime: START + 3 * DAY })), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("记录文件还没有时从空的开始、不报警；读坏了打一行警告，也从空的开始", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "follow-"));
  const file = path.join(dir, "follow.json");
  try {
    const fresh = setup("是", false, undefined, file);
    await fresh.follower.init();
    assert.equal(fresh.follower.wants(msg("om_2")), false);
    assert.ok(!fresh.logs.some((line) => line.includes("读不了") || line.includes("格式不对")));

    for (const broken of ["{", "null", "[]"]) {
      await writeFile(file, broken, "utf8");
      const t = setup("是", false, undefined, file);
      await t.follower.init();
      assert.equal(t.follower.wants(msg("om_2")), false);
      if (broken !== "[]") {
        assert.ok(t.logs.some((line) => line.includes("格式不对")), broken);
      }
    }

    // 读坏了以后照样能记：下一次 @ 写回好的
    const t = setup("是", false, undefined, file);
    await t.follower.init();
    t.follower.track(asked);
    await t.follower.flush();
    assert.deepEqual(Object.keys((JSON.parse(await readFile(file, "utf8")) as { threads: object }).threads), ["om_root"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("排队等判断的时候话题里有人说了「只在 @ 我时回」：轮到时不再问模型、不回", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const logs: string[] = [];
  const handled: string[] = [];
  const follower = new ThreadFollower({
    allowedChatIds: new Set(["oc_1"]),
    context: { load: async () => ({ history: [], source: "none" }) },
    model: {
      model: "fake",
      async chat() {
        calls++;
        await gate;
        return { text: "是", finish: "stop" };
      },
    },
    botName: () => "飞书 CLI",
    botOpenId: () => BOT,
    handle: async (m) => {
      handled.push(m.messageId);
    },
    reply: async () => {},
    logger: { info: (line: string) => logs.push(line), warn: (line: string) => logs.push(line), error() {} },
    now: () => START,
  });
  // 4 个话题，同时最多判断 3 条，第 4 个话题的那条排队
  const runs = Array.from({ length: 4 }, (_, i) => {
    follower.track({ ...asked, messageId: `om_root_${i}` });
    return follower.consider(msg(`om_${i}`, { rootId: `om_root_${i}`, threadId: `omt_${i}` }));
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 3);
  await follower.consider(msg("om_mute", { rootId: "om_root_3", threadId: "omt_3", content: "只在 @ 我时回" }));
  release();
  await Promise.all(runs);
  assert.equal(calls, 3);
  assert.deepEqual(handled.sort(), ["om_0", "om_1", "om_2"]);
  assert.match(logs.join("\n"), /跟聊：排队判断的这会儿话题里有人说了停止或只在 @ 时回，这条不判断了 message=om_3/);
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

test("@ 了机器人的消息也排在同一话题里还在判断的消息后面；「@机器人 停止」让前面还没交出去的作废", async () => {
  const gates: Array<() => void> = [];
  const handled: string[] = [];
  const follower = new ThreadFollower({
    allowedChatIds: new Set(["oc_1"]),
    context: { load: async () => ({ history: [], source: "none" }) },
    model: {
      model: "fake",
      chat: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return { text: "是", finish: "stop" };
      },
    },
    botName: () => "飞书 CLI",
    botOpenId: () => BOT,
    handle: async (m) => {
      handled.push(m.content);
    },
    reply: async () => {},
    logger: { info() {}, warn() {}, error() {} },
    now: () => START,
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
  follower.track(asked);

  // 普通的 @：排在前面那句后面
  const first = follower.consider(msg("om_2", { content: "把这个结论写进周报文档" }));
  const ask = msg("om_3", { content: "顺便查下 union", mentionedBot: true });
  const asking = follower.answerInTurn(ask, async () => {
    handled.push(ask.content);
  });
  await tick();
  assert.equal(handled.length, 0);
  gates.shift()!();
  await Promise.all([first, asking]);
  assert.deepEqual(handled, ["把这个结论写进周报文档", "顺便查下 union"]);

  // 「@机器人 停止」马上处理，不等正在判断的那句；那句判断完也不交出去，排着的（没 @ 的、@ 了的）都作废
  const writing = follower.consider(msg("om_4", { content: "再追加一段到周报文档" }));
  const queued = follower.consider(msg("om_5", { content: "还有这段也加上" }));
  const queuedAsk = msg("om_5b", { content: "顺便改下文档", mentionedBot: true });
  const queuedAsking = follower.answerInTurn(queuedAsk, async () => {
    handled.push(queuedAsk.content);
  });
  await tick();
  assert.equal(gates.length, 1, "第一句在判断");
  const stop = msg("om_6", { content: "停止", mentionedBot: true });
  await follower.answerInTurn(stop, async () => {
    handled.push(stop.content);
  });
  assert.deepEqual(handled.slice(2), ["停止"], "不等判断就停");
  gates.shift()!();
  await Promise.all([writing, queued, queuedAsking]);
  assert.deepEqual(handled.slice(2), ["停止"]);
  assert.equal(gates.length, 0, "排着的那句没再判断");

  // 点按钮问的（commands=false）按钮上写着「停止」也只是普通的一条：排在正在判断的那句后面，也不让它作废
  const judging = follower.consider(msg("om_6c", { content: "再查一下" }));
  await tick();
  const button = msg("om_6b", { content: "停止", mentionedBot: true });
  const pressing = follower.answerInTurn(button, async () => {
    handled.push("按钮");
  }, false);
  await tick();
  assert.equal(handled.at(-1), "停止");
  gates.shift()!();
  await Promise.all([judging, pressing]);
  assert.deepEqual(handled.slice(-2), ["再查一下", "按钮"]);

  // 没有在判断的消息时马上处理，处理的这个话题之后也跟着
  const other = msg("om_7", { content: "看下 union", mentionedBot: true, rootId: "om_root_2", threadId: "omt_2" });
  await follower.answerInTurn(other, async () => {
    handled.push(other.content);
  });
  assert.equal(handled.at(-1), "看下 union");
  assert.equal(follower.wants(msg("om_8", { rootId: "om_root_2", threadId: "omt_2" })), true);
});

test("同一个话题里最多排 5 条；排满了说「只在 @ 我时回」也马上静音，排着的不再判断、判断完的也不交出去", async () => {
  const gates: Array<() => void> = [];
  const judged: string[] = [];
  const logs: string[] = [];
  const replies: string[] = [];
  const follower = new ThreadFollower({
    allowedChatIds: new Set(["oc_1"]),
    context: { load: async () => ({ history: [], source: "none" }) },
    model: {
      model: "fake",
      chat: async (request) => {
        judged.push(String(request.messages[0].content).split("\n").at(-1)!);
        await new Promise<void>((resolve) => gates.push(resolve));
        return { text: "是", finish: "stop" };
      },
    },
    botName: () => "飞书 CLI",
    botOpenId: () => BOT,
    handle: async (m) => {
      handled.push(m.messageId);
    },
    reply: async (_m, markdown) => {
      replies.push(markdown);
    },
    logger: { info() {}, warn: (line: string) => logs.push(line), error() {} },
    now: () => START,
  });
  const handled: string[] = [];
  follower.track(asked);
  const runs = ["第一句", "第二句", "第三句", "第四句", "第五句", "第六句"].map((content, i) => follower.consider(msg(`om_${2 + i}`, { content })));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(logs.join("\n"), /跟聊：这个话题里还有 5 条没判断完，这条不判断、不回 thread=om_root message=om_7/);
  // 排满了，静音照样马上生效，不用等第一句判断完
  await follower.consider(msg("om_8", { content: "别插话" }));
  assert.deepEqual(replies, [MUTED_REPLY]);
  gates.shift()!();
  await Promise.all(runs);
  // 只判断了第一句，判断是对它说的也不交出去；静音以后排着的都不判断
  assert.equal(judged.length, 1);
  assert.match(judged[0], /第一句/);
  assert.deepEqual(handled, []);
});

test("机器人在做事时，排满了说「停止」也马上交给处理函数停任务；排着的作废", async () => {
  const gates: Array<() => void> = [];
  const handled: string[] = [];
  const follower = new ThreadFollower({
    allowedChatIds: new Set(["oc_1"]),
    context: { load: async () => ({ history: [], source: "none" }) },
    model: {
      model: "fake",
      chat: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return { text: "是", finish: "stop" };
      },
    },
    botName: () => "飞书 CLI",
    botOpenId: () => BOT,
    busy: () => true,
    handle: async (m) => {
      handled.push(m.messageId);
    },
    reply: async () => {},
    logger: { info() {}, warn() {}, error() {} },
    now: () => START,
  });
  follower.track(asked);
  const runs = ["第一句", "第二句", "第三句", "第四句", "第五句"].map((content, i) => follower.consider(msg(`om_${2 + i}`, { content })));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await follower.consider(msg("om_9", { content: "停止" }));
  assert.deepEqual(handled, ["om_9"]);
  gates.shift()!();
  await Promise.all(runs);
  assert.deepEqual(handled, ["om_9"]);
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
