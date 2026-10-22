import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { FileQueue, writeAtomically } from "./file-store.js";
import type { Logger } from "./history.js";

/**
 * 管理群的设置卡片上给一个群单独定的项。没写的项照服务器上的配置：.env 里这个群的 GROUP_<名字>_…，再没有就照全局。
 * 卡片上定的盖过 .env 里的同一项
 */
export interface GroupOverride {
  /**
   * 开通：true 是在卡片上开通的（服务器白名单 FEISHU_ALLOWED_CHAT_IDS 里没有），false 是在卡片上停用的（白名单里有）。
   * 没写照服务器白名单。停用的群其余的项留着，再开通时照用
   */
  enabled?: boolean;
  /** 能操作的仓库（只能是服务器上接入了的仓库，或者 group/* 一整组）；空数组是不开代码工具 */
  codeRepos?: string[];
  /** 写权限名单（open_id）；空数组是谁都不能让机器人改文档、改代码 */
  writeAllowed?: string[];
  /** 能让机器人记、改、删群记忆的人；空数组是群记忆只能看 */
  memoryEditors?: string[];
  /** 每个 MCP 服务：all 是服务器上开了的全部工具，off 是不开，数组是只开这几个；没写的服务照服务器上的配置 */
  mcp?: Record<string, McpOverride>;
  /** 团队经验库用不用 */
  knowledge?: boolean;
  /** 不 @ 也主动接话 */
  proactive?: boolean;
}

export type McpOverride = "all" | "off" | string[];

/** 改的是管理员名单（不是哪个群）时，版本号、改动记录里写这个 */
export const ADMINS_TARGET = "admins";

/** 一次改动里的一项：卡片上核对、改动记录、管理群里那条消息都按它写 */
export interface SettingsChange {
  /** 哪一项，比如「写权限名单」 */
  field: string;
  before: string;
  after: string;
}

/** 改动记录里的一行：谁、什么时候、改的哪个群、每一项改前改后。只追加不改 */
export interface ChangeRecord {
  at: string;
  /** 点「确认」的人的 open_id */
  by: string;
  byName?: string;
  /** 群的 chat_id；改管理员名单时是 ADMINS_TARGET */
  target: string;
  targetName?: string;
  changes: SettingsChange[];
}

interface SettingsData {
  /** 管理员（open_id）：所有者在卡片上加减，所有者本人写在 .env 里 */
  admins: string[];
  /** 群的 chat_id → 卡片上单独定的项 */
  groups: Record<string, GroupOverride>;
  /** 群的 chat_id（管理员名单是 ADMINS_TARGET）→ 改过几次：确认时核对，打开卡片以后别人改过的不覆盖 */
  versions: Record<string, number>;
}

const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
const FIELDS = new Set<keyof GroupOverride>(["enabled", "codeRepos", "writeAllowed", "memoryEditors", "mcp", "knowledge", "proactive"]);

export interface GroupSettingsOptions {
  /** 配置文件 groups.json 和改动记录 changes.log 放在这个目录 */
  dir: string;
  logger?: Logger;
  now?: () => Date;
}

/**
 * 管理群里改的配置：存在机器人数据目录里的 groups.json，只有机器人写；每改一次往 changes.log 追加一行。
 * 读坏了不从空的开始（那样卡片上收紧过的群会悄悄放宽），启动时直接报错
 */
export class GroupSettings {
  readonly file: string;
  readonly logFile: string;
  private data: SettingsData = { admins: [], groups: {}, versions: {} };
  private readonly files = new FileQueue();
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(private readonly opts: GroupSettingsOptions) {
    this.file = path.join(opts.dir, "groups.json");
    this.logFile = path.join(opts.dir, "changes.log");
    this.logger = opts.logger ?? console;
    this.now = opts.now ?? (() => new Date());
  }

  async init(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
    this.data = parseSettings(raw, this.file);
  }

  /** 这个群在卡片上单独定的项，没定过返回 undefined */
  override(chatId: string): GroupOverride | undefined {
    return this.data.groups[chatId];
  }

  /** 卡片上单独定过的群 */
  chatIds(): string[] {
    return Object.keys(this.data.groups);
  }

  /** 管理员名单（不含 .env 里的所有者） */
  admins(): ReadonlySet<string> {
    return new Set(this.data.admins);
  }

  /** 这个群（或管理员名单）改过几次 */
  version(target: string): number {
    return this.data.versions[target] ?? 0;
  }

  /**
   * 存一个群的新设置（全部照服务器上的配置时传空对象）。打开卡片时的版本号和现在的不一样（这期间别人改过）返回 stale，什么都不改。
   * 写配置文件失败时抛错、内存里也不改；写进了配置文件、改动记录没追加上时只打警告
   */
  saveGroup(chatId: string, next: GroupOverride, expected: number, record: RecordInput): Promise<"saved" | "stale"> {
    return this.commit(chatId, expected, record, (data) => {
      const clean = compact(next);
      const groups = { ...data.groups };
      if (Object.keys(clean).length === 0) {
        delete groups[chatId];
      } else {
        groups[chatId] = clean;
      }
      return { ...data, groups };
    });
  }

