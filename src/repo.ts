import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./history.js";
import { type CodeFact, type CodeLocation, type Piece, ToolError, type ToolOutput, ToolOutputBuilder } from "./tools/tool.js";

/**
 * 读文件时一次最多返回的行数和字数。字数要比工具结果交给模型前的上限（MAX_TOOL_OUTPUT_CHARS，1.6 万字）小，留出结果开头的说明：
 * 原先是 2 万字，超出的部分被截掉，结果开头却写着「下面是第 1 到 400 行，要看后面用 start_line=401」，中间那段模型没看到也不知道
 */
export const MAX_READ_LINES = 400;
export const MAX_READ_CHARS = 15_000;
/** 超过这个大小的文件不读不改 */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_MATCHES = 100;
const MAX_LIST_FILES = 500;
const MAX_LIST_BRANCHES = 50;
/** 跨分支搜索时，「最近活跃的分支」取几个；一次最多搜几个分支 */
export const RECENT_BRANCHES = 8;
const MAX_SEARCH_BRANCHES = 10;
const MAX_DIFF_CHARS = 15000;
/** 查提交历史时默认列几个、最多列几个；按说明里的词筛时，带了文件或日期的最多翻最近这么多个提交 */
export const DEFAULT_LOG_COMMITS = 10;
export const MAX_LOG_COMMITS = 30;
const LOG_SCAN_COMMITS = 100;
/** 列合并请求时默认列几个、最多列几个 */
export const DEFAULT_LIST_REQUESTS = 10;
export const MAX_LIST_REQUESTS = 30;
const REQUEST_STATES: Record<RequestState | "all", string> = { opened: "开着", merged: "已合并", closed: "已关闭", all: "全部" };
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
  /** 用平台接口查一个分支的提交历史（工作目录是浅克隆，没有历史），按提交时间从新到旧。没有实现时 code_log 不能用 */
  searchCommits?(repo: string, query: CommitQuery, signal?: AbortSignal): Promise<CommitSearch>;
  /** 列出合并请求，按最近更新从新到旧。没有实现时 code_requests 不能用 */
  listRequests?(repo: string, query: RequestQuery, signal?: AbortSignal): Promise<RequestInfo[]>;
  /** 一个合并请求的分支、状态和改动范围。把别的话题开的合并请求搬到别的分支时用，没有实现时不能搬 */
  getRequest?(repo: string, number: number, signal?: AbortSignal): Promise<RequestDetail>;
  /** 合并前要核对的：合并请求的状态、分支、谁开的、源分支最新的提交，机器人自己的账号，要合到的分支受不受保护。没有实现时机器人不能合并 */
  mergeCheck?(repo: string, number: number, signal?: AbortSignal): Promise<MergeCheck>;
  /** 合并（sha 是核对过的源分支最新提交，对不上平台会拒绝）；要等流水线的设成流水线通过后自动合并 */
  mergeRequest?(repo: string, number: number, options: { sha: string }, signal?: AbortSignal): Promise<MergeResult>;
}

/** 合并前核对用的 */
export interface MergeCheck extends RequestInfo {
  /** 源分支最新的提交 */
  sha: string;
  /** 开合并请求的账号（用户名） */
  authorUsername?: string;
  /** 机器人自己的账号（令牌对应的用户名） */
  botUsername: string;
  /** 从别的项目（fork）提过来的 */
  fromFork?: boolean;
  /** 要合到的分支在平台上受保护（按平台上的保护设置，含通配的规则） */
  targetProtected: boolean;
  /** 要合到的分支是仓库的默认分支 */
  targetIsDefault: boolean;
}

/** 合并的结果：合好了，或者设成了流水线通过后自动合并 */
export interface MergeResult {
  state: "merged" | "auto";
  url: string;
}

/** 列合并请求的条件 */
export interface RequestQuery {
  /** 开着的、合过的，还是全部（含关掉的） */
  state: RequestState | "all";
  /** 标题或描述里要有的词 */
  search?: string;
  limit: number;
}

export type RequestState = "opened" | "merged" | "closed";

export interface RequestInfo {
  number: number;
  title: string;
  url: string;
  state: RequestState;
  /** 改动所在的分支 */
  source: string;
  /** 要合到的分支 */
  target: string;
  author?: string;
  /** 最近更新的时间（ISO 格式） */
  updatedAt?: string;
}

/** 合并请求的改动范围：从 baseSha（源分支和目标分支分叉的地方）改到 headSha（源分支最新的提交） */
export interface RequestDetail extends RequestInfo {
  baseSha: string;
  headSha: string;
  /** 从别的项目（fork）提过来的 */
  fromFork?: boolean;
}

/** 查提交历史的条件 */
export interface CommitQuery {
  /** 分支 */
  ref: string;
  /** 提交说明里要有的词，空格隔开的几个词都要有，不分大小写 */
  query?: string;
  /** 只看改过这个文件或目录的提交（相对仓库根目录） */
  path?: string;
  /** 只看这个时间以后的提交（ISO 格式） */
  since?: string;
  limit: number;
}

export interface CommitInfo {
  sha: string;
  title: string;
  /** 完整的提交说明，按词筛时用 */
  message?: string;
  /** 提交时间（ISO 格式） */
  date?: string;
  author?: string;
  url?: string;
}

export interface CommitSearch {
  commits: CommitInfo[];
  /** 先列提交再按说明里的词筛时，一共翻了几个提交（翻满 LOG_SCAN_COMMITS 说明更早的没看）；平台直接按说明搜的不填 */
  scanned?: number;
}

