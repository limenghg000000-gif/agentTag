import type { Client } from "@larksuiteoapi/node-sdk";
import { callFeishu } from "./feishu.js";
import type { ProgressCard } from "./progress.js";

/**
 * 飞书卡片实体（CardKit）接口：先建卡片实体，按 card_id 发消息，之后按组件更新文字（打字机效果）。
 * 同一张卡片的每次更新都要带比上一次大的 sequence。单独抽出来，测试时可以换成假的
 */
export interface CardKitApi {
  /** 建卡片实体，返回 card_id */
  create(card: object): Promise<string>;
  /** 全量更新卡片 */
  update(cardId: string, card: object, sequence: number): Promise<void>;
  /** 流式更新一个组件的文字：旧文字是新文字的开头时，多出来的部分以打字机效果显示。卡片要开着 streaming_mode */
  setContent(cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  /** 改卡片配置，比如打开、关掉 streaming_mode */
  settings(cardId: string, settings: object, sequence: number): Promise<void>;
}

/** 要应用开通 cardkit:card:write 权限 */
export function createCardKitApi(client: Client): CardKitApi {
  return {
    async create(card) {
      const data = await callFeishu(() => client.cardkit.v1.card.create({ data: { type: "card_json", data: JSON.stringify(card) } }));
      if (!data?.card_id) {
        throw new Error("创建卡片实体没有返回 card_id");
      }
      return data.card_id;
    },
    async update(cardId, card, sequence) {
      await callFeishu(() =>
        client.cardkit.v1.card.update({
          path: { card_id: cardId },
          data: { card: { type: "card_json", data: JSON.stringify(card) }, sequence, uuid: `u_${cardId}_${sequence}` },
        }),
      );
    },
    async setContent(cardId, elementId, content, sequence) {
      await callFeishu(() =>
        client.cardkit.v1.cardElement.content({
          path: { card_id: cardId, element_id: elementId },
          data: { content, sequence, uuid: `c_${cardId}_${sequence}` },
        }),
      );
    },
    async settings(cardId, settings, sequence) {
      await callFeishu(() =>
        client.cardkit.v1.card.settings({
          path: { card_id: cardId },
          data: { settings: JSON.stringify(settings), sequence, uuid: `s_${cardId}_${sequence}` },
        }),
      );
    },
  };
}

interface CardJson {
  config?: { streaming_mode?: boolean; [key: string]: unknown };
  body?: { elements?: { tag?: string; element_id?: string; content?: string; [key: string]: unknown }[] };
}

/**
 * 卡片即回答用的进度卡片（卡片实体）。和 CardUpdater 一样合并短时间内的多次更新、同一时间只有一个请求在途，另外：
 * - 模型写回答时（卡片 config.streaming_mode 为 true）先打开卡片的流式模式，之后只是文字变了的组件按组件更新，有打字机效果；
 * - 别的时候（想、调工具、结束）关掉流式模式再全量更新：流式模式开着时卡片上的按钮可能点不了，飞书也会在 10 分钟后自动关掉它；
 * - 按组件更新失败一次（比如流式模式被飞书关了）就不再用，之后都全量更新。
 * 更新失败只记日志，不影响任务本身
 */
export class StreamingCard implements ProgressCard {
  private sequence = 0;
  /** 卡片上现在的样子：组件结构（流式组件的文字去掉）和每个流式组件的文字 */
  private layout: string;
  private texts: Map<string, string>;
  private streaming = false;
  private elementsBroken = false;
  private pending?: object;
  private running?: Promise<void>;
  private lastAt = 0;
  /** 上一次全量更新的时间：思考的时候流式模式关着，每次刷新都是全量更新，间隔拉长一些 */
  private lastFullAt = 0;
  private closed = false;

  constructor(
    private readonly api: CardKitApi,
    readonly cardId: string,
    /** 建卡片实体时用的卡片 */
    initial: object,
    private readonly logger: Pick<Console, "error"> = console,
    private readonly minIntervalMs = 300,
    /** 两次全量更新的最小间隔 */
    private readonly fullIntervalMs = Math.max(minIntervalMs, 1000),
  ) {
    this.layout = layoutOf(initial);
    this.texts = textsOf(initial);
    this.streaming = (initial as CardJson).config?.streaming_mode === true;
  }

  update(card: object): void {
    if (this.closed) {
      return;
    }
    this.pending = card;
    this.kick();
  }

