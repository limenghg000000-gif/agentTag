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

test("带上工具说明，解析模型返回的工具调用", async () => {
  responses.push({
    status: 200,
    body: {
      id: "chatcmpl-2",
      object: "chat.completion",
      created: 0,
      model: "qwen3.8-max",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "我先看看这个网页",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "fetch_url", arguments: '{"url":"https://example.com"}' } }],
        },
        finish_reason: "tool_calls",
      }],
    },
  });
  const tool = { name: "fetch_url", description: "读网页", parameters: { type: "object", properties: { url: { type: "string" } } } };

  const result = await model.chat({ system: "你是助手", messages: [{ role: "user", content: "看看 example.com" }], tools: [tool] });

  assert.deepEqual(result, {
    text: "我先看看这个网页",
    finish: "tool_calls",
    toolCalls: [{ id: "call_1", name: "fetch_url", arguments: '{"url":"https://example.com"}' }],
  });
  assert.deepEqual(requests.at(-1)!.body.tools, [{ type: "function", function: tool }]);
  // 允许一轮调多个工具，少等几轮
  assert.equal(requests.at(-1)!.body.parallel_tool_calls, true);
});

test("带回模型服务返回的用量，包括思考用掉的 token", async () => {
  const reply = completion("好");
  responses.push({
    ...reply,
    body: {
      ...reply.body,
      usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, completion_tokens_details: { reasoning_tokens: 250 } },
    },
  });
  assert.deepEqual(await ask(), { text: "好", finish: "stop", usage: { input: 1200, output: 300, reasoning: 250 } });

  responses.push({ ...reply, body: { ...reply.body, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } });
  assert.deepEqual(await ask(), { text: "好", finish: "stop", usage: { input: 10, output: 2 } });
  // 不带工具时不发 parallel_tool_calls，有的服务会拒绝
  assert.equal(requests.at(-1)!.body.parallel_tool_calls, undefined);
});

test("把之前的工具调用和工具结果按 OpenAI 格式发回去", async () => {
  responses.push(completion("网页讲的是示例域名"));
  const toolCalls = [{ id: "call_1", name: "fetch_url", arguments: '{"url":"https://example.com"}' }];

  await model.chat({
    system: "你是助手",
    messages: [
      { role: "user", content: "看看 example.com" },
      { role: "assistant", content: "", toolCalls },
      { role: "tool", toolCallId: "call_1", content: "Example Domain" },
    ],
  });

  const { body } = requests.at(-1)!;
  assert.equal(body.tools, undefined);
  assert.deepEqual(body.messages.slice(2), [
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "fetch_url", arguments: '{"url":"https://example.com"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "Example Domain" },
  ]);
});

test("中止后请求被取消，抛出的不是 LlmError", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    model.chat({ system: "你是助手", messages: [{ role: "user", content: "你好" }], signal: controller.signal }),
    (err) => !(err instanceof LlmError),
  );
});

test("服务不认 parallel_tool_calls 时去掉它重试，之后不再带", async () => {
  const tool = { name: "fetch_url", description: "读网页", parameters: { type: "object", properties: {} } };
  const withTools = () => model.chat({ system: "你是助手", messages: [{ role: "user", content: "看看" }], tools: [tool] });
  responses.push(
    { status: 400, body: { error: { code: "invalid_parameter", message: "Unrecognized request argument: parallel_tool_calls" } } },
    completion("好"),
    completion("好"),
  );

  assert.deepEqual(await withTools(), { text: "好", finish: "stop" });
  assert.deepEqual(await withTools(), { text: "好", finish: "stop" });

  const bodies = requests.slice(-3).map((r) => r.body.parallel_tool_calls);
  assert.deepEqual(bodies, [true, undefined, undefined]);
});

test("按配置传 enable_thinking；模型不支持时去掉重试并提示一次", async () => {
  const warnings: string[] = [];
  const noThink = createOpenAICompatibleModel(
    {
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/compatible-mode/v1`,
      apiKey: "sk-test",
      model: "qwq-plus",
      thinking: false,
    },
    (message) => warnings.push(message),
  );
  const askNoThink = () => noThink.chat({ system: "你是助手", messages: [{ role: "user", content: "你好" }] });
  responses.push(
    completion("好"),
    { status: 400, body: { error: { code: "invalid_parameter_error", message: "The value of the enable_thinking parameter is restricted to True." } } },
    completion("好"),
    completion("好"),
  );

  await askNoThink();
  assert.equal(requests.at(-1)!.body.enable_thinking, false);
  assert.deepEqual(await askNoThink(), { text: "好", finish: "stop" });
  await askNoThink();

  const bodies = requests.slice(-3).map((r) => r.body.enable_thinking);
  assert.deepEqual(bodies, [false, undefined, undefined]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /不支持设置思考模式/);
});
