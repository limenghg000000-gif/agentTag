import { copyFile, readFile } from "node:fs/promises";
import { describeCron, formatTime, nextRun, parseAt, parseCron, runsInWeek, shortestGapMinutes } from "./cron.js";
import { FileQueue, writeAtomically } from "./file-store.js";
import type { Logger } from "./history.js";

/** 每个群最多几个定时任务（在跑的和暂停的都算） */
export const MAX_PER_CHAT = 20;
/** 每个人最多建几个（所有群加起来，在跑的和暂停的都算） */
export const MAX_PER_CREATOR = 10;
/** 周期任务相邻两次最少隔几分钟 */
export const MIN_GAP_MINUTES = 60;
/** 每个群所有要干活的周期任务（不算纯提醒）加起来，每天最多跑几次：每次都要调模型、查东西 */
export const MAX_RUNS_PER_CHAT_PER_DAY = 48;
/** 到点交给机器人的那句话最多多少字 */
export const MAX_PROMPT_CHARS = 1000;
/** 一次性任务最远能定到多久以后 */
const MAX_AHEAD_MS = 366 * 24 * 60 * 60_000;
/** 连着失败几次自动暂停 */
export const MAX_FAILURES = 3;
/** 停机错过了的，多久以内重启后补跑一次；再晚的周期任务等下一次，一次性的在群里说一声错过了 */
export const GRACE_MS = 2 * 60 * 60_000;
/** 多久看一次有没有到点的 */
const TICK_MS = 30_000;
/** 同时最多跑几个定时任务，多的等下一轮再看 */
const MAX_RUNNING = 2;
/** 跑完、取消了的留着最近多少个（问「T3 跑了没有」时查得到），再早的删掉 */
const KEEP_FINISHED = 200;

/** 一次跑的结果：做完、出错、被停止（点了停止或者重启）、错过了（停机超过 GRACE_MS）、跳过（群不在白名单里了） */
export type RunResult = "done" | "failed" | "stopped" | "missed" | "skipped";

export interface ScheduleActor {
  openId: string;
  name?: string;
}

export interface ScheduledTask {
  id: number;
  chatId: string;
  /** 谁建的：到点按他的权限跑 */
  creator: ScheduleActor;
  /** 在哪条消息里建的 */
  messageId: string;
  createdAt: number;
  /** 到点交给机器人的话（写成一句能单独看懂的提问）；纯提醒时是提醒的内容 */
  prompt: string;
  /** 纯提醒：到点只发提醒、@ 建的人，不调模型 */
  remind?: boolean;
  /** 建的时候就没有改文档的工具（建的人不在写权限名单里、带着群聊建的）：到点也只给读的工具 */
  readOnly?: boolean;
  /** 周期任务的 cron（北京时间） */
  cron?: string;
  /** 一次性任务的时间 */
  at?: number;
  /** active 等着到点；paused 暂停了；finished 一次性的跑完了（或者错过了）；cancelled 取消了 */
  status: "active" | "paused" | "finished" | "cancelled";
  /** 下次几点跑（active 时才有） */
  nextRunAt?: number;
  runs: number;
  lastRunAt?: number;
  lastResult?: RunResult;
  /** 连着失败了几次 */
  failures: number;
  /** 暂停、恢复、取消的人和时间；连着失败自动暂停时没有人 */
  changedBy?: ScheduleActor & { at: number };
  /** 为什么暂停的：自己暂停的不写 */
  pausedFor?: "failures";
}

export interface CreateInput {
  chatId: string;
  creator: ScheduleActor;
  messageId: string;
  prompt: string;
  cron?: string;
  /** 北京时间「2026-10-22 15:00」 */
  at?: string;
  remind?: boolean;
  readOnly?: boolean;
}

export type ChangeAction = "pause" | "resume" | "cancel";

export interface SchedulerOptions {
  /** 定时任务记在这个文件里，重启后接着跑。不给就只记在内存里（测试用） */
  file?: string;
  /** 群不在白名单里了的不跑 */
  allowedChatIds: ReadonlySet<string>;
  /** 到点跑一次：发到群里、交给机器人做。late 是比该跑的时间晚了多久 */
  run: (task: ScheduledTask, late: number) => Promise<RunResult>;
  /** 在群里说一句（错过了、连着失败暂停了） */
  notify: (chatId: string, markdown: string) => Promise<unknown>;
  logger?: Logger;
  now?: () => number;
  tickMs?: number;
  maxRunning?: number;
}

