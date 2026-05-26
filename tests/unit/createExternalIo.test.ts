import { describe, expect, it, vi } from "vitest";
import { buildIoScript, createExternalIoImpl } from "../../src/tools/layer2/createExternalIo.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  kind: string;
  parent: string;
  name: string | null;
  port: number | null;
  normalize: string;
  bind_to: Array<{ channel: string; target: string }> | null;
  source: string | null;
  interface: string;
  universe: number;
  net_address: string | null;
  source_name: string | null;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const script = exec.mock.calls[0]?.[0];
  if (typeof script !== "string")
    throw new Error("executePythonScript was not called with a script");
  return script;
}

function okExec() {
  return vi.fn(async () => ({
    stdout: JSON.stringify({
      kind: "osc_in",
      node: "/p/oscin1",
      type: "oscin",
      bound: [],
      warnings: [],
    }),
  }));
}

describe("buildIoScript", () => {
  it("round-trips the payload and emits per-kind machinery", () => {
    const payload = {
      kind: "dmx_out",
      parent: "/project1",
      name: null,
      port: null,
      normalize: "0to1",
      bind_to: null,
      source: "/project1/vals",
      interface: "artnet",
      universe: 1,
      net_address: "10.0.0.5",
      source_name: null,
    };
    const script = buildIoScript(payload);
    expect(decodePayload(script)).toEqual(payload);
    expect(script).toContain('"osc_in": oscinCHOP'); // type map
    expect(script).toContain("inputConnectors[0].connect(_s)"); // dmx source wiring
    // Defensive channel binding: falls back to 0 when the channel hasn't arrived.
    expect(script).toContain("else 0");
    expect(script).toContain("_tp.mode = _PM.EXPRESSION");
  });
});

describe("createExternalIoImpl", () => {
  it("defaults the OSC port to 7000", async () => {
    const exec = okExec();
    await createExternalIoImpl(fakeCtx(exec), {
      kind: "osc_in",
      parent_path: "/project1",
      normalize: "0to1",
      interface: "artnet",
      universe: 1,
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.kind).toBe("osc_in");
    expect(p.port).toBe(7000);
  });

  it("leaves port null for non-OSC kinds and forwards DMX settings", async () => {
    const exec = okExec();
    await createExternalIoImpl(fakeCtx(exec), {
      kind: "dmx_out",
      parent_path: "/project1",
      normalize: "0to1",
      interface: "sacn",
      universe: 7,
      net_address: "192.168.1.50",
      source_path: "/project1/sys/vals",
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.port).toBeNull();
    expect(p.interface).toBe("sacn");
    expect(p.universe).toBe(7);
    expect(p.net_address).toBe("192.168.1.50");
    expect(p.source).toBe("/project1/sys/vals");
  });

  it("forwards osc bindings", async () => {
    const exec = okExec();
    await createExternalIoImpl(fakeCtx(exec), {
      kind: "osc_in",
      parent_path: "/project1",
      normalize: "0to1",
      interface: "artnet",
      universe: 1,
      bind_to: [{ channel: "fader1", target: "/project1/sys/blur1.size" }],
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.bind_to).toEqual([{ channel: "fader1", target: "/project1/sys/blur1.size" }]);
  });
});
