import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server, ServerWebSocket } from "bun";
import { Bridge } from "./bridge.js";
import { BROWSER_TOOLS, errorResult, toolResult } from "./tools.js";

export interface Options {
  port: number;
  /** When set, the endpoints are /mcp/<secret> and /ext/<secret>; otherwise /mcp and /ext. */
  secret: string;
  hostname?: string;
}

const DEFAULT_AGENT = "Agent";

/** The calling agent's name, which titles its tab group: ?agent=, else the X-Agent-Id header. */
function agentName(request: Request, url: URL): string {
  const name = (url.searchParams.get("agent") ?? request.headers.get("x-agent-id") ?? "").trim();
  return name === "" ? DEFAULT_AGENT : name.slice(0, 40);
}

/** One stateless MCP exchange: a fresh server whose tools act as `agent`. */
async function handleMcp(request: Request, bridge: Bridge, agent: string): Promise<Response> {
  const mcp = new McpServer({ name: "browser-agent", version: "0.1.0" });
  for (const tool of BROWSER_TOOLS) {
    mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.shape }, async (args, extra) => {
      try {
        // The extension checks params again; the zod shape already matched them to the method.
        const result = await bridge.call(agent, tool.method, args as never, extra.signal);
        return toolResult(tool, result);
      } catch (error) {
        return errorResult(tool, error instanceof Error ? error.message : String(error));
      }
    });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcp.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void mcp.close();
  }
}

export function startServer(options: Options): { server: Server<undefined>; bridge: Bridge } {
  const bridge = new Bridge();
  const suffix = options.secret === "" ? "" : `/${options.secret}`;
  const mcpPath = `/mcp${suffix}`;
  const extPath = `/ext${suffix}`;

  const server = Bun.serve<undefined>({
    port: options.port,
    ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    // Tool calls can wait up to 90 s on the browser.
    idleTimeout: 120,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === extPath) {
        if (server.upgrade(request)) return undefined;
        return new Response("Expected a WebSocket upgrade.", { status: 426 });
      }
      if (url.pathname === mcpPath) return handleMcp(request, bridge, agentName(request, url));
      if (url.pathname === "/healthz") return Response.json({ ok: true, browser: bridge.connected ? (bridge.info ?? {}) : null });
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      idleTimeout: 120,
      open(socket: ServerWebSocket<undefined>) {
        bridge.attach(socket);
      },
      message(socket, data) {
        bridge.receive(socket, typeof data === "string" ? data : new TextDecoder().decode(data));
      },
      close(socket) {
        bridge.detach(socket);
      },
    },
  });
  return { server, bridge };
}
