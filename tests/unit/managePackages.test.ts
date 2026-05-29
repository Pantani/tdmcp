import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { managePackagesImpl, managePackagesSchema } from "../../src/tools/layer3/managePackages.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tdmcp-manage-packages-test-"));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 10,
      fetchImpl: vi.fn(async () => {
        throw new Error("TD should not be called by dry-run package tests.");
      }) as unknown as typeof fetch,
    }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function textOf(result: Awaited<ReturnType<typeof managePackagesImpl>>): string {
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

describe("manage_packages MCP tool", () => {
  it("searches package manifests through structured content", async () => {
    const result = await managePackagesImpl(
      makeCtx(),
      managePackagesSchema.parse({
        action: "search",
        query: "shader",
      }),
    );
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("package search");
    expect(result.structuredContent?.packages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "shader-park-td" })]),
    );
  });

  it("dry-runs an install without contacting TouchDesigner", async () => {
    const root = tempRoot();
    try {
      const result = await managePackagesImpl(
        makeCtx(),
        managePackagesSchema.parse({
          action: "install",
          package_id: "raytk",
          dry_run: true,
          packages_root: root,
        }),
      );
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.report).toMatchObject({
        dryRun: true,
        status: "planned",
        package: { id: "raytk" },
      });
    } finally {
      cleanup(root);
    }
  });

  it("surfaces doctor-only packages without throwing", async () => {
    const result = await managePackagesImpl(
      makeCtx(),
      managePackagesSchema.parse({
        action: "doctor",
        package_id: "comfyui-td",
      }),
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.report).toMatchObject({
      status: "manual",
      package: { id: "comfyui-td" },
    });
  });
});
