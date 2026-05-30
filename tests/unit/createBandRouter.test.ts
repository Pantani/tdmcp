import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdConnectionError } from "../../src/td-client/types.js";
import {
  buildBandRouterScript,
  createBandRouterImpl,
  createBandRouterSchema,
} from "../../src/tools/layer2/createBandRouter.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PayloadTarget {
  band: number;
  node_param: string;
  scale: number;
  offset: number;
}

interface Payload {
  parent_path: string;
  name: string;
  source_chop: string;
  bands: number;
  smooth: number;
  targets: PayloadTarget[];
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: { executePythonScript: exec },
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

/** A representative success report the Python pass would emit. */
function happyReport(
  overrides: Partial<{
    bands: number;
    bound: string[];
    warnings: string[];
    split_optype: string;
    level_function: string;
  }> = {},
) {
  return JSON.stringify({
    container: "/project1/band_router",
    bands_out: "/project1/band_router/bands_out",
    bands: overrides.bands ?? 4,
    split_optype: overrides.split_optype ?? "audiofilterCHOP",
    level_function: overrides.level_function ?? "rmspower",
    lag_chop: "/project1/band_router/smooth",
    bound: overrides.bound ?? [],
    warnings: overrides.warnings ?? [],
  });
}

// ---------------------------------------------------------------------------
// buildBandRouterScript — pure, no TD needed
// ---------------------------------------------------------------------------

describe("buildBandRouterScript (pure payload)", () => {
  it("embeds all schema fields in the base64 payload", () => {
    const script = buildBandRouterScript({
      parent_path: "/project1",
      name: "band_router",
      source_chop: "/project1/audiodevin1",
      bands: 4,
      smooth: 0.1,
      targets: [],
    });
    const payload = decodePayload(script);
    expect(payload.parent_path).toBe("/project1");
    expect(payload.name).toBe("band_router");
    expect(payload.source_chop).toBe("/project1/audiodevin1");
    expect(payload.bands).toBe(4);
    expect(payload.smooth).toBe(0.1);
    expect(payload.targets).toEqual([]);
  });

  it("embeds targets list (band/node_param/scale/offset) when provided", () => {
    const script = buildBandRouterScript({
      parent_path: "/project1",
      name: "br",
      source_chop: "/project1/audiofilein1",
      bands: 3,
      smooth: 0.05,
      targets: [
        { band: 0, node_param: "/project1/glow1.intensity", scale: 2, offset: 0 },
        { band: 2, node_param: "/project1/blur1.size", scale: 1, offset: 0.1 },
      ],
    });
    const payload = decodePayload(script);
    expect(payload.bands).toBe(3);
    expect(payload.targets).toHaveLength(2);
    expect(payload.targets[0]).toEqual({
      band: 0,
      node_param: "/project1/glow1.intensity",
      scale: 2,
      offset: 0,
    });
    expect(payload.targets[1]?.band).toBe(2);
    expect(payload.targets[1]?.node_param).toBe("/project1/blur1.size");
  });

  it("uses only base64 for the payload — no raw source_chop literal in the template", () => {
    const tricky = "/project1/UNIQUEMARKER_xyzzy";
    const script = buildBandRouterScript({
      parent_path: "/project1",
      name: "br",
      source_chop: tricky,
      bands: 4,
      smooth: 0.1,
      targets: [],
    });
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1] ?? "";
    expect(b64.length).toBeGreaterThan(0);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain(tricky);
    const templateWithoutBlob = script.replace(b64, "REDACTED");
    expect(templateWithoutBlob).not.toContain("UNIQUEMARKER_xyzzy");
  });

  it("script imports json/base64 and prints json.dumps(report); uses the audio idioms", () => {
    const script = buildBandRouterScript({
      parent_path: "/project1",
      name: "br",
      source_chop: "/project1/audio",
      bands: 4,
      smooth: 0.1,
      targets: [],
    });
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
    // Band split (audioFilter + analyze rmspower) + smoothing chain present in the template.
    expect(script).toContain("selectCHOP");
    expect(script).toContain("audiofilterCHOP");
    expect(script).toContain("audiospectrumCHOP");
    expect(script).toContain("analyzeCHOP");
    expect(script).toContain("rmspower");
    expect(script).toContain("lagCHOP");
    expect(script).toContain("nullCHOP");
  });
});

// ---------------------------------------------------------------------------
// Schema defaults / coercion / validation
// ---------------------------------------------------------------------------

