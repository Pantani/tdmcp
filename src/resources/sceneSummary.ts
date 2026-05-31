import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TouchDesignerClient } from "../td-client/touchDesignerClient.js";
import { TdConnectionError } from "../td-client/types.js";
import type { TdNodeError } from "../td-client/validators.js";
import { firstVar, jsonContents, type ResourceRegistrar } from "./shared.js";

// ---------------------------------------------------------------------------
// Exported Zod schemas (used by the test to assert payload shape)
// ---------------------------------------------------------------------------

export const SceneCurrentSchema = z.object({
  view: z.literal("current"),
  root: z.string(),
  bridge: z.object({
    reachable: z.boolean(),
    tdVersion: z.string().optional(),
    project: z.string().optional(),
  }),
  topology: z.object({
    nodeCount: z.number(),
    connectionCount: z.number(),
    families: z.record(z.string(), z.number()),
  }),
  errors: z.object({
    total: z.number(),
    topGroups: z.array(z.object({ key: z.string(), count: z.number() })),
  }),
  performance: z.object({
    targetFps: z.number(),
    frameBudgetMs: z.number(),
    totalCookMs: z.number(),
    overBudgetNodes: z.number(),
  }),
  warnings: z.array(z.string()),
  cachedAt: z.string(),
});
export type SceneCurrent = z.infer<typeof SceneCurrentSchema>;

export const SceneOperatorsSchema = z.object({
  view: z.literal("operators"),
  root: z.string(),
  count: z.number(),
  families: z.record(
    z.string(),
    z.array(z.object({ path: z.string(), type: z.string(), name: z.string(), parent: z.string() })),
  ),
  warnings: z.array(z.string()),
  cachedAt: z.string(),
});
export type SceneOperators = z.infer<typeof SceneOperatorsSchema>;

export const SceneErrorsSchema = z.object({
  view: z.literal("errors"),
  root: z.string(),
  total: z.number(),
  groups: z.array(
    z.object({
      key: z.string(),
      count: z.number(),
      sample: z.object({ path: z.string(), message: z.string() }),
    }),
  ),
  warnings: z.array(z.string()),
  cachedAt: z.string(),
});
export type SceneErrors = z.infer<typeof SceneErrorsSchema>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract family suffix from a TD type string (e.g. "noiseTOP" → "TOP"). */
function familyOf(type: string): string {
  // Known 4-letter families: CHOP, COMP
  // Known 3-letter families: TOP, SOP, DAT, MAT, POP
  const known4 = ["CHOP", "COMP"];
  const known3 = ["TOP", "SOP", "DAT", "MAT", "POP"];
  const upper = type.toUpperCase();
  for (const fam of known4) {
    if (upper.endsWith(fam)) return fam;
  }
  for (const fam of known3) {
    if (upper.endsWith(fam)) return fam;
  }
  return "OTHER";
}

