import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPackageCommand, runPackageCli } from "../../src/packages/cli.js";
import { createPackagePaths } from "../../src/packages/paths.js";

/**
 * Branch-coverage focused tests for src/packages/cli.ts.
 *
 * tests/unit/packageManager.test.ts already covers `install --dry-run --json`,
 * `info --json`, `doctor --json`, and `packages --help`. This file targets the
 * uncovered branches that were dominating wave-3's Br gap:
 *   - search (text + --json)
 *   - list (default, --installed, --available, --json)
 *   - info text rendering + missing-arg + unknown id
 *   - install (text rendering, missing arg, unknown)
 *   - uninstall (text + --json + missing arg + unknown)
 *   - doctor (text + no-arg → all packages + deferred shape)
 *   - packages path (text + --json + wrong subcommand)
 *   - top-level: bare command (no args), bare invalid command, --help on info
 *
 * Every package interaction stays offline: `--dry-run` for install and a
 * temp rootDir for any disk writes. The bridge is never reached.
 */

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "tdmcp-packages-cli-test-"));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

describe("isPackageCommand", () => {
  it("recognizes every top-level package subcommand", () => {
    for (const cmd of ["search", "list", "info", "install", "uninstall", "doctor", "packages"]) {
      expect(isPackageCommand(cmd)).toBe(true);
    }
  });

  it("rejects unknown commands and undefined", () => {
    expect(isPackageCommand(undefined)).toBe(false);
    expect(isPackageCommand("install-bridge")).toBe(false);
    expect(isPackageCommand("nonsense")).toBe(false);
  });
});

describe("runPackageCli — top-level dispatch", () => {
  it("returns usage with exit 2 when the command isn't a package command", async () => {
    const result = await runPackageCli([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("tdmcp packages");
  });

  it("returns usage with exit 0 for any subcommand + --help", async () => {
    const result = await runPackageCli(["info", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("tdmcp install <lib>");
  });
});

describe("runPackageCli — search", () => {
  it("renders a text list of matching packages", async () => {
    const result = await runPackageCli(["search", "shader"]);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout).toContain("shader-park-td");
  });

  it("emits JSON when --json is set, even with no query", async () => {
    const result = await runPackageCli(["search", "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });
});

describe("runPackageCli — list", () => {
  it("renders 'Available:' section in text mode with no installed packages", async () => {
    const root = tempRoot();
    try {
      const result = await runPackageCli(["list"], { rootDir: root });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Available:");
    } finally {
      cleanup(root);
    }
  });

  it("emits both available + installed arrays in --json mode", async () => {
    const root = tempRoot();
    try {
      const result = await runPackageCli(["list", "--json", "--installed"], { rootDir: root });
      expect(result.code).toBe(0);
      const doc = JSON.parse(result.stdout);
      expect(doc).toHaveProperty("available");
      expect(doc).toHaveProperty("installed");
      expect(Array.isArray(doc.available)).toBe(true);
      expect(Array.isArray(doc.installed)).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  it("--available-only still lists available", async () => {
    const root = tempRoot();
    try {
      const result = await runPackageCli(["list", "--available"], { rootDir: root });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Available:");
    } finally {
      cleanup(root);
    }
  });
});

describe("runPackageCli — info", () => {
  it("renders the text display for a known package", async () => {
    const result = await runPackageCli(["info", "shader-park-td"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Source:");
    expect(result.stdout).toContain("Support:");
    expect(result.stdout).toContain("Type:");
  });

  it("returns exit 2 with a usage message when id is missing", async () => {
    const result = await runPackageCli(["info"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: tdmcp info");
  });

  it("returns exit 1 for an unknown package id", async () => {
    const result = await runPackageCli(["info", "definitely-not-a-real-package-xyz"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown package");
  });
});

describe("runPackageCli — install", () => {
  it("renders a text install report for a dry-run", async () => {
    const root = tempRoot();
    try {
      const result = await runPackageCli(
        ["install", "shader-park-td", "--dry-run", "--project", "/project1"],
        { rootDir: root },
      );
      expect(result.code).toBe(0);
      // Display string includes "<displayName>: <status>"
      expect(result.stdout.length).toBeGreaterThan(0);
    } finally {
      cleanup(root);
    }
  });

  it("returns exit 2 with usage when id is missing", async () => {
    const result = await runPackageCli(["install"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: tdmcp install");
  });

  it("honors --dir as a packages-root override (dry-run)", async () => {
    const root = tempRoot();
    try {
      const result = await runPackageCli(
        ["install", "shader-park-td", "--dry-run", "--json", "--dir", root],
        {},
      );
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.dryRun).toBe(true);
    } finally {
      cleanup(root);
    }
  });
});

describe("runPackageCli — uninstall", () => {
  it("renders a text report when the package isn't installed", async () => {
    const root = tempRoot();
    try {
      const result = await runPackageCli(["uninstall", "shader-park-td", "--yes"], {
        rootDir: root,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("not installed");
    } finally {
      cleanup(root);
    }
  });

  it("emits --json output for uninstall", async () => {
    const root = tempRoot();
    try {
      const result = await runPackageCli(["uninstall", "shader-park-td", "--json", "--yes"], {
        rootDir: root,
      });
      expect(result.code).toBe(0);
      const doc = JSON.parse(result.stdout);
      expect(doc).toHaveProperty("removed");
    } finally {
      cleanup(root);
    }
  });

  it("returns exit 2 with usage when id is missing", async () => {
    const result = await runPackageCli(["uninstall"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: tdmcp uninstall");
  });
});

describe("runPackageCli — doctor", () => {
  it("renders text for a specific package", async () => {
    const result = await runPackageCli(["doctor", "shader-park-td"]);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("renders text for the all-packages report when no id is given", async () => {
    const result = await runPackageCli(["doctor"]);
    expect(result.code).toBe(0);
    // The "all" report goes through the `Package doctor: <status>` branch.
    expect(result.stdout).toContain("Package doctor");
  });

  it("renders a 'deferred' label for deferred entries", async () => {
    const result = await runPackageCli(["doctor", "touchengine-unreal"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("deferred");
  });
});

describe("runPackageCli — packages path", () => {
  it("returns exit 2 when subcommand isn't `path`", async () => {
    const result = await runPackageCli(["packages", "something-else"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: tdmcp packages path");
  });

  it("emits the package root in text mode", async () => {
    const root = tempRoot();
    try {
      const result = await runPackageCli(["packages", "path"], { rootDir: root });
      expect(result.code).toBe(0);
      const paths = createPackagePaths({ rootDir: root });
      expect(result.stdout).toContain(paths.root);
    } finally {
      cleanup(root);
    }
  });

  it("emits the full paths object in --json mode", async () => {
    const root = tempRoot();
    try {
      const result = await runPackageCli(["packages", "path", "--json"], { rootDir: root });
      expect(result.code).toBe(0);
      const doc = JSON.parse(result.stdout);
      expect(doc).toHaveProperty("root");
    } finally {
      cleanup(root);
    }
  });
});
