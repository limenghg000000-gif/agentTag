import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./history.js";

/** 读文件时一次最多返回的行数和字数 */
export const MAX_READ_LINES = 400;
export const MAX_READ_CHARS = 20000;
/** 超过这个大小的文件不读不改 */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_MATCHES = 100;
const MAX_LIST_FILES = 500;
const MAX_DIFF_CHARS = 15000;
const GIT_TIMEOUT_MS = 120_000;
/** 话题里的工作目录多久没用就删掉 */
export const WORKSPACE_KEEP_MS = 3 * 24 * 60 * 60_000;
const STATE_FILE = ".agenttag.json";

/** 代码平台：怎么拉代码、怎么认证、怎么开合并请求。换平台（如云效）只需另写一个实现 */
export interface CodeHost {
  /** 平台名，写进提示和报错，如 GitLab */
  readonly name: string;
  /** 合并请求在这个平台上的叫法：GitLab 叫合并请求（MR），GitHub 叫 PR */
  readonly requestName: string;
  /** 合并请求编号的写法：GitLab 是 !12，GitHub 是 #12 */
  refOf(number: number): string;
  cloneUrl(repo: string): string;
  /** 给 git 进程的环境变量（认证），不能出现在命令行参数里 */
  gitEnv(): Record<string, string>;
  openPullRequest(repo: string, pr: { head: string; base: string; title: string; body: string }): Promise<{ url: string; number: number }>;
}

/**
 * 自建 GitLab：用一个访问令牌（项目或群组访问令牌、个人访问令牌都行，要 api 权限，角色至少 Developer）
 * 拉代码、推分支、开合并请求。repo 是项目路径，如 group/sub/project。
 */
