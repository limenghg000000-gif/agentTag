import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 推代码之前的编译检查：机器人跑不了仓库的测试，但能在服务器上编译一下，编不过的改动不推、不合。
 * 照项目自己的构建方式编：先读 .gitlab-ci.yml 找流水线用的 Dockerfile，再从 Dockerfile 里找 go build 那一步，
 * 编同一个入口、用同样的 CGO_ENABLED、GOOS、-tags（不跑 docker，不拉镜像）；找不到时编改到的包。
 * 只编译不运行：Go 用 go build（项目要更新的 Go 时自动下载官方工具链），PHP 用 php -l 查语法。
 * 编不过时在改之前的提交上再编一次：改之前能编过，就是这次改坏的；改之前也编不过，说不清。
 * 服务器上没装对应的工具、改的是编不了的文件（别的语言、依赖、Dockerfile）时说不清，合并时退回到看平台上的流水线。
 */
export interface BuildChecker {
  /** base：改之前的提交，编不过时拿它比 */
  check(dir: string, files: readonly string[], signal?: AbortSignal, base?: string): Promise<BuildResult>;
}

export type BuildResult =
  /** 编过了（或者改的都是不用编译的文件）；summary 写查了什么 */
  | { state: "passed"; summary: string }
  /** 这次改动编不过；output 是编译器的报错 */
  | { state: "failed"; output: string }
  /** 没编（没装工具、编不了这类文件），或者编不过但改之前也编不过：说不清能不能编过 */
  | { state: "unknown"; reason: string };

/** 跑一个命令，不经过 shell：退出码、输出（标准输出和标准错误合在一起） */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; signal?: AbortSignal; timeoutMs: number },
) => Promise<{ code: number; output: string; missing?: boolean }>;

export interface BuildCheckerOptions {
  /** 跑命令的（测试里换掉） */
  run?: CommandRunner;
  /** go 下载依赖用的代理，没配时用 goproxy.cn */
  goproxy?: string;
  /** 一次编译最多等多久：第一次要下载依赖，给足 */
  timeoutMs?: number;
}

/** 从项目的流水线和 Dockerfile 里读出来的 Go 构建方式 */
export interface GoRecipe {
  /** 流水线用的 Dockerfile（相对仓库根目录） */
  dockerfile: string;
  /** go build 编的入口：包（./cmd/x）或者文件（main.go） */
  targets: string[];
  /** Dockerfile 里写死的环境变量：GOOS、GOARCH 这类 */
  env: Record<string, string>;
  /** go build 的 -tags */
  tags?: string;
  /** 构建镜像里的 Go 版本，如 1.25：用这个版本的官方工具链编 */
  goVersion?: string;
  /** 照着编说明不了流水线的原因（go build -C、几步 go build 条件不一样、读不懂）：编过了也只算说不清 */
  unsupported?: string;
}

/** 报错最多带多少字给模型 */
const MAX_OUTPUT_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** 不用编译的文件：文档、图片、配置 */
const NO_BUILD = /\.(md|markdown|txt|rst|adoc|png|jpe?g|gif|svg|ico|webp|pdf|toml|ya?ml|json|ini|conf|cfg|properties|env|csv|tsv|html?|css|sql|xml)$/i;
/** 改了构建方式本身：照旧的方式编说明不了什么（流水线拆出去的 .gitlab-ci/、.gitlab/ 下的文件也算） */
const BUILD_FILES = /(^|\/)(Dockerfile[^/]*|Makefile|\.dockerignore)$|(^|\/)\.gitlab-ci[^/]*(\/|$)|^\.gitlab\//;
/** Dockerfile 里照着用的环境变量。GOFLAGS（能带 -toolexec 跑任意命令）和 CGO_ENABLED（开了会调 C 编译器）不照搬，一律关掉 */
const GO_ENV_KEYS = new Set(["GOOS", "GOARCH", "GOEXPERIMENT", "GOAMD64", "GO111MODULE"]);

