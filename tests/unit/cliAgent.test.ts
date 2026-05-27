import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCli, runWatch } from "../../src/cli/agent.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const makeCtx = (): ToolContext => ({
  client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
  knowledge: new KnowledgeBase(),
  recipes: new RecipeLibrary(),
  logger: silentLogger,
});

describe("tdmcp-agent CLI", () => {
  it("prints usage with --help (no TD needed)", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("tdmcp-agent");
    expect(r.stdout).toContain("nodes find");
  });

  it("emits a JSON Schema for `schema <command>`", async () => {
    const r = await runCli(["schema", "nodes", "list"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("nodes list");
    expect(JSON.stringify(doc.input)).toContain("parent_path");
  });

  it("rejects an unknown command with exit code 2", async () => {
    const r = await runCli(["nodes", "frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unknown command");
  });

  it("validates and echoes a mutation under --dry-run without calling TD", async () => {
    const r = await runCli([
      "nodes",
      "create",
      "--dry-run",
      "--params",
      '{"parent_path":"/project1","type":"noiseTOP"}',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.command).toBe("nodes create");
    expect(doc.args.type).toBe("noiseTOP");
  });

  it("blocks exec escape hatches without --allow-unsafe", async () => {
    const r = await runCli(["exec", "python", "--params", '{"script":"print(1)"}']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--allow-unsafe");
  });

  it("locks exec out entirely when TDMCP_RAW_PYTHON=off, even with --allow-unsafe", async () => {
    const makeCtxLocked = (): ToolContext => ({ ...makeCtx(), allowRawPython: false });
    const r = await runCli(
      ["exec", "python", "--allow-unsafe", "--params", '{"script":"print(1)"}'],
      { makeCtx: makeCtxLocked },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("disabled");
  });

  it("runs exec python with --allow-unsafe against the mocked bridge", async () => {
    const r = await runCli(
      ["exec", "python", "--allow-unsafe", "--params", '{"script":"print(1)"}'],
      { makeCtx },
    );
    expect(r.code).toBe(0);
  });

  it("rejects invalid JSON in --params", async () => {
    const r = await runCli(["nodes", "list", "--params", "{not json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid JSON");
  });

  it("runs an offline KB command and prints JSON", async () => {
    const r = await runCli(["classes", "list", "--params", '{"filter":"app"}'], { makeCtx });
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(JSON.parse(r.stdout)).toHaveProperty("classes");
  });

  it("finds nodes through the mocked bridge", async () => {
    const r = await runCli(
      ["nodes", "find", "--params", '{"parent_path":"/project1","recursive":false,"type":"null"}'],
      { makeCtx },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("/project1/null1");
  });

  it("streams list results as NDJSON", async () => {
    const r = await runCli(
      ["nodes", "list", "--output", "ndjson", "--params", '{"detail_level":"full"}'],
      { makeCtx },
    );
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(r.stdout).toContain("noise1");
    expect(r.stdout).toContain("null1");
  });
});

describe("tdmcp-agent CLI — phase 0 additions", () => {
  it("lists the new high-level + DX commands in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of [
      "reload",
      "visual",
      "audio-reactive",
      "checkpoint",
      "preview",
      "watch",
      "plan",
    ]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("emits a JSON Schema for a Layer-2 command (checkpoint)", async () => {
    const r = await runCli(["schema", "checkpoint"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("checkpoint");
    expect(JSON.stringify(doc.input)).toContain("recreate_deleted");
  });

  it("dry-runs a Layer-1 generator without calling TD", async () => {
    const r = await runCli(["generative", "--dry-run", "--params", '{"technique":"voronoi"}']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.command).toBe("generative");
    expect(doc.args.technique).toBe("voronoi");
  });

  it("dry-runs preview and resolves an output path without writing a file", async () => {
    const r = await runCli(["preview", "/project1/out1", "--dry-run"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.command).toBe("preview");
    expect(doc.args.node_path).toBe("/project1/out1");
    expect(doc.out).toContain("preview.png");
  });

  it("requires a node path for preview", async () => {
    const r = await runCli(["preview"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid arguments");
  });

  it("reloads the bridge through the mocked exec endpoint", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: { result: null, stdout: '{"reloaded": ["mcp", "utils"], "count": 2}' },
        }),
      ),
    );
    const r = await runCli(["reload"], { makeCtx });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).count).toBe(2);
  });
});

describe("tdmcp-agent watch", () => {
  it("writes events as ndjson and stops when the signal aborts", async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    let emit: ((e: { event: string; data?: unknown }) => void) | undefined;
    let closed = false;
    const done = runWatch({
      write: (line) => lines.push(line),
      signal: controller.signal,
      makeStream: ({ onEvent }) => {
        emit = onEvent;
        return { start: () => {}, close: () => (closed = true) };
      },
    });
    emit?.({ event: "node.created", data: { path: "/project1/x" } });
    controller.abort();
    await done;
    expect(closed).toBe(true);
    expect(lines).toContain('{"event":"node.created","data":{"path":"/project1/x"}}');
  });

  it("derives a ws:// url ending in / from config", async () => {
    let url = "";
    const controller = new AbortController();
    const done = runWatch({
      write: () => {},
      signal: controller.signal,
      makeStream: (args) => {
        url = args.url;
        return { start: () => {}, close: () => {} };
      },
    });
    controller.abort();
    await done;
    expect(url).toMatch(/^ws:\/\/.+\/$/);
  });
});

describe("tdmcp-agent CLI — phase 1 (musical reactivity)", () => {
  it("lists the reactivity commands in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["audio-features", "tempo-sync", "bind"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("emits a JSON Schema for bind (source_chop + channel)", async () => {
    const r = await runCli(["schema", "bind"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("bind");
    const input = JSON.stringify(doc.input);
    expect(input).toContain("source_chop");
    expect(input).toContain("channel");
  });

  it("dry-runs audio-features with the safe oscillator source", async () => {
    const r = await runCli(["audio-features", "--dry-run", "--params", '{"source":"oscillator"}']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.command).toBe("audio-features");
    expect(doc.args.source).toBe("oscillator");
  });

  it("dry-runs tempo-sync", async () => {
    const r = await runCli(["tempo-sync", "--dry-run", "--params", '{"period":2}']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("tempo-sync");
    expect(doc.args.period).toBe(2);
  });

  it("binds parameters to a channel through the mocked exec endpoint", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout:
              '{"bound": ["/project1/v/transform1.scale"], "warnings": [], "channel_present": true, "expression": "op(x)[bass]"}',
          },
        }),
      ),
    );
    const r = await runCli(
      [
        "bind",
        "--params",
        '{"targets":["/project1/v/transform1.scale"],"source_chop":"/x","channel":"bass"}',
      ],
      { makeCtx },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).bound).toContain("/project1/v/transform1.scale");
  });
});

