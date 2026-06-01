import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { setupTdabletonImpl, setupTdabletonSchema } from "../../src/tools/layer1/setupTdableton.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const script = exec.mock.calls[0]?.[0];
  if (typeof script !== "string")
    throw new Error("executePythonScript was not called with a script string");
  return script;
}

function decodePayload(script: string): Record<string, unknown> {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (!b64) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

function makeOscReport(over: Record<string, unknown> = {}) {
  return {
    container: "/project1/tdableton",
    resolved_mode: "osc",
    palette_resolved: false,
    palette_path: null,
    nulls: {
      tempo: "/project1/tdableton/null_tempo",
      master: "/project1/tdableton/null_master",
      tracks: "/project1/tdableton/null_tracks",
    },
    port_in: 9001,
    port_out: 9000,
    host: "127.0.0.1",
    warnings: [],
    errors: [],
    ...over,
  };
}

function makePaletteReport(over: Record<string, unknown> = {}) {
  return {
    ...makeOscReport(),
    resolved_mode: "palette",
    palette_resolved: true,
    palette_path: "/palette/tdableton",
    ...over,
  };
}

function okExec(report: Record<string, unknown>) {
  return vi.fn(async () => ({ stdout: JSON.stringify(report) }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupTdabletonSchema", () => {
  it("provides sensible defaults", () => {
    const args = setupTdabletonSchema.parse({});
    expect(args.parent_path).toBe("/project1");
    expect(args.name).toBe("tdableton");
    expect(args.mode).toBe("auto");
    expect(args.port_in).toBe(9001);
    expect(args.port_out).toBe(9000);
    expect(args.track_count).toBe(8);
    expect(args.expose_devices).toBe(false);
    expect(args.include_master).toBe(true);
    expect(args.include_tempo).toBe(true);
  });
});

describe("setupTdabletonImpl", () => {
  // ── 1. Default args ────────────────────────────────────────────────────────
  it("default args — returns success with nulls.tempo set and summary mentions mode", async () => {
    const report = makePaletteReport();
    const exec = okExec(report);
    const result = await setupTdabletonImpl(fakeCtx(exec), setupTdabletonSchema.parse({}));

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // resolved_mode from the canned report
    expect(text).toContain("palette");
    // null_tempo is set in the report
    expect(text).toContain("null_tempo");
    // summary mentions container path
    expect(text).toContain("/project1/tdableton");
  });

  // ── 2. Custom OSC ports + host in payload ─────────────────────────────────
  it("mode=osc with custom ports — payload encodes port_in, port_out, host", async () => {
    const exec = okExec(makeOscReport({ port_in: 7000, port_out: 7001, host: "192.168.1.10" }));
    await setupTdabletonImpl(
      fakeCtx(exec),
      setupTdabletonSchema.parse({
        mode: "osc",
        port_in: 7000,
        port_out: 7001,
        host: "192.168.1.10",
      }),
    );

    const payload = decodePayload(scriptArg(exec));
    expect(payload.port_in).toBe(7000);
    expect(payload.port_out).toBe(7001);
    expect(payload.host).toBe("192.168.1.10");
    expect(payload.mode).toBe("osc");
  });

  // ── 3. Palette miss in auto — still returns nulls.tracks ─────────────────
  it("palette miss in auto mode — resolved_mode=osc, warning surfaced, nulls.tracks present", async () => {
    const report = makeOscReport({
      resolved_mode: "osc",
      palette_resolved: false,
      warnings: ["TDAbleton Palette component not found. Falling back to OSC."],
    });
    const exec = okExec(report);
    const result = await setupTdabletonImpl(
      fakeCtx(exec),
      setupTdabletonSchema.parse({ mode: "auto" }),
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // mode is osc
    expect(text).toContain("osc");
    // nulls.tracks is in the report and its binding appears in summary
    expect(text).toContain("null_tracks");
  });

  // ── 4. expose_devices + track_count=16 — payload and summary ─────────────
  it("expose_devices=true track_count=16 — payload reflects these, summary mentions devices", async () => {
    const report = makeOscReport({
      nulls: {
        tempo: "/project1/tdableton/null_tempo",
        master: "/project1/tdableton/null_master",
        tracks: "/project1/tdableton/null_tracks",
        devices: "/project1/tdableton/null_devices",
      },
    });
    const exec = okExec(report);
    const result = await setupTdabletonImpl(
      fakeCtx(exec),
      setupTdabletonSchema.parse({ track_count: 16, expose_devices: true, device_param_count: 4 }),
    );

    expect(result.isError).toBeFalsy();

    const payload = decodePayload(scriptArg(exec));
    expect(payload.track_count).toBe(16);
    expect(payload.expose_devices).toBe(true);
    expect(payload.device_param_count).toBe(4);

    const text = textOf(result);
    expect(text).toContain("null_devices");
    // device params note appears in summary
    expect(text).toContain("device params");
  });

  // ── 5. TD offline — guardTd returns friendly errorResult ─────────────────
  it("TD offline — returns isError with friendly message", async () => {
    const exec = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const result = await setupTdabletonImpl(fakeCtx(exec), setupTdabletonSchema.parse({}));

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text.length).toBeGreaterThan(0);
  });

  // ── 6. Fatal in report — returns errorResult echoing fatal ────────────────
  it("fatal in report — returns isError containing the fatal message", async () => {
    const exec = okExec({
      container: "",
      resolved_mode: "osc",
      palette_resolved: false,
      nulls: {},
      port_in: 9001,
      port_out: 9000,
      host: "127.0.0.1",
      warnings: [],
      errors: [],
      fatal: "Parent COMP not found: /does/not/exist",
    });
    const result = await setupTdabletonImpl(
      fakeCtx(exec),
      setupTdabletonSchema.parse({ parent_path: "/does/not/exist" }),
    );

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Parent COMP not found");
  });

  // ── 7. Address map template in payload script (OSC branch) ───────────────
  it("mode=osc — script contains ADDRESS_MAP template with /live/ addresses", async () => {
    const exec = okExec(makeOscReport());
    await setupTdabletonImpl(fakeCtx(exec), setupTdabletonSchema.parse({ mode: "osc" }));

    const script = scriptArg(exec);
    expect(script).toContain("/live/tempo");
    expect(script).toContain("/live/master/volume");
    expect(script).toContain("address_map");
  });
});
