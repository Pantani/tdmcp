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

const scannedMarkdownFiles = [
  join(root, "CLAUDE.md"),
  join(root, "README.md"),
  join(root, "llms-install.md"),
  join(root, "tdmcp-install-prompt.md"),
  join(root, "td", "README.md"),
  ...collectMarkdownFiles(join(root, "docs")),
];

const scannedPublicInstructionFiles = [...scannedMarkdownFiles, join(root, "td", "bootstrap.py")];
const directRemoteContentUrlPattern = /https?:\/\/[^\s/]+\/[^\s]*\.(?:txt|md|prompt)\b/i;

describe("SafeSkill hygiene", () => {
  it("keeps public instructions out of SafeSkill prompt-injection trigger patterns", () => {
    const forbidden = [
      {
        name: "role reassignment",
        pattern: /\bact\s+as\s+(?:my|a|the)\s+/i,
      },
      {
        name: "raw hosted source URL",
        pattern: /raw\.githubusercontent\.com/i,
      },
      {
        name: "direct remote markdown or prompt URL",
        pattern: directRemoteContentUrlPattern,
      },
      {
        name: "instruction-following URL",
        pattern: /follow\s+(?:the\s+)?instructions?\s+(?:at|from|in)\s+https?:\/\//i,
      },
      {
        name: "hidden HTML comment",
        pattern: /<!--[\s\S]*?-->/,
      },
    ];

    const violations: string[] = [];
    for (const file of scannedPublicInstructionFiles) {
      const text = readFileSync(file, "utf8");
      for (const { name, pattern } of forbidden) {
        for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
          const line = text.slice(0, match.index).split("\n").length;
          violations.push(`${relative(root, file)}:${line} ${name}: ${match[0]}`);
        }
      }

      for (const match of text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
        const altText = match[1] ?? "";
        if (/\b(?:ignore|override|system|execute|run|fetch|send)\b/i.test(altText)) {
          const line = text.slice(0, match.index).split("\n").length;
          violations.push(`${relative(root, file)}:${line} suspicious image alt text: ${altText}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("allows dot-md hostnames while rejecting direct remote content files", () => {
    expect(directRemoteContentUrlPattern.test("https://obsidian.md")).toBe(false);
    expect(directRemoteContentUrlPattern.test("https://example.com/docs/install.md")).toBe(true);
    expect(directRemoteContentUrlPattern.test("https://example.com/install.prompt")).toBe(true);
  });

  it("publishes repository metadata for security scanners", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: { version?: string };
      repository?: { type?: string; url?: string };
      version?: string;
      files?: string[];
    };
    const manifest = JSON.parse(readFileSync(join(root, "safeskill.manifest.json"), "utf8")) as {
      version?: string;
    };
    const syncScript = readFileSync(join(root, "scripts", "sync-manifest-version.mjs"), "utf8");

    expect(pkg.repository).toEqual({
      type: "git",
      url: "https://github.com/Pantani/tdmcp.git",
    });
    expect(pkg.files).toContain("safeskill.manifest.json");
    expect(manifest.version).toBe(pkg.version);
    expect(syncScript).toContain("safeskill.manifest.json");
    expect(pkg.scripts?.version).toContain("safeskill.manifest.json");
  });
});
