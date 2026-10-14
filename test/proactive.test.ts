import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { ThreadMessage } from "../src/feishu.js";
import type { ChatModel, ChatRequest } from "../src/llm.js";
import type { MemoryEntry } from "../src/memory.js";
import { MAX_JUDGED_PER_HOUR, PAUSE_COMMAND, ProactiveReplier, RESUME_COMMAND } from "../src/proactive.js";

const START = Date.UTC(2026, 9, 14, 2, 0, 0);
const BOT = "ou_bot";
const HOUR = 60 * 60_000;

function msg(messageId: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId,
    chatId: "oc_1",
    chatType: "group",
    senderId: "ou_1",
    senderName: "张三",
    content: "测试环境的数据库地址是哪个来着",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: START,
    ...extra,
  };
}

async function setup(
  opts: { judge?: string | Error | (() => Promise<string>); enabled?: string[]; maxPerHour?: number; superseded?: (msg: NormalizedMessage) => boolean } = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), "proactive-"));
  const stateFile = path.join(dir, "proactive.json");
  let now = START;
  const requests: ChatRequest[] = [];
  const replies: string[] = [];
  const replied: string[] = [];
  const logs: string[] = [];
  const chat: ThreadMessage[] = [
    { messageId: "om_0", fromBot: false, senderName: "李四", senderId: "ou_2", msgType: "text", content: "测试库换成 db-test-2 了", createTime: START - 60_000 },
  ];
  const memoryEntries: MemoryEntry[] = [
    { id: 3, kind: "background", content: "测试环境数据库是 db-test-2.internal", author: "李四", createdAt: new Date(START - HOUR).toISOString() },
  ];
  const judge = opts.judge ?? "不接";
  const model: ChatModel = {
    model: "fake",
    async chat(request) {
      requests.push(request);
      if (judge instanceof Error) {
        throw judge;
      }
      return { text: typeof judge === "function" ? await judge() : judge, finish: "stop" };
    },
  };
  const make = () =>
    new ProactiveReplier({
      allowedChatIds: new Set(["oc_1", "oc_2"]),
      enabledChatIds: new Set(opts.enabled ?? ["oc_1"]),
      stateFile,
      api: { listChatMessages: async () => chat },
      memory: { list: async () => structuredClone(memoryEntries) },
      model,
      botName: () => "飞书 CLI",
      botOpenId: () => BOT,
      reply: async (m, markdown) => {
        replies.push(`${m.messageId} ${markdown}`);
      },
      onReplied: (m) => replied.push(m.messageId),
      ...(opts.maxPerHour ? { maxPerHour: opts.maxPerHour } : {}),
      ...(opts.superseded ? { superseded: opts.superseded } : {}),
      logger: { info: (line: string) => logs.push(line), warn: (line: string) => logs.push(line), error: (line: string) => logs.push(line) },
      now: () => now,
    });
  const replier = make();
  await replier.init();
  return {
    replier,
    make,
    stateFile,
    requests,
    replies,
    replied,
    logs,
    advance: (ms: number) => {
      now += ms;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("打开了的群主界面、人发的、有内容的消息才判断", async () => {
  const t = await setup();
  try {
    assert.equal(t.replier.wants(msg("om_1")), true);
    // 没打开的群、话题里的（归跟聊）、@ 了机器人的、@ 了别人的、@所有人
    assert.equal(t.replier.wants(msg("om_2", { chatId: "oc_2" })), false);
    assert.equal(t.replier.wants(msg("om_3", { rootId: "om_root", threadId: "omt_1" })), false);
    assert.equal(t.replier.wants(msg("om_4", { mentionedBot: true })), false);
    assert.equal(t.replier.wants(msg("om_5", { mentions: [{ key: "@_user_1", openId: "ou_2", name: "李四" }] })), false);
    assert.equal(t.replier.wants(msg("om_6", { mentionAll: true })), false);
    // 机器人自己、别的应用、不是 ou_ 的发言人
    assert.equal(t.replier.wants(msg("om_7", { senderId: BOT })), false);
    assert.equal(t.replier.wants(msg("om_8"), true), false);
    assert.equal(t.replier.wants(msg("om_9", { senderId: "cli_x" })), false);
    // 太短的、只是表态的、只有图片的
    assert.equal(t.replier.wants(msg("om_10", { content: "嗯嗯" })), false);
    assert.equal(t.replier.wants(msg("om_11", { content: "收到！" })), false);
    assert.equal(t.replier.wants(msg("om_12", { content: "谢谢大家" })), false);
    assert.equal(t.replier.wants(msg("om_13", { content: "![image](img_1)" })), false);
    // 回复群里某条（不在话题里）的照样判断
    assert.equal(t.replier.wants(msg("om_14", { rootId: "om_0", replyToMessageId: "om_0" })), true);
  } finally {
    await t.cleanup();
  }
});

test("模型说不接就不回；说接就在这条下面回一句，当天第一次带上怎么关，回完交给跟聊", async () => {
  const t = await setup({ judge: "接：测试库是 db-test-2.internal（群记忆 #3）" });
  try {
    await t.replier.consider(msg("om_1"));
    assert.equal(t.replies.length, 1);
    assert.match(t.replies[0], /^om_1 测试库是 db-test-2\.internal（群记忆 #3）\n\n（没 @ 我，我看到了就接一句。不需要的话 @ 我说「别主动插话」。）$/);
    assert.deepEqual(t.replied, ["om_1"]);
    // 同一天第二次不再带提示
    t.advance(60_000);
    await t.replier.consider(msg("om_2", { createTime: START + 60_000 }));
    assert.equal(t.replies[1], "om_2 测试库是 db-test-2.internal（群记忆 #3）");

    // 判断用的是群记忆、刚才的群聊和这条消息，关着思考
    const request = t.requests[0];
    assert.equal(request.thinking, false);
    assert.match(request.system, /大多数时候不接/);
    const content = String(request.messages[0].content);
    assert.match(content, /#3 测试环境数据库是 db-test-2\.internal（李四/);
    assert.match(content, /\[李四\] 测试库换成 db-test-2 了/);
    assert.match(content, /新消息（没有 @ 你）：\[张三\] 测试环境的数据库地址是哪个来着/);
  } finally {
    await t.cleanup();
  }

  const quiet = await setup({ judge: "不接" });
  try {
    await quiet.replier.consider(msg("om_1"));
    assert.deepEqual(quiet.replies, []);
    assert.deepEqual(quiet.replied, []);
    assert.match(quiet.logs.join("\n"), /主动接话：不接 chat=oc_1 message=om_1/);
  } finally {
    await quiet.cleanup();
  }
});

test("模型出错、超时、格式不对都不回", async () => {
  for (const judge of [new Error("timeout"), "要不要我查一下？", "", "接："]) {
    const t = await setup({ judge });
    try {
      await t.replier.consider(msg("om_1"));
      assert.deepEqual(t.replies, [], String(judge));
    } finally {
      await t.cleanup();
    }
  }
});

test("回的话里的尖括号换成全角，不能变成 @所有人；太长的截断", async () => {
  const t = await setup({ judge: `接：<at id=all></at> ${"很长".repeat(150)}` });
  try {
    await t.replier.consider(msg("om_1"));
    const said = t.replies[0].split("\n\n")[0];
    assert.doesNotMatch(said, /[<>]/);
    assert.match(said, /＜at id=all＞＜\/at＞/);
    assert.ok(said.length <= "om_1 ".length + 201, `${said.length}`);
    assert.ok(said.endsWith("…"));
  } finally {
    await t.cleanup();
  }
});

test("每个群每小时最多回几次，过了一小时恢复", async () => {
  const t = await setup({ judge: "接：要我帮忙查一下吗？", maxPerHour: 2 });
  try {
    await t.replier.consider(msg("om_1"));
    await t.replier.consider(msg("om_2"));
    await t.replier.consider(msg("om_3"));
    assert.equal(t.replies.length, 2);
    // 到了上限就不再问模型
    assert.equal(t.requests.length, 2);
    assert.match(t.logs.join("\n"), /这一小时已经主动回了 2 次/);
    // 过了一小时又能回
    t.advance(HOUR);
    await t.replier.consider(msg("om_4"));
    assert.equal(t.replies.length, 3);
  } finally {
    await t.cleanup();
  }
});

test("每个群每小时最多判断 120 条，后面的不问模型", async () => {
  const t = await setup({ judge: "不接" });
  try {
    for (let i = 0; i < MAX_JUDGED_PER_HOUR + 5; i++) {
      await t.replier.consider(msg(`om_${i}`));
    }
    assert.equal(t.requests.length, MAX_JUDGED_PER_HOUR);
    // 上限的日志一小时只记一次
    assert.equal(t.logs.filter((line) => line.includes("这一小时已经判断了")).length, 1);
  } finally {
    await t.cleanup();
  }
});

test("判断的时候有人说了「别主动插话」：判断完不回", async () => {
  let release!: (text: string) => void;
  const t = await setup({ judge: () => new Promise<string>((resolve) => (release = resolve)) });
  try {
    const pending = t.replier.consider(msg("om_1"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await t.replier.toggleIfAsked(msg("om_2", { mentionedBot: true, content: "别主动插话" })), true);
    release("接：要我帮忙查一下吗？");
    await pending;
    assert.equal(t.replies.length, 1);
    assert.match(t.replies[0], /^om_2 好的，这个群里我不主动接话了/);
  } finally {
    await t.cleanup();
  }
});

test("判断完发现是话题里「同时发送到群」的副本：不回（话题里那份归跟聊）", async () => {
  const t = await setup({ judge: "接：要我帮忙查一下吗？", superseded: (m) => m.messageId === "om_copy" });
  try {
    await t.replier.consider(msg("om_copy"));
    assert.deepEqual(t.replies, []);
    await t.replier.consider(msg("om_1"));
    assert.equal(t.replies.length, 1);
  } finally {
    await t.cleanup();
  }
});

test("判断的这会儿群里又有人说话、或者有人回复了这条：不接", async () => {
  let release!: (text: string) => void;
  const t = await setup({ judge: () => new Promise<string>((resolve) => (release = resolve)) });
  try {
    const first = msg("om_1");
    t.replier.noteActivity(first);
    const pending = t.replier.consider(first);
    await new Promise((resolve) => setImmediate(resolve));
    t.replier.noteActivity(msg("om_2", { senderId: "ou_2", content: "db-test-2 啊", createTime: START + 2000 }));
    release("接：测试库是 db-test-2.internal（群记忆 #3）");
    await pending;
    assert.deepEqual(t.replies, []);
    assert.match(t.logs.join("\n"), /判断的这会儿群里又有人说话了，这条不接 chat=oc_1 message=om_1/);

    // 有人在这条下面开话题回了
    const second = msg("om_3", { createTime: START + 3000 });
    t.replier.noteActivity(second);
    const again = t.replier.consider(second);
    await new Promise((resolve) => setImmediate(resolve));
    t.replier.noteActivity(msg("om_4", { senderId: "ou_2", rootId: "om_3", threadId: "omt_3", createTime: START + 4000 }));
    release("接：测试库是 db-test-2.internal（群记忆 #3）");
    await again;
    assert.deepEqual(t.replies, []);

    // 机器人自己的消息、话题里别的回复不算
    const third = msg("om_5", { createTime: START + 5000 });
    t.replier.noteActivity(third);
    const last = t.replier.consider(third);
    await new Promise((resolve) => setImmediate(resolve));
    t.replier.noteActivity(msg("om_6", { senderId: BOT, createTime: START + 6000 }));
    t.replier.noteActivity(msg("om_7", { senderId: "ou_2", rootId: "om_other", threadId: "omt_9", createTime: START + 6000 }));
    release("接：测试库是 db-test-2.internal（群记忆 #3）");
    await last;
    assert.equal(t.replies.length, 1);
  } finally {
    await t.cleanup();
  }
});

test("回复发不出去：不占每小时的次数，下次照样带上怎么关", async () => {
  let failing = true;
  const t = await setup({ judge: "接：要我帮忙查一下吗？", maxPerHour: 1 });
  try {
    const replier = new ProactiveReplier({
      ...(t.replier as unknown as { opts: ConstructorParameters<typeof ProactiveReplier>[0] }).opts,
      reply: async (m, markdown) => {
        if (failing) {
          throw new Error("飞书 500");
        }
        t.replies.push(`${m.messageId} ${markdown}`);
      },
    });
    await replier.consider(msg("om_1"));
    assert.deepEqual(t.replies, []);
    assert.match(t.logs.join("\n"), /回复发不出去 chat=oc_1 message=om_1/);
    failing = false;
    await replier.consider(msg("om_2"));
    assert.equal(t.replies.length, 1);
    assert.match(t.replies[0], /不需要的话 @ 我说「别主动插话」/);
  } finally {
    await t.cleanup();
  }
});

test("几个群同时开关：存下来的状态一个不丢", async () => {
  const t = await setup({ enabled: ["oc_1", "oc_2"] });
  try {
    await Promise.all([
      t.replier.toggleIfAsked(msg("om_1", { mentionedBot: true, content: "别主动插话" })),
      t.replier.toggleIfAsked(msg("om_2", { chatId: "oc_2", mentionedBot: true, content: "别主动插话" })),
    ]);
    const saved = JSON.parse(await readFile(t.stateFile, "utf8"));
    assert.deepEqual(Object.keys(saved.paused).sort(), ["oc_1", "oc_2"]);
  } finally {
    await t.cleanup();
  }
});

test("群里 @ 机器人说「别主动插话」就停，「可以主动说话」再打开，重启后照样记着", async () => {
  const t = await setup();
  try {
    assert.equal(await t.replier.toggleIfAsked(msg("om_1", { mentionedBot: true, content: "别主动插话了" })), true);
    assert.equal(t.replier.active("oc_1"), false);
    assert.equal(t.replier.wants(msg("om_2")), false);
    assert.match(t.replies[0], /不主动接话了/);
    const saved = JSON.parse(await readFile(t.stateFile, "utf8"));
    assert.equal(saved.paused.oc_1.by, "ou_1");

    // 重启：读回来照样停着
    const restarted = t.make();
    await restarted.init();
    assert.equal(restarted.active("oc_1"), false);

    assert.equal(await restarted.toggleIfAsked(msg("om_3", { mentionedBot: true, content: "可以主动说话了", createTime: START + 60_000 })), true);
    assert.equal(restarted.active("oc_1"), true);
    // 停着的时候群里说的话，打开以后补漏轮询再看到也不判断；打开以后说的照常
    assert.equal(restarted.wants(msg("om_4", { content: "测试环境数据库是哪个来着", createTime: START + 30_000 })), false);
    assert.equal(restarted.wants(msg("om_5", { content: "测试环境数据库是哪个来着", createTime: START + 90_000 })), true);
    assert.match(t.replies[1], /会看情况主动接一句.*每小时最多 3 次/);
    const again = t.make();
    await again.init();
    assert.equal(again.active("oc_1"), true);
  } finally {
    await t.cleanup();
  }
});

test("打开了的群里在群主界面说「只在 @ 我时回」也算停；话题里说的、没 @ 的、别的话不算", async () => {
  const t = await setup();
  try {
    assert.equal(await t.replier.toggleIfAsked(msg("om_1", { mentionedBot: true, content: "以后在话题里也查一下这个" })), false);
    assert.equal(await t.replier.toggleIfAsked(msg("om_2", { content: "别主动插话" })), false);
    assert.equal(
      await t.replier.toggleIfAsked(msg("om_3", { mentionedBot: true, content: "别主动插话", rootId: "om_root", threadId: "omt_1" })),
      false,
    );
    assert.equal(t.replier.active("oc_1"), true);
    assert.equal(await t.replier.toggleIfAsked(msg("om_4", { mentionedBot: true, content: "只在 @ 我时回" })), true);
    assert.equal(t.replier.active("oc_1"), false);
  } finally {
    await t.cleanup();
  }
});

test("群主界面的开关话后来有人回复、补漏读到时带着 threadId：照样算群主界面的", async () => {
  const t = await setup();
  try {
    assert.equal(await t.replier.toggleIfAsked(msg("om_1", { mentionedBot: true, content: "别主动插话", threadId: "omt_1" })), true);
    assert.equal(t.replier.active("oc_1"), false);
  } finally {
    await t.cleanup();
  }
});

test("没打开的群里说开关的话：告诉他这个群没开；「只在 @ 我时回」留给跟聊；白名单外的群不理", async () => {
  const t = await setup();
  try {
    assert.equal(await t.replier.toggleIfAsked(msg("om_1", { chatId: "oc_2", mentionedBot: true, content: "可以主动说话" })), true);
    assert.match(t.replies[0], /这个群没开主动接话.*PROACTIVE_CHAT_IDS/);
    assert.equal(t.replier.active("oc_2"), false);
    assert.equal(await t.replier.toggleIfAsked(msg("om_2", { chatId: "oc_2", mentionedBot: true, content: "只在 @ 我时回" })), false);
    assert.equal(await t.replier.toggleIfAsked(msg("om_3", { chatId: "oc_9", mentionedBot: true, content: "别主动插话" })), false);
    assert.equal(t.replies.length, 1);
  } finally {
    await t.cleanup();
  }
});

test("开关的话要整句是：句子里顺带提到的不算", () => {
  assert.equal(PAUSE_COMMAND.test("别主动插话"), true);
  assert.equal(PAUSE_COMMAND.test("不要主动回复了！"), true);
  assert.equal(PAUSE_COMMAND.test("不用主动回"), true);
  assert.equal(PAUSE_COMMAND.test("为什么你别主动插话的时候还在回"), false);
  assert.equal(RESUME_COMMAND.test("可以主动说话"), true);
  assert.equal(RESUME_COMMAND.test("恢复主动插话吧"), true);
  assert.equal(RESUME_COMMAND.test("不用 @ 你也可以回"), true);
  assert.equal(RESUME_COMMAND.test("可以主动说话的功能怎么开"), false);
});

test("状态文件坏了：打一行警告，按都没停算", async () => {
  const t = await setup();
  try {
    await writeFile(t.stateFile, "{坏的");
    const restarted = t.make();
    await restarted.init();
    assert.equal(restarted.active("oc_1"), true);
    assert.match(t.logs.join("\n"), /格式不对，先按所有群都没停算/);
  } finally {
    await t.cleanup();
  }
});