  /** 存新的管理员名单，同 saveGroup */
  saveAdmins(admins: readonly string[], expected: number, record: RecordInput): Promise<"saved" | "stale"> {
    return this.commit(ADMINS_TARGET, expected, record, (data) => ({ ...data, admins: [...new Set(admins)] }));
  }

  private commit(target: string, expected: number, record: RecordInput, change: (data: SettingsData) => SettingsData): Promise<"saved" | "stale"> {
    return this.files.run(this.file, async () => {
      if (this.version(target) !== expected) {
        return "stale";
      }
      const next = change(this.data);
      next.versions = { ...next.versions, [target]: expected + 1 };
      await writeAtomically(this.file, `${JSON.stringify(next, null, 2)}\n`);
      this.data = next;
      const line: ChangeRecord = { at: this.now().toISOString(), target, ...record };
      await appendFile(this.logFile, `${JSON.stringify(line)}\n`, { encoding: "utf8", mode: 0o600 }).catch((err: unknown) =>
        this.logger.warn(`群配置：改动已经生效，但没记进 ${this.logFile}：${JSON.stringify(line)}`, err),
      );
      return "saved";
    });
  }
}

type RecordInput = Omit<ChangeRecord, "at" | "target">;

/** 去掉没写的项，空的 mcp 对象也去掉（没写的服务照服务器上的配置，空对象就是全照服务器） */
function compact(override: GroupOverride): GroupOverride {
  const out: GroupOverride = {};
  if (override.enabled !== undefined) {
    out.enabled = override.enabled;
  }
  if (override.codeRepos !== undefined) {
    out.codeRepos = [...new Set(override.codeRepos)];
  }
  if (override.writeAllowed !== undefined) {
    out.writeAllowed = [...new Set(override.writeAllowed)];
  }
  if (override.memoryEditors !== undefined) {
    out.memoryEditors = [...new Set(override.memoryEditors)];
  }
  if (override.mcp !== undefined && Object.keys(override.mcp).length > 0) {
    out.mcp = { ...override.mcp };
  }
  if (override.knowledge !== undefined) {
    out.knowledge = override.knowledge;
  }
  if (override.proactive !== undefined) {
    out.proactive = override.proactive;
  }
  return out;
}

/** 读配置文件：格式不对的整个不认，报错写明哪里不对 */
export function parseSettings(raw: string, file: string): SettingsData {
  const fail = (why: string): never => {
    throw new Error(`群配置文件 ${file} 格式不对（${why}）。改好它，或者从备份里拿一份回来，再重启`);
  };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("不是 JSON");
  }
  if (!isRecord(value)) {
    return fail("不是对象");
  }
  const admins = value.admins ?? [];
  if (!Array.isArray(admins) || !admins.every((id) => typeof id === "string" && OPEN_ID.test(id))) {
    fail("admins 要是 open_id 的列表");
  }
  const groups = value.groups ?? {};
  if (!isRecord(groups)) {
    return fail("groups 要是对象");
  }
  for (const [chatId, override] of Object.entries(groups)) {
    const why = checkOverride(override);
    if (why) {
      fail(`群 ${chatId}：${why}`);
    }
  }
  const versions = value.versions ?? {};
  if (!isRecord(versions) || !Object.values(versions).every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) {
    fail("versions 要是不小于 0 的整数");
  }
  return { admins: admins as string[], groups: groups as Record<string, GroupOverride>, versions: versions as Record<string, number> };
}

function checkOverride(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return "不是对象";
  }
  for (const key of Object.keys(value)) {
    if (!FIELDS.has(key as keyof GroupOverride)) {
      return `不认识 ${key}`;
    }
  }
  const strings = (list: unknown) => Array.isArray(list) && list.every((item) => typeof item === "string" && item.length > 0);
  const people = (list: unknown) => Array.isArray(list) && list.every((item) => typeof item === "string" && OPEN_ID.test(item));
  if (value.codeRepos !== undefined && !strings(value.codeRepos)) {
    return "codeRepos 要是仓库名的列表";
  }
  for (const key of ["writeAllowed", "memoryEditors"] as const) {
    if (value[key] !== undefined && !people(value[key])) {
      return `${key} 要是 open_id 的列表`;
    }
  }
  if (value.mcp !== undefined) {
    if (!isRecord(value.mcp)) {
      return "mcp 要是对象";
    }
    for (const [server, tools] of Object.entries(value.mcp)) {
      if (tools !== "all" && tools !== "off" && !strings(tools)) {
        return `mcp.${server} 要是 all、off 或工具名的列表`;
      }
    }
  }
  for (const key of ["enabled", "knowledge", "proactive"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      return `${key} 要是 true 或 false`;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
