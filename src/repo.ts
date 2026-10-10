import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./history.js";
import { type CodeFact, type CodeLocation, ToolError, type ToolOutput, ToolOutputBuilder } from "./tools/tool.js";

/** 读文件时一次最多返回的行数和字数 */
export const MAX_READ_LINES = 400;
export const MAX_READ_CHARS = 20000;
/** 超过这个大小的文件不读不改 */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_MATCHES = 100;
const MAX_LIST_FILES = 500;
const MAX_LIST_BRANCHES = 50;
/** 跨分支搜索时，「最近活跃的分支」取几个；一次最多搜几个分支 */
export const RECENT_BRANCHES = 8;
const MAX_SEARCH_BRANCHES = 10;
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
  /** 检查令牌能不能访问这个仓库：能访问时返回一句说明，不能时抛 RepoError 说明原因。启动时用来在日志里报告每个仓库的状态 */
  checkAccess?(repo: string): Promise<string>;
  /** 用平台接口列出分支和各自最近一次提交，不用拉代码。没有实现时用 git 把所有分支拉下来再列 */
  listBranches?(repo: string, signal?: AbortSignal): Promise<BranchInfo[]>;
}

/** 一个分支和它最近一次提交 */
export interface BranchInfo {
  name: string;
  isDefault?: boolean;
  /** 最近一次提交的时间（ISO 格式） */
  date?: string;
  author?: string;
  title?: string;
}

/** GitLab 的角色等级 */
const GITLAB_ROLES: Record<number, string> = { 10: "Guest", 20: "Reporter", 30: "Developer", 40: "Maintainer", 50: "Owner" };

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
    async checkAccess(repo) {
      const res = await fetchImpl(`${base}/api/v4/projects/${encodeURIComponent(repo)}`, {
        headers: { "private-token": token },
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        path_with_namespace?: string;
        default_branch?: string;
        permissions?: { project_access?: { access_level?: number } | null; group_access?: { access_level?: number } | null };
      };
      if (res.status === 401) {
        throw new RepoError("令牌无效或过期了（HTTP 401）");
      }
      if (res.status === 404) {
        throw new RepoError(
          "找不到项目，或者令牌看不到它（HTTP 404）。检查项目路径和网页地址栏里的是否一致；令牌对应的账号要是项目成员；" +
            "项目访问令牌只能访问建它的那个项目，要访问多个项目请用群组访问令牌或个人访问令牌",
        );
      }
      if (!res.ok) {
        throw new RepoError(`检查失败（HTTP ${res.status}）`);
      }
      const level = Math.max(body.permissions?.project_access?.access_level ?? 0, body.permissions?.group_access?.access_level ?? 0);
      const role = GITLAB_ROLES[level];
      const branch = body.default_branch ? `，默认分支 ${body.default_branch}` : "";
      if (level > 0 && level < 30) {
        throw new RepoError(`能看到项目，但角色是 ${role ?? level}，推不了分支，要 Developer 以上`);
      }
      return `能访问${role ? `，角色 ${role}` : ""}${branch}`;
    },
    async listBranches(repo, signal) {
      const res = await fetchImpl(
        `${base}/api/v4/projects/${encodeURIComponent(repo)}/repository/branches?per_page=100&sort=updated_desc`,
        { headers: { "private-token": token }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) },
      );
      if (!res.ok) {
        throw new RepoError(`GitLab 列分支失败（HTTP ${res.status}）`);
      }
      const body = (await res.json()) as {
        name: string;
        default?: boolean;
        commit?: { committed_date?: string; author_name?: string; title?: string };
      }[];
      return body.map((b) => ({
        name: b.name,
        isDefault: b.default === true,
        date: b.commit?.committed_date,
        author: b.commit?.author_name,
        title: b.commit?.title,
      }));
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
    async checkAccess(repo) {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "AgentTag",
        },
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as { default_branch?: string; permissions?: { push?: boolean } };
      if (res.status === 401) {
        throw new RepoError("token 无效或过期了（HTTP 401）");
      }
      if (res.status === 403 || res.status === 404) {
        throw new RepoError(`找不到仓库，或者 token 没有这个仓库的权限（HTTP ${res.status}）`);
      }
      if (!res.ok) {
        throw new RepoError(`检查失败（HTTP ${res.status}）`);
      }
      if (body.permissions?.push === false) {
        throw new RepoError("能看到仓库，但没有写权限，推不了分支");
      }
      return `能访问${body.default_branch ? `，默认分支 ${body.default_branch}` : ""}`;
    },
  };
}

