import type { Client } from "@larksuiteoapi/node-sdk";
import { type DocBlock, kindOf, renderDocument } from "./doc-render.js";
import { FeishuApiError } from "./feishu.js";

/** 单次「创建嵌套块」最多插入的块数（飞书接口上限） */
export const MAX_BLOCKS_PER_INSERT = 1000;
/** 一篇文档最多读多少页块（每页 500 块） */
const MAX_BLOCK_PAGES = 40;

/** 链接路径里的类型 → 飞书云文档类型 */
const PATH_KINDS: Record<string, string> = {
  docx: "docx",
  wiki: "wiki",
  docs: "doc",
  doc: "doc",
  sheets: "sheet",
  sheet: "sheet",
  base: "bitable",
  bitable: "bitable",
  mindnotes: "mindnote",
  file: "file",
  slides: "slides",
};

const KIND_NAMES: Record<string, string> = {
  doc: "旧版文档",
  sheet: "电子表格",
  bitable: "多维表格",
  mindnote: "思维导图",
  file: "云空间文件",
  slides: "幻灯片",
};

export interface DocRef {
  kind: string;
  token: string;
  /** 链接的协议和域名，如 https://xxx.feishu.cn，只给了 ID 时没有 */
  origin?: string;
}

/** 给模型看的错误：说明哪里不对、该怎么办 */
export class DocError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocError";
  }
}

