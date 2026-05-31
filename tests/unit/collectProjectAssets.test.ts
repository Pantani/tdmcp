import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  collectProjectAssetsImpl,
  collectProjectAssetsSchema,
  registerCollectProjectAssets,
} from "../../src/tools/layer3/collectProjectAssets.js";
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

/** Pull the base64 payload out of a captured exec script and JSON.parse it. */
function decodePayload(script: string): Record<string, unknown> {
  const match = script.match(/b64decode\("([^"]+)"\)/);
  if (!match?.[1]) throw new Error(`No base64 payload in script: ${script.slice(0, 120)}`);
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as Record<string, unknown>;
}

/**
 * Override /api/exec to capture the script that was sent and return a canned
 * stdout (wrapped in the bridge `{ok, data}` envelope) whose last line is the
 * JSON report.
 */
function captureExec(report: unknown): { scripts: string[] } {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(report) },
      });
    }),
  );
  return { scripts };
}

const TWO_ASSETS_REPORT = {
  parent: "/project1",
  assets: [
    {
      node: "/project1/moviein1",
      par: "file",
      value: "/media/clip.mov",
      exists: true,
      kind: "style:File",
    },
    {
      node: "/project1/text1",
      par: "fontfile",
      value: "/fonts/missing.ttf",
      exists: false,
      kind: "name:fontfile",
    },
  ],
  count: 2,
  missing_count: 1,
  warnings: [],
  style_supported: true,
};

describe("collect_project_assets", () => {
  it("schema defaults the optional fields", () => {
    const parsed = collectProjectAssetsSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.out_manifest).toBe("");
    expect(parsed.include_missing_only).toBe(false);
  });

  it("sends the parent path + include_missing_only in the payload", async () => {
    const cap = captureExec(TWO_ASSETS_REPORT);
    const ctx = makeCtx();

    await collectProjectAssetsImpl(ctx, {
      parent_path: "/project1/scene",
      out_manifest: "",
      include_missing_only: false,
    });

    expect(cap.scripts).toHaveLength(1);
    const payload = decodePayload(cap.scripts[0] ?? "");
    expect(payload.parent_path).toBe("/project1/scene");
    expect(payload.include_missing_only).toBe(false);
  });

  it("returns structured assets, count, and a friendly summary", async () => {
    captureExec(TWO_ASSETS_REPORT);
    const ctx = makeCtx();

    const result = await collectProjectAssetsImpl(ctx, {
      parent_path: "/project1",
      out_manifest: "",
      include_missing_only: false,
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      assets: Array<{ node: string; par: string; exists: boolean }>;
      count: number;
      missing_count: number;
      style_supported?: boolean;
    };
    expect(structured.count).toBe(2);
    expect(structured.missing_count).toBe(1);
    expect(structured.assets).toHaveLength(2);
    expect(structured.assets[0]?.node).toBe("/project1/moviein1");
    expect(structured.assets[1]?.par).toBe("fontfile");
    expect(structured.style_supported).toBe(true);

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Found 2 external file dependencies");
    expect(text).toContain("1 missing");
  });

  it("passes include_missing_only through (server already filtered to the missing one)", async () => {
    const missingOnly = {
      ...TWO_ASSETS_REPORT,
      assets: [TWO_ASSETS_REPORT.assets[1]],
      count: 1,
      missing_count: 1,
    };
    const cap = captureExec(missingOnly);
    const ctx = makeCtx();

    const result = await collectProjectAssetsImpl(ctx, {
      parent_path: "/project1",
      out_manifest: "",
      include_missing_only: true,
    });

    const payload = decodePayload(cap.scripts[0] ?? "");
    expect(payload.include_missing_only).toBe(true);

    const structured = result.structuredContent as {
      assets: Array<{ exists: boolean }>;
      count: number;
    };
    expect(structured.count).toBe(1);
    expect(structured.assets).toHaveLength(1);
    expect(structured.assets[0]?.exists).toBe(false);
  });

  it("writes the JSON manifest when out_manifest is set", async () => {
    captureExec(TWO_ASSETS_REPORT);
    const ctx = makeCtx();
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-assets-"));
    const manifestPath = join(dir, "assets.json");

    try {
      const result = await collectProjectAssetsImpl(ctx, {
        parent_path: "/project1",
        out_manifest: manifestPath,
        include_missing_only: false,
      });

      expect(result.isError).toBeFalsy();
      expect(existsSync(manifestPath)).toBe(true);
      const written = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        kind: string;
        parent: string;
        count: number;
        assets: unknown[];
      };
      expect(written.kind).toBe("tdmcp-project-assets");
      expect(written.parent).toBe("/project1");
      expect(written.count).toBe(2);
      expect(written.assets).toHaveLength(2);

      const structured = result.structuredContent as { manifest_path?: string };
      expect(structured.manifest_path).toBe(manifestPath);
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(text).toContain(manifestPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the collected inventory when manifest writing fails", async () => {
    captureExec(TWO_ASSETS_REPORT);
    const ctx = makeCtx();
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-assets-"));
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "occupied", "utf8");

    try {
      const result = await collectProjectAssetsImpl(ctx, {
        parent_path: "/project1",
        out_manifest: join(blocker, "assets.json"),
        include_missing_only: false,
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        count: number;
        manifest_path?: string;
        warnings: string[];
      };
      expect(structured.count).toBe(2);
      expect(structured.manifest_path).toBeUndefined();
      expect(structured.warnings.join("\n")).toContain("manifest");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not advertise as read-only because out_manifest writes a local file", () => {
    const calls: Array<{
      name: string;
      options: { annotations?: Record<string, boolean> };
    }> = [];
    const fakeServer = {
      registerTool(name: string, options: { annotations?: Record<string, boolean> }) {
        calls.push({ name, options });
      },
    };

    registerCollectProjectAssets(fakeServer as never, makeCtx());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("collect_project_assets");
    expect(calls[0]?.options.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("returns an isError result (no throw) when the bridge reports fatal", async () => {
    captureExec({
      parent: "/nope",
      assets: [],
      count: 0,
      missing_count: 0,
      warnings: [],
      fatal: "Parent not found: /nope",
    });
    const ctx = makeCtx();

    const result = await collectProjectAssetsImpl(ctx, {
      parent_path: "/nope",
      out_manifest: "",
      include_missing_only: false,
    });

    expect(result.isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("collect_project_assets failed");
    expect(text).toContain("Parent not found");
  });

  it("returns an isError result (no throw) when TouchDesigner is offline", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));
    const ctx = makeCtx();

    let result: Awaited<ReturnType<typeof collectProjectAssetsImpl>> | undefined;
    await expect(
      (async () => {
        result = await collectProjectAssetsImpl(ctx, {
          parent_path: "/project1",
          out_manifest: "",
          include_missing_only: false,
        });
      })(),
    ).resolves.toBeUndefined();

    expect(result?.isError).toBe(true);
  });
});
