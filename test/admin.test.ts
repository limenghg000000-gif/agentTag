import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CardActionEvent, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { AdminDesk, SETTINGS_ACTION, SETTINGS_TTL_MS } from "../src/admin.js";
import { loadConfig } from "../src/config.js";
import { GroupPolicies } from "../src/groups.js";
import { GroupSettings } from "../src/settings.js";

const quiet = { info() {}, warn() {}, error() {} };
const ADMIN_CHAT = "oc_admin";
/** 另一个管理群：只有所有者自己，自己试用 */
const MINE = "oc_mine";

const env = {
  FEISHU_APP_ID: "cli_x",
  FEISHU_APP_SECRET: "s",
  MODEL_API_KEY: "k",
  FEISHU_ALLOWED_CHAT_IDS: "oc_test,oc_ops,oc_plain",
  GITLAB_URL: "https://lab.corp",
  GITLAB_TOKEN: "t",
  CODE_REPOS: "ai/aiops-mcp@aiops,ai/agent-tag",
  WRITE_ALLOWED_USERS: "ou_ml",
  MCP_SERVERS: "aiops=https://aiops.example.com/mcp",
  GROUPS: "ops=oc_ops",
  GROUP_OPS_WRITE_ALLOWED_USERS: "none",
};

interface Sent {
  to: string;
  card?: Record<string, unknown>;
  markdown?: string;
  replyTo?: string;
  messageId: string;
}

async function setup(
  opts: {
    allowAdminChat?: boolean;
    directory?: boolean;
    env?: Record<string, string>;
    onMembers?: () => Promise<void>;
    chats?: () => Promise<string[]>;
    /** 飞书拒收卡片（比如卡片写错了） */
    rejectCards?: boolean;
    /** 管理群，不填只有 ADMIN_CHAT */
    adminChats?: string[];
    /** 读这些群的成员时出错（机器人被移出群这类） */
    membersFail?: string[];
  } = {},
) {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), "agenttag-admin-")), "settings");
  const settings = new GroupSettings({ dir, logger: quiet });
  await settings.init();
  const config = loadConfig({ ...env, ...opts.env, ...(opts.allowAdminChat ? { FEISHU_ALLOWED_CHAT_IDS: `${env.FEISHU_ALLOWED_CHAT_IDS},${ADMIN_CHAT}` } : {}) });
  const groups = new GroupPolicies(config, settings);
  const sent: Sent[] = [];
  const cards = new Map<string, Record<string, unknown>>();
  const saved: string[] = [];
  let now = 1_000_000;
  const names: Record<string, string> = { oc_ops: "运营群", oc_test: "测试群", oc_plain: "产品群", oc_new: "新群", [ADMIN_CHAT]: "管理群", [MINE]: "自测群" };
  const members: Record<string, string[]> = { oc_ops: ["ou_a", "ou_b", "ou_c"], oc_new: ["ou_n1", "ou_n2"], [ADMIN_CHAT]: ["ou_owner", "ou_admin", "ou_x"], [MINE]: ["ou_owner"] };
  // 机器人在的群：白名单里的三个、管理群，还有一个没开通的新群
  const chats = opts.chats ?? (async () => ["oc_test", "oc_ops", "oc_plain", ADMIN_CHAT, "oc_new"]);
  const desk = new AdminDesk({
    chatIds: new Set(opts.adminChats ?? [ADMIN_CHAT]),
    owners: new Set(["ou_owner"]),
    settings,
    groups,
    repos: () => ["ai/aiops-mcp", "ai/agent-tag", "golang/*"],
    mcpServers: ["aiops"],
    mcpTools: () => ["query_logs", "search_knowledge", "get_knowledge"],
    knowledge: true,
    ...(opts.directory === false
      ? {}
      : {
          directory: {
            chatName: async (chatId: string) => names[chatId],
            members: async (chatId: string) => {
              await opts.onMembers?.();
              if (opts.membersFail?.includes(chatId)) {
                throw new Error("机器人不在群里");
              }
              return (members[chatId] ?? []).map((openId) => ({ openId }));
            },
            chats: async () => (await chats()).map((chatId) => ({ chatId, ...(names[chatId] ? { name: names[chatId] } : {}) })),
          },
        }),
    send: async (to, input, sendOpts) => {
      const messageId = `om_sent_${sent.length + 1}`;
      const item = input as { card?: Record<string, unknown>; markdown?: string };
      if (item.card) {
        assertFeishuAccepts(item.card);
        if (opts.rejectCards) {
          throw new Error("Failed to create card content, ext=ErrCode: 11310");
        }
      }
      sent.push({ to, messageId, ...(item.card ? { card: item.card } : {}), ...(item.markdown ? { markdown: item.markdown } : {}), ...(sendOpts?.replyTo ? { replyTo: sendOpts.replyTo } : {}) });
      if (item.card) {
        cards.set(messageId, item.card);
      }
      return { messageId } as never;
    },
    updateCard: async (messageId, card) => {
      assertFeishuAccepts(card);
      cards.set(messageId, card as Record<string, unknown>);
    },
    nameOf: async (openId) => ({ ou_owner: "老板", ou_admin: "管理员甲", ou_x: "路人" })[openId],
    onSaved: (chatId) => saved.push(chatId),
    logger: quiet,
    now: () => now,
  });
  return {
    desk,
    settings,
    groups,
    sent,
    cards,
    saved,
    dir,
    advance: (ms: number) => {
      now += ms;
    },
    say: (content: string, sender = "ou_owner", chatId = ADMIN_CHAT, mentionedBot = true) => desk.handleMessage(message(content, sender, chatId, mentionedBot)),
    /** 群里没 @ 机器人说的 */
    hear: (content: string, sender = "ou_owner", chatId = ADMIN_CHAT) => desk.handleUnaddressed(message(content, sender, chatId, false)),
    /** 点卡片上的按钮：按 op 在卡片里找按钮；在卡片发到的那个群里点 */
    click: async (messageId: string, op: string, operator: string, form?: Record<string, unknown>, extra: Record<string, string> = {}) => {
      const card = cards.get(messageId);
      assert.ok(card, `没有卡片 ${messageId}`);
      const value = findButton(card, op, extra);
      assert.ok(value, `卡片上没有 ${op} 按钮：${JSON.stringify(card)}`);
      const chatId = sent.find((item) => item.messageId === messageId)?.to ?? ADMIN_CHAT;
      return desk.handleCardAction(cardEvent(messageId, value, operator, form, chatId));
    },
  };
}

