import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { componentChangelogTrailImpl } from "../../src/tools/library/componentChangelogTrail.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function withVault(fn: (vault: Vault, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-trail-"));
  return Promise.resolve(fn(new Vault(dir), dir)).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

function ctxNoVault(): ToolContext {
  return { logger: silentLogger } as unknown as ToolContext;
}

function ctxWith(vault: Vault): ToolContext {
  return { logger: silentLogger, vault } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function jsonOf<T = Record<string, unknown>>(result: CallToolResult): T {
  const text = textOf(result);
  const m = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!m) throw new Error(`No JSON block in: ${text}`);
  return JSON.parse(m[1] ?? "{}") as T;
}

const COMP_REL = "Components/MyFx.tox";
const TRAIL_REL = `${COMP_REL}.trail.jsonl`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("componentChangelogTrail", () => {
  it("appends a JSONL line with sha256 and size", async () => {
    await withVault(async (vault, dir) => {
      // Create the .tox file
      const toxDir = join(dir, "Components");
      mkdirSync(toxDir, { recursive: true });
      writeFileSync(join(dir, COMP_REL), Buffer.from("fake tox bytes"));

      const result = await componentChangelogTrailImpl(ctxWith(vault), {
        componentPath: COMP_REL,
        action: "append",
        entry: { note: "first revision", changedParams: [] },
        includeSha: true,
        exportNoteName: undefined,
      });

      expect(result.isError).toBeFalsy();
      const data = jsonOf<{
        trail_path: string;
        entry: Record<string, unknown>;
        entry_count: number;
      }>(result);
      expect(data.entry_count).toBe(1);
      expect(data.trail_path).toBe(TRAIL_REL);

      // Read raw JSONL
      const raw = readFileSync(join(dir, TRAIL_REL), "utf8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      expect(entry.schema_version).toBe(1);
      expect(entry.note).toBe("first revision");
      expect(typeof entry.author).toBe("string");
      expect(typeof entry.ts).toBe("string");
      expect(typeof entry.sha256).toBe("string");
      expect(entry.sha256 as string).toHaveLength(64); // hex sha256
      expect(typeof entry.size).toBe("number");
      expect(entry.changedParams).toEqual([]);
    });
  });

  it("appends twice → two lines, first line unchanged", async () => {
    await withVault(async (vault, dir) => {
      const toxDir = join(dir, "Components");
      mkdirSync(toxDir, { recursive: true });
      writeFileSync(join(dir, COMP_REL), Buffer.from("tox v1"));

      await componentChangelogTrailImpl(ctxWith(vault), {
        componentPath: COMP_REL,
        action: "append",
        entry: { note: "first", changedParams: [] },
        includeSha: false,
        exportNoteName: undefined,
      });
      await componentChangelogTrailImpl(ctxWith(vault), {
        componentPath: COMP_REL,
        action: "append",
        entry: { note: "second", changedParams: ["a/tx"] },
        includeSha: false,
        exportNoteName: undefined,
      });

      const raw = readFileSync(join(dir, TRAIL_REL), "utf8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(2);

      const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      expect(first.note).toBe("first");
      const second = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
      expect(second.note).toBe("second");
      expect(second.changedParams).toEqual(["a/tx"]);
    });
  });

  it("read returns parsed entries and no warnings", async () => {
    await withVault(async (vault, dir) => {
      const toxDir = join(dir, "Components");
      mkdirSync(toxDir, { recursive: true });
      writeFileSync(join(dir, COMP_REL), Buffer.from("bytes"));

      await componentChangelogTrailImpl(ctxWith(vault), {
        componentPath: COMP_REL,
        action: "append",
        entry: { note: "r1", changedParams: [] },
        includeSha: false,
        exportNoteName: undefined,
      });
      await componentChangelogTrailImpl(ctxWith(vault), {
        componentPath: COMP_REL,
        action: "append",
        entry: { note: "r2", changedParams: [] },
        includeSha: false,
        exportNoteName: undefined,
      });

      const result = await componentChangelogTrailImpl(ctxWith(vault), {
        componentPath: COMP_REL,
        action: "read",
        includeSha: true,
        exportNoteName: undefined,
      });
      expect(result.isError).toBeFalsy();
      const data = jsonOf<{ entries: unknown[]; warnings: string[] }>(result);
      expect(data.entries).toHaveLength(2);
      expect(data.warnings).toHaveLength(0);
    });
  });

  it("read tolerates a malformed line and returns a warning", async () => {
    await withVault(async (vault, dir) => {
      const toxDir = join(dir, "Components");
      mkdirSync(toxDir, { recursive: true });
      writeFileSync(join(dir, COMP_REL), Buffer.from("bytes"));

      // Write one good line then a garbage line
      const trailAbs = join(dir, TRAIL_REL);
      appendFileSync(
        trailAbs,
        `${JSON.stringify({
          schema_version: 1,
          note: "ok",
          ts: new Date().toISOString(),
          author: "x",
          changedParams: [],
        })}\n`,
        "utf8",
      );
      appendFileSync(trailAbs, "NOT_JSON_AT_ALL\n", "utf8");

      const result = await componentChangelogTrailImpl(ctxWith(vault), {
        componentPath: COMP_REL,
        action: "read",
        includeSha: true,
        exportNoteName: undefined,
      });
      const data = jsonOf<{ entries: unknown[]; warnings: string[] }>(result);
      expect(data.entries).toHaveLength(1);
      expect(data.warnings.length).toBeGreaterThan(0);
    });
  });

  it("read returns empty entries when trail file does not exist", async () => {
    await withVault(async (vault) => {
      const result = await componentChangelogTrailImpl(ctxWith(vault), {
        componentPath: COMP_REL,
        action: "read",
        includeSha: true,
        exportNoteName: undefined,
      });
      expect(result.isError).toBeFalsy();
      const data = jsonOf<{ entries: unknown[] }>(result);
      expect(data.entries).toHaveLength(0);
    });
  });

  it("export writes a markdown note with reverse-chronological revisions", async () => {
    await withVault(async (vault, dir) => {
      const toxDir = join(dir, "Components");
      mkdirSync(toxDir, { recursive: true });
      writeFileSync(join(dir, COMP_REL), Buffer.from("bytes"));

      await componentChangelogTrailImpl(ctxWith(vault), {
        componentPath: COMP_REL,
        action: "append",
        entry: { note: "initial build", ts: "2026-05-01T10:00:00.000Z", changedParams: [] },
        includeSha: false,
        exportNoteName: undefined,
      });
      await componentChangelogTrailImpl(ctxWith(vault), {
        componentPath: COMP_REL,
        action: "append",
        entry: {
          note: "strobe stage",
          ts: "2026-05-31T14:22:00.000Z",
          changedParams: ["transform1/tx"],
        },
        includeSha: false,
        exportNoteName: undefined,
      });

      const result = await componentChangelogTrailImpl(ctxWith(vault), {
        componentPath: COMP_REL,
        action: "export",
        includeSha: false,
        exportNoteName: undefined,
      });
      expect(result.isError).toBeFalsy();
      const data = jsonOf<{ note_path: string; entry_count: number }>(result);
      expect(data.entry_count).toBe(2);
      expect(data.note_path).toBe(`${COMP_REL}.CHANGELOG.md`);

      const mdAbs = join(dir, data.note_path);
      expect(existsSync(mdAbs)).toBe(true);
      const md = readFileSync(mdAbs, "utf8");
      expect(md).toContain("type: component-changelog");
      expect(md).toContain("tox: MyFx.tox");
      expect(md).toContain("## Revisions");
      // Reverse chronological: strobe stage should come first
      const idxStrobe = md.indexOf("strobe stage");
      const idxInitial = md.indexOf("initial build");
      expect(idxStrobe).toBeLessThan(idxInitial);
    });
  });

  it("includeSha:false skips sha256 field", async () => {
    await withVault(async (vault, dir) => {
      const toxDir = join(dir, "Components");
      mkdirSync(toxDir, { recursive: true });
      writeFileSync(join(dir, COMP_REL), Buffer.from("bytes"));

      await componentChangelogTrailImpl(ctxWith(vault), {
        componentPath: COMP_REL,
        action: "append",
        entry: { note: "no hash", changedParams: [] },
        includeSha: false,
        exportNoteName: undefined,
      });

      const raw = readFileSync(join(dir, TRAIL_REL), "utf8");
      const entry = JSON.parse(raw.trim()) as Record<string, unknown>;
      expect(entry.sha256).toBeUndefined();
      expect(entry.size).toBeUndefined();
    });
  });

  it("vault escape returns errorResult", async () => {
    await withVault(async (vault) => {
      const result = await componentChangelogTrailImpl(ctxWith(vault), {
        componentPath: "../escape.tox",
        action: "read",
        includeSha: true,
        exportNoteName: undefined,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("escapes");
    });
  });

  it("missing vault returns NO_VAULT error", async () => {
    const result = await componentChangelogTrailImpl(ctxNoVault(), {
      componentPath: COMP_REL,
      action: "read",
      includeSha: true,
      exportNoteName: undefined,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });
});
