import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

function decodePayload(script: string): Record<string, unknown> {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (!b64) throw new Error("No b64decode payload found");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
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

    extractZip("/tmp/package.zip", "/tmp/tdmcp-package", exec);

    expect(calls[0]?.options.stdio).toBe("pipe");
  });

  it("sanitizes explicit portable tox names before resolving the output path", async () => {
    const dir = tmp();
    let capturedScript = "";
    try {
      const ctx = {
        ...makeCtx(),
        client: {
          executePythonScript: async (script: string) => {
            capturedScript = script;
            return { stdout: JSON.stringify({ saved: "/ignored/widget.tox", size: 1 }) };
          },
        },
      } as unknown as ToolContext;

      const result = await makePortableToxImpl(ctx, {
        comp_path: "/project1/widget",
        out_dir: dir,
        name: "../shared/widget",
        docs: [],
      });

      expect(result.isError).toBeFalsy();
      const payload = decodePayload(capturedScript);
      const toxPath = String(payload.tox_path);
      expect(dirname(toxPath)).toBe(resolve(dir));
      expect(basename(toxPath)).toBe(".._shared_widget.tox");
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