interface State {
  nextId: number;
  tasks: ScheduledTask[];
}

/**
 * 定时任务：群里 @ 机器人说「每周一 9 点汇总上周进展」，模型调 schedule_create 建好记在文件里；
 * 每 30 秒看一次有没有到点的，到点在原来的群里发一条消息、按建的人的权限交给机器人做（见 index.ts）。
 * 先算好下一次的时间、写进文件再跑：跑到一半重启也不会重跑一遍
 */
export class Scheduler {
  private state: State = { nextId: 1, tasks: [] };
  private readonly running = new Set<number>();
  private readonly runs = new Set<Promise<void>>();
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly files = new FileQueue();
  private saveQueued = false;
  private lastSave: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: SchedulerOptions) {
    this.logger = opts.logger ?? console;
    this.now = opts.now ?? Date.now;
  }

  /** 读出重启前的定时任务。文件不在就是没有；读坏了先备份一份再从空的开始，免得下次写文件把它盖掉 */
  async init(): Promise<void> {
    const file = this.opts.file;
    if (!file) {
      return;
    }
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      return;
    }
    try {
      const state = JSON.parse(raw) as State;
      if (typeof state !== "object" || state === null || !Array.isArray(state.tasks)) {
        throw new Error("不是定时任务的格式");
      }
      const tasks = state.tasks.filter(isTask);
      this.state = { nextId: Math.max(Number(state.nextId) || 1, ...tasks.map((task) => task.id + 1)), tasks };
    } catch (err) {
      const backup = `${file}.bad-${this.now()}`;
      await copyFile(file, backup).catch(() => {});
      this.logger.error(`定时任务：${file} 读不出来，原文件备份成 ${backup}，从空的开始`, err);
      return;
    }
    const active = this.state.tasks.filter((task) => task.status === "active");
    for (const task of active) {
      // 文件里的时间不对（手改过、cron 写坏了）：按现在重新算
      if (typeof task.nextRunAt !== "number") {
        this.reschedule(task, this.now());
      }
    }
    this.logger.info(`定时任务：读出 ${active.length} 个等着到点的、${this.state.tasks.filter((task) => task.status === "paused").length} 个暂停的`);
  }

  /** 开始每 30 秒看一次（马上先看一次：停机时到点的接着处理） */
  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? TICK_MS);
    this.timer.unref();
    this.tick();
  }

  /** 不再看新到点的；正在跑的由任务队列停掉（见 index.ts 的 shutdown），这里等它们记完结果、写完文件 */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all(this.runs);
    await this.lastSave;
  }

  /** 等排着的写文件做完（测试用） */
  flush(): Promise<void> {
    return this.lastSave;
  }

  /** 建一个定时任务。时间不对、超过上限时抛错，错误信息是一句给模型看的中文 */
  create(input: CreateInput): ScheduledTask {
    const now = this.now();
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error("task 不能是空的：写清楚到点要做什么");
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`task 最多 ${MAX_PROMPT_CHARS} 字，现在 ${prompt.length} 字：只写到点要做的事，长的资料放进文档，task 里写文档链接`);
    }
    const cronText = input.cron?.trim();
    const atText = input.at?.trim();
    if (Boolean(cronText) === Boolean(atText)) {
      throw new Error("cron 和 at 要填一个，只填一个：周期任务填 cron，一次性的填 at");
    }
    const live = this.state.tasks.filter((task) => task.status === "active" || task.status === "paused");
    if (live.filter((task) => task.chatId === input.chatId).length >= MAX_PER_CHAT) {
      throw new Error(`这个群已经有 ${MAX_PER_CHAT} 个定时任务了（暂停的也算），先取消几个用不着的再建`);
    }
    if (live.filter((task) => task.creator.openId === input.creator.openId).length >= MAX_PER_CREATOR) {
      throw new Error(`每人最多建 ${MAX_PER_CREATOR} 个定时任务（几个群加起来，暂停的也算），${input.creator.name ?? "他"}已经建满了，先取消几个用不着的再建`);
    }
    let at: number | undefined;
    let nextRunAt: number;
    if (cronText) {
      const cron = parseCron(cronText);
      const next = nextRun(cron, now);
      if (next === undefined) {
        throw new Error(`cron「${cron.expr}」两年内一次都不会跑，检查一下日期和星期`);
      }
      const gap = shortestGapMinutes(cron, now);
      if (gap < MIN_GAP_MINUTES) {
        throw new Error(`周期任务两次之间至少隔 ${MIN_GAP_MINUTES} 分钟，cron「${cron.expr}」最短只隔 ${gap} 分钟`);
      }
      if (!input.remind) {
        const perDay = this.dailyRuns(input.chatId) + runsInWeek(cron, now) / 7;
        if (perDay > MAX_RUNS_PER_CHAT_PER_DAY) {
          throw new Error(
            `这个群的定时任务加起来每天最多跑 ${MAX_RUNS_PER_CHAT_PER_DAY} 次（纯提醒不算），加上这个就要每天约 ${Math.ceil(perDay)} 次了：放宽间隔，或者先取消几个`,
          );
        }
      }
      nextRunAt = next;
    } else {
      at = parseAt(atText!);
      if (at <= now) {
        throw new Error(`${formatTime(at, now)} 已经过了，现在是 ${formatTime(now, now)}`);
      }
      if (at - now > MAX_AHEAD_MS) {
        throw new Error("一次性任务最远定到一年以后");
      }
      nextRunAt = at;
    }
    const task: ScheduledTask = {
      id: this.state.nextId++,
      chatId: input.chatId,
      creator: input.creator,
      messageId: input.messageId,
      createdAt: now,
      prompt,
      ...(input.remind ? { remind: true } : {}),
      ...(input.readOnly ? { readOnly: true } : {}),
      ...(cronText ? { cron: parseCron(cronText).expr } : {}),
      ...(at !== undefined ? { at } : {}),
      status: "active",
      nextRunAt,
      runs: 0,
      failures: 0,
    };
    this.state.tasks.push(task);
    this.save();
    this.logger.info(
      `定时任务：建了 ${label(task)} chat=${task.chatId} creator=${task.creator.openId} ${describeSchedule(task)}${task.remind ? " 纯提醒" : ""} 下次=${formatTime(nextRunAt, now)}`,
    );
    return task;
  }

  /** 这个群的定时任务（在跑的和暂停的），按下次跑的时间排，暂停的排后面 */
  list(chatId: string): ScheduledTask[] {
    return this.state.tasks
      .filter((task) => task.chatId === chatId && (task.status === "active" || task.status === "paused"))
      .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.id - b.id);
  }

  /** 这个群最近跑完、取消了的几个，从新到旧 */
  recentlyEnded(chatId: string, limit: number): ScheduledTask[] {
    return this.state.tasks
      .filter((task) => task.chatId === chatId && (task.status === "finished" || task.status === "cancelled"))
      .sort((a, b) => (b.changedBy?.at ?? b.lastRunAt ?? b.createdAt) - (a.changedBy?.at ?? a.lastRunAt ?? a.createdAt))
      .slice(0, limit);
  }

  /** 只找这个群的：别的群的任务编号报不存在 */
  get(chatId: string, id: number): ScheduledTask | undefined {
    return this.state.tasks.find((task) => task.id === id && task.chatId === chatId);
  }

  /**
   * 暂停、恢复、取消。只有建的人和 canManageAll（写权限名单里的人，没配名单时是所有人）能做；
   * 别的群的、不存在的报找不到。做不了时抛错，错误信息是一句给模型看的中文
   */
  change(chatId: string, id: number, action: ChangeAction, actor: ScheduleActor, canManageAll: boolean): ScheduledTask {
    const task = this.get(chatId, id);
    if (!task) {
      throw new Error(`这个群里没有定时任务 T${id}，用 schedule_list 看看有哪些`);
    }
    if (task.creator.openId !== actor.openId && !canManageAll) {
      throw new Error(`定时任务 T${id} 是${task.creator.name ?? "别人"}建的，只有建的人和管理员（写权限名单里的人）能暂停、恢复、取消`);
    }
    if (task.status === "cancelled" || task.status === "finished") {
      throw new Error(`定时任务 T${id} 已经${task.status === "cancelled" ? "取消" : "跑完"}了，要的话重新建一个`);
    }
    const now = this.now();
    if (action === "pause") {
      if (task.status === "paused") {
        throw new Error(`定时任务 T${id} 已经是暂停的了`);
      }
      task.status = "paused";
      task.nextRunAt = undefined;
      delete task.pausedFor;
    } else if (action === "resume") {
      if (task.status === "active") {
        throw new Error(`定时任务 T${id} 没有暂停，下次 ${formatTime(task.nextRunAt!, now)} 跑`);
      }
      if (task.at !== undefined && task.at <= now) {
        throw new Error(`定时任务 T${id} 定的 ${formatTime(task.at, now)} 已经过了，要的话重新建一个`);
      }
      task.status = "active";
      task.failures = 0;
      delete task.pausedFor;
      this.reschedule(task, now);
    } else {
      task.status = "cancelled";
      task.nextRunAt = undefined;
    }
    task.changedBy = { ...actor, at: now };
    this.prune();
    this.save();
    this.logger.info(`定时任务：${label(task)} ${ACTION_LOG[action]} by=${actor.openId} chat=${chatId}`);
    return task;
  }

  /** 看一遍有没有到点的（定时器每 30 秒调一次，测试里直接调） */
  tick(): void {
    const now = this.now();
    const due = this.state.tasks
      .filter((task) => task.status === "active" && task.nextRunAt !== undefined && task.nextRunAt <= now && !this.running.has(task.id))
      .sort((a, b) => a.nextRunAt! - b.nextRunAt!);
    let changed = false;
    for (const task of due) {
      const scheduledAt = task.nextRunAt!;
      const late = now - scheduledAt;
      if (!this.opts.allowedChatIds.has(task.chatId)) {
        this.logger.warn(`定时任务：${label(task)} 所在的群 ${task.chatId} 不在白名单里了，这次不跑`);
        this.finishRun(task, now, "skipped");
        changed = true;
        continue;
      }
      if (late > GRACE_MS) {
        this.missed(task, scheduledAt, now);
        changed = true;
        continue;
      }
      if (this.running.size >= (this.opts.maxRunning ?? MAX_RUNNING)) {
        // 同时在跑的满了：留着，下一轮再看（晚得太久就算错过）
        continue;
      }
      this.fire(task, late, now);
      changed = true;
    }
    if (changed) {
      this.save();
    }
  }

  /** 这个群要干活的周期任务（在跑的，不算纯提醒）加起来每天约跑几次 */
  private dailyRuns(chatId: string): number {
    const now = this.now();
    return this.state.tasks
      .filter((task) => task.chatId === chatId && task.status === "active" && task.cron && !task.remind)
      .reduce((sum, task) => sum + runsInWeek(parseCron(task.cron!), now) / 7, 0);
  }

  /** 先算好下一次、记进文件再跑：跑到一半重启不会重跑 */
  private fire(task: ScheduledTask, late: number, now: number): void {
    this.advance(task, now);
    task.runs++;
    task.lastRunAt = now;
    this.running.add(task.id);
    this.logger.info(`定时任务：${label(task)} 到点了，开始跑 chat=${task.chatId}${late > 60_000 ? ` 晚了 ${Math.round(late / 60_000)} 分钟` : ""}`);
    const run = this.execute(task, late);
    this.runs.add(run);
    void run.finally(() => this.runs.delete(run));
  }

  private async execute(task: ScheduledTask, late: number): Promise<void> {
    let result: RunResult;
    try {
      result = await this.opts.run(task, late);
    } catch (err) {
      this.logger.error(`定时任务：${label(task)} 跑的时候出错 chat=${task.chatId}`, err);
      result = "failed";
    } finally {
      this.running.delete(task.id);
    }
    task.lastResult = result;
    if (result === "failed") {
      task.failures++;
    } else if (result === "done") {
      task.failures = 0;
    }
    this.logger.info(`定时任务：${label(task)} 跑完了，结果=${result}${task.failures > 0 ? ` 连着失败 ${task.failures} 次` : ""}`);
    if (result === "failed" && task.failures >= MAX_FAILURES && task.status === "active") {
      task.status = "paused";
      task.nextRunAt = undefined;
      task.pausedFor = "failures";
      this.logger.warn(`定时任务：${label(task)} 连着失败 ${task.failures} 次，自动暂停了`);
      await this.opts
        .notify(
          task.chatId,
          `⏸️ 定时任务 T${task.id}（${escapePost(describeSchedule(task))}）连着 ${task.failures} 次没跑成，先暂停了。查清原因后 @ 我说「恢复定时任务 T${task.id}」。`,
        )
        .catch((err: unknown) => this.logger.warn(`定时任务：${label(task)} 自动暂停的通知没发出去`, err));
    }
    this.save();
  }

  /** 停机错过了太久：周期任务等下一次，一次性的在群里说一声 */
  private missed(task: ScheduledTask, scheduledAt: number, now: number): void {
    this.finishRun(task, now, "missed");
    this.logger.warn(`定时任务：${label(task)} 本该 ${formatTime(scheduledAt, now)} 跑，机器人那会儿没在线，${task.at !== undefined ? "错过了" : "等下一次"}`);
    if (task.at === undefined) {
      return;
    }
    void this.opts
      .notify(
        task.chatId,
        `⏰ 定时任务 T${task.id} 本该在 ${formatTime(scheduledAt, now)} 跑（${escapePost(preview(task.prompt))}），那会儿机器人没在线，错过了。要的话 @ 我再建一次。`,
      )
      .catch((err: unknown) => this.logger.warn(`定时任务：${label(task)} 错过的通知没发出去`, err));
  }

  /** 这次不跑（跳过、错过了）：周期任务算到下一次，一次性的结束 */
  private finishRun(task: ScheduledTask, now: number, result: RunResult): void {
    this.advance(task, now);
    task.lastResult = result;
  }

  private advance(task: ScheduledTask, now: number): void {
    if (task.at !== undefined) {
      task.status = "finished";
      task.nextRunAt = undefined;
      this.prune();
      return;
    }
    this.reschedule(task, now);
  }

  /** 周期任务按 now 之后算下一次；一次性的就是定的时间。算不出来（cron 坏了、两年内没有）的暂停 */
  private reschedule(task: ScheduledTask, now: number): void {
    if (task.at !== undefined) {
      task.nextRunAt = task.at;
      return;
    }
    let next: number | undefined;
    try {
      next = task.cron ? nextRun(parseCron(task.cron), now) : undefined;
    } catch {
      next = undefined;
    }
    if (next === undefined) {
      this.logger.warn(`定时任务：${label(task)} 的时间算不出下一次（cron「${task.cron ?? ""}」），先暂停`);
      task.status = "paused";
      task.nextRunAt = undefined;
      return;
    }
    task.nextRunAt = next;
  }

  /** 跑完、取消了的只留最近 KEEP_FINISHED 个 */
  private prune(): void {
    const ended = this.state.tasks.filter((task) => task.status === "finished" || task.status === "cancelled");
    if (ended.length <= KEEP_FINISHED) {
      return;
    }
    const drop = new Set(ended.slice(0, ended.length - KEEP_FINISHED));
    this.state.tasks = this.state.tasks.filter((task) => !drop.has(task));
  }

  /** 写进文件（配了的话）。写失败只打警告：内存里照样跑，最多是重启后少了这次的改动 */
  private save(): void {
    const file = this.opts.file;
    if (!file || this.saveQueued) {
      return;
    }
    this.saveQueued = true;
    this.lastSave = this.files
      .run(file, () => {
        this.saveQueued = false;
        return writeAtomically(file, `${JSON.stringify(this.state, null, 2)}\n`);
      })
      .catch((err) => {
        this.saveQueued = false;
        this.logger.warn(`定时任务：写 ${file} 失败，重启后这次的改动会丢`, err);
      });
  }
}

