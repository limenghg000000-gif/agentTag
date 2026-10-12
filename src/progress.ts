import { stripThinkTags } from "./llm.js";

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
  /** 卡片即回答：模型这一轮到目前为止的思考和正文，边生成边显示。这一轮结束时清掉 */
  live?: { round: number; reasoning: string; text: string };
  /** 卡片即回答：卡片里的回答。进行中是最后一轮给出的那版（还没检查完），结束后是最终的回答 */
  answer?: string;
  /** 卡片即回答：还没有回答可显示时，回答位置上的说明（比如上一版没通过检查、正在重做） */
  answerNote?: string;
}

export interface CardOptions {
  /**
   * 卡片即回答：卡片是飞书的卡片实体，回答写在卡片里。进行中的状态、思考、回答各是一个带 element_id 的组件，
   * 模型生成时按组件流式更新（打字机效果），见 StreamingCard
   */
  streaming?: boolean;
}

/** 流式卡片里各组件的 element_id */
export const ELEMENT = { status: "status", thought: "thought", answer: "answer", stop: "stop" } as const;

/** 卡片上最多列出几步，更早的合成一行 */
const MAX_VISIBLE_STEPS = 12;
/** 进行中只显示最新一段思考，最多这么多字 */
const LIVE_THOUGHT_CHARS = 800;
/** 结束后折叠面板里每段思考最多这么多字 */
const MAX_THOUGHT_CHARS = 1500;
/** 飞书卡片最大 30 KB，带样式的标签展开后比请求体还长，留些余量；超了就从最早的一段思考开始去掉正文 */
export const MAX_CARD_BYTES = 24_000;
const THOUGHT_NOTE = "💭 是模型的思考草稿，里面的猜测没有核实，结论以回答为准";
/** 卡片里的回答最多这么多字：再长卡片放不下（还要放步骤和思考），卡片里只显示开头，全文另外发 */
export const MAX_CARD_ANSWER_CHARS = 4000;
const ANSWER_CONTINUED = "…（回答较长，全文另外发在下面）";
/** 打字机效果：每 50 毫秒出 2 个字；新内容到了就把还没打完的先显示出来（fast），不落后于模型 */
const STREAMING_CONFIG = { print_frequency_ms: { default: 50 }, print_step: { default: 2 }, print_strategy: "fast" };
/** 结束后消息列表里的预览：回答的开头 */
const SUMMARY_CHARS = 50;

/**
 * 进度卡片（飞书卡片 JSON 2.0）。进行中：当前状态 + 已执行的步骤 + 最新一段思考 + 停止按钮；
 * 结束后收成一行结果，步骤和每轮的思考按先后放进默认折叠的面板里，按钮去掉。
 */
export function renderProgressCard(state: ProgressState, taskId: string, now = Date.now(), options: CardOptions = {}): object {
  const total = state.thoughts?.length ?? 0;
  const fits = (card: object) => Buffer.byteLength(JSON.stringify(card)) <= MAX_CARD_BYTES;
  // 卡片太大时从最早的一段思考开始，只留标题、去掉正文，直到放得下
  let omitted = 0;
  let card = buildProgressCard(state, taskId, now, omitted, options);
  while (omitted < total && !fits(card)) {
    card = buildProgressCard(state, taskId, now, ++omitted, options);
  }
  // 正文全去掉还放不下（步骤太多、步骤名很长）：不显示思考，和以前一样只列最近的步骤
  return total > 0 && !fits(card) ? buildProgressCard({ ...state, thoughts: undefined }, taskId, now, 0, options) : card;
}

