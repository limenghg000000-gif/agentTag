import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSystemPrompt } from "../src/prompt.js";

const base = { botName: "飞书 CLI", now: new Date(0), toolNames: ["web_search"] };

test("问「你能做什么」「想看全部功能」时：按给的工具说几类事，附产品功能说明的链接", () => {
  const prompt = buildSystemPrompt({ ...base, about: { featuresLink: "https://yuebaiapp.feishu.cn/page/abc" } });
  assert.match(prompt, /有人问你能做什么、有哪些功能、怎么用你，或者想看全部功能时/);
  assert.match(prompt, /没给你的工具不要提/);
  assert.match(prompt, /\[产品功能说明\]\(https:\/\/yuebaiapp\.feishu\.cn\/page\/abc\)/);
  assert.ok(!prompt.includes("最近一次更新"), "没读到更新说明时不提");

  // 没配链接时照样按工具介绍，只是不附链接
  const noLink = buildSystemPrompt({ ...base });
  assert.match(noLink, /想看全部功能时/);
  assert.ok(!noLink.includes("产品功能说明"));
});

test("问最近更新了什么时：按最新一版的产品更新说明回答，更早的不编", () => {
  const prompt = buildSystemPrompt({
    ...base,
    about: {
      featuresLink: "https://yuebaiapp.feishu.cn/page/abc",
      latest: { version: "0.8.1", date: "2026-10-14", notes: "**更新通知写清楚了**\n- 写明本次更新了什么" },
    },
  });
  assert.match(prompt, /有人问最近更新了什么、新版本有什么时/);
  assert.match(prompt, /最近一次更新（版本 0\.8\.1，2026-10-14）：\n\*\*更新通知写清楚了\*\*\n- 写明本次更新了什么/);
  assert.match(prompt, /不要编/);
});

test("有功能清单时：问能做什么按清单一项一行说，不写技术词，附产品功能说明", () => {
  const features = {
    features: [
      { name: "问问题、查资料", summary: "联网搜最新信息、读网页，回答附来源。", how: [], examples: [{ text: "Node 24 有哪些不兼容的改动", tryable: true }], needs: [] },
      { name: "想仔细点、停下", summary: "让它深度思考；随时点停止。", how: [], examples: [], needs: [] },
    ],
    limits: [],
  };
  const prompt = buildSystemPrompt({ ...base, about: { featuresLink: "https://yuebaiapp.feishu.cn/page/abc", features } });
  assert.match(prompt, /按下面的「功能清单」说，顺序和功能名照清单写/);
  assert.match(prompt, /不写工具名、仓库路径这类技术词/);
  assert.match(prompt, /功能清单：\n- \*\*问问题、查资料\*\*：联网搜最新信息、读网页，回答附来源。例：「Node 24 有哪些不兼容的改动」\n- \*\*想仔细点、停下\*\*：让它深度思考；随时点停止。\n/);
  assert.match(prompt, /\[产品功能说明\]\(https:\/\/yuebaiapp\.feishu\.cn\/page\/abc\)/);
  assert.ok(!prompt.includes("没给你的工具不要提"));
});
