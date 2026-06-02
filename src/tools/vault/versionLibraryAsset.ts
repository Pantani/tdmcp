import { z } from "zod";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { readNoteSafe, requireVault } from "./shared.js";

// License tier enum — free-form bucket complementing the SPDX id.
export const LICENSE_TIERS = [
  "public-domain",
  "permissive",
  "copyleft",
  "proprietary",
  "unknown",
] as const;
export const licenseTierSchema = z.enum(LICENSE_TIERS);
export type LicenseTier = (typeof LICENSE_TIERS)[number];

// SPDX id: short token, conservative shape (letters/digits/dot/dash/plus).
export const spdxIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9.+\-]+$/, "spdx id may only contain letters, digits, '.', '+', '-'");

/**
 * `version_library_asset` — semver bump + change history for a vault library
 * asset (a recipe or component note). State lives in a sidecar JSON next to the
 * note: `<asset>.versions.json`. The note's frontmatter `version` is updated to
 * the new version on each bump so `browse_vault_library`/`tag_and_search_library`
 * can surface it. Pure vault I/O — no TouchDesigner bridge required.
 *
 * Sidecar shape:
 * ```json
 * {
 *   "asset_path": "Recipes/feedback_tunnel.md",
 *   "current": "1.2.0",
 *   "history": [
 *     { "version": "1.2.0", "bump": "minor", "note": "...", "timestamp": "..." },
 *     { "version": "1.1.0", "bump": "minor", "note": "...", "timestamp": "..." }
 *   ]
 * }
 * ```
 */

export const versionLibraryAssetSchema = z.object({
  asset_path: z
    .string()
    .describe(
      "Vault-relative path to the asset note (e.g. 'Recipes/feedback_tunnel.md' or 'Components/foo.md').",
    ),
  bump: z
    .enum(["patch", "minor", "major"])
    .default("patch")
    .describe(
      "SemVer bump kind. patch=0.0.X, minor=0.X.0 (resets patch), major=X.0.0 (resets minor+patch).",
    ),
  note: z.string().optional().describe("Short human note describing what changed in this version."),
  read_only: z
    .boolean()
    .default(false)
    .describe(
      "When true, do not bump — just read and return the current version + history (`bump`/`note` ignored).",
    ),
  license: spdxIdSchema
    .optional()
    .describe(
      "SPDX-id (e.g. 'MIT', 'CC-BY-4.0', 'LicenseRef-Custom'). Written to note frontmatter AND mirrored into the sidecar. Omit to leave the existing value untouched.",
    ),
  license_tier: licenseTierSchema
    .optional()
    .describe(
      "License bucket: public-domain | permissive | copyleft | proprietary | unknown. Mirrors into frontmatter + sidecar.",
    ),
});
export type VersionLibraryAssetArgs = z.infer<typeof versionLibraryAssetSchema>;

interface VersionHistoryEntry {
  version: string;
  bump: "patch" | "minor" | "major" | "initial";
  note?: string;
  timestamp: string;
}
interface VersionSidecar {
  asset_path: string;
  current: string;
  history: VersionHistoryEntry[];
  license?: string;
  license_tier?: LicenseTier;
}

const SIDECAR_SUFFIX = ".versions.json";

