import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildToolContext } from "../../src/server/context.js";
import { TdApiError } from "../../src/td-client/types.js";
import { layer1Registrars } from "../../src/tools/layer1/index.js";
import { layer2Registrars } from "../../src/tools/layer2/index.js";
import { layoutScript, placeInGridScript } from "../../src/tools/layout.js";
import type { ToolRegistrar } from "../../src/tools/types.js";
import { loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";
import policy from "../fixtures/exec-off-policy.json" with { type: "json" };
import {
  customParamsContainCallerCode,
  genericNodeCodeSources,
  makeExecOffBridge,
} from "../helpers/execOffBridge.js";
import {
  captureTools,
  type ExecOffStatus,
  isPlacementScript,
  STATUS_RANK,
  sweepTool,
  type ToolOutcome,
} from "../helpers/execOffSweep.js";

// G4 — Bridge hardening: Layer 1/2 tools under `TDMCP_BRIDGE_ALLOW_EXEC=0`.
//
// Invokes EVERY Layer 1 + Layer 2 tool handler against an msw bridge that refuses
// what a real exec-off bridge refuses, and ratchets the outcome against a committed
// baseline. Companion to tests/smoke/execOff.test.ts, which covers the other switch
// (`TDMCP_RAW_PYTHON=off`, Node side) and only checks registration.
//
// PROVES (offline):
//   - which bridge routes each tool's DEFAULT path requests, given mocked responses;
//   - which of those a real exec-off router refuses (parity: td/tests/test_exec_off_policy_parity.py);
//   - no tool gets worse than the baseline, and the baseline only shrinks.
//
// DOES NOT PROVE:
//   - anything about a live TouchDesigner. Nothing cooks; "clean" means the requests
//     avoid refused routes, not that the network renders. Live validation is separate.
//   - anything about non-default paths. Only required args are filled, so optional
//     branches (and code reached only after a real exec response) are never exercised.
//     A "clean" tool may still reach exec on another option.
//   - that "degraded" output is usable. Those tools return success with part of the
//     work refused: create_feedback_network, for one, leaves its loop unclosed.
//
// Refresh after promoting a tool off exec: `npm run smoke:exec-off:update`.

// Runs before the imports above, because some modules read the home dir at load time.
const sandbox = await vi.hoisted(async () => {
  const { mkdirSync, mkdtempSync, realpathSync, writeFileSync: write } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tdmcp-exec-off-")));
  write(join(dir, "smoke.tox"), "");
  // Community .tox files some tools look up by fixed location, with no path argument.
  const palette = join(dir, "Documents", "Derivative", "COMP");
  mkdirSync(palette, { recursive: true });
  for (const tox of ["TDGS.tox", "StreamDiffusionTD.tox"]) write(join(palette, tox), "");
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  // Off by default, so it would otherwise escape the sweep.
  process.env.TDMCP_RAG_APPLY_CARD = "1";
  process.chdir(dir);
  return dir;
});

// Tools run for real here, so nothing may escape the sandbox: msw errors on unknown
// hosts, HOME and cwd point at a temp dir, and subprocesses are refused.
vi.mock("node:child_process", () => {
  const refuse = () => {
    throw new Error("exec-off smoke: subprocesses are blocked");
  };
  return { spawn: refuse, spawnSync: refuse, exec: refuse, execFile: refuse, execSync: refuse };
});

const TOX = `${sandbox}/smoke.tox`;

/**
 * Tools whose schema accepts args their handler rejects: conditionally-required
 * fields, or values minimalToolArgs can't guess. Without these they'd be `unverified`.
 */
const ARG_OVERRIDES: Record<string, Record<string, unknown>> = {
  apply_recipe: { id: "audio_reactive_basic" },
  build_chop_chain: { ops: [{ type: "mathCHOP" }] },
  build_sop_geometry: { ops: [{ type: "boxSOP" }] },
  connect_comfyui: { tox_path: TOX },
  create_automation_lane: { targetParam: "/project1/smoke:amp" },
  create_beat_grid_sequencer: { param: "Go" },
  create_data_source_http_ws: { selectors: [{ name: "a", path: "$.a" }] },
  create_depth_from_2d: { tox_path: TOX },
  create_euclidean_sequencer: { param: "Go" },
  create_gaussian_splat_scene: { splat_asset_path: "scene.ply" },
  create_keyframe_animation: {
    targets: ["/project1/smoke.amp"],
    keyframes: [
      { time: 0, value: 0 },
      { time: 1, value: 1 },
    ],
  },
  create_pose_controlnet_driver: { pose_chop_path: "/project1/pose" },
  create_preset_morph: { target_path: "/project1/smoke" },
  create_scheduler: { target: "/project1/smoke" },
  drive_streamdiffusion: { tox_path: TOX },
  get_preview: { node_path: "/project1/smoke" },
  import_isf_shader: {
    source: '/*{"ISFVSN":"2"}*/\nvoid main(){gl_FragColor=vec4(1.0);}',
    source_kind: "raw",
  },
  import_shadertoy: { raw_source: "void mainImage(out vec4 c, in vec2 f){c=vec4(1.0);}" },
  manage_artist_workspace: {
    action: "open",
    network_path: "/project1",
    viewer_path: "/project1/smoke",
    viewer_mode: "top_output",
  },
  manage_checkpoint: { name: "smoke" },
  manage_component: { comp_path: "/project1/smoke" },
  manage_cue: { name: "smoke" },
  manage_presets: { name: "smoke" },
  setup_mediapipe_plugin: { tox_path: TOX },
};

/**
 * Outcome depends on whether the optional `shader-park-core` peer is installed: CI
 * has none (`unverified`), a developer who installed it would see `blocked`.
 */
const ENVIRONMENT_DEPENDENT = new Set(["create_shader_park"]);

type Baseline = Record<Exclude<ExecOffStatus, "clean">, string[]> & {
  _comment: string;
  core: string[];
};

const BASELINE_PATH = fileURLToPath(new URL("./bridgeExecOff.baseline.json", import.meta.url));
const BASELINE_STATUSES = ["placement_only", "degraded", "blocked", "unverified"] as const;

function baselineStatusByTool(baseline: Baseline): Map<string, ExecOffStatus> {
  const byTool = new Map<string, ExecOffStatus>();
  for (const status of BASELINE_STATUSES) {
    for (const tool of baseline[status]) byTool.set(tool, status);
  }
  return byTool;
}

function renderBaseline(outcomes: readonly ToolOutcome[], previous: Baseline): Baseline {
  const names = (status: ExecOffStatus) =>
    outcomes
      .filter((o) => o.status === status)
      .map((o) => o.tool)
      .sort();
  return {
    _comment: previous._comment,
    core: previous.core,
    placement_only: names("placement_only"),
    degraded: names("degraded"),
    blocked: names("blocked"),
    unverified: names("unverified"),
  };
}

const bridge = makeExecOffBridge();
const outcomes: ToolOutcome[] = [];
let baseline: Baseline;
const makeCtx = () =>
  buildToolContext(loadConfig({ XDG_CONFIG_HOME: sandbox }), { logger: silentLogger });

beforeAll(async () => {
  bridge.server.listen({ onUnhandledRequest: "error" });
  const tools = captureTools(makeCtx(), [...layer1Registrars, ...layer2Registrars]);
  for (const tool of tools) {
    outcomes.push(await sweepTool(tool, bridge, ARG_OVERRIDES[tool.name]));
  }
  if (process.env.EXEC_OFF_UPDATE_BASELINE === "1") {
    const previous = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(renderBaseline(outcomes, previous), null, 2)}\n`,
    );
  }
  if (process.env.EXEC_OFF_REPORT) {
    // Per-tool gates and error text, for reporting; not committed.
    writeFileSync(process.env.EXEC_OFF_REPORT, JSON.stringify(outcomes, null, 2));
  }
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}, 300_000);

afterAll(() => {
  bridge.server.close();
});

describe("exec-off mock matches the bridge's policy fixture", () => {
  it("ports the generic-node gate", () => {
    for (const { type, parameters, sources } of policy.genericNodeCodeCases) {
      expect(genericNodeCodeSources(type, parameters)).toEqual(sources);
    }
  });

  it("ports the custom-parameter gate", () => {
    for (const { body, contains } of policy.customParamsCases) {
      expect(customParamsContainCallerCode(body)).toBe(contains);
    }
  });

  it.each(policy.refusedRoutes)("refuses $method $path as $gate", async (route) => {
    const response = await fetch(`http://127.0.0.1:9980${route.path}`, {
      method: route.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(route.body),
    });
    const body = (await response.json()) as { error: { message: string } };
    expect(response.status).toBe(403);
    expect(body.error.message).toBe(policy.messages[route.gate as keyof typeof policy.messages]);
    expect(bridge.takeCalls()).toMatchObject([{ gate: route.gate }]);
  });

  it("serves every first-class route the Python parity test validates", async () => {
    const routes = policy.currentBridgeRoutes as unknown as Array<{
      method: string;
      path: string;
      query?: Record<string, string>;
      body?: unknown;
    }>;
    for (const route of routes) {
      const query = route.query ? `?${new URLSearchParams(route.query)}` : "";
      // The real client percent-encodes the node path into one segment.
      const path = route.path.replace(
        /^\/api\/nodes\/(project1\/\w+)/,
        (_, node: string) => `/api/nodes/${encodeURIComponent(`/${node}`)}`,
      );
      const response = await fetch(`http://127.0.0.1:9980${path}${query}`, {
        method: route.method,
        headers: { "content-type": "application/json" },
        ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
      });
      expect([route.path, response.status]).toEqual([route.path, 200]);
    }
    bridge.takeCalls();
  });

  it("surfaces a refusal as a 403 TdApiError, not a missing endpoint", async () => {
    const err = await makeCtx()
      .client.executePythonScript("print(1)")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TdApiError);
    expect((err as TdApiError).status).toBe(403);
    bridge.takeCalls();
  });
});

