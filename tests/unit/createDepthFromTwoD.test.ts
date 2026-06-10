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
  createDepthFromTwoDImpl,
  createDepthFromTwoDSchema,
} from "../../src/tools/layer1/createDepthFromTwoD.js";
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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

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

// Round-2 Wave-4 fix: the impl now pre-checks tox candidate paths on disk
// BEFORE the bridge call to avoid TD-hang. Tests that need the bridge to be
// called must point tox_path at a real on-disk .tox fixture.
const TMP_DIR = mkdtempSync(join(tmpdir(), "tdmcp-depth-test-"));
const FIXTURE_TOX = join(TMP_DIR, "TDDepthAnything.tox");
writeFileSync(FIXTURE_TOX, "stub");
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

function run(args: Partial<z.input<typeof createDepthFromTwoDSchema>> = {}) {
  return createDepthFromTwoDImpl(
    makeCtx(),
    createDepthFromTwoDSchema.parse({
      source_top_path: "/project1/cam1",
      tox_path: FIXTURE_TOX,
      ...args,
    }),
  );
}

describe("create_depth_from_2d", () => {
  it("drop success — returns depth_top_path and summary hint", async () => {
    const successReport = {
      container_path: "/project1/depth_from_2d",
      found_path: "/project1/depth_from_2d/TDDepthAnything",
      depth_out_path: "/project1/depth_from_2d/depth_out",
      validated_pars: ["Inputtop", "Outputresolution", "Modelvariant"],
      missing_pars: [],
      warnings: [],
    };

    server.use(
      http.post(`${TD_BASE}/api/exec`, async () =>
        HttpResponse.json({
          ok: true,
          data: { result: null, stdout: JSON.stringify(successReport) },
        }),
      ),
    );

    const result = await run({ source_top_path: "/project1/cam1" });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/depth_from_2d/depth_out");
    expect(text).toContain(
      "Feed this depth_top_path into create_depth_displacement / create_depth_pop_field / create_depth_silhouette",
    );

    // Structured envelope check
    const jsonMatch = /```json\n([\s\S]+?)\n```/.exec(text);
    expect(jsonMatch).not.toBeNull();
    const envelope = JSON.parse(jsonMatch?.[1] ?? "{}") as Record<string, unknown>;
    expect(envelope.depth_top_path).toBe("/project1/depth_from_2d/depth_out");
    expect(envelope.container_path).toBe("/project1/depth_from_2d");
    expect(envelope.source_top_path).toBe("/project1/cam1");
    expect(envelope.output_resolution).toBe(512);
    expect(envelope.model_variant).toBe("small");
  });

  it("tox missing → friendly error listing candidate paths (TS-side pre-check, no bridge call)", async () => {
    // Round-2 Wave-4 fix: when every candidate is absolute and none exist on
    // disk, the impl returns a friendly error WITHOUT calling executePythonScript.
    let execCalled = false;
    server.use(
      http.post(`${TD_BASE}/api/exec`, async () => {
        execCalled = true;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const missingPath = join(TMP_DIR, "does-not-exist", "TDDepthAnything.tox");
    const result = await createDepthFromTwoDImpl(
      makeCtx(),
      createDepthFromTwoDSchema.parse({
        source_top_path: "/project1/cam1",
        tox_path: missingPath,
      }),
    );

    expect(execCalled).toBe(false);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("Install TDDepthAnything");
    expect(text).toContain("https://github.com/IntentDev/TDDepthAnything");
    expect(text).toContain(missingPath);
  });

  it("source_top_path empty → Zod rejects", () => {
    expect(() => createDepthFromTwoDSchema.parse({ source_top_path: "" })).toThrow();
  });

  it("custom resolution + model_variant → script body contains values and envelope echoes them", async () => {
    const scripts = captureExecScripts();

    // Override exec after captureExecScripts so we can intercept AND return a result
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        scripts.push(body.script);
        const report = {
          container_path: "/project1/depth_from_2d",
          found_path: "/project1/depth_from_2d/TDDepthAnything",
          depth_out_path: "/project1/depth_from_2d/depth_out",
          validated_pars: ["Inputtop", "Outputresolution", "Modelvariant"],
          missing_pars: [],
          warnings: [],
        };
        return HttpResponse.json({
          ok: true,
          data: { result: null, stdout: JSON.stringify(report) },
        });
      }),
    );

    const result = await run({
      source_top_path: "/project1/video1",
      output_resolution: "1024",
      model_variant: "large",
    });

    expect(result.isError).toBeFalsy();

    // Script body must include the resolution and variant values.
    // After the refactor, payload travels base64-encoded — decode it before asserting.
    const script = scripts.find((s) => s.includes("OUTPUT_RESOLUTION")) ?? "";
    const b64Match = /"([A-Za-z0-9+/=]{20,})"/.exec(script);
    const decoded = b64Match ? Buffer.from(b64Match[1] ?? "", "base64").toString("utf8") : "";
    expect(decoded).toContain("1024");
    expect(decoded).toContain("large");

    // Result envelope echoes the values
    const text = textOf(result);
    const jsonMatch = /```json\n([\s\S]+?)\n```/.exec(text);
    const envelope = JSON.parse(jsonMatch?.[1] ?? "{}") as Record<string, unknown>;
    expect(envelope.output_resolution).toBe(1024);
    expect(envelope.model_variant).toBe("large");
  });

  it("missing pars warn — succeeds but surfaces missing_pars in warnings", async () => {
    const reportWithMissing = {
      container_path: "/project1/depth_from_2d",
      found_path: "/project1/depth_from_2d/TDDepthAnything",
      depth_out_path: "/project1/depth_from_2d/depth_out",
      validated_pars: ["Inputtop"],
      missing_pars: ["Outputresolution", "Modelvariant"],
      warnings: ["Container 'TDDepthAnything' already existed; reusing."],
    };

    server.use(
      http.post(`${TD_BASE}/api/exec`, async () =>
        HttpResponse.json({
          ok: true,
          data: { result: null, stdout: JSON.stringify(reportWithMissing) },
        }),
      ),
    );

    const result = await run({ source_top_path: "/project1/cam1" });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);

    // Both missing pars surfaced as warnings
    expect(text).toContain("Outputresolution");
    expect(text).toContain("Modelvariant");
    // Reuse note surfaces
    expect(text).toContain("already existed");

    // Envelope warnings array contains all three entries
    const jsonMatch = /```json\n([\s\S]+?)\n```/.exec(text);
    const envelope = JSON.parse(jsonMatch?.[1] ?? "{}") as Record<string, unknown>;
    const warnings = envelope.warnings as string[];
    expect(warnings.some((w) => w.includes("Outputresolution"))).toBe(true);
    expect(warnings.some((w) => w.includes("Modelvariant"))).toBe(true);
    expect(warnings.some((w) => w.includes("already existed"))).toBe(true);
  });
});
