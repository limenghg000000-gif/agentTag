import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { call } from "./docs.js";
import { FeishuApiError } from "./feishu.js";
import type { Logger } from "./history.js";
import {
  KNOWLEDGE_CATEGORIES,
  type KnowledgeBackend,
  type KnowledgeCategory,
  type KnowledgeEntry,
  KnowledgeError,
} from "./knowledge.js";

/** 多维表格的列名。第一列是标题（多维表格的主字段） */
const FIELDS = {
  title: "标题",
  id: "编号",
  category: "类别",
  status: "状态",
  scope: "适用范围",
  question: "问题或场景",
  conclusion: "结论",
  handling: "怎么处理",
  basis: "依据或排查过程",
  keywords: "关键词",
  errorCodes: "错误码",
  alertname: "告警名",
  proposedBy: "发起人",
  confirmedBy: "确认人",
  source: "来源",
  replaces: "取代的经验",
  aiopsId: "aiops 经验编号",
  requestId: "草稿编号",
  createdAt: "保存时间",
  updatedAt: "修改时间",
} as const;

const STATUS_LABELS = { active: "有效", archived: "已归档" } as const;
const PERM_LABELS = { view: "只读", edit: "可编辑", full_access: "可管理" } as const;
const APP_NAME = "AgentTag 经验库";
const TABLE_NAME = "经验库";

/** 多维表格字段类型：1 文本，3 单选，1001 创建时间，1002 修改时间 */
const TEXT = 1;
const SINGLE_SELECT = 3;
const CREATED_TIME = 1001;
const MODIFIED_TIME = 1002;

export interface BitableField {
  field_name: string;
  type: number;
  property?: { options?: { name: string }[]; date_formatter?: string };
}

export interface BitableRecord {
  recordId: string;
  fields: Record<string, unknown>;
}

export type BitableMember = { type: "openchat" | "openid"; id: string };
export type BitablePerm = "view" | "edit" | "full_access";

