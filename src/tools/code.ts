import {
  addChanges,
  type CodeWorkspaces,
  DEFAULT_LIST_REQUESTS,
  DEFAULT_LOG_COMMITS,
  MAX_LIST_REQUESTS,
  MAX_LOG_COMMITS,
  type OpenedRequest,
  RECENT_BRANCHES,
  type Workspace,
} from "../repo.js";
import { type Piece, type Tool, type ToolContext, type ToolOutput, ToolOutputBuilder } from "./tool.js";

export const CODE_TOOL_NAMES = [
  "code_branches",
  "code_list_files",
  "code_read_file",
  "code_search",
  "code_log",
  "code_requests",
  "code_edit_file",
  "code_diff",
  "code_open_pr",
  "code_merge",
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
  // 平台支持时机器人能合并：只合自己开的、开到没保护的分支的
  const canMerge = workspaces.host.mergeCheck !== undefined && workspaces.host.mergeRequest !== undefined;
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
        `${requestName}都基于它。切换要单独调用，等它返回后再调其他代码工具。` +
        `switch_to 只能切到已有的分支：要新分支不用先建，改好代码用 code_open_pr 的 branch 起名。` +
        `开过${requestName}以后也能切，之前的${requestName}不受影响，切回那个分支时新改动接着推到它；改了代码还没推上去时不能切。`,
      parameters: {
        type: "object",
        properties: {
          repo: repoParam,
          switch_to: { type: "string", description: "要切换到的已有分支名。不填就只列出分支" },
          filter: { type: "string", description: "只列名字里带这个词的分支" },
        },
        required: required(),
      },
    },
    describe: (args) => (optional(args.switch_to) ? `切到 ${optional(args.switch_to)} 分支` : "列出代码分支"),
    async run(args, ctx) {
      const ws = await workspace(args, ctx);
      const target = optional(args.switch_to);
      return report(ctx, await (target ? ws.switchBranch(target, ctx.signal) : ws.listBranches(optional(args.filter), ctx.signal)));
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

  // 2026-10-10 转链排查：修复「c.tb.cn 短链落地半屏详情页」已经合进 master，提交说明写得清清楚楚，
  // 机器人看不到提交历史，读了 master 的代码还是下了「不是服务故障、让用户重新分享」的结论
  const log: Tool = {
    spec: {
      name: "code_log",
      description:
        "查代码仓库一个分支的提交历史（提交号、时间、作者、说明），从新到旧，可以按提交说明里的词、改过的文件或目录、起始日期筛。" +
        "用来确认一个问题有没有人改过、改在哪个提交、什么时候合进来的：排查追到某段代码或某个报错，" +
        "要下「代码没处理」「不是服务的问题」「让用户换个方式」这类结论前，先按报错文案、关键参数或文件查一下最近的提交。" +
        "只看一个分支（默认当前分支）；要知道修复合没合进别的分支，用 branch 再查一次。",
      parameters: {
        type: "object",
        properties: {
          repo: repoParam,
          query: { type: "string", description: "提交说明里要有的词，几个词用空格隔开（都要有），不分大小写，如「c.tb.cn 转链」" },
          path: { type: "string", description: "只看改过这个文件或目录的提交，相对仓库根目录" },
          since: { type: "string", description: "只看这天以后的提交，如 2026-10-01" },
          limit: { type: "integer", description: `最多列几个，默认 ${DEFAULT_LOG_COMMITS}，最多 ${MAX_LOG_COMMITS}` },
          branch: branchParam,
        },
        required: required(),
      },
    },
    describe: (args) => `查提交：${[optional(args.query) ? preview(args.query) : "", optional(args.path) ?? ""].filter(Boolean).join(" ") || "最近的提交"}${onBranch(args.branch)}`,
    async run(args, ctx) {
      const ws = await workspace(args, ctx);
      const options = {
        query: optional(args.query),
        path: optional(args.path),
        since: optional(args.since),
        branch: optional(args.branch),
        limit: typeof args.limit === "number" ? args.limit : undefined,
      };
      return report(ctx, await ws.log(options, ctx.signal));
    },
  };

  const requests: Tool = {
    spec: {
      name: "code_requests",
      description:
        `列出代码仓库里的${requestName}（编号、标题、从哪个分支合到哪个分支、状态、作者、更新时间），按最近更新从新到旧，标出这个话题开的。` +
        `群成员提到别处做的修改、别的话题开的${requestName}（如「把京东短链修复合到 uat」「上次那个 MR」）时，先用它按关键词找到是哪一个，` +
        "再说它合没合、合到了哪个分支；不要只看现有的代码和提交历史就下「已经合进去了」的结论。",
      parameters: {
        type: "object",
        properties: {
          repo: repoParam,
          query: { type: "string", description: "标题或描述里要有的词，如「短链」「jd」" },
          state: { type: "string", enum: ["opened", "merged", "all"], description: "opened 开着的（默认），merged 已合并的，all 全部（含关掉的）" },
          limit: { type: "integer", description: `最多列几个，默认 ${DEFAULT_LIST_REQUESTS}，最多 ${MAX_LIST_REQUESTS}` },
        },
        required: required(),
      },
    },
    describe: (args) => `查${requestName}${optional(args.query) ? `：${preview(args.query)}` : ""}`,
    async run(args, ctx) {
      const ws = await workspace(args, ctx);
      const state = args.state === "merged" || args.state === "all" ? args.state : "opened";
      const options = { state, search: optional(args.query), limit: typeof args.limit === "number" ? args.limit : undefined } as const;
      return report(ctx, await ws.listRequests(options, ctx.signal));
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
        `把改动提交到机器人新建的分支，开${requestName}到这个话题的当前分支（没切换过就是默认分支），返回链接。这个话题在这个分支上已经开过${requestName}时，新改动推到同一个。` +
        `群成员要「起一个新分支」时就用它：branch 填群成员说的分支名，没说就不填，机器人会起名。` +
        `同一份改动还要合到别的分支（如「合并到 uat」「uat 也要」）时，在这个话题里直接调用，target 填那个分支：机器人从那个分支拉一个新分支，把改动搬过去，再开一个到那个分支的${requestName}，之前开的不受影响，不用让群成员新开话题。` +
        `要搬的是别的话题或别人开的${requestName}，先用 code_requests 找到编号，填 from 和 target。` +
        `只在群成员要你提交、开${requestName}或者合到某个分支时使用；` +
        (canMerge
          ? `它只开不合，群成员要合并（「合并到 uat」）时，开好以后再用 code_merge 合。机器人不会推到已有的分支。`
          : `机器人不会合并（「合并到 uat」就是开一个到 uat 的${requestName}，合并要人来点），也不会推到已有的分支。`),
      parameters: {
        type: "object",
        properties: {
          repo: repoParam,
          title: { type: "string", description: `${requestName}标题，也是提交说明的第一行，一句话说清改了什么` },
          body: { type: "string", description: `${requestName}描述：为什么改、改了什么、怎么验证（机器人没有运行代码，要写明）` },
          branch: {
            type: "string",
            description: "新分支的名字，群成员说了分支名时填（如 bugfix/jd_shortlink）。只能是还没有的分支，不填由机器人起名；这个话题在这个分支上已经推过改动时不用填",
          },
          target: {
            type: "string",
            description: `${requestName}开到哪个分支，不填是这个话题当前的分支。和当前分支不一样时，机器人从它拉新分支、把改动搬过去再开`,
          },
          from: { type: "integer", description: `要搬的是仓库里已有的这个${requestName}的改动（填编号，如 353），要和 target 一起填` },
        },
        required: required("title", "body"),
      },
    },
    describe: (args) =>
      optional(args.target) ? `把改动开${requestName}到 ${optional(args.target)} 分支` : `提交代码并开${requestName}`,
    async run(args, ctx) {
      const title = requireString(args, "title").split("\n")[0].trim();
      const body = [
        typeof args.body === "string" ? args.body.trim() : "",
        `由 ${askerName || "群成员"} 在飞书群里让「${botName()}」提交。`,
      ]
        .filter(Boolean)
        .join("\n\n---\n");
      const ws = await workspace(args, ctx);
      const from = requestNumber(args.from, "from");
      const pr = await ws.openPullRequest(title, body, { branch: optional(args.branch), target: optional(args.target), from }, ctx.signal);
      const out = new ToolOutputBuilder(ws.repo).parts(...openedLine(pr, requestName, refOf));
      return report(ctx, addChanges(out.line(""), pr.changes).build());
    },
  };

  const merge: Tool = {
    writes: true,
    spec: {
      name: "code_merge",
      description:
        `合并一个${requestName}（填编号）。只合这个话题里机器人自己开的、开到没保护的分支（如 uat、test）的；别的话题开的、别人往分支上推过提交的、改动是从别人的${requestName}搬来的都不合；` +
        `开到受保护的分支（master、prod 这类线上分支，以 ${workspaces.host.name} 上的保护设置为准）或仓库默认分支的不合，要人审过再点，照它返回的原因告诉群成员。` +
        `只在群成员明确要合并时用（「合并到 uat」「把 !354 合了」）：先用 code_open_pr 开好到那个分支的${requestName}，再用它合；已经开过的直接填编号。` +
        `只说「提个 PR」「开个${requestName}」时只开不合。要等流水线通过才能合的，会设成流水线通过后自动合并。`,
      parameters: {
        type: "object",
        properties: {
          repo: repoParam,
          number: { type: "integer", description: `要合并的${requestName}编号，如 354` },
        },
        required: required("number"),
      },
    },
    describe: (args) => {
      let number: number | undefined;
      try {
        number = requestNumber(args.number, "number");
      } catch {
        number = undefined;
      }
      return number ? `合并${requestName} ${refOf(number)}` : `合并${requestName}`;
    },
    async run(args, ctx) {
      const number = requestNumber(args.number, "number");
      if (number === undefined) {
        throw new Error(`缺少 number 参数，填要合并的${requestName}编号`);
      }
      return report(ctx, await (await workspace(args, ctx)).mergeRequest(number, ctx.signal));
    },
  };

  return [branches, listFiles, read, search, log, requests, edit, diff, openPr, ...(canMerge ? [merge] : [])];
}