/** 给模型看的错误：说明哪里不对、该怎么办。facts 是错误里查到的代码位置（文件在、只是读不了时，路径是真的） */
export class RepoError extends ToolError {
  constructor(message: string, facts: readonly CodeFact[] = []) {
    super(message, facts);
    this.name = "RepoError";
  }
}

/** 结果里写的「分支 @ 提交号」，和它对应的代码位置（提交号和分支名） */
interface Label {
  text: string;
  refs: CodeLocation[];
}

/** 一个改动了的文件，按 git diff --numstat 统计；二进制文件没有行数 */
export interface ChangedFile {
  path: string;
  added?: number;
  deleted?: number;
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
  /** 这个话题切换到的分支，看代码、改代码、开合并请求都基于它。没切过时用仓库默认分支 */
  base?: string;
  /** 工作目录检出时 base 分支的提交。比较改动时和它比，远端分支后来更新了也不会混进来 */
  baseSha?: string;
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
  /** 给仓库指定的默认分支（仓库 → 分支）。没指定的用仓库自己的默认分支 */
  branches?: Readonly<Record<string, string>>;
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
  readonly branches: Readonly<Record<string, string>>;
  private readonly root: string;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(opts: CodeWorkspacesOptions) {
    this.root = opts.root;
    this.host = opts.host;
    this.repos = opts.repos;
    this.branches = opts.branches ?? {};
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
    const configured = this.branches[name];
    const exists = await stat(path.join(dir, ".git")).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(path.dirname(dir), { recursive: true });
      try {
        await runGit(
          ["clone", "--depth", "1", "--no-tags", ...(configured ? ["--branch", configured] : []), this.host.cloneUrl(name), dir],
          { env, signal },
        );
      } catch (err) {
        await rm(dir, { recursive: true, force: true });
        throw err;
      }
      this.logger.info(`代码仓库 ${name} 已克隆到 ${dir}`);
    }
    const workspace = new Workspace(name, dir, env, this.host, await readState(dir), this.now, configured);
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
  /** 当前看的分支：切换过就是切换后的，否则是仓库默认分支 */
  baseBranch = "main";
  private realDir = "";
  private queue: Promise<unknown> = Promise.resolve();
  /** git fetch 排队执行，免得几个并行的读取同时拉代码抢锁 */
  private fetching: Promise<unknown> = Promise.resolve();
  /** 这个任务里已经拉过最新提交的分支 */
  private readonly fetched = new Set<string>();
  private branches?: Promise<BranchInfo[]>;

  constructor(
    readonly repo: string,
    readonly dir: string,
    private readonly env: Record<string, string>,
    private readonly host: CodeHost,
    private state: WorkspaceState,
    private readonly now: () => Date,
    /** 配置里给这个仓库指定的默认分支 */
    private readonly configuredBranch?: string,
  ) {}

  get pullRequest(): { url: string; number: number; branch: string } | undefined {
    return this.state.prUrl && this.state.prNumber && this.state.branch
      ? { url: this.state.prUrl, number: this.state.prNumber, branch: this.state.branch }
      : undefined;
  }

