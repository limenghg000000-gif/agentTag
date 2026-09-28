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
      "[1] Node.js 发布计划 https://nodejs.org/en/about/previous-releases",
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

test("出错时给出能看懂的原因，不带密钥", async () => {
  responses.push({ status: 401, body: { code: "InvalidApiKey", message: "Invalid API-key provided." } });
  await assert.rejects(tool.run({ query: "x" }, { signal }), /API Key 无效/);
  responses.push({ status: 400, body: { code: "InvalidParameter", message: "model not support search" } });
  await assert.rejects(tool.run({ query: "x" }, { signal }), /HTTP 400 InvalidParameter：model not support search/);
  await assert.rejects(tool.run({ query: "  " }, { signal }), /缺少 query/);
  requests.splice(0);
});
