import { describe, expect, it, vi } from "vitest";
import { TdConnectionError } from "../../src/td-client/types.js";
import {
  buildSyncTimecodeScript,
  syncTimecodeImpl,
  syncTimecodeSchema,
} from "../../src/tools/layer2/syncTimecode.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  parent: string;
  name: string | null;
  source: string;
  host: string | null;
  port: number | null;
  osc_address: string | null;
  fps: number | null;
  drive_timeline: boolean;
  cue_on_label: boolean;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script missing base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const script = exec.mock.calls[0]?.[0];
  if (typeof script !== "string") throw new Error("executePythonScript not called with a script");
  return script;
}

function okExec(report: Record<string, unknown>) {
  return vi.fn(async (_script: string, _returnOutput?: boolean) => ({
    stdout: JSON.stringify(report),
  }));
}

describe("buildSyncTimecodeScript", () => {
  it("embeds the payload and uses defensive getattr for params", () => {
    const script = buildSyncTimecodeScript({
      parent: "/project1",
      name: null,
      source: "osc",
      host: "0.0.0.0",
      port: 7000,
      osc_address: "/timecode",
      fps: null,
      drive_timeline: true,
      cue_on_label: false,
    });
    expect(script).toContain("oscinCHOP");
    expect(script).toContain("getattr(node.par, parname, None)");
    expect(script).toContain("project.frame = int(ch.eval())");
  });
});

describe("syncTimecodeImpl", () => {
  it("osc: defaults port 7000 and address /timecode, returns structured paths", async () => {
    const exec = okExec({
      kind: "sync_timecode",
      source: "osc",
      node: "/project1/tc_in1_sys/osc_in",
      null_path: "/project1/tc_in1_sys/tc_out",
      drive_path: "/project1/tc_in1_sys/tc_drive",
      fps: 30,
      warnings: [],
    });
    const res = await syncTimecodeImpl(fakeCtx(exec), {
      parent: "/project1",
      source: "osc",
      drive_timeline: true,
      cue_on_label: false,
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[1]).toBe(true);
    const payload = decodePayload(scriptArg(exec));
    expect(payload.source).toBe("osc");
    expect(payload.port).toBe(7000);
    expect(payload.osc_address).toBe("/timecode");
    expect(payload.drive_timeline).toBe(true);
    expect(res.isError).not.toBe(true);
  });

  it("mtc: defaults port (device index) to 0 and omits osc_address", async () => {
    const exec = okExec({
      kind: "sync_timecode",
      source: "mtc",
      node: "/project1/tc_in1_sys/midi_in",
      null_path: "/project1/tc_in1_sys/tc_out",
      drive_path: "/project1/tc_in1_sys/tc_drive",
      warnings: [],
    });
    await syncTimecodeImpl(fakeCtx(exec), {
      parent: "/project1",
      source: "mtc",
      drive_timeline: true,
      cue_on_label: false,
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.source).toBe("mtc");
    expect(payload.osc_address).toBeNull();
  });

  it("ltc: surfaces a decoder warning from the bridge", async () => {
    const exec = okExec({
      kind: "sync_timecode",
      source: "ltc",
      node: "/project1/tc_in1_sys/audio_in",
      null_path: "/project1/tc_in1_sys/tc_out",
      drive_path: null,
      warnings: ["LTC has no native TouchDesigner decoder — install ltc-tools…"],
    });
    const res = await syncTimecodeImpl(fakeCtx(exec), {
      parent: "/project1",
      source: "ltc",
      drive_timeline: false,
      cue_on_label: false,
    });
    expect(res.isError).not.toBe(true);
    const text = (res.content?.[0] as { text: string }).text;
    expect(text).toContain("1 warning");
  });

  it("drive_timeline:false → drive_path null and still success", async () => {
    const exec = okExec({
      kind: "sync_timecode",
      source: "osc",
      node: "/p/tc_in1_sys/osc_in",
      null_path: "/p/tc_in1_sys/tc_out",
      drive_path: null,
      warnings: [],
    });
    const res = await syncTimecodeImpl(fakeCtx(exec), {
      parent: "/project1",
      source: "osc",
      drive_timeline: false,
      cue_on_label: false,
    });
    expect(res.isError).not.toBe(true);
    const payload = decodePayload(scriptArg(exec));
    expect(payload.drive_timeline).toBe(false);
  });

  it("TD offline → friendly isError via guardTd", async () => {
    const exec = vi.fn(async () => {
      throw new TdConnectionError("bridge down");
    });
    const res = await syncTimecodeImpl(fakeCtx(exec), {
      parent: "/project1",
      source: "osc",
      drive_timeline: true,
      cue_on_label: false,
    });
    expect(res.isError).toBe(true);
  });

  it("fatal report → isError with the fatal message", async () => {
    const exec = okExec({
      kind: "sync_timecode",
      source: "osc",
      warnings: [],
      fatal: "Parent COMP not found: /nope",
    });
    const res = await syncTimecodeImpl(fakeCtx(exec), {
      parent: "/nope",
      source: "osc",
      drive_timeline: true,
      cue_on_label: false,
    });
    expect(res.isError).toBe(true);
  });

  it("schema rejects a missing source", () => {
    const parsed = syncTimecodeSchema.safeParse({ parent: "/project1" });
    expect(parsed.success).toBe(false);
  });
});