function sidecarPathFor(assetPath: string): string {
  // Replace trailing `.md` (or any extension) with `.versions.json`.
  // For files without an extension, just append.
  const dot = assetPath.lastIndexOf(".");
  const slash = assetPath.lastIndexOf("/");
  if (dot > slash) return `${assetPath.slice(0, dot)}${SIDECAR_SUFFIX}`;
  return `${assetPath}${SIDECAR_SUFFIX}`;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function parseSemver(v: string): [number, number, number] | null {
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function nextVersion(current: string, bump: "patch" | "minor" | "major"): string {
  const parsed = parseSemver(current);
  const [major, minor, patch] = parsed ?? [0, 0, 0];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export const registerVersionLibraryAsset: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "version_library_asset",
    {
      title: "Version-bump a vault library asset",
      description:
        "Apply a SemVer patch/minor/major bump to a vault recipe or component note, recording the change " +
        "in a sidecar `<asset>.versions.json` (asset_path + current + history list with version/bump/note/timestamp) " +
        "and writing the new version into the note's frontmatter `version` field. Pass `read_only:true` to inspect " +
        "the sidecar without bumping. Pure vault I/O — no TouchDesigner bridge required. Requires TDMCP_VAULT_PATH.",
      inputSchema: versionLibraryAssetSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => versionLibraryAssetImpl(ctx, args),
  );
};

type SidecarLoad =
  | { kind: "missing" }
  | { kind: "ok"; sidecar: VersionSidecar }
  | { kind: "malformed"; reason: string };

function loadSidecar(
  vault: { exists: (p: string) => boolean; read: (p: string) => string },
  sidecarPath: string,
): SidecarLoad {
  if (!vault.exists(sidecarPath)) return { kind: "missing" };
  let raw: string;
  try {
    raw = vault.read(sidecarPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: "malformed", reason: `unreadable: ${reason}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: "malformed", reason: `invalid JSON: ${reason}` };
  }
  if (!parsed || typeof parsed !== "object") {
    return { kind: "malformed", reason: "expected a JSON object at the top level" };
  }
  const obj = parsed as Partial<VersionSidecar>;
  if (typeof obj.current !== "string") {
    return { kind: "malformed", reason: "missing or non-string `current` field" };
  }
  if (!parseSemver(obj.current)) {
    return {
      kind: "malformed",
      reason: `\`current\` is not a valid SemVer: ${JSON.stringify(obj.current)}`,
    };
  }
  if (!Array.isArray(obj.history)) {
    return { kind: "malformed", reason: "missing or non-array `history` field" };
  }
  const sidecar: VersionSidecar = {
    asset_path: typeof obj.asset_path === "string" ? obj.asset_path : "",
    current: obj.current,
    history: obj.history as VersionHistoryEntry[],
  };
  if (typeof obj.license === "string") sidecar.license = obj.license;
  if (
    typeof obj.license_tier === "string" &&
    (LICENSE_TIERS as readonly string[]).includes(obj.license_tier)
  ) {
    sidecar.license_tier = obj.license_tier as LicenseTier;
  }
  return { kind: "ok", sidecar };
}

export async function versionLibraryAssetImpl(ctx: ToolContext, args: VersionLibraryAssetArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  let assetExists: boolean;
  try {
    assetExists = vault.exists(args.asset_path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`Invalid vault path: ${reason}`);
  }
  if (!assetExists) {
    return errorResult(`Vault asset not found: ${args.asset_path}`);
  }
  const note = readNoteSafe(vault, args.asset_path);
  if ("error" in note) return note.error;

  const sidecarPath = sidecarPathFor(args.asset_path);
  const loaded = loadSidecar(vault, sidecarPath);
  if (loaded.kind === "malformed") {
    return errorResult(
      `Refusing to proceed: existing sidecar "${sidecarPath}" is malformed (${loaded.reason}). ` +
        `Fix or delete the file so version history isn't overwritten.`,
    );
  }
  const existing = loaded.kind === "ok" ? loaded.sidecar : null;

  if (args.read_only) {
    // When there's no sidecar, only accept a frontmatter `version` that's a
    // valid SemVer — otherwise fall back to "0.0.0", matching the bumping path.
    const frontmatterVersion =
      typeof note.data.version === "string" && parseSemver(note.data.version)
        ? note.data.version
        : "0.0.0";
    const current = existing?.current ?? frontmatterVersion;
    const readLicense =
      existing?.license ?? (typeof note.data.license === "string" ? note.data.license : null);
    const readTier =
      existing?.license_tier ??
      (typeof note.data.license_tier === "string" &&
      (LICENSE_TIERS as readonly string[]).includes(note.data.license_tier)
        ? (note.data.license_tier as LicenseTier)
        : null);
    return jsonResult(`Read current version ${current} for ${args.asset_path}.`, {
      asset_path: args.asset_path,
      sidecar_path: sidecarPath,
      current,
      history: existing?.history ?? [],
      has_sidecar: existing !== null,
      license: readLicense,
      license_tier: readTier,
    });
  }

  const startVersion =
    existing?.current ??
    (typeof note.data.version === "string" && parseSemver(note.data.version)
      ? (note.data.version as string)
      : "0.0.0");
  const newVersion = nextVersion(startVersion, args.bump);
  const timestamp = new Date().toISOString();

  const historyEntry: VersionHistoryEntry = {
    version: newVersion,
    bump: args.bump,
    timestamp,
  };
  if (args.note) historyEntry.note = args.note;

  // If no sidecar yet and the note already had a version that doesn't match startVersion,
  // we still root the history at startVersion → newVersion.
  const baseHistory = existing?.history ?? [];
  if (!existing && startVersion !== "0.0.0") {
    baseHistory.unshift({
      version: startVersion,
      bump: "initial",
      note: "Pre-existing version captured from frontmatter.",
      timestamp,
    });
  }
  const nextHistory = [historyEntry, ...baseHistory];

  // Resolve effective license: explicit arg > existing sidecar > existing frontmatter > undefined
  const effectiveLicense =
    args.license ??
    existing?.license ??
    (typeof note.data.license === "string" ? note.data.license : undefined);
  const effectiveTier =
    args.license_tier ??
    existing?.license_tier ??
    (typeof note.data.license_tier === "string" &&
    (LICENSE_TIERS as readonly string[]).includes(note.data.license_tier)
      ? (note.data.license_tier as LicenseTier)
      : undefined);

  const sidecar: VersionSidecar = {
    asset_path: args.asset_path,
    current: newVersion,
    history: nextHistory,
    ...(effectiveLicense !== undefined ? { license: effectiveLicense } : {}),
    ...(effectiveTier !== undefined ? { license_tier: effectiveTier } : {}),
  };

  // Persist sidecar.
  try {
    vault.write(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`Could not write version sidecar "${sidecarPath}": ${reason}`);
  }

  // Update the note's frontmatter `version` (and license fields if present).
  const nextData = {
    ...note.data,
    version: newVersion,
    ...(effectiveLicense !== undefined ? { license: effectiveLicense } : {}),
    ...(effectiveTier !== undefined ? { license_tier: effectiveTier } : {}),
  };
  try {
    vault.writeNote(args.asset_path, nextData, note.body);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`Could not update note frontmatter "${args.asset_path}": ${reason}`);
  }

  return jsonResult(`Bumped ${args.asset_path}: ${startVersion} → ${newVersion} (${args.bump}).`, {
    asset_path: args.asset_path,
    sidecar_path: sidecarPath,
    previous: startVersion,
    current: newVersion,
    bump: args.bump,
    note: args.note ?? null,
    timestamp,
    history: nextHistory,
    license: effectiveLicense ?? null,
    license_tier: effectiveTier ?? null,
  });
}
