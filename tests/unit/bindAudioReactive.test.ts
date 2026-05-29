import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  bindAudioReactiveImpl,
  bindAudioReactiveSchema,
  buildAudioReactiveScript,
} from "../../src/tools/layer2/bindAudioReactive.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// Mirrors tests/unit/disconnectNodes.test.ts (a Layer-2 bridge tool that drives one Python pass
// and parses a JSON report). The payload travels as base64, so we decode it out of the executed
// script and assert the fields the impl put in; the bridge is a vi.fn that returns a tailored
// report, so the whole test runs offline with no TouchDesigner.

interface Mapping {
  param: string;
  channel: string;
  scale: number;
  offset: number;
}
interface Payload {
  target: string;
  source_chop: string;
  intensity: number;
  add_master: boolean;
  mappings: Mapping[] | null;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
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
  if (typeof s !== "string") throw new Error("executePythonScript not called with a script");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// buildAudioReactiveScript — pure payload encoding + script machinery
// ---------------------------------------------------------------------------

describe("buildAudioReactiveScript", () => {
  it("embeds the target, source_chop, intensity, add_master, and mappings in the payload", () => {
    const script = buildAudioReactiveScript({
      target: "/project1/sys",
      source_chop: "/project1/audio/features",
      intensity: 1.5,
      add_master: true,
      mappings: [{ param: "Speed", channel: "bass", scale: 2, offset: 0.1 }],
    });
    const payload = decodePayload(script);
    expect(payload.target).toBe("/project1/sys");
    expect(payload.source_chop).toBe("/project1/audio/features");
    expect(payload.intensity).toBe(1.5);
    expect(payload.add_master).toBe(true);
    expect(payload.mappings).toEqual([{ param: "Speed", channel: "bass", scale: 2, offset: 0.1 }]);
  });

  it("uses the house mechanisms: customPars read, appendFloat master, expression-mode bind", () => {
    const script = buildAudioReactiveScript({
      target: "/project1/sys",
      source_chop: "/a",
      intensity: 1,
      add_master: true,
      mappings: null,
    });
    // Reads the custom parameters and their style, like randomize_controls / manage_presets.
    expect(script).toContain("_t.customPars");
    expect(script).toContain('getattr(_par, "style", None)');
    // Master knob appended via appendFloat with normMin/normMax (add_custom_parameters idiom).
    expect(script).toContain('_page.appendFloat("Reactivity"');
    expect(script).toContain("_pp.normMax = 2");
    // Switches to expression mode the bind_to_channel way (ParMode derived from a live par).
    expect(script).toContain("_par.mode = _PM.EXPRESSION");
  });
});

// ---------------------------------------------------------------------------
// bindAudioReactiveImpl
// ---------------------------------------------------------------------------

describe("bindAudioReactiveImpl", () => {
  it("happy path with explicit mappings: binds and summarizes, no error", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        target: "/project1/sys",
        source_chop: "/project1/audio/features",
        bound: [
          {
            param: "Speed",
            channel: "bass",
            scale: 2,
            expr: "op('/project1/audio/features')['bass'] * 2 * op('/project1/sys').par.Reactivity + 0",
          },
        ],
        source_channels: ["level", "bass", "mid", "treble"],
        master: "Reactivity",
        warnings: [],
      }),
    }));
    const result = await bindAudioReactiveImpl(fakeCtx(exec), {
      target: "/project1/sys",
      source_chop: "/project1/audio/features",
      intensity: 1,
      add_master: true,
      mappings: [{ param: "Speed", channel: "bass", scale: 2, offset: 0 }],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Bound 1 knob(s) on /project1/sys to audio");
    expect(text).toContain("master 'Reactivity'");
    // The explicit mapping flowed through to the payload verbatim.
    const payload = decodePayload(scriptArg(exec));
    expect(payload.target).toBe("/project1/sys");
    expect(payload.source_chop).toBe("/project1/audio/features");
    expect(payload.intensity).toBe(1);
    expect(payload.mappings).toEqual([{ param: "Speed", channel: "bass", scale: 2, offset: 0 }]);
  });

  it("auto-map happy path: omitting mappings sends null and still binds", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        target: "/project1/sys",
        source_chop: "/project1/audio/features",
        bound: [
          {
            param: "Brightness",
            channel: "level",
            scale: 1,
            expr: "op('/project1/audio/features')['level'] * 1 * op('/project1/sys').par.Reactivity + 0",
          },
          {
            param: "Zoom",
            channel: "bass",
            scale: 1,
            expr: "op('/project1/audio/features')['bass'] * 1 * op('/project1/sys').par.Reactivity + 0",
          },
        ],
        source_channels: ["level", "bass", "mid", "treble"],
        master: "Reactivity",
        probe: { has_customPars: true, first_par_style: "Float" },
        warnings: [],
      }),
    }));
    const result = await bindAudioReactiveImpl(fakeCtx(exec), {
      target: "/project1/sys",
      source_chop: "/project1/audio/features",
      intensity: 1,
      add_master: true,
      mappings: undefined,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Bound 2 knob(s) on /project1/sys to audio");
    // No mappings → payload carries null (the auto-map signal), and the script is still sent.
    const payload = decodePayload(scriptArg(exec));
    expect(payload.mappings).toBeNull();
    expect(scriptArg(exec)).toContain("_t.customPars");
  });

  it("returns isError when the bridge reports fatal and does not throw", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        target: "/project1/ghost",
        source_chop: "/project1/audio/features",
        bound: [],
        source_channels: null,
        warnings: [],
        fatal: "Target not found: /project1/ghost",
      }),
    }));
    const result = await bindAudioReactiveImpl(fakeCtx(exec), {
      target: "/project1/ghost",
      source_chop: "/project1/audio/features",
      intensity: 1,
      add_master: true,
      mappings: undefined,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Target not found");
  });

  it("returns isError on bridge/network failure without throwing", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await bindAudioReactiveImpl(fakeCtx(exec), {
      target: "/project1/sys",
      source_chop: "/project1/audio/features",
      intensity: 1,
      add_master: true,
      mappings: undefined,
    });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema validation / defaults
// ---------------------------------------------------------------------------

describe("bindAudioReactiveSchema", () => {
  it("applies defaults: intensity=1 and add_master=true from a minimal input", () => {
    const parsed = bindAudioReactiveSchema.parse({ target: "/x", source_chop: "/a" });
    expect(parsed.intensity).toBe(1);
    expect(parsed.add_master).toBe(true);
    expect(parsed.mappings).toBeUndefined();
  });

  it("requires target and source_chop", () => {
    expect(() => bindAudioReactiveSchema.parse({ target: "/x" })).toThrow();
    expect(() => bindAudioReactiveSchema.parse({ source_chop: "/a" })).toThrow();
  });

  it("defaults each mapping's scale and offset", () => {
    const parsed = bindAudioReactiveSchema.parse({
      target: "/x",
      source_chop: "/a",
      mappings: [{ param: "Speed", channel: "mid" }],
    });
    expect(parsed.mappings?.[0]).toMatchObject({ scale: 1, offset: 0 });
  });

  it("rejects a negative intensity", () => {
    expect(() =>
      bindAudioReactiveSchema.parse({ target: "/x", source_chop: "/a", intensity: -1 }),
    ).toThrow();
  });
});
