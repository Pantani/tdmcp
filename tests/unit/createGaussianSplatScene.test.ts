import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createGaussianSplatSceneImpl,
  createGaussianSplatSceneSchema,
} from "../../src/tools/layer1/createGaussianSplatScene.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

// Round-3 Wave-4 fix: all default candidate paths are now absolute-only.
// Success tests must supply an on-disk tox_path fixture so the TS precheck
// does not short-circuit before the bridge call.
const TMP_DIR = mkdtempSync(join(tmpdir(), "tdmcp-gs-test-"));
const FIXTURE_TOX = join(TMP_DIR, "TDGS.tox");
writeFileSync(FIXTURE_TOX, "stub");

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

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

/** Sets up exec mock: dropExternalTox returns success, configure returns the given report. */
function mockExecHappyPath(
  dropFoundPath: string,
  configureReport: Record<string, unknown>,
): Array<{ script: string; stdout: string }> {
  const calls: Array<{ script: string; stdout: string }> = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      const script = body.script;

      let stdout = "";
      if (script.includes("CANDIDATES") && script.includes("loadTox")) {
        // dropExternalTox
        const report = {
          found_path: dropFoundPath,
          container_name: "TDGS",
          container_path: "/project1/gaussian_splat_scene/TDGS",
          validated_pars: ["Plyfile"],
          missing_pars: ["Splatfile", "File", "Camera", "Cam"],
          warnings: [],
        };
        stdout = JSON.stringify(report);
      } else if (script.includes("SPLAT_ASSET_PATH") && script.includes("CONTAINER_PATH")) {
        // configure payload
        stdout = JSON.stringify(configureReport);
      }
      // layout, panel, etc. → empty stdout is fine

      calls.push({ script, stdout });
      return HttpResponse.json({ ok: true, data: { result: null, stdout } });
    }),
  );
  return calls;
}

// Default tox_path to fixture so the TS precheck does not short-circuit.
// Success tests rely on this; missing-tox tests must pass a non-existent path explicitly.
function run(args: Partial<z.input<typeof createGaussianSplatSceneSchema>> = {}) {
  return createGaussianSplatSceneImpl(
    makeCtx(),
    createGaussianSplatSceneSchema.parse({
      splat_asset_path: "/scans/room.ply",
      tox_path: FIXTURE_TOX,
      ...args,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("create_gaussian_splat_scene", () => {
  // Case 1: drop success at candidate 1 (~/Documents/Derivative/COMP/TDGS.tox),
  // asset .ply set, no camera, output_top ends /out1, no warnings.
  it("1 — drop success (1080p): creates selectTOP+fitTOP+nullTOP, returns output_top_path ending /out1", async () => {
    const bodies = captureCreateBodies();
    mockExecHappyPath("/Users/user/Documents/Derivative/COMP/TDGS.tox", {
      asset_par_name: "Plyfile",
      inner_out_path: "/project1/gaussian_splat_scene/TDGS/out1",
      warnings: [],
    });

    const result = await run();

    expect(result.isError).toBeFalsy();
    expect(bodies.some((b) => b.name === "splat_out" && b.type === "selectTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "scale" && b.type === "fitTOP")).toBe(true);
    expect(bodies.some((b) => b.name === "out1" && b.type === "nullTOP")).toBe(true);

    const txt = textOf(result);
    expect(txt).toContain("/out1");
    expect(txt).toContain("TDGS.tox");
  });

  // Case 2: TS-side Zod validation — wrong extension rejected before bridge call.
  it("2 — asset path validation (TS-side): .obj extension → Zod parse error, no bridge call", () => {
    expect(() => createGaussianSplatSceneSchema.parse({ splat_asset_path: "scene.obj" })).toThrow(
      /must end in \.ply or \.splat/,
    );
  });

  // Case 3: TDGS not found — dropExternalTox returns no_candidate_found → friendly error
  // mentioning candidate paths and install hint.
  it("3 — TDGS missing: errorResult mentions Anglerfish-graphics install hint", async () => {
    captureCreateBodies();
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        const script = body.script;
        let stdout = "";
        if (script.includes("CANDIDATES") && script.includes("loadTox")) {
          stdout = JSON.stringify({
            error: "no_candidate_found",
            candidates_checked: ["/Users/user/Documents/Derivative/COMP/TDGS.tox"],
            warnings: [],
          });
        }
        return HttpResponse.json({ ok: true, data: { result: null, stdout } });
      }),
    );

    const result = await run();

    expect(result.isError).toBe(true);
    const txt = textOf(result);
    expect(txt).toMatch(/Anglerfish/i);
    expect(txt).toMatch(/TDGS/);
  });

  // Case 4: Custom camera binding — camera_path provided → report includes camera_par_name.
  it("4 — custom camera binding: result echoes camera_path, 0 camera warnings", async () => {
    captureCreateBodies();
    mockExecHappyPath("/Users/user/Documents/Derivative/COMP/TDGS.tox", {
      asset_par_name: "Plyfile",
      camera_par_name: "Camera",
      inner_out_path: "/project1/gaussian_splat_scene/TDGS/out1",
      warnings: [],
    });

    const result = await run({ camera_path: "/project1/cam1" });

    expect(result.isError).toBeFalsy();
    const txt = textOf(result);
    expect(txt).toContain("/project1/cam1");
    // No camera-not-found warning in the output text
    expect(txt).not.toContain("camera_path not found");
  });

  // Case 5: output_res "2160p" → fitTOP gets resolutionw=3840, resolutionh=2160.
  it("5 — output_res 2160p: fitTOP parameters set to 3840×2160", async () => {
    const bodies = captureCreateBodies();
    mockExecHappyPath("/Users/user/Documents/Derivative/COMP/TDGS.tox", {
      asset_par_name: "Plyfile",
      inner_out_path: "/project1/gaussian_splat_scene/TDGS/out1",
      warnings: [],
    });

    const result = await run({ output_res: "2160p" });

    expect(result.isError).toBeFalsy();
    const scaleTOP = bodies.find((b) => b.name === "scale" && b.type === "fitTOP");
    expect(scaleTOP).toBeDefined();
    expect(scaleTOP?.parameters).toMatchObject({ resolutionw: 3840, resolutionh: 2160 });
  });
});
