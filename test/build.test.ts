import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type CommandRunner, createBuildChecker, parseDockerfile, readGoRecipe, toolchainFor } from "../src/build.js";

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
  const run: CommandRunner = async (command, args, { cwd, env }) => {
    // go list：照目录里的文件答（没有编译条件，.go 都算参与编译）
    if (command === "go" && args[0] === "list") {
      const lines: string[] = [];
      for (const pkg of args.filter((a) => a.startsWith("./") || a === ".")) {
        const abs = path.join(cwd, pkg);
        const names = (await readdir(abs).catch(() => [] as string[])).filter((n) => n.endsWith(".go") && !n.endsWith("_test.go"));
        lines.push(`${abs}\t${names.join(" ")}`);
      }
      return { code: 0, output: lines.join("\n") };
    }
    if (command === "go" && args[0] === "env") {
      return { code: 0, output: "go1.24.7\n" };
    }
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

  // 编的全是库：-o 写目录会报 no main packages，不带 -o 再编一次
  const lib = fakeRunner([{ code: 1, output: "go: no main packages to build\n" }, { code: 0, output: "" }]);
  assert.equal((await createBuildChecker({ run: lib.run }).check(dir, ["services/goods/jingdong.go"])).state, "passed");
  assert.deepEqual(lib.calls[1].args, ["build", "./services/goods"]);
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
  assert.deepEqual(await createBuildChecker({ run: fakeRunner([]).run }).check(dir, ["conf/app.toml"]), { state: "passed", summary: "改的都是不用编译的文件（文档、配置）" });

  const php = fakeRunner([{ code: 255, output: "PHP Parse error: syntax error in app/A.php on line 3\n" }]);
  const bad = await createBuildChecker({ run: php.run }).check(dir, ["app/A.php", "app/Gone.php"]);
  assert.equal(bad.state, "failed");
  assert.deepEqual(php.calls.map((c) => [c.command, ...c.args]), [["php", "-l", "./app/A.php"]]);
  const good = await createBuildChecker({ run: fakeRunner([{ code: 0, output: "No syntax errors detected in app/A.php" }]).run }).check(dir, ["app/A.php"]);
  assert.deepEqual(good, { state: "passed", summary: "php -l 查了 1 个文件，语法没问题" });
});

const APPSERVICE_CI = `image: golang:1.15
#build-dev:
#  script:
#    - docker build -t x --file=docker/golang/Dockerfile .
k8s_build_and_push:
  script:
    - DOCKER_BUILDKIT=1 docker buildx build --progress=plain   --file  deploy/Dockerfile --build-arg  BRANCH=$TARGET_BRANCH --platform $PLATFORM -t $REGISTRY_URL/yuebuy/product-api:$TARGET_BRANCH . --push
`;
const APPSERVICE_DOCKERFILE = `# syntax=registry.example/dockerfile:1.4
ARG BUILDER_IMAGE=registry.example/common/golang:1.25-alpine
FROM --platform=$BUILDPLATFORM  \${BUILDER_IMAGE} AS builder
ARG TARGETOS
ENV GO111MODULE=on \\
    CGO_ENABLED=1 \\
    GOOS=linux    \\
    GOFLAGS=-toolexec=/bin/evil \\
    GOPROXY=https://goproxy.cn,direct
WORKDIR /build
RUN --mount=type=cache,target=/go/pkg/mod/,sharing=locked \\
     CGO_ENABLED=0  GOOS=$TARGETOS GOARCH=$TARGETARCH go build -ldflags="-s -w" -tags jsoniter -o /build/product-api main.go
FROM alpine AS final
RUN echo done
`;

test("编译检查：照流水线用的 Dockerfile 读出 go build 的入口、环境变量和 -tags", async () => {
  const recipe = parseDockerfile(APPSERVICE_DOCKERFILE);
  assert.deepEqual(recipe, { targets: ["main.go"], env: { GO111MODULE: "on", GOOS: "linux" }, tags: "jsoniter", goVersion: "1.25" });
  assert.deepEqual(parseDockerfile("FROM golang:1.22\nRUN go build -o /app/x ./cmd/aiops-mcp/\n")?.targets, ["./cmd/aiops-mcp/"]);
  assert.equal(parseDockerfile("FROM php:8.0-fpm\nRUN composer install\n"), undefined);

  // 流水线里注释掉的 docker build 不算；写的是 deploy/Dockerfile 就不看根目录的
  const dir = await repo({ ".gitlab-ci.yml": APPSERVICE_CI, "deploy/Dockerfile": APPSERVICE_DOCKERFILE, "Dockerfile": "FROM golang:1.10\nRUN go build ./other\n", "docker/golang/Dockerfile": "FROM golang:1.10\nRUN go build ./old\n" });
  assert.equal((await readGoRecipe(dir))?.dockerfile, "deploy/Dockerfile");
  // 流水线没写 Dockerfile：用根目录的
  const plain = await repo({ "Dockerfile": "FROM golang:1.22\nRUN go build -o /x ./cmd/app\n" });
  assert.deepEqual((await readGoRecipe(plain))?.targets, ["./cmd/app"]);
  assert.equal(await readGoRecipe(await repo({ "a.txt": "x" })), undefined);
});

