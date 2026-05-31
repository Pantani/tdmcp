import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createChromaReactiveImpl,
  createChromaReactiveSchema,
} from "../../src/tools/layer1/createChromaReactive.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function captureExecScripts(stdout = ""): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout } });
    }),
  );
  return scripts;
}

function decodePayload(script: string): Record<string, unknown> {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (!b64) throw new Error("no payload base64 in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

describe("createChromaReactiveSchema", () => {
  it("has the expected defaults", () => {
    const parsed = createChromaReactiveSchema.parse({});
    expect(parsed.name).toBe("chroma_reactive");
    expect(parsed.parent).toBe("/");
    expect(parsed.fftSize).toBe(2048);
    expect(parsed.smoothing).toBeCloseTo(0.7);
    expect(parsed.audioSource).toBeUndefined();
  });

  it("rejects invalid fftSize", () => {
    expect(() => createChromaReactiveSchema.parse({ fftSize: 512 })).toThrow();
  });

  it("rejects out-of-range smoothing", () => {
    expect(() => createChromaReactiveSchema.parse({ smoothing: 1.5 })).toThrow();
  });
});

describe("createChromaReactiveImpl", () => {
  it("sends a Python payload that builds the audio→spectrum→script→filter→out chain", async () => {
    const fakeReport = {
      parent_path: "/chroma_reactive",
      output_path: "/chroma_reactive/out",
      channels: Array.from({ length: 12 }, (_, i) => `chroma_${i}`),
      children: [],
      warnings: [],
    };
    const scripts = captureExecScripts(`${JSON.stringify(fakeReport)}\n`);
    const result = await createChromaReactiveImpl(makeCtx(), {
      name: "chroma_reactive",
      parent: "/",
      fftSize: 2048,
      smoothing: 0.7,
    });
    expect(result.isError).toBeFalsy();
    expect(scripts).toHaveLength(1);
    const script = scripts[0] ?? "";
    expect(script).toContain("audiospectrumCHOP");
    expect(script).toContain("fftsize");
    expect(script).toContain("scriptCHOP");
    expect(script).toContain("Refpitch");
    expect(script).toContain("chroma_");
    expect(script).toContain("filterCHOP");
    expect(script).toContain("nullCHOP");
    expect(script).toContain("audiodeviceinCHOP");
    // Pitch-class fold math is inlined in the Script CHOP body
    expect(script).toContain("log2");
    expect(script).toContain("% 12");
    const payload = decodePayload(script);
    expect(payload.fftSize).toBe(2048);
    expect(payload.smoothing).toBe(0.7);
    expect(payload.audioSource).toBeNull();
  });

  it("passes audioSource through to the payload", async () => {
    const fakeReport = {
      parent_path: "/chroma_reactive",
      output_path: "/chroma_reactive/out",
      channels: [],
      children: [],
      warnings: [],
    };
    const scripts = captureExecScripts(`${JSON.stringify(fakeReport)}\n`);
    await createChromaReactiveImpl(makeCtx(), {
      name: "chroma_reactive",
      parent: "/",
      audioSource: "/project1/myAudio",
      fftSize: 4096,
      smoothing: 0.3,
    });
    const payload = decodePayload(scripts[0] ?? "");
    expect(payload.audioSource).toBe("/project1/myAudio");
    expect(payload.fftSize).toBe(4096);
  });

  it("returns an isError result when the bridge report has a fatal", async () => {
    const fakeReport = { warnings: [], fatal: "Parent not found: /nope" };
    captureExecScripts(`${JSON.stringify(fakeReport)}\n`);
    const result = await createChromaReactiveImpl(makeCtx(), {
      name: "chroma_reactive",
      parent: "/nope",
      fftSize: 2048,
      smoothing: 0.7,
    });
    expect(result.isError).toBe(true);
  });

  it("does not throw when the bridge connection fails", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => HttpResponse.json({ ok: false }, { status: 500 })),
    );
    const result = await createChromaReactiveImpl(makeCtx(), {
      name: "chroma_reactive",
      parent: "/",
      fftSize: 2048,
      smoothing: 0.7,
    });
    expect(result.isError).toBe(true);
  });
});
