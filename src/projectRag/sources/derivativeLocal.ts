/**
 * Project RAG — Derivative local install source adapter.
 *
 * Enumerates `.tox`/`.toe` files from the user's installed TouchDesigner
 * (Palette + OP Snippets). Each file becomes one {@link RawProjectItem} with
 * mandatory provenance and `Derivative-EULA` license.
 *
 * Hard rules:
 *  - NEVER open/execute/spawn any `.tox`/`.toe`. Directory metadata only.
 *  - NEVER set `binaryUrl`. The bytes are not redistributable under the Derivative EULA.
 *  - When no install directory is found, throws {@link SourceSkippedError} so
 *    cards from other sources are never tombstoned.
 *  - No child_process, no exec, no network I/O — pure node:fs + node:path + node:os.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SourceSkippedError } from "./errors.js";
import type { RawProjectItem, SourceAdapter, SourceAdapterContext } from "./types.js";

const SOURCE_URL = "https://derivative.ca/UserGuide/Palette";
const RIGHTS_NOTES =
  "Shipped with TouchDesigner under the Derivative EULA. Local use only — not redistributable. Do not set binaryUrl. See https://derivative.ca/eula";
const MAX_DEPTH = 6;

export interface DerivativeLocalOptions {
  /**
   * Explicit override for the TD install root (the directory that contains the
   * Palette/Samples trees). Supplied by the registry/config layer from env var
   * TDMCP_PROJECT_RAG_DERIVATIVE_ROOT — the adapter does NOT read env vars
   * directly; that plumbing lives in resolveProjectSources / config.ts.
   */
  installRoot?: string;
}

/** Build the ordered list of candidate paths for the given platform. */
export function buildCandidatePaths(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    const base = "/Applications/TouchDesigner.app/Contents/Resources/Samples";
    return [`${base}/Palette`, `${base}/OP Snippets`, base];
  }
  if (platform === "win32") {
    const home = os.homedir();
    const sys = "C:\\Program Files\\Derivative\\TouchDesigner\\Samples";
    return [
      `${sys}\\Palette`,
      `${sys}\\OP Snippets`,
      sys,
      `${home}\\Documents\\Derivative\\TouchDesigner\\Samples\\Palette`,
      `${home}\\Documents\\Derivative\\TouchDesigner\\Samples`,
    ];
  }
  if (platform === "linux") {
    const base = "/opt/derivative/TouchDesigner/Samples";
    return [`${base}/Palette`, `${base}/OP Snippets`, base];
  }
  return [];
}

/** Resolve the install root from an explicit override or OS candidate paths. */
export function discoverInstallRoot(
  installRoot: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  if (installRoot !== undefined && installRoot.length > 0) return installRoot;
  const candidates = buildCandidatePaths(platform);
  return candidates.find((p) => fs.existsSync(p));
}

/** Recursively walk `rootDir`, returning absolute paths of `.tox`/`.toe` files. */
export function enumerateAssets(rootDir: string): string[] {
  const results: string[] = [];
  walk(rootDir, 0, results);
  return results;
}

function walk(dir: string, depth: number, results: string[]): void {
  if (depth > MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, depth + 1, results);
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (lower.endsWith(".tox") || lower.endsWith(".toe")) {
        results.push(fullPath);
      }
    }
  }
}

/** Compute tag array based on the path segments of the asset. */
function buildTags(absolutePath: string): string[] {
  const normalized = absolutePath.replace(/\\/g, "/");
  if (normalized.includes("/Palette")) return ["derivative", "palette"];
  if (normalized.includes("/OP Snippets")) return ["derivative", "op-snippets"];
  return ["derivative"];
}

/** Construct one RawProjectItem from an absolute file path. */
export function buildItem(absolutePath: string, rootDir: string): RawProjectItem {
  const relPath = path.relative(rootDir, absolutePath).replace(/\\/g, "/");
  const ext = path.extname(absolutePath).toLowerCase();
  return {
    sourceName: `derivative-local:${relPath}`,
    sourceUrl: SOURCE_URL,
    canonical: `derivative-local:${relPath}`,
    title: path.basename(absolutePath),
    type: ext === ".tox" ? "component" : "project",
    tags: buildTags(absolutePath),
    license: "Derivative-EULA",
    licenseConfidence: "declared",
    rightsNotes: RIGHTS_NOTES,
    authors: ["Derivative"],
    files: [path.basename(absolutePath)],
  };
}

/** Factory — returns a SourceAdapter that enumerates the local TD install. */
export function derivativeLocalSource(options?: DerivativeLocalOptions): SourceAdapter {
  return {
    name: "derivative-local",
    displayName: "Derivative local install (TouchDesigner Palette + OP Snippets)",
    async fetchItems(limit: number, _ctx: SourceAdapterContext): Promise<RawProjectItem[]> {
      const root = discoverInstallRoot(options?.installRoot, process.platform);
      if (root === undefined) {
        throw new SourceSkippedError(
          "derivative-local",
          "No TouchDesigner install directory found. " +
            "Set TDMCP_PROJECT_RAG_DERIVATIVE_ROOT to point to your TD Samples directory.",
        );
      }
      const allPaths = enumerateAssets(root);
      const sliced = limit > 0 ? allPaths.slice(0, limit) : allPaths;
      return sliced.map((p) => buildItem(p, root));
    },
  };
}