/** 用到的多维表格接口，测试时换成假的 */
export interface BitableApi {
  createApp(name: string): Promise<{ appToken: string; url?: string; defaultTableId?: string }>;
  createTable(appToken: string, name: string, fields: readonly BitableField[]): Promise<string>;
  deleteTable(appToken: string, tableId: string): Promise<void>;
  listRecords(appToken: string, tableId: string): Promise<BitableRecord[]>;
  /** 数据表里已有的列名 */
  listFields(appToken: string, tableId: string): Promise<string[]>;
  createField(appToken: string, tableId: string, field: BitableField): Promise<void>;
  /** clientToken（UUID）相同的请求飞书只建一行，结果没传回来时可以放心重试 */
  createRecord(appToken: string, tableId: string, fields: Record<string, unknown>, clientToken?: string): Promise<string>;
  updateRecord(appToken: string, tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void>;
  addCollaborator(appToken: string, member: BitableMember, perm: BitablePerm): Promise<void>;
  updateCollaborator(appToken: string, member: BitableMember, perm: BitablePerm): Promise<void>;
  removeCollaborator(appToken: string, member: BitableMember): Promise<void>;
  /** 只有可管理的协作者（机器人自己）能加、移除协作者；关掉链接分享和分享到组织外，只有协作者能打开 */
  restrictSharing(appToken: string): Promise<void>;
  getUrl(appToken: string): Promise<string | undefined>;
}

export function createBitableApi(client: Client): BitableApi {
  return {
    async createApp(name) {
      const data = await call(() => client.bitable.v1.app.create({ data: { name, time_zone: "Asia/Shanghai" } }));
      const app = data?.app;
      if (!app?.app_token) {
        throw new KnowledgeError("新建多维表格的接口没有返回 app_token");
      }
      return { appToken: app.app_token, url: app.url, defaultTableId: app.default_table_id };
    },

    async createTable(appToken, name, fields) {
      const data = await call(() =>
        client.bitable.v1.appTable.create({
          path: { app_token: appToken },
          data: { table: { name, default_view_name: "全部", fields: fields as never } },
        }),
      );
      if (!data?.table_id) {
        throw new KnowledgeError("新建数据表的接口没有返回 table_id");
      }
      return data.table_id;
    },

    async deleteTable(appToken, tableId) {
      await call(() => client.bitable.v1.appTable.delete({ path: { app_token: appToken, table_id: tableId } }));
    },

    async listRecords(appToken, tableId) {
      const items = await allPages("经验库表格的记录", (pageToken) =>
        call(() =>
          client.bitable.v1.appTableRecord.list({
            path: { app_token: appToken, table_id: tableId },
            params: { page_size: 500, page_token: pageToken, automatic_fields: true },
          }),
        ),
      );
      return items.flatMap((item) => (item.record_id ? [{ recordId: item.record_id, fields: item.fields as Record<string, unknown> }] : []));
    },

    async listFields(appToken, tableId) {
      const items = await allPages("经验库表格的列", (pageToken) =>
        call(() =>
          client.bitable.v1.appTableField.list({ path: { app_token: appToken, table_id: tableId }, params: { page_size: 100, page_token: pageToken } }),
        ),
      );
      return items.flatMap((item) => (item.field_name ? [item.field_name] : []));
    },

    async createField(appToken, tableId, field) {
      await call(() => client.bitable.v1.appTableField.create({ path: { app_token: appToken, table_id: tableId }, data: field as never }));
    },

    async createRecord(appToken, tableId, fields, clientToken) {
      const data = await call(() =>
        client.bitable.v1.appTableRecord.create({
          path: { app_token: appToken, table_id: tableId },
          ...(clientToken ? { params: { client_token: clientToken } } : {}),
          data: { fields: fields as never },
        }),
      );
      return data?.record?.record_id ?? "";
    },

    async updateRecord(appToken, tableId, recordId, fields) {
      await call(() =>
        client.bitable.v1.appTableRecord.update({
          path: { app_token: appToken, table_id: tableId, record_id: recordId },
          data: { fields: fields as never },
        }),
      );
    },

    async addCollaborator(appToken, member, perm) {
      await call(() =>
        client.drive.v1.permissionMember.create({
          path: { token: appToken },
          params: { type: "bitable", need_notification: false },
          data: { member_type: member.type, member_id: member.id, perm, type: memberKind(member) },
        }),
      );
    },

    async updateCollaborator(appToken, member, perm) {
      await call(() =>
        client.drive.v1.permissionMember.update({
          path: { token: appToken, member_id: member.id },
          params: { type: "bitable", need_notification: false },
          data: { member_type: member.type, perm, type: memberKind(member) },
        }),
      );
    },

    async removeCollaborator(appToken, member) {
      await call(() =>
        client.drive.v1.permissionMember.delete({
          path: { token: appToken, member_id: member.id },
          params: { type: "bitable", member_type: member.type },
          data: { type: memberKind(member) },
        }),
      );
    },

    async restrictSharing(appToken) {
      await call(() =>
        client.drive.v2.permissionPublic.patch({
          path: { token: appToken },
          params: { type: "bitable" },
          data: { manage_collaborator_entity: "collaborator_full_access", external_access_entity: "closed", link_share_entity: "closed" },
        }),
      );
    },

    async getUrl(appToken) {
      const data = await call(() =>
        client.drive.v1.meta.batchQuery({ data: { request_docs: [{ doc_token: appToken, doc_type: "bitable" }], with_url: true } }),
      );
      return data?.metas?.[0]?.url || undefined;
    },
  };
}

function memberKind(member: BitableMember): "chat" | "user" {
  return member.type === "openchat" ? "chat" : "user";
}

/** 用哪张多维表格：KNOWLEDGE_BITABLE 里给的链接，或者机器人自己建的（记在数据目录里） */
export interface BitableTarget {
  appToken: string;
  tableId: string;
  url?: string;
}

/** 翻页最多翻多少页：只防接口一直说还有下一页、停不下来（500 行一页，够十万行） */
const MAX_PAGES = 200;

/**
 * 一页一页读到底。接口说还有下一页、却没给新的翻页位置，或者页数多得不正常时报错：
 * 读了一半的结果不能当成整张表用（漏掉的行检索不到，新编号还可能和漏掉的行重复）
 */
async function allPages<T>(
  what: string,
  fetch: (pageToken: string | undefined) => Promise<{ items?: T[]; has_more?: boolean; page_token?: string } | undefined>,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 1; ; page++) {
    const data = await fetch(pageToken);
    items.push(...(data?.items ?? []));
    if (!data?.has_more) {
      return items;
    }
    if (!data.page_token || seen.has(data.page_token)) {
      throw new KnowledgeError(`读${what}时，飞书说还有下一页，却没给新的翻页位置，读不全，这次先不用`);
    }
    if (page >= MAX_PAGES) {
      throw new KnowledgeError(`${what}读了 ${MAX_PAGES} 页还没读完，这次先不用读了一半的结果`);
    }
    seen.add(data.page_token);
    pageToken = data.page_token;
  }
}

