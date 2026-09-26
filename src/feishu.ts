import { type BotIdentity, type Client, type NormalizedMessage, normalize } from "@larksuiteoapi/node-sdk";

/** 话题里的一条历史消息，内容已转成文本（@ 机器人已去掉，其他 @ 换成名字） */
export interface ThreadMessage {
  messageId: string;
  /** 是不是本机器人发的 */
  fromBot: boolean;
  /** 发言人名字，拿不到时为空 */
  senderName?: string;
  /** 飞书消息类型：text、post、interactive（卡片）等 */
  msgType: string;
  content: string;
  createTime: number;
}

/** 轮询读到的一条消息，已转成和事件一样的格式，可以直接交给消息处理函数 */
export interface RecentMessage {
  message: NormalizedMessage;
  /** 是不是本机器人发的 */
  fromBot: boolean;
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
}

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
  ) {
    super(message);
    this.name = "FeishuApiError";
  }
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
    return {
      messageId: item.message_id,
      fromBot: isFromBot(item),
      senderName: item.sender?.sender_name || undefined,
      msgType: item.msg_type ?? "unknown",
      content: normalized.content,
      createTime: Number(item.create_time) || 0,
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
      return Promise.all(items.map(async (item) => ({ message: await toNormalized(item), fromBot: isFromBot(item) })));
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
  };
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
