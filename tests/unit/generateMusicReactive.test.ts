import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AceStepClient } from "../../src/ace-client/aceStepClient.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { generateMusicReactiveImpl } from "../../src/tools/layer1/generateMusicReactive.js";
import type { AceToolContext } from "../../src/tools/layer3/generateMusic.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const ACE_BASE = "http://127.0.0.1:8000";
const OUTPUT_DIR = "/out/ace-output";
const OK_RESULT = { wavPath: "/out/bed.wav", seconds: 30, seed: 7 };

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(): AceStepClient {
  return new AceStepClient({
    baseUrl: ACE_BASE,
    timeoutMs: 2000,
    defaultSteps: 27,
    outputDir: OUTPUT_DIR,
    pollMs: 1,
  });
}

function makeCtx(aceClient?: AceStepClient): AceToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
    aceClient,
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * Capture the ACE submit body and reply with a crafted result. P2: the bed is now
 * generated through the shared driver's sync branch (POST /jobs + poll), not
 * POST /generate — same worker, but it buys progress + real cancellation.
 */
function captureGenerate(result: Record<string, unknown>): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.post(`${ACE_BASE}/jobs`, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ job_id: "job-r" });
    }),
    http.get(`${ACE_BASE}/jobs/job-r`, () => HttpResponse.json({ status: "done", ...result })),
  );
  return { bodies };
}

/** Capture the bodies of TD node-create calls. */
function captureCreateBodies(): CreatedNodeBody[] {
  const bodies: CreatedNodeBody[] = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as CreatedNodeBody;
      bodies.push(body);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
  );
  return bodies;
}

/** Capture the scripts sent to /api/exec (used for the frag-DAT shader assignment). */
function captureExecScripts(): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

describe("generate_music_reactive", () => {
  it("happy path: generation facts nested under structuredContent.generation, reactive keys preserved", async () => {
    captureGenerate(OK_RESULT);
    const result = await generateMusicReactiveImpl(makeCtx(makeClient()), {
      prompt: "lofi hip hop, mellow",
      visual_style: "glsl",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("bed (seed 7)");
    expect(text).toContain("/out/bed.wav");
    const structured = (result as { structuredContent?: Record<string, unknown> })
      .structuredContent;
    expect(structured?.generation).toEqual({ wavPath: "/out/bed.wav", seconds: 30, seed: 7 });
    // The reactive tool's own JSON-fence report (container path etc.) survives augmentation.
    expect(text).toContain('"container"');
    // The reactive preview image survives too.
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("forces audio_source=file with the generated wavPath (user cannot override the source)", async () => {
    captureGenerate(OK_RESULT);
    const bodies = captureCreateBodies();
    await generateMusicReactiveImpl(makeCtx(makeClient()), {
      prompt: "techno",
      visual_style: "glsl",
    });
    const src = bodies.find((b) => b.name === "audioin");
    expect(src?.type).toBe("audiofileinCHOP");
    expect(src?.parameters).toMatchObject({ file: "/out/bed.wav", play: 1 });
    // No microphone/device source was created.
    expect(bodies.some((b) => b.type === "audiodeviceinCHOP")).toBe(false);
  });

  it("passes visual_style and frequency_bands through to the reactive build", async () => {
    captureGenerate(OK_RESULT);
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await generateMusicReactiveImpl(makeCtx(makeClient()), {
      prompt: "ambient",
      visual_style: "geometric",
      frequency_bands: 512,
    });
    const spectrum = bodies.find((b) => b.name === "spectrum" && b.type === "audiospectrumCHOP");
    expect(spectrum?.parameters).toMatchObject({ outlength: 512 });
    // The geometric style's radial-bar shader is what got assigned to the frag DAT.
    expect(scripts.some((s) => s.includes("0.159155"))).toBe(true);
  });

  it("reuses the client default injection (infer_step 27, guidance_scale 15) when omitted", async () => {
    const { bodies } = captureGenerate(OK_RESULT);
    await generateMusicReactiveImpl(makeCtx(makeClient()), {
      prompt: "orchestral",
      visual_style: "glsl",
    });
    expect(bodies).toHaveLength(1);
    const body = bodies[0] ?? {};
    expect(body.infer_step).toBe(27);
    expect(body.guidance_scale).toBe(15);
    expect(body.save_path).toBe(OUTPUT_DIR);
  });

  it("disabled gate: aceClient undefined -> friendly error, no TD build attempted", async () => {
    // No ACE handler and no TD-node override; onUnhandledRequest:"error" would fail
    // the test if either network was touched. The disabled guard short-circuits first.
    const result = await generateMusicReactiveImpl(makeCtx(undefined), {
      prompt: "anything",
      visual_style: "glsl",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_ACE_ENABLED=1");
  });

  it("generation failure (ACE unreachable) -> friendly error, no reactive build attempted", async () => {
    server.use(http.post(`${ACE_BASE}/jobs`, () => HttpResponse.error()));
    // Any TD node-create means the build was wrongly attempted → fail loudly.
    let tdTouched = false;
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () => {
        tdTouched = true;
        return HttpResponse.json({ ok: true, data: { path: "/x", type: "baseCOMP", name: "x" } });
      }),
    );
    const result = await generateMusicReactiveImpl(makeCtx(makeClient()), {
      prompt: "jazz",
      visual_style: "glsl",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cannot reach the ACE-Step wrapper");
    expect(tdTouched).toBe(false);
  });

  it("build failure after generation -> surfaces the reactive error result as-is, no throw", async () => {
    captureGenerate(OK_RESULT);
    // TD bridge rejects node creation → the reactive build returns an isError result.
    server.use(
      http.post(`${TD_BASE}/api/nodes`, () =>
        HttpResponse.json({ ok: false, error: { message: "bridge boom" } }, { status: 500 }),
      ),
    );
    const result = await generateMusicReactiveImpl(makeCtx(makeClient()), {
      prompt: "drone",
      visual_style: "glsl",
    });
    expect(result.isError).toBe(true);
    // It is the reactive build's error, not a generation-facts augmentation.
    expect(
      (result as { structuredContent?: { generation?: unknown } }).structuredContent?.generation,
    ).toBeUndefined();
  });

  it("invalid args: empty prompt -> errorResult, no throw, no network", async () => {
    const result = await generateMusicReactiveImpl(makeCtx(makeClient()), {
      prompt: "",
      visual_style: "glsl",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid arguments");
  });

  it("invalid args: bad visual_style -> errorResult, no throw", async () => {
    const result = await generateMusicReactiveImpl(makeCtx(makeClient()), {
      prompt: "valid",
      visual_style: "not-a-style",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Invalid arguments");
  });
});
