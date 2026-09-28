import assert from "node:assert/strict";
import { test } from "node:test";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { DuplicateAsks } from "../src/duplicates.js";

function msg(messageId: string, content: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId,
    chatId: "oc_1",
    chatType: "group",
    senderId: "ou_1",
    content,
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1_000_000,
    ...extra,
  };
}

test("话题里的提问先到，群里的副本跳过", () => {
  const asks = new DuplicateAsks(() => 0);
  assert.deepEqual(asks.check(msg("om_t", "@飞书 CLI 追加一行", { rootId: "om_root" })), { action: "handle" });
  assert.deepEqual(asks.check(msg("om_g", " @飞书 CLI  追加一行 ", { createTime: 1_000_400 })), {
    action: "skip",
    duplicateOf: "om_t",
  });
});

test("群里的副本先到时，改为处理话题里那条，并停掉副本", () => {
  const asks = new DuplicateAsks(() => 0);
  assert.deepEqual(asks.check(msg("om_g", "追加一行")), { action: "handle" });
  assert.deepEqual(asks.check(msg("om_t", "追加一行", { rootId: "om_root" })), {
    action: "handle",
    stopThreadKey: "om_g",
    duplicateOf: "om_g",
  });
});

test("内容不同、换了人、换了群、隔得久，或者是同一条消息，都不算重复", () => {
  const asks = new DuplicateAsks(() => 0);
  asks.check(msg("om_1", "追加一行", { rootId: "om_root" }));
  assert.equal(asks.check(msg("om_2", "追加两行")).action, "handle");
  assert.equal(asks.check(msg("om_3", "追加一行", { senderId: "ou_2" })).action, "handle");
  assert.equal(asks.check(msg("om_4", "追加一行", { chatId: "oc_2" })).action, "handle");
  assert.equal(asks.check(msg("om_5", "追加一行", { createTime: 1_000_000 + 10_001 })).action, "handle");
  assert.equal(asks.check(msg("om_1", "追加一行", { rootId: "om_root" })).action, "handle");
});

test("没有发送时间时按收到的时间比；记录几分钟后清掉", () => {
  let now = 50_000;
  const asks = new DuplicateAsks(() => now);
  asks.check(msg("om_1", "你好", { createTime: 0, rootId: "om_root" }));
  now += 3_000;
  assert.equal(asks.check(msg("om_2", "你好", { createTime: 0 })).action, "skip");
  now += 10 * 60_000;
  assert.equal(asks.check(msg("om_3", "你好", { createTime: 0 })).action, "handle");
});
