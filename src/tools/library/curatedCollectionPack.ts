import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { basename, dirname, extname, join, posix, resolve, sep } from "node:path";
import { z } from "zod";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { checksumAndVerifyPackImpl } from "./checksumAndVerifyPack.js";
import { provenanceStampImpl } from "./provenanceStamp.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const PACK_MANIFEST_FILE = "pack.manifest.json";
const CHECKSUM_MANIFEST_FILE = "tdmcp-checksums.json";
const PACK_MANIFEST_KIND = "tdmcp-curated-pack";
const PACK_SCHEMA_VERSION = 1;
const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024; // 50 MB

const KIND_SUBDIR: Record<string, string> = {
  recipe: "recipes",
  component: "components",
  look: "looks",
  asset: "assets",
};

// ── Schema ────────────────────────────────────────────────────────────────────

const itemSchema = z.object({
  kind: z.enum(["recipe", "component", "look", "asset"]),
  path: z.string(),
  alias: z.string().optional(),
});

export const curatedCollectionPackSchema = z.object({
  action: z.enum(["pack", "unpack"]),
  name: z
    .string()
    .regex(/^[a-z0-9_-]+$/, "name must be slug-safe ([a-z0-9_-]+)")
    .describe("Pack identifier; becomes <name>.pack/ dir name."),
  out_dir: z
    .string()
    .describe("Absolute dir where the pack is written (pack) or restored into (unpack)."),
  pack_path: z
    .string()
    .optional()
    .describe("unpack only — path to existing <name>.pack/ or its pack.manifest.json."),
  items: z
    .array(itemSchema)
    .default([])
    .describe("pack only. Files to include. Empty is an error."),
  vault_path: z
    .string()
    .optional()
    .describe("Root for resolving relative items[].path. Falls back to TDMCP_VAULT_PATH env."),
  include_provenance: z
    .boolean()
    .default(true)
    .describe("Copy .provenance.json sidecars if present; else synthesize via provenanceStamp."),
  description: z.string().optional().describe("Free-form note baked into pack.manifest.json."),
  tags: z.array(z.string()).default([]).describe("Pack-level tags for search."),
  overwrite: z
    .boolean()
    .default(false)
    .describe("Replace existing pack dir (pack) or existing files in out_dir (unpack)."),
  verify_on_unpack: z
    .boolean()
    .default(true)
    .describe("unpack only — re-run checksumAndVerifyPack after copy and fail if not OK."),
});

export type CuratedCollectionPackArgs = z.infer<typeof curatedCollectionPackSchema>;

// ── PackManifest shape ────────────────────────────────────────────────────────

interface PackManifestItem {
  kind: string;
  source_path: string;
  pack_path: string;
  alias: string;
  sha256: string;
  size: number;
  provenance_path?: string;
}

