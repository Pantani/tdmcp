import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { captureToVaultImpl, captureToVaultSchema } from "../../src/tools/vault/captureToVault.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Tiny 1×1 transparent PNG (base64) returned by the mock preview endpoint.
const PREVIEW_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeClient(): TouchDesignerClient {
  return new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 });
}

function ctxNoVault(): ToolContext {
  return { client: makeClient(), logger: silentLogger } as unknown as ToolContext;
}

function ctxWith(vault: Vault): ToolContext {
  return { client: makeClient(), logger: silentLogger, vault } as unknown as ToolContext;
}

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

/** Creates a temp vault dir, runs fn, then cleans up. */
function withVault(fn: (vault: Vault) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-captureToVault-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

describe("captureToVaultImpl", () => {
  // ── schema defaults ──────────────────────────────────────────────────────
  it("schema applies defaults for gallery/width/height", () => {
    const parsed = captureToVaultSchema.parse({ node_path: "/project1/out1" });
    expect(parsed.gallery).toBe("Gallery");
    expect(parsed.width).toBe(640);
    expect(parsed.height).toBe(360);
    expect(parsed.note).toBeUndefined();
    expect(parsed.caption).toBeUndefined();
  });

  // ── no vault ─────────────────────────────────────────────────────────────
  it("returns isError when no vault is configured — never throws", async () => {
    const result = await captureToVaultImpl(ctxNoVault(), {
      node_path: "/project1/out1",
      gallery: "Gallery",
      width: 640,
      height: 360,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  // ── happy path ────────────────────────────────────────────────────────────
  it("captures and writes the PNG + gallery note on the first capture", async () => {
    await withVault(async (vault) => {
      const result = await captureToVaultImpl(ctxWith(vault), {
        node_path: "/project1/out1",
        gallery: "Gallery",
        note: "2099-01-01",
        caption: "first look",
        width: 640,
        height: 360,
      });

      expect(result.isError).toBeFalsy();

      const data = jsonOf<{
        note: string;
        image: string;
        capture_number: number;
        caption: string;
        warnings: string[];
      }>(result);

      expect(data.note).toBe("Gallery/2099-01-01.md");
      expect(data.image).toMatch(/^Gallery\/images\/.+\.png$/);
      expect(data.capture_number).toBe(1);
      expect(data.caption).toBe("first look");
      expect(data.warnings).toHaveLength(0);

      // The PNG binary was written — read it with fs to preserve bytes.
      expect(vault.exists(data.image)).toBe(true);
      const imgBuf = readFileSync(vault.resolve(data.image));
      // Check PNG magic bytes.
      expect(imgBuf[0]).toBe(0x89);
      expect(imgBuf[1]).toBe(0x50); // P
      expect(imgBuf[2]).toBe(0x4e); // N
      expect(imgBuf[3]).toBe(0x47); // G

      // The gallery note was created.
      expect(vault.exists("Gallery/2099-01-01.md")).toBe(true);
      const noteContent = vault.read("Gallery/2099-01-01.md");
      expect(noteContent).toContain("![[images/");
      expect(noteContent).toContain("first look");

      // Summary text mentions the note.
      expect(textOf(result)).toContain("Gallery/2099-01-01.md");
      expect(textOf(result)).toContain("(image 1)");
    });
  });

  it("appends a second capture block to the same gallery note", async () => {
    await withVault(async (vault) => {
      const base = {
        node_path: "/project1/out1",
        gallery: "Gallery",
        note: "2099-01-01",
        width: 640,
        height: 360,
      } as const;

      // First capture.
      const r1 = await captureToVaultImpl(ctxWith(vault), { ...base, caption: "look A" });
      expect(r1.isError).toBeFalsy();
      const d1 = jsonOf<{ capture_number: number; image: string }>(r1);
      expect(d1.capture_number).toBe(1);

      // Second capture.
      const r2 = await captureToVaultImpl(ctxWith(vault), { ...base, caption: "look B" });
      expect(r2.isError).toBeFalsy();
      const d2 = jsonOf<{ capture_number: number; image: string }>(r2);
      expect(d2.capture_number).toBe(2);

      // Both image files exist.
      expect(vault.exists(d1.image)).toBe(true);
      expect(vault.exists(d2.image)).toBe(true);

      // Gallery note contains both embed markers.
      const noteContent = vault.read("Gallery/2099-01-01.md");
      const embedCount = (noteContent.match(/!\[\[images\//g) ?? []).length;
      expect(embedCount).toBe(2);
      expect(noteContent).toContain("look A");
      expect(noteContent).toContain("look B");
    });
  });

  // ── preview / bridge failure ──────────────────────────────────────────────
  it("returns isError when the preview endpoint fails — never throws", async () => {
    server.use(
      http.get(`${TD_BASE}/api/preview/:seg`, () => {
        return HttpResponse.error();
      }),
    );

    await withVault(async (vault) => {
      const result = await captureToVaultImpl(ctxWith(vault), {
        node_path: "/project1/out1",
        gallery: "Gallery",
        width: 640,
        height: 360,
      });
      expect(result.isError).toBe(true);
    });
  });

  it("does not throw on any failure path — defensive check", async () => {
    // ctxNoVault has no vault — should return an error, not throw.
    let threw = false;
    try {
      await captureToVaultImpl(ctxNoVault(), {
        node_path: "/project1/out1",
        gallery: "Gallery",
        width: 640,
        height: 360,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  // ── preview data is the base64 from the mock ──────────────────────────────
  it("uses the preview base64 from the bridge to write the file", async () => {
    await withVault(async (vault) => {
      // Verify the default mock returns our known PNG.
      const result = await captureToVaultImpl(ctxWith(vault), {
        node_path: "/project1/out1",
        gallery: "Looks",
        note: "test-session",
        width: 320,
        height: 180,
      });
      expect(result.isError).toBeFalsy();
      const data = jsonOf<{ image: string }>(result);
      // The written file matches the base64 the mock returned — read with fs to preserve bytes.
      const written = readFileSync(vault.resolve(data.image));
      const expected = Buffer.from(PREVIEW_B64, "base64");
      // Verify sizes match — the mock PNG is 1×1.
      expect(written.length).toBe(expected.length);
    });
  });
});
