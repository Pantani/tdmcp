import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";
import { versionLibraryAssetImpl } from "../../src/tools/vault/versionLibraryAsset.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
function jsonOf<T = Record<string, unknown>>(result: CallToolResult): T {
  const m = /```json\n([\s\S]*?)\n```/.exec(textOf(result));
  return JSON.parse(m?.[1] ?? "{}") as T;
}

const tmpDirs: string[] = [];
function makeVault(): Vault {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-version-"));
  tmpDirs.push(dir);
  return new Vault(dir);
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function ctxWith(vault: Vault): ToolContext {
  return { logger: silentLogger, vault } as unknown as ToolContext;
}
function ctxNoVault(): ToolContext {
  return { logger: silentLogger } as unknown as ToolContext;
}

describe("versionLibraryAssetImpl", () => {
  it("errors when no vault is configured", async () => {
    const result = await versionLibraryAssetImpl(ctxNoVault(), {
      asset_path: "Recipes/x.md",
      bump: "patch",
      read_only: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  it("returns errorResult when the asset_path escapes the vault root", async () => {
    const vault = makeVault();
    const result = await versionLibraryAssetImpl(ctxWith(vault), {
      asset_path: "../escape.md",
      bump: "patch",
      read_only: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result).toLowerCase()).toContain("invalid vault path");
  });

  it("errors when the asset does not exist", async () => {
    const vault = makeVault();
    const result = await versionLibraryAssetImpl(ctxWith(vault), {
      asset_path: "Recipes/missing.md",
      bump: "patch",
      read_only: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not found");
  });

  it("bumps patch on a fresh asset (no sidecar) starting from 0.0.0", async () => {
    const vault = makeVault();
    vault.writeNote("Recipes/a.md", { id: "a" }, "body\n");
    const result = await versionLibraryAssetImpl(ctxWith(vault), {
      asset_path: "Recipes/a.md",
      bump: "patch",
      read_only: false,
    });
    expect(result.isError).toBeFalsy();
    const data = jsonOf<{ previous: string; current: string; history: unknown[] }>(result);
    expect(data.previous).toBe("0.0.0");
    expect(data.current).toBe("0.0.1");
    expect(data.history.length).toBe(1);
    // Sidecar exists.
    expect(vault.exists("Recipes/a.versions.json")).toBe(true);
    // Frontmatter updated.
    const after = vault.readNote("Recipes/a.md");
    expect(after.data.version).toBe("0.0.1");
  });

  it("minor bump resets patch; major bump resets minor+patch; history accumulates", async () => {
    const vault = makeVault();
    vault.writeNote("Recipes/a.md", { id: "a" }, "body\n");
    let r = await versionLibraryAssetImpl(ctxWith(vault), {
      asset_path: "Recipes/a.md",
      bump: "patch",
      read_only: false,
    });
    expect(jsonOf<{ current: string }>(r).current).toBe("0.0.1");
    r = await versionLibraryAssetImpl(ctxWith(vault), {
      asset_path: "Recipes/a.md",
      bump: "minor",
      read_only: false,
      note: "added control",
    });
    expect(jsonOf<{ current: string }>(r).current).toBe("0.1.0");
    r = await versionLibraryAssetImpl(ctxWith(vault), {
      asset_path: "Recipes/a.md",
      bump: "major",
      read_only: false,
    });
    const final = jsonOf<{ current: string; history: Array<{ version: string; note?: string }> }>(
      r,
    );
    expect(final.current).toBe("1.0.0");
    // newest first
    expect(final.history[0]?.version).toBe("1.0.0");
    expect(final.history.find((h) => h.note === "added control")?.version).toBe("0.1.0");
  });

  it("read_only returns the current version without bumping", async () => {
    const vault = makeVault();
    vault.writeNote("Recipes/a.md", { id: "a", version: "2.3.4" }, "body\n");
    const result = await versionLibraryAssetImpl(ctxWith(vault), {
      asset_path: "Recipes/a.md",
      bump: "patch",
      read_only: true,
    });
    expect(result.isError).toBeFalsy();
    const data = jsonOf<{ current: string; has_sidecar: boolean }>(result);
    expect(data.current).toBe("2.3.4");
    expect(data.has_sidecar).toBe(false);
    // No sidecar written.
    expect(vault.exists("Recipes/a.versions.json")).toBe(false);
  });

  it("read_only falls back to 0.0.0 when frontmatter version is not a valid SemVer", async () => {
    // Matches the bumping path's behavior: a non-SemVer frontmatter `version`
    // is treated as 0.0.0 rather than reported as-is.
    const vault = makeVault();
    vault.writeNote("Recipes/a.md", { id: "a", version: "draft-7" }, "body\n");
    const result = await versionLibraryAssetImpl(ctxWith(vault), {
      asset_path: "Recipes/a.md",
      bump: "patch",
      read_only: true,
    });
    expect(result.isError).toBeFalsy();
    const data = jsonOf<{ current: string; has_sidecar: boolean }>(result);
    expect(data.current).toBe("0.0.0");
    expect(data.has_sidecar).toBe(false);
  });

  it("refuses to overwrite a malformed sidecar (invalid JSON)", async () => {
    const vault = makeVault();
    vault.writeNote("Recipes/a.md", { id: "a" }, "body\n");
    vault.write("Recipes/a.versions.json", "{ not valid json");
    const result = await versionLibraryAssetImpl(ctxWith(vault), {
      asset_path: "Recipes/a.md",
      bump: "patch",
      read_only: false,
    });
    expect(result.isError).toBe(true);
    const msg = textOf(result);
    expect(msg).toContain("malformed");
    expect(msg).toContain("invalid JSON");
    // Sidecar untouched.
    expect(vault.read("Recipes/a.versions.json")).toBe("{ not valid json");
  });

  it("refuses to overwrite a sidecar whose `current` is not a valid SemVer", async () => {
    const vault = makeVault();
    vault.writeNote("Recipes/a.md", { id: "a" }, "body\n");
    vault.write(
      "Recipes/a.versions.json",
      JSON.stringify({ asset_path: "Recipes/a.md", current: "not-semver", history: [] }),
    );
    const result = await versionLibraryAssetImpl(ctxWith(vault), {
      asset_path: "Recipes/a.md",
      bump: "patch",
      read_only: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not a valid SemVer");
  });

  it("writes license + license_tier to sidecar AND frontmatter when bumping", async () => {
    const vault = makeVault();
    vault.writeNote("Recipes/lic.md", { id: "lic" }, "body\n");
    const result = await versionLibraryAssetImpl(ctxWith(vault), {
      asset_path: "Recipes/lic.md",
      bump: "minor",
      read_only: false,
      license: "MIT",
      license_tier: "permissive",
    });
    expect(result.isError).toBeFalsy();
    const payload = jsonOf(result);
    expect(payload.license).toBe("MIT");
    expect(payload.license_tier).toBe("permissive");
    // sidecar persisted
    const sc = JSON.parse(vault.read("Recipes/lic.versions.json"));
    expect(sc.license).toBe("MIT");
    expect(sc.license_tier).toBe("permissive");
    // frontmatter mirrored
    const note = vault.readNote("Recipes/lic.md");
    expect(note.data.license).toBe("MIT");
    expect(note.data.license_tier).toBe("permissive");
  });

  it("read_only returns existing license metadata from sidecar", async () => {
    const vault = makeVault();
    vault.writeNote("Recipes/lic.md", { id: "lic" }, "body\n");
    // First bump to seed the sidecar with license data
    await versionLibraryAssetImpl(ctxWith(vault), {
      asset_path: "Recipes/lic.md",
      bump: "patch",
      read_only: false,
      license: "Apache-2.0",
      license_tier: "permissive",
    });
    // read_only should surface it
    const result = await versionLibraryAssetImpl(ctxWith(vault), {
      asset_path: "Recipes/lic.md",
      bump: "patch",
      read_only: true,
    });
    expect(result.isError).toBeFalsy();
    const payload = jsonOf(result);
    expect(payload.license).toBe("Apache-2.0");
    expect(payload.license_tier).toBe("permissive");
  });

  it("omitting license args preserves prior sidecar license through subsequent bumps", async () => {
    const vault = makeVault();
    vault.writeNote("Recipes/lic.md", { id: "lic" }, "body\n");
    // First bump with license
    await versionLibraryAssetImpl(ctxWith(vault), {
      asset_path: "Recipes/lic.md",
      bump: "patch",
      read_only: false,
      license: "MIT",
      license_tier: "permissive",
    });
    // Second bump without license args — should carry them forward
    const result = await versionLibraryAssetImpl(ctxWith(vault), {
      asset_path: "Recipes/lic.md",
      bump: "minor",
      read_only: false,
    });
    expect(result.isError).toBeFalsy();
    const payload = jsonOf(result);
    expect(payload.license).toBe("MIT");
    expect(payload.license_tier).toBe("permissive");
    // Sidecar still has it
    const sc = JSON.parse(vault.read("Recipes/lic.versions.json"));
    expect(sc.license).toBe("MIT");
  });
});
