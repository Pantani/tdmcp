import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractFencedBlock, parseNote } from "../../src/vault/frontmatter.js";
import { Vault } from "../../src/vault/index.js";

describe("Vault", () => {
  let dir: string;
  let vault: Vault;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tdmcp-vault-"));
    vault = new Vault(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes and reads a file, creating parent dirs", () => {
    vault.write("Recipes/foo.md", "hello");
    expect(vault.read("Recipes/foo.md")).toBe("hello");
    expect(vault.exists("Recipes/foo.md")).toBe(true);
    expect(vault.exists("Recipes/missing.md")).toBe(false);
  });

  it("round-trips frontmatter via writeNote/readNote", () => {
    vault.writeNote("note.md", { id: "x", tags: ["a", "b"] }, "body text");
    const note = vault.readNote("note.md");
    expect(note.data).toMatchObject({ id: "x", tags: ["a", "b"] });
    expect(note.body.trim()).toBe("body text");
  });

  it("lists files filtered by extension, sorted", () => {
    vault.write("Recipes/b.md", "");
    vault.write("Recipes/a.md", "");
    vault.write("Recipes/c.json", "");
    expect(vault.list("Recipes", ".md")).toEqual(["a.md", "b.md"]);
  });

  it("returns an empty list for a missing subdir", () => {
    expect(vault.list("Nope")).toEqual([]);
  });

  it("refuses paths that escape the vault root", () => {
    expect(() => vault.resolve("../escape.md")).toThrow(/escapes the vault/);
    expect(() => vault.resolve("a/../../escape.md")).toThrow(/escapes the vault/);
    expect(() => vault.resolve("/etc/passwd")).toThrow(/escapes the vault/);
  });

  it("allows nested paths inside the vault", () => {
    expect(() => vault.resolve("a/b/c.md")).not.toThrow();
    expect(vault.resolve("a/b/c.md").startsWith(vault.root)).toBe(true);
  });

  it("expands a leading ~ to the home directory", () => {
    expect(new Vault("~/some-tdmcp-vault").root).toBe(join(homedir(), "some-tdmcp-vault"));
  });
});

describe("parseNote", () => {
  it("strips a BOM from body-only fallback notes", () => {
    expect(parseNote("\uFEFFplain body").body).toBe("plain body");
  });

  it("strips a BOM when frontmatter is unterminated", () => {
    const note = parseNote("\uFEFF---\ntitle: broken\nbody");
    expect(note).toEqual({ data: {}, body: "---\ntitle: broken\nbody" });
  });

  it("does not treat indented fence-like YAML content as the closing fence", () => {
    const note = parseNote("---\ndescription: |\n  ---\n  keep this line\ntitle: Demo\n---\nbody");

    expect(note.data.title).toBe("Demo");
    expect(String(note.data.description)).toContain("---");
    expect(note.body).toBe("body");
  });
});

describe("extractFencedBlock", () => {
  it("extracts a json block carrying an info word", () => {
    const body = 'intro\n\n```json tdmcp-recipe\n{"id":"x"}\n```\n\noutro';
    expect(extractFencedBlock(body, "json")).toBe('{"id":"x"}');
  });

  it("extracts a glsl block", () => {
    expect(extractFencedBlock("```glsl\nvoid main(){}\n```", "glsl")).toBe("void main(){}");
  });

  it("returns undefined when the block is absent", () => {
    expect(extractFencedBlock("no code here", "json")).toBeUndefined();
  });
});
