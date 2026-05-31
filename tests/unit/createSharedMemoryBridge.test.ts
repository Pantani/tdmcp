import { describe, expect, it, vi } from "vitest";
import {
  buildShmScript,
  createSharedMemoryBridgeImpl,
  createSharedMemoryBridgeSchema,
} from "../../src/tools/layer2/createSharedMemoryBridge.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  direction: "in" | "out";
  kind: "TOP" | "CHOP";
  shmName: string;
  parent: string;
  name: string | null;
  format: Record<string, unknown>;
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

function okExec(report: Record<string, unknown>) {
  return vi.fn(async () => ({ stdout: JSON.stringify(report) }));
}

describe("buildShmScript", () => {
  it("round-trips the payload and embeds the defensive typemap + pixfmt map", () => {
    const payload = {
      direction: "out" as const,
      kind: "TOP" as const,
      shmName: "td_to_notch",
      parent: "/project1",
      name: null,
      format: { width: 1920, height: 1080, pixelFormat: "rgba8", header: true },
    };
    const script = buildShmScript(payload);
    expect(decodePayload(script)).toEqual(payload);
    expect(script).toContain('getattr(td, "sharedmemoryoutTOP", None)');
    expect(script).toContain('getattr(td, "sharedmemoryinCHOP", None)');
    expect(script).toContain('"rgba8":"rgba8fixed"');
    expect(script).toContain("Shared Memory %s %s is not available");
  });
});

describe("createSharedMemoryBridgeImpl", () => {
  it("out/TOP with format forwards resolution + pixelFormat and surfaces success", async () => {
    const exec = okExec({
      direction: "out",
      kind: "TOP",
      node: "/project1/sharedmemoryout1",
      type: "sharedmemoryoutTOP",
      shmName: "td_to_notch",
      warnings: [],
    });
    const result = await createSharedMemoryBridgeImpl(fakeCtx(exec), {
      direction: "out",
      kind: "TOP",
      shmName: "td_to_notch",
      parent: "/project1",
      format: { width: 1920, height: 1080, pixelFormat: "rgba8", header: true },
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.direction).toBe("out");
    expect(p.kind).toBe("TOP");
    expect(p.format).toMatchObject({ width: 1920, height: 1080, pixelFormat: "rgba8" });
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Created Shared Memory out TOP");
    expect(text).toContain("td_to_notch");
    expect(result.isError).not.toBe(true);
  });

  it("in/CHOP minimal args does not reference TOP-only setters in the script", async () => {
    const exec = okExec({
      direction: "in",
      kind: "CHOP",
      node: "/project1/sharedmemoryin1",
      type: "sharedmemoryinCHOP",
      shmName: "ext_chans",
      warnings: [],
    });
    const result = await createSharedMemoryBridgeImpl(fakeCtx(exec), {
      direction: "in",
      kind: "CHOP",
      shmName: "ext_chans",
      parent: "/project1",
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.kind).toBe("CHOP");
    expect(p.format).toEqual({});
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Created Shared Memory in CHOP");
  });

  it("returns isError when the report carries a fatal", async () => {
    const exec = okExec({
      direction: "out",
      kind: "CHOP",
      warnings: [],
      fatal: "Shared Memory out CHOP is not available on this TouchDesigner build/platform.",
    });
    const result = await createSharedMemoryBridgeImpl(fakeCtx(exec), {
      direction: "out",
      kind: "CHOP",
      shmName: "seg",
      parent: "/project1",
    });
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("not available on this TouchDesigner build/platform");
  });

  it("surfaces warnings count without flagging an error", async () => {
    const exec = okExec({
      direction: "out",
      kind: "TOP",
      node: "/project1/sharedmemoryout1",
      type: "sharedmemoryoutTOP",
      shmName: "seg",
      warnings: ["No parameter 'pixelformat' on sharedmemoryoutTOP"],
    });
    const result = await createSharedMemoryBridgeImpl(fakeCtx(exec), {
      direction: "out",
      kind: "TOP",
      shmName: "seg",
      parent: "/project1",
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("1 warning(s)");
  });

  it("rejects shmName with spaces via the Zod regex", () => {
    const r = createSharedMemoryBridgeSchema.safeParse({
      direction: "in",
      kind: "TOP",
      shmName: "bad name",
    });
    expect(r.success).toBe(false);
  });

  it("accepts out/TOP with no format and sends an empty format object", async () => {
    const exec = okExec({
      direction: "out",
      kind: "TOP",
      node: "/project1/sharedmemoryout1",
      type: "sharedmemoryoutTOP",
      shmName: "seg",
      warnings: [],
    });
    await createSharedMemoryBridgeImpl(fakeCtx(exec), {
      direction: "out",
      kind: "TOP",
      shmName: "seg",
      parent: "/project1",
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.format).toEqual({});
  });
});
