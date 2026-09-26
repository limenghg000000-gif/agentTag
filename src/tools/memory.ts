import {
  formatEntry,
  MAX_CONTENT_CHARS,
  MEMORY_KINDS,
  type MemoryAuthor,
  type MemoryKind,
  type MemoryStore,
  searchMemory,
} from "../memory.js";
import type { Tool } from "./tool.js";

/** 查记忆时一次最多列出几条 */
const PAGE_SIZE = 30;

const KIND_SCHEMA = {
  type: "string",
  enum: Object.keys(MEMORY_KINDS),
  description:
    "类别：background 项目背景和事实（仓库、环境、负责人、术语）；decision 做出的决定（写上结论和原因）；" +
    "convention 团队约定和偏好（流程、格式、希望你怎么做）；person 某位成员的角色、职责或个人偏好",
};

export interface MemoryToolsOptions {
  store: MemoryStore;
  /** 工具只能读写这个群的记忆，模型没法指定别的群 */
  chatId: string;
  /** 这次任务是谁在哪条消息里发起的，写进记忆的来源 */
  author: MemoryAuthor;
  /** 系统提示词里没列全记忆时才提供查记忆的工具，列全了就不必再查 */
  includeSearch: boolean;
}

/** 当前群的记忆工具。每个任务按所在的群单独创建一套。 */
export function createMemoryTools({ store, chatId, author, includeSearch }: MemoryToolsOptions): Tool[] {
  const save: Tool = {
    spec: {
      name: "memory_save",
      description:
        "把一条以后在这个群的其他话题里也用得上的信息记进群记忆。群成员让你记住什么时一定要用；" +
        "对话里出现了决定、约定、项目背景、成员分工等长期有用的信息时也可以主动记。" +
        `每条写成一句能独立看懂的话，写明谁、什么时间，不超过 ${MAX_CONTENT_CHARS} 字。` +
        "已有相关的记忆时用 memory_update 改那一条，不要重复记。不要记密码、密钥等敏感信息。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "要记住的内容，一句完整的话" },
          kind: KIND_SCHEMA,
        },
        required: ["content", "kind"],
      },
    },
    describe: (args) => `记住：${preview(args.content)}`,
    async run(args) {
      const content = requireString(args, "content");
      const kind = requireKind(args.kind);
      const { entry, duplicate } = await store.add(chatId, kind, content, author);
      return duplicate ? `已经记过了：${formatEntry(entry)}` : `已记住：${formatEntry(entry)}`;
    },
  };

  const update: Tool = {
    spec: {
      name: "memory_update",
      description: "修改一条群记忆，用于信息有变化、决定被推翻或需要补充时。按编号修改，内容整条替换。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "integer", description: "记忆编号，即 #3 里的 3" },
          content: { type: "string", description: "修改后的完整内容" },
          kind: { ...KIND_SCHEMA, description: "要改类别时才填" },
        },
        required: ["id", "content"],
      },
    },
    describe: (args) => `修改记忆 #${args.id}`,
    async run(args) {
      const id = requireId(args.id);
      const content = requireString(args, "content");
      const kind = args.kind === undefined ? undefined : requireKind(args.kind);
      const entry = await store.update(chatId, id, { content, kind }, author);
      return `已修改：${formatEntry(entry)}`;
    },
  };

  const remove: Tool = {
    spec: {
      name: "memory_delete",
      description: "删除群记忆，用于群成员让你忘掉某些内容，或信息已经过时、记错了。",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "integer" }, description: "要删除的记忆编号" },
        },
        required: ["ids"],
      },
    },
    describe: (args) => `删除记忆 ${Array.isArray(args.ids) ? args.ids.map((id) => `#${id}`).join(" ") : ""}`.trim(),
    async run(args) {
      if (!Array.isArray(args.ids) || args.ids.length === 0) {
        throw new Error("ids 必须是非空的编号数组");
      }
      const { removed, missing } = await store.remove(chatId, args.ids.map(requireId), author);
      const lines: string[] = [];
      if (removed.length > 0) {
        lines.push(`已删除：\n${removed.map((e) => formatEntry(e)).join("\n")}`);
      }
      if (missing.length > 0) {
        lines.push(`没有这些编号的记忆：${missing.map((id) => `#${id}`).join(" ")}`);
      }
      return lines.join("\n");
    },
  };

  const search: Tool = {
    spec: {
      name: "memory_search",
      description:
        "查这个群的记忆。系统提示里只列出了最近的一部分记忆，需要更早的信息时用关键词查；" +
        "不填 query 时按从新到旧列出全部记忆，用 offset 翻页。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "关键词，多个词用空格分开" },
          offset: { type: "integer", description: `不填 query 时从第几条开始列，默认 0，每次最多 ${PAGE_SIZE} 条` },
        },
      },
    },
    describe: (args) => (typeof args.query === "string" && args.query.trim() ? `查记忆：${preview(args.query)}` : "列出群记忆"),
    async run(args) {
      const entries = await store.list(chatId);
      if (entries.length === 0) {
        return "这个群还没有记忆。";
      }
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (query) {
        const found = searchMemory(entries, query);
        return found.length > 0 ? found.map((e) => formatEntry(e)).join("\n") : `没有找到和「${query}」相关的记忆。`;
      }
      const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
      const page = [...entries].sort((a, b) => b.id - a.id).slice(offset, offset + PAGE_SIZE);
      const rest = entries.length - offset - page.length;
      const lines = page.map((e) => formatEntry(e));
      lines.unshift(`共 ${entries.length} 条记忆，下面是第 ${offset + 1} 到 ${offset + page.length} 条（从新到旧）：`);
      if (rest > 0) {
        lines.push(`还有 ${rest} 条，用 offset=${offset + page.length} 继续列。`);
      }
      return page.length > 0 ? lines.join("\n") : `共 ${entries.length} 条记忆，offset 超出范围了。`;
    },
  };

  return includeSearch ? [save, update, remove, search] : [save, update, remove];
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`缺少 ${key} 参数`);
  }
  return value;
}

function requireKind(value: unknown): MemoryKind {
  if (typeof value !== "string" || !(value in MEMORY_KINDS)) {
    throw new Error(`kind 只能是 ${Object.keys(MEMORY_KINDS).join("、")} 之一`);
  }
  return value as MemoryKind;
}

function requireId(value: unknown): number {
  // 模型有时把编号写成 "#3" 或 "3"
  const id = typeof value === "string" ? Number(value.replace(/^#/, "")) : value;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new Error(`不是合法的记忆编号：${String(value)}`);
  }
  return id;
}

function preview(value: unknown): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}
