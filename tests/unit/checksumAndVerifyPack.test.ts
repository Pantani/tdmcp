import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checksumAndVerifyPackImpl } from "../../src/tools/library/checksumAndVerifyPack.js";
import type { ToolContext } from "../../src/tools/types.js";

// ── Stub context — client must never be called ────────────────────────────────

let stubCallCount = 0;

function makeCtx(): ToolContext {
  stubCallCount = 0;
  const stub = new Proxy(
    {},
    {
      get(_t, prop) {
        return (..._args: unknown[]) => {
          stubCallCount++;
          throw new Error(`ctx.client.${String(prop)} must not be called in a pure-FS tool`);
        };
      },
    },
  );
  return {
    client: stub as unknown as ToolContext["client"],
    knowledge: {} as unknown as ToolContext["knowledge"],
    recipes: [] as unknown as ToolContext["recipes"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as ToolContext["logger"],
    allowRawPython: false,
  };
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tdmcp-checksum-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. compute on a single file ────────────────────────────────────────────

it("compute on a single file writes a 1-entry manifest", async () => {
  const buf = Buffer.from("hello tdmcp");
  const filePath = join(tmpDir, "MyComp.tox");
  writeFileSync(filePath, buf);

  const ctx = makeCtx();
  const res = await checksumAndVerifyPackImpl(ctx, {
    action: "compute",
    path: filePath,
    include_globs: [],
    exclude_globs: ["**/tdmcp-checksums.json", "**/.DS_Store", "**/node_modules/**", "**/.git/**"],
    follow_symlinks: false,
    max_file_bytes: 2 * 1024 * 1024 * 1024,
    strict: true,
  });

  expect(res.isError).toBeFalsy();
  const data = res.structuredContent as {
    files: Array<{ path: string; sha256: string; size: number }>;
  };
  expect(data.files).toHaveLength(1);
  expect(data.files[0]?.path).toBe("MyComp.tox");
  expect(data.files[0]?.sha256).toBe(sha256(buf));
  expect(data.files[0]?.size).toBe(statSync(filePath).size);
  expect(stubCallCount).toBe(0);
});

// ── 2. compute on a directory with a subdir ────────────────────────────────

it("compute on a directory produces lex-sorted POSIX paths", async () => {
  writeFileSync(join(tmpDir, "a.tox"), Buffer.from("aaa"));
  writeFileSync(join(tmpDir, "b.json"), Buffer.from("bbb"));
  mkdirSync(join(tmpDir, "docs"));
  writeFileSync(join(tmpDir, "docs", "README.md"), Buffer.from("readme"));

  const ctx = makeCtx();
  const res = await checksumAndVerifyPackImpl(ctx, {
    action: "compute",
    path: tmpDir,
    include_globs: [],
    exclude_globs: ["**/tdmcp-checksums.json", "**/.DS_Store", "**/node_modules/**", "**/.git/**"],
    follow_symlinks: false,
    max_file_bytes: 2 * 1024 * 1024 * 1024,
    strict: true,
  });

  expect(res.isError).toBeFalsy();
  const data = res.structuredContent as { files: Array<{ path: string }> };
  const paths = data.files.map((f) => f.path);
  // lex-sorted
  expect(paths).toEqual([...paths].sort());
  // POSIX separators on all platforms
  for (const p of paths) {
    expect(p).not.toContain("\\");
  }
  expect(paths).toContain("docs/README.md");
  expect(stubCallCount).toBe(0);
});

// ── 3. compute is deterministic ────────────────────────────────────────────

it("compute is deterministic across two runs", async () => {
  writeFileSync(join(tmpDir, "x.tox"), Buffer.from("stable"));
  mkdirSync(join(tmpDir, "sub"));
  writeFileSync(join(tmpDir, "sub", "y.json"), Buffer.from("also stable"));

  const args = {
    action: "compute" as const,
    path: tmpDir,
    include_globs: [] as string[],
    exclude_globs: ["**/tdmcp-checksums.json", "**/.DS_Store", "**/node_modules/**", "**/.git/**"],
    follow_symlinks: false,
    max_file_bytes: 2 * 1024 * 1024 * 1024,
    strict: true,
  };

  const ctx = makeCtx();
  const r1 = (await checksumAndVerifyPackImpl(ctx, args)).structuredContent as {
    files: Array<{ path: string; sha256: string; size: number }>;
  };
  const r2 = (await checksumAndVerifyPackImpl(ctx, args)).structuredContent as {
    files: Array<{ path: string; sha256: string; size: number }>;
  };

  expect(r1.files).toEqual(r2.files);
  expect(stubCallCount).toBe(0);
});

// ── 4. verify happy path ───────────────────────────────────────────────────

describe("verify happy path (3 files + subdir)", () => {
  async function buildFixture() {
    writeFileSync(join(tmpDir, "a.tox"), Buffer.from("aaa"));
    writeFileSync(join(tmpDir, "b.json"), Buffer.from("bbb"));
    mkdirSync(join(tmpDir, "docs"));
    writeFileSync(join(tmpDir, "docs", "README.md"), Buffer.from("readme"));

    const ctx = makeCtx();
    await checksumAndVerifyPackImpl(ctx, {
      action: "compute",
      path: tmpDir,
      include_globs: [],
      exclude_globs: [
        "**/tdmcp-checksums.json",
        "**/.DS_Store",
        "**/node_modules/**",
        "**/.git/**",
      ],
      follow_symlinks: false,
      max_file_bytes: 2 * 1024 * 1024 * 1024,
      strict: true,
    });
  }

  it("returns ok:true checked:3", async () => {
    await buildFixture();
    const ctx = makeCtx();
    const res = await checksumAndVerifyPackImpl(ctx, {
      action: "verify",
      path: tmpDir,
      include_globs: [],
      exclude_globs: [
        "**/tdmcp-checksums.json",
        "**/.DS_Store",
        "**/node_modules/**",
        "**/.git/**",
      ],
      follow_symlinks: false,
      max_file_bytes: 2 * 1024 * 1024 * 1024,
      strict: true,
    });

    expect(res.isError).toBeFalsy();
    const v = res.structuredContent as {
      ok: boolean;
      checked: number;
      mismatches: unknown[];
      missing: unknown[];
      extra: unknown[];
    };
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(3);
    expect(v.mismatches).toHaveLength(0);
    expect(v.missing).toHaveLength(0);
    expect(v.extra).toHaveLength(0);
    expect(stubCallCount).toBe(0);
  });
});

// ── 5. verify detects a tampered file ─────────────────────────────────────

it("verify detects a tampered file", async () => {
  writeFileSync(join(tmpDir, "a.tox"), Buffer.from("aaa"));
  mkdirSync(join(tmpDir, "docs"));
  writeFileSync(join(tmpDir, "docs", "README.md"), Buffer.from("readme"));

  const ctx = makeCtx();
  await checksumAndVerifyPackImpl(ctx, {
    action: "compute",
    path: tmpDir,
    include_globs: [],
    exclude_globs: ["**/tdmcp-checksums.json", "**/.DS_Store", "**/node_modules/**", "**/.git/**"],
    follow_symlinks: false,
    max_file_bytes: 2 * 1024 * 1024 * 1024,
    strict: true,
  });

  // Tamper
  writeFileSync(join(tmpDir, "docs", "README.md"), Buffer.from("TAMPERED"));

  const res = await checksumAndVerifyPackImpl(ctx, {
    action: "verify",
    path: tmpDir,
    include_globs: [],
    exclude_globs: ["**/tdmcp-checksums.json", "**/.DS_Store", "**/node_modules/**", "**/.git/**"],
    follow_symlinks: false,
    max_file_bytes: 2 * 1024 * 1024 * 1024,
    strict: true,
  });

  const v = res.structuredContent as {
    ok: boolean;
    mismatches: Array<{ path: string; expected: string; actual: string }>;
  };
  expect(v.ok).toBe(false);
  expect(v.mismatches).toHaveLength(1);
  expect(v.mismatches[0]?.path).toBe("docs/README.md");
  expect(v.mismatches[0]?.expected).not.toBe(v.mismatches[0]?.actual);
  expect(stubCallCount).toBe(0);
});

// ── 6. verify detects a missing file ──────────────────────────────────────

it("verify detects a missing file", async () => {
  writeFileSync(join(tmpDir, "a.tox"), Buffer.from("aaa"));
  writeFileSync(join(tmpDir, "b.json"), Buffer.from("bbb"));

  const ctx = makeCtx();
  await checksumAndVerifyPackImpl(ctx, {
    action: "compute",
    path: tmpDir,
    include_globs: [],
    exclude_globs: ["**/tdmcp-checksums.json", "**/.DS_Store", "**/node_modules/**", "**/.git/**"],
    follow_symlinks: false,
    max_file_bytes: 2 * 1024 * 1024 * 1024,
    strict: true,
  });

  rmSync(join(tmpDir, "b.json"));

  const res = await checksumAndVerifyPackImpl(ctx, {
    action: "verify",
    path: tmpDir,
    include_globs: [],
    exclude_globs: ["**/tdmcp-checksums.json", "**/.DS_Store", "**/node_modules/**", "**/.git/**"],
    follow_symlinks: false,
    max_file_bytes: 2 * 1024 * 1024 * 1024,
    strict: true,
  });

  const v = res.structuredContent as { ok: boolean; missing: string[] };
  expect(v.ok).toBe(false);
  expect(v.missing).toContain("b.json");
  expect(stubCallCount).toBe(0);
});

// ── 7. verify detects extra files (strict vs lenient) ──────────────────────

it("verify strict=true fails on extra file, strict=false does not", async () => {
  writeFileSync(join(tmpDir, "a.tox"), Buffer.from("aaa"));

  const ctx = makeCtx();
  await checksumAndVerifyPackImpl(ctx, {
    action: "compute",
    path: tmpDir,
    include_globs: [],
    exclude_globs: ["**/tdmcp-checksums.json", "**/.DS_Store", "**/node_modules/**", "**/.git/**"],
    follow_symlinks: false,
    max_file_bytes: 2 * 1024 * 1024 * 1024,
    strict: true,
  });

  // Add an extra file
  writeFileSync(join(tmpDir, "extra.txt"), Buffer.from("extra"));

  const strictRes = await checksumAndVerifyPackImpl(ctx, {
    action: "verify",
    path: tmpDir,
    include_globs: [],
    exclude_globs: ["**/tdmcp-checksums.json", "**/.DS_Store", "**/node_modules/**", "**/.git/**"],
    follow_symlinks: false,
    max_file_bytes: 2 * 1024 * 1024 * 1024,
    strict: true,
  });
  const sv = strictRes.structuredContent as { ok: boolean; extra: string[] };
  expect(sv.ok).toBe(false);
  expect(sv.extra).toContain("extra.txt");

  const lenientRes = await checksumAndVerifyPackImpl(ctx, {
    action: "verify",
    path: tmpDir,
    include_globs: [],
    exclude_globs: ["**/tdmcp-checksums.json", "**/.DS_Store", "**/node_modules/**", "**/.git/**"],
    follow_symlinks: false,
    max_file_bytes: 2 * 1024 * 1024 * 1024,
    strict: false,
  });
  const lv = lenientRes.structuredContent as { ok: boolean };
  expect(lv.ok).toBe(true);
  expect(stubCallCount).toBe(0);
});

// ── 8. verify rejects unknown manifest kind ───────────────────────────────

it("verify rejects unknown manifest kind", async () => {
  const manifestPath = join(tmpDir, "tdmcp-checksums.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      kind: "something-else",
      version: 1,
      files: [],
      created_at: "",
      tdmcp_version: "0",
    }),
  );

  const ctx = makeCtx();
  const res = await checksumAndVerifyPackImpl(ctx, {
    action: "verify",
    path: tmpDir,
    include_globs: [],
    exclude_globs: ["**/tdmcp-checksums.json", "**/.DS_Store", "**/node_modules/**", "**/.git/**"],
    follow_symlinks: false,
    max_file_bytes: 2 * 1024 * 1024 * 1024,
    strict: true,
  });

  expect(res.isError).toBe(true);
  expect(stubCallCount).toBe(0);
});

