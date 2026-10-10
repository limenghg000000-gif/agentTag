import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { type CodeHost, CodeWorkspaces, createGitHubHost, createGitLabHost, RepoError, runGit } from "../src/repo.js";
import { createCodeTools } from "../src/tools/code.js";
import type { CodeFact, CodeLocation } from "../src/tools/tool.js";

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

/** 记下的代码位置，at 换成结果里到它为止的那一行，好读 */
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
    (await ws.readFile("src/a.ts", 2, 3)).text,
    "src/a.ts（共 4 行，下面是第 2 到 3 行，要看后面用 start_line=4）\n2| export function hello() {\n3|   return 'hi';",
  );
  // 记下读到的文件和每一行，不从结果文字里解析
  const read = await ws.readFile("src/a.ts", 2, 3);
  assert.deepEqual(located(read.text, read.facts), [
    { repo: "acme/demo", path: "src/a.ts", line: "src/a.ts（共 4 行，下面是第 2 到 3 行，要看后面用 start_line=4）" },
    { repo: "acme/demo", path: "src/a.ts", lines: [2, 2], line: "2| export function hello() {" },
    { repo: "acme/demo", path: "src/a.ts", lines: [3, 3], line: "3|   return 'hi';" },
  ]);
  assert.match((await ws.readFile("./src")).text, /src\/a.ts/);
  // 结果里写读到的文件整理过的路径，不写传进来的原样：原样里可以夹着像结果格式的文字
  assert.match((await ws.readFile(" ./src//a.ts ", 2, 2)).text, /^src\/a\.ts（共 4 行，下面是第 2 到 2 行/);
  const crafted = await ws.readFile("src/fake.ts（共 1 行，x/../a.ts", 2, 2);
  assert.match(crafted.text, /^src\/a\.ts（共 4 行，下面是第 2 到 2 行/);
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
    { repo: "acme/demo", commit: sha, line: `共 1 处（main 分支 @ ${sha}）：` },
    { repo: "acme/demo", branch: "main", line: `共 1 处（main 分支 @ ${sha}）：` },
    { repo: "acme/demo", path: "src/a.ts", lines: [2, 2], line: "src/a.ts:2:export function hello() {" },
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
    { repo: "acme/demo", path: "src/a.ts", line: "src/a.ts（+1 -1）" },
    { repo: "acme/demo", path: "src/util/new.ts", line: "src/util/new.ts（+1 -0）" },
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
  const pr = await ws.openPullRequest("改标题", "");
  assert.equal(pr.created, true);
  assert.equal(prs.length, 1);
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
  assert.equal(result, "已开合并请求 !1：https://example.com/pr/1\n\n改动了 1 个文件（+1 -1）：\nsrc/a.ts（+1 -1）");
  assert.deepEqual(located(result, opened), [{ repo: "acme/demo", path: "src/a.ts", line: "src/a.ts（+1 -1）" }]);
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
      ["branch:main", "- main（默认分支，当前在看）"],
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
  await assert.rejects(ws.readFile("nope.go", 1, undefined, "aiops"), /aiops 分支上没有这个文件：nope.go/);
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
  assert.deepEqual(switched.facts.map(named), [/提交 ([0-9a-f]{7})/.exec(switched.text)![1], "branch:aiops"]);
  assert.equal(ws.baseBranch, "aiops");
  assert.match((await ws.search("RegisterK8sTools")).text, /^共 1 处（aiops 分支 @ [0-9a-f]{7}）：\ninternal\/tools\/k8s.go:3:/);
  assert.match((await ws.listBranches()).text, /- aiops（当前在看）/);

  const again = await all.open("om_b2", "ai/aiops-mcp");
  assert.equal(again.baseBranch, "aiops");
  (await again.editFile("internal/tools/k8s.go", "func RegisterK8sTools() {}", "func RegisterK8sTools() {\n\t// TODO\n}")).text;
  await assert.rejects(again.switchBranch("main"), /已经基于 aiops 分支改了代码，不能再切分支/);
  assert.equal((await again.switchBranch("aiops")).text, "已经在 aiops 分支上了。");

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
