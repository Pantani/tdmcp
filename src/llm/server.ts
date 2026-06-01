import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ToolContext } from "../tools/types.js";
import {
  DEFAULT_LLM_MAX_STEPS,
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_LLM_TIER,
  type LlmRuntimeConfig,
  type LlmTier,
  type TdmcpConfig,
} from "../utils/config.js";
import { runAgentTurn } from "./agent.js";
import { applySettings, type ChatMessage, LlmClient, type LlmConfig } from "./client.js";
import { buildHandoffPrompt } from "./handoff.js";
import { resolveTools, type ToolTier } from "./tools.js";
import { CHAT_HTML } from "./ui.js";

export interface ChatServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

type ChatServerConfig = TdmcpConfig &
  Partial<LlmRuntimeConfig> & {
    /** When set by the CLI, every browser/API chat request is forced to this tier. */
    llmLockedTier?: ToolTier;
  };

/** Extracts the bare hostname from a `Host` header (`h:port`, `[::1]:port`) or an `Origin` URL. */
function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes("://")) {
    try {
      return new URL(value).hostname;
    } catch {
      return undefined;
    }
  }
  let h = value.trim();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : undefined; // [::1]:port -> ::1
  }
  const colon = h.indexOf(":");
  if (colon > 0 && colon === h.lastIndexOf(":")) h = h.slice(0, colon); // strip :port (ipv4/host)
  return h;
}

/**
 * The chat UI is bound to loopback, but binding alone does not stop a web page the
 * artist visits from POSTing to `http://127.0.0.1:<port>/chat` (CSRF) or a name
 * rebound to 127.0.0.1 (DNS rebinding) — either could drive node CRUD against the
 * live TD project. Accept a request only when both the `Host` and (when present)
 * the `Origin` resolve to a loopback name, mirroring the bridge's `_check_origin`
 * and the MCP HTTP transport's DNS-rebinding guard.
 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const host = hostnameOf(req.headers.host);
  if (!host || !LOOPBACK_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const originHost = hostnameOf(origin);
    if (!originHost || !LOOPBACK_HOSTS.has(originHost)) return false;
  }
  return true;
}

function readJsonBody(req: IncomingMessage, limitBytes = 5_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** A writer that drops events once the client has hung up (cancel / closed tab). */
function sseWriter(res: ServerResponse): (data: unknown) => void {
  return (data: unknown) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

export function resolveRequestedTier(
  requested: unknown,
  fallback: LlmTier = DEFAULT_LLM_TIER,
  locked?: ToolTier,
): ToolTier {
  if (locked) return locked;
  if (requested === "safe" || requested === "creative" || requested === "standard") {
    return requested;
  }
  return fallback ?? DEFAULT_LLM_TIER;
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ToolContext,
  client: LlmClient,
  config: Pick<ChatServerConfig, "llmTier" | "llmMaxSteps" | "llmLockedTier">,
): Promise<void> {
  const body = (await readJsonBody(req)) as { messages?: ChatMessage[]; tier?: string };
  const history = Array.isArray(body.messages) ? body.messages : [];
  // safe (read-only) wins over creative in the browser UI; API callers can also
  // omit tier and use the configured default.
  const tier = resolveRequestedTier(
    body.tier,
    config.llmTier ?? DEFAULT_LLM_TIER,
    config.llmLockedTier,
  );
  const tools = resolveTools(tier);

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  res.writeHead(200, SSE_HEADERS);
  const sse = sseWriter(res);

  const messages = await runAgentTurn(ctx, client, history, sse, {
    signal: controller.signal,
    tools,
    maxSteps: config.llmMaxSteps ?? DEFAULT_LLM_MAX_STEPS,
  });
  if (!controller.signal.aborted) sse({ type: "final", messages });
  if (!res.writableEnded) res.end();
}

async function handlePull(
  req: IncomingMessage,
  res: ServerResponse,
  client: LlmClient,
): Promise<void> {
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  res.writeHead(200, SSE_HEADERS);
  const sse = sseWriter(res);
  try {
    await client.pull((p) => sse({ type: "progress", ...p }), controller.signal);
    sse({ type: "done" });
  } catch (err) {
    if (!(err instanceof Error && err.name === "AbortError")) {
      sse({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!res.writableEnded) res.end();
}

/**
 * Starts the local chat UI on loopback only. Serves the single-page UI at `/`, a
 * `/health` probe, a streaming `/chat` turn endpoint, and a `/pull` endpoint that
 * downloads the model via Ollama. Bound to 127.0.0.1 so it never leaves the machine.
 */
export function startChatServer(
  ctx: ToolContext,
  config: ChatServerConfig,
): Promise<ChatServerHandle> {
  // Live, mutable settings so the UI can switch model/endpoint without a restart.
  let settings: LlmConfig = {
    llmBaseUrl: config.llmBaseUrl,
    llmModel: config.llmModel,
    llmApiKey: config.llmApiKey,
    llmTemperature: config.llmTemperature,
  };
  const clientFor = () => new LlmClient(settings);

  const server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0];

    const run = async () => {
      if (!isLoopbackRequest(req)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("forbidden: cross-origin or non-loopback request rejected");
        return;
      }
      if (method === "GET" && path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(CHAT_HTML);
        return;
      }
      if (method === "GET" && path === "/health") {
        const health = await clientFor().health();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...health,
            model: settings.llmModel,
            baseUrl: settings.llmBaseUrl,
            hasKey: Boolean(settings.llmApiKey),
            defaultTier: config.llmTier ?? DEFAULT_LLM_TIER,
            lockedTier: config.llmLockedTier,
            maxSteps: config.llmMaxSteps ?? DEFAULT_LLM_MAX_STEPS,
            temperature: settings.llmTemperature ?? DEFAULT_LLM_TEMPERATURE,
          }),
        );
        return;
      }
      if (method === "GET" && path === "/models") {
        const models = await clientFor().listModels();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models }));
        return;
      }
      if (method === "POST" && path === "/settings") {
        const patch = (await readJsonBody(req)) as {
          model?: string;
          baseUrl?: string;
          apiKey?: string;
        };
        settings = applySettings(settings, patch);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            model: settings.llmModel,
            baseUrl: settings.llmBaseUrl,
            hasKey: Boolean(settings.llmApiKey),
          }),
        );
        return;
      }
      if (method === "POST" && path === "/chat") {
        await handleChat(req, res, ctx, clientFor(), config);
        return;
      }
      if (method === "POST" && path === "/pull") {
        await handlePull(req, res, clientFor());
        return;
      }
      if (method === "POST" && path === "/handoff") {
        const body = (await readJsonBody(req)) as { messages?: ChatMessage[] };
        const prompt = buildHandoffPrompt(Array.isArray(body.messages) ? body.messages : []);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ prompt }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    };

    run().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      if (!res.writableEnded) res.end(`error: ${message}`);
    });
  });

  return new Promise((resolve) => {
    server.listen(config.chatPort, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${config.chatPort}/`;
      resolve({
        url,
        port: config.chatPort,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