export function createBuildChecker(options: BuildCheckerOptions = {}): BuildChecker {
  const run = options.run ?? runCommand;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 一次只编一个：几个话题同时推代码时排队，免得把服务器的 CPU、内存占满
  let queue: Promise<unknown> = Promise.resolve();
  return {
    check(dir, files, signal, base) {
      const next = queue.then(() => checkOnce(dir, files, signal, base));
      queue = next.catch(() => undefined);
      return next;
    },
  };

  async function checkOnce(dir: string, files: readonly string[], signal?: AbortSignal, base?: string): Promise<BuildResult> {
    {
      const goFiles = files.filter((file) => file.endsWith(".go"));
      const goModChanged = files.some((file) => file === "go.mod" || file === "go.sum");
      const phpFiles = files.filter((file) => file.endsWith(".php"));
      const composerChanged = files.some((file) => file === "composer.json" || file === "composer.lock");
      const done: string[] = [];
      const unknown: string[] = [];
      const failures: string[] = [];

      const included = await ciIncludes(dir);
      const isBuildFile = (file: string) => BUILD_FILES.test(file) || included.has(file);
      const buildFiles = files.filter(isBuildFile);
      if (buildFiles.length > 0) {
        unknown.push(`改了构建配置（${buildFiles.join("、")}），服务器上的编译说明不了流水线能不能过`);
      }
      const others = files.filter(
        (file) => !file.endsWith(".go") && !file.endsWith(".php") && file !== "go.mod" && file !== "go.sum" && file !== "composer.json" && file !== "composer.lock" && !NO_BUILD.test(file) && !isBuildFile(file),
      );
      if (others.length > 0) {
        unknown.push(`改了服务器上编不了的文件（${others.slice(0, 5).join("、")}${others.length > 5 ? " 等" : ""}）`);
      }
      if (composerChanged) {
        unknown.push("改了 composer 依赖，服务器上不装依赖，说不清能不能装上");
      }

      if (goFiles.length > 0 || goModChanged) {
        const result = await checkGo(dir, goFiles, goModChanged, files, run, { goproxy: options.goproxy, timeoutMs, signal, base });
        if (result.state === "passed") done.push(result.summary);
        else if (result.state === "failed") failures.push(result.output);
        else unknown.push(result.reason);
      }
      if (phpFiles.length > 0) {
        const result = await checkPhp(dir, phpFiles, run, { timeoutMs, signal });
        if (result.state === "passed") done.push(result.summary);
        else if (result.state === "failed") failures.push(result.output);
        else unknown.push(result.reason);
      }
      if (failures.length > 0) {
        return { state: "failed", output: cut(failures.join("\n\n")) };
      }
      if (unknown.length > 0) {
        return { state: "unknown", reason: unknown.join("；") };
      }
      return { state: "passed", summary: done.length > 0 ? done.join("；") : "改的都是不用编译的文件（文档、配置）" };
    }
  }
}

/** .gitlab-ci.yml 里 include 的本仓库文件（local:），改了它们就是改了流水线 */
async function ciIncludes(dir: string): Promise<Set<string>> {
  const ci = await readText(path.join(dir, ".gitlab-ci.yml"));
  const found = new Set<string>();
  for (const match of (ci ?? "").matchAll(/^\s*(?:-\s*)?(?:include:\s*|local:\s*)?["']?\/?([^\s"'#:]+\.ya?ml)["']?\s*$/gm)) {
    found.add(path.posix.normalize(match[1]));
  }
  return found;
}

/** 一次 go build：编几个包，或者编同一个目录里的几个文件 */
interface GoBuild {
  args: string[];
  /** 写进结果的样子 */
  label: string;
}

