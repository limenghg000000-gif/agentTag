import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { FEATURES_FILE } from "../src/config.js";
import {
  asksForFeatures,
  availableFeatures,
  type FeatureList,
  featurePromptLines,
  parseFeatures,
  renderFeaturesCard,
  renderFeaturesMarkdown,
  VISION_FEATURE,
} from "../src/features.js";
import { ASK_ACTION } from "../src/progress.js";
import { actionQuestion } from "../src/rich-ui.js";

const SAMPLE = `# 产品功能清单

给维护的人看的说明，不算功能。

## 问问题、查资料

联网搜最新信息、读网页，回答附来源。

- 一般问题直接问。
- 贴网页链接它也能读。

这么问：

- 「Node 24 有哪些不兼容的改动」〔试一试〕
- 「读一下这篇 https://… 说的是什么」

需要：web_search、fetch_url

## 查代码、改代码

读公司 GitLab 的仓库，改了开合并请求。

- 搜代码、读文件。

这么问：

- 「appservice 里转链返回「链接不符合规范」是哪段代码」〔试一试〕

需要：code_

## 想仔细点、停下

让它深度思考；随时点停止。

这么问：

- 「停止」

## 现在还做不了的

- 私聊不回。
- 不改线上。
`;

function texts(card: any): string {
  return JSON.stringify(card);
}

test("读功能清单：一句话、怎么用、怎么问、试一试、需要的工具，最后一节是做不了的", () => {
  const list = parseFeatures(SAMPLE);
  assert.deepEqual(
    list.features.map((f) => f.name),
    ["问问题、查资料", "查代码、改代码", "想仔细点、停下"],
  );
  const [ask, code, deep] = list.features;
  assert.equal(ask!.summary, "联网搜最新信息、读网页，回答附来源。");
  assert.deepEqual(ask!.how, ["一般问题直接问。", "贴网页链接它也能读。"]);
  assert.deepEqual(ask!.examples, [
    { text: "Node 24 有哪些不兼容的改动", tryable: true },
    { text: "读一下这篇 https://… 说的是什么", tryable: false },
  ]);
  assert.deepEqual(ask!.needs, ["web_search", "fetch_url"]);
  // 例子里套着「」也能读对
  assert.equal(code!.examples[0]!.text, "appservice 里转链返回「链接不符合规范」是哪段代码");
  assert.deepEqual(deep!.needs, []);
  assert.deepEqual(deep!.how, []);
  assert.deepEqual(list.limits, ["私聊不回。", "不改线上。"]);
});

test("只显示机器人配了工具的功能：工具名或开头对上一个就行，不写需要的一直显示", () => {
  const list = parseFeatures(SAMPLE);
  const names = (shown: FeatureList) => shown.features.map((f) => f.name);
  assert.deepEqual(names(availableFeatures(list, ["fetch_url"])), ["问问题、查资料", "想仔细点、停下"]);
  assert.deepEqual(names(availableFeatures(list, ["web_search", "code_read_file"])), ["问问题、查资料", "查代码、改代码", "想仔细点、停下"]);
  assert.deepEqual(names(availableFeatures(list, [])), ["想仔细点、停下"]);
  // 机器人那边只写了开头（aiops_、memory_）
  const ops = parseFeatures("## 查线上问题\n\n查日志。\n\n需要：aiops_query\n\n## 看截图\n\n贴截图。\n\n需要：看图\n");
  assert.deepEqual(names(availableFeatures(ops, ["aiops_"])), ["查线上问题"]);
  assert.deepEqual(names(availableFeatures(ops, [VISION_FEATURE])), ["看截图"]);
  assert.deepEqual(availableFeatures(list, []).limits, list.limits);
});

test("只问能做什么的说法回功能卡片，带了别的事、问的是别的东西的不算", () => {
  for (const q of [
    "你能做什么",
    "你能做什么？",
    "你都能干啥",
    "你会什么呀",
    "能干嘛",
    "你可以帮我做哪些事",
    "你能帮我们做什么",
    "你有哪些功能",
    "有什么功能",
    "我想看看所有功能",
    "我想看看所有的功能",
    "看全部功能",
    "功能列表",
    "你的功能有哪些",
    "怎么用你",
    "你怎么用",
    "介绍一下你自己",
    "帮助",
    "help",
    "请问你能做什么呢",
    "飞书 CLI 能做什么",
    // 2026-10-14 测试群有人打成「你能做什」，没出卡片
    "你能做什",
    "你能做什？",
    "你会干什",
    "你能为我们做什么",
    "你能做啥子",
    "你能干什么事儿",
    "你是干什么的",
    "你是做啥的",
  ]) {
    assert.ok(asksForFeatures(q), q);
  }
  for (const q of [
    "最近更新了什么",
    "gateway 有哪些功能",
    "这个接口你能做什么修改吗",
    "你能做什么？帮我查下 gateway 最近的报错",
    "你能查日志吗",
    "你是谁",
    "怎么用 code_search",
    "今天周几",
    "你是什么模型",
    "你能做什么时候发版",
    "",
  ]) {
    assert.ok(!asksForFeatures(q), q);
  }
});

