import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildDmxFixturePipelineScript,
  createDmxFixturePipelineImpl,
  createDmxFixturePipelineSchema,
  FIXTURE_PROFILES,
  flattenFixtures,
  getProfile,
} from "../../src/tools/layer1/createDmxFixturePipeline.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  parent_path: string;
  name: string;
  universe: number;
  interface: string;
  host: string | null;
  fps: number;
  totalChannels: number;
  warnings: string[];
  fixtures: Array<{
    id: string;
    profile: string;
    startChannel: number;
    channels: string[];
    defaults: number[];
  }>;
  pads: Array<{ before: number; gap: number }>;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: { executePythonScript: exec },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function happyReport(
  overrides: Partial<{
    fixtures: Array<{
      id: string;
      node: string;
      profile: string;
      startChannel: number;
      channels: string[];
    }>;
    universe: number;
    totalChannels: number;
    warnings: string[];
    errors: string[];
  }> = {},
) {
  return JSON.stringify({
    container: "/project1/dmx_rig",
    fixtures: overrides.fixtures ?? [
      {
        id: "fix1",
        node: "/project1/dmx_rig/fix1",
        profile: "rgb",
        startChannel: 1,
        channels: ["fix1/r", "fix1/g", "fix1/b"],
      },
    ],
    merge: "/project1/dmx_rig/merge",
    out: "/project1/dmx_rig/rig_out",
    dmx: "/project1/dmx_rig/dmx",
    universe: overrides.universe ?? 1,
    totalChannels: overrides.totalChannels ?? 3,
    controls: [
      { name: "Universe", target: "/project1/dmx_rig/dmx.universe" },
      { name: "Rate", target: "/project1/dmx_rig/dmx.rate" },
      { name: "Net Address", target: "/project1/dmx_rig/dmx.netaddress" },
    ],
    warnings: overrides.warnings ?? [],
    errors: overrides.errors ?? [],
  });
}

// ---------------------------------------------------------------------------
// FIXTURE_PROFILES / getProfile
// ---------------------------------------------------------------------------

describe("FIXTURE_PROFILES", () => {
  it("exposes the documented channel counts", () => {
    expect(getProfile("rgb").channels.length).toBe(3);
    expect(getProfile("rgbw").channels.length).toBe(4);
    expect(getProfile("par64").channels.length).toBe(7);
    expect(getProfile("movingHead8").channels.length).toBe(8);
    expect(getProfile("movingHead16").channels.length).toBe(16);
  });

  it("par64 dimmer defaults to 255 (lights on)", () => {
    const p = getProfile("par64");
    expect(p.channels[0]).toBe("dimmer");
    expect(p.defaults[0]).toBe(255);
  });

  it("defaults length matches channels length for every profile", () => {
    for (const key of Object.keys(FIXTURE_PROFILES) as Array<keyof typeof FIXTURE_PROFILES>) {
      const p = FIXTURE_PROFILES[key];
      expect(p.defaults.length).toBe(p.channels.length);
    }
  });
});

// ---------------------------------------------------------------------------
// flattenFixtures
// ---------------------------------------------------------------------------

