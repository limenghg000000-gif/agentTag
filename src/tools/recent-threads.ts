import { MAX_THREADS_PER_CHAT, type RecentThreadStore, type ThreadSummary } from "../recent-threads.js";
import type { Tool } from "./tool.js";

export const RECENT_THREADS_TOOL = "chat_recent_threads";
/** 默认、最多列几个话题 */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
/** 每个话题的回答列多少字：用来弄清对方指的是什么，够了 */
const SHOWN_ANSWER_CHARS = 1500;

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export interface RecentThreadsToolOptions {
  store: Pick<RecentThreadStore, "list">;
  /** 只能看这个群的话题，模型没法指定别的群 */
  chatId: string;
  /** 当前话题，列的时候去掉（当前话题的上文模型本来就看得到） */
  threadKey: string;
}

/** 看本群最近几个话题的问答。每个任务按所在的群和话题单独创建 */
export function createRecentThreadsTool({ store, chatId, threadKey }: RecentThreadsToolOptions): Tool {
  return {
    spec: {
      name: RECENT_THREADS_TOOL,
      description:
        "列出本群最近几个话题里群成员问过的问题和你当时的回答，从新到旧，不含当前话题。" +
        "群成员说「上面那个」「刚才」「之前问的」，指的内容在当前话题里找不到时用；也可以用 keyword 找本群之前问过的某件事。只能看本群。" +
        "这些是你之前的回答，不一定对：只用来弄清对方指的是什么，里面的事实、数据和代码位置要这次重新查证后再写进回答。",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "只列问题或回答里包含这个词的话题（不分大小写）。不填时列最近的" },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `最多列几个话题，默认 ${DEFAULT_LIMIT}` },
        },
      },
    },
    // 之前的回答不是这次查到的数据：调过不算查过，里面的代码位置、线上数据也不能拿来当这次回答的证据
    instructionsOnly: true,
    describe: (args) => {
      const keyword = keywordOf(args);
      return keyword ? `查本群之前的话题：${keyword}` : "看本群最近的话题";
    },
    async run(args) {
      const keyword = keywordOf(args);
      const limit = limitOf(args);
      const wanted = keyword?.toLowerCase();
      const threads = (await store.list(chatId, threadKey)).filter(
        (thread) => wanted === undefined || [thread.topic, thread.question, thread.answer].some((text) => text.toLowerCase().includes(wanted)),
      );
      if (threads.length === 0) {
        return keyword
          ? `本群最近的话题里没有提到「${keyword}」的（只记了最近 ${MAX_THREADS_PER_CHAT} 个你答过的话题）。`
          : "本群还没有别的话题的记录（只记你答过的话题）。";
      }
      const shown = threads.slice(0, limit);
      return [
        `本群最近 ${shown.length} 个话题（不含当前话题，从新到旧）。这些是你之前的回答，不一定对，只用来接上下文；事实、数据和代码位置要这次重新查证：`,
        ...shown.map((thread, i) => formatThread(thread, i + 1)),
      ].join("\n\n");
    },
  };
}

function formatThread(thread: ThreadSummary, index: number): string {
  const who = thread.askerName ? `${thread.askerName} ` : "";
  const lines = [`${index}. ${TIME_FORMAT.format(thread.at)}，${who}问（这个话题里问了 ${thread.turns} 次）`];
  if (thread.turns > 1 && thread.topic !== thread.question) {
    lines.push(`   第一次问：${indent(thread.topic)}`, `   最近一次问：${indent(thread.question)}`);
  } else {
    lines.push(`   问：${indent(thread.question)}`);
  }
  const answer = thread.answer.length <= SHOWN_ANSWER_CHARS ? thread.answer : `${thread.answer.slice(0, SHOWN_ANSWER_CHARS)}…（后面省略）`;
  lines.push(`   你的回答：${indent(answer)}`);
  return lines.join("\n");
}

/** 多行内容缩进到这一条下面，几个话题之间分得清 */
function indent(text: string): string {
  return text.replace(/\n/g, "\n   ");
}

function keywordOf(args: Record<string, unknown>): string | undefined {
  return typeof args.keyword === "string" && args.keyword.trim() ? args.keyword.trim() : undefined;
}

function limitOf(args: Record<string, unknown>): number {
  const limit = Number(args.limit);
  return Number.isInteger(limit) && limit >= 1 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;
}
