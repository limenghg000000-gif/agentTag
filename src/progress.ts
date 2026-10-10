import { escapeCardMarkdown } from "./markdown.js";

/** 卡片上停止按钮回传的值 */
export const STOP_ACTION = "stop_task";

export interface ProgressStep {
  id: string;
  label: string;
  status: "running" | "ok" | "error";
}

export type ProgressPhase = "queued" | "thinking" | "done" | "stopped" | "failed";

export interface ProgressState {
  phase: ProgressPhase;
  steps: ProgressStep[];
  startedAt: number;
  endedAt?: number;
}

/** 卡片上最多列出几步，更早的合成一行 */
const MAX_VISIBLE_STEPS = 12;

/**
 * 进度卡片（飞书卡片 JSON 2.0）。进行中：当前状态 + 已执行的步骤 + 停止按钮；
 * 结束后收成一行结果，步骤放进默认折叠的面板里，按钮去掉。
 */
export function renderProgressCard(state: ProgressState, taskId: string, now = Date.now()): object {
  const finished = state.phase === "done" || state.phase === "stopped" || state.phase === "failed";
  const elements: object[] = [];
  if (!finished) {
    elements.push({ tag: "markdown", content: [statusLine(state), ...stepLines(state.steps)].join("\n") });
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "停止" },
      type: "danger",
      size: "small",
      behaviors: [{ type: "callback", value: { action: STOP_ACTION, task: taskId } }],
    });
  } else if (state.steps.length === 0) {
    elements.push({ tag: "markdown", content: summaryLine(state, now) });
  } else {
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: { tag: "markdown", content: summaryLine(state, now) },
        icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
        icon_position: "right",
        icon_expanded_angle: -180,
      },
      elements: [{ tag: "markdown", content: stepLines(state.steps).join("\n") }],
    });
  }
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: finished ? summaryText(state.phase) : "处理中…" } },
    body: { elements },
  };
}

/** 折叠面板渲染不了时（比如飞书客户端太旧导致更新失败）用的简单版本 */
export function renderPlainProgressCard(state: ProgressState, now = Date.now()): object {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: summaryText(state.phase) } },
    body: { elements: [{ tag: "markdown", content: [summaryLine(state, now), ...stepLines(state.steps)].join("\n") }] },
  };
}

function statusLine(state: ProgressState): string {
  if (state.phase === "queued") {
    return "⏳ 排队中：等这个话题里上一个任务完成";
  }
  return state.steps.some((step) => step.status === "running") ? "⏳ 正在执行…" : "⏳ 思考中…";
}

function summaryText(phase: ProgressPhase): string {
  return { queued: "排队中", thinking: "处理中…", done: "已完成", stopped: "已停止", failed: "出错了" }[phase];
}

function summaryLine(state: ProgressState, now: number): string {
  const icon = { queued: "⏳", thinking: "⏳", done: "✅", stopped: "⏹️", failed: "⚠️" }[state.phase];
  const parts = [`${icon} ${summaryText(state.phase)}`];
  if (state.steps.length > 0) {
    parts.push(`${state.steps.length} 步`);
  }
  parts.push(`用时 ${formatDuration((state.endedAt ?? now) - state.startedAt)}`);
  return parts.join(" · ");
}

function stepLines(steps: ProgressStep[]): string[] {
  const hidden = Math.max(0, steps.length - MAX_VISIBLE_STEPS);
  const icon = { running: "▶️", ok: "✔️", error: "❌" };
  return [
    ...(hidden > 0 ? [`…前面还有 ${hidden} 步`] : []),
    ...steps.slice(hidden).map((step) => `${icon[step.status]} ${escapeCardMarkdown(step.label)}`),
  ];
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export type PatchCard = (card: object) => Promise<void>;

/**
 * 把进度更新推到已发出的卡片上。飞书对同一条消息的更新有频率限制，这里合并短时间内的多次更新，
 * 同一时间只有一个请求在途，间隔至少 minIntervalMs。更新失败只记日志，不影响任务本身。
 */
export class CardUpdater {
  private pending?: object;
  private running?: Promise<void>;
  private lastAt = 0;
  private closed = false;

  constructor(
    private readonly patch: PatchCard,
    private readonly logger: Pick<Console, "error"> = console,
    private readonly minIntervalMs = 1000,
  ) {}

  update(card: object): void {
    if (this.closed) {
      return;
    }
    this.pending = card;
    this.kick();
  }

  /** 推送最终状态并等它完成。失败时再试一次 fallback（如果给了） */
  async finish(card: object, fallback?: object): Promise<void> {
    this.closed = true;
    this.pending = undefined;
    while (this.running) {
      await this.running;
    }
    await this.wait();
    try {
      await this.patch(card);
    } catch (err) {
      if (!fallback) {
        this.logger.error("更新进度卡片失败", err);
        return;
      }
      try {
        await this.patch(fallback);
      } catch (err2) {
        this.logger.error("更新进度卡片失败", err2);
      }
    }
  }

  private kick(): void {
    if (this.running || !this.pending) {
      return;
    }
    this.running = this.drain().finally(() => {
      this.running = undefined;
      this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      await this.wait();
      const card = this.pending;
      this.pending = undefined;
      if (!card) {
        return;
      }
      this.lastAt = Date.now();
      try {
        await this.patch(card);
      } catch (err) {
        this.logger.error("更新进度卡片失败", err);
      }
    }
  }

  private async wait(): Promise<void> {
    const delay = this.lastAt + this.minIntervalMs - Date.now();
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