/** 飞书收卡片时的检查：一张卡片里组件的 name 不能重名（重名时整张卡片被拒，11310 name duplicate） */
function assertFeishuAccepts(card: unknown): void {
  const names: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      const item = node as Record<string, unknown>;
      if (typeof item.tag === "string" && typeof item.name === "string") {
        names.push(item.name);
      }
      Object.values(item).forEach(walk);
    }
  };
  walk(card);
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate) {
    throw new Error(`Failed to create card content, ext=ErrCode: 11310; ErrMsg: name(${duplicate}) duplicate`);
  }
}

function message(content: string, senderId: string, chatId: string, mentionedBot: boolean): NormalizedMessage {
  return {
    messageId: `om_in_${Math.random()}`,
    chatId,
    chatType: "group",
    senderId,
    content,
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot,
    createTime: Date.now(),
  };
}

function cardEvent(messageId: string, value: Record<string, unknown>, operator: string, form?: Record<string, unknown>, chatId = ADMIN_CHAT): CardActionEvent {
  return {
    messageId,
    chatId,
    operator: { openId: operator },
    action: { value, tag: "button" },
    raw: { action: { value, tag: "button", ...(form ? { form_value: form } : {}) } },
  };
}

function findButton(node: unknown, op: string, extra: Record<string, string>): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findButton(item, op, extra);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof node !== "object" || node === null) {
    return undefined;
  }
  const record = node as Record<string, unknown>;
  const value = (record.behaviors as Array<{ value?: Record<string, unknown> }> | undefined)?.[0]?.value;
  if (value?.op === op && Object.entries(extra).every(([key, v]) => value[key] === v)) {
    return value;
  }
  for (const child of Object.values(record)) {
    const found = findButton(child, op, extra);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function text(card: Record<string, unknown> | undefined): string {
  return JSON.stringify(card);
}

/** 表单里一个下拉框的初始选项 */
function initial(card: Record<string, unknown> | undefined, name: string): unknown {
  let found: unknown;
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (typeof node === "object" && node !== null) {
      const record = node as Record<string, unknown>;
      if (record.name === name) {
        found = record.initial_option ?? record.selected_values;
      }
      Object.values(record).forEach(walk);
    }
  };
  walk(card);
  return found;
}

const keepAll = { repos_mode: "env", writers_mode: "env", editors_mode: "env", mcp_0_mode: "env", knowledge: "env", proactive: "env" };

test("管理群里 @ 机器人说「配置」：回总览卡片，列出白名单里的群和现在的设置；别的群、没 @ 的不管", async () => {
  const t = await setup();
  assert.equal(await t.say("配置", "ou_owner", "oc_ops"), false);
  assert.equal(await t.say("配置", "ou_owner", ADMIN_CHAT, false), false);
  assert.equal(await t.say("配置"), true);
  assert.equal(t.sent.length, 1);
  const overview = text(t.sent[0]!.card);
  assert.match(overview, /各群的设置/);
  assert.match(overview, /运营群/);
  assert.match(overview, /测试群/);
  assert.match(overview, /写权限 谁都不能/, "运营群在 .env 里写权限是 none");
  assert.match(overview, /所有者 1 人，管理员 0 人/);
});