/**
 * 解析多维表格链接：https://xxx.feishu.cn/base/<app_token>?table=<table_id>。
 * 知识库里的多维表格链接（/wiki/…）背后的 app_token 要另外查，这里不支持，请用多维表格本身的链接
 */
export function parseBitableUrl(value: string): BitableTarget {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`KNOWLEDGE_BITABLE 要填多维表格的链接（https://xxx.feishu.cn/base/…?table=…），当前为 ${value}`);
  }
  const appToken = /\/base\/([A-Za-z0-9]+)/.exec(url.pathname)?.[1];
  const tableId = url.searchParams.get("table");
  if (!appToken || !tableId || !/^tbl\w+$/.test(tableId)) {
    throw new Error("KNOWLEDGE_BITABLE 要填打开经验库那张数据表时浏览器里的链接，里面要有 /base/<app_token> 和 ?table=tbl…");
  }
  return { appToken, tableId, url: `${url.origin}${url.pathname}?table=${tableId}` };
}

export interface BitableBackendOptions {
  api: BitableApi;
  /** 机器人自己建的表记在这个文件里，重启后接着用 */
  stateFile: string;
  /** KNOWLEDGE_BITABLE 指定的表；指定了就不自己建 */
  target?: BitableTarget;
  /**
   * 机器人自己建表时共享给谁：白名单群默认只读，写权限名单里的人可编辑。
   * 没配写权限名单时群里谁都能点「保存」，群也给可编辑。可管理只留给机器人：能管协作者的人才能把表格共享出名单
   */
  share: { chatIds: readonly string[]; editors: readonly string[]; chatPerm?: "view" | "edit" };
  logger?: Logger;
}

/** 机器人自己建的表记在数据目录里：表在哪，已经共享给了谁 */
interface BitableState extends BitableTarget {
  /** 机器人共享出去的「类型:id:权限」。只管这些：别人在飞书里手动加的协作者不动 */
  shared?: string[];
  /** 已经设成只有机器人能管协作者、只有协作者能打开 */
  restricted?: boolean;
  /** shared 里结果不明的「类型:id」（先记下来再加的，加的结果没传回来或者进程退出了）：可能加上了，下次再加一次确认 */
  pending?: string[];
}

/**
 * 经验存在飞书多维表格里：大家在飞书里能直接看、筛选和修改，机器人每分钟重新读一次。
 * 没指定表时，第一次保存经验时机器人自己建一张，共享给白名单群（只读）和写权限名单里的人（可编辑）。
 * 表格设成只有机器人能加、移除协作者，链接分享关掉，所以能打开的只有名单里的群和人。
 * 共享跟着白名单群和写权限名单走：启动时和每次保存时补上没共享成的、改掉权限变了的、撤掉移出名单的。
 * 有人在表格里手动加的行没有编号时，用行的 record_id 当编号，照样能检索到
 */