describe("flattenFixtures", () => {
  it("sorts by startChannel, inserts a pad before the gap, totalChannels covers the last slot", () => {
    const result = flattenFixtures([
      { id: "fix2", profile: "par64", startChannel: 10 },
      { id: "fix1", profile: "rgb", startChannel: 1 },
    ]);
    expect(result.fixtures.map((f) => f.id)).toEqual(["fix1", "fix2"]);
    expect(result.fixtures[0]?.channels).toEqual(["fix1/r", "fix1/g", "fix1/b"]);
    expect(result.fixtures[1]?.channels[0]).toBe("fix2/dimmer");
    expect(result.fixtures[1]?.defaults[0]).toBe(255);
    // rgb fills 1..3, gap of 6 before par64 at 10, par64 fills 10..16
    expect(result.pads).toEqual([{ before: 1, gap: 6 }]);
    expect(result.totalChannels).toBe(16);
    expect(result.warnings).toEqual([]);
  });

  it("emits an overlap warning but still includes both fixtures", () => {
    const result = flattenFixtures([
      { id: "a", profile: "rgb", startChannel: 1 },
      { id: "b", profile: "rgb", startChannel: 2 },
    ]);
    expect(result.fixtures.length).toBe(2);
    expect(result.warnings.join("\n")).toMatch(/overlap/i);
  });

  it("warns when a fixture exceeds slot 512", () => {
    const result = flattenFixtures([{ id: "x", profile: "movingHead16", startChannel: 510 }]);
    expect(result.warnings.join("\n")).toMatch(/exceeds universe 512/);
  });

  it("no pad when fixtures are contiguous", () => {
    const result = flattenFixtures([
      { id: "a", profile: "rgb", startChannel: 1 },
      { id: "b", profile: "rgb", startChannel: 4 },
    ]);
    expect(result.pads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("createDmxFixturePipelineSchema", () => {
  it("applies documented defaults", () => {
    const parsed = createDmxFixturePipelineSchema.parse({
      fixtures: [{ id: "fix1", profile: "rgb", startChannel: 1 }],
    });
    expect(parsed.name).toBe("dmx_rig");
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.universe).toBe(1);
    expect(parsed.net).toBe("artnet");
    expect(parsed.fps).toBe(40);
    expect(parsed.host).toBeNull();
  });

  it("rejects empty fixtures (min 1)", () => {
    expect(() => createDmxFixturePipelineSchema.parse({ fixtures: [] })).toThrow();
  });

  it("rejects duplicate fixture ids", () => {
    expect(() =>
      createDmxFixturePipelineSchema.parse({
        fixtures: [
          { id: "fix1", profile: "rgb", startChannel: 1 },
          { id: "fix1", profile: "rgb", startChannel: 4 },
        ],
      }),
    ).toThrow();
  });

  it("rejects invalid fixture ids", () => {
    expect(() =>
      createDmxFixturePipelineSchema.parse({
        fixtures: [{ id: "1bad", profile: "rgb", startChannel: 1 }],
      }),
    ).toThrow();
  });

  it("rejects startChannel out of 1..512", () => {
    expect(() =>
      createDmxFixturePipelineSchema.parse({
        fixtures: [{ id: "fix1", profile: "rgb", startChannel: 0 }],
      }),
    ).toThrow();
    expect(() =>
      createDmxFixturePipelineSchema.parse({
        fixtures: [{ id: "fix1", profile: "rgb", startChannel: 513 }],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildDmxFixturePipelineScript — pure payload
// ---------------------------------------------------------------------------

describe("buildDmxFixturePipelineScript", () => {
  it("embeds all build parameters in the base64 payload", () => {
    const script = buildDmxFixturePipelineScript({
      parent_path: "/project1",
      name: "rig",
      universe: 7,
      interface: "sacn",
      host: "10.0.0.5",
      fps: 25,
      totalChannels: 16,
      warnings: [],
      fixtures: [
        {
          id: "fix1",
          profile: "rgb",
          startChannel: 1,
          channels: ["fix1/r", "fix1/g", "fix1/b"],
          defaults: [0, 0, 0],
        },
      ],
      pads: [],
    });
    const payload = decodePayload(script);
    expect(payload.universe).toBe(7);
    expect(payload.interface).toBe("sacn");
    expect(payload.host).toBe("10.0.0.5");
    expect(payload.fps).toBe(25);
    expect(payload.fixtures[0]?.channels).toEqual(["fix1/r", "fix1/g", "fix1/b"]);
  });

  it("references the expected TD operator types and prints the report", () => {
    const script = buildDmxFixturePipelineScript({
      parent_path: "/project1",
      name: "rig",
      universe: 1,
      interface: "artnet",
      host: null,
      fps: 40,
      totalChannels: 3,
      warnings: [],
      fixtures: [],
      pads: [],
    });
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
    expect(script).toContain("constantCHOP");
    expect(script).toContain("mergeCHOP");
    expect(script).toContain("nullCHOP");
    expect(script).toContain("dmxoutCHOP");
    expect(script).toContain("baseCOMP");
  });
});

// ---------------------------------------------------------------------------
// createDmxFixturePipelineImpl — happy path
// ---------------------------------------------------------------------------

describe("createDmxFixturePipelineImpl", () => {
  it("forwards args (universe / net / host / fps) into the payload and summarises the build", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        universe: 7,
        totalChannels: 16,
        fixtures: [
          {
            id: "fix1",
            node: "/project1/dmx_rig/fix1",
            profile: "rgb",
            startChannel: 1,
            channels: ["fix1/r", "fix1/g", "fix1/b"],
          },
          {
            id: "fix2",
            node: "/project1/dmx_rig/fix2",
            profile: "par64",
            startChannel: 10,
            channels: [
              "fix2/dimmer",
              "fix2/r",
              "fix2/g",
              "fix2/b",
              "fix2/strobe",
              "fix2/macro",
              "fix2/speed",
            ],
          },
        ],
      }),
    }));
    const result = await createDmxFixturePipelineImpl(fakeCtx(exec), {
      name: "dmx_rig",
      parent_path: "/project1",
      host: "10.0.0.5",
      universe: 7,
      net: "sacn",
      fps: 25,
      fixtures: [
        { id: "fix1", profile: "rgb", startChannel: 1 },
        { id: "fix2", profile: "par64", startChannel: 10 },
      ],
    });
    expect(result.isError).toBeFalsy();
    const firstCall = exec.mock.calls[0] as unknown as [string, boolean] | undefined;
    const scriptStr = firstCall?.[0];
    if (typeof scriptStr !== "string") throw new Error("script not captured");
    const payload = decodePayload(scriptStr);
    expect(payload.parent_path).toBe("/project1");
    expect(payload.universe).toBe(7);
    expect(payload.interface).toBe("sacn");
    expect(payload.host).toBe("10.0.0.5");
    expect(payload.fps).toBe(25);
    expect(payload.fixtures.map((f) => f.id)).toEqual(["fix1", "fix2"]);
    expect(payload.fixtures[0]?.channels).toEqual(["fix1/r", "fix1/g", "fix1/b"]);
    expect(payload.fixtures[1]?.defaults[0]).toBe(255); // par64 dimmer
    // pad of 6 slots before par64 (rgb fills 1-3, par64 at 10)
    expect(payload.pads).toEqual([{ before: 1, gap: 6 }]);
    const text = textOf(result);
    expect(text).toContain("2 fixture(s)");
    expect(text).toContain("16 channels");
    expect(text).toContain("universe 7");
    expect(text).toContain("sacn");
  });

  it("returns isError on a fatal report", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "",
        fixtures: [],
        merge: "",
        out: "",
        dmx: "",
        universe: 1,
        totalChannels: 0,
        controls: [],
        warnings: [],
        fatal: "Parent COMP not found: /nope",
      }),
    }));
    const result = await createDmxFixturePipelineImpl(fakeCtx(exec), {
      name: "dmx_rig",
      parent_path: "/nope",
      host: null,
      universe: 1,
      net: "artnet",
      fps: 40,
      fixtures: [{ id: "fix1", profile: "rgb", startChannel: 1 }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });

  it("returns isError without throwing when the bridge is unreachable", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createDmxFixturePipelineImpl(fakeCtx(exec), {
      name: "dmx_rig",
      parent_path: "/project1",
      host: null,
      universe: 1,
      net: "artnet",
      fps: 40,
      fixtures: [{ id: "fix1", profile: "rgb", startChannel: 1 }],
    });
    expect(result.isError).toBe(true);
  });
});