test("管理群里不 @ 也能说「配置」：整句是「配置」「配置 管理员」或者对得上群的才回卡片，平时聊天的话不管", async () => {
  const t = await setup();
  assert.equal(await t.hear("配置"), true);
  assert.match(text(t.sent[0]!.card), /各群的设置/);
  assert.match(t.sent[0]!.replyTo ?? "", /^om_in_/, "回在说「配置」的那条下面");
  assert.equal(await t.hear("配置 管理员"), true);
  assert.match(text(t.sent[1]!.card), /管理员名单/);
  assert.equal(await t.hear("设置 运营群"), true);
  assert.match(text(t.sent[2]!.card), /「运营群」的设置/);

  assert.equal(await t.hear("配置一下测试环境"), false);
  assert.equal(await t.hear("设置 测试环境"), false, "对不上群的不回总览");
  assert.equal(await t.hear("帮我查下日志"), false, "别的话也不回怎么用");
  assert.equal(await t.hear("配置", "ou_owner", "oc_ops"), false, "不是管理群的不管");
  assert.equal(await t.desk.handleUnaddressed(message("配置", "ou_owner", ADMIN_CHAT, true)), false, "@ 了的归 handleMessage");
  assert.equal(t.sent.length, 3);
});

test("「配置 群名」直接打开那个群；GROUPS 里的名字也认；对不上的回总览并说一句", async () => {
  const t = await setup();
  await t.say("配置 运营群");
  assert.match(text(t.sent[0]!.card), /「运营群」的设置/);
  await t.say("配置 OPS");
  assert.match(text(t.sent[1]!.card), /「运营群」的设置/);
  await t.say("配置 财务群");
  assert.match(text(t.sent[2]!.card), /没找到叫「财务群」的群/);
  await t.say("配置 群");
  assert.match(text(t.sent[3]!.card), /有 4 个群对得上「群」/, "还没开通的新群也算");
  assert.match(text(t.sent[3]!.card), /还没开通的群.*新群.*"开通"/);
});

test("管理员改一个群：表单里选好、核对改前改后、点确认才存，下一条消息起生效，管理群里另发一条", async () => {
  const t = await setup();
  await t.say("配置 运营群", "ou_owner");
  const card = t.sent[0]!.messageId;
  assert.equal(initial(t.cards.get(card), "writers_mode"), "env");
  assert.match(text(t.cards.get(card)), /照服务器上的配置（现在：谁都不能）/);

  await t.click(card, "next", "ou_owner", { ...keepAll, writers_mode: "list", writers: ["ou_a", "ou_b"], mcp_0_mode: "list", mcp_0_tools: ["query_logs"], proactive: "on" });
  const review = text(t.cards.get(card));
  assert.match(review, /核对「运营群」的改动/);
  assert.match(review, /写权限\*\*：照服务器上的配置（现在：谁都不能） → 只有这 2 人：<person id='ou_a'/);
  assert.match(review, /aiops 工具\*\*：照服务器上的配置（现在：全开） → 只开 1 个：query_logs/);
  assert.match(review, /不 @ 也主动接话\*\*：照服务器上的配置（现在：关） → 开/);
  assert.equal(t.settings.override("oc_ops"), undefined, "核对时还没存");

  await t.click(card, "confirm", "ou_owner");
  assert.deepEqual(t.settings.override("oc_ops"), { writeAllowed: ["ou_a", "ou_b"], mcp: { aiops: ["query_logs"] }, proactive: true });
  assert.deepEqual(t.groups.of("oc_ops").writeAllowed, new Set(["ou_a", "ou_b"]));
  assert.equal(t.groups.of("oc_ops").proactive, true);
  assert.deepEqual(t.saved, ["oc_ops"]);
  assert.match(text(t.cards.get(card)), /运营群 的设置已保存/);
  const notice = t.sent.at(-1)!;
  assert.equal(notice.to, ADMIN_CHAT);
  assert.equal(notice.replyTo, card);
  assert.match(text(notice.card), /<person id='ou_owner'.*改了「运营群」的设置/);

  const log = JSON.parse((await readFile(path.join(t.dir, "changes.log"), "utf8")).trim());
  assert.equal(log.by, "ou_owner");
  assert.equal(log.byName, "老板");
  assert.equal(log.target, "oc_ops");
  assert.equal(log.changes.length, 3);

  // 卡片处理完了：再点提示失效
  await t.desk.handleCardAction(cardEvent(card, { action: SETTINGS_ACTION, card: "gone", op: "confirm", r: "1" }, "ou_owner"));
  assert.match(text(t.cards.get(card)), /已经失效/);
});

