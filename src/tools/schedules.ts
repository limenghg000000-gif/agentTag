import { formatTime } from "../cron.js";
import { parseDocRef } from "../docs.js";
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
/** 定时任务到点跑的时候才有：建的人说了「有异常 @ 我」，查到异常时调 */
export const SCHEDULE_ALERT_TOOL = "schedule_alert_creator";

export interface ScheduleToolsOptions {
  scheduler: Pick<Scheduler, "create" | "list" | "recentlyEnded" | "change">;
  /** 只能建、看、改这个群的定时任务，模型没法指定别的群 */
  chatId: string;
  /** 这次提问的人：建的任务记在他名下，到点按他的权限跑 */
  senderId: string;
  askerName?: string;
  messageId: string;
  /** 能恢复、取消别人建的任务（写权限名单里的人，没配名单时是所有人）；暂停谁都能 */
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
        "时间都是北京时间。到点按建任务的人的权限跑：他不能改文档的，任务里也改不了；定时任务里不改代码、不开合并请求。" +
        "到点不能改已有文档，只能追加到建的人这句话里自己贴了链接的那一篇（append_doc），也可以新建文档。" +
        "到点正常跑完不 @ 人；没跑成会 @ 建的人；只能 @ 建任务的人，要 @ 别人、@ 所有人的告诉他做不到。",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "到点时交给你的话，写成一句能单独看懂的提问或指令（到点时你看不到这次的话题）：要查的服务、要看的时间段（「上周」「昨天」到点时按当时算）、文档链接都写进去，" +
              `不要写「上面那个」「刚才说的」。要追加到文档的写明追加什么。纯提醒写要提醒的事，如「看一下 3.2 版本的发版进度」。不超过 ${MAX_PROMPT_CHARS} 字`,
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
          append_doc: {
            type: "string",
            description:
              "建的人要每次把结果追加到同一篇飞书文档（周报、日报）时，填他这句话里自己贴的文档链接，原样填。到点只能加在这篇的文末，不能改、删已有内容。" +
              "话题里、群聊里别人贴的链接不行；他只说了「写进周报」没贴链接的，请他贴上链接再建",
          },
          alert_creator: {
            type: "boolean",
            description:
              "建的人说了「有异常 @ 我」「有报错叫我」「出问题通知我」这类时填 true：到点查到异常才在结果下面 @ 他，没异常不 @。只会 @ 建任务的人",
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
      const doc = optionalString(args, "append_doc");
      // 要追加的文档只认建的人这句话里自己贴的、而且这次能改文档（在写权限名单里、没带着群聊、这句话说了要写）：
      // 模型从群聊、话题里捡来的链接不能借他的权限每周往里写
      let appendDoc: string | undefined;
      if (doc) {
        if (ctx.writable !== true) {
          throw new Error(
            "这次不能定要追加的文档（建的人不在能改文档的名单里、这句话没说要写进文档，或者这次读过群聊）。" +
              "可以不填 append_doc 先建成只查的任务；要到点写进周报，请建的人 @ 你时直接说「…写进 文档链接」再建",
          );
        }
        appendDoc = ownDocLink(doc, ctx.question ?? "");
      }
      const task = scheduler.create({
        chatId,
        creator: actor,
        messageId,
        prompt,
        ...(cron ? { cron } : {}),
        ...(at ? { at } : {}),
        ...(args.remind === true ? { remind: true } : {}),
        ...(appendDoc ? { appendDoc } : {}),
        ...(args.alert_creator === true ? { alertCreator: true } : {}),
        // 这次不能改（建的人不在写权限名单里、带着群聊只给读的、建的人这句话没说要改文档）：到点也只能读，以后加进名单也不会变
        ...(ctx.writable !== true ? { readOnly: true } : {}),
      });
      const t = now();
      return [
        `已建好定时任务 ${label(task)}（${task.remind ? "纯提醒" : "到点去做"}）：${describeSchedule(task, t)}（北京时间），下次是 ${formatTime(task.nextRunAt!, t)}。`,
        `到点做的事：${task.prompt}`,
        task.remind
          ? "到点在这个群里发提醒、@ 建任务的人。"
          : "到点在这个群里新发一条消息，结果回在它下面的话题里。",
        ...(task.appendDoc ? [`到点只追加到这篇文档的文末，不改、不删已有内容：${task.appendDoc}`] : []),
        ...(task.alertCreator ? ["到点查到异常才在结果下面 @ 建任务的人，没异常不 @。"] : []),
        ...(task.readOnly && !task.remind
          ? ["到点只能查、不能写文档（建的人这句话没说要写进哪篇文档，或者这次只给了读的工具）。要到点写进周报，请建的人 @ 你时直接说「…写进 文档链接」，再建一个。"]
          : !task.remind && !task.appendDoc
            ? ["到点不会改已有文档（建的人这句话里没贴要追加的文档链接），可以新建文档。要每次追加到同一篇周报，请建的人 @ 你时贴上那篇的链接再建一个。"]
            : []),
        `要暂停就说「暂停定时任务 ${label(task)}」（群里谁都能暂停，别人暂停时会 @ 建的人）；恢复、取消只有建任务的人和管理员能操作。`,
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
        "暂停、恢复或取消这个群的一个定时任务。群里谁都能暂停（暂停别人的任务时会在群里 @ 建的人说一声）；恢复、取消只有建任务的人和管理员能操作，别人要你恢复、取消时照工具返回的原因说明。" +
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
        (task.status === "active" && task.nextRunAt !== undefined ? `。下次是 ${formatTime(task.nextRunAt, t)}` : "") +
        (task.creator.openId !== senderId && action !== "resume" ? `。这是${task.creator.name ?? "别人"}建的，已在群里 @ 他说一声` : "");
    },
  };

