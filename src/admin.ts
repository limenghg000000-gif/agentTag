import { randomUUID } from "node:crypto";
import type { CardActionEvent, NormalizedMessage, SendInput, SendOptions, SendResult } from "@larksuiteoapi/node-sdk";
import type { ChatDirectory } from "./feishu.js";
import type { GroupPolicies, GroupPolicy } from "./groups.js";
import type { Logger } from "./history.js";
import { escapeCardMarkdown } from "./markdown.js";
import { clickerName, type NameLookup } from "./operator-names.js";
import { ADMINS_TARGET, type GroupOverride, type GroupSettings, type McpOverride, type SettingsChange } from "./settings.js";

/** 管理群设置卡片上按钮回传的 action */
export const SETTINGS_ACTION = "group-settings";
/** 设置卡片多久以后点了不算（和 Claude Tag 的确认卡片一样 30 分钟） */
export const SETTINGS_TTL_MS = 30 * 60_000;
/** 「配置」「配置 运营群」「配置 管理员」，说「设置」也行 */
const COMMAND = /^\s*群?(?:配置|设置)(?:\s+(.+?))?\s*$/s;
const ADMINS_QUERY = /^管理员(?:名单)?$/;
/** 总览卡片上开通了的、还没开通的群各最多列几个，再多的说「配置 群名」打开 */
const MAX_LISTED = 20;
/** 找机器人在哪些群时最多翻多少个 */
const MAX_CHATS = 500;
/** 从群成员里选人时最多列多少人（名单里已经有的另外算）。卡片上两个选人框各列一遍，飞书卡片最大 30 KB */
const MAX_MEMBERS = 100;
/** 卡片超过这么大时日志里警告一句（飞书卡片最大 30 KB，超了发不出去） */
const CARD_WARN_BYTES = 28_000;
/** 同时开着的设置卡片最多多少张，多了先丢最早的 */
const MAX_SESSIONS = 50;
/** 下拉框选项上「现在：…」最多多少字 */
const OPTION_CHARS = 60;
const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
const OPEN_IDS = /ou_[A-Za-z0-9_-]+/g;
const CHAT_ID = /^oc_[A-Za-z0-9_-]+$/;

const HINT =
  "这里是管理群：@ 我说「配置」看各群的设置、改设置、开通新群，「配置 群名」直接打开那个群，「配置 管理员」看管理员名单。别的问题请到各群里问我。";
const EXPIRED = "这张卡片已经失效（机器人重启过，或者已经处理完了）。在管理群里 @ 我说「配置」重新打开";

export interface AdminDeskOptions {
  /**
   * 管理群的 chat_id（可以有几个）：只在这些群里回设置卡片、认卡片上的按钮。
   * 卡片发在说「配置」的那个群里，改好的通知也只发在那个群里（不吵别的管理群），各群都记进改动记录
   */
  chatIds: ReadonlySet<string>;
  /** 所有者（.env 里的 CONFIG_OWNERS）：能改各群的设置，也能加减管理员 */
  owners: ReadonlySet<string>;
  settings: GroupSettings;
  /** 各群的配置；allowed 是现在开通的群（服务器白名单加上卡片上开通的、去掉停用的），存了以后 refresh */
  groups: Pick<GroupPolicies, "of" | "preview" | "carded" | "allowed" | "onServer" | "refresh">;
  /** 卡片上能勾的仓库：服务器上接入了的仓库和 group/* 通配。没开代码工具时为空，卡片上不显示这一项 */
  repos: () => readonly string[];
  /** 配了的 MCP 服务 */
  mcpServers: readonly string[];
  /** 这个 MCP 服务全局开给模型的工具（卡片上能勾的）；还没连上、不知道有哪些时返回 undefined */
  mcpTools: (server: string) => readonly string[] | undefined;
  /** 全局开着团队经验库。关着时卡片上不显示这一项 */
  knowledge: boolean;
  /** 群名、群成员、机器人在哪些群。不传、或者没开权限时，卡片上写群的编号、只能从名单里已经有的人里减、列不出还没开通的群 */
  directory?: ChatDirectory;
  send: (to: string, input: SendInput, opts?: SendOptions) => Promise<SendResult>;
  updateCard: (messageId: string, card: object) => Promise<void>;
  /** 卡片回调里没有点的人的名字：用它找。找不到写「有人」 */
  nameOf?: NameLookup;
  /** 存好了一个群的新设置（经验库表格按新名单调整共享）。开通了的群已经算进 groups.allowed */
  onSaved?: (chatId: string) => void;
  logger?: Logger;
  now?: () => number;
}

interface Person {
  openId: string;
  name?: string;
}

interface BaseSession {
  id: string;
  /** 卡片发在哪个管理群：只认这个群里点的，改好的通知也发在这里 */
  home: string;
  createdAt: number;
  /** 卡片消息；发出去以后才有 */
  cardMessageId?: string;
  /** 说「配置」的人 */
  opener: Person;
  /** 每画一次加一，按钮上带着它：点的是没刷新的旧卡片时认得出来，同一个按钮再点一次飞书 SDK 也不会当成重复的丢掉 */
  rev: number;
  /** 卡片上额外的一句：不是管理员点了、哪里填得不对、刚被别人改过 */
  note?: string;
}

/** 总览：列出开通了的群和各自现在的设置，再列机器人在、还没开通的群 */
interface ListSession extends BaseSession {
  kind: "list";
  chatIds: string[];
  /** 机器人在、还没开通的群 */
  pending: string[];
  /** 列不出还没开通的群时的说明 */
  pendingNote?: string;
  /** 卡片最上面的一句，比如「没找到叫 X 的群」 */
  intro?: string;
}

/**
 * 一个群的设置：先在表单里改（form），点「下一步」核对改前改后（review），点「确认」才存。
 * 还没开通的群打开就是开通：表单上的设置先收紧，确认后开通；开通了的群可以点「停用这个群」
 */
interface GroupSession extends BaseSession {
  kind: "group";
  chatId: string;
  name: string;
  /** 打开卡片时这个群的设置改过几次：确认时还是这个数才存，这期间别人改过的不覆盖 */
  version: number;
  /** 表单上现在的选择（这个群卡片上单独定的项）。表单上一直是开通的，点「停用这个群」时才换成停用去核对 */
  draft: GroupOverride;
  /** 能选的人：这个群的成员，加上名单里已经有的 */
  people: string[];
  /** 读不到群成员时的说明 */
  peopleNote?: string;
  view: "form" | "review";
  changes: SettingsChange[];
}

/** 管理员名单：只有所有者能加减 */
interface AdminsSession extends BaseSession {
  kind: "admins";
  version: number;
  draft: string[];
  /** 能选的人：各个管理群的成员，加上已经是管理员的 */
  people: string[];
  peopleNote?: string;
  view: "form" | "review";
  changes: SettingsChange[];
}

type Session = ListSession | GroupSession | AdminsSession;

/** 卡片上一项的设置：raw 用来比较改没改，text 是给人看的（里面的 open_id 在卡片上显示成名字） */
interface Item {
  raw: string;
  text: string;
  /** 是一份名单时的人，前后都是名单的写出加了谁、去掉了谁 */
  people?: readonly string[];
}

interface ActionValue {
  action?: unknown;
  card?: unknown;
  op?: unknown;
  r?: unknown;
  chat?: unknown;
}

