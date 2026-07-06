import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  bundleDependenciesImpl,
  bundleDependenciesSchema,
  registerBundleDependencies,
} from "../../src/tools/layer3/bundleDependencies.js";
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

/**
 * Queue of canned stdout reports; each /api/exec call pops the next one. bundle_dependencies
 * makes up to three exec calls in order: collect scan → rewrite → save.
 */
function queueExec(reports: unknown[]): { scripts: string[] } {
  const scripts: string[] = [];
  let i = 0;
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      const report = reports[Math.min(i, reports.length - 1)];
      i += 1;
      return HttpResponse.json({ ok: true, data: { result: null, stdout: JSON.stringify(report) } });
    }),
  );
  return { scripts };
}

describe("bundle_dependencies", () => {
  it("schema defaults rewrite_refs=true and include_missing=false", () => {
    const parsed = bundleDependenciesSchema.parse({ comp_path: "/project1", out_dir: "/out" });
    expect(parsed.rewrite_refs).toBe(true);
    expect(parsed.include_missing).toBe(false);
  });

  it("copies existing assets, rewrites refs, saves the .tox, and writes a manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-bundle-"));
    const srcClip = join(dir, "clip.mov");
    const srcFont = join(dir, "font.ttf");
    writeFileSync(srcClip, "MOVIE", "utf8");
    writeFileSync(srcFont, "FONT", "utf8");
    const outDir = join(dir, "pkg");

    const collect = {
      parent: "/project1/scene",
      assets: [
        { node: "/project1/scene/moviein1", par: "file", value: srcClip, exists: true, kind: "style:File" },
        { node: "/project1/scene/text1", par: "fontfile", value: srcFont, exists: true, kind: "name:fontfile" },
      ],
      count: 2,
      missing_count: 0,
      warnings: [],
      style_supported: true,
    };
    const rewrite = {
      results: [
        { node: "/project1/scene/moviein1", par: "file", ok: true },
        { node: "/project1/scene/text1", par: "fontfile", ok: true },
      ],
    };
    const save = { saved: join(outDir, "scene.tox"), size: 4096 };
    const cap = queueExec([collect, rewrite, save]);

    try {
      const result = await bundleDependenciesImpl(makeCtx(), {
        comp_path: "/project1/scene",
        out_dir: outDir,
        rewrite_refs: true,
        include_missing: false,
      });

      expect(result.isError).toBeFalsy();
      // three exec calls: scan, rewrite, save
      expect(cap.scripts).toHaveLength(3);

      const structured = result.structuredContent as {
        copied_count: number;
        assets_copied: Array<{ relative: string; rewritten: boolean }>;
        tox_bytes: number | null;
        manifest_path: string;
      };
      expect(structured.copied_count).toBe(2);
      expect(structured.assets_copied.every((a) => a.rewritten)).toBe(true);
      expect(structured.assets_copied[0]?.relative).toBe("assets/clip.mov");
      expect(structured.tox_bytes).toBe(4096);

      // Assets were actually copied into <out>/assets/.
      expect(existsSync(join(outDir, "assets", "clip.mov"))).toBe(true);
      expect(existsSync(join(outDir, "assets", "font.ttf"))).toBe(true);
      const manifest = JSON.parse(readFileSync(structured.manifest_path, "utf8")) as {
        assets: string[];
        type: string;
      };
      expect(manifest.type).toBe("touchdesigner-component");
      expect(manifest.assets).toContain("assets/clip.mov");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips the rewrite exec call when rewrite_refs=false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-bundle-"));
    const srcClip = join(dir, "clip.mov");
    writeFileSync(srcClip, "MOVIE", "utf8");
    const outDir = join(dir, "pkg");

    const collect = {
      parent: "/project1",
      assets: [{ node: "/project1/moviein1", par: "file", value: srcClip, exists: true }],
      count: 1,
      missing_count: 0,
      warnings: [],
    };
    const save = { saved: join(outDir, "project1.tox"), size: 10 };
    const cap = queueExec([collect, save]);

    try {
      const result = await bundleDependenciesImpl(makeCtx(), {
        comp_path: "/project1",
        out_dir: outDir,
        rewrite_refs: false,
        include_missing: false,
      });
      expect(result.isError).toBeFalsy();
      // Only scan + save — no rewrite call.
      expect(cap.scripts).toHaveLength(2);
      const structured = result.structuredContent as {
        assets_copied: Array<{ rewritten: boolean }>;
      };
      expect(structured.assets_copied[0]?.rewritten).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a missing source as skipped and does not copy it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-bundle-"));
    const outDir = join(dir, "pkg");
    const collect = {
      parent: "/project1",
      assets: [
        { node: "/project1/text1", par: "fontfile", value: "/nope/missing.ttf", exists: false },
      ],
      count: 1,
      missing_count: 1,
      warnings: [],
    };
    const save = { saved: join(outDir, "project1.tox"), size: 10 };
    queueExec([collect, save]);

    try {
      const result = await bundleDependenciesImpl(makeCtx(), {
        comp_path: "/project1",
        out_dir: outDir,
        rewrite_refs: true,
        include_missing: false,
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        copied_count: number;
        skipped: Array<{ reason: string }>;
      };
      expect(structured.copied_count).toBe(0);
      expect(structured.skipped).toHaveLength(1);
      expect(structured.skipped[0]?.reason).toContain("missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an isError result (no throw) when the scan reports fatal", async () => {
    queueExec([{ parent: "/nope", assets: [], count: 0, missing_count: 0, warnings: [], fatal: "COMP not found: /nope" }]);
    const result = await bundleDependenciesImpl(makeCtx(), {
      comp_path: "/nope",
      out_dir: "/tmp/pkg",
      rewrite_refs: true,
      include_missing: false,
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("bundle_dependencies failed");
  });

  it("is registered as destructive (writes files + mutates the network)", () => {
    const calls: Array<{ name: string; options: { annotations?: Record<string, boolean> } }> = [];
    const fakeServer = {
      registerTool(name: string, options: { annotations?: Record<string, boolean> }) {
        calls.push({ name, options });
      },
    };
    registerBundleDependencies(fakeServer as never, makeCtx());
    expect(calls[0]?.name).toBe("bundle_dependencies");
    expect(calls[0]?.options.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
