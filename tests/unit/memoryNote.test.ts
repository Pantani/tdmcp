import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "../../src/vault/index.js";
import {
  compactStyleContext,
  memoryNoteRel,
  mergeMemoryFrontmatter,
  mergeStyleMemory,
  normalizeTags,
  readMemoryNote,
  readStyleMemory,
  STYLE_NOTE_REL,
  StyleMemorySchema,
  writeMemoryNote,
  writeStyleMemory,
} from "../../src/vault/memoryNote.js";

let dir: string;
let vault: Vault;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tdmcp-memorynote-"));
  vault = new Vault(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("memoryNote", () => {
  it("returns a valid default StyleMemory on an empty vault", () => {
    const v = readStyleMemory(vault);
    expect(v.type).toBe("tdmcp-memory");
    expect(v.topic).toBe("style");
    expect(v.palettes).toEqual([]);
    expect(v.banned).toEqual([]);
    expect(v.favorite_generators).toEqual([]);
    expect(v.tags).toEqual([]);
    expect(vault.exists(STYLE_NOTE_REL)).toBe(false);
  });

  it("write → read round-trips and stamps updated as YYYY-MM-DD", () => {
    writeStyleMemory(
      vault,
      StyleMemorySchema.parse({
        default_energy: "high",
        palettes: [{ name: "p1", colors: ["#fff"] }],
        banned: ["strobe"],
      }),
    );
    expect(vault.exists(STYLE_NOTE_REL)).toBe(true);
    const v = readStyleMemory(vault);
    expect(v.default_energy).toBe("high");
    expect(v.palettes).toEqual([{ name: "p1", colors: ["#fff"] }]);
    expect(v.banned).toEqual(["strobe"]);
    expect(v.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const raw = vault.readNote(STYLE_NOTE_REL);
    expect(raw.data.type).toBe("tdmcp-memory");
  });

  it("merges without clobbering — arrays accrete, absent scalars preserved", () => {
    writeStyleMemory(
      vault,
      StyleMemorySchema.parse({
        banned: ["strobe"],
        palettes: [{ name: "a", colors: ["#000"] }],
        favorite_generators: ["g1"],
        tags: ["warm"],
        default_energy: "medium",
      }),
    );
    const merged = mergeStyleMemory(vault, {
      banned: ["fast-flash"],
      palettes: [{ name: "b", colors: ["#fff"] }],
      favorite_generators: ["g2"],
      tags: ["slow"],
    });
    expect(merged.banned).toEqual(["fast-flash", "strobe"]);
    expect(merged.palettes.map((p) => p.name)).toEqual(["a", "b"]);
    expect(merged.favorite_generators).toEqual(["g1", "g2"]);
    expect(merged.tags).toEqual(["warm", "slow"]);
    expect(merged.default_energy).toBe("medium");

    const merged2 = mergeStyleMemory(vault, { banned: ["STROBE"] });
    const lowered = merged2.banned.map((b) => b.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
  });

  it("preserves the body on a frontmatter-only merge", () => {
    writeStyleMemory(vault, StyleMemorySchema.parse({}), "## Style notes\n\ncustom prose here\n");
    mergeStyleMemory(vault, { tags: ["new"] });
    const raw = vault.readNote(STYLE_NOTE_REL);
    expect(raw.body).toContain("custom prose here");
  });

  it("compactStyleContext renders frontmatter only, omits empty fields", () => {
    const populated = StyleMemorySchema.parse({
      default_energy: "high",
      palettes: [{ name: "warm-dusk", colors: ["#1a1a2e", "#e94560"] }],
      banned: ["strobe", "fast-flash"],
      favorite_generators: ["create_feedback_network"],
      naming: "camelCase",
      tags: ["warm", "slow"],
    });
    const s = compactStyleContext(populated);
    expect(s).toContain("energy: high");
    expect(s).toContain("strobe");
    expect(s).toContain("fast-flash");
    expect(s).toContain("warm-dusk");
    expect(s).toContain("warm");
    expect(s).not.toContain("custom prose");

    const empty = compactStyleContext(StyleMemorySchema.parse({}));
    expect(empty).toBe("");
  });

  it("normalizeTags matches browseVaultLibrary tolerance + lower-cases + dedups", () => {
    expect(normalizeTags(["A", "b"])).toEqual(["a", "b"]);
    expect(normalizeTags("x, y ,x")).toEqual(["x", "y"]);
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(42)).toEqual([]);
  });

  it("generic note: write + read + merge round-trips via slugged path", () => {
    writeMemoryNote(vault, "Naming Conventions!", { rule: "camelCase" }, "body text");
    const rel = memoryNoteRel("Naming Conventions!");
    expect(rel).toBe("Memory/Naming_Conventions.md");
    expect(vault.exists(rel)).toBe(true);
    const got = readMemoryNote(vault, "Naming Conventions!");
    expect(got.data.rule).toBe("camelCase");
    expect(got.body.trim()).toBe("body text");

    const merged = mergeMemoryFrontmatter(vault, "Naming Conventions!", { extra: "x" });
    expect(merged.rule).toBe("camelCase");
    expect((merged as Record<string, unknown>).extra).toBe("x");
  });

  it("path safety: a topic that tries to escape is slugged + stays inside Memory/", () => {
    const rel = memoryNoteRel("../escape");
    expect(rel.startsWith("Memory/")).toBe(true);
    expect(rel).not.toContain("..");
    writeMemoryNote(vault, "../escape", { a: 1 }, "");
    expect(vault.exists(rel)).toBe(true);
  });
});
