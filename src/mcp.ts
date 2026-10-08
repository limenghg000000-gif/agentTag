import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type CallToolResult, ErrorCode, McpError, type Tool as RemoteTool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config.js";
import type { Logger } from "./history.js";
import { formatToolResult, MCP_RESULT_LIMIT, resultText } from "./mcp-result.js";
import type { Tool } from "./tools/tool.js";

/** 普通工具的超时。个别工具在配置里单独定，如 aiops 的 diagnose_service 两分钟 */
export const DEFAULT_MCP_TIMEOUT_MS = 60_000;
/** 一次任务里同一个 MCP 服务的工具最多调几次，到了就让模型按已有证据回答 */
export const MAX_MCP_CALLS_PER_TASK = 10;
/** 一次任务里同一个 MCP 服务的结果一共交给模型多少字。快用完时后面的结果截得更短，免得撑爆上下文 */
export const MAX_MCP_CHARS_PER_TASK = 150_000;
/** 总字数快用完或用完时，单个结果至少还给这么多字（加上调用次数的上限，一次任务最多比总字数多出 3 个这么多） */
const MIN_RESULT_CHARS = 6000;
/** 服务端说「服务繁忙」时隔多久重试，重试几次就有几项 */
const BUSY_RETRY_MS = [1000, 3000];
/** 多久重新连一次、刷新工具清单和使用说明 */
const REFRESH_MS = 10 * 60_000;
/** 连不上时隔多久重试，用完后一直按最后一项 */
const RETRY_MS = [30_000, 60_000, 120_000, 300_000];
/** 连接和拉清单的超时 */
const CONNECT_TIMEOUT_MS = 20_000;
/** 刷新后旧连接再留多久才关，让还在进行的调用跑完 */
const RETIRE_MS = 3 * 60_000;
/** 调用遇到 HTTP 层的错误时马上重连一次，但两次重连至少隔这么久 */
const RESYNC_GAP_MS = 30_000;
/** 服务端使用说明写进提示词的字数上限 */
const MAX_INSTRUCTIONS_CHARS = 8000;

const BUSY = /服务繁忙|server (is )?busy|too many (concurrent )?requests/i;
/** 名字里带这些动词的工具算「会写东西」，宁可多拦 */
const WRITE_VERB =
  /(^|_)(create|save|update|delete|remove|archive|restart|scale|exec|apply|patch|rollback|silence|set|put|write|edit|deploy|kill|drain|cordon|evict|upsert|insert)(_|$)/;
/** 进度卡片上跟在步骤名后面的对象：按顺序取第一个有值的参数 */
const SUBJECT_KEYS = [
  "workload",
  "name",
  "service",
  "service_name",
  "pod_name",
  "resource_name",
  "trace_id",
  "case_id",
  "id",
  "label",
  "alertname",
  "keywords",
  "text",
  "logql",
  "promql",
  "query",
];

/** MCP 工具调用要记进审计日志的信息 */
export interface McpTaskContext {
  chatId: string;
  /** 发起人的 open_id */
  senderId: string;
  messageId: string;
}

export interface McpHubOptions {
  logger?: Logger;
  /** 以下几项测试时调短 */
  refreshMs?: number;
  retryMs?: readonly number[];
  busyRetryMs?: readonly number[];
  now?: () => number;
}

/** 会写东西的工具：配置里点名的，加上名字里带 create、save、delete 这类动词的 */
export function isWriteTool(name: string, extra: readonly string[] = []): boolean {
  const snake = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[.-]/g, "_").toLowerCase();
  return extra.includes(name) || WRITE_VERB.test(snake);
}

interface ServerState {
  config: McpServerConfig;
  conn: McpConnection;
  /** 开给模型的工具（服务端的原始定义） */
  enabled: RemoteTool[];
  instructions?: string;
  /** 飞书这边的补充说明（promptFile 的内容） */
  prompt?: string;
  /** 连上过（之后刷新失败也沿用上次的清单） */
  synced: boolean;
  /** 正在进行的同步，同一时间只有一个 */
  syncing?: Promise<void>;
  /** 上次开始同步的时间 */
  syncedAt: number;
  failures: number;
  /** 上次打到日志里的清单摘要，没变就不重复打 */
  logged?: string;
  timer?: NodeJS.Timeout;
}

