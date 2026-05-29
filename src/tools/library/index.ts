import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { z } from "zod";
import { capturePreview } from "../../feedback/previewCapture.js";
import { type Recipe, RecipeSchema } from "../../recipes/schema.js";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const ComponentManifestSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    type: z.string().optional(),
    tox: z.string().optional(),
    assets: z.array(z.string()).default([]),
    docs: z.array(z.string()).default([]),
    recipes: z.array(z.string()).default([]),
  })
  .passthrough();

type ComponentManifest = z.infer<typeof ComponentManifestSchema>;

function manifestCandidates(path: string): string[] {
  const full = resolve(path);
  if (existsSync(full) && statSync(full).isFile()) return [full];
  return [
    join(full, "tdmcp-component.json"),
    join(full, "manifest.json"),
    join(full, "package.json"),
  ];
}

function readManifest(path: string): { path: string; manifest: ComponentManifest } {
  for (const candidate of manifestCandidates(path)) {
    if (!existsSync(candidate)) continue;
    const parsed = ComponentManifestSchema.safeParse(JSON.parse(readFileSync(candidate, "utf8")));
    if (!parsed.success) {
      throw new Error(`Invalid manifest ${candidate}: ${parsed.error.issues.length} issue(s)`);
    }
    return { path: candidate, manifest: parsed.data };
  }
  throw new Error(`No component manifest found at ${path}`);
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function recipeFileName(recipe: Recipe): string {
  return `${recipe.id.replace(/[^a-zA-Z0-9_.-]+/g, "_")}.json`;
}

function extractZip(zipPath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
      ],
      { stdio: "inherit" },
    );
  } else {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", destDir], { stdio: "inherit" });
  }
}

export const browseLibrarySchema = z.object({
  query: z.string().optional(),
  tags: z.array(z.string()).default([]),
  package_dir: z.string().optional(),
  include_recipes: z.boolean().default(true),
  include_packages: z.boolean().default(true),
});
type BrowseLibraryArgs = z.infer<typeof browseLibrarySchema>;

export async function browseLibraryImpl(ctx: ToolContext, args: BrowseLibraryArgs) {
  const query = args.query?.toLowerCase();
  const tags = args.tags.map((t) => t.toLowerCase());
  const recipes = args.include_recipes
    ? ctx.recipes.list().filter((recipe) => {
        const haystack =
          `${recipe.id} ${recipe.name} ${recipe.description} ${recipe.tags.join(" ")}`.toLowerCase();
        if (query && !haystack.includes(query)) return false;
        return tags.every((tag) => recipe.tags.map((t) => t.toLowerCase()).includes(tag));
      })
    : [];
  const packages: Array<{ path: string; id?: string; name?: string; version?: string }> = [];
  if (args.include_packages && args.package_dir && existsSync(args.package_dir)) {
    for (const entry of readdirSync(args.package_dir)) {
      const path = join(args.package_dir, entry);
      if (!statSync(path).isDirectory()) continue;
      try {
        const { manifest } = readManifest(path);
        const haystack =
          `${manifest.id ?? ""} ${manifest.name ?? ""} ${manifest.description ?? ""}`.toLowerCase();
        if (query && !haystack.includes(query)) continue;
        packages.push({ path, id: manifest.id, name: manifest.name, version: manifest.version });
      } catch {
        // Non-package folders are ignored by browse; inspect_component_manifest reports details.
      }
    }
  }
  return structuredResult(`Found ${recipes.length} recipe(s) and ${packages.length} package(s).`, {
    recipes,
    packages,
  });
}

export const inspectComponentManifestSchema = z.object({ path: z.string() });
type InspectComponentManifestArgs = z.infer<typeof inspectComponentManifestSchema>;

