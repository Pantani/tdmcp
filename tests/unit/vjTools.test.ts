import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  bindAudioReactiveImpl,
  createDisplacementWarpImpl,
  createLiveSourceImpl,
  createMediaBinImpl,
  createTransitionImpl,
} from "../../src/tools/layer1/vjTools.js";
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

describe("post-0.5.0 VJ tools", () => {
  it("create_transition builds a GLSL wipe with a bindable progress uniform", async () => {
    const bodies = captureCreateBodies();
    const result = await createTransitionImpl(makeCtx(), {
      mode: "wipe",
      progress: 0.25,
      expose_controls: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.name === "transition" && b.type === "glslTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
    expect(textOf(result)).toContain("wipe transition");
  });

  it("create_live_source creates NDI/Syphon/camera source wrappers behind a stable out1", async () => {
    const bodies = captureCreateBodies();
    const result = await createLiveSourceImpl(makeCtx(), {
      kind: "ndi",
      name: "Main",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.find((b) => b.name === "source")?.type).toBe("ndiinTOP");
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);
  });

  it("create_media_bin stores a clip table and switches multi-clip bins", async () => {
    const bodies = captureCreateBodies();
    const result = await createMediaBinImpl(makeCtx(), {
      files: ["/clips/a.mov", "/clips/b.mov"],
      expose_controls: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.filter((b) => b.type === "moviefileinTOP")).toHaveLength(2);
    expect(bodies.find((b) => b.name === "switch")?.type).toBe("switchTOP");
    expect(bodies.find((b) => b.name === "media_list")?.type).toBe("tableDAT");
  });

  it("create_displacement_warp uses Select TOPs for external source and driver", async () => {
    const bodies = captureCreateBodies();
    const result = await createDisplacementWarpImpl(makeCtx(), {
      source: "/a/out1",
      displacement: "/b/out1",
      amount: 0.4,
      expose_controls: false,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.filter((b) => b.type === "selectTOP")).toHaveLength(2);
    expect(bodies.find((b) => b.name === "warp")?.type).toBe("displaceTOP");
  });

  it("bind_audio_reactive reuses an existing features CHOP and delegates expression binding", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              bound: ["/project1/noise1.period"],
              expression: "op('/features')['bass']",
              warnings: [],
            }),
          },
        }),
      ),
    );
    const result = await bindAudioReactiveImpl(makeCtx(), {
      targets: ["/project1/noise1.period"],
      features_chop: "/features",
      source: "oscillator",
      channel: "bass",
      scale: 2,
      offset: 0,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("audio bass");
    expect(textOf(result)).toContain("/features");
  });
});
