import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function collectMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(path);
    }
  }
  return out;
}

const publicInstallFiles = [
  join(root, "README.md"),
  join(root, "td", "README.md"),
  join(root, "td", "bootstrap.py"),
  ...collectMarkdownFiles(join(root, "docs")),
];

describe("bootstrap release pinning", () => {
  it("does not publish mutable-branch bootstrap download snippets", () => {
    const violations: string[] = [];
    for (const file of publicInstallFiles) {
      const text = readFileSync(file, "utf8");
      for (const pattern of [
        /github\.com\/Pantani\/tdmcp\/raw\/main\/td\/bootstrap\.py/g,
        /github\.com\/Pantani\/tdmcp\/archive\/refs\/heads\/main\.zip/g,
      ]) {
        for (const match of text.matchAll(pattern)) {
          const line = text.slice(0, match.index).split("\n").length;
          violations.push(`${relative(root, file)}:${line} ${match[0]}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("updates bootstrap release pins during npm version sync", () => {
    const syncScript = readFileSync(join(root, "scripts", "sync-manifest-version.mjs"), "utf8");

    expect(syncScript).toContain("td/bootstrap.py");
    expect(syncScript).toContain("raw/v");
    expect(syncScript).toContain("archive/refs/tags/v");
  });
});
