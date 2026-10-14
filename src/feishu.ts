import { type BotIdentity, type Client, type NormalizedMessage, normalize } from "@larksuiteoapi/node-sdk";

/** 话题里的一条历史消息，内容已转成文本（@ 机器人已去掉，其他 @ 换成名字） */
export interface ThreadMessage {
  messageId: string;
  /** 是不是本机器人发的 */
  fromBot: boolean;
  /** 发言人名字，拿不到时为空 */
  senderName?: string;
  /** 发言人的 open_id，拿不到时（包括机器人发的）为空 */
  senderId?: string;
  /** 飞书消息类型：text、post、interactive（卡片）等 */
  msgType: string;
  content: string;
  createTime: number;
  /** 消息里图片的 image_key，按出现的顺序。内容里对应的位置是 ![image](image_key) */
  images?: string[];
  /** 在话题里时：话题 id（omt_ 开头）和话题第一条消息的 id */
  threadId?: string;
  rootId?: string;
}

/** 轮询读到的一条消息，已转成和事件一样的格式，可以直接交给消息处理函数 */
export interface RecentMessage {
  message: NormalizedMessage;
  /** 是不是本机器人发的 */
  fromBot: boolean;
  /** 是不是机器人、应用发的（本机器人和别的机器人都算） */
  fromApp?: boolean;
}

/** 机器人用到的飞书读接口。单独抽出来，测试时可以换成假的。 */
export interface FeishuApi {
  /** 话题内的消息，按时间从早到晚，最多取最近 limit 条 */
  listThreadMessages(threadId: string, limit: number): Promise<ThreadMessage[]>;
  getMessage(messageId: string): Promise<ThreadMessage | undefined>;
  /**
   * 群（chat）或话题（thread）里最近的消息，按时间从新到旧，最多 limit 条。
   * sinceMs 只对群有效（飞书的话题列表不支持按时间过滤），调用方自己再按 createTime 筛一遍。
   */
  listRecentMessages(container: "chat" | "thread", id: string, limit: number, sinceMs?: number): Promise<RecentMessage[]>;
  /** 群主界面里 sinceMs 之后的消息（带发言人名字），按时间从早到晚，最多取最近 limit 条 */
  listChatMessages(chatId: string, sinceMs: number, limit: number): Promise<ThreadMessage[]>;
  /** 下载消息里的一张图片（获取消息中的资源文件）。机器人得在这条消息所在的群里 */
  downloadImage(messageId: string, imageKey: string): Promise<DownloadedImage>;
}

export interface DownloadedImage {
  data: Buffer;
  /** image/png、image/jpeg 等 */
  mimeType: string;
}

/** 群里的截图一般几百 KB，超过这个就不下载了（飞书发图片的上限是 10 MB） */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 飞书接口返回的消息条目（获取会话历史消息 / 获取指定消息内容） */
interface ApiItem {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  chat_id?: string;
  msg_type?: string;
  create_time?: string;
  deleted?: boolean;
  sender?: { id?: string; id_type?: string; sender_type?: string; sender_name?: string };
  body?: { content?: string };
  mentions?: { key: string; id: string | { open_id?: string }; id_type?: string; name?: string }[];
}

interface ApiResponse<T> {
  code?: number;
  msg?: string;
  data?: T;
}

export class FeishuApiError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
    /** HTTP 状态码，接口直接返回 4xx/5xx 时才有 */
    readonly status?: number,
  ) {
    super(message);
    this.name = "FeishuApiError";
  }
}

/** 飞书接口限流了（HTTP 429，或者错误码 99991400） */
export function isRateLimited(err: unknown): boolean {
  return err instanceof FeishuApiError && (err.status === 429 || err.code === 99991400);
}

/** 调飞书接口：接口直接返回 4xx 时 SDK 会抛 axios 的异常，统一换成带 code 和 msg 的 FeishuApiError */
export async function callFeishu<T>(request: () => Promise<ApiResponse<T>>): Promise<T | undefined> {
  let res: ApiResponse<T>;
  try {
    res = await request();
  } catch (err) {
    const response = (err as { response?: { status?: number; data?: { code?: number; msg?: string } } })?.response;
    if (response?.data?.code !== undefined) {
      throw new FeishuApiError(response.data.code, `飞书接口返回错误 ${response.data.code}：${response.data.msg ?? ""}`, response.status);
    }
    if (response?.status) {
      throw new FeishuApiError(undefined, `飞书接口返回 HTTP ${response.status}`, response.status);
    }
    throw err;
  }
  check(res);
  return res.data;
}

