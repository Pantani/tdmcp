import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  loadSessionProfileImpl,
  loadSessionProfileOutputSchema,
  loadSessionProfileSchema,
} from "../../src/tools/ai/loadSessionProfile.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TD_BASE = "http://127.0.0.1:9980";

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

let tmpDir: string;
let profilePath: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `tdmcp-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  profilePath = join(tmpDir, "session-profile.json");
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("loadSessionProfileSchema", () => {
  it("defaults reset to false", () => {
    const parsed = loadSessionProfileSchema.parse({});
    expect(parsed.reset).toBe(false);
  });

  it("accepts a custom profile_path", () => {
    const parsed = loadSessionProfileSchema.parse({ profile_path: "/tmp/my-profile.json" });
    expect(parsed.profile_path).toBe("/tmp/my-profile.json");
  });

  it("accepts reset=true", () => {
    const parsed = loadSessionProfileSchema.parse({ reset: true });
    expect(parsed.reset).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Happy path: no file → creates default
// ---------------------------------------------------------------------------

describe("loadSessionProfileImpl — no existing file", () => {
  it("creates a default skeleton and returns isError=falsy", async () => {
    const args = loadSessionProfileSchema.parse({ profile_path: profilePath });
    const result = await loadSessionProfileImpl(makeCtx(), args);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain(profilePath);
    // File should now exist
    expect(existsSync(profilePath)).toBe(true);
  });

  it("returned structuredContent matches output schema", async () => {
    const args = loadSessionProfileSchema.parse({ profile_path: profilePath });
    const result = await loadSessionProfileImpl(makeCtx(), args);
    const sc = result.structuredContent;
    expect(sc).toBeDefined();
    const parsed = loadSessionProfileOutputSchema.safeParse(sc);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.created).toBe(true);
      expect(parsed.data.profile_path).toBe(profilePath);
    }
  });

  it("written file is valid JSON", async () => {
    const args = loadSessionProfileSchema.parse({ profile_path: profilePath });
    await loadSessionProfileImpl(makeCtx(), args);
    const raw = JSON.parse(readFileSync(profilePath, "utf8"));
    expect(raw).toBeTruthy();
    expect(typeof raw.loaded_at).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Happy path: existing file → reads it back
// ---------------------------------------------------------------------------

describe("loadSessionProfileImpl — existing populated file", () => {
  it("reads and returns a previously written profile", async () => {
    const stored = {
      profile_path: profilePath,
      created: false,
      reset: false,
      loaded_at: "2026-01-01T00:00:00.000Z",
      style_memory: { default_energy: "high", palettes: [], tags: ["dark", "glitch"] },
      notes: ["previously saved"],
    };
    writeFileSync(profilePath, JSON.stringify(stored, null, 2), "utf8");

    const args = loadSessionProfileSchema.parse({ profile_path: profilePath });
    const result = await loadSessionProfileImpl(makeCtx(), args);
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toBeDefined();
    const sm = sc.style_memory as Record<string, unknown> | undefined;
    expect(sm?.default_energy).toBe("high");
  });

  it("summary mentions populated section count", async () => {
    const stored = {
      profile_path: profilePath,
      created: false,
      reset: false,
      loaded_at: "2026-01-01T00:00:00.000Z",
      style_memory: { default_energy: "medium" },
      conventions: { naming_label: "camelCase" },
      notes: [],
    };
    writeFileSync(profilePath, JSON.stringify(stored, null, 2), "utf8");

    const args = loadSessionProfileSchema.parse({ profile_path: profilePath });
    const result = await loadSessionProfileImpl(makeCtx(), args);
    const text = textOf(result);
    expect(text).toMatch(/2 section\(s\)/);
  });

  it("refreshes loaded_at without losing stored sections", async () => {
    const stored = {
      profile_path: profilePath,
      created: false,
      reset: false,
      loaded_at: "2026-01-01T00:00:00.000Z",
      style_memory: { default_energy: "low" },
      notes: [],
    };
    writeFileSync(profilePath, JSON.stringify(stored, null, 2), "utf8");

    const args = loadSessionProfileSchema.parse({ profile_path: profilePath });
    const result = await loadSessionProfileImpl(makeCtx(), args);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc?.loaded_at).not.toBe("2026-01-01T00:00:00.000Z");
    expect((sc?.style_memory as Record<string, unknown>)?.default_energy).toBe("low");

    // The on-disk file backing tdmcp://session/profile must also reflect the
    // refreshed loaded_at — otherwise the resource handler keeps serving the
    // stale timestamp after this tool runs.
    const onDisk = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, unknown>;
    expect(onDisk.loaded_at).toBe(sc?.loaded_at);
    expect(onDisk.loaded_at).not.toBe("2026-01-01T00:00:00.000Z");
    expect((onDisk.style_memory as Record<string, unknown>)?.default_energy).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Reset path
// ---------------------------------------------------------------------------

describe("loadSessionProfileImpl — reset=true", () => {
  it("overwrites an existing profile with defaults and sets reset=true", async () => {
    const stored = {
      profile_path: profilePath,
      created: false,
      reset: false,
      loaded_at: "2026-01-01T00:00:00.000Z",
      style_memory: { default_energy: "high" },
      notes: ["old"],
    };
    writeFileSync(profilePath, JSON.stringify(stored, null, 2), "utf8");

    const args = loadSessionProfileSchema.parse({ profile_path: profilePath, reset: true });
    const result = await loadSessionProfileImpl(makeCtx(), args);
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc?.reset).toBe(true);
    expect(sc?.style_memory).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain("reset");
  });
});

// ---------------------------------------------------------------------------
// Corrupt file
// ---------------------------------------------------------------------------

describe("loadSessionProfileImpl — corrupt file", () => {
  it("returns isError=true when the file cannot be parsed", async () => {
    writeFileSync(profilePath, "{ not valid json !!!", "utf8");

    const args = loadSessionProfileSchema.parse({ profile_path: profilePath });
    const result = await loadSessionProfileImpl(makeCtx(), args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/corrupt|parsed/i);
  });

  it("never throws out of the handler", async () => {
    writeFileSync(profilePath, "{ not valid json !!!", "utf8");

    const args = loadSessionProfileSchema.parse({ profile_path: profilePath });
    await expect(loadSessionProfileImpl(makeCtx(), args)).resolves.toBeDefined();
  });
});
