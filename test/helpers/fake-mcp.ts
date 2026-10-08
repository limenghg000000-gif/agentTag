import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  type CallToolResult,
  CallToolRequestSchema,
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
}

export interface FakeMcp {
  url: string;
  /** 改了就按新的令牌校验（模拟换令牌） */
  token?: string;
  /** 收到的工具调用 */
  calls: { name: string; args: Record<string, unknown> }[];
  /** 收到的 initialize 次数 */
  initializes: number;
  tools: Tool[];
  close(): Promise<void>;
}

/** 用官方 SDK 的服务端起一个无状态的 Streamable HTTP MCP 服务，模仿 aiops 的行为 */
export async function startFakeMcp(options: FakeMcpOptions): Promise<FakeMcp> {
  const state: FakeMcp = {
    url: "",
    token: options.token,
    calls: [],
    initializes: 0,
    tools: options.tools,
    close: async () => {},
  };
  const httpServer = http.createServer(async (req, res) => {
    if (state.token && req.headers.authorization !== `Bearer ${state.token}`) {
      res.writeHead(404, { "content-type": "text/plain" }).end("404 page not found");
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
    const server = new Server(
      { name: "fake-aiops", version: "0.14.0" },
      { capabilities: { tools: {} }, ...(options.instructions ? { instructions: options.instructions } : {}) },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: state.tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const args = request.params.arguments ?? {};
      state.calls.push({ name: request.params.name, args });
      if (!options.call) {
        return { content: [{ type: "text", text: "{}" }] };
      }
      return options.call(request.params.name, args, extra.signal);
    });
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
