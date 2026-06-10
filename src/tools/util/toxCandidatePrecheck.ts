import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Result of a Node.js-side absolute-candidate existence pre-check.
 *
 * Round-2 Wave-4 fix: the TD bridge can hang indefinitely when an
 * `executePythonScript` is dispatched while TD is loading external resources,
 * so we want to avoid any bridge round-trip when we can prove from the host
 * filesystem alone that no candidate .tox exists.
 *
 * Only ABSOLUTE candidates are checked here (paths starting with `/`, `~`, or
 * a Windows drive letter). Project-relative candidates (resolved against
 * `project.folder` inside TD) are pass-through — we cannot evaluate them on
 * Node side, so the bridge call must still happen for those.
 */
export interface ToxCandidatePrecheckResult {
  /**
   * True when every candidate in the input is absolute AND none of them exist
   * on disk. Callers should short-circuit to a friendly error.
   */
  allAbsoluteAndMissing: boolean;
  /**
   * The candidates that were absolute (after `~` expansion). Useful for
   * including in friendly error messages so the user sees exactly what was
   * checked.
   */
  absoluteChecked: string[];
  /**
   * True when at least one candidate is project-relative — the bridge call
   * must proceed because we cannot resolve it here.
   */
  hasRelative: boolean;
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isAbsoluteCandidate(p: string): boolean {
  if (p.startsWith("/") || p.startsWith("~")) return true;
  // Windows drive letter (e.g. C:\foo)
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  return false;
}

/**
 * Walks the candidate list. For every absolute candidate (after `~`
 * expansion), checks `fs.existsSync` + `.tox` extension. Returns whether ALL
 * candidates were absolute AND none existed — the signal the caller uses to
 * skip the bridge round-trip entirely.
 *
 * Project-relative candidates (no `/`, no `~`, no drive letter) are tracked
 * via `hasRelative`; their presence forces the bridge call (since the bridge
 * resolves them against `project.folder`).
 */
export function precheckToxCandidates(
  candidate_paths: readonly string[],
): ToxCandidatePrecheckResult {
  const absoluteChecked: string[] = [];
  let hasRelative = false;
  let anyAbsoluteExists = false;

  for (const cand of candidate_paths) {
    if (!cand) continue;
    if (!isAbsoluteCandidate(cand)) {
      hasRelative = true;
      continue;
    }
    const resolved = expandHome(cand);
    absoluteChecked.push(resolved);
    if (resolved.toLowerCase().endsWith(".tox") && fs.existsSync(resolved)) {
      anyAbsoluteExists = true;
    }
  }

  const allAbsoluteAndMissing = !hasRelative && absoluteChecked.length > 0 && !anyAbsoluteExists;

  return { allAbsoluteAndMissing, absoluteChecked, hasRelative };
}
