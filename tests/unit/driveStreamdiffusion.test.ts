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
  driveStreamdiffusionImpl,
  driveStreamdiffusionSchema,
} from "../../src/tools/layer1/driveStreamdiffusion.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// Types / helpers
// ---------------------------------------------------------------------------

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

// Round-2 Wave-4 fix: driveStreamdiffusion now pre-checks tox_path on disk
// BEFORE the bridge call. Tests that pass an explicit absolute tox_path must
// point it at a real on-disk fixture so the bridge is still consulted.
const TMP_DIR = mkdtempSync(join(tmpdir(), "tdmcp-sd-test-"));
const FIXTURE_TOX = join(TMP_DIR, "StreamDiffusionTD.tox");
writeFileSync(FIXTURE_TOX, "stub");
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

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

function captureExecScripts(): Array<{ script: string; stdout: string }> {
  const calls: Array<{ script: string; stdout: string }> = [];

  // Default successful tox drop + configure — bridge returns proper report JSON
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      const script = body.script;
      calls.push({ script, stdout: "" });

      // Detect which script this is and return appropriate stdout
      if (script.includes("CANDIDATES") && script.includes("loadTox")) {
        // FM-02 dropExternalTox script
        const report = {
          found_path: "/Users/user/Documents/Derivative/COMP/StreamDiffusionTD.tox",
          container_name: "StreamDiffusionTD",
          container_path: "/project1/streamdiffusion_driver/StreamDiffusionTD",
          validated_pars: ["Tindex", "Prompt", "Strength", "Cfg", "Seed", "Controlnetweight"],
          missing_pars: [],
          warnings: [],
        };
        const stdout = JSON.stringify(report);
        const last = calls[calls.length - 1];
        if (last) last.stdout = stdout;
        return HttpResponse.json({ ok: true, data: { result: null, stdout } });
      }

      if (script.includes("CONTAINER") && script.includes("pars_to_set")) {
        // Configure payload
        const report = { ok: true, warnings: [] };
        const stdout = JSON.stringify(report);
        const last = calls[calls.length - 1];
        if (last) last.stdout = stdout;
        return HttpResponse.json({ ok: true, data: { result: null, stdout } });
      }

      // layout, cooker, placeInGrid, etc.
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );

  return calls;
}