  async finish(card: object, fallback?: object): Promise<boolean> {
    this.closed = true;
    this.pending = undefined;
    while (this.running) {
      await this.running;
    }
    if (this.streaming) {
      await this.setStreaming(false);
    }
    for (const candidate of fallback ? [card, fallback] : [card]) {
      if (await this.replace(candidate, true)) {
        return true;
      }
    }
    return false;
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
      if (card) {
        await this.apply(card);
      }
    }
  }

  private async apply(card: object): Promise<void> {
    const wanted = this.wantsStreaming(card);
    if (wanted && layoutOf(card) === this.layout) {
      if (!this.streaming && !(await this.setStreaming(true))) {
        this.elementsBroken = true;
        await this.replace(card);
        return;
      }
      for (const [elementId, content] of textsOf(card)) {
        if (this.texts.get(elementId) === content) {
          continue;
        }
        if (!(await this.call("流式更新卡片文字", (sequence) => this.api.setContent(this.cardId, elementId, content, sequence)))) {
          // 之后都全量更新：先关掉流式模式（可能已经被飞书关了），这次的内容全量推上去
          this.elementsBroken = true;
          await this.setStreaming(false);
          await this.replace(card);
          return;
        }
        this.texts.set(elementId, content);
      }
      return;
    }
    // 组件有增减，或者不在生成：关掉流式模式再全量更新；还在生成的，更新完再打开
    if (this.streaming) {
      await this.setStreaming(false);
    }
    const pushed = await this.replace(card);
    if (pushed && this.wantsStreaming(pushed) && !(await this.setStreaming(true))) {
      this.elementsBroken = true;
    }
  }

  private wantsStreaming(card: object): boolean {
    return (card as CardJson).config?.streaming_mode === true && !this.elementsBroken;
  }

  /**
   * 全量更新，返回推上去的卡片（失败、不推时为空）。卡片里的 streaming_mode 换成卡片现在实际的状态，开关只通过 settings 改。
   * 等间隔的时候来了更新的，推最新的那张；等完已经结束了就不推，马上要推最终的卡片（final 是最终卡片）
   */
  private async replace(card: object, final = false): Promise<object | undefined> {
    await this.wait(this.lastFullAt + this.fullIntervalMs);
    if (!final) {
      if (this.closed) {
        return undefined;
      }
      if (this.pending) {
        card = this.pending;
        this.pending = undefined;
      }
    }
    const json = card as CardJson;
    const body = { ...json, config: { ...json.config, streaming_mode: this.streaming } };
    this.lastFullAt = Date.now();
    if (!(await this.call("更新卡片", (sequence) => this.api.update(this.cardId, body, sequence)))) {
      return undefined;
    }
    this.layout = layoutOf(card);
    this.texts = textsOf(card);
    return card;
  }

  private async setStreaming(on: boolean): Promise<boolean> {
    const ok = await this.call(on ? "打开卡片流式模式" : "关掉卡片流式模式", (sequence) =>
      this.api.settings(this.cardId, { config: { streaming_mode: on } }, sequence),
    );
    // 关失败时也当成关了：多半是飞书已经自动关掉了；没关掉的话下一次全量更新会报错，日志里能看到
    this.streaming = on ? ok : false;
    return ok;
  }

  private async call(what: string, request: (sequence: number) => Promise<void>): Promise<boolean> {
    await this.wait();
    this.lastAt = Date.now();
    try {
      await request(++this.sequence);
      return true;
    } catch (err) {
      this.logger.error(`${what}失败 card=${this.cardId}`, err);
      return false;
    }
  }

  /** 等到离上一次请求至少 minIntervalMs，并且不早于 until */
  private async wait(until = 0): Promise<void> {
    const delay = Math.max(this.lastAt + this.minIntervalMs, until) - Date.now();
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** 流式组件：带 element_id 的 markdown 组件（只看最外层） */
function streamable(element: { tag?: string; element_id?: string; content?: string }): element is { tag: "markdown"; element_id: string; content: string } {
  return element.tag === "markdown" && typeof element.element_id === "string" && typeof element.content === "string";
}

/** 卡片的结构：去掉流式组件的文字和会变的配置（流式开关、预览），只剩这些都一样时才能按组件更新 */
function layoutOf(card: object): string {
  const json = card as CardJson;
  const { streaming_mode: _mode, summary: _summary, ...config } = json.config ?? {};
  const elements = (json.body?.elements ?? []).map((element) => (streamable(element) ? { ...element, content: "" } : element));
  return JSON.stringify({ ...json, config, body: { ...json.body, elements } });
}

function textsOf(card: object): Map<string, string> {
  const elements = (card as CardJson).body?.elements ?? [];
  return new Map(elements.filter(streamable).map((element) => [element.element_id, element.content]));
}