test("编译检查：编流水线编的入口（main.go 单独编，旁边的 demo.go 不管），加上入口外改到的包；cgo 和 GOFLAGS 不照搬", async () => {
  const dir = await repo({
    ".gitlab-ci.yml": APPSERVICE_CI,
    "deploy/Dockerfile": APPSERVICE_DOCKERFILE,
    "go.mod": "module x\n\ngo 1.15\n",
    "main.go": "package main\n",
    "demo.go": "package main\n",
    "services/goods/jingdong.go": "package goods\n",
  });
  const { calls, run } = fakeRunner([{ code: 0, output: "" }, { code: 0, output: "" }]);
  const ok = await createBuildChecker({ run }).check(dir, ["services/goods/jingdong.go", "demo.go"]);
  assert.equal(ok.state, "passed");
  assert.match(ok.state === "passed" ? ok.summary : "", /照 deploy\/Dockerfile 的构建（镜像里是 Go 1\.25，GO111MODULE=on，GOOS=linux）go build main\.go、go build \.\/services\/goods 编过了/);
  assert.deepEqual(calls.map((c) => c.args.slice(3)), [["-tags", "jsoniter", "./main.go"], ["-tags", "jsoniter", "./services/goods"]]);
  assert.equal(calls[0].env.GOOS, "linux");
  assert.equal(calls[0].env.CGO_ENABLED, "0");
  assert.equal(calls[0].env.GOFLAGS, "");
});

test("编译检查：编不过时在改之前的提交上再编一次，改之前能编过就是这次改坏的（报错在没改的文件里也算）", async () => {
  const dir = await repo({ ".gitlab-ci.yml": APPSERVICE_CI, "deploy/Dockerfile": APPSERVICE_DOCKERFILE, "go.mod": "module x\n", "main.go": "package main\n", "services/goods/jingdong.go": "package goods\n" });
  const broken = { code: 1, output: "controller/goods.go:12:3: not enough arguments in call to goods.Convert\n" };
  // git worktree add 换成把目录拷一份
  const withWorktree = (fake: ReturnType<typeof fakeRunner>): CommandRunner => async (command, args, options) => {
    const result = await fake.run(command, args, options);
    if (command === "git" && args[1] === "add") await cp(dir, String(args.at(-2)), { recursive: true });
    return result;
  };
  // 改之前编得过：这次改坏了调用的地方
  const caller = fakeRunner([broken, { code: 0, output: "" }]);
  const failed = await createBuildChecker({ run: withWorktree(caller) }).check(dir, ["services/goods/jingdong.go"], undefined, "abc123");
  assert.equal(failed.state, "failed");
  assert.match(failed.state === "failed" ? failed.output : "", /controller\/goods\.go:12:3/);
  const git = caller.calls.filter((c) => c.command === "git").map((c) => c.args.slice(0, 2).join(" "));
  assert.deepEqual(git, ["worktree add", "worktree remove", "worktree prune"]);
  assert.equal(caller.calls[2].args.at(-1), "abc123");
  assert.equal(caller.calls.filter((c) => c.command === "go").length, 4);

  // 改之前也编不过：本来就有问题，说不清
  const before = fakeRunner([broken, { code: 0, output: "" }, { code: 0, output: "" }, broken]);
  const unknown = await createBuildChecker({ run: withWorktree(before) }).check(dir, ["services/goods/jingdong.go"], undefined, "abc123");
  assert.equal(unknown.state, "unknown");
  assert.match(unknown.state === "unknown" ? unknown.reason : "", /改之前也编不过/);
});

test("编译检查：改了别的语言、构建配置、composer 依赖，说不清（合并时看流水线）", async () => {
  const dir = await repo({ "go.mod": "module x\n", "a.go": "package a\n" });
  const ts = await createBuildChecker({ run: fakeRunner([]).run }).check(dir, ["src/index.ts"]);
  assert.equal(ts.state, "unknown");
  assert.match(ts.state === "unknown" ? ts.reason : "", /编不了的文件（src\/index\.ts）/);
  const docker = await createBuildChecker({ run: fakeRunner([{ code: 0, output: "" }]).run }).check(dir, ["a.go", "deploy/Dockerfile"]);
  assert.equal(docker.state, "unknown");
  const composer = await createBuildChecker({ run: fakeRunner([]).run }).check(dir, ["composer.json"]);
  assert.match(composer.state === "unknown" ? composer.reason : "", /composer 依赖/);
});