async function checkGo(
  dir: string,
  goFiles: readonly string[],
  goModChanged: boolean,
  changed: readonly string[],
  run: CommandRunner,
  { goproxy, timeoutMs, signal, base }: { goproxy?: string; timeoutMs: number; signal?: AbortSignal; base?: string },
): Promise<BuildResult> {
  if (!(await exists(path.join(dir, "go.mod")))) {
    return { state: "unknown", reason: "仓库根目录没有 go.mod，没编译 Go 代码" };
  }
  const recipe = await readGoRecipe(dir);
  const builds = await goBuilds(dir, goFiles, goModChanged, recipe);
  if (builds.length === 0) {
    return { state: "passed", summary: "改的 Go 文件都删掉了，没有要编译的包" };
  }
  const env: Record<string, string> = {
    ...(recipe?.env ?? {}),
    CGO_ENABLED: "0",
    GOFLAGS: "",
    // 用构建镜像里那个版本的官方工具链（从代理下载，有校验），go.mod 要更新的就用更新的；不知道镜像版本时用装的
    GOTOOLCHAIN: toolchainFor(recipe?.goVersion, await installedGo(dir, run, timeoutMs, signal)),
    GOPROXY: goproxy || process.env.GOPROXY || "https://goproxy.cn,direct",
    // 校验下载的依赖和工具链：用官方的国内地址，服务器在国内连不上 sum.golang.org
    GOSUMDB: process.env.GOSUMDB || "sum.golang.google.cn",
  };
  const how = recipe ? `照 ${recipe.dockerfile} 的构建（${[recipe.goVersion ? `镜像里是 Go ${recipe.goVersion}` : "", ...Object.entries(recipe.env).map(([k, v]) => `${k}=${v}`)].filter(Boolean).join("，")}）` : "";
  const labels = builds.map((b) => b.label).join("、");

  const head = await runBuilds(dir, builds, run, env, { timeoutMs, signal });
  if (head.missing) {
    return { state: "unknown", reason: "服务器上没装 Go，没编译" };
  }
  if (head.ok) {
    if (recipe?.unsupported) {
      return { state: "unknown", reason: `${labels} 编过了，但${recipe.unsupported}，说不清流水线能不能过` };
    }
    // 改到的文件可能因为编译条件（_windows.go、build tag、要 cgo）根本没参与编译：编过了也说明不了它
    const skipped = await excludedFiles(dir, goFiles, builds, run, env, { timeoutMs, signal });
    if (skipped.length > 0) {
      return { state: "unknown", reason: `${labels} 编过了，但改到的 ${skipped.join("、")} 在服务器的编译条件下没参与编译（系统、build tag 或 cgo 限定），说不清` };
    }
    return { state: "passed", summary: `${how}${labels} 编过了` };
  }
  const output = head.output.trim();
  const failed: BuildResult = { state: "failed", output: `${how}${labels} 编不过：\n${output}` };
  // 改之前也编一次：改之前能编过，就是这次改坏的（报错可能在没改的文件里，比如改了函数签名，调用的地方编不过）
  if (base) {
    const before = await atCommit(dir, base, run, { timeoutMs, signal }, async (baseDir) => {
      const existing: GoBuild[] = [];
      for (const build of builds) {
        if (await allExist(baseDir, build)) existing.push(build);
      }
      return existing.length === builds.length ? runBuilds(baseDir, existing, run, env, { timeoutMs, signal }) : undefined;
    });
    if (before?.ok) {
      return failed;
    }
    // 改之前也编不过：分不清报错是原来就有的还是这次加的
    if (before && !before.missing) {
      return { state: "unknown", reason: `${labels} 编不过，但改之前也编不过（本来就有问题）：${firstLines(output)}` };
    }
  }
  return mentionsChanged(output, changed) ? failed : { state: "unknown", reason: `${labels} 编不过，但报错都不在这次改的文件上（可能本来就编不过）：${firstLines(output)}` };
}

/**
 * GOTOOLCHAIN：镜像是 Go 1.21 以后的、和装的不是同一个小版本时，用镜像那个版本（go1.25 → go1.25.0+auto，go.mod 要更新的会再换）；
 * 同一个小版本、更老的或者不知道的用装的
 */
export function toolchainFor(version: string | undefined, installed?: string): string {
  const [major, minor, patch] = (version ?? "").split(".").map(Number);
  if (major !== 1 || !Number.isInteger(minor) || minor < 21) {
    return "auto";
  }
  if (installed && /^go1\.(\d+)/.exec(installed)?.[1] === String(minor)) {
    return "auto";
  }
  return `go1.${minor}.${Number.isInteger(patch) ? patch : 0}+auto`;
}