// ── 9. glob excludes drop .DS_Store and manifest itself ────────────────────

it("default excludes drop .DS_Store and tdmcp-checksums.json", async () => {
  writeFileSync(join(tmpDir, "real.tox"), Buffer.from("real"));
  writeFileSync(join(tmpDir, ".DS_Store"), Buffer.from("mac"));
  writeFileSync(join(tmpDir, "tdmcp-checksums.json"), Buffer.from("{}"));

  const ctx = makeCtx();
  const res = await checksumAndVerifyPackImpl(ctx, {
    action: "compute",
    path: tmpDir,
    include_globs: [],
    exclude_globs: ["**/tdmcp-checksums.json", "**/.DS_Store", "**/node_modules/**", "**/.git/**"],
    follow_symlinks: false,
    max_file_bytes: 2 * 1024 * 1024 * 1024,
    strict: true,
  });

  const data = res.structuredContent as { files: Array<{ path: string }> };
  const paths = data.files.map((f) => f.path);
  expect(paths).toContain("real.tox");
  expect(paths).not.toContain(".DS_Store");
  expect(paths).not.toContain("tdmcp-checksums.json");
  expect(stubCallCount).toBe(0);
});

// ── 10. max_file_bytes guard ──────────────────────────────────────────────

it("compute rejects a file above max_file_bytes", async () => {
  writeFileSync(join(tmpDir, "huge.tox"), Buffer.alloc(100));

  const ctx = makeCtx();
  const res = await checksumAndVerifyPackImpl(ctx, {
    action: "compute",
    path: tmpDir,
    include_globs: [],
    exclude_globs: ["**/tdmcp-checksums.json", "**/.DS_Store", "**/node_modules/**", "**/.git/**"],
    follow_symlinks: false,
    max_file_bytes: 50, // below 100 bytes
    strict: true,
  });

  expect(res.isError).toBe(true);
  const text =
    res.content[0] && "text" in res.content[0] ? (res.content[0] as { text: string }).text : "";
  expect(text).toMatch(/huge\.tox/);
  expect(stubCallCount).toBe(0);
});