interface TaskBudget {
  calls: number;
  /** 已经交给模型的字数 */
  chars: number;
  /** 同一工具同样的参数直接复用结果；失败的不留 */
  results: Map<string, { at: number; text: Promise<string> }>;
}

/**
 * 通过 MCP 接入的外部服务（如 aiops）。启动后在后台连接、拉工具清单和服务端的使用说明，定时刷新；连不上不影响机器人，按退避重试。
 * 每个任务单独拿一套工具（tools），调用次数和同参去重按任务算，每次调用都记审计日志（谁、哪个群、哪个工具、参数摘要、结果大小、用时）。
 */
export class McpHub {
  private readonly servers: ServerState[];
  private readonly logger: Logger;
  private readonly refreshMs: number;
  private readonly retryMs: readonly number[];
  private readonly busyRetryMs: readonly number[];
  private readonly now: () => number;
  private stopped = false;

  constructor(configs: readonly McpServerConfig[], options: McpHubOptions = {}) {
    this.logger = options.logger ?? console;
    this.refreshMs = options.refreshMs ?? REFRESH_MS;
    this.retryMs = options.retryMs ?? RETRY_MS;
    this.busyRetryMs = options.busyRetryMs ?? BUSY_RETRY_MS;
    this.now = options.now ?? Date.now;
    this.servers = configs.map((config) => ({
      config,
      conn: new McpConnection(config, this.logger),
      enabled: [],
      synced: false,
      syncedAt: 0,
      failures: 0,
    }));
  }

  get names(): string[] {
    return this.servers.map((server) => server.config.name);
  }