/**
 * 管理群里改各群的配置：管理员 @ 机器人说「配置」，程序（不经过模型）回一张设置卡片，选好、核对、点「确认」才存进 GroupSettings，
 * 下一条消息起生效，管理群里再发一条谁改了什么。
 * 只认管理群里的消息和按钮；点按钮的人按飞书给的身份核对：所有者（.env）和管理员能改各群，只有所有者能加减管理员，其他人只能看。
 * 卡片内容存在内存里（按钮只回传卡片编号，表单里的值逐项核对），机器人重启后旧卡片点了提示失效
 */
export class AdminDesk {
  private readonly sessions = new Map<string, Session>();
  private readonly chatNames = new Map<string, string>();
  private readonly logger: Logger;
  private readonly now: () => number;
  private directoryWarned = false;

  constructor(private readonly opts: AdminDeskOptions) {
    this.logger = opts.logger ?? console;
    this.now = opts.now ?? Date.now;
  }

  /** 能改各群设置的人：所有者和管理员 */
  isAdmin(openId: string): boolean {
    return this.opts.owners.has(openId) || this.opts.settings.admins().has(openId);
  }

  /**
   * 管理群里 @ 机器人的消息：「配置」回设置卡片；管理群不在白名单里时，别的话回一句这里能做什么。
   * 不是管理群的、没 @ 的，和管理群也在白名单里时的别的话，返回 false，照常处理
   */
  async handleMessage(msg: NormalizedMessage): Promise<boolean> {
    if (!this.opts.chatIds.has(msg.chatId) || !msg.mentionedBot) {
      return false;
    }
    const match = COMMAND.exec(msg.content);
    if (!match) {
      if (this.opts.groups.allowed.has(msg.chatId)) {
        return false;
      }
      await this.opts.send(msg.chatId, { markdown: HINT }, { replyTo: msg.messageId }).catch((err: unknown) => this.logger.warn("管理群：回怎么用失败", err));
      return true;
    }
    const opener = person(msg.senderId, msg.senderName);
    const query = match[1]?.trim();
    this.logger.info(`管理群：${opener.openId} 说了「配置${query ? ` ${query}` : ""}」`);
    try {
      await this.publish(await this.open(msg.chatId, query, opener), msg.messageId);
    } catch (err) {
      await this.unsent(err, msg.chatId, msg.messageId);
    }
    return true;
  }

  /** 设置卡片没发出去：记日志，管理群里回一句，免得点了、说了以后什么都没有 */
  private async unsent(err: unknown, home: string, replyTo: string | undefined): Promise<void> {
    this.logger.error("管理群：设置卡片没发出去", err);
    const reason = describe(err).replace(/\s+/g, " ").slice(0, 200);
    await this.opts
      .send(home, { markdown: `设置卡片没发出去（${reason}），设置没改。请稍后再试，还不行就把这句话发给维护机器人的人。` }, replyTo ? { replyTo } : undefined)
      .catch((sendErr: unknown) => this.logger.warn("管理群：回卡片没发出去失败", sendErr));
  }

  /** 处理设置卡片上的按钮。不是设置卡片返回 false；别的群里点的不理 */
  async handleCardAction(evt: CardActionEvent): Promise<boolean> {
    const value = evt.action.value as ActionValue | undefined;
    if (value?.action !== SETTINGS_ACTION || typeof value.op !== "string") {
      return false;
    }
    if (!this.opts.chatIds.has(evt.chatId)) {
      return true;
    }
    const session = typeof value.card === "string" ? this.sessions.get(value.card) : undefined;
    if (!session || session.home !== evt.chatId || (session.cardMessageId && session.cardMessageId !== evt.messageId)) {
      this.logger.info(`管理群：设置卡片已失效 card=${String(value.card)} operator=${evt.operator.openId}`);
      await this.update(evt.messageId, closedCard("已失效", EXPIRED, "grey"));
      return true;
    }
    session.cardMessageId ??= evt.messageId;
    if (this.now() - session.createdAt > SETTINGS_TTL_MS) {
      this.sessions.delete(session.id);
      await this.update(evt.messageId, closedCard("已失效", "这张卡片超过 30 分钟，已经失效。在管理群里 @ 我说「配置」重新打开", "grey"));
      return true;
    }
    // 卡片上要写是谁点的：回调里一般没有名字，去找（找不到写「有人」）
    const operator = person(evt.operator.openId, await clickerName(evt, session.opener, this.opts.nameOf));
    const current = value.r === String(session.rev);
    const form = formValue(evt);
    if (session.kind === "list") {
      await this.onList(session, value, operator);
    } else if (session.kind === "group") {
      await this.onGroup(session, value.op, current, operator, form);
    } else {
      await this.onAdmins(session, value.op, current, operator, form);
    }
    return true;
  }

  /**
   * 「配置」后面跟的：没有是总览，「管理员」是管理员名单，群名（或 chat_id、GROUPS 里的名字）对上一个就直接打开那个群，
   * 还没开通的群打开就是开通
   */
  private async open(home: string, query: string | undefined, opener: Person): Promise<Session> {
    if (query && ADMINS_QUERY.test(query)) {
      return this.adminsSession(home, opener);
    }
    if (!query) {
      return this.listSession(home, opener);
    }
    // 直接写 chat_id 的，机器人列不出来的群（没开权限）也能开通
    if (CHAT_ID.test(query) && !this.opts.chatIds.has(query)) {
      return this.groupSession(home, query, opener);
    }
    const pending = await this.pending();
    const found = await this.find(query, [...this.opts.groups.allowed, ...pending.chatIds]);
    if (found.length === 1) {
      return this.groupSession(home, found[0]!, opener);
    }
    return found.length > 1
      ? this.listSession(home, opener, `有 ${found.length} 个群对得上「${query}」，点要改的那个`, found, pending)
      : this.listSession(home, opener, `没找到叫「${query}」的群，下面是机器人在的所有群`, undefined, pending);
  }

  private async find(query: string, chatIds: readonly string[]): Promise<string[]> {
    const q = query.toLowerCase();
    if (chatIds.includes(query)) {
      return [query];
    }
    // 还没开通的群名列群的时候已经拿到了，不再一个个去问（可能有几百个）
    const nameOf = (chatId: string) => (this.opts.groups.allowed.has(chatId) ? this.chatName(chatId) : this.chatNames.get(chatId) ?? "");
    const named = await Promise.all(chatIds.map(async (chatId) => ({ chatId, names: [await nameOf(chatId), this.opts.groups.of(chatId).name ?? ""] })));
    const exact = named.filter(({ names }) => names.some((name) => name.toLowerCase() === q));
    if (exact.length > 0) {
      return exact.map(({ chatId }) => chatId);
    }
    return named.filter(({ names }) => names.some((name) => name && name.toLowerCase().includes(q))).map(({ chatId }) => chatId);
  }

  /** 总览：only 给了时只列这几个群（对得上名字的）；known 是刚列过的还没开通的群 */
  private async listSession(home: string, opener: Person, intro?: string, only?: readonly string[], known?: { chatIds: string[]; note?: string }): Promise<ListSession> {
    const pending = known ?? (await this.pending());
    const pick = (list: readonly string[]) => (only ? list.filter((chatId) => only.includes(chatId)) : [...list]);
    const chatIds = pick([...this.opts.groups.allowed]);
    const waiting = pick(pending.chatIds);
    // 先把群名找好，画卡片时直接用
    await Promise.all(chatIds.slice(0, MAX_LISTED).map((chatId) => this.chatName(chatId)));
    return {
      kind: "list",
      id: randomUUID(),
      home,
      createdAt: this.now(),
      opener,
      rev: 0,
      chatIds,
      pending: waiting,
      ...(pending.note && !only ? { pendingNote: pending.note } : {}),
      ...(intro ? { intro } : {}),
    };
  }