  async init(existed: boolean, signal?: AbortSignal): Promise<void> {
    this.realDir = await realpath(this.dir);
    const head = await this.git(["rev-parse", "--abbrev-ref", "origin/HEAD"], signal).catch(() => "origin/main");
    const remoteDefault = this.configuredBranch ?? (head.trim().replace(/^origin\//, "") || "main");
    this.baseBranch = this.state.base ?? remoteDefault;
    if (!existed) {
      this.state.baseSha = (await this.git(["rev-parse", "HEAD"], signal)).trim();
    } else if (!this.state.branch && !(await this.hasChanges(signal))) {
      try {
        await this.fetchBranches([this.baseBranch], signal);
      } catch (err) {
        // 话题里切过去的分支后来被删了：回到默认分支
        if (!this.state.base || !(err instanceof RepoError)) {
          throw err;
        }
        this.state.base = undefined;
        this.baseBranch = remoteDefault;
        await this.fetchBranches([this.baseBranch], signal);
      }
      await this.checkout(this.baseBranch, signal);
    }
    // 状态文件的修改时间记作最近使用时间，sweep 按它删旧目录
    await this.saveState();
  }

  /**
   * 列出分支，按最近提交从新到旧，带最近一次提交的时间、作者和说明。filter 只列名字里带这个词的
   */
  async listBranches(filter?: string, signal?: AbortSignal): Promise<ToolOutput> {
    const all = await this.branchList(signal);
    const word = filter?.trim().toLowerCase();
    const matched = word ? all.filter((b) => b.name.toLowerCase().includes(word)) : all;
    const out = this.output();
    if (matched.length === 0) {
      return out.line(word ? `${this.repo} 没有名字里带「${filter}」的分支，共 ${all.length} 个分支。` : `${this.repo} 还没有分支。`).build();
    }
    const shown = matched.slice(0, MAX_LIST_BRANCHES);
    const more = matched.length - shown.length;
    out.line(
      `${this.repo} 共 ${all.length} 个分支${word ? `，名字带「${filter}」的有 ${matched.length} 个` : ""}，按最近提交从新到旧` +
        `${more > 0 ? `，只列出前 ${MAX_LIST_BRANCHES} 个，用 filter 缩小范围` : ""}：`,
    );
    for (const b of shown) {
      const tags = [b.isDefault ? "默认分支" : "", b.name === this.baseBranch ? "当前在看" : ""].filter(Boolean);
      const commit = [b.date?.slice(0, 10), b.author].filter(Boolean).join(" ") + (b.title ? `「${oneLine(b.title)}」` : "");
      out.line(`- ${b.name}${tags.length > 0 ? `（${tags.join("，")}）` : ""}${commit ? `：${commit}` : ""}`, { branch: b.name });
    }
    return out.build();
  }

  /**
   * 切换这个话题看的分支。之后不指定分支的读、搜、改和开合并请求都基于它。
   * 已经改了代码或开过合并请求时不能切，免得改动混到别的分支上。
   */
  switchBranch(branch: string, signal?: AbortSignal): Promise<ToolOutput> {
    return this.serial(async () => {
      const name = branchName(branch);
      if (this.state.branch || (await this.hasChanges(signal))) {
        if (name === this.baseBranch) {
          return this.output().line(`已经在 ${name} 分支上了。`, { branch: name }).build();
        }
        throw new RepoError(
          `这个话题里已经基于 ${this.baseBranch} 分支改了代码${this.pullRequest ? `，开了${this.host.requestName} ${this.pullRequest.url}` : ""}，不能再切分支。` +
            "只是看别的分支的代码，给读、搜工具传 branch 就行；要基于别的分支改代码，请群成员新开一个话题",
          this.onBranch(this.baseBranch),
        );
      }
      await this.fetchBranches([name], signal);
      await this.checkout(name, signal);
      this.baseBranch = name;
      this.state.base = name;
      await this.saveState();
      const [sha, last] = (await this.git(["log", "-1", "--format=%h%x00%cs %an「%s」"], signal)).trim().split("\0");
      return this.output()
        .line(`已切到 ${name} 分支，最新提交 ${sha} ${last}。这个话题后面看代码、改代码、开${this.host.requestName}都基于这个分支。`, { commit: sha }, { branch: name })
        .build();
    });
  }

  /**
   * 列出文件。glob 如 src/**\/*.ts，dir 如 src/tools。
   * 不指定 branch 时列当前分支的工作目录（含机器人新建还没提交的）；指定时列那个分支上的
   */
  async listFiles({ dir, glob, branch }: { dir?: string; glob?: string; branch?: string } = {}, signal?: AbortSignal): Promise<ToolOutput> {
    await this.queue;
    const ref = await this.branchRef(branch, signal);
    let files: string[];
    if (ref) {
      const prefix = dir ? this.relative(dir) : ".";
      const pattern = glob ? globToRegExp(glob) : undefined;
      files = splitNul(await this.git(["ls-tree", "-r", "-z", "--name-only", ref.ref], signal)).filter(
        (f) => (prefix === "." || f === prefix || f.startsWith(`${prefix}/`)) && (!pattern || pattern.test(f)),
      );
    } else {
      const specs = glob ? [`:(glob)${glob}`] : dir ? [this.relative(dir)] : [];
      const out = await this.git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...specs], signal);
      files = [...new Set(splitNul(out))];
    }
    const where = await this.label(ref, signal);
    const out = this.output();
    if (files.length === 0) {
      return out.line(`没有匹配的文件（${where.text}）。`, ...where.refs).build();
    }
    const more = files.length - MAX_LIST_FILES;
    out.line(`共 ${files.length} 个文件（${where.text}）${more > 0 ? `，只列出前 ${MAX_LIST_FILES} 个，缩小范围再看` : ""}：`, ...where.refs);
    for (const file of files.slice(0, MAX_LIST_FILES)) {
      out.line(shownPath(file), { path: file });
    }
    return out.build();
  }

