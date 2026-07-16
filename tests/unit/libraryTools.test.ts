import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  attachDocsAsAssetsImpl,
  browseLibraryImpl,
  componentLinkHealthImpl,
  exportRecipeBundleImpl,
  extractZip,
  importRecipeBundleImpl,
  inspectComponentManifestImpl,
  installLibraryPackageImpl,
  localMarketplaceIndexImpl,
  makePortableToxImpl,
  publishRecipeBundleImpl,
  refreshAssetPreviewsImpl,
  scaffoldRecipeTemplateImpl,
  validateLibraryAssetImpl,
  zipExtractCommand,
} from "../../src/tools/library/index.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeCtx(recipeDir?: string): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(recipeDir ? { dir: recipeDir } : {}),
    logger: silentLogger,
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "tdmcp-library-"));
}

function jsonPayload<T>(result: { content: Array<{ type: string; text?: string }> }): T {
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  const json = /```json\n([\s\S]*?)\n```/.exec(text ?? "")?.[1];
  if (!json) throw new Error(`No JSON payload found in result: ${text}`);
  return JSON.parse(json) as T;
}

describe("library and packaging tools", () => {
  it("builds a Windows zip extraction command without interpolating paths", () => {
    const zipPath = "C:\\packages\\widget'; Remove-Item C:\\important.zip";
    const destDir = "C:\\tdmcp\\packages\\widget";
    const command = zipExtractCommand(zipPath, destDir, "win32");
    expect(command.command).toBe("powershell");
    expect(command.args[2]).toBe(
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
    );
    expect(command.args).toContain(zipPath);
    expect(command.args).toContain(destDir);
    expect(command.args[2]).not.toContain("Remove-Item");
  });

  it("extracts zip packages without inheriting MCP stdio", () => {
    const calls: Array<{ options: { stdio?: unknown } }> = [];
    const exec = ((_command: string, _args: string[], options: { stdio?: unknown }) => {
      calls.push({ options });
      return Buffer.from("");
    }) as never;

    extractZip("/tmp/package.zip", "/tmp/tdmcp-package", exec, () => ["package/widget.tox"]);

    expect(calls[0]?.options.stdio).toBe("pipe");
  });

  it("rejects unsafe zip entries before extraction", () => {
    const exec = vi.fn();

    expect(() =>
      extractZip("/tmp/package.zip", "/tmp/tdmcp-package", exec as never, () => [
        "package/../../outside.tox",
      ]),
    ).toThrow(/Unsafe archive path/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not create a zip destination when entry validation fails", () => {
    const dir = tmp();
    try {
      const dest = join(dir, "tdmcp-package");
      const exec = vi.fn();

      expect(() =>
        extractZip(join(dir, "package.zip"), dest, exec as never, () => [
          "package/../../outside.tox",
        ]),
      ).toThrow(/Unsafe archive path/);
      expect(exec).not.toHaveBeenCalled();
      expect(existsSync(dest)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects zip symlink entries before extraction", () => {
    const dir = tmp();
    try {
      const dest = join(dir, "tdmcp-package");
      const exec = vi.fn();

      expect(() =>
        extractZip(join(dir, "package.zip"), dest, exec as never, () => [
          { path: "package/link", isSymlink: true },
        ]),
      ).toThrow(/Unsafe archive path.*symlink/);
      expect(exec).not.toHaveBeenCalled();
      expect(existsSync(dest)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes explicit portable tox names before resolving the output path", async () => {
    const dir = tmp();
    let capturedTarget = "";
    try {
      const ctx = {
        ...makeCtx(),
        client: {
          exportToxTransaction: async (input: { target_path: string }) => {
            capturedTarget = input.target_path;
            writeFileSync(input.target_path, "tox");
            return {
              operation_id: "opaque_export_operation",
              status: "succeeded",
              verdict: "PASS",
              action_applied: true,
              phases: [],
              artifact: {
                path: input.target_path,
                size_bytes: 1,
                sha256: "a".repeat(64),
              },
            };
          },
          getNode: async () => ({
            path: "/project1/widget",
            type: "baseCOMP",
            name: "widget",
            operator_id: "1234",
          }),
          getInfo: async () => ({ td_version: "099", build: "2025.32820" }),
        },
      } as unknown as ToolContext;

      const result = await makePortableToxImpl(ctx, {
        comp_path: "/project1/widget",
        out_dir: dir,
        name: "../shared/widget",
        docs: [],
        include_readme: false,
      });

      expect(result.isError).toBeFalsy();
      expect(dirname(capturedTarget)).toBe(resolve(dir));
      expect(basename(capturedTarget)).toMatch(
        /^\.tdmcp-\.\._shared_widget-[A-Za-z0-9_]+\.provenance\.tmp\.tox$/,
      );
      expect(existsSync(join(dir, ".._shared_widget.tox"))).toBe(true);
      expect(existsSync(join(dir, ".._shared_widget.tox.provenance.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes an automatic component README into portable tox packages", async () => {
    const dir = tmp();
    const scripts: string[] = [];
    try {
      const ctx = {
        ...makeCtx(),
        client: {
          exportToxTransaction: async (input: { target_path: string }) => {
            writeFileSync(input.target_path, "tox");
            return {
              operation_id: "opaque_export_operation",
              status: "succeeded" as const,
              verdict: "PASS" as const,
              action_applied: true,
              phases: [],
              artifact: {
                path: input.target_path,
                size_bytes: 3,
                sha256: "b".repeat(64),
              },
            };
          },
          getNode: async () => ({
            path: "/project1/widget",
            type: "baseCOMP",
            name: "widget",
            operator_id: "1234",
          }),
          getInfo: async () => ({ td_version: "099", build: "2025.32820" }),
          executePythonScript: async (script: string) => {
            scripts.push(script);
            return {
              stdout: JSON.stringify({
                title_default: "widget",
                node_count: 2,
                nodes: [
                  {
                    path: "/project1/widget/in1",
                    name: "in1",
                    type: "inTOP",
                    family: "TOP",
                  },
                  {
                    path: "/project1/widget/out1",
                    name: "out1",
                    type: "outTOP",
                    family: "TOP",
                  },
                ],
                custom_params: [
                  {
                    comp: "widget",
                    name: "Speed",
                    label: "Speed",
                    value: "0.5",
                    style: "Float",
                  },
                ],
                io: { inputs: ["in1"], outputs: ["out1"] },
                file_deps: [],
                output_top: "/project1/widget/out1",
                warnings: [],
              }),
            };
          },
        },
      } as unknown as ToolContext;

      const result = await makePortableToxImpl(ctx, {
        comp_path: "/project1/widget",
        out_dir: dir,
        name: "widget",
        docs: [],
        include_readme: true,
      });

      expect(result.isError).toBeFalsy();
      expect(scripts).toHaveLength(1);
      const readme = readFileSync(join(dir, "README.md"), "utf8");
      expect(readme).toContain("# widget");
      expect(readme).toContain("## Custom parameters");
      expect(readme).toContain("| widget | Speed | Speed | 0.5 | Float |");
      expect(readme).toContain("**Inputs:** in1");
      expect(readme).toContain("**Outputs:** out1");

      const manifest = JSON.parse(readFileSync(join(dir, "tdmcp-component.json"), "utf8")) as {
        docs: string[];
      };
      expect(manifest.docs).toContain("README.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds, browses, exports, and imports valid recipe bundles", async () => {
    const dir = tmp();
    try {
      const recipePath = join(dir, "pulse.json");
      const scaffold = await scaffoldRecipeTemplateImpl(makeCtx(), {
        out_file: recipePath,
        id: "pulse",
        name: "Pulse",
        overwrite: false,
      });
      expect(scaffold.isError).toBeFalsy();
      expect(existsSync(recipePath)).toBe(true);

      const browse = await browseLibraryImpl(makeCtx(dir), {
        query: "pulse",
        tags: [],
        include_recipes: true,
        include_packages: false,
      });
      expect(browse.structuredContent?.recipes).toHaveLength(1);

      const bundle = join(dir, "bundle.json");
      const exported = await exportRecipeBundleImpl(makeCtx(dir), {
        out_file: bundle,
        recipe_ids: ["pulse"],
        include_all: false,
      });
      expect(exported.isError).toBeFalsy();
      expect(exported.structuredContent).toMatchObject({
        kind: "tdmcp-recipe-bundle",
        version: 1,
        recipes: [expect.objectContaining({ id: "pulse" })],
        missing: [],
      });

      const importedDir = join(dir, "imported");
      const imported = await importRecipeBundleImpl(makeCtx(), {
        bundle_file: bundle,
        out_dir: importedDir,
        overwrite: false,
      });
      expect(imported.isError).toBeFalsy();
      expect(existsSync(join(importedDir, "pulse.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes a versioned recipe bundle artifact with checksums", async () => {
    const dir = tmp();
    try {
      const recipePath = join(dir, "pulse.json");
      await scaffoldRecipeTemplateImpl(makeCtx(), {
        out_file: recipePath,
        id: "pulse",
        name: "Pulse",
        overwrite: false,
      });

      const outDir = join(dir, "published");
      const result = await publishRecipeBundleImpl(makeCtx(dir), {
        out_dir: outDir,
        name: "stage pack",
        version: "1.2.3",
        recipe_ids: ["pulse"],
        include_all: false,
        overwrite: false,
      });

      expect(result.isError).toBeFalsy();
      const bundlePath = join(outDir, "stage_pack.recipes.json");
      const manifestPath = join(outDir, "tdmcp-recipe-publish.json");
      const checksumPath = join(outDir, "tdmcp-checksums.json");
      expect(existsSync(bundlePath)).toBe(true);
      expect(existsSync(manifestPath)).toBe(true);
      expect(existsSync(checksumPath)).toBe(true);

      const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as {
        kind: string;
        recipes: Array<{ id: string }>;
      };
      expect(bundle.kind).toBe("tdmcp-recipe-bundle");
      expect(bundle.recipes.map((r) => r.id)).toEqual(["pulse"]);

      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        kind: string;
        name: string;
        version: string;
        bundle: string;
        recipe_count: number;
        files: Array<{ path: string; sha256: string; size: number }>;
      };
      expect(manifest).toMatchObject({
        kind: "tdmcp-recipe-publish",
        name: "stage_pack",
        version: "1.2.3",
        bundle: "stage_pack.recipes.json",
        recipe_count: 1,
      });
      expect(manifest.files.map((f) => f.path)).toEqual(["stage_pack.recipes.json"]);
      expect(manifest.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.files[0]?.size).toBeGreaterThan(0);

      const checksums = JSON.parse(readFileSync(checksumPath, "utf8")) as {
        kind: string;
        tdmcp_version: string;
        files: Array<{ path: string }>;
      };
      const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string };
      expect(checksums.kind).toBe("tdmcp-checksum-manifest");
      expect(checksums.tdmcp_version).toBe(pkg.version);
      expect(checksums.tdmcp_version).not.toBe("unknown");
      expect(checksums.files.map((f) => f.path).sort()).toEqual([
        "stage_pack.recipes.json",
        "tdmcp-recipe-publish.json",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a file package_dir as an empty package listing", async () => {
    const dir = tmp();
    try {
      const packageFile = join(dir, "packages.json");
      writeFileSync(packageFile, "not a directory", "utf8");

      const browse = await browseLibraryImpl(makeCtx(), {
        package_dir: packageFile,
        tags: [],
        include_recipes: false,
        include_packages: true,
      });

      expect(browse.isError).toBeFalsy();
      expect(browse.structuredContent?.packages).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("browses local packages by manifest metadata and ignores non-package folders", async () => {
    const dir = tmp();
    try {
      const packages = join(dir, "packages");
      const widget = join(packages, "widget");
      const other = join(packages, "other");
      const scratch = join(packages, "scratch");
      mkdirSync(widget, { recursive: true });
      mkdirSync(other, { recursive: true });
      mkdirSync(scratch, { recursive: true });
      writeFileSync(
        join(widget, "tdmcp-component.json"),
        JSON.stringify({
          id: "widget_pack",
          name: "Widget Pack",
          version: "2.0.0",
          description: "projection mapping utilities",
        }),
        "utf8",
      );
      writeFileSync(
        join(other, "manifest.json"),
        JSON.stringify({
          id: "other_pack",
          name: "Other Pack",
          version: "1.0.0",
          description: "unrelated audio helpers",
        }),
        "utf8",
      );
      writeFileSync(join(scratch, "notes.txt"), "not a manifest", "utf8");

      const browse = await browseLibraryImpl(makeCtx(), {
        package_dir: packages,
        query: "projection",
        tags: [],
        include_recipes: false,
        include_packages: true,
      });

      expect(browse.isError).toBeFalsy();
      expect(browse.structuredContent?.recipes).toEqual([]);
      expect(browse.structuredContent?.packages).toEqual([
        expect.objectContaining({
          path: widget,
          id: "widget_pack",
          name: "Widget Pack",
          version: "2.0.0",
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports invalid and missing component manifests as tool errors", async () => {
    const dir = tmp();
    try {
      const invalid = join(dir, "invalid");
      mkdirSync(invalid, { recursive: true });
      writeFileSync(join(invalid, "tdmcp-component.json"), JSON.stringify({ assets: [7] }), "utf8");

      const invalidResult = await inspectComponentManifestImpl(makeCtx(), { path: invalid });
      expect(invalidResult.isError).toBe(true);
      expect(
        invalidResult.content[0]?.type === "text" ? invalidResult.content[0].text : "",
      ).toMatch(/Invalid manifest/);

      const missingResult = await inspectComponentManifestImpl(makeCtx(), {
        path: join(dir, "missing"),
      });
      expect(missingResult.isError).toBe(true);
      expect(
        missingResult.content[0]?.type === "text" ? missingResult.content[0].text : "",
      ).toMatch(/No component manifest found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preflights recipe bundle conflicts before writing any imported recipe", async () => {
    const dir = tmp();
    try {
      const bundle = join(dir, "bundle.json");
      const outDir = join(dir, "imported");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        bundle,
        JSON.stringify({
          recipes: [
            { id: "first", name: "First", nodes: [{ name: "noise1", type: "noiseTOP" }] },
            { id: "second", name: "Second", nodes: [{ name: "noise1", type: "noiseTOP" }] },
          ],
        }),
        "utf8",
      );
      writeFileSync(join(outDir, "second.json"), "existing", "utf8");

      const imported = await importRecipeBundleImpl(makeCtx(), {
        bundle_file: bundle,
        out_dir: outDir,
        overwrite: false,
      });

      expect(imported.isError).toBe(true);
      expect(existsSync(join(outDir, "first.json"))).toBe(false);
      expect(readFileSync(join(outDir, "second.json"), "utf8")).toBe("existing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preflights duplicate recipe bundle target paths before writing", async () => {
    const dir = tmp();
    try {
      const bundle = join(dir, "bundle.json");
      const outDir = join(dir, "imported");
      writeFileSync(
        bundle,
        JSON.stringify({
          recipes: [
            { id: "a/b", name: "Slash", nodes: [{ name: "noise1", type: "noiseTOP" }] },
            { id: "a_b", name: "Underscore", nodes: [{ name: "noise1", type: "noiseTOP" }] },
          ],
        }),
        "utf8",
      );

      const imported = await importRecipeBundleImpl(makeCtx(), {
        bundle_file: bundle,
        out_dir: outDir,
        overwrite: true,
      });

      expect(imported.isError).toBe(true);
      expect(imported.content[0]?.type === "text" ? imported.content[0].text : "").toMatch(
        /Duplicate recipe target path/,
      );
      expect(existsSync(join(outDir, "a_b.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preflights recipe publish artifact conflicts before overwriting files", async () => {
    const dir = tmp();
    try {
      const recipePath = join(dir, "pulse.json");
      await scaffoldRecipeTemplateImpl(makeCtx(), {
        out_file: recipePath,
        id: "pulse",
        name: "Pulse",
        overwrite: false,
      });
      const outDir = join(dir, "published");
      mkdirSync(outDir, { recursive: true });
      const existingBundle = join(outDir, "stage_pack.recipes.json");
      writeFileSync(existingBundle, "existing", "utf8");

      const result = await publishRecipeBundleImpl(makeCtx(dir), {
        out_dir: outDir,
        name: "stage pack",
        version: "1.2.3",
        recipe_ids: ["pulse"],
        include_all: false,
        overwrite: false,
      });

      expect(result.isError).toBe(true);
      expect(readFileSync(existingBundle, "utf8")).toBe("existing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes all recipes when include_all is enabled", async () => {
    const dir = tmp();
    try {
      await scaffoldRecipeTemplateImpl(makeCtx(), {
        out_file: join(dir, "pulse.json"),
        id: "pulse",
        name: "Pulse",
        overwrite: false,
      });
      await scaffoldRecipeTemplateImpl(makeCtx(), {
        out_file: join(dir, "wave.json"),
        id: "wave",
        name: "Wave",
        overwrite: false,
      });

      const result = await publishRecipeBundleImpl(makeCtx(dir), {
        out_dir: join(dir, "published"),
        name: "all",
        version: "1.0.0",
        recipe_ids: ["missing"],
        include_all: true,
        overwrite: false,
      });

      expect(result.isError).toBeFalsy();
      const payload = jsonPayload<{
        manifest: { recipe_count: number; recipes: string[]; missing: string[] };
      }>(result);
      expect(payload.manifest).toMatchObject({
        recipe_count: 2,
        recipes: ["pulse", "wave"],
        missing: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inspects manifests, attaches docs, validates assets, and writes a local marketplace index", async () => {
    const dir = tmp();
    try {
      const pkg = join(dir, "pkg");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "widget.tox"), "tox", "utf8");
      writeFileSync(
        join(pkg, "tdmcp-component.json"),
        JSON.stringify({
          id: "widget",
          name: "Widget",
          version: "1.0.0",
          tox: "widget.tox",
          assets: ["widget.tox"],
        }),
        "utf8",
      );
      const doc = join(dir, "README.md");
      writeFileSync(doc, "# Widget\n", "utf8");

      const inspected = await inspectComponentManifestImpl(makeCtx(), { path: pkg });
      expect(inspected.isError).toBeFalsy();
      expect(inspected.structuredContent?.missing).toEqual([]);

      const attached = await attachDocsAsAssetsImpl(makeCtx(), {
        manifest_path: join(pkg, "tdmcp-component.json"),
        docs: [doc],
        asset_dir: "docs",
      });
      expect(attached.isError).toBeFalsy();
      expect(existsSync(join(pkg, "docs", "README.md"))).toBe(true);

      const valid = await validateLibraryAssetImpl(makeCtx(), {
        path: join(pkg, "widget.tox"),
        manifest_path: join(pkg, "tdmcp-component.json"),
      });
      expect(valid.structuredContent?.issues).toEqual([]);

      const validFromDir = await validateLibraryAssetImpl(makeCtx(), {
        path: join(pkg, "widget.tox"),
        manifest_path: pkg,
      });
      expect(validFromDir.structuredContent?.issues).toEqual([]);

      const indexed = await localMarketplaceIndexImpl(makeCtx(), { package_dir: dir });
      expect(indexed.isError).toBeFalsy();
      const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as {
        entries: unknown[];
      };
      expect(index.entries).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("attaches docs at the package root when asset_dir is dot", async () => {
    const dir = tmp();
    try {
      const pkg = join(dir, "pkg");
      mkdirSync(pkg, { recursive: true });
      const manifestPath = join(pkg, "tdmcp-component.json");
      writeFileSync(manifestPath, JSON.stringify({ id: "widget", docs: [] }), "utf8");
      const doc = join(dir, "README.md");
      writeFileSync(doc, "# Widget\n", "utf8");

      const attached = await attachDocsAsAssetsImpl(makeCtx(), {
        manifest_path: manifestPath,
        docs: [doc],
        asset_dir: ".",
      });

      expect(attached.isError).toBeFalsy();
      expect(existsSync(join(pkg, "README.md"))).toBe(true);
      const payload = jsonPayload<{ manifest: { docs: string[] } }>(attached);
      expect(payload.manifest).toMatchObject({ docs: ["README.md"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags manifest entries that escape the package directory", async () => {
    const dir = tmp();
    try {
      const pkg = join(dir, "pkg");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(dir, "outside.tox"), "external", "utf8");
      writeFileSync(
        join(pkg, "tdmcp-component.json"),
        JSON.stringify({
          id: "widget",
          assets: ["../outside.tox"],
        }),
        "utf8",
      );

      const inspected = await inspectComponentManifestImpl(makeCtx(), { path: pkg });

      expect(inspected.isError).toBeFalsy();
      expect(inspected.structuredContent?.missing).toContain("../outside.tox");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects absolute and drive-qualified manifest references before resolving", async () => {
    const dir = tmp();
    try {
      const pkg = join(dir, "pkg");
      mkdirSync(join(pkg, "tmp"), { recursive: true });
      mkdirSync(join(pkg, "C:"), { recursive: true });
      writeFileSync(join(pkg, "tmp", "secret.tox"), "internal", "utf8");
      writeFileSync(join(pkg, "C:", "secret.tox"), "internal", "utf8");
      writeFileSync(join(pkg, "secret.tox"), "internal", "utf8");
      writeFileSync(
        join(pkg, "tdmcp-component.json"),
        JSON.stringify({
          id: "widget",
          assets: [
            "/tmp/secret.tox",
            "C:/secret.tox",
            "C:secret.tox",
            "safe/../secret.tox",
            "bad\u0000name.tox",
          ],
        }),
        "utf8",
      );

      const inspected = await inspectComponentManifestImpl(makeCtx(), { path: pkg });
      expect(inspected.isError).toBeFalsy();
      expect(inspected.structuredContent?.missing).toEqual([
        "/tmp/secret.tox",
        "C:/secret.tox",
        "C:secret.tox",
        "safe/../secret.tox",
        "bad\u0000name.tox",
      ]);

      const valid = await validateLibraryAssetImpl(makeCtx(), {
        path: join(pkg, "tmp", "secret.tox"),
        manifest_path: pkg,
      });

      expect(valid.structuredContent?.issues).toEqual(
        expect.arrayContaining([
          "Manifest reference escapes package directory: /tmp/secret.tox",
          "Manifest reference escapes package directory: C:/secret.tox",
          "Manifest reference escapes package directory: C:secret.tox",
          "Manifest reference escapes package directory: safe/../secret.tox",
          "Manifest reference escapes package directory: bad\u0000name.tox",
          "Asset is not referenced by the manifest.",
        ]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects manifest asset references that escape the package directory", async () => {
    const dir = tmp();
    try {
      const pkg = join(dir, "pkg");
      const outside = join(dir, "outside.tox");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(outside, "external", "utf8");
      writeFileSync(
        join(pkg, "tdmcp-component.json"),
        JSON.stringify({
          id: "widget",
          assets: ["../outside.tox"],
        }),
        "utf8",
      );

      const valid = await validateLibraryAssetImpl(makeCtx(), {
        path: outside,
        manifest_path: pkg,
      });

      expect(valid.structuredContent?.issues).toContain(
        "Manifest reference escapes package directory: ../outside.tox",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an error result when recipe bundle export cannot write the output file", async () => {
    const dir = tmp();
    try {
      await expect(
        exportRecipeBundleImpl(makeCtx(), {
          out_file: dir,
          recipe_ids: [],
          include_all: false,
        }),
      ).resolves.toMatchObject({ isError: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an error result when recipe template scaffold cannot write the output file", async () => {
    const dir = tmp();
    try {
      await expect(
        scaffoldRecipeTemplateImpl(makeCtx(), {
          out_file: dir,
          id: "blocked",
          name: "Blocked",
          overwrite: true,
        }),
      ).resolves.toMatchObject({ isError: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an error result when local marketplace index cannot write the output file", async () => {
    const dir = tmp();
    try {
      await expect(
        localMarketplaceIndexImpl(makeCtx(), {
          package_dir: dir,
          out_file: dir,
        }),
      ).resolves.toMatchObject({ isError: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects doc asset directories that escape the package", async () => {
    const dir = tmp();
    try {
      const pkg = join(dir, "pkg");
      mkdirSync(pkg, { recursive: true });
      const manifestPath = join(pkg, "tdmcp-component.json");
      writeFileSync(manifestPath, JSON.stringify({ id: "widget", docs: [] }), "utf8");
      const doc = join(dir, "README.md");
      writeFileSync(doc, "# Widget\n", "utf8");

      const attached = await attachDocsAsAssetsImpl(makeCtx(), {
        manifest_path: manifestPath,
        docs: [doc],
        asset_dir: "../outside",
      });

      expect(attached.isError).toBe(true);
      expect(existsSync(join(dir, "outside", "README.md"))).toBe(false);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { docs?: string[] };
      expect(manifest.docs).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects Windows drive-relative doc asset directories", async () => {
    const dir = tmp();
    try {
      const pkg = join(dir, "pkg");
      mkdirSync(pkg, { recursive: true });
      const manifestPath = join(pkg, "tdmcp-component.json");
      writeFileSync(manifestPath, JSON.stringify({ id: "widget", docs: [] }), "utf8");
      const doc = join(dir, "README.md");
      writeFileSync(doc, "# Widget\n", "utf8");

      const attached = await attachDocsAsAssetsImpl(makeCtx(), {
        manifest_path: manifestPath,
        docs: [doc],
        asset_dir: "C:docs",
      });

      expect(attached.isError).toBe(true);
      expect(existsSync(join(pkg, "C:docs", "README.md"))).toBe(false);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { docs?: string[] };
      expect(manifest.docs).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs a local package directory without overwriting by default", async () => {
    const dir = tmp();
    try {
      const src = join(dir, "srcpkg");
      const dest = join(dir, "packages");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "tdmcp-component.json"), JSON.stringify({ id: "srcpkg" }), "utf8");
      const installed = await installLibraryPackageImpl(makeCtx(), {
        source: src,
        dest_dir: dest,
        overwrite: false,
      });
      expect(installed.isError).toBeFalsy();
      expect(existsSync(join(dest, "srcpkg", "tdmcp-component.json"))).toBe(true);
      const second = await installLibraryPackageImpl(makeCtx(), {
        source: src,
        dest_dir: dest,
        overwrite: false,
      });
      expect(second.isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs a local package directory into project-scoped storage", async () => {
    const dir = tmp();
    try {
      const src = join(dir, "srcpkg");
      const project = join(dir, "project");
      mkdirSync(src, { recursive: true });
      mkdirSync(project, { recursive: true });
      writeFileSync(join(src, "tdmcp-component.json"), JSON.stringify({ id: "srcpkg" }), "utf8");
      const installed = await installLibraryPackageImpl(makeCtx(), {
        source: src,
        scope: "project",
        project_dir: project,
        overwrite: false,
      });
      expect(installed.isError).toBeFalsy();
      expect(
        existsSync(
          join(project, ".tdmcp", "packages", "installed", "srcpkg", "tdmcp-component.json"),
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects filesystem root package sources before resolving a destination", async () => {
    const dir = tmp();
    try {
      const rootSource = parse(resolve(dir)).root;
      const result = await installLibraryPackageImpl(makeCtx(), {
        source: rootSource,
        dest_dir: dir,
        overwrite: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.type === "text" ? result.content[0].text : "").toMatch(
        /filesystem root/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects local package directories that contain symlinks", async () => {
    const dir = tmp();
    try {
      const src = join(dir, "srcpkg");
      const dest = join(dir, "packages");
      const outside = join(dir, "outside.txt");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "tdmcp-component.json"), JSON.stringify({ id: "srcpkg" }), "utf8");
      writeFileSync(outside, "external", "utf8");
      symlinkSync(outside, join(src, "outside-link.txt"));

      const installed = await installLibraryPackageImpl(makeCtx(), {
        source: src,
        dest_dir: dest,
        overwrite: false,
      });

      expect(installed.isError).toBe(true);
      expect(installed.content[0]?.type === "text" ? installed.content[0].text : "").toMatch(
        /symlink/,
      );
      expect(existsSync(join(dest, "srcpkg", "outside-link.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs a manifest file by copying its containing package directory", async () => {
    const dir = tmp();
    try {
      const src = join(dir, "srcpkg");
      const docs = join(src, "docs");
      const dest = join(dir, "packages");
      mkdirSync(docs, { recursive: true });
      writeFileSync(join(src, "widget.tox"), "tox", "utf8");
      writeFileSync(join(docs, "guide.md"), "# Guide\n", "utf8");
      const manifestPath = join(src, "tdmcp-component.json");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          id: "srcpkg",
          tox: "widget.tox",
          assets: ["widget.tox"],
          docs: ["docs/guide.md"],
        }),
        "utf8",
      );

      const installed = await installLibraryPackageImpl(makeCtx(), {
        source: manifestPath,
        dest_dir: dest,
        overwrite: false,
      });

      expect(installed.isError).toBeFalsy();
      expect(existsSync(join(dest, "srcpkg", "tdmcp-component.json"))).toBe(true);
      expect(existsSync(join(dest, "srcpkg", "widget.tox"))).toBe(true);
      expect(existsSync(join(dest, "srcpkg", "docs", "guide.md"))).toBe(true);
      expect(existsSync(join(dest, "tdmcp-component", "tdmcp-component.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs a single tox file into a package folder", async () => {
    const dir = tmp();
    try {
      const source = join(dir, "widget.tox");
      const dest = join(dir, "packages");
      writeFileSync(source, "tox", "utf8");

      const installed = await installLibraryPackageImpl(makeCtx(), {
        source,
        dest_dir: dest,
        overwrite: false,
      });

      expect(installed.isError).toBeFalsy();
      expect(existsSync(join(dest, "widget", "widget.tox"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports missing install sources before creating destination folders", async () => {
    const dir = tmp();
    try {
      const dest = join(dir, "packages");
      const result = await installLibraryPackageImpl(makeCtx(), {
        source: join(dir, "missing.tox"),
        dest_dir: dest,
        overwrite: false,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.type === "text" ? result.content[0].text : "").toMatch(
        /Package source not found/,
      );
      expect(existsSync(dest)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks component externaltox links from a live TD report", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              checked: [
                {
                  path: "/project1/widget",
                  externaltox: "/missing/widget.tox",
                  exists: false,
                  issue: "externaltox file missing",
                },
              ],
            }),
          },
        }),
      ),
    );
    const result = await componentLinkHealthImpl(makeCtx(), {
      paths: ["/project1/widget"],
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("1 issue");
  });

  it("returns an error when the component link health report is fatal", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({ checked: [], fatal: "Parent not found: /missing" }),
          },
        }),
      ),
    );

    const result = await componentLinkHealthImpl(makeCtx(), {
      paths: [],
      parent_path: "/missing",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      "Component link health failed",
    );
  });

  it("returns an error when every asset preview capture fails", async () => {
    server.use(http.get(`${TD_BASE}/api/preview/:seg`, () => HttpResponse.error()));
    const dir = tmp();
    try {
      const result = await refreshAssetPreviewsImpl(makeCtx(), {
        targets: [
          { node_path: "/project1/out1", file_path: join(dir, "out1.png") },
          { node_path: "/project1/out2", file_path: join(dir, "out2.png") },
        ],
        width: 64,
        height: 64,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
        "Refreshed 0/2 preview asset(s).",
      );
      expect(existsSync(join(dir, "out1.png"))).toBe(false);
      expect(existsSync(join(dir, "out2.png"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes preview image files from TOP nodes", async () => {
    const dir = tmp();
    try {
      const out = join(dir, "preview.png");
      const result = await refreshAssetPreviewsImpl(makeCtx(), {
        targets: [{ node_path: "/project1/out1", file_path: out }],
        width: 64,
        height: 64,
      });
      expect(result.isError).toBeFalsy();
      expect(existsSync(out)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