/** 要跑的 go build：流水线编的入口，加上改到、但入口没带上的包；改了 go.mod 编整个仓库 */
async function goBuilds(dir: string, goFiles: readonly string[], goModChanged: boolean, recipe: GoRecipe | undefined): Promise<GoBuild[]> {
  const tags = recipe?.tags ? ["-tags", recipe.tags] : [];
  const builds: GoBuild[] = [];
  // 入口里的文件（main.go）只能和同一个目录的文件一起编；包可以一起编
  const fileTargets = new Map<string, string[]>();
  const packages = new Set<string>();
  for (const target of recipe?.targets ?? []) {
    if (target.endsWith(".go")) {
      const parent = path.posix.dirname(path.posix.normalize(target));
      fileTargets.set(parent, [...(fileTargets.get(parent) ?? []), `./${path.posix.normalize(target)}`]);
    } else {
      packages.add(asPackage(target));
    }
  }
  if (goModChanged) {
    packages.add("./...");
  }
  for (const file of goFiles) {
    const parent = path.posix.dirname(file);
    // 入口是这个目录里的几个文件时（比如根目录的 main.go，旁边还有别的 main），这个目录按入口编，不整个编
    if (fileTargets.has(parent)) {
      continue;
    }
    if (!(await exists(path.join(dir, parent)))) {
      // 整个包删掉了：编整个仓库，看还有没有地方引用它
      packages.add("./...");
      continue;
    }
    packages.add(asPackage(parent));
  }
  for (const [, list] of fileTargets) {
    builds.push({ args: [...tags, ...list], label: `go build ${list.map((f) => f.replace(/^\.\//, "")).join(" ")}` });
  }
  const pkgList = packages.has("./...") ? ["./..."] : [...packages];
  if (pkgList.length > 0) {
    builds.push({ args: [...tags, ...pkgList], label: `go build ${pkgList.join(" ")}` });
  }
  return builds;
}

