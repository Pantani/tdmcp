import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdApiError } from "../../src/td-client/types.js";
import {
  buildInspectScript,
  inspectComponentImpl,
  inspectComponentSchema,
} from "../../src/tools/layer3/inspectComponent.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Payload {
  path: string;
  include_storage: boolean;
  include_extensions: boolean;
  include_custom_pars: boolean;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

function fakeCtx(
  exec: ReturnType<typeof vi.fn>,
  getCustomParams?: (...args: unknown[]) => Promise<unknown>,
): ToolContext {
  // Default getCustomParams to a missing-endpoint TdApiError (404) so legacy
  // tests that pre-date the wave-9 REST promotion still exercise the in-script
  // custom_pars readout via the exec fallback.
  const gcp =
    getCustomParams ??
    (async () => {
      throw new TdApiError("not found", { status: 404 });
    });
  return {
    client: { executePythonScript: exec, getCustomParams: gcp },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const s = exec.mock.calls[0]?.[0];
  if (typeof s !== "string") throw new Error("executePythonScript not called with a string");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// A full happy-path report from the bridge.
const FULL_REPORT = {
  path: "/project1/myComp",
  type: "baseCOMP",
  storage: { speed: 1.5, label: "fast" },
  extensions: [
    {
      name: "WidgetExt",
      promoted: true,
      members: ["Reset", "Tick", "ownerComp"],
    },
  ],
  custom_pars: [
    { page: "Custom", name: "Speed", style: "Float", default: 1.0 },
    { page: "Custom", name: "Enabled", style: "Toggle", default: true },
  ],
  probe: {
    storage_attr: "storage",
    extensions_attr: "extensions",
    customPars_attr: "customPars",
  },
  warnings: [],
};

const okReport = (over: Record<string, unknown> = {}) =>
  vi.fn(async (_script: string, _capture?: boolean) => ({
    stdout: JSON.stringify({ ...FULL_REPORT, ...over }),
  }));

// Parse args through the schema so all defaults are applied — required because
// vitest strips types and tsc would catch missing defaulted fields in the impl call.
const args = (over: Record<string, unknown> = {}) =>
  inspectComponentSchema.parse({ path: "/project1/myComp", ...over });

// ---------------------------------------------------------------------------
// buildInspectScript — payload round-trip
// ---------------------------------------------------------------------------

describe("buildInspectScript", () => {
  it("round-trips all four payload fields via base64", () => {
    const script = buildInspectScript({
      path: "/project1/myComp",
      include_storage: true,
      include_extensions: false,
      include_custom_pars: true,
    });
    const p = decodePayload(script);
    expect(p.path).toBe("/project1/myComp");
    expect(p.include_storage).toBe(true);
    expect(p.include_extensions).toBe(false);
    expect(p.include_custom_pars).toBe(true);
  });

  it("script contains isCOMP guard and defensive probe patterns", () => {
    const script = buildInspectScript({
      path: "/p/c",
      include_storage: true,
      include_extensions: true,
      include_custom_pars: true,
    });
    // Must guard against a missing op and non-COMP ops.
    expect(script).toContain("isCOMP");
    expect(script).toContain("Not found:");
    // Must probe storage defensively with getattr.
    expect(script).toContain('getattr(_c, "storage"');
    // Must probe both extensions list (extensions attr) and ext namespace fallback.
    expect(script).toContain('getattr(_c, "extensions"');
    expect(script).toContain('getattr(_c, "ext"');
    // Must probe customPars and fall back to customPages.
    expect(script).toContain('getattr(_c, "customPars"');
    expect(script).toContain('getattr(_c, "customPages"');
    // probe dict must be written to report.
    expect(script).toContain('report["probe"]');
    // Report is emitted as last line of stdout.
    expect(script).toContain("print(json.dumps(report))");
  });

  it("does not interpolate the path string directly into Python (uses base64 payload)", () => {
    const tricky = '/project1/comp with "quotes" and \\backslash';
    const script = buildInspectScript({
      path: tricky,
      include_storage: true,
      include_extensions: true,
      include_custom_pars: true,
    });
    // The raw tricky string must NOT appear in the script source (it travels via b64).
    expect(script).not.toContain(tricky);
    // But decoding the payload recovers it intact.
    expect(decodePayload(script).path).toBe(tricky);
  });
});

// ---------------------------------------------------------------------------
// inspectComponentImpl — happy path
// ---------------------------------------------------------------------------

describe("inspectComponentImpl (happy path)", () => {
  it("calls executePythonScript with capture=true", async () => {
    const exec = okReport();
    await inspectComponentImpl(fakeCtx(exec), args());
    expect(exec.mock.calls[0]?.[1]).toBe(true);
  });

  it("sends the correct path and all three include flags in the payload", async () => {
    const exec = okReport();
    await inspectComponentImpl(
      fakeCtx(exec),
      args({ include_storage: true, include_extensions: false, include_custom_pars: true }),
    );
    const p = decodePayload(scriptArg(exec));
    expect(p.path).toBe("/project1/myComp");
    expect(p.include_storage).toBe(true);
    expect(p.include_extensions).toBe(false);
    expect(p.include_custom_pars).toBe(true);
  });

  it("returns a structuredResult (no isError) with all three sections populated", async () => {
    const result = await inspectComponentImpl(fakeCtx(okReport()), args());
    expect(result.isError).toBeFalsy();
    const sc = (result as { structuredContent?: unknown }).structuredContent as typeof FULL_REPORT;
    expect(sc).toBeDefined();
    expect(sc.path).toBe("/project1/myComp");
    expect(sc.type).toBe("baseCOMP");
    // Storage section.
    expect(sc.storage).toMatchObject({ speed: 1.5, label: "fast" });
    // Extensions section.
    expect(sc.extensions).toHaveLength(1);
    expect(sc.extensions[0]?.name).toBe("WidgetExt");
    expect(sc.extensions[0]?.promoted).toBe(true);
    expect(sc.extensions[0]?.members).toContain("Reset");
    // Custom pars section.
    expect(sc.custom_pars).toHaveLength(2);
    expect(sc.custom_pars[0]?.name).toBe("Speed");
    expect(sc.custom_pars[1]?.style).toBe("Toggle");
    // warnings list.
    expect(sc.warnings).toEqual([]);
  });

  it("summary text encodes storage/extension/custom-par counts", async () => {
    const result = await inspectComponentImpl(fakeCtx(okReport()), args());
    const text = textOf(result);
    expect(text).toContain("/project1/myComp");
    expect(text).toMatch(/2 storage key\(s\)/);
    expect(text).toMatch(/1 extension\(s\)/);
    expect(text).toMatch(/2 custom par\(s\)/);
  });

  it("summary shows zero counts when sections are empty", async () => {
    const exec = okReport({ storage: {}, extensions: [], custom_pars: [] });
    const result = await inspectComponentImpl(fakeCtx(exec), args());
    const text = textOf(result);
    expect(text).toMatch(/0 storage key\(s\)/);
    expect(text).toMatch(/0 extension\(s\)/);
    expect(text).toMatch(/0 custom par\(s\)/);
  });

  it("carries probe dict in structuredContent", async () => {
    const result = await inspectComponentImpl(fakeCtx(okReport()), args());
    const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(sc?.probe).toMatchObject({ storage_attr: "storage" });
  });

  it("surfaces bridge warnings in structuredContent without failing", async () => {
    const exec = okReport({
      warnings: ["storage key 'fn': value not JSON-serializable, stored as string."],
    });
    const result = await inspectComponentImpl(fakeCtx(exec), args());
    expect(result.isError).toBeFalsy();
    const sc = (result as { structuredContent?: { warnings: string[] } }).structuredContent;
    expect(sc?.warnings).toHaveLength(1);
    expect(sc?.warnings[0]).toContain("not JSON-serializable");
  });
});

// ---------------------------------------------------------------------------
// inspectComponentImpl — schema defaults
// ---------------------------------------------------------------------------

describe("inspectComponentSchema defaults", () => {
  it("defaults all three include flags to true", () => {
    const parsed = inspectComponentSchema.parse({ path: "/p/c" });
    expect(parsed.include_storage).toBe(true);
    expect(parsed.include_extensions).toBe(true);
    expect(parsed.include_custom_pars).toBe(true);
  });

  it("accepts overriding individual flags to false", () => {
    const parsed = inspectComponentSchema.parse({
      path: "/p/c",
      include_storage: false,
      include_extensions: false,
    });
    expect(parsed.include_storage).toBe(false);
    expect(parsed.include_extensions).toBe(false);
    expect(parsed.include_custom_pars).toBe(true);
  });

  it("rejects a missing path", () => {
    expect(() => inspectComponentSchema.parse({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// inspectComponentImpl — fatal / no-throw guarantees
// ---------------------------------------------------------------------------

describe("inspectComponentImpl (fatal + no-throw)", () => {
  it("returns isError when report.fatal is set (COMP not found)", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        path: "/project1/missing",
        type: "",
        warnings: [],
        fatal: "Not found: /project1/missing",
      }),
    }));
    const result = await inspectComponentImpl(fakeCtx(exec), args({ path: "/project1/missing" }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Not found");
  });

  it("returns isError when report.fatal is set (not a COMP)", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        path: "/project1/noise1",
        type: "noiseTOP",
        warnings: [],
        fatal: "/project1/noise1 is not a COMP.",
      }),
    }));
    const result = await inspectComponentImpl(fakeCtx(exec), args({ path: "/project1/noise1" }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("is not a COMP");
  });

  it("never throws when the bridge call rejects — returns isError instead", async () => {
    const exec = vi.fn(async () => {
      throw new Error("connection refused");
    });
    // Must not throw — any exception here would propagate and fail the test.
    const result = await inspectComponentImpl(fakeCtx(exec), args());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connection refused");
  });

  it("never throws when the bridge returns empty stdout — returns isError instead", async () => {
    const exec = vi.fn(async () => ({ stdout: "" }));
    // Must not throw — parsePythonReport throws on empty stdout; guardTd catches it.
    const result = await inspectComponentImpl(fakeCtx(exec), args());
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// inspectComponentImpl — flag combinations
// ---------------------------------------------------------------------------

describe("inspectComponentImpl (flag combinations)", () => {
  it("passes include_storage=false in payload when disabled", async () => {
    const exec = okReport({ storage: undefined });
    await inspectComponentImpl(fakeCtx(exec), args({ include_storage: false }));
    const p = decodePayload(scriptArg(exec));
    expect(p.include_storage).toBe(false);
  });

  it("passes include_extensions=false in payload when disabled", async () => {
    const exec = okReport({ extensions: undefined });
    await inspectComponentImpl(fakeCtx(exec), args({ include_extensions: false }));
    const p = decodePayload(scriptArg(exec));
    expect(p.include_extensions).toBe(false);
  });

  it("passes include_custom_pars=false in payload when disabled", async () => {
    const exec = okReport({ custom_pars: undefined });
    await inspectComponentImpl(fakeCtx(exec), args({ include_custom_pars: false }));
    const p = decodePayload(scriptArg(exec));
    expect(p.include_custom_pars).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wave-9 — REST custom_params endpoint promotion (partial, custom_pars only)
// ---------------------------------------------------------------------------

describe("inspectComponentImpl — REST custom_params promotion", () => {
  // Skeleton report the exec script returns when skip_custom_in_script=true.
  const skeleton = (over: Record<string, unknown> = {}) => ({
    path: "/project1/myComp",
    type: "baseCOMP",
    storage: { speed: 1.5 },
    extensions: [],
    probe: { storage_attr: "storage" },
    warnings: [],
    ...over,
  });

  it("REST-first: prefers /custom_params endpoint and skips the in-script readout", async () => {
    const exec = vi.fn(async () => ({ stdout: JSON.stringify(skeleton()) }));
    const getCustomParams = vi.fn(async () => ({
      params: [
        { name: "Speed", page: "Custom", style: "Float", default: 1.0, value: 1.0 },
        { name: "Enabled", page: "Custom", style: "Toggle", default: true, value: true },
      ],
      warnings: [],
    }));
    const result = await inspectComponentImpl(fakeCtx(exec, getCustomParams), args());
    expect(result.isError).toBeFalsy();
    // Exec called exactly once (no fallback after REST success).
    expect(exec).toHaveBeenCalledTimes(1);
    // Exec payload instructed the script to SKIP the in-script custom_pars readout.
    const payload = decodePayload(scriptArg(exec)) as Payload & {
      skip_custom_in_script?: boolean;
    };
    expect(payload.skip_custom_in_script).toBe(true);
    // REST called once with the inspected path.
    expect(getCustomParams).toHaveBeenCalledTimes(1);
    expect(getCustomParams).toHaveBeenCalledWith("/project1/myComp");
    // The mapped CustomParEntry shape (page/name/style/default) lands intact.
    const sc = result.structuredContent as {
      custom_pars?: Array<{ page: string; name: string; style: string; default?: unknown }>;
      probe?: Record<string, unknown>;
    };
    expect(sc.custom_pars).toEqual([
      { page: "Custom", name: "Speed", style: "Float", default: 1.0 },
      { page: "Custom", name: "Enabled", style: "Toggle", default: true },
    ]);
    expect(sc.probe?.custom_params_endpoint).toBe("ok");
  });

  it("falls back to in-script custom_pars readout when the REST endpoint is absent (404)", async () => {
    // The default fakeCtx already throws TdApiError 404 on getCustomParams.
    const exec = okReport();
    const result = await inspectComponentImpl(fakeCtx(exec), args());
    expect(result.isError).toBeFalsy();
    // First exec: skeleton (skip=true). Second exec: legacy readout (skip=false).
    expect(exec).toHaveBeenCalledTimes(2);
    const first = decodePayload(exec.mock.calls[0]?.[0] as string) as Payload & {
      skip_custom_in_script?: boolean;
    };
    const second = decodePayload(exec.mock.calls[1]?.[0] as string) as Payload & {
      skip_custom_in_script?: boolean;
    };
    expect(first.skip_custom_in_script).toBe(true);
    expect(second.skip_custom_in_script).toBe(false);
    // Output shape preserved — in-script readout is what the user sees.
    const sc = result.structuredContent as {
      custom_pars?: Array<{ page: string; name: string; style: string }>;
    };
    expect(sc.custom_pars).toEqual([
      { page: "Custom", name: "Speed", style: "Float", default: 1.0 },
      { page: "Custom", name: "Enabled", style: "Toggle", default: true },
    ]);
  });
});
