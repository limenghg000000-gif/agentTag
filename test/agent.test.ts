import assert from "node:assert/strict";
import { test } from "node:test";
import { type AgentEvent, compactToolResults, MAX_TOOL_OUTPUT_CHARS, runAgent } from "../src/agent.js";
import { type ChatMessage, type ChatModel, type ChatRequest, type ChatResult, LlmError } from "../src/llm.js";
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

test("工具可以自己定结果的字数上限", async () => {
  const big = { ...echoTool("big", async () => "字".repeat(MAX_TOOL_OUTPUT_CHARS + 100)), maxOutputChars: MAX_TOOL_OUTPUT_CHARS + 200 };
  const { model, requests } = scriptedModel([
    { text: "", finish: "tool_calls", toolCalls: [call("c1", "big", {})] },
    { text: "好", finish: "stop" },
  ]);

  await runAgent({ model, system: "s", messages: user, tools: [big], signal });

  assert.equal(requests[1].messages.at(-1)!.content, "字".repeat(MAX_TOOL_OUTPUT_CHARS + 100));
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

test("模型返回了思考内容时，这一轮的事件带上它", async () => {
  const { model } = scriptedModel([
    { text: "", finish: "tool_calls", toolCalls: [call("c1", "echo", { text: "a" })], reasoning: "先查日志" },
    { text: "好了", finish: "stop" },
  ]);
  const events: AgentEvent[] = [];

  await runAgent({ model, system: "s", messages: user, tools: [echoTool()], signal, now: () => 0, onEvent: (e) => events.push(e) });

  assert.deepEqual(
    events.filter((e) => e.type === "model"),
    [
      { type: "model", round: 1, ms: 0, toolNames: ["echo"], reasoning: "先查日志" },
      { type: "model", round: 2, ms: 0, toolNames: [] },
    ],
  );
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

test("调过 thinkAfter 认的工具以后，后面每一轮都打开思考；之前的轮次和别的工具不动；显式传了 thinking 时照它", async () => {
  const script = (): ChatResult[] => [
    { text: "", finish: "tool_calls", toolCalls: [call("c1", "echo", { text: "a" })] },
    { text: "", finish: "tool_calls", toolCalls: [call("c2", "aiops_query_logs", { text: "b" })] },
    { text: "", finish: "tool_calls", toolCalls: [call("c3", "echo", { text: "c" })] },
    { text: "查完了", finish: "stop" },
  ];
  const tools = [echoTool(), echoTool("aiops_query_logs")];
  const thinkAfter = (name: string) => name.startsWith("aiops_");
  const events: AgentEvent[] = [];

  const { model, requests } = scriptedModel(script());
  await runAgent({ model, system: "s", messages: user, tools, signal, thinkAfter, onEvent: (e) => events.push(e) });
  assert.deepEqual(
    requests.map((req) => req.thinking),
    [undefined, undefined, true, true],
  );
  assert.deepEqual(
    events.flatMap((e) => (e.type === "model" ? [e.thinking] : [])),
    [undefined, undefined, true, true],
  );

  const forced = scriptedModel(script());
  await runAgent({ model: forced.model, system: "s", messages: user, tools, signal, thinkAfter, thinking: false });
  assert.deepEqual(
    forced.requests.map((req) => req.thinking),
    [false, false, false, false],
  );
});

test("steerReasoning 返回一段话时，在这一轮工具结果后面加一条用户消息；没有思考内容、给出回答的那轮不看", async () => {
  const { model, requests } = scriptedModel([
    { text: "", finish: "tool_calls", toolCalls: [call("c1", "echo", { text: "a" }), call("c2", "echo", { text: "b" })], reasoning: "check the logs" },
    { text: "", finish: "tool_calls", toolCalls: [call("c3", "echo", { text: "c" })] },
    { text: "好了", finish: "stop", reasoning: "done" },
  ]);
  const seen: string[] = [];

  await runAgent({
    model,
    system: "s",
    messages: user,
    tools: [echoTool()],
    signal,
    steerReasoning: (reasoning) => {
      seen.push(reasoning);
      return "用中文想";
    },
  });

  assert.deepEqual(seen, ["check the logs"]);
  assert.deepEqual(requests[1].messages.slice(-3), [
    { role: "tool", toolCallId: "c1", content: "回声：a" },
    { role: "tool", toolCallId: "c2", content: "回声：b" },
    { role: "user", content: "用中文想" },
  ]);
  assert.deepEqual(requests[2].messages.at(-1), { role: "tool", toolCallId: "c3", content: "回声：c" });
});

test("轮数用完时上一条已经是用户消息（思考提醒）就把收尾提醒并进去，不连着两条用户消息", async () => {
  const { model, requests } = scriptedModel([
    { text: "", finish: "tool_calls", toolCalls: [call("c1", "echo", { text: "a" })], reasoning: "check the logs" },
    { text: "只能先这样答", finish: "stop" },
  ]);

  await runAgent({ model, system: "s", messages: user, tools: [echoTool()], signal, maxToolRounds: 1, steerReasoning: () => "用中文想" });

  const last = requests[1].messages.slice(-2);
  assert.deepEqual(
    last.map((m) => m.role),
    ["tool", "user"],
  );
  assert.match(last[1].content, /^用中文想\n\n工具调用次数已经用完/);
  // 调用方传进来的消息没被改
  assert.deepEqual(user, [{ role: "user", content: "帮我做事" }]);
});

test("stream 打开时把模型的 onDelta 转成这一轮的 delta 事件；不打开时不传 onDelta", async () => {
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    model: "fake",
    async chat(req) {
      requests.push(req);
      req.onDelta?.({ reasoning: "想", text: "" });
      req.onDelta?.({ reasoning: "想", text: "答" });
      return { text: "答", finish: "stop" };
    },
  };
  const events: AgentEvent[] = [];

  await runAgent({ model, system: "s", messages: user, tools: [], signal, stream: true, onEvent: (e) => events.push(e) });
  await runAgent({ model, system: "s", messages: user, tools: [], signal });

  assert.deepEqual(
    events.filter((e) => e.type === "delta"),
    [
      { type: "delta", round: 1, reasoning: "想", text: "" },
      { type: "delta", round: 1, reasoning: "想", text: "答" },
    ],
  );
  assert.equal(typeof requests[0].onDelta, "function");
  assert.equal(requests[1].onDelta, undefined);
});

/** 按顺序答：Error 就抛出（比如模型服务说输入太长），否则当作这次的结果 */
function scriptedModelWithErrors(script: (ChatResult | Error)[]) {
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    model: "fake",
    async chat(req) {
      requests.push({ ...req, messages: [...req.messages] });
      const next = script.shift();
      assert.ok(next, "模型被多调用了一次");
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
  return { model, requests };
}

const tooLong = () => new LlmError("too_long", "400 Range of input length should be [1, 991808]");
const big = (n: number) => echoTool(`big${n}`, async () => `${n}`.repeat(5000));
const toolContents = (req: ChatRequest) => req.messages.filter((m) => m.role === "tool").map((m) => m.content);

test("模型服务说输入太长时，最近 2 轮以前的工具结果压到只留开头再试，最近 2 轮原样留着", async () => {
  const { model, requests } = scriptedModelWithErrors([
    { text: "", finish: "tool_calls", toolCalls: [call("c1", "big1", {})] },
    { text: "", finish: "tool_calls", toolCalls: [call("c2", "big2", {})] },
    { text: "", finish: "tool_calls", toolCalls: [call("c3", "big3", {})] },
    tooLong(),
    { text: "查完了", finish: "stop" },
  ]);
  const events: AgentEvent[] = [];

  const result = await runAgent({ model, system: "s", messages: user, tools: [big(1), big(2), big(3)], signal, onEvent: (e) => events.push(e) });

  assert.equal(result.text, "查完了");
  assert.equal(requests.length, 5);
  const [first, second, third] = toolContents(requests[4]);
  assert.equal(first.slice(0, 2000), "1".repeat(2000));
  assert.match(first, /只留了开头 2000 字，后面 3000 字已省略；要用后面的内容请重新查/);
  assert.equal(second, "2".repeat(5000));
  assert.equal(third, "3".repeat(5000));
  const compacted = events.filter((e) => e.type === "compacted");
  assert.deepEqual(compacted, [{ type: "compacted", round: 4, results: 1, chars: 5000 - first.length }]);
  // 压短只改交给模型的那份，第一次失败的请求里还是原文
  assert.equal(toolContents(requests[3])[0], "1".repeat(5000));
});

test("压了较早的还放不下就连最近的也压，再不行只留很短的开头；都压过了还放不下就照原样报错", async () => {
  const { model, requests } = scriptedModelWithErrors([
    { text: "", finish: "tool_calls", toolCalls: [call("c1", "big1", {})] },
    { text: "", finish: "tool_calls", toolCalls: [call("c2", "big2", {})] },
    { text: "", finish: "tool_calls", toolCalls: [call("c3", "big3", {})] },
    tooLong(),
    tooLong(),
    tooLong(),
    tooLong(),
  ]);
  const events: AgentEvent[] = [];

  await assert.rejects(
    runAgent({ model, system: "s", messages: user, tools: [big(1), big(2), big(3)], signal, onEvent: (e) => events.push(e) }),
    (err) => err instanceof LlmError && err.kind === "too_long",
  );

  assert.equal(requests.length, 7);
  assert.deepEqual(
    toolContents(requests[5]).map((content) => content.match(/只留了开头 (\d+) 字/)?.[1]),
    ["2000", "2000", "2000"],
  );
  assert.deepEqual(
    toolContents(requests[6]).map((content) => content.match(/只留了开头 (\d+) 字/)?.[1]),
    ["300", "300", "300"],
  );
  assert.deepEqual(
    events.filter((e) => e.type === "compacted").map((e) => (e as { results: number }).results),
    [1, 2, 3],
  );
});

test("第一轮就说输入太长（还没有工具结果可压）时直接报错，不重试", async () => {
  const { model, requests } = scriptedModelWithErrors([tooLong()]);

  await assert.rejects(
    runAgent({ model, system: "s", messages: user, tools: [echoTool()], signal }),
    (err) => err instanceof LlmError && err.kind === "too_long",
  );
  assert.equal(requests.length, 1);
});

test("别的模型错误照原样抛出，不压缩、不重试", async () => {
  const { model, requests } = scriptedModelWithErrors([
    { text: "", finish: "tool_calls", toolCalls: [call("c1", "big1", {})] },
    new LlmError("api", "500 boom"),
  ]);

  await assert.rejects(
    runAgent({ model, system: "s", messages: user, tools: [big(1)], signal }),
    (err) => err instanceof LlmError && err.kind === "api",
  );
  assert.equal(requests.length, 2);
});

test("压过的结果只会越压越短：下一轮按较松的一档压时，不会把压到 300 字的又放回 2000 字", () => {
  const conversation: ChatMessage[] = [
    { role: "user", content: "问" },
    { role: "assistant", content: "", toolCalls: [call("c1", "a", {})] },
    { role: "tool", toolCallId: "c1", content: "x".repeat(5000) },
    { role: "assistant", content: "", toolCalls: [call("c2", "a", {})] },
    { role: "tool", toolCallId: "c2", content: "y".repeat(5000) },
    { role: "assistant", content: "", toolCalls: [call("c3", "a", {})] },
    { role: "tool", toolCallId: "c3", content: "短" },
  ];
  const originals = new Map<number, string>();
  const firstResult = conversation[2];

  assert.equal(compactToolResults(conversation, originals, { keepRounds: 0, headChars: 300 }).results, 2);
  const tight = conversation[2].content;
  assert.match(tight, /只留了开头 300 字，后面 4700 字已省略/);

  assert.deepEqual(compactToolResults(conversation, originals, { keepRounds: 2, headChars: 2000 }), { results: 0, chars: 0 });
  assert.equal(conversation[2].content, tight);
  assert.equal(conversation[6].content, "短");
  // 换成新的消息对象，原来那条不改（调用方传进来的消息也可能被别处用着）
  assert.equal(firstResult.content, "x".repeat(5000));
  assert.equal(originals.get(2), "x".repeat(5000));
});
