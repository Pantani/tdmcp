import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildSidechainPumpScript,
  createSidechainPumpImpl,
  createSidechainPumpSchema,
} from "../../src/tools/layer2/createSidechainPump.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Payload {
  parent_path: string;
  name: string;
  source_chop: string;
  channel: string;
  targets: string[];
  depth: number;
  attack: number;
  release: number;
  rest_value: number;
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
    bound: string[];
    warnings: string[];
    depth: number;
  }> = {},
) {
  return JSON.stringify({
    container: "/project1/sidechain_pump",
    pump_chop: "/project1/sidechain_pump/pump",
    bound: overrides.bound ?? [],
    depth: overrides.depth ?? 0.8,
    warnings: overrides.warnings ?? [],
  });
}

// ---------------------------------------------------------------------------
// buildSidechainPumpScript — pure, no TD needed
// ---------------------------------------------------------------------------

describe("buildSidechainPumpScript (pure payload)", () => {
  it("embeds all schema fields in the base64 payload", () => {
    const script = buildSidechainPumpScript({
      parent_path: "/project1",
      name: "sidechain_pump",
      source_chop: "/project1/audio/onsets",
      channel: "kick",
      targets: [],
      depth: 0.8,
      attack: 0.005,
      release: 0.25,
      rest_value: 1.0,
    });
    const payload = decodePayload(script);
    expect(payload.parent_path).toBe("/project1");
    expect(payload.name).toBe("sidechain_pump");
    expect(payload.source_chop).toBe("/project1/audio/onsets");
    expect(payload.channel).toBe("kick");
    expect(payload.targets).toEqual([]);
    expect(payload.depth).toBe(0.8);
    expect(payload.attack).toBe(0.005);
    expect(payload.release).toBe(0.25);
    expect(payload.rest_value).toBe(1.0);
  });

  it("embeds a multi-target list in the payload", () => {
    const script = buildSidechainPumpScript({
      parent_path: "/project1",
      name: "pump",
      source_chop: "/project1/onsets",
      channel: "level",
      targets: ["/project1/layer1.opacity", "/project1/gain1.gain", "/project1/blur.size"],
      depth: 0.9,
      attack: 0.001,
      release: 0.3,
      rest_value: 1.0,
    });
    const payload = decodePayload(script);
    expect(payload.targets).toHaveLength(3);
    expect(payload.targets).toContain("/project1/layer1.opacity");
    expect(payload.targets).toContain("/project1/gain1.gain");
    expect(payload.targets).toContain("/project1/blur.size");
  });

  it("payload source_chop never appears raw outside the base64 blob", () => {
    const tricky = "/project1/UNIQUEMARKER_xyzzy";
    const script = buildSidechainPumpScript({
      parent_path: "/project1",
      name: "pump",
      source_chop: tricky,
      channel: "level",
      targets: [],
      depth: 0.8,
      attack: 0.005,
      release: 0.25,
      rest_value: 1.0,
    });
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1] ?? "";
    expect(b64.length).toBeGreaterThan(0);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain(tricky);
    const templateWithoutBlob = script.replace(b64, "REDACTED");
    expect(templateWithoutBlob).not.toContain("UNIQUEMARKER_xyzzy");
  });

  it("script imports json and base64 and prints json.dumps(report)", () => {
    const script = buildSidechainPumpScript({
      parent_path: "/project1",
      name: "pump",
      source_chop: "/project1/audio",
      channel: "level",
      targets: [],
      depth: 0.8,
      attack: 0.005,
      release: 0.25,
      rest_value: 1.0,
    });
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
    expect(script).toContain("selectCHOP");
    expect(script).toContain("lagCHOP");
    // Clamp to [0,1] uses a Limit CHOP (Math CHOP has no clamp pars — confirmed
    // live on TD 099 build 2025.32820); type="clamp", min, max.
    expect(script).toContain("limitCHOP");
    expect(script).toContain("nullCHOP");
  });

  it("script contains the pump expression template", () => {
    const script = buildSidechainPumpScript({
      parent_path: "/project1",
      name: "pump",
      source_chop: "/project1/audio",
      channel: "level",
      targets: [],
      depth: 0.8,
      attack: 0.005,
      release: 0.25,
      rest_value: 1.0,
    });
    // Expression pattern: rest * (1 - depth * op(path)[chan])
    expect(script).toContain("(1 - %r * op(%r)[%r])");
  });
});