function asPackage(target: string): string {
  const clean = path.posix.normalize(target.replace(/\/+$/, "")).replace(/^\.\//, "");
  if (clean === "." || clean === "") return ".";
  if (clean.startsWith("./") || clean.endsWith("...")) return clean.startsWith(".") ? clean : `./${clean}`;
  return `./${clean}`;
}

/** 改到的 Go 文件（测试文件除外，流水线不编）里，在这些环境变量下被编译条件排除掉的 */
async function excludedFiles(
  dir: string,
  goFiles: readonly string[],
  builds: readonly GoBuild[],
  run: CommandRunner,
  env: Record<string, string>,
  { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
): Promise<string[]> {
  const targetFiles = new Set(builds.flatMap((b) => b.args).filter((a) => a.endsWith(".go")).map((a) => path.posix.normalize(a)));
  const byDir = new Map<string, string[]>();
  for (const file of goFiles) {
    if (file.endsWith("_test.go") || targetFiles.has(path.posix.normalize(file))) continue;
    const parent = path.posix.dirname(file);
    if (!(await exists(path.join(dir, file)))) continue;
    byDir.set(parent, [...(byDir.get(parent) ?? []), path.posix.basename(file)]);
  }
  if (byDir.size === 0) {
    return [];
  }
  const tags = builds[0]?.args[0] === "-tags" ? ["-tags", builds[0].args[1]] : [];
  const dirs = [...byDir.keys()];
  const result = await run("go", ["list", "-e", ...tags, "-f", "{{.Dir}}\t{{join .GoFiles \" \"}}", ...dirs.map(asPackage)], { cwd: dir, env, signal, timeoutMs });
  const compiled = new Map<string, Set<string>>();
  for (const line of result.output.split("\n")) {
    const [abs, list = ""] = line.split("\t");
    if (abs) compiled.set(path.resolve(abs), new Set(list.split(" ").filter(Boolean)));
  }
  const skipped: string[] = [];
  for (const [parent, names] of byDir) {
    const files = compiled.get(path.resolve(dir, parent));
    for (const name of names) {
      if (!files?.has(name)) skipped.push(path.posix.join(parent, name));
    }
  }
  return skipped;
}

/** 服务器上装的 Go 版本（如 go1.25.3），没装或者问不出来时 undefined */
async function installedGo(dir: string, run: CommandRunner, timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
  const result = await run("go", ["env", "GOVERSION"], { cwd: dir, env: { GOTOOLCHAIN: "local" }, signal, timeoutMs });
  return result.code === 0 && !result.missing ? result.output.trim() || undefined : undefined;
}

async function allExist(dir: string, build: GoBuild): Promise<boolean> {
  for (const arg of build.args) {
    if (arg.startsWith("./") && !arg.includes("...") && !(await exists(path.join(dir, arg)))) {
      return false;
    }
  }
  return true;
}

async function runBuilds(
  dir: string,
  builds: readonly GoBuild[],
  run: CommandRunner,
  env: Record<string, string>,
  { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ ok: boolean; output: string; missing?: boolean }> {
  const outputs: string[] = [];
  // 编出来的程序放到临时目录，编完就删，不留在工作目录里
  const out = await mkdtemp(path.join(tmpdir(), "agenttag-build-"));
  try {
    for (const build of builds) {
      let result = await run("go", ["build", "-o", `${out}${path.sep}`, ...build.args], { cwd: dir, env, signal, timeoutMs });
      // -o 写目录时编的全是库（没有 main 包）会报错；这时不带 -o 再编，编库不会留下文件
      if (result.code !== 0 && /no main packages to build/.test(result.output)) {
        result = await run("go", ["build", ...build.args], { cwd: dir, env, signal, timeoutMs });
      }
      if (result.missing) {
        return { ok: false, output: "", missing: true };
      }
      if (result.code !== 0) {
        outputs.push(result.output.trim());
      }
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
  return { ok: outputs.length === 0, output: outputs.join("\n") };
}

/** 把改之前的提交检出到临时目录里做点事，做完删掉 */
async function atCommit<T>(
  dir: string,
  commit: string,
  run: CommandRunner,
  { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
  work: (baseDir: string) => Promise<T>,
): Promise<T | undefined> {
  const parent = await mkdtemp(path.join(tmpdir(), "agenttag-base-"));
  const baseDir = path.join(parent, "src");
  try {
    const added = await run("git", ["worktree", "add", "--detach", "--", baseDir, commit], { cwd: dir, env: {}, signal, timeoutMs });
    if (added.code !== 0 || added.missing) {
      return undefined;
    }
    return await work(baseDir);
  } finally {
    await run("git", ["worktree", "remove", "--force", "--", baseDir], { cwd: dir, env: {}, signal: undefined, timeoutMs: 60_000 }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
    await run("git", ["worktree", "prune"], { cwd: dir, env: {}, signal: undefined, timeoutMs: 60_000 }).catch(() => undefined);
  }
}

/** 一步 go build：编的入口、写死的环境变量、-tags、用的 Go 版本 */
interface GoStep {
  targets: string[];
  env: Record<string, string>;
  tags?: string;
  goVersion?: string;
  unsupported?: string;
}

/**
 * 读项目的构建方式，按流水线来：
 * 1. .gitlab-ci.yml 里 docker build 用的 Dockerfile（--file/-f，几个都读；路径里的 ${SERVICE_NAME} 这类按实际的目录展开），取里面每一步 go build；
 * 2. 流水线没用 Dockerfile、直接在脚本里 go build 的（老项目：image: golang:1.18 加 script），照脚本里的 go build；
 * 3. 流水线里两样都没有，用根目录的 Dockerfile。
 * 一个都找不到返回 undefined（只编改到的包）
 */
export async function readGoRecipe(dir: string): Promise<GoRecipe | undefined> {
  const ci = await readText(path.join(dir, ".gitlab-ci.yml"));
  const ciText = ci ? withoutComments(ci) : "";
  const files: string[] = [];
  for (const match of ciText.matchAll(/(?:--file[\s=]+|\s-f\s+)["']?([^\s"']+)/g)) {
    for (const file of await expandPath(dir, match[1])) {
      if (!files.includes(file)) files.push(file);
    }
  }
  const found: { file: string; steps: GoStep[] }[] = [];
  for (const file of files) {
    const text = await readText(path.join(dir, file));
    if (!text) continue;
    const steps = dockerfileSteps(text);
    if (steps.length > 0) {
      found.push({ file, steps });
    } else if (/\bgo\b[\s",]+build\b/.test(text)) {
      found.push({ file, steps: [{ targets: [], env: {}, unsupported: `${file} 里的 go build 读不懂` }] });
    }
  }
  if (found.length === 0 && ciText) {
    const steps = ciScriptSteps(ciText);
    if (steps.length > 0) found.push({ file: ".gitlab-ci.yml", steps });
  }
  if (found.length === 0 && files.length === 0) {
    const text = await readText(path.join(dir, "Dockerfile"));
    const steps = text ? dockerfileSteps(text) : [];
    if (steps.length > 0) found.push({ file: "Dockerfile", steps });
  }
  if (found.length === 0) {
    return undefined;
  }
  const merged = mergeSteps(found.flatMap((f) => f.steps));
  return merged ? { dockerfile: found.map((f) => f.file).join("、"), ...merged } : undefined;
}

/** 去掉注释行（Dockerfile 和 YAML 都是 # 开头的整行；Dockerfile 的注释行在续行之前去掉） */
function withoutComments(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** 流水线里的 Dockerfile 路径：不能出仓库；带 ${SERVICE_NAME} 这类变量的段，按仓库里实际有的目录展开（最多 20 个） */
async function expandPath(dir: string, raw: string): Promise<string[]> {
  const rel = path.posix.normalize(raw.replace(/^\.\//, ""));
  if (rel.startsWith("..") || path.posix.isAbsolute(rel)) {
    return [];
  }
  let current = [""];
  for (const segment of rel.split("/")) {
    const next: string[] = [];
    for (const prefix of current) {
      if (!segment.includes("$")) {
        next.push(path.posix.join(prefix, segment));
      } else if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(segment)) {
        const entries = await readdir(path.join(dir, prefix), { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.name.startsWith(".") && entry.name !== "vendor" && entry.name !== "node_modules") next.push(path.posix.join(prefix, entry.name));
        }
      }
    }
    current = next.slice(0, 20);
  }
  const existing: string[] = [];
  for (const file of current) {
    if (await isFile(path.join(dir, file))) existing.push(file);
  }
  return existing;
}

/** 从 Dockerfile 里读出 go build 那一步（导出给测试用） */
export function parseDockerfile(text: string): Omit<GoRecipe, "dockerfile"> | undefined {
  return mergeSteps(dockerfileSteps(text));
}

/** 几步 go build（比如先编工具再编服务）：入口都编；编译条件不一样的照一套编说明不了 */
function mergeSteps(steps: readonly GoStep[]): Omit<GoRecipe, "dockerfile"> | undefined {
  const [first] = steps;
  if (!first) {
    return undefined;
  }
  const same = steps.every((s) => s.tags === first.tags && s.goVersion === first.goVersion && JSON.stringify(s.env) === JSON.stringify(first.env));
  const unsupported = steps.find((s) => s.unsupported)?.unsupported ?? (same ? undefined : "几步 go build 的编译条件（Go 版本、-tags、GOOS 这类）不一样");
  return {
    targets: [...new Set(steps.flatMap((s) => s.targets))],
    env: first.env,
    ...(first.tags ? { tags: first.tags } : {}),
    ...(first.goVersion ? { goVersion: first.goVersion } : {}),
    ...(unsupported ? { unsupported } : {}),
  };
}

function dockerfileSteps(text: string): GoStep[] {
  const lines = withoutComments(text)
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const args: Record<string, string> = {};
  let image = "";
  let env: Record<string, string> = {};
  const steps: GoStep[] = [];
  for (const line of lines) {
    const [, instruction = "", rest = ""] = /^(\S+)\s*(.*)$/.exec(line) ?? [];
    const name = instruction.toUpperCase();
    if (name === "ARG") {
      const [, key, value] = /^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/.exec(rest) ?? [];
      if (key && value !== undefined) args[key] = unquote(value);
    } else if (name === "FROM") {
      const words = rest.split(/\s+/).filter((w) => !w.startsWith("--"));
      image = (words[0] ?? "").replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, key: string) => args[key] ?? "");
      env = {};
    } else if (name === "ENV") {
      Object.assign(env, parseEnv(rest));
    } else if (name === "RUN") {
      let command = rest.replace(/^(--\S+\s+)+/, "");
      // exec 写法：RUN ["go", "build", ...]
      if (command.startsWith("[")) {
        try {
          const list = JSON.parse(command) as unknown;
          if (Array.isArray(list)) command = list.map((w) => (/\s/.test(String(w)) ? `"${String(w)}"` : String(w))).join(" ");
        } catch {
          // 不是 JSON，当普通命令看
        }
      }
      const step = goStep(command, env, goVersionOf(image));
      if (step) steps.push(step);
    }
  }
  return steps;
}

/** 流水线脚本里直接跑的 go build（「- go build -o x main.go」），Go 版本看最近的 image；前面单独一行 cd 到子目录的，入口跟着换 */
function ciScriptSteps(text: string): GoStep[] {
  const steps: GoStep[] = [];
  let image = "";
  // 这个任务的脚本当前在哪个目录（相对仓库根目录）；cd 到仓库外、绝对路径时不知道
  let cwd: string | undefined = "";
  for (const line of text.split("\n")) {
    if (/^\S[^:]*:\s*$/.test(line)) {
      cwd = "";
    }
    const declared = /^\s*image:\s*["']?([^\s"']+)/.exec(line);
    if (declared) {
      image = declared[1];
      continue;
    }
    if (!/^\s*-\s/.test(line)) continue;
    const command = line.replace(/^\s*-\s+/, "");
    const cd = /^cd\s+["']?([^\s"'&;]+)["']?\s*$/.exec(command.trim());
    if (cd) {
      const target = cd[1];
      if (/^\$\{?CI_PROJECT_DIR\}?\/?$/.test(target)) cwd = "";
      else if (cwd !== undefined && !target.includes("$") && !path.posix.isAbsolute(target)) {
        const joined = path.posix.normalize(path.posix.join(cwd, target));
        cwd = joined.startsWith("..") ? undefined : joined === "." ? "" : joined;
      } else cwd = undefined;
      continue;
    }
    const step = goStep(command, {}, goVersionOf(image));
    if (!step) continue;
    if (cwd === undefined) {
      steps.push({ ...step, unsupported: step.unsupported ?? "流水线 cd 到了仓库外面再 go build" });
    } else {
      steps.push({ ...step, targets: step.targets.map((t) => (cwd ? path.posix.join(cwd, t) : t)) });
    }
  }
  return steps;
}

/** 镜像名里的 Go 版本：golang:1.22-alpine、go1.21:v1.0.0 */
function goVersionOf(image: string): string | undefined {
  return /golang:(\d+\.\d+(?:\.\d+)?)/.exec(image)?.[1] ?? /\bgo(\d+\.\d+(?:\.\d+)?)\b/.exec(image)?.[1];
}

/** 一条命令里的 go build；cd 到别的目录再编的、-C 的算说不清 */
function goStep(command: string, env: Record<string, string>, goVersion: string | undefined): GoStep | undefined {
  const build = /(?:^|[\s;&|(])((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)go\s+build\b([^;&|]*)/.exec(command);
  if (!build) {
    return undefined;
  }
  const inline = parseEnv(build[1]);
  const { targets, tags, unsupported } = parseGoBuild(build[2]);
  const merged: Record<string, string> = {};
  // 写死的才用；$TARGETOS 这类由构建平台定的不管，留着这个阶段 ENV 里写的
  for (const source of [env, inline]) {
    for (const [key, value] of Object.entries(source)) {
      if (GO_ENV_KEYS.has(key) && value && !value.includes("$")) merged[key] = value;
    }
  }
  const moved = /(^|[\s;&|(])cd\s/.test(command.slice(0, build.index + 1)) ? "go build 之前 cd 到了别的目录" : undefined;
  const why = unsupported ?? moved;
  return { targets: targets.length > 0 ? targets : ["."], env: merged, ...(tags ? { tags } : {}), ...(goVersion ? { goVersion } : {}), ...(why ? { unsupported: why } : {}) };
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  const pairs = [...text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g)];
  if (pairs.length > 0) {
    for (const [, key, value] of pairs) env[key] = unquote(value);
    return env;
  }
  // 老写法：ENV KEY value
  const [, key, value] = /^([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/.exec(text.trim()) ?? [];
  if (key) env[key] = unquote(value);
  return env;
}

/** go build 后面的参数：去掉 -o、-ldflags 这类选项，剩下的是入口；-tags 留着 */
function parseGoBuild(text: string): { targets: string[]; tags?: string; unsupported?: string } {
  const words = [...text.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((m) => unquote(m[0]));
  const withValue = new Set(["-o", "-ldflags", "-gcflags", "-asmflags", "-tags", "-mod", "-modfile", "-p", "-buildmode", "-compiler", "-gccgoflags", "-installsuffix", "-pkgdir", "-overlay", "-pgo", "-toolexec", "-C"]);
  const targets: string[] = [];
  let tags: string | undefined;
  let unsupported: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.startsWith("-")) {
      const [flag, inlineValue] = word.split("=", 2);
      const value = inlineValue ?? (withValue.has(flag) ? words[++i] : undefined);
      if (flag === "-tags" && value) tags = value;
      // -C 换了目录再编：入口相对那个目录，照着编容易编错地方
      if (flag === "-C") unsupported = "Dockerfile 里的 go build 用了 -C 换目录";
      continue;
    }
    if (word.includes("$") || word.startsWith("/")) {
      continue;
    }
    targets.push(word);
  }
  return { targets, ...(tags ? { tags } : {}), ...(unsupported ? { unsupported } : {}) };
}

function unquote(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

async function checkPhp(
  dir: string,
  phpFiles: readonly string[],
  run: CommandRunner,
  { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal },
): Promise<BuildResult> {
  const errors: string[] = [];
  let checked = 0;
  for (const file of phpFiles) {
    if (!(await exists(path.join(dir, file)))) {
      continue;
    }
    // 写成 ./路径：文件名以 - 开头也不会被当成参数（php 的 -- 之后会去读标准输入，不能用）
    const result = await run("php", ["-l", `./${file}`], { cwd: dir, env: {}, signal, timeoutMs });
    if (result.missing) {
      return { state: "unknown", reason: "服务器上没装 PHP，没查语法" };
    }
    checked++;
    if (result.code !== 0) {
      errors.push(result.output.trim());
    }
  }
  if (errors.length > 0) {
    return { state: "failed", output: `php -l 查出语法错误：\n${errors.join("\n")}` };
  }
  return { state: "passed", summary: checked > 0 ? `php -l 查了 ${checked} 个文件，语法没问题` : "改的 PHP 文件都删掉了" };
}

/** 报错里提到了这次改的文件（按文件名找，报错里的路径可能是相对包目录的） */
function mentionsChanged(output: string, changed: readonly string[]): boolean {
  return changed.some((file) => output.includes(`${path.posix.basename(file)}:`));
}

function firstLines(output: string): string {
  return output.split("\n").slice(0, 3).join(" ").slice(0, 300);
}

function cut(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…（报错太长，后面省略）` : text;
}

async function readText(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 512 * 1024) return undefined;
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function isFile(file: string): Promise<boolean> {
  return stat(file).then(
    (info) => info.isFile(),
    () => false,
  );
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** 默认的跑命令：不经过 shell，超时或中止时杀掉；命令不存在时 missing */
const runCommand: CommandRunner = (command, args, { cwd, env, signal, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { cwd, env: { ...process.env, ...env, LC_ALL: "C.UTF-8" }, signal, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (signal?.aborted) {
          reject(err ?? new Error("aborted"));
          return;
        }
        const code = (err as { code?: unknown } | null)?.code;
        if (code === "ENOENT") {
          resolve({ code: -1, output: "", missing: true });
          return;
        }
        if (err && (err as { killed?: boolean }).killed) {
          resolve({ code: -1, output: `${stdout}${stderr}\n（超过 ${Math.round(timeoutMs / 1000)} 秒没编完，停了）` });
          return;
        }
        resolve({ code: typeof code === "number" ? code : err ? 1 : 0, output: `${stdout}${stderr}` });
      },
    );
  });