  /** 机器人在、还没开通的群（管理群不算）。列不出来（没开权限）时没有，附一句说明 */
  private async pending(): Promise<{ chatIds: string[]; note?: string }> {
    const howTo = "也可以说「配置 群的编号」开通（群的编号是 oc_ 开头的那串，有人在那个群里 @ 机器人时服务器日志里会打出来）";
    if (!this.opts.directory) {
      return { chatIds: [], note: `列不出机器人还在哪些群里，${howTo}` };
    }
    try {
      const chats = await this.opts.directory.chats(MAX_CHATS);
      for (const chat of chats) {
        if (chat.name) {
          this.chatNames.set(chat.chatId, chat.name);
        }
      }
      return { chatIds: chats.map((chat) => chat.chatId).filter((chatId) => !this.opts.chatIds.has(chatId) && !this.opts.groups.allowed.has(chatId)) };
    } catch (err) {
      if (!this.directoryWarned) {
        this.directoryWarned = true;
        this.logger.warn("管理群：列不出机器人在哪些群（要 im:chat:readonly 权限），总览卡片上不列还没开通的群", err);
      }
      return { chatIds: [], note: `列不出机器人还在哪些群里（要给应用开「获取群组信息」权限），${howTo}` };
    }
  }

  private async groupSession(home: string, chatId: string, opener: Person): Promise<GroupSession> {
    // 版本号和表单要同一时刻取：下面读群成员、群名要等，这期间别人存了的话，旧表单配上新版本号确认时就会盖掉别人的改动
    const version = this.opts.settings.version(chatId);
    const draft = this.formDraft(chatId);
    const { people, note } = await this.members([chatId], this.listed(chatId, draft), "这个群");
    return {
      kind: "group",
      id: randomUUID(),
      home,
      createdAt: this.now(),
      opener,
      rev: 0,
      chatId,
      name: await this.chatName(chatId),
      version,
      draft,
      people,
      ...(note ? { peopleNote: note } : {}),
      view: "form",
      changes: [],
    };
  }

  private async adminsSession(home: string, opener: Person): Promise<AdminsSession> {
    // 同 groupSession：版本号和名单在等群成员之前一起取
    const version = this.opts.settings.version(ADMINS_TARGET);
    const draft = [...this.opts.settings.admins()];
    const { people, note } = await this.members([...this.opts.chatIds], draft, "管理群");
    return {
      kind: "admins",
      id: randomUUID(),
      home,
      createdAt: this.now(),
      opener,
      rev: 0,
      version,
      draft,
      people: people.filter((openId) => !this.opts.owners.has(openId)),
      ...(note ? { peopleNote: note } : {}),
      view: "form",
      changes: [],
    };
  }

  /**
   * 名单里已经有的人：卡片上定的，加上照服务器上的配置现在用的（.env 里这个群的或全局的）。
   * 读不到群成员、群里人多没列全时，这些人也要能选，才能从现在的名单里减人
   */
  private listed(chatId: string, draft: GroupOverride): string[] {
    const base = this.opts.groups.of(chatId, { card: false });
    return unique([...(draft.writeAllowed ?? []), ...(draft.memoryEditors ?? []), ...(base.writeAllowed ?? []), ...(base.memoryEditors ?? [])]);
  }

  /** 能选的人：这几个群的成员（管理员名单是各个管理群的）加上名单里已经有的。读不到群成员时只有名单里的人，附一句说明 */
  private async members(chatIds: readonly string[], listed: readonly string[], where: string): Promise<{ people: string[]; note?: string }> {
    let note: string | undefined;
    let members: string[] = [];
    if (!this.opts.directory) {
      note = `读不到${where}的成员，只能从名单里已经有的人里减，加不了人`;
    } else {
      // 一个群一个群读：其中一个读不到（机器人被移出了自测的管理群这类），别的群的人照样能选
      let failed = 0;
      for (const chatId of chatIds) {
        try {
          members.push(...(await this.opts.directory.members(chatId, MAX_MEMBERS + 1)).map((member) => member.openId));
        } catch (err) {
          failed++;
          if (!this.directoryWarned) {
            this.directoryWarned = true;
            this.logger.warn("管理群：读不到群成员（要 im:chat.members:read 权限，机器人要在群里），设置卡片上只能从读得到的群成员和名单里已有的人里选", err);
          }
        }
      }
      members = unique(members);
      if (failed === chatIds.length) {
        note = `读不到${where}的成员（要给应用开「获取群组成员」权限），只能从名单里已经有的人里减，加不了人`;
      } else if (members.length > MAX_MEMBERS) {
        members = members.slice(0, MAX_MEMBERS);
        note = `${where}人多，只列了前 ${MAX_MEMBERS} 人`;
      } else if (failed > 0) {
        note = `有 ${failed} 个${where}读不到成员（机器人还在不在那个群里？），只列了读得到的`;
      }
    }
    return { people: unique([...members, ...listed]), ...(note ? { note } : {}) };
  }

  private async chatName(chatId: string): Promise<string> {
    const known = this.chatNames.get(chatId);
    if (known) {
      return known;
    }
    const name = await this.opts.directory?.chatName(chatId).catch((err: unknown) => {
      if (!this.directoryWarned) {
        this.directoryWarned = true;
        this.logger.warn("管理群：读不到群名（要 im:chat:readonly 权限，机器人要在群里），设置卡片上写群的编号", err);
      }
      return undefined;
    });
    if (name) {
      this.chatNames.set(chatId, name);
      return name;
    }
    return this.opts.groups.of(chatId).name ?? chatId;
  }

  private async onList(session: ListSession, value: ActionValue, operator: Person): Promise<void> {
    let next: Promise<Session> | undefined;
    if (value.op === "open" && typeof value.chat === "string" && (session.chatIds.includes(value.chat) || session.pending.includes(value.chat))) {
      next = this.groupSession(session.home, value.chat, operator);
    } else if (value.op === "admins") {
      next = this.adminsSession(session.home, operator);
    }
    if (!next) {
      return;
    }
    // 换个编号重画：同一个按钮还能再点（飞书 SDK 按按钮内容去重），顺带刷新各群现在的设置
    await this.render(session);
    // 读群成员要一会儿，放到后台：这张卡片先换好
    void next
      .then((opened) => this.publish(opened, session.cardMessageId))
      .catch((err: unknown) => this.unsent(err, session.home, session.cardMessageId));
  }

