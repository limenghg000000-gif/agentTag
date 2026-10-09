import assert from "node:assert/strict";
import { Readable } from "node:stream";
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

test("读群或话题里最近的消息：群按时间过滤，话题不传时间；转成和事件一样的格式，认出 @ 机器人和机器人自己", async () => {
  const items = [
    {
      message_id: "om_2",
      chat_id: "oc_1",
      root_id: "om_1",
      thread_id: "omt_1",
      msg_type: "text",
      create_time: "2000",
      sender: { id: "ou_zhang", id_type: "open_id", sender_type: "user" },
      body: { content: JSON.stringify({ text: "@_user_1 ping" }) },
      mentions: [{ key: "@_user_1", id: "ou_bot", id_type: "open_id", name: "飞书 CLI" }],
    },
    {
      message_id: "om_1",
      chat_id: "oc_1",
      msg_type: "text",
      create_time: "1000",
      sender: { id: "cli_app", id_type: "app_id", sender_type: "app" },
      body: { content: JSON.stringify({ text: "回答" }) },
    },
    { message_id: "om_0", deleted: true, body: { content: "{}" } },
  ];
  const { client, listCalls } = fakeClient([
    { code: 0, data: { items } },
    { code: 0, data: { items: [] } },
  ]);
  const api = createFeishuApi(client, "cli_app", () => bot);

  const recent = await api.listRecentMessages("chat", "oc_1", 30, 1_700_000_000_500);
  await api.listRecentMessages("thread", "omt_1", 30, 1_700_000_000_500);

  assert.deepEqual(listCalls, [
    { container_id_type: "chat", container_id: "oc_1", sort_type: "ByCreateTimeDesc", page_size: 30, start_time: "1700000000" },
    { container_id_type: "thread", container_id: "omt_1", sort_type: "ByCreateTimeDesc", page_size: 30 },
  ]);
  assert.equal(recent.length, 2);
  const [ping, answer] = recent;
  assert.equal(ping.fromBot, false);
  assert.equal(ping.message.mentionedBot, true);
  assert.equal(ping.message.content, "ping");
  assert.equal(ping.message.senderId, "ou_zhang");
  assert.equal(ping.message.chatId, "oc_1");
  assert.equal(ping.message.rootId, "om_1");
  assert.equal(ping.message.threadId, "omt_1");
  assert.equal(ping.message.createTime, 2000);
  assert.equal(answer.fromBot, true);
  assert.equal(answer.message.mentionedBot, false);
});

test("话题消息里的图片记下 image_key；下载图片读出整个文件，按返回头或文件头认出类型", async () => {
  const { client } = fakeClient([
    {
      code: 0,
      data: {
        items: [
          {
            message_id: "om_1",
            msg_type: "post",
            create_time: "1000",
            sender: { id: "ou_zhang", id_type: "open_id", sender_type: "user", sender_name: "张三" },
            body: {
              content: JSON.stringify({
                title: "",
                content: [[{ tag: "img", image_key: "img_v3_a" }], [{ tag: "text", text: "这个线上报警是咋回事" }]],
              }),
            },
          },
        ],
      },
    },
  ]);
  const [first] = await createFeishuApi(client, "cli_app", () => bot).listThreadMessages("omt_1", 10);
  assert.deepEqual(first.images, ["img_v3_a"]);
  assert.match(first.content, /!\[image\]\(img_v3_a\)/);

  const calls: any[] = [];
  const files = [
    { headers: { "content-type": "image/jpeg; charset=binary" }, chunks: [Buffer.from([0xff, 0xd8]), Buffer.from("rest")] },
    { headers: {}, chunks: [Buffer.from([0xff, 0xd8, 0xff])] },
    { headers: { "content-type": "application/octet-stream" }, chunks: [Buffer.from("\x89PNG")] },
  ];
  const download = createFeishuApi(
    {
      im: {
        v1: {
          messageResource: {
            get: async (payload: any) => {
              calls.push(payload);
              const file = files.shift()!;
              return { headers: file.headers, getReadableStream: () => Readable.from(file.chunks), writeFile: async () => {} };
            },
          },
        },
      },
    } as unknown as Client,
    "cli_app",
    () => bot,
  );

  const jpeg = await download.downloadImage("om_1", "img_v3_a");
  assert.deepEqual(calls[0], { path: { message_id: "om_1", file_key: "img_v3_a" }, params: { type: "image" } });
  assert.equal(jpeg.mimeType, "image/jpeg");
  assert.equal(jpeg.data.length, 6);
  assert.equal((await download.downloadImage("om_1", "img_b")).mimeType, "image/jpeg");
  assert.equal((await download.downloadImage("om_1", "img_c")).mimeType, "image/png");
});