export function groupErrors(
  errors: TdNodeError[],
): Array<{ key: string; count: number; sample: { path: string; message: string } }> {
  const map = new Map<string, { count: number; sample: { path: string; message: string } }>();
  for (const e of errors) {
    const existing = map.get(e.message);
    if (existing) {
      existing.count += 1;
    } else {
      map.set(e.message, { count: 1, sample: { path: e.path, message: e.message } });
    }
  }
  return Array.from(map.entries())
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const cache = new Map<string, { expires: number; payload: unknown }>();
const TTL_MS = 5_000;
const OFFLINE_TTL_MS = 1_000;

function cacheKey(view: string, root: string): string {
  return `${view}:${root}`;
}

function getCached(view: string, root: string): unknown | undefined {
  const entry = cache.get(cacheKey(view, root));
  if (entry && Date.now() < entry.expires) return entry.payload;
  return undefined;
}

function setCached(view: string, root: string, payload: unknown, offline: boolean): void {
  cache.set(cacheKey(view, root), {
    expires: Date.now() + (offline ? OFFLINE_TTL_MS : TTL_MS),
    payload,
  });
}

// ---------------------------------------------------------------------------
// Per-view fetch functions (exported for testing via DI)
// ---------------------------------------------------------------------------

export async function fetchSceneCurrent(
  client: TouchDesignerClient,
  root: string,
): Promise<SceneCurrent> {
  const hit = getCached("current", root);
  if (hit) return hit as SceneCurrent;

  const cachedAt = new Date().toISOString();
  const warnings: string[] = [];

  // --- Bridge info ---
  let reachable = true;
  let tdVersion: string | undefined;
  let project: string | undefined;

  try {
    const info = await client.getInfo();
    tdVersion = info.td_version;
    project = info.project;
  } catch (err) {
    if (err instanceof TdConnectionError) {
      reachable = false;
      warnings.push(
        "TouchDesigner bridge not reachable at 127.0.0.1:9980 — scene snapshot is empty.",
      );
    } else {
      warnings.push(`Bridge info fetch failed: ${String(err)}`);
    }
  }

  if (!reachable) {
    const payload: SceneCurrent = {
      view: "current",
      root,
      bridge: { reachable: false },
      topology: { nodeCount: 0, connectionCount: 0, families: {} },
      errors: { total: 0, topGroups: [] },
      performance: { targetFps: 60, frameBudgetMs: 16.67, totalCookMs: 0, overBudgetNodes: 0 },
      warnings,
      cachedAt,
    };
    setCached("current", root, payload, true);
    return payload;
  }

  // --- Topology ---
  let nodeCount = 0;
  let connectionCount = 0;
  const families: Record<string, number> = {};

  try {
    const topo = await client.getNetworkTopology(root, true);
    nodeCount = topo.nodes.length;
    connectionCount = topo.connections.length;
    for (const n of topo.nodes) {
      const fam = familyOf(n.type);
      families[fam] = (families[fam] ?? 0) + 1;
    }
  } catch (err) {
    warnings.push(`Topology fetch failed: ${String(err)}`);
  }

  // --- Errors ---
  let errorTotal = 0;
  let topGroups: Array<{ key: string; count: number }> = [];

  try {
    const errs = await client.getNetworkErrors(root);
    const grouped = groupErrors(errs.errors);
    errorTotal = errs.errors.length;
    topGroups = grouped.slice(0, 3).map((g) => ({ key: g.key, count: g.count }));
  } catch (err) {
    warnings.push(`Errors fetch failed: ${String(err)}`);
  }

  // --- Performance ---
  const TARGET_FPS = 60;
  const FRAME_BUDGET_MS = 1000 / TARGET_FPS;
  let totalCookMs = 0;
  let overBudgetNodes = 0;

  try {
    const perf = await client.getNetworkPerformance(root, true);
    totalCookMs = perf.total_cook_time_ms ?? 0;
    overBudgetNodes = perf.nodes.filter((n) => n.cook_time_ms > FRAME_BUDGET_MS).length;
  } catch (err) {
    warnings.push(`Performance fetch failed: ${String(err)}`);
  }

  const payload: SceneCurrent = {
    view: "current",
    root,
    bridge: { reachable: true, tdVersion, project },
    topology: { nodeCount, connectionCount, families },
    errors: { total: errorTotal, topGroups },
    performance: {
      targetFps: TARGET_FPS,
      frameBudgetMs: FRAME_BUDGET_MS,
      totalCookMs,
      overBudgetNodes,
    },
    warnings,
    cachedAt,
  };
  setCached("current", root, payload, false);
  return payload;
}

export async function fetchSceneOperators(
  client: TouchDesignerClient,
  root: string,
): Promise<SceneOperators> {
  const hit = getCached("operators", root);
  if (hit) return hit as SceneOperators;

  const cachedAt = new Date().toISOString();
  const warnings: string[] = [];
  const familyMap: Record<
    string,
    Array<{ path: string; type: string; name: string; parent: string }>
  > = {};
  let count = 0;

  try {
    await client.getInfo(); // probe reachability
  } catch (err) {
    if (err instanceof TdConnectionError) {
      warnings.push(
        "TouchDesigner bridge not reachable at 127.0.0.1:9980 — scene snapshot is empty.",
      );
      const payload: SceneOperators = {
        view: "operators",
        root,
        count: 0,
        families: {},
        warnings,
        cachedAt,
      };
      setCached("operators", root, payload, true);
      return payload;
    }
  }

  try {
    const topo = await client.getNetworkTopology(root, true);
    count = topo.nodes.length;
    for (const n of topo.nodes) {
      const fam = familyOf(n.type);
      const parent = n.path.substring(0, n.path.lastIndexOf("/")) || root;
      if (!familyMap[fam]) familyMap[fam] = [];
      const famArr = familyMap[fam];
      if (famArr) famArr.push({ path: n.path, type: n.type, name: n.name, parent });
    }
  } catch (err) {
    warnings.push(`Topology fetch failed: ${String(err)}`);
  }

  const payload: SceneOperators = {
    view: "operators",
    root,
    count,
    families: familyMap,
    warnings,
    cachedAt,
  };
  setCached("operators", root, payload, false);
  return payload;
}

export async function fetchSceneErrors(
  client: TouchDesignerClient,
  root: string,
): Promise<SceneErrors> {
  const hit = getCached("errors", root);
  if (hit) return hit as SceneErrors;

  const cachedAt = new Date().toISOString();
  const warnings: string[] = [];
  let total = 0;
  let groups: Array<{ key: string; count: number; sample: { path: string; message: string } }> = [];

  try {
    await client.getInfo(); // probe reachability
  } catch (err) {
    if (err instanceof TdConnectionError) {
      warnings.push(
        "TouchDesigner bridge not reachable at 127.0.0.1:9980 — scene snapshot is empty.",
      );
      const payload: SceneErrors = {
        view: "errors",
        root,
        total: 0,
        groups: [],
        warnings,
        cachedAt,
      };
      setCached("errors", root, payload, true);
      return payload;
    }
  }

  try {
    const errs = await client.getNetworkErrors(root);
    total = errs.errors.length;
    groups = groupErrors(errs.errors);
  } catch (err) {
    warnings.push(`Errors fetch failed: ${String(err)}`);
  }

  const payload: SceneErrors = { view: "errors", root, total, groups, warnings, cachedAt };
  setCached("errors", root, payload, false);
  return payload;
}

// ---------------------------------------------------------------------------
// Resource registrar
// ---------------------------------------------------------------------------

const VIEWS = ["current", "operators", "errors"] as const;

/** Extended context that includes an optional client; the integrator adds it. */
interface SceneResourceContext {
  client?: TouchDesignerClient;
}

export const registerSceneSummaryResource: ResourceRegistrar = (server, ctx) => {
  const ctxWithClient = ctx as typeof ctx & SceneResourceContext;
  const root = process.env.TDMCP_SCENE_ROOT ?? "/project1";

  const template = new ResourceTemplate("tdmcp://scene/{view}", {
    list: async () => ({
      resources: VIEWS.map((v) => ({
        uri: `tdmcp://scene/${v}`,
        name: `Scene: ${v}`,
        description: `Live TD scene snapshot — ${v} view`,
        mimeType: "application/json",
      })),
    }),
    complete: {
      view: async () => [...VIEWS],
    },
  });

  server.registerResource(
    "td-scene-summary",
    template,
    {
      title: "Live TD scene summary",
      description:
        "Compact structured snapshot of the running TouchDesigner project. " +
        "view=current for topology+perf+errors overview, operators for full inventory, errors for clustered error list. " +
        "Results are cached for 5 s (1 s when bridge is offline).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const view = firstVar(variables.view);
      const client = ctxWithClient.client;

      if (!client) {
        const msg = { error: "No TD client available — resource context missing client." };
        return jsonContents(uri, msg);
      }

      if (view === "operators") {
        const data = await fetchSceneOperators(client, root);
        return jsonContents(uri, data);
      }
      if (view === "errors") {
        const data = await fetchSceneErrors(client, root);
        return jsonContents(uri, data);
      }
      // default: current
      const data = await fetchSceneCurrent(client, root);
      return jsonContents(uri, data);
    },
  );
};