  /** 连接所有服务，等第一次连接有了结果（成功或失败）就返回，不抛错；之后在后台定时刷新、失败重试 */
  async start(): Promise<void> {
    await Promise.all(this.servers.map((server) => this.sync(server)));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const server of this.servers) {
      clearTimeout(server.timer);
    }
    await Promise.all(this.servers.map((server) => server.conn.close()));
  }

  /** 给一个任务用的 MCP 工具，名字带服务名前缀（aiops_diagnose_service） */
  tools(task: McpTaskContext): Tool[] {
    return this.servers.flatMap((server) => {
      const budget: TaskBudget = { calls: 0, chars: 0, results: new Map() };
      return server.enabled.map((remote) => this.wrap(server, remote, task, budget));
    });
  }

  /**
   * 写进系统提示词的说明：这次任务带了哪个服务的工具，就写那个服务的使用说明（服务端下发的 + 飞书这边的补充）；
   * 配了但还没连上的服务说明一句，免得模型凭空回答
   */
  prompt(toolNames: readonly string[]): string | undefined {
    const sections = this.servers.flatMap((server) => {
      const { name } = server.config;
      if (toolNames.some((tool) => tool.startsWith(`${name}_`))) {
        return [this.serverPrompt(server)];
      }
      if (!server.synced) {
        return [
          `## ${name}（MCP 服务）\n` +
            `- ${name} 现在连不上（程序在自动重连），这次没有 ${name}_ 开头的工具。有人要用 ${name} 查东西时如实说明，请他稍后再试，不要凭印象编结果。`,
        ];
      }
      return [];
    });
    return sections.length > 0 ? sections.join("\n\n") : undefined;
  }

  private serverPrompt(server: ServerState): string {
    const { name } = server.config;
    const example = server.enabled[0]?.name ?? "tool";
    const lines = [
      `## ${name}（MCP 服务）`,
      `名字以 ${name}_ 开头的工具都来自 ${name}。${name} 的说明里写的工具名（如 ${example}）在你这里都带 ${name}_ 前缀（${toolName(name, example)}）。` +
        `一次任务里 ${name} 的工具最多调 ${MAX_MCP_CALLS_PER_TASK} 次，同样的参数调第二次会直接拿到上次的结果。`,
    ];
    if (server.instructions) {
      lines.push("", `### ${name} 服务端的使用说明`, clip(server.instructions, MAX_INSTRUCTIONS_CHARS));
    }
    if (server.prompt) {
      lines.push("", `### 在飞书群里用 ${name}`, server.prompt);
    }
    return lines.join("\n");
  }

  private sync(server: ServerState): Promise<void> {
    server.syncing ??= this.doSync(server).finally(() => {
      server.syncing = undefined;
    });
    return server.syncing;
  }

  /** 调用遇到 HTTP 层的错误（服务端重启、会话失效、令牌改了）时马上重连，不等下一次定时刷新 */
  private resyncSoon(server: ServerState): void {
    if (!server.syncing && this.now() - server.syncedAt >= RESYNC_GAP_MS) {
      void this.sync(server);
    }
  }

  private async doSync(server: ServerState): Promise<void> {
    if (this.stopped) {
      return;
    }
    server.syncedAt = this.now();
    const { name, url } = server.config;
    try {
      const synced = await server.conn.sync();
      server.instructions = synced.instructions?.trim() || undefined;
      server.prompt = await this.readPrompt(server.config);
      const picked = pickTools(server.config, synced.tools);
      server.enabled = picked.enabled;
      server.synced = true;
      server.failures = 0;
      const key = JSON.stringify([synced.version, picked, server.instructions?.length, server.prompt?.length]);
      if (key !== server.logged) {
        server.logged = key;
        this.logTools(server, synced, picked);
      }
      this.schedule(server, this.refreshMs);
    } catch (err) {
      if (this.stopped) {
        return;
      }
      const wait = this.retryMs[Math.min(server.failures, this.retryMs.length - 1)];
      server.failures++;
      const reason = describeConnectError(err, server.config);
      if (server.synced) {
        this.logger.warn(`MCP ${name} 刷新失败：${reason}。先沿用上次的工具清单，${wait / 1000} 秒后重试`);
      } else {
        this.logger.warn(`MCP ${name} 连不上（${url}）：${reason}。${wait / 1000} 秒后重试；机器人照常运行，这期间没有 ${name} 的工具`);
      }
      server.logged = undefined;
      this.schedule(server, wait);
    }
  }

  private schedule(server: ServerState, ms: number): void {
    clearTimeout(server.timer);
    if (!this.stopped) {
      server.timer = setTimeout(() => void this.sync(server), ms);
      server.timer.unref();
    }
  }

  private logTools(server: ServerState, synced: SyncResult, picked: PickedTools): void {
    const { name, url } = server.config;
    const key = `MCP_${name.toUpperCase()}`;
    const extras = [
      synced.version,
      server.instructions ? `服务端使用说明 ${server.instructions.length} 字` : "服务端没有下发使用说明",
      server.prompt ? `飞书补充说明 ${server.config.promptFile}` : "",
    ].filter(Boolean);
    this.logger.info(
      `MCP ${name}：已连上 ${url}，服务端 ${synced.tools.length} 个工具，开了 ${picked.enabled.length} 个` +
        `（${extras.join("，")}）：${picked.enabled.map((tool) => tool.name).join(", ") || "无"}`,
    );
    if (picked.notEnabled.length > 0) {
      this.logger.info(`MCP ${name}：服务端还有 ${picked.notEnabled.length} 个工具没开：${picked.notEnabled.join(", ")}（要开就加进 ${key}_TOOLS）`);
    }
    if (picked.skippedWrites.length > 0) {
      this.logger.warn(
        `MCP ${name}：${picked.skippedWrites.join(", ")} 会写东西（或服务端没标成只读），这一版先不开（写工具要等发起人确认的卡片做好）`,
      );
    }
    if (picked.clashes.length > 0) {
      this.logger.warn(`MCP ${name}：${picked.clashes.join(", ")} 换成机器人的工具名后和别的工具重名，先不开`);
    }
    if (picked.missing.length > 0) {
      this.logger.warn(`MCP ${name}：${key}_TOOLS 里的 ${picked.missing.join(", ")} 服务端没有，先跳过`);
    }
  }

  private async readPrompt(config: McpServerConfig): Promise<string | undefined> {
    try {
      // HTML 注释是写给维护的人看的，不发给模型
      const text = (await readFile(config.promptFile, "utf8")).replace(/<!--[\s\S]*?-->/g, "").trim();
      return text || undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(`MCP ${config.name}：读不了使用说明文件 ${config.promptFile}`, err);
      }
      return undefined;
    }
  }

  private wrap(server: ServerState, remote: RemoteTool, task: McpTaskContext, budget: TaskBudget): Tool {
    const { name, labels, timeoutsMs } = server.config;
    const timeout = timeoutsMs[remote.name] ?? DEFAULT_MCP_TIMEOUT_MS;
    return {
      spec: {
        name: toolName(name, remote.name),
        description: remote.description || remote.title || remote.name,
        parameters: toolParameters(remote),
      },
      maxOutputChars: MCP_RESULT_LIMIT + 1000,
      describe: (args) => `${name} · ${stepLabel(labels[remote.name] ?? remote.name, args)}`,
      run: async (args, { signal }) => {
        const key = `${remote.name} ${stableJson(args)}`;
        const previous = budget.results.get(key);
        if (previous) {
          const text = await previous.text;
          const ago = Math.round((this.now() - previous.at) / 1000);
          return `（这次任务里已经用同样的参数调过 ${remote.name}，没有再调，下面是 ${ago} 秒前那次的结果）\n${text}`;
        }
        if (budget.calls >= MAX_MCP_CALLS_PER_TASK) {
          throw new Error(
            `这次任务里 ${name} 的工具已经调了 ${MAX_MCP_CALLS_PER_TASK} 次，到上限了，这次没有执行。请按已有的证据回答，写明还缺哪些证据、建议接着查什么`,
          );
        }
        budget.calls++;
        // 先按这次的上限把字数占住，同一轮并行的几个调用加起来也不会超出总字数；拿到结果后按实际字数退回多占的
        const limit = Math.min(MCP_RESULT_LIMIT, Math.max(MIN_RESULT_CHARS, MAX_MCP_CHARS_PER_TASK - budget.chars));
        budget.chars += limit;
        const pending = this.invoke(server, remote.name, args, task, signal, timeout, limit).then(
          (text) => {
            budget.chars += text.length - limit;
            return text;
          },
          (err: unknown) => {
            budget.chars -= limit;
            throw err;
          },
        );
        budget.results.set(key, { at: this.now(), text: pending });
        pending.catch(() => budget.results.delete(key));
        return pending;
      },
    };
  }

  private async invoke(
    server: ServerState,
    tool: string,
    args: Record<string, unknown>,
    task: McpTaskContext,
    signal: AbortSignal,
    timeout: number,
    limit: number,
  ): Promise<string> {
    const { name } = server.config;
    const startedAt = this.now();
    let retries = 0;
    const audit = (outcome: string, failed = false) => {
      const line =
        `MCP 调用 ${name}.${tool} chat=${task.chatId} sender=${task.senderId} message=${task.messageId} ` +
        `参数=${clip(JSON.stringify(args), 300)} ${outcome} 用时=${this.now() - startedAt}ms${retries > 0 ? ` 繁忙重试=${retries}` : ""}`;
      if (failed) {
        this.logger.warn(line);
      } else {
        this.logger.info(line);
      }
    };

    let result: CallToolResult;
    try {
      for (;;) {
        result = await server.conn.call(tool, args, { signal, timeout });
        const busy = result.isError === true && BUSY.test(resultText(result));
        if (!busy || retries >= this.busyRetryMs.length) {
          break;
        }
        await delay(this.busyRetryMs[retries++], undefined, { signal });
      }
    } catch (err) {
      if (signal.aborted) {
        audit("已停止");
        throw err;
      }
      // HTTP 层或网络的错误（服务端重启、会话失效、令牌改了）马上重连；工具自己的报错和超时不用
      if (!(err instanceof McpError)) {
        this.resyncSoon(server);
      }
      const message = describeCallError(err, server.config, tool, timeout);
      audit(`失败：${message}`, true);
      throw new Error(message);
    }

    const raw = resultText(result);
    if (result.isError) {
      const message = BUSY.test(raw)
        ? `${name} 服务繁忙（并发满了），重试 ${retries} 次还是不行：${clip(raw, 300)}。可以稍后再试，或者先按已有的证据回答`
        : `${name} 返回错误：${clip(raw, 2000)}`;
      audit(`出错 结果=${raw.length}字：${clip(raw, 200)}`, true);
      throw new Error(message);
    }
    const text = formatToolResult(result, limit);
    audit(`结果=${raw.length}字${text.length !== raw.length ? `→${text.length}字` : ""}`);
    return text;
  }
}