export async function inspectComponentManifestImpl(
  _ctx: ToolContext,
  args: InspectComponentManifestArgs,
) {
  try {
    const { path, manifest } = readManifest(args.path);
    const base = dirname(path);
    const missing = [
      ...(manifest.assets ?? []),
      ...(manifest.docs ?? []),
      ...(manifest.tox ? [manifest.tox] : []),
    ].filter((rel) => !existsSync(join(base, rel)));
    return structuredResult(`Read component manifest ${path}.`, { path, manifest, missing });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export const makePortableToxSchema = z.object({
  comp_path: z.string(),
  out_dir: z.string(),
  name: z.string().optional(),
  docs: z.array(z.string()).default([]),
});
type MakePortableToxArgs = z.infer<typeof makePortableToxSchema>;

interface SaveToxReport {
  saved?: string;
  size?: number | null;
  fatal?: string;
}

const SAVE_TOX_SCRIPT = `
import json, base64, os, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {}
try:
    _c = op(_p["comp_path"])
    if _c is None:
        report["fatal"] = "COMP not found: " + _p["comp_path"]
    elif not _c.isCOMP:
        report["fatal"] = _p["comp_path"] + " is not a COMP"
    else:
        _c.save(_p["tox_path"], createFolders=True)
        report["saved"] = _p["tox_path"]
        report["size"] = os.path.getsize(_p["tox_path"]) if os.path.isfile(_p["tox_path"]) else None
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export async function makePortableToxImpl(ctx: ToolContext, args: MakePortableToxArgs) {
  const name = args.name ?? basename(args.comp_path).replace(/[^a-zA-Z0-9_.-]+/g, "_");
  const outDir = resolve(args.out_dir);
  const toxPath = join(outDir, `${name}.tox`);
  return guardTd(
    async () => {
      mkdirSync(outDir, { recursive: true });
      const exec = await ctx.client.executePythonScript(
        buildPayloadScript(SAVE_TOX_SCRIPT, { comp_path: args.comp_path, tox_path: toxPath }),
        true,
      );
      const report = parsePythonReport<SaveToxReport>(exec.stdout);
      if (report.fatal) return { report };
      const copiedDocs: string[] = [];
      for (const doc of args.docs) {
        const target = join(outDir, "docs", basename(doc));
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(doc, target);
        copiedDocs.push(`docs/${basename(doc)}`);
      }
      const manifest: ComponentManifest = {
        id: name,
        name,
        version: "0.1.0",
        type: "touchdesigner-component",
        tox: basename(toxPath),
        docs: copiedDocs,
        assets: [basename(toxPath)],
        recipes: [],
      };
      writeJson(join(outDir, "tdmcp-component.json"), manifest);
      return { report, manifest_path: join(outDir, "tdmcp-component.json"), manifest };
    },
    (data) => {
      if (data.report.fatal) return errorResult(`Portable tox failed: ${data.report.fatal}`, data);
      return jsonResult(`Saved portable .tox package to ${outDir}.`, data);
    },
  );
}

export const exportRecipeBundleSchema = z.object({
  out_file: z.string(),
  recipe_ids: z.array(z.string()).default([]),
  include_all: z.boolean().default(false),
});
type ExportRecipeBundleArgs = z.infer<typeof exportRecipeBundleSchema>;

export async function exportRecipeBundleImpl(ctx: ToolContext, args: ExportRecipeBundleArgs) {
  const recipes = args.include_all
    ? ctx.recipes.all()
    : args.recipe_ids.map((id) => ctx.recipes.get(id)).filter((r): r is Recipe => Boolean(r));
  const missing = args.include_all ? [] : args.recipe_ids.filter((id) => !ctx.recipes.get(id));
  const bundle = {
    kind: "tdmcp-recipe-bundle",
    version: 1,
    exported_at: new Date().toISOString(),
    recipes,
    missing,
  };
  writeJson(args.out_file, bundle);
  return jsonResult(`Exported ${recipes.length} recipe(s) to ${args.out_file}.`, bundle);
}

export const importRecipeBundleSchema = z.object({
  bundle_file: z.string(),
  out_dir: z.string(),
  overwrite: z.boolean().default(false),
});
type ImportRecipeBundleArgs = z.infer<typeof importRecipeBundleSchema>;

export async function importRecipeBundleImpl(_ctx: ToolContext, args: ImportRecipeBundleArgs) {
  try {
    const raw = JSON.parse(readFileSync(args.bundle_file, "utf8")) as { recipes?: unknown[] };
    const recipes = z.array(RecipeSchema).parse(raw.recipes ?? []);
    const written: string[] = [];
    for (const recipe of recipes) {
      const out = join(args.out_dir, recipeFileName(recipe));
      if (existsSync(out) && !args.overwrite) {
        return errorResult(`Recipe already exists: ${out}. Pass overwrite:true to replace it.`);
      }
      writeJson(out, recipe);
      written.push(out);
    }
    return jsonResult(`Imported ${written.length} recipe(s) into ${args.out_dir}.`, { written });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export const validateLibraryAssetSchema = z.object({
  path: z.string(),
  manifest_path: z.string().optional(),
});
type ValidateLibraryAssetArgs = z.infer<typeof validateLibraryAssetSchema>;

export async function validateLibraryAssetImpl(_ctx: ToolContext, args: ValidateLibraryAssetArgs) {
  const issues: string[] = [];
  const full = resolve(args.path);
  if (!existsSync(full)) issues.push(`Missing asset: ${full}`);
  const ext = extname(full).toLowerCase();
  if (full.endsWith(".tox") && ext !== ".tox") issues.push("Expected a .tox extension.");
  if (args.manifest_path) {
    const manifestPath = args.manifest_path;
    try {
      const { manifest } = readManifest(manifestPath);
      const rels = [
        ...(manifest.assets ?? []),
        ...(manifest.docs ?? []),
        ...(manifest.tox ? [manifest.tox] : []),
      ];
      if (!rels.some((rel) => resolve(dirname(manifestPath), rel) === full)) {
        issues.push("Asset is not referenced by the manifest.");
      }
    } catch (err) {
      issues.push(err instanceof Error ? err.message : String(err));
    }
  }
  const info = existsSync(full) ? statSync(full) : undefined;
  return structuredResult(
    issues.length ? `${issues.length} asset issue(s).` : "Asset looks valid.",
    {
      path: full,
      exists: existsSync(full),
      size: info?.size ?? null,
      extension: ext,
      issues,
    },
  );
}

export const scaffoldRecipeTemplateSchema = z.object({
  out_file: z.string(),
  id: z.string(),
  name: z.string(),
  overwrite: z.boolean().default(false),
});
type ScaffoldRecipeTemplateArgs = z.infer<typeof scaffoldRecipeTemplateSchema>;

export async function scaffoldRecipeTemplateImpl(
  _ctx: ToolContext,
  args: ScaffoldRecipeTemplateArgs,
) {
  if (existsSync(args.out_file) && !args.overwrite) {
    return errorResult(
      `Recipe template already exists: ${args.out_file}. Pass overwrite:true to replace it.`,
    );
  }
  const recipe = RecipeSchema.parse({
    id: args.id,
    name: args.name,
    description: "Describe what this recipe builds.",
    tags: ["template"],
    difficulty: "beginner",
    nodes: [
      { name: "source", type: "noiseTOP", parameters: {} },
      { name: "out1", type: "nullTOP", parameters: {} },
    ],
    connections: [{ from: "source", to: "out1" }],
    parameters: [],
    controls: [],
    preview_description: "A starter recipe template.",
  });
  writeJson(args.out_file, recipe);
  return jsonResult(`Scaffolded recipe template ${args.out_file}.`, {
    recipe,
    out_file: args.out_file,
  });
}

export const attachDocsAsAssetsSchema = z.object({
  manifest_path: z.string(),
  docs: z.array(z.string()).min(1),
  asset_dir: z.string().default("docs"),
});
type AttachDocsAsAssetsArgs = z.infer<typeof attachDocsAsAssetsSchema>;

export async function attachDocsAsAssetsImpl(_ctx: ToolContext, args: AttachDocsAsAssetsArgs) {
  try {
    const { manifest } = readManifest(args.manifest_path);
    const base = dirname(args.manifest_path);
    const attached: string[] = [];
    for (const doc of args.docs) {
      const rel = join(args.asset_dir, basename(doc));
      const dest = join(base, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(doc, dest);
      attached.push(rel);
    }
    const next = { ...manifest, docs: [...new Set([...(manifest.docs ?? []), ...attached])] };
    writeJson(args.manifest_path, next);
    return jsonResult(`Attached ${attached.length} doc asset(s).`, {
      manifest_path: args.manifest_path,
      attached,
      manifest: next,
    });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export const localMarketplaceIndexSchema = z.object({
  package_dir: z.string(),
  out_file: z.string().optional(),
});
type LocalMarketplaceIndexArgs = z.infer<typeof localMarketplaceIndexSchema>;

export async function localMarketplaceIndexImpl(
  _ctx: ToolContext,
  args: LocalMarketplaceIndexArgs,
) {
  const entries: Array<{
    path: string;
    id?: string;
    name?: string;
    version?: string;
    manifest: string;
  }> = [];
  if (existsSync(args.package_dir)) {
    for (const entry of readdirSync(args.package_dir)) {
      const path = join(args.package_dir, entry);
      if (!statSync(path).isDirectory()) continue;
      try {
        const found = readManifest(path);
        entries.push({
          path,
          id: found.manifest.id,
          name: found.manifest.name,
          version: found.manifest.version,
          manifest: found.path,
        });
      } catch {
        // skip non-package folders
      }
    }
  }
  const index = {
    kind: "tdmcp-local-marketplace-index",
    generated_at: new Date().toISOString(),
    entries,
  };
  const out = args.out_file ?? join(args.package_dir, "index.json");
  writeJson(out, index);
  return jsonResult(`Indexed ${entries.length} local package(s) at ${out}.`, index);
}

export const componentLinkHealthSchema = z.object({
  paths: z.array(z.string()).default([]),
  parent_path: z.string().default("/project1"),
});
type ComponentLinkHealthArgs = z.infer<typeof componentLinkHealthSchema>;

interface LinkHealthReport {
  checked: Array<{ path: string; externaltox?: string; exists?: boolean; issue?: string }>;
  fatal?: string;
}

const LINK_HEALTH_SCRIPT = `
import json, base64, os, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"checked": []}
try:
    _paths = _p.get("paths") or []
    if not _paths:
        _parent = op(_p["parent_path"])
        if _parent is None:
            report["fatal"] = "Parent not found: " + _p["parent_path"]
        else:
            _paths = [c.path for c in _parent.children if getattr(c, "isCOMP", False)]
    if not report.get("fatal"):
        for _path in _paths:
            _n = op(_path)
            if _n is None:
                report["checked"].append({"path": _path, "issue": "node not found"})
                continue
            _tox = ""
            try:
                _tox = str(_n.par.externaltox.eval())
            except Exception:
                _tox = ""
            _item = {"path": _path, "externaltox": _tox}
            if _tox:
                _item["exists"] = os.path.exists(_tox)
                if not _item["exists"]:
                    _item["issue"] = "externaltox file missing"
            report["checked"].append(_item)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export async function componentLinkHealthImpl(ctx: ToolContext, args: ComponentLinkHealthArgs) {
  return guardTd(
    async () => {
      const exec = await ctx.client.executePythonScript(
        buildPayloadScript(LINK_HEALTH_SCRIPT, args),
        true,
      );
      return parsePythonReport<LinkHealthReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) return errorResult(`Component link health failed: ${report.fatal}`, report);
      const issues = report.checked.filter((item) => item.issue).length;
      return jsonResult(
        `Checked ${report.checked.length} component link(s), ${issues} issue(s).`,
        report,
      );
    },
  );
}