/** 解析飞书文档链接（新版文档、知识库等），也接受直接给的文档 ID */
export function parseDocRef(input: string): DocRef {
  const text = input.trim();
  if (/^[A-Za-z0-9]{16,}$/.test(text)) {
    return { kind: "docx", token: text };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new DocError(`不是飞书文档链接或文档 ID：${input}`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  for (let i = 0; i < segments.length - 1; i++) {
    const kind = PATH_KINDS[segments[i]];
    if (kind && /^[A-Za-z0-9]{8,}$/.test(segments[i + 1])) {
      return { kind, token: segments[i + 1], origin: url.origin };
    }
  }
  throw new DocError(`认不出这个链接里的飞书文档：${input}`);
}

export interface WikiNode {
  objType: string;
  objToken: string;
  title?: string;
}

/** 「Markdown 转文档块」的结果：第一层块的 id 和全部块（含嵌套的） */
export interface ConvertedBlocks {
  firstLevelIds: string[];
  blocks: DocBlock[];
}

export type Collaborator = { type: "openchat" | "openid"; id: string };

/** 用到的飞书云文档接口，单独抽出来，测试时换成假的 */
export interface DocsApi {
  getWikiNode(token: string): Promise<WikiNode>;
  /** 文档的全部块（第一个是页面块） */
  listBlocks(documentId: string): Promise<DocBlock[]>;
  /** 新建文档，返回 document_id */
  createDocument(title: string): Promise<string>;
  convertMarkdown(markdown: string): Promise<ConvertedBlocks>;
  /** 把 descendants 里的块插到 parentId 的子块里，index 不填时插到最后 */
  insertBlocks(documentId: string, parentId: string, childrenIds: string[], descendants: DocBlock[], index?: number): Promise<void>;
  /** 删除 parentId 的第 start 到 end-1 个子块 */
  deleteChildren(documentId: string, parentId: string, start: number, end: number): Promise<void>;
  addCollaborator(documentId: string, member: Collaborator, perm: "view" | "edit" | "full_access"): Promise<void>;
  /** 文档的访问链接 */
  getUrl(documentId: string): Promise<string | undefined>;
}

interface ApiResponse<T> {
  code?: number;
  msg?: string;
  data?: T;
}

/** 调飞书接口：接口直接返回 4xx 时 SDK 会抛 axios 的异常，统一换成带 code 和 msg 的 FeishuApiError */
async function call<T>(request: () => Promise<ApiResponse<T>>): Promise<T | undefined> {
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
  if (res.code !== undefined && res.code !== 0) {
    throw new FeishuApiError(res.code, `飞书接口返回错误 ${res.code}：${res.msg ?? ""}`);
  }
  return res.data;
}

export function createDocsApi(client: Client): DocsApi {
  return {
    async getWikiNode(token) {
      const data = await call(() => client.wiki.v2.space.getNode({ params: { token } }));
      const node = data?.node;
      if (!node?.obj_token || !node.obj_type) {
        throw new DocError("知识库接口没有返回这个节点的文档");
      }
      return { objType: node.obj_type, objToken: node.obj_token, title: node.title };
    },

    async listBlocks(documentId) {
      const blocks: DocBlock[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_BLOCK_PAGES; page++) {
        const data = await call(() =>
          client.docx.v1.documentBlock.list({
            path: { document_id: documentId },
            params: { page_size: 500, page_token: pageToken, document_revision_id: -1 },
          }),
        );
        blocks.push(...((data?.items ?? []) as DocBlock[]));
        pageToken = data?.has_more ? data.page_token : undefined;
        if (!pageToken) {
          break;
        }
      }
      return blocks;
    },

    async createDocument(title) {
      const data = await call(() => client.docx.v1.document.create({ data: { title } }));
      const id = data?.document?.document_id;
      if (!id) {
        throw new DocError("新建文档接口没有返回文档 ID");
      }
      return id;
    },

    async convertMarkdown(markdown) {
      const data = await call(() => client.docx.v1.document.convert({ data: { content_type: "markdown", content: markdown } }));
      const blocks = ((data?.blocks ?? []) as DocBlock[]).map((block) => {
        // 转出来的块带 parent_id 和只读的表格 merge_info，插入时传了会报错
        const { parent_id: _parent, ...rest } = block;
        const table = rest.table as { property?: Record<string, unknown> } | undefined;
        if (table?.property) {
          const { merge_info: _merge, ...property } = table.property;
          return { ...rest, table: { ...table, property } };
        }
        return rest;
      });
      return { firstLevelIds: data?.first_level_block_ids ?? [], blocks };
    },

    async insertBlocks(documentId, parentId, childrenIds, descendants, index) {
      await call(() =>
        client.docx.v1.documentBlockDescendant.create({
          path: { document_id: documentId, block_id: parentId },
          params: { document_revision_id: -1 },
          data: {
            children_id: childrenIds,
            ...(index === undefined ? {} : { index }),
            descendants: descendants as never,
          },
        }),
      );
    },

    async deleteChildren(documentId, parentId, start, end) {
      await call(() =>
        client.docx.v1.documentBlockChildren.batchDelete({
          path: { document_id: documentId, block_id: parentId },
          params: { document_revision_id: -1 },
          data: { start_index: start, end_index: end },
        }),
      );
    },

    async addCollaborator(documentId, member, perm) {
      await call(() =>
        client.drive.v1.permissionMember.create({
          path: { token: documentId },
          params: { type: "docx", need_notification: false },
          data: {
            member_type: member.type,
            member_id: member.id,
            perm,
            type: member.type === "openchat" ? "chat" : "user",
          },
        }),
      );
    },

    async getUrl(documentId) {
      const data = await call(() =>
        client.drive.v1.meta.batchQuery({
          data: { request_docs: [{ doc_token: documentId, doc_type: "docx" }], with_url: true },
        }),
      );
      return data?.metas?.[0]?.url || undefined;
    },
  };
}

export type EditAction = "append" | "insert_before" | "insert_after" | "replace" | "delete";

export interface EditRequest {
  action: EditAction;
  /** 目标块；append 不用 */
  blockId?: string;
  /** 范围的最后一块（replace、delete 用），不填就只动 blockId 这一块 */
  endBlockId?: string;
  /** 要写入的 Markdown；delete 不用 */
  markdown?: string;
}

export interface ReadResult {
  documentId: string;
  title: string;
  markdown: string;
  url?: string;
}

export interface CreateResult {
  documentId: string;
  url?: string;
  /** 写入的第一层块数 */
  blocks: number;
  /** 没做成的附带步骤（写内容、共享），给模型如实转告 */
  problems: string[];
}

/**
 * 读写飞书新版文档：解析链接（知识库链接换成背后的文档）、读成 Markdown、新建、按块插入/替换/删除。
 * 同一篇文档的修改排队执行，避免并行的两次修改按过时的块位置操作。
 */
export class FeishuDocs {
  /** 最近见过的文档域名（如 https://xxx.feishu.cn），拿不到文档链接时用它拼 */
  private origin?: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly api: DocsApi,
    /** 机器人的名字，写进「怎么给机器人开权限」的提示里 */
    private readonly botName: () => string = () => "机器人",
  ) {}

  async read(input: string, withIds = false): Promise<ReadResult> {
    return this.explain(async () => {
      const { documentId, url } = await this.resolve(input);
      const { title, markdown } = renderDocument(await this.api.listBlocks(documentId), { withIds });
      return { documentId, title, markdown, url };
    });
  }

  async create(title: string, markdown: string, share: { chatId: string; openId?: string }): Promise<CreateResult> {
    const documentId = await this.explain(() => this.api.createDocument(title));
    const problems: string[] = [];
    let blocks = 0;
    if (markdown.trim()) {
      try {
        blocks = await this.insert(documentId, documentId, await this.convert(markdown));
      } catch (err) {
        problems.push(`文档建好了，但内容没写进去：${this.describe(err)}`);
      }
    }
    // 机器人建的文档在应用自己的云空间里，不共享出去谁都打不开
    const shares: [Collaborator, "edit" | "full_access", string][] = [[{ type: "openchat", id: share.chatId }, "edit", "本群"]];
    if (share.openId) {
      shares.push([{ type: "openid", id: share.openId }, "full_access", "发起人"]);
    }
    // 共享和查链接互不依赖，一起发
    const [url, ...shareProblems] = await Promise.all([
      this.urlOf(documentId),
      ...shares.map(([member, perm, who]) =>
        this.api.addCollaborator(documentId, member, perm).then(
          () => undefined,
          (err: unknown) => `没能把文档共享给${who}：${this.describe(err)}`,
        ),
      ),
    ]);
    problems.push(...shareProblems.filter((p): p is string => p !== undefined));
    return { documentId, url, blocks, problems };
  }

  /** 按块修改文档，返回一句做了什么 */
  async edit(input: string, request: EditRequest): Promise<{ summary: string; url?: string }> {
    return this.explain(async () => {
      const { documentId, url } = await this.resolve(input);
      const summary = await this.exclusive(documentId, () => this.applyEdit(documentId, request));
      return { summary, url: url ?? (await this.urlOf(documentId)) };
    });
  }

  private async applyEdit(documentId: string, { action, blockId, endBlockId, markdown }: EditRequest): Promise<string> {
    const content = action === "delete" ? undefined : await this.convert(markdown ?? "");
    if (action === "append") {
      const count = await this.insert(documentId, documentId, content!);
      return `已在文档末尾追加 ${count} 块内容。`;
    }

    if (!blockId) {
      throw new DocError(`${action} 需要 block_id：先用 feishu_doc_read（with_block_ids=true）读文档拿到块 id`);
    }
    const range = locate(await this.api.listBlocks(documentId), documentId, blockId, action === "insert_before" ? undefined : endBlockId);
    switch (action) {
      case "insert_before": {
        const count = await this.insert(documentId, range.parentId, content!, range.start);
        return `已在块 ${blockId} 前面插入 ${count} 块内容。`;
      }
      case "insert_after": {
        const count = await this.insert(documentId, range.parentId, content!, range.end);
        return `已在块 ${endBlockId ?? blockId} 后面插入 ${count} 块内容。`;
      }
      case "replace": {
        // 先插新内容再删旧的：插入失败时原文不受影响
        const count = await this.insert(documentId, range.parentId, content!, range.end);
        await this.api.deleteChildren(documentId, range.parentId, range.start, range.end);
        return `已把 ${range.end - range.start} 块旧内容替换成 ${count} 块新内容。`;
      }
      case "delete":
        await this.api.deleteChildren(documentId, range.parentId, range.start, range.end);
        return `已删除 ${range.end - range.start} 块内容。`;
      default:
        throw new DocError(`不支持的操作：${String(action)}`);
    }
  }

  /** 解析链接，知识库链接换成背后的新版文档 */
  private async resolve(input: string): Promise<{ documentId: string; url?: string }> {
    const ref = parseDocRef(input);
    if (ref.origin) {
      this.origin = ref.origin;
    }
    const url = ref.origin ? `${ref.origin}/${ref.kind}/${ref.token}` : undefined;
    if (ref.kind === "docx") {
      return { documentId: ref.token, url };
    }
    if (ref.kind === "wiki") {
      const node = await this.api.getWikiNode(ref.token);
      if (node.objType !== "docx") {
        throw unsupported(node.objType);
      }
      return { documentId: node.objToken, url };
    }
    throw unsupported(ref.kind);
  }

  /** Markdown 转成文档块。图片转成链接：插入图片块还得另外上传图片，先不支持 */
  private async convert(markdown: string): Promise<ConvertedBlocks> {
    const text = markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt: string, src: string) => `[${alt || "图片"}](${src})`);
    if (!text.trim()) {
      throw new DocError("要写入的内容是空的");
    }
    const converted = await this.api.convertMarkdown(text);
    if (converted.firstLevelIds.length === 0) {
      throw new DocError("这段 Markdown 没有转换出任何内容");
    }
    return converted;
  }

  /** 分批插入（每批不超过接口上限），返回插入的第一层块数 */
  private async insert(documentId: string, parentId: string, { firstLevelIds, blocks }: ConvertedBlocks, index?: number): Promise<number> {
    const byId = new Map(blocks.map((block) => [block.block_id, block]));
    const subtree = (id: string): DocBlock[] => {
      const block = byId.get(id);
      return block ? [block, ...(block.children ?? []).flatMap(subtree)] : [];
    };

    let at = index;
    let batch: string[] = [];
    let descendants: DocBlock[] = [];
    const flush = async () => {
      await this.api.insertBlocks(documentId, parentId, batch, descendants, at);
      if (at !== undefined) {
        at += batch.length;
      }
      batch = [];
      descendants = [];
    };
    for (const id of firstLevelIds) {
      const tree = subtree(id);
      if (batch.length > 0 && descendants.length + tree.length > MAX_BLOCKS_PER_INSERT) {
        await flush();
      }
      batch.push(id);
      descendants.push(...tree);
    }
    if (batch.length > 0) {
      await flush();
    }
    return firstLevelIds.length;
  }

  private async urlOf(documentId: string): Promise<string | undefined> {
    try {
      const url = await this.api.getUrl(documentId);
      if (url) {
        return url;
      }
    } catch {
      // 缺查元数据的权限时退回用见过的域名拼
    }
    return this.origin ? `${this.origin}/docx/${documentId}` : undefined;
  }

  private async exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(run);
    this.locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === current) {
        this.locks.delete(key);
      }
    }
  }

  private async explain<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      throw err instanceof DocError ? err : new DocError(this.describe(err));
    }
  }

  /** 把飞书接口的错误翻译成模型能转告给群成员的话 */
  private describe(err: unknown): string {
    if (err instanceof DocError) {
      return err.message;
    }
    if (!(err instanceof FeishuApiError)) {
      return err instanceof Error ? err.message : String(err);
    }
    const raw = err.message;
    // 应用没开通接口权限：飞书的错误信息里带着缺的权限名和申请链接，原样给出
    if (err.code === 99991672 || err.code === 99991679 || /scope|权限：\[/i.test(raw)) {
      return `机器人缺少飞书应用权限，需要管理员在飞书开发者后台开通后发布新版本。${raw}`;
    }
    if (err.status === 403 || err.code === 1770032 || err.code === 131006 || /forbidden|permission denied|no permission/i.test(raw)) {
      return (
        `机器人没有这篇文档的权限（${raw}）。请文档所有者在文档右上角「…」→「更多」→「添加文档应用」里添加「${this.botName()}」，` +
        "或者把文档分享给机器人所在的群"
      );
    }
    if (err.code === 1770002 || err.status === 404 || /not found/i.test(raw)) {
      return `找不到这篇文档，可能已被删除或链接不对（${raw}）`;
    }
    if (err.status === 429 || err.code === 99991400) {
      return `飞书接口限流了，等几秒再试（${raw}）`;
    }
    return raw;
  }
}

