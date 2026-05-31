import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ── Schema ──────────────────────────────────────────────────────────────────

const fileEntry = z.object({
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
});

export const checksumAndVerifyPackSchema = z.object({
  action: z.enum(["compute", "verify"]),
  path: z.string(),
  manifest: z
    .object({
      files: z.array(fileEntry),
      created_at: z.string(),
      tdmcp_version: z.string(),
      root: z.string().optional(),
    })
    .optional(),
  manifest_out: z.string().optional(),
  include_globs: z.array(z.string()).default([]),
  exclude_globs: z
    .array(z.string())
    .default(["**/tdmcp-checksums.json", "**/.DS_Store", "**/node_modules/**", "**/.git/**"]),
  follow_symlinks: z.boolean().default(false),
  max_file_bytes: z
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024 * 1024),
  strict: z.boolean().default(true),
});

export type ChecksumAndVerifyPackArgs = z.infer<typeof checksumAndVerifyPackSchema>;

// ── Manifest shape ───────────────────────────────────────────────────────────

interface ChecksumManifest {
  kind: "tdmcp-checksum-manifest";
  version: 1;
  tdmcp_version: string;
  created_at: string;
  root?: string;
  files: Array<{ path: string; sha256: string; size: number }>;
}

const MANIFEST_KIND = "tdmcp-checksum-manifest";
const MANIFEST_FILE = "tdmcp-checksums.json";

// ── Glob helper (no external dep) ───────────────────────────────────────────

function globToRegExp(glob: string): RegExp {
  // Converts minimatch-style glob to RegExp (POSIX paths assumed).
  let src = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // '**/' matches zero or more path segments
        src += ".*";
        i += 2;
        if (glob[i] === "/") i++;
      } else {
        src += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      src += "[^/]";
      i++;
    } else if (c === ".") {
      src += "\\.";
      i++;
    } else if ("{[()^$|\\+".includes(c ?? "")) {
      src += `\\${c}`;
      i++;
    } else {
      src += c;
      i++;
    }
  }
  return new RegExp(`^${src}$`);
}