export const refreshAssetPreviewsSchema = z.object({
  targets: z.array(z.object({ node_path: z.string(), file_path: z.string() })).min(1),
  width: z.coerce.number().int().positive().default(640),
  height: z.coerce.number().int().positive().default(360),
});
type RefreshAssetPreviewsArgs = z.infer<typeof refreshAssetPreviewsSchema>;

export async function refreshAssetPreviewsImpl(ctx: ToolContext, args: RefreshAssetPreviewsArgs) {
  const written: Array<{ node_path: string; file_path: string; bytes: number }> = [];
  const warnings: string[] = [];
  for (const target of args.targets) {
    try {
      const preview = await capturePreview(ctx.client, target.node_path, args.width, args.height);
      const bytes = Buffer.from(preview.base64, "base64");
      mkdirSync(dirname(target.file_path), { recursive: true });
      writeFileSync(target.file_path, bytes);
      written.push({
        node_path: target.node_path,
        file_path: target.file_path,
        bytes: bytes.length,
      });
    } catch (err) {
      warnings.push(`${target.node_path}: ${friendlyTdError(err)}`);
    }
  }
  return jsonResult(`Refreshed ${written.length}/${args.targets.length} preview asset(s).`, {
    written,
    warnings,
  });
}

export const installLibraryPackageSchema = z.object({
  source: z.string().describe("Local package folder, .zip, .tox, or manifest file."),
  dest_dir: z.string(),
  overwrite: z.boolean().default(false),
});
type InstallLibraryPackageArgs = z.infer<typeof installLibraryPackageSchema>;

