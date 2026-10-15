import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * 推代码之前的编译检查：机器人跑不了仓库的测试，但能在服务器上编译一下，编不过的改动不推、不合。
 * 只编译不运行：Go 用 go build（关掉 cgo；项目要更新的 Go 时自动下载官方工具链），PHP 用 php -l 查语法。
 * 服务器上没装对应的工具时跳过，合并时退回到看平台上的流水线。
 */
export interface BuildChecker {
  check(dir: string, files: readonly string[], signal?: AbortSignal): Promise<BuildResult>;
}

export type BuildResult =
  /** 编过了（或者改的都不是要编译的文件）；summary 写查了什么 */
  | { state: "passed"; summary: string }
  /** 改到的文件编不过；output 是编译器的报错 */
  | { state: "failed"; output: string }
  /** 没编（没装工具、没有 go.mod），或者编不过但报错都在没改的文件上（本来就编不过）：说不清能不能编过 */
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

/** 报错最多带多少字给模型 */
const MAX_OUTPUT_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export function createBuildChecker(options: BuildCheckerOptions = {}): BuildChecker {
  const run = options.run ?? runCommand;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async check(dir, files, signal) {
      const goFiles = files.filter((file) => file.endsWith(".go"));
      const goModChanged = files.some((file) => file === "go.mod" || file === "go.sum");
      const phpFiles = files.filter((file) => file.endsWith(".php"));
      const done: string[] = [];
      const unknown: string[] = [];
      const failures: string[] = [];

      if (goFiles.length > 0 || goModChanged) {
        const result = await checkGo(dir, goFiles, goModChanged, files, run, { goproxy: options.goproxy, timeoutMs, signal });
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
      return { state: "passed", summary: done.length > 0 ? done.join("；") : "改的都不是要编译的代码文件" };
    },
  };
}

async function checkGo(
  dir: string,
  goFiles: readonly string[],
  goModChanged: boolean,
  changed: readonly string[],
  run: CommandRunner,
  { goproxy, timeoutMs, signal }: { goproxy?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<BuildResult> {
  if (!(await exists(path.join(dir, "go.mod")))) {
    return { state: "unknown", reason: "仓库根目录没有 go.mod，没编译 Go 代码" };
  }
  // 编改到的那几个包（删掉的文件所在的目录还在就编）；改了 go.mod 编整个仓库
  const dirs = new Set<string>();
  for (const file of goFiles) {
    const pkg = path.posix.dirname(file);
    if (await exists(path.join(dir, pkg))) {
      dirs.add(pkg === "." ? "." : `./${pkg}`);
    }
  }
  const packages = goModChanged ? ["./..."] : [...dirs];
  if (packages.length === 0) {
    return { state: "passed", summary: "改的 Go 文件都删掉了，没有要编译的包" };
  }
  // 编出来的程序放到临时目录，编完就删，不留在工作目录里
  const out = await mkdtemp(path.join(tmpdir(), "agenttag-build-"));
  try {
    const result = await run("go", ["build", "-o", `${out}${path.sep}`, ...packages], {
      cwd: dir,
      env: {
        CGO_ENABLED: "0",
        // 项目要的 Go 比装的新时，按 go.mod 自动从代理下载那个版本的官方工具链（有校验）；比装的旧的直接编
        GOTOOLCHAIN: "auto",
        GOFLAGS: "",
        GOPROXY: goproxy || process.env.GOPROXY || "https://goproxy.cn,direct",
        // 校验下载的依赖和工具链：用官方的国内地址，服务器在国内连不上 sum.golang.org
        GOSUMDB: process.env.GOSUMDB || "sum.golang.google.cn",
      },
      signal,
      timeoutMs,
    });
    if (result.missing) {
      return { state: "unknown", reason: "服务器上没装 Go，没编译" };
    }
    if (result.code === 0) {
      return { state: "passed", summary: `go build ${packages.join(" ")} 编过了` };
    }
    const output = result.output.trim();
    // 报错都在没改的文件上：多半是这些包本来就编不过（比如一个目录里有两个 main），说不清是不是这次改坏的
    return mentionsChanged(output, changed) ? { state: "failed", output: `go build ${packages.join(" ")} 编不过：\n${output}` } : { state: "unknown", reason: `go build 编不过，但报错都不在这次改的文件上（可能本来就编不过）：${firstLines(output)}` };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
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