export class BitableKnowledgeBackend implements KnowledgeBackend {
  private target?: Promise<BitableState | undefined>;
  private creating?: Promise<BitableState>;
  /** 调整共享排队进行（启动时和保存时可能同时来） */
  private sharing: Promise<void> = Promise.resolve();
  /** 补齐列：每次启动后第一次写表格前做一次 */
  private schema?: Promise<void>;
  /** 编号 → 行 id，update 时用 */
  private rows = new Map<string, string>();
  /** 表格里不止一行用的编号（有人复制了行）：改这些编号时不知道该改哪行，不改 */
  private ambiguous = new Set<string>();
  /**
   * 每开始读一次表格、每写进一行加一。读完时这个数变了，说明读的时候又有了更新的读或者新写的行
   * （比如回答前检索超时、还在后台读的那次），这次读到的比现在记的旧，不拿来换编号 → 行 id 的对照
   */
  private generation = 0;
  private warnedAmbiguous = "";
  private readonly logger: Logger;

  constructor(private readonly options: BitableBackendOptions) {
    this.logger = options.logger ?? console;
  }

  async location(): Promise<string | undefined> {
    const target = await this.current();
    return target?.url;
  }

  async list(): Promise<KnowledgeEntry[]> {
    const target = await this.current();
    if (!target) {
      return [];
    }
    const generation = ++this.generation;
    const records = await this.explain(() => this.options.api.listRecords(target.appToken, target.tableId));
    const rows = new Map<string, string>();
    const ambiguous = new Set<string>();
    const entries: KnowledgeEntry[] = [];
    for (const record of records) {
      const entry = toEntry(record);
      if (entry) {
        const key = entry.id.toUpperCase();
        if (rows.has(key)) {
          ambiguous.add(key);
        } else {
          rows.set(key, record.recordId);
        }
        entries.push(entry);
      }
    }
    if (generation === this.generation) {
      this.rows = rows;
      this.ambiguous = ambiguous;
      this.warnAmbiguous();
    }
    return entries;
  }

  private warnAmbiguous(): void {
    const ambiguous = [...this.ambiguous].join(" ");
    if (ambiguous && ambiguous !== this.warnedAmbiguous) {
      this.logger.warn(`经验库：表格里有不止一行用了同一个编号：${ambiguous}。归档这些编号前请先在表格里把重复的改掉`);
    }
    this.warnedAmbiguous = ambiguous;
  }

  async add(entry: KnowledgeEntry): Promise<void> {
    const target = (await this.current()) ?? (await this.create());
    if (!this.options.target) {
      await this.share(target);
    }
    await this.ensureColumns(target);
    const recordId = await this.explain(() => this.options.api.createRecord(target.appToken, target.tableId, toFields(entry), entry.requestId));
    // 写之前开始的读还没回来的话，回来时不再用它换掉对照，不然会把这一行丢掉
    this.generation++;
    if (recordId) {
      this.rows.set(entry.id.toUpperCase(), recordId);
    }
  }

  async update(id: string, changes: Partial<Pick<KnowledgeEntry, "status" | "aiopsId">>): Promise<void> {
    const target = await this.current();
    const recordId = this.rows.get(id.toUpperCase());
    if (!target || !recordId) {
      throw new KnowledgeError(`多维表格里找不到 ${id} 这一行`);
    }
    if (this.ambiguous.has(id.toUpperCase())) {
      throw new KnowledgeError(`多维表格里不止一行的编号是 ${id}，不知道该改哪一行。请先在表格里把重复的编号改掉再试`);
    }
    await this.ensureColumns(target);
    const fields: Record<string, unknown> = {};
    if (changes.status) {
      fields[FIELDS.status] = STATUS_LABELS[changes.status];
    }
    if (changes.aiopsId !== undefined) {
      fields[FIELDS.aiopsId] = String(changes.aiopsId);
    }
    await this.explain(() => this.options.api.updateRecord(target.appToken, target.tableId, recordId, fields));
  }

  /** 启动时调：机器人自己建的表按现在的名单调整共享。还没建表时什么也不做；用的是 KNOWLEDGE_BITABLE 指定的表时只在日志里提醒一句 */
  async syncSharing(): Promise<void> {
    if (this.options.target) {
      this.logger.info("经验库：用的是 KNOWLEDGE_BITABLE 指定的表，机器人不管它的共享。白名单群和写权限名单变了，请在飞书里自己调整这张表的协作者");
      return;
    }
    const target = await this.current().catch((err: unknown) => {
      this.logger.warn("经验库：读不出数据目录里记的多维表格，这次没调整共享", err);
      return undefined;
    });
    if (target) {
      await this.share(target);
    }
  }

