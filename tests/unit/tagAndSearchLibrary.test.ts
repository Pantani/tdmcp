import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../../src/tools/types.js";
import {
  type TagAndSearchLibraryArgs,
  tagAndSearchLibraryImpl,
} from "../../src/tools/vault/tagAndSearchLibrary.js";
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
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-tagsearch-"));
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

const DEFAULTS: TagAndSearchLibraryArgs = {
  op: "search",
  tags: [],
  replace: false,
  tags_any: [],
  tags_all: [],
  folders: ["Recipes", "Components"],
  limit: 50,
};

describe("tagAndSearchLibraryImpl", () => {
  it("errors with TDMCP_VAULT_PATH hint when no vault is configured", async () => {
    const result = await tagAndSearchLibraryImpl(ctxNoVault(), { ...DEFAULTS, op: "list" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  it("op='tag' requires asset_path", async () => {
    const vault = makeVault();
    const result = await tagAndSearchLibraryImpl(ctxWith(vault), {
      ...DEFAULTS,
      op: "tag",
      tags: ["foo"],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("asset_path is required");
  });

  it("op='tag' errors when the asset is missing", async () => {
    const vault = makeVault();
    const result = await tagAndSearchLibraryImpl(ctxWith(vault), {
      ...DEFAULTS,
      op: "tag",
      asset_path: "Recipes/missing.md",
      tags: ["foo"],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not found");
  });

  it("op='tag' unions tags, preserving '*'-pinned user tags", async () => {
    const vault = makeVault();
    vault.writeNote("Recipes/a.md", { id: "a", tags: ["*pinned", "old"] }, "body\n");
    const result = await tagAndSearchLibraryImpl(ctxWith(vault), {
      ...DEFAULTS,
      op: "tag",
      asset_path: "Recipes/a.md",
      tags: ["new1", "new2"],
    });
    expect(result.isError).toBeFalsy();
    const after = vault.readNote("Recipes/a.md");
    const tags = after.data.tags as string[];
    expect(tags).toEqual(expect.arrayContaining(["*pinned", "old", "new1", "new2"]));
  });

  it("op='tag' replace=true drops non-pinned tags but keeps '*'-pinned ones", async () => {
    const vault = makeVault();
    vault.writeNote("Recipes/a.md", { id: "a", tags: ["*pinned", "old"] }, "body\n");
    const result = await tagAndSearchLibraryImpl(ctxWith(vault), {
      ...DEFAULTS,
      op: "tag",
      asset_path: "Recipes/a.md",
      tags: ["fresh"],
      replace: true,
    });
    expect(result.isError).toBeFalsy();
    const after = vault.readNote("Recipes/a.md");
    const tags = after.data.tags as string[];
    expect(tags).toContain("*pinned");
    expect(tags).toContain("fresh");
    expect(tags).not.toContain("old");
  });

  it("op='list' enumerates assets from Recipes/ and Components/", async () => {
    const vault = makeVault();
    vault.writeNote("Recipes/a.md", { id: "a", tags: ["audio"] }, "body");
    vault.writeNote("Recipes/b.md", { id: "b", tags: ["glsl"] }, "body");
    vault.writeNote("Components/c.md", { id: "c", tags: ["util"] }, "body");
    const result = await tagAndSearchLibraryImpl(ctxWith(vault), { ...DEFAULTS, op: "list" });
    expect(result.isError).toBeFalsy();
    const data = jsonOf<{ total: number; assets: Array<{ path: string }> }>(result);
    expect(data.total).toBe(3);
    expect(data.assets.map((a) => a.path).sort()).toEqual([
      "Components/c.md",
      "Recipes/a.md",
      "Recipes/b.md",
    ]);
  });

  it("op='search' tags_all requires every listed tag", async () => {
    const vault = makeVault();
    vault.writeNote("Recipes/a.md", { id: "a", tags: ["audio", "glsl"] }, "body");
    vault.writeNote("Recipes/b.md", { id: "b", tags: ["audio"] }, "body");
    const result = await tagAndSearchLibraryImpl(ctxWith(vault), {
      ...DEFAULTS,
      op: "search",
      tags_all: ["audio", "glsl"],
    });
    expect(result.isError).toBeFalsy();
    const data = jsonOf<{ total: number; matches: Array<{ path: string }> }>(result);
    expect(data.total).toBe(1);
    expect(data.matches[0]?.path).toBe("Recipes/a.md");
  });

  it("op='search' tags_any matches at least one tag", async () => {
    const vault = makeVault();
    vault.writeNote("Recipes/a.md", { id: "a", tags: ["audio"] }, "body");
    vault.writeNote("Recipes/b.md", { id: "b", tags: ["glsl"] }, "body");
    vault.writeNote("Recipes/c.md", { id: "c", tags: ["other"] }, "body");
    const result = await tagAndSearchLibraryImpl(ctxWith(vault), {
      ...DEFAULTS,
      op: "search",
      tags_any: ["audio", "glsl"],
    });
    const data = jsonOf<{ total: number }>(result);
    expect(data.total).toBe(2);
  });

  it("op='search' query matches name/description/tag substrings", async () => {
    const vault = makeVault();
    vault.writeNote(
      "Recipes/a.md",
      { id: "a", name: "Feedback Tunnel", description: "zoom" },
      "body",
    );
    vault.writeNote("Recipes/b.md", { id: "b", name: "Particles", description: "swarm" }, "body");
    const result = await tagAndSearchLibraryImpl(ctxWith(vault), {
      ...DEFAULTS,
      op: "search",
      query: "feedback",
    });
    const data = jsonOf<{ total: number; matches: Array<{ id: string }> }>(result);
    expect(data.total).toBe(1);
    expect(data.matches[0]?.id).toBe("a");
  });
});