interface SyncResult {
  tools: RemoteTool[];
  instructions?: string;
  /** 服务端的名字和版本，如「aiops-mcp 0.14.0」 */
  version?: string;
}

/**
 * 一个 MCP 服务（Streamable HTTP）的连接。令牌用 Authorization: Bearer 头发送。
 * 每次同步都新建一个连接（initialize 拿到最新的使用说明，再拉工具清单），成功后换上，旧连接留一会儿让进行中的调用跑完再关。
 */
class McpConnection {
  private client?: Client;
  private closed = false;
  /** 上一句传输层的后台错误。每次刷新都新建连接，同一句不重复记 */
  private lastError = "";

  constructor(
    private readonly config: McpServerConfig,
    private readonly logger: Logger,
  ) {}

  async sync(): Promise<SyncResult> {
    const client = new Client({ name: "agenttag", version: "0.1.0" });
    // 传输层的后台错误（比如服务端推送用的 SSE 流断了）不影响调用，只记日志
    client.onerror = (err) => {
      if (err.message !== this.lastError) {
        this.lastError = err.message;
        this.logger.warn(`MCP ${this.config.name}：${err.message}`);
      }
    };
    const transport = new StreamableHTTPClientTransport(
      new URL(this.config.url),
      this.config.token ? { requestInit: { headers: { authorization: `Bearer ${this.config.token}` } } } : {},
    );
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      const tools: RemoteTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor && tools.length < 1000);
      if (this.closed) {
        throw new Error("已停止");
      }
      const server = client.getServerVersion();
      const retired = this.client;
      this.client = client;
      if (retired) {
        setTimeout(() => void retired.close().catch(() => {}), RETIRE_MS).unref();
      }
      return { tools, instructions: client.getInstructions(), version: server && `${server.name} ${server.version}` };
    } catch (err) {
      void client.close().catch(() => {});
      throw err;
    }
  }

  async call(name: string, args: Record<string, unknown>, options: { signal: AbortSignal; timeout: number }): Promise<CallToolResult> {
    if (!this.client) {
      throw new Error(`还没连上 ${this.config.name}`);
    }
    return (await this.client.callTool({ name, arguments: args }, undefined, options)) as CallToolResult;
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
  }
}