export async function installLibraryPackageImpl(
  _ctx: ToolContext,
  args: InstallLibraryPackageArgs,
) {
  try {
    const source = resolve(args.source);
    if (!existsSync(source)) return errorResult(`Package source not found: ${source}`);
    const baseName = basename(source, extname(source));
    const dest = resolve(args.dest_dir, baseName);
    if (existsSync(dest) && !args.overwrite) {
      return errorResult(
        `Destination already exists: ${dest}. Pass overwrite:true to replace/update it.`,
      );
    }
    mkdirSync(dirname(dest), { recursive: true });
    if (statSync(source).isDirectory()) {
      cpSync(source, dest, { recursive: true, force: args.overwrite });
    } else if (source.toLowerCase().endsWith(".zip")) {
      extractZip(source, dest);
    } else {
      mkdirSync(dest, { recursive: true });
      copyFileSync(source, join(dest, basename(source)));
    }
    return jsonResult(`Installed library package to ${dest}.`, { source, dest });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

export const libraryRegistrars: ToolRegistrar[] = [
  (server, ctx) =>
    server.registerTool(
      "browse_library",
      {
        title: "Browse library",
        description: "Browse built-in/vault recipes and optional local component packages.",
        inputSchema: browseLibrarySchema.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        outputSchema: z.object({ recipes: z.array(z.unknown()), packages: z.array(z.unknown()) })
          .shape,
      },
      (args) => browseLibraryImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "inspect_component_manifest",
      {
        title: "Inspect component manifest",
        description:
          "Read and validate a tdmcp component/library manifest from a package folder or file.",
        inputSchema: inspectComponentManifestSchema.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      (args) => inspectComponentManifestImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "make_portable_tox",
      {
        title: "Make portable tox",
        description:
          "Save a COMP as a .tox package and write a tdmcp-component manifest beside it.",
        inputSchema: makePortableToxSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => makePortableToxImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "export_recipe_bundle",
      {
        title: "Export recipe bundle",
        description: "Write selected recipes to a portable JSON bundle.",
        inputSchema: exportRecipeBundleSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => exportRecipeBundleImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "import_recipe_bundle",
      {
        title: "Import recipe bundle",
        description: "Import recipes from a portable JSON bundle into a recipe directory.",
        inputSchema: importRecipeBundleSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => importRecipeBundleImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "validate_library_asset",
      {
        title: "Validate library asset",
        description:
          "Check that a local library asset exists and is referenced by an optional manifest.",
        inputSchema: validateLibraryAssetSchema.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      (args) => validateLibraryAssetImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "scaffold_recipe_template",
      {
        title: "Scaffold recipe template",
        description: "Write a minimal valid recipe JSON template.",
        inputSchema: scaffoldRecipeTemplateSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => scaffoldRecipeTemplateImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "attach_docs_as_assets",
      {
        title: "Attach docs as assets",
        description:
          "Copy documentation files into a package and add them to its manifest docs list.",
        inputSchema: attachDocsAsAssetsSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => attachDocsAsAssetsImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "local_marketplace_index",
      {
        title: "Local marketplace index",
        description:
          "Scan a local package directory and write an index of installable tdmcp packages.",
        inputSchema: localMarketplaceIndexSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => localMarketplaceIndexImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "component_link_health",
      {
        title: "Component link health",
        description: "Probe live COMPs for externaltox paths and missing linked component files.",
        inputSchema: componentLinkHealthSchema.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      (args) => componentLinkHealthImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "refresh_asset_previews",
      {
        title: "Refresh asset previews",
        description: "Capture preview PNG assets from one or more TOP nodes.",
        inputSchema: refreshAssetPreviewsSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => refreshAssetPreviewsImpl(ctx, args),
    ),
  (server, ctx) =>
    server.registerTool(
      "install_library_package",
      {
        title: "Install library package",
        description:
          "Install a local package folder, zip, tox, or manifest into a local tdmcp package directory.",
        inputSchema: installLibraryPackageSchema.shape,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      (args) => installLibraryPackageImpl(ctx, args),
    ),
];
