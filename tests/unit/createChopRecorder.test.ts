import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildChopRecorderScript,
  createChopRecorderImpl,
  createChopRecorderSchema,
} from "../../src/tools/layer1/createChopRecorder.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

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

const baseArgs = {
  name: "chop_rec_hand",
  sourceChop: "/project1/null_audio",
} as const;

const okReport = (over: Record<string, unknown> = {}) =>
  vi.fn(async () => ({
    stdout: JSON.stringify({
      container: "/chop_rec_hand",
      source: "/project1/null_audio",
      lengthSeconds: 8,
      takeName: "take1",
      loop: true,
      recording: false,
      reactiveChannel: "/chop_rec_hand/null_out",
      hasTake: false,
      takeSamples: 0,
      warnings: [],
      exists: false,
      ...over,
    }),
  }));

// ─── schema ──────────────────────────────────────────────────────────────────

describe("createChopRecorderSchema", () => {
  it("applies defaults: lengthSeconds=8, takeName=take1, loop=true, recordOnCreate=false", () => {
    const p = createChopRecorderSchema.parse({ name: "rec1", sourceChop: "/foo" });
    expect(p.lengthSeconds).toBe(8);
    expect(p.takeName).toBe("take1");
    expect(p.loop).toBe(true);
    expect(p.recordOnCreate).toBe(false);
  });

  it("rejects lengthSeconds > 120 (spec cap)", () => {
    expect(() =>
      createChopRecorderSchema.parse({ name: "rec1", sourceChop: "/foo", lengthSeconds: 999 }),
    ).toThrow();
  });

  it("rejects empty name", () => {
    expect(() => createChopRecorderSchema.parse({ name: "", sourceChop: "/foo" })).toThrow();
  });
});

// ─── buildChopRecorderScript ──────────────────────────────────────────────────

describe("buildChopRecorderScript", () => {
  it("embeds required operator types in the script", () => {
    const script = buildChopRecorderScript({
      name: "chop_rec_hand",
      parent: "/",
      sourceChop: "/project1/null_audio",
      lengthSeconds: 8,
      takeName: "take1",
      loop: true,
      recordOnCreate: false,
    });
    expect(script).toContain("trailCHOP");
    expect(script).toContain("timerCHOP");
    expect(script).toContain("lookupCHOP");
    expect(script).toContain("nullCHOP");
    expect(script).toContain("tableDAT");
    expect(script).toContain("dattoCHOP");
    expect(script).toContain("scriptCHOP");
    expect(script).toContain("textDAT");
  });

  it("embeds storage key tdmcp_chop_recorder", () => {
    const script = buildChopRecorderScript({
      name: "r",
      parent: "/",
      sourceChop: "/s",
      lengthSeconds: 4,
      takeName: "t1",
      loop: false,
      recordOnCreate: false,
    });
    expect(script).toContain("tdmcp_chop_recorder");
  });

  it("embeds custom-page parameter names", () => {
    const script = buildChopRecorderScript({
      name: "r",
      parent: "/",
      sourceChop: "/s",
      lengthSeconds: 4,
      takeName: "t1",
      loop: true,
      recordOnCreate: false,
    });
    expect(script).toContain("Record");
    expect(script).toContain("Stop");
    expect(script).toContain("Loop");
    expect(script).toContain("Scrub");
    expect(script).toContain("Length");
    expect(script).toContain("Takename");
    expect(script).toContain("Play");
  });
});

// ─── createChopRecorderImpl ───────────────────────────────────────────────────