test("不是管理员的人能看不能改：点下一步、确认都只写一句，不存", async () => {
  const t = await setup();
  await t.say("配置 运营群", "ou_x");
  const card = t.sent[0]!.messageId;
  await t.click(card, "next", "ou_x", { ...keepAll, proactive: "on" });
  assert.match(text(t.cards.get(card)), /路人点了按钮：只有管理员能改设置/);
  // 管理员点了下一步，路人再点确认也不行
  await t.click(card, "next", "ou_owner", { ...keepAll, proactive: "on" });
  await t.click(card, "confirm", "ou_x");
  assert.match(text(t.cards.get(card)), /只有管理员能改设置/);
  assert.equal(t.settings.override("oc_ops"), undefined);
});

test("填的不对的项不往下走，卡片上写哪里不对：没接入的仓库、不在群里的人、服务器上没开的工具、一个人没选", async () => {
  const t = await setup();
  await t.say("配置 运营群");
  const card = t.sent[0]!.messageId;
  await t.click(card, "next", "ou_owner", {
    ...keepAll,
    repos_mode: "set",
    repos: ["evil/repo"],
    writers_mode: "list",
    writers: ["ou_stranger"],
    editors_mode: "list",
    editors: [],
    mcp_0_mode: "list",
    mcp_0_tools: ["delete_pod"],
  });
  const shown = text(t.cards.get(card));
  assert.match(shown, /有几处不对，没往下走/);
  assert.match(shown, /代码仓库：勾的仓库有的服务器上没接入/);
  assert.match(shown, /写权限：选的人不在这个群里/);
  assert.match(shown, /改群记忆：选了「只有下面选的人」但一个人都没选/);
  assert.match(shown, /aiops 工具：勾的工具有的服务器上没开/);
  assert.equal(initial(t.cards.get(card), "next"), undefined);
  assert.doesNotMatch(shown, /核对「运营群」的改动/);
});

test("没改什么点下一步：说一声，不出核对", async () => {
  const t = await setup();
  await t.say("配置 运营群");
  const card = t.sent[0]!.messageId;
  await t.click(card, "next", "ou_owner", keepAll);
  assert.match(text(t.cards.get(card)), /和现在的设置一样，没有要改的/);
  assert.match(afterForm(t.cards.get(card)), /⚠️.*和现在的设置一样/, "写在「下一步」正下方，不写在长表单上面");

  // 管理员名单也一样：选的和现在的一样
  await t.say("配置 管理员", "ou_owner");
  const admins = t.sent.at(-1)!.messageId;
  await t.click(admins, "next", "ou_owner", { admins: [] });
  assert.match(afterForm(t.cards.get(admins)), /⚠️.*和现在的名单一样，没有要改的/);
});

/** 卡片上紧跟在表单后面的那个组件 */
function afterForm(card: Record<string, unknown> | undefined): string {
  const elements = (card as { body: { elements: Array<{ tag?: string }> } }).body.elements;
  const at = elements.findIndex((element) => element.tag === "form");
  assert.ok(at >= 0, "卡片上有表单");
  return JSON.stringify(elements[at + 1]);
}

test("没读到表单里的值（没开原始事件）：请再点一次，不改", async () => {
  const t = await setup();
  await t.say("配置 运营群");
  const card = t.sent[0]!.messageId;
  await t.click(card, "next", "ou_owner");
  assert.match(text(t.cards.get(card)), /没读到卡片上选的内容/);
});

test("打开卡片以后别人先改了同一个群：确认时不覆盖，换成最新的设置请重新改", async () => {
  const t = await setup();
  await t.say("配置 运营群");
  await t.say("配置 运营群");
  const [first, second] = [t.sent[0]!.messageId, t.sent[1]!.messageId];
  await t.click(first, "next", "ou_owner", { ...keepAll, knowledge: "off" });
  await t.click(second, "next", "ou_owner", { ...keepAll, proactive: "on" });
  await t.click(first, "confirm", "ou_owner");
  await t.click(second, "confirm", "ou_owner");
  assert.deepEqual(t.settings.override("oc_ops"), { knowledge: false }, "第二张没覆盖第一张存的");
  const shown = t.cards.get(second);
  assert.match(text(shown), /有人改过「运营群」的设置/);
  assert.equal(initial(shown, "knowledge"), "off", "表单换成了最新的");
});

