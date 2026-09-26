import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { type CodeHost, CodeWorkspaces, RepoError, runGit } from "../src/repo.js";
import { createCodeTools } from "../src/tools/code.js";

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

let rootCount = 0;
function workspaces(host: CodeHost, now?: () => Date) {
  return new CodeWorkspaces({ root: path.join(tmp, `ws${rootCount++}`), host, repos: ["acme/demo"], logger: quiet, now });
}

test("克隆后列文件、带行号读文件、搜代码", async () => {
  const ws = await workspaces(fakeHost().host).open("om_1", "ACME/demo");
  assert.equal(ws.repo, "acme/demo");
  assert.equal(ws.defaultBranch, "main");
  assert.match(await ws.listFiles(), /共 5 个文件：\nREADME.md\nleak\nlogo.bin\nsrc\/a.ts\nsrc\/b.ts/);
  assert.equal(await ws.listFiles({ glob: "src/**/*.ts" }), "共 2 个文件：\nsrc/a.ts\nsrc/b.ts");
  assert.equal(
    await ws.readFile("src/a.ts", 2, 3),
    "src/a.ts（共 4 行，下面是第 2 到 3 行，要看后面用 start_line=4）\n2| export function hello() {\n3|   return 'hi';",
  );
  assert.match(await ws.readFile("./src"), /src\/a.ts/);
  assert.equal(await ws.search("hello"), "共 1 处：\nsrc/a.ts:2:export function hello() {");
  assert.equal(await ws.search("A, A", { literal: true, ignoreCase: true }), "共 1 处：\nsrc/b.ts:2:console.log(a, a);");
  assert.equal(await ws.search("nothing_here"), "没有搜到「nothing_here」。");
  await assert.rejects(ws.readFile("logo.bin"), /二进制/);
  await assert.rejects(ws.readFile("missing.ts"), /没有这个文件/);
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
  assert.equal(await ws.search("sk-secret"), "没有搜到「sk-secret」。");
});

test("改文件：替换唯一的片段、新建文件，找不到或不唯一时报错；diff 列出全部改动", async () => {
  const ws = await workspaces(fakeHost().host).open("om_2", "acme/demo");
  assert.equal(await ws.editFile("src/a.ts", "return 'hi';", "return 'hello';"), "已修改 src/a.ts 第 3 行起的内容。");
  await assert.rejects(ws.editFile("src/a.ts", "not there", "x"), /没找到 old_text/);
  await assert.rejects(ws.editFile("src/b.ts", "a", "x"), /出现了 \d+ 次/);
  await assert.rejects(ws.editFile("src/new.ts", "x", "y"), /要新建文件时不填 old_text/);
  assert.equal(await ws.editFile("src/util/new.ts", undefined, "export {};\n"), "已新建 src/util/new.ts（2 行）。");

  const diff = await ws.diff();
  assert.match(diff, /src\/a.ts\s+\| 2 \+-/);
  assert.match(diff, /src\/util\/new.ts\s+\| 1 \+/);
  assert.match(diff, /-  return 'hi';\n\+  return 'hello';/);
});

test("开 PR：提交到机器人建的分支并推上去；同一话题再改会推到同一个 PR；没改动时报错", async () => {
  const { host, prs } = fakeHost();
  const all = workspaces(host, () => new Date("2026-09-26T10:00:00Z"));
  const ws = await all.open("om_3", "acme/demo");
  await assert.rejects(ws.openPullRequest("t", "b"), /还没有任何改动/);

  await ws.editFile("README.md", "# demo", "# demo\n\n说明");
  const first = await ws.openPullRequest("改 README", "描述");
  assert.equal(first.created, true);
  assert.equal(first.url, "https://example.com/pr/1");
  assert.match(first.stat, /README.md/);
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
  await again.editFile("src/a.ts", "export const a = 1;", "export const a = 2;");
  assert.match(await again.diff(), /src\/a.ts/);
  assert.doesNotMatch(await again.diff(), /README/);
  const second = await again.openPullRequest("改 a", "");
  assert.deepEqual([second.created, second.number], [false, 1]);
  assert.equal(prs.length, 1);
  assert.equal((await runGit(["log", "-1", "--format=%s", prs[0].head], { cwd: remote })).stdout.trim(), "改 a");
  await assert.rejects(again.openPullRequest("x", ""), /没有新的改动要推，PR 还是 https:\/\/example.com\/pr\/1/);
});

test("推上去了但开 PR 失败时，再调一次直接补开，不用新改动", async () => {
  const { host, prs } = fakeHost(1);
  const ws = await workspaces(host).open("om_4", "acme/demo");
  await ws.editFile("README.md", "# demo", "# demo 2");
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
  assert.match(await ws.listFiles(), /NEW.md/);
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
  await tools.code_edit_file.run({ path: "src/a.ts", old_text: "= 1", new_text: "= 3" }, { signal });
  const result = await tools.code_open_pr.run({ title: "a 改成 3\n多余的行", body: "原因" }, { signal });
  assert.match(result, /^已开 PR #1：https:\/\/example.com\/pr\/1\n\n改动统计：\nsrc\/a.ts/);
  assert.equal(prs[0].title, "a 改成 3");
  assert.equal(prs[0].body, "原因\n\n---\n由 张三 在飞书群里让「飞书 CLI」提交。");
  assert.equal(opens, 1);
  assert.equal(tools.code_search.describe({ pattern: "hello" }), "搜代码：hello");
  await assert.rejects(tools.code_edit_file.run({ path: "x.ts" }, { signal }), /缺少 new_text/);
});