// ---------------------------------------------------------------------------
// Schema defaults and validation
// ---------------------------------------------------------------------------

describe("createSidechainPumpSchema defaults", () => {
  it("applies all documented defaults when only source_chop is supplied", () => {
    const parsed = createSidechainPumpSchema.parse({
      source_chop: "/project1/onsets",
    });
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("sidechain_pump");
    expect(parsed.channel).toBe("level");
    expect(parsed.targets).toEqual([]);
    expect(parsed.depth).toBe(0.8);
    expect(parsed.attack).toBe(0.005);
    expect(parsed.release).toBe(0.25);
    expect(parsed.rest_value).toBe(1.0);
  });

  it("coerces numeric strings for depth/attack/release/rest_value", () => {
    const parsed = createSidechainPumpSchema.parse({
      source_chop: "/project1/s",
      depth: "0.9",
      attack: "0.01",
      release: "0.5",
      rest_value: "0.8",
    });
    expect(parsed.depth).toBe(0.9);
    expect(parsed.attack).toBe(0.01);
    expect(parsed.release).toBe(0.5);
    expect(parsed.rest_value).toBe(0.8);
  });

  it("rejects depth > 1", () => {
    expect(() => createSidechainPumpSchema.parse({ source_chop: "/s", depth: 1.5 })).toThrow();
  });

  it("rejects depth < 0", () => {
    expect(() => createSidechainPumpSchema.parse({ source_chop: "/s", depth: -0.1 })).toThrow();
  });

  it("rejects negative attack", () => {
    expect(() => createSidechainPumpSchema.parse({ source_chop: "/s", attack: -0.001 })).toThrow();
  });

  it("rejects negative release", () => {
    expect(() => createSidechainPumpSchema.parse({ source_chop: "/s", release: -1 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Happy path — impl integration
// ---------------------------------------------------------------------------

describe("createSidechainPumpImpl — happy path", () => {
  it("returns a non-error result with a summary line", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createSidechainPumpImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "sidechain_pump",
      source_chop: "/project1/audio/onsets",
      channel: "kick",
      targets: [],
      depth: 0.8,
      attack: 0.005,
      release: 0.25,
      rest_value: 1.0,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("sidechain pump");
    expect(text).toContain("/project1/audio/onsets");
    expect(text).toContain("'kick'");
    expect(text).toContain("depth 0.8");
    expect(text).toContain("attack 0.005s");
    expect(text).toContain("release 0.25s");
    expect(text).toContain("/project1/sidechain_pump/pump");
  });

  it("sends the correct payload (all schema fields)", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createSidechainPumpImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "pump",
      source_chop: "/project1/onsets/kick_null",
      channel: "kick",
      targets: [],
      depth: 0.75,
      attack: 0.002,
      release: 0.4,
      rest_value: 1.0,
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.parent_path).toBe("/project1");
    expect(payload.name).toBe("pump");
    expect(payload.source_chop).toBe("/project1/onsets/kick_null");
    expect(payload.channel).toBe("kick");
    expect(payload.targets).toEqual([]);
    expect(payload.depth).toBe(0.75);
    expect(payload.attack).toBe(0.002);
    expect(payload.release).toBe(0.4);
    expect(payload.rest_value).toBe(1.0);
  });

  it("passes a multi-target list through the payload", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        bound: ["/project1/layer1.opacity", "/project1/gain1.gain"],
      }),
    }));
    await createSidechainPumpImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "pump",
      source_chop: "/project1/onsets",
      channel: "kick",
      targets: ["/project1/layer1.opacity", "/project1/gain1.gain"],
      depth: 0.8,
      attack: 0.005,
      release: 0.25,
      rest_value: 1.0,
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.targets).toContain("/project1/layer1.opacity");
    expect(payload.targets).toContain("/project1/gain1.gain");
  });

  it("reports bound count in summary when targets are bound", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        bound: ["/project1/layer1.opacity", "/project1/gain1.gain", "/project1/blur.size"],
      }),
    }));
    const result = await createSidechainPumpImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "pump",
      source_chop: "/project1/audio",
      channel: "level",
      targets: ["/project1/layer1.opacity", "/project1/gain1.gain", "/project1/blur.size"],
      depth: 0.8,
      attack: 0.005,
      release: 0.25,
      rest_value: 1.0,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("bound 3 target(s)");
  });

  it("no bound note in summary when no targets given", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createSidechainPumpImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "pump",
      source_chop: "/project1/audio",
      channel: "level",
      targets: [],
      depth: 0.8,
      attack: 0.005,
      release: 0.25,
      rest_value: 1.0,
    });
    // The summary line (first text line before the JSON fence) must not mention "bound N target(s)".
    const summaryLine = textOf(result).split("\n")[0] ?? "";
    expect(summaryLine).not.toContain("bound");
  });

  it("includes warning count in summary when warnings are present", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        warnings: [
          "limitCHOP par 'type' not found; clamp mode not set (UNVERIFIED TD build).",
          "limitCHOP par 'min' not found; lower bound not clamped.",
        ],
      }),
    }));
    const result = await createSidechainPumpImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "pump",
      source_chop: "/project1/audio",
      channel: "level",
      targets: [],
      depth: 0.8,
      attack: 0.005,
      release: 0.25,
      rest_value: 1.0,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("2 warning(s)");
  });

  it("passes a non-default rest_value through the payload", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ depth: 0.6 }),
    }));
    await createSidechainPumpImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "pump",
      source_chop: "/project1/audio",
      channel: "level",
      targets: [],
      depth: 0.6,
      attack: 0.005,
      release: 0.25,
      rest_value: 0.5,
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.rest_value).toBe(0.5);
    expect(payload.depth).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// Fatal — source not found