interface PackManifest {
  kind: typeof PACK_MANIFEST_KIND;
  schema_version: typeof PACK_SCHEMA_VERSION;
  name: string;
  description?: string;
  tags: string[];
  created_at: string;
  tdmcp_version: string;
  author: string;
  items: PackManifestItem[];
  integrity_manifest: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tdmcpVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../../../package.json") as Record<string, unknown>;
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function resolveAuthor(): string {
  const env = process.env.TDMCP_AUTHOR;
  if (env) return env;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

function sha256File(filePath: string): string {
  const data = readFileSync(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function copyFile(src: string, dest: string): Promise<void> {
  const st = statSync(src);
  if (st.size > LARGE_FILE_THRESHOLD) {
    await new Promise<void>((res, rej) => {
      const rs = createReadStream(src);
      const ws = createWriteStream(dest);
      rs.on("error", rej);
      ws.on("error", rej);
      ws.on("close", res);
      rs.pipe(ws);
    });
  } else {
    copyFileSync(src, dest);
  }
}

function toPackPath(subdir: string, alias: string, ext: string): string {
  return posix.join(subdir, `${alias}${ext}`);
}

function safePackPath(packPath: string): boolean {
  // Reject anything with .. or absolute segments
  const parts = packPath.replace(/\\/g, "/").split("/");
  return !parts.some((p) => p === ".." || p === "");
}

function mapKindToArtifactKind(
  kind: string,
): "tox" | "recipe_note" | "recipe_bundle" | "component_bundle" | "other" {
  if (kind === "component") return "tox";
  if (kind === "recipe") return "recipe_bundle";
  return "other";
}

// ── Pack action ───────────────────────────────────────────────────────────────

async function packImpl(
  ctx: ToolContext,
  args: CuratedCollectionPackArgs,
): Promise<ReturnType<typeof structuredResult> | ReturnType<typeof errorResult>> {
  if (args.items.length === 0) {
    return errorResult("items must not be empty for action=pack");
  }

  const vaultRoot = args.vault_path ?? ctx.vault?.root ?? process.env.TDMCP_VAULT_PATH ?? undefined;

  // Resolve item paths
  const resolvedItems: Array<{ item: (typeof args.items)[number]; absPath: string }> = [];
  for (const item of args.items) {
    let absPath = item.path;
    if (!absPath.startsWith("/") && vaultRoot) {
      absPath = join(vaultRoot, item.path);
    }
    absPath = resolve(absPath);
    if (!existsSync(absPath)) {
      return errorResult(`Item not found: ${absPath} (original: ${item.path})`);
    }
    try {
      if (!statSync(absPath).isFile()) {
        return errorResult(`Item is not a file: ${absPath} (original: ${item.path})`);
      }
    } catch (err) {
      return errorResult(
        `Cannot stat item: ${absPath} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    resolvedItems.push({ item, absPath });
  }

  const packDir = join(args.out_dir, `${args.name}.pack`);

  if (existsSync(packDir)) {
    if (!args.overwrite) {
      return errorResult(`Pack dir already exists and overwrite=false: ${packDir}`);
    }
    rmSync(packDir, { recursive: true, force: true });
  }

  mkdirSync(packDir, { recursive: true });

  // Create subdirs
  for (const subdir of Object.values(KIND_SUBDIR)) {
    mkdirSync(join(packDir, subdir), { recursive: true });
  }

  const manifestItems: PackManifestItem[] = [];
  let totalBytes = 0;
  const seenPackPaths = new Set<string>();

  for (const { item, absPath } of resolvedItems) {
    const ext = extname(absPath);
    const rawBase = basename(absPath, ext);
    const alias = item.alias ?? rawBase;
    const subdir = KIND_SUBDIR[item.kind] ?? "assets";
    const packRelPath = toPackPath(subdir, alias, ext);
    if (seenPackPaths.has(packRelPath)) {
      return errorResult(
        `Duplicate pack destination: ${packRelPath} (set distinct alias per item)`,
      );
    }
    seenPackPaths.add(packRelPath);
    const destAbs = join(packDir, subdir, `${alias}${ext}`);

    await copyFile(absPath, destAbs);
    const hash = sha256File(destAbs);
    const size = statSync(destAbs).size;
    totalBytes += size;

    let provenancePath: string | undefined;

    if (args.include_provenance) {
      const srcSidecar = `${absPath}.provenance.json`;
      const destSidecar = `${destAbs}.provenance.json`;
      const packSidecarRel = `${packRelPath}.provenance.json`;

      if (existsSync(srcSidecar)) {
        copyFileSync(srcSidecar, destSidecar);
      } else {
        // Synthesize a minimal provenance sidecar
        await provenanceStampImpl(ctx, {
          artifact_path: destAbs,
          artifact_kind: mapKindToArtifactKind(item.kind),
          source: { tool: "curated_collection_pack" },
          tags: args.tags,
          overwrite: true,
          include_git: false,
          extra: {},
        });
      }
      provenancePath = packSidecarRel;
    }

    // Normalise to POSIX in manifest
    const posixPackPath = sep === "/" ? packRelPath : packRelPath.split(sep).join(posix.sep);

    manifestItems.push({
      kind: item.kind,
      source_path: absPath,
      pack_path: posixPackPath,
      alias,
      sha256: hash,
      size,
      ...(provenancePath !== undefined ? { provenance_path: provenancePath } : {}),
    });
  }

  // Write pack.manifest.json
  const packManifest: PackManifest = {
    kind: PACK_MANIFEST_KIND,
    schema_version: PACK_SCHEMA_VERSION,
    name: args.name,
    ...(args.description !== undefined ? { description: args.description } : {}),
    tags: args.tags,
    created_at: new Date().toISOString(),
    tdmcp_version: tdmcpVersion(),
    author: resolveAuthor(),
    items: manifestItems,
    integrity_manifest: CHECKSUM_MANIFEST_FILE,
  };

  const manifestPath = join(packDir, PACK_MANIFEST_FILE);
  writeFileSync(manifestPath, JSON.stringify(packManifest, null, 2), "utf8");

  // Compute checksums (exclude manifest + provenance sidecars — they are post-hoc)
  const checksumResult = await checksumAndVerifyPackImpl(ctx, {
    action: "compute",
    path: packDir,
    manifest_out: join(packDir, CHECKSUM_MANIFEST_FILE),
    exclude_globs: [
      "**/tdmcp-checksums.json",
      "**/.DS_Store",
      "**/node_modules/**",
      "**/.git/**",
      "**/pack.manifest.json",
      "**/*.provenance.json",
    ],
    include_globs: [],
    follow_symlinks: false,
    max_file_bytes: 2 * 1024 * 1024 * 1024,
    strict: true,
  });

  if (checksumResult.isError) {
    return errorResult(
      `Pack created but checksum compute failed: ${(checksumResult.content[0] as { text?: string })?.text ?? "unknown"}`,
    );
  }

  const integrityPath = join(packDir, CHECKSUM_MANIFEST_FILE);

  return structuredResult(
    `Packed ${manifestItems.length} item(s) into ${packDir} (${totalBytes} bytes total).`,
    {
      pack_path: packDir,
      manifest_path: manifestPath,
      integrity_manifest_path: integrityPath,
      item_count: manifestItems.length,
      total_bytes: totalBytes,
    },
  );
}

// ── Unpack action ─────────────────────────────────────────────────────────────

async function unpackImpl(
  ctx: ToolContext,
  args: CuratedCollectionPackArgs,
): Promise<ReturnType<typeof structuredResult> | ReturnType<typeof errorResult>> {
  // Resolve pack dir
  let packDir: string;
  if (args.pack_path) {
    const resolved = resolve(args.pack_path);
    // If pointed at the manifest file, use its dir
    packDir = resolved.endsWith(PACK_MANIFEST_FILE) ? dirname(resolved) : resolved;
  } else {
    packDir = join(args.out_dir, `${args.name}.pack`);
  }

  if (!existsSync(packDir)) {
    return errorResult(`Pack dir not found: ${packDir}`);
  }

  const manifestPath = join(packDir, PACK_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    return errorResult(`pack.manifest.json not found in: ${packDir}`);
  }

  let manifest: PackManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackManifest;
  } catch (err) {
    return errorResult(
      `Failed to parse pack.manifest.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (manifest.kind !== PACK_MANIFEST_KIND) {
    return errorResult(
      `Unknown pack kind: "${manifest.kind ?? "(missing)"}". Expected "${PACK_MANIFEST_KIND}".`,
    );
  }
  if (manifest.schema_version !== PACK_SCHEMA_VERSION) {
    return errorResult(`Unsupported pack schema_version: ${manifest.schema_version}`);
  }

  // Verify integrity before restoring
  let verifyOutput: { ok?: boolean } | undefined;
  if (args.verify_on_unpack) {
    const vResult = await checksumAndVerifyPackImpl(ctx, {
      action: "verify",
      path: packDir,
      exclude_globs: [
        "**/tdmcp-checksums.json",
        "**/.DS_Store",
        "**/node_modules/**",
        "**/.git/**",
        "**/pack.manifest.json",
        "**/*.provenance.json",
      ],
      include_globs: [],
      follow_symlinks: false,
      max_file_bytes: 2 * 1024 * 1024 * 1024,
      strict: false, // extra files (sidecars) are OK
    });

    if (vResult.isError) {
      return errorResult(
        `Integrity verification failed before unpack: ${(vResult.content[0] as { text?: string })?.text ?? "unknown"}`,
      );
    }
    verifyOutput = (vResult as { structuredContent?: { ok?: boolean } }).structuredContent ?? {};
    if (verifyOutput.ok === false) {
      return errorResult(
        `Pack integrity check failed — not restoring. Run checksum_and_verify_pack action=verify on ${packDir} for details.`,
      );
    }
  }

  const dest = args.out_dir;
  mkdirSync(dest, { recursive: true });

  let restoredCount = 0;

  for (const item of manifest.items) {
    // Security: reject path traversal
    if (!safePackPath(item.pack_path)) {
      return errorResult(
        `Rejected unsafe pack_path (path traversal detected): "${item.pack_path}"`,
      );
    }

    const srcAbs = join(packDir, item.pack_path.split(posix.sep).join(sep));
    const destAbs = join(dest, item.pack_path.split(posix.sep).join(sep));

    if (!existsSync(srcAbs)) {
      return errorResult(`Packed file missing: ${srcAbs} (pack_path: ${item.pack_path})`);
    }

    // Reject symlinks (could escape packDir).
    try {
      if (lstatSync(srcAbs).isSymbolicLink()) {
        return errorResult(`Symlinked entry rejected: ${item.pack_path}`);
      }
    } catch (err) {
      return errorResult(
        `Cannot lstat packed entry: ${srcAbs} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    // Ensure realpath is inside packDir.
    try {
      const realSrc = realpathSync(srcAbs);
      const realPack = realpathSync(packDir);
      const realPackWithSep = realPack.endsWith(sep) ? realPack : realPack + sep;
      if (realSrc !== realPack && !realSrc.startsWith(realPackWithSep)) {
        return errorResult(`Packed entry escapes pack dir: ${item.pack_path}`);
      }
    } catch (err) {
      return errorResult(
        `Cannot resolve realpath: ${srcAbs} (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    if (existsSync(destAbs) && !args.overwrite) {
      return errorResult(`Destination file already exists and overwrite=false: ${destAbs}`);
    }

    mkdirSync(dirname(destAbs), { recursive: true });
    await copyFile(srcAbs, destAbs);
    restoredCount++;
  }

  return structuredResult(`Restored ${restoredCount} item(s) to ${dest}.`, {
    restored_count: restoredCount,
    dest,
    verify: verifyOutput ?? null,
  });
}

// ── Public impl ───────────────────────────────────────────────────────────────

export async function curatedCollectionPackImpl(
  ctx: ToolContext,
  args: CuratedCollectionPackArgs,
): Promise<ReturnType<typeof structuredResult> | ReturnType<typeof errorResult>> {
  try {
    if (args.action === "pack") {
      return await packImpl(ctx, args);
    }
    return await unpackImpl(ctx, args);
  } catch (err) {
    return errorResult(
      `curated_collection_pack internal error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Registrar ─────────────────────────────────────────────────────────────────

export const registerCuratedCollectionPack: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "curated_collection_pack",
    {
      title: "Curated Collection Pack",
      description:
        "Bundles a curated, hand-picked set of vault assets (recipes, components, looks, raw " +
        "assets) into a single portable, shareable pack with provenance + integrity. " +
        "action=pack gathers items into a <name>.pack/ directory tree with a JSON manifest and " +
        "checksum manifest. action=unpack restores the tree, optionally verifying integrity. " +
        "Fully offline — no TD bridge required.",
      inputSchema: curatedCollectionPackSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (callArgs) => curatedCollectionPackImpl(ctx, callArgs),
  );
