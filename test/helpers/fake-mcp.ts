import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  type CallToolResult,
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
  ErrorCode,
  type Prompt,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export interface FakeMcpOptions {
  /** 配了就校验 Authorization: Bearer，不对返回 404（和 aiops 一样） */
  token?: string;
  instructions?: string;
  tools: Tool[];
  call?: (name: string, args: Record<string, unknown>, signal: AbortSignal) => CallToolResult | Promise<CallToolResult>;
  /** true（默认）回 JSON，和 aiops 一样；false 回 SSE */
  json?: boolean;
  /** 指定端口（测连不上再连上时用） */
  port?: number;
  /** true 时像有状态的服务端一样发会话 ID，接受 DELETE 结束会话（aiops 是无状态的） */
  stateful?: boolean;
  /** 自己控制工具清单怎么分页（测分页出错时用）；不配就一页返回全部 */
  list?: (cursor: string | undefined) => { tools: Tool[]; nextCursor?: string };
  /** 配了就开 prompts 能力：每个 prompt 的定义和正文（text） */
  prompts?: (Prompt & { text: string })[];
  /** 拉 prompts 清单时报错（测清单失败） */
  promptsError?: string;
}

export interface FakeMcp {
  url: string;
  /** 改了就按新的令牌校验（模拟换令牌） */
  token?: string;
  /** 收到的工具调用 */
  calls: { name: string; args: Record<string, unknown> }[];
  /** 收到的取 prompt 请求（prompt 名） */
  promptGets: string[];
  /** 收到的 initialize 次数 */
  initializes: number;
  tools: Tool[];
  /** stateful 时还开着的会话 */
  sessions: Set<string>;
  /** stateful 时收到的结束会话请求（DELETE）次数 */
  deleted: number;
  close(): Promise<void>;
}

/** 用官方 SDK 的服务端起一个无状态的 Streamable HTTP MCP 服务，模仿 aiops 的行为 */
export async function startFakeMcp(options: FakeMcpOptions): Promise<FakeMcp> {
  const state: FakeMcp = {
    url: "",
    token: options.token,
    calls: [],
    promptGets: [],
    initializes: 0,
    tools: options.tools,
    sessions: new Set(),
    deleted: 0,
    close: async () => {},
  };
  const newServer = () => {
    const server = new Server(
      { name: "fake-aiops", version: "0.14.0" },
      {
        capabilities: { tools: {}, ...(options.prompts ? { prompts: {} } : {}) },
        ...(options.instructions ? { instructions: options.instructions } : {}),
      },
    );
    if (options.prompts) {
      const prompts = options.prompts;
      server.setRequestHandler(ListPromptsRequestSchema, async () => {
        if (options.promptsError) {
          throw new McpError(ErrorCode.InternalError, options.promptsError);
        }
        return { prompts: prompts.map(({ text: _text, ...prompt }) => prompt) };
      });
      server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        state.promptGets.push(request.params.name);
        const prompt = prompts.find((item) => item.name === request.params.name);
        if (!prompt) {
          throw new McpError(ErrorCode.InvalidParams, `没有 ${request.params.name}`);
        }
        return { description: prompt.description, messages: [{ role: "user", content: { type: "text", text: prompt.text } }] };
      });
    }
    server.setRequestHandler(ListToolsRequestSchema, async (request) =>
      options.list ? options.list(request.params?.cursor) : { tools: state.tools },
    );
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const args = request.params.arguments ?? {};
      state.calls.push({ name: request.params.name, args });
      if (!options.call) {
        return { content: [{ type: "text", text: "{}" }] };
      }
      return options.call(request.params.name, args, extra.signal);
    });
    return server;
  };
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = http.createServer(async (req, res) => {
    if (state.token && req.headers.authorization !== `Bearer ${state.token}`) {
      res.writeHead(404, { "content-type": "text/plain" }).end("404 page not found");
      return;
    }
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (options.stateful && req.method === "DELETE" && sessionId && sessions.has(sessionId)) {
      state.deleted++;
      await sessions.get(sessionId)!.handleRequest(req, res);
      sessions.delete(sessionId);
      state.sessions.delete(sessionId);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
    }
    const body = JSON.parse(raw) as { method?: string };
    if (body.method === "initialize") {
      state.initializes++;
    }
    if (options.stateful) {
      let transport = sessionId ? sessions.get(sessionId) : undefined;
      if (!transport) {
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: options.json ?? true,
          onsessioninitialized: (id) => {
            sessions.set(id, created);
            state.sessions.add(id);
          },
        });
        await newServer().connect(created);
        transport = created;
      }
      await transport.handleRequest(req, res, body);
      return;
    }
    const server = newServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: options.json ?? true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => httpServer.listen(options.port ?? 0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
  state.close = () =>
    new Promise<void>((resolve) => {
      httpServer.closeAllConnections();
      httpServer.close(() => resolve());
    });
  return state;
}

/** 拿一个当前没人用的端口 */
export async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
