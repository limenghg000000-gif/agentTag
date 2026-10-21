import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeishuApi, ThreadMessage } from "../src/feishu.js";
import { CHAT_HISTORY_CHARS, createChatHistoryTool } from "../src/tools/chat-history.js";

const bj = (text: string) => Date.parse(`${text.replace(" ", "T")}:00+08:00`);
const ctx = { signal: new AbortController().signal };

function msg(id: string, at: string, content: string, extra: Partial<ThreadMessage> = {}): ThreadMessage {
  return { messageId: id, fromBot: false, senderName: "张三", msgType: "text", content, createTime: bj(at), ...extra };
}

/** 假的飞书接口：群主界面按时间从早到晚，每次最多取离 until 最近的 limit 条 */
function fakeApi(main: ThreadMessage[], threads: Record<string, ThreadMessage[]> = {}) {
  const calls: Array<[number, number, number]> = [];
  const api: Pick<FeishuApi, "listChatMessages" | "listThreadMessages"> = {
    async listChatMessages(_chatId, since, until, limit) {
      calls.push([since, until, limit]);
      const inRange = main.filter((m) => m.createTime >= since && m.createTime <= Math.ceil(until / 1000) * 1000);
      return inRange.slice(-limit);
    },
    async listThreadMessages(threadId) {
      return threads[threadId] ?? [];
    },
  };
  return { api, calls };
}

test("读本群一段时间的聊天：群主界面的消息和话题里的回复，机器人卡片换成记下的回答", async () => {
  const { api } = fakeApi(
    [
      msg("om_old", "2026-10-12 23:00", "上上周的，不要"),
      msg("om_1", "2026-10-13 09:00", "发版改到周三", { threadId: "omt_1" }),
      msg("om_2", "2026-10-15 10:00", "gateway 报错了"),
      msg("om_card", "2026-10-15 11:00", "", { fromBot: true, msgType: "interactive" }),
    ],
    {
      omt_1: [
        msg("om_1", "2026-10-13 09:00", "发版改到周三", { threadId: "omt_1" }),
        msg("om_1a", "2026-10-13 09:05", "收到", { senderName: "李四", threadId: "omt_1" }),
        msg("om_1b", "2026-10-13 09:06", "", { fromBot: true, msgType: "interactive", threadId: "omt_1" }),
        msg("om_1c", "2026-10-13 09:07", "进度卡片", { fromBot: true, msgType: "interactive", threadId: "omt_1" }),
      ],
    },
  );
  const asked: string[][] = [];
  const tool = createChatHistoryTool({
    api,
    chatId: "oc_1",
    cardAnswers: {
      async get(_chatId, threadKey, ids) {
        asked.push([threadKey, ...ids]);
        return new Map(threadKey === "om_1" ? [["om_1b", "好的，记下了：发版改到周三"]] : []);
      },
    },
    now: () => bj("2026-10-21 10:00"),
  });
  const out = await tool.run({ since: "2026-10-13 00:00", until: "2026-10-20 00:00" }, ctx);
  assert.equal(
    out,
    [
      "本群 10-13（周二）00:00 到 10-20（周二）00:00 的聊天记录（北京时间，4 条；↳ 是话题里的回复）：",
      "[张三 10-13（周二）09:00] 发版改到周三",
      "  ↳ [李四 10-13（周二）09:05] 收到",
      "  ↳ [机器人 10-13（周二）09:06] 好的，记下了：发版改到周三",
      "[张三 10-15（周四）10:00] gateway 报错了",
    ].join("\n"),
  );
  assert.deepEqual(asked, [["om_1", "om_1b", "om_1c"]]);
});

test("超过 50 条往前翻页；太长时去掉最早的；范围不对报错", async () => {
  const main = Array.from({ length: 120 }, (_, i) =>
    msg(`om_${i}`, `2026-10-${String(14 + Math.floor(i / 60)).padStart(2, "0")} ${String(Math.floor((i % 60) / 6) + 9).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}`, `第 ${i} 条 ${"字".repeat(250)}`),
  );
  const { api, calls } = fakeApi(main);
  const tool = createChatHistoryTool({ api, chatId: "oc_1", now: () => bj("2026-10-21 10:00") });
  const out = await tool.run({ since: "2026-10-14 00:00" }, ctx);
  assert.ok(calls.length >= 3);
  assert.ok(out.length <= CHAT_HISTORY_CHARS);
  assert.match(out, /120 条/);
  assert.match(out, /最早的 \d+ 条没列出来/);
  assert.match(out, /第 119 条/);
  assert.doesNotMatch(out, /第 0 条/);

  await assert.rejects(tool.run({ since: "2026-10-01 00:00" }, ctx), /最多读 8 天/);
  await assert.rejects(tool.run({ since: "2026-10-22 00:00" }, ctx), /since 要早于 until/);
  await assert.rejects(tool.run({ since: "上周" }, ctx), /2026-10-22 15:00/);
  assert.match(await tool.run({ since: "2026-10-20 00:00" }, ctx), /没有聊天记录/);
});
