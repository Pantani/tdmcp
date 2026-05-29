import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

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

export function listZipEntries(zipPath: string): string[] {
  if (process.platform === "win32") {
    const output = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead(${JSON.stringify(zipPath)}).Entries | ForEach-Object { $_.FullName }`,
      ],
      { encoding: "utf8" },
    );
    return output.split(/\r?\n/).filter(Boolean);
  }
  const output = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
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
        `Expand-Archive -Path ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`,
      ],
      { stdio: "inherit" },
    );
    return;
  }
  execFileSync("unzip", ["-o", "-q", zipPath, "-d", destDir], { stdio: "inherit" });
}