  /** 读文件，带行号。start/end 是行号（从 1 开始，含 end）。指定 branch 时读那个分支上的 */
  async readFile(file: string, start = 1, end?: number, branch?: string, signal?: AbortSignal): Promise<ToolOutput> {
    await this.queue;
    const ref = await this.branchRef(branch, signal);
    if (ref) {
      return this.readFromBranch(ref, file, start, end, signal);
    }
    const abs = await this.resolve(file);
    const info = await stat(abs).catch(() => undefined);
    if (!info) {
      throw new RepoError(`没有这个文件：${file}。可以先用 code_list_files 或 code_search 找找`);
    }
    if (info.isDirectory()) {
      return this.listFiles({ dir: file });
    }
    // 读到了的文件，结果里写整理过的路径（真实存在的那个），不写模型传的原样
    const rel = this.relative(file);
    if (info.size > MAX_FILE_BYTES) {
      throw new RepoError(`${shownPath(rel)} 有 ${Math.round(info.size / 1024)} KB，太大了不读，用 code_search 搜需要的部分`, this.exists(rel));
    }
    const buf = await readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) {
      throw new RepoError(`${shownPath(rel)} 是二进制文件，读不了`, this.exists(rel));
    }
    return numberedLines(this.output(), rel, buf.toString("utf8"), start, end);
  }

  /** 从别的分支读文件：直接读 git 里的对象，不动工作目录 */
  private async readFromBranch(ref: BranchRef, file: string, start: number, end: number | undefined, signal?: AbortSignal): Promise<ToolOutput> {
    const rel = this.relative(file);
    if (rel === ".") {
      return this.listFiles({ branch: ref.name }, signal);
    }
    const spec = `${ref.ref}:${rel}`;
    const type = (await this.git(["cat-file", "-t", spec], signal).catch(() => "")).trim();
    if (!type) {
      throw new RepoError(`${ref.name} 分支上没有这个文件：${file}。可以先用 code_list_files 或 code_search 找找`, this.onBranch(ref.name));
    }
    if (type === "tree") {
      return this.listFiles({ dir: rel, branch: ref.name }, signal);
    }
    if (type !== "blob") {
      throw new RepoError(`${shownPath(rel)} 是子模块，读不了`, this.exists(rel));
    }
    const size = Number((await this.git(["cat-file", "-s", spec], signal)).trim());
    if (size > MAX_FILE_BYTES) {
      throw new RepoError(`${shownPath(rel)} 有 ${Math.round(size / 1024)} KB，太大了不读，用 code_search 搜需要的部分`, this.exists(rel));
    }
    const text = await this.git(["cat-file", "blob", spec], signal);
    if (text.slice(0, 8000).includes("\u0000")) {
      throw new RepoError(`${shownPath(rel)} 是二进制文件，读不了`, this.exists(rel));
    }
    return numberedLines(this.output(), rel, text, start, end, await this.label(ref, signal));
  }

  /**
   * 按正则（或原文）搜代码，返回「文件:行号: 内容」。
   * 不指定 branches 时搜当前分支的工作目录；指定时在这些分支上一起搜，结果按分支分组。branches 里的 recent 表示最近有提交的几个分支
   */
  async search(
    pattern: string,
    { literal = false, ignoreCase = false, glob, branches }: { literal?: boolean; ignoreCase?: boolean; glob?: string; branches?: readonly string[] } = {},
    signal?: AbortSignal,
  ): Promise<ToolOutput> {
    await this.queue;
    // -z：文件名原样输出、用 \0 隔开，文件名里有冒号、换行也分得清
    const args = ["grep", "-n", "-z", "-I", "--no-color", literal ? "-F" : "-E"];
    if (ignoreCase) {
      args.push("-i");
    }
    args.push("-e", pattern);
    const pathspec = ["--", ...(glob ? [`:(glob)${glob}`] : [])];
    if (!branches || branches.length === 0) {
      const matches = grepMatches(await this.git([...args, "--untracked", ...pathspec], signal, [1]));
      const where = await this.label(undefined, signal);
      const out = this.output();
      if (matches.length === 0) {
        return out.line(`没有搜到「${pattern}」（${where.text}）。`, ...where.refs).build();
      }
      const more = matches.length - MAX_SEARCH_MATCHES;
      out.line(
        `共 ${matches.length} 处（${where.text}）${more > 0 ? `，只列出前 ${MAX_SEARCH_MATCHES} 处，换个更具体的搜法或加 glob 缩小范围` : ""}：`,
        ...where.refs,
      );
      matches.slice(0, MAX_SEARCH_MATCHES).forEach((match) => addMatch(out, match));
      return out.build();
    }

    const names = await this.pickBranches(branches, signal);
    await this.fetchBranches(names, signal);
    const refs = names.map((name) => `refs/remotes/origin/${name}`);
    const found = new Map<string, GrepMatch[]>(names.map((name) => [name, []]));
    for (const match of grepMatches(await this.git([...args, ...refs, ...pathspec], signal, [1]))) {
      const i = refs.findIndex((ref) => match.file.startsWith(`${ref}:`));
      if (i >= 0) {
        found.get(names[i])!.push({ ...match, file: match.file.slice(refs[i].length + 1) });
      }
    }
    const hit = names.filter((name) => found.get(name)!.length > 0);
    const miss = names.filter((name) => found.get(name)!.length === 0);
    const out = this.output();
    if (hit.length === 0) {
      return out.line(`在这 ${names.length} 个分支上都没有搜到「${pattern}」：${names.join("、")}。`, ...names.map((branch) => ({ branch }))).build();
    }
    const labels = await Promise.all(hit.map((name) => this.label({ name, ref: `refs/remotes/origin/${name}` }, signal)));
    const total = hit.reduce((sum, name) => sum + found.get(name)!.length, 0);
    out.line(`在 ${hit.length} 个分支上共搜到 ${total} 处${total > MAX_SEARCH_MATCHES ? `，只列出前 ${MAX_SEARCH_MATCHES} 处` : ""}：`);
    let budget = MAX_SEARCH_MATCHES;
    hit.forEach((name, i) => {
      const matches = found.get(name)!;
      out.line(`【${labels[i].text}，${matches.length} 处】`, ...labels[i].refs);
      matches.slice(0, Math.max(0, budget)).forEach((match) => addMatch(out, match));
      budget -= matches.length;
    });
    if (miss.length > 0) {
      out.line(`没搜到的分支：${miss.join("、")}`, ...miss.map((branch) => ({ branch })));
    }
    return out.build();
  }

  /** 分支和最近一次提交，按提交时间从新到旧。一个任务里只查一次 */
  private branchList(signal?: AbortSignal): Promise<BranchInfo[]> {
    if (!this.branches) {
      // 平台接口出错（比如老版本 GitLab）时退回用 git 列
      const list = this.host.listBranches
        ? this.host.listBranches(this.repo, signal).catch(() => this.gitBranchList(signal))
        : this.gitBranchList(signal);
      this.branches = list.then((all) => [...all].sort((a, b) => (Date.parse(b.date ?? "") || 0) - (Date.parse(a.date ?? "") || 0)));
      this.branches.catch(() => {
        this.branches = undefined;
      });
    }
    return this.branches;
  }

  /** 平台没有列分支的接口时：把所有分支的最新提交拉下来，用 git 列 */
  private async gitBranchList(signal?: AbortSignal): Promise<BranchInfo[]> {
    const head = await this.git(["ls-remote", "--symref", "origin", "HEAD"], signal);
    const remoteDefault = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head)?.[1];
    await this.fetch(["+refs/heads/*:refs/remotes/origin/*"], signal);
    const out = await this.git(
      ["for-each-ref", "--format=%(refname:lstrip=3)%09%(committerdate:iso-strict)%09%(authorname)%09%(subject)", "refs/remotes/origin/"],
      signal,
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"))
      .filter(([name]) => name !== "HEAD")
      .map(([name, date, author, title]) => {
        this.fetched.add(name);
        return { name, isDefault: name === remoteDefault, date, author, title };
      });
  }

  /** 把 branches 参数换成分支名：recent 换成最近有提交的几个分支，去重，最多 MAX_SEARCH_BRANCHES 个 */
  private async pickBranches(branches: readonly string[], signal?: AbortSignal): Promise<string[]> {
    const names: string[] = [];
    for (const item of branches) {
      if (/^(recent|最近)$/i.test(item.trim())) {
        names.push(...(await this.branchList(signal)).slice(0, RECENT_BRANCHES).map((b) => b.name));
      } else if (item.trim()) {
        names.push(branchName(item));
      }
    }
    const unique = [...new Set(names)];
    if (unique.length === 0) {
      throw new RepoError("branches 里没有分支名");
    }
    if (unique.length > MAX_SEARCH_BRANCHES) {
      throw new RepoError(`一次最多在 ${MAX_SEARCH_BRANCHES} 个分支上搜，这次给了 ${unique.length} 个`);
    }
    return unique;
  }

  /** 读别的分支时用的引用（先拉下那个分支的最新提交）。没指定或就是当前分支时返回 undefined，读工作目录 */
  private async branchRef(branch: string | undefined, signal?: AbortSignal): Promise<BranchRef | undefined> {
    if (!branch?.trim()) {
      return undefined;
    }
    const name = branchName(branch);
    if (name === this.baseBranch) {
      return undefined;
    }
    await this.fetchBranches([name], signal);
    return { name, ref: `refs/remotes/origin/${name}` };
  }

  /** 结果里写明是哪个分支、哪个提交，如「aiops 分支 @ 3f2a1c9」 */
  private async label(ref: BranchRef | undefined, signal?: AbortSignal): Promise<Label> {
    const sha = (await this.git(["rev-parse", "--short", ref?.ref ?? "HEAD"], signal)).trim();
    const branch = ref?.name ?? this.baseBranch;
    return {
      text: `${branch} 分支 @ ${sha}${!ref && this.state.branch ? "，含机器人的改动" : ""}`,
      refs: [{ commit: sha }, { branch }],
    };
  }

  /** 浅拉这些分支的最新提交到 origin/<分支>。一个任务里每个分支只拉一次 */
  private async fetchBranches(names: readonly string[], signal?: AbortSignal): Promise<void> {
    const need = names.filter((name) => !this.fetched.has(name));
    if (need.length === 0) {
      return;
    }
    try {
      await this.fetch(
        need.map((name) => `+refs/heads/${name}:refs/remotes/origin/${name}`),
        signal,
      );
    } catch (err) {
      const missing = err instanceof RepoError ? /couldn't find remote ref refs\/heads\/(\S+)/.exec(err.message) : null;
      if (missing) {
        throw new RepoError(`没有 ${missing[1]} 这个分支，用 code_branches 看看有哪些分支`);
      }
      throw err;
    }
    for (const name of need) {
      this.fetched.add(name);
    }
  }

  private fetch(refspecs: string[], signal?: AbortSignal): Promise<string> {
    const run = this.fetching.then(() => this.git(["fetch", "-q", "--depth", "1", "--no-tags", "origin", ...refspecs], signal));
    this.fetching = run.catch(() => {});
    return run;
  }

  /** 工作目录换到 origin/<分支> 的最新提交，记下这个提交作为比较改动的基准 */
  private async checkout(name: string, signal?: AbortSignal): Promise<void> {
    await this.git(["checkout", "-q", "-B", name, `refs/remotes/origin/${name}`], signal);
    this.state.baseSha = (await this.git(["rev-parse", "HEAD"], signal)).trim();
  }

  /**
   * 改文件。oldText 为空时整个文件写成 newText（新建或覆盖）；
   * 否则把文件里唯一出现的 oldText 换成 newText，出现 0 次或多次都报错，让模型给更准的片段。
   */
  editFile(file: string, oldText: string | undefined, newText: string): Promise<ToolOutput> {
    return this.serial(() => this.applyEdit(file, oldText, newText));
  }

  private async applyEdit(file: string, oldText: string | undefined, newText: string): Promise<ToolOutput> {
    const abs = await this.resolve(file, true);
    // 和读文件一样，结果里写整理过的路径
    const rel = this.relative(file);
    const shown = shownPath(rel);
    const info = await lstat(abs).catch(() => undefined);
    if (info?.isSymbolicLink()) {
      throw new RepoError(`${shown} 是符号链接，不能改`, this.exists(rel));
    }
    if (info?.isDirectory()) {
      throw new RepoError(`${shown} 是目录`, this.exists(rel));
    }
    const out = this.output();
    if (!oldText) {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, newText);
      const count = lineCount(newText);
      return out.line(`${info ? "已覆盖" : "已新建"} ${shown}（${count} 行）。`, count > 0 ? { path: rel, lines: [1, count] } : { path: rel }).build();
    }
    if (!info) {
      throw new RepoError(`没有这个文件：${file}。要新建文件时不填 old_text`);
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new RepoError(`${shown} 太大了，不改`, this.exists(rel));
    }
    const content = await readFile(abs, "utf8");
    const count = content.split(oldText).length - 1;
    if (count === 0) {
      throw new RepoError(`${shown} 里没找到 old_text（要和文件内容一字不差，包括缩进和空格），先用 code_read_file 看准再改`, this.exists(rel));
    }
    if (count > 1) {
      throw new RepoError(`${shown} 里 old_text 出现了 ${count} 次，多带几行上下文让它只出现一次`, this.exists(rel));
    }
    const index = content.indexOf(oldText);
    await writeFile(abs, content.slice(0, index) + newText + content.slice(index + oldText.length));
    const line = content.slice(0, index).split("\n").length;
    // 只记改动后新内容所在的行：删掉的那几行已经不在文件里了
    if (newText === "") {
      return out.line(`已修改 ${shown}：删掉了原来第 ${line} 行起的内容。`, { path: rel }).build();
    }
    const last = line + lineCount(newText) - 1;
    return out
      .line(`已修改 ${shown}，改动后的内容在第 ${last > line ? `${line} 到 ${last}` : line} 行。`, { path: rel, lines: [line, last] })
      .build();
  }

  /** 当前所有改动（含新建的文件）：先列改了哪些文件，再给完整 diff */
  diff(): Promise<ToolOutput> {
    return this.serial(() => this.stagedDiff());
  }

  private async stagedDiff(): Promise<ToolOutput> {
    await this.git(["add", "-A"]);
    // 和上次推上去的（没推过就是检出时的分支）比，没推的提交和没提交的改动都算
    const base = this.state.pushedSha ?? this.state.baseSha ?? `origin/${this.baseBranch}`;
    const files = await this.changedFiles(["--cached", base]);
    const out = this.output();
    if (files.length === 0) {
      return out
        .line(this.pullRequest ? `和已经推到${this.host.requestName}的内容相比没有新的改动（${this.pullRequest.url}）。` : "还没有任何改动。")
        .build();
    }
    const full = await this.git(["diff", "--cached", base]);
    const cut = full.length > MAX_DIFF_CHARS;
    return addChanges(out, files)
      .line("")
      .line(cut ? `${full.slice(0, MAX_DIFF_CHARS)}\n…（diff 太长，后面省略）` : full)
      .build();
  }

  /** 改动了的文件：按 --numstat -z 取，文件名原样；不认改名，改名记成删掉旧的、新建新的 */
  private async changedFiles(args: string[], signal?: AbortSignal): Promise<ChangedFile[]> {
    const out = await this.git(["diff", "--numstat", "-z", "--no-renames", ...args], signal);
    return splitNul(out).flatMap((row) => {
      const stat = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
      if (!stat) {
        return [];
      }
      return [stat[1] === "-" ? { path: stat[3] } : { path: stat[3], added: Number(stat[1]), deleted: Number(stat[2]) }];
    });
  }

  /**
   * 提交全部改动，推到机器人自己建的分支，开 PR 到当前看的分支（没切过就是默认分支）。这个话题已经开过 PR 时推到同一个分支，更新那个 PR。
   * 分支名由程序生成（agenttag/日期-随机），不会推到默认分支或别人的分支。
   */
  openPullRequest(title: string, body: string, signal?: AbortSignal): Promise<OpenedRequest> {
    return this.serial(() => this.commitAndOpen(title, body, signal));
  }

  private async commitAndOpen(title: string, body: string, signal?: AbortSignal): Promise<OpenedRequest> {
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
    const base = this.state.pushedSha ?? this.state.baseSha ?? (await this.git(["rev-parse", `origin/${this.baseBranch}`], signal)).trim();
    const changes = await this.changedFiles([base, "HEAD"], signal);
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
      return { ...this.pullRequest, created: false, changes };
    }
    // 上次推上去了但开 PR 失败时，这次直接补开
    const pr = await this.host.openPullRequest(this.repo, { head: branch, base: this.baseBranch, title, body });
    this.state = { ...this.state, prUrl: pr.url, prNumber: pr.number };
    await this.saveState();
    return { ...pr, created: true, changes };
  }

  /**
   * 模型可能在同一轮里并行调几个工具：改文件、看 diff、提交这些会写文件或 git index 的操作排队执行，
   * 免得两次修改同一个文件互相覆盖，或者 git 抢 index.lock。
   */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  /** 这个仓库的工具结果 */
  private output(): ToolOutputBuilder {
    return new ToolOutputBuilder(this.repo);
  }

  /** 报错里查到的：这个文件在（rel 是整理过的路径） */
  private exists(rel: string): CodeFact[] {
    return [{ path: rel, repo: this.repo, at: 0 }];
  }

  /** 报错里查到的：这个分支在 */
  private onBranch(name: string): CodeFact[] {
    return [{ branch: name, repo: this.repo, at: 0 }];
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

interface BranchRef {
  name: string;
  ref: string;
}

/** 开好或更新了的合并请求，changes 是和上次推上去的相比改了哪些文件 */
export interface OpenedRequest {
  url: string;
  number: number;
  created: boolean;
  changes: ChangedFile[];
}

/** git grep -n -z 的一处结果 */
interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

/** 解析 git grep -n -z 的输出：每处是「文件\0行号\0内容\n」，文件名里可以有冒号和换行，内容里没有换行 */
function grepMatches(out: string): GrepMatch[] {
  const matches: GrepMatch[] = [];
  const record = /([^\0]*)\0(\d+)\0([^\n]*)(?:\n|$)/y;
  for (let at = record.exec(out); at && at[0]; at = record.exec(out)) {
    matches.push({ file: at[1], line: Number(at[2]), text: at[3] });
  }
  return matches;
}

/** 搜索结果的一行「文件:行号:内容」，记下这个文件的这一行 */
function addMatch(out: ToolOutputBuilder, match: GrepMatch): void {
  out.line(`${shownPath(match.file)}:${match.line}:${clip(match.text)}`, { path: match.file, lines: [match.line, match.line] });
}

/** 改动了哪些文件：一个文件一行，加减了几行 */
export function addChanges(out: ToolOutputBuilder, files: readonly ChangedFile[]): ToolOutputBuilder {
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const deleted = files.reduce((sum, file) => sum + (file.deleted ?? 0), 0);
  out.line(`改动了 ${files.length} 个文件（+${added} -${deleted}）：`);
  for (const file of files) {
    out.line(`${shownPath(file.path)}（${file.added === undefined ? "二进制文件" : `+${file.added} -${file.deleted}`}）`, { path: file.path });
  }
  return out;
}

function splitNul(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

/** 给模型看的文件名：带换行、引号这类字符的，和 git 一样加引号转义 */
function shownPath(file: string): string {
  return /[\u0000-\u001f"\\]/.test(file) ? JSON.stringify(file) : file;
}

/** 有几行，和读文件时一样数：结尾的换行不算多一行 */
function lineCount(text: string): number {
  const lines = text.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function clip(line: string): string {
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

function newBranchName(now: Date): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `agenttag/${day}-${randomBytes(3).toString("hex")}`;
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]/g, "_");
}

/** 文件内容加上行号，一次最多 MAX_READ_LINES 行、MAX_READ_CHARS 字。where 写明是哪个分支上的。记下读到的文件和每一行 */
function numberedLines(
  out: ToolOutputBuilder,
  file: string,
  text: string,
  start: number,
  end: number | undefined,
  where?: Label,
): ToolOutput {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const from = Math.max(1, Math.floor(start));
  const to = Math.min(lines.length, end ? Math.floor(end) : from + MAX_READ_LINES - 1, from + MAX_READ_LINES - 1);
  if (from > lines.length) {
    return out.line(`${shownPath(file)} 只有 ${lines.length} 行。`, { path: file }).build();
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
  const head = `${shownPath(file)}（${where ? `${where.text}，` : ""}共 ${lines.length} 行，下面是第 ${from} 到 ${last} 行${last < lines.length ? `，要看后面用 start_line=${last + 1}` : ""}）`;
  out.line(head, { path: file }, ...(where?.refs ?? []));
  body.forEach((row, i) => out.line(row, { path: file, lines: [from + i, from + i] }));
  return out.build();
}

/** 分支名：去掉 origin/、refs/heads/ 前缀，只许 git 分支名里常见的字符 */
function branchName(input: string): string {
  const name = input.trim().replace(/^refs\/heads\//, "").replace(/^origin\//, "");
  if (!/^[\p{L}\p{N}_.\/+@-]+$/u.test(name) || name.startsWith("-") || name.includes("..") || name.endsWith("/") || name.endsWith(".lock")) {
    throw new RepoError(`分支名不对：${input}`);
  }
  return name;
}

/** 把 glob（如 src/**\/*.ts）转成正则，规则和 git 的 :(glob) 一样：* 不跨目录，**\/ 匹配任意层目录 */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.trim().replace(/^\.?\/+/, "");
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}
