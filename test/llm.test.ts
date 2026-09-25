import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createOpenAICompatibleModel, LlmError } from "../src/llm.js";

// 本地假 OpenAI 兼容接口：记录收到的请求，按队列返回预设的状态码和响应
const requests: { url: string; headers: IncomingHttpHeaders; body: any }[] = [];
const responses: { status: number; body: object }[] = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    requests.push({ url: req.url!, headers: req.headers, body: JSON.parse(raw) });
    const { status, body } = responses.shift()!;
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => server.close());

const model = createOpenAICompatibleModel({
  baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/compatible-mode/v1`,
  apiKey: "sk-test",
  model: "qwen3.8-max",
});

function completion(content: string, finish_reason = "stop") {
  return {
    status: 200,
    body: {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "qwen3.8-max",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason }],
    },
  };
}

const ask = () => model.chat({ system: "你是助手", messages: [{ role: "user", content: "你好" }] });

test("按 OpenAI 兼容格式调用：系统提示在前，Key 走 Bearer", async () => {
  responses.push(completion(" 你好！ "));
  assert.deepEqual(await ask(), { text: "你好！", finish: "stop" });

  const { url, headers, body } = requests.at(-1)!;
  assert.equal(url, "/compatible-mode/v1/chat/completions");
  assert.equal(headers.authorization, "Bearer sk-test");
  assert.equal(body.model, "qwen3.8-max");
  assert.deepEqual(body.messages, [
    { role: "system", content: "你是助手" },
    { role: "user", content: "你好" },
  ]);
});

test("finish_reason 为 length / content_filter 时分别标记", async () => {
  responses.push(completion("前半段", "length"), completion("", "content_filter"));
  assert.deepEqual(await ask(), { text: "前半段", finish: "length" });
  assert.deepEqual(await ask(), { text: "", finish: "filtered" });
});

test("百炼输入审核不通过（400 data_inspection_failed）视为被拦截", async () => {
  responses.push({
    status: 400,
    body: { error: { code: "data_inspection_failed", message: "Input data may contain inappropriate content.", type: "data_inspection_failed" } },
  });
  assert.deepEqual(await ask(), { text: "", finish: "filtered" });
});

test("Key 无效时抛出 auth 类错误", async () => {
  responses.push({ status: 401, body: { error: { code: "invalid_api_key", message: "Incorrect API key provided." } } });
  await assert.rejects(ask, (err) => err instanceof LlmError && err.kind === "auth");
});
