import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateArchiveEntries } from "../../src/packages/archive.js";
import { isPackageCommand, runPackageCli } from "../../src/packages/cli.js";
import { doctorPackage } from "../../src/packages/doctor.js";
import { resolveGithubReleaseDownloadPlan } from "../../src/packages/github.js";
import { installPackage, uninstallPackage } from "../../src/packages/installer.js";
import { createPackagePaths } from "../../src/packages/paths.js";
import {
  FULL_SUPPORT_PACKAGE_IDS,
  getDeferredPackage,
  listPackages,
  PackageManifestSchema,
  resolvePackage,
  searchPackages,
} from "../../src/packages/registry.js";
import { readPackageState, writePackageState } from "../../src/packages/state.js";

const fullSupportIds = [
  "mediapipe-touchdesigner",
  "raytk",
  "functionstore-tools",
  "touchdesigner-shared",
  "shader-park-td",
  "sop-to-svg",
  "augmenta-touchdesigner",
  "simplemixer",
] as const;

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tdmcp-packages-test-"));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

describe("package registry", () => {
  it("keeps every manifest schema-valid and every MVP id marked full support", () => {
    const manifests = listPackages({ available: true });
    expect(manifests.length).toBeGreaterThanOrEqual(15);
    for (const manifest of manifests) {
      expect(() => PackageManifestSchema.parse(manifest)).not.toThrow();
    }
    expect(listPackages({ available: false })).toHaveLength(0);
    expect(FULL_SUPPORT_PACKAGE_IDS).toEqual([...fullSupportIds]);
    for (const id of fullSupportIds) {
      expect(resolvePackage(id)?.supportLevel).toBe("full");
    }
  });

  it("normalizes ids and aliases to the canonical package", () => {
    expect(resolvePackage("mediapipe")?.id).toBe("mediapipe-touchdesigner");
    expect(resolvePackage("torinmb-mediapipe")?.id).toBe("mediapipe-touchdesigner");
    expect(resolvePackage("FunctionStore_tools")?.id).toBe("functionstore-tools");
    expect(resolvePackage("shader-park-touchdesigner")?.id).toBe("shader-park-td");
  });

  it("searches manifests without including deferred packages as install targets", () => {
    expect(searchPackages("shader").map((pkg) => pkg.id)).toContain("shader-park-td");
    expect(searchPackages("body tracking").map((pkg) => pkg.id)).toContain(
      "mediapipe-touchdesigner",
    );
    expect(searchPackages("object detection").map((pkg) => pkg.id)).toContain("td-yolo");
    expect(resolvePackage("pytorchtop")).toBeUndefined();
    expect(getDeferredPackage("pytorchtop")?.reason).toMatch(/too heavy/i);
  });
});

describe("package paths and archive safety", () => {
  it("uses the requested root and stable cache/state subpaths", () => {
    const root = join(tempRoot(), "nested", "..", "root");
    try {
      const paths = createPackagePaths({ rootDir: root });
      expect(paths.root).toBe(join(root, "..", "root"));
      expect(paths.cache).toBe(join(paths.root, "cache"));
      expect(paths.installedRegistry).toBe(join(paths.root, "installed.json"));
      expect(paths.installRoot).toBe(join(paths.root, "installed"));
    } finally {
      cleanup(join(root, ".."));
    }
  });

  it("rejects archives that would write outside the destination", () => {
    expect(() => validateArchiveEntries(["repo/file.tox", "repo/docs/readme.md"])).not.toThrow();
    expect(() => validateArchiveEntries(["repo/../../evil.py"])).toThrow(/Unsafe archive path/);
    expect(() => validateArchiveEntries(["/absolute/evil.tox"])).toThrow(/Unsafe archive path/);
  });
});

