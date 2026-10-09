import type { DownloadedImage } from "./feishu.js";
import { describeFeishuError, type ImageRef, type Logger } from "./history.js";
import type { VisionModel } from "./llm.js";

/** 一次任务最多识别几张图片：提问里的在前，然后是话题里从新到旧的 */
export const MAX_IMAGES_PER_TASK = 4;
/** 识别一张图片最多等多久（下载加识别） */
const IMAGE_TIMEOUT_MS = 60_000;
/** 识别结果的字数上限 */
const MAX_IMAGE_TEXT_CHARS = 4000;
/** 记住最近识别过的图片：话题里每次提问都会重新读上文，同一张图不用再识别 */
const MAX_CACHED_IMAGES = 200;

/** SDK 把消息转成文本时，图片写成 ![image](image_key) */
const IMAGE_MARK = /!\[image\]\(([^)\s]+)\)/g;

export const IMAGE_INSTRUCTION = [
  "这是飞书群里有人发的图片，多半是告警、报错、监控或聊天的截图。把图片里的文字原样抄出来，保留原来的分行和层级。",
  "服务名、命名空间、Pod 名、接口、时间、requestId、trace_id、报错原文、数字，一个字都不能改；看不清的写「（看不清）」，不要猜。",
  "图片里不是文字的部分（曲线图、界面布局）用一两句话说明，比如哪条曲线在几点突然升高。",
  "只输出图片内容，不要分析原因，也不要给建议。",
].join("\n");

/** 没识别出来的图片换成这句，免得模型照着一行图片编号去猜，或者自己挑一个服务查 */
export const UNREAD_IMAGE =
  "[图片：机器人没能看到这张图片的内容。不要猜图片里是什么；回答要靠图片内容时（比如截图里的告警），请对方把图片里的关键文字贴出来，比如服务名、告警名、时间、报错原文]";

export interface ImageReaderOptions {
  download: (messageId: string, imageKey: string) => Promise<DownloadedImage>;
  vision: VisionModel;
  logger?: Logger;
  timeoutMs?: number;
}

/** 把群里的图片识别成文字，交给只看文字的主模型 */
export class ImageReader {
  private readonly cache = new Map<string, string>();

  constructor(private readonly options: ImageReaderOptions) {}

  get model(): string {
    return this.options.vision.model;
  }

  /** 识别这些图片，返回 image_key → 文字。识别不了的不在结果里，原因写进日志 */
  async read(refs: readonly ImageRef[], signal?: AbortSignal): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    await Promise.all(
      refs.map(async (ref) => {
        const text = await this.readOne(ref, signal);
        if (text) {
          results.set(ref.imageKey, text);
        }
      }),
    );
    return results;
  }

  private async readOne(ref: ImageRef, signal?: AbortSignal): Promise<string | undefined> {
    const { download, vision, logger = console, timeoutMs = IMAGE_TIMEOUT_MS } = this.options;
    const cached = this.cache.get(ref.imageKey);
    if (cached !== undefined) {
      this.cache.delete(ref.imageKey);
      this.cache.set(ref.imageKey, cached);
      return cached;
    }
    // 不用 AbortSignal.timeout：它的计时器不拦着进程退出，测试里等不到超时
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("timeout")), timeoutMs);
    const abort = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    let stage = "下载";
    try {
      const image = await raceAbort(download(ref.messageId, ref.imageKey), abort);
      stage = "识别";
      const text = clipText((await vision.describe(image, IMAGE_INSTRUCTION, abort)).trim());
      if (!text) {
        logger.warn(`识别图片没有得到文字 message=${ref.messageId} image=${ref.imageKey} 模型=${vision.model}`);
        return undefined;
      }
      this.cache.set(ref.imageKey, text);
      if (this.cache.size > MAX_CACHED_IMAGES) {
        this.cache.delete(this.cache.keys().next().value!);
      }
      return text;
    } catch (err) {
      if (signal?.aborted) {
        return undefined;
      }
      const reason = timeout.signal.aborted ? `超过 ${timeoutMs / 1000} 秒` : describeFeishuError(err);
      const hint =
        stage === "下载"
          ? "（下载图片要飞书应用有读取消息资源的权限，机器人也要在这个群里）"
          : `（检查 MODEL_VISION_ID=${vision.model} 是不是能看图的模型）`;
      logger.warn(`${stage}图片失败 message=${ref.messageId} image=${ref.imageKey}：${reason}${hint}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 文字里出现的图片，按出现顺序 */
export function imageKeysIn(text: string): string[] {
  return [...text.matchAll(IMAGE_MARK)].map((match) => match[1]);
}

/**
 * 把文字里飞书图片的 ![image](image_key) 换成识别出的内容，没识别出来的换成 UNREAD_IMAGE。
 * 只换 known 里的（消息里真有这张图）：群成员自己贴的 Markdown 图片语法原样保留
 */
export function inlineImages(text: string, results: ReadonlyMap<string, string>, known: ReadonlySet<string>): string {
  return text.replace(IMAGE_MARK, (mark, key: string) => {
    if (!known.has(key)) {
      return mark;
    }
    const content = results.get(key);
    return content === undefined
      ? UNREAD_IMAGE
      : `\n[图片内容：机器人用看图模型识别的文字，个别字可能识别错]\n${content}\n[图片内容结束]\n`;
  });
}

/**
 * 这次要识别哪些图片：提问里的全部在前，然后是话题上文里还看得到的（history 里有标记的），从新到旧，
 * 一共不超过 MAX_IMAGES_PER_TASK 张。同一张图只识别一次
 */
export function pickImages(questionImages: readonly ImageRef[], contextImages: readonly ImageRef[], historyText: string): ImageRef[] {
  const visible = new Set(imageKeysIn(historyText));
  const picked: ImageRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...questionImages, ...[...contextImages].reverse().filter((ref) => visible.has(ref.imageKey))]) {
    if (picked.length >= MAX_IMAGES_PER_TASK) {
      break;
    }
    if (!seen.has(ref.imageKey)) {
      seen.add(ref.imageKey);
      picked.push(ref);
    }
  }
  return picked;
}

function clipText(text: string): string {
  return text.length > MAX_IMAGE_TEXT_CHARS ? `${text.slice(0, MAX_IMAGE_TEXT_CHARS)}\n（图片文字太长，后面省略）` : text;
}

/** 下载不认中止信号：中止或超时就不再等它 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