describe("exec-off sweep can tell the outcomes apart", () => {
  // Controls for the classifier: without these, a broken gate would quietly mark
  // every tool `clean` and the ratchet would report nothing.
  const fake = (name: string, run: (ctx: ReturnType<typeof makeCtx>) => Promise<unknown>) =>
    ((server, ctx) => {
      server.registerTool(name, { inputSchema: {} }, async () => {
        const failure = await run(ctx as ReturnType<typeof makeCtx>).catch((e: unknown) => e);
        return failure instanceof Error
          ? { isError: true, content: [{ type: "text" as const, text: failure.message }] }
          : { content: [{ type: "text" as const, text: "ok" }] };
      });
    }) as ToolRegistrar;

  const statusOf = async (run: (ctx: ReturnType<typeof makeCtx>) => Promise<unknown>) => {
    const [tool] = captureTools(makeCtx(), [fake("control", run)]);
    if (!tool) throw new Error("control tool did not register");
    return (await sweepTool(tool, bridge, undefined)).status;
  };

  it("flags exec that fails the tool as blocked", async () => {
    expect(await statusOf((ctx) => ctx.client.executePythonScript("print(1)"))).toBe("blocked");
  });

  it("flags a code-bearing node create as blocked", async () => {
    const run = (ctx: ReturnType<typeof makeCtx>) =>
      ctx.client.createNode({ parent_path: "/project1", type: "glslTOP" });
    expect(await statusOf(run)).toBe("blocked");
  });

  it("flags exec a tool swallows as degraded", async () => {
    const run = (ctx: ReturnType<typeof makeCtx>) =>
      ctx.client.executePythonScript("print(1)").catch(() => undefined);
    expect(await statusOf(run)).toBe("degraded");
  });

  it("notices when a tool hides the refusal from its result", async () => {
    const [silent] = captureTools(makeCtx(), [
      fake("silent", (ctx) => ctx.client.executePythonScript("print(1)").catch(() => undefined)),
    ]);
    const [loud] = captureTools(makeCtx(), [
      fake("loud", (ctx) => ctx.client.executePythonScript("print(1)")),
    ]);
    if (!silent || !loud) throw new Error("control tools did not register");
    expect((await sweepTool(silent, bridge, undefined)).reportsRefusal).toBe(false);
    expect((await sweepTool(loud, bridge, undefined)).reportsRefusal).toBe(true);
  });

  it("flags swallowed placement scripts as placement_only", async () => {
    const run = (ctx: ReturnType<typeof makeCtx>) =>
      ctx.client
        .executePythonScript(placeInGridScript("/project1", "/project1/a"))
        .catch(() => undefined);
    expect(await statusOf(run)).toBe("placement_only");
  });

  it("calls first-class routes clean", async () => {
    const run = (ctx: ReturnType<typeof makeCtx>) =>
      ctx.client.createNode({ parent_path: "/project1", type: "noiseTOP" });
    expect(await statusOf(run)).toBe("clean");
  });

  it("does not blame exec for an unrelated error", async () => {
    const run = async () => {
      throw new Error("unrelated");
    };
    expect(await statusOf(run)).toBe("unverified");
  });

  it("recognises exactly the layout module's placement scripts", () => {
    expect(isPlacementScript(layoutScript({ "/a": [0, 0] }))).toBe(true);
    expect(isPlacementScript(layoutScript({ "/a": [0, 0] }, false))).toBe(true);
    expect(isPlacementScript(placeInGridScript("/project1", "/project1/a"))).toBe(true);
    expect(isPlacementScript("op('/a').par.top = 'b'")).toBe(false);
  });
});