  private async onGroup(session: GroupSession, op: string, current: boolean, operator: Person, form: Record<string, unknown> | undefined): Promise<void> {
    const who = operator.name ?? "有人";
    if (op === "cancel") {
      if (!this.isAdmin(operator.openId) && operator.openId !== session.opener.openId) {
        session.note = `${who}点了取消：只有管理员或打开卡片的人能取消`;
        return this.render(session);
      }
      this.sessions.delete(session.id);
      this.logger.info(`管理群：${operator.openId} 取消了群 ${session.chatId} 的设置卡片`);
      return this.update(session.cardMessageId!, closedCard(`${session.name} 的设置`, `${escapeCardMarkdown(who)}取消了，设置没改`, "grey"));
    }
    if (!this.isAdmin(operator.openId)) {
      session.note = `${who}点了按钮：只有管理员能改设置，其他人只能看。管理员名单在管理群里说「配置 管理员」看`;
      this.logger.info(`管理群：${operator.openId} 不是管理员，点了群 ${session.chatId} 的设置卡片，没改`);
      return this.render(session);
    }
    if (this.opts.settings.version(session.chatId) !== session.version) {
      this.reloadGroup(session);
      session.note = `打开这张卡片以后有人改过「${session.name}」的设置，${who}这次点的没有保存。下面已经换成最新的设置，请重新改一遍`;
      return this.render(session);
    }
    if (op === "next" || op === "reset" || op === "disable") {
      if (session.view !== "form") {
        session.note = `${who}点的是旧卡片：卡片已经换成核对改动了，请看一眼再点`;
        return this.render(session);
      }
      if (op === "next") {
        if (!form) {
          session.note = "没读到卡片上选的内容，请再点一次「下一步」";
          return this.render(session);
        }
        const { draft, errors } = this.parseGroupForm(session, form);
        // 填对了的先记下，免得重画表单时丢掉
        session.draft = draft;
        if (errors.length > 0) {
          session.note = `${who}点了下一步，有几处不对，没往下走：\n${errors.map((error) => `- ${error}`).join("\n")}`;
          return this.render(session);
        }
      } else if (op === "reset") {
        // 开通、停用不算在「全部照服务器上的配置」里：表单上一直是开通的
        session.draft = {};
        this.setEnabled(session.chatId, session.draft, true);
      } else {
        if (!this.opts.groups.allowed.has(session.chatId)) {
          session.note = `${who}点了停用：这个群本来就没开通`;
          return this.render(session);
        }
        // 停用只改开通这一项：表单上没确认的改动不算，其余的项照存着的留下，再开通时照用
        session.draft = structuredClone(this.opts.settings.override(session.chatId) ?? {});
        this.setEnabled(session.chatId, session.draft, false);
      }
      const changes = this.groupChanges(session.chatId, this.opts.settings.override(session.chatId) ?? {}, session.draft);
      if (changes.length === 0) {
        session.note = op === "reset" ? "这个群本来就全照服务器上的配置，没有要改的" : `${who}点了下一步：和现在的设置一样，没有要改的`;
        return this.render(session);
      }
      session.changes = changes;
      session.view = "review";
      session.note = undefined;
      return this.render(session);
    }
    if (op === "edit") {
      // 从停用的核对返回：表单上还是开通的，其余的项照存着的
      if (!this.on(session.chatId, session.draft)) {
        session.draft = this.formDraft(session.chatId);
      }
      session.view = "form";
      session.note = undefined;
      return this.render(session);
    }
    if (op !== "confirm") {
      return;
    }
    if (session.view !== "review" || !current) {
      session.note = `${who}点确认的时候卡片上的改动刚被换过，这次没有保存。请核对下面的改动再点「确认」`;
      return this.render(session);
    }
    const wasOn = this.opts.groups.allowed.has(session.chatId);
    const nowOn = this.on(session.chatId, session.draft);
    let result: "saved" | "stale";
    try {
      result = await this.opts.settings.saveGroup(session.chatId, session.draft, session.version, {
        by: operator.openId,
        ...(operator.name ? { byName: operator.name } : {}),
        targetName: session.name,
        changes: session.changes,
      });
    } catch (err) {
      this.logger.error(`管理群：群 ${session.chatId} 的设置没存上`, err);
      session.note = `没存上（${describe(err)}），设置没改，原来的照用。可以再点一次「确认」`;
      return this.render(session);
    }
    if (result === "stale") {
      this.reloadGroup(session);
      session.note = `打开这张卡片以后有人改过「${session.name}」的设置，${who}这次点的没有保存。下面已经换成最新的设置，请重新改一遍`;
      return this.render(session);
    }
    this.sessions.delete(session.id);
    // 开通、停用马上算进各处收不收这个群的消息
    this.opts.groups.refresh();
    this.logger.info(
      `管理群：${operator.openId} 改了群 ${session.chatId} 的设置：${session.changes.map((change) => `${change.field} ${change.before} → ${change.after}`).join("；")}`,
    );
    this.opts.onSaved?.(session.chatId);
    const name = escapeCardMarkdown(session.name);
    const [title, done, notice] = !nowOn
      ? [`已停用「${session.name}」`, "机器人从下一条消息起不在这个群里回话（群记忆、定时任务都留着，定时任务到点不跑；再开通照用）", `停用了「${name}」`]
      : !wasOn
        ? [`已开通「${session.name}」`, "机器人从下一条消息起在这个群里回话，按下面的设置", `开通了「${name}」`]
        : [`${session.name} 的设置已保存`, "下一条消息起生效", `改了「${name}」的设置`];
    const after = nowOn ? `\n\n${grey(`改完以后：${this.summary(this.opts.groups.of(session.chatId))}`)}` : "";
    await this.update(session.cardMessageId!, closedCard(title, `${personTag(operator.openId)} 点了确认，${done}：\n${changeLines(session.changes)}${after}`, "green"));
    await this.notify(
      session.home,
      nowOn && wasOn ? `${session.name} 的设置改了` : title,
      `${personTag(operator.openId)} ${notice}，${done}：\n${changeLines(session.changes)}`,
      session.cardMessageId,
    );
  }

  /** 按这份设置这个群开不开通 */
  private on(chatId: string, override: GroupOverride): boolean {
    return override.enabled ?? this.opts.groups.onServer(chatId);
  }

