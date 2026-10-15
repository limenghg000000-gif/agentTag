import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeishuApi, ThreadMessage } from "../src/feishu.js";
import { clickerName, createNameLookup } from "../src/operator-names.js";

function setup({
  thread = [],
  contact = {},
  contactError,
  hold,
}: {
  thread?: ThreadMessage[];
  contact?: Record<string, string>;
  contactError?: Error;
  /** 读话题时先等它：模拟飞书接口很慢 */
  hold?: Promise<void>;
} = {}) {
  const calls: string[] = [];
  const warnings: string[] = [];
  const api: Pick<FeishuApi, "getMessage" | "listThreadMessages" | "getUserName"> = {
    async getMessage(messageId) {
      calls.push(`get ${messageId}`);
      await hold;
      return messageId === "om_card" ? { messageId, fromBot: true, msgType: "interactive", content: "", createTime: 1, threadId: "omt_1" } : undefined;
    },
    async listThreadMessages(threadId) {
      calls.push(`list ${threadId}`);
      return thread;
    },
    async getUserName(openId) {
      calls.push(`contact ${openId}`);
      if (contactError) {
        throw contactError;
      }
      return contact[openId];
    },
  };
  const logger = { info() {}, warn: (text: string) => warnings.push(text), error() {} };
  return { api, calls, warnings, logger };
}

const said = (senderId: string, senderName: string, extra: Partial<ThreadMessage> = {}): ThreadMessage => ({
  messageId: `om_${senderId}`,
  fromBot: false,
  senderId,
  senderName,
  msgType: "text",
  content: "…",
  createTime: 1,
  ...extra,
});

test("找点卡片的人的名字：先在卡片所在的话题里找他说过的话，找到就记下，下次不再查", async () => {
  const s = setup({ thread: [said("ou_li", "李四（旧名）"), said("ou_zhang", "张三"), said("ou_li", "李四")] });
  const nameOf = createNameLookup(s.api, { logger: s.logger });
  assert.equal(await nameOf("ou_li", "om_card"), "李四", "同一个人说过几次，用最近的名字");
  assert.deepEqual(s.calls, ["get om_card", "list omt_1"]);
  assert.equal(await nameOf("ou_li", "om_card"), "李四");
  assert.equal(s.calls.length, 2, "记下了，第二次不再读话题");
});

test("找点卡片的人的名字：话题里没说过话的查通讯录；都没有返回空；通讯录查不了只记一次日志", async () => {
  const s = setup({ thread: [said("ou_zhang", "张三"), { ...said("ou_bot", "机器人"), fromBot: true }], contact: { ou_wang: "王五" } });
  const nameOf = createNameLookup(s.api, { logger: s.logger });
  assert.equal(await nameOf("ou_wang", "om_card"), "王五");
  assert.deepEqual(s.calls, ["get om_card", "list omt_1", "contact ou_wang"]);
  assert.equal(await nameOf("ou_zhao", "om_card"), undefined);

  const failing = setup({ contactError: new Error("飞书接口返回错误 41050：no user authority") });
  const lookup = createNameLookup(failing.api, { logger: failing.logger });
  assert.equal(await lookup("ou_wang", "om_card"), undefined);
  assert.equal(await lookup("ou_wang", "om_card"), undefined, "没找到的不记，下次再找");
  assert.equal(failing.warnings.length, 1, "查不了通讯录只记一次");
  assert.equal(failing.calls.filter((call) => call.startsWith("contact")).length, 2);
});

test("找点卡片的人的名字：飞书接口太慢时到时间就不等了，后面找到的记下来，下次点就有", async () => {
  let release!: () => void;
  const s = setup({ thread: [said("ou_li", "李四")], hold: new Promise((resolve) => (release = resolve)) });
  const nameOf = createNameLookup(s.api, { logger: s.logger, timeoutMs: 20 });
  assert.equal(await nameOf("ou_li", "om_card"), undefined);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await nameOf("ou_li", "om_card"), "李四");
  assert.equal(s.calls.filter((call) => call.startsWith("get")).length, 1, "第二次用的是记下的");
});

test("点卡片的人：回调里带了名字就用；是发起人就用他提问时的名字；不然去找", async () => {
  const asked: string[] = [];
  const lookup = async (openId: string) => {
    asked.push(openId);
    return openId === "ou_wang" ? "王五" : undefined;
  };
  const proposer = { openId: "ou_zhang", name: "张三" };
  const evt = (openId: string, name?: string) => ({ messageId: "om_card", operator: { openId, ...(name ? { name } : {}) } });
  assert.equal(await clickerName(evt("ou_li", "李四"), proposer, lookup), "李四");
  assert.equal(await clickerName(evt("ou_zhang"), proposer, lookup), "张三");
  assert.deepEqual(asked, []);
  assert.equal(await clickerName(evt("ou_wang"), proposer, lookup), "王五");
  assert.equal(await clickerName(evt("ou_zhao"), proposer, lookup), undefined);
  assert.equal(await clickerName(evt("ou_zhao"), proposer, undefined), undefined, "没给找名字的");
  assert.equal(await clickerName(evt("ou_zhao"), proposer, async () => Promise.reject(new Error("坏了"))), undefined, "找名字出错当没找到");
});