/** omitted：最早的几段思考只显示标题、不显示正文 */
function buildProgressCard(state: ProgressState, taskId: string, now: number, omitted: number, { streaming }: CardOptions): object {
  const finished = isFinished(state);
  const thoughts = state.thoughts ?? [];
  const id = (elementId: string) => (streaming ? { element_id: elementId } : {});
  const elements: object[] = [];
  if (!finished) {
    elements.push({ tag: "markdown", ...id(ELEMENT.status), content: [statusLine(state), ...stepLines(state.steps)].join("\n") });
    const live = streaming ? state.live : undefined;
    const latest = thoughts.at(-1);
    if (live?.reasoning) {
      const title = `💭 第 ${live.round} 轮，正在想…（草稿，结论以回答为准）`;
      elements.push({ ...thoughtElement(title, clip(live.reasoning, LIVE_THOUGHT_CHARS)), ...id(ELEMENT.thought) });
    } else if (latest && omitted < thoughts.length) {
      const title = `💭 最新的思考（${roundLabel(latest)}，草稿，结论以回答为准）`;
      elements.push({ ...thoughtElement(title, clip(latest.text, LIVE_THOUGHT_CHARS)), ...id(ELEMENT.thought) });
    }
    const answer = streaming ? (liveText(state) || state.answerNote || state.answer) : undefined;
    if (answer) {
      elements.push(answerElement(answer));
    }
    elements.push({
      tag: "button",
      ...id(ELEMENT.stop),
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
  if (streaming && finished && state.answer) {
    elements.push(answerElement(state.answer));
  }
  return { schema: "2.0", config: cardConfig(state, streaming), body: { elements } };
}

function isFinished(state: ProgressState): boolean {
  return state.phase === "done" || state.phase === "stopped" || state.phase === "failed";
}

/**
 * streaming_mode：开着时组件才能流式更新（打字机效果），但卡片上的按钮可能点不了，所以只在模型写回答时开；
 * 想的时候（开着深度思考能想好几分钟）和调工具时关着，思考按全量更新刷新，停止按钮能点（实际开关由 StreamingCard 调接口）。
 * 卡片即回答时，结束后消息列表里的预览是回答的开头
 */
function cardConfig(state: ProgressState, streaming: boolean | undefined): object {
  const finished = isFinished(state);
  const preview = streaming && finished && state.answer ? previewOf(state.answer) : undefined;
  return {
    update_multi: true,
    ...(streaming ? { streaming_mode: !finished && liveText(state) !== "", streaming_config: STREAMING_CONFIG } : {}),
    summary: { content: preview || (finished ? summaryText(state.phase) : "处理中…") },
  };
}

function previewOf(answer: string): string {
  const chars = Array.from(answer.replace(/\s+/g, " ").trim());
  return chars.length <= SUMMARY_CHARS ? chars.join("") : `${chars.slice(0, SUMMARY_CHARS - 1).join("")}…`;
}

/** 模型这一轮已经写出来的正文。还在 <think> 标签里（有的模型把思考写在正文里）的不算 */
function liveText(state: ProgressState): string {
  const text = state.live?.text ?? "";
  if (/^\s*<think>/.test(text) && !text.includes("</think>")) {
    return "";
  }
  return stripThinkTags(text);
}

/** 卡片里的回答：太长时只放开头，后面说明全文另外发 */
function answerElement(answer: string): object {
  return { tag: "markdown", element_id: ELEMENT.answer, content: escapeAnswer(clipAnswer(answer)) };
}

/** 回答能不能完整放进卡片。放不下时卡片里只有开头，要另外发全文 */
export function answerFitsCard(answer: string): boolean {
  return Array.from(answer).length <= MAX_CARD_ANSWER_CHARS;
}

function clipAnswer(answer: string): string {
  if (answerFitsCard(answer)) {
    return answer;
  }
  const head = Array.from(answer).slice(0, MAX_CARD_ANSWER_CHARS).join("");
  // 切在代码块中间时先把代码块合上，不然后面的说明也显示成代码
  let open: string | undefined;
  for (const line of head.split("\n")) {
    open = nextFence(open, line).fence;
  }
  return `${head}${open ? `\n${open}` : ""}\n\n${ANSWER_CONTINUED}`;
}

/**
 * 代码块开头：3 个以上反引号或波浪号；反引号开头的后面不能再有反引号（```x``` 是行内代码）。
 * 前面的空白不限（列表里的代码块会缩进）：认错了也只是代码块里的 < 不转义，<at 在代码块里照样转义
 */
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})(.*?)\r?$/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?$/;

/** 按 CommonMark 的规则走一行：返回这一行之后还在不在代码块里（fence 是开头那串符号），以及这一行是不是代码块的开头或结尾 */
function nextFence(fence: string | undefined, line: string): { fence: string | undefined; marker: boolean } {
  if (fence) {
    const close = FENCE_CLOSE.exec(line)?.[1];
    return close && close[0] === fence[0] && close.length >= fence.length ? { fence: undefined, marker: true } : { fence, marker: false };
  }
  const open = FENCE_OPEN.exec(line);
  if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
    return { fence: open[1], marker: true };
  }
  return { fence: undefined, marker: false };
}