  private async onAdmins(session: AdminsSession, op: string, current: boolean, operator: Person, form: Record<string, unknown> | undefined): Promise<void> {
    const who = operator.name ?? "有人";
    if (op === "cancel") {
      if (!this.isAdmin(operator.openId) && operator.openId !== session.opener.openId) {
        session.note = `${who}点了取消：只有管理员或打开卡片的人能取消`;
        return this.render(session);
      }
      this.sessions.delete(session.id);
      return this.update(session.cardMessageId!, closedCard("管理员名单", `${escapeCardMarkdown(who)}取消了，管理员名单没改`, "grey"));
    }
    if (!this.opts.owners.has(operator.openId)) {
      session.note = `${who}点了按钮：只有所有者（写在服务器配置里的那几位）能加减管理员`;
      this.logger.info(`管理群：${operator.openId} 不是所有者，点了管理员名单卡片，没改`);
      return this.render(session);
    }
    if (this.opts.settings.version(ADMINS_TARGET) !== session.version) {
      this.reloadAdmins(session);
      session.note = `打开这张卡片以后有人改过管理员名单，${who}这次点的没有保存。下面已经换成最新的名单，请重新改一遍`;
      return this.render(session);
    }
    if (op === "next") {
      if (session.view !== "form") {
        session.note = `${who}点的是旧卡片：卡片已经换成核对改动了，请看一眼再点`;
        return this.render(session);
      }
      if (!form) {
        session.note = "没读到卡片上选的内容，请再点一次「下一步」";
        return this.render(session);
      }
      const picked = strings(form.admins);
      // 所有者本来就能改，选上了也不进管理员名单
      if (!picked.every((openId) => OPEN_ID.test(openId) && (session.people.includes(openId) || this.opts.owners.has(openId)))) {
        session.note = `${who}点了下一步：选的人不在管理群里，没往下走。要加的人请先拉进管理群，再重新打开卡片`;
        return this.render(session);
      }
      session.draft = unique(picked.filter((openId) => !this.opts.owners.has(openId)));
      const change = peopleChange("管理员", [...this.opts.settings.admins()], session.draft);
      if (!change) {
        session.note = `${who}点了下一步：和现在的名单一样，没有要改的`;
        return this.render(session);
      }
      session.changes = [change];
      session.view = "review";
      session.note = undefined;
      return this.render(session);
    }
    if (op === "edit") {
      session.view = "form";
      session.note = undefined;
      return this.render(session);
    }
    if (op !== "confirm") {
      return;
    }
    if (session.view !== "review" || !current) {
      session.note = `${who}点确认的时候卡片上的改动刚被换过，这次没有保存。请核对下面的改动再点「确认」`;
      return this.render(session);
    }
    let result: "saved" | "stale";
    try {
      result = await this.opts.settings.saveAdmins(session.draft, session.version, {
        by: operator.openId,
        ...(operator.name ? { byName: operator.name } : {}),
        targetName: "管理员名单",
        changes: session.changes,
      });
    } catch (err) {
      this.logger.error("管理群：管理员名单没存上", err);
      session.note = `没存上（${describe(err)}），名单没改。可以再点一次「确认」`;
      return this.render(session);
    }
    if (result === "stale") {
      this.reloadAdmins(session);
      session.note = `打开这张卡片以后有人改过管理员名单，${who}这次点的没有保存。下面已经换成最新的名单，请重新改一遍`;
      return this.render(session);
    }
    this.sessions.delete(session.id);
    this.logger.info(`管理群：${operator.openId} 改了管理员名单：${session.changes.map((change) => `${change.before} → ${change.after}`).join("；")}`);
    await this.update(session.cardMessageId!, closedCard("管理员名单已保存", `${personTag(operator.openId)} 点了确认，马上生效：\n${changeLines(session.changes)}`, "green"));
    await this.notify(session.home, "管理员名单改了", `${personTag(operator.openId)} 改了管理员名单：\n${changeLines(session.changes)}`, session.cardMessageId);
  }

  /**
   * 表单开始时的选择：卡片上存着的。还没开通的群表单上是开通它：在卡片上开通过又停用了的、服务器白名单里有的，照原来存着的；
   * 第一次开通的先收紧（不开代码仓库和 MCP 工具、谁都不能让它改），管理员在表单上放开
   */
  private formDraft(chatId: string): GroupOverride {
    const saved = this.opts.settings.override(chatId);
    const draft = structuredClone(saved ?? {});
    if (!this.opts.groups.allowed.has(chatId) && !saved && !this.opts.groups.onServer(chatId)) {
      const base = this.opts.groups.of(chatId, { card: false });
      if (base.codeRepos.length > 0) {
        draft.codeRepos = [];
      }
      draft.writeAllowed = [];
      if (base.mcp.size > 0) {
        draft.mcp = Object.fromEntries([...base.mcp.keys()].map((server) => [server, "off" as const]));
      }
    }
    this.setEnabled(chatId, draft, true);
    return draft;
  }

  /** 开通、停用：和服务器白名单一样时不写（照白名单），不一样才写 */
  private setEnabled(chatId: string, draft: GroupOverride, on: boolean): void {
    if (on === this.opts.groups.onServer(chatId)) {
      delete draft.enabled;
    } else {
      draft.enabled = on;
    }
  }

  private reloadGroup(session: GroupSession): void {
    session.version = this.opts.settings.version(session.chatId);
    session.draft = this.formDraft(session.chatId);
    session.people = unique([...session.people, ...this.listed(session.chatId, session.draft)]);
    session.view = "form";
    session.changes = [];
  }

  private reloadAdmins(session: AdminsSession): void {
    session.version = this.opts.settings.version(ADMINS_TARGET);
    session.draft = [...this.opts.settings.admins()];
    session.people = unique([...session.people, ...session.draft]);
    session.view = "form";
    session.changes = [];
  }

  /** 表单上填的逐项核对：只认卡片上给的选项，不对的项写进 errors、照原来的；卡片上没显示的项照原来的 */
  private parseGroupForm(session: GroupSession, form: Record<string, unknown>): { draft: GroupOverride; errors: string[] } {
    const draft = structuredClone(session.draft);
    const errors: string[] = [];
    const mode = (key: string) => (typeof form[key] === "string" ? (form[key] as string) : undefined);

    const repoOptions = this.opts.repos();
    const repos = mode("repos_mode");
    if (repoOptions.length > 0 && repos !== undefined) {
      if (repos === "env") {
        delete draft.codeRepos;
      } else if (repos === "set") {
        const picked = strings(form.repos).map((repo) => repoOptions.find((option) => option.toLowerCase() === repo.toLowerCase()));
        if (picked.some((repo) => repo === undefined)) {
          errors.push("代码仓库：勾的仓库有的服务器上没接入");
        } else {
          draft.codeRepos = unique(picked as string[]);
        }
      } else {
        errors.push("代码仓库：选项不对");
      }
    }

    for (const [key, field, label] of [
      ["writers", "writeAllowed", "写权限"],
      ["editors", "memoryEditors", "改群记忆"],
    ] as const) {
      const choice = mode(`${key}_mode`);
      if (choice === undefined) {
        continue;
      }
      if (choice === "env") {
        delete draft[field];
      } else if (choice === "none") {
        draft[field] = [];
      } else if (choice === "list") {
        const picked = strings(form[key]);
        if (!picked.every((openId) => OPEN_ID.test(openId) && session.people.includes(openId))) {
          errors.push(`${label}：选的人不在这个群里`);
        } else if (picked.length === 0) {
          errors.push(`${label}：选了「只有下面选的人」但一个人都没选；要谁都不能就选「谁都不能」`);
        } else {
          draft[field] = unique(picked);
        }
      } else {
        errors.push(`${label}：选项不对`);
      }
    }

    this.opts.mcpServers.forEach((server, i) => {
      const choice = mode(`mcp_${i}_mode`);
      if (choice === undefined) {
        return;
      }
      const mcp: Record<string, McpOverride> = { ...draft.mcp };
      const tools = this.opts.mcpTools(server);
      if (choice === "env") {
        delete mcp[server];
      } else if (choice === "all" || choice === "off") {
        mcp[server] = choice;
      } else if (choice === "list" && tools) {
        const picked = strings(form[`mcp_${i}_tools`]);
        if (!picked.every((tool) => tools.includes(tool))) {
          errors.push(`${server} 工具：勾的工具有的服务器上没开`);
        } else if (picked.length === 0) {
          errors.push(`${server} 工具：选了「只开下面勾的」但一个都没勾；要不开就选「不开」`);
        } else {
          mcp[server] = unique(picked);
        }
      } else if (choice === "list" && !Array.isArray(mcp[server])) {
        errors.push(`${server} 工具：还没连上，不知道有哪些工具，现在只能选全开或不开`);
      } else if (choice !== "list") {
        errors.push(`${server} 工具：选项不对`);
      }
      if (Object.keys(mcp).length > 0) {
        draft.mcp = mcp;
      } else {
        delete draft.mcp;
      }
    });

    for (const [key, field, label] of [
      ["knowledge", "knowledge", "团队经验库"],
      ["proactive", "proactive", "主动接话"],
    ] as const) {
      const choice = mode(key);
      if (choice === undefined || (key === "knowledge" && !this.opts.knowledge)) {
        continue;
      }
      if (choice === "env") {
        delete draft[field];
      } else if (choice === "on" || choice === "off") {
        draft[field] = choice === "on";
      } else {
        errors.push(`${label}：选项不对`);
      }
    }
    return { draft, errors };
  }