describe("tdmcp-agent CLI — phase 2 (live performance)", () => {
  it("lists the performance commands in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["cue", "macro", "randomize", "surface", "remote"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("schema cue exposes the morph action and duration", async () => {
    const r = await runCli(["schema", "cue"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("morph");
    expect(input).toContain("duration");
  });

  it("schema surface exposes faders and cue_buttons", async () => {
    const r = await runCli(["schema", "surface"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("faders");
    expect(input).toContain("cue_buttons");
  });

  it("schema io now includes osc_out and midi_out", async () => {
    const r = await runCli(["schema", "io"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("osc_out");
    expect(input).toContain("midi_out");
  });

  it("dry-runs randomize with an amount", async () => {
    const r = await runCli([
      "randomize",
      "--dry-run",
      "--params",
      '{"comp_path":"/project1/sys","amount":0.5}',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("randomize");
    expect(doc.args.amount).toBe(0.5);
  });

  it("creates a macro through the mocked exec endpoint", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout:
              '{"comp":"/project1/sys","macro":"Energy","bound":["/project1/sys/a.scale"],"warnings":[]}',
          },
        }),
      ),
    );
    const r = await runCli(
      [
        "macro",
        "--params",
        '{"comp_path":"/project1/sys","name":"Energy","targets":[{"param":"/project1/sys/a.scale","min":0,"max":2}]}',
      ],
      { makeCtx },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).macro).toBe("Energy");
  });
});