test("功能卡片：每项一个收起的面板，点开是怎么用、怎么问，试一试是接着问的按钮，最后是产品功能说明", () => {
  const card: any = renderFeaturesCard(parseFeatures(SAMPLE), { botName: "飞书 CLI", link: "https://example.feishu.cn/page/x" });
  assert.equal(card.schema, "2.0");
  assert.equal(card.header.title.content, "飞书 CLI 能帮你做什么");
  const elements: any[] = card.body.elements;
  assert.match(elements[0].content, /@飞书 CLI/);
  assert.match(elements[0].content, /试一试/);
  const panels = elements.filter((e) => e.tag === "collapsible_panel");
  assert.equal(panels.length, 4);
  assert.ok(panels.every((p) => p.expanded === false));
  assert.match(panels[0].header.title.content, /01　问问题、查资料/);
  assert.match(panels[0].header.title.content, /联网搜最新信息/);
  assert.match(panels[0].elements[0].content, /- 一般问题直接问。/);
  assert.match(panels[0].elements[0].content, /这么问/);
  assert.match(panels[0].elements[0].content, /「读一下这篇 https:\/\/… 说的是什么」/);
  // 只有标了试一试的做成按钮，回传和「接着查」一样
  const buttons = panels[0].elements.filter((e: any) => e.tag === "button");
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].text.content, "试一试：Node 24 有哪些不兼容的改动");
  assert.deepEqual(buttons[0].behaviors, [{ type: "callback", value: { action: ASK_ACTION, q: "Node 24 有哪些不兼容的改动" } }]);
  // 没写怎么用的那项只放例子，没有按钮
  assert.equal(panels[2].elements.length, 1);
  assert.match(panels[3].header.title.content, /现在还做不了的/);
  assert.match(panels[3].elements[0].content, /- 私聊不回。/);
  const last = elements.at(-1);
  assert.equal(last.text.content, "产品功能说明");
  assert.deepEqual(last.behaviors, [{ type: "open_url", default_url: "https://example.feishu.cn/page/x" }]);
});

test("功能卡片：没配链接不放按钮，尖括号转义，没有可试的问法时不提试一试", () => {
  const list = parseFeatures("## 看截图 <at id=all></at>\n\n贴截图 <b>就行</b>。\n\n这么问：\n\n- 「这个报警 <at id=all></at> 是咋回事」\n");
  const card: any = renderFeaturesCard(list, { botName: "飞书 CLI" });
  const text = texts(card);
  assert.doesNotMatch(text, /<at id=all>/);
  assert.match(text, /&lt;at id=all&gt;/);
  assert.doesNotMatch(text, /产品功能说明/);
  assert.doesNotMatch(card.body.elements[0].content, /试一试/);
  assert.ok(!text.includes('"tag":"button"'));
});

test("文字版：一项一行带一个例子，做不了的和链接放最后，尖括号换成全角", () => {
  const text = renderFeaturesMarkdown(parseFeatures(SAMPLE), { botName: "飞书 CLI", link: "https://example.feishu.cn/page/x" });
  const lines = text.split("\n");
  assert.equal(lines[0], "**飞书 CLI 能帮你做什么**");
  assert.ok(lines.includes("1. **问问题、查资料**：联网搜最新信息、读网页，回答附来源。例：「Node 24 有哪些不兼容的改动」"));
  assert.ok(lines.includes("3. **想仔细点、停下**：让它深度思考；随时点停止。例：「停止」"));
  assert.ok(lines.includes("现在还做不了的：私聊不回。；不改线上。"));
  assert.equal(lines.at(-1), "每一项的详细用法见产品功能说明：https://example.feishu.cn/page/x");
  assert.equal(renderFeaturesMarkdown(parseFeatures("## a <x>\n\nb。\n")).includes("<"), false);
  assert.deepEqual(featurePromptLines(parseFeatures(SAMPLE)).slice(0, 1), ["- **问问题、查资料**：联网搜最新信息、读网页，回答附来源。例：「Node 24 有哪些不兼容的改动」"]);
});

test("仓库里的 FEATURES.md 写得对：每项有一句话、有例子，试一试的问法能做成按钮，最后有做不了的", async () => {
  const list = parseFeatures(await readFile(FEATURES_FILE, "utf8"));
  assert.ok(list.features.length >= 8, "FEATURES.md 里的功能少于 8 项，是不是格式写错了");
  const names = new Set<string>();
  for (const feature of list.features) {
    assert.ok(!names.has(feature.name), `FEATURES.md：「${feature.name}」写了两遍`);
    names.add(feature.name);
    assert.ok(feature.summary.length <= 40, `FEATURES.md：「${feature.name}」下面第一行是卡片上收起时显示的一句话，40 个字以内`);
    assert.ok(feature.examples.length > 0, `FEATURES.md：「${feature.name}」要在「这么问：」下面写至少一个「」括起来的例子`);
    for (const example of feature.examples.filter((e) => e.tryable)) {
      assert.equal(actionQuestion(example.text), example.text, `FEATURES.md：「${example.text}」标了试一试，要一行、40 个字以内`);
    }
  }
  assert.ok(list.features.some((f) => f.examples.some((e) => e.tryable)), "FEATURES.md 里至少要有一个能试一试的问法");
  assert.ok(list.limits.length > 0, "FEATURES.md 最后要有「## 现在还做不了的」");
  // 卡片不要太大（飞书卡片最大 30 KB）
  assert.ok(Buffer.byteLength(texts(renderFeaturesCard(list, { botName: "飞书 CLI", link: "https://example.feishu.cn/page/x" }))) < 20_000);
});