/** 开好合并请求以后的第一行：哪个分支开到哪个分支，改动是不是从别处搬过来的 */
function openedLine(pr: OpenedRequest, requestName: string, refOf: (number: number) => string): Piece[] {
  const ref = refOf(pr.number);
  const route: Piece[] = ["（", [pr.branch, { branch: pr.branch }], " → ", [pr.base, { branch: pr.base }], `）：${pr.url}`];
  if (!pr.created) {
    return [`已把新改动推到这个话题之前开的${requestName} ${ref}`, ...route];
  }
  if (pr.replaced) {
    const was =
      pr.replaced.state === "merged"
        ? `${refOf(pr.replaced.number)} 已经合并了，新改动`
        : `${refOf(pr.replaced.number)} 已经关掉了（没合并），它的改动连同新改动`;
    return [`这个话题之前开的${requestName} ${was}从 `, [pr.base, { branch: pr.base }], ` 最新的代码另开了${requestName} ${ref}`, ...route];
  }
  if (!pr.ported) {
    return [`已开${requestName} ${ref}`, ...route];
  }
  const { from, earlier, request } = pr.ported;
  const source: Piece[] = request
    ? [
        `，把${refOf(request.number)}（`,
        [request.source, { branch: request.source }],
        " → ",
        [request.target, { branch: request.target }],
        `，${request.state === "merged" ? "已合并" : "还开着"}）的改动`,
      ]
    : from
      ? ["，把这个话题在 ", [from, { branch: from }], " 分支上的改动"]
      : ["，把改动"];
  const kept = request
    ? `${refOf(request.number)} 不受影响。`
    : from && earlier !== undefined
      ? `之前在 ${from} 上开的 ${refOf(earlier)} 不受影响。`
      : "";
  return [
    "已从 ",
    [pr.base, { branch: pr.base }],
    " 拉出新分支 ",
    [pr.branch, { branch: pr.branch }],
    ...source,
    `搬过去，开了${requestName} ${ref}`,
    ...route,
    `。${kept}合并要人来点。`,
  ];
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

/** 合并请求的编号参数（from、number），模型有时写成「!353」「#353」 */
function requestNumber(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = typeof value === "number" ? value : typeof value === "string" && /^\s*[!#]?\d+\s*$/.test(value) ? Number(value.replace(/\D/g, "")) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${key} 要填合并请求的编号，如 353：${String(value)}`);
  }
  return number;
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