/**
 * 回答里的 < 转义：卡片会把 <at>、<font> 当成标签，工具结果里冒充的 <at id=all></at> 会变成 @所有人。
 * 代码块里照原样显示（代码里 < 很常见），只把 <at 转义，万一飞书在代码块里也认 @ 也不会变成 @。
 * > 不转义：只转 < 标签就不成立了，> 开头的引用照常显示
 */
function escapeAnswer(text: string): string {
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const inCode = fence !== undefined;
      const next = nextFence(fence, line);
      fence = next.fence;
      return inCode && !next.marker ? line.replace(/<(\/?at\b)/gi, "&lt;$1") : line.replace(/</g, "&lt;");
    })
    .join("\n");
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
  const ends = clipEnds(text, max);
  return ends ? `${ends[0]}\n…（中间省略 ${Array.from(text).length - max} 字）…\n${ends[1]}` : text;
}

/** 太长时只留开头三分之一和结尾三分之二；不长时返回 undefined */
function clipEnds(text: string, max: number): [string, string] | undefined {
  const chars = Array.from(text);
  if (chars.length <= max) {
    return undefined;
  }
  const head = Math.floor(max / 3);
  return [chars.slice(0, head).join(""), chars.slice(chars.length - (max - head)).join("")];
}

/** 进度卡片上「最新的思考」实际显示的那部分文字（不含中间省略的标记） */
export function visibleThought(text: string): string {
  return clipEnds(text, LIVE_THOUGHT_CHARS)?.join("\n") ?? text;
}

/** 折叠面板渲染不了时（比如飞书客户端太旧导致更新失败）用的简单版本 */
export function renderPlainProgressCard(state: ProgressState, now = Date.now(), { streaming }: CardOptions = {}): object {
  const elements: object[] = [{ tag: "markdown", content: [summaryLine(state, now), ...stepLines(state.steps)].join("\n") }];
  if (streaming && state.answer) {
    elements.push(answerElement(state.answer));
  }
  return { schema: "2.0", config: cardConfig(state, streaming), body: { elements } };
}

function statusLine(state: ProgressState): string {
  if (state.phase === "queued") {
    return "⏳ 排队中：等这个话题里上一个任务完成";
  }
  if (liveText(state)) {
    return "✍️ 正在写回答…";
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

/** 已发出的进度卡片：进行中的更新合并着推，结束时推最终状态 */
export interface ProgressCard {
  update(card: object): void;
  /** 推送最终状态并等它完成。失败时再试一次 fallback（如果给了）。返回卡片最后有没有更新成功 */
  finish(card: object, fallback?: object): Promise<boolean>;
}

/**
 * 把进度更新推到已发出的卡片上。飞书对同一条消息的更新有频率限制，这里合并短时间内的多次更新，
 * 同一时间只有一个请求在途，间隔至少 minIntervalMs。更新失败只记日志，不影响任务本身。
 */
export class CardUpdater implements ProgressCard {
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
  async finish(card: object, fallback?: object): Promise<boolean> {
    this.closed = true;
    this.pending = undefined;
    while (this.running) {
      await this.running;
    }
    await this.wait();
    try {
      await this.patch(card);
      return true;
    } catch (err) {
      if (!fallback) {
        this.logger.error("更新进度卡片失败", err);
        return false;
      }
      try {
        await this.patch(fallback);
        return true;
      } catch (err2) {
        this.logger.error("更新进度卡片失败", err2);
        return false;
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