describe("Layer 1/2 tools under TDMCP_BRIDGE_ALLOW_EXEC=0 (mocked bridge, default path)", () => {
  it("sweeps every registered Layer 1/2 tool", () => {
    const registered = captureTools(makeCtx(), [...layer1Registrars, ...layer2Registrars]);
    expect(outcomes.map((o) => o.tool)).toEqual(registered.map((t) => t.name));
    expect(outcomes.length).toBeGreaterThan(300);
  });

  it("has no regression against the baseline", () => {
    const known = baselineStatusByTool(baseline);
    const regressions = outcomes
      .filter((o) => STATUS_RANK[o.status] > STATUS_RANK[known.get(o.tool) ?? "clean"])
      .map(
        (o) =>
          `${o.tool}: ${known.get(o.tool) ?? "clean"} -> ${o.status} ` +
          `[${o.gates.join(",")}] ${o.detail ?? ""}`,
      );
    expect(
      regressions,
      "These tools now depend on routes refused under TDMCP_BRIDGE_ALLOW_EXEC=0. Prefer a " +
        "first-class endpoint; if a new exec dependency is truly intended, run " +
        "`npm run smoke:exec-off:update` (the PR then needs the exec-off-baseline-growth label).",
    ).toEqual([]);
  });

  it("has no stale baseline entry: improvements must shrink the list", () => {
    const known = baselineStatusByTool(baseline);
    const byTool = new Map(outcomes.map((o) => [o.tool, o]));
    const stale = [...known].flatMap(([tool, status]) => {
      if (ENVIRONMENT_DEPENDENT.has(tool)) return [];
      const actual = byTool.get(tool);
      if (!actual) return [`${tool}: no longer registered`];
      return STATUS_RANK[actual.status] < STATUS_RANK[status]
        ? [`${tool}: ${status} -> ${actual.status}`]
        : [];
    });
    expect(stale, "Run `npm run smoke:exec-off:update` to lock in these improvements.").toEqual([]);
  });

  it("keeps the named core set buildable", () => {
    // The G4 bar for 1.0: these tools build a network from structured routes alone.
    const byTool = new Map(outcomes.map((o) => [o.tool, o]));
    const broken = baseline.core.flatMap((tool) => {
      const status = byTool.get(tool)?.status ?? "not registered";
      return status === "clean" || status === "placement_only" ? [] : [`${tool}: ${status}`];
    });
    expect(baseline.core.length).toBeGreaterThan(0);
    expect(broken, "Core tools must build under TDMCP_BRIDGE_ALLOW_EXEC=0.").toEqual([]);
  });

  it("has every other tool name the policy when it refuses work", () => {
    // The other half of the bar: outside the core a tool may fail, but not quietly.
    const refused = outcomes.filter((o) => o.status === "degraded" || o.status === "blocked");
    const silent = refused.filter((o) => !o.reportsRefusal).map((o) => o.tool);
    expect(silent, "These tools hide a TDMCP_BRIDGE_ALLOW_EXEC=0 refusal; surface it.").toEqual([]);
  });

  it("states a baseline with no duplicates", () => {
    const all = BASELINE_STATUSES.flatMap((status) => baseline[status]);
    expect(all.length).toBe(new Set(all).size);
  });
});
