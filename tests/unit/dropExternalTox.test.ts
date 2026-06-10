import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { dropExternalTox } from "../../src/tools/util/dropExternalTox.js";
import type { Logger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Round-2 Wave-4 fix: dropExternalTox now pre-checks absolute candidate paths
// on the Node side and short-circuits BEFORE the bridge call when none exist.
// Tests that need the bridge to be reached must point candidate_paths at a
// real on-disk fixture.
const TMP_DIR = mkdtempSync(join(tmpdir(), "tdmcp-drop-test-"));
const FIXTURE_TOX = join(TMP_DIR, "MediaPipe.tox");
writeFileSync(FIXTURE_TOX, "stub");
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(): { ctx: ToolContext; warnSpy: ReturnType<typeof vi.fn> } {
  const warnSpy = vi.fn();
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
  };
  const ctx: ToolContext = {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger,
  };
  return { ctx, warnSpy };
}

interface BridgeReport {
  error?: string;
  detail?: string;
  parent_path?: string;
  candidates_checked?: string[];
  found_path?: string;
  container_name?: string;
  container_path?: string;
  validated_pars?: string[];
  missing_pars?: string[];
  warnings?: string[];
}

function mockExec(report: BridgeReport): void {
  server.use(
    http.post(`${TD_BASE}/api/exec`, async () => {
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify({ warnings: [], ...report }) },
      });
    }),
  );
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("dropExternalTox", () => {
  it("case 1: happy path — first candidate hit, all pars validated", async () => {
    mockExec({
      found_path: FIXTURE_TOX,
      container_name: "MediaPipe",
      container_path: "/project1/MediaPipe",
      validated_pars: ["Active", "Maxhands"],
      missing_pars: [],
      warnings: [],
    });

    const { ctx, warnSpy } = makeCtx();
    const result = await dropExternalTox(ctx, {
      parent_path: "/project1",
      candidate_paths: [FIXTURE_TOX, "/fallback/MediaPipe.tox"],
      expected_custom_pars: ["Active", "Maxhands"],
    });

    expect("ok" in result).toBe(true);
    if (!("ok" in result)) return;
    expect(result.ok.found_path).toBe(FIXTURE_TOX);
    expect(result.ok.container_path).toBe("/project1/MediaPipe");
    expect(result.ok.validated_pars).toEqual(["Active", "Maxhands"]);
    expect(result.ok.missing_pars).toHaveLength(0);
    expect(result.ok.warnings).toHaveLength(0);
    // No logger.warn call when all pars are present
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("case 2: no candidate found — when at least one relative path is present, bridge is consulted and returns the error", async () => {
    mockExec({
      error: "no_candidate_found",
      candidates_checked: ["/abs/a.tox", "rel/b.tox"],
    });

    const { ctx } = makeCtx();
    // Mixing a relative candidate forces the bridge call (precheck cannot
    // evaluate project-relative paths on Node side).
    const result = await dropExternalTox(ctx, {
      parent_path: "/project1",
      candidate_paths: ["/abs/a.tox", "rel/b.tox"],
      expected_custom_pars: [],
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.isError).toBe(true);
    const text = textOf(result.error);
    expect(text).toContain("/abs/a.tox");
    expect(text).toContain("rel/b.tox");
    expect(text).toContain("Install the package");
  });

  it("case 2b: TS-side pre-check — all-absolute and missing short-circuits WITHOUT calling the bridge", async () => {
    let execCalled = false;
    server.use(
      http.post(`${TD_BASE}/api/exec`, async () => {
        execCalled = true;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const { ctx } = makeCtx();
    const missingAbs = join(TMP_DIR, "no-such-dir", "Nope.tox");
    const result = await dropExternalTox(ctx, {
      parent_path: "/project1",
      candidate_paths: [missingAbs, "/also/nope.tox"],
      expected_custom_pars: [],
    });

    expect(execCalled).toBe(false);
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.isError).toBe(true);
    const text = textOf(result.error);
    expect(text).toContain(missingAbs);
    expect(text).toContain("/also/nope.tox");
    expect(text).toContain("Install the package");
  });

  it("case 3: par missing, on_missing: 'warn' (default) — ok:true with warning", async () => {
    mockExec({
      found_path: "/abs/MediaPipe.tox",
      container_path: "/project1/MediaPipe",
      validated_pars: ["Active"],
      missing_pars: ["Maxhands"],
      warnings: [],
    });

    const { ctx, warnSpy } = makeCtx();
    const result = await dropExternalTox(ctx, {
      parent_path: "/project1",
      candidate_paths: [FIXTURE_TOX],
      expected_custom_pars: ["Active", "Maxhands"],
      // on_missing defaults to "warn"
    });

    expect("ok" in result).toBe(true);
    if (!("ok" in result)) return;
    expect(result.ok.missing_pars).toEqual(["Maxhands"]);
    // Warnings array should mention the missing par
    expect(result.ok.warnings.some((w) => w.includes("Maxhands"))).toBe(true);
    // logger.warn must have been called with the missing par detail
    expect(warnSpy).toHaveBeenCalledWith(
      "dropExternalTox: missing custom pars",
      expect.objectContaining({ missing_pars: ["Maxhands"] }),
    );
  });

  it("case 4: par missing, on_missing: 'error' — returns error with report JSON fence", async () => {
    mockExec({
      found_path: "/abs/MediaPipe.tox",
      container_path: "/project1/MediaPipe",
      validated_pars: ["Active"],
      missing_pars: ["Maxhands"],
      warnings: [],
    });

    const { ctx } = makeCtx();
    const result = await dropExternalTox(ctx, {
      parent_path: "/project1",
      candidate_paths: [FIXTURE_TOX],
      expected_custom_pars: ["Active", "Maxhands"],
      on_missing: "error",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.isError).toBe(true);
    const text = textOf(result.error);
    expect(text).toContain("Maxhands");
    // Report JSON fence should include validated_pars so caller can recover
    expect(text).toContain("validated_pars");
  });

  it("case 5: parent path missing — error mentioning the path", async () => {
    mockExec({
      error: "parent_missing",
      parent_path: "/project99",
    });

    const { ctx } = makeCtx();
    const result = await dropExternalTox(ctx, {
      parent_path: "/project99",
      candidate_paths: [FIXTURE_TOX],
      expected_custom_pars: [],
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.isError).toBe(true);
    const text = textOf(result.error);
    expect(text).toContain("/project99");
    expect(text).toContain("Create it first");
  });

  it("case 6: bridge offline — guardTd-equivalent error, no throw", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => {
        return HttpResponse.error();
      }),
    );

    const { ctx } = makeCtx();
    // Must not throw — catch block should turn TdConnectionError into { error }
    const result = await dropExternalTox(ctx, {
      parent_path: "/project1",
      candidate_paths: [FIXTURE_TOX],
      expected_custom_pars: [],
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error.isError).toBe(true);
    const text = textOf(result.error);
    // Friendly error message — at minimum a non-empty string
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });
});
