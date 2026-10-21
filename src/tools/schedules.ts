import { formatTime } from "../cron.js";
import {
  type ChangeAction,
  describeSchedule,
  label,
  MAX_PROMPT_CHARS,
  MIN_GAP_MINUTES,
  preview,
  type ScheduledTask,
  type Scheduler,
} from "../schedules.js";
import type { Tool } from "./tool.js";

export const SCHEDULE_CREATE_TOOL = "schedule_create";
export const SCHEDULE_LIST_TOOL = "schedule_list";
export const SCHEDULE_CHANGE_TOOL = "schedule_change";
export const SCHEDULE_TOOL_NAMES = [SCHEDULE_CREATE_TOOL, SCHEDULE_LIST_TOOL, SCHEDULE_CHANGE_TOOL] as const;

export interface ScheduleToolsOptions {
  scheduler: Pick<Scheduler, "create" | "list" | "recentlyEnded" | "change">;
  /** 只能建、看、改这个群的定时任务，模型没法指定别的群 */
  chatId: string;
  /** 这次提问的人：建的任务记在他名下，到点按他的权限跑 */
  senderId: string;
  askerName?: string;
  messageId: string;
  /** 能暂停、恢复、取消别人建的任务（写权限名单里的人，没配名单时是所有人） */
  canManageAll: boolean;
  now?: () => number;
}

const ACTION_DONE: Record<ChangeAction, string> = { pause: "已暂停", resume: "已恢复", cancel: "已取消" };

