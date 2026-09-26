import { type BotIdentity, type Client, normalize } from "@larksuiteoapi/node-sdk";

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

/** 机器人用到的飞书读接口。单独抽出来，测试时可以换成假的。 */
export interface FeishuApi {
  /** 话题内的消息，按时间从早到晚，最多取最近 limit 条 */
  listThreadMessages(threadId: string, limit: number): Promise<ThreadMessage[]>;
  getMessage(messageId: string): Promise<ThreadMessage | undefined>;
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
  const toThreadMessage = async (item: ApiItem): Promise<ThreadMessage | undefined> => {
    if (!item.message_id || item.deleted) {
      return undefined;
    }
    const botIdentity = getBotIdentity() ?? { openId: "", name: "" };
    // 复用 SDK 把事件消息转成文本的逻辑：接口条目和事件消息字段名不同，先对齐
    const normalized = await normalize(
      {
        sender: {
          sender_id: { open_id: item.sender?.id_type === "open_id" ? item.sender.id : undefined },
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
            id: typeof m.id === "string" ? { open_id: m.id_type === "open_id" ? m.id : undefined } : m.id,
            name: m.name,
          })),
        },
      },
      { botIdentity, stripBotMentions: true },
    );
    return {
      messageId: item.message_id,
      fromBot: item.sender?.sender_type === "app" && item.sender.id === appId,
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

function check(res: ApiResponse<unknown>): void {
  if (res.code !== undefined && res.code !== 0) {
    throw new FeishuApiError(res.code, `飞书接口返回错误 ${res.code}：${res.msg ?? ""}`);
  }
}
