import type { EditAction, FeishuDocs } from "../docs.js";
import type { Tool } from "./tool.js";

/** 读文档时一次返回的字数上限，超出的用 offset 接着读 */
export const DOC_PAGE_CHARS = 12000;
export const DOC_TOOL_NAMES = ["feishu_doc_read", "feishu_doc_create", "feishu_doc_edit"] as const;

const EDIT_ACTIONS: Record<EditAction, string> = {
  append: "在文档末尾追加内容",
  insert_before: "在文档里插入内容",
  insert_after: "在文档里插入内容",
  replace: "修改文档内容",
  delete: "删除文档内容",
};

const DOCUMENT_PARAM = {
  type: "string",
  description: "飞书文档链接（新版文档 /docx/… 或知识库 /wiki/…），或 feishu_doc_create 返回的文档 ID",
};

export interface DocToolsOptions {
  docs: FeishuDocs;
  /** 新建的文档共享给这个群（可编辑） */
  chatId: string;
  /** 发起人的 open_id，新建的文档给发起人管理权限 */
  requesterOpenId?: string;
}

/** 飞书云文档工具。每个任务单独创建一套，新建文档时共享给当前群和发起人。 */
export function createDocTools({ docs, chatId, requesterOpenId }: DocToolsOptions): Tool[] {
  const read: Tool = {
    spec: {
      name: "feishu_doc_read",
      description:
        "读取飞书云文档（新版文档或知识库页面），返回标题和 Markdown 格式的正文。群里有人贴了飞书文档链接、" +
        "或者让你看、总结、修改某篇文档时使用；飞书文档链接不要用 fetch_url 打开。" +
        `正文超过 ${DOC_PAGE_CHARS} 字时分段返回，用 offset 接着读。`,
      parameters: {
        type: "object",
        properties: {
          document: DOCUMENT_PARAM,
          offset: { type: "integer", description: "从正文第几个字开始读，默认 0" },
          with_block_ids: {
            type: "boolean",
            description: "要修改文档时设为 true：每一块前会标出 <!-- id:块id -->，供 feishu_doc_edit 定位",
          },
        },
        required: ["document"],
      },
    },
    describe: (args) => `读取飞书文档${typeof args.offset === "number" && args.offset > 0 ? `（从第 ${args.offset} 字起）` : ""}`,
    async run(args) {
      const document = requireString(args, "document");
      const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
      const doc = await docs.read(document, args.with_block_ids === true);
      const lines = [`标题：${doc.title || "（无标题）"}`, `文档 ID：${doc.documentId}`];
      if (doc.url) {
        lines.push(`链接：${doc.url}`);
      }
      if (!doc.markdown) {
        return [...lines, "", "（文档是空的）"].join("\n");
      }
      if (offset >= doc.markdown.length) {
        return [...lines, "", `全文只有 ${doc.markdown.length} 字，offset 超出范围了。`].join("\n");
      }
      const end = pageEnd(doc.markdown, offset, DOC_PAGE_CHARS);
      if (offset > 0 || end < doc.markdown.length) {
        lines.push(
          `（全文 ${doc.markdown.length} 字，下面是第 ${offset} 到 ${end} 字` +
            `${end < doc.markdown.length ? `，后面还有 ${doc.markdown.length - end} 字，用 offset=${end} 接着读` : ""}）`,
        );
      }
      return [...lines, "", doc.markdown.slice(offset, end)].join("\n");
    },
  };

  const create: Tool = {
    spec: {
      name: "feishu_doc_create",
      description:
        "新建一篇飞书云文档并写入内容，建好后自动共享给本群（可编辑）和发起人（可管理），返回文档链接。" +
        "只在群成员要你写成文档、整理成文档时使用。content 用 Markdown：支持标题、列表、待办、代码块、引用、表格和链接，" +
        "图片会变成链接。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "文档标题" },
          content: { type: "string", description: "正文，Markdown 格式，不用再写一遍标题" },
        },
        required: ["title", "content"],
      },
    },
    describe: (args) => `新建飞书文档「${preview(args.title)}」`,
    async run(args) {
      const title = requireString(args, "title");
      const content = typeof args.content === "string" ? args.content : "";
      const result = await docs.create(title, content, { chatId, openId: requesterOpenId });
      const lines = [`已新建文档「${title}」，写入 ${result.blocks} 块内容。`, `文档 ID：${result.documentId}`];
      lines.push(
        result.url
          ? `链接：${result.url}`
          : "没拿到文档链接：群成员可以在飞书云文档的「与我共享」里按标题找到它。",
      );
      if (result.problems.length > 0) {
        lines.push("", "以下步骤没做成，请如实告诉群成员：", ...result.problems.map((p) => `- ${p}`));
      }
      return lines.join("\n");
    },
  };

  const edit: Tool = {
    spec: {
      name: "feishu_doc_edit",
      description:
        "修改飞书云文档。只在群成员明确要你改某篇文档时使用。除 append 外都要块 id：先用 feishu_doc_read 并设 with_block_ids=true 读一遍，" +
        "按 <!-- id:… --> 标记确定要动的块。改完把改了什么和文档链接告诉群成员。",
      parameters: {
        type: "object",
        properties: {
          document: DOCUMENT_PARAM,
          action: {
            type: "string",
            enum: Object.keys(EDIT_ACTIONS),
            description:
              "append 追加到文末；insert_before / insert_after 插到 block_id 那块的前面 / 后面；" +
              "replace 把 block_id 到 end_block_id（含）这段换成 content；delete 删掉 block_id 到 end_block_id（含）这段",
          },
          block_id: { type: "string", description: "要操作的块 id，append 不用填" },
          end_block_id: {
            type: "string",
            description: "replace / delete 一段连续的块时，最后一块的 id，要和 block_id 在同一层。只动一块时不填",
          },
          content: { type: "string", description: "要写入的内容，Markdown 格式。delete 不用填" },
        },
        required: ["document", "action"],
      },
    },
    describe: (args) => (isEditAction(args.action) ? EDIT_ACTIONS[args.action] : "修改飞书文档"),
    async run(args) {
      const document = requireString(args, "document");
      const action = args.action;
      if (!isEditAction(action)) {
        throw new Error(`action 只能是 ${Object.keys(EDIT_ACTIONS).join("、")} 之一`);
      }
      if (action !== "delete" && (typeof args.content !== "string" || !args.content.trim())) {
        throw new Error(`${action} 需要 content 参数`);
      }
      const { summary, url } = await docs.edit(document, {
        action,
        blockId: optionalString(args.block_id),
        endBlockId: optionalString(args.end_block_id),
        markdown: typeof args.content === "string" ? args.content : undefined,
      });
      return url ? `${summary}\n链接：${url}` : summary;
    },
  };

  return [read, create, edit];
}

function isEditAction(value: unknown): value is EditAction {
  return typeof value === "string" && Object.hasOwn(EDIT_ACTIONS, value);
}

/** 分段的结束位置：尽量断在换行处，别把一行切成两半 */
function pageEnd(text: string, offset: number, size: number): number {
  const end = offset + size;
  if (end >= text.length) {
    return text.length;
  }
  const newline = text.lastIndexOf("\n", end);
  return newline > offset + size / 2 ? newline + 1 : end;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`缺少 ${key} 参数`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function preview(value: unknown): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}