/** 当前群的定时任务工具：建、看、暂停恢复取消。每个任务按所在的群和提问的人单独创建一套 */
export function createScheduleTools(opts: ScheduleToolsOptions): Tool[] {
  const { scheduler, chatId, senderId, askerName, messageId, canManageAll, now = Date.now } = opts;
  const actor = { openId: senderId, ...(askerName ? { name: askerName } : {}) };

  const create: Tool = {
    spec: {
      name: SCHEDULE_CREATE_TOOL,
      description:
        "建一个定时任务：到点（或按周期）在这个群里新发一条消息，由你按 task 去做，结果回在那条消息下面的话题里；纯提醒（remind=true）到点只发提醒、@ 建任务的人，不去查也不去做。" +
        "只在群成员这句话明确要你在以后某个时间、或者定期做某件事时用（「每周一 9 点汇总上周进展」「明天下午 3 点提醒我看发版」「工作日每天 10 点查一下昨晚的报错」）。" +
        "时间都是北京时间。到点按建任务的人的权限跑：他不能改文档的，任务里也改不了；定时任务里不改代码、不开合并请求。",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "到点时交给你的话，写成一句能单独看懂的提问或指令（到点时你看不到这次的话题）：要查的服务、要看的时间段（「上周」「昨天」到点时按当时算）、文档链接都写进去，" +
              `不要写「上面那个」「刚才说的」。要改文档的写明改哪篇、怎么改。纯提醒写要提醒的事，如「看一下 3.2 版本的发版进度」。不超过 ${MAX_PROMPT_CHARS} 字`,
          },
          cron: {
            type: "string",
            description:
              "周期任务填 5 段 cron：分 时 日 月 星期（星期 0 或 7 是周日）。每周一 9 点「0 9 * * 1」，工作日 10:30「30 10 * * 1-5」，每天 9 点和 18 点「0 9,18 * * *」，" +
              `每月 1 号 10 点「0 10 1 * *」，每 2 小时「0 */2 * * *」。两次之间至少隔 ${MIN_GAP_MINUTES} 分钟。和 at 只填一个`,
          },
          at: {
            type: "string",
            description: "一次性任务填北京时间，写成「2026-10-22 15:00」。「明天」「下周一」按现在的时间换算成日期。和 cron 只填一个",
          },
          remind: {
            type: "boolean",
            description: "只是到点提醒一句、不用你去查去做时填 true（「提醒我…」「到点叫一下大家…」）；要你到点去查、去汇总、去写的不填",
          },
        },
        required: ["task"],
      },
    },
    describe: (args) => `建定时任务：${typeof args.task === "string" ? preview(args.task, 30) : ""}`,
    async run(args, ctx) {
      const prompt = requireString(args, "task");
      const cron = optionalString(args, "cron");
      const at = optionalString(args, "at");
      const task = scheduler.create({
        chatId,
        creator: actor,
        messageId,
        prompt,
        ...(cron ? { cron } : {}),
        ...(at ? { at } : {}),
        ...(args.remind === true ? { remind: true } : {}),
        // 这次没有改文档的工具（建的人不在写权限名单里、带着群聊只给读的）：到点也只能读，以后加进名单也不会变
        ...(ctx.writable !== true ? { readOnly: true } : {}),
      });
      const t = now();
      return [
        `已建好定时任务 ${label(task)}（${task.remind ? "纯提醒" : "到点去做"}）：${describeSchedule(task, t)}（北京时间），下次是 ${formatTime(task.nextRunAt!, t)}。`,
        `到点做的事：${task.prompt}`,
        task.remind
          ? "到点在这个群里发提醒、@ 建任务的人。"
          : "到点在这个群里新发一条消息，结果回在它下面的话题里。",
        `要暂停或取消就说「暂停定时任务 ${label(task)}」「取消定时任务 ${label(task)}」（建任务的人和管理员能操作）。`,
      ].join("\n");
    },
  };

  const list: Tool = {
    spec: {
      name: SCHEDULE_LIST_TOOL,
      description: "列出这个群的定时任务：编号、什么时间跑、做什么、谁建的、下次几点跑、上次跑得怎么样，以及最近跑完和取消了的几个。",
      parameters: { type: "object", properties: {} },
    },
    describe: () => "看这个群的定时任务",
    async run() {
      const t = now();
      const live = scheduler.list(chatId);
      const ended = scheduler.recentlyEnded(chatId, 5);
      if (live.length === 0 && ended.length === 0) {
        return "这个群还没有定时任务。";
      }
      return [
        live.length > 0 ? `这个群有 ${live.length} 个定时任务：` : "这个群现在没有在跑的定时任务。",
        ...live.map((task) => `- ${describeTask(task, t)}`),
        ...(ended.length > 0 ? ["最近跑完、取消了的：", ...ended.map((task) => `- ${describeTask(task, t)}`)] : []),
      ].join("\n");
    },
  };

  const change: Tool = {
    spec: {
      name: SCHEDULE_CHANGE_TOOL,
      description:
        "暂停、恢复或取消这个群的一个定时任务。只有建任务的人和管理员能操作，别人要你停时照工具返回的原因说明。" +
        "要改时间或内容的：先用 schedule_create 按新的建一个，再取消旧的，两个编号都告诉对方。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "定时任务编号，如 T3（写 3 也行）" },
          action: { type: "string", enum: ["pause", "resume", "cancel"], description: "pause 暂停、resume 恢复、cancel 取消" },
        },
        required: ["id", "action"],
      },
    },
    describe: (args) => `${args.action === "cancel" ? "取消" : args.action === "pause" ? "暂停" : "恢复"}定时任务 ${String(args.id ?? "")}`,
    async run(args) {
      const id = requireId(args.id);
      const action = args.action;
      if (action !== "pause" && action !== "resume" && action !== "cancel") {
        throw new Error("action 只能是 pause、resume 或 cancel");
      }
      const task = scheduler.change(chatId, id, action, actor, canManageAll);
      const t = now();
      return `${ACTION_DONE[action]}定时任务 ${label(task)}：${describeSchedule(task, t)}，${preview(task.prompt)}` +
        (task.status === "active" && task.nextRunAt !== undefined ? `。下次是 ${formatTime(task.nextRunAt, t)}` : "");
    },
  };

  return [create, list, change];
}

/** 列表里的一行 */
function describeTask(task: ScheduledTask, now: number): string {
  const state =
    task.status === "active"
      ? `下次 ${formatTime(task.nextRunAt!, now)}`
      : task.status === "paused"
        ? task.pausedFor === "failures"
          ? "连着失败，自动暂停了"
          : "已暂停"
        : task.status === "cancelled"
          ? "已取消"
          : "跑完了";
  const last = task.lastRunAt !== undefined ? `，上次 ${formatTime(task.lastRunAt, now)} ${RESULT_TEXT[task.lastResult ?? "done"]}` : "";
  const creator = task.creator.name ? `${task.creator.name}建的` : "";
  return `${label(task)} · ${describeSchedule(task, now)}${task.remind ? " · 纯提醒" : ""} · ${preview(task.prompt)} · ${creator}${creator ? " · " : ""}${state}（已跑 ${task.runs} 次${last}）`;
}

const RESULT_TEXT: Record<string, string> = {
  done: "跑完了",
  failed: "没跑成",
  stopped: "被停止了",
  missed: "机器人没在线、错过了",
  skipped: "没跑（群不在白名单里）",
};

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`缺少参数 ${key}`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function requireId(value: unknown): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const match = /^(?:T|#)?\s*(\d+)$/i.exec(text);
  if (!match) {
    throw new Error("id 要写定时任务编号，如 T3");
  }
  return Number(match[1]);
}