test("核对以后卡片又被换过（点的是旧的确认）：不存", async () => {
  const t = await setup();
  await t.say("配置 运营群");
  const card = t.sent[0]!.messageId;
  await t.click(card, "next", "ou_owner", { ...keepAll, proactive: "on" });
  const oldConfirm = findButton(t.cards.get(card), "confirm", {})!;
  await t.click(card, "edit", "ou_owner");
  await t.click(card, "next", "ou_owner", { ...keepAll, proactive: "off" });
  await t.desk.handleCardAction(cardEvent(card, oldConfirm, "ou_owner"));
  assert.equal(t.settings.override("oc_ops"), undefined);
  assert.match(text(t.cards.get(card)), /卡片上的改动刚被换过，这次没有保存/);
});

test("卡片 30 分钟后失效；机器人重启过的旧卡片点了也提示失效；别的群里点的不理", async () => {
  const t = await setup();
  await t.say("配置 运营群");
  const card = t.sent[0]!.messageId;
  const next = findButton(t.cards.get(card), "next", {})!;
  assert.equal(await t.desk.handleCardAction(cardEvent(card, next, "ou_owner", { ...keepAll, proactive: "on" }, "oc_ops")), true);
  assert.match(text(t.cards.get(card)), /「运营群」的设置/, "别的群里点的不理");
  t.advance(SETTINGS_TTL_MS + 1);
  await t.click(card, "next", "ou_owner", { ...keepAll, proactive: "on" });
  assert.match(text(t.cards.get(card)), /超过 30 分钟，已经失效/);
  assert.equal(t.settings.override("oc_ops"), undefined);
  assert.equal(await t.desk.handleCardAction(cardEvent("om_old", { action: "other" }, "ou_owner")), false, "不是设置卡片的交给别人");
});

test("全部照服务器上的配置：去掉这个群在卡片上改过的项", async () => {
  const t = await setup();
  await t.settings.saveGroup("oc_ops", { proactive: true, codeRepos: [] }, 0, { by: "ou_owner", changes: [] });
  await t.say("配置 运营群");
  const card = t.sent[0]!.messageId;
  await t.click(card, "reset", "ou_owner");
  assert.match(text(t.cards.get(card)), /代码仓库\*\*：不开代码工具 → 照服务器上的配置（现在：ai\/aiops-mcp、ai\/agent-tag）/);
  await t.click(card, "confirm", "ou_owner");
  assert.equal(t.settings.override("oc_ops"), undefined);
  assert.equal(t.groups.of("oc_ops").proactive, false);
});

test("总览上点「改设置」另发这个群的设置卡片；同一个按钮能再点", async () => {
  const t = await setup();
  await t.say("配置");
  const overview = t.sent[0]!.messageId;
  await t.click(overview, "open", "ou_admin", undefined, { chat: "oc_test" });
  await t.click(overview, "open", "ou_admin", undefined, { chat: "oc_test" });
  await new Promise((resolve) => setImmediate(resolve));
  const opened = t.sent.slice(1);
  assert.equal(opened.length, 2);
  assert.equal(opened[0]!.replyTo, overview);
  assert.match(text(opened[0]!.card), /「测试群」的设置/);
  // 按钮换了编号：飞书 SDK 按按钮内容去重，不换的话同一个人第二次点会被丢掉
  assert.equal(findButton(t.cards.get(overview), "open", { chat: "oc_test" })!.r, "2");
});

test("管理员名单：只有所有者能加减；加上的管理员能改各群", async () => {
  const t = await setup();
  await t.say("配置 管理员", "ou_owner");
  const card = t.sent[0]!.messageId;
  assert.match(text(t.cards.get(card)), /所有者\*\*（写在服务器配置里，卡片上改不了）：<person id='ou_owner'/);
  await t.click(card, "next", "ou_owner", { admins: ["ou_admin", "ou_owner"] });
  assert.match(text(t.cards.get(card)), /管理员\*\*：没有 → 1 人：<person id='ou_admin'.*（加了 <person id='ou_admin'/);
  await t.click(card, "confirm", "ou_owner");
  assert.deepEqual([...t.settings.admins()], ["ou_admin"], "所有者本人不进管理员名单");
  assert.equal(t.desk.isAdmin("ou_admin"), true);

  // 管理员不能加减管理员
  await t.say("配置 管理员", "ou_admin");
  const second = t.sent.at(-1)!.messageId;
  await t.click(second, "next", "ou_admin", { admins: ["ou_admin", "ou_x"] });
  assert.match(text(t.cards.get(second)), /只有所有者（写在服务器配置里的那几位）能加减管理员/);
  assert.deepEqual([...t.settings.admins()], ["ou_admin"]);

  // 不在管理群里的人加不了
  await t.say("配置 管理员", "ou_owner");
  const third = t.sent.at(-1)!.messageId;
  await t.click(third, "next", "ou_owner", { admins: ["ou_stranger"] });
  assert.match(text(t.cards.get(third)), /选的人不在管理群里/);

  // 管理员能改群
  await t.say("配置 测试群", "ou_admin");
  const group = t.sent.at(-1)!.messageId;
  await t.click(group, "next", "ou_admin", { ...keepAll, proactive: "on" });
  await t.click(group, "confirm", "ou_admin");
  assert.deepEqual(t.settings.override("oc_test"), { proactive: true });
});

