import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildTwoWaySurfaceScript,
  createTwoWaySurfaceImpl,
  createTwoWaySurfaceSchema,
} from "../../src/tools/layer1/createTwoWaySurface.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Mapping {
  control: string;
  param: string;
  epsilon: number;
  direction: "in" | "out" | "both";
  min: number;
  max: number;
}
interface Payload {
  name: string;
  parent: string;
  protocol: "osc" | "midi";
  host: string;
  port: number;
  listenPort: number;
  midiDevice?: string;
  mappings: Mapping[];
  rateLimitHz: number;
  guard_body: string;
  in_cb: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const okReport = (over: Record<string, unknown> = {}) =>
  vi.fn(async (_script: string, _capture?: boolean) => ({
    stdout: JSON.stringify({
      container: "/two_way_surface",
      inNullPath: "/two_way_surface/in_null",
      guardPath: "/two_way_surface/guard",
      outChopPath: "/two_way_surface/out_chop",
      mappingCount: 1,
      warnings: [],
      ...over,
    }),
  }));

const baseArgs = (
  over: Partial<Parameters<typeof createTwoWaySurfaceImpl>[1]> = {},
): Parameters<typeof createTwoWaySurfaceImpl>[1] => ({
  name: "two_way_surface",
  parent: "/",
  protocol: "osc",
  host: "127.0.0.1",
  port: 9000,
  listenPort: 9001,
  mappings: [
    {
      control: "/track/1/fader",
      param: "/project1/wave1.amp",
      epsilon: 0.001,
      direction: "both",
      min: 0,
      max: 1,
    },
  ],
  rateLimitHz: 60,
  ...over,
});

describe("createTwoWaySurfaceSchema", () => {
  it("applies per-mapping defaults (epsilon=0.001, direction='both')", () => {
    const parsed = createTwoWaySurfaceSchema.parse({
      mappings: [{ control: "/a", param: "/project1/n.x" }],
    });
    expect(parsed.protocol).toBe("osc");
    expect(parsed.rateLimitHz).toBe(60);
    expect(parsed.mappings[0]?.epsilon).toBe(0.001);
    expect(parsed.mappings[0]?.direction).toBe("both");
    expect(parsed.mappings[0]?.min).toBe(0);
    expect(parsed.mappings[0]?.max).toBe(1);
  });

  it("rejects empty mappings", () => {
    expect(() => createTwoWaySurfaceSchema.parse({ mappings: [] })).toThrow();
  });

  it("rejects invalid protocol", () => {
    expect(() =>
      createTwoWaySurfaceSchema.parse({
        protocol: "udp",
        mappings: [{ control: "/a", param: "/p.x" }],
      }),
    ).toThrow();
  });

  it("rejects out-of-range port", () => {
    expect(() =>
      createTwoWaySurfaceSchema.parse({
        port: 70000,
        mappings: [{ control: "/a", param: "/p.x" }],
      }),
    ).toThrow();
  });
});

describe("buildTwoWaySurfaceScript", () => {
  it("encodes OSC payload: container, host, ports, every mapping address", () => {
    const script = buildTwoWaySurfaceScript({
      name: "surf",
      parent: "/project1",
      protocol: "osc",
      host: "10.0.0.5",
      port: 9000,
      listenPort: 9001,
      mappings: [
        {
          control: "/track/1/fader",
          param: "/project1/w.amp",
          epsilon: 0.001,
          direction: "both",
          min: 0,
          max: 1,
        },
        {
          control: "/track/2/fader",
          param: "/project1/w.freq",
          epsilon: 0.005,
          direction: "in",
          min: 0,
          max: 1,
        },
      ],
      rateLimitHz: 60,
      guard_body: "GUARD",
      in_cb: "INCB",
    });
    const payload = decodePayload(script);
    expect(payload.protocol).toBe("osc");
    expect(payload.name).toBe("surf");
    expect(payload.host).toBe("10.0.0.5");
    expect(payload.port).toBe(9000);
    expect(payload.listenPort).toBe(9001);
    expect(payload.mappings.map((m) => m.control)).toEqual(["/track/1/fader", "/track/2/fader"]);
    expect(payload.guard_body).toBe("GUARD");
    expect(payload.in_cb).toBe("INCB");
  });

  it("OSC variant: script mentions OSC op types", () => {
    const script = buildTwoWaySurfaceScript({
      name: "s",
      parent: "/",
      protocol: "osc",
      host: "127.0.0.1",
      port: 9000,
      listenPort: 9001,
      mappings: [
        { control: "/a", param: "/p.x", epsilon: 0.001, direction: "both", min: 0, max: 1 },
      ],
      rateLimitHz: 60,
      guard_body: "G",
      in_cb: "I",
    });
    expect(script).toContain("oscinCHOP");
    expect(script).toContain("oscoutCHOP");
    expect(script).toContain("scriptCHOP");
    expect(script).toContain("nullCHOP");
    expect(script).toContain("tableDAT");
    expect(script).toContain("chopexecuteDAT");
    const payload = decodePayload(script);
    expect(payload.protocol).toBe("osc");
  });

  it("MIDI variant: script mentions MIDI op types", () => {
    const script = buildTwoWaySurfaceScript({
      name: "s",
      parent: "/",
      protocol: "midi",
      host: "127.0.0.1",
      port: 9000,
      listenPort: 9001,
      midiDevice: "X-Touch",
      mappings: [
        { control: "cc:7:1", param: "/p.x", epsilon: 0.001, direction: "both", min: 0, max: 1 },
      ],
      rateLimitHz: 60,
      guard_body: "G",
      in_cb: "I",
    });
    expect(script).toContain("midiinCHOP");
    expect(script).toContain("midioutCHOP");
    const payload = decodePayload(script);
    expect(payload.protocol).toBe("midi");
    expect(payload.midiDevice).toBe("X-Touch");
  });

  it("guard body references epsilon, last_out, last_in, rate cap, and Globaleps", () => {
    const script = buildTwoWaySurfaceScript({
      name: "s",
      parent: "/",
      protocol: "osc",
      host: "127.0.0.1",
      port: 9000,
      listenPort: 9001,
      mappings: [
        { control: "/a", param: "/p.x", epsilon: 0.001, direction: "both", min: 0, max: 1 },
      ],
      rateLimitHz: 60,
      guard_body: "epsilon last_out last_in Ratehz Globaleps",
      in_cb: "I",
    });
    const payload = decodePayload(script);
    expect(payload.guard_body).toContain("epsilon");
    expect(payload.guard_body).toContain("last_out");
    expect(payload.guard_body).toContain("last_in");
    expect(payload.guard_body).toContain("Ratehz");
    expect(payload.guard_body).toContain("Globaleps");
  });
});

describe("createTwoWaySurfaceImpl", () => {
  it("returns an error result when report.fatal is set, without throwing", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        mappingCount: 1,
        warnings: [],
        fatal: "Parent COMP not found: /missing",
      }),
    }));
    const result = await createTwoWaySurfaceImpl(fakeCtx(exec), baseArgs({ parent: "/missing" }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });

  it("returns an error (no throw, no bridge call) when MIDI is selected without a device", async () => {
    const exec = vi.fn();
    const result = await createTwoWaySurfaceImpl(
      fakeCtx(exec),
      baseArgs({ protocol: "midi", midiDevice: undefined }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("midiDevice");
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns an error when the bridge is offline (TdError → no throw)", async () => {
    const exec = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9980");
    });
    const result = await createTwoWaySurfaceImpl(fakeCtx(exec), baseArgs());
    expect(result.isError).toBe(true);
  });

  it("summarises container path, protocol, and mapping count", async () => {
    const exec = okReport({ mappingCount: 2 });
    const result = await createTwoWaySurfaceImpl(
      fakeCtx(exec),
      baseArgs({
        mappings: [
          { control: "/a", param: "/p.x", epsilon: 0.001, direction: "both", min: 0, max: 1 },
          { control: "/b", param: "/p.y", epsilon: 0.001, direction: "out", min: 0, max: 1 },
        ],
      }),
    );
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("OSC");
    expect(text).toContain("/two_way_surface");
    expect(text).toContain("2 mapping(s)");
  });

  it("passes captureStdout=true to executePythonScript", async () => {
    const exec = okReport();
    await createTwoWaySurfaceImpl(fakeCtx(exec), baseArgs());
    expect(exec.mock.calls[0]?.[1]).toBe(true);
  });

  it("payload preserves direction filter so the guard/bind branches can skip correctly", async () => {
    const exec = okReport();
    await createTwoWaySurfaceImpl(
      fakeCtx(exec),
      baseArgs({
        mappings: [
          { control: "/in_only", param: "/p.x", epsilon: 0.001, direction: "in", min: 0, max: 1 },
          { control: "/out_only", param: "/p.y", epsilon: 0.001, direction: "out", min: 0, max: 1 },
          { control: "/both", param: "/p.z", epsilon: 0.002, direction: "both", min: 0, max: 1 },
        ],
      }),
    );
    const payload = decodePayload(exec.mock.calls[0]?.[0] as string);
    const dirs = payload.mappings.map((m) => m.direction);
    expect(dirs).toEqual(["in", "out", "both"]);
    const epsByCtrl = Object.fromEntries(payload.mappings.map((m) => [m.control, m.epsilon]));
    expect(epsByCtrl["/both"]).toBe(0.002);
    expect(payload.rateLimitHz).toBe(60);
  });
});
