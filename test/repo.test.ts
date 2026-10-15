import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  type CodeHost,
  type CommitQuery,
  type CommitSearch,
  CodeWorkspaces,
  type MergeCheck,
  type MergeResult,
  type RequestDetail,
  type RequestInfo,
  type RequestQuery,
  type RequestState,
  createGitHubHost,
  createGitLabHost,
  enclosingFunction,
  numberedLines,
  RepoError,
  runGit,
} from "../src/repo.js";
import { createCodeTools } from "../src/tools/code.js";
import { type CodeFact, type CodeLocation, ToolOutputBuilder } from "../src/tools/tool.js";

const quiet = { info() {}, warn() {}, error() {} };
const author = {
  GIT_AUTHOR_NAME: "Seed",
  GIT_AUTHOR_EMAIL: "seed@example.com",
  GIT_COMMITTER_NAME: "Seed",
  GIT_COMMITTER_EMAIL: "seed@example.com",
};
const signal = new AbortController().signal;

const tmp = await mkdtemp(path.join(tmpdir(), "agenttag-repo-"));
after(() => rm(tmp, { recursive: true, force: true }));

// 本地的「远端」：一个裸仓库，里面有几个文件、一个指向仓库外的符号链接和一个二进制文件
const remote = path.join(tmp, "remote.git");
const seed = path.join(tmp, "seed");
const secret = path.join(tmp, "secret.env");
await writeFile(secret, "MODEL_API_KEY=sk-secret\n");
await runGit(["init", "-q", "--bare", "-b", "main", remote]);
await runGit(["clone", "-q", remote, seed]);
await mkdir(path.join(seed, "src"));
await writeFile(path.join(seed, "src", "a.ts"), "export const a = 1;\nexport function hello() {\n  return 'hi';\n}\n");
await writeFile(path.join(seed, "src", "b.ts"), "import { a } from './a';\nconsole.log(a, a);\n");
await writeFile(path.join(seed, "README.md"), "# demo\n");
await writeFile(path.join(seed, "logo.bin"), Buffer.from([0, 1, 2, 3]));
await symlink(secret, path.join(seed, "leak"));
await runGit(["add", "-A"], { cwd: seed });
await runGit(["commit", "-q", "-m", "init"], { cwd: seed, env: author });
await runGit(["push", "-q", "origin", "main"], { cwd: seed });

function fakeHost(fail = 0) {
  const prs: { repo: string; head: string; base: string; title: string; body: string }[] = [];
  let failures = fail;
  const host: CodeHost = {
    name: "Fake",
    requestName: "合并请求",
    refOf: (number) => `!${number}`,
    cloneUrl: () => `file://${remote}`,
    gitEnv: () => ({}),
    async openPullRequest(repo, pr) {
      if (failures-- > 0) {
        throw new RepoError("开 PR 失败");
      }
      prs.push({ repo, ...pr });
      return { url: `https://example.com/pr/${prs.length}`, number: prs.length };
    },
  };
  return { host, prs };
}

/** 记下的代码位置，at 换成结果里它所在那一行到 at 为止的文字，好读：代码位置在它自己那段文字露出来时就算数 */
function located(text: string, facts: readonly CodeFact[]) {
  return facts.map(({ at, ...fact }) => ({ ...fact, line: text.slice(0, at).split("\n").at(-1) }));
}

/** 代码位置的简写：文件、提交号，分支写成 branch:名字 */
function named(fact: CodeLocation): string {
  return "path" in fact ? fact.path : "commit" in fact ? fact.commit : `branch:${fact.branch}`;
}

/** 报错里带的代码位置 */
async function rejectsWith(run: Promise<unknown>, message: RegExp, facts: unknown[]) {
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof RepoError);
    assert.match(err.message, message);
    assert.deepEqual(err.facts.map(({ at: _, ...fact }) => fact), facts);
    return true;
  });
}

let rootCount = 0;
function workspaces(host: CodeHost, now?: () => Date) {
  return new CodeWorkspaces({ root: path.join(tmp, `ws${rootCount++}`), host, repos: ["acme/demo"], logger: quiet, now });
}

test("克隆后列文件、带行号读文件、搜代码", async () => {
  const ws = await workspaces(fakeHost().host).open("om_1", "ACME/demo");
  assert.equal(ws.repo, "acme/demo");
  assert.equal(ws.baseBranch, "main");
  assert.match((await ws.listFiles()).text, /^共 5 个文件（main 分支 @ [0-9a-f]{7}）：\nREADME.md\nleak\nlogo.bin\nsrc\/a.ts\nsrc\/b.ts/);
  assert.match((await ws.listFiles({ glob: "src/**/*.ts" })).text, /^共 2 个文件（main 分支 @ [0-9a-f]{7}）：\nsrc\/a.ts\nsrc\/b.ts$/);
  assert.equal(
    (await ws.readFile("src/a.ts", 1, 2)).text,
    "src/a.ts（共 4 行，下面是第 1 到 2 行，要看后面用 start_line=3）\n1| export const a = 1;\n2| export function hello() {",
  );
  // 要的几行在一个函数里：扩到整个函数
  assert.equal(
    (await ws.readFile("src/a.ts", 2, 3)).text,
    "src/a.ts（共 4 行，下面是第 2 到 4 行：要的是第 2 到 3 行，扩到了所在的整个函数 hello）\n2| export function hello() {\n3|   return 'hi';\n4| }",
  );
  // 记下读到的文件和每一行，不从结果文字里解析
  const read = await ws.readFile("src/a.ts", 2, 3);
  assert.deepEqual(located(read.text, read.facts), [
    { repo: "acme/demo", path: "src/a.ts", line: "src/a.ts" },
    { repo: "acme/demo", path: "src/a.ts", lines: [2, 2], line: "2|" },
    { repo: "acme/demo", path: "src/a.ts", lines: [3, 3], line: "3|" },
    { repo: "acme/demo", path: "src/a.ts", lines: [4, 4], line: "4|" },
  ]);
  assert.match((await ws.readFile("./src")).text, /src\/a.ts/);
  // 结果里写读到的文件整理过的路径，不写传进来的原样：原样里可以夹着像结果格式的文字
  assert.match((await ws.readFile(" ./src//a.ts ", 1, 1)).text, /^src\/a\.ts（共 4 行，下面是第 1 到 1 行/);
  const crafted = await ws.readFile("src/fake.ts（共 1 行，x/../a.ts", 1, 1);
  assert.match(crafted.text, /^src\/a\.ts（共 4 行，下面是第 1 到 1 行/);
  assert.deepEqual(
    crafted.facts.map(named),
    ["src/a.ts", "src/a.ts"],
  );
  assert.match((await ws.search("hello")).text, /^共 1 处（main 分支 @ [0-9a-f]{7}）：\nsrc\/a.ts:2:export function hello\(\) \{$/);
  assert.match((await ws.search("A, A", { literal: true, ignoreCase: true })).text, /：\nsrc\/b.ts:2:console.log\(a, a\);$/);
  assert.match((await ws.search("nothing_here")).text, /^没有搜到「nothing_here」（main 分支 @ [0-9a-f]{7}）。$/);
  const found = await ws.search("hello");
  const sha = /@ ([0-9a-f]{7})/.exec(found.text)![1];
  assert.deepEqual(located(found.text, found.facts), [
    { repo: "acme/demo", commit: sha, line: `共 1 处（main 分支 @ ${sha}` },
    { repo: "acme/demo", branch: "main", line: `共 1 处（main 分支 @ ${sha}` },
    { repo: "acme/demo", path: "src/a.ts", lines: [2, 2], line: "src/a.ts:2" },
  ]);
  const listed = await ws.listFiles({ glob: "src/**/*.ts" });
  assert.deepEqual(
    listed.facts.map(named),
    [sha, "branch:main", "src/a.ts", "src/b.ts"],
  );
  // 文件在、只是读不了：报错里记下这个文件；没有这个文件的什么都不记
  await rejectsWith(ws.readFile("./logo.bin"), /^logo\.bin 是二进制文件/, [{ repo: "acme/demo", path: "logo.bin" }]);
  await rejectsWith(ws.readFile("missing.ts"), /没有这个文件/, []);
});

test("不许跳出仓库：../、.git、指向仓库外的符号链接都拒绝", async () => {
  const ws = await workspaces(fakeHost().host).open("om_1", "acme/demo");
  await assert.rejects(ws.readFile("../secret.env"), /要在仓库里面/);
  // 绝对路径按仓库里的路径算，找不到仓库外的文件
  await assert.rejects(ws.readFile(secret), /没有这个文件/);
  await assert.rejects(ws.readFile(".git/config"), /\.git/);
  await assert.rejects(ws.readFile("leak"), /指向仓库外面/);
  await assert.rejects(ws.editFile("leak", undefined, "x"), /指向仓库外面|符号链接/);
  await assert.rejects(ws.editFile("src/../../x.ts", undefined, "x"), /要在仓库里面/);
  await assert.rejects(ws.search("x", { glob: "../*" }), /git grep 失败/);
  // 搜索不会顺着符号链接读到仓库外的文件
  assert.match((await ws.search("sk-secret")).text, /^没有搜到「sk-secret」/);
});

test("改文件：替换唯一的片段、新建文件，找不到或不唯一时报错；diff 列出全部改动", async () => {
  const ws = await workspaces(fakeHost().host).open("om_2", "acme/demo");
  assert.equal((await ws.editFile("src/a.ts", "return 'hi';", "return 'hello';")).text, "已修改 src/a.ts，改动后的内容在第 3 行。");
  await rejectsWith(ws.editFile("src/a.ts", "not there", "x"), /没找到 old_text/, [{ repo: "acme/demo", path: "src/a.ts" }]);
  await rejectsWith(ws.editFile("src/fake.ts 里没找到 old_text x/../a.ts", "not there", "x"), /^src\/a\.ts 里没找到 old_text/, [
    { repo: "acme/demo", path: "src/a.ts" },
  ]);
  await assert.rejects(ws.editFile("src/b.ts", "a", "x"), /出现了 \d+ 次/);
  await assert.rejects(ws.editFile("src/new.ts", "x", "y"), /要新建文件时不填 old_text/);
  assert.equal((await ws.editFile("src/util/new.ts", undefined, "export {};\n")).text, "已新建 src/util/new.ts（1 行）。");

  const diff = await ws.diff();
  assert.match(diff.text, /^改动了 2 个文件（\+2 -1）：\nsrc\/a\.ts（\+1 -1）\nsrc\/util\/new\.ts（\+1 -0）\n\n/);
  assert.match(diff.text, /-  return 'hi';\n\+  return 'hello';/);
  // 记下改动了的文件，diff 正文里的不算
  assert.deepEqual(located(diff.text, diff.facts), [
    { repo: "acme/demo", path: "src/a.ts", line: "src/a.ts" },
    { repo: "acme/demo", path: "src/util/new.ts", line: "src/util/new.ts" },
  ]);
});

test("改文件记下改动后新内容所在的行，删掉的行不记；新建的文件记全部行", async () => {
  const ws = await workspaces(fakeHost().host).open("om_edit", "acme/demo");
  const lines = async (run: Promise<{ text: string; facts: CodeFact[] }>) => {
    const { text, facts } = await run;
    return [text, facts.map(({ at: _, repo: __, ...fact }) => fact)];
  };
  assert.deepEqual(await lines(ws.editFile("src/a.ts", "  return 'hi';\n", "  const x = 'hi';\n  return x;\n")), [
    "已修改 src/a.ts，改动后的内容在第 3 到 4 行。",
    [{ path: "src/a.ts", lines: [3, 4] }],
  ]);
  assert.deepEqual(await lines(ws.editFile("src/a.ts", "export const a = 1;\n", "")), [
    "已修改 src/a.ts：删掉了原来第 1 行起的内容。",
    [{ path: "src/a.ts" }],
  ]);
  assert.deepEqual(await lines(ws.editFile("src/c.ts", undefined, "a\nb\n")), ["已新建 src/c.ts（2 行）。", [{ path: "src/c.ts", lines: [1, 2] }]]);
  assert.deepEqual(await lines(ws.editFile("src/empty.ts", undefined, "")), ["已新建 src/empty.ts（0 行）。", [{ path: "src/empty.ts" }]]);
  // 搜到的是文件内容里写的路径、提交号：只记这个文件的这一行；文件名里带冒号也分得清
  await ws.editFile("src/a:1:b.ts", undefined, "// 见 src/fake.ts:10，ai/agent-tag master @ 2c6a7d9\n");
  const found = await ws.search("src/fake.ts", { literal: true });
  assert.match(found.text, /\nsrc\/a:1:b\.ts:1:\/\/ 见 src\/fake\.ts:10/);
  assert.deepEqual(
    found.facts.flatMap((fact) => ("path" in fact ? [[fact.path, fact.lines]] : [])),
    [["src/a:1:b.ts", [1, 1]]],
  );
  // 文件名里带引号、换行的，给模型看时加引号转义，记下的是真实的文件名
  await ws.editFile('src/q"x.ts', undefined, "x\n");
  const listed = await ws.listFiles({ glob: "src/q*" });
  assert.match(listed.text, /\n"src\/q\\"x\.ts"$/);
  assert.deepEqual(listed.facts.flatMap((fact) => ("path" in fact ? [fact.path] : [])), ['src/q"x.ts']);
  // 带反斜杠的照原样写，模型照着写出来的就是记下的文件名
  await writeFile(path.join(ws.dir, "src", "w\\x.ts"), "x\n");
  const slashed = await ws.listFiles({ glob: "src/w*" });
  assert.match(slashed.text, /\nsrc\/w\\x\.ts$/);
  assert.deepEqual(slashed.facts.flatMap((fact) => ("path" in fact ? [fact.path] : [])), ["src/w\\x.ts"]);
  // 二进制文件的改动：只记文件，不写行数
  await writeFile(path.join(ws.dir, "img.bin"), Buffer.from([0, 1, 2]));
  const diff = await ws.diff();
  assert.match(diff.text, /\nimg\.bin（二进制文件）\n/);
  assert.ok(diff.facts.some((fact) => "path" in fact && fact.path === "img.bin" && fact.lines === undefined));
});

test("同一轮里并行改同一个文件的两处，两处改动都保留", async () => {
  const ws = await workspaces(fakeHost().host).open("om_par", "acme/demo");
  await Promise.all([
    ws.editFile("src/a.ts", "export const a = 1;", "export const a = 2;"),
    ws.editFile("src/a.ts", "return 'hi';", "return 'hello';"),
    ws.diff(),
  ]);
  const content = (await ws.readFile("src/a.ts")).text;
  assert.match(content, /export const a = 2;/);
  assert.match(content, /return 'hello';/);
});

test("开 PR：提交到机器人建的分支并推上去；同一话题再改会推到同一个 PR；没改动时报错", async () => {
  const { host, prs } = fakeHost();
  const all = workspaces(host, () => new Date("2026-09-26T10:00:00Z"));
  const ws = await all.open("om_3", "acme/demo");
  await assert.rejects(ws.openPullRequest("t", "b"), /还没有任何改动/);

  (await ws.editFile("README.md", "# demo", "# demo\n\n说明")).text;
  const first = await ws.openPullRequest("改 README", "描述");
  assert.equal(first.created, true);
  assert.equal(first.url, "https://example.com/pr/1");
  assert.deepEqual(first.changes, [{ path: "README.md", added: 2, deleted: 0 }]);
  assert.equal(prs.length, 1);
  assert.match(prs[0].head, /^agenttag\/20260926-[0-9a-f]{6}$/);
  assert.equal(prs[0].base, "main");
  assert.deepEqual([prs[0].title, prs[0].body], ["改 README", "描述"]);
  const log = (await runGit(["log", "--format=%s|%an", prs[0].head], { cwd: remote })).stdout.trim();
  assert.equal(log.split("\n")[0], "改 README|AgentTag");
  assert.equal((await runGit(["log", "-1", "--format=%s", "main"], { cwd: remote })).stdout.trim(), "init");

  // 同一话题的下一个任务：接着用这个工作目录，不会被重置
  const again = await all.open("om_3", "acme/demo");
  assert.equal(again.pullRequest?.url, first.url);
  (await again.editFile("src/a.ts", "export const a = 1;", "export const a = 2;")).text;
  assert.match((await again.diff()).text, /src\/a.ts/);
  assert.doesNotMatch((await again.diff()).text, /README/);
  const second = await again.openPullRequest("改 a", "");
  assert.deepEqual([second.created, second.number], [false, 1]);
  assert.equal(prs.length, 1);
  assert.equal((await runGit(["log", "-1", "--format=%s", prs[0].head], { cwd: remote })).stdout.trim(), "改 a");
  await assert.rejects(again.openPullRequest("x", ""), /没有新的改动要推，合并请求还是 https:\/\/example.com\/pr\/1/);
});

test("推上去了但开 PR 失败时，再调一次直接补开，不用新改动", async () => {
  const { host, prs } = fakeHost(1);
  const ws = await workspaces(host).open("om_4", "acme/demo");
  (await ws.editFile("README.md", "# demo", "# demo 2")).text;
  await assert.rejects(ws.openPullRequest("改标题", ""), /开 PR 失败/);
  // 推上去的提交还不在任何 PR 里：diff 和补开的 PR 都列出全部改动，记下改动了的文件
  const pending = await ws.diff();
  assert.match(pending.text, /^改动了 1 个文件（\+1 -1）：\nREADME\.md（\+1 -1）/);
  assert.deepEqual(pending.facts.map(named), ["README.md"]);
  const pr = await ws.openPullRequest("改标题", "");
  assert.equal(pr.created, true);
  assert.equal(prs.length, 1);
  assert.deepEqual(pr.changes, [{ path: "README.md", added: 1, deleted: 1 }]);
  // PR 开好以后，和推上去的比
  assert.match((await ws.diff()).text, /和已经推到合并请求的内容相比没有新的改动/);
});

test("没有改动、也没开过 PR 的工作目录，下次打开时更新到远端最新", async () => {
  const all = workspaces(fakeHost().host);
  await all.open("om_5", "acme/demo");
  await writeFile(path.join(seed, "NEW.md"), "new\n");
  await runGit(["add", "-A"], { cwd: seed });
  await runGit(["commit", "-q", "-m", "more"], { cwd: seed, env: author });
  await runGit(["push", "-q", "origin", "main"], { cwd: seed });
  const ws = await all.open("om_5", "acme/demo");
  assert.match((await ws.listFiles()).text, /NEW.md/);
});

test("只能操作接入的仓库；几天没用的工作目录会被清掉", async () => {
  let now = new Date("2026-09-26T00:00:00Z");
  const all = workspaces(fakeHost().host, () => now);
  await assert.rejects(all.open("om_6", "other/repo"), /没有接入仓库 other\/repo，能操作的只有：acme\/demo/);
  await all.open("om_6", "acme/demo");
  const root = path.dirname(path.dirname((await all.open("om_7", "acme/demo")).dir));
  await utimes(path.join(root, "om_6"), now, now);
  now = new Date("2026-09-28T00:00:00Z");
  await all.open("om_7", "acme/demo");
  now = new Date("2026-09-30T00:00:00Z");
  assert.equal(await all.sweep(), 1);
  assert.deepEqual(await readdir(root), ["om_7"]);
});

test("GitLab：git 用 Basic 认证头（放在环境变量里），开合并请求调 v4 接口，出错时说清原因", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const replies = [
    new Response(JSON.stringify({ iid: 7, web_url: "https://git.corp/g/sub/p/-/merge_requests/7" }), { status: 201 }),
    new Response(JSON.stringify({ message: "403 Forbidden" }), { status: 403 }),
    new Response(JSON.stringify({ message: ["Another open merge request already exists for this source branch: !7"] }), { status: 409 }),
  ];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return replies.shift()!;
  }) as unknown as typeof fetch;
  const host = createGitLabHost("https://git.corp/", "glpat-x", fakeFetch);

  assert.equal(host.cloneUrl("g/sub/p"), "https://git.corp/g/sub/p.git");
  assert.deepEqual(host.gitEnv(), {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://git.corp/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from("oauth2:glpat-x").toString("base64")}`,
  });
  assert.equal(host.refOf(7), "!7");

  const pr = { head: "agenttag/20260927-abcdef", base: "main", title: "修 bug", body: "说明" };
  assert.deepEqual(await host.openPullRequest("g/sub/p", pr), { url: "https://git.corp/g/sub/p/-/merge_requests/7", number: 7 });
  assert.equal(calls[0].url, "https://git.corp/api/v4/projects/g%2Fsub%2Fp/merge_requests");
  assert.equal((calls[0].init.headers as Record<string, string>)["private-token"], "glpat-x");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    source_branch: "agenttag/20260927-abcdef",
    target_branch: "main",
    title: "修 bug",
    description: "说明",
    remove_source_branch: true,
  });
  await assert.rejects(host.openPullRequest("g/sub/p", pr), /HTTP 403.*api 权限.*Developer/);
  await assert.rejects(host.openPullRequest("g/sub/p", pr), /HTTP 409.*已经有打开的合并请求.*Another open merge request/);
});

