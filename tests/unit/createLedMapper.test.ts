import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildLedMapperScript,
  createLedMapperImpl,
} from "../../src/tools/layer2/createLedMapper.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  parent: string;
  name: string | null;
  source: string | null;
  width: number;
  height: number;
  layout: string;
  start_universe: number;
  start_channel: number;
  net: string;
  net_address: string | null;
  fps: number;
  channels: number;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const script = exec.mock.calls[0]?.[0];
  if (typeof script !== "string")
    throw new Error("executePythonScript was not called with a script");
  return script;
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

// A happy-path report mirroring what the Python pass prints back.
function okExec(over: Record<string, unknown> = {}) {
  return vi.fn(async () => ({
    stdout: JSON.stringify({
      parent: "/project1",
      nodes: {
        source: "/project1/led_map_src_test",
        bright: "/project1/led_map_bright",
        grid: "/project1/led_map_grid",
        pixels: "/project1/led_map_pixels",
        dmx: "/project1/led_map_dmx",
        out: "/project1/led_map_out1",
      },
      source_built: true,
      channels: 48,
      layout: "horizontal",
      universe: 1,
      controls: [
        { name: "Brightness", target: "/project1/led_map_bright.brightness1" },
        { name: "Universe", target: "/project1/led_map_dmx.universe" },
      ],
      errors: [],
      warnings: [],
      ...over,
    }),
  }));
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const baseArgs = {
  width: 16,
  height: 1,
  layout: "horizontal" as const,
  start_universe: 1,
  start_channel: 1,
  net: "artnet" as const,
  fps: 30,
  parent_path: "/project1",
};

describe("buildLedMapperScript", () => {
  it("round-trips the payload and emits the full source -> sample -> CHOP -> DMX chain", () => {
    const payload = {
      parent: "/project1",
      name: null,
      source: null,
      width: 16,
      height: 1,
      layout: "horizontal",
      start_universe: 1,
      start_channel: 1,
      net: "artnet",
      net_address: null,
      fps: 30,
      channels: 48,
    };
    const script = buildLedMapperScript(payload);
    expect(decodePayload(script)).toEqual(payload);
    // The pipeline operators are all created.
    expect(script).toContain("_mk(rampTOP"); // built-in test source
    expect(script).toContain("_mk(levelTOP"); // brightness gain
    expect(script).toContain("_mk(resolutionTOP"); // WxH grid
    expect(script).toContain("_mk(toptoCHOP"); // per-pixel sampling
    expect(script).toContain("_mk(dmxoutCHOP"); // Art-Net/sACN out
    expect(script).toContain("_mk(nullCHOP"); // tap
    // Wired together (fail-forward connect helper).
    expect(script).toContain("inputConnectors[0].connect");
    // Per-pixel sampling: singleset OFF keeps per-pixel r/g/b channels.
    expect(script).toContain('_setpar(_pixels, "singleset", False)');
    expect(script).toContain('_setpar(_pixels, "r", "r")');
    // One texel = one pixel: nearest filtering, custom WxH resolution.
    expect(script).toContain('_setpar(_grid, "outputresolution", "custom")');
    expect(script).toContain('_setpar(_grid, "filtertype", "nearest")');
    // Controls bound to live nodes.
    expect(script).toContain('appendCustomPage("LED")');
    expect(script).toContain('appendFloat("Brightness")');
    expect(script).toContain('appendInt("Universe")');
    // start_channel offset: when > 1, prepend (start_channel - 1) zero pad channels via a
    // Constant CHOP merged ahead of the pixels (the DMX Out CHOP has no start-channel par).
    expect(script).toContain('int(_p["start_channel"]) - 1');
    expect(script).toContain("_mk(constantCHOP");
    expect(script).toContain("_mk(mergeCHOP");
    // The pad merges BEFORE the pixels (input 0 = pad, input 1 = pixels) so pixels shift down.
    expect(script).toContain("inputConnectors[0].connect(_pad)");
    expect(script).toContain("inputConnectors[1].connect(_pixels)");
  });
});

describe("createLedMapperImpl", () => {
  it("computes the DMX channel count (W*H*3) and forwards grid + DMX settings", async () => {
    const exec = okExec();
    await createLedMapperImpl(fakeCtx(exec), {
      ...baseArgs,
      width: 16,
      height: 4,
      net: "sacn",
      net_address: "10.0.0.20",
      start_universe: 7,
      fps: 40,
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.width).toBe(16);
    expect(p.height).toBe(4);
    expect(p.channels).toBe(16 * 4 * 3); // r/g/b per pixel
    expect(p.net).toBe("sacn");
    expect(p.net_address).toBe("10.0.0.20");
    expect(p.start_universe).toBe(7);
    expect(p.fps).toBe(40);
  });

  it("defaults to a built-in test source when no source TOP is given (source null)", async () => {
    const exec = okExec();
    await createLedMapperImpl(fakeCtx(exec), { ...baseArgs });
    const p = decodePayload(scriptArg(exec));
    expect(p.source).toBeNull();
    // The script always wires a rampTOP fallback when source is absent.
    expect(scriptArg(exec)).toContain('_mk(rampTOP, "src_test")');
  });

  it("forwards an explicit source TOP path", async () => {
    const exec = okExec({ source_built: false });
    await createLedMapperImpl(fakeCtx(exec), { ...baseArgs, source: "/project1/render1" });
    const p = decodePayload(scriptArg(exec));
    expect(p.source).toBe("/project1/render1");
  });

  it("forwards the layout (serpentine) to the payload", async () => {
    const exec = okExec({ layout: "serpentine" });
    await createLedMapperImpl(fakeCtx(exec), { ...baseArgs, layout: "serpentine" });
    const p = decodePayload(scriptArg(exec));
    expect(p.layout).toBe("serpentine");
  });

  it("reports the Brightness and Universe controls and the grid summary", async () => {
    const result = await createLedMapperImpl(fakeCtx(okExec()), { ...baseArgs });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("16x1");
    expect(text).toContain("48 DMX channels");
    // Structured report carries the bound controls.
    expect(text).toContain("Brightness");
    expect(text).toContain("Universe");
    expect(text).toContain("led_map_bright.brightness1");
    expect(text).toContain("led_map_dmx.universe");
  });

  it("forwards start_channel and notes the channel offset (pad channels) in the summary", async () => {
    const exec = okExec({
      nodes: {
        source: "/project1/led_map_src_test",
        pixels: "/project1/led_map_pixels",
        pad: "/project1/led_map_pad",
        offset: "/project1/led_map_offset",
        dmx: "/project1/led_map_dmx",
        out: "/project1/led_map_out1",
      },
    });
    const result = await createLedMapperImpl(fakeCtx(exec), { ...baseArgs, start_channel: 5 });
    expect(result.isError).toBeFalsy();
    // The payload carries start_channel through to the Python pass.
    expect(decodePayload(scriptArg(exec)).start_channel).toBe(5);
    // The summary reports the start channel and the number of pad channels (start_channel - 1).
    const text = textOf(result);
    expect(text).toContain("starting at DMX channel 5");
    expect(text).toContain("4 pad channel(s)");
  });

  it("does not mention a channel offset when start_channel is 1 (no pad)", async () => {
    const result = await createLedMapperImpl(fakeCtx(okExec()), { ...baseArgs, start_channel: 1 });
    expect(textOf(result)).not.toContain("starting at DMX channel");
  });

  it("returns an isError result when the bridge reports a fatal failure", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        parent: "/nope",
        nodes: {},
        source_built: false,
        channels: 48,
        layout: "horizontal",
        universe: 1,
        controls: [],
        warnings: [],
        fatal: "Parent COMP not found: /nope",
      }),
    }));
    const result = await createLedMapperImpl(fakeCtx(exec), { ...baseArgs, parent_path: "/nope" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });
});
