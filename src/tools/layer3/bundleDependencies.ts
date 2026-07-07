import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  buildCollectProjectAssetsScript,
  type collectProjectAssetsOutputSchema,
} from "./collectProjectAssets.js";

// ---------------------------------------------------------------------------
// bundle_dependencies — make a package self-contained.
//
// Delta vs make_portable_tox (which saves the .tox only) and
// collect_project_assets (which just *reports* external refs): this tool walks a
// COMP subtree for every external file reference (reusing the
// collect_project_assets scan), COPIES each existing asset into
// <out_dir>/assets/, optionally REWRITES the referencing parameter in the live
// network to the copied relative path (assets/<file>), then saves the COMP as a
// .tox beside its assets. The result is a folder you can hand to another machine
// and open without broken links.
// ---------------------------------------------------------------------------

export const bundleDependenciesSchema = z.object({
  comp_path: z
    .string()
    .describe("Full path of the COMP subtree to bundle (assets are gathered recursively)."),
  out_dir: z
    .string()
    .describe(
      "Local folder to write the self-contained package into (created if missing). The .tox and an assets/ subfolder land here.",
    ),
  name: z
    .string()
    .optional()
    .describe("Package/.tox stem. Defaults to the last path segment of comp_path."),
  rewrite_refs: z
    .boolean()
    .default(true)
    .describe(
      "When true, rewrite each referencing parameter in the LIVE network to the copied relative path (assets/<file>) BEFORE saving the .tox, so the saved component points at the bundled copies. When false, assets are copied but the network is left untouched (a report-and-copy pass).",
    ),
  include_missing: z
    .boolean()
    .default(false)
    .describe(
      "If true, still record assets whose source file is missing on disk (they cannot be copied and their ref is not rewritten). If false, missing refs are skipped with a warning.",
    ),
});
type BundleDependenciesArgs = z.infer<typeof bundleDependenciesSchema>;

export const bundleDependenciesOutputSchema = z.object({
  comp: z.string().describe("Echoed COMP path that was bundled."),
  out_dir: z.string().describe("Absolute package folder."),
  tox_path: z.string().describe("Absolute path of the saved .tox."),
  tox_bytes: z.number().nullable().describe("Size of the saved .tox in bytes, or null if unknown."),
  assets_copied: z
    .array(
      z.object({
        node: z.string(),
        par: z.string(),
        source: z.string(),
        relative: z.string().describe("Path inside the package, e.g. assets/clip.mov."),
        rewritten: z.boolean().describe("Whether the live parameter was rewritten to `relative`."),
      }),
    )
    .describe("Every external file that was copied into the package."),
  copied_count: z.number(),
  skipped: z
    .array(z.object({ node: z.string(), par: z.string(), value: z.string(), reason: z.string() }))
    .describe("Refs that were not bundled (missing source, or duplicate collision)."),
  manifest_path: z.string().describe("Absolute path of the tdmcp-component.json manifest written."),
  warnings: z.array(z.string()),
});

type CollectOut = z.infer<typeof collectProjectAssetsOutputSchema>;
interface CollectReport extends CollectOut {
  fatal?: string;
}

interface RewriteResult {
  node: string;
  par: string;
  ok: boolean;
  error?: string;
}
interface RewriteReport {
  results: RewriteResult[];
  fatal?: string;
}

// Rewrites a list of (node, par, value) triples in the live network. Fail-forward:
// a par that can't be set is collected as an error, never thrown.
const REWRITE_REFS_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"results": []}
try:
    for _r in _p["rewrites"]:
        _res = {"node": _r["node"], "par": _r["par"], "ok": False}
        try:
            _n = op(_r["node"])
            if _n is None:
                _res["error"] = "node not found"
            else:
                _par = getattr(_n.par, _r["par"], None)
                if _par is None:
                    _res["error"] = "par not found"
                else:
                    _par.val = _r["value"]
                    _res["ok"] = True
        except Exception as _e:
            _res["error"] = str(_e)
        report["results"].append(_res)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

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

interface SaveReport {
  saved?: string;
  size?: number | null;
  fatal?: string;
}

