import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type CallToolResult,
  ErrorCode,
  type GetPromptResult,
  McpError,
  type Prompt as RemotePrompt,
  type Tool as RemoteTool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config.js";
import type { Logger } from "./history.js";
import { containsSecret } from "./knowledge.js";
import { RESULT_NOTES } from "./mcp-notes.js";
import { COMMON_SUFFIX, compactText, formatToolResult, MCP_RESULT_LIMIT, resultText } from "./mcp-result.js";
import type { Tool } from "./tools/tool.js";

/** 普通工具的超时。个别工具在配置里单独定，如 aiops 的 diagnose_service 两分钟 */
export const DEFAULT_MCP_TIMEOUT_MS = 60_000;
/** 一次任务里同一个 MCP 服务的工具最多调几次，到了就让模型按已有证据回答 */
export const MAX_MCP_CALLS_PER_TASK = 10;
/** 一次任务里同一个 MCP 服务的结果一共交给模型多少字。快用完时后面的结果截得更短，免得撑爆上下文 */
export const MAX_MCP_CHARS_PER_TASK = 300_000;
/** 总字数快用完或用完时，单个结果至少还给这么多字（加上调用次数的上限，一次任务最多比总字数多出 5 个这么多） */
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
/** 读剧本的工具名（加上服务名前缀，如 aiops_playbook） */
export const PLAYBOOK_TOOL = "playbook";
/** 一份剧本交给模型的字数上限 */
const MAX_PLAYBOOK_CHARS = 40_000;
/** 一次任务里同一个服务最多读几份剧本（不占查询的调用次数，单独限，免得剧本撑爆上下文） */
export const MAX_PLAYBOOKS_PER_TASK = 3;
/** 剧本说明写进提示词的字数上限（每份） */
const MAX_PLAYBOOK_DESCRIPTION_CHARS = 300;