export function createGitLabHost(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): CodeHost {
  const base = baseUrl.trim().replace(/\/+$/, "");
  // git 走 HTTP 时用户名随便填，密码是令牌
  const basic = Buffer.from(`oauth2:${token}`).toString("base64");
  return {
    name: "GitLab",
    requestName: "合并请求",
    refOf: (number) => `!${number}`,
    cloneUrl: (repo) => `${base}/${repo}.git`,
    gitEnv: () => ({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${base}/.extraheader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    }),
    async openPullRequest(repo, pr) {
      const res = await fetchImpl(`${base}/api/v4/projects/${encodeURIComponent(repo)}/merge_requests`, {
        method: "POST",
        headers: { "private-token": token, "content-type": "application/json" },
        body: JSON.stringify({
          source_branch: pr.head,
          target_branch: pr.base,
          title: pr.title,
          description: pr.body,
          // 合并后删掉机器人建的分支
          remove_source_branch: true,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => ({}))) as { iid?: number; web_url?: string; message?: unknown; error?: unknown };
      if (!res.ok || !body.web_url || !body.iid) {
        const raw = body.message ?? body.error;
        const detail = raw === undefined ? "" : typeof raw === "string" ? raw : JSON.stringify(raw);
        const hint =
          res.status === 401
            ? "令牌无效或过期了"
            : res.status === 403
              ? "令牌没有权限，要 api 权限，对应的账号在项目里至少是 Developer"
              : res.status === 404
                ? "找不到这个项目，或者令牌访问不了它"
                : res.status === 409
                  ? "这个分支已经有打开的合并请求了"
                  : "";
        throw new RepoError(`GitLab 开合并请求失败（HTTP ${res.status}）${hint ? `：${hint}` : ""}。${detail}`.trim());
      }
      return { url: body.web_url, number: body.iid };
    },
  };
}

/** GitHub：用一个 token（fine-grained，给指定仓库 Contents 和 Pull requests 读写权限）拉代码、推分支、开 PR */
export function createGitHubHost(token: string, fetchImpl: typeof fetch = fetch): CodeHost {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    name: "GitHub",
    requestName: "PR",
    refOf: (number) => `#${number}`,
    cloneUrl: (repo) => `https://github.com/${repo}.git`,
    gitEnv: () => ({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    }),
    async openPullRequest(repo, pr) {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/pulls`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "AgentTag",
          "content-type": "application/json",
        },
        body: JSON.stringify(pr),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        html_url?: string;
        number?: number;
        message?: string;
        errors?: { message?: string }[];
      };
      if (!res.ok || !body.html_url || !body.number) {
        const detail = [body.message, ...(body.errors ?? []).map((e) => e.message)].filter(Boolean).join("；");
        throw new RepoError(
          res.status === 401 || res.status === 403 || res.status === 404
            ? `GitHub 拒绝开 PR（HTTP ${res.status}）：token 可能没有这个仓库的 Pull requests 写权限。${detail}`
            : `GitHub 开 PR 失败（HTTP ${res.status}）：${detail}`,
        );
      }
      return { url: body.html_url, number: body.number };
    },
  };
}

/** 给模型看的错误：说明哪里不对、该怎么办 */
export class RepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoError";
  }
}

interface GitOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** 这些退出码不算出错（比如 git grep 没搜到返回 1） */
  okCodes?: number[];
}

/** 调 git（不经过 shell，参数原样传），超时或中止时杀掉进程 */
export function runGit(args: string[], { cwd, env, signal, okCodes = [] }: GitOptions = {}): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      // 不跑仓库里的任何钩子，不读终端输入
      ["-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false", ...args],
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8", ...env },
        signal,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const code = typeof (err as { code?: unknown } | null)?.code === "number" ? (err as { code: number }).code : err ? -1 : 0;
        if (err && !okCodes.includes(code)) {
          if (signal?.aborted) {
            reject(err);
            return;
          }
          const detail = String(stderr || err.message).trim().split("\n").slice(-5).join("\n");
          reject(new RepoError(`git ${args[0]} 失败：${detail}`));
          return;
        }
        resolve({ stdout, code });
      },
    );
  });
}

interface WorkspaceState {
  /** 机器人为这个话题建的分支，第一次提交时建 */
  branch?: string;
  /** 最近一次推上去的提交 */
  pushedSha?: string;
  prUrl?: string;
  prNumber?: number;
}

export interface CodeWorkspacesOptions {
  /** 工作目录的根，每个话题一个子目录 */
  root: string;
  host: CodeHost;
  /** 允许操作的仓库（GitLab 的项目路径 group/project，或 GitHub 的 owner/repo） */
  repos: readonly string[];
  logger?: Logger;
  now?: () => Date;
}

/**
 * 代码仓库的工作目录。每个话题每个仓库一份浅克隆，话题里的几次任务共用，改了一半的代码和开过的 PR 都接得上；
 * 同一话题的任务本来就排队执行，不会同时改一份目录。几天没用的目录由 sweep 删掉。
 */
export class CodeWorkspaces {
  readonly repos: readonly string[];
  readonly host: CodeHost;
  private readonly root: string;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(opts: CodeWorkspacesOptions) {
    this.root = opts.root;
    this.host = opts.host;
    this.repos = opts.repos;
    this.logger = opts.logger ?? console;
    this.now = opts.now ?? (() => new Date());
  }

  /** 打开（没有就克隆）这个话题的工作目录。没有未提交改动、也没开过 PR 时先更新到最新 */
  async open(threadKey: string, repo: string, signal?: AbortSignal): Promise<Workspace> {
    const name = this.repos.find((r) => r.toLowerCase() === repo.trim().toLowerCase());
    if (!name) {
      throw new RepoError(`没有接入仓库 ${repo}，能操作的只有：${this.repos.join("、")}`);
    }
    const dir = path.join(this.root, safeName(threadKey), safeName(name.replace("/", "__")));
    const env = this.host.gitEnv();
    const exists = await stat(path.join(dir, ".git")).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(path.dirname(dir), { recursive: true });
      try {
        await runGit(["clone", "--depth", "1", "--no-tags", this.host.cloneUrl(name), dir], { env, signal });
      } catch (err) {
        await rm(dir, { recursive: true, force: true });
        throw err;
      }
      this.logger.info(`代码仓库 ${name} 已克隆到 ${dir}`);
    }
    const workspace = new Workspace(name, dir, env, this.host, await readState(dir), this.now);
    await workspace.init(exists, signal);
    return workspace;
  }

  /** 删掉超过 maxAgeMs 没用过的话题工作目录 */
  async sweep(maxAgeMs = WORKSPACE_KEEP_MS): Promise<number> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.join(this.root, entry.name);
      if (this.now().getTime() - (await lastUsed(dir)) > maxAgeMs) {
        await rm(dir, { recursive: true, force: true });
        removed++;
      }
    }
    if (removed > 0) {
      this.logger.info(`删掉了 ${removed} 个超过 ${Math.round(maxAgeMs / 86_400_000)} 天没用的代码工作目录`);
    }
    return removed;
  }
}

/** 话题目录下各仓库状态文件的最新修改时间（每次打开都会更新） */
async function lastUsed(threadDir: string): Promise<number> {
  const repos = await readdir(threadDir).catch(() => []);
  const times = await Promise.all(
    [threadDir, ...repos.map((r) => path.join(threadDir, r, ".git", STATE_FILE))].map((p) =>
      stat(p).then(
        (s) => s.mtimeMs,
        () => 0,
      ),
    ),
  );
  return Math.max(...times);
}

async function readState(dir: string): Promise<WorkspaceState> {
  try {
    return JSON.parse(await readFile(path.join(dir, ".git", STATE_FILE), "utf8")) as WorkspaceState;
  } catch {
    return {};
  }
}

/** 一个仓库的工作目录。路径都相对仓库根目录，不能跳出去，也不能碰 .git */
export class Workspace {
  defaultBranch = "main";
  private realDir = "";

  constructor(
    readonly repo: string,
    readonly dir: string,
    private readonly env: Record<string, string>,
    private readonly host: CodeHost,
    private state: WorkspaceState,
    private readonly now: () => Date,
  ) {}

  get pullRequest(): { url: string; number: number; branch: string } | undefined {
    return this.state.prUrl && this.state.prNumber && this.state.branch
      ? { url: this.state.prUrl, number: this.state.prNumber, branch: this.state.branch }
      : undefined;
  }

  async init(existed: boolean, signal?: AbortSignal): Promise<void> {
    this.realDir = await realpath(this.dir);
    const head = await this.git(["rev-parse", "--abbrev-ref", "origin/HEAD"], signal).catch(() => "origin/main");
    this.defaultBranch = head.trim().replace(/^origin\//, "") || "main";
    if (existed && !this.state.branch && !(await this.hasChanges(signal))) {
      await this.git(["fetch", "--depth", "1", "--no-tags", "origin", this.defaultBranch], signal);
      await this.git(["reset", "--hard", "FETCH_HEAD"], signal);
    }
    // 状态文件的修改时间记作最近使用时间，sweep 按它删旧目录
    await this.saveState();
  }

  /** 列出文件（含新建还没提交的）。glob 如 src/**\/*.ts，dir 如 src/tools */
  async listFiles({ dir, glob }: { dir?: string; glob?: string } = {}): Promise<string> {
    const specs = glob ? [`:(glob)${glob}`] : dir ? [this.relative(dir)] : [];
    const out = await this.git(["ls-files", "--cached", "--others", "--exclude-standard", "--", ...specs]);
    const files = [...new Set(out.split("\n").filter(Boolean))];
    if (files.length === 0) {
      return "没有匹配的文件。";
    }
    const shown = files.slice(0, MAX_LIST_FILES);
    const more = files.length - shown.length;
    return [`共 ${files.length} 个文件${more > 0 ? `，只列出前 ${MAX_LIST_FILES} 个，缩小范围再看` : ""}：`, ...shown].join("\n");
  }

  /** 读文件，带行号。start/end 是行号（从 1 开始，含 end） */
  async readFile(file: string, start = 1, end?: number): Promise<string> {
    const abs = await this.resolve(file);
    const info = await stat(abs).catch(() => undefined);
    if (!info) {
      throw new RepoError(`没有这个文件：${file}。可以先用 code_list_files 或 code_search 找找`);
    }
    if (info.isDirectory()) {
      return this.listFiles({ dir: file });
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new RepoError(`${file} 有 ${Math.round(info.size / 1024)} KB，太大了不读，用 code_search 搜需要的部分`);
    }
    const buf = await readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) {
      throw new RepoError(`${file} 是二进制文件，读不了`);
    }
    const lines = buf.toString("utf8").split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    const from = Math.max(1, Math.floor(start));
    const to = Math.min(lines.length, end ? Math.floor(end) : from + MAX_READ_LINES - 1, from + MAX_READ_LINES - 1);
    if (from > lines.length) {
      return `${file} 只有 ${lines.length} 行。`;
    }
    const body: string[] = [];
    let size = 0;
    let last = from - 1;
    for (let i = from; i <= to; i++) {
      const line = `${i}| ${lines[i - 1]}`;
      if (size + line.length > MAX_READ_CHARS && body.length > 0) {
        break;
      }
      body.push(line);
      size += line.length + 1;
      last = i;
    }
    const head = `${file}（共 ${lines.length} 行，下面是第 ${from} 到 ${last} 行${last < lines.length ? `，要看后面用 start_line=${last + 1}` : ""}）`;
    return [head, ...body].join("\n");
  }

  /** 按正则（或原文）搜代码，返回「文件:行号: 内容」 */
  async search(pattern: string, { literal = false, ignoreCase = false, glob }: { literal?: boolean; ignoreCase?: boolean; glob?: string } = {}): Promise<string> {
    const args = ["grep", "-n", "-I", "--untracked", "--no-color", literal ? "-F" : "-E"];
    if (ignoreCase) {
      args.push("-i");
    }
    args.push("-e", pattern, "--", ...(glob ? [`:(glob)${glob}`] : []));
    const out = await this.git(args, undefined, [1]);
    const matches = out.split("\n").filter(Boolean);
    if (matches.length === 0) {
      return `没有搜到「${pattern}」。`;
    }
    const shown = matches.slice(0, MAX_SEARCH_MATCHES).map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line));
    const more = matches.length - shown.length;
    return [`共 ${matches.length} 处${more > 0 ? `，只列出前 ${MAX_SEARCH_MATCHES} 处，换个更具体的搜法或加 glob 缩小范围` : ""}：`, ...shown].join("\n");
  }

  /**
   * 改文件。oldText 为空时整个文件写成 newText（新建或覆盖）；
   * 否则把文件里唯一出现的 oldText 换成 newText，出现 0 次或多次都报错，让模型给更准的片段。
   */
  async editFile(file: string, oldText: string | undefined, newText: string): Promise<string> {
    const abs = await this.resolve(file, true);
    const info = await lstat(abs).catch(() => undefined);
    if (info?.isSymbolicLink()) {
      throw new RepoError(`${file} 是符号链接，不能改`);
    }
    if (info?.isDirectory()) {
      throw new RepoError(`${file} 是目录`);
    }
    if (!oldText) {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, newText);
      return `${info ? "已覆盖" : "已新建"} ${file}（${newText.split("\n").length} 行）。`;
    }
    if (!info) {
      throw new RepoError(`没有这个文件：${file}。要新建文件时不填 old_text`);
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new RepoError(`${file} 太大了，不改`);
    }
    const content = await readFile(abs, "utf8");
    const count = content.split(oldText).length - 1;
    if (count === 0) {
      throw new RepoError(`${file} 里没找到 old_text（要和文件内容一字不差，包括缩进和空格），先用 code_read_file 看准再改`);
    }
    if (count > 1) {
      throw new RepoError(`${file} 里 old_text 出现了 ${count} 次，多带几行上下文让它只出现一次`);
    }
    const index = content.indexOf(oldText);
    await writeFile(abs, content.slice(0, index) + newText + content.slice(index + oldText.length));
    const line = content.slice(0, index).split("\n").length;
    return `已修改 ${file} 第 ${line} 行起的内容。`;
  }

  /** 当前所有改动（含新建的文件）：先列统计，再给完整 diff */
  async diff(): Promise<string> {
    await this.git(["add", "-A"]);
    // 和上次推上去的（没推过就是默认分支）比，没推的提交和没提交的改动都算
    const base = this.state.pushedSha ?? `origin/${this.defaultBranch}`;
    const stat = (await this.git(["diff", "--cached", "--stat", base])).trim();
    if (!stat) {
      return this.pullRequest
        ? `和已经推到${this.host.requestName}的内容相比没有新的改动（${this.pullRequest.url}）。`
        : "还没有任何改动。";
    }
    const full = await this.git(["diff", "--cached", base]);
    const cut = full.length > MAX_DIFF_CHARS;
    return [stat, "", cut ? `${full.slice(0, MAX_DIFF_CHARS)}\n…（diff 太长，后面省略）` : full].join("\n");
  }

  /**
   * 提交全部改动，推到机器人自己建的分支，开 PR 到默认分支。这个话题已经开过 PR 时推到同一个分支，更新那个 PR。
   * 分支名由程序生成（agenttag/日期-随机），不会推到默认分支或别人的分支。
   */
  async openPullRequest(title: string, body: string, signal?: AbortSignal): Promise<{ url: string; number: number; created: boolean; stat: string }> {
    await this.git(["add", "-A"], signal);
    if (await this.hasStaged(signal)) {
      if (!this.state.branch) {
        this.state.branch = newBranchName(this.now());
        await this.git(["checkout", "-B", this.state.branch], signal);
        await this.saveState();
      }
      await this.git(["commit", "-q", "-m", title, ...(body ? ["-m", body] : [])], signal);
    }
    const branch = this.state.branch;
    const head = (await this.git(["rev-parse", "HEAD"], signal)).trim();
    const base = this.state.pushedSha ?? (await this.git(["rev-parse", `origin/${this.defaultBranch}`], signal)).trim();
    const stat = (await this.git(["diff", "--stat", base, "HEAD"], signal)).trim();
    if (!branch || (head === base && this.pullRequest)) {
      throw new RepoError(
        this.pullRequest
          ? `没有新的改动要推，${this.host.requestName}还是 ${this.pullRequest.url}`
          : "还没有任何改动，先用 code_edit_file 改代码",
      );
    }
    if (head !== this.state.pushedSha) {
      await this.git(["push", "origin", `HEAD:refs/heads/${branch}`], signal);
      this.state.pushedSha = head;
      await this.saveState();
    }

    if (this.pullRequest) {
      return { ...this.pullRequest, created: false, stat };
    }
    // 上次推上去了但开 PR 失败时，这次直接补开
    const pr = await this.host.openPullRequest(this.repo, { head: branch, base: this.defaultBranch, title, body });
    this.state = { ...this.state, prUrl: pr.url, prNumber: pr.number };
    await this.saveState();
    return { ...pr, created: true, stat };
  }

  private async hasChanges(signal?: AbortSignal): Promise<boolean> {
    return (await this.git(["status", "--porcelain"], signal)).trim() !== "";
  }

  private async hasStaged(signal?: AbortSignal): Promise<boolean> {
    const { code } = await runGit(["diff", "--cached", "--quiet"], { cwd: this.dir, env: this.gitEnvWithAuthor(), signal, okCodes: [1] });
    return code === 1;
  }

  private async git(args: string[], signal?: AbortSignal, okCodes?: number[]): Promise<string> {
    return (await runGit(args, { cwd: this.dir, env: this.gitEnvWithAuthor(), signal, okCodes })).stdout;
  }

  private gitEnvWithAuthor(): Record<string, string> {
    return {
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "AgentTag",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "agenttag@users.noreply.github.com",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || process.env.GIT_AUTHOR_NAME || "AgentTag",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || process.env.GIT_AUTHOR_EMAIL || "agenttag@users.noreply.github.com",
      ...this.env,
    };
  }

  private async saveState(): Promise<void> {
    const file = path.join(this.dir, ".git", STATE_FILE);
    await writeFile(file, JSON.stringify(this.state));
    const now = this.now();
    await utimes(file, now, now);
  }

  /** 相对路径，去掉开头的 ./ 和 / */
  private relative(file: string): string {
    const rel = path.posix.normalize(file.trim().replace(/\\/g, "/").replace(/^\.?\/+/, ""));
    if (rel === "." || rel === "") {
      return ".";
    }
    if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
      throw new RepoError(`路径要在仓库里面：${file}`);
    }
    if (rel.split("/").includes(".git")) {
      throw new RepoError("不能读写 .git 目录");
    }
    return rel;
  }

  /** 仓库里的绝对路径。跟着符号链接走出仓库的一律拒绝（防止读到服务器上的 .env 等文件） */
  private async resolve(file: string, forWrite = false): Promise<string> {
    const rel = this.relative(file);
    if (forWrite && rel === ".") {
      throw new RepoError("要写明文件路径");
    }
    const abs = path.join(this.dir, rel);
    // 找到最近一个已存在的上级（新文件的目录可能还没建），按它的真实路径判断
    let existing = abs;
    let suffix = "";
    for (;;) {
      try {
        const real = await realpath(existing);
        const target = path.join(real, suffix);
        if (target !== this.realDir && !target.startsWith(this.realDir + path.sep)) {
          throw new RepoError(`${file} 指向仓库外面，不能访问`);
        }
        return abs;
      } catch (err) {
        if (err instanceof RepoError || (err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
        suffix = path.join(path.basename(existing), suffix);
        existing = path.dirname(existing);
      }
    }
  }
}

function newBranchName(now: Date): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `agenttag/${day}-${randomBytes(3).toString("hex")}`;
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]/g, "_");
}
