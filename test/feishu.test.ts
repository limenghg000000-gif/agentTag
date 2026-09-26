import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "@larksuiteoapi/node-sdk";
import { createFeishuApi, FeishuApiError } from "../src/feishu.js";

const bot = { openId: "ou_bot", name: "飞书 CLI" };

function fakeClient(pages: object[], single: object = { code: 0, data: { items: [] } }) {
  const listCalls: any[] = [];
  const client = {
    im: {
      v1: {
        message: {
          list: async (payload: any) => {
            listCalls.push(payload.params);
            return pages.shift();
          },
          get: async () => single,
        },
      },
    },
  } as unknown as Client;
  return { client, listCalls };
}

test("读话题消息：按时间正序，转成文本，去掉 @机器人，认出本机器人发的消息", async () => {
  const { client, listCalls } = fakeClient([
    {
      code: 0,
      data: {
        has_more: false,
        items: [
          {
            message_id: "om_2",
            msg_type: "post",
            create_time: "2000",
            sender: { id: "cli_app", id_type: "app_id", sender_type: "app" },
            body: { content: JSON.stringify({ title: "", content: [[{ tag: "text", text: "《季度总结》" }]] }) },
          },
          {
            message_id: "om_1",
            msg_type: "text",
            create_time: "1000",
            sender: { id: "ou_zhang", id_type: "open_id", sender_type: "user", sender_name: "张三" },
            body: { content: JSON.stringify({ text: "@_user_1 帮 @_user_2 写个标题" }) },
            mentions: [
              { key: "@_user_1", id: "ou_bot", id_type: "open_id", name: "飞书 CLI" },
              { key: "@_user_2", id: "ou_li", id_type: "open_id", name: "李四" },
            ],
          },
          { message_id: "om_0", msg_type: "text", deleted: true, body: { content: "{}" } },
        ],
      },
    },
  ]);

  const messages = await createFeishuApi(client, "cli_app", () => bot).listThreadMessages("omt_1", 60);

  assert.deepEqual(listCalls[0], {
    container_id_type: "thread",
    container_id: "omt_1",
    sort_type: "ByCreateTimeDesc",
    page_size: 50,
    page_token: undefined,
    with_sender_name: true,
  });
  assert.deepEqual(messages, [
    { messageId: "om_1", fromBot: false, senderName: "张三", msgType: "text", content: "帮 @李四 写个标题", createTime: 1000 },
    { messageId: "om_2", fromBot: true, senderName: undefined, msgType: "post", content: "《季度总结》", createTime: 2000 },
  ]);
});

test("分页读取，最多读 limit 条", async () => {
  const page = (ids: string[], more: boolean) => ({
    code: 0,
    data: {
      has_more: more,
      page_token: "next",
      items: ids.map((id) => ({ message_id: id, msg_type: "text", body: { content: JSON.stringify({ text: id }) } })),
    },
  });
  const { client, listCalls } = fakeClient([page(["c", "b"], true), page(["a"], true)]);

  const messages = await createFeishuApi(client, "cli_app", () => bot).listThreadMessages("omt_1", 3);

  assert.deepEqual(messages.map((m) => m.content), ["a", "b", "c"]);
  assert.deepEqual(listCalls.map((p) => [p.page_size, p.page_token]), [[3, undefined], [1, "next"]]);
});

test("接口返回错误码时抛出 FeishuApiError", async () => {
  const { client } = fakeClient([{ code: 230027, msg: "Lack of necessary permissions" }]);
  await assert.rejects(
    createFeishuApi(client, "cli_app", () => bot).listThreadMessages("omt_1", 10),
    (err) => err instanceof FeishuApiError && err.code === 230027,
  );
});

test("读单条消息", async () => {
  const { client } = fakeClient([], {
    code: 0,
    data: { items: [{ message_id: "om_9", msg_type: "text", body: { content: JSON.stringify({ text: "明天开会" }) } }] },
  });
  const message = await createFeishuApi(client, "cli_app", () => bot).getMessage("om_9");
  assert.equal(message?.content, "明天开会");
});