test("管理群可以有几个：哪个里面都能改，卡片和改动通知只发在说「配置」的那个群；管理员从各个管理群的人里选；管理群都不算没开通的群", async () => {
  const t = await setup({ adminChats: [ADMIN_CHAT, MINE], chats: async () => ["oc_test", "oc_ops", "oc_plain", ADMIN_CHAT, MINE, "oc_new"] });
  await t.say("配置 运营群", "ou_owner", MINE);
  const card = t.sent[0]!;
  assert.equal(card.to, MINE);
  await t.click(card.messageId, "next", "ou_owner", { ...keepAll, proactive: "on" });
  await t.click(card.messageId, "confirm", "ou_owner");
  assert.deepEqual(t.settings.override("oc_ops"), { proactive: true });
  assert.match(text(t.sent.at(-1)!.card), /改了「运营群」的设置/);
  assert.deepEqual(
    t.sent.map((item) => item.to),
    [MINE, MINE],
    "通知只发在自测群，不吵大家用的管理群",
  );
  // 卡片在自测群里，拿到别的管理群里点（编号对得上也不认）：不改
  await t.say("配置 测试群", "ou_owner", MINE);
  const other = t.sent.at(-1)!.messageId;
  const next = findButton(t.cards.get(other), "next", {})!;
  await t.desk.handleCardAction(cardEvent(other, next, "ou_owner", { ...keepAll, proactive: "on" }, ADMIN_CHAT));
  assert.match(text(t.cards.get(other)), /已经失效/);
  assert.equal(t.settings.override("oc_test"), undefined);

  // 自测群里只有所有者自己：管理员照样能从大家用的管理群的人里选
  await t.say("配置 管理员", "ou_owner", MINE);
  const admins = t.sent.at(-1)!.messageId;
  await t.click(admins, "next", "ou_owner", { admins: ["ou_admin"] });
  await t.click(admins, "confirm", "ou_owner");
  assert.deepEqual([...t.settings.admins()], ["ou_admin"]);
  // 两个管理群都不当成要开通的群，「配置 群编号」也打不开
  await t.say("配置", "ou_owner", ADMIN_CHAT);
  const overview = t.sent.at(-1)!;
  assert.equal(overview.to, ADMIN_CHAT);
  assert.equal(findButton(overview.card, "open", { chat: MINE }), undefined);
  assert.equal(findButton(overview.card, "open", { chat: ADMIN_CHAT }), undefined);
  assert.ok(findButton(overview.card, "open", { chat: "oc_new" }));
  await t.say(`配置 ${MINE}`, "ou_owner", ADMIN_CHAT);
  assert.doesNotMatch(text(t.sent.at(-1)!.card), /「自测群」的设置/);

  // 机器人被移出了自测群、读不到那个群的成员：大家用的管理群的人照样能选
  const partial = await setup({ adminChats: [ADMIN_CHAT, MINE], membersFail: [MINE] });
  await partial.say("配置 管理员", "ou_owner", ADMIN_CHAT);
  const list = partial.sent[0]!.messageId;
  assert.match(text(partial.cards.get(list)), /有 1 个管理群读不到成员/);
  await partial.click(list, "next", "ou_owner", { admins: ["ou_admin"] });
  await partial.click(list, "confirm", "ou_owner");
  assert.deepEqual([...partial.settings.admins()], ["ou_admin"]);
});

test("管理员名单：群里有人可选时卡片照样发得出去（表单和选人框不重名）", async () => {
  const t = await setup();
  await t.say("配置 管理员", "ou_owner");
  const card = t.cards.get(t.sent[0]!.messageId);
  assert.match(text(card), /"multi_select_person"/);
  assert.match(text(card), /"name":"admins_form"/);
});

test("设置卡片没发出去（飞书拒收）：管理群里回一句，不是什么都没有", async () => {
  const t = await setup({ rejectCards: true });
  assert.equal(await t.say("配置 管理员", "ou_owner"), true);
  const reply = t.sent.at(-1)!;
  assert.match(reply.replyTo ?? "", /^om_in_/);
  assert.match(reply.markdown ?? "", /设置卡片没发出去（Failed to create card content, ext=ErrCode: 11310），设置没改/);
});

