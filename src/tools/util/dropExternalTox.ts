import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult } from "../result.js";
import type { ToolContext } from "../types.js";
import { precheckToxCandidates } from "./toxCandidatePrecheck.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DropExternalToxOptions {
  /**
   * Existing parent COMP that will receive the inner baseCOMP. Must already exist
   * in TD — caller is responsible for creating it (typically via NetworkBuilder).
   */
  parent_path: string;
  /**
   * Name of the inner baseCOMP that wraps the loaded TOX.
   * Default: derived from the basename of `found_path` (e.g. `MediaPipe.tox` → `MediaPipe`).
   */
  container_name?: string;
  /**
   * Candidate absolute or project-relative paths, tried in order. First that
   * exists on disk wins. Project-relative paths resolve against `project.folder`.
   */
  candidate_paths: readonly string[];
  /**
   * Custom parameter NAMES (not labels) the loaded TOX must expose. Validated
   * via `op(container).par.<name>` after load. Pass `[]` to skip validation.
   */
  expected_custom_pars: readonly string[];
  /**
   * Behaviour when `expected_custom_pars` has misses.
   * - "warn" (default): include the missing names in `missing_pars` and warnings; succeed.
   * - "error": return `{ error: errorResult(...) }` with the report still inside the JSON fence.
   */
  on_missing?: "warn" | "error";
}

export interface DropExternalToxOk {
  /** Absolute filesystem path of the chosen .tox. */
  found_path: string;
  /** TouchDesigner path of the baseCOMP wrapping the loaded TOX (e.g. `/project1/MediaPipe`). */
  container_path: string;
  /** Custom par names that were present after load (subset of `expected_custom_pars`). */
  validated_pars: string[];
  /** Custom par names that were expected but missing. */
  missing_pars: string[];
  /** Non-fatal issues (e.g. "container already existed; reused"). */
  warnings: string[];
}

export type DropExternalToxResult = { ok: DropExternalToxOk } | { error: CallToolResult };

// ─── Internal bridge report shape ─────────────────────────────────────────────

interface DropExternalToxReport {
  error?: "parent_missing" | "no_candidate_found" | "load_failed";
  detail?: string;
  parent_path?: string;
  candidates_checked?: string[];
  found_path?: string;
  container_name?: string;
  container_path?: string;
  validated_pars?: string[];
  missing_pars?: string[];
  warnings: string[];
}

// ─── Python script template ───────────────────────────────────────────────────

const SCRIPT_TEMPLATE = `
import base64, json, os
_payload = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))

PARENT_PATH        = _payload["parent_path"]
CONTAINER_NAME_IN  = _payload.get("container_name")
CANDIDATES         = _payload["candidate_paths"]
EXPECTED_PARS      = _payload["expected_custom_pars"]

report = {"warnings": []}

# 1. Resolve parent
parent = op(PARENT_PATH)
if parent is None:
    report["error"] = "parent_missing"
    report["parent_path"] = PARENT_PATH
    print(json.dumps(report)); raise SystemExit

# 2. Walk candidates, first-existing wins (project-relative resolved against project.folder)
project_root = project.folder
found = None
for cand in CANDIDATES:
    if not cand: continue
    resolved = cand if os.path.isabs(cand) else os.path.normpath(os.path.join(project_root, cand))
    if os.path.exists(resolved) and resolved.lower().endswith(".tox"):
        found = resolved
        break

if found is None:
    report["error"] = "no_candidate_found"
    report["candidates_checked"] = list(CANDIDATES)
    print(json.dumps(report)); raise SystemExit
report["found_path"] = found

# 3. Derive container name if caller did not supply one
container_name = CONTAINER_NAME_IN or os.path.splitext(os.path.basename(found))[0]
import re as _re
container_name = _re.sub(r"[^A-Za-z0-9_]", "_", container_name) or "external_tox"
report["container_name"] = container_name

# 4. Load the TOX. Reuse an existing baseCOMP of the same name if present.
existing = parent.op(container_name)
if existing is not None:
    report["warnings"].append(f"Container {container_name!r} already existed; reusing.")
    container = existing
else:
    try:
        container = parent.loadTox(found)
        try: container.name = container_name
        except Exception: pass
    except Exception as e:
        report["error"] = "load_failed"
        report["detail"] = str(e)
        print(json.dumps(report)); raise SystemExit

report["container_path"] = container.path

# 5. Validate expected custom pars
validated, missing = [], []
for par_name in EXPECTED_PARS:
    if not par_name or not isinstance(par_name, str):
        report["warnings"].append(f"Ignoring invalid par name: {par_name!r}")
        continue
    p = getattr(container.par, par_name, None)
    if p is None:
        missing.append(par_name)
    else:
        validated.append(par_name)
report["validated_pars"] = validated
report["missing_pars"]   = missing

result = json.dumps(report)
print(result)
`;

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Standardises the community-TOX drop pattern: candidate-path walk →
 * `parent.loadTox` → custom-par validation. Returns a tagged-union result
 * so callers never have to catch.
 *
 * Usage in a Wave-4 wrapper:
 * ```ts
 * const r = await dropExternalTox(ctx, { parent_path, candidate_paths, expected_custom_pars });
 * if ("error" in r) return r.error;
 * const { container_path } = r.ok;
 * ```
 */
