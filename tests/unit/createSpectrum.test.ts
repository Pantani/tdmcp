import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createSpectrumImpl } from "../../src/tools/layer1/createSpectrum.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

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

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// Records every POST /api/nodes body so a test can assert which ops/params a build asked for.
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

describe("create_spectrum", () => {
  it("builds an FFT spectrum chain ending in a Null bind point with named band channels", async () => {
    const result = await createSpectrumImpl(makeCtx(), {
      source: "device",
      bands: 16,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/spectrum");
    // The stable bind point is the Null named "spectrum" inside the "spectrum" container.
    expect(text).toContain("/project1/spectrum/spectrum");
    expect(text).toContain("band0");
    expect(text).toContain("band15");
  });

  it("produces no preview image (the output is a CHOP, not a TOP)", async () => {
    const result = await createSpectrumImpl(makeCtx(), {
      source: "device",
      bands: 16,
      expose_controls: false,
      parent_path: "/project1",
    });
    const hasImage = result.content.some((c) => c.type === "image");
    expect(hasImage).toBe(false);
  });

  it("creates an audiospectrumCHOP for the FFT (not the non-createable spectrumCHOP)", async () => {
    const bodies = captureCreateBodies();
    await createSpectrumImpl(makeCtx(), {
      source: "device",
      bands: 16,
      expose_controls: false,
      parent_path: "/project1",
    });
    const fft = bodies.find((b) => b.type === "audiospectrumCHOP");
    expect(fft).toBeDefined();
    // "matchtofrequency" would emit ~22050 samples; "setmanually" bounds the FFT length.
    expect(fft?.parameters).toMatchObject({ outputmenu: "setmanually" });
    // No node should ever be a (non-createable) spectrumCHOP.
    expect(bodies.some((b) => b.type === "spectrumCHOP")).toBe(false);
  });

  it("transposes to channels and renames them with a positional band pattern", async () => {
    const bodies = captureCreateBodies();
    await createSpectrumImpl(makeCtx(), {
      source: "device",
      bands: 32,
      expose_controls: false,
      parent_path: "/project1",
    });
    // Shuffle transposes the single spectrum channel's samples into one channel each.
    const split = bodies.find((b) => b.type === "shuffleCHOP");
    expect(split?.parameters).toMatchObject({ method: "seqtochan" });
    // Rename expands `band[0-31]` across the 32 transposed channels → band0..band31.
    const rename = bodies.find((b) => b.type === "renameCHOP");
    expect(rename?.parameters).toMatchObject({ renamefrom: "*", renameto: "band[0-31]" });
  });

  it("resamples the FFT down to exactly `bands` samples before transposing", async () => {
    const bodies = captureCreateBodies();
    await createSpectrumImpl(makeCtx(), {
      source: "device",
      bands: 16,
      expose_controls: false,
      parent_path: "/project1",
    });
    const rebin = bodies.find((b) => b.type === "resampleCHOP");
    // A fixed sample interval [0, bands-1] in sample units yields exactly `bands` samples.
    expect(rebin?.parameters).toMatchObject({
      start: 0,
      end: 15,
      startunit: "samples",
      endunit: "samples",
    });
  });

  it("uses a white-noise oscillator for the device-free testing source", async () => {
    const bodies = captureCreateBodies();
    await createSpectrumImpl(makeCtx(), {
      source: "oscillator",
      bands: 16,
      expose_controls: false,
      parent_path: "/project1",
    });
    const osc = bodies.find((b) => b.type === "audiooscillatorCHOP");
    expect(osc?.parameters).toMatchObject({ wavetype: "whitenoise" });
    // The device input must NOT be created when an oscillator source is requested.
    expect(bodies.some((b) => b.type === "audiodeviceinCHOP")).toBe(false);
  });

  it("reuses an existing CHOP without creating any audio input node", async () => {
    const bodies = captureCreateBodies();
    const result = await createSpectrumImpl(makeCtx(), {
      source: "existing_chop",
      existing_chop_path: "/project1/my_audio",
      bands: 16,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.type === "audiodeviceinCHOP")).toBe(false);
    expect(bodies.some((b) => b.type === "audiofileinCHOP")).toBe(false);
    expect(bodies.some((b) => b.type === "audiooscillatorCHOP")).toBe(false);
    // The FFT still gets built; it just reads from the supplied CHOP.
    expect(bodies.some((b) => b.type === "audiospectrumCHOP")).toBe(true);
  });

  it("exposes a Sensitivity knob bound to the math gain when expose_controls is on", async () => {
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await createSpectrumImpl(makeCtx(), {
      source: "device",
      bands: 16,
      expose_controls: true,
      parent_path: "/project1",
    });
    const panel = scripts.find((s) => s.includes("appendCustomPage"));
    expect(panel).toBeDefined();
    const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
    if (b64 === undefined) throw new Error("panel script did not embed a base64 payload");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; bind_to?: string[] }>;
    };
    const sens = payload.controls.find((c) => c.name === "Sensitivity");
    expect(sens?.bind_to?.[0]).toMatch(/sensitivity\.gain$/);
  });
});
