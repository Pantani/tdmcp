export const TDMCP_DOCS_BASE_PATH = "/tdmcp/" as const;

export interface TdmcpDocEntry {
  id: string;
  title: string;
  description: string;
  path: string;
  keywords: readonly string[];
}

export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute(input: unknown): Promise<string> | string;
}

export interface WebMcpContext {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): Promise<void>;
}

interface BrowserRuntime {
  document?: { modelContext?: WebMcpContext };
  navigator?: { modelContext?: WebMcpContext };
  location?: { origin?: string };
  addEventListener?: (event: string, listener: () => void, options?: { once?: boolean }) => void;
  [key: symbol]: unknown;
}

const DEFAULT_DOCS_ORIGIN = "https://pantani.github.io";
const INSTALL_KEY = Symbol.for("tdmcp.webmcp.controller");

export const TDMCP_DOCS: readonly TdmcpDocEntry[] = [
  {
    id: "install",
    title: "Install tdmcp",
    description: "Install tdmcp for Claude Desktop, Claude Code, Cursor, or another MCP client.",
    path: `${TDMCP_DOCS_BASE_PATH}guide/install`,
    keywords: ["setup", "claude", "cursor", "mcpb", "desktop"],
  },
  {
    id: "codex",
    title: "Use tdmcp with Codex",
    description: "Connect Codex to tdmcp and verify the project-scoped MCP configuration.",
    path: `${TDMCP_DOCS_BASE_PATH}guide/codex`,
    keywords: ["openai", "codex", "config", "mcp"],
  },
  {
    id: "first-visual",
    title: "Create your first visual",
    description: "Build and verify a first TouchDesigner visual through tdmcp.",
    path: `${TDMCP_DOCS_BASE_PATH}guide/first-visual`,
    keywords: ["tutorial", "touchdesigner", "visual", "beginner"],
  },
  {
    id: "prompt-cookbook",
    title: "Prompt cookbook",
    description: "Browse practical prompts for visuals, installations, live shows, and automation.",
    path: `${TDMCP_DOCS_BASE_PATH}guide/prompt-cookbook`,
    keywords: ["examples", "prompts", "recipes", "visuals"],
  },
  {
    id: "tools",
    title: "MCP tools reference",
    description: "Inspect the generated reference for every tdmcp tool and its input contract.",
    path: `${TDMCP_DOCS_BASE_PATH}reference/tools`,
    keywords: ["api", "schema", "parameters", "reference"],
  },
  {
    id: "mcp-resources",
    title: "MCP resources",
    description: "Discover tdmcp resource URIs for tools, techniques, projects, and receipts.",
    path: `${TDMCP_DOCS_BASE_PATH}guide/mcp-resources`,
    keywords: ["resource", "uri", "discovery", "catalog"],
  },
  {
    id: "bridge-api",
    title: "Bridge and REST API",
    description:
      "Read the local TouchDesigner bridge endpoints, authentication, and response shapes.",
    path: `${TDMCP_DOCS_BASE_PATH}reference/bridge-api`,
    keywords: ["http", "rest", "endpoint", "health", "touchdesigner"],
  },
  {
    id: "oauth-pkce",
    title: "OAuth and PKCE",
    description:
      "Protect a self-hosted Streamable HTTP MCP endpoint with OAuth authorization code and PKCE.",
    path: `${TDMCP_DOCS_BASE_PATH}guide/oauth-pkce`,
    keywords: ["auth", "authorization", "token", "remote", "streamable"],
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    description:
      "Diagnose installation, MCP client, bridge, and TouchDesigner connectivity problems.",
    path: `${TDMCP_DOCS_BASE_PATH}guide/troubleshooting`,
    keywords: ["doctor", "error", "offline", "debug", "repair"],
  },
  {
    id: "privacy",
    title: "Privacy",
    description:
      "Review tdmcp data handling, local execution, network access, and retention behavior.",
    path: `${TDMCP_DOCS_BASE_PATH}privacy`,
    keywords: ["security", "data", "policy", "local"],
  },
] as const;

export const TDMCP_WEB_MCP_TOOL_NAMES = ["search_tdmcp_docs", "get_tdmcp_doc"] as const;

function inputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("WebMCP input must be an object.");
  }
  return input as Record<string, unknown>;
}