  /** 卡片上定的从 before 换成 after，每一项改前改后（没变的不列） */
  private groupChanges(chatId: string, before: GroupOverride, after: GroupOverride): SettingsChange[] {
    const base = this.opts.groups.of(chatId, { card: false });
    const was = this.items(chatId, before, base);
    const now = this.items(chatId, after, base);
    const changes: SettingsChange[] = [];
    for (const [field, item] of now) {
      const old = was.get(field);
      if (old?.raw === item.raw) {
        continue;
      }
      changes.push({ field, before: old?.text ?? "照服务器上的配置", after: item.text + delta(old?.people, item.people) });
    }
    return changes;
  }

  /** 一个群卡片上定的每一项，没定的写「照服务器上的配置（现在：…）」；开通写在最前面 */
  private items(chatId: string, override: GroupOverride, base: GroupPolicy): Map<string, Item> {
    const items = new Map<string, Item>();
    const env = (now: string): Item => ({ raw: "env", text: `照服务器上的配置（现在：${now}）` });
    const on = this.on(chatId, override);
    items.set("开通", { raw: String(on), text: on ? "已开通（在群里回话）" : "没开通（在群里不回话）" });
    if (this.opts.repos().length > 0 || override.codeRepos !== undefined) {
      const repos = override.codeRepos;
      items.set(
        "代码仓库",
        repos === undefined
          ? env(base.codeRepos.length > 0 ? base.codeRepos.join("、") : "不开")
          : { raw: sortedJson(repos), text: repos.length > 0 ? `只用 ${repos.join("、")}` : "不开代码工具" },
      );
    }
    const people = (list: readonly string[] | undefined, now: ReadonlySet<string> | undefined): Item =>
      list === undefined
        ? env(peopleText(now === undefined ? undefined : [...now]))
        : { raw: sortedJson(list), text: list.length > 0 ? `只有这 ${list.length} 人：${list.join("、")}` : "谁都不能", people: list };
    items.set("写权限", people(override.writeAllowed, base.writeAllowed));
    items.set("改群记忆", people(override.memoryEditors, base.memoryEditors));
    for (const server of unique([...this.opts.mcpServers, ...Object.keys(override.mcp ?? {})])) {
      const choice = override.mcp?.[server];
      items.set(
        `${server} 工具`,
        choice === undefined
          ? env(mcpText(base.mcp.get(server)))
          : {
              raw: typeof choice === "string" ? choice : sortedJson(choice),
              text: choice === "all" ? "全开（服务器上开了的全部）" : choice === "off" ? "不开" : `只开 ${choice.length} 个：${choice.join("、")}`,
            },
      );
    }
    if (this.opts.knowledge || override.knowledge !== undefined) {
      items.set("团队经验库", override.knowledge === undefined ? env(base.knowledge ? "用" : "不用") : { raw: String(override.knowledge), text: override.knowledge ? "用" : "不用" });
    }
    items.set("不 @ 也主动接话", override.proactive === undefined ? env(base.proactive ? "开" : "关") : { raw: String(override.proactive), text: override.proactive ? "开" : "关" });
    return items;
  }

  /** 一个群现在用的配置，一行说完（总览、改完以后） */
  private summary(policy: GroupPolicy): string {
    const parts: string[] = [];
    if (this.opts.repos().length > 0 || policy.codeRepos.length > 0) {
      parts.push(`仓库 ${policy.codeRepos.length > 0 ? clip(policy.codeRepos.join("、"), 80) : "不开"}`);
    }
    parts.push(`写权限 ${peopleCount(policy.writeAllowed)}`, `改群记忆 ${peopleCount(policy.memoryEditors)}`);
    for (const server of this.opts.mcpServers) {
      parts.push(`${server} ${mcpText(policy.mcp.get(server))}`);
    }
    if (this.opts.knowledge) {
      parts.push(`经验库 ${policy.knowledge ? "用" : "不用"}`);
    }
    parts.push(`主动接话 ${policy.proactive ? "开" : "关"}`);
    return parts.join("；");
  }

  /** 新卡片：记下、发出去（回复在 replyTo 下面） */
  private async publish(session: Session, replyTo?: string): Promise<void> {
    this.prune();
    this.sessions.set(session.id, session);
    try {
      const { messageId } = await this.opts.send(session.home, { card: this.card(session) }, replyTo ? { replyTo } : undefined);
      session.cardMessageId ??= messageId;
    } catch (err) {
      this.sessions.delete(session.id);
      throw err;
    }
  }

  /** 换个编号重画 */
  private async render(session: Session): Promise<void> {
    session.rev += 1;
    if (session.cardMessageId) {
      await this.update(session.cardMessageId, this.card(session));
    }
  }

  private async update(messageId: string, card: object): Promise<void> {
    try {
      await this.opts.updateCard(messageId, card);
      // 改好了也记一行：点了没看到变化时，分得清是没改上还是飞书那边没刷出来
      this.logger.info(`管理群：设置卡片改好了 card=${messageId}`);
    } catch (err) {
      this.logger.warn(`管理群：更新设置卡片失败 card=${messageId}`, err);
    }
  }

  /** 改的那个管理群里另发一条：谁改了什么（卡片更新了群里不提醒） */
  private async notify(home: string, title: string, body: string, replyTo: string | undefined): Promise<void> {
    await this.opts
      .send(home, { card: closedCard(title, body, "green") }, replyTo ? { replyTo } : undefined)
      .catch((err: unknown) => this.logger.warn("管理群：改动通知没发出去", err));
  }

  /** 去掉过期的卡片，太多时丢最早的 */
  private prune(): void {
    for (const [id, session] of this.sessions) {
      if (this.now() - session.createdAt > SETTINGS_TTL_MS) {
        this.sessions.delete(id);
      }
    }
    while (this.sessions.size >= MAX_SESSIONS) {
      this.sessions.delete(this.sessions.keys().next().value!);
    }
  }

  private card(session: Session): object {
    const card = session.kind === "list" ? this.listCard(session) : session.kind === "group" ? this.groupCard(session) : this.adminsCard(session);
    const bytes = Buffer.byteLength(JSON.stringify(card));
    if (bytes > CARD_WARN_BYTES) {
      this.logger.warn(`管理群：设置卡片有 ${bytes} 字节，快到飞书的上限（30 KB）了，可能发不出去`);
    }
    return card;
  }