interface PickedTools {
  enabled: RemoteTool[];
  /** 换成机器人的工具名后和前面的重名，没开 */
  clashes: string[];
  /** 服务端有、没开的 */
  notEnabled: string[];
  /** 要开、但会写东西（或者按 * 开时服务端没标成只读），这一版不开的 */
  skippedWrites: string[];
  /** 点名要开、服务端没有的 */
  missing: string[];
}

function pickTools(config: McpServerConfig, tools: readonly RemoteTool[]): PickedTools {
  const wanted = config.tools === "*" ? undefined : new Set(config.tools);
  const requested = tools.filter((tool) => !wanted || wanted.has(tool.name));
  const names = new Set(tools.map((tool) => tool.name));
  const taken = new Set<string>();
  const clashes: string[] = [];
  const enabled = requested.filter((tool) => {
    if (mayWrite(tool, config, !wanted)) {
      return false;
    }
    const name = toolName(config.name, tool.name);
    if (taken.has(name)) {
      clashes.push(tool.name);
      return false;
    }
    taken.add(name);
    return true;
  });
  return {
    enabled,
    clashes,
    notEnabled: tools.filter((tool) => wanted && !wanted.has(tool.name)).map((tool) => tool.name),
    skippedWrites: requested.filter((tool) => mayWrite(tool, config, !wanted)).map((tool) => tool.name),
    missing: wanted ? [...wanted].filter((name) => !names.has(name)) : [],
  };
}