test("启动检查：GitLab 按角色和默认分支说明能否访问，404、401、Reporter 时说清原因", async () => {
  const urls: string[] = [];
  const replies = [
    new Response(
      JSON.stringify({
        path_with_namespace: "ai/aiops-mcp",
        default_branch: "main",
        permissions: { project_access: null, group_access: { access_level: 30 } },
      }),
      { status: 200 },
    ),
    new Response(JSON.stringify({ message: "404 Project Not Found" }), { status: 404 }),
    new Response(JSON.stringify({ message: "401 Unauthorized" }), { status: 401 }),
    new Response(JSON.stringify({ permissions: { project_access: { access_level: 20 }, group_access: null } }), { status: 200 }),
  ];
  const fakeFetch = (async (url: string) => {
    urls.push(url);
    return replies.shift()!;
  }) as unknown as typeof fetch;
  const host = createGitLabHost("https://lab.corp", "glpat-x", fakeFetch);

  assert.equal(await host.checkAccess!("ai/aiops-mcp"), "能访问，角色 Developer，默认分支 main");
  assert.equal(urls[0], "https://lab.corp/api/v4/projects/ai%2Faiops-mcp");
  await assert.rejects(host.checkAccess!("ai/agent-tag"), /HTTP 404.*项目成员.*项目访问令牌只能访问建它的那个项目/);
  await assert.rejects(host.checkAccess!("ai/agent-tag"), /令牌无效或过期/);
  await assert.rejects(host.checkAccess!("ai/agent-tag"), /角色是 Reporter，推不了分支/);
});

test("启动检查：GitHub 没有写权限或看不到仓库时说清原因", async () => {
  const replies = [
    new Response(JSON.stringify({ default_branch: "main", permissions: { push: true } }), { status: 200 }),
    new Response(JSON.stringify({ permissions: { push: false } }), { status: 200 }),
    new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
  ];
  const fakeFetch = (async () => replies.shift()!) as unknown as typeof fetch;
  const host = createGitHubHost("ghp", fakeFetch);
  assert.equal(await host.checkAccess!("acme/app"), "能访问，默认分支 main");
  await assert.rejects(host.checkAccess!("acme/app"), /没有写权限/);
  await assert.rejects(host.checkAccess!("acme/app"), /HTTP 404/);
});

test("代码工具：只有一个仓库时可以不填 repo，PR 描述带上发起人，一个任务里只打开一次", async () => {
  const { host, prs } = fakeHost();
  const all = workspaces(host);
  let opens = 0;
  const open = all.open.bind(all);
  all.open = (...args) => {
    opens++;
    return open(...args);
  };
  const tools = Object.fromEntries(
    createCodeTools({ workspaces: all, threadKey: "om_8", askerName: "张三", botName: () => "飞书 CLI" }).map((t) => [t.spec.name, t]),
  );
  assert.deepEqual(tools.code_read_file.spec.parameters.required, ["path"]);
  assert.match(await tools.code_read_file.run({ path: "src/a.ts" }, { signal }), /1\| export const a = 1;/);
  // 工具把查到的代码位置交给 onFacts，文字交给模型
  const reported: CodeFact[] = [];
  await tools.code_read_file.run({ path: "src/b.ts" }, { signal, onFacts: (facts) => reported.push(...facts) });
  assert.deepEqual(
    reported.map((fact) => ("path" in fact ? [fact.repo, fact.path, fact.lines] : [])),
    [["acme/demo", "src/b.ts", undefined], ["acme/demo", "src/b.ts", [1, 1]], ["acme/demo", "src/b.ts", [2, 2]]],
  );
  await tools.code_edit_file.run({ path: "src/a.ts", old_text: "= 1", new_text: "= 3" }, { signal });
  const opened: CodeFact[] = [];
  const result = await tools.code_open_pr.run({ title: "a 改成 3\n多余的行", body: "原因" }, { signal, onFacts: (facts) => opened.push(...facts) });
  const head = prs[0].head;
  assert.equal(result, `已开合并请求 !1（${head} → main）：https://example.com/pr/1\n\n改动了 1 个文件（+1 -1）：\nsrc/a.ts（+1 -1）`);
  // 分支名记在它那一行：回答里写到机器人建的分支、开到的分支不算编的
  assert.deepEqual(located(result, opened), [
    { repo: "acme/demo", branch: head, line: `已开合并请求 !1（${head}` },
    { repo: "acme/demo", branch: "main", line: `已开合并请求 !1（${head} → main` },
    { repo: "acme/demo", path: "src/a.ts", line: "src/a.ts" },
  ]);
  assert.equal(prs[0].title, "a 改成 3");
  assert.equal(prs[0].body, "原因\n\n---\n由 张三 在飞书群里让「飞书 CLI」提交。");
  assert.equal(opens, 1);
  assert.equal(tools.code_search.describe({ pattern: "hello" }), "搜代码：hello");
  await assert.rejects(tools.code_edit_file.run({ path: "x.ts" }, { signal }), /缺少 new_text/);
});