test("读不到群成员（没开权限）：只能从名单里已有的人里减，卡片上说明", async () => {
  const t = await setup({ directory: false });
  await t.settings.saveGroup("oc_ops", { writeAllowed: ["ou_a", "ou_b"] }, 0, { by: "ou_owner", changes: [] });
  await t.say("配置 oc_ops");
  const card = t.sent[0]!.messageId;
  assert.match(text(t.cards.get(card)), /读不到这个群的成员/);
  await t.click(card, "next", "ou_owner", { ...keepAll, writers_mode: "list", writers: ["ou_a", "ou_c"] });
  assert.match(text(t.cards.get(card)), /写权限：选的人不在这个群里/);
  await t.click(card, "next", "ou_owner", { ...keepAll, writers_mode: "list", writers: ["ou_a"] });
  await t.click(card, "confirm", "ou_owner");
  assert.deepEqual(t.settings.override("oc_ops"), { writeAllowed: ["ou_a"] });
});

test("管理群不在白名单里：别的话回一句这里能做什么；在白名单里时照常交给模型", async () => {
  const t = await setup();
  assert.equal(await t.say("帮我查下日志"), true);
  assert.match(t.sent[0]!.markdown!, /这里是管理群/);
  const allowed = await setup({ allowAdminChat: true });
  assert.equal(await allowed.say("帮我查下日志"), false);
  assert.equal(allowed.sent.length, 0);
});

test("打开卡片时读群成员那会儿别人存了设置：卡片拿的是存之前的版本号，确认时不会盖掉别人的改动", async () => {
  let settingsRef: GroupSettings | undefined;
  let raced = false;
  const t = await setup({
    onMembers: async () => {
      if (!raced && settingsRef) {
        raced = true;
        await settingsRef.saveGroup("oc_ops", { knowledge: false }, 0, { by: "ou_admin", changes: [] });
        await settingsRef.saveAdmins(["ou_admin"], 0, { by: "ou_owner", changes: [] });
      }
    },
  });
  settingsRef = t.settings;
  await t.say("配置 运营群");
  const card = t.sent[0]!.messageId;
  await t.click(card, "next", "ou_owner", { ...keepAll, proactive: "on" });
  assert.match(text(t.cards.get(card)), /有人改过「运营群」的设置/);
  assert.deepEqual(t.settings.override("oc_ops"), { knowledge: false });
});

test("读不到群成员时，.env 里现在的名单也能选：照服务器上的配置先勾上，改成只留其中几个人", async () => {
  const t = await setup({ directory: false, env: { WRITE_ALLOWED_USERS: "ou_ml,ou_lee" } });
  await t.say("配置 oc_plain");
  const card = t.sent[0]!.messageId;
  assert.deepEqual(initial(t.cards.get(card), "writers"), ["ou_ml", "ou_lee"], "照服务器上的配置时先勾上现在的名单");
  await t.click(card, "next", "ou_owner", { ...keepAll, writers_mode: "list", writers: ["ou_ml"] });
  assert.match(text(t.cards.get(card)), /写权限\*\*：照服务器上的配置（现在：2 人：.*） → 只有这 1 人/);
  await t.click(card, "confirm", "ou_owner");
  assert.deepEqual(t.settings.override("oc_plain"), { writeAllowed: ["ou_ml"] });
});

test("总览列出机器人在、还没开通的群（管理群自己不算）；点「开通」先收紧，管理员改好、核对、确认后马上开通", async () => {
  const t = await setup();
  await t.say("配置");
  const overview = t.sent[0]!.messageId;
  assert.match(text(t.cards.get(overview)), /机器人在、还没开通的群.*新群/);
  assert.equal(findButton(t.cards.get(overview), "open", { chat: ADMIN_CHAT }), undefined);

  await t.click(overview, "open", "ou_x", undefined, { chat: "oc_new" });
  await new Promise((resolve) => setImmediate(resolve));
  const card = t.sent[1]!.messageId;
  const form = t.cards.get(card);
  assert.match(text(form), /开通「新群」/);
  assert.match(text(form), /新开通的群先收紧/);
  assert.equal(initial(form, "repos_mode"), "set");
  assert.equal(initial(form, "writers_mode"), "none");
  assert.equal(initial(form, "mcp_0_mode"), "off");
  assert.equal(initial(form, "proactive"), "env");

  const choice = { ...keepAll, repos_mode: "set", repos: [], writers_mode: "list", writers: ["ou_n1"], mcp_0_mode: "list", mcp_0_tools: ["query_logs"] };
  await t.click(card, "next", "ou_x", choice);
  assert.match(text(t.cards.get(card)), /只有管理员能改设置/);
  await t.click(card, "next", "ou_owner", choice);
  const review = text(t.cards.get(card));
  assert.match(review, /核对：开通「新群」/);
  assert.match(review, /开通\*\*：没开通（在群里不回话） → 已开通（在群里回话）/);
  assert.match(review, /代码仓库\*\*：照服务器上的配置（现在：ai\/aiops-mcp、ai\/agent-tag） → 不开代码工具/);
  assert.equal(t.groups.allowed.has("oc_new"), false, "核对时还没开通");

  await t.click(card, "confirm", "ou_owner");
  assert.deepEqual(t.settings.override("oc_new"), { enabled: true, codeRepos: [], writeAllowed: ["ou_n1"], mcp: { aiops: ["query_logs"] } });
  assert.equal(t.groups.allowed.has("oc_new"), true);
  assert.deepEqual(t.groups.of("oc_new").codeRepos, []);
  assert.deepEqual(t.groups.of("oc_new").writeAllowed, new Set(["ou_n1"]));
  assert.match(text(t.cards.get(card)), /已开通「新群」.*从下一条消息起在这个群里回话/);
  assert.match(text(t.sent.at(-1)!.card), /开通了「新群」/);
  assert.deepEqual(t.saved, ["oc_new"]);

  await t.say("配置");
  const after = t.sent.at(-1)!.card;
  assert.ok(findButton(after, "open", { chat: "oc_new" }));
  assert.doesNotMatch(text(after), /还没开通的群/);
});

