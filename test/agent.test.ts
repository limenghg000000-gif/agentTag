import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentEvent, MAX_TOOL_OUTPUT_CHARS, runAgent } from "../src/agent.js";
import type { ChatMessage, ChatModel, ChatRequest, ChatResult } from "../src/llm.js";
import type { Tool } from "../src/tools/tool.js";

function scriptedModel(script: ChatResult[]) {
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    model: "fake",
    async chat(req) {
      requests.push({ ...req, messages: [...req.messages] });
      const next = script.shift();
      assert.ok(next, "模型被多调用了一次");
      return next;
    },
  };
  return { model, requests };
}

function echoTool(name = "echo", run?: Tool["run"]): Tool {
  return {
    spec: { name, description: "原样返回", parameters: { type: "object", properties: { text: { type: "string" } } } },
    describe: (args) => `${name} ${args.text}`,
    run: run ?? (async (args) => `回声：${args.text}`),
  };
}

const call = (id: string, name: string, args: object | string) => ({
  id,
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
});
const user: ChatMessage[] = [{ role: "user", content: "帮我做事" }];
const signal = new AbortController().signal;

test("模型直接回答时只调用一次", async () => {
  const { model, requests } = scriptedModel([{ text: "答案", finish: "stop" }]);

  const result = await runAgent({ model, system: "s", messages: user, tools: [echoTool()], signal });

  assert.deepEqual(result, { text: "答案", finish: "stop", toolCalls: 0 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tools?.[0].name, "echo");
});

test("执行工具后把结果交回模型，直到给出最终回答", async () => {
  const { model, requests } = scriptedModel([
    { text: "先查一下", finish: "tool_calls", toolCalls: [call("c1", "echo", { text: "a" })] },
    { text: "", finish: "tool_calls", toolCalls: [call("c2", "echo", { text: "b" }), call("c3", "echo", { text: "c" })] },
    { text: "都查完了", finish: "stop" },
  ]);
  const events: AgentEvent[] = [];

  const result = await runAgent({ model, system: "s", messages: user, tools: [echoTool()], signal, onEvent: (e) => events.push(e) });

  assert.deepEqual(result, { text: "都查完了", finish: "stop", toolCalls: 3 });
  assert.deepEqual(requests[1].messages.slice(1), [
    { role: "assistant", content: "先查一下", toolCalls: [call("c1", "echo", { text: "a" })] },
    { role: "tool", toolCallId: "c1", content: "回声：a" },
  ]);
  assert.deepEqual(requests[2].messages.slice(-2), [
    { role: "tool", toolCallId: "c2", content: "回声：b" },
    { role: "tool", toolCallId: "c3", content: "回声：c" },
  ]);
  assert.deepEqual(events.filter((e) => e.type === "tool_start").map((e) => (e as { label: string }).label), ["echo a", "echo b", "echo c"]);
  assert.equal(events.filter((e) => e.type === "tool_end" && e.ok).length, 3);
});

test("工具不存在、参数不是 JSON、工具抛错时，把错误交给模型继续", async () => {
  const failing = echoTool("fail", async () => {
    throw new Error("网站返回 HTTP 404");
  });
  const { model, requests } = scriptedModel([
    {
      text: "",
      finish: "tool_calls",
      toolCalls: [call("c1", "nope", {}), call("c2", "echo", "{bad"), call("c3", "fail", { text: "x" })],
    },
    { text: "都失败了", finish: "stop" },
  ]);
  const events: AgentEvent[] = [];

  await runAgent({ model, system: "s", messages: user, tools: [echoTool(), failing], signal, onEvent: (e) => events.push(e) });

  const outputs = requests[1].messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(outputs[0], /没有名为 nope 的工具/);
  assert.match(outputs[1], /不是合法的 JSON/);
  assert.match(outputs[2], /工具执行失败：网站返回 HTTP 404/);
  const failed = events.find((e) => e.type === "tool_end" && e.id === "c3");
  assert.ok(failed?.type === "tool_end");
  assert.equal(failed.ok, false);
  assert.equal(failed.name, "fail");
  assert.equal(failed.error, "网站返回 HTTP 404");
});

test("工具结果太长时截断", async () => {
  const big = echoTool("big", async () => "字".repeat(MAX_TOOL_OUTPUT_CHARS + 100));
  const { model, requests } = scriptedModel([
    { text: "", finish: "tool_calls", toolCalls: [call("c1", "big", {})] },
    { text: "好", finish: "stop" },
  ]);

  await runAgent({ model, system: "s", messages: user, tools: [big], signal });

  const output = requests[1].messages.at(-1)!.content;
  assert.ok(output.length < MAX_TOOL_OUTPUT_CHARS + 50);
  assert.match(output, /后面 100 字已省略/);
});

test("工具轮数用完后要求模型直接作答", async () => {
  const { model, requests } = scriptedModel([
    { text: "", finish: "tool_calls", toolCalls: [call("c1", "echo", { text: "1" })] },
    { text: "", finish: "tool_calls", toolCalls: [call("c2", "echo", { text: "2" })] },
    { text: "", finish: "tool_calls", toolCalls: [call("c3", "echo", { text: "3" })] },
  ]);

  const result = await runAgent({ model, system: "s", messages: user, tools: [echoTool()], signal, maxToolRounds: 2 });

  assert.equal(requests.length, 3);
  assert.match(requests[2].messages.at(-1)!.content, /工具调用次数已经用完/);
  assert.equal(result.toolCalls, 2);
  assert.match(result.text, /超出了单次上限/);
});

test("停止后中止正在执行的工具，不再调用模型", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const slow = echoTool("slow", (_args, ctx) =>
    new Promise((_, reject) => {
      started();
      ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  );
  const { model, requests } = scriptedModel([{ text: "", finish: "tool_calls", toolCalls: [call("c1", "slow", {})] }]);

  const run = runAgent({ model, system: "s", messages: user, tools: [slow], signal: controller.signal });
  await running;
  controller.abort();

  await assert.rejects(run);
  assert.equal(requests.length, 1);
});

test("每轮模型调用和每次工具调用都报告用时，带上模型用量和要调的工具", async () => {
  const { model } = scriptedModel([
    {
      text: "",
      finish: "tool_calls",
      toolCalls: [call("c1", "echo", { text: "a" }), call("c2", "echo", { text: "b" })],
      usage: { input: 900, output: 40, reasoning: 30 },
    },
    { text: "好了", finish: "stop" },
  ]);
  let clock = 0;
  const events: AgentEvent[] = [];

  await runAgent({
    model,
    system: "s",
    messages: user,
    tools: [echoTool()],
    signal,
    now: () => (clock += 5),
    onEvent: (e) => events.push(e),
  });

  const rounds = events.filter((e) => e.type === "model");
  assert.deepEqual(rounds, [
    { type: "model", round: 1, ms: 5, usage: { input: 900, output: 40, reasoning: 30 }, toolNames: ["echo", "echo"] },
    { type: "model", round: 2, ms: 5, toolNames: [] },
  ]);
  const ends = events.filter((e) => e.type === "tool_end");
  assert.equal(ends.length, 2);
  for (const end of ends) {
    assert.ok(end.type === "tool_end" && end.ok && end.name === "echo" && end.ms > 0);
  }
});

test("回答没通过 review 时交回模型重做一次，第二次不再检查", async () => {
  const { model, requests } = scriptedModel([
    { text: "瞎编的答案", finish: "stop" },
    { text: "", finish: "tool_calls", toolCalls: [call("c1", "echo", { text: "a" })] },
    { text: "查过的答案", finish: "stop" },
  ]);
  const events: AgentEvent[] = [];
  const seen: string[][] = [];

  const result = await runAgent({
    model,
    system: "s",
    messages: user,
    tools: [echoTool()],
    signal,
    onEvent: (e) => events.push(e),
    review: (answer, used) => {
      seen.push([answer, ...used]);
      return "先查再答";
    },
  });

  assert.deepEqual(result, { text: "查过的答案", finish: "stop", toolCalls: 1 });
  // 只检查了第一版；第一版和要求一起交回模型
  assert.deepEqual(seen, [["瞎编的答案"]]);
  assert.deepEqual(requests[1].messages.slice(1), [
    { role: "assistant", content: "瞎编的答案" },
    { role: "user", content: "先查再答" },
  ]);
  assert.ok(events.some((e) => e.type === "retry" && e.reason === "先查再答"));
});

test("review 拿到这次调过的工具名，通过时直接返回", async () => {
  const { model } = scriptedModel([
    { text: "", finish: "tool_calls", toolCalls: [call("c1", "echo", { text: "a" })] },
    { text: "答案", finish: "stop" },
  ]);
  let used: string[] = [];
  const result = await runAgent({
    model,
    system: "s",
    messages: user,
    tools: [echoTool()],
    signal,
    review: (_answer, tools) => {
      used = [...tools];
      return undefined;
    },
  });
  assert.equal(result.text, "答案");
  assert.deepEqual(used, ["echo"]);
});
