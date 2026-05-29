import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

function isMissingCommandError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function missingUnzipError(): Error {
  return new Error(
    "Required zip tool 'unzip' was not found. Install unzip or choose a package/release asset that stages a .tox directly.",
  );
}

function unsafeReason(entry: string): string | undefined {
  const normalized = entry.replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0")) return "empty or NUL-containing path";
  if (path.posix.isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)) {
    return "absolute path";
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) return "path traversal";
  return undefined;
}

export function validateArchiveEntries(entries: string[]): void {
  for (const entry of entries) {
    const reason = unsafeReason(entry);
    if (reason) throw new Error(`Unsafe archive path (${reason}): ${entry}`);
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

export async function extractZipSafe(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  validateArchiveEntries(listZipEntries(zipPath));
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