describe("package state", () => {
  it("round-trips installed package state", () => {
    const root = tempRoot();
    try {
      const paths = createPackagePaths({ rootDir: root });
      writePackageState(paths, {
        version: 1,
        packages: [
          {
            id: "raytk",
            displayName: "RayTK",
            sourceUrl: "https://github.com/t3kt/raytk",
            ref: "main",
            status: "staged",
            stagedPath: join(root, "raytk"),
            artifacts: [],
            warnings: [],
            installedAt: "2026-05-28T00:00:00.000Z",
            updatedAt: "2026-05-28T00:00:00.000Z",
          },
        ],
      });
      expect(readPackageState(paths).packages).toHaveLength(1);
      expect(readPackageState(paths).packages[0]?.id).toBe("raytk");
    } finally {
      cleanup(root);
    }
  });
});

describe("package install planning", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns dry-run install reports without touching disk", async () => {
    const root = tempRoot();
    try {
      const report = await installPackage("mediapipe", {
        rootDir: root,
        dryRun: true,
        projectPath: "/project1",
      });
      expect(report.dryRun).toBe(true);
      expect(report.package.id).toBe("mediapipe-touchdesigner");
      expect(report.status).toBe("planned");
      expect(report.download?.url).toContain("github.com/torinmb/mediapipe-touchdesigner");
      expect(readPackageState(createPackagePaths({ rootDir: root })).packages).toHaveLength(0);
    } finally {
      cleanup(root);
    }
  });

  it("prefers standalone .tox release assets when a release exposes no zip asset", async () => {
    const manifest = resolvePackage("shader-park-td");
    expect(manifest).toBeDefined();
    if (!manifest) throw new Error("shader-park-td manifest missing");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        tag_name: "v1.2.3",
        zipball_url: "https://zipball",
        assets: [{ name: "ShaderPark.tox", browser_download_url: "https://asset/tox" }],
      }),
    })) as unknown as typeof fetch;
    const plan = await resolveGithubReleaseDownloadPlan(manifest, fetchImpl);
    expect(plan).toMatchObject({
      ref: "v1.2.3",
      archiveName: "ShaderPark.tox",
      kind: "file",
      url: "https://asset/tox",
    });
  });

  it("honors an explicit release asset selector", async () => {
    const manifest = resolvePackage("shader-park-td");
    expect(manifest).toBeDefined();
    if (!manifest) throw new Error("shader-park-td manifest missing");
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        tag_name: "v1.2.3",
        zipball_url: "https://zipball",
        assets: [
          { name: "ShaderPark-windows.zip", browser_download_url: "https://asset/windows" },
          { name: "ShaderPark-mac.zip", browser_download_url: "https://asset/mac" },
        ],
      }),
    })) as unknown as typeof fetch;
    await expect(resolveGithubReleaseDownloadPlan(manifest, fetchImpl, "linux")).rejects.toThrow(
      /No release asset matching/,
    );
    const plan = await resolveGithubReleaseDownloadPlan(manifest, fetchImpl, "mac");
    expect(plan).toMatchObject({
      archiveName: "ShaderPark-mac.zip",
      url: "https://asset/mac",
    });
  });

  it("reports the release asset that was actually fetched", async () => {
    const root = tempRoot();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        tag_name: "v1.2.3",
        zipball_url: "https://zipball",
        assets: [{ name: "MediaPipe.tox", browser_download_url: "https://asset/mediapipe.tox" }],
      }),
    })) as unknown as typeof fetch;
    const downloader = vi.fn(async (_url: string, filePath: string) => {
      writeFileSync(filePath, "tox");
    });
    try {
      const report = await installPackage("mediapipe-touchdesigner", {
        rootDir: root,
        fetchImpl,
        downloader,
        bridge: { mode: "offline" },
        yes: true,
      });
      expect(report.download).toMatchObject({
        ref: "v1.2.3",
        archiveName: "MediaPipe.tox",
        kind: "file",
        strategy: "github-release-asset",
        url: "https://asset/mediapipe.tox",
      });
      expect(downloader).toHaveBeenCalledWith(
        "https://asset/mediapipe.tox",
        expect.stringContaining("MediaPipe.tox"),
      );
      const state = readPackageState(createPackagePaths({ rootDir: root }));
      expect(state.packages[0]?.ref).toBe("v1.2.3");
    } finally {
      cleanup(root);
    }
  });

  it("mock-installs every MVP package and records one idempotent state entry each", async () => {
    const root = tempRoot();
    const downloader = vi.fn(async (_url: string, filePath: string) => {
      writeFileSync(filePath, "fake archive");
    });
    const extractor = vi.fn(async (_archivePath: string, destDir: string) => {
      writeFileSync(join(destDir, "component.tox"), "tox");
      writeFileSync(join(destDir, "README.md"), "docs");
    });
    try {
      for (const id of fullSupportIds) {
        const report = await installPackage(id, {
          rootDir: root,
          downloader,
          extractor,
          bridge: { mode: "offline" },
          yes: true,
        });
        expect(report.package.id).toBe(id);
        expect(report.status).toBe("staged");
        expect(report.artifacts.some((artifact) => artifact.kind === "tox")).toBe(true);

        const again = await installPackage(id, {
          rootDir: root,
          downloader,
          extractor,
          bridge: { mode: "offline" },
          yes: true,
        });
        expect(again.status).toBe("staged");
      }
      const state = readPackageState(createPackagePaths({ rootDir: root }));
      expect(state.packages.map((pkg) => pkg.id).sort()).toEqual([...fullSupportIds].sort());
      expect(downloader).toHaveBeenCalledTimes(fullSupportIds.length * 2);
    } finally {
      cleanup(root);
    }
  });

  it("marks heavy doctor-only packages as manual instead of downloading hidden deps", async () => {
    const root = tempRoot();
    const downloader = vi.fn();
    try {
      const report = await installPackage("td-yolo", {
        rootDir: root,
        downloader,
        yes: true,
      });
      expect(report.status).toBe("manual");
      expect(report.warnings.join("\n")).toMatch(/doctor-only|model/i);
      expect(downloader).not.toHaveBeenCalled();
    } finally {
      cleanup(root);
    }
  });

  it("names deferred packages when rejecting an install target", async () => {
    const root = tempRoot();
    try {
      await expect(installPackage("pytorchtop", { rootDir: root })).rejects.toThrow(
        /pytorchtop is deferred and not an install target: .*too heavy/i,
      );
    } finally {
      cleanup(root);
    }
  });

  it("imports a safe .tox when the bridge is reachable", async () => {
    const root = tempRoot();
    const downloader = vi.fn(async (_url: string, filePath: string) => {
      writeFileSync(filePath, "fake archive");
    });
    const extractor = vi.fn(async (_archivePath: string, destDir: string) => {
      writeFileSync(join(destDir, "MediaPipe.tox"), "tox");
    });
    const bridge = {
      mode: "client" as const,
      getInfo: vi.fn(async () => ({ td_version: "2023.12000" })),
      executePythonScript: vi.fn(async () => ({
        stdout: JSON.stringify({
          imported: true,
          targetPath: "/project1/tdmcp_packages/mediapipe_touchdesigner",
          marker: "/project1/tdmcp_packages/mediapipe_touchdesigner/tdmcp_package_info",
          warnings: [],
        }),
      })),
      getNodeErrors: vi.fn(async () => ({ errors: [] })),
    };
    try {
      const report = await installPackage("mediapipe-touchdesigner", {
        rootDir: root,
        downloader,
        extractor,
        bridge,
        projectPath: "/project1",
        yes: true,
      });
      expect(report.status).toBe("imported");
      expect(report.bridge?.targetPath).toBe("/project1/tdmcp_packages/mediapipe_touchdesigner");
      expect(bridge.executePythonScript).toHaveBeenCalledOnce();
    } finally {
      cleanup(root);
    }
  });

  it("keeps a staged install and friendly warning when the bridge import reports fatal", async () => {
    const root = tempRoot();
    const downloader = vi.fn(async (_url: string, filePath: string) => {
      writeFileSync(filePath, "fake archive");
    });
    const extractor = vi.fn(async (_archivePath: string, destDir: string) => {
      writeFileSync(join(destDir, "component.tox"), "tox");
    });
    const bridge = {
      mode: "client" as const,
      getInfo: vi.fn(async () => ({ td_version: "2023.12000" })),
      executePythonScript: vi.fn(async () => ({
        stdout: JSON.stringify({ fatal: "Target exists; rerun with --yes.", warnings: [] }),
      })),
    };
    try {
      const report = await installPackage("sop-to-svg", {
        rootDir: root,
        downloader,
        extractor,
        bridge,
        yes: false,
      });
      expect(report.status).toBe("staged");
      expect(report.warnings.join("\n")).toMatch(/Target exists/);
    } finally {
      cleanup(root);
    }
  });
});