  private listCard(session: ListSession): object {
    const shown = session.chatIds.slice(0, MAX_LISTED);
    const waiting = session.pending.slice(0, MAX_LISTED);
    const button = (text: string, op: string, extra: Record<string, string> = {}) =>
      actionButton(text, "default", { action: SETTINGS_ACTION, card: session.id, op, r: String(session.rev), ...extra });
    const elements: object[] = [
      ...(session.intro ? [markdown(`⚠️ ${escapeCardMarkdown(session.intro)}`)] : []),
      markdown(
        session.chatIds.length === 0
          ? "还没开通任何群。" + (session.pending.length > 0 ? "下面是机器人在、还没开通的群，点「开通」。" : "先把机器人拉进要用的群。") + "只有管理员能开通，其他人只能看。"
          : "点「改设置」打开一个群的设置，也可以直接说「配置 群名」。只有管理员能改，其他人只能看。",
      ),
      ...shown.map((chatId) =>
        row(
          [
            markdown(
              `**${escapeCardMarkdown(this.chatNames.get(chatId) ?? this.opts.groups.of(chatId).name ?? chatId)}**` +
                (this.opts.groups.carded(chatId) ? " <font color='orange'>卡片上改过</font>" : "") +
                `\n${grey(this.summary(this.opts.groups.of(chatId)))}`,
            ),
          ],
          [button("改设置", "open", { chat: chatId })],
        ),
      ),
      ...(session.chatIds.length > shown.length ? [markdown(grey(`还有 ${session.chatIds.length - shown.length} 个群没列出来，说「配置 群名」打开`))] : []),
      ...(session.pending.length > 0
        ? [
            markdown("**机器人在、还没开通的群**（不回话，开通后才回）"),
            ...waiting.map((chatId) => row([markdown(escapeCardMarkdown(this.chatNames.get(chatId) ?? chatId))], [button("开通", "open", { chat: chatId })])),
            ...(session.pending.length > waiting.length ? [markdown(grey(`还有 ${session.pending.length - waiting.length} 个没列出来，说「配置 群名」打开`))] : []),
          ]
        : []),
      ...(session.pendingNote ? [markdown(grey(session.pendingNote))] : []),
      row(
        [markdown(`**管理员**：所有者 ${this.opts.owners.size} 人，管理员 ${this.opts.settings.admins().size} 人`)],
        [button("管理员名单", "admins")],
      ),
      ...(session.note ? [markdown(`⚠️ ${escapeCardMarkdown(session.note)}`)] : []),
    ];
    return card("各群的设置", "blue", elements);
  }

  private groupCard(session: GroupSession): object {
    const value = (op: string) => ({ action: SETTINGS_ACTION, card: session.id, op, r: String(session.rev) });
    const note = session.note ? [markdown(`⚠️ ${richText(session.note)}`)] : [];
    const enabled = this.opts.groups.allowed.has(session.chatId);
    if (session.view === "review") {
      const on = this.on(session.chatId, session.draft);
      const after = on ? this.summary(this.opts.groups.preview(session.chatId, session.draft)) : "机器人在这个群里不回话，其余的设置留着，再开通照用";
      return card(!on ? `核对：停用「${session.name}」` : enabled ? `核对「${session.name}」的改动` : `核对：开通「${session.name}」`, !on ? "red" : "orange", [
        markdown(`要改的（点「确认」才生效）：\n${changeLines(session.changes)}`),
        markdown(grey(`改完以后：${after}`)),
        ...note,
        buttons([actionButton("确认", "primary", value("confirm")), actionButton("返回修改", "default", value("edit")), actionButton("取消", "default", value("cancel"))]),
      ]);
    }
    const base = this.opts.groups.of(session.chatId, { card: false });
    const draft = session.draft;
    const fields: object[] = [];

    const repoOptions = this.opts.repos();
    if (repoOptions.length > 0) {
      const chosen = (draft.codeRepos ?? []).map((repo) => repoOptions.find((option) => option.toLowerCase() === repo.toLowerCase()));
      const missing = (draft.codeRepos ?? []).filter((_, i) => chosen[i] === undefined);
      fields.push(
        label("代码仓库", "能查、能改哪些仓库" + (missing.length > 0 ? `。原来勾的 ${missing.join("、")} 服务器上没接入了` : "")),
        select("repos_mode", draft.codeRepos === undefined ? "env" : "set", [
          ["env", `照服务器上的配置（现在：${base.codeRepos.length > 0 ? base.codeRepos.join("、") : "不开"}）`],
          ["set", "只用下面勾的（一个不勾就是不开代码工具）"],
        ]),
        multiSelect("repos", repoOptions, chosen.filter((repo): repo is string => repo !== undefined), "勾仓库"),
      );
    }

    for (const [key, field, title, desc] of [
      ["writers", "writeAllowed", "写权限", "谁能让它改文档、改代码、点经验库的「保存」"],
      ["editors", "memoryEditors", "改群记忆", "谁能让它记、改、删群记忆"],
    ] as const) {
      const list = draft[field];
      const now = base[field];
      const canPick = session.people.length > 0;
      fields.push(
        label(title, desc),
        select(`${key}_mode`, list === undefined ? "env" : list.length === 0 ? "none" : "list", [
          ["env", `照服务器上的配置（现在：${peopleCount(now)}）`],
          ...(canPick || (list?.length ?? 0) > 0 ? [["list", "只有下面选的人"] as [string, string]] : []),
          ["none", "谁都不能"],
        ]),
        // 照服务器上的配置时先勾上现在的名单：改成「只有下面选的人」时在它上面减人就行
        ...(canPick ? [personSelect(key, session.people, (list ?? [...(now ?? [])]).filter((openId) => session.people.includes(openId)))] : []),
      );
    }
    if (session.peopleNote) {
      fields.push(markdown(grey(session.peopleNote)));
    }

    this.opts.mcpServers.forEach((server, i) => {
      const choice = draft.mcp?.[server];
      const tools = this.opts.mcpTools(server);
      fields.push(
        label(`${server} 工具`, tools ? `服务器上开了 ${tools.length} 个，只能在这些里挑` : "还没连上，不知道有哪些工具，现在只能选全开或不开"),
        select(`mcp_${i}_mode`, choice === undefined ? "env" : Array.isArray(choice) ? "list" : choice, [
          ["env", `照服务器上的配置（现在：${mcpText(base.mcp.get(server))}）`],
          ["all", "全开（服务器上开了的全部）"],
          ...(tools || Array.isArray(choice) ? [["list", tools ? "只开下面勾的" : `只开原来勾的 ${(choice as string[]).length} 个`] as [string, string]] : []),
          ["off", "不开"],
        ]),
        ...(tools && tools.length > 0 ? [multiSelect(`mcp_${i}_tools`, tools, Array.isArray(choice) ? choice.filter((tool) => tools.includes(tool)) : [], "勾工具")] : []),
      );
    });

    if (this.opts.knowledge) {
      fields.push(
        label("团队经验库", "回答前查经验库、能沉淀经验"),
        select("knowledge", draft.knowledge === undefined ? "env" : draft.knowledge ? "on" : "off", [
          ["env", `照服务器上的配置（现在：${base.knowledge ? "用" : "不用"}）`],
          ["on", "用"],
          ["off", "不用"],
        ]),
      );
    }
    fields.push(
      label("不 @ 也主动接话", "群里没 @ 它的消息，它看情况接一句"),
      select("proactive", draft.proactive === undefined ? "env" : draft.proactive ? "on" : "off", [
        ["env", `照服务器上的配置（现在：${base.proactive ? "开" : "关"}）`],
        ["on", "开"],
        ["off", "关"],
      ]),
    );

    return card(enabled ? `「${session.name}」的设置` : `开通「${session.name}」`, enabled ? "blue" : "turquoise", [
      ...(enabled
        ? []
        : [
            markdown(
              "这个群还没开通，机器人在群里不回话。开通前先定好它在这个群里能做什么" +
                (this.opts.settings.override(session.chatId) || this.opts.groups.onServer(session.chatId)
                  ? "：下面是这个群原来的设置。"
                  : "：新开通的群先收紧，不开代码仓库和运维工具，谁都不能让它改文档和代码，要开哪样在下面改。"),
            ),
          ]),
      markdown(
        grey("每一项选「照服务器上的配置」就用服务器上写的（括号里是现在的）。改好点「下一步」核对改动，点「确认」才生效。只有管理员能改，卡片 30 分钟内有效"),
      ),
      ...note,
      { tag: "form", name: "settings", elements: [...fields, submitButton(enabled ? "下一步：核对改动" : "下一步：核对后开通", value("next"))] },
      buttons([
        actionButton("全部照服务器上的配置", "default", value("reset")),
        ...(enabled ? [actionButton("停用这个群", "danger", value("disable"))] : []),
        actionButton("取消", "default", value("cancel")),
      ]),
    ]);
  }

