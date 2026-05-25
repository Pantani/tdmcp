import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { TdEventStream } from "../td-client/eventStream.js";
import { type TdmcpConfig, tdBaseUrl } from "../utils/config.js";
import type { Logger } from "../utils/logger.js";

/** A running transport plus a way to shut it down cleanly. */
export interface TransportHandle {
  close: () => Promise<void>;
}

const MCP_PATH = "/mcp";

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function startStdio(
  createMcpServer: () => McpServer,
  config: TdmcpConfig,
  logger: Logger,
): TransportHandle {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  void server.connect(transport);
  logger.info("tdmcp connected over stdio");

  let events: TdEventStream | undefined;
  if (config.events === "on") {
    const wsUrl = `${tdBaseUrl(config).replace(/^http/, "ws")}/`;
    events = new TdEventStream({
      url: wsUrl,
      logger,
      onEvent: (event) => {
        const level = event.event === "node.error" ? "error" : "info";
        void server
          .sendLoggingMessage({ level, logger: "touchdesigner", data: event })
          .catch(() => {
            // client may not support logging or not be ready — ignore
          });
      },
    });
    events.start();
  }

  return {
    close: async () => {
      events?.close();
      await server.close();
    },
  };
}

/**
 * Stateful Streamable HTTP transport: one MCP server + transport per session,
 * keyed by the `mcp-session-id` header. Sessions are created on an `initialize`
 * POST and torn down on transport close or DELETE.
 */
function startHttp(
  createMcpServer: () => McpServer,
  config: TdmcpConfig,
  logger: Logger,
): TransportHandle {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger.error("HTTP request failed", { error: String(err) });
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== MCP_PATH) {
      sendJson(res, 404, { error: "Not found. MCP endpoint is at /mcp." });
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? transports.get(sessionId) : undefined;

    if (req.method === "POST") {
      const body = await readBody(req);
      if (!existing) {
        if (!isInitializeRequest(body)) {
          sendJson(res, 400, {
            jsonrpc: "2.0",
            error: { code: -32000, message: "No valid session; send an initialize request first." },
            id: null,
          });
          return;
        }
        const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, created);
          },
        });
        created.onclose = () => {
          if (created.sessionId) transports.delete(created.sessionId);
        };
        await createMcpServer().connect(created);
        await created.handleRequest(req, res, body);
        return;
      }
      await existing.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!existing) {
        sendJson(res, 400, { error: "Unknown or missing mcp-session-id." });
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed." });
  }

  // Bind to loopback by default so HTTP isn't unexpectedly exposed.
  httpServer.listen(config.httpPort, "127.0.0.1", () => {
    logger.info("tdmcp listening over Streamable HTTP", { port: config.httpPort, path: MCP_PATH });
  });

  return {
    close: async () => {
      for (const transport of transports.values()) await transport.close();
      transports.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/**
 * Connects the MCP server to a transport based on config. `stdio` is the default;
 * `http` serves Streamable HTTP. Returns a handle for clean shutdown.
 */
export async function startTransport(
  createMcpServer: () => McpServer,
  config: TdmcpConfig,
  logger: Logger,
): Promise<TransportHandle> {
  if (config.transport === "http") {
    return startHttp(createMcpServer, config, logger);
  }
  return startStdio(createMcpServer, config, logger);
}
