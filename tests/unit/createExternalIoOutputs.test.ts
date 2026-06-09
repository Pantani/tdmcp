import { describe, expect, it, vi } from "vitest";
import { buildIoScript, createExternalIoImpl } from "../../src/tools/layer2/createExternalIo.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// Covers the OUTPUT kinds added on top of the originals (see createExternalIo.test.ts
// for osc/midi/dmx): network Art-Net/sACN (artnet_out) and RTMP streaming (rtmp_out).

interface Payload {
  kind: string;
  parent: string;
  name: string | null;
  port: number | null;
  normalize: string;
  bind_to: Array<{ channel: string; target: string }> | null;
  source: string | null;
  interface: string;
  net: string;
  universe: number;
  net_address: string | null;
  url: string | null;
  fps: number | null;
  active: boolean | null;
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

function okExec(kind: string, type: string) {
  return vi.fn(async () => ({
    stdout: JSON.stringify({
      kind,
      node: "/p/out1",
      type,
      bound: [],
      warnings: [],
    }),
  }));
}

// Defaults the impl always receives from the Zod schema; individual tests override.
const baseArgs = {
  parent_path: "/project1",
  normalize: "0to1" as const,
  interface: "artnet" as const,
  net: "artnet" as const,
  universe: 1,
  rtmp_base: "rtmp://a.rtmp.youtube.com/live2",
  active: false,
};

describe("buildIoScript (output kinds)", () => {
  it("maps the new kinds to confirmed operator types and wires a source", () => {
    const script = buildIoScript({
      kind: "rtmp_out",
      parent: "/project1",
      name: null,
      port: null,
      normalize: "0to1",
      bind_to: null,
      source: "/project1/final",
      interface: "artnet",
      net: "artnet",
      universe: 1,
      net_address: null,
      url: "rtmp://live.twitch.tv/app/key",
      fps: 30,
      active: false,
      source_name: null,
    });
    // artnet_out reuses the DMX Out CHOP; rtmp_out uses the Video Stream Out TOP.
    expect(script).toContain('"artnet_out": dmxoutCHOP');
    expect(script).toContain('"rtmp_out": videostreamoutTOP');
    // RTMP forces the sender mode and wires the TOP source.
    expect(script).toContain('_setpar("mode", "rtmpsender")');
    expect(script).toContain("inputConnectors[0].connect(_s)");
  });
});

describe("createExternalIoImpl artnet_out", () => {
  it("creates a DMX Out CHOP forced onto a network protocol with universe + target IP", async () => {
    const exec = okExec("artnet_out", "dmxout");
    await createExternalIoImpl(fakeCtx(exec), {
      ...baseArgs,
      kind: "artnet_out",
      net: "sacn",
      universe: 4,
      net_address: "10.0.0.42",
      source_path: "/project1/pixels",
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.kind).toBe("artnet_out");
    expect(p.net).toBe("sacn");
    expect(p.universe).toBe(4);
    expect(p.net_address).toBe("10.0.0.42");
    expect(p.source).toBe("/project1/pixels");
    // Output kinds never get an OSC port.
    expect(p.port).toBeNull();
  });

  it("defaults to Art-Net when net is left at its default", async () => {
    const exec = okExec("artnet_out", "dmxout");
    await createExternalIoImpl(fakeCtx(exec), {
      ...baseArgs,
      kind: "artnet_out",
      source_path: "/project1/pixels",
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.net).toBe("artnet");
  });
});

describe("createExternalIoImpl rtmp_out", () => {
  it("forwards an explicit url verbatim and defaults fps to 30, staying inactive", async () => {
    const exec = okExec("rtmp_out", "videostreamout");
    await createExternalIoImpl(fakeCtx(exec), {
      ...baseArgs,
      kind: "rtmp_out",
      url: "rtmp://live.twitch.tv/app/live_123",
      source_path: "/project1/final",
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.kind).toBe("rtmp_out");
    expect(p.url).toBe("rtmp://live.twitch.tv/app/live_123");
    expect(p.fps).toBe(30);
    expect(p.active).toBe(false);
    expect(p.source).toBe("/project1/final");
  });

  it("composes the url from rtmp_base + stream_key when url is omitted", async () => {
    const exec = okExec("rtmp_out", "videostreamout");
    await createExternalIoImpl(fakeCtx(exec), {
      ...baseArgs,
      kind: "rtmp_out",
      rtmp_base: "rtmp://a.rtmp.youtube.com/live2",
      stream_key: "abcd-efgh",
      source_path: "/project1/final",
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.url).toBe("rtmp://a.rtmp.youtube.com/live2/abcd-efgh");
  });

  it("honours a custom fps and an explicit active=true", async () => {
    const exec = okExec("rtmp_out", "videostreamout");
    await createExternalIoImpl(fakeCtx(exec), {
      ...baseArgs,
      kind: "rtmp_out",
      url: "rtmp://x/y",
      fps: 60,
      active: true,
      source_path: "/project1/final",
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.fps).toBe(60);
    expect(p.active).toBe(true);
  });

  it("leaves url null when neither url nor stream_key is given", async () => {
    const exec = okExec("rtmp_out", "videostreamout");
    await createExternalIoImpl(fakeCtx(exec), {
      ...baseArgs,
      kind: "rtmp_out",
      source_path: "/project1/final",
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.url).toBeNull();
  });
});

describe("createExternalIoImpl regression (existing kinds still build)", () => {
  it("keeps fps/url/active null for a dmx_out so originals are untouched", async () => {
    const exec = okExec("dmx_out", "dmxout");
    await createExternalIoImpl(fakeCtx(exec), {
      ...baseArgs,
      kind: "dmx_out",
      interface: "sacn",
      universe: 7,
      net_address: "192.168.1.50",
      source_path: "/project1/vals",
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.url).toBeNull();
    expect(p.fps).toBeNull();
    expect(p.active).toBeNull();
    expect(p.interface).toBe("sacn");
  });
});

// FM-01: ndi_out + syphon_spout_out outbound video kinds

describe("buildIoScript (ndi_out + syphon_spout_out _TYPEMAP)", () => {
  it("maps ndi_out and syphon_spout_out to confirmed TD OPTypes and emits correct par names", () => {
    const script = buildIoScript({
      kind: "ndi_out",
      parent: "/project1",
      name: null,
      port: null,
      normalize: "0to1",
      bind_to: null,
      source: "/project1/final",
      interface: "artnet",
      net: "artnet",
      universe: 1,
      net_address: null,
      url: null,
      fps: null,
      active: false,
      source_name: null,
    });
    // _TYPEMAP entries confirmed from KB ndi_out_top.json + syphon_spout_out_top.json.
    expect(script).toContain('"ndi_out": ndioutTOP');
    expect(script).toContain('"syphon_spout_out": syphonspoutoutTOP');
    // Python branch par names confirmed from KB parameter lists.
    expect(script).toContain('_setpar("name", _p.get("source_name") or _node.name)');
    expect(script).toContain('_setpar("sendername", _p.get("source_name") or _node.name)');
  });
});

describe("createExternalIoImpl ndi_out", () => {
  it("forwards kind/source/source_name/active and leaves port null", async () => {
    const exec = okExec("ndi_out", "ndiout");
    await createExternalIoImpl(fakeCtx(exec), {
      ...baseArgs,
      kind: "ndi_out",
      source_path: "/project1/final",
      source_name: "studio-feed",
      active: true,
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.kind).toBe("ndi_out");
    expect(p.source).toBe("/project1/final");
    expect(p.source_name).toBe("studio-feed");
    expect(p.active).toBe(true);
    // Output kinds never get an OSC port.
    expect(p.port).toBeNull();
  });
});

describe("createExternalIoImpl syphon_spout_out", () => {
  it("defaults active to false and forwards null source_name when omitted", async () => {
    const exec = okExec("syphon_spout_out", "syphonspoutout");
    await createExternalIoImpl(fakeCtx(exec), {
      ...baseArgs,
      kind: "syphon_spout_out",
      source_path: "/project1/final",
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.kind).toBe("syphon_spout_out");
    // source_name is null in payload; Python falls back to _node.name.
    expect(p.source_name).toBeNull();
    // active defaults false per rtmp_out precedent.
    expect(p.active).toBe(false);
    expect(p.source).toBe("/project1/final");
  });
});

describe("createExternalIoImpl regression (ndi_in active stays null)", () => {
  it("input kinds are not treated as active-capable — active must be null", async () => {
    const exec = okExec("ndi_in", "ndiin");
    await createExternalIoImpl(fakeCtx(exec), {
      ...baseArgs,
      kind: "ndi_in",
      source_name: "some-source",
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.kind).toBe("ndi_in");
    // ndi_in is not in the active-capable set; active must remain null.
    expect(p.active).toBeNull();
  });
});
