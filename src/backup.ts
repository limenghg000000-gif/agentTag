import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./history.js";

/** 默认保留最近 14 天的备份 */
export const DEFAULT_BACKUP_KEEP_DAYS = 14;
/** 每小时看一次今天备份过没有 */
export const BACKUP_CHECK_INTERVAL_MS = 60 * 60_000;
const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;
/** 只备份正式的记忆文件，不带写了一半的临时文件和 .corrupt- 文件 */
const MEMORY_FILE = /^[\w-]+\.json$/;
const TMP_PREFIX = ".tmp-";

export interface MemoryBackupOptions {
  memoryDir: string;
  /** 每天一个子目录，名字是日期（服务器本地时间） */
  backupDir: string;
  keepDays: number;
  logger?: Logger;
  now?: () => Date;
}

/**
 * 群记忆每日备份：每天第一次检查时把所有群的记忆文件复制一份到 backupDir/<日期>/，
 * 超过保留天数的旧备份删掉。防的是误删、写坏，不防整块盘坏掉。
 */
export class MemoryBackup {
  private readonly memoryDir: string;
  private readonly backupDir: string;
  private readonly keepDays: number;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(opts: MemoryBackupOptions) {
    this.memoryDir = opts.memoryDir;
    this.backupDir = opts.backupDir;
    this.keepDays = opts.keepDays;
    this.logger = opts.logger ?? console;
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), BACKUP_CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** 今天还没备份就备份一份，再删掉超出保留天数的旧备份。返回今天新建的备份目录，今天已经备份过返回 undefined */
  async runOnce(): Promise<string | undefined> {
    await mkdir(this.backupDir, { recursive: true, mode: 0o700 });
    const target = path.join(this.backupDir, dayOf(this.now()));
    const existing = await readdir(this.backupDir);
    if (existing.includes(path.basename(target))) {
      return undefined;
    }

    const files = (await readdir(this.memoryDir).catch(ignoreMissing)).filter((name) => MEMORY_FILE.test(name));
    // 先复制到临时目录，全部成功再改名，不会留下只复制了一半的备份
    const tmp = path.join(this.backupDir, `${TMP_PREFIX}${randomUUID()}`);
    try {
      await mkdir(tmp, { mode: 0o700 });
      for (const name of files) {
        await copyFile(path.join(this.memoryDir, name), path.join(tmp, name));
        await chmod(path.join(tmp, name), 0o600);
      }
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw err;
    }

    const removed = await this.prune(existing);
    this.logger.info(
      `群记忆已备份到 ${target}（${files.length} 个群）` + (removed > 0 ? `，删掉了 ${removed} 份超过 ${this.keepDays} 天的旧备份` : ""),
    );
    return target;
  }

  private tick(): void {
    if (this.running) {
      return;
    }
    this.running = this.runOnce()
      .then(() => undefined)
      .catch((err) => this.logger.error(`群记忆备份失败，下个小时再试：${err instanceof Error ? err.message : err}`))
      .finally(() => {
        this.running = undefined;
      });
  }

  /** 只留最近 keepDays 份；顺手清掉上次中途退出留下的临时目录 */
  private async prune(before: string[]): Promise<number> {
    const days = (await readdir(this.backupDir)).filter((name) => DAY_DIR.test(name)).sort().reverse();
    const old = days.slice(this.keepDays);
    const leftovers = before.filter((name) => name.startsWith(TMP_PREFIX));
    for (const name of [...old, ...leftovers]) {
      await rm(path.join(this.backupDir, name), { recursive: true, force: true });
    }
    return old.length;
  }
}

/** 服务器本地时间的日期，如 2026-09-27 */
function dayOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function ignoreMissing(err: NodeJS.ErrnoException): string[] {
  if (err.code === "ENOENT") {
    return [];
  }
  throw err;
}