test("停用一个群：只改开通这一项，确认后马上不回话，其余的设置留着；再开通照原来的设置", async () => {
  const t = await setup();
  await t.settings.saveGroup("oc_ops", { proactive: true }, 0, { by: "ou_owner", changes: [] });
  await t.say("配置 运营群");
  const card = t.sent[0]!.messageId;
  await t.click(card, "disable", "ou_owner");
  const review = text(t.cards.get(card));
  assert.match(review, /核对：停用「运营群」/);
  assert.match(review, /开通\*\*：已开通（在群里回话） → 没开通（在群里不回话）/);
  assert.doesNotMatch(review, /主动接话\*\*/);
  // 返回修改：表单上还是开通的
  await t.click(card, "edit", "ou_owner");
  assert.match(text(t.cards.get(card)), /「运营群」的设置/);
  await t.click(card, "disable", "ou_owner");
  await t.click(card, "confirm", "ou_owner");
  assert.deepEqual(t.settings.override("oc_ops"), { enabled: false, proactive: true });
  assert.equal(t.groups.allowed.has("oc_ops"), false);
  assert.equal(t.groups.of("oc_ops").proactive, false, "停用的群不看卡片");
  assert.match(text(t.cards.get(card)), /已停用「运营群」/);
  assert.match(text(t.sent.at(-1)!.card), /停用了「运营群」/);

  await t.say("配置");
  assert.match(text(t.sent.at(-1)!.card), /还没开通的群.*运营群/);

  await t.say("配置 运营群");
  const reopen = t.sent.at(-1)!.messageId;
  assert.match(text(t.cards.get(reopen)), /开通「运营群」.*下面是这个群原来的设置/);
  assert.equal(initial(t.cards.get(reopen), "proactive"), "on");
  await t.click(reopen, "next", "ou_owner", { ...keepAll, proactive: "on" });
  await t.click(reopen, "confirm", "ou_owner");
  assert.deepEqual(t.settings.override("oc_ops"), { proactive: true }, "开通这一项回到照服务器白名单");
  assert.equal(t.groups.allowed.has("oc_ops"), true);
  assert.equal(t.groups.of("oc_ops").proactive, true);
});

test("列不出机器人在哪些群（没开权限）：总览上说明；说「配置 群的编号」也能开通；不是管理员的人不能停用", async () => {
  const t = await setup({ chats: async () => Promise.reject(new Error("没有权限")) });
  await t.say("配置");
  assert.match(text(t.sent[0]!.card), /列不出机器人还在哪些群里（要给应用开「获取群组信息」权限），也可以说「配置 群的编号」开通/);

  await t.say("配置 oc_far");
  const card = t.sent[1]!.messageId;
  assert.match(text(t.cards.get(card)), /开通「oc_far」/);
  // 全部照服务器上的配置：不收紧，但还是开通
  await t.click(card, "reset", "ou_owner");
  const review = text(t.cards.get(card));
  assert.match(review, /开通\*\*：没开通（在群里不回话） → 已开通（在群里回话）/);
  assert.doesNotMatch(review, /代码仓库\*\*/);
  await t.click(card, "confirm", "ou_owner");
  assert.deepEqual(t.settings.override("oc_far"), { enabled: true });
  assert.equal(t.groups.allowed.has("oc_far"), true);

  await t.say("配置 oc_far", "ou_x");
  const other = t.sent.at(-1)!.messageId;
  await t.click(other, "disable", "ou_x");
  assert.match(text(t.cards.get(other)), /只有管理员能改设置/);
  assert.equal(t.groups.allowed.has("oc_far"), true);
});