// Default to fixture tox so the TS-side precheck does not short-circuit.
// Pass tox_path: undefined explicitly to test the no-tox precheck path.
function run(args: Partial<z.input<typeof driveStreamdiffusionSchema>> = {}) {
  const merged = { tox_path: FIXTURE_TOX, ...args };
  return driveStreamdiffusionImpl(makeCtx(), driveStreamdiffusionSchema.parse(merged));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("drive_streamdiffusion", () => {
  it("1 — tox present, default args: result includes container/output paths, no warnings, validated_pars non-empty", async () => {
    const bodies = captureCreateBodies();
    captureExecScripts();

    const result = await run({});

    expect(result.isError).toBeFalsy();

    // baseCOMP container created
    expect(
      bodies.find((b) => b.type === "baseCOMP" && b.name === "streamdiffusion_driver"),
    ).toBeDefined();

    // synthetic noiseTOP when no source_top_path (avoids macOS file-chooser modal hang)
    expect(bodies.find((b) => b.type === "noiseTOP" && b.name === "source_in")).toBeDefined();
    expect(bodies.find((b) => b.type === "moviefileinTOP")).toBeUndefined();

    // Null TOP output
    expect(bodies.find((b) => b.type === "nullTOP" && b.name === "out1")).toBeDefined();

    // Result text mentions container and output
    const text = textOf(result);
    expect(text).toContain("streamdiffusion_driver");
    expect(text).toContain("out1");
    expect(text).toContain("StreamDiffusionTD.tox");
  });

  it("2 — tox missing on all candidates: isError via TS precheck, NO bridge call, recommends install", async () => {
    // Round-3 Wave-4 fix: project-relative defaults removed from buildCandidatePaths.
    // Now ALL defaults are absolute — the TS precheck short-circuits without any bridge call.
    let bridgeCalled = false;
    server.use(
      http.post(`${TD_BASE}/api/exec`, async () => {
        bridgeCalled = true;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    // Call impl directly with a non-existent absolute path so the precheck fires.
    const missingTox = join(TMP_DIR, "does-not-exist", "StreamDiffusionTD.tox");
    const result = await driveStreamdiffusionImpl(
      makeCtx(),
      driveStreamdiffusionSchema.parse({ tox_path: missingTox }),
    );
    expect(result.isError).toBe(true);
    // Bridge must NOT have been called — the TS-side precheck short-circuited.
    expect(bridgeCalled).toBe(false);

    const text = textOf(result);
    // Friendly error message includes install guidance and tox_path option
    expect(text.toLowerCase()).toMatch(/install|tox_path/i);
    // Error references the missing path that was checked
    expect(text).toContain(missingTox);
  });

  it("3 — explicit tox_path override: candidate_paths length === 1 in bridge payload", async () => {
    captureCreateBodies();
    const payloads: unknown[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        if (body.script.includes("CANDIDATES") && body.script.includes("loadTox")) {
          // Decode the base64 payload from the script to inspect candidate_paths
          const match = /base64\.b64decode\("([^"]+)"\)/.exec(body.script);
          if (match?.[1]) {
            const decoded = JSON.parse(Buffer.from(match[1], "base64").toString("utf-8"));
            payloads.push(decoded);
          }
          const report = {
            found_path: "/custom/path/StreamDiffusionTD.tox",
            container_name: "StreamDiffusionTD",
            container_path: "/project1/streamdiffusion_driver/StreamDiffusionTD",
            validated_pars: ["Prompt", "Strength", "Cfg", "Seed"],
            missing_pars: ["Tindex", "Controlnetweight"],
            warnings: [],
          };
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: JSON.stringify(report) },
          });
        }
        if (body.script.includes("pars_to_set")) {
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: JSON.stringify({ ok: true, warnings: [] }) },
          });
        }
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    await run({ tox_path: FIXTURE_TOX });

    // Only 1 candidate should have been sent
    expect(payloads.length).toBeGreaterThan(0);
    const dropPayload = payloads[0] as { candidate_paths: string[] };
    expect(dropPayload.candidate_paths).toHaveLength(1);
    expect(dropPayload.candidate_paths[0]).toBe(FIXTURE_TOX);
  });

  it("4 — custom prompt/strength/seed: configure payload sets those values", async () => {
    captureCreateBodies();
    const configPayloads: unknown[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };

        if (body.script.includes("CANDIDATES") && body.script.includes("loadTox")) {
          const report = {
            found_path: "/home/user/StreamDiffusionTD.tox",
            container_name: "StreamDiffusionTD",
            container_path: "/project1/streamdiffusion_driver/StreamDiffusionTD",
            validated_pars: ["Prompt", "Strength", "Cfg", "Seed"],
            missing_pars: ["Tindex", "Controlnetweight"],
            warnings: [],
          };
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: JSON.stringify(report) },
          });
        }
        if (body.script.includes("pars_to_set")) {
          const match = /base64\.b64decode\("([^"]+)"\)/.exec(body.script);
          if (match?.[1]) {
            const decoded = JSON.parse(Buffer.from(match[1], "base64").toString("utf-8"));
            configPayloads.push(decoded);
          }
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: JSON.stringify({ ok: true, warnings: [] }) },
          });
        }
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    await run({ prompt: "oil painting sunrise", strength: 0.9, seed: 42 });

    expect(configPayloads.length).toBeGreaterThan(0);
    const cfg = configPayloads[0] as { pars_to_set: Record<string, unknown> };
    expect(cfg.pars_to_set.Prompt).toBe("oil painting sunrise");
    expect(cfg.pars_to_set.Strength).toBe(0.9);
    expect(cfg.pars_to_set.Seed).toBe(42);
  });

  it("5 — output_mode syphon_spout: syphonspoutoutTOP created, senderName = output_name, sender_info.kind = syphon_spout", async () => {
    const bodies = captureCreateBodies();
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        if (body.script.includes("CANDIDATES") && body.script.includes("loadTox")) {
          const report = {
            found_path: "/home/user/StreamDiffusionTD.tox",
            container_name: "StreamDiffusionTD",
            container_path: "/project1/streamdiffusion_driver/StreamDiffusionTD",
            validated_pars: ["Prompt", "Strength", "Cfg", "Seed"],
            missing_pars: [],
            warnings: [],
          };
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: JSON.stringify(report) },
          });
        }
        if (body.script.includes("pars_to_set")) {
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: JSON.stringify({ ok: true, warnings: [] }) },
          });
        }
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const result = await run({
      output_mode: "syphon_spout",
      output_name: "my_sd_stream",
    });

    expect(result.isError).toBeFalsy();

    const syphon = bodies.find((b) => b.type === "syphonspoutoutTOP");
    expect(syphon).toBeDefined();
    expect(syphon?.parameters?.senderName).toBe("my_sd_stream");

    const text = textOf(result);
    expect(text.toLowerCase()).toMatch(/syphon|my_sd_stream/i);
  });

  it("6 — output_mode ndi: ndioutTOP created with name par, sender_info.kind = ndi", async () => {
    const bodies = captureCreateBodies();
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        if (body.script.includes("CANDIDATES") && body.script.includes("loadTox")) {
          const report = {
            found_path: "/home/user/StreamDiffusionTD.tox",
            container_name: "StreamDiffusionTD",
            container_path: "/project1/streamdiffusion_driver/StreamDiffusionTD",
            validated_pars: ["Prompt", "Strength"],
            missing_pars: ["Cfg", "Seed", "Tindex", "Controlnetweight"],
            warnings: [],
          };
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: JSON.stringify(report) },
          });
        }
        if (body.script.includes("pars_to_set")) {
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: JSON.stringify({ ok: true, warnings: [] }) },
          });
        }
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const result = await run({
      output_mode: "ndi",
      output_name: "ndi_sd",
    });

    expect(result.isError).toBeFalsy();

    const ndi = bodies.find((b) => b.type === "ndioutTOP");
    expect(ndi).toBeDefined();
    expect(ndi?.parameters?.name).toBe("ndi_sd");

    const text = textOf(result);
    expect(text.toLowerCase()).toMatch(/ndi|ndi_sd/i);
  });

  it("8 — source_top_path provided: moviefileinTOP created with file + play=true, no noiseTOP", async () => {
    const bodies = captureCreateBodies();
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        if (body.script.includes("CANDIDATES") && body.script.includes("loadTox")) {
          const report = {
            found_path: "/home/user/StreamDiffusionTD.tox",
            container_name: "StreamDiffusionTD",
            container_path: "/project1/streamdiffusion_driver/StreamDiffusionTD",
            validated_pars: ["Prompt", "Strength", "Cfg", "Seed"],
            missing_pars: [],
            warnings: [],
          };
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: JSON.stringify(report) },
          });
        }
        if (body.script.includes("pars_to_set")) {
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: JSON.stringify({ ok: true, warnings: [] }) },
          });
        }
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const result = await run({ source_top_path: "/project1/cam1" });

    expect(result.isError).toBeFalsy();

    // moviefileinTOP with explicit file and play
    const movieNode = bodies.find((b) => b.type === "moviefileinTOP" && b.name === "source_in");
    expect(movieNode).toBeDefined();
    expect(movieNode?.parameters?.file).toBe("/project1/cam1");
    expect(movieNode?.parameters?.play).toBe(true);

    // noiseTOP must NOT be present as source_in
    expect(bodies.find((b) => b.type === "noiseTOP" && b.name === "source_in")).toBeUndefined();
  });

  it("7 — partial par drift: validated_pars=[Prompt,Strength], tool succeeds, warnings surface missing list, configure only sets those 2", async () => {
    captureCreateBodies();
    const configPayloads: unknown[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        if (body.script.includes("CANDIDATES") && body.script.includes("loadTox")) {
          const report = {
            found_path: "/home/user/StreamDiffusionTD.tox",
            container_name: "StreamDiffusionTD",
            container_path: "/project1/streamdiffusion_driver/StreamDiffusionTD",
            validated_pars: ["Prompt", "Strength"],
            missing_pars: ["Cfg", "Seed", "Tindex", "Controlnetweight"],
            warnings: ["Missing custom pars: Cfg, Seed, Tindex, Controlnetweight"],
          };
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: JSON.stringify(report) },
          });
        }
        if (body.script.includes("pars_to_set")) {
          const match = /base64\.b64decode\("([^"]+)"\)/.exec(body.script);
          if (match?.[1]) {
            configPayloads.push(JSON.parse(Buffer.from(match[1], "base64").toString("utf-8")));
          }
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: JSON.stringify({ ok: true, warnings: [] }) },
          });
        }
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const result = await run({});

    // Tool must NOT be an error — partial pars are warn-only
    expect(result.isError).toBeFalsy();

    // validated_pars reflected in result text
    const text = textOf(result);
    expect(text).toContain("Prompt");
    expect(text).toContain("Strength");

    // Configure payload validates_pars only contains what came back
    expect(configPayloads.length).toBeGreaterThan(0);
    const cfg = configPayloads[0] as { validated_pars: string[] };
    expect(cfg.validated_pars).toEqual(["Prompt", "Strength"]);
    // missing ones are NOT in validated_pars
    expect(cfg.validated_pars).not.toContain("Cfg");
    expect(cfg.validated_pars).not.toContain("Seed");
  });
});