// ── 11. inline manifest verify ────────────────────────────────────────────

it("verify works with an inline manifest (no tdmcp-checksums.json on disk)", async () => {
  const buf = Buffer.from("inline test");
  writeFileSync(join(tmpDir, "comp.tox"), buf);

  const sha = sha256(buf);
  const size = statSync(join(tmpDir, "comp.tox")).size;

  const ctx = makeCtx();
  const res = await checksumAndVerifyPackImpl(ctx, {
    action: "verify",
    path: tmpDir,
    manifest: {
      files: [{ path: "comp.tox", sha256: sha, size }],
      created_at: new Date().toISOString(),
      tdmcp_version: "0.9.0",
    },
    include_globs: [],
    exclude_globs: ["**/tdmcp-checksums.json", "**/.DS_Store", "**/node_modules/**", "**/.git/**"],
    follow_symlinks: false,
    max_file_bytes: 2 * 1024 * 1024 * 1024,
    strict: false, // no manifest on disk → no extra-file noise
  });

  expect(res.isError).toBeFalsy();
  const v = res.structuredContent as { ok: boolean; checked: number };
  expect(v.ok).toBe(true);
  expect(v.checked).toBe(1);
  expect(stubCallCount).toBe(0);
});

// ── 12. bridge isolation ───────────────────────────────────────────────────

it("ctx.client is never called across all test scenarios", () => {
  // stubCallCount is reset in makeCtx(); each test above asserts it stays 0.
  // This final guard makes the isolation contract explicit.
  expect(stubCallCount).toBe(0);
});