test("编译检查：Dockerfile 的 exec 写法、几步 go build、-C、读不懂的，和镜像里的 Go 版本", async () => {
  assert.deepEqual(parseDockerfile('FROM golang:1.22\nRUN ["go", "build", "-o", "/app", "./cmd/api"]\n')?.targets, ["./cmd/api"]);
  const two = parseDockerfile("FROM golang:1.22\nRUN go build -o /m ./cmd/migrate\nRUN go build -o /a ./cmd/api\n");
  assert.deepEqual(two?.targets, ["./cmd/migrate", "./cmd/api"]);
  assert.equal(two?.unsupported, undefined);
  assert.match(parseDockerfile("FROM golang:1.22\nRUN go build -tags a ./x\nRUN go build ./y\n")?.unsupported ?? "", /编译条件不一样/);
  assert.match(parseDockerfile("FROM golang:1.22\nRUN go build -C cmd/api .\n")?.unsupported ?? "", /-C/);
  const odd = await repo({ Dockerfile: "FROM golang:1.22\nRUN sh -c 'cd x && go   build'\n" });
  // 能读出来的照读；读不出入口的 go build 不当作没有
  assert.ok(await readGoRecipe(odd));

  assert.equal(toolchainFor("1.25"), "go1.25.0+auto");
  assert.equal(toolchainFor("1.22.5"), "go1.22.5+auto");
  assert.equal(toolchainFor("1.15"), "auto");
  assert.equal(toolchainFor("1.25", "go1.25.3"), "auto");
  assert.equal(toolchainFor("1.22", "go1.25.3"), "go1.22.0+auto");
  assert.equal(toolchainFor(undefined), "auto");

  // 照编时用镜像的版本；-C 的编过了也只算说不清
  const dir = await repo({ "go.mod": "module x\n", Dockerfile: "FROM golang:1.22-alpine\nRUN go build -C cmd/api .\n", "cmd/api/main.go": "package main\n" });
  const { calls, run } = fakeRunner([{ code: 0, output: "" }]);
  const result = await createBuildChecker({ run }).check(dir, ["cmd/api/main.go"]);
  assert.equal(calls[0].env.GOTOOLCHAIN, "go1.22.0+auto");
  assert.equal(result.state, "unknown");
});

test("编译检查：改到的文件被编译条件排除了、改了流水线拆出去的文件、改之前也编不过，都算说不清；同时几次检查排队", async () => {
  const dir = await repo({ "go.mod": "module x\n", "a/a.go": "package a\n", "a/a_windows.go": "//go:build windows\npackage a\n", ".gitlab-ci.yml": "include:\n  - local: ci/build.yml\n", "ci/build.yml": "x: 1\n" });
  const listed: CommandRunner = async (command, args, options) =>
    command === "go" && args[0] === "list" ? { code: 0, output: `${path.join(options.cwd, "a")}\ta.go` } : { code: 0, output: "" };
  const excluded = await createBuildChecker({ run: listed }).check(dir, ["a/a_windows.go"]);
  assert.match(excluded.state === "unknown" ? excluded.reason : "", /a\/a_windows\.go 在服务器的编译条件下没参与编译/);
  assert.equal((await createBuildChecker({ run: listed }).check(dir, ["a/a.go"])).state, "passed");

  const ci = await createBuildChecker({ run: listed }).check(dir, ["ci/build.yml"]);
  assert.match(ci.state === "unknown" ? ci.reason : "", /构建配置（ci\/build\.yml）/);

  // 报错在改的文件上，但改之前也一样编不过：不拦
  const broken = { code: 1, output: "a/a.go:3:1: syntax error\n" };
  const both: CommandRunner = async (command, args, options) => {
    if (command === "git" && args[1] === "add") {
      await cp(dir, String(args.at(-2)), { recursive: true });
      return { code: 0, output: "" };
    }
    return command === "go" ? broken : { code: 0, output: "" };
  };
  const old = await createBuildChecker({ run: both }).check(dir, ["a/a.go"], undefined, "abc");
  assert.equal(old.state, "unknown");

  // 排队：前一次没编完，后一次不开始
  let running = 0;
  let most = 0;
  const slow: CommandRunner = async (command, args, options) => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
    return listed(command, args, options);
  };
  const checker = createBuildChecker({ run: slow });
  await Promise.all([checker.check(dir, ["a/a.go"]), checker.check(dir, ["a/a.go"])]);
  assert.equal(most, 1);
});
