import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("archive extraction diagnostics", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("reports a clear action when unzip is unavailable", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => {
        throw Object.assign(new Error("spawnSync unzip ENOENT"), { code: "ENOENT" });
      }),
    }));

    try {
      const { assertZipToolAvailable } = await import("../../src/packages/archive.js");
      expect(() => assertZipToolAvailable()).toThrow(/Required zip tool 'unzip'.*Install unzip/);
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
  });

  it("lists Windows zip entries without embedding the archive path in PowerShell code", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    const execFileSync = vi.fn(() => "pkg/widget.tox\n");
    vi.doMock("node:child_process", () => ({ execFileSync }));

    try {
      const { listZipEntries } = await import("../../src/packages/archive.js");
      const zipPath = "C:\\packages\\widget.zip'; Remove-Item C:\\important; '";

      expect(listZipEntries(zipPath)).toEqual(["pkg/widget.tox"]);

      const args = (execFileSync.mock.calls[0] as unknown as [string, string[], unknown])[1];
      expect(args).toContain(zipPath);
      expect(args[2]).toContain("$args[0]");
      expect(args[2]).not.toContain(zipPath);
      expect(args[2]).not.toContain("Remove-Item");
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
  });

  it("extracts Windows zips without embedding paths in PowerShell code", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    const execFileSync = vi.fn(() => "pkg/widget.tox\n");
    vi.doMock("node:child_process", () => ({ execFileSync }));
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-archive-"));

    try {
      const { extractZipSafe } = await import("../../src/packages/archive.js");
      const zipPath = "C:\\packages\\widget.zip'; Remove-Item C:\\important; '";
      const destDir = join(dir, "dest'; Remove-Item C:\\important; '");

      await extractZipSafe(zipPath, destDir);

      const extractArgs = (execFileSync.mock.calls[1] as unknown as [string, string[], unknown])[1];
      expect(extractArgs).toContain(zipPath);
      expect(extractArgs).toContain(destDir);
      expect(extractArgs[2]).toContain("$args[0]");
      expect(extractArgs[2]).toContain("$args[1]");
      expect(extractArgs[2]).not.toContain(zipPath);
      expect(extractArgs[2]).not.toContain(destDir);
      expect(extractArgs[2]).not.toContain("Remove-Item");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (platform) Object.defineProperty(process, "platform", platform);
    }
  });
});