/**
 * 这一版不开的工具：配置里点名的写工具、名字里带写操作动词的、服务端标了 readOnlyHint=false 的；
 * 按 * 开全部时，服务端没明确标成只读（readOnlyHint=true）的也不开。服务端的标注只用来多拦，不能让上面拦下的工具放行
 */
function mayWrite(tool: RemoteTool, config: McpServerConfig, wildcard: boolean): boolean {
  const readOnly = tool.annotations?.readOnlyHint;
  return isWriteTool(tool.name, config.writeTools) || readOnly === false || (wildcard && readOnly !== true);
}

/** 交给模型的工具名：服务名_工具名，只留 OpenAI 函数名允许的字符 */
function toolName(server: string, tool: string): string {
  return `${server}_${tool}`.replace(/[^\w-]/g, "_").slice(0, 64);
}

/** 参数照搬服务端的 inputSchema，补齐 type 和 properties */
function toolParameters(tool: RemoteTool): Record<string, unknown> {
  const { $schema: _schema, ...schema } = tool.inputSchema as Record<string, unknown>;
  return { ...schema, type: "object", properties: schema.properties ?? {} };
}

/** 进度卡片上的一步，如「诊断 gateway-api（prod，error_log）」 */
function stepLabel(label: string, args: Record<string, unknown>): string {
  const subject = SUBJECT_KEYS.map((key) => args[key]).find(
    (value) => (typeof value === "string" && value.trim()) || typeof value === "number",
  );
  const extras = [args.namespace, args.scenario].filter((value): value is string => typeof value === "string" && !!value.trim());
  const head = subject === undefined ? label : `${label} ${clip(String(subject).replace(/\s+/g, " ").trim(), 40)}`;
  return extras.length > 0 ? `${head}（${extras.join("，")}）` : head;
}

/** 键排好序的 JSON，参数顺序不同也算同样的调用 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** 连接失败的原因，写进日志 */
function describeConnectError(err: unknown, config: McpServerConfig): string {
  if (err instanceof StreamableHTTPError && (err.code === 404 || err.code === 401 || err.code === 403)) {
    // aiops 令牌不对时回 404，不是 401
    return `HTTP ${err.code}，令牌或地址不对（检查 MCP_${config.name.toUpperCase()}_TOKEN 和 MCP_SERVERS 里的地址）`;
  }
  return describeError(err);
}

/** 调用失败的原因，交给模型（会转告到群里），不带令牌 */
function describeCallError(err: unknown, config: McpServerConfig, tool: string, timeout: number): string {
  const { name } = config;
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
    return `${name} 的 ${tool} 超时（${timeout / 1000} 秒没返回）。可以缩小时间范围、加过滤条件后再试，或者改用更具体的单项工具`;
  }
  if (err instanceof StreamableHTTPError && (err.code === 404 || err.code === 401 || err.code === 403)) {
    return `${name} 拒绝了请求（HTTP ${err.code}）：可能是机器人配置的 ${name} 令牌或地址不对，也可能是服务端刚重启（程序已在重新连接）。稍后再试一次，还不行就请管理员检查`;
  }
  return `调用 ${name} 失败：${describeError(err)}`;
}

function describeError(err: unknown): string {
  if (err instanceof StreamableHTTPError) {
    return `HTTP ${err.code}：${clip(err.message, 200)}`;
  }
  if (err instanceof Error) {
    // fetch 连不上时 message 只有「fetch failed」，原因在 cause 里
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message;
    return clip(detail ? `${err.message}（${detail}）` : err.message, 300);
  }
  return String(err);
}