// ---------------------------------------------------------------------------

describe("createSidechainPumpImpl — fatal (source not found)", () => {
  it("returns isError:true and does not throw", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "",
        pump_chop: "",
        bound: [],
        depth: 0.8,
        warnings: [],
        fatal: "Source CHOP not found: /project1/missing",
      }),
    }));
    const result = await createSidechainPumpImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "pump",
      source_chop: "/project1/missing",
      channel: "kick",
      targets: [],
      depth: 0.8,
      attack: 0.005,
      release: 0.25,
      rest_value: 1.0,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Source CHOP not found");
  });

  it("returns isError:true and does not throw when parent COMP missing", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "",
        pump_chop: "",
        bound: [],
        depth: 0.8,
        warnings: [],
        fatal: "Parent COMP not found: /missing_parent",
      }),
    }));
    const result = await createSidechainPumpImpl(fakeCtx(exec), {
      parent_path: "/missing_parent",
      name: "pump",
      source_chop: "/project1/audio",
      channel: "level",
      targets: [],
      depth: 0.8,
      attack: 0.005,
      release: 0.25,
      rest_value: 1.0,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });
});

// ---------------------------------------------------------------------------
// TD offline — guardTd swallows the connection error
// ---------------------------------------------------------------------------

describe("createSidechainPumpImpl — TD offline", () => {
  it("returns isError:true and does not throw when the bridge is unreachable", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createSidechainPumpImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "pump",
      source_chop: "/project1/audio",
      channel: "level",
      targets: [],
      depth: 0.8,
      attack: 0.005,
      release: 0.25,
      rest_value: 1.0,
    });
    expect(result.isError).toBe(true);
  });

  it("does not throw even if exec throws a non-TdError", async () => {
    const exec = vi.fn(async () => {
      throw new TypeError("unexpected null");
    });
    const result = await createSidechainPumpImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "pump",
      source_chop: "/project1/audio",
      channel: "level",
      targets: [],
      depth: 0.8,
      attack: 0.005,
      release: 0.25,
      rest_value: 1.0,
    });
    expect(result.isError).toBe(true);
  });
});
