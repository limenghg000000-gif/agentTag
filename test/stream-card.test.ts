import assert from "node:assert/strict";
import { test } from "node:test";
import { FeishuApiError } from "../src/feishu.js";
import { type CardKitApi, StreamingCard } from "../src/stream-card.js";

const quiet = { error() {} };
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

type Call =
  | { op: "update"; sequence: number; streaming: boolean; texts: Record<string, string> }
  | { op: "content"; sequence: number; element: string; content: string }
  | { op: "settings"; sequence: number; streaming: boolean };

/** 假的卡片实体接口：记下每次调用，fail 里返回 true 的调用抛错，返回错误的抛这个错误 */
function fakeKit(fail: (call: Call) => boolean | Error = () => false) {
  const calls: Call[] = [];
  const record = async (call: Call) => {
    calls.push(call);
    const failure = fail(call);
    if (failure) {
      throw failure instanceof Error ? failure : new Error(`${call.op} failed`);
    }
  };
  const api: CardKitApi = {
    create: async () => "card_1",
    update: (_id, card: any, sequence) =>
      record({
        op: "update",
        sequence,
        streaming: card.config.streaming_mode,
        texts: Object.fromEntries(card.body.elements.filter((e: any) => e.tag === "markdown").map((e: any) => [e.element_id, e.content])),
      }),
    setContent: (_id, element, content, sequence) => record({ op: "content", sequence, element, content }),
    settings: (_id, settings: any, sequence) => record({ op: "settings", sequence, streaming: settings.config.streaming_mode }),
  };
  return { api, calls };
}

/** 卡片：texts 是各个流式组件（带 element_id 的 markdown）的文字，streaming 是想不想开流式模式 */
const card = (streaming: boolean, texts: Record<string, string>, summary = "处理中…") => ({
  schema: "2.0",
  config: { update_multi: true, streaming_mode: streaming, summary: { content: summary } },
  body: {
    elements: [
      ...Object.entries(texts).map(([id, content]) => ({ tag: "markdown", element_id: id, content })),
      { tag: "button", element_id: "stop", text: { tag: "plain_text", content: "停止" } },
    ],
  },
});

test("生成时先打开流式模式，之后只按组件更新变了的文字；不在生成时关掉流式模式再全量更新；sequence 一直递增", async () => {
  const { api, calls } = fakeKit();
  const streaming = new StreamingCard(api, "card_1", card(false, { status: "思考中" }), quiet, 0, 0);

  // 多了一个组件：结构变了，先全量更新（流式模式还关着），再打开
  streaming.update(card(true, { status: "思考中", thought: "想" }));
  await settle();
  // 结构没变：只更新变了的那个组件
  streaming.update(card(true, { status: "思考中", thought: "想一想" }));
  await settle();
  // 这一轮想完了去调工具：关掉流式模式，全量更新
  streaming.update(card(false, { status: "正在执行", thought: "想一想" }));
  await settle();
  const landed = await streaming.finish(card(false, { answer: "答案" }, "答案"));

  assert.equal(landed, true);
  assert.deepEqual(calls, [
    { op: "update", sequence: 1, streaming: false, texts: { status: "思考中", thought: "想" } },
    { op: "settings", sequence: 2, streaming: true },
    { op: "content", sequence: 3, element: "thought", content: "想一想" },
    { op: "settings", sequence: 4, streaming: false },
    { op: "update", sequence: 5, streaming: false, texts: { status: "正在执行", thought: "想一想" } },
    { op: "update", sequence: 6, streaming: false, texts: { answer: "答案" } },
  ]);
});

test("短时间内的多次更新合并成一次，结束后的更新忽略；结束时流式模式还开着就先关掉", async () => {
  const { api, calls } = fakeKit();
  const streaming = new StreamingCard(api, "card_1", card(false, { status: "思考中", answer: "答" }), quiet, 0, 0);

  streaming.update(card(true, { status: "思考中", answer: "答案" }));
  streaming.update(card(true, { status: "思考中", answer: "答案是" }));
  streaming.update(card(true, { status: "思考中", answer: "答案是 42" }));
  await settle();
  await streaming.finish(card(false, { answer: "答案是 42。" }));
  streaming.update(card(true, { answer: "结束以后的更新" }));
  await settle();

  assert.deepEqual(calls, [
    { op: "settings", sequence: 1, streaming: true },
    { op: "content", sequence: 2, element: "answer", content: "答案是 42" },
    { op: "settings", sequence: 3, streaming: false },
    { op: "update", sequence: 4, streaming: false, texts: { answer: "答案是 42。" } },
  ]);
});

