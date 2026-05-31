import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildPhoneGestureScript,
  createPhoneGestureImpl,
  createPhoneGestureSchema,
} from "../../src/tools/layer1/createPhoneGesture.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  parent: string;
  name: string;
  port: number;
  callbacks: string;
  script_callback: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload in script");
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

const baseArgs: Parameters<typeof createPhoneGestureImpl>[1] = {
  name: "phone_gesture",
  parent: "/project1",
  port: 9982,
  enableImu: true,
  enableMultitouch: true,
  shakeThreshold: 15,
};

function happyReport(overrides: Partial<{ warnings: string[] }> = {}) {
  return JSON.stringify({
    parent: "/project1",
    server: "/project1/phone_gesture_server",
    out: "/project1/phone_gesture_out",
    port: 9982,
    url: "http://10.0.0.5:9982/",
    warnings: overrides.warnings ?? [],
  });
}

describe("createPhoneGestureSchema defaults", () => {
  it("applies documented defaults", () => {
    const parsed = createPhoneGestureSchema.parse({});
    expect(parsed.name).toBe("phone_gesture");
    expect(parsed.parent).toBe("/project1");
    expect(parsed.port).toBe(9982);
    expect(parsed.enableImu).toBe(true);
    expect(parsed.enableMultitouch).toBe(true);
    expect(parsed.shakeThreshold).toBe(15);
  });

  it("rejects out-of-range port and shake threshold", () => {
    expect(() => createPhoneGestureSchema.parse({ port: 0 })).toThrow();
    expect(() => createPhoneGestureSchema.parse({ port: 70000 })).toThrow();
    expect(() => createPhoneGestureSchema.parse({ shakeThreshold: 0.1 })).toThrow();
    expect(() => createPhoneGestureSchema.parse({ shakeThreshold: 100 })).toThrow();
  });

  it("accepts toggles", () => {
    const p = createPhoneGestureSchema.parse({ enableImu: false, enableMultitouch: false });
    expect(p.enableImu).toBe(false);
    expect(p.enableMultitouch).toBe(false);
  });
});

describe("buildPhoneGestureScript (pure)", () => {
  it("script contains build operators and prints a json report", () => {
    const s = buildPhoneGestureScript(baseArgs);
    expect(s).toContain("import json, base64");
    expect(s).toContain("print(json.dumps(report))");
    expect(s).toContain("webserverDAT");
    expect(s).toContain("scriptCHOP");
    expect(s).toContain("nullCHOP");
    expect(s).toContain("textDAT");
  });

  it("embeds parent / name / port in the base64 payload", () => {
    const s = buildPhoneGestureScript({ ...baseArgs, name: "gx", port: 9983 });
    const p = decodePayload(s);
    expect(p.parent).toBe("/project1");
    expect(p.name).toBe("gx");
    expect(p.port).toBe(9983);
  });

  it("callbacks include onHTTPRequest and onWebSocketReceiveText", () => {
    const p = decodePayload(buildPhoneGestureScript(baseArgs));
    expect(p.callbacks).toContain("def onHTTPRequest");
    expect(p.callbacks).toContain("def onWebSocketReceiveText");
    expect(p.callbacks).toContain("phone_gesture_state");
  });

  it("served HTML contains IMU + touch + websocket bits", () => {
    const p = decodePayload(buildPhoneGestureScript(baseArgs));
    const html = p.callbacks;
    expect(html).toContain("DeviceMotionEvent");
    expect(html).toContain("requestPermission");
    expect(html).toContain("deviceorientation");
    expect(html).toContain("devicemotion");
    expect(html).toContain("touchstart");
    expect(html).toContain("new WebSocket");
  });

  it("Script CHOP callback declares every expected channel name", () => {
    const p = decodePayload(buildPhoneGestureScript(baseArgs));
    const cb = p.script_callback;
    for (const name of [
      "tilt_x",
      "tilt_y",
      "tilt_z",
      "gyro_x",
      "gyro_y",
      "gyro_z",
      "shake",
      "touch%d_active",
      "clients",
    ]) {
      expect(cb).toContain(name);
    }
  });

  it("honors enableImu=false / enableMultitouch=false via JS flags but keeps channels", () => {
    const p = decodePayload(
      buildPhoneGestureScript({ ...baseArgs, enableImu: false, enableMultitouch: false }),
    );
    expect(p.callbacks).toContain("IMU_ENABLED = false");
    expect(p.callbacks).toContain("TOUCH_ENABLED = false");
    expect(p.script_callback).toContain("tilt_x");
    expect(p.script_callback).toContain("touch%d_active");
  });

  it("bakes shakeThreshold into the HTML", () => {
    const p = decodePayload(buildPhoneGestureScript({ ...baseArgs, shakeThreshold: 22 }));
    expect(p.callbacks).toContain("SHAKE_THRESHOLD = 22");
  });
});

describe("createPhoneGestureImpl — happy path", () => {
  it("returns a non-error result mentioning the URL", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createPhoneGestureImpl(fakeCtx(exec), { ...baseArgs });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("http://10.0.0.5:9982/");
    expect(text).toContain("phone_gesture");
  });

  it("surfaces warning counts", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ warnings: ["Web Server DAT: port in use"] }),
    }));
    const result = await createPhoneGestureImpl(fakeCtx(exec), { ...baseArgs });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("1 warning(s)");
  });
});

describe("createPhoneGestureImpl — fatal", () => {
  it("returns isError when the report has a fatal field", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        parent: "/nope",
        warnings: [],
        fatal: "COMP not found: /nope",
      }),
    }));
    const result = await createPhoneGestureImpl(fakeCtx(exec), { ...baseArgs, parent: "/nope" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMP not found");
  });
});