describe("createBandRouterSchema defaults", () => {
  it("applies all documented defaults", () => {
    const parsed = createBandRouterSchema.parse({ source_chop: "/project1/audio" });
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("band_router");
    expect(parsed.bands).toBe(4);
    expect(parsed.smooth).toBe(0.1);
    expect(parsed.targets).toEqual([]);
  });

  it("coerces numeric strings for bands/smooth and per-target scale/offset", () => {
    const parsed = createBandRouterSchema.parse({
      source_chop: "/s",
      bands: "6",
      smooth: "0.2",
      targets: [{ band: "1", node_param: "/a.b", scale: "3", offset: "0.5" }],
    });
    expect(parsed.bands).toBe(6);
    expect(parsed.smooth).toBe(0.2);
    expect(parsed.targets[0]?.band).toBe(1);
    expect(parsed.targets[0]?.scale).toBe(3);
    expect(parsed.targets[0]?.offset).toBe(0.5);
  });

  it("defaults per-target scale=1 and offset=0", () => {
    const parsed = createBandRouterSchema.parse({
      source_chop: "/s",
      targets: [{ band: 0, node_param: "/a.b" }],
    });
    expect(parsed.targets[0]?.scale).toBe(1);
    expect(parsed.targets[0]?.offset).toBe(0);
  });

  it("rejects bands < 2", () => {
    expect(() => createBandRouterSchema.parse({ source_chop: "/s", bands: 1 })).toThrow();
  });

  it("rejects bands > 8", () => {
    expect(() => createBandRouterSchema.parse({ source_chop: "/s", bands: 9 })).toThrow();
  });

  it("rejects negative smooth", () => {
    expect(() => createBandRouterSchema.parse({ source_chop: "/s", smooth: -0.1 })).toThrow();
  });

  it("requires source_chop", () => {
    expect(() => createBandRouterSchema.parse({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Happy path — impl integration
// ---------------------------------------------------------------------------

describe("createBandRouterImpl — happy path", () => {
  it("returns a non-error result with a summary line", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createBandRouterImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "band_router",
      source_chop: "/project1/audiodevin1",
      bands: 4,
      smooth: 0.1,
      targets: [],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/audiodevin1");
    expect(text).toContain("4 EQ band(s)");
    expect(text).toContain("audiofilterCHOP");
    expect(text).toContain("rmspower");
    expect(text).toContain("smooth 0.1s");
    expect(text).toContain("/project1/band_router/bands_out");
  });

  it("sends the correct payload (source_chop, bands, smooth, targets)", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport({ bands: 6 }) }));
    await createBandRouterImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "br",
      source_chop: "/project1/audiofilein1",
      bands: 6,
      smooth: 0.15,
      targets: [{ band: 0, node_param: "/project1/glow1.intensity", scale: 2, offset: 0 }],
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.source_chop).toBe("/project1/audiofilein1");
    expect(payload.bands).toBe(6);
    expect(payload.smooth).toBe(0.15);
    expect(payload.targets).toHaveLength(1);
    expect(payload.targets[0]?.band).toBe(0);
    expect(payload.targets[0]?.node_param).toBe("/project1/glow1.intensity");
    expect(payload.targets[0]?.scale).toBe(2);
  });

  it("reports routed band count in summary when targets are bound", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        bound: ["/project1/glow1.intensity", "/project1/blur1.size"],
      }),
    }));
    const result = await createBandRouterImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "br",
      source_chop: "/project1/audio",
      bands: 4,
      smooth: 0.1,
      targets: [
        { band: 0, node_param: "/project1/glow1.intensity", scale: 1, offset: 0 },
        { band: 3, node_param: "/project1/blur1.size", scale: 1, offset: 0 },
      ],
    });
    const text = textOf(result);
    expect(text).toContain("routed 2 band(s)");
  });

  it("includes a warning count and the fallback optype when present", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        split_optype: "audiospectrumCHOP",
        warnings: [
          "audiofilterCHOP unavailable; used audiospectrumCHOP with a single combined level on 'band0'.",
          "analyzeCHOP function='rmspower' could not be set; using op default level. UNVERIFIED-live.",
        ],
      }),
    }));
    const result = await createBandRouterImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "br",
      source_chop: "/project1/audio",
      bands: 4,
      smooth: 0.1,
      targets: [],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("audiospectrumCHOP");
    expect(text).toContain("2 warning(s)");
  });
});

// ---------------------------------------------------------------------------
// Fatal — source / parent not found
// ---------------------------------------------------------------------------

describe("createBandRouterImpl — fatal (source not found)", () => {
  it("returns isError:true and does not throw", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "",
        bands_out: "",
        bands: 4,
        split_optype: "",
        level_function: "",
        lag_chop: "",
        bound: [],
        warnings: [],
        fatal: "Source CHOP not found: /project1/missing",
      }),
    }));
    const result = await createBandRouterImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "br",
      source_chop: "/project1/missing",
      bands: 4,
      smooth: 0.1,
      targets: [],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Source CHOP not found");
  });
});

// ---------------------------------------------------------------------------
// TD offline — guardTd swallows the (Td)connection error
// ---------------------------------------------------------------------------

describe("createBandRouterImpl — TD offline", () => {
  it("returns isError:true and does not throw when the bridge is unreachable", async () => {
    const exec = vi.fn(async () => {
      throw new TdConnectionError("ECONNREFUSED");
    });
    // guardTd must catch the TdError and return an isError result — no throw out of impl.
    const result = await createBandRouterImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "br",
      source_chop: "/project1/audio",
      bands: 4,
      smooth: 0.1,
      targets: [],
    });
    expect(result.isError).toBe(true);
  });
});
