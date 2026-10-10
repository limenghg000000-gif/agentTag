/** 卡片上停止按钮回传的值 */
export const STOP_ACTION = "stop_task";

export interface ProgressStep {
  id: string;
  label: string;
  status: "running" | "ok" | "error";
}

/** 模型一轮的思考内容 */
export interface ProgressThought {
  /** 第几轮模型调用（从 1 开始） */
  round: number;
  /** 这一轮模型调用的用时 */
  ms: number;
  text: string;
  /** 想完时卡片上已经有几步：排在第 at 步前面（下标从 0 开始），后面跟着这一轮去调的工具 */
  at: number;
}

export type ProgressPhase = "queued" | "thinking" | "done" | "stopped" | "failed";

export interface ProgressState {
  phase: ProgressPhase;
  steps: ProgressStep[];
  /** 模型每轮的思考，没有就不显示 */
  thoughts?: ProgressThought[];
  startedAt: number;
  endedAt?: number;
}

/** 卡片上最多列出几步，更早的合成一行 */
const MAX_VISIBLE_STEPS = 12;
/** 进行中只显示最新一段思考，最多这么多字 */
const LIVE_THOUGHT_CHARS = 800;
/** 结束后折叠面板里每段思考最多这么多字 */
const MAX_THOUGHT_CHARS = 1500;
/** 飞书卡片最大 30 KB，带样式的标签展开后比请求体还长，留些余量；超了就从最早的一段思考开始去掉正文 */
export const MAX_CARD_BYTES = 24_000;
const THOUGHT_NOTE = "💭 是模型的思考草稿，里面的猜测没有核实，结论以回答为准";

/**
 * 进度卡片（飞书卡片 JSON 2.0）。进行中：当前状态 + 已执行的步骤 + 最新一段思考 + 停止按钮；
 * 结束后收成一行结果，步骤和每轮的思考按先后放进默认折叠的面板里，按钮去掉。
 */
export function renderProgressCard(state: ProgressState, taskId: string, now = Date.now()): object {
  const total = state.thoughts?.length ?? 0;
  const fits = (card: object) => Buffer.byteLength(JSON.stringify(card)) <= MAX_CARD_BYTES;
  // 卡片太大时从最早的一段思考开始，只留标题、去掉正文，直到放得下
  let omitted = 0;
  let card = buildProgressCard(state, taskId, now, omitted);
  while (omitted < total && !fits(card)) {
    card = buildProgressCard(state, taskId, now, ++omitted);
  }
  // 正文全去掉还放不下（步骤太多、步骤名很长）：不显示思考，和以前一样只列最近的步骤
  return total > 0 && !fits(card) ? buildProgressCard({ ...state, thoughts: undefined }, taskId, now, 0) : card;
}

/** omitted：最早的几段思考只显示标题、不显示正文 */
function buildProgressCard(state: ProgressState, taskId: string, now: number, omitted: number): object {
  const finished = state.phase === "done" || state.phase === "stopped" || state.phase === "failed";
  const thoughts = state.thoughts ?? [];
  const elements: object[] = [];
  if (!finished) {
    elements.push({ tag: "markdown", content: [statusLine(state), ...stepLines(state.steps)].join("\n") });
    const latest = thoughts.at(-1);
    if (latest && omitted < thoughts.length) {
      elements.push(thoughtElement(`💭 最新的思考（${roundLabel(latest)}，草稿，结论以回答为准）`, clip(latest.text, LIVE_THOUGHT_CHARS)));
    }
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "停止" },
      type: "danger",
      size: "small",
      behaviors: [{ type: "callback", value: { action: STOP_ACTION, task: taskId } }],
    });
  } else if (state.steps.length === 0 && thoughts.length === 0) {
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
      elements: thoughts.length === 0 ? [{ tag: "markdown", content: stepLines(state.steps).join("\n") }] : timeline(state.steps, thoughts, omitted),
    });
  }
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: finished ? summaryText(state.phase) : "处理中…" } },
    body: { elements },
  };
}

/** 结束后面板里按先后排：每段思考后面跟着这一轮调的工具。步骤全部列出（面板是折叠的） */
function timeline(steps: ProgressStep[], thoughts: ProgressThought[], omitted: number): object[] {
  const elements: object[] = [{ tag: "markdown", text_size: "notation", content: THOUGHT_NOTE }];
  let next = 0;
  const flushSteps = (until: number) => {
    if (until > next) {
      elements.push({ tag: "markdown", content: stepLines(steps.slice(next, until), steps.length).join("\n") });
      next = until;
    }
  };
  thoughts.forEach((thought, i) => {
    flushSteps(Math.min(thought.at, steps.length));
    const title = `💭 ${roundLabel(thought)}`;
    elements.push(i < omitted ? thoughtElement(title, "（太长，卡片里放不下）") : thoughtElement(title, clip(thought.text, MAX_THOUGHT_CHARS)));
  });
  flushSteps(steps.length);
  return elements;
}

function thoughtElement(title: string, text: string): object {
  return { tag: "markdown", text_size: "notation", content: `**${title}**\n${escapeMarkdown(text)}` };
}

function roundLabel(thought: ProgressThought): string {
  return `第 ${thought.round} 轮，${formatDuration(thought.ms)}`;
}

/** 太长时留开头一小段和结尾（想到最后决定做什么），中间省略。按字符切，不把 emoji 切成两半 */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) {
    return text;
  }
  const head = Math.floor(max / 3);
  const tail = max - head;
  return `${chars.slice(0, head).join("")}\n…（中间省略 ${chars.length - max} 字）…\n${chars.slice(chars.length - tail).join("")}`;
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

/** limit：最多列出几步，更早的合成一行 */
function stepLines(steps: ProgressStep[], limit = MAX_VISIBLE_STEPS): string[] {
  const hidden = Math.max(0, steps.length - limit);
  const icon = { running: "▶️", ok: "✔️", error: "❌" };
  return [
    ...(hidden > 0 ? [`…前面还有 ${hidden} 步`] : []),
    ...steps.slice(hidden).map((step) => `${icon[step.status]} ${escapeMarkdown(step.label)}`),
  ];
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** 步骤说明里的尖括号会被卡片当成标签（如 <at>、<font>），转成实体 */
function escapeMarkdown(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