  private current(): Promise<BitableState | undefined> {
    if (!this.target) {
      const reading = this.options.target ? Promise.resolve(this.options.target) : this.readState();
      this.target = reading;
      // 读数据目录出错（比如磁盘一时读不了）不记住，下次再读
      reading.catch(() => {
        if (this.target === reading) {
          this.target = undefined;
        }
      });
    }
    return this.target;
  }

  private async readState(): Promise<BitableState | undefined> {
    try {
      const data = JSON.parse(await readFile(this.options.stateFile, "utf8")) as Partial<BitableState>;
      if (!data.appToken || !data.tableId) {
        return undefined;
      }
      const shared = Array.isArray(data.shared) ? data.shared.filter((key): key is string => typeof key === "string") : [];
      return {
        appToken: data.appToken,
        tableId: data.tableId,
        ...(data.url ? { url: data.url } : {}),
        shared,
        ...(data.restricted === true ? { restricted: true } : {}),
        ...(Array.isArray(data.pending) ? { pending: data.pending.filter((key): key is string => typeof key === "string") } : {}),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }

  /** 建表：新建多维表格，加一张带好列的数据表，删掉自带的空表，记进数据目录（共享在 add 里做） */
  private create(): Promise<BitableState> {
    this.creating ??= this.doCreate().finally(() => {
      this.creating = undefined;
    });
    return this.creating;
  }

  private async doCreate(): Promise<BitableState> {
    const { api } = this.options;
    const app = await this.explain(() => api.createApp(APP_NAME));
    const tableId = await this.explain(() => api.createTable(app.appToken, TABLE_NAME, TABLE_FIELDS));
    if (app.defaultTableId && app.defaultTableId !== tableId) {
      await api.deleteTable(app.appToken, app.defaultTableId).catch((err: unknown) => {
        this.logger.warn("经验库：删掉多维表格自带的空数据表失败，不影响使用", err);
      });
    }
    const base = app.url ?? (await api.getUrl(app.appToken).catch(() => undefined));
    const target: BitableState = { appToken: app.appToken, tableId, ...(base ? { url: `${base.split("?")[0]}?table=${tableId}` } : {}), shared: [] };
    // 先记下来再共享：共享到一半出错或者进程退出，下次也不会再建一张
    await this.writeState(target);
    this.target = Promise.resolve(target);
    this.logger.info(`经验库：新建了多维表格 ${target.url ?? target.appToken}`);
    return target;
  }

  /**
   * 表格里缺的列补上：KNOWLEDGE_BITABLE 指定的是新建的空表、或者是旧版本建的表少了后来加的列时，不补的话写入会报列不存在。
   * 同名但类型不同的列不动
   */
  private ensureColumns(target: BitableTarget): Promise<void> {
    this.schema ??= this.addMissingColumns(target).catch((err: unknown) => {
      this.schema = undefined;
      throw err;
    });
    return this.schema;
  }

  private async addMissingColumns(target: BitableTarget): Promise<void> {
    const { api } = this.options;
    const existing = new Set(await this.explain(() => api.listFields(target.appToken, target.tableId)));
    const missing = TABLE_FIELDS.filter((field) => !existing.has(field.field_name));
    for (const field of missing) {
      await this.explain(() => api.createField(target.appToken, target.tableId, field));
    }
    if (missing.length > 0) {
      this.logger.info(`经验库：多维表格里补上了 ${missing.length} 列：${missing.map((field) => field.field_name).join("、")}`);
    }
  }

  /** 按名单调整共享，排队进行 */
  private share(target: BitableState): Promise<void> {
    const run = this.sharing.then(() => this.reconcile(target));
    this.sharing = run.catch(() => {});
    return run;
  }

  /**
   * 先把表格设成只有机器人能管协作者、只有协作者能打开，名单里的人就没法再共享给名单外的人；这一步没成功就先不共享给任何人。
   * 再拿白名单群（默认只读）和写权限名单里的人（可编辑）要有的权限，和机器人已经共享出去的比：
   * 没共享的加上，权限变了的改掉，移出名单的撤掉（被移出写权限名单的人不能再直接改表格）。
   * 加协作者之前先把它记进数据目录：加上了却没来得及记下就退出的话，以后移出名单时就不知道要撤它。
   * 失败不影响保存，记一条警告，下次启动或保存时再试
   */
  private async reconcile(target: BitableState): Promise<void> {
    const { api, share } = this.options;
    const chatPerm = share.chatPerm ?? "view";
    const wanted = new Map<string, [BitableMember, BitablePerm]>([
      ...share.chatIds.map((id): [string, [BitableMember, BitablePerm]] => [`openchat:${id}`, [{ type: "openchat", id }, chatPerm]]),
      ...share.editors.map((id): [string, [BitableMember, BitablePerm]] => [`openid:${id}`, [{ type: "openid", id }, "edit"]]),
    ]);
    const granted = parseShared(target.shared ?? []);
    const pending = new Set((target.pending ?? []).filter((key) => granted.has(key)));
    let changed = false;
    const persist = async () => {
      target.shared = [...granted.values()].map(({ member, perm }) => `${member.type}:${member.id}:${perm}`);
      if (pending.size > 0) {
        target.pending = [...pending];
      } else {
        delete target.pending;
      }
      await this.writeState(target);
    };
    // 每一步各要一个应用权限，失败时把要的权限名写进警告。rejected：飞书明确拒绝了（带错误码），不是结果不明
    const attempt = async (what: string, scope: string, run: () => Promise<void>): Promise<{ ok: boolean; rejected?: boolean }> => {
      try {
        await run();
        changed = true;
        this.logger.info(`经验库：${what}`);
        return { ok: true };
      } catch (err) {
        // 不用 describeBitableError：它把缺权限都说成缺 bitable:app
        this.logger.warn(
          `经验库：没能${what}（要用应用权限 ${scope}），下次启动或保存经验时再试：${err instanceof Error ? err.message : String(err)}`,
        );
        return { ok: false, rejected: err instanceof FeishuApiError && err.code !== undefined };
      }
    };
    if (
      !target.restricted &&
      (
        await attempt("把多维表格设成只有机器人能加、移除协作者，关掉链接分享和分享到组织外", "docs:permission.setting:write_only", () =>
          api.restrictSharing(target.appToken),
        )
      ).ok
    ) {
      target.restricted = true;
    }
    const update = (member: BitableMember, from: BitablePerm, perm: BitablePerm) =>
      attempt(`把 ${member.id} 对多维表格的权限从${PERM_LABELS[from]}改成${PERM_LABELS[perm]}`, "docs:permission.member:update", () =>
        api.updateCollaborator(target.appToken, member, perm),
      );
    // 没设成只有机器人能管协作者之前不共享给任何人：看组织的默认设置，拿到权限的人可能再共享给名单外的人，之后也撤不掉。撤权限照常
    for (const [key, [member, perm]] of target.restricted ? wanted : []) {
      const had = granted.get(key);
      if (had && !pending.has(key)) {
        if (had.perm !== perm && (await update(member, had.perm, perm)).ok) {
          granted.set(key, { member, perm });
        }
        continue;
      }
      if (!had) {
        granted.set(key, { member, perm });
        pending.add(key);
        try {
          await persist();
        } catch (err) {
          granted.delete(key);
          pending.delete(key);
          this.logger.warn(`经验库：没能先把 ${member.id} 记进数据目录，这次先不共享给它，下次再试`, err);
          continue;
        }
      }
      // 新加的，或者上次结果不明的：加一次；上次其实加上了的话加会失败，再改一次权限
      const added = await attempt(`把多维表格共享给 ${member.id}（${PERM_LABELS[perm]}）`, "docs:permission.member:create", () =>
        api.addCollaborator(target.appToken, member, perm),
      );
      if (added.ok || (had && (await update(member, had.perm, perm)).ok)) {
        pending.delete(key);
        granted.set(key, { member, perm });
      } else if (!had && added.rejected) {
        // 飞书明确拒绝了（比如还没开权限），肯定没加上，不用记着
        granted.delete(key);
        pending.delete(key);
        changed = true;
      }
    }
    for (const [key, { member }] of [...granted]) {
      if (
        !wanted.has(key) &&
        (
          await attempt(`撤掉 ${member.id} 对多维表格的权限（已不在白名单群或写权限名单里）`, "docs:permission.member:delete", () =>
            api.removeCollaborator(target.appToken, member),
          )
        ).ok
      ) {
        granted.delete(key);
        pending.delete(key);
      }
    }
    if (changed) {
      await persist().catch((err: unknown) => this.logger.warn("经验库：共享结果没能记进数据目录，下次会再调整一次", err));
    }
  }

  private async writeState(state: BitableState): Promise<void> {
    await mkdir(path.dirname(this.options.stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.options.stateFile}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.options.stateFile);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  private async explain<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      throw new KnowledgeError(describeBitableError(err));
    }
  }
}

const TABLE_FIELDS: BitableField[] = [
  { field_name: FIELDS.title, type: TEXT },
  { field_name: FIELDS.id, type: TEXT },
  {
    field_name: FIELDS.category,
    type: SINGLE_SELECT,
    property: { options: Object.values(KNOWLEDGE_CATEGORIES).map((name) => ({ name })) },
  },
  { field_name: FIELDS.status, type: SINGLE_SELECT, property: { options: Object.values(STATUS_LABELS).map((name) => ({ name })) } },
  { field_name: FIELDS.scope, type: TEXT },
  { field_name: FIELDS.question, type: TEXT },
  { field_name: FIELDS.conclusion, type: TEXT },
  { field_name: FIELDS.handling, type: TEXT },
  { field_name: FIELDS.basis, type: TEXT },
  { field_name: FIELDS.keywords, type: TEXT },
  { field_name: FIELDS.errorCodes, type: TEXT },
  { field_name: FIELDS.alertname, type: TEXT },
  { field_name: FIELDS.proposedBy, type: TEXT },
  { field_name: FIELDS.confirmedBy, type: TEXT },
  { field_name: FIELDS.source, type: TEXT },
  { field_name: FIELDS.replaces, type: TEXT },
  { field_name: FIELDS.aiopsId, type: TEXT },
  { field_name: FIELDS.requestId, type: TEXT },
  { field_name: FIELDS.createdAt, type: CREATED_TIME, property: { date_formatter: "yyyy/MM/dd HH:mm" } },
  { field_name: FIELDS.updatedAt, type: MODIFIED_TIME, property: { date_formatter: "yyyy/MM/dd HH:mm" } },
];

function toFields(entry: KnowledgeEntry): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    [FIELDS.title]: entry.title,
    [FIELDS.id]: entry.id,
    [FIELDS.category]: KNOWLEDGE_CATEGORIES[entry.category],
    [FIELDS.status]: STATUS_LABELS[entry.status],
    [FIELDS.question]: entry.question,
    [FIELDS.conclusion]: entry.conclusion,
  };
  const optional: [string, string | undefined][] = [
    [FIELDS.scope, entry.scope],
    [FIELDS.handling, entry.handling],
    [FIELDS.basis, entry.basis],
    [FIELDS.keywords, entry.keywords],
    [FIELDS.errorCodes, entry.errorCodes],
    [FIELDS.alertname, entry.alertname],
    [FIELDS.proposedBy, entry.proposedBy],
    [FIELDS.confirmedBy, entry.confirmedBy],
    [FIELDS.source, entry.source],
    [FIELDS.replaces, entry.replaces],
    [FIELDS.aiopsId, entry.aiopsId === undefined ? undefined : String(entry.aiopsId)],
    [FIELDS.requestId, entry.requestId],
  ];
  for (const [name, value] of optional) {
    if (value) {
      fields[name] = value;
    }
  }
  return fields;
}