describe("package doctor and CLI", () => {
  it("returns useful doctor guidance for external packages and deferred items", () => {
    const comfy = doctorPackage("comfyui-td");
    expect(comfy.package?.id).toBe("comfyui-td");
    expect(comfy.checks.some((check) => check.status === "manual")).toBe(true);
    expect(comfy.nextSteps.join("\n")).toMatch(/ComfyUI/i);

    const deferred = doctorPackage("touchengine-unreal");
    expect(deferred.deferred?.id).toBe("touchengine-unreal");
    expect(deferred.status).toBe("deferred");
  });

  it("parses top-level package commands without claiming install-bridge", async () => {
    expect(isPackageCommand("install")).toBe(true);
    expect(isPackageCommand("install-bridge")).toBe(false);

    const root = tempRoot();
    try {
      const info = await runPackageCli(["info", "shader-park-td", "--json"], { rootDir: root });
      expect(info.code).toBe(0);
      expect(JSON.parse(info.stdout).id).toBe("shader-park-td");

      const dry = await runPackageCli(
        ["install", "raytk", "--dry-run", "--json", "--project", "/project1"],
        { rootDir: root },
      );
      expect(dry.code).toBe(0);
      expect(JSON.parse(dry.stdout).dryRun).toBe(true);

      const latest = await runPackageCli(
        ["install", "owner/repo", "--version", "latest", "--dry-run", "--json"],
        { rootDir: root },
      );
      expect(latest.code).toBe(0);
      const latestReport = JSON.parse(latest.stdout);
      expect(latestReport.download.ref).toBe("main");
      expect(latestReport.download.url).not.toContain("refs/heads/latest");

      const doctor = await runPackageCli(["doctor", "comfyui-td", "--json"], { rootDir: root });
      expect(doctor.code).toBe(0);
      expect(JSON.parse(doctor.stdout).package.id).toBe("comfyui-td");
    } finally {
      cleanup(root);
    }
  });

  it("uninstalls package state without deleting unrelated package records", async () => {
    const root = tempRoot();
    try {
      const paths = createPackagePaths({ rootDir: root });
      writePackageState(paths, {
        version: 1,
        packages: [
          {
            id: "raytk",
            displayName: "RayTK",
            sourceUrl: "https://github.com/t3kt/raytk",
            ref: "main",
            status: "staged",
            stagedPath: join(root, "raytk"),
            artifacts: [],
            warnings: [],
            installedAt: "2026-05-28T00:00:00.000Z",
            updatedAt: "2026-05-28T00:00:00.000Z",
          },
          {
            id: "shader-park-td",
            displayName: "Shader Park TouchDesigner",
            sourceUrl: "https://github.com/shader-park/shader-park-touchdesigner",
            ref: "main",
            status: "staged",
            stagedPath: join(root, "shader"),
            artifacts: [],
            warnings: [],
            installedAt: "2026-05-28T00:00:00.000Z",
            updatedAt: "2026-05-28T00:00:00.000Z",
          },
        ],
      });
      const report = await uninstallPackage("raytk", { rootDir: root, yes: true });
      expect(report.removed).toBe(true);
      expect(readPackageState(paths).packages.map((pkg) => pkg.id)).toEqual(["shader-park-td"]);
    } finally {
      cleanup(root);
    }
  });
});
