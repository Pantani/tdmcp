import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildObsCommandPayload,
  buildObsStreamControlScript,
  obsStreamControlImpl,
  obsStreamControlSchema,
} from "../../src/tools/layer2/obsStreamControl.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function decodePayload(script: string): Record<string, unknown> {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function jsonOf(result: CallToolResult): Record<string, unknown> {
  const match = /```json\n([\s\S]*?)\n```/.exec(textOf(result));
  if (!match?.[1]) throw new Error("result did not contain a JSON fence");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

describe("obsStreamControlSchema", () => {
  it("defaults to local OBS WebSocket v5 with safe auto_connect=false", () => {
    const parsed = obsStreamControlSchema.parse({});
    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.port).toBe(4455);
    expect(parsed.auto_connect).toBe(false);
    expect(parsed.include_recording).toBe(true);
  });

  it("rejects invalid ports", () => {
    expect(() => obsStreamControlSchema.parse({ port: 70000 })).toThrow();
  });
});

describe("buildObsCommandPayload", () => {
  it("creates stream, recording, and scene request payloads", () => {
    const commands = buildObsCommandPayload(
      obsStreamControlSchema.parse({ scenes: ["Scene 12", "Program/Main"] }),
    );
    expect(commands.map((command) => command.request_type)).toEqual([
      "StartStream",
      "StopStream",
      "ToggleStream",
      "StartRecord",
      "StopRecord",
      "ToggleRecord",
      "SetCurrentProgramScene",
      "SetCurrentProgramScene",
    ]);
    expect(commands.at(-1)?.request_data).toEqual({ sceneName: "Program/Main" });
    expect(commands.map((command) => command.channel)).toContain("scene_scene_12");
  });

  it("omits recording controls when requested", () => {
    const commands = buildObsCommandPayload(
      obsStreamControlSchema.parse({ include_recording: false }),
    );
    expect(commands.map((command) => command.request_type)).toEqual([
      "StartStream",
      "StopStream",
      "ToggleStream",
    ]);
  });
});

describe("buildObsStreamControlScript", () => {
  it("embeds websocketDAT, dispatch callbacks, obs-websocket v5 request op, and payload", () => {
    const commands = buildObsCommandPayload(obsStreamControlSchema.parse({ scenes: ["Scene 12"] }));
    const script = buildObsStreamControlScript({
      parent_path: "/project1",
      name: "obs_stream_control",
      host: "127.0.0.1",
      port: 4455,
      endpoint: "ws://127.0.0.1:4455",
      auto_connect: false,
      auth_required: false,
      commands,
    });
    expect(script).toContain("websocketDAT");
    expect(script).toContain("chopexecuteDAT");
    expect(script).toContain("obswebsocket.json");
    expect(script).toContain('"op": 6');
    expect(script).toContain("onReceiveText");
    expect(script).toContain("sendText");

    const payload = decodePayload(script);
    expect(payload.endpoint).toBe("ws://127.0.0.1:4455");
    expect(payload.commands).toEqual(commands);
  });
});

describe("obsStreamControlImpl", () => {
  it("sends the expected payload to TD and returns a friendly summary", async () => {
    let captured: Record<string, unknown> | undefined;
    const exec = vi.fn(async (script: string) => {
      captured = decodePayload(script);
      const commands = captured.commands as Array<{ channel: string }>;
      return {
        stdout: JSON.stringify({
          container: "/project1/obs_stream_control",
          websocket: "/project1/obs_stream_control/obs_ws",
          controls: "/project1/obs_stream_control/obs_controls",
          dispatch_dat: "/project1/obs_stream_control/obs_dispatch",
          requests_dat: "/project1/obs_stream_control/obs_requests",
          endpoint: captured.endpoint,
          commands,
          command_channels: commands.map((command) => command.channel),
          auth_note: "OBS passwords are intentionally not stored.",
          warnings: [],
        }),
      };
    });

    const result = await obsStreamControlImpl(
      fakeCtx(exec),
      obsStreamControlSchema.parse({
        name: "obs_show",
        use_tls: true,
        scenes: ["Intro"],
        auto_connect: true,
        auth_required: true,
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(captured).toMatchObject({
      name: "obs_show",
      endpoint: "wss://127.0.0.1:4455",
      auto_connect: true,
      auth_required: true,
    });
    const commands = captured?.commands as Array<{ request_type: string; request_data: unknown }>;
    expect(commands.some((command) => command.request_type === "SetCurrentProgramScene")).toBe(
      true,
    );
    expect(commands.at(-1)?.request_data).toEqual({ sceneName: "Intro" });
    expect(textOf(result)).toContain("Built OBS stream control");
    expect(jsonOf(result).endpoint).toBe("wss://127.0.0.1:4455");
  });

  it("returns isError when the bridge report is fatal", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        commands: [],
        command_channels: [],
        auth_note: "",
        warnings: [],
        fatal: "Parent COMP not found: /missing",
      }),
    }));
    const result = await obsStreamControlImpl(
      fakeCtx(exec),
      obsStreamControlSchema.parse({ parent_path: "/missing" }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });
});