function safeStem(name: string): string {
  const cleaned = name
    .trim()
    .replace(/\.tox$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return cleaned || "component";
}

/** De-duplicates asset basenames so two `logo.png` from different folders don't collide. */
function uniqueBasename(source: string, used: Set<string>): string {
  const base = basename(source);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 1; ; i++) {
    const candidate = `${stem}_${i}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

interface CopiedAsset {
  node: string;
  par: string;
  source: string;
  relative: string;
  rewritten: boolean;
}
interface SkippedAsset {
  node: string;
  par: string;
  value: string;
  reason: string;
}

/**
 * Copy each existing asset into `assets/`, de-duplicating basenames. Missing sources
 * and copy failures are collected as `skipped` (fail-forward), never thrown.
 */
type Asset = NonNullable<CollectReport["assets"]>[number];

/** Copy one asset into `assets/`, returning either the copied or the skipped record. */
function copyOneAsset(
  a: Asset,
  assetsDir: string,
  used: Set<string>,
): { copied: CopiedAsset } | { skipped: SkippedAsset } {
  const target = uniqueBasename(a.value, used);
  try {
    copyFileSync(a.value, join(assetsDir, target));
    return {
      copied: {
        node: a.node,
        par: a.par,
        source: a.value,
        relative: `assets/${target}`,
        rewritten: false,
      },
    };
  } catch (err) {
    used.delete(target);
    const reason = `copy failed: ${err instanceof Error ? err.message : String(err)}`;
    return { skipped: { node: a.node, par: a.par, value: a.value, reason } };
  }
}

function copyAssets(
  assets: CollectReport["assets"],
  assetsDir: string,
  includeMissing: boolean,
  warnings: string[],
): { copied: CopiedAsset[]; skipped: SkippedAsset[] } {
  const used = new Set<string>();
  const copied: CopiedAsset[] = [];
  const skipped: SkippedAsset[] = [];
  for (const a of assets ?? []) {
    if (!a.exists) {
      skipped.push({ node: a.node, par: a.par, value: a.value, reason: "source missing" });
      // include_missing suppresses the not-bundled warning (the caller opted into
      // recording missing sources without treating them as a problem).
      if (!includeMissing) {
        warnings.push(`missing source, not bundled: ${a.value} (${a.node}.${a.par})`);
      }
      continue;
    }
    const result = copyOneAsset(a, assetsDir, used);
    if ("copied" in result) copied.push(result.copied);
    else skipped.push(result.skipped);
  }
  return { copied, skipped };
}

/**
 * Rewrite the live pars to their bundled relative paths and flag each copied asset as
 * `rewritten`. Fail-forward: a fatal pass or a per-par error becomes a warning.
 */
async function rewriteRefs(
  ctx: ToolContext,
  copied: CopiedAsset[],
  warnings: string[],
): Promise<void> {
  const rewriteExec = await ctx.client.executePythonScript(
    buildPayloadScript(REWRITE_REFS_SCRIPT, {
      rewrites: copied.map((c) => ({ node: c.node, par: c.par, value: c.relative })),
    }),
    true,
  );
  const rewrite = parsePythonReport<RewriteReport>(rewriteExec.stdout);
  if (rewrite.fatal) {
    warnings.push(`rewrite pass failed: ${rewrite.fatal} — assets copied but refs unchanged.`);
    return;
  }
  const byKey = new Map(rewrite.results.map((r) => [`${r.node} ${r.par}`, r]));
  for (const c of copied) {
    const r = byKey.get(`${c.node} ${c.par}`);
    if (r?.ok) c.rewritten = true;
    else if (r?.error) warnings.push(`rewrite ${c.node}.${c.par}: ${r.error}`);
  }
}

/** Build + write the tdmcp-component manifest listing the bundled tox + assets. */
function writeManifest(
  outDir: string,
  name: string,
  toxPath: string,
  comp_path: string,
  copied: CopiedAsset[],
): string {
  const manifest = {
    id: name,
    name,
    version: "0.1.0",
    type: "touchdesigner-component",
    tox: basename(toxPath),
    assets: [basename(toxPath), ...copied.map((c) => c.relative)],
    docs: [],
    recipes: [],
    generated_at: new Date().toISOString(),
    source_comp: comp_path,
  };
  const manifestPath = join(outDir, "tdmcp-component.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

/** Step 1: enumerate external refs (reuse the collect_project_assets scan). */
async function scanProjectAssets(ctx: ToolContext, compPath: string): Promise<CollectReport> {
  const collectExec = await ctx.client.executePythonScript(
    buildCollectProjectAssetsScript({ parent_path: compPath, include_missing_only: false }),
    true,
  );
  return parsePythonReport<CollectReport>(collectExec.stdout);
}

/** Step 4: save the COMP as a .tox beside its assets. */
async function saveTox(ctx: ToolContext, compPath: string, toxPath: string): Promise<SaveReport> {
  const saveExec = await ctx.client.executePythonScript(
    buildPayloadScript(SAVE_TOX_SCRIPT, { comp_path: compPath, tox_path: toxPath }),
    true,
  );
  return parsePythonReport<SaveReport>(saveExec.stdout);
}

export async function bundleDependenciesImpl(ctx: ToolContext, args: BundleDependenciesArgs) {
  const parsed = bundleDependenciesSchema.safeParse(args);
  if (!parsed.success) return errorResult(`Invalid arguments: ${parsed.error.message}`);
  const { comp_path, rewrite_refs, include_missing } = parsed.data;
  const name = safeStem(parsed.data.name ?? basename(comp_path));
  const outDir = resolve(parsed.data.out_dir);
  const assetsDir = join(outDir, "assets");
  const toxPath = join(outDir, `${name}.tox`);

  return guardTd(
    async () => {
      const warnings: string[] = [];
      // 1. Enumerate external refs (reuse the collect_project_assets scan).
      const collect = await scanProjectAssets(ctx, comp_path);
      if (collect.fatal) return { ok: false as const, fatal: collect.fatal, warnings };
      for (const w of collect.warnings ?? []) warnings.push(`scan: ${w}`);

      // 2. Copy each existing asset into assets/, tracking collisions + missing.
      mkdirSync(assetsDir, { recursive: true });
      const { copied, skipped } = copyAssets(collect.assets, assetsDir, include_missing, warnings);

      // 3. Rewrite the live pars to the relative bundled path (optional).
      if (rewrite_refs && copied.length > 0) {
        await rewriteRefs(ctx, copied, warnings);
      }

      // 4. Save the .tox beside its assets (points at the bundled copies when rewritten).
      const save = await saveTox(ctx, comp_path, toxPath);
      if (save.fatal) return { ok: false as const, fatal: save.fatal, warnings, copied, skipped };

      // 5. Manifest listing the bundled assets.
      const manifestPath = writeManifest(outDir, name, toxPath, comp_path, copied);

      return {
        ok: true as const,
        save,
        toxPath,
        outDir,
        manifestPath,
        copied,
        skipped,
        warnings,
      };
    },
    (data) => {
      if (!data.ok) {
        return errorResult(`bundle_dependencies failed: ${data.fatal}`, data);
      }
      const copied = data.copied;
      const rewrittenCount = copied.filter((c) => c.rewritten).length;
      const summary =
        `Bundled ${copied.length} asset(s) (${rewrittenCount} ref(s) rewritten) into ${data.outDir}` +
        `; saved ${basename(data.toxPath)}${data.skipped.length ? `, ${data.skipped.length} skipped` : ""}.`;
      return structuredResult(summary, {
        comp: comp_path,
        out_dir: data.outDir,
        tox_path: data.toxPath,
        tox_bytes: data.save.size ?? null,
        assets_copied: copied,
        copied_count: copied.length,
        skipped: data.skipped,
        manifest_path: data.manifestPath,
        warnings: data.warnings,
      });
    },
  );
}

export const registerBundleDependencies: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "bundle_dependencies",
    {
      title: "Bundle dependencies (self-contained package)",
      description:
        "Make a COMP self-contained: recursively scan its subtree for external file references (movie/image files, fonts, LUTs, externaltox links — reusing the collect_project_assets scan), COPY each existing asset into <out_dir>/assets/, rewrite each referencing parameter in the LIVE network to the copied relative path (assets/<file>), then save the COMP as a .tox beside its assets with a tdmcp-component manifest. The result is a folder you can move to another machine and open without broken links. Delta vs make_portable_tox (which saves the .tox only, leaving external assets behind) and collect_project_assets (which only reports refs). Rewriting mutates the live network — set rewrite_refs=false to copy-and-report without touching parameters.",
      inputSchema: bundleDependenciesSchema.shape,
      outputSchema: bundleDependenciesOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => bundleDependenciesImpl(ctx, args),
  );
};
