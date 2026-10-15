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

test("能改代码时：新分支开合并请求时起名，「合并到 uat」在同一话题里开到 uat，提到别处的修改先找到是哪个合并请求", () => {
  const read = ["code_read_file", "code_search", "code_branches", "code_requests", "chat_recent_threads"];
  const prompt = buildSystemPrompt({ ...base, toolNames: [...read, "code_edit_file", "code_open_pr"] });
  assert.match(prompt, /新分支不用先建，code_branches 的 switch_to 只能切到已有的分支/);
  assert.match(prompt, /target 填那个分支，机器人会从那个分支拉新分支、把改动搬过去，再开一个合并请求，之前开的不受影响；不要让群成员新开话题/);
  assert.match(prompt, /你不能合并，「合并到 uat」就是开一个到 uat 的合并请求/);
  // 把做好的修改提合并请求是动手，不重新排查；没调 code_open_pr 不能说开好了
  assert.match(prompt, /是让你动手，不是重新排查：改动已经在合并请求里了，不用再搜代码、读代码去核对之前的结论/);
  assert.match(prompt, /合并请求的编号和链接只写工具返回的；没调 code_open_pr、没拿到它返回的结果，不能说已经开好了/);
  assert.match(prompt, /话题里之前的回答不算查证，追问时也要重新查（让你把已经做好的修改提合并请求、合到别的分支不是追问，见下面开合并请求那条）。/);
  assert.match(prompt, /先弄清指的是哪一个：用 code_requests 按关键词找开着的和最近合过的合并请求，再用 chat_recent_threads 看本群最近几个话题里开过什么/);
  assert.match(prompt, /不能只凭文件的提交历史一样、或者找到几个相关的旧提交就说「已经合进去了」/);
  assert.match(prompt, /列出候选问群成员是哪一个，不要猜/);

  // 不在写权限名单里：没有开合并请求的工具，不提怎么开，查别处的修改照样要先找到是哪个
  const readOnly = buildSystemPrompt({ ...base, toolNames: read });
  assert.ok(!readOnly.includes("新分支不用先建"));
  assert.ok(!readOnly.includes("是让你动手"));
  assert.match(readOnly, /话题里之前的回答不算查证，追问时也要重新查。问到的服务/);
  assert.match(readOnly, /先弄清指的是哪一个：用 code_requests/);
  assert.ok(!readOnly.includes("code_open_pr 的 from"));
  assert.match(prompt, /用 code_open_pr 的 from 填它的编号、target 填那个分支/);
});
