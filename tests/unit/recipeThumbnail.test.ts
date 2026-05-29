import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  captureThumbnail,
  injectAfterFrontmatter,
  resolveOutputTop,
} from "../../src/tools/vault/recipeThumbnail.js";
import { Vault } from "../../src/vault/index.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(): TouchDesignerClient {
  return new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 });
}

/** Creates a temp vault dir, runs fn, then cleans up. */
function withVault(fn: (vault: Vault) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-recipeThumbnail-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

describe("captureThumbnail", () => {
  // ── happy path ─────────────────────────────────────────────────────────────
  it("captures the preview, writes <dir>/<baseName>.png, and returns the wikilink embed", async () => {
    await withVault(async (vault) => {
      const result = await captureThumbnail(makeClient(), vault, "Recipes", "myGlow", {
        topPath: "/project1/out1",
      });

      expect(result.imageRel).toBe("Recipes/myGlow.png");
      expect(result.embed).toBe("![[myGlow.png]]");
      expect(result.warning).toBeUndefined();

      // The PNG binary was written — read with fs to preserve bytes.
      expect(vault.exists("Recipes/myGlow.png")).toBe(true);
      const buf = readFileSync(vault.resolve("Recipes/myGlow.png"));
      // PNG magic bytes 0x89 'P' 'N' 'G'.
      expect(buf[0]).toBe(0x89);
      expect(buf[1]).toBe(0x50);
      expect(buf[2]).toBe(0x4e);
      expect(buf[3]).toBe(0x47);
    });
  });

  // ── no topPath: cheap no-op, no bridge call ────────────────────────────────
  it("returns a warning and writes nothing when no topPath is given (no bridge call)", async () => {
    await withVault(async (vault) => {
      // onUnhandledRequest:"error" is set globally — any HTTP request would fail the test,
      // so reaching this assertion proves no bridge call fired.
      const result = await captureThumbnail(makeClient(), vault, "Recipes", "noTop", {});
      expect(result.imageRel).toBeNull();
      expect(result.embed).toBe("");
      expect(result.warning).toMatch(/No output TOP/);
      expect(vault.exists("Recipes/noTop.png")).toBe(false);
    });
  });

  // ── no client (bridge not configured) ──────────────────────────────────────
  it("degrades to embed:'' + warning when the client is undefined — never throws", async () => {
    await withVault(async (vault) => {
      const result = await captureThumbnail(undefined, vault, "Recipes", "noClient", {
        topPath: "/project1/out1",
      });
      expect(result.imageRel).toBeNull();
      expect(result.embed).toBe("");
      expect(result.warning).toMatch(/not connected/i);
      expect(vault.exists("Recipes/noClient.png")).toBe(false);
    });
  });

  // ── bridge / preview HTTP failure ──────────────────────────────────────────
  it("does not throw and returns a warning when the preview endpoint fails", async () => {
    server.use(http.get(`${TD_BASE}/api/preview/:seg`, () => HttpResponse.error()));

    await withVault(async (vault) => {
      let threw = false;
      let result: Awaited<ReturnType<typeof captureThumbnail>> | undefined;
      try {
        result = await captureThumbnail(makeClient(), vault, "Recipes", "offline", {
          topPath: "/project1/out1",
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result?.imageRel).toBeNull();
      expect(result?.embed).toBe("");
      expect(result?.warning).toMatch(/Thumbnail skipped/);
      expect(vault.exists("Recipes/offline.png")).toBe(false);
    });
  });

  // ── perform-mode skip (capturePreview throws TdApiError) ────────────────────
  it("degrades gracefully when perform mode is active (capturePreview throws)", async () => {
    // capturePreview probes perform mode via /api/exec reading tdmcp_perform_mode.
    // Returning perform:true makes it throw before any preview call.
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({ ok: true, data: { result: null, stdout: '{"perform": true}' } }),
      ),
    );

    await withVault(async (vault) => {
      let threw = false;
      let result: Awaited<ReturnType<typeof captureThumbnail>> | undefined;
      try {
        result = await captureThumbnail(makeClient(), vault, "Recipes", "performMode", {
          topPath: "/project1/out1",
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result?.imageRel).toBeNull();
      expect(result?.embed).toBe("");
      expect(result?.warning).toMatch(/Thumbnail skipped/);
      expect(vault.exists("Recipes/performMode.png")).toBe(false);
    });
  });
});

describe("resolveOutputTop", () => {
  it("picks the last TOP-typed node", () => {
    const top = resolveOutputTop(
      [
        { name: "noise1", type: "noiseTOP" },
        { name: "blur1", type: "blurTOP" },
      ],
      "/project1",
    );
    expect(top).toBe("/project1/blur1");
  });

  it("returns undefined for an empty node list", () => {
    expect(resolveOutputTop([], "/project1")).toBeUndefined();
  });

  it("returns undefined when no TOP is present (CHOP-only recipe -> caller skips)", () => {
    // The preview endpoint only renders TOPs, so a CHOP/DAT/SOP-only recipe must
    // resolve to undefined and take captureThumbnail's cheap no-op skip path.
    expect(resolveOutputTop([{ name: "lfo1", type: "lfoCHOP" }], "/project1")).toBeUndefined();
  });

  it("prefers a TOP even when it is not the last node", () => {
    const top = resolveOutputTop(
      [
        { name: "out1", type: "nullTOP" },
        { name: "lfo1", type: "lfoCHOP" },
      ],
      "/project1",
    );
    expect(top).toBe("/project1/out1");
  });
});

describe("injectAfterFrontmatter", () => {
  it("splices the block between the closing --- and the body", () => {
    const md = "---\nid: x\n---\nbody";
    const out = injectAfterFrontmatter(md, "EMBED\n");
    expect(out).toBe("---\nid: x\n---\nEMBED\nbody");
    // The block sits after the frontmatter close, before the body.
    expect(out.indexOf("EMBED")).toBeGreaterThan(out.indexOf("---\nid: x\n---"));
    expect(out.indexOf("EMBED")).toBeLessThan(out.indexOf("body"));
  });

  it("prepends the block when there is no frontmatter", () => {
    const out = injectAfterFrontmatter("just a body\n", "EMBED\n");
    expect(out).toBe("EMBED\njust a body\n");
  });

  it("handles CRLF frontmatter fences", () => {
    const md = "---\r\nid: x\r\n---\r\nbody";
    const out = injectAfterFrontmatter(md, "EMBED\n");
    expect(out.startsWith("---\r\nid: x\r\n---\r\nEMBED\n")).toBe(true);
  });
});
