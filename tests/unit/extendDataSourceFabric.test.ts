import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildExtendDataSourceFabricScript,
  extendDataSourceFabricImpl,
  extendDataSourceFabricSchema,
} from "../../src/tools/layer2/extendDataSourceFabric.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function decodePayload(script: string): Record<string, unknown> {
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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function jsonOf(result: CallToolResult): Record<string, unknown> {
  const text = textOf(result);
  const m = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!m?.[1]) throw new Error("no json fence in result text");
  return JSON.parse(m[1]);
}

function okExec(report: Record<string, unknown>) {
  return vi.fn(async () => ({ stdout: JSON.stringify(report) }));
}

const BASE = {
  parent_path: "/project1",
  host: "127.0.0.1",
  tls: false,
  frame_format: "float32-le" as const,
  channels: 4,
  fields: ["value"],
  expose_controls: true,
};

describe("buildExtendDataSourceFabricScript", () => {
  it("round-trips an mqtt payload", () => {
    const script = buildExtendDataSourceFabricScript({
      transport: "mqtt",
      parent: "/project1",
      name: null,
      host: "broker.local",
      port: 1883,
      topic: "tdmcp/#",
      username: "u",
      password: "p",
      tls: false,
      device: null,
      frame_format: null,
      channels: null,
      fields: ["bass", "mid"],
      expose_controls: true,
    });
    const payload = decodePayload(script);
    expect(payload.transport).toBe("mqtt");
    expect(payload.host).toBe("broker.local");
    expect(payload.topic).toBe("tdmcp/#");
    expect(payload.username).toBe("u");
    expect(script).toContain("mqttclientDAT");
    expect(script).toContain("tableDAT");
    expect(script).toContain("dattoCHOP");
    expect(script).toContain("nullCHOP");
    expect(script).toContain("nullDAT");
    expect(script).toContain("textDAT");
  });
});

describe("extendDataSourceFabricImpl mqtt", () => {
  it("builds the mqtt branch and returns its channels and Active control", async () => {
    const exec = okExec({
      transport: "mqtt",
      container: "/project1/data_source_mqtt",
      source: "/project1/data_source_mqtt/src",
      source_type: "mqttclient",
      null_chop: "/project1/data_source_mqtt/out",
      null_dat: "/project1/data_source_mqtt/raw",
      channels: ["bass", "mid"],
      fields: ["bass", "mid"],
      controls: ["Active", "Reconnect"],
      warnings: [],
    });
    const args = extendDataSourceFabricSchema.parse({
      ...BASE,
      transport: "mqtt",
      host: "broker.local",
      port: 1883,
      topic: "tdmcp/#",
      username: "u",
      fields: ["bass", "mid"],
    });
    const result = await extendDataSourceFabricImpl(fakeCtx(exec), args);
    expect(exec).toHaveBeenCalledOnce();
    const script = scriptArg(exec);
    expect(script).toContain("mqttclientDAT");
    const payload = decodePayload(script);
    expect(payload.host).toBe("broker.local");
    expect(payload.port).toBe(1883);
    expect(payload.username).toBe("u");
    expect(textOf(result)).toContain("mqtt");
    expect(jsonOf(result)).toMatchObject({
      transport: "mqtt",
      container: "/project1/data_source_mqtt",
      null_chop: "/project1/data_source_mqtt/out",
      channels: ["bass", "mid"],
      controls: ["Active", "Reconnect"],
    });
  });
});

describe("extendDataSourceFabricImpl ws-binary", () => {
  it("builds the ws-binary branch with float32-le decode", async () => {
    const exec = okExec({
      transport: "ws-binary",
      container: "/project1/data_source_ws_binary",
      null_chop: "/project1/data_source_ws_binary/out",
      null_dat: "/project1/data_source_ws_binary/raw",
      channels: ["ch0", "ch1", "ch2", "ch3"],
      fields: ["ch0", "ch1", "ch2", "ch3"],
      controls: ["Active", "Reconnect"],
      warnings: [],
    });
    const args = extendDataSourceFabricSchema.parse({
      ...BASE,
      transport: "ws-binary",
      port: 9001,
      topic: "/stream",
      frame_format: "float32-le",
      channels: 4,
    });
    const result = await extendDataSourceFabricImpl(fakeCtx(exec), args);
    const script = scriptArg(exec);
    // Operator and fallback marker.
    expect(script).toContain("websocketDAT");
    expect(script).toContain("webclientDAT");
    expect(script).toContain("float32-le");
    expect(script).toContain("int16-le");
    expect(script).toContain("tableDAT");
    expect(script).toContain("dattoCHOP");
    expect(script).toContain("nullCHOP");
    expect(script).toContain("nullDAT");
    expect(script).toContain("textDAT");
    const payload = decodePayload(script);
    expect(payload.transport).toBe("ws-binary");
    expect(payload.channels).toBe(4);
    expect(payload.frame_format).toBe("float32-le");
    expect(jsonOf(result)).toMatchObject({
      transport: "ws-binary",
      channels: ["ch0", "ch1", "ch2", "ch3"],
    });
  });
});

describe("extendDataSourceFabricImpl midi-mmc", () => {
  it("builds the midi-mmc branch with MMC sub-IDs and transport channels", async () => {
    const exec = okExec({
      transport: "midi-mmc",
      container: "/project1/data_source_midi_mmc",
      null_chop: "/project1/data_source_midi_mmc/out",
      null_dat: "/project1/data_source_midi_mmc/raw",
      channels: ["play", "stop", "record", "locate"],
      fields: ["play", "stop", "record", "locate"],
      controls: ["Active"],
      warnings: [],
    });
    const args = extendDataSourceFabricSchema.parse({
      ...BASE,
      transport: "midi-mmc",
    });
    const result = await extendDataSourceFabricImpl(fakeCtx(exec), args);
    const script = scriptArg(exec);
    expect(script).toContain("midiinDAT");
    expect(script).toContain("0x01");
    expect(script).toContain("0x02");
    expect(script).toContain("0x06");
    expect(script).toContain("0x44");
    expect(script).toContain("tableDAT");
    expect(script).toContain("dattoCHOP");
    expect(script).toContain("nullCHOP");
    expect(script).toContain("nullDAT");
    expect(script).toContain("textDAT");
    expect(jsonOf(result)).toMatchObject({
      transport: "midi-mmc",
      channels: ["play", "stop", "record", "locate"],
      controls: ["Active"],
    });
  });
});

describe("extendDataSourceFabricImpl controls + fatal", () => {
  it("does not append a Controls page when expose_controls is false", async () => {
    const exec = okExec({
      transport: "mqtt",
      container: "/project1/data_source_mqtt",
      null_chop: "/project1/data_source_mqtt/out",
      channels: ["value"],
      controls: [],
      warnings: [],
    });
    const args = extendDataSourceFabricSchema.parse({
      ...BASE,
      transport: "mqtt",
      expose_controls: false,
    });
    await extendDataSourceFabricImpl(fakeCtx(exec), args);
    const script = scriptArg(exec);
    const payload = decodePayload(script);
    expect(payload.expose_controls).toBe(false);
    // The script gates the Controls page on this flag at runtime.
    expect(script).toContain('if _p.get("expose_controls")');
  });

  it("returns an isError result when the report carries fatal", async () => {
    const exec = okExec({
      transport: "midi-mmc",
      warnings: [],
      fatal: "boom",
    });
    const args = extendDataSourceFabricSchema.parse({ ...BASE, transport: "midi-mmc" });
    const result = await extendDataSourceFabricImpl(fakeCtx(exec), args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("midi-mmc");
    expect(textOf(result)).toContain("boom");
  });
});
