import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildPoseReactiveScript,
  createPoseReactiveImpl,
  createPoseReactiveSchema,
} from "../../src/tools/layer1/createPoseReactive.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface ChannelPayload {
  name: string;
  metric: string;
  landmarks: number[];
  invert: boolean;
  scale: number;
  offset: number;
  clamp: [number | null, number | null];
  confidence_gate: number;
}
interface BindingPayload {
  param: string;
  channel: string;
  scale: number;
  offset: number;
}
interface Payload {
  source_chop: string;
  parent_path: string;
  container_name: string;
  channels: ChannelPayload[];
  bindings: BindingPayload[] | null;
  smoothing: number;
  intensity: number;
  expose_controls: boolean;
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

describe("buildPoseReactiveScript", () => {
  it("embeds the source, container, channels and bindings in the payload", () => {
    const script = buildPoseReactiveScript({
      source_chop: "/project1/mp_adapter/pose",
      parent_path: "/project1",
      container_name: "pose_reactive",
      channels: [
        {
          name: "rh_y",
          metric: "y",
          landmarks: [16],
          invert: false,
          scale: 1,
          offset: 0,
          clamp: [0, 1],
          confidence_gate: 0.3,
        },
      ],
      bindings: null,
      smoothing: 0.25,
      intensity: 1,
      expose_controls: true,
    });
    const payload = decodePayload(script);
    expect(payload.source_chop).toBe("/project1/mp_adapter/pose");
    expect(payload.container_name).toBe("pose_reactive");
    expect(payload.channels).toHaveLength(1);
    expect(payload.channels[0]?.name).toBe("rh_y");
    // Expression-mode bind discipline lifted from bind_audio_reactive.
    expect(script).toContain("_par.mode = _PM.EXPRESSION");
    // Per-channel chain creates the canonical operator sequence.
    expect(script).toContain("selectCHOP");
    expect(script).toContain("mathCHOP");
    expect(script).toContain("filterCHOP");
    expect(script).toContain("renameCHOP");
    expect(script).toContain("mergeCHOP");
    expect(script).toContain("nullCHOP");
  });
});

describe("createPoseReactiveImpl", () => {
  it("happy path single channel: builds, summarizes, no error", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container_path: "/project1/pose_reactive",
        null_chop_path: "/project1/pose_reactive/null_out",
        channels_built: [
          {
            name: "rh_y",
            metric: "y",
            landmarks: [16],
            chain: ["select_rh_y", "math_rh_y", "hold_rh_y", "filter_rh_y", "rename_rh_y"],
          },
        ],
        bindings_applied: [],
        source_num_samples: 33,
        warnings: [],
      }),
    }));
    const result = await createPoseReactiveImpl(fakeCtx(exec), {
      source_chop: "/project1/mp_adapter/pose",
      channels: [
        {
          name: "rh_y",
          metric: "y",
          landmarks: [16],
          invert: false,
          scale: 1,
          offset: 0,
          clamp: [0, 1],
          confidence_gate: 0.3,
        },
      ],
      parent_path: "/project1",
      container_name: "pose_reactive",
      bindings: undefined,
      smoothing: 0.25,
      intensity: 1,
      expose_controls: true,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Built 1 pose channel(s)");
    expect(text).toContain("/project1/pose_reactive");
  });

  it("multi-channel + bindings: summary mentions both counts", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container_path: "/project1/pose_reactive",
        null_chop_path: "/project1/pose_reactive/null_out",
        channels_built: [
          { name: "rh_y", metric: "y", landmarks: [16], chain: ["select_rh_y"] },
          { name: "arms", metric: "openness", landmarks: [11, 12], chain: ["select_arms"] },
        ],
        bindings_applied: [
          { param: "/project1/sys:Speed", channel: "rh_y", expr: "op('x')['rh_y']*1*1+0" },
          { param: "/project1/sys:Hue", channel: "arms", expr: "op('x')['arms']*1*1+0" },
        ],
        source_num_samples: 33,
        warnings: [],
      }),
    }));
    const result = await createPoseReactiveImpl(fakeCtx(exec), {
      source_chop: "/project1/mp_adapter/pose",
      channels: [
        {
          name: "rh_y",
          metric: "y",
          landmarks: [16],
          invert: false,
          scale: 1,
          offset: 0,
          clamp: [0, 1],
          confidence_gate: 0.3,
        },
        {
          name: "arms",
          metric: "openness",
          landmarks: [11, 12],
          invert: false,
          scale: 1,
          offset: 0,
          clamp: [0, 1],
          confidence_gate: 0.3,
        },
      ],
      parent_path: "/project1",
      container_name: "pose_reactive",
      bindings: [
        { param: "/project1/sys:Speed", channel: "rh_y", scale: 1, offset: 0 },
        { param: "/project1/sys:Hue", channel: "arms", scale: 1, offset: 0 },
      ],
      smoothing: 0.25,
      intensity: 1,
      expose_controls: true,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Built 2 pose channel(s)");
    expect(text).toContain("2 binding(s)");
    // Bindings flowed through to the payload (including normalized scale/offset).
    const payload = decodePayload(scriptArg(exec));
    expect(payload.bindings).toHaveLength(2);
    expect(payload.bindings?.[0]).toMatchObject({
      param: "/project1/sys:Speed",
      channel: "rh_y",
      scale: 1,
      offset: 0,
    });
  });

  it("distance metric with 1 landmark is rejected pre-bridge", async () => {
    const exec = vi.fn();
    const result = await createPoseReactiveImpl(fakeCtx(exec), {
      source_chop: "/project1/mp/pose",
      channels: [
        {
          name: "bad",
          metric: "distance",
          landmarks: [15],
          invert: false,
          scale: 1,
          offset: 0,
          clamp: [0, 1],
          confidence_gate: 0.3,
        },
      ],
      parent_path: "/project1",
      container_name: "pose_reactive",
      bindings: undefined,
      smoothing: 0.25,
      intensity: 1,
      expose_controls: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("distance metric needs exactly 2 landmark");
    expect(exec).not.toHaveBeenCalled();
  });

  it("angle metric with 2 landmarks (needs 3) is rejected pre-bridge", async () => {
    const exec = vi.fn();
    const result = await createPoseReactiveImpl(fakeCtx(exec), {
      source_chop: "/project1/mp/pose",
      channels: [
        {
          name: "bad_angle",
          metric: "angle",
          landmarks: [11, 13],
          invert: false,
          scale: 1,
          offset: 0,
          clamp: [0, 1],
          confidence_gate: 0.3,
        },
      ],
      parent_path: "/project1",
      container_name: "pose_reactive",
      bindings: undefined,
      smoothing: 0.25,
      intensity: 1,
      expose_controls: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("angle metric needs exactly 3");
    expect(exec).not.toHaveBeenCalled();
  });

  it("defaults are normalized into the bridge payload (no undefined)", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container_path: "/project1/pose_reactive",
        null_chop_path: "/project1/pose_reactive/null_out",
        channels_built: [{ name: "rh_y", metric: "y", landmarks: [16], chain: [] }],
        bindings_applied: [],
        source_num_samples: 33,
        warnings: [],
      }),
    }));
    const parsed = createPoseReactiveSchema.parse({
      source_chop: "/project1/mp/pose",
      channels: [{ name: "rh_y", metric: "y", landmarks: [16] }],
    });
    await createPoseReactiveImpl(fakeCtx(exec), parsed);
    const payload = decodePayload(scriptArg(exec));
    expect(payload.channels[0]).toMatchObject({
      name: "rh_y",
      metric: "y",
      landmarks: [16],
      invert: false,
      scale: 1,
      offset: 0,
      clamp: [0, 1],
      confidence_gate: 0.3,
    });
    expect(payload.bindings).toBeNull();
    expect(payload.smoothing).toBe(0.25);
    expect(payload.intensity).toBe(1);
    expect(payload.expose_controls).toBe(true);
    expect(payload.parent_path).toBe("/project1");
    expect(payload.container_name).toBe("pose_reactive");
  });

  it("fatal from bridge surfaces as friendly errorResult", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container_path: "",
        null_chop_path: "",
        channels_built: [],
        bindings_applied: [],
        source_num_samples: 0,
        warnings: [],
        fatal: "Source CHOP has 0 samples",
      }),
    }));
    const result = await createPoseReactiveImpl(fakeCtx(exec), {
      source_chop: "/project1/ghost",
      channels: [
        {
          name: "rh_y",
          metric: "y",
          landmarks: [16],
          invert: false,
          scale: 1,
          offset: 0,
          clamp: [0, 1],
          confidence_gate: 0.3,
        },
      ],
      parent_path: "/project1",
      container_name: "pose_reactive",
      bindings: undefined,
      smoothing: 0.25,
      intensity: 1,
      expose_controls: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Source CHOP");
  });

  it("warnings appear in summary text", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container_path: "/project1/pose_reactive",
        null_chop_path: "/project1/pose_reactive/null_out",
        channels_built: [{ name: "rh_y", metric: "y", landmarks: [16], chain: [] }],
        bindings_applied: [],
        source_num_samples: 33,
        warnings: ["channel 'x' garbage"],
      }),
    }));
    const result = await createPoseReactiveImpl(fakeCtx(exec), {
      source_chop: "/project1/mp/pose",
      channels: [
        {
          name: "rh_y",
          metric: "y",
          landmarks: [16],
          invert: false,
          scale: 1,
          offset: 0,
          clamp: [0, 1],
          confidence_gate: 0.3,
        },
      ],
      parent_path: "/project1",
      container_name: "pose_reactive",
      bindings: undefined,
      smoothing: 0.25,
      intensity: 1,
      expose_controls: true,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("1 warning(s)");
  });
});

describe("createPoseReactiveSchema", () => {
  it("applies defaults: smoothing/intensity/expose_controls + per-channel fields", () => {
    const parsed = createPoseReactiveSchema.parse({
      source_chop: "/x",
      channels: [{ name: "rh_y", metric: "y", landmarks: [16] }],
    });
    expect(parsed.smoothing).toBe(0.25);
    expect(parsed.intensity).toBe(1);
    expect(parsed.expose_controls).toBe(true);
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.container_name).toBe("pose_reactive");
    expect(parsed.channels[0]).toMatchObject({
      invert: false,
      scale: 1,
      offset: 0,
      clamp: [0, 1],
      confidence_gate: 0.3,
    });
  });

  it("rejects empty channels[]", () => {
    expect(() => createPoseReactiveSchema.parse({ source_chop: "/x", channels: [] })).toThrow();
  });
});