// 分支的「远端」：默认分支 main 上只有 README，代码在 aiops 分支上，另有一个旧分支和一个最近的功能分支
const branchRemote = path.join(tmp, "branches.git");
const branchSeed = path.join(tmp, "branch-seed");
async function commitAt(date: string, message: string) {
  await runGit(["add", "-A"], { cwd: branchSeed });
  await runGit(["commit", "-q", "-m", message], { cwd: branchSeed, env: { ...author, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}
await runGit(["init", "-q", "--bare", "-b", "main", branchRemote]);
await runGit(["clone", "-q", branchRemote, branchSeed]);
await writeFile(path.join(branchSeed, "README.md"), "# aiops-mcp\n");
await commitAt("2026-03-12T10:00:00+08:00", "Initial commit");
await runGit(["checkout", "-q", "-b", "old"], { cwd: branchSeed });
await writeFile(path.join(branchSeed, "legacy.go"), "// K8S client, deprecated\n");
await commitAt("2026-05-01T10:00:00+08:00", "old k8s client");
await runGit(["checkout", "-q", "-b", "aiops", "main"], { cwd: branchSeed });
await mkdir(path.join(branchSeed, "internal", "tools"), { recursive: true });
await writeFile(path.join(branchSeed, "internal", "tools", "k8s.go"), "package tools\n\nfunc RegisterK8sTools() {}\n");
await commitAt("2026-09-20T10:00:00+08:00", "feat: k8s tools");
await runGit(["checkout", "-q", "-b", "feature/x", "main"], { cwd: branchSeed });
await writeFile(path.join(branchSeed, "x.txt"), "x\n");
await commitAt("2026-09-25T10:00:00+08:00", "feature x");
await runGit(["push", "-q", "origin", "main", "old", "aiops", "feature/x"], { cwd: branchSeed });

function branchWorkspaces() {
  const { host, prs } = fakeHost();
  host.cloneUrl = () => `file://${branchRemote}`;
  return { all: new CodeWorkspaces({ root: path.join(tmp, `ws${rootCount++}`), host, repos: ["ai/aiops-mcp"], logger: quiet }), prs };
}

test("分支：列出分支、在最近活跃的分支上一起搜、读别的分支上的文件，都不切换当前分支", async () => {
  const ws = await branchWorkspaces().all.open("om_b1", "ai/aiops-mcp");
  assert.match((await ws.search("k8s", { ignoreCase: true })).text, /^没有搜到「k8s」（main 分支 @ [0-9a-f]{7}）。$/);

  const listed = await ws.listBranches();
  const branches = listed.text;
  assert.match(branches, /^ai\/aiops-mcp 共 4 个分支，按最近提交从新到旧：\n/);
  assert.deepEqual(
    branches.split("\n").slice(1).map((line) => line.split("：")[0]),
    ["- feature/x", "- aiops", "- old", "- main（默认分支，当前在看）"],
  );
  // 每个分支记在它那一行：分支名可以长得像路径，回答里写到它不算编的
  assert.deepEqual(
    located(branches, listed.facts).map(({ line, ...fact }) => [named(fact), line?.split("：")[0]]),
    [
      ["branch:feature/x", "- feature/x"],
      ["branch:aiops", "- aiops"],
      ["branch:old", "- old"],
      ["branch:main", "- main"],
    ],
  );
  assert.match(branches, /- aiops：2026-09-20 Seed「feat: k8s tools」/);
  assert.equal((await ws.listBranches("AIO")).text.split("\n").length, 2);
  const none = await ws.listBranches("nothing");
  assert.match(none.text, /没有名字里带「nothing」的分支，共 4 个分支/);
  assert.deepEqual(none.facts, []);

  const found = (await ws.search("k8s", { ignoreCase: true, branches: ["recent"] })).text;
  assert.match(found, /^在 2 个分支上共搜到 2 处：\n/);
  assert.match(found, /【aiops 分支 @ [0-9a-f]{7}，1 处】\ninternal\/tools\/k8s.go:3:func RegisterK8sTools\(\) \{\}/);
  assert.match(found, /【old 分支 @ [0-9a-f]{7}，1 处】\nlegacy.go:1:\/\/ K8S client, deprecated/);
  assert.match(found, /没搜到的分支：feature\/x、main$/);
  const grouped = await ws.search("k8s", { ignoreCase: true, branches: ["aiops", "old"] });
  assert.deepEqual(
    grouped.facts.map((fact) => ("path" in fact ? `${fact.path}:${fact.lines?.[0]}` : named(fact))),
    [...grouped.text.matchAll(/分支 @ ([0-9a-f]{7})/g)].flatMap((m, i) => [
      m[1],
      ["branch:aiops", "branch:old"][i],
      ["internal/tools/k8s.go:3", "legacy.go:1"][i],
    ]),
  );
  assert.match((await ws.search("RegisterK8sTools", { branches: ["aiops"], glob: "**/*.go" })).text, /在 1 个分支上共搜到 1 处/);
  const missed = await ws.search("nothing_here", { branches: ["aiops", "old"] });
  assert.match(missed.text, /在这 2 个分支上都没有搜到「nothing_here」：aiops、old。/);
  assert.deepEqual(missed.facts.map(named), ["branch:aiops", "branch:old"]);

  const other = await ws.readFile("internal/tools/k8s.go", 3, undefined, "origin/aiops");
  assert.match(other.text, /^internal\/tools\/k8s.go（aiops 分支 @ [0-9a-f]{7}，共 3 行，下面是第 3 到 3 行）\n3\| func RegisterK8sTools\(\) \{\}$/);
  // 别的分支上读的：记下文件、那一行和分支的提交号
  assert.deepEqual(
    other.facts.map((fact) => ("path" in fact ? [fact.path, fact.lines] : named(fact))),
    [["internal/tools/k8s.go", undefined], /@ ([0-9a-f]{7})/.exec(other.text)![1], "branch:aiops", ["internal/tools/k8s.go", [3, 3]]],
  );
  assert.match((await ws.readFile("internal", 1, undefined, "aiops")).text, /internal\/tools\/k8s.go/);
  assert.match((await ws.listFiles({ glob: "**/*.go", branch: "aiops" })).text, /^共 1 个文件（aiops 分支 @ [0-9a-f]{7}）：\ninternal\/tools\/k8s.go$/);
  assert.match((await ws.listFiles({ dir: "internal/tools", branch: "aiops" })).text, /internal\/tools\/k8s.go$/);
  // 分支在、文件不在：报错里只记下分支
  await rejectsWith(ws.readFile("nope.go", 1, undefined, "aiops"), /aiops 分支上没有这个文件：nope.go/, [{ repo: "ai/aiops-mcp", branch: "aiops" }]);
  await assert.rejects(ws.readFile("x", 1, undefined, "nope"), /没有 nope 这个分支，用 code_branches 看看有哪些分支/);
  await assert.rejects(ws.search("x", { branches: ["../etc"] }), /分支名不对/);
  await assert.rejects(ws.search("x", { branches: ["-x"] }), /分支名不对/);

  assert.equal(ws.baseBranch, "main");
  assert.match((await ws.listFiles()).text, /^共 1 个文件（main 分支 @ [0-9a-f]{7}）：\nREADME.md$/);
});

test("切换分支：之后读、搜、开合并请求都基于它，下个任务沿用；改过代码后不能再切", async () => {
  const { all, prs } = branchWorkspaces();
  const ws = await all.open("om_b2", "ai/aiops-mcp");
  const switched = await ws.switchBranch("origin/aiops");
  assert.match(switched.text, /^已切到 aiops 分支，最新提交 [0-9a-f]{7} 2026-09-20 Seed「feat: k8s tools」。/);
  const switchedTo = /提交 ([0-9a-f]{7})/.exec(switched.text)![1];
  assert.deepEqual(
    located(switched.text, switched.facts).map(({ line, ...fact }) => [named(fact), line]),
    [
      ["branch:aiops", "已切到 aiops"],
      [switchedTo, `已切到 aiops 分支，最新提交 ${switchedTo}`],
    ],
  );
  assert.equal(ws.baseBranch, "aiops");
  assert.match((await ws.search("RegisterK8sTools")).text, /^共 1 处（aiops 分支 @ [0-9a-f]{7}）：\ninternal\/tools\/k8s.go:3:/);
  assert.match((await ws.listBranches()).text, /- aiops（当前在看）/);

  const again = await all.open("om_b2", "ai/aiops-mcp");
  assert.equal(again.baseBranch, "aiops");
  (await again.editFile("internal/tools/k8s.go", "func RegisterK8sTools() {}", "func RegisterK8sTools() {\n\t// TODO\n}")).text;
  await rejectsWith(again.switchBranch("main"), /基于 aiops 分支改的代码还没推上去，切分支会把改动丢掉，不能切。要把这些改动提到 main 分支，用 code_open_pr 的 target 填 main/, [
    { repo: "ai/aiops-mcp", branch: "aiops" },
  ]);
  const stay = await again.switchBranch("aiops");
  assert.equal(stay.text, "已经在 aiops 分支上了。");
  assert.deepEqual(stay.facts.map(named), ["branch:aiops"]);

  // 远端分支后来又有新提交：比较改动时不会把它混进来
  await runGit(["checkout", "-q", "aiops"], { cwd: branchSeed });
  await writeFile(path.join(branchSeed, "later.go"), "package later\n");
  await commitAt("2026-09-27T10:00:00+08:00", "later");
  await runGit(["push", "-q", "origin", "aiops"], { cwd: branchSeed });
  const third = await all.open("om_b2", "ai/aiops-mcp");
  assert.match((await third.search("package later", { branches: ["aiops"] })).text, /later.go:1/);
  const diff = (await third.diff()).text;
  assert.match(diff, /internal\/tools\/k8s.go/);
  assert.doesNotMatch(diff, /later.go/);

  const pr = await third.openPullRequest("加 TODO", "");
  assert.equal(prs[0].base, "aiops");
  assert.deepEqual(pr.changes.map((file) => file.path), ["internal/tools/k8s.go"]);
  assert.match((await third.search("TODO")).text, /（aiops 分支 @ [0-9a-f]{7}，含机器人的改动）/);
});

test("话题里切过去的分支被删了：下次打开时回到默认分支", async () => {
  const { all } = branchWorkspaces();
  const ws = await all.open("om_b3", "ai/aiops-mcp");
  (await ws.switchBranch("feature/x")).text;
  await runGit(["push", "-q", "origin", "--delete", "feature/x"], { cwd: branchSeed });
  const again = await all.open("om_b3", "ai/aiops-mcp");
  assert.equal(again.baseBranch, "main");
  assert.match((await again.listFiles()).text, /README.md$/);
});

test("配置里给仓库指定了默认分支：新话题直接克隆这个分支，旧话题下次打开时换过去", async () => {
  const { host } = fakeHost();
  host.cloneUrl = () => `file://${branchRemote}`;
  const root = path.join(tmp, `ws${rootCount++}`);
  const plain = new CodeWorkspaces({ root, host, repos: ["ai/aiops-mcp"], logger: quiet });
  assert.equal((await plain.open("om_c1", "ai/aiops-mcp")).baseBranch, "main");

  const pinned = new CodeWorkspaces({ root, host, repos: ["ai/aiops-mcp"], branches: { "ai/aiops-mcp": "aiops" }, logger: quiet });
  const fresh = await pinned.open("om_c2", "ai/aiops-mcp");
  assert.equal(fresh.baseBranch, "aiops");
  assert.match((await fresh.search("RegisterK8sTools")).text, /（aiops 分支 @ [0-9a-f]{7}）/);
  const old = await pinned.open("om_c1", "ai/aiops-mcp");
  assert.equal(old.baseBranch, "aiops");
  assert.match((await old.listFiles({ glob: "**/*.go" })).text, /internal\/tools\/k8s.go/);
  // 话题里明确切过的分支优先
  (await old.switchBranch("old")).text;
  assert.equal((await pinned.open("om_c1", "ai/aiops-mcp")).baseBranch, "old");
});

// 搬改动的「远端」：main 和 uat 两个分支，uat 比 main 多一个提交（加了 uat.txt，改了 b.txt 的第 2 行）
const portRemote = path.join(tmp, "port.git");
const portSeed = path.join(tmp, "port-seed");
await runGit(["init", "-q", "--bare", "-b", "main", portRemote]);
await runGit(["clone", "-q", portRemote, portSeed]);
await writeFile(path.join(portSeed, "a.go"), "package a\n\nfunc A() int {\n\treturn 1\n}\n");
await writeFile(path.join(portSeed, "b.txt"), "one\ntwo\nthree\n");
await runGit(["add", "-A"], { cwd: portSeed });
await runGit(["commit", "-q", "-m", "init"], { cwd: portSeed, env: author });
await runGit(["checkout", "-q", "-b", "uat"], { cwd: portSeed });
await writeFile(path.join(portSeed, "uat.txt"), "uat only\n");
await writeFile(path.join(portSeed, "b.txt"), "one\nTWO on uat\nthree\n");
await runGit(["add", "-A"], { cwd: portSeed });
await runGit(["commit", "-q", "-m", "uat change"], { cwd: portSeed, env: author });
await runGit(["push", "-q", "origin", "main", "uat"], { cwd: portSeed });
const portRepo = "golang/appservice";

function portWorkspaces(extra: Partial<CodeHost> = {}) {
  const { host, prs } = fakeHost();
  Object.assign(host, { cloneUrl: () => `file://${portRemote}` }, extra);
  const root = path.join(tmp, `ws${rootCount++}`);
  return { all: new CodeWorkspaces({ root, host, repos: [portRepo], logger: quiet, now: () => new Date("2026-10-15T02:00:00Z") }), prs };
}
const remoteLog = async (ref: string) => (await runGit(["log", "--format=%s", ref], { cwd: portRemote })).stdout.trim().split("\n");
const remoteFile = async (ref: string, file: string) => (await runGit(["show", `${ref}:${file}`], { cwd: portRemote })).stdout;
const brief = (pr: { created: boolean; number: number; branch: string; base: string }) => [pr.created, pr.number, pr.branch, pr.base];

test("起新分支：按群成员说的名字建分支开合并请求；名字已经有了就不推，换个名字接着开", async () => {
  const { all, prs } = portWorkspaces();
  const ws = await all.open("om_p1", portRepo);
  // 切分支只能切到已有的：要新分支，告诉模型开合并请求时用 branch 起名
  await assert.rejects(
    ws.switchBranch("bugfix/jd_shortlink"),
    /^RepoError: 没有 bugfix\/jd_shortlink 这个分支，只能切到已有的分支。要新建分支不用先切：基于当前的 main 分支.*用 code_open_pr 开合并请求时把 branch 填成 bugfix\/jd_shortlink，机器人会建这个新分支/,
  );
  await ws.editFile("a.go", "return 1", "return 2");
  await rejectsWith(ws.openPullRequest("改 A", "", { branch: "uat" }), /^uat 分支已经有了。机器人只往自己新建的分支上推，不会推到已有的分支/, [
    { repo: portRepo, branch: "uat" },
  ]);
  // 这个话题自己在用的分支（当前看的 main）也不能当新分支：会把它重置掉
  await rejectsWith(ws.openPullRequest("改 A", "", { branch: "main" }), /^main 是这个话题已经在用的分支，新分支要换一个名字/, [{ repo: portRepo, branch: "main" }]);
  await assert.rejects(ws.openPullRequest("改 A", "", { branch: "bad..name" }), /分支名不对/);
  await assert.rejects(ws.openPullRequest("改 A", "", { branch: "bad.lock" }), /分支名不对/);
  assert.equal(prs.length, 0);

  // 查过没有、推之前别人建了同名分支（还指在 main 上，推上去能快进）：远端原子地拒绝，不会推到别人的分支上
  await runGit(["push", "-q", "origin", "main:refs/heads/fix/taken"], { cwd: portSeed });
  const racing = ws as unknown as { isNewBranch: () => Promise<boolean> };
  const check = racing.isNewBranch;
  racing.isNewBranch = async () => true;
  await rejectsWith(ws.openPullRequest("改 A", "", { branch: "fix/taken" }), /^fix\/taken 分支已经有了/, [{ repo: portRepo, branch: "fix/taken" }]);
  racing.isNewBranch = check;
  assert.deepEqual(await remoteLog("fix/taken"), ["init"]);
  await runGit(["push", "-q", "origin", "--delete", "fix/taken"], { cwd: portSeed });

  // 换个名字再开：本地还没推上去的分支改成新名字
  const pr = await ws.openPullRequest("改 A", "原因", { branch: "bugfix/jd_shortlink" });
  assert.deepEqual(brief(pr), [true, 1, "bugfix/jd_shortlink", "main"]);
  assert.deepEqual(prs.map((p) => [p.head, p.base]), [["bugfix/jd_shortlink", "main"]]);
  assert.deepEqual(await remoteLog("bugfix/jd_shortlink"), ["改 A", "init"]);
  // 推上去以后，这个话题在 main 上的改动都推到这个分支，不能换名字
  await ws.editFile("a.go", "return 2", "return 3");
  await rejectsWith(
    ws.openPullRequest("再改", "", { branch: "other" }),
    /已经推到机器人建的 bugfix\/jd_shortlink 分支（合并请求 !1），后面的改动都接着推到它，不能换分支名/,
    [{ repo: portRepo, branch: "bugfix/jd_shortlink" }],
  );
  assert.deepEqual(brief(await ws.openPullRequest("再改", "", { branch: "bugfix/jd_shortlink" })), [false, 1, "bugfix/jd_shortlink", "main"]);
  assert.equal((await ws.switchBranch("main")).text, "已经在 main 分支上了，这个话题的改动在机器人建的 bugfix/jd_shortlink 分支上，开了合并请求 !1（https://example.com/pr/1），新改动会推到它。");
});

test("合并到别的分支：同一话题里把开过合并请求的改动搬到 uat 再开一个，原来的不动；切回原来的分支接着用它", async () => {
  const { all, prs } = portWorkspaces();
  const ws = await all.open("om_p2", portRepo);
  await ws.editFile("a.go", "return 1", "return 2");
  await ws.openPullRequest("fix(jd): 短链", "描述", { branch: "bugfix/jd" });
  const port = await ws.openPullRequest("fix(jd): 短链（uat）", "描述", { target: "uat" });
  assert.deepEqual(brief(port), [true, 2, "bugfix/jd-uat", "uat"]);
  assert.deepEqual(port.ported, { from: "main", earlier: 1 });
  assert.deepEqual(port.changes, [{ path: "a.go", added: 1, deleted: 1 }]);
  assert.deepEqual(
    prs.map((p) => [p.head, p.base, p.title]),
    [
      ["bugfix/jd", "main", "fix(jd): 短链"],
      ["bugfix/jd-uat", "uat", "fix(jd): 短链（uat）"],
    ],
  );
  // uat 上原有的提交都在，改动整份搬过来成一个提交；原来的分支不动
  assert.deepEqual(await remoteLog("bugfix/jd-uat"), ["fix(jd): 短链（uat）", "uat change", "init"]);
  assert.match(await remoteFile("bugfix/jd-uat", "a.go"), /return 2/);
  assert.equal(await remoteFile("bugfix/jd-uat", "b.txt"), "one\nTWO on uat\nthree\n");
  assert.deepEqual(await remoteLog("bugfix/jd"), ["fix(jd): 短链", "init"]);
  assert.equal(ws.baseBranch, "uat");
  assert.equal(ws.pullRequest?.number, 2);
  assert.deepEqual(ws.earlier.map((c) => [c.base, c.branch, c.prNumber]), [["main", "bugfix/jd", 1]]);

  // 下个任务：接着在 uat 上改，推到 !2
  const next = await all.open("om_p2", portRepo);
  assert.equal(next.baseBranch, "uat");
  assert.match((await next.readFile("uat.txt")).text, /uat only/);
  await next.editFile("a.go", "return 2", "return 22");
  assert.deepEqual(brief(await next.openPullRequest("uat 上再改", "")), [false, 2, "bugfix/jd-uat", "uat"]);

  // 切回 main：接着用 !1，新改动推到它
  const back = await next.switchBranch("main");
  assert.equal(
    back.text,
    "已切到 main 分支，这个话题的改动在机器人建的 bugfix/jd 分支上，开了合并请求 !1（https://example.com/pr/1），新改动会推到它。" +
      "之前在 uat 上开的合并请求 !2 不受影响，切回 uat 会接着用它。",
  );
  assert.deepEqual(back.facts.map(named), ["branch:main", "branch:bugfix/jd", "branch:uat", "branch:uat"]);
  assert.match((await next.readFile("a.go")).text, /return 2$/m);
  await next.editFile("a.go", "return 2", "return 3");
  assert.deepEqual(brief(await next.openPullRequest("main 上再改", "")), [false, 1, "bugfix/jd", "main"]);
  assert.deepEqual(await remoteLog("bugfix/jd"), ["main 上再改", "fix(jd): 短链", "init"]);
  // uat 上已经开过：不再搬一份，切过去接着改
  await rejectsWith(
    next.openPullRequest("又搬", "", { target: "uat" }),
    /^这个话题已经在 uat 分支上开过合并请求 !2（https:\/\/example.com\/pr\/2），用的是机器人建的 bugfix\/jd-uat 分支。要把改动也放进去：用 code_branches 切到 uat/,
    [
      { repo: portRepo, branch: "uat" },
      { repo: portRepo, branch: "bugfix/jd-uat" },
    ],
  );
  // 用机器人建的分支名切也行
  assert.match((await next.switchBranch("bugfix/jd-uat")).text, /^已切到 uat 分支，这个话题的改动在机器人建的 bugfix\/jd-uat 分支上，开了合并请求 !2/);
  assert.match((await next.readFile("a.go")).text, /return 22/);
  assert.equal(prs.length, 2);
});

test("还没开合并请求就说开到 uat：改动整份挪过去只开一个；有冲突、uat 上已经有了，都退回原样", async () => {
  const { all, prs } = portWorkspaces();
  const ws = await all.open("om_p3", portRepo);
  // b.txt 第 2 行在 uat 上改过：冲突，退回原样，还能照常开到 main
  await ws.editFile("b.txt", "two", "two fixed");
  await rejectsWith(
    ws.openPullRequest("改 b", "", { target: "uat" }),
    /^改动搬到 uat 分支时有冲突：b.txt（uat 上这几个文件改动的地方和原来不一样）。机器人不会自己解冲突：可以用 code_branches 切到 uat，按 uat 上的代码重新改/,
    [
      { repo: portRepo, branch: "uat" },
      { repo: portRepo, path: "b.txt" },
    ],
  );
  assert.equal(ws.baseBranch, "main");
  assert.match((await ws.diff()).text, /two fixed/);
  await assert.rejects(ws.switchBranch("uat"), /还没推上去/);
  assert.deepEqual(brief(await ws.openPullRequest("改 b", "")).slice(2), [prs[0].head, "main"]);
  assert.match(prs[0].head, /^agenttag\/20261015-[0-9a-f]{6}$/);

  // uat 上已经有这份改动：不开
  const same = await all.open("om_p4", portRepo);
  await same.editFile("b.txt", "two", "TWO on uat");
  await rejectsWith(same.openPullRequest("改 b", "", { target: "uat" }), /^uat 分支上已经有这份改动了（搬过去没有任何变化），不用再开合并请求/, [
    { repo: portRepo, branch: "uat" },
  ]);
  assert.equal(same.baseBranch, "main");

  // 挪过去：只开一个到 uat 的，本地临时的分支不留
  const moved = await all.open("om_p5", portRepo);
  await moved.editFile("a.go", "return 1", "return 5");
  const pr = await moved.openPullRequest("A 返回 5", "", { target: "uat" });
  assert.deepEqual(pr.ported, { from: "main" });
  assert.equal(pr.base, "uat");
  assert.match(pr.branch, /^agenttag\/20261015-[0-9a-f]{6}$/);
  assert.deepEqual(moved.earlier, []);
  assert.deepEqual(await remoteLog(pr.branch), ["A 返回 5", "uat change", "init"]);
  const local = (await runGit(["branch", "--format=%(refname:short)"], { cwd: moved.dir })).stdout.trim().split("\n");
  assert.deepEqual(local.sort(), ["main", pr.branch].sort());
  assert.deepEqual(prs.slice(1).map((p) => p.base), ["uat"]);
});

test("搬别的话题开的合并请求：按编号拿到改动范围，从 uat 拉新分支搬过去", async () => {
  // 别的话题在 main 上开的 !7（分支 fix/other），和一个关掉了的 !8
  await runGit(["checkout", "-q", "-b", "fix/other", "main"], { cwd: portSeed });
  await writeFile(path.join(portSeed, "a.go"), "package a\n\nfunc A() int {\n\treturn 7\n}\n");
  await runGit(["commit", "-q", "-am", "A 返回 7"], { cwd: portSeed, env: author });
  await runGit(["push", "-q", "origin", "fix/other"], { cwd: portSeed });
  const headSha = (await runGit(["rev-parse", "HEAD"], { cwd: portSeed })).stdout.trim();
  const baseSha = (await runGit(["rev-parse", "main"], { cwd: portSeed })).stdout.trim();
  const seven: RequestDetail = { number: 7, title: "A 返回 7", url: "https://example.com/pr/7", state: "opened", source: "fix/other", target: "main", baseSha, headSha };
  const requests: Record<number, RequestDetail> = {
    7: seven,
    8: { ...seven, number: 8, state: "closed" },
    10: { ...seven, number: 10, fromFork: true },
  };
  const { all, prs } = portWorkspaces({
    async getRequest(_repo, number) {
      return requests[number] ?? Promise.reject(new RepoError(`没有 !${number}`));
    },
  });
  const ws = await all.open("om_p6", portRepo);
  await assert.rejects(ws.openPullRequest("t", "", { from: 7 }), /要搬 !7 的改动，target 要填搬到哪个分支/);
  await rejectsWith(ws.openPullRequest("t", "", { from: 7, target: "main" }), /^!7 本来就是开到 main 分支的/, [{ repo: portRepo, branch: "main" }]);
  await assert.rejects(ws.openPullRequest("t", "", { from: 8, target: "uat" }), /!8 已经关掉了/);
  // 从别的项目（fork）提过来的：没人在这个项目里审过，不搬
  await assert.rejects(ws.openPullRequest("t", "", { from: 10, target: "uat" }), /^RepoError: !10 是从别的项目（fork）提过来的，机器人不搬外面项目的代码/);
  await assert.rejects(ws.openPullRequest("t", "", { from: 9, target: "uat" }), /没有 !9/);
  const pr = await ws.openPullRequest("A 返回 7（uat）", "", { from: 7, target: "uat" });
  assert.deepEqual(brief(pr), [true, 1, "fix/other-uat", "uat"]);
  assert.deepEqual(pr.ported, { request: { number: 7, source: "fix/other", target: "main", state: "opened" } });
  assert.deepEqual(await remoteLog("fix/other-uat"), ["A 返回 7（uat）", "uat change", "init"]);
  assert.match(await remoteFile("fix/other-uat", "a.go"), /return 7/);
  assert.deepEqual(await remoteLog("fix/other"), ["A 返回 7", "init"]);
  assert.deepEqual(prs.map((p) => [p.head, p.base]), [["fix/other-uat", "uat"]]);

  // 这个话题自己还有没推的改动：不和它混在一起
  const busy = await all.open("om_p7", portRepo);
  await busy.editFile("b.txt", "three", "3");
  await assert.rejects(busy.openPullRequest("t", "", { from: 7, target: "uat" }), /还没推上去，搬 !7 的改动会和它混在一起/);
  // 平台不支持读合并请求
  const plain = await portWorkspaces().all.open("om_p8", portRepo);
  await assert.rejects(plain.openPullRequest("t", "", { from: 7, target: "uat" }), /Fake 还不支持把别的合并请求的改动搬到别的分支/);
  await runGit(["checkout", "-q", "uat"], { cwd: portSeed });
});

test("列合并请求：写明从哪个分支到哪个分支、状态，标出这个话题开的；分支名记作查到的", async () => {
  const queries: RequestQuery[] = [];
  let listed: RequestInfo[] = [];
  const { all } = portWorkspaces({
    async listRequests(_repo, query) {
      queries.push(query);
      return listed;
    },
  });
  const ws = await all.open("om_p9", portRepo);
  await ws.editFile("a.go", "return 1", "return 9");
  await ws.openPullRequest("fix(jd): 短链", "", { branch: "fix/nine" });
  listed = [
    { number: 1, title: "fix(jd): 短链\n第二行", url: "https://example.com/pr/1", state: "opened", source: "fix/nine", target: "main", author: "agent-boot", updatedAt: "2026-10-14T18:30:00Z" },
    { number: 5, title: "old", url: "https://example.com/pr/5", state: "merged", source: "feature/x", target: "uat" },
  ];
  const out = await ws.listRequests({ search: " 短链 " });
  assert.equal(
    out.text,
    "golang/appservice 开着的合并请求（标题或描述里有「短链」），按最近更新从新到旧，2 个：\n" +
      "- !1「fix(jd): 短链 第二行」：fix/nine → main，开着，agent-boot，2026-10-15，这个话题开的 https://example.com/pr/1\n" +
      "- !5「old」：feature/x → uat，已合并 https://example.com/pr/5",
  );
  assert.deepEqual(
    located(out.text, out.facts).map(({ line, ...fact }) => [named(fact), line]),
    [
      ["branch:fix/nine", "- !1「fix(jd): 短链 第二行」：fix/nine"],
      ["branch:main", "- !1「fix(jd): 短链 第二行」：fix/nine → main"],
      ["branch:feature/x", "- !5「old」：feature/x"],
      ["branch:uat", "- !5「old」：feature/x → uat"],
    ],
  );
  assert.deepEqual(queries, [{ state: "opened", search: "短链", limit: 10 }]);
  listed = [];
  assert.equal((await ws.listRequests({ state: "merged", limit: 99 })).text, "golang/appservice 已合并的合并请求一个都没有。");
  assert.deepEqual(queries[1], { state: "merged", search: undefined, limit: 30 });
  await assert.rejects((await portWorkspaces().all.open("om_p10", portRepo)).listRequests({}), /Fake 还不支持列合并请求/);
});

test("代码工具：code_open_pr 按 branch 起名、用 target 开到别的分支，code_requests 列合并请求", async () => {
  const fromAsked: number[] = [];
  const { all, prs } = portWorkspaces({
    listRequests: async () => [],
    async getRequest(_repo, number) {
      fromAsked.push(number);
      throw new RepoError("没有这个合并请求");
    },
  });
  const tools = Object.fromEntries(createCodeTools({ workspaces: all, threadKey: "om_p11", botName: () => "飞书 CLI" }).map((t) => [t.spec.name, t]));
  assert.equal(tools.code_open_pr.describe({}), "提交代码并开合并请求");
  assert.equal(tools.code_open_pr.describe({ target: "uat" }), "把改动开合并请求到 uat 分支");
  assert.equal(tools.code_requests.describe({ query: "短链" }), "查合并请求：短链");
  assert.ok(!tools.code_requests.writes && tools.code_open_pr.writes);
  await tools.code_edit_file.run({ path: "a.go", old_text: "return 1", new_text: "return 5" }, { signal });
  const first = await tools.code_open_pr.run({ title: "A 返回 5", body: "原因", branch: "fix/five" }, { signal });
  assert.match(first, /^已开合并请求 !1（fix\/five → main）：https:\/\/example.com\/pr\/1\n\n改动了 1 个文件/);
  const facts: CodeFact[] = [];
  const second = await tools.code_open_pr.run({ title: "A 返回 5（uat）", body: "原因", target: "uat" }, { signal, onFacts: (found) => facts.push(...found) });
  assert.equal(
    second.split("\n")[0],
    "已从 uat 拉出新分支 fix/five-uat，把这个话题在 main 分支上的改动搬过去，开了合并请求 !2（fix/five-uat → uat）：https://example.com/pr/2。" +
      "之前在 main 上开的 !1 不受影响。合并要人来点。",
  );
  assert.deepEqual(
    facts.map(named),
    ["branch:uat", "branch:fix/five-uat", "branch:main", "branch:fix/five-uat", "branch:uat", "a.go"],
  );
  assert.deepEqual(prs.map((p) => [p.head, p.base, p.body]), [
    ["fix/five", "main", "原因\n\n---\n由 群成员 在飞书群里让「飞书 CLI」提交。"],
    ["fix/five-uat", "uat", "原因\n\n---\n由 群成员 在飞书群里让「飞书 CLI」提交。"],
  ]);
  // from 写成「!353」也认
  const fresh = createCodeTools({ workspaces: all, threadKey: "om_p12", botName: () => "飞书 CLI" }).find((t) => t.spec.name === "code_open_pr")!;
  await assert.rejects(fresh.run({ title: "t", body: "", from: "!353", target: "uat" }, { signal }), /没有这个合并请求/);
  assert.deepEqual(fromAsked, [353]);
  await assert.rejects(fresh.run({ title: "t", body: "", from: "上次那个", target: "uat" }, { signal }), /from 要填合并请求的编号，如 353：上次那个/);
  assert.equal(await tools.code_requests.run({ query: "x", state: "weird" }, { signal }), "golang/appservice 开着的合并请求（标题或描述里有「x」）一个都没有。");
});

test("GitLab 合并请求：按更新时间列、带搜索词；读一个时用 diff_refs 的改动范围，找不到、没算好时说清", async () => {
  const urls: string[] = [];
  const responses = [
    new Response(
      JSON.stringify([
        {
          iid: 353,
          title: "fix(jd): 支持 3.jd.hk / 3.cn 短链跳转解析",
          web_url: "https://lab.corp/golang/appservice/-/merge_requests/353",
          state: "opened",
          source_branch: "agenttag/20261014-a1b2c3",
          target_branch: "master",
          author: { name: "agent-boot" },
          updated_at: "2026-10-14T18:23:00+08:00",
        },
        { iid: 300, title: "合并中", web_url: "u", state: "locked", source_branch: "a", target_branch: "uat", author: null },
        { iid: 12, title: "关掉的", web_url: "u", state: "closed", source_branch: "b", target_branch: "master" },
      ]),
      { status: 200 },
    ),
    new Response(
      JSON.stringify({
        iid: 353,
        title: "t",
        web_url: "u",
        state: "merged",
        source_branch: "s",
        target_branch: "master",
        source_project_id: 5,
        target_project_id: 5,
        diff_refs: { base_sha: "b0", head_sha: "h1", start_sha: "s0" },
      }),
      { status: 200 },
    ),
    new Response("{}", { status: 404 }),
    new Response(JSON.stringify({ iid: 354, title: "t", state: "opened", diff_refs: null }), { status: 200 }),
    new Response(
      JSON.stringify({ iid: 355, title: "t", state: "opened", source_project_id: 9, target_project_id: 5, diff_refs: { base_sha: "b0", head_sha: "h1" } }),
      { status: 200 },
    ),
    new Response("{}", { status: 403 }),
  ];
  const fakeFetch = (async (url: string) => {
    urls.push(url);
    return responses.shift()!;
  }) as unknown as typeof fetch;
  const host = createGitLabHost("https://lab.corp", "glpat-x", fakeFetch);
  const list = await host.listRequests!("golang/appservice", { state: "opened", search: "短链 jd", limit: 10 });
  assert.equal(
    urls[0],
    "https://lab.corp/api/v4/projects/golang%2Fappservice/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=10&search=%E7%9F%AD%E9%93%BE+jd",
  );
  assert.deepEqual(list[0], {
    number: 353,
    title: "fix(jd): 支持 3.jd.hk / 3.cn 短链跳转解析",
    url: "https://lab.corp/golang/appservice/-/merge_requests/353",
    state: "opened",
    source: "agenttag/20261014-a1b2c3",
    target: "master",
    author: "agent-boot",
    updatedAt: "2026-10-14T18:23:00+08:00",
  });
  assert.deepEqual(
    list.map((r) => [r.number, r.state]),
    [
      [353, "opened"],
      [300, "opened"],
      [12, "closed"],
    ],
  );
  const one = await host.getRequest!("golang/appservice", 353);
  assert.equal(urls[1], "https://lab.corp/api/v4/projects/golang%2Fappservice/merge_requests/353");
  assert.deepEqual([one.state, one.target, one.baseSha, one.headSha, one.fromFork], ["merged", "master", "b0", "h1", undefined]);
  await assert.rejects(host.getRequest!("golang/appservice", 9), /没有 !9 这个合并请求，用 code_requests 找一下/);
  await assert.rejects(host.getRequest!("golang/appservice", 354), /GitLab 没给出 !354 的改动范围/);
  // 从别的项目（fork）提过来的
  assert.equal((await host.getRequest!("golang/appservice", 355)).fromFork, true);
  await assert.rejects(host.listRequests!("golang/appservice", { state: "all", limit: 5 }), /GitLab 列合并请求失败（HTTP 403）：令牌没有读这个项目的权限/);
});

test("GitLab 列分支：调 v4 接口，按最近更新排，带最近一次提交", async () => {
  const urls: string[] = [];
  const fakeFetch = (async (url: string) => {
    urls.push(url);
    return new Response(
      JSON.stringify([
        { name: "master", default: true, commit: { committed_date: "2026-03-12T10:00:00.000+08:00", author_name: "张三", title: "Initial commit" } },
        { name: "aiops", default: false, commit: { committed_date: "2026-09-20T10:00:00.000+08:00", author_name: "李四", title: "feat: k8s" } },
      ]),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const host = createGitLabHost("https://lab.corp", "glpat-x", fakeFetch);
  assert.deepEqual(await host.listBranches!("ai/aiops-mcp"), [
    { name: "master", isDefault: true, date: "2026-03-12T10:00:00.000+08:00", author: "张三", title: "Initial commit" },
    { name: "aiops", isDefault: false, date: "2026-09-20T10:00:00.000+08:00", author: "李四", title: "feat: k8s" },
  ]);
  assert.equal(urls[0], "https://lab.corp/api/v4/projects/ai%2Faiops-mcp/repository/branches?per_page=100&sort=updated_desc");
});

test("代码工具：code_branches 列出和切换分支，code_search 的 branches 也接受逗号分隔的字符串", async () => {
  const { all } = branchWorkspaces();
  const tools = Object.fromEntries(createCodeTools({ workspaces: all, threadKey: "om_b4", botName: () => "飞书 CLI" }).map((t) => [t.spec.name, t]));
  assert.equal(tools.code_branches.describe({}), "列出代码分支");
  assert.equal(tools.code_branches.describe({ switch_to: "aiops" }), "切到 aiops 分支");
  assert.equal(tools.code_search.describe({ pattern: "k8s", branches: ["recent"] }), "搜代码：k8s（最近活跃的分支）");
  assert.equal(tools.code_read_file.describe({ path: "a.go", branch: "aiops" }), "读代码 a.go（aiops 分支）");
  assert.match(await tools.code_branches.run({ filter: "aio" }, { signal }), /- aiops：/);
  assert.match(await tools.code_search.run({ pattern: "k8s", ignore_case: true, branches: "aiops, old" }, { signal }), /在 2 个分支上共搜到 2 处/);
  assert.match(await tools.code_branches.run({ switch_to: "aiops" }, { signal }), /已切到 aiops 分支/);
  assert.match(await tools.code_list_files.run({ glob: "**/*.go" }, { signal }), /（aiops 分支 @ [0-9a-f]{7}）：\ninternal\/tools\/k8s.go/);
});

test("GitLab 查提交历史：只按说明里的词时用搜索接口，带文件或日期时列出提交再按说明筛，都按时间从新到旧", async () => {
  const urls: string[] = [];
  const commits = [
    {
      id: "1bfb19b1a0000000000000000000000000000000",
      title: "修复淘宝c.tb.cn不能转链的问题",
      author_name: "赵作武",
      committed_date: "2026-09-01T10:00:00.000+08:00",
    },
    {
      id: "4a677c0a4c1efcc3bc039fbbbb6c9aec029e0f37",
      title: "修复淘宝c.tb.cn短链落地半屏详情页导致转链失败的问题",
      message: "修复淘宝c.tb.cn短链落地半屏详情页导致转链失败的问题\n\n直接从 topIds 参数取商品id",
      author_name: "赵作武",
      committed_date: "2026-10-10T02:03:01.000-07:00",
      web_url: "https://lab.corp/golang/appservice/-/commit/4a677c0a4c1efcc3bc039fbbbb6c9aec029e0f37",
    },
    { id: "fd243a73d0000000000000000000000000000000", title: "Merge branch 'feature/x' into 'master'", author_name: "赵作武", committed_date: "2026-10-09T03:09:24.000+00:00" },
  ];
  const fakeFetch = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(commits), { status: 200 });
  }) as unknown as typeof fetch;
  const host = createGitLabHost("https://lab.corp", "glpat-x", fakeFetch);
  // 空格隔开的几个词都要有，不分大小写；说明正文里的词也算
  const searched = await host.searchCommits!("golang/appservice", { ref: "master", query: "C.TB.CN topids", limit: 10 });
  assert.deepEqual(searched, {
    commits: [
      {
        sha: "4a677c0a4c1efcc3bc039fbbbb6c9aec029e0f37",
        title: "修复淘宝c.tb.cn短链落地半屏详情页导致转链失败的问题",
        message: "修复淘宝c.tb.cn短链落地半屏详情页导致转链失败的问题\n\n直接从 topIds 参数取商品id",
        date: "2026-10-10T02:03:01.000-07:00",
        author: "赵作武",
        url: "https://lab.corp/golang/appservice/-/commit/4a677c0a4c1efcc3bc039fbbbb6c9aec029e0f37",
      },
    ],
  });
  assert.equal(urls[0], "https://lab.corp/api/v4/projects/golang%2Fappservice/search?scope=commits&search=C.TB.CN+topids&ref=master&per_page=100");
  const byFile = await host.searchCommits!("golang/appservice", {
    ref: "master",
    query: "c.tb.cn",
    path: "services/goods/tb.go",
    since: "2026-08-31T16:00:00.000Z",
    limit: 1,
  });
  assert.deepEqual(
    byFile.commits.map((c) => c.sha.slice(0, 9)),
    ["4a677c0a4"],
  );
  assert.equal(byFile.scanned, 3);
  assert.equal(
    urls[1],
    "https://lab.corp/api/v4/projects/golang%2Fappservice/repository/commits?ref_name=master&path=services%2Fgoods%2Ftb.go&since=2026-08-31T16%3A00%3A00.000Z&per_page=100",
  );
  // 不按词筛：只要 limit 个
  const recent = await host.searchCommits!("golang/appservice", { ref: "master", limit: 2 });
  assert.deepEqual(
    recent.commits.map((c) => c.sha.slice(0, 9)),
    ["4a677c0a4", "fd243a73d"],
  );
  assert.equal(recent.scanned, undefined);
  assert.equal(urls[2], "https://lab.corp/api/v4/projects/golang%2Fappservice/repository/commits?ref_name=master&per_page=2");
  // 提交搜索被关了：退回列出最近的提交再筛
  const fallbackUrls: string[] = [];
  const noSearch = createGitLabHost("https://lab.corp", "glpat-x", (async (url: string) => {
    fallbackUrls.push(url);
    return url.includes("/search?") ? new Response("{}", { status: 400 }) : new Response(JSON.stringify(commits), { status: 200 });
  }) as unknown as typeof fetch);
  const fellBack = await noSearch.searchCommits!("golang/appservice", { ref: "master", query: "半屏", limit: 10 });
  assert.deepEqual(
    fellBack.commits.map((c) => c.sha.slice(0, 9)),
    ["4a677c0a4"],
  );
  assert.equal(fellBack.scanned, 3);
  assert.equal(fallbackUrls[1], "https://lab.corp/api/v4/projects/golang%2Fappservice/repository/commits?ref_name=master&per_page=100");
  // 没开高级搜索时搜索接口把几个词当一句话找，搜不到；搜索出错（5xx）也一样：再列出最近的提交按词筛
  for (const search of [new Response("[]", { status: 200 }), new Response("{}", { status: 500 })]) {
    const phraseUrls: string[] = [];
    const phrase = createGitLabHost("https://lab.corp", "glpat-x", (async (url: string) => {
      phraseUrls.push(url);
      return url.includes("/search?") ? search : new Response(JSON.stringify(commits), { status: 200 });
    }) as unknown as typeof fetch);
    const words = await phrase.searchCommits!("golang/appservice", { ref: "master", query: "c.tb.cn 转链", limit: 10 });
    assert.deepEqual(
      words.commits.map((c) => c.sha.slice(0, 9)),
      ["4a677c0a4", "1bfb19b1a"],
    );
    assert.equal(words.scanned, 3);
    assert.equal(phraseUrls[1], "https://lab.corp/api/v4/projects/golang%2Fappservice/repository/commits?ref_name=master&per_page=100");
  }
  const missing = createGitLabHost("https://lab.corp", "glpat-x", (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch);
  await assert.rejects(missing.searchCommits!("golang/appservice", { ref: "nope", limit: 10 }), /GitLab 查提交历史失败（HTTP 404）：找不到项目或分支/);
});

test("GitHub 查提交历史：列出这个分支的提交再按说明筛", async () => {
  const urls: string[] = [];
  const fakeFetch = (async (url: string) => {
    urls.push(url);
    return new Response(
      JSON.stringify([
        {
          sha: "aaaaaaaa11111111111111111111111111111111",
          html_url: "https://github.com/o/r/commit/aaaaaaaa",
          commit: { message: "fix: retry on 429\n\ndetails", author: { name: "张三", date: "2026-10-01T00:00:00Z" }, committer: { date: "2026-10-10T00:00:00Z" } },
        },
        { sha: "bbbbbbbb22222222222222222222222222222222", commit: { message: "docs", author: { name: "李四", date: "2026-10-02T00:00:00Z" } } },
      ]),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const host = createGitHubHost("ghp_x", fakeFetch);
  assert.deepEqual(await host.searchCommits!("o/r", { ref: "main", query: "429", path: "src", limit: 10 }), {
    commits: [
      {
        sha: "aaaaaaaa11111111111111111111111111111111",
        title: "fix: retry on 429",
        message: "fix: retry on 429\n\ndetails",
        // 合进分支的时间，不是写的时间
        date: "2026-10-10T00:00:00Z",
        author: "张三",
        url: "https://github.com/o/r/commit/aaaaaaaa",
      },
    ],
    scanned: 2,
  });
  assert.equal(urls[0], "https://api.github.com/repos/o/r/commits?sha=main&path=src&per_page=100");
});

test("代码工具 code_log：查当前分支的提交历史，列出的提交号记作查到的；翻满了写明更早的没看", async () => {
  const { all } = branchWorkspaces();
  const queries: CommitQuery[] = [];
  let result: CommitSearch = {
    commits: [
      {
        sha: "4a677c0a4c1efcc3bc039fbbbb6c9aec029e0f37",
        title: "修复淘宝c.tb.cn短链落地半屏详情页导致转链失败的问题",
        date: "2026-10-10T09:03:01Z",
        author: "赵作武",
        url: "https://lab.corp/golang/appservice/-/commit/4a677c0a4",
      },
    ],
  };
  all.host.searchCommits = async (_repo, query) => {
    queries.push(query);
    return result;
  };
  const tools = Object.fromEntries(createCodeTools({ workspaces: all, threadKey: "om_log", botName: () => "飞书 CLI" }).map((t) => [t.spec.name, t]));
  assert.equal(tools.code_log.describe({ query: "c.tb.cn", path: "services/goods/tb.go" }), "查提交：c.tb.cn services/goods/tb.go");
  assert.equal(tools.code_log.describe({ branch: "aiops" }), "查提交：最近的提交（aiops 分支）");
  const facts: CodeFact[] = [];
  const text = await tools.code_log.run(
    { query: "c.tb.cn", path: "./services/goods/tb.go", since: "2026-10-01" },
    { signal, onFacts: (found) => facts.push(...found) },
  );
  assert.equal(
    text,
    "ai/aiops-mcp 的 main 分支上说明里有「c.tb.cn」、改过 services/goods/tb.go、2026-10-01 以后的提交，最近的 1 个，从新到旧：\n" +
      "- 4a677c0a 2026-10-10 赵作武「修复淘宝c.tb.cn短链落地半屏详情页导致转链失败的问题」 https://lab.corp/golang/appservice/-/commit/4a677c0a4",
  );
  // 只写日期的按北京时间当天 0 点
  assert.deepEqual(queries[0], { ref: "main", query: "c.tb.cn", path: "services/goods/tb.go", since: "2026-09-30T16:00:00.000Z", limit: 10 });
  assert.deepEqual(located(text, facts), [{ commit: "4a677c0a4c1efcc3bc039fbbbb6c9aec029e0f37", repo: "ai/aiops-mcp", line: "- 4a677c0a" }]);
  // 先列再筛、又翻满了：不能当成「没改过」
  result = { commits: [], scanned: 100 };
  assert.equal(
    await tools.code_log.run({ query: "topIds", branch: "aiops", limit: 99 }, { signal }),
    "ai/aiops-mcp 的 aiops 分支上说明里有「topIds」的提交一个都没找到（只翻了最近 100 个提交，更早的没看，可以加 since 或换个词再查）。",
  );
  assert.deepEqual(queries[1], { ref: "aiops", query: "topIds", path: undefined, since: undefined, limit: 30 });
  // 分支名和别的代码工具一样整理；没写时区的时间按北京时间
  await tools.code_log.run({ branch: "origin/aiops", since: "2026-10-10 09:00" }, { signal });
  assert.equal(queries[2].ref, "aiops");
  assert.equal(queries[2].since, "2026-10-10T01:00:00.000Z");
  await tools.code_log.run({ since: "2026-10-1" }, { signal });
  assert.equal(queries[3].since, "2026-09-30T16:00:00.000Z");
  await tools.code_log.run({ since: "2026-10-10T09:00:00Z" }, { signal });
  assert.equal(queries[4].since, "2026-10-10T09:00:00.000Z");
  await tools.code_log.run({ since: "2026/10/10" }, { signal });
  assert.equal(queries[5].since, "2026-10-09T16:00:00.000Z");
  await tools.code_log.run({ since: "2026-10-10T09:00:00.000" }, { signal });
  assert.equal(queries[6].since, "2026-10-10T01:00:00.000Z");
  // 提交时间按北京时间写日期：UTC 前一天 23 点是北京当天 7 点
  result = { commits: [{ sha: "aaaaaaaa11111111111111111111111111111111", title: "fix", date: "2026-10-09T23:00:00Z" }] };
  assert.match(await tools.code_log.run({ since: "2026-10-10" }, { signal }), /- aaaaaaaa 2026-10-10「fix」/);
  await assert.rejects(tools.code_log.run({ since: "上周" }, { signal }), /since 要写成 2026-10-01 这样的日期/);
  await assert.rejects(tools.code_log.run({ path: "../etc/passwd" }, { signal }), /路径要在仓库里面/);
  // 平台没有查提交的接口时直说
  const plain = Object.fromEntries(
    createCodeTools({ workspaces: branchWorkspaces().all, threadKey: "om_log2", botName: () => "飞书 CLI" }).map((t) => [t.spec.name, t]),
  );
  await assert.rejects(plain.code_log.run({}, { signal }), /Fake 还不支持查提交历史/);
});

test("读代码只要了一小段：扩到所在的整个函数，同一个函数里后面的分支也给出来", () => {
  // 2026-10-10 转链排查：只读了重定向失败就 return 的那几行，修复在同一个函数往下几行
  const go = [
    "package goods", // 1
    "", // 2
    "func (t *TaoBao) Other() {", // 3
    "}", // 4
    "", // 5
    "func (t *TaoBao) GetGoodIdAndOriginUrl(c *gin.Context) (goodsId string, err error) {", // 6
    "\tstr, err = common.GetGetContentUrlByCache(request.Content)", // 7
    "\tif err != nil {", // 8
    "\t\treturn", // 9
    "\t}", // 10
    "\tif id := common.ParseTbHalfDetailItemId(str); id != \"\" {", // 11
    "\t\treturn id, nil", // 12
    "\t}", // 13
    "\treturn", // 14
    "}", // 15
    "", // 16
    "type X struct {", // 17
    "\tA int", // 18
    "}", // 19
  ];
  assert.deepEqual(enclosingFunction(go, 7, 9, "services/goods/tb.go"), { start: 6, end: 15, name: "GetGoodIdAndOriginUrl" });
  // 跨了两个函数、不在函数里、函数太长：照要的给
  assert.equal(enclosingFunction(go, 4, 7, "services/goods/tb.go"), undefined);
  assert.equal(enclosingFunction(go, 18, 18, "services/goods/tb.go"), undefined);
  // 一行写完的函数下面的几行（var 块）不在它里面
  const oneLine = ["package x", "func (x X) Len() int { return len(x) }", "", "var m = map[string]int{", '\t"a": 1,', "}"];
  assert.equal(enclosingFunction(oneLine, 5, 5, "x.go"), undefined);
  // 行尾注释里的大括号不算一行写完
  const routed = ["func Handle(w http.ResponseWriter, r *http.Request) { // GET /items/{id}", "\tid := r.PathValue(\"id\")", "\t_ = id", "}"];
  assert.deepEqual(enclosingFunction(routed, 2, 2, "x.go"), { start: 1, end: 4, name: "Handle" });
  const long = ["func Long() {", ...Array.from({ length: 300 }, () => "\tx++"), "}"];
  assert.equal(enclosingFunction(long, 10, 12, "a.go"), undefined);
  // PHP：认 function 关键字，往下数大括号，字符串里的括号不算
  const php = [
    "<?php", // 1
    "class Order {", // 2
    "    public static function convert($url) {", // 3
    "        $a = \"{\";", // 4
    "        if ($url) {", // 5
    "            return 1;", // 6
    "        }", // 7
    "        return 0;", // 8
    "    }", // 9
    "}", // 10
  ];
  assert.deepEqual(enclosingFunction(php, 5, 6, "app/Order.php"), { start: 3, end: 9, name: "convert" });
  assert.equal(enclosingFunction(php, 5, 6, "notes.md"), undefined);
  // 没闭合的字符串里一长串反斜杠：去引号的正则不能回溯到卡死
  const slashes = ["function f() {", `  $s = "${"\\".repeat(5000)}`, "}"];
  const started = Date.now();
  assert.deepEqual(enclosingFunction(slashes, 2, 2, "a.php"), { start: 1, end: 3, name: "f" });
  assert.ok(Date.now() - started < 1000);

  const out = numberedLines(new ToolOutputBuilder("golang/appservice"), "services/goods/tb.go", go.join("\n"), 7, 9);
  assert.match(out.text, /^services\/goods\/tb\.go（共 19 行，下面是第 6 到 15 行：要的是第 7 到 9 行，扩到了所在的整个函数 GetGoodIdAndOriginUrl，要看后面用 start_line=16）\n6\| func/);
  assert.match(out.text, /\n11\| \tif id := common\.ParseTbHalfDetailItemId/);
  // 没给止行（从某行往后读）：照旧
  assert.match(numberedLines(new ToolOutputBuilder("golang/appservice"), "services/goods/tb.go", go.join("\n"), 7, undefined).text, /下面是第 7 到 19 行）/);
  // 函数不到 250 行但一次给不完（行很长）：不扩，照要的给，不能从函数头开始给到一半就截断、要的几行反而没给
  const wide = ["func Wide() {", ...Array.from({ length: 100 }, (_, i) => `\tx${i} := "${"y".repeat(300)}"`), "}"];
  assert.deepEqual(enclosingFunction(wide, 90, 92, "a.go"), { start: 1, end: 102, name: "Wide" });
  const narrow = numberedLines(new ToolOutputBuilder("acme/demo"), "a.go", wide.join("\n"), 90, 92);
  assert.match(narrow.text, /^a\.go（共 102 行，下面是第 90 到 92 行，要看后面用 start_line=93）\n90\| \tx88 /);
  // 超过一次能读的 1.5 万字（工具结果交给模型前截到 1.6 万字）：也不扩，扩了后半段会被截掉
  const mid = ["func Mid() {", ...Array.from({ length: 100 }, (_, i) => `\tx${i} := "${"y".repeat(150)}"`), "}"];
  assert.ok(mid.join("\n").length > 15_000 && mid.join("\n").length < 20_000);
  assert.match(numberedLines(new ToolOutputBuilder("acme/demo"), "a.go", mid.join("\n"), 90, 92).text, /下面是第 90 到 92 行，/);
});

test("搬改动时被打断（比如重启）：下次打开先退回原来的分支，搬了一半的新分支删掉", async () => {
  const { all } = portWorkspaces();
  const ws = await all.open("om_p13", portRepo);
  await ws.editFile("a.go", "return 1", "return 13");
  await ws.openPullRequest("A 返回 13", "", { branch: "fix/thirteen" });
  // 停在搬了一半的分支上：检出了 uat，改动只应用了一部分
  await runGit(["fetch", "-q", "--depth", "1", "origin", "+refs/heads/uat:refs/remotes/origin/uat"], { cwd: ws.dir });
  await runGit(["checkout", "-q", "-B", "fix/thirteen-uat", "refs/remotes/origin/uat"], { cwd: ws.dir });
  await writeFile(path.join(ws.dir, "a.go"), "half\n");
  const stateFile = path.join(ws.dir, ".git", ".agenttag.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  await writeFile(stateFile, JSON.stringify({ ...state, porting: { back: "fix/thirteen", branch: "fix/thirteen-uat" } }));

  const again = await all.open("om_p13", portRepo);
  assert.equal(again.baseBranch, "main");
  assert.equal((await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: ws.dir })).stdout.trim(), "fix/thirteen");
  assert.match((await again.readFile("a.go")).text, /return 13/);
  assert.equal((await runGit(["branch", "--list", "fix/thirteen-uat"], { cwd: ws.dir })).stdout.trim(), "");
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).porting, undefined);
  // 接着搬：照常开到 uat
  assert.deepEqual(brief(await again.openPullRequest("A 返回 13（uat）", "", { target: "uat" })), [true, 2, "fix/thirteen-uat", "uat"]);
});

test("之前开的合并请求合并了或关掉了：新改动另开一个，不再推到那个分支；切回那边时也从最新的代码开始", async () => {
  // 单独一个远端：要真的把合并请求合进 main
  const finishedRemote = path.join(tmp, "finished.git");
  await runGit(["clone", "-q", "--bare", portRemote, finishedRemote]);
  const states: Record<number, RequestState> = {};
  const { all } = portWorkspaces({
    cloneUrl: () => `file://${finishedRemote}`,
    async getRequest(_repo, number) {
      const state = states[number] ?? "opened";
      return { number, title: "", url: `https://example.com/pr/${number}`, state, source: "", target: "", baseSha: "", headSha: "" };
    },
  });
  const log = async (ref: string) => (await runGit(["log", "--format=%s", ref], { cwd: finishedRemote })).stdout.trim().split("\n");
  const show = async (ref: string, file: string) => (await runGit(["show", `${ref}:${file}`], { cwd: finishedRemote })).stdout;

  // 合并了：新改动从 main 最新的代码另开一个，只带新改动；合过的分支不再往上推，本地也删掉
  const ws = await all.open("om_f1", portRepo);
  await ws.editFile("a.go", "return 1", "return 2");
  await ws.openPullRequest("A 返回 2", "", { branch: "fix/merged" });
  await runGit(["push", "-q", "origin", "fix/merged:main"], { cwd: ws.dir });
  states[1] = "merged";
  await ws.editFile("a.go", "return 2", "return 3");
  const next = await ws.openPullRequest("A 返回 3", "");
  assert.deepEqual(brief(next).slice(0, 2), [true, 2]);
  assert.equal(next.base, "main");
  assert.match(next.branch, /^agenttag\/20261015-[0-9a-f]{6}$/);
  assert.deepEqual(next.replaced, { number: 1, state: "merged" });
  assert.deepEqual(await log(next.branch), ["A 返回 3", "A 返回 2", "init"]);
  assert.deepEqual(await log("fix/merged"), ["A 返回 2", "init"]);
  assert.equal(ws.pullRequest?.number, 2);
  assert.deepEqual(ws.earlier, []);
  assert.equal((await runGit(["branch", "--list", "fix/merged"], { cwd: ws.dir })).stdout.trim(), "");

  // 关掉了（没合并）：之前那份没进 main，连同新改动整份另开一个
  const tools = Object.fromEntries(createCodeTools({ workspaces: all, threadKey: "om_f2", botName: () => "飞书 CLI" }).map((t) => [t.spec.name, t]));
  await tools.code_edit_file.run({ path: "b.txt", old_text: "three", new_text: "3" }, { signal });
  await tools.code_open_pr.run({ title: "b 改 3", body: "", branch: "fix/closed" }, { signal });
  states[3] = "closed";
  await tools.code_edit_file.run({ path: "b.txt", old_text: "one", new_text: "1" }, { signal });
  const reopened = (await tools.code_open_pr.run({ title: "b 改 1 和 3", body: "" }, { signal })).split("\n")[0];
  assert.match(
    reopened,
    /^这个话题之前开的合并请求 !3 已经关掉了（没合并），它的改动连同新改动从 main 最新的代码另开了合并请求 !4（(agenttag\/20261015-[0-9a-f]{6}) → main）：https:\/\/example.com\/pr\/4$/,
  );
  const reopenedBranch = /（(\S+) → main）/.exec(reopened)![1];
  assert.equal(await show(reopenedBranch, "b.txt"), "1\ntwo\n3\n");
  assert.deepEqual(await log(reopenedBranch), ["b 改 1 和 3", "A 返回 2", "init"]);
  assert.deepEqual(await log("fix/closed"), ["b 改 3", "A 返回 2", "init"]);

  // 开到 uat 以后，main 上那个合并了：切回 main 不接着用它，从 main 最新的代码开始；uat 上那个照旧放着
  const ws3 = await all.open("om_f3", portRepo);
  await ws3.editFile("c.txt", undefined, "c\n");
  await ws3.openPullRequest("加 c", "", { branch: "fix/c" });
  assert.equal((await ws3.openPullRequest("加 c（uat）", "", { target: "uat" })).number, 6);
  states[5] = "merged";
  const back = await ws3.switchBranch("main");
  assert.match(
    back.text,
    /^之前在 main 上开的合并请求 !5 已经合并了，不再往上推。这次从 main 最新的代码开始，新改动会另开合并请求。已切到 main 分支，最新提交 [0-9a-f]{7} .*之前在 uat 上开的合并请求 !6 不受影响，切回 uat 会接着用它。$/,
  );
  assert.equal(ws3.baseBranch, "main");
  assert.equal(ws3.pullRequest, undefined);
  assert.deepEqual(ws3.earlier.map((c) => [c.base, c.branch, c.prNumber]), [["uat", "fix/c-uat", 6]]);
  // 放着的分支在本地找不到了：也不从远端拉同名分支，从 uat 最新的代码开始
  await runGit(["branch", "-q", "-D", "fix/c-uat"], { cwd: ws3.dir });
  const lost = await ws3.switchBranch("uat");
  assert.match(lost.text, /^之前在 uat 上开的合并请求 !6 在工作目录里找不到了，不再往上推。这次从 uat 最新的代码开始，新改动会另开合并请求。已切到 uat 分支/);
  assert.equal(ws3.pullRequest, undefined);
  assert.deepEqual(ws3.earlier, []);
});

test("切分支时被打断（检出了别的分支，状态还没记下）：下次打开退回机器人的分支；本地连分支都没了就从最新的代码开始", async () => {
  const { all } = portWorkspaces();
  const ws = await all.open("om_p14", portRepo);
  await ws.editFile("a.go", "return 1", "return 14");
  await ws.openPullRequest("A 返回 14", "", { branch: "fix/fourteen" });
  const head = async () => (await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: ws.dir })).stdout.trim();
  await runGit(["fetch", "-q", "--depth", "1", "origin", "+refs/heads/uat:refs/remotes/origin/uat"], { cwd: ws.dir });
  await runGit(["checkout", "-q", "-B", "uat", "refs/remotes/origin/uat"], { cwd: ws.dir });

  const again = await all.open("om_p14", portRepo);
  assert.equal(await head(), "fix/fourteen");
  assert.equal(again.baseBranch, "main");
  assert.equal(again.pullRequest?.number, 1);
  assert.match((await again.readFile("a.go")).text, /return 14/);

  // 机器人的分支在本地没了：不从远端拉同名分支（可能已经不是机器人的了），当成还没改过
  await runGit(["checkout", "-q", "-B", "uat", "refs/remotes/origin/uat"], { cwd: ws.dir });
  await runGit(["branch", "-q", "-D", "fix/fourteen"], { cwd: ws.dir });
  const third = await all.open("om_p14", portRepo);
  assert.equal(await head(), "main");
  assert.equal(third.baseBranch, "main");
  assert.equal(third.pullRequest, undefined);
  assert.match((await third.readFile("a.go")).text, /return 1$/m);
});

test("不能借仓库里的符号链接读写 .git；状态文件里不对的分支名、提交号整个不认", async () => {
  const evilRemote = path.join(tmp, "evil.git");
  const evilSeed = path.join(tmp, "evil-seed");
  await runGit(["init", "-q", "--bare", "-b", "main", evilRemote]);
  await runGit(["clone", "-q", evilRemote, evilSeed]);
  await writeFile(path.join(evilSeed, "a.txt"), "a\n");
  await symlink(".git", path.join(evilSeed, "evil"));
  await symlink(".git/config", path.join(evilSeed, "conf"));
  await runGit(["add", "-A"], { cwd: evilSeed });
  await runGit(["commit", "-q", "-m", "init"], { cwd: evilSeed, env: author });
  await runGit(["push", "-q", "origin", "main"], { cwd: evilSeed });
  const { host } = fakeHost();
  host.cloneUrl = () => `file://${evilRemote}`;
  const all = new CodeWorkspaces({ root: path.join(tmp, `ws${rootCount++}`), host, repos: ["acme/evil"], logger: quiet });
  const ws = await all.open("om_e1", "acme/evil");
  for (const file of ["evil", "evil/config", "evil/.agenttag.json", "conf"]) {
    await assert.rejects(ws.readFile(file), /不能读写 \.git 目录/, file);
  }
  for (const file of ["evil/config", "evil/.agenttag.json", "evil/hooks/pre-commit", "evil/new/x", "conf"]) {
    await assert.rejects(ws.editFile(file, undefined, "x"), /不能读写 \.git 目录/, file);
  }
  assert.match((await ws.readFile("a.txt")).text, /a/);

  const stateFile = path.join(ws.dir, ".git", ".agenttag.json");
  const sha = "a".repeat(40);
  for (const bad of [
    { base: "--upload-pack=touch x", branch: "fix/x" },
    { branch: "main;rm -rf", pushedSha: sha },
    { branch: "fix/ok", pushedSha: "HEAD" },
    { earlier: "x" },
    { earlier: [{ base: "main", branch: "../x", pushedSha: sha }] },
    { porting: { back: "-f", branch: "fix/ok" } },
    null,
  ]) {
    await writeFile(stateFile, JSON.stringify(bad));
    const again = await all.open("om_e1", "acme/evil");
    assert.equal(again.baseBranch, "main", JSON.stringify(bad));
    assert.equal(again.pullRequest, undefined);
    assert.deepEqual(again.earlier, []);
  }
});

test("GitLab 合并前核对：读合并请求、机器人自己的账号（查一次记下）、要合到的分支受不受保护", async () => {
  const calls: string[] = [];
  const mr = (extra: object) => ({
    iid: 354,
    title: "fix(jd): 3.jd.hk",
    web_url: "https://lab.corp/golang/appservice/-/merge_requests/354",
    state: "opened",
    source_branch: "fix/jd_uat",
    target_branch: "uat",
    author: { name: "agent-boot", username: "agent-boot" },
    sha: "c".repeat(40),
    source_project_id: 5,
    target_project_id: 5,
    ...extra,
  });
  const responses: Response[] = [
    new Response(JSON.stringify(mr({})), { status: 200 }),
    new Response("{}", { status: 401 }),
    new Response(JSON.stringify(mr({})), { status: 200 }),
    new Response(JSON.stringify({ username: "agent-boot" }), { status: 200 }),
    new Response(JSON.stringify({ name: "uat", protected: false, default: false }), { status: 200 }),
    new Response(JSON.stringify(mr({ target_branch: "release/1.0", author: { name: "张三", username: "zhangsan" }, source_project_id: 9 })), { status: 200 }),
    new Response(JSON.stringify({ name: "release/1.0", protected: true, default: false, developers_can_merge: true }), { status: 200 }),
    new Response(JSON.stringify(mr({ target_branch: "gone" })), { status: 200 }),
    new Response("{}", { status: 404 }),
  ];
  const fakeFetch = (async (url: string) => {
    calls.push(url);
    return responses.shift()!;
  }) as unknown as typeof fetch;
  const host = createGitLabHost("https://lab.corp", "glpat-x", fakeFetch);
  await assert.rejects(host.mergeCheck!("golang/appservice", 354), /查不到机器人自己的 GitLab 账号（HTTP 401），先不合并/);
  const uat = await host.mergeCheck!("golang/appservice", 354);
  assert.deepEqual(
    [uat.state, uat.source, uat.target, uat.sha, uat.authorUsername, uat.botUsername, uat.fromFork, uat.targetProtected, uat.targetIsDefault],
    ["opened", "fix/jd_uat", "uat", "c".repeat(40), "agent-boot", "agent-boot", undefined, false, false],
  );
  // 账号查到了就记下，不再查
  const release = await host.mergeCheck!("golang/appservice", 354);
  assert.deepEqual(
    [release.authorUsername, release.botUsername, release.fromFork, release.targetProtected, release.targetDevelopersCanMerge],
    ["zhangsan", "agent-boot", true, true, true],
  );
  assert.equal(uat.targetDevelopersCanMerge, undefined);
  await assert.rejects(host.mergeCheck!("golang/appservice", 354), /!354 要合到的 gone 分支不存在了/);
  assert.deepEqual(calls, [
    "https://lab.corp/api/v4/projects/golang%2Fappservice/merge_requests/354",
    "https://lab.corp/api/v4/user",
    "https://lab.corp/api/v4/projects/golang%2Fappservice/merge_requests/354",
    "https://lab.corp/api/v4/user",
    "https://lab.corp/api/v4/projects/golang%2Fappservice/repository/branches/uat",
    "https://lab.corp/api/v4/projects/golang%2Fappservice/merge_requests/354",
    "https://lab.corp/api/v4/projects/golang%2Fappservice/repository/branches/release%2F1.0",
    "https://lab.corp/api/v4/projects/golang%2Fappservice/merge_requests/354",
    "https://lab.corp/api/v4/projects/golang%2Fappservice/repository/branches/gone",
  ]);
});

test("GitLab 合并：等它算完能不能合再合，带上核对过的提交；要等流水线的设成自动合并，有冲突的不合", async () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const url = "https://lab.corp/golang/appservice/-/merge_requests/354";
  const responses: Response[] = [];
  const status = (s: string) => new Response(JSON.stringify({ iid: 354, state: "opened", web_url: url, target_branch: "uat", detailed_merge_status: s }), { status: 200 });
  const fakeFetch = (async (u: string, init?: RequestInit) => {
    calls.push({ url: u, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return responses.shift()!;
  }) as unknown as typeof fetch;
  const naps: number[] = [];
  const host = createGitLabHost("https://lab.corp", "glpat-x", fakeFetch, async (ms) => {
    naps.push(ms);
  });
  const sha = "c".repeat(40);
  responses.push(status("checking"), status("mergeable"), new Response(JSON.stringify({ iid: 354, state: "merged", web_url: url }), { status: 200 }));
  assert.deepEqual(await host.mergeRequest!("golang/appservice", 354, { sha, target: "uat" }), { state: "merged", url });
  assert.deepEqual(naps, [2000]);
  assert.deepEqual(calls.at(-1), { url: "https://lab.corp/api/v4/projects/golang%2Fappservice/merge_requests/354/merge", method: "PUT", body: { sha } });
  // 老版本只有 merge_status
  responses.push(
    new Response(JSON.stringify({ iid: 354, state: "opened", target_branch: "uat", merge_status: "can_be_merged" }), { status: 200 }),
    new Response(JSON.stringify({ iid: 354, state: "merged", web_url: url }), { status: 200 }),
  );
  assert.equal((await host.mergeRequest!("golang/appservice", 354, { sha, target: "uat" })).state, "merged");
  responses.push(status("ci_must_pass"), new Response(JSON.stringify({ iid: 354, state: "opened", web_url: url, merge_when_pipeline_succeeds: true }), { status: 200 }));
  assert.deepEqual(await host.mergeRequest!("golang/appservice", 354, { sha, target: "uat" }), { state: "auto", url });
  assert.deepEqual(calls.at(-1)?.body, { sha, auto_merge: true, merge_when_pipeline_succeeds: true });
  const before = calls.length;
  responses.push(status("conflict"));
  await assert.rejects(host.mergeRequest!("golang/appservice", 354, { sha, target: "uat" }), /^RepoError: !354 现在合不了：和要合到的分支有冲突，要先解决冲突/);
  responses.push(status("status_checks_must_pass"));
  await assert.rejects(host.mergeRequest!("golang/appservice", 354, { sha, target: "uat" }), /外部检查还没通过/);
  // 核对以后有人把合并请求改成开到 master：不合
  responses.push(new Response(JSON.stringify({ iid: 354, state: "opened", target_branch: "master", detailed_merge_status: "mergeable" }), { status: 200 }));
  await assert.rejects(host.mergeRequest!("golang/appservice", 354, { sha, target: "uat" }), /!354 要合到的分支改成了 master（核对时是 uat），机器人不合/);
  responses.push(status("draft_status"));
  await assert.rejects(host.mergeRequest!("golang/appservice", 354, { sha, target: "uat" }), /还是草稿/);
  // 合不了的没有去合
  assert.ok(calls.slice(before).every((c) => c.method === "GET"));
  responses.push(status("mergeable"), new Response(JSON.stringify({ message: "Branch cannot be merged" }), { status: 405 }));
  await assert.rejects(host.mergeRequest!("golang/appservice", 354, { sha, target: "uat" }), /GitLab 合并 !354 失败（HTTP 405）：GitLab 说现在不能合.*Branch cannot be merged/);
  responses.push(status("mergeable"), new Response(JSON.stringify({ message: "SHA does not match HEAD of source branch" }), { status: 409 }));
  await assert.rejects(host.mergeRequest!("golang/appservice", 354, { sha, target: "uat" }), /HTTP 409）：源分支刚有新的提交，和核对过的不一样，没合/);
  responses.push(status("mergeable"), new Response("{}", { status: 403 }));
  await assert.rejects(host.mergeRequest!("golang/appservice", 354, { sha, target: "uat" }), /HTTP 403）：机器人的账号没有权限合到这个分支/);
  // 一直在算：看够次数就去合，由 GitLab 决定
  naps.length = 0;
  responses.push(...Array.from({ length: 6 }, () => status("checking")), new Response(JSON.stringify({ iid: 354, state: "merged", web_url: url }), { status: 200 }));
  assert.equal((await host.mergeRequest!("golang/appservice", 354, { sha, target: "uat" })).state, "merged");
  assert.equal(naps.length, 5);
});

test("合并合并请求：只合这个话题自己开的、源分支还是机器人推的那个提交、开到允许开发者合并的分支的；其余都不合", async () => {
  const checks: Record<number, MergeCheck> = {};
  const merged: { number: number; sha: string; target: string }[] = [];
  let result: MergeResult = { state: "merged", url: "https://example.com/pr/1" };
  const { host } = fakeHost();
  Object.assign(host, {
    mergeCheck: async (_repo: string, number: number) => checks[number] ?? Promise.reject(new RepoError(`没有 !${number}`)),
    mergeRequest: async (_repo: string, number: number, options: { sha: string; target: string }) => {
      merged.push({ number, ...options });
      return result;
    },
  });
  const ws = await workspaces(host).open("om_m1", "acme/demo");
  await ws.editFile("README.md", "# demo", "# demo 2");
  const pr = await ws.openPullRequest("改说明", "");
  const sha = (await runGit(["rev-parse", `refs/heads/${pr.branch}`], { cwd: remote })).stdout.trim();
  const base: MergeCheck = {
    number: 1,
    title: "改说明",
    url: "https://example.com/pr/1",
    state: "opened",
    source: pr.branch,
    target: "uat",
    author: "agent-boot",
    authorUsername: "agent-boot",
    botUsername: "Agent-Boot",
    sha,
    targetProtected: false,
    targetIsDefault: false,
  };
  checks[1] = base;
  const out = await ws.mergeRequest(1);
  assert.equal(out.text, `已合并合并请求 !1「改说明」（${pr.branch} → uat），改动进了 uat 分支：https://example.com/pr/1`);
  assert.deepEqual(out.facts.map(({ at: _, ...fact }) => fact), [
    { repo: "acme/demo", branch: pr.branch },
    { repo: "acme/demo", branch: "uat" },
  ]);
  assert.deepEqual(merged, [{ number: 1, sha, target: "uat" }]);
  result = { state: "auto", url: "https://example.com/pr/1" };
  assert.match((await ws.mergeRequest(1)).text, /^!1「改说明」（.+ → uat）要等流水线跑完才能合，已设成流水线通过后自动合并/);
  // 受保护、但 GitLab 上允许开发者合并的（uat 常这样设）：能合
  result = { state: "merged", url: "https://example.com/pr/1" };
  checks[1] = { ...base, targetProtected: true, targetDevelopersCanMerge: true };
  assert.match((await ws.mergeRequest(1)).text, /^已合并合并请求 !1/);
  merged.length = 0;
  checks[1] = { ...base, state: "merged" };
  assert.match((await ws.mergeRequest(1)).text, /^!1「改说明」（.+ → uat）已经合并过了/);
  merged.length = 0;
  checks[9] = { ...base, number: 9 };
  for (const [number, bad, message] of [
    [1, { targetProtected: true, target: "prod" }, /^RepoError: !1 要合到的 prod 是受保护的分支，只许维护者合并，合并要人审过再点，机器人不合/],
    [1, { targetProtected: true, targetDevelopersCanMerge: false, target: "prod" }, /是受保护的分支，只许维护者合并/],
    // 允许开发者合并，但是默认分支：也不合
    [1, { targetProtected: true, targetDevelopersCanMerge: true, targetIsDefault: true, target: "master" }, /^RepoError: !1 要合到的 master 是仓库的默认分支/],
    [1, { targetIsDefault: true, target: "main" }, /^RepoError: !1 要合到的 main 是仓库的默认分支，合并要人审过再点/],
    [1, { author: "张三", authorUsername: "zhangsan" }, /^RepoError: !1 是 张三 开的，机器人只合并自己开的合并请求/],
    [1, { authorUsername: undefined }, /机器人只合并自己开的合并请求/],
    [1, { fromFork: true }, /是从别的项目（fork）提过来的，机器人不合/],
    [1, { state: "closed" }, /!1 已经关掉了（没合并），合不了/],
    // 别人后来往机器人的分支上推了提交
    [1, { sha: "d".repeat(40) }, /^RepoError: !1 的源分支上有机器人没推过的提交/],
    // 别的话题开的
    [9, {}, /^RepoError: !9 不是这个话题里开的，机器人只合并当前话题里自己开的合并请求/],
  ] as const) {
    checks[number] = { ...base, number, ...bad };
    await assert.rejects(ws.mergeRequest(number), message, JSON.stringify(bad));
  }
  assert.deepEqual(merged, []);
  // 平台不支持合并
  const plain = await workspaces(fakeHost().host).open("om_m2", "acme/demo");
  await assert.rejects(plain.mergeRequest(1), /Fake 上机器人还不能合并合并请求，请人来点/);
});

test("合并从别的合并请求搬过来的：那个不是这个话题里开的就不合，再搬一次也记着", async () => {
  await runGit(["checkout", "-q", "-b", "fix/merge-src", "main"], { cwd: portSeed });
  await writeFile(path.join(portSeed, "a.go"), "package a\n\nfunc A() int {\n\treturn 8\n}\n");
  await runGit(["commit", "-q", "-am", "A 返回 8"], { cwd: portSeed, env: author });
  await runGit(["push", "-q", "origin", "fix/merge-src"], { cwd: portSeed });
  const headSha = (await runGit(["rev-parse", "HEAD"], { cwd: portSeed })).stdout.trim();
  const baseSha = (await runGit(["rev-parse", "main"], { cwd: portSeed })).stdout.trim();
  await runGit(["checkout", "-q", "uat"], { cwd: portSeed });
  const source: RequestDetail = { number: 40, title: "A 返回 8", url: "https://example.com/pr/40", state: "opened", source: "fix/merge-src", target: "main", baseSha, headSha };
  const checks: Record<number, MergeCheck> = {};
  const merged: number[] = [];
  const { all } = portWorkspaces({
    getRequest: async () => source,
    mergeCheck: async (_repo: string, number: number) => checks[number],
    mergeRequest: async (_repo: string, number: number) => {
      merged.push(number);
      return { state: "merged", url: "" };
    },
  });
  const ws = await all.open("om_m5", portRepo);
  const pr = await ws.openPullRequest("A 返回 8（uat）", "", { from: 40, target: "uat" });
  const sha = (await runGit(["rev-parse", `refs/heads/${pr.branch}`], { cwd: portRemote })).stdout.trim();
  const mine: MergeCheck = { ...source, number: pr.number, url: "", source: pr.branch, target: "uat", authorUsername: "agent-boot", botUsername: "agent-boot", sha, targetProtected: false, targetIsDefault: false };
  checks[pr.number] = mine;
  checks[40] = { ...mine, number: 40, author: "张三", authorUsername: "zhangsan" };
  await assert.rejects(ws.mergeRequest(pr.number), /^RepoError: !1 的改动是从 !40 搬过来的，那个不是这个话题里开的/);
  // 下次打开（状态从文件读回来）也记得是搬过来的
  await assert.rejects((await all.open("om_m5", portRepo)).mergeRequest(pr.number), /是从 !40 搬过来的/);
  // 再搬到别的分支（test）也记着是从 !40 搬来的
  await runGit(["push", "-q", "origin", "uat:test"], { cwd: portSeed });
  const again = await ws.openPullRequest("A 返回 8（test）", "", { target: "test" });
  const againSha = (await runGit(["rev-parse", `refs/heads/${again.branch}`], { cwd: portRemote })).stdout.trim();
  checks[again.number] = { ...mine, number: again.number, source: again.branch, target: "test", sha: againSha };
  await assert.rejects(ws.mergeRequest(again.number), /是从 !40 搬过来的/);
  // !40 是机器人开的，但不是这个话题开的：看不到它是不是又从别人的合并请求搬来的，也不合
  checks[40] = { ...mine, number: 40 };
  await assert.rejects(ws.mergeRequest(pr.number), /^RepoError: !1 的改动是从 !40 搬过来的，那个不是这个话题里开的，机器人查不清是谁写的，不合/);
  assert.deepEqual(merged, []);
  await runGit(["push", "-q", "origin", "--delete", "test"], { cwd: portSeed });
});

test("代码工具：平台能合并时才有 code_merge，要写权限，编号认 !354", async () => {
  const { host } = fakeHost();
  const plainTools = createCodeTools({ workspaces: workspaces(host), threadKey: "om_m3", botName: () => "飞书 CLI" }).map((t) => t.spec.name);
  assert.ok(!plainTools.includes("code_merge"));
  assert.match(
    createCodeTools({ workspaces: workspaces(host), threadKey: "om_m3", botName: () => "飞书 CLI" }).find((t) => t.spec.name === "code_open_pr")!.spec.description,
    /机器人不会合并（「合并到 uat」就是开一个到 uat 的合并请求，合并要人来点）/,
  );
  const asked: number[] = [];
  Object.assign(host, {
    mergeCheck: async (_repo: string, number: number) => {
      asked.push(number);
      throw new RepoError(`没有 !${number} 这个合并请求`);
    },
    mergeRequest: async () => ({ state: "merged", url: "" }),
  });
  const tools = Object.fromEntries(createCodeTools({ workspaces: workspaces(host), threadKey: "om_m4", botName: () => "飞书 CLI" }).map((t) => [t.spec.name, t]));
  assert.ok(tools.code_merge.writes);
  assert.match(tools.code_open_pr.spec.description, /群成员要合并（「合并到 uat」）时，开好以后再用 code_merge 合/);
  assert.equal(tools.code_merge.describe({ number: "!354" }), "合并合并请求 !354");
  assert.equal(tools.code_merge.describe({}), "合并合并请求");
  await assert.rejects(tools.code_merge.run({ number: "!354" }, { signal }), /没有 !354 这个合并请求/);
  await assert.rejects(tools.code_merge.run({}, { signal }), /缺少 number 参数/);
  await assert.rejects(tools.code_merge.run({ number: "abc" }, { signal }), /number 要填合并请求的编号/);
  assert.deepEqual(asked, [354]);
});
