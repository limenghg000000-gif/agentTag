import { addChanges, type CodeWorkspaces, RECENT_BRANCHES, type Workspace } from "../repo.js";
import { type Tool, type ToolContext, type ToolOutput, ToolOutputBuilder } from "./tool.js";

export const CODE_TOOL_NAMES = [
  "code_branches",
  "code_list_files",
  "code_read_file",
  "code_search",
  "code_edit_file",
  "code_diff",
  "code_open_pr",
] as const;

export interface CodeToolsOptions {
  workspaces: CodeWorkspaces;
  /** 话题标识：同一话题的几次任务共用一份工作目录 */
  threadKey: string;
  /** 发起人的名字，写进 PR 描述 */
  askerName?: string;
  botName: () => string;
}

/** 代码仓库工具。每个任务单独创建一套，工作目录按话题复用。 */
export function createCodeTools({ workspaces, threadKey, askerName, botName }: CodeToolsOptions): Tool[] {
  const repos = workspaces.repos;
  const { requestName, refOf } = workspaces.host;
  const opened = new Map<string, Promise<Workspace>>();
  // 一个任务里每个仓库只打开（克隆或更新）一次
  const workspace = (args: Record<string, unknown>, { signal }: ToolContext) => {
    const repo = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : repos.length === 1 ? repos[0] : "";
    if (!repo) {
      throw new Error(`要用 repo 指明仓库：${repos.join("、")}`);
    }
    const key = repo.toLowerCase();
    let ws = opened.get(key);
    if (!ws) {
      ws = workspaces.open(threadKey, repo, signal);
      ws.catch(() => opened.delete(key));
      opened.set(key, ws);
    }
    return ws;
  };

  const repoParam = {
    type: "string",
    ...(repos.length > 1 ? { enum: [...repos] } : {}),
    description: `仓库的项目路径${repos.length === 1 ? `，只有 ${repos[0]} 一个，可以不填` : ""}`,
  };
  const required = (...keys: string[]) => (repos.length === 1 ? keys : ["repo", ...keys]);
  const branchParam = {
    type: "string",
    description: "要看的分支，不填就是这个话题当前的分支（没切换过就是仓库默认分支）。只看一眼别的分支用它，不会切换当前分支",
  };

  const branches: Tool = {
    spec: {
      name: "code_branches",
      description:
        "列出代码仓库的分支（按最近提交从新到旧，带最近一次提交的时间、作者和说明），或者用 switch_to 切换这个话题的当前分支。" +
        "默认看的是仓库默认分支；群成员说了要看哪个分支时切过去，这个话题后面看代码、改代码、开" +
        `${requestName}都基于它。切换要单独调用，等它返回后再调其他代码工具。`,
      parameters: {
        type: "object",
        properties: {
          repo: repoParam,
          switch_to: { type: "string", description: "要切换到的分支名。不填就只列出分支" },
          filter: { type: "string", description: "只列名字里带这个词的分支" },
        },
        required: required(),
      },
    },
    describe: (args) => (optional(args.switch_to) ? `切到 ${optional(args.switch_to)} 分支` : "列出代码分支"),
    async run(args, ctx) {
      const ws = await workspace(args, ctx);
      const target = optional(args.switch_to);
      return target ? report(ctx, await ws.switchBranch(target, ctx.signal)) : ws.listBranches(optional(args.filter), ctx.signal);
    },
  };

  const listFiles: Tool = {
    spec: {
      name: "code_list_files",
      description: "列出代码仓库里的文件。了解项目结构、找文件时用。dir 列某个目录下的全部文件，glob 按模式找，都不填列全部。",
      parameters: {
        type: "object",
        properties: {
          repo: repoParam,
          dir: { type: "string", description: "目录，如 docs" },
          glob: { type: "string", description: "文件模式，如 **/*.md、**/README.md" },
          branch: branchParam,
        },
        required: required(),
      },
    },
    describe: (args) => `列出代码文件 ${optional(args.glob) ?? optional(args.dir) ?? ""}${onBranch(args.branch)}`.trim(),
    async run(args, ctx) {
      const ws = await workspace(args, ctx);
      return report(ctx, await ws.listFiles({ dir: optional(args.dir), glob: optional(args.glob), branch: optional(args.branch) }, ctx.signal));
    },
  };

  const read: Tool = {
    spec: {
      name: "code_read_file",
      description: "读代码仓库里的一个文件，带行号，一次最多几百行，长文件用 start_line 往后读。路径是目录时列出其中的文件。",
      parameters: {
        type: "object",
        properties: {
          repo: repoParam,
          path: { type: "string", description: "相对仓库根目录的路径，用 code_list_files 或 code_search 查到的" },
          start_line: { type: "integer", description: "从第几行开始，默认 1" },
          end_line: { type: "integer", description: "读到第几行（含）" },
          branch: branchParam,
        },
        required: required("path"),
      },
    },
    describe: (args) => `读代码 ${args.path}${onBranch(args.branch)}`,
    async run(args, ctx) {
      const file = requireString(args, "path");
      const start = typeof args.start_line === "number" ? args.start_line : 1;
      const end = typeof args.end_line === "number" ? args.end_line : undefined;
      return report(ctx, await (await workspace(args, ctx)).readFile(file, start, end, optional(args.branch), ctx.signal));
    },
  };

  const search: Tool = {
    spec: {
      name: "code_search",
      description:
        "在代码仓库里搜索，返回「文件:行号: 内容」。找函数定义、调用处、配置项、报错文案时用。" +
        "pattern 默认是 POSIX 扩展正则（不支持 \\d、\\w 这类写法，用 [0-9]、[A-Za-z_]），literal=true 时按原文搜。",
      parameters: {
        type: "object",
        properties: {
          repo: repoParam,
          pattern: { type: "string", description: "要搜的正则或原文" },
          literal: { type: "boolean", description: "按原文搜，不当正则" },
          ignore_case: { type: "boolean", description: "不区分大小写" },
          glob: { type: "string", description: "只搜这些文件，如 **/*.go" },
          branches: {
            type: "array",
            items: { type: "string" },
            description:
              `在这些分支上一起搜，结果按分支分开列，不会切换当前分支。填 ["recent"] 是最近有提交的 ${RECENT_BRANCHES} 个分支，` +
              "不确定代码在哪个分支、或者当前分支上搜不到时用。不填只搜当前分支",
          },
        },
        required: required("pattern"),
      },
    },
    describe: (args) => {
      const names = list(args.branches);
      const where = names.length === 0 ? "" : names.some((n) => /^recent$/i.test(n)) ? "（最近活跃的分支）" : `（${names.join("、")} 分支）`;
      return `搜代码：${preview(args.pattern)}${where}`;
    },
    async run(args, ctx) {
      const pattern = requireString(args, "pattern");
      const ws = await workspace(args, ctx);
      const options = { literal: args.literal === true, ignoreCase: args.ignore_case === true, glob: optional(args.glob), branches: list(args.branches) };
      return report(ctx, await ws.search(pattern, options, ctx.signal));
    },
  };

  const edit: Tool = {
    writes: true,
    spec: {
      name: "code_edit_file",
      description:
        `改代码仓库里的文件（改动先留在机器人的工作目录里，用 code_open_pr 开${requestName}时才会提交）。` +
        "只在群成员明确要你改代码时使用，改之前先读相关代码。" +
        "把文件里的 old_text 换成 new_text：old_text 要和文件内容一字不差（含缩进），并且在文件里只出现一次，多带几行上下文。" +
        "新建文件或整个重写时不填 old_text，new_text 写完整内容。",
      parameters: {
        type: "object",
        properties: {
          repo: repoParam,
          path: { type: "string", description: "相对仓库根目录的路径" },
          old_text: { type: "string", description: "要替换的原文，新建或整个重写文件时不填" },
          new_text: { type: "string", description: "替换成的内容，或新文件的完整内容" },
        },
        required: required("path", "new_text"),
      },
    },
    describe: (args) => `改代码 ${args.path}`,
    async run(args, ctx) {
      const file = requireString(args, "path");
      if (typeof args.new_text !== "string") {
        throw new Error("缺少 new_text 参数");
      }
      const oldText = typeof args.old_text === "string" && args.old_text !== "" ? args.old_text : undefined;
      return report(ctx, await (await workspace(args, ctx)).editFile(file, oldText, args.new_text));
    },
  };

  const diff: Tool = {
    spec: {
      name: "code_diff",
      description: "查看目前所有还没推上去的改动（git diff）。开 PR 之前用它检查一遍，群成员想先看改动时也用它。",
      parameters: { type: "object", properties: { repo: repoParam }, required: required() },
    },
    describe: () => "查看代码改动",
    async run(args, ctx) {
      return report(ctx, await (await workspace(args, ctx)).diff());
    },
  };

  const openPr: Tool = {
    writes: true,
    spec: {
      name: "code_open_pr",
      description:
        `把改动提交到机器人新建的分支，开${requestName}到这个话题的当前分支（没切换过就是默认分支），返回链接。这个话题里已经开过${requestName}时，新改动推到同一个。` +
        `只在群成员要你提交或开${requestName}时使用；机器人不会合并，也不会推到已有的分支。`,
      parameters: {
        type: "object",
        properties: {
          repo: repoParam,
          title: { type: "string", description: `${requestName}标题，也是提交说明的第一行，一句话说清改了什么` },
          body: { type: "string", description: `${requestName}描述：为什么改、改了什么、怎么验证（机器人没有运行代码，要写明）` },
        },
        required: required("title", "body"),
      },
    },
    describe: () => `提交代码并开${requestName}`,
    async run(args, ctx) {
      const title = requireString(args, "title").split("\n")[0].trim();
      const body = [
        typeof args.body === "string" ? args.body.trim() : "",
        `由 ${askerName || "群成员"} 在飞书群里让「${botName()}」提交。`,
      ]
        .filter(Boolean)
        .join("\n\n---\n");
      const ws = await workspace(args, ctx);
      const pr = await ws.openPullRequest(title, body, ctx.signal);
      const out = new ToolOutputBuilder(ws.repo).line(
        pr.created
          ? `已开${requestName} ${refOf(pr.number)}：${pr.url}`
          : `已把新改动推到这个话题之前开的${requestName} ${refOf(pr.number)}：${pr.url}`,
      );
      return report(ctx, addChanges(out.line(""), pr.changes).build());
    },
  };

  return [branches, listFiles, read, search, edit, diff, openPr];
}

/** 把结果里查到的代码位置交给机器人的回答检查，文字交给模型 */
function report(ctx: ToolContext, output: ToolOutput): string {
  ctx.onFacts?.(output.facts);
  return output.text;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`缺少 ${key} 参数`);
  }
  return value;
}

/** 数组参数：模型有时会写成逗号分隔的字符串 */
function list(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,，、]/) : [];
  return items.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function onBranch(value: unknown): string {
  const branch = optional(value);
  return branch ? `（${branch} 分支）` : "";
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function preview(value: unknown): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}
