import assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { ALARM_CONFIRM_MS, ALARM_COOLDOWN_MS, ALARM_WINDOW_MS, MissedEventAlarm } from "../src/alarm.js";

const quiet = { info() {}, warn() {}, error() {} };

function missed(messageId: string, chatId = "oc_1"): NormalizedMessage {
  return {
    messageId,
    chatId,
    chatType: "group",
    senderId: "ou_1",
    content: "ping",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: 0,
  };
}

function setup(opts: { chatId?: string; notify?: (chatId: string, text: string) => Promise<unknown> } = {}) {
  let now = 1_000_000;
  const sent: { chatId: string; text: string }[] = [];
  const pending: (() => void)[] = [];
  const errors: string[] = [];
  const alarm = new MissedEventAlarm({
    notify:
      opts.notify ??
      (async (chatId, text) => {
        sent.push({ chatId, text });
      }),
    chatId: opts.chatId,
    logger: { ...quiet, error: (line: string) => errors.push(line) },
    now: () => now,
    schedule: (fn, ms) => {
      assert.equal(ms, ALARM_CONFIRM_MS);
      pending.push(fn);
    },
  });
  return {
    alarm,
    sent,
    errors,
    advance: (ms: number) => {
      now += ms;
    },
    /** 等过确认时间，跑到期的检查 */
    confirm: () => {
      now += ALARM_CONFIRM_MS;
      pending.splice(0).forEach((fn) => fn());
    },
  };
}

test("只补上一条不报警，偶尔一条可能只是推送慢", () => {
  const t = setup();
  t.alarm.record(missed("om_1"));
  t.confirm();
  assert.deepEqual(t.sent, []);
});

test("30 分钟内补上两条、事件一直没到，在漏消息的群里报警一次", () => {
  const t = setup();
  t.alarm.record(missed("om_1"));
  t.advance(5 * 60_000);
  t.alarm.record(missed("om_2"));
  t.confirm();

  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].chatId, "oc_1");
  assert.match(t.sent[0].text, /补漏报警：最近 30 分钟有 2 条 @/);
  assert.match(t.sent[0].text, /journalctl --user -u agenttag-feishu \| grep 补漏/);
});

test("配置了报警群时发到那个群", () => {
  const t = setup({ chatId: "oc_ops" });
  t.alarm.record(missed("om_1"));
  t.alarm.record(missed("om_2"));
  t.confirm();
  assert.deepEqual(
    t.sent.map((s) => s.chatId),
    ["oc_ops"],
  );
});

test("事件晚到的那条不算：只是推送慢，不是被别处拿走", () => {
  const t = setup();
  t.alarm.record(missed("om_1"));
  t.alarm.record(missed("om_2"));
  t.alarm.arrivedLate("om_2");
  t.confirm();
  assert.deepEqual(t.sent, []);
});

test("超过 30 分钟的旧记录不算", () => {
  const t = setup();
  t.alarm.record(missed("om_1"));
  t.confirm();
  t.advance(ALARM_WINDOW_MS);
  t.alarm.record(missed("om_2"));
  t.confirm();
  assert.deepEqual(t.sent, []);
});

test("报过一次后 1 小时内不重复报，过了再报", () => {
  const t = setup();
  t.alarm.record(missed("om_1"));
  t.alarm.record(missed("om_2"));
  t.confirm();
  t.alarm.record(missed("om_3"));
  t.confirm();
  assert.equal(t.sent.length, 1);

  t.advance(ALARM_COOLDOWN_MS);
  t.alarm.record(missed("om_4"));
  t.alarm.record(missed("om_5"));
  t.confirm();
  assert.equal(t.sent.length, 2);
});

test("报警发送失败只记日志", async () => {
  const t = setup({
    notify: async () => {
      throw new Error("send failed");
    },
  });
  t.alarm.record(missed("om_1"));
  t.alarm.record(missed("om_2"));
  t.confirm();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(t.errors[0], /补漏报警发送失败 chat=oc_1/);
});