describe("tdmcp-agent CLI — phase 3 (advanced creation)", () => {
  it("lists the creation commands in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["mixer", "video", "scene3d", "mapping", "keyframe", "simulation"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("dry-runs the layer mixer with a blend mode", async () => {
    const r = await runCli(["mixer", "--dry-run", "--params", '{"blend":"difference"}']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("mixer");
    expect(doc.args.blend).toBe("difference");
  });

  it("schema scene3d exposes the primitive choices", async () => {
    const r = await runCli(["schema", "scene3d"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("sphere");
    expect(input).toContain("primitive");
  });

  it("schema simulation exposes reaction_diffusion / slime / fluid", async () => {
    const r = await runCli(["schema", "simulation"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("reaction_diffusion");
    expect(input).toContain("slime");
    expect(input).toContain("fluid");
  });

  it("rejects keyframe animation with a non-positive duration", async () => {
    const r = await runCli(
      [
        "keyframe",
        "--params",
        '{"targets":["/project1/x.brightness1"],"keyframes":[{"time":0,"value":0},{"time":0,"value":1}]}',
      ],
      { makeCtx },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("positive duration");
  });
});

describe("tdmcp-agent CLI — phase 4 (intelligence)", () => {
  it("lists the intelligence commands in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["operators", "document"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("searches the operator knowledge base (offline)", async () => {
    const r = await runCli(["operators", "--params", '{"query":"blur","limit":5}'], { makeCtx });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.count).toBeGreaterThan(0);
    expect(JSON.stringify(doc.operators).toLowerCase()).toContain("blur");
  });

  it("documents a network into a mermaid flowchart via the mocked bridge", async () => {
    const r = await runCli(["document", "--params", '{"path":"/project1"}'], { makeCtx });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.mermaid).toContain("flowchart");
    expect(doc.nodeCount).toBeGreaterThanOrEqual(1);
  });
});

describe("tdmcp-agent CLI — phase 5 (robustness & export)", () => {
  it("lists the robustness/export commands in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["diff", "optimize", "render", "recipes", "recipe"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("lists the recipe library offline", async () => {
    const r = await runCli(["recipes"], { makeCtx });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).count).toBeGreaterThan(0);
  });

  it("diffs two snapshots offline (added node + parameter change)", async () => {
    const r = await runCli([
      "diff",
      "--params",
      JSON.stringify({
        before: { nodes: [{ path: "/a", parameters: { size: 1 } }] },
        after: {
          nodes: [{ path: "/a", parameters: { size: 5 } }, { path: "/b" }],
        },
      }),
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.nodes_added).toContain("/b");
    expect(doc.parameter_changes[0].changes.size).toEqual({ from: 1, to: 5 });
  });

  it("schema render exposes node_path and file", async () => {
    const r = await runCli(["schema", "render"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("node_path");
    expect(input).toContain("file");
  });

  it("schema io now includes keyboard_in and gamepad_in", async () => {
    const r = await runCli(["schema", "io"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("keyboard_in");
    expect(input).toContain("gamepad_in");
  });
});

describe("tdmcp-agent CLI — pending items (0.9.0)", () => {
  it("lists the new commands in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of ["movie", "init", "repl"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it("schema scene3d exposes instances", async () => {
    const r = await runCli(["schema", "scene3d"]);
    expect(r.code).toBe(0);
    expect(JSON.stringify(JSON.parse(r.stdout).input)).toContain("instances");
  });

  it("schema operators exposes the semantic opt-in", async () => {
    const r = await runCli(["schema", "operators"]);
    expect(r.code).toBe(0);
    expect(JSON.stringify(JSON.parse(r.stdout).input)).toContain("semantic");
  });

  it("schema movie exposes action and seconds", async () => {
    const r = await runCli(["schema", "movie"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("seconds");
    expect(input).toContain("action");
  });

  it("operator search stays in keyword mode by default (no endpoint needed)", async () => {
    const r = await runCli(["operators", "--params", '{"query":"blur"}'], { makeCtx });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).mode).toBe("keyword");
  });
});

describe("tdmcp-agent CLI — phase 7 (stage I/O & sensor reactivity)", () => {
  it("lists motion-reactive in --help", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("motion-reactive");
  });

  it("schema motion-reactive exposes the source choices and analysis resolution", async () => {
    const r = await runCli(["schema", "motion-reactive"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("camera");
    expect(input).toContain("synthetic");
    expect(input).toContain("analysis_resolution");
  });

  it("dry-runs motion-reactive with the safe synthetic source", async () => {
    const r = await runCli(["motion-reactive", "--dry-run", "--params", '{"source":"synthetic"}']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dryRun).toBe(true);
    expect(doc.command).toBe("motion-reactive");
    expect(doc.args.source).toBe("synthetic");
  });

  it("schema text exposes the text content and alignment", async () => {
    const r = await runCli(["schema", "text"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("source_path");
    expect(input).toContain("align");
    expect(input).toContain("font_size");
  });

  it("dry-runs text with a color and alignment", async () => {
    const r = await runCli([
      "text",
      "--dry-run",
      "--params",
      '{"text":"HELLO","color":"#ff3366","valign":"bottom"}',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("text");
    expect(doc.args.text).toBe("HELLO");
    expect(doc.args.valign).toBe("bottom");
  });

  it("schema autopilot exposes the mode and beats cadence", async () => {
    const r = await runCli(["schema", "autopilot"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("randomize");
    expect(input).toContain("cue");
    expect(input).toContain("beats");
  });

  it("dry-runs autopilot in cue mode", async () => {
    const r = await runCli([
      "autopilot",
      "--dry-run",
      "--params",
      '{"comp_path":"/project1/v","mode":"cue","beats":8}',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("autopilot");
    expect(doc.args.mode).toBe("cue");
    expect(doc.args.beats).toBe(8);
  });

  it("schema multi-output exposes count and layout", async () => {
    const r = await runCli(["schema", "multi-output"]);
    expect(r.code).toBe(0);
    const input = JSON.stringify(JSON.parse(r.stdout).input);
    expect(input).toContain("count");
    expect(input).toContain("horizontal");
    expect(input).toContain("as_windows");
  });

  it("dry-runs multi-output across 3 projectors", async () => {
    const r = await runCli([
      "multi-output",
      "--dry-run",
      "--params",
      '{"source_path":"/project1/out1","count":3,"as_windows":true}',
    ]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.command).toBe("multi-output");
    expect(doc.args.count).toBe(3);
    expect(doc.args.as_windows).toBe(true);
  });
});
