import assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { CATCHUP_GRACE_MS, CATCHUP_LOOKBACK_MS, CatchUpPoller, HandledMessages, THREAD_WATCH_MS } from "../src/catchup.js";
import type { FeishuApi, RecentMessage } from "../src/feishu.js";

const quiet = { info() {}, warn() {}, error() {} };
const START = 1_000_000_000_000;

function msg(messageId: string, createTime: number, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId,
    chatId: "oc_1",
    chatType: "group",
    senderId: "ou_1",
    content: "ping",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime,
    ...extra,
  };
}

function setup(listing: { chat?: RecentMessage[]; threads?: Record<string, RecentMessage[]> } = {}) {
  let now = START;
  const calls: string[] = [];
  const api: Pick<FeishuApi, "listRecentMessages"> = {
    async listRecentMessages(container, id, _limit, sinceMs) {
      calls.push(`${container} ${id}${sinceMs === undefined ? "" : ` since=${sinceMs}`}`);
      if (container === "chat") {
        return listing.chat ?? [];
      }
      return listing.threads?.[id] ?? [];
    },
  };
  const handledIds: string[] = [];
  const logs: string[] = [];
  const handled = new HandledMessages();
  const poller = new CatchUpPoller({
    api,
    chatIds: new Set(["oc_1"]),
    handled,
    handle: async (m) => {
      handledIds.push(m.messageId);
    },
    logger: { ...quiet, info: (line: string) => logs.push(line) },
    now: () => now,
    since: START,
  });
  return {
    poller,
    handled,
    calls,
    handledIds,
    logs,
    listing,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

const user = (m: NormalizedMessage): RecentMessage => ({ message: m, fromBot: false });

test("补上群里 @ 了机器人、却没从事件收到的消息，并在日志里说明", async () => {
  const t = setup();
  t.advance(60_000);
  t.listing.chat = [user(msg("om_lost", START + 30_000))];

  assert.equal(await t.poller.pollOnce(), 1);
  assert.deepEqual(t.handledIds, ["om_lost"]);
  assert.deepEqual(t.calls, [`chat oc_1 since=${START}`]);
  assert.match(t.logs[0], /补漏.*message=om_lost/);

  // 同一条不会补第二次
  assert.equal(await t.poller.pollOnce(), 0);
  assert.deepEqual(t.handledIds, ["om_lost"]);
});

test("事件已经收到的消息不再补；轮询补上的消息，事件晚到时也认领不到", async () => {
  const t = setup();
  t.advance(60_000);
  t.handled.claim("om_event");
  t.listing.chat = [user(msg("om_event", START + 10_000)), user(msg("om_late", START + 20_000))];

  await t.poller.pollOnce();

  assert.deepEqual(t.handledIds, ["om_late"]);
  assert.equal(t.handled.claim("om_late"), false);
});

test("刚发出的消息先等事件，过了等待时间还没收到才补", async () => {
  const t = setup();
  t.advance(60_000);
  t.listing.chat = [user(msg("om_new", t.at() - 1000))];

  assert.equal(await t.poller.pollOnce(), 0);
  t.advance(CATCHUP_GRACE_MS);
  assert.equal(await t.poller.pollOnce(), 1);
});

test("不补：没 @ 机器人、@所有人、机器人自己发的、启动前或太久以前的、白名单外的群", async () => {
  const t = setup();
  t.advance(CATCHUP_LOOKBACK_MS + 120_000);
  const recent = t.at() - 60_000;
  t.listing.chat = [
    user(msg("om_plain", recent, { mentionedBot: false })),
    user(msg("om_all", recent, { mentionAll: true })),
    { message: msg("om_bot", recent), fromBot: true },
    user(msg("om_before_start", START - 1000)),
    user(msg("om_too_old", t.at() - CATCHUP_LOOKBACK_MS - 1000)),
    user(msg("om_other_chat", recent, { chatId: "oc_other" })),
    user(msg("om_ok", recent)),
  ];

  await t.poller.pollOnce();

  assert.deepEqual(t.handledIds, ["om_ok"]);
  assert.deepEqual(t.calls, [`chat oc_1 since=${t.at() - CATCHUP_LOOKBACK_MS}`]);
});

test("机器人回复过的消息变成话题后，也盯着话题里的追问", async () => {
  const t = setup();
  t.advance(60_000);
  t.handled.claim("om_root");
  t.listing.chat = [user(msg("om_root", START + 10_000, { threadId: "omt_1" }))];
  t.listing.threads = {
    omt_1: [
      user(msg("om_followup", START + 50_000, { rootId: "om_root", threadId: "omt_1" })),
      user(msg("om_chat_in_thread", START + 51_000, { rootId: "om_root", threadId: "omt_1", mentionedBot: false })),
    ],
  };

  await t.poller.pollOnce();

  assert.deepEqual(t.calls, [`chat oc_1 since=${START}`, "thread omt_1"]);
  assert.deepEqual(t.handledIds, ["om_followup"]);
  assert.equal(t.poller.watchedThreads, 1);
});

test("话题里跟聊：没 @ 机器人的话题消息，跟聊要跟的也补上，交给跟聊判断；不要的、应用发的照样不补", async () => {
  const considered: string[] = [];
  const handledIds: string[] = [];
  const asked: string[] = [];
  const logs: string[] = [];
  const handled = new HandledMessages();
  handled.claim("om_root");
  const thread = (id: string, at: number, extra: Partial<NormalizedMessage> = {}) =>
    msg(id, at, { rootId: "om_root", threadId: "omt_1", mentionedBot: false, ...extra });
  const poller = new CatchUpPoller({
    api: {
      async listRecentMessages(container) {
        if (container === "chat") {
          return [user(msg("om_root", START + 10_000, { threadId: "omt_1" }))];
        }
        return [
          user(thread("om_follow", START + 50_000)),
          user(thread("om_to_others", START + 51_000, { content: "张三你看下" })),
          { message: thread("om_app", START + 52_000), fromBot: false, fromApp: true },
          user(thread("om_mention", START + 53_000, { mentionedBot: true })),
        ];
      },
    },
    chatIds: new Set(["oc_1"]),
    handled,
    handle: async (m) => {
      handledIds.push(m.messageId);
    },
    follow: {
      wants(m, fromApp) {
        asked.push(`${m.messageId}${fromApp ? " app" : ""}`);
        return !fromApp && m.messageId === "om_follow";
      },
      async consider(m) {
        considered.push(m.messageId);
      },
    },
    logger: { ...quiet, info: (line: string) => logs.push(line) },
    now: () => START + 60_000,
    since: START,
  });

  assert.equal(await poller.pollOnce(), 2);
  assert.deepEqual(considered, ["om_follow"]);
  assert.deepEqual(handledIds, ["om_mention"]);
  assert.deepEqual(asked, ["om_follow", "om_to_others", "om_app app"]);
  assert.match(logs.join("\n"), /补漏：没 @ 机器人的消息事件没送到，由轮询补上 chat=oc_1 message=om_follow/);
  // 补过的不再补
  assert.equal(await poller.pollOnce(), 0);
});

test("接口按从新到旧返回，补的时候从旧到新交出去：同一个话题里先说的先处理", async () => {
  const t = setup({
    chat: [user(msg("om_new", START + 30_000)), user(msg("om_mid", START + 20_000)), user(msg("om_old", START + 10_000))],
  });
  t.advance(60_000);
  assert.equal(await t.poller.pollOnce(), 3);
  assert.deepEqual(t.handledIds, ["om_old", "om_mid", "om_new"]);
});

test("读到的每条人发的消息都报给 observe（补不补都算），机器人和应用发的、白名单外的不报", async () => {
  const observed: string[] = [];
  const poller = new CatchUpPoller({
    api: {
      async listRecentMessages() {
        return [
          user(msg("om_plain", START + 10_000, { mentionedBot: false })),
          user(msg("om_at", START + 11_000)),
          { message: msg("om_bot", START + 12_000), fromBot: true },
          { message: msg("om_app", START + 13_000, { mentionedBot: false }), fromBot: false, fromApp: true },
          user(msg("om_other_chat", START + 14_000, { chatId: "oc_9", mentionedBot: false })),
        ];
      },
    },
    chatIds: new Set(["oc_1"]),
    handled: new HandledMessages(),
    handle: async () => {},
    observe: (m) => observed.push(m.messageId),
    logger: quiet,
    now: () => START + 60_000,
    since: START,
  });
  await poller.pollOnce();
  assert.deepEqual(observed, ["om_plain", "om_at"]);
});

test("事件收到的话题消息也开始盯这个话题；很久没动静的话题不再盯", async () => {
  const t = setup();
  t.poller.watch(msg("om_1", START, { rootId: "om_root", threadId: "omt_1" }));
  t.poller.watch(msg("om_2", START, { chatId: "oc_other", threadId: "omt_other" }));
  assert.equal(t.poller.watchedThreads, 1);

  t.advance(THREAD_WATCH_MS + 1);
  await t.poller.pollOnce();

  assert.equal(t.poller.watchedThreads, 0);
  assert.deepEqual(t.calls, [`chat oc_1 since=${t.at() - CATCHUP_LOOKBACK_MS}`]);
});

test("定时轮询：接口失败只提示一次，恢复后再提示；停止后不再轮询", async () => {
  let fail = true;
  let polls = 0;
  const warnings: string[] = [];
  const infos: string[] = [];
  const poller = new CatchUpPoller({
    api: {
      async listRecentMessages() {
        polls++;
        if (fail) {
          throw Object.assign(new Error("boom"), { response: { data: { code: 99991400, msg: "rate limited" } } });
        }
        return [];
      },
    },
    chatIds: new Set(["oc_1"]),
    handled: new HandledMessages(),
    handle: async () => {},
    intervalMs: 5,
    logger: { ...quiet, warn: (line: string) => warnings.push(line), info: (line: string) => infos.push(line) },
  });

  poller.start();
  await waitFor(() => polls >= 3);
  fail = false;
  const before = polls;
  await waitFor(() => polls >= before + 2);
  await poller.stop();
  const stopped = polls;
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /code=99991400 rate limited/);
  assert.deepEqual(infos, ["补漏轮询恢复正常"]);
  assert.equal(polls, stopped);
});

test("处理补上的消息出错时记日志，不影响轮询", async () => {
  const errors: string[] = [];
  const poller = new CatchUpPoller({
    api: { listRecentMessages: async () => [user(msg("om_1", START))] },
    chatIds: new Set(["oc_1"]),
    handled: new HandledMessages(),
    handle: async () => {
      throw new Error("handler failed");
    },
    logger: { ...quiet, error: (line: string) => errors.push(line) },
    now: () => START + 60_000,
    since: START - 1,
  });

  assert.equal(await poller.pollOnce(), 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(errors[0], /补漏处理失败 message=om_1/);
});

test("已处理的消息 id 只记最近的若干条", () => {
  const handled = new HandledMessages(2);
  assert.equal(handled.claim("a"), true);
  assert.equal(handled.claim("a"), false);
  handled.claim("b");
  handled.claim("c");
  assert.equal(handled.has("a"), false);
  assert.equal(handled.has("c"), true);
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