test("按组件更新失败一次（比如飞书关掉了流式模式）以后都改成全量更新", async () => {
  const errors: unknown[] = [];
  const { api, calls } = fakeKit((call) => call.op === "content");
  const streaming = new StreamingCard(api, "card_1", card(false, { status: "s", answer: "a" }), { error: (...args) => errors.push(args) }, 0, 0);

  streaming.update(card(true, { status: "s", answer: "ab" }));
  await settle();
  streaming.update(card(true, { status: "s", answer: "abc" }));
  await settle();

  assert.deepEqual(
    calls.map((call) => call.op),
    ["settings", "content", "settings", "update", "update"],
  );
  assert.deepEqual(calls.at(-1), { op: "update", sequence: 5, streaming: false, texts: { status: "s", answer: "abc" } });
  assert.match(String((errors[0] as unknown[])[0]), /流式更新卡片文字失败 card=card_1/);
});

test("打不开流式模式时这次全量更新，之后也都全量更新", async () => {
  const { api, calls } = fakeKit((call) => call.op === "settings" && call.streaming);
  const streaming = new StreamingCard(api, "card_1", card(false, { answer: "a" }), quiet, 0, 0);

  streaming.update(card(true, { answer: "ab" }));
  await settle();
  streaming.update(card(true, { answer: "abc" }));
  await settle();

  assert.deepEqual(
    calls.map((call) => `${call.op}${call.op === "update" ? `:${call.texts.answer}` : ""}`),
    ["settings", "update:ab", "update:abc"],
  );
});

test("全量更新失败时下一次照样全量推最新的；结束时最终卡片推不上去就推简单版本，都失败返回 false", async () => {
  let failing = true;
  const { api, calls } = fakeKit((call) => call.op === "update" && failing);
  const streaming = new StreamingCard(api, "card_1", card(false, { status: "s" }), quiet, 0, 0);

  streaming.update(card(false, { status: "s", thought: "t" }));
  await settle();
  failing = false;
  streaming.update(card(false, { status: "s2", thought: "t" }));
  await settle();
  assert.deepEqual(calls.at(-1), { op: "update", sequence: 2, streaming: false, texts: { status: "s2", thought: "t" } });

  failing = true;
  assert.equal(await streaming.finish(card(false, { answer: "最终" }), card(false, { answer: "简单" })), false);
  assert.deepEqual(
    calls.slice(2).map((call) => call.op === "update" && call.texts.answer),
    ["最终", "简单"],
  );

  const { api: api2 } = fakeKit((call) => call.op === "update" && call.texts.answer === "最终");
  assert.equal(await new StreamingCard(api2, "card_2", card(false, {}), quiet, 0, 0).finish(card(false, { answer: "最终" }), card(false, { answer: "简单" })), true);
});

test("全量更新至少隔 fullIntervalMs：等的时候来了新的推最新的；等的时候结束了就不推旧的，直接推最终卡片", async () => {
  const { api, calls } = fakeKit();
  const streaming = new StreamingCard(api, "card_1", card(false, { status: "a" }), quiet, 0, 50);
  const shown = () => calls.map((call) => (call.op === "update" ? call.texts.status : call.op));

  streaming.update(card(false, { status: "b" }));
  await settle();
  streaming.update(card(false, { status: "c" }));
  await settle();
  streaming.update(card(false, { status: "d" }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(shown(), ["b", "d"]);

  streaming.update(card(false, { status: "e" }));
  await settle();
  const startedAt = Date.now();
  assert.equal(await streaming.finish(card(false, { status: "最终" })), true);
  assert.deepEqual(shown(), ["b", "d", "最终"]);
  assert.ok(Date.now() - startedAt < 200);
});

test("被飞书限流时等一会儿用新的 sequence 重试，不算失败；重试几次还被限流才当失败", async () => {
  const limited = new FeishuApiError(99991400, "飞书接口返回错误 99991400：request trigger frequency limit", 400);
  let limits = 1;
  const { api, calls } = fakeKit((call) => (call.op === "content" && limits-- > 0 ? limited : false));
  const errors: unknown[] = [];
  const streaming = new StreamingCard(api, "card_1", card(false, { answer: "a" }), { error: (...args) => errors.push(args) }, 0, 0, [5, 5]);

  streaming.update(card(true, { answer: "ab" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  // 限流过去了，之后照样按组件更新
  streaming.update(card(true, { answer: "abc" }));
  await settle();

  assert.deepEqual(
    calls.map((call) => `${call.sequence}:${call.op}`),
    ["1:settings", "2:content", "3:content", "4:content"],
  );
  assert.deepEqual(errors, []);

  // 一直被限流：重试用完就当失败，改成全量更新
  limits = 3;
  streaming.update(card(true, { answer: "abcd" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    calls.slice(4).map((call) => call.op),
    ["content", "content", "content", "settings", "update"],
  );
  assert.equal(errors.length, 1);
});
