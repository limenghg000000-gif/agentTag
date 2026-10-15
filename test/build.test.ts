import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type CommandRunner, createBuildChecker } from "../src/build.js";

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agenttag-build-test-"));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  return dir;
}

function fakeRunner(results: { code: number; output: string; missing?: boolean }[]) {
  const calls: { command: string; args: readonly string[]; env: Record<string, string> }[] = [];
  const run: CommandRunner = async (command, args, { env }) => {
    calls.push({ command, args, env });
    return results.shift() ?? { code: 0, output: "" };
  };
  return { calls, run };
}

test("编译检查：Go 只编改到的包，关掉 cgo、走国内代理；编不过且报错在改的文件上算没通过", async () => {
  const dir = await repo({ "go.mod": "module x\n\ngo 1.15\n", "services/goods/jingdong.go": "package goods\n", "main.go": "package main\n" });
  const { calls, run } = fakeRunner([{ code: 0, output: "" }]);
  const checker = createBuildChecker({ run });
  const ok = await checker.check(dir, ["services/goods/jingdong.go", "README.md"]);
  assert.deepEqual(ok, { state: "passed", summary: "go build ./services/goods 编过了" });
  assert.equal(calls[0].command, "go");
  assert.equal(calls[0].args[0], "build");
  assert.equal(calls[0].args[1], "-o");
  assert.deepEqual(calls[0].args.slice(3), ["./services/goods"]);
  assert.equal(calls[0].env.CGO_ENABLED, "0");
  assert.equal(calls[0].env.GOTOOLCHAIN, "auto");
  assert.match(calls[0].env.GOPROXY, /goproxy\.cn/);
  assert.equal(calls[0].env.GOSUMDB, "sum.golang.google.cn");

  const failed = await createBuildChecker({ run: fakeRunner([{ code: 1, output: "services/goods/jingdong.go:1401:4: undefined: logs\n" }]).run }).check(dir, [
    "services/goods/jingdong.go",
  ]);
  assert.equal(failed.state, "failed");
  assert.match(failed.state === "failed" ? failed.output : "", /jingdong\.go:1401:4: undefined: logs/);

  // 报错都在没改的文件上：说不清是不是这次改坏的
  const other = await createBuildChecker({ run: fakeRunner([{ code: 1, output: "./demo.go:3:6: main redeclared in this block\n" }]).run }).check(dir, ["main.go"]);
  assert.equal(other.state, "unknown");
  assert.match(other.state === "unknown" ? other.reason : "", /报错都不在这次改的文件上/);

  // 改了 go.mod 编整个仓库
  const all = fakeRunner([{ code: 0, output: "" }]);
  await createBuildChecker({ run: all.run }).check(dir, ["go.mod"]);
  assert.deepEqual(all.calls[0].args.slice(3), ["./..."]);
  // 配了代理用配的
  const proxy = fakeRunner([{ code: 0, output: "" }]);
  await createBuildChecker({ run: proxy.run, goproxy: "https://goproxy.corp,direct" }).check(dir, ["main.go"]);
  assert.equal(proxy.calls[0].env.GOPROXY, "https://goproxy.corp,direct");
  assert.deepEqual(proxy.calls[0].args.slice(3), ["."]);
});

test("编译检查：没装工具、没有 go.mod 说不清；不是代码的改动直接算过；PHP 查语法", async () => {
  const dir = await repo({ "go.mod": "module x\n", "a.go": "package a\n", "app/A.php": "<?php\n", "conf/app.toml": "x=1\n" });
  const missing = await createBuildChecker({ run: fakeRunner([{ code: -1, output: "", missing: true }]).run }).check(dir, ["a.go"]);
  assert.deepEqual(missing, { state: "unknown", reason: "服务器上没装 Go，没编译" });
  const noMod = await repo({ "a.go": "package a\n" });
  assert.equal((await createBuildChecker({ run: fakeRunner([]).run }).check(noMod, ["a.go"])).state, "unknown");
  assert.deepEqual(await createBuildChecker({ run: fakeRunner([]).run }).check(dir, ["conf/app.toml"]), { state: "passed", summary: "改的都不是要编译的代码文件" });

  const php = fakeRunner([{ code: 255, output: "PHP Parse error: syntax error in app/A.php on line 3\n" }]);
  const bad = await createBuildChecker({ run: php.run }).check(dir, ["app/A.php", "app/Gone.php"]);
  assert.equal(bad.state, "failed");
  assert.deepEqual(php.calls.map((c) => [c.command, ...c.args]), [["php", "-l", "./app/A.php"]]);
  const good = await createBuildChecker({ run: fakeRunner([{ code: 0, output: "No syntax errors detected in app/A.php" }]).run }).check(dir, ["app/A.php"]);
  assert.deepEqual(good, { state: "passed", summary: "php -l 查了 1 个文件，语法没问题" });
});