const ACTION_LOG: Record<ChangeAction, string> = { pause: "暂停了", resume: "恢复了", cancel: "取消了" };

/** 定时任务的编号：T3 */
export function label(task: Pick<ScheduledTask, "id">): string {
  return `T${task.id}`;
}

/** 什么时间跑：「每周一 09:00」，一次性的「10-22（周三）15:00 一次」 */
export function describeSchedule(task: Pick<ScheduledTask, "cron" | "at">, now = Date.now()): string {
  if (task.at !== undefined) {
    return `${formatTime(task.at, now)} 一次`;
  }
  try {
    return describeCron(parseCron(task.cron ?? ""));
  } catch {
    return `cron「${task.cron ?? ""}」`;
  }
}

/** 列表、通知里显示的开头一段 */
export function preview(text: string, limit = 60): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= limit ? line : `${line.slice(0, limit)}…`;
}

/**
 * 发到群里的普通消息（post 的 md）会把 <at user_id="all"></at> 当成 @所有人：群成员写的、模型写的文字放进去之前，尖括号换成全角。
 * 只用在机器人自己拼的消息里（定时任务的通知），回答本身不走这里
 */
export function escapePost(text: string): string {
  return text.replace(/</g, "＜").replace(/>/g, "＞");
}

function isTask(value: unknown): value is ScheduledTask {
  const task = value as ScheduledTask;
  return (
    typeof task === "object" &&
    task !== null &&
    Number.isInteger(task.id) &&
    typeof task.chatId === "string" &&
    typeof task.creator?.openId === "string" &&
    typeof task.prompt === "string" &&
    ["active", "paused", "finished", "cancelled"].includes(task.status) &&
    (typeof task.cron === "string" || typeof task.at === "number")
  );
}

