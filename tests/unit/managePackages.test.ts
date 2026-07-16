import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { createPackagePaths } from "../../src/packages/paths.js";
import { readPackageState, writePackageState } from "../../src/packages/state.js";
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

const PLAN_ID = "plan_000000000000000000000001";

function writeInstalled(root: string, stagedPath?: string) {
  const paths = createPackagePaths({ rootDir: root });
  mkdirSync(paths.root, { recursive: true });
  writePackageState(paths, {
    version: 1,
    packages: [
      {
        id: "package-a",
        displayName: "Package A",
        sourceUrl: "https://github.com/example/package-a",
        ref: "v1",
        status: "imported",
        ...(stagedPath ? { stagedPath } : {}),
        artifacts: [],
        bridgeTargetPath: "/project1/tdmcp_packages/package_a",
        warnings: [],
        installedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  return paths;
}

function livePlan(scope: "user" | "project" = "user") {
  return {
    status: "planned" as const,
    plan_id: PLAN_ID,
    expires_at: 1_000,
    package_id: "package-a",
    scope,
    intent: "prune" as const,
    classification: "aligned_owned" as const,
    actionable: true,
    resolved_target_path: "/project1/tdmcp_packages/package_a",
    marker: { matched: true, schema_version: 1 },
    candidates: [
      {
        path: "/project1/tdmcp_packages/package_a",
        marker_status: "match" as const,
        marker_schema_version: 1,
      },
    ],
    warnings: [],
    deduplicated: false,
  };
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

  it("doctor version-gate uses the live TD build number, not the product series", async () => {
    // Regression: getInfo() returns { td_version: "099", build: "2025.32820" }. The version gate
    // must compare the numeric build ("2025.32820"), NOT the "099" series — otherwise a compatible
    // build is falsely reported as predating the 2025.30770 gate.
    const infoCtx: ToolContext = {
      client: new TouchDesignerClient({
        baseUrl: "http://127.0.0.1:1",
        timeoutMs: 50,
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({ ok: true, data: { td_version: "099", build: "2025.32820" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as unknown as typeof fetch,
      }),
      knowledge: new KnowledgeBase(),
      recipes: new RecipeLibrary(),
      logger: silentLogger,
    };
    const result = await managePackagesImpl(
      infoCtx,
      managePackagesSchema.parse({ action: "doctor", package_id: "raytk" }),
    );
    expect(result.isError).toBeUndefined();
    const gate = (
      result.structuredContent?.report as { checks: { id: string; status: string }[] }
    ).checks.find((c) => c.id === "version-gate");
    expect(gate?.status).toBe("ok");
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

  it("uses an explicit project-scoped package root", async () => {
    const project = tempRoot();
    try {
      const result = await managePackagesImpl(
        makeCtx(),
        managePackagesSchema.parse({
          action: "list",
          installed: true,
          scope: "project",
          project_dir: project,
        }),
      );
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.storage).toMatchObject({
        scope: "project",
        root: join(project, ".tdmcp", "packages"),
      });
    } finally {
      cleanup(project);
    }
  });

  it("reconciles through a dry-run plan without mutating local state", async () => {
    const root = tempRoot();
    try {
      const paths = writeInstalled(root);
      const checkPackageNamespace = vi.fn(async () => livePlan());
      const ctx = {
        ...makeCtx(),
        client: { checkPackageNamespace },
      } as unknown as ToolContext;
      const result = await managePackagesImpl(
        ctx,
        managePackagesSchema.parse({
          action: "reconcile",
          package_id: "package-a",
          packages_root: root,
        }),
      );

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.report).toMatchObject({ status: "planned" });
      expect(readPackageState(paths).packages).toHaveLength(1);
      expect(checkPackageNamespace).toHaveBeenCalledOnce();
    } finally {
      cleanup(root);
    }
  });

  it("turns legacy uninstall with a live target into a safe reconciliation plan", async () => {
    const root = tempRoot();
    try {
      const paths = writeInstalled(root);
      const ctx = {
        ...makeCtx(),
        client: { checkPackageNamespace: vi.fn(async () => livePlan()) },
      } as unknown as ToolContext;
      const result = await managePackagesImpl(
        ctx,
        managePackagesSchema.parse({
          action: "uninstall",
          package_id: "package-a",
          packages_root: root,
        }),
      );

      expect(result.structuredContent?.report).toMatchObject({ status: "planned" });
      expect(readPackageState(paths).packages).toHaveLength(1);
    } finally {
      cleanup(root);
    }
  });

  it("commits local deletion only after a confirmed YOLO live delete", async () => {
    const root = tempRoot();
    try {
      const paths = createPackagePaths({ rootDir: root });
      const stagedPath = join(paths.installRoot, "package-a");
      mkdirSync(stagedPath, { recursive: true });
      writeInstalled(root, stagedPath);
      const applyPackageNamespace = vi.fn(async () => ({
        status: "applied" as const,
        plan_id: PLAN_ID,
        package_id: "package-a",
        classification: "aligned_owned" as const,
        resolved_target_path: "/project1/tdmcp_packages/package_a",
        decision: "Delete" as const,
        action_applied: "delete" as const,
        final_path: null,
        confirmation_policy: "yolo" as const,
        request_id: null,
        marker: { matched: true as const, schema_version: 1 },
        warnings: [],
      }));
      const ctx = {
        ...makeCtx(),
        yolo: true,
        client: { applyPackageNamespace },
      } as unknown as ToolContext;

      const result = await managePackagesImpl(
        ctx,
        managePackagesSchema.parse({
          action: "reconcile",
          package_id: "package-a",
          packages_root: root,
          dry_run: false,
          reconcile_choice: "Delete",
          plan_id: PLAN_ID,
        }),
      );

      expect(result.structuredContent?.report).toMatchObject({ status: "applied" });
      expect(applyPackageNamespace).toHaveBeenCalledOnce();
      expect(readPackageState(paths).packages).toHaveLength(0);
      expect(existsSync(stagedPath)).toBe(false);
    } finally {
      cleanup(root);
    }
  });
});