  private adminsCard(session: AdminsSession): object {
    const value = (op: string) => ({ action: SETTINGS_ACTION, card: session.id, op, r: String(session.rev) });
    const note = session.note ? [markdown(`⚠️ ${richText(session.note)}`)] : [];
    if (session.view === "review") {
      return card("核对管理员名单", "orange", [
        markdown(`要改的（点「确认」才生效）：\n${changeLines(session.changes)}`),
        ...note,
        buttons([actionButton("确认", "primary", value("confirm")), actionButton("返回修改", "default", value("edit")), actionButton("取消", "default", value("cancel"))]),
      ]);
    }
    const admins = [...this.opts.settings.admins()];
    return card("管理员名单", "blue", [
      markdown(`**所有者**（写在服务器配置里，卡片上改不了）：${[...this.opts.owners].map(personTag).join("、")}`),
      markdown(`**管理员**（能改各群的设置，不能加减管理员）：${admins.length > 0 ? admins.map(personTag).join("、") : "还没有"}`),
      markdown(grey("只有所有者能加减管理员。要加的人得先在这个管理群里" + (session.peopleNote ? `。${session.peopleNote}` : ""))),
      ...note,
      {
        tag: "form",
        // 不能和下面的选人框（admins）重名：飞书整张卡片拒收（11310 name duplicate）
        name: "admins_form",
        elements: [
          ...(session.people.length > 0 ? [personSelect("admins", session.people, session.draft.filter((openId) => session.people.includes(openId)))] : []),
          submitButton("下一步：核对改动", value("next")),
        ],
      },
      buttons([actionButton("取消", "default", value("cancel"))]),
    ]);
  }
}

/** 表单里填的值：飞书 SDK 整理过的事件里没有，要开 includeRawEvent 从原始事件里取 */
function formValue(evt: CardActionEvent): Record<string, unknown> | undefined {
  const raw = evt.raw as { action?: { form_value?: unknown } } | undefined;
  const value = raw?.action?.form_value;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") {
    return value ? [value] : [];
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function unique<T>(list: readonly T[]): T[] {
  return [...new Set(list)];
}

function sortedJson(list: readonly string[]): string {
  return JSON.stringify([...list].sort());
}

function peopleCount(set: ReadonlySet<string> | undefined): string {
  return set === undefined ? "所有人" : set.size === 0 ? "谁都不能" : `${set.size} 人`;
}

function peopleText(list: readonly string[] | undefined): string {
  return list === undefined ? "所有人" : list.length === 0 ? "谁都不能" : `${list.length} 人：${list.join("、")}`;
}

function mcpText(tools: readonly string[] | "*" | undefined): string {
  return tools === undefined ? "不开" : tools === "*" ? "全开" : `${tools.length} 个工具`;
}

/** 前后都是名单时，写出加了谁、去掉了谁 */
function delta(before: readonly string[] | undefined, after: readonly string[] | undefined): string {
  if (!before || !after) {
    return "";
  }
  const added = after.filter((openId) => !before.includes(openId));
  const removed = before.filter((openId) => !after.includes(openId));
  const parts = [...(added.length > 0 ? [`加了 ${added.join("、")}`] : []), ...(removed.length > 0 ? [`去掉了 ${removed.join("、")}`] : [])];
  return parts.length > 0 ? `（${parts.join("；")}）` : "";
}

function peopleChange(field: string, before: readonly string[], after: readonly string[]): SettingsChange | undefined {
  if (sortedJson(before) === sortedJson(after)) {
    return undefined;
  }
  const text = (list: readonly string[]) => (list.length > 0 ? `${list.length} 人：${list.join("、")}` : "没有");
  return { field, before: text(before), after: text(after) + delta(before, after) };
}

function changeLines(changes: readonly SettingsChange[]): string {
  return changes.map((change) => `- **${escapeCardMarkdown(change.field)}**：${richText(change.before)} → ${richText(change.after)}`).join("\n");
}

/** 卡片上的字：尖括号转义，open_id 显示成名字（飞书按人渲染，不 @ 人） */
function richText(text: string): string {
  return escapeCardMarkdown(text).replace(OPEN_IDS, personTag);
}

function personTag(openId: string): string {
  return `<person id='${openId}' show_name=true show_avatar=false style='normal'></person>`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function grey(text: string): string {
  return `<font color='grey'>${escapeCardMarkdown(text)}</font>`;
}

function markdown(content: string): object {
  return { tag: "markdown", content };
}

function label(title: string, desc: string): object {
  return markdown(`**${escapeCardMarkdown(title)}**　${grey(desc)}`);
}

function select(name: string, initial: string, options: ReadonlyArray<readonly [string, string]>): object {
  return {
    tag: "select_static",
    name,
    width: "fill",
    initial_option: initial,
    options: options.map(([value, text]) => ({ text: { tag: "plain_text", content: clip(text, OPTION_CHARS) }, value })),
  };
}

function multiSelect(name: string, options: readonly string[], selected: readonly string[], placeholder: string): object {
  return {
    tag: "multi_select_static",
    name,
    width: "fill",
    placeholder: { tag: "plain_text", content: placeholder },
    selected_values: [...selected],
    options: options.map((option) => ({ text: { tag: "plain_text", content: option }, value: option })),
  };
}

function personSelect(name: string, people: readonly string[], selected: readonly string[]): object {
  return {
    tag: "multi_select_person",
    name,
    width: "fill",
    placeholder: { tag: "plain_text", content: "选人" },
    selected_values: [...selected],
    options: people.map((openId) => ({ value: openId })),
  };
}

function submitButton(text: string, value: Record<string, string>): object {
  return { tag: "button", name: "submit", text: { tag: "plain_text", content: text }, type: "primary", form_action_type: "submit", behaviors: [{ type: "callback", value }] };
}

function actionButton(text: string, type: string, value: Record<string, string>): object {
  return { tag: "button", text: { tag: "plain_text", content: text }, type, size: "small", behaviors: [{ type: "callback", value }] };
}

function buttons(list: readonly object[]): object {
  return { tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: list.map((button) => ({ tag: "column", width: "auto", elements: [button] })) };
}

function row(left: readonly object[], right: readonly object[]): object {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    columns: [
      { tag: "column", width: "weighted", weight: 4, vertical_align: "center", elements: left },
      { tag: "column", width: "auto", vertical_align: "center", elements: right },
    ],
  };
}

function card(title: string, template: string, elements: readonly object[]): object {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: title } },
    header: { title: { tag: "plain_text", content: title }, template },
    body: { elements },
  };
}

function closedCard(title: string, body: string, template: string): object {
  return card(title, template, [markdown(body)]);
}

function person(openId: string, name: string | undefined): Person {
  return { openId, ...(name ? { name } : {}) };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