function unsupported(kind: string): DocError {
  const name = KIND_NAMES[kind] ?? kind;
  return new DocError(
    kind === "doc"
      ? "这是旧版飞书文档，暂不支持。可以在飞书里把它升级为新版文档后再试"
      : `这是${name}，目前只支持读写飞书新版文档（docx）`,
  );
}

/** 找到 blockId（到 endBlockId）在父块里的位置，end 不含 */
export function locate(blocks: readonly DocBlock[], documentId: string, blockId: string, endBlockId?: string) {
  const byId = new Map(blocks.map((block) => [block.block_id, block]));
  const block = byId.get(blockId);
  const stale = "，先用 feishu_doc_read（with_block_ids=true）重新读一遍，拿最新的块 id";
  if (!block) {
    throw new DocError(`文档里没有块 ${blockId}${stale}`);
  }
  if (blockId === documentId || kindOf(block) === "page") {
    throw new DocError("这是整篇文档的根块，不能直接改。要加到文末用 append，要改正文请指定具体的块");
  }
  if (["table_cell", "grid_column"].includes(kindOf(block))) {
    throw new DocError("不能单独改表格单元格或分栏里的一栏，请对整个表格或分栏操作");
  }
  const parentId = block.parent_id;
  const siblings = parentId ? byId.get(parentId)?.children : undefined;
  const start = siblings?.indexOf(blockId) ?? -1;
  if (!parentId || start < 0) {
    throw new DocError(`找不到块 ${blockId} 在文档里的位置${stale}`);
  }
  let end = start + 1;
  if (endBlockId && endBlockId !== blockId) {
    const last = siblings!.indexOf(endBlockId);
    if (last < 0) {
      throw new DocError(`块 ${endBlockId} 和 ${blockId} 不在同一层（同一个父块下），范围的首尾要是同一层的块`);
    }
    if (last < start) {
      throw new DocError(`end_block_id 在 block_id 前面，范围要从前往后`);
    }
    end = last + 1;
  }
  return { parentId, start, end };
}