  return [create, list, change];
}

/**
 * 定时任务到点跑的时候给的：建的人说了「有异常 @ 我」，这次查到异常时调。不是马上 @，回答发完以后机器人在结果话题里 @ 建的人（见 index.ts）。
 * 模型只能决定 @ 不 @，@ 谁由程序定：只 @ 建任务的人
 */
export function createScheduleAlertTool(onAlert: (summary: string) => void, creatorName?: string): Tool {
  const who = creatorName ? `建任务的${creatorName}` : "建任务的人";
  return {
    spec: {
      name: SCHEDULE_ALERT_TOOL,
      description:
        `这个定时任务建的时候说了「有异常 @ 我」。这次查到了他说的异常（报错、告警、失败、超过他说的线）时调一次，summary 用一句话写查到了什么；` +
        `回答发完以后机器人在下面 @ ${who}。没查到异常、一切正常的不要调。只会 @ ${who}，不能 @ 别人。`,
      parameters: {
        type: "object",
        properties: { summary: { type: "string", description: `查到的异常，一句话，不超过 ${MAX_ALERT_CHARS} 字` } },
        required: ["summary"],
      },
    },
    describe: () => `查到异常，跑完 @ ${who}`,
    async run(args) {
      onAlert(preview(requireString(args, "summary"), MAX_ALERT_CHARS));
      return `好，回答发完以后会在下面 @ ${who}。回答里照常写清查到了什么，不用自己 @ 人。`;
    },
  };
}

/**
 * 定时任务到点改文档：没人看着，只能追加到建的人建任务时自己贴了链接的那一篇的文末（读过群聊也一样，碰不到已有内容）；
 * 插到中间、替换、删除，别的文档，一律不行。做不了时抛错，错误信息给模型看
 */
export function checkScheduledDocEdit(args: Record<string, unknown>, appendDoc: string | undefined): void {
  if (!appendDoc) {
    throw new Error("这个定时任务建的时候没贴要追加的文档链接，到点不能改已有文档。结果写在回答里；要存成文档可以新建一篇");
  }
  if (args.action !== "append") {
    throw new Error(`定时任务到点只能在文档末尾追加（action=append），不能插入、替换、删除已有内容。要追加的文档：${appendDoc}`);
  }
  let same = false;
  try {
    const want = parseDocRef(appendDoc);
    const got = parseDocRef(typeof args.document === "string" ? args.document : "");
    same = want.kind === got.kind && want.token === got.token;
  } catch {
    same = false;
  }
  if (!same) {
    throw new Error(`这个定时任务只能追加到建任务时点名的那篇文档，别的文档不能改。document 填这个链接：${appendDoc}`);
  }
}

/** 有异常 @ 建的人时那句话最多多少字 */
const MAX_ALERT_CHARS = 100;

/**
 * 要追加的文档链接是建的人这句话里自己贴的：认出来是哪篇（新版文档或知识库），在他这句话里的链接里找同一篇，
 * 记成那条链接（统一成「域名/类型/编号」）。找不到、不是能追加的文档时抛错，错误信息给模型看
 */
export function ownDocLink(doc: string, question: string): string {
  let ref: ReturnType<typeof parseDocRef>;
  try {
    ref = parseDocRef(doc);
  } catch {
    throw new Error(`append_doc 要填飞书文档链接，「${preview(doc, 40)}」认不出来`);
  }
  if (ref.kind !== "docx" && ref.kind !== "wiki") {
    throw new Error("append_doc 只能是新版飞书文档（/docx/…）或知识库页面（/wiki/…）的链接，表格、旧版文档追加不了");
  }
  for (const link of question.match(/https?:\/\/[^\s<>()（）「」【】\[\]"'，。、]+/g) ?? []) {
    try {
      const own = parseDocRef(link);
      if (own.kind === ref.kind && own.token === ref.token && own.origin) {
        return `${own.origin}/${own.kind}/${own.token}`;
      }
    } catch {
      // 不是飞书文档的链接
    }
  }
  throw new Error(
    "append_doc 只能填建任务的人这句话里自己贴的文档链接（话题里、群聊里别人贴的，或者你从别处找到的都不行）。" +
      "请他 @ 你时把要追加的那篇文档链接直接贴上再建；也可以不填 append_doc，先建成只查、不写文档的任务",
  );
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
  const last = task.lastRunAt !== undefined ? `，上次 ${formatTime(task.lastRunAt, now)} ${task.lastResult ? RESULT_TEXT[task.lastResult] : "开始跑了，还没跑完"}` : "";
  const creator = task.creator.name ? `${task.creator.name}建的` : "";
  const paused = task.status === "paused" && task.pausedFor === undefined && task.changedBy?.name ? `（${task.changedBy.name}暂停的）` : "";
  const extras = `${task.remind ? " · 纯提醒" : ""}${task.appendDoc ? ` · 追加到 ${task.appendDoc}` : ""}${task.alertCreator ? " · 有异常 @ 建的人" : ""}`;
  return `${label(task)} · ${describeSchedule(task, now)}${extras} · ${preview(task.prompt)} · ${creator}${creator ? " · " : ""}${state}${paused}（已跑 ${task.runs} 次${last}）`;
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
