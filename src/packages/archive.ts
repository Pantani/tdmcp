import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

export interface ZipEntryInfo {
  path: string;
  isSymlink?: boolean;
}

export type ArchiveEntry = string | ZipEntryInfo;

function isMissingCommandError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function missingUnzipError(): Error {
  return new Error(
    "Required zip tool 'unzip' was not found. Install unzip or choose a package/release asset that stages a .tox directly.",
  );
}

function entryPath(entry: ArchiveEntry): string {
  return typeof entry === "string" ? entry : entry.path;
}

function isSymlinkEntry(entry: ArchiveEntry): boolean {
  return typeof entry === "object" && entry.isSymlink === true;
}

function unsafeReason(entry: string): string | undefined {
  const normalized = entry.replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0")) return "empty or NUL-containing path";
  if (path.posix.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    return "absolute path";
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) return "path traversal";
  return undefined;
}

export function validateArchiveEntries(entries: ArchiveEntry[]): void {
  for (const entry of entries) {
    const name = entryPath(entry);
    if (isSymlinkEntry(entry)) throw new Error(`Unsafe archive path (symlink): ${name}`);
    const reason = unsafeReason(name);
    if (reason) throw new Error(`Unsafe archive path (${reason}): ${name}`);
  }
}

export function assertZipToolAvailable(): void {
  if (process.platform === "win32") return;
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
  } catch (err) {
    if (isMissingCommandError(err)) throw missingUnzipError();
    throw err;
  }
}

export function listZipEntries(zipPath: string): string[] {
  if (process.platform === "win32") {
    const output = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead($args[0]).Entries | ForEach-Object { $_.FullName }",
        zipPath,
      ],
      { encoding: "utf8" },
    );
    return output.split(/\r?\n/).filter(Boolean);
  }
  assertZipToolAvailable();
  let output: string;
  try {
    output = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
  } catch (err) {
    if (isMissingCommandError(err)) throw missingUnzipError();
    throw err;
  }
  return output.split(/\r?\n/).filter(Boolean);
}

function symlinkFromExternalAttributes(attributes: unknown): boolean {
  if (typeof attributes !== "number" || !Number.isFinite(attributes)) return false;
  const mode = Math.floor(attributes / 0x10000) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

function parsePowerShellZipInfo(output: string): ZipEntryInfo[] {
  if (!output.trim()) return [];
  const parsed = JSON.parse(output) as unknown;
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries
    .filter((entry): entry is { FullName?: unknown; ExternalAttributes?: unknown } =>
      Boolean(entry && typeof entry === "object"),
    )
    .map((entry) => ({
      path: String(entry.FullName ?? ""),
      isSymlink: symlinkFromExternalAttributes(entry.ExternalAttributes),
    }))
    .filter((entry) => entry.path);
}

function parseUnixZipInfo(output: string): ZipEntryInfo[] {
  const entries: ZipEntryInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = /^([dl-][rwxstST-]{9})\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(
      trimmed,
    );
    if (!match) continue;
    const mode = match[1];
    const entry = match[2];
    if (!mode || !entry) continue;
    entries.push({ path: entry, isSymlink: mode.startsWith("l") });
  }
  return entries;
}

export function listZipEntryInfo(zipPath: string): ZipEntryInfo[] {
  if (process.platform === "win32") {
    const output = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [IO.Compression.ZipFile]::OpenRead($args[0]); try { $zip.Entries | ForEach-Object { [pscustomobject]@{ FullName = $_.FullName; ExternalAttributes = $_.ExternalAttributes } } | ConvertTo-Json -Compress } finally { $zip.Dispose() }",
        zipPath,
      ],
      { encoding: "utf8" },
    );
    return parsePowerShellZipInfo(output);
  }
  assertZipToolAvailable();
  let output: string;
  try {
    output = execFileSync("unzip", ["-Z", "-l", zipPath], { encoding: "utf8" });
  } catch (err) {
    if (isMissingCommandError(err)) throw missingUnzipError();
    throw err;
  }
  return parseUnixZipInfo(output);
}

export async function extractZipSafe(zipPath: string, destDir: string): Promise<void> {
  validateArchiveEntries(listZipEntryInfo(zipPath));
  mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
        zipPath,
        destDir,
      ],
      { stdio: "inherit" },
    );
    return;
  }
  try {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", destDir], { stdio: "inherit" });
  } catch (err) {
    if (isMissingCommandError(err)) throw missingUnzipError();
    throw err;
  }
}