describe("createChopRecorderImpl", () => {
  // Test 1 — happy path
  it("happy path: returns container, reactiveChannel ends in /null_out, summary mentions length and take name", async () => {
    const exec = okReport();
    const result = await createChopRecorderImpl(fakeCtx(exec), {
      ...baseArgs,
      lengthSeconds: 8,
      takeName: "take1",
      loop: true,
      recordOnCreate: false,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/chop_rec_hand");
    expect(text).toContain("/null_out");
    expect(text).toContain("8");
    expect(text).toContain("take1");
    // structuredContent via jsonResult embeds the raw report in JSON fence
    expect(text).toContain("reactiveChannel");
  });

  // Test 2 — script content
  it("script embeds all required operators and storage key", async () => {
    const exec = okReport();
    await createChopRecorderImpl(fakeCtx(exec), {
      ...baseArgs,
      lengthSeconds: 8,
      takeName: "take1",
      loop: true,
      recordOnCreate: false,
    });
    const script = scriptArg(exec);
    expect(script).toContain("trailCHOP");
    expect(script).toContain("timerCHOP");
    expect(script).toContain("lookupCHOP");
    expect(script).toContain("nullCHOP");
    expect(script).toContain("tableDAT");
    expect(script).toContain("dattoCHOP");
    expect(script).toContain("scriptCHOP");
    expect(script).toContain("textDAT");
    expect(script).toContain("tdmcp_chop_recorder");
    expect(script).toContain("Record");
    expect(script).toContain("Stop");
    expect(script).toContain("Loop");
    expect(script).toContain("Scrub");
    expect(script).toContain("Length");
    expect(script).toContain("Takename");
    expect(script).toContain("Play");
  });

  // Test 3 — recordOnCreate=true
  it("recordOnCreate=true: payload sets capture=1", async () => {
    const exec = okReport({ recording: true });
    await createChopRecorderImpl(fakeCtx(exec), {
      ...baseArgs,
      lengthSeconds: 8,
      takeName: "take1",
      loop: true,
      recordOnCreate: true,
    });
    const script = scriptArg(exec);
    // The script sets capture=1 when record_on_create is true
    expect(script).toContain("capture = 1 if _record_on_create else 0");
    // Payload decoded should have recordOnCreate=true
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
    if (b64 === undefined) throw new Error("no base64 payload found");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    expect(payload.recordOnCreate).toBe(true);
  });

  // Test 4 — loop=false
  it("loop=false: script sets cycle=0 and extend=hold", async () => {
    const exec = okReport({ loop: false });
    await createChopRecorderImpl(fakeCtx(exec), {
      ...baseArgs,
      lengthSeconds: 8,
      takeName: "take1",
      loop: false,
      recordOnCreate: false,
    });
    const script = scriptArg(exec);
    expect(script).toContain("cycle = 1 if _loop else 0");
    expect(script).toContain('"cycle" if _loop else "hold"');
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
    if (b64 === undefined) throw new Error("no base64 payload found");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    expect(payload.loop).toBe(false);
  });

  // Test 5 — autoBind set
  it("autoBind: payload contains bindExpr referencing null_out", async () => {
    const exec = okReport();
    await createChopRecorderImpl(fakeCtx(exec), {
      ...baseArgs,
      lengthSeconds: 8,
      takeName: "take1",
      loop: true,
      recordOnCreate: false,
      autoBind: "/project1/myop:myparam",
    });
    const script = scriptArg(exec);
    expect(script).toContain("null_out");
    expect(script).toContain("bindExpr");
    expect(script).toContain("bindMode = 1");
  });

  // Test 6 — fatal handling
  it("fatal report: returns isError with message containing 'Could not create CHOP recorder'", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ fatal: "boom", warnings: [] }),
    }));
    const result = await createChopRecorderImpl(fakeCtx(exec), {
      ...baseArgs,
      lengthSeconds: 8,
      takeName: "take1",
      loop: true,
      recordOnCreate: false,
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Could not create CHOP recorder: boom");
  });

  // Test 7 — bridge offline
  it("bridge offline: TdConnectionError → friendly isError result", async () => {
    const { TdConnectionError } = await import("../../src/td-client/types.js");
    const exec = vi.fn(async () => {
      throw new TdConnectionError("Connection refused");
    });
    const result = await createChopRecorderImpl(fakeCtx(exec), {
      ...baseArgs,
      lengthSeconds: 8,
      takeName: "take1",
      loop: true,
      recordOnCreate: false,
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text.toLowerCase()).toMatch(/touchdesigner|offline|connection|not running/i);
  });

  // Test 8 — length cap (Zod)
  it("rejects lengthSeconds=999 at Zod parse", () => {
    expect(() =>
      createChopRecorderSchema.parse({
        name: "r",
        sourceChop: "/s",
        lengthSeconds: 999,
      }),
    ).toThrow();
  });
});