/** 按说明里的词筛（空格隔开的几个词都要有，不分大小写），从新到旧取前 limit 个 */
function pickCommits(commits: CommitInfo[], query: CommitQuery): CommitInfo[] {
  const words = (query.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return commits
    .filter((c) => words.every((word) => `${c.title}\n${c.message ?? ""}`.toLowerCase().includes(word)))
    .sort((a, b) => (Date.parse(b.date ?? "") || 0) - (Date.parse(a.date ?? "") || 0))
    .slice(0, query.limit);
}

function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n")[0].trim();
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
export function createGitLabHost(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch, sleep: Sleep = wait): CodeHost {
  const base = baseUrl.trim().replace(/\/+$/, "");
  let botUser: Promise<string> | undefined;
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
    async searchCommits(repo, query, signal) {
      const project = `${base}/api/v4/projects/${encodeURIComponent(repo)}`;
      const get = (url: string) =>
        fetchImpl(url, {
          headers: { "private-token": token },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        });
      // 只按说明里的词找：用搜索接口，搜这个分支上全部提交的说明；带了文件或日期时列出这个分支上符合的提交，再按说明筛
      let bySearch = query.query !== undefined && query.path === undefined && query.since === undefined;
      const list = () =>
        get(
          `${project}/repository/commits?${new URLSearchParams({
            ref_name: query.ref,
            ...(query.path ? { path: query.path } : {}),
            ...(query.since ? { since: query.since } : {}),
            per_page: String(query.query ? LOG_SCAN_COMMITS : query.limit),
          })}`,
        );
      const read = async (res: Response) => {
        if (!res.ok) {
          const hint = res.status === 404 ? "：找不到项目或分支" : res.status === 401 || res.status === 403 ? "：令牌没有读这个项目的权限" : "";
          throw new RepoError(`GitLab 查提交历史失败（HTTP ${res.status}）${hint}`);
        }
        const body = (await res.json()) as {
          id: string;
          title?: string;
          message?: string;
          author_name?: string;
          committed_date?: string;
          created_at?: string;
          web_url?: string;
        }[];
        const commits = body.map((c) => ({
          sha: c.id,
          title: c.title ?? firstLine(c.message),
          message: c.message,
          date: c.committed_date ?? c.created_at,
          author: c.author_name,
          url: c.web_url,
        }));
        return { commits: pickCommits(commits, query), scanned: body.length };
      };
      let res = bySearch
        ? await get(`${project}/search?${new URLSearchParams({ scope: "commits", search: query.query ?? "", ref: query.ref, per_page: String(LOG_SCAN_COMMITS) })}`)
        : await list();
      // 自建 GitLab 可能关了提交搜索（400、403），搜的词里有正则符号时也可能出错（5xx）：退回列出最近的提交再按说明筛
      if (bySearch && (res.status === 400 || res.status === 403 || res.status >= 500)) {
        bySearch = false;
        await res.body?.cancel();
        res = await list();
      }
      let found = await read(res);
      // 没开高级搜索时，搜索接口把整串当成一句话找（git log --grep），几个词不挨着就搜不到：搜不到再列出最近的提交按词筛一遍
      if (bySearch && found.commits.length === 0) {
        bySearch = false;
        found = await read(await list());
      }
      return { commits: found.commits, ...(bySearch || !query.query ? {} : { scanned: found.scanned }) };
    },
    async listRequests(repo, query, signal) {
      const params = new URLSearchParams({
        state: query.state,
        order_by: "updated_at",
        sort: "desc",
        per_page: String(query.limit),
        ...(query.search ? { search: query.search } : {}),
      });
      const res = await fetchImpl(`${base}/api/v4/projects/${encodeURIComponent(repo)}/merge_requests?${params}`, {
        headers: { "private-token": token },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new RepoError(`GitLab 列合并请求失败（HTTP ${res.status}）${res.status === 404 ? "：找不到项目" : res.status === 401 || res.status === 403 ? "：令牌没有读这个项目的权限" : ""}`);
      }
      return ((await res.json()) as GitLabRequest[]).map(gitLabRequest);
    },
    async getRequest(repo, number, signal) {
      const res = await fetchImpl(`${base}/api/v4/projects/${encodeURIComponent(repo)}/merge_requests/${number}`, {
        headers: { "private-token": token },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      if (res.status === 404) {
        throw new RepoError(`没有 !${number} 这个合并请求，用 code_requests 找一下`);
      }
      if (!res.ok) {
        throw new RepoError(`GitLab 读合并请求 !${number} 失败（HTTP ${res.status}）`);
      }
      const body = (await res.json()) as GitLabRequest & {
        diff_refs?: { base_sha?: string; head_sha?: string } | null;
        source_project_id?: number;
        target_project_id?: number;
      };
      const baseSha = body.diff_refs?.base_sha;
      const headSha = body.diff_refs?.head_sha;
      if (!baseSha || !headSha) {
        throw new RepoError(`GitLab 没给出 !${number} 的改动范围（可能还在计算），过一会儿再试`);
      }
      const fromFork = body.source_project_id !== undefined && body.source_project_id !== body.target_project_id;
      return { ...gitLabRequest(body), baseSha, headSha, ...(fromFork ? { fromFork } : {}) };
    },
    async mergeCheck(repo, number, signal) {
      const project = `${base}/api/v4/projects/${encodeURIComponent(repo)}`;
      const request = await readMergeRequest(project, number, signal);
      if (!request.sha) {
        throw new RepoError(`GitLab 没给出 !${number} 最新的提交，过一会儿再试`);
      }
      // 令牌对应的账号不会变，查一次就记下；没查到下次再查
      const user = (botUser ??= gitLabGet(`${base}/api/v4/user`, signal).then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { username?: string };
        if (!res.ok || !body.username) {
          throw new RepoError(`查不到机器人自己的 GitLab 账号（HTTP ${res.status}），先不合并`);
        }
        return body.username;
      }));
      user.catch(() => {
        if (botUser === user) {
          botUser = undefined;
        }
      });
      const botUsername = await user;
      const target = request.target_branch ?? "";
      const res = await gitLabGet(`${project}/repository/branches/${encodeURIComponent(target)}`, signal);
      if (res.status === 404) {
        throw new RepoError(`!${number} 要合到的 ${target} 分支不存在了`);
      }
      const branch = (await res.json().catch(() => ({}))) as { protected?: unknown; default?: unknown };
      if (!res.ok || typeof branch.protected !== "boolean") {
        throw new RepoError(`GitLab 查 ${target} 分支是不是受保护的失败（HTTP ${res.status}），先不合并`);
      }
      const fromFork = request.source_project_id !== undefined && request.source_project_id !== request.target_project_id;
      return {
        ...gitLabRequest(request),
        sha: request.sha,
        ...(request.author?.username ? { authorUsername: request.author.username } : {}),
        botUsername,
        ...(fromFork ? { fromFork } : {}),
        targetProtected: branch.protected,
        targetIsDefault: branch.default === true,
      };
    },
    async mergeRequest(repo, number, { sha }, signal) {
      const project = `${base}/api/v4/projects/${encodeURIComponent(repo)}`;
      // 刚开的合并请求 GitLab 要算一会儿能不能合（checking 这类），等它算完再合
      let status = "";
      for (let tries = 0; ; tries++) {
        const request = await readMergeRequest(project, number, signal);
        status = request.detailed_merge_status ?? request.merge_status ?? "";
        if (!MERGE_CHECKING.has(status) || tries + 1 >= MERGE_CHECK_TRIES) {
          break;
        }
        await sleep(MERGE_CHECK_WAIT_MS, signal);
      }
      const blocked = MERGE_BLOCKED[status];
      if (blocked) {
        throw new RepoError(`!${number} 现在合不了：${blocked}`);
      }
      // 要等流水线通过才能合的：设成流水线通过后自动合并（新版本叫 auto_merge，老版本叫 merge_when_pipeline_succeeds，两个都传）
      const pipeline = status === "ci_must_pass" || status === "ci_still_running";
      const res = await fetchImpl(`${project}/merge_requests/${number}/merge`, {
        method: "PUT",
        headers: { "private-token": token, "content-type": "application/json" },
        body: JSON.stringify({ sha, ...(pipeline ? { auto_merge: true, merge_when_pipeline_succeeds: true } : {}) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      });
      const body = (await res.json().catch(() => ({}))) as GitLabRequest & { merge_when_pipeline_succeeds?: boolean; message?: unknown };
      if (!res.ok) {
        const raw = body.message;
        const detail = raw === undefined ? "" : typeof raw === "string" ? raw : JSON.stringify(raw);
        const hint =
          res.status === 401
            ? "令牌无效或过期了"
            : res.status === 403
              ? "机器人的账号没有权限合到这个分支，要有权限的人来合"
              : res.status === 405 || res.status === 422
                ? "GitLab 说现在不能合（可能是草稿、有冲突、流水线没过、还要审批或者有没解决的评论）"
                : res.status === 406
                  ? "和要合到的分支有冲突"
                  : res.status === 409
                    ? "源分支刚有新的提交，和核对过的不一样，没合"
                    : "";
        throw new RepoError(`GitLab 合并 !${number} 失败（HTTP ${res.status}）${hint ? `：${hint}` : ""}。${detail}`.trim());
      }
      const url = body.web_url ?? "";
      if (body.state === "merged") {
        return { state: "merged", url };
      }
      if (pipeline || body.merge_when_pipeline_succeeds === true) {
        return { state: "auto", url };
      }
      throw new RepoError(`GitLab 没有合并 !${number}（状态 ${body.state ?? "未知"}），请到 GitLab 上看一下：${url}`);
    },
  };

  function gitLabGet(url: string, signal?: AbortSignal): Promise<Response> {
    return fetchImpl(url, {
      headers: { "private-token": token },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  }

  async function readMergeRequest(project: string, number: number, signal?: AbortSignal): Promise<GitLabMergeRequest> {
    const res = await gitLabGet(`${project}/merge_requests/${number}`, signal);
    if (res.status === 404) {
      throw new RepoError(`没有 !${number} 这个合并请求，用 code_requests 找一下`);
    }
    if (!res.ok) {
      throw new RepoError(`GitLab 读合并请求 !${number} 失败（HTTP ${res.status}）`);
    }
    return (await res.json()) as GitLabMergeRequest;
  }
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** 合并前等 GitLab 算完能不能合：最多看几次、每次隔多久 */
const MERGE_CHECK_TRIES = 6;
const MERGE_CHECK_WAIT_MS = 2000;
/** GitLab 还在算能不能合的状态（detailed_merge_status，老版本的 merge_status） */
const MERGE_CHECKING = new Set(["unchecked", "checking", "preparing", "approvals_syncing", "cannot_be_merged_recheck", "cannot_be_merged_rechecking"]);
/** 合不了的状态和大白话的原因；没列的（mergeable、can_be_merged、要等流水线的、不认识的）照样去合，由 GitLab 决定 */
const MERGE_BLOCKED: Record<string, string> = {
  conflict: "和要合到的分支有冲突，要先解决冲突",
  cannot_be_merged: "和要合到的分支有冲突，要先解决冲突",
  broken_status: "源分支和要合到的分支对不上（可能有冲突），GitLab 合不了",
  need_rebase: "要先变基（rebase）到要合到的分支最新的代码",
  draft_status: "还是草稿（Draft），要先改成正式的",
  not_approved: "还没审批通过",
  requested_changes: "有人要求修改",
  discussions_not_resolved: "还有没解决的评论",
  not_open: "已经不是开着的了",
  blocked_status: "被别的合并请求挡着",
  merge_request_blocked: "被别的合并请求挡着",
  external_status_checks: "外部检查还没通过",
  security_policy_violations: "安全策略没通过",
  commits_status: "源分支的提交有问题（比如还没推上去）",
  locked_paths: "改到了被锁住的文件",
  locked_lfs_files: "改到了被锁住的文件",
  title_regex: "标题不符合项目要求的格式",
  jira_association_missing: "标题或描述里要带 Jira 编号",
};

interface GitLabMergeRequest extends GitLabRequest {
  sha?: string;
  detailed_merge_status?: string;
  merge_status?: string;
  source_project_id?: number;
  target_project_id?: number;
}

interface GitLabRequest {
  iid: number;
  title?: string;
  web_url?: string;
  state?: string;
  source_branch?: string;
  target_branch?: string;
  author?: { name?: string; username?: string } | null;
  updated_at?: string;
}

function gitLabRequest(r: GitLabRequest): RequestInfo {
  return {
    number: r.iid,
    title: r.title ?? "",
    url: r.web_url ?? "",
    // locked 是正在合并的那一会儿，还算开着
    state: r.state === "merged" ? "merged" : r.state === "closed" ? "closed" : "opened",
    source: r.source_branch ?? "",
    target: r.target_branch ?? "",
    ...(r.author?.name ? { author: r.author.name } : {}),
    ...(r.updated_at ? { updatedAt: r.updated_at } : {}),
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
    async searchCommits(repo, query, signal) {
      // GitHub 的提交搜索只搜默认分支：一律列出这个分支上的提交，再按说明筛
      const params = new URLSearchParams({
        sha: query.ref,
        ...(query.path ? { path: query.path } : {}),
        ...(query.since ? { since: query.since } : {}),
        per_page: String(query.query ? LOG_SCAN_COMMITS : query.limit),
      });
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/commits?${params}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "AgentTag",
        },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new RepoError(`GitHub 查提交历史失败（HTTP ${res.status}）${res.status === 404 || res.status === 422 ? "：找不到仓库或分支" : ""}`);
      }
      const body = (await res.json()) as {
        sha: string;
        html_url?: string;
        commit?: { message?: string; author?: { name?: string; date?: string }; committer?: { date?: string } };
      }[];
      const commits = body.map((c) => ({
        sha: c.sha,
        title: firstLine(c.commit?.message),
        message: c.commit?.message,
        // 提交进这个分支的时间（rebase、cherry-pick 过的提交，写的时间可能早得多），和 GitLab 的 committed_date 一样
        date: c.commit?.committer?.date ?? c.commit?.author?.date,
        author: c.commit?.author?.name,
        url: c.html_url,
      }));
      return { commits: pickCommits(commits, query), ...(query.query ? { scanned: body.length } : {}) };
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

/** 远端没有这个分支 */
class MissingBranchError extends RepoError {}

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

/** 话题在一个分支上的改动：基于哪个分支改、机器人建的分支、推上去的提交和开的合并请求 */
interface Change {
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

/** 推上去以后放到一边的改动：切到别的分支、或者把改动搬到别的分支时存下，切回 base 分支时接着用 */
interface ParkedChange extends Change {
  base: string;
  branch: string;
  pushedSha: string;
}

/** 话题工作目录的状态。当前的改动写在最外层（和以前的状态文件一样），之前在别的分支上推过的放在 earlier */
interface WorkspaceState extends Change {
  earlier?: ParkedChange[];
  /** 正在把改动搬到新分支 branch 上，搬完或退回前记着：中途被打断（重启）时，下次打开先退回 back 分支 */
  porting?: { back: string; branch: string };
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
  let state: WorkspaceState;
  try {
    state = JSON.parse(await readFile(path.join(dir, ".git", STATE_FILE), "utf8")) as WorkspaceState;
  } catch {
    return {};
  }
  // 状态文件里的分支名、提交号会拿去 checkout、push：对不上规矩的整个不认，当成新话题
  return validState(state) ? state : {};
}

function validState(state: WorkspaceState): boolean {
  if (typeof state !== "object" || state === null || (state.earlier !== undefined && !Array.isArray(state.earlier))) {
    return false;
  }
  const changes: Change[] = [state, ...(state.earlier ?? [])];
  const names = [...changes.flatMap((change) => [change.base, change.branch]), state.porting?.back, state.porting?.branch];
  const shas = changes.flatMap((change) => [change.baseSha, change.pushedSha]);
  return (
    names.every((name) => name === undefined || (typeof name === "string" && isBranchName(name))) &&
    shas.every((sha) => sha === undefined || (typeof sha === "string" && /^[0-9a-f]{40,64}$/.test(sha)))
  );
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

  /** 这个话题之前在别的分支上推过的改动和开的合并请求，从旧到新 */
  get earlier(): readonly ParkedChange[] {
    return this.state.earlier ?? [];
  }

  async init(existed: boolean, signal?: AbortSignal): Promise<void> {
    this.realDir = await realpath(this.dir);
    const head = await this.git(["rev-parse", "--abbrev-ref", "origin/HEAD"], signal).catch(() => "origin/main");
    const remoteDefault = this.configuredBranch ?? (head.trim().replace(/^origin\//, "") || "main");
    this.baseBranch = this.state.base ?? remoteDefault;
    if (existed && this.state.porting) {
      // 上次搬改动到别的分支时被打断：工作目录停在搬了一半的新分支上，退回原来的分支，改动还在那边
      const { back, branch } = this.state.porting;
      await this.git(["reset", "-q", "--hard"], signal);
      await this.git(["checkout", "-q", back], signal);
      await this.git(["branch", "-q", "-D", branch], signal).catch(() => {});
      delete this.state.porting;
    }
    if (existed && this.state.branch && !(await this.hasChanges(signal))) {
      // 切分支时被打断（检出了别的分支，状态文件还没写）：退回状态文件里记的机器人的分支
      const current = (await this.git(["symbolic-ref", "-q", "--short", "HEAD"], signal, [1])).trim();
      if (current !== this.state.branch && !(await this.checkoutOwn(this.state.branch, signal))) {
        // 本地连机器人的分支都没有了：当成这个分支上还没改过，下面从最新的代码开始
        this.state = { ...(this.state.base ? { base: this.state.base } : {}), ...(this.state.earlier ? { earlier: this.state.earlier } : {}) };
      }
    }
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
      out.parts("- ", [b.name, { branch: b.name }], `${tags.length > 0 ? `（${tags.join("，")}）` : ""}${commit ? `：${commit}` : ""}`);
    }
    return out.build();
  }

  /**
   * 查一个分支的提交历史，从新到旧：按说明里的词、改过的文件或目录、起始日期筛。工作目录是浅克隆，用平台接口查。
   * branch 不填是这个话题当前看的分支。列出的提交号记作查到的，回答里引用时要对得上
   */
  async log(
    options: { query?: string; path?: string; branch?: string; since?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<ToolOutput> {
    if (!this.host.searchCommits) {
      throw new RepoError(`${this.host.name} 还不支持查提交历史`);
    }
    const ref = options.branch?.trim() ? branchName(options.branch) : this.baseBranch;
    const query = options.query?.trim() || undefined;
    const rel = options.path?.trim() ? this.relative(options.path) : undefined;
    const file = rel === "." ? undefined : rel;
    const since = options.since?.trim() ? isoDate(options.since) : undefined;
    const limit = Math.min(MAX_LOG_COMMITS, Math.max(1, Math.trunc(options.limit ?? DEFAULT_LOG_COMMITS)));
    const { commits, scanned } = await this.host.searchCommits(this.repo, { ref, query, path: file, since, limit }, signal);
    const conditions = [query ? `说明里有「${query}」` : "", file ? `改过 ${file}` : "", since ? `${options.since?.trim()} 以后` : ""].filter(Boolean);
    const what = `${this.repo} 的 ${ref} 分支上${conditions.length > 0 ? `${conditions.join("、")}的` : ""}提交`;
    // 先列提交再筛、又翻满了：更早的提交没看，不能说「没改过」
    const partial = scanned !== undefined && scanned >= LOG_SCAN_COMMITS ? `（只翻了最近 ${scanned} 个提交，更早的没看，可以加 since 或换个词再查）` : "";
    const out = this.output();
    if (commits.length === 0) {
      return out.line(`${what}一个都没找到${partial}。`).build();
    }
    out.line(`${what}，最近的 ${commits.length} 个，从新到旧${partial}：`);
    for (const c of commits) {
      const detail = [c.date && beijingDate(c.date), c.author].filter(Boolean).join(" ");
      out.parts("- ", [c.sha.slice(0, 8), { commit: c.sha }], `${detail ? ` ${detail}` : ""}「${oneLine(c.title)}」${c.url ? ` ${c.url}` : ""}`);
    }
    return out.build();
  }

  /**
   * 列出仓库里的合并请求，按最近更新从新到旧，写明从哪个分支到哪个分支、状态，标出这个话题开的。
   * 群成员说「把京东短链修复合到 uat」这类指别处做过的修改时，先用它找到是哪个合并请求，再看合没合
   */
  async listRequests(options: { state?: RequestQuery["state"]; search?: string; limit?: number }, signal?: AbortSignal): Promise<ToolOutput> {
    const name = this.host.requestName;
    if (!this.host.listRequests) {
      throw new RepoError(`${this.host.name} 还不支持列${name}`);
    }
    const state = options.state ?? "opened";
    const search = options.search?.trim() || undefined;
    const limit = Math.min(MAX_LIST_REQUESTS, Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIST_REQUESTS)));
    const list = await this.host.listRequests(this.repo, { state, search, limit }, signal);
    const mine = new Set([this.state.prNumber, ...this.earlier.map((change) => change.prNumber)].filter((n) => n !== undefined));
    const what = `${this.repo} ${REQUEST_STATES[state]}的${name}${search ? `（标题或描述里有「${search}」）` : ""}`;
    const out = this.output();
    if (list.length === 0) {
      return out.line(`${what}一个都没有。`).build();
    }
    out.line(`${what}，按最近更新从新到旧，${list.length} 个${list.length >= limit ? `（只列了前 ${limit} 个）` : ""}：`);
    for (const r of list) {
      const detail = [REQUEST_STATES[r.state], r.author, r.updatedAt && beijingDate(r.updatedAt), mine.has(r.number) ? "这个话题开的" : ""].filter(Boolean);
      out.parts(
        `- ${this.host.refOf(r.number)}「${oneLine(r.title)}」：`,
        [r.source, { branch: r.source }],
        " → ",
        [r.target, { branch: r.target }],
        `，${detail.join("，")} ${r.url}`,
      );
    }
    return out.build();
  }

  /**
   * 合并一个合并请求。只合机器人自己开的、开到没保护的分支（如 uat）的；开到受保护的分支（以平台上的保护设置为准，
   * master、prod 这类线上分支）或者仓库默认分支的不合，要人审过再点。要等流水线的设成流水线通过后自动合并
   */
  async mergeRequest(number: number, signal?: AbortSignal): Promise<ToolOutput> {
    const name = this.host.requestName;
    const ref = this.host.refOf(number);
    if (!this.host.mergeCheck || !this.host.mergeRequest) {
      throw new RepoError(`${this.host.name} 上机器人还不能合并${name}，请人来点`);
    }
    const check = await this.host.mergeCheck(this.repo, number, signal);
    const route: Piece[] = ["（", [check.source, { branch: check.source }], " → ", [check.target, { branch: check.target }], "）"];
    if (check.state === "merged") {
      return this.output().parts(`${ref}「${oneLine(check.title)}」`, ...route, `已经合并过了：${check.url}`).build();
    }
    if (check.state === "closed") {
      throw new RepoError(`${ref} 已经关掉了（没合并），合不了：${check.url}`);
    }
    if (check.fromFork) {
      throw new RepoError(`${ref} 是从别的项目（fork）提过来的，机器人不合，请人在 ${this.host.name} 上处理：${check.url}`);
    }
    // 只合机器人自己推的代码：别人开的合并请求里的改动机器人没经手，由开的人或有权限的人决定
    if (!check.authorUsername || check.authorUsername.toLowerCase() !== check.botUsername.toLowerCase()) {
      throw new RepoError(
        `${ref} 是 ${check.author ?? check.authorUsername ?? "别人"} 开的，机器人只合并自己开的${name}，请开的人或有权限的人在 ${this.host.name} 上点合并：${check.url}`,
      );
    }
    if (check.targetProtected || check.targetIsDefault) {
      throw new RepoError(
        `${ref} 要合到的 ${check.target} 是${check.targetProtected ? "受保护的分支" : "仓库的默认分支"}，合并要人审过再点，机器人不合：${check.url}`,
        this.onBranch(check.target),
      );
    }
    const merged = await this.host.mergeRequest(this.repo, number, { sha: check.sha }, signal);
    const url = merged.url || check.url;
    const out = this.output();
    return (
      merged.state === "merged"
        ? out.parts(`已合并${name} ${ref}「${oneLine(check.title)}」`, ...route, `，改动进了 ${check.target} 分支：${url}`)
        : out.parts(
            `${ref}「${oneLine(check.title)}」`,
            ...route,
            `要等流水线跑完才能合，已设成流水线通过后自动合并；流水线没过就不会合，到 ${this.host.name} 上看流水线：${url}`,
          )
    ).build();
  }

  /**
   * 切换这个话题看的分支。之后不指定分支的读、搜、改和开合并请求都基于它。
   * 改了代码还没推上去时不能切，免得改动丢了或混到别的分支上。推上去了的（开过合并请求的）放到一边，
   * 切回那个分支（或机器人建的那个分支）时接着用，新改动推到同一个合并请求。只能切到已有的分支，新分支在开合并请求时建
   */
  switchBranch(branch: string, signal?: AbortSignal): Promise<ToolOutput> {
    return this.serial(async () => {
      const name = branchName(branch);
      if (name === this.baseBranch || name === this.state.branch) {
        return this.output()
          .parts("已经在 ", [this.baseBranch, { branch: this.baseBranch }], " 分支上了", ...(this.state.branch ? this.ownBranchNote() : ["。"]))
          .build();
      }
      if (await this.unpushed(signal)) {
        throw new RepoError(
          `这个话题里基于 ${this.baseBranch} 分支改的代码还没推上去，切分支会把改动丢掉，不能切。` +
            `要把这些改动提到 ${name} 分支，用 code_open_pr 的 target 填 ${name}；只是看别的分支的代码，给读、搜工具传 branch 就行`,
          this.onBranch(this.baseBranch),
        );
      }
      let restore = this.earlier.findLast((change) => change.base === name || change.branch === name);
      // 放到一边的合并请求后来合并了、关掉了：不再接着用它，从那个分支最新的代码重新开始
      let finished: { change: ParkedChange; state: RequestState | "missing" } | undefined;
      const state = restore && (await this.requestState(restore.prNumber, signal));
      if (restore && (state === "merged" || state === "closed")) {
        finished = { change: restore, state };
        restore = undefined;
      } else if (restore && !(await this.git(["rev-parse", "-q", "--verify", `refs/heads/${restore.branch}`], signal, [1])).trim()) {
        finished = { change: restore, state: "missing" };
        restore = undefined;
      }
      const goal = finished ? finished.change.base : name;
      if (finished && goal === this.baseBranch) {
        // 说的是这个分支上之前那个机器人的分支：只把它从记录里去掉，当前的不动
        const rest = this.earlier.filter((change) => change !== finished.change);
        this.state = { ...this.state, earlier: rest.length > 0 ? rest : undefined };
        await this.saveState();
        return this.output()
          .parts(
            ...this.finishedNote(finished.change, finished.state, false),
            "已经在 ",
            [goal, { branch: goal }],
            " 分支上了",
            ...(this.state.branch ? this.ownBranchNote() : ["。"]),
          )
          .build();
      }
      const parked = this.parked();
      const earlier = [...this.earlier.filter((change) => change !== restore && change !== finished?.change), ...(parked ? [parked] : [])];
      const pieces: Piece[] = [];
      if (finished) {
        pieces.push(...this.finishedNote(finished.change, finished.state, true));
      }
      if (restore) {
        await this.checkoutOwn(restore.branch, signal);
        this.state = { ...restore, ...(earlier.length > 0 ? { earlier } : {}) };
        this.baseBranch = restore.base;
        await this.saveState();
        pieces.push("已切到 ", [restore.base, { branch: restore.base }], " 分支", ...this.ownBranchNote());
      } else {
        try {
          await this.fetchBranches([goal], signal);
        } catch (err) {
          if (err instanceof MissingBranchError && !finished) {
            throw new RepoError(
              `没有 ${name} 这个分支，只能切到已有的分支。要新建分支不用先切：基于当前的 ${this.baseBranch} 分支（或者先切到要基于的已有分支）改好代码，` +
                `用 code_open_pr 开${this.host.requestName}时把 branch 填成 ${name}，机器人会建这个新分支。看有哪些分支用 code_branches`,
            );
          }
          throw err;
        }
        await this.checkout(goal, signal);
        this.state = { base: goal, baseSha: this.state.baseSha, ...(earlier.length > 0 ? { earlier } : {}) };
        this.baseBranch = goal;
        await this.saveState();
        const [sha, last] = (await this.git(["log", "-1", "--format=%h%x00%cs %an「%s」"], signal)).trim().split("\0");
        pieces.push(
          "已切到 ",
          [goal, { branch: goal }],
          " 分支，最新提交 ",
          [sha, { commit: sha }],
          ` ${last}。这个话题后面看代码、改代码、开${this.host.requestName}都基于这个分支。`,
        );
      }
      if (parked) {
        pieces.push(
          `之前在 `,
          [parked.base, { branch: parked.base }],
          ` 上${parked.prNumber ? `开的${this.host.requestName} ${this.host.refOf(parked.prNumber)} ` : "推上去的改动"}不受影响，切回 `,
          [parked.base, { branch: parked.base }],
          " 会接着用它。",
        );
      }
      return this.output().parts(...pieces).build();
    });
  }

  /** 「之前在 main 上开的 !12 已经合并了…」 */
  private finishedNote(change: Change, state: RequestState | "missing", fresh: boolean): Piece[] {
    const base = change.base ?? this.baseBranch;
    const what = change.prNumber ? `开的${this.host.requestName} ${this.host.refOf(change.prNumber)} ` : "推过的改动";
    const why = state === "merged" ? "已经合并了" : state === "closed" ? "已经关掉了" : "在工作目录里找不到了";
    const next = fresh ? `这次从 ${base} 最新的代码开始，新改动会另开${this.host.requestName}。` : "";
    return ["之前在 ", [base, { branch: base }], ` 上${what}${why}，不再往上推。${next}`];
  }

  /** 之前开的合并请求现在的状态。平台不支持查、或者查失败时不知道（当它还开着，和以前一样） */
  private async requestState(number: number | undefined, signal?: AbortSignal): Promise<RequestState | undefined> {
    if (!number || !this.host.getRequest) {
      return undefined;
    }
    try {
      return (await this.host.getRequest(this.repo, number, signal)).state;
    } catch (err) {
      if (signal?.aborted) {
        throw err;
      }
      return undefined;
    }
  }

  /** 「，改动在机器人建的 xx 分支上（合并请求 !12）…」：当前分支上已经有机器人的分支时，说明新改动推到哪里 */
  private ownBranchNote(): Piece[] {
    const branch = this.state.branch!;
    const pr = this.pullRequest;
    return [
      "，这个话题的改动在机器人建的 ",
      [branch, { branch }],
      pr
        ? ` 分支上，开了${this.host.requestName} ${this.host.refOf(pr.number)}（${pr.url}），新改动会推到它。`
        : ` 分支上，还没开成${this.host.requestName}，用 code_open_pr 补开。`,
    ];
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
      return out.parts("没有匹配的文件（", [where.text, ...where.refs], "）。").build();
    }
    const more = files.length - MAX_LIST_FILES;
    out.parts(`共 ${files.length} 个文件（`, [where.text, ...where.refs], `）${more > 0 ? `，只列出前 ${MAX_LIST_FILES} 个，缩小范围再看` : ""}：`);
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
        return out.parts(`没有搜到「${pattern}」（`, [where.text, ...where.refs], "）。").build();
      }
      const more = matches.length - MAX_SEARCH_MATCHES;
      out.parts(
        `共 ${matches.length} 处（`,
        [where.text, ...where.refs],
        `）${more > 0 ? `，只列出前 ${MAX_SEARCH_MATCHES} 处，换个更具体的搜法或加 glob 缩小范围` : ""}：`,
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
      return out.parts(`在这 ${names.length} 个分支上都没有搜到「${pattern}」：`, ...branchList(names), "。").build();
    }
    const labels = await Promise.all(hit.map((name) => this.label({ name, ref: `refs/remotes/origin/${name}` }, signal)));
    const total = hit.reduce((sum, name) => sum + found.get(name)!.length, 0);
    out.line(`在 ${hit.length} 个分支上共搜到 ${total} 处${total > MAX_SEARCH_MATCHES ? `，只列出前 ${MAX_SEARCH_MATCHES} 处` : ""}：`);
    let budget = MAX_SEARCH_MATCHES;
    hit.forEach((name, i) => {
      const matches = found.get(name)!;
      out.parts("【", [labels[i].text, ...labels[i].refs], `，${matches.length} 处】`);
      matches.slice(0, Math.max(0, budget)).forEach((match) => addMatch(out, match));
      budget -= matches.length;
    });
    if (miss.length > 0) {
      out.parts("没搜到的分支：", ...branchList(miss));
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
        throw new MissingBranchError(`没有 ${missing[1]} 这个分支，用 code_branches 看看有哪些分支`);
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
    // 和上次推上去的（没推过就是检出时的分支，见 compareBase）比，没推的提交和没提交的改动都算
    const base = this.compareBase() ?? `origin/${this.baseBranch}`;
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
   * 分支名用群成员给的（options.branch），没给时由程序生成（agenttag/日期-随机）；第一次推时远端不能已经有这个分支，不会推到默认分支或别人的分支。
   * target 和当前分支不一样时，从 target 拉一个新分支，把这个话题的改动（或者 from 这个合并请求的改动）整份搬过去，再开一个到 target 的 PR
   */
  openPullRequest(title: string, body: string, options: OpenRequestOptions = {}, signal?: AbortSignal): Promise<OpenedRequest> {
    return this.serial(() => this.commitAndOpen(title, body, options, signal));
  }

  private async commitAndOpen(title: string, body: string, options: OpenRequestOptions, signal?: AbortSignal): Promise<OpenedRequest> {
    const target = options.target?.trim() ? branchName(options.target) : undefined;
    const requested = options.branch?.trim() ? branchName(options.branch) : undefined;
    if (options.from !== undefined) {
      if (!target) {
        throw new RepoError(`要搬 ${this.host.refOf(options.from)} 的改动，target 要填搬到哪个分支`);
      }
      return this.portRequest(options.from, target, title, body, requested, signal);
    }
    if (target && target !== this.baseBranch) {
      return this.portOwn(target, title, body, requested, signal);
    }
    await this.git(["add", "-A"], signal);
    const staged = await this.hasStaged(signal);
    if (requested && this.state.branch && requested !== this.state.branch) {
      if (this.state.pushedSha) {
        throw new RepoError(
          `这个话题在 ${this.baseBranch} 分支上的改动已经推到机器人建的 ${this.state.branch} 分支` +
            `${this.pullRequest ? `（${this.host.requestName} ${this.host.refOf(this.pullRequest.number)}）` : ""}，后面的改动都接着推到它，不能换分支名。` +
            "要把另一处修改单独开分支，请在新话题里提",
          this.onBranch(this.state.branch),
        );
      }
      // 上次没推成（比如分支名已经有了）：本地的分支换成这个名字
      await this.assertNewBranch(requested, signal);
      await this.git(["branch", "-M", requested], signal);
      this.state.branch = requested;
      await this.saveState();
    }
    if (staged) {
      if (!this.state.branch) {
        if (requested) {
          await this.assertNewBranch(requested, signal);
        }
        const branch = requested ?? newBranchName(this.now());
        await this.git(["checkout", "-B", branch], signal);
        this.state.branch = branch;
        await this.saveState();
      }
      await this.git(["commit", "-q", "-m", title, ...(body ? ["-m", body] : [])], signal);
    }
    const branch = this.state.branch;
    const head = await this.head(signal);
    const base = this.compareBase() ?? (await this.git(["rev-parse", `origin/${this.baseBranch}`], signal)).trim();
    const changes = await this.changedFiles([base, "HEAD"], signal);
    if (!branch || (head === base && this.pullRequest)) {
      throw new RepoError(
        this.pullRequest
          ? `没有新的改动要推，${this.host.requestName}还是 ${this.pullRequest.url}`
          : "还没有任何改动，先用 code_edit_file 改代码",
      );
    }
    if (this.pullRequest && head !== this.state.pushedSha) {
      const old = this.pullRequest;
      const state = await this.requestState(old.number, signal);
      if ((state === "merged" || state === "closed") && this.state.pushedSha) {
        // 之前开的已经合并或关掉了：那个分支不再往上推，从这个分支最新的代码另开一个。
        // 合并了的只搬后来的新改动；关掉了（没合并）的之前那份没进去，连同新改动整份搬
        const from = state === "merged" ? this.state.pushedSha : (this.state.baseSha ?? this.state.pushedSha);
        const opened = await this.port({ base: from, tip: head }, this.baseBranch, title, body, undefined, undefined, signal, true);
        return { ...opened, replaced: { number: old.number, state } };
      }
    }
    await this.push(branch, signal);

    if (this.pullRequest) {
      return { ...this.pullRequest, created: false, changes, base: this.baseBranch };
    }
    // 上次推上去了但开 PR 失败时，这次直接补开
    const pr = await this.host.openPullRequest(this.repo, { head: branch, base: this.baseBranch, title, body });
    this.state = { ...this.state, prUrl: pr.url, prNumber: pr.number };
    await this.saveState();
    return { ...pr, created: true, changes, branch, base: this.baseBranch };
  }

  /**
   * 把这个话题在当前分支上的改动搬到 target：还没推过的整份挪过去（只开到 target 的 PR），
   * 已经开过 PR 的复制一份（原来的 PR 不动，放到 earlier，切回原来的分支时接着用）
   */
  private async portOwn(target: string, title: string, body: string, requested: string | undefined, signal?: AbortSignal): Promise<OpenedRequest> {
    const from = this.baseBranch;
    const opened = this.pullRequest;
    this.assertNoChangeOn(target);
    await this.git(["add", "-A"], signal);
    const staged = await this.hasStaged(signal);
    if (this.state.pushedSha && (staged || (await this.head(signal)) !== this.state.pushedSha)) {
      const where = opened ? `${this.host.requestName} ${this.host.refOf(opened.number)}` : `${this.state.branch} 分支`;
      throw new RepoError(
        `这个话题在 ${from} 分支上推过的改动（${where}）后面又改了代码，还没推上去，不知道这些新改动要不要也放进 ${where}。` +
          `先问群成员：要放进去的话先用 code_open_pr（不填 target）推上去，再搬到 ${target}`,
        this.onBranch(from),
      );
    }
    if (staged) {
      // 改动先提交到本地的分支上（不推），再整份搬到 target
      if (!this.state.branch) {
        this.state.branch = newBranchName(this.now());
        await this.git(["checkout", "-B", this.state.branch], signal);
        await this.saveState();
      }
      await this.git(["commit", "-q", "-m", title, ...(body ? ["-m", body] : [])], signal);
    }
    const tip = await this.head(signal);
    if (!this.state.branch || !this.state.baseSha || tip === this.state.baseSha) {
      throw new RepoError("还没有任何改动，先用 code_edit_file 改代码");
    }
    // 名字跟着原来的分支走，看得出是同一份改动搬过去的；原来的分支还没推过（名字是随机起的）就另起一个
    const derived = this.state.pushedSha ? `${this.state.branch}-${target.replace(/\//g, "-")}` : undefined;
    const opened2 = await this.port({ base: this.state.baseSha, tip }, target, title, body, requested, derived, signal);
    return { ...opened2, ported: { from, ...(opened ? { earlier: opened.number } : {}) } };
  }

  /** 把仓库里已有的合并请求（别的话题或者别人开的）的改动搬到 target，开一个新的 PR，原来的不动 */
  private async portRequest(
    number: number,
    target: string,
    title: string,
    body: string,
    requested: string | undefined,
    signal?: AbortSignal,
  ): Promise<OpenedRequest> {
    const ref = this.host.refOf(number);
    if (!this.host.getRequest) {
      throw new RepoError(`${this.host.name} 还不支持把别的${this.host.requestName}的改动搬到别的分支`);
    }
    if (await this.unpushed(signal)) {
      throw new RepoError(
        `这个话题里基于 ${this.baseBranch} 分支改的代码还没推上去，搬 ${ref} 的改动会和它混在一起。先用 code_open_pr（不填 from）把这些改动推上去，再搬`,
        this.onBranch(this.baseBranch),
      );
    }
    this.assertNoChangeOn(target);
    const request = await this.host.getRequest(this.repo, number, signal);
    if (request.state === "closed") {
      throw new RepoError(`${ref} 已经关掉了（没合并），不搬。确认要的话请群成员说清楚要哪份改动`);
    }
    // 别的项目（fork）提过来的代码没人在这个项目里审过，机器人不替它在这个项目里建分支
    if (request.fromFork) {
      throw new RepoError(`${ref} 是从别的项目（fork）提过来的，机器人不搬外面项目的代码，请人在 ${this.host.name} 上处理：${request.url}`);
    }
    if (request.target === target) {
      throw new RepoError(`${ref} 本来就是开到 ${target} 分支的：${request.url}`, this.onBranch(target));
    }
    if (![request.baseSha, request.headSha].every((sha) => /^[0-9a-f]{40,64}$/.test(sha))) {
      throw new RepoError(`${this.host.name} 给的 ${ref} 的提交号不对，搬不了`);
    }
    try {
      await this.fetch([request.baseSha, request.headSha], signal);
    } catch (err) {
      throw new RepoError(`拉不到 ${ref} 的提交，搬不了：${(err as Error).message}`);
    }
    const derived = `${request.source}-${target.replace(/\//g, "-")}`;
    const opened = await this.port({ base: request.baseSha, tip: request.headSha }, target, title, body, requested, derived, signal);
    return { ...opened, ported: { request: { number, source: request.source, target: request.target, state: request.state } } };
  }

  /**
   * 从 target 拉一个新分支，把 source.base 到 source.tip 的改动整份搬过去（git apply --3way，有冲突就退回原样并说明是哪些文件），
   * 提交、推上去、开到 target 的 PR。这个话题当前推过的改动放到 earlier，之后就在新分支上接着改
   */
  private async port(
    source: { base: string; tip: string },
    target: string,
    title: string,
    body: string,
    requested: string | undefined,
    derived: string | undefined,
    signal?: AbortSignal,
    /** 当前的合并请求已经合并或关掉了：不放到一边，直接丢掉 */
    drop = false,
  ): Promise<OpenedRequest> {
    await this.fetchBranches([target], signal);
    if (requested) {
      await this.assertNewBranch(requested, signal);
    }
    const branch = requested ?? (await this.unusedName(derived, signal));
    const previous = this.state.branch ?? this.baseBranch;
    const patch = path.join(this.dir, ".git", "agenttag-port.patch");
    // 让 git 直接写文件：改动里可能有不是 UTF-8 的文件（GBK 的 PHP），经过字符串会坏
    await this.git(["diff", "--binary", "--full-index", "--no-renames", `--output=${patch}`, source.base, source.tip], signal);
    const targetSha = (await this.git(["rev-parse", `refs/remotes/origin/${target}`], signal)).trim();
    this.state.porting = { back: previous, branch };
    await this.saveState();
    await this.git(["checkout", "-q", "-B", branch, `refs/remotes/origin/${target}`], signal);
    const back = async () => {
      await this.git(["reset", "-q", "--hard"], signal).catch(() => {});
      await this.git(["checkout", "-q", previous], signal);
      await this.git(["branch", "-q", "-D", branch], signal).catch(() => {});
      delete this.state.porting;
      await this.saveState();
    };
    try {
      await this.git(["apply", "--3way", "--index", "--whitespace=nowarn", patch], signal);
    } catch (err) {
      const conflicts = splitNul(await this.git(["diff", "--name-only", "-z", "--diff-filter=U"], signal).catch(() => ""));
      await back();
      if (conflicts.length > 0) {
        throw new RepoError(
          `改动搬到 ${target} 分支时有冲突：${conflicts.map(shownPath).join("、")}（${target} 上这几个文件改动的地方和原来不一样）。` +
            `机器人不会自己解冲突：可以用 code_branches 切到 ${target}，按 ${target} 上的代码重新改，再开${this.host.requestName}；或者请人手动处理`,
          [...this.onBranch(target), ...conflicts.map((file) => ({ path: file, repo: this.repo, at: 0 }))],
        );
      }
      throw new RepoError(`改动搬到 ${target} 分支失败：${(err as Error).message}`, this.onBranch(target));
    } finally {
      await rm(patch, { force: true });
    }
    try {
      if (!(await this.hasStaged(signal))) {
        throw new RepoError(`${target} 分支上已经有这份改动了（搬过去没有任何变化），不用再开${this.host.requestName}`, this.onBranch(target));
      }
      await this.git(["commit", "-q", "-m", title, ...(body ? ["-m", body] : [])], signal);
    } catch (err) {
      await back();
      throw err;
    }
    // 推过的改动放到一边，切回原来的分支时接着用；只在本地、还没推过的不用留，已经整份搬过来了
    const parked = drop ? undefined : this.parked();
    const dropped = parked ? undefined : this.state.branch;
    const earlier = [...this.earlier, ...(parked ? [parked] : [])];
    this.state = { base: target, baseSha: targetSha, branch, ...(earlier.length > 0 ? { earlier } : {}) };
    this.baseBranch = target;
    await this.saveState();
    if (dropped) {
      await this.git(["branch", "-q", "-D", dropped], signal).catch(() => {});
    }
    await this.push(branch, signal);
    const changes = await this.changedFiles([targetSha, "HEAD"], signal);
    const pr = await this.host.openPullRequest(this.repo, { head: branch, base: target, title, body });
    this.state = { ...this.state, prUrl: pr.url, prNumber: pr.number };
    await this.saveState();
    return { ...pr, created: true, changes, branch, base: target };
  }

  /** 这个话题已经在 target 上推过改动时不再搬一份：新改动要进的是那个合并请求，切过去接着改 */
  private assertNoChangeOn(target: string): void {
    const existing = [...this.earlier, ...(this.state.branch && this.baseBranch === target ? [this.state] : [])].find(
      (change) => (change.base ?? this.baseBranch) === target && change.pushedSha,
    );
    if (existing?.branch) {
      const done = existing.prNumber ? `开过${this.host.requestName} ${this.host.refOf(existing.prNumber)}（${existing.prUrl}）` : "推过改动";
      throw new RepoError(
        `这个话题已经在 ${target} 分支上${done}，用的是机器人建的 ${existing.branch} 分支。` +
          `要把改动也放进去：用 code_branches 切到 ${target}（会接着用那个分支），改好再用 code_open_pr 推上去`,
        [...this.onBranch(target), ...this.onBranch(existing.branch)],
      );
    }
  }

  /** 推到机器人自己的分支。第一次推时远端不能已经有这个分支：--force-with-lease=<分支>: 由远端原子地检查，不会推到别人的分支上 */
  private async push(branch: string, signal?: AbortSignal): Promise<void> {
    const head = await this.head(signal);
    if (head === this.state.pushedSha) {
      return;
    }
    const fresh = this.state.pushedSha === undefined;
    try {
      await this.git(["push", ...(fresh ? [`--force-with-lease=refs/heads/${branch}:`] : []), "origin", `HEAD:refs/heads/${branch}`], signal);
    } catch (err) {
      if (fresh && err instanceof RepoError && /stale info|already exists/.test(err.message)) {
        throw new RepoError(
          `${branch} 分支已经有了。机器人只往自己新建的分支上推，用 code_open_pr 的 branch 换一个还没有的名字，或者问群成员要个新名字`,
          this.onBranch(branch),
        );
      }
      throw err;
    }
    this.state.pushedSha = head;
    await this.saveState();
  }

  /** 搬过去的新分支的名字：跟着原来的分支起（如 fix/x-uat），不合规矩或者已经有了就另起一个 */
  private async unusedName(derived: string | undefined, signal?: AbortSignal): Promise<string> {
    if (derived && !this.ownBranches().has(derived)) {
      try {
        const name = branchName(derived);
        if (await this.isNewBranch(name, signal)) {
          return name;
        }
      } catch (err) {
        if (!(err instanceof RepoError)) {
          throw err;
        }
      }
    }
    return newBranchName(this.now());
  }

  /** 这个话题工作目录里已经在用的分支：当前看的、机器人建的、之前放到一边的。新分支不能和它们重名，免得把它们重置掉 */
  private ownBranches(): Set<string> {
    return new Set([this.baseBranch, ...(this.state.branch ? [this.state.branch] : []), ...this.earlier.flatMap((change) => [change.base, change.branch])]);
  }

  /** 新分支名要合 git 的规矩，这个话题里没用过，远端也还没有这个分支 */
  private async assertNewBranch(name: string, signal?: AbortSignal): Promise<void> {
    if (this.ownBranches().has(name)) {
      throw new RepoError(`${name} 是这个话题已经在用的分支，新分支要换一个名字`, this.onBranch(name));
    }
    if (!(await this.isNewBranch(name, signal))) {
      throw new RepoError(
        `${name} 分支已经有了。机器人只往自己新建的分支上推，不会推到已有的分支；换一个还没有的分支名，或者不填 branch 由机器人起名`,
        this.onBranch(name),
      );
    }
  }

  private async isNewBranch(name: string, signal?: AbortSignal): Promise<boolean> {
    const { code } = await runGit(["check-ref-format", "--branch", name], { cwd: this.dir, signal, okCodes: [128] });
    if (code !== 0) {
      throw new RepoError(`分支名不对：${name}`);
    }
    const ref = `refs/heads/${name}`;
    const listed = await this.git(["ls-remote", "--heads", "origin", ref], signal);
    return !listed.split("\n").some((line) => line.split("\t")[1] === ref);
  }

  /** 这个话题当前推上去了的改动（放到一边时用）；没推过的不算 */
  private parked(): ParkedChange | undefined {
    const { branch, pushedSha, baseSha, prUrl, prNumber } = this.state;
    if (!branch || !pushedSha) {
      return undefined;
    }
    return { base: this.baseBranch, branch, pushedSha, ...(baseSha ? { baseSha } : {}), ...(prUrl && prNumber ? { prUrl, prNumber } : {}) };
  }

  /** 改了代码还没推上去：工作目录有改动，或者机器人的分支上有没推的提交 */
  private async unpushed(signal?: AbortSignal): Promise<boolean> {
    return (await this.hasChanges(signal)) || (this.state.branch !== undefined && (await this.head(signal)) !== this.state.pushedSha);
  }

  /**
   * 检出机器人之前建的分支，只用工作目录里本地的那个：不从远端拉同名分支，那可能是机器人的分支合并删掉以后别人新建的。
   * 本地没有了返回 false
   */
  private async checkoutOwn(branch: string, signal?: AbortSignal): Promise<boolean> {
    const local = await this.git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], signal, [1]);
    if (!local.trim()) {
      return false;
    }
    await this.git(["checkout", "-q", branch], signal);
    return true;
  }

  private async head(signal?: AbortSignal): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"], signal)).trim();
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

  /**
   * 算改动从哪儿比起：开过 PR 的，和上次推上去的比；还没开成 PR 的，和检出时的分支比。
   * 推上去了但开 PR 失败时，推上去的提交还不在任何 PR 里，补开时要列出全部改动
   */
  private compareBase(): string | undefined {
    return (this.pullRequest ? this.state.pushedSha : undefined) ?? this.state.baseSha;
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
        // 仓库里提交的符号链接目录（如 evil -> .git）也不能拿来读写 .git：改了状态文件、.git/config 就能推到别人的分支、在服务器上跑命令
        const gitDir = path.join(this.realDir, ".git");
        if (target === gitDir || target.startsWith(gitDir + path.sep)) {
          throw new RepoError("不能读写 .git 目录");
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

/** 开合并请求的选项 */
export interface OpenRequestOptions {
  /** 新分支的名字（群成员说了的话），不填由机器人起名。只能是远端还没有的分支 */
  branch?: string;
  /** 合并请求开到哪个分支，不填是这个话题当前的分支；不一样时把改动搬到那个分支上再开 */
  target?: string;
  /** 要搬的是仓库里已有的这个合并请求的改动（别的话题或别人开的），要和 target 一起用 */
  from?: number;
}

/** 开好或更新了的合并请求，changes 是和上次推上去的相比改了哪些文件 */
export interface OpenedRequest {
  url: string;
  number: number;
  created: boolean;
  changes: ChangedFile[];
  /** 机器人的分支，和合并请求开到的分支 */
  branch: string;
  base: string;
  /** 改动是搬过来的：从这个话题在 from 分支上的改动（earlier 是那边开过的合并请求），或者从仓库里已有的合并请求 request */
  ported?: { from?: string; earlier?: number; request?: { number: number; source: string; target: string; state: RequestState } };
  /** 这个话题之前开的合并请求已经合并或关掉了，新改动另开了这一个 */
  replaced?: { number: number; state: RequestState };
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
  out.parts([`${shownPath(match.file)}:${match.line}`, { path: match.file, lines: [match.line, match.line] }], `:${clip(match.text)}`);
}

/** 用顿号隔开的分支名，每个分支记在它自己那段 */
function branchList(names: readonly string[]): Piece[] {
  return names.flatMap((name, i): Piece[] => [...(i > 0 ? ["、"] : []), [name, { branch: name }]]);
}

/** 改动了哪些文件：一个文件一行，加减了几行 */
export function addChanges(out: ToolOutputBuilder, files: readonly ChangedFile[]): ToolOutputBuilder {
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const deleted = files.reduce((sum, file) => sum + (file.deleted ?? 0), 0);
  out.line(`改动了 ${files.length} 个文件（+${added} -${deleted}）：`);
  for (const file of files) {
    out.parts([shownPath(file.path), { path: file.path }], `（${file.added === undefined ? "二进制文件" : `+${file.added} -${file.deleted}`}）`);
  }
  return out;
}

function splitNul(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

/**
 * 给模型看的文件名：带换行、引号这类字符的，和 git 一样加引号转义。反斜杠照原样写：转义成 \\ 以后模型照着写出来的就和记下的文件名对不上了，
 * 反斜杠在回答里认路径时也不是分界
 */
function shownPath(file: string): string {
  return /[\u0000-\u001f"]/.test(file) ? JSON.stringify(file) : file;
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
export function numberedLines(
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
  let from = Math.max(1, Math.floor(start));
  let to = Math.min(lines.length, end ? Math.floor(end) : from + MAX_READ_LINES - 1, from + MAX_READ_LINES - 1);
  if (from > lines.length) {
    return out.parts([shownPath(file), { path: file }], ` 只有 ${lines.length} 行。`).build();
  }
  // 只要了一小段：扩到所在的整个函数，同一个函数里后面的分支也看得到
  const asked = { from, to };
  const fn = end ? enclosingFunction(lines, from, to, file) : undefined;
  // 整个函数一次给不完就不扩：不然从函数头开始给，没到要的那几行就截断了
  if (fn && (fn.start < from || fn.end > to) && lastShown(lines, fn.start, fn.end) === fn.end) {
    from = fn.start;
    to = fn.end;
  }
  const last = lastShown(lines, from, to);
  out.parts(
    [shownPath(file), { path: file }],
    "（",
    ...(where ? [[where.text, ...where.refs] as const, "，"] : []),
    `共 ${lines.length} 行，下面是第 ${from} 到 ${last} 行` +
      (from !== asked.from || to !== asked.to ? `：要的是第 ${asked.from} 到 ${asked.to} 行，扩到了所在的整个函数 ${fn?.name}` : "") +
      `${last < lines.length ? `，要看后面用 start_line=${last + 1}` : ""}）`,
  );
  // 每一行的行号「12|」交给了模型，这一行就算查到了
  for (let i = from; i <= last; i++) {
    out.parts([`${i}|`, { path: file, lines: [i, i] }], ` ${lines[i - 1]}`);
  }
  return out.build();
}

/** 从 from 往下给到 to，不超过 MAX_READ_CHARS 字时给到哪一行（至少给一行） */
function lastShown(lines: readonly string[], from: number, to: number): number {
  let size = 0;
  let last = from - 1;
  for (let i = from; i <= to; i++) {
    const length = `${i}| ${lines[i - 1]}`.length;
    if (size + length > MAX_READ_CHARS && i > from) {
      break;
    }
    size += length + 1;
    last = i;
  }
  return last;
}

/** 只要了一小段时，所在的函数最多这么多行就整段给出；更长的照要的给 */
const MAX_FUNCTION_LINES = 250;
/** 往上找函数头最多找多少行 */
const MAX_FUNCTION_LOOKBACK = 400;
/** PHP、JS/TS 用 function 关键字的函数头 */
const FUNCTION_HEADER = /^\s*(?:(?:export|default|public|private|protected|static|final|abstract|async)\s+)*function\s*&?\s*([A-Za-z_$][\w$]*)\s*\(/;
const BRACE_FILE = /\.(?:php|js|jsx|mjs|cjs|ts|tsx)$/i;

/**
 * 读的这几行（from 到 to）所在的函数，起止行（含）和函数名；不在函数里、或者函数超过 MAX_FUNCTION_LINES 行时不给。
 * 2026-10-10 转链排查：模型只读了 tb.go 报错附近几行（2431-2436，重定向失败就 return），
 * 修复在同一个函数往下 30 行（2468 从 topIds 取商品 ID），没看到，下了「不是服务故障」的结论。
 * Go 按 gofmt 的写法认：顶格的 func 到下一个顶格的 }。PHP、JS/TS 认 function 关键字的函数头，往下数大括号找到结尾
 * （字符串、注释里的大括号会数错，数出来超长的就不扩）
 */
export function enclosingFunction(lines: readonly string[], from: number, to: number, file: string): { start: number; end: number; name: string } | undefined {
  const limit = Math.max(1, from - MAX_FUNCTION_LOOKBACK);
  if (file.toLowerCase().endsWith(".go")) {
    for (let i = from; i >= limit; i--) {
      const line = lines[i - 1];
      // 先碰到上一个函数的结尾：要的这几行不在函数里
      if (i < from && /^}/.test(line)) {
        return undefined;
      }
      const header = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(line);
      // 一行写完的函数（func (x X) Len() int { return len(x) }）：在它下面的几行不在它里面。行尾注释里的大括号（// GET /items/{id}）不算
      if (header && /\{.*\}\s*$/.test(line.replace(/\s*\/\/.*$/, ""))) {
        return undefined;
      }
      if (header) {
        const close = lines.findIndex((text, index) => index >= i - 1 && /^}/.test(text));
        return close >= 0 ? fit(i, close + 1, header[1]) : undefined;
      }
    }
    return undefined;
  }
  if (!BRACE_FILE.test(file)) {
    return undefined;
  }
  // 由近到远找函数头，第一个把要的这几行包在里面的就是所在的函数（方法里的闭包也是函数，取最近的那个）
  for (let i = from; i >= limit; i--) {
    const header = FUNCTION_HEADER.exec(lines[i - 1]);
    if (!header) {
      continue;
    }
    const close = closingBrace(lines, i);
    if (close !== undefined && close >= to) {
      return fit(i, close, header[1]);
    }
  }
  return undefined;

  function fit(start: number, end: number, name: string) {
    return end >= to && end - start + 1 <= MAX_FUNCTION_LINES ? { start, end, name } : undefined;
  }
}

/** 从函数头那一行往下数大括号，回到 0 的那一行；数不到（或者超过 MAX_FUNCTION_LINES 还没完）不给 */
function closingBrace(lines: readonly string[], header: number): number | undefined {
  let depth = 0;
  let opened = false;
  for (let i = header; i <= Math.min(lines.length, header + MAX_FUNCTION_LINES); i++) {
    // 去掉行尾的 // 注释和引号里的内容，少数错一些。反斜杠只当转义符认（[^\\]），不然一长串没闭合的反斜杠会让正则回溯到卡死
    const code = lines[i - 1].replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "").replace(/\/\/.*$/, "");
    for (const char of code) {
      if (char === "{") {
        depth++;
        opened = true;
      } else if (char === "}") {
        depth--;
      }
    }
    if (opened && depth <= 0) {
      return i;
    }
  }
  return undefined;
}

/** 已经是整理好的分支名（状态文件里记的） */
function isBranchName(name: string): boolean {
  try {
    return branchName(name) === name;
  } catch {
    return false;
  }
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

/** 平台给的提交时间（各带各的时区，GitHub 是 UTC）写成北京时间的日期，和 since 的口径一样 */
function beijingDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso.slice(0, 10) : new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 模型写的日期（2026-10-01，或带时间的）换成平台接口要的 ISO 时间；没写时区的按北京时间，只写日期的是当天 0 点 */
function isoDate(text: string): string {
  const value = text.trim();
  const local = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(value);
  const pad = (part: string | undefined) => (part ?? "0").padStart(2, "0");
  const date = new Date(
    local ? `${local[1]}-${pad(local[2])}-${pad(local[3])}T${pad(local[4])}:${pad(local[5])}:${pad(local[6])}+08:00` : value,
  );
  if (Number.isNaN(date.getTime())) {
    throw new RepoError(`since 要写成 2026-10-01 这样的日期：${text}`);
  }
  return date.toISOString();
}