/** 表格里的一行 → 一条经验。没有标题或结论的行（空行、写到一半的）跳过 */
function toEntry({ recordId, fields }: BitableRecord): KnowledgeEntry | undefined {
  const text = (name: string) => textOf(fields[name]);
  const title = text(FIELDS.title);
  const conclusion = text(FIELDS.conclusion);
  if (!title || !conclusion) {
    return undefined;
  }
  const categoryLabel = text(FIELDS.category);
  const category = (Object.entries(KNOWLEDGE_CATEGORIES).find(([, label]) => label === categoryLabel)?.[0] ?? "other") as KnowledgeCategory;
  const aiopsId = Number.parseInt(text(FIELDS.aiopsId) ?? "", 10);
  const createdAt = timeOf(fields[FIELDS.createdAt]);
  const updatedAt = timeOf(fields[FIELDS.updatedAt]);
  const optional = (
    key: "scope" | "handling" | "basis" | "keywords" | "errorCodes" | "alertname" | "proposedBy" | "confirmedBy" | "source" | "requestId" | "replaces",
  ) => {
    const value = text(FIELDS[key]);
    return value ? { [key]: value } : {};
  };
  return {
    id: text(FIELDS.id) || recordId,
    category,
    title,
    question: text(FIELDS.question) ?? "",
    conclusion,
    status: text(FIELDS.status) === STATUS_LABELS.archived ? "archived" : "active",
    ...optional("scope"),
    ...optional("handling"),
    ...optional("basis"),
    ...optional("keywords"),
    ...optional("errorCodes"),
    ...optional("alertname"),
    ...optional("proposedBy"),
    ...optional("confirmedBy"),
    ...optional("source"),
    ...optional("requestId"),
    ...optional("replaces"),
    ...(Number.isFinite(aiopsId) ? { aiopsId } : {}),
    createdAt: createdAt ?? new Date(0).toISOString(),
    ...(updatedAt && updatedAt !== createdAt ? { updatedAt } : {}),
  };
}

