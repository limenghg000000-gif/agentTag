import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createWebSearchTool } from "../src/tools/web-search.js";

// 本地假百炼原生接口：记录请求，按队列返回预设的状态码和响应
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

const PATH = "/api/v1/services/aigc/text-generation/generation";
const tool = createWebSearchTool({
  url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${PATH}`,
  apiKey: "sk-test",
  model: "qwen3.8-max",
  now: () => new Date("2026-09-26T08:00:00Z"),
});
const signal = new AbortController().signal;

test("强制联网搜索并要来源，返回摘要和来源链接", async () => {
  responses.push({
    status: 200,
    body: {
      output: {
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Node.js 24 于 2025 年 10 月进入 LTS [1]。" } }],
        search_info: {
          search_results: [
            { index: 1, title: "Node.js 发布计划", url: "https://nodejs.org/en/about/previous-releases", site_name: "Node.js" },
            { index: 2, title: "没有链接的结果" },
          ],
        },
      },
      request_id: "r1",
    },
  });

  const result = await tool.run({ query: " Node.js 24 什么时候 LTS " }, { signal });

  const [req] = requests.splice(0);
  assert.equal(req.url, PATH);
  assert.equal(req.headers.authorization, "Bearer sk-test");
  assert.equal(req.body.model, "qwen3.8-max");
  assert.equal(req.body.input.messages[1].content, "Node.js 24 什么时候 LTS");
  assert.match(req.body.input.messages[0].content, /2026年9月26日/);
  assert.deepEqual(req.body.parameters, {
    result_format: "message",
    enable_thinking: false,
    enable_search: true,
    search_options: {
      forced_search: true,
      enable_source: true,
      enable_citation: true,
      citation_format: "[<number>]",
      search_strategy: "turbo",
    },
  });
  assert.equal(
    result,
    [
      "搜索「Node.js 24 什么时候 LTS」的结果：",
      "",
      "Node.js 24 于 2025 年 10 月进入 LTS [1]。",
      "",
      "来源：",
      "[1] [Node.js 发布计划](https://nodejs.org/en/about/previous-releases)",
      "",
      "（回答里引用时写成上面的 [标题](网址) 链接，不要只写 [编号]。搜索结果可能滞后几天，版本号、价格等以官方来源为准）",
    ].join("\n"),
  );
  assert.equal(tool.describe({ query: "Node.js 24 什么时候 LTS" }), "搜索：Node.js 24 什么时候 LTS");
});

test("deep 时用 max 策略；没返回来源时提醒核实", async () => {
  responses.push({ status: 200, body: { output: { choices: [{ message: { content: "答案" } }] } } });
  const result = await tool.run({ query: "对比三家云厂商", deep: true }, { signal });
  assert.equal(requests.splice(0)[0].body.parameters.search_options.search_strategy, "max");
  assert.match(result, /没有返回搜索来源.*核实/);
});

test("来源标题里的方括号去掉，免得打断 Markdown 链接", async () => {
  responses.push({
    status: 200,
    body: {
      output: {
        choices: [{ message: { content: "答案 [1]" } }],
        search_info: { search_results: [{ index: 1, title: "[公告] Release  v2", url: "https://example.com/r" }] },
      },
    },
  });
  const result = await tool.run({ query: "x" }, { signal });
  requests.splice(0);
  assert.match(result, /^\[1\] \[公告 Release v2\]\(https:\/\/example.com\/r\)$/m);
});

test("出错时给出能看懂的原因，不带密钥", async () => {
  responses.push({ status: 401, body: { code: "InvalidApiKey", message: "Invalid API-key provided." } });
  await assert.rejects(tool.run({ query: "x" }, { signal }), /API Key 无效/);
  responses.push({ status: 400, body: { code: "InvalidParameter", message: "model not support search" } });
  await assert.rejects(tool.run({ query: "x" }, { signal }), /HTTP 400 InvalidParameter：model not support search/);
  await assert.rejects(tool.run({ query: "  " }, { signal }), /缺少 query/);
  requests.splice(0);
});

test("文本接口报 url error 时换多模态接口（content 用数组），之后都走多模态", async () => {
  const mmTool = createWebSearchTool({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${PATH}`,
    apiKey: "sk-test",
    model: "qwen3.8-max",
    now: () => new Date("2026-09-26T08:00:00Z"),
  });
  const reply = {
    output: {
      choices: [{ message: { role: "assistant", content: [{ text: "最新版是 2.1.283 [1]。" }] } }],
      search_info: { search_results: [{ index: 1, title: "npm", url: "https://www.npmjs.com/package/x" }] },
    },
  };
  responses.push(
    { status: 400, body: { code: "InvalidParameter", message: "url error, please check url! For details, see: https://help.aliyun.com" } },
    { status: 200, body: reply },
    { status: 200, body: reply },
  );

  const result = await mmTool.run({ query: "x 最新版本" }, { signal });
  await mmTool.run({ query: "再搜一次" }, { signal });

  const [first, second, third] = requests.splice(0);
  assert.equal(first.url, PATH);
  assert.equal(second.url, "/api/v1/services/aigc/multimodal-generation/generation");
  assert.deepEqual(second.body.input.messages[1].content, [{ text: "x 最新版本" }]);
  assert.equal(third.url, "/api/v1/services/aigc/multimodal-generation/generation");
  assert.match(result, /最新版是 2.1.283 \[1\]。/);
  assert.match(result, /\[1\] \[npm\]\(https:\/\/www.npmjs.com\/package\/x\)/);
});

test("两个接口都报 url error 时，提示换搜索模型", async () => {
  const badTool = createWebSearchTool({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${PATH}`,
    apiKey: "sk-test",
    model: "some-model",
  });
  const urlError = { status: 400, body: { code: "InvalidParameter", message: "url error, please check url!" } };
  responses.push(urlError, urlError);
  await assert.rejects(badTool.run({ query: "x" }, { signal }), /两个接口都试过了.*WEB_SEARCH_MODEL=qwen-plus/);
  requests.splice(0);
});

test("模型不认 enable_thinking 时去掉重试", async () => {
  const thinkTool = createWebSearchTool({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${PATH}`,
    apiKey: "sk-test",
    model: "qwq-plus",
  });
  responses.push(
    { status: 400, body: { code: "InvalidParameter", message: "The value of the enable_thinking parameter is restricted to True." } },
    { status: 200, body: { output: { choices: [{ message: { content: "答案" } }] } } },
  );
  await thinkTool.run({ query: "x" }, { signal });
  const [first, second] = requests.splice(0);
  assert.equal(first.body.parameters.enable_thinking, false);
  assert.equal(second.body.parameters.enable_thinking, undefined);
});