export async function dropExternalTox(
  ctx: ToolContext,
  opts: DropExternalToxOptions,
): Promise<DropExternalToxResult> {
  const { parent_path, container_name, candidate_paths, expected_custom_pars } = opts;
  const on_missing = opts.on_missing ?? "warn";

  ctx.logger.debug("dropExternalTox: resolving candidates", {
    count: candidate_paths.length,
  });

  // Round-2 Wave-4 fix: if every candidate is absolute AND none exist on disk,
  // short-circuit BEFORE calling the bridge. TD has been observed to hang the
  // app when an executePythonScript is issued under unrelated load (e.g. a
  // .tox import elsewhere in the session), so the safest behaviour when we
  // can prove the result locally is to skip the round-trip entirely.
  const precheck = precheckToxCandidates(candidate_paths);
  if (precheck.allAbsoluteAndMissing) {
    ctx.logger.debug("dropExternalTox: no absolute candidate exists; skipping bridge call", {
      checked: precheck.absoluteChecked,
    });
    return {
      error: errorResult(
        `No .tox found on disk in any candidate path. Tried: ${precheck.absoluteChecked.join(", ")}. ` +
          "Install the package or pass an explicit path.",
      ),
    };
  }

  const script = buildPayloadScript(SCRIPT_TEMPLATE, {
    parent_path,
    container_name: container_name ?? null,
    candidate_paths: Array.from(candidate_paths),
    expected_custom_pars: Array.from(expected_custom_pars),
  });

  let report: DropExternalToxReport;
  try {
    const exec = await ctx.client.executePythonScript(script, true);
    report = parsePythonReport<DropExternalToxReport>(exec.stdout);
  } catch (err) {
    return { error: errorResult(friendlyTdError(err)) };
  }

  // ── Bridge-side error codes ────────────────────────────────────────────────

  if (report.error === "parent_missing") {
    return {
      error: errorResult(
        `Parent COMP not found: ${report.parent_path ?? parent_path}. ` +
          "Create it first (e.g. via create_td_node) then re-run.",
      ),
    };
  }

  if (report.error === "no_candidate_found") {
    const tried = (report.candidates_checked ?? Array.from(candidate_paths)).join(", ");
    return {
      error: errorResult(
        `No .tox found in any candidate path. Tried: ${tried}. ` +
          "Install the package or pass an explicit path.",
      ),
    };
  }

  if (report.error === "load_failed") {
    return {
      error: errorResult(
        `Failed to load ${report.found_path ?? "TOX"} into ${parent_path}: ` +
          `${report.detail ?? "unknown error"}. ` +
          "Check the .tox is not corrupt and was saved from a compatible TD build.",
        report,
      ),
    };
  }

  // ── Missing-par handling ───────────────────────────────────────────────────

  const missing = report.missing_pars ?? [];
  const validated = report.validated_pars ?? [];
  const foundPath = report.found_path ?? "";
  const containerPath = report.container_path ?? "";
  const warnings = [...(report.warnings ?? [])];

  if (missing.length > 0) {
    ctx.logger.warn("dropExternalTox: missing custom pars", {
      found_path: foundPath,
      missing_pars: missing,
    });

    if (on_missing === "error") {
      return {
        error: errorResult(
          `Loaded ${foundPath} but the TOX did not expose required custom pars: ` +
            `${missing.join(", ")}. ` +
            "Confirm you have the right version of the TOX.",
          { validated_pars: validated, missing_pars: missing, container_path: containerPath },
        ),
      };
    }

    // on_missing === "warn" — add to warnings and succeed
    warnings.push(`Missing custom pars: ${missing.join(", ")}`);
  }

  ctx.logger.info("dropExternalTox: loaded", {
    found_path: foundPath,
    container_path: containerPath,
  });

  return {
    ok: {
      found_path: foundPath,
      container_path: containerPath,
      validated_pars: validated,
      missing_pars: missing,
      warnings,
    },
  };
}