/** 数据目录里记的「类型:id:权限」→ 成员和权限；认不出的跳过 */
function parseShared(keys: readonly string[]): Map<string, { member: BitableMember; perm: BitablePerm }> {
  const granted = new Map<string, { member: BitableMember; perm: BitablePerm }>();
  for (const key of keys) {
    const match = /^(openchat|openid):(.+):(view|edit|full_access)$/.exec(key);
    if (match) {
      const member: BitableMember = { type: match[1] as BitableMember["type"], id: match[2] };
      granted.set(`${member.type}:${member.id}`, { member, perm: match[3] as BitablePerm });
    }
  }
  return granted;
}

/** 文本列读出来可能是字符串，也可能是分段的数组（带链接、@ 人时）；单选是字符串 */
function textOf(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const joined = value
      .map((part) => (typeof part === "string" ? part : typeof part === "object" && part !== null ? ((part as { text?: string; name?: string }).text ?? (part as { name?: string }).name ?? "") : ""))
      .join("")
      .trim();
    return joined || undefined;
  }
  return undefined;
}

function timeOf(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : undefined;
}

/** 飞书接口的错误翻译成能转告的一句话 */
export function describeBitableError(err: unknown): string {
  if (err instanceof KnowledgeError) {
    return err.message;
  }
  if (!(err instanceof FeishuApiError)) {
    return err instanceof Error ? err.message : String(err);
  }
  const raw = err.message;
  if (err.code === 99991672 || err.code === 99991679 || /scope|权限：\[/i.test(raw)) {
    return `机器人缺少飞书应用的多维表格权限（bitable:app），需要管理员在飞书开发者后台开通后发布新版本。${raw}`;
  }
  if (err.status === 403 || err.code === 1254302 || /forbidden|permission denied|no permission/i.test(raw)) {
    return `机器人没有经验库这张多维表格的权限（${raw}）。请表格所有者在多维表格右上角「…」→「更多」→「添加文档应用」里添加机器人`;
  }
  return raw;
}
