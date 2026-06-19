import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { TdmcpConfig } from "../utils/config.js";
import type { DoctorCheck } from "./doctor.js";

/**
 * Project RAG doctor check.
 *
 * The point of this probe is a single informative nudge: when an on-disk
 * Project RAG index already exists but `TDMCP_PROJECT_RAG_ENABLED` has been
 * turned off, the index is silently ignored. Without this check `tdmcp doctor`
 * gives no hint that previously-ingested project knowledge is dormant. It is
 * never critical and never fails — at worst it warns.
 */

/** Injected probe for testability (no real fs in unit tests). */
export interface ProjectRagProbes {
  /** Returns the index file size in bytes, or null when it does not exist. */
  indexSize?: (filePath: string) => number | null;
}

/** Expand a leading `~/` the same way doctor.ts / doctorCreativeRag.ts do. */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith(`~${sep}`)) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the JSONL index path. Mirrors storeFactory.ts: the Project RAG store
 * lives at `<ragDataDir>/project/index.jsonl`.
 */
export function projectRagIndexPath(config: TdmcpConfig): string {
  // Fall back to the schema default so a partially-built config (or a missing
  // override) never crashes the diagnostic — it just resolves the default path.
  const root = resolve(expandHome(config.ragDataDir ?? ".tdmcp/creative-rag"));
  return join(root, "project", "index.jsonl");
}

/** Default fs probe: stat the file, treat a missing file as "no index". */
function defaultIndexSize(filePath: string): number | null {
  try {
    return statSync(filePath).size;
  } catch (err) {
    // Only a missing file means "no index". Any other I/O error must surface
    // rather than masquerade as an absent index.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Single Project RAG check. Pass when enabled (the index is live) or when
 * disabled with no index on disk. Warn only in the dormant-index case.
 */
export function checkProjectRag(config: TdmcpConfig, probes?: ProjectRagProbes): DoctorCheck {
  const base: Omit<DoctorCheck, "status" | "detail"> = {
    id: "project_rag",
    title: "Project RAG — status",
    critical: false,
  };

  // Project RAG is the AND of both gating flags (see toProjectRagConfig in
  // src/projectRag/cli.ts): the master Creative-RAG switch must also be on.
  // With TDMCP_RAG_ENABLED unset, an existing index is dormant even though
  // projectRagEnabled defaults to true — that is exactly the case to nudge.
  if (config.ragEnabled && config.projectRagEnabled) {
    return {
      ...base,
      status: "pass",
      detail: "enabled (TDMCP_RAG_ENABLED + TDMCP_PROJECT_RAG_ENABLED on).",
      data: { enabled: true },
    };
  }

  // Name the flag(s) actually holding it off so the nudge is actionable.
  const offFlag = !config.ragEnabled ? "TDMCP_RAG_ENABLED" : "TDMCP_PROJECT_RAG_ENABLED";

  const indexPath = projectRagIndexPath(config);
  let indexSize: number | null;
  try {
    indexSize = (probes?.indexSize ?? defaultIndexSize)(indexPath);
  } catch (err) {
    // This check is non-critical — a permission/I/O error inspecting the index
    // (EACCES, EPERM, …) must degrade to a visible warn, never abort `doctor`.
    const code = (err as NodeJS.ErrnoException)?.code ?? "I/O error";
    return {
      ...base,
      status: "warn",
      detail: `could not inspect ${indexPath} (${code}) while ${offFlag} is off.`,
      data: { enabled: false, indexFound: false, indexPath, offFlag, errorCode: code },
    };
  }

  // A zero-byte file is an empty index — nothing dormant to nudge about.
  if (indexSize === null || indexSize === 0) {
    return {
      ...base,
      status: "pass",
      detail: `not enabled (${offFlag} off), no on-disk index — skipped.`,
      data: { enabled: false, indexFound: false, offFlag },
    };
  }

  return {
    ...base,
    status: "warn",
    detail: `on-disk index found at ${indexPath} but ${offFlag} is off — the indexed project knowledge is being ignored.`,
    data: { enabled: false, indexFound: true, indexPath, indexBytes: indexSize, offFlag },
  };
}

/** Run all Project RAG checks (currently one). */
export function runProjectRagChecks(config: TdmcpConfig, probes?: ProjectRagProbes): DoctorCheck[] {
  return [checkProjectRag(config, probes)];
}

/** Suggest remediation for Project RAG check ids. Returns undefined for pass / unknown ids. */
export function suggestFixProjectRag(check: DoctorCheck, _config: TdmcpConfig): string | undefined {
  if (check.status === "pass") return undefined;
  if (check.id === "project_rag") {
    const offFlag =
      typeof check.data?.offFlag === "string" ? check.data.offFlag : "TDMCP_PROJECT_RAG_ENABLED";
    return `Set ${offFlag}=1 (Project RAG needs both TDMCP_RAG_ENABLED and TDMCP_PROJECT_RAG_ENABLED) to use the existing index, or delete it if you no longer need it.`;
  }
  return undefined;
}
