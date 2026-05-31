import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildEngineCompScript,
  createEngineCompImpl,
  createEngineCompSchema,
} from "../../src/tools/layer1/createEngineComp.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  parent_path: string;
  name: string;
  tox_path: string;
  reload: boolean;
  use_color_map: boolean;
  perform_mode: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
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

const DEFAULT_ARGS = {
  name: "engine1",
  parent_path: "/project1",
  tox_path: "/assets/heavy.tox",
  reload: false,
  use_color_map: false,
  perform_mode: "auto" as const,
};

function happyReport(overrides: Partial<{ warnings: string[]; path: string }> = {}) {
  return JSON.stringify({
    path: overrides.path ?? "/project1/engine1",
    type: "engineCOMP",
    tox_path: "/assets/heavy.tox",
    warnings: overrides.warnings ?? [],
  });
}

// ---------------------------------------------------------------------------
// Script / payload
// ---------------------------------------------------------------------------

describe("buildEngineCompScript", () => {
  it("emits a script that creates engineCOMP and assigns par.file from payload", () => {
    const script = buildEngineCompScript({
      parent_path: "/project1",
      name: "engine1",
      tox_path: "/assets/heavy.tox",
      reload: false,
      use_color_map: false,
      perform_mode: "auto",
    });
    expect(script).toContain("engineCOMP");
    expect(script).toContain('_node.par.file = _p["tox_path"]');
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
  });

  it("payload carries all fields verbatim", () => {
    const script = buildEngineCompScript({
      parent_path: "/render",
      name: "subengine",
      tox_path: "C:/work/scene.tox",
      reload: true,
      use_color_map: true,
      perform_mode: "on",
    });
    const p = decodePayload(script);
    expect(p.parent_path).toBe("/render");
    expect(p.name).toBe("subengine");
    expect(p.tox_path).toBe("C:/work/scene.tox");
    expect(p.reload).toBe(true);
    expect(p.use_color_map).toBe(true);
    expect(p.perform_mode).toBe("on");
  });

  it("contains hasattr-guarded reload pulse and performmode/usecolormap branches", () => {
    const script = buildEngineCompScript({
      parent_path: "/project1",
      name: "engine1",
      tox_path: "/a.tox",
      reload: true,
      use_color_map: true,
      perform_mode: "on",
    });
    expect(script).toContain("_node.par.reload.pulse()");
    expect(script).toContain('hasattr(_node.par, "performmode")');
    expect(script).toContain('hasattr(_node.par, "usecolormap")');
    expect(script).toContain('hasattr(_node.par, "reload")');
  });
});

// ---------------------------------------------------------------------------
// Impl — payload assertions per spec
// ---------------------------------------------------------------------------

describe("createEngineCompImpl — payload", () => {
  it("uses default name + parent when omitted", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createEngineCompImpl(fakeCtx(exec), DEFAULT_ARGS);
    const p = decodePayload(scriptArg(exec));
    expect(p.name).toBe("engine1");
    expect(p.parent_path).toBe("/project1");
  });

  it("threads tox_path into payload", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createEngineCompImpl(fakeCtx(exec), {
      ...DEFAULT_ARGS,
      tox_path: "/somewhere/other.tox",
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.tox_path).toBe("/somewhere/other.tox");
  });

  it("perform_mode='on' passes through; 'auto' (default) passes through too (script gates the assignment)", async () => {
    const execOn = vi.fn(async () => ({ stdout: happyReport() }));
    await createEngineCompImpl(fakeCtx(execOn), { ...DEFAULT_ARGS, perform_mode: "on" });
    expect(decodePayload(scriptArg(execOn)).perform_mode).toBe("on");

    const execAuto = vi.fn(async () => ({ stdout: happyReport() }));
    await createEngineCompImpl(fakeCtx(execAuto), DEFAULT_ARGS);
    expect(decodePayload(scriptArg(execAuto)).perform_mode).toBe("auto");
  });

  it("reload flag round-trips through payload (true and false)", async () => {
    const execTrue = vi.fn(async () => ({ stdout: happyReport() }));
    await createEngineCompImpl(fakeCtx(execTrue), { ...DEFAULT_ARGS, reload: true });
    expect(decodePayload(scriptArg(execTrue)).reload).toBe(true);

    const execFalse = vi.fn(async () => ({ stdout: happyReport() }));
    await createEngineCompImpl(fakeCtx(execFalse), DEFAULT_ARGS);
    expect(decodePayload(scriptArg(execFalse)).reload).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Impl — happy path result shape
// ---------------------------------------------------------------------------

describe("createEngineCompImpl — happy path", () => {
  it("returns non-error result with summary mentioning .tox path and node path", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createEngineCompImpl(fakeCtx(exec), DEFAULT_ARGS);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/engine1");
    expect(text).toContain("/assets/heavy.tox");
  });

  it("notes warning count when warnings present", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ warnings: ["engineCOMP has no 'performmode' par (UNVERIFIED)."] }),
    }));
    const result = await createEngineCompImpl(fakeCtx(exec), DEFAULT_ARGS);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("1 warning(s)");
  });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("createEngineCompSchema", () => {
  it("applies all defaults when only tox_path is provided", () => {
    const parsed = createEngineCompSchema.parse({ tox_path: "/a.tox" });
    expect(parsed.name).toBe("engine1");
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.reload).toBe(false);
    expect(parsed.use_color_map).toBe(false);
    expect(parsed.perform_mode).toBe("auto");
  });

  it("requires tox_path", () => {
    expect(() => createEngineCompSchema.parse({})).toThrow();
  });

  it("rejects invalid perform_mode", () => {
    expect(() =>
      createEngineCompSchema.parse({ tox_path: "/a.tox", perform_mode: "always" }),
    ).toThrow();
  });

  it("accepts all valid perform_mode values", () => {
    for (const pm of ["auto", "on", "off"]) {
      expect(() =>
        createEngineCompSchema.parse({ tox_path: "/a.tox", perform_mode: pm }),
      ).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Fatal + offline
// ---------------------------------------------------------------------------

describe("createEngineCompImpl — fatal", () => {
  it("returns isError:true when parent COMP missing", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        path: "",
        type: "engineCOMP",
        tox_path: "/a.tox",
        warnings: [],
        fatal: "Parent COMP not found: /project1/missing",
      }),
    }));
    const result = await createEngineCompImpl(fakeCtx(exec), {
      ...DEFAULT_ARGS,
      parent_path: "/project1/missing",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });
});

describe("createEngineCompImpl — TD offline", () => {
  it("returns isError:true and does not throw when bridge is unreachable", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createEngineCompImpl(fakeCtx(exec), DEFAULT_ARGS);
    expect(result.isError).toBe(true);
  });
});
