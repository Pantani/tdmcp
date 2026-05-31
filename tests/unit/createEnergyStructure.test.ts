import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildEnergyStructureScript,
  createEnergyStructureImpl,
  createEnergyStructureSchema,
} from "../../src/tools/layer1/createEnergyStructure.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  parent: string;
  name: string;
  audioSource: string;
  windowSec: number;
  buildThreshold: number;
  dropThreshold: number;
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

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const s = exec.mock.calls[0]?.[0];
  if (typeof s !== "string") throw new Error("executePythonScript not called with a string");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function happyReport(overrides: Partial<{ warnings: string[]; comp: string }> = {}) {
  return JSON.stringify({
    comp: overrides.comp ?? "/energy1",
    ops: ["/energy1/audioin", "/energy1/env", "/energy1/script", "/energy1/out"],
    warnings: overrides.warnings ?? [],
  });
}

describe("createEnergyStructureSchema defaults", () => {
  it("applies documented defaults", () => {
    const parsed = createEnergyStructureSchema.parse({ name: "e1" });
    expect(parsed.parent).toBe("/");
    expect(parsed.windowSec).toBe(20);
    expect(parsed.buildThreshold).toBe(0.7);
    expect(parsed.dropThreshold).toBe(0.85);
    expect(parsed.audioSource).toBeUndefined();
  });

  it("rejects windowSec out of range", () => {
    expect(() => createEnergyStructureSchema.parse({ name: "e", windowSec: 1 })).toThrow();
    expect(() => createEnergyStructureSchema.parse({ name: "e", windowSec: 200 })).toThrow();
  });

  it("rejects empty name", () => {
    expect(() => createEnergyStructureSchema.parse({ name: "" })).toThrow();
  });
});

describe("buildEnergyStructureScript (pure payload)", () => {
  it("embeds schema fields in the base64 payload", () => {
    const script = buildEnergyStructureScript({
      parent: "/",
      name: "energy1",
      audioSource: "",
      windowSec: 20,
      buildThreshold: 0.7,
      dropThreshold: 0.85,
    });
    const payload = decodePayload(script);
    expect(payload.parent).toBe("/");
    expect(payload.name).toBe("energy1");
    expect(payload.windowSec).toBe(20);
    expect(payload.buildThreshold).toBe(0.7);
    expect(payload.dropThreshold).toBe(0.85);
  });

  it("script references expected operators and outputs", () => {
    const script = buildEnergyStructureScript({
      parent: "/",
      name: "energy1",
      audioSource: "",
      windowSec: 20,
      buildThreshold: 0.7,
      dropThreshold: 0.85,
    });
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
    expect(script).toContain("baseCOMP");
    expect(script).toContain("audiodeviceinCHOP");
    expect(script).toContain("filterCHOP");
    expect(script).not.toContain("envelopeCHOP");
    expect(script).toContain("scriptCHOP");
    expect(script).toContain("nullCHOP");
    expect(script).toContain("selectCHOP");
  });

  it("script body contains rolling-buffer adaptive-threshold logic", () => {
    const script = buildEnergyStructureScript({
      parent: "/",
      name: "e",
      audioSource: "",
      windowSec: 20,
      buildThreshold: 0.7,
      dropThreshold: 0.85,
    });
    // rolling stats + storage + edge channels + hysteresis counters
    expect(script).toContain("parent_.fetch");
    expect(script).toContain("parent_.store");
    expect(script).toContain("'buf'");
    expect(script).toContain("build_level");
    expect(script).toContain("drop_level");
    expect(script).toContain("build_edge");
    expect(script).toContain("drop_edge");
    expect(script).toContain("breakdown_edge");
    expect(script).toContain("'above'");
    expect(script).toContain("'below'");
    // custom-param names exposed on parent
    expect(script).toContain("Windowsec");
    expect(script).toContain("Buildthreshold");
    expect(script).toContain("Dropthreshold");
  });
});

describe("createEnergyStructureImpl — happy path", () => {
  it("builds with defaults and returns a summary", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createEnergyStructureImpl(fakeCtx(exec), {
      name: "energy1",
      parent: "/",
      windowSec: 20,
      buildThreshold: 0.7,
      dropThreshold: 0.85,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/energy1");
    expect(text).toContain("energy/state/build_edge/drop_edge/breakdown_edge");
    const payload = decodePayload(scriptArg(exec));
    expect(payload.audioSource).toBe("");
    expect(payload.name).toBe("energy1");
  });

  it("passes audioSource through the payload (skips Audio Device In)", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createEnergyStructureImpl(fakeCtx(exec), {
      name: "e",
      parent: "/",
      audioSource: "/audio/in1",
      windowSec: 20,
      buildThreshold: 0.7,
      dropThreshold: 0.85,
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.audioSource).toBe("/audio/in1");
  });

  it("surfaces warnings count", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ warnings: ["env connect: nope"] }),
    }));
    const result = await createEnergyStructureImpl(fakeCtx(exec), {
      name: "e",
      parent: "/",
      windowSec: 20,
      buildThreshold: 0.7,
      dropThreshold: 0.85,
    });
    expect(textOf(result)).toContain("1 warning(s)");
  });
});

describe("createEnergyStructureImpl — validation", () => {
  it("rejects dropThreshold <= buildThreshold without calling the bridge", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createEnergyStructureImpl(fakeCtx(exec), {
      name: "e",
      parent: "/",
      windowSec: 20,
      buildThreshold: 0.9,
      dropThreshold: 0.5,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("dropThreshold");
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("createEnergyStructureImpl — fatal", () => {
  it("returns isError when bridge reports fatal, does not throw", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        comp: "",
        ops: [],
        warnings: [],
        fatal: "Parent not found: /nope",
      }),
    }));
    const result = await createEnergyStructureImpl(fakeCtx(exec), {
      name: "e",
      parent: "/nope",
      windowSec: 20,
      buildThreshold: 0.7,
      dropThreshold: 0.85,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent not found");
  });

  it("returns isError when bridge throws (TD offline), does not throw", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createEnergyStructureImpl(fakeCtx(exec), {
      name: "e",
      parent: "/",
      windowSec: 20,
      buildThreshold: 0.7,
      dropThreshold: 0.85,
    });
    expect(result.isError).toBe(true);
  });
});