function matchesGlob(posixPath: string, glob: string): boolean {
  const re = globToRegExp(glob);
  // Match against full path or just the basename component
  return re.test(posixPath) || re.test(posixPath.replace(/^.*\//, ""));
}

function isExcluded(posixPath: string, excludes: string[]): boolean {
  return excludes.some((g) => matchesGlob(posixPath, g));
}

function isIncluded(posixPath: string, includes: string[]): boolean {
  if (includes.length === 0) return true;
  return includes.some((g) => matchesGlob(posixPath, g));
}

// ── SHA-256 streaming ────────────────────────────────────────────────────────

async function hashFile(absPath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(absPath, { highWaterMark: 1 << 20 });
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

// ── Directory walk ───────────────────────────────────────────────────────────

function walkDir(
  rootAbs: string,
  args: Pick<
    ChecksumAndVerifyPackArgs,
    "include_globs" | "exclude_globs" | "follow_symlinks" | "max_file_bytes"
  >,
): Array<{ absPath: string; posixRel: string; size: number }> | string {
  const results: Array<{ absPath: string; posixRel: string; size: number }> = [];
  const queue: string[] = [rootAbs];

  while (queue.length > 0) {
    const dir = queue.shift() ?? "";
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const absPath = join(dir, entry.name);
      const rawRel = relative(rootAbs, absPath);
      // Normalise to POSIX separators
      const posixRel = sep === "/" ? rawRel : rawRel.split(sep).join(posix.sep);

      if (entry.isSymbolicLink()) {
        if (!args.follow_symlinks) continue;
        // Symlink: stat the target
        const st = statSync(absPath);
        if (!st.isFile()) continue;
        if (isExcluded(posixRel, args.exclude_globs)) continue;
        if (!isIncluded(posixRel, args.include_globs)) continue;
        if (st.size > args.max_file_bytes) return `File exceeds max_file_bytes: ${posixRel}`;
        results.push({ absPath, posixRel, size: st.size });
        continue;
      }

      if (entry.isDirectory()) {
        queue.push(absPath);
        continue;
      }

      if (!entry.isFile()) continue;

      if (isExcluded(posixRel, args.exclude_globs)) continue;
      if (!isIncluded(posixRel, args.include_globs)) continue;

      const st = statSync(absPath);
      if (st.size > args.max_file_bytes) return `File exceeds max_file_bytes: ${posixRel}`;
      results.push({ absPath, posixRel, size: st.size });
    }
  }

  return results;
}

// ── Compute action ───────────────────────────────────────────────────────────

async function computeChecksums(
  ctx: ToolContext,
  args: ChecksumAndVerifyPackArgs,
): Promise<ReturnType<typeof structuredResult> | ReturnType<typeof errorResult>> {
  const absPath = resolve(args.path);

  if (!existsSync(absPath)) {
    return errorResult(`Path not found: ${absPath}`);
  }

  const st = lstatSync(absPath);
  const isFile = st.isFile();
  const isDir = st.isDirectory();

  if (!isFile && !isDir) {
    return errorResult(`Path is not a file or directory: ${absPath}`);
  }

  const files: Array<{ path: string; sha256: string; size: number }> = [];

  if (isFile) {
    if (st.size > args.max_file_bytes) {
      return errorResult(`File exceeds max_file_bytes (${args.max_file_bytes}): ${absPath}`);
    }
    const sha256 = await hashFile(absPath);
    files.push({ path: absPath.split(sep).at(-1) ?? absPath, sha256, size: st.size });
  } else {
    // directory
    const walked = walkDir(absPath, args);
    if (typeof walked === "string") return errorResult(walked);
    for (const entry of walked) {
      const sha256 = await hashFile(entry.absPath);
      files.push({ path: entry.posixRel, sha256, size: entry.size });
    }
    // Stable sort
    files.sort((a, b) => a.path.localeCompare(b.path));
  }

  const tdmcpVersion = (() => {
    try {
      const pkg = JSON.parse(
        readFileSync(fileURLToPath(new URL("../../../../package.json", import.meta.url)), "utf8"),
      ) as { version?: string };
      return pkg.version ?? "unknown";
    } catch {
      return "unknown";
    }
  })();

  const manifest: ChecksumManifest = {
    kind: MANIFEST_KIND,
    version: 1,
    tdmcp_version: tdmcpVersion,
    created_at: new Date().toISOString(),
    root: isDir ? absPath : undefined,
    files,
  };

  const manifestOut = args.manifest_out ?? join(isDir ? absPath : dirname(absPath), MANIFEST_FILE);
  mkdirSync(dirname(manifestOut), { recursive: true });
  writeFileSync(manifestOut, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  ctx.logger.info(`checksum_and_verify_pack: wrote manifest to ${manifestOut}`);

  return structuredResult(
    `Computed SHA-256 for ${files.length} file(s). Manifest: ${manifestOut}`,
    {
      manifest_path: manifestOut,
      file_count: files.length,
      files,
    },
  );
}

// ── Verify action ─────────────────────────────────────────────────────────────

interface VerifyResult {
  ok: boolean;
  manifest_path: string | null;
  checked: number;
  mismatches: Array<{
    path: string;
    expected: string;
    actual: string;
    expected_size: number;
    actual_size: number;
  }>;
  missing: string[];
  extra: string[];
  errors: string[];
}

async function verifyChecksums(
  ctx: ToolContext,
  args: ChecksumAndVerifyPackArgs,
): Promise<ReturnType<typeof structuredResult> | ReturnType<typeof errorResult>> {
  const absPath = resolve(args.path);

  if (!existsSync(absPath)) {
    return errorResult(`Path not found: ${absPath}`);
  }

  const isDir = lstatSync(absPath).isDirectory();

  // Resolve manifest
  let manifestPath: string | null = null;
  let manifest: ChecksumManifest;

  if (args.manifest) {
    // Inline manifest — validate kind/version
    manifest = {
      kind: MANIFEST_KIND,
      version: 1,
      tdmcp_version: args.manifest.tdmcp_version,
      created_at: args.manifest.created_at,
      root: args.manifest.root,
      files: args.manifest.files,
    };
  } else {
    // Read from disk
    manifestPath = isDir ? join(absPath, MANIFEST_FILE) : absPath;
    if (!existsSync(manifestPath)) {
      return errorResult(`Manifest not found: ${manifestPath}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      return errorResult(
        `Failed to parse manifest: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const parsed = raw as Partial<ChecksumManifest>;
    if (parsed.kind !== MANIFEST_KIND) {
      return errorResult(
        `Unknown manifest kind: "${parsed.kind ?? "(missing)"}". Expected "${MANIFEST_KIND}".`,
      );
    }
    manifest = parsed as ChecksumManifest;
  }

  // Build a map of expected entries
  const expected = new Map<string, { sha256: string; size: number }>();
  for (const f of manifest.files) {
    expected.set(f.path, { sha256: f.sha256, size: f.size });
  }

  // Resolve root dir for verification
  const rootDir = isDir ? absPath : dirname(absPath);

  const result: VerifyResult = {
    ok: false,
    manifest_path: manifestPath,
    checked: 0,
    mismatches: [],
    missing: [],
    extra: [],
    errors: [],
  };

  // Check each expected entry
  for (const [posixRel, exp] of expected.entries()) {
    const absFile = join(rootDir, posixRel.split(posix.sep).join(sep));
    if (!existsSync(absFile)) {
      result.missing.push(posixRel);
      continue;
    }
    let actualSize: number;
    try {
      actualSize = statSync(absFile).size;
    } catch (err) {
      result.errors.push(
        `${posixRel}: stat failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (actualSize > args.max_file_bytes) {
      result.errors.push(`${posixRel}: exceeds max_file_bytes (${args.max_file_bytes})`);
      continue;
    }
    let actualHash: string;
    try {
      actualHash = await hashFile(absFile);
    } catch (err) {
      result.errors.push(
        `${posixRel}: hash failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    result.checked++;
    if (actualHash !== exp.sha256 || actualSize !== exp.size) {
      result.mismatches.push({
        path: posixRel,
        expected: exp.sha256,
        actual: actualHash,
        expected_size: exp.size,
        actual_size: actualSize,
      });
    }
  }

  // Detect extra files in dir mode
  if (isDir) {
    const walked = walkDir(rootDir, {
      ...args,
      // When verifying, always exclude the manifest file itself
      exclude_globs: [...args.exclude_globs, `**/${MANIFEST_FILE}`],
    });
    if (typeof walked === "string") {
      result.errors.push(walked);
    } else {
      for (const entry of walked) {
        if (!expected.has(entry.posixRel)) {
          result.extra.push(entry.posixRel);
        }
      }
    }
  }

  result.ok =
    result.mismatches.length === 0 &&
    result.missing.length === 0 &&
    (!args.strict || result.extra.length === 0) &&
    result.errors.length === 0;

  const summary = result.ok
    ? `Verified ${result.checked} file(s) — all OK.`
    : `Verify failed: ${result.mismatches.length} mismatch(es), ${result.missing.length} missing, ${result.extra.length} extra, ${result.errors.length} error(s).`;

  ctx.logger.info(`checksum_and_verify_pack: ${summary}`);

  return structuredResult(summary, result);
}

// ── Public impl ───────────────────────────────────────────────────────────────

export async function checksumAndVerifyPackImpl(ctx: ToolContext, args: ChecksumAndVerifyPackArgs) {
  try {
    if (args.action === "compute") {
      return await computeChecksums(ctx, args);
    }
    return await verifyChecksums(ctx, args);
  } catch (err) {
    return errorResult(
      `checksum_and_verify_pack internal error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Registrar ─────────────────────────────────────────────────────────────────

export const registerChecksumAndVerifyPack: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "checksum_and_verify_pack",
    {
      title: "Checksum and Verify Pack",
      description:
        "Compute or verify SHA-256 checksums for tdmcp artifacts (.tox, .recipe.json, bundles). " +
        "action=compute walks a path and writes a tdmcp-checksums.json manifest. " +
        "action=verify re-hashes files and reports ok/mismatch/missing/extra. No TD bridge required.",
      inputSchema: checksumAndVerifyPackSchema.shape,
    },
    (args) => checksumAndVerifyPackImpl(ctx, args),
  );