function boundedString(input: unknown, key: string, maximum: number): string {
  const value = inputRecord(input)[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${key} must contain between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function searchTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

function docsUrl(path: string, origin: string): string {
  return new URL(path, `${origin.replace(/\/+$/u, "")}/`).href;
}

function publicDoc(entry: TdmcpDocEntry, origin: string) {
  return {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    url: docsUrl(entry.path, origin),
  };
}

export function searchTdmcpDocs(query: string, origin = DEFAULT_DOCS_ORIGIN) {
  const tokens = searchTokens(query);
  return TDMCP_DOCS.map((entry) => {
    const title = `${entry.id} ${entry.title}`.toLowerCase();
    const keywords = entry.keywords.join(" ").toLowerCase();
    const description = entry.description.toLowerCase();
    const score = tokens.reduce((total, token) => {
      if (title.includes(token)) return total + 4;
      if (keywords.includes(token)) return total + 2;
      if (description.includes(token)) return total + 1;
      return total;
    }, 0);
    return { entry, score };
  })
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.entry.title.localeCompare(right.entry.title),
    )
    .slice(0, 5)
    .map(({ entry }) => publicDoc(entry, origin));
}

export function createTdmcpWebMcpTools(origin = DEFAULT_DOCS_ORIGIN): WebMcpTool[] {
  const docIds = TDMCP_DOCS.map((entry) => entry.id);
  return [
    {
      name: TDMCP_WEB_MCP_TOOL_NAMES[0],
      description:
        "Search the key tdmcp documentation pages. Use for installation, tools, bridge, OAuth, troubleshooting, privacy, examples, or MCP resource questions.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: 120,
            description: "A short documentation search query.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute(input) {
        const query = boundedString(input, "query", 120);
        return JSON.stringify({ query, results: searchTdmcpDocs(query, origin) });
      },
    },
    {
      name: TDMCP_WEB_MCP_TOOL_NAMES[1],
      description:
        "Return the canonical URL and summary for one key tdmcp documentation topic without navigating the page.",
      inputSchema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: docIds,
            description: "The documentation topic identifier.",
          },
        },
        required: ["topic"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute(input) {
        const topic = boundedString(input, "topic", 64);
        const entry = TDMCP_DOCS.find((candidate) => candidate.id === topic);
        if (!entry) throw new Error(`Unknown tdmcp documentation topic: ${topic}`);
        return JSON.stringify(publicDoc(entry, origin));
      },
    },
  ];
}

function currentRuntime(): BrowserRuntime {
  return globalThis as unknown as BrowserRuntime;
}

export function resolveTdmcpWebMcpContext(
  runtime: BrowserRuntime = currentRuntime(),
): WebMcpContext | undefined {
  const current = runtime.document?.modelContext;
  if (current?.registerTool) return current;
  const legacy = runtime.navigator?.modelContext;
  return legacy?.registerTool ? legacy : undefined;
}

export async function registerTdmcpWebMcp(
  options: {
    context?: WebMcpContext;
    origin?: string;
    controller?: AbortController;
    runtime?: BrowserRuntime;
  } = {},
): Promise<AbortController | undefined> {
  const runtime = options.runtime ?? currentRuntime();
  const context = options.context ?? resolveTdmcpWebMcpContext(runtime);
  if (!context) return undefined;
  const controller = options.controller ?? new AbortController();
  const origin = options.origin ?? runtime.location?.origin ?? DEFAULT_DOCS_ORIGIN;
  try {
    for (const tool of createTdmcpWebMcpTools(origin)) {
      await context.registerTool(tool, { signal: controller.signal });
    }
  } catch (error) {
    controller.abort();
    throw error;
  }
  return controller;
}

export async function installTdmcpWebMcp(
  runtime: BrowserRuntime = currentRuntime(),
): Promise<AbortController | undefined> {
  const existing = runtime[INSTALL_KEY];
  if (existing instanceof AbortController && !existing.signal.aborted) return existing;
  const controller = await registerTdmcpWebMcp({ runtime });
  if (!controller) return undefined;
  runtime[INSTALL_KEY] = controller;
  runtime.addEventListener?.("beforeunload", () => controller.abort(), { once: true });
  return controller;
}