export function createFeishuApi(client: Client, appId: string, getBotIdentity: () => BotIdentity | undefined): FeishuApi {
  const toNormalized = (item: ApiItem & { message_id: string }): Promise<NormalizedMessage> => {
    const botIdentity = getBotIdentity() ?? { openId: "", name: "" };
    // 复用 SDK 把事件消息转成文本的逻辑：接口条目和事件消息字段名不同，先对齐
    return normalize(
      {
        sender: {
          sender_id: { open_id: asOpenId(item.sender?.id, item.sender?.id_type) },
          sender_type: item.sender?.sender_type,
        },
        message: {
          message_id: item.message_id,
          root_id: item.root_id,
          parent_id: item.parent_id,
          thread_id: item.thread_id,
          chat_id: item.chat_id ?? "",
          chat_type: "group",
          create_time: item.create_time,
          message_type: item.msg_type ?? "unknown",
          content: item.body?.content ?? "",
          mentions: item.mentions?.map((m) => ({
            key: m.key,
            id: typeof m.id === "string" ? { open_id: asOpenId(m.id, m.id_type) } : m.id,
            name: m.name,
          })),
        },
      },
      { botIdentity, stripBotMentions: true },
    );
  };
  const isFromBot = (item: ApiItem) => item.sender?.sender_type === "app" && item.sender.id === appId;

  const toThreadMessage = async (item: ApiItem): Promise<ThreadMessage | undefined> => {
    if (!item.message_id || item.deleted) {
      return undefined;
    }
    const normalized = await toNormalized({ ...item, message_id: item.message_id });
    const images = imageKeysOf(normalized);
    const senderId = asOpenId(item.sender?.id, item.sender?.id_type);
    return {
      messageId: item.message_id,
      fromBot: isFromBot(item),
      senderName: item.sender?.sender_name || undefined,
      ...(senderId ? { senderId } : {}),
      msgType: item.msg_type ?? "unknown",
      content: normalized.content,
      createTime: Number(item.create_time) || 0,
      ...(images.length > 0 ? { images } : {}),
      ...(item.thread_id ? { threadId: item.thread_id } : {}),
      ...(item.root_id ? { rootId: item.root_id } : {}),
    };
  };

  const convertAll = async (items: ApiItem[]) =>
    (await Promise.all(items.map(toThreadMessage))).filter((m): m is ThreadMessage => m !== undefined);

  return {
    async listThreadMessages(threadId, limit) {
      const items: ApiItem[] = [];
      let pageToken: string | undefined;
      do {
        const res = (await client.im.v1.message.list({
          params: {
            container_id_type: "thread",
            container_id: threadId,
            sort_type: "ByCreateTimeDesc",
            page_size: Math.min(50, limit - items.length),
            page_token: pageToken,
            with_sender_name: true,
          },
        })) as ApiResponse<{ items?: ApiItem[]; has_more?: boolean; page_token?: string }>;
        check(res);
        items.push(...(res.data?.items ?? []));
        pageToken = res.data?.has_more ? res.data.page_token : undefined;
      } while (pageToken && items.length < limit);
      return (await convertAll(items)).reverse();
    },

    async listRecentMessages(container, id, limit, sinceMs) {
      const res = (await client.im.v1.message.list({
        params: {
          container_id_type: container,
          container_id: id,
          sort_type: "ByCreateTimeDesc",
          page_size: Math.min(50, limit),
          ...(container === "chat" && sinceMs !== undefined ? { start_time: String(Math.floor(sinceMs / 1000)) } : {}),
        },
      })) as ApiResponse<{ items?: ApiItem[] }>;
      check(res);
      const items = (res.data?.items ?? []).filter(
        (item): item is ApiItem & { message_id: string } => Boolean(item.message_id) && !item.deleted,
      );
      return Promise.all(
        items.map(async (item) => ({ message: await toNormalized(item), fromBot: isFromBot(item), fromApp: item.sender?.sender_type === "app" })),
      );
    },

    async listChatMessages(chatId, sinceMs, limit) {
      const res = (await client.im.v1.message.list({
        params: {
          container_id_type: "chat",
          container_id: chatId,
          sort_type: "ByCreateTimeDesc",
          page_size: Math.min(50, limit),
          start_time: String(Math.floor(sinceMs / 1000)),
          with_sender_name: true,
        },
      })) as ApiResponse<{ items?: ApiItem[] }>;
      check(res);
      return (await convertAll(res.data?.items ?? [])).reverse();
    },

    async getMessage(messageId) {
      const res = (await client.im.v1.message.get({
        path: { message_id: messageId },
        params: { with_sender_name: true },
      })) as ApiResponse<{ items?: ApiItem[] }>;
      check(res);
      const [first] = await convertAll(res.data?.items?.slice(0, 1) ?? []);
      return first;
    },

    async downloadImage(messageId, imageKey) {
      const res = await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: "image" },
      });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res.getReadableStream()) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_IMAGE_BYTES) {
          throw new Error(`图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB，没有下载`);
        }
        chunks.push(buffer);
      }
      const data = Buffer.concat(chunks);
      const header = String(res.headers?.["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      return { data, mimeType: header.startsWith("image/") ? header : sniffImageType(data) };
    },
  };
}

/** 消息里图片的 image_key（SDK 转文本时记在 resources 里） */
export function imageKeysOf(message: Pick<NormalizedMessage, "resources">): string[] {
  return (message.resources ?? []).filter((resource) => resource.type === "image").map((resource) => resource.fileKey);
}

/** 接口没给出图片类型时按文件头认，认不出按 PNG */
function sniffImageType(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xd8) {
    return "image/jpeg";
  }
  if (data.subarray(0, 3).toString("latin1") === "GIF") {
    return "image/gif";
  }
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return "image/png";
}

/** 接口返回的用户 id 是 open_id 时才用（@ 机器人要按 open_id 比对）。个别返回没带 id_type，按 ou_ 前缀认 */
function asOpenId(id: string | undefined, idType: string | undefined): string | undefined {
  return id && (idType === "open_id" || (!idType && id.startsWith("ou_"))) ? id : undefined;
}

function check(res: ApiResponse<unknown>): void {
  if (res.code !== undefined && res.code !== 0) {
    throw new FeishuApiError(res.code, `飞书接口返回错误 ${res.code}：${res.msg ?? ""}`);
  }
}