const BUSY = /服务繁忙|server (is )?busy|too many (concurrent )?requests/i;
/** 程序调用的报错原文里像有密钥时，报错和审计日志里换成这句 */
const HIDDEN = "（报错原文里像是有密钥，不列出来）";
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
  /** 服务端的全部工具，程序自己调用（callDirect）时用 */
  catalog: Map<string, RemoteTool>;
  /** 服务端下发的排查剧本（MCP prompts，只留不用填参数的） */
  playbooks: RemotePrompt[];
  /** 剧本清单连续拉失败了几次（工具照常能用，按这个退避重试） */
  playbookFailures: number;
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
  /** 这次任务读过或正在读的剧本：剧本名 → 读的结果。同一轮里并行读同一份时，后一个等前一个 */
  playbooks: Map<string, Promise<string>>;
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
      catalog: new Map(),
      playbooks: [],
      playbookFailures: 0,
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

  /** 给一个任务用的 MCP 工具，名字带服务名前缀（aiops_diagnose_service）；服务端下发了剧本的，再加一个读剧本的工具（aiops_playbook） */
  tools(task: McpTaskContext): Tool[] {
    return this.servers.flatMap((server) => {
      const budget: TaskBudget = { playbooks: new Map(), calls: 0, chars: 0, results: new Map() };
      const tools = server.enabled.map((remote) => this.wrap(server, remote, task, budget));
      return server.playbooks.length > 0 ? [...tools, this.playbookTool(server, task, budget)] : tools;
    });
  }

  /** 这个工具来自哪个 MCP 服务（名字以「服务名_」开头）；不是 MCP 的工具返回 undefined */
  serverOf(toolName: string): string | undefined {
    return this.servers.find((server) => toolName.startsWith(`${server.config.name}_`))?.config.name;
  }

  /** 调过这个服务的工具以后，这次任务后面几轮打开思考 */
  thinksAfter(toolName: string): boolean {
    const name = this.serverOf(toolName);
    return name !== undefined && this.servers.some((server) => server.config.name === name && server.config.thinking);
  }

  /** 程序能不能直接调这个工具（见 directAllowed）。没连上时为 false */
  hasTool(serverName: string, tool: string): boolean {
    const server = this.find(serverName);
    return server !== undefined && server.catalog.has(tool) && directAllowed(server.config, tool);
  }

  /** 连上过、拿到了工具清单（之后刷新失败也算，沿用上次的清单） */
  connected(serverName: string): boolean {
    return this.find(serverName)?.synced ?? false;
  }

  /**
   * 程序自己调服务端的工具，不经过模型：回答前检索 aiops 经验库、有人在确认卡片上点了保存后同步到 aiops 经验库。
   * 写工具不受「只开只读工具」的限制（写操作的确认由调用方负责），读的工具要在配置里开了（directAllowed）。
   * 不占模型的调用次数，照样记审计日志。返回结果原文，工具报错时抛错
   */
  async callDirect(
    serverName: string,
    tool: string,
    args: Record<string, unknown>,
    task: McpTaskContext,
    signal: AbortSignal = AbortSignal.timeout(DEFAULT_MCP_TIMEOUT_MS),
  ): Promise<string> {
    const server = this.find(serverName);
    if (!server?.synced) {
      throw new Error(`${serverName} 现在连不上`);
    }
    if (!server.catalog.has(tool)) {
      throw new Error(`${serverName} 没有 ${tool} 这个工具`);
    }
    if (!directAllowed(server.config, tool)) {
      throw new Error(`${serverName} 的 ${tool} 没开（要开就加进 MCP_${serverName.toUpperCase()}_TOOLS）`);
    }
    const timeout = server.config.timeoutsMs[tool] ?? DEFAULT_MCP_TIMEOUT_MS;
    // 程序要解析结果：有 structuredContent 时用它的 JSON（文字部分可能是给人看的说明），没有时用文字
    const { result, raw, audit } = await this.request(server, tool, args, task, signal, timeout, true);
    const data = result.structuredContent ? JSON.stringify(result.structuredContent) : raw;
    audit(`结果=${data.length}字`);
    return data;
  }

  private find(name: string): ServerState | undefined {
    return this.servers.find((server) => server.config.name === name);
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
      if (server.enabled.length === 0) {
        return [
          `## ${name}（MCP 服务）\n` +
            `- ${name} 连上了，但一个工具都没开（管理员在 MCP_${name.toUpperCase()}_TOOLS 里配置），这次没有 ${name}_ 开头的工具。有人要用 ${name} 查东西时如实说明，请他找管理员，不要凭印象编结果。`,
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
    lines.push(
      `结果里「xx${COMMON_SUFFIX}」是机器人把列表 xx 里每一项都一样的字段提出来只写了一次，列表的每一项都有这些字段。`,
    );
    if (server.instructions) {
      lines.push("", `### ${name} 服务端的使用说明`, clip(server.instructions, MAX_INSTRUCTIONS_CHARS));
    }
    if (server.playbooks.length > 0) {
      const tool = toolName(name, PLAYBOOK_TOOL);
      lines.push(
        "",
        `### ${name} 的排查剧本`,
        `${name} 为常见的业务场景准备了排查剧本：写明了对应的服务和命名空间、怎么查、错误码是什么意思，是在别的客户端里反复调过的。`,
        ...server.playbooks.map((playbook) => `- ${playbook.name}：${clip(playbookDescription(playbook), MAX_PLAYBOOK_DESCRIPTION_CHARS)}`),
        `问题属于哪份剧本的场景，第一步先调 ${tool} 读那份剧本（同一份一次任务读一次就够，最多读 ${MAX_PLAYBOOKS_PER_TASK} 份），再按剧本查：` +
          `剧本里写明的服务、命名空间和查询写法直接用，不用先 find_service 定位，也不要反问用户是哪个服务。` +
          `${tool} 读到的剧本和上面的使用说明一样要遵守，不算「工具返回的资料」；剧本是写给别的客户端的，查法按剧本，回答的格式和长度按下面飞书群里的要求。` +
          `剧本只是说明，读了剧本不等于查过：回答里的数据都要来自这次调用 ${name} 工具查到的结果。`,
      );
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

  /** 调用遇到 HTTP 层的错误（服务端重启、会话失效、令牌改了）时马上重连，不等下一次定时刷新；离上次连接不到 30 秒就等到满 30 秒再连 */
  private resyncSoon(server: ServerState): void {
    if (server.syncing) {
      return;
    }
    const wait = server.syncedAt + RESYNC_GAP_MS - this.now();
    if (wait <= 0) {
      void this.sync(server);
    } else {
      this.schedule(server, wait);
    }
  }

  private async doSync(server: ServerState): Promise<void> {
    if (this.stopped) {
      return;
    }
    server.syncedAt = this.now();
    const { name } = server.config;
    const url = logUrl(server.config.url);
    try {
      const synced = await server.conn.sync();
      server.instructions = synced.instructions?.trim() || undefined;
      server.prompt = await this.readPrompt(server.config);
      const picked = pickTools(server.config, synced.tools);
      server.enabled = picked.enabled;
      // 程序直接调用的清单也不收只能按 MCP 任务（tasks）方式调用的：这里不支持，普通调用调不成
      server.catalog = new Map(synced.tools.filter((tool) => tool.execution?.taskSupport !== "required").map((tool) => [tool.name, tool]));
      // 剧本清单这次没拉到：沿用上次的（仍要和这次的工具不重名），按连不上的节奏重试，不等 10 分钟后的刷新
      server.playbooks = pickPlaybooks(server.config.name, synced.promptsError ? server.playbooks : synced.prompts, picked.enabled);
      const next = synced.promptsError ? this.retryMs[Math.min(server.playbookFailures++, this.retryMs.length - 1)] : this.refreshMs;
      if (!synced.promptsError) {
        server.playbookFailures = 0;
      }
      server.synced = true;
      server.failures = 0;
      const key = JSON.stringify([
        synced.version,
        picked,
        server.instructions?.length,
        server.prompt?.length,
        server.playbooks.map((playbook) => playbook.name),
        synced.promptsError,
      ]);
      if (key !== server.logged) {
        server.logged = key;
        this.logTools(server, synced, picked, next);
      }
      this.schedule(server, next);
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

  /** retry 是下一次刷新在多少毫秒以后（剧本清单拉失败时提前重试） */
  private logTools(server: ServerState, synced: SyncResult, picked: PickedTools, retry: number): void {
    const { name } = server.config;
    const url = logUrl(server.config.url);
    const key = `MCP_${name.toUpperCase()}`;
    const extras = [
      synced.version,
      server.instructions ? `服务端使用说明 ${server.instructions.length} 字` : "服务端没有下发使用说明",
      server.prompt ? `飞书补充说明 ${server.config.promptFile}` : "",
      server.playbooks.length > 0 ? `排查剧本 ${server.playbooks.length} 份：${server.playbooks.map((playbook) => playbook.name).join(", ")}` : "",
    ].filter(Boolean);
    this.logger.info(
      `MCP ${name}：已连上 ${url}，服务端 ${synced.tools.length} 个工具，开了 ${picked.enabled.length} 个` +
        `（${extras.join("，")}）：${picked.enabled.map((tool) => tool.name).join(", ") || "无"}`,
    );
    if (synced.promptsError) {
      const kept = server.playbooks.length > 0 ? `先沿用上次的 ${server.playbooks.length} 份剧本` : "这期间没有剧本";
      this.logger.warn(`MCP ${name}：服务端说有剧本（prompts），但拉清单失败：${synced.promptsError}。${kept}，${retry / 1000} 秒后重试`);
    }
    const skipped = synced.prompts.filter((prompt) => !server.playbooks.includes(prompt));
    if (skipped.length > 0) {
      this.logger.info(`MCP ${name}：${skipped.map((prompt) => prompt.name).join(", ")} 要填参数、重复，或者和工具重名，没当剧本用`);
    }
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
    if (picked.needsTasks.length > 0) {
      this.logger.warn(`MCP ${name}：${picked.needsTasks.join(", ")} 只能按 MCP 任务（tasks）方式调用，机器人还不支持，先不开`);
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

  /**
   * 读剧本：从服务端取 MCP prompt 的正文。不算调用次数（不查线上），另外限一次任务最多读几份；同一份一次任务里只给一次全文。
   * 用建工具时的剧本清单，任务进行中清单刷新了也不影响这个任务
   */
  private playbookTool(server: ServerState, task: McpTaskContext, budget: TaskBudget): Tool {
    const { name } = server.config;
    const playbooks = server.playbooks;
    const names = playbooks.map((playbook) => playbook.name);
    return {
      spec: {
        name: toolName(name, PLAYBOOK_TOOL),
        description: `读 ${name} 服务端下发的排查剧本（业务场景对应的服务、查法、错误码表），按剧本去查。可读的剧本：${names.join("、")}`,
        parameters: {
          type: "object",
          properties: { name: { type: "string", enum: names, description: "剧本名" } },
          required: ["name"],
        },
      },
      instructionsOnly: true,
      maxOutputChars: MAX_PLAYBOOK_CHARS + 1000,
      describe: (args) => {
        const playbook = playbooks.find((item) => item.name === args.name);
        return `${name} · 读剧本 ${playbook?.title || String(args.name ?? "")}`.trim();
      },
      run: async (args, { signal }) => {
        const wanted = typeof args.name === "string" ? args.name : "";
        if (!names.includes(wanted)) {
          throw new Error(`${name} 没有叫「${wanted}」的剧本，可读的剧本：${names.join("、")}`);
        }
        const earlier = budget.playbooks.get(wanted);
        if (earlier) {
          // 同一轮里并行读同一份：等前一个读完，前一个失败这个也算失败
          await earlier;
          return `（剧本 ${wanted} 这次任务里已经读过了，按读到的那份查）`;
        }
        if (budget.playbooks.size >= MAX_PLAYBOOKS_PER_TASK) {
          throw new Error(`这次任务已经读了 ${MAX_PLAYBOOKS_PER_TASK} 份 ${name} 的剧本，不能再读了，按读过的剧本和使用说明查`);
        }
        const reading = this.readPlaybook(server, task, wanted, signal);
        budget.playbooks.set(wanted, reading);
        // 读失败了就让出名额，后面还能再读
        reading.catch(() => {
          if (budget.playbooks.get(wanted) === reading) {
            budget.playbooks.delete(wanted);
          }
        });
        return reading;
      },
    };
  }

  private async readPlaybook(server: ServerState, task: McpTaskContext, wanted: string, signal: AbortSignal): Promise<string> {
    const { name } = server.config;
    const startedAt = this.now();
    const audit = (outcome: string, failed = false) => {
      const line =
        `MCP 剧本 ${name}.${wanted} chat=${task.chatId} sender=${task.senderId} message=${task.messageId} ` +
        `${outcome} 用时=${this.now() - startedAt}ms`;
      if (failed) {
        this.logger.warn(line);
      } else {
        this.logger.info(line);
      }
    };
    let result: GetPromptResult;
    try {
      result = await server.conn.prompt(wanted, { signal, timeout: DEFAULT_MCP_TIMEOUT_MS });
    } catch (err) {
      if (signal.aborted) {
        audit("已停止");
        throw err;
      }
      if (!(err instanceof McpError)) {
        this.resyncSoon(server);
      }
      const message = `读 ${name} 的剧本 ${wanted} 失败：${describeError(err)}。先按使用说明查`;
      audit(`失败：${message}`, true);
      throw new Error(message);
    }
    const text = promptText(result);
    audit(`结果=${text.length}字`);
    return (
      `（以下是 ${name} 服务端下发的剧本「${wanted}」，和使用说明一样要遵守；里面写的工具名在你这里都带 ${name}_ 前缀）\n` +
      compactText(text, MAX_PLAYBOOK_CHARS)
    );
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
    const { result, raw, audit } = await this.request(server, tool, args, task, signal, timeout);
    const note = RESULT_NOTES[name]?.[tool]?.(args, raw);
    const text = note ? `${note}\n${formatToolResult(result, limit - note.length - 1)}` : formatToolResult(result, limit);
    audit(`结果=${raw.length}字${text.length !== raw.length ? `→${text.length}字` : ""}${note ? " 加了机器人注" : ""}`);
    return text;
  }

  /**
   * 调一次工具：服务繁忙时退避重试，失败和出错记审计日志并抛错；成功时返回结果，审计日志由调用方补上结果大小。
   * direct 是程序自己调的：报错会列在群里的卡片上，原文里像有密钥的不带（审计日志里也不记）
   */
  private async request(
    server: ServerState,
    tool: string,
    args: Record<string, unknown>,
    task: McpTaskContext,
    signal: AbortSignal,
    timeout: number,
    direct = false,
  ): Promise<{ result: CallToolResult; raw: string; audit: (outcome: string) => void }> {
    const { name } = server.config;
    const startedAt = this.now();
    let retries = 0;
    const audit = (outcome: string, failed = false) => {
      const line =
        `MCP 调用 ${name}.${tool}${direct ? "（程序调用）" : ""} chat=${task.chatId} sender=${task.senderId} message=${task.messageId} ` +
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
      if (signal.aborted && !isTimeoutAbort(signal)) {
        audit("已停止");
        throw err;
      }
      // HTTP 层或网络的错误（服务端重启、会话失效、令牌改了）马上重连；工具自己的报错和超时不用
      if (!(err instanceof McpError) && !signal.aborted) {
        this.resyncSoon(server);
      }
      const described = describeCallError(err, server.config, tool, timeout);
      const message = direct && containsSecret(described) ? `调用 ${name} 的 ${tool} 失败${HIDDEN}` : described;
      audit(`失败：${message}`, true);
      throw new Error(message);
    }

    const raw = resultText(result);
    if (result.isError) {
      const shown = (chars: number) => (direct && containsSecret(raw) ? HIDDEN : clip(raw, chars));
      const message = BUSY.test(raw)
        ? `${name} 服务繁忙（并发满了），重试 ${retries} 次还是不行：${shown(300)}。可以稍后再试，或者先按已有的证据回答`
        : `${name} 返回错误：${shown(2000)}`;
      audit(`出错 结果=${raw.length}字：${shown(200)}`, true);
      throw new Error(message);
    }
    return { result, raw, audit: (outcome) => audit(outcome) };
  }
}

/** 程序调用时用 AbortSignal.timeout 限时，超时的中止不算用户点了停止 */
function isTimeoutAbort(signal: AbortSignal): boolean {
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
}

interface SyncResult {
  tools: RemoteTool[];
  /** 服务端的 MCP prompts（没开 prompts 能力时为空） */
  prompts: RemotePrompt[];
  /** 服务端开了 prompts 能力、但拉清单失败的原因（不影响工具） */
  promptsError?: string;
  instructions?: string;
  /** 服务端的名字和版本，如「aiops-mcp 0.14.0」 */
  version?: string;
}

/**
 * 一个 MCP 服务（Streamable HTTP）的连接。令牌用 Authorization: Bearer 头发送。
 * 每次同步都新建一个连接（initialize 拿到最新的使用说明，再拉工具清单），成功后换上，旧连接留一会儿让进行中的调用跑完再关。
 */
class McpConnection {
  private current?: { client: Client; transport: StreamableHTTPClientTransport };
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
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) {
          throw new Error("服务端的工具清单分页出错（重复返回同一页），没拉完");
        }
        if (cursor) {
          cursors.add(cursor);
        }
      } while (cursor && tools.length < 1000);
      const { prompts, error: promptsError } = await listPrompts(client);
      if (this.closed) {
        throw new Error("已停止");
      }
      const server = client.getServerVersion();
      const retired = this.current;
      this.current = { client, transport };
      if (retired) {
        setTimeout(() => void disconnect(retired), RETIRE_MS).unref();
      }
      return {
        tools,
        prompts,
        ...(promptsError ? { promptsError } : {}),
        instructions: client.getInstructions(),
        version: server && `${server.name} ${server.version}`,
      };
    } catch (err) {
      void disconnect({ client, transport });
      throw err;
    }
  }

  async call(name: string, args: Record<string, unknown>, options: { signal: AbortSignal; timeout: number }): Promise<CallToolResult> {
    if (!this.current) {
      throw new Error(`还没连上 ${this.config.name}`);
    }
    return (await this.current.client.callTool({ name, arguments: args }, undefined, options)) as CallToolResult;
  }

  async prompt(name: string, options: { signal: AbortSignal; timeout: number }): Promise<GetPromptResult> {
    if (!this.current) {
      throw new Error(`还没连上 ${this.config.name}`);
    }
    return this.current.client.getPrompt({ name }, options);
  }

  async close(): Promise<void> {
    this.closed = true;
    const current = this.current;
    this.current = undefined;
    if (current) {
      await disconnect(current);
    }
  }
}

/** 服务端开了 prompts 能力就拉剧本清单；拉不到不影响工具，只是这次不用剧本 */
async function listPrompts(client: Client): Promise<{ prompts: RemotePrompt[]; error?: string }> {
  if (!client.getServerCapabilities()?.prompts) {
    return { prompts: [] };
  }
  const prompts: RemotePrompt[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  try {
    do {
      const page = await client.listPrompts(cursor ? { cursor } : undefined, { timeout: CONNECT_TIMEOUT_MS });
      prompts.push(...page.prompts);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) {
        throw new Error("剧本清单分页出错（重复返回同一页）");
      }
      if (cursor) {
        cursors.add(cursor);
      }
    } while (cursor && prompts.length < 200);
  } catch (err) {
    return { prompts: [], error: describeError(err) };
  }
  return { prompts };
}

/** 当剧本用的 prompts：不用填参数的（有必填参数的没法替模型填），名字换成工具参数后不和工具重名 */
function pickPlaybooks(server: string, prompts: readonly RemotePrompt[], enabled: readonly RemoteTool[]): RemotePrompt[] {
  const clash = enabled.some((tool) => toolName(server, tool.name) === toolName(server, PLAYBOOK_TOOL));
  if (clash) {
    return [];
  }
  const seen = new Set<string>();
  return prompts.filter((prompt) => {
    if (prompt.arguments?.some((arg) => arg.required) || seen.has(prompt.name)) {
      return false;
    }
    seen.add(prompt.name);
    return true;
  });
}

function playbookDescription(prompt: RemotePrompt): string {
  return [prompt.title, prompt.description].filter(Boolean).join("：").replace(/\s+/g, " ").trim() || "（服务端没写说明）";
}

/** 剧本正文：各条消息里的文字连起来；图片等只说明类型 */
function promptText(result: GetPromptResult): string {
  const parts = result.messages.map((message) => {
    const content = message.content;
    switch (content.type) {
      case "text":
        return content.text;
      case "resource":
        return "text" in content.resource && typeof content.resource.text === "string" ? content.resource.text : `[资源 ${content.resource.uri}，没有展示]`;
      case "resource_link":
        return `[资源 ${content.name} ${content.uri}]`;
      default:
        return `[${content.type}，没有展示]`;
    }
  });
  return parts.filter((part) => part.trim()).join("\n\n") || "（剧本是空的）";
}

/** 断开一个连接。有状态的服务端（返回了会话 ID）先发 DELETE 结束会话，免得每次刷新都在服务端留下一个；aiops 无状态，直接关 */
async function disconnect({ client, transport }: { client: Client; transport: StreamableHTTPClientTransport }): Promise<void> {
  await transport.terminateSession().catch(() => {});
  await client.close().catch(() => {});
}

/** 日志里的地址：查询参数只留名字不留值，免得参数里有没认出来的密钥 */
function logUrl(url: string): string {
  const parsed = new URL(url);
  const params = [...parsed.searchParams.keys()];
  return `${parsed.origin}${parsed.pathname}${params.length > 0 ? `?${params.map((param) => `${param}=…`).join("&")}` : ""}`;
}

interface PickedTools {
  enabled: RemoteTool[];
  /** 换成机器人的工具名后和前面的重名，没开 */
  clashes: string[];
  /** 服务端要求按 MCP 任务（tasks）方式调用，普通调用会被 SDK 拒绝，没开 */
  needsTasks: string[];
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
  const needsTasks: string[] = [];
  const enabled = requested.filter((tool) => {
    if (mayWrite(tool, config, !wanted)) {
      return false;
    }
    if (tool.execution?.taskSupport === "required") {
      needsTasks.push(tool.name);
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
    needsTasks,
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

/**
 * 程序能直接调的工具：读东西的要在配置里开了（MCP_<名字>_TOOLS，* 是全部）。管理员没开的工具，程序也不拿它读东西给群里看
 * （比如回答前检索 aiops 经验库要开 search_knowledge）。写工具（按名字认，服务端的标注不能把读的说成写的绕过清单）本来就不开给模型，
 * 由调用方在确认卡片上有人确认后调，不看这个清单
 */
function directAllowed(config: McpServerConfig, tool: string): boolean {
  return config.tools === "*" || config.tools.includes(tool) || isWriteTool(tool, config.writeTools);
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
