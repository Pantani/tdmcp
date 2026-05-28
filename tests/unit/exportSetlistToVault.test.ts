import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import {
  exportSetlistToVaultImpl,
  exportSetlistToVaultSchema,
} from "../../src/tools/vault/exportSetlistToVault.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function client(): TouchDesignerClient {
  return new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 });
}

function ctxNoVault(): ToolContext {
  return {
    client: client(),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  } as unknown as ToolContext;
}

function ctxWith(vault: Vault): ToolContext {
  return {
    client: client(),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
    vault,
  } as unknown as ToolContext;
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

function withVault(fn: (vault: Vault) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-setlist-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

function mockExec(report: Record<string, unknown>): void {
  server.use(
    http.post(`${TD_BASE}/api/exec`, () =>
      HttpResponse.json({ ok: true, data: { result: null, stdout: JSON.stringify(report) } }),
    ),
  );
}

// ─── Schema tests ────────────────────────────────────────────────────────────

describe("exportSetlistToVaultSchema", () => {
  it("applies defaults for folder and include_tempo", () => {
    const parsed = exportSetlistToVaultSchema.parse({ target: "/project1", note: "My Set" });
    expect(parsed.folder).toBe("Setlists");
    expect(parsed.include_tempo).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(() => exportSetlistToVaultSchema.parse({ target: "/project1" })).toThrow();
    expect(() => exportSetlistToVaultSchema.parse({ note: "Nope" })).toThrow();
  });
});

// ─── No vault configured ─────────────────────────────────────────────────────

describe("exportSetlistToVaultImpl — no vault", () => {
  it("returns isError with TDMCP_VAULT_PATH hint and never throws", async () => {
    const result = await exportSetlistToVaultImpl(ctxNoVault(), {
      target: "/project1",
      note: "Friday Set",
      folder: "Setlists",
      include_tempo: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });
});

// ─── Bridge fatal ─────────────────────────────────────────────────────────────

describe("exportSetlistToVaultImpl — bridge fatal", () => {
  it("returns isError when the bridge reports a fatal and never throws", async () => {
    await withVault(async (vault) => {
      mockExec({
        comp: "/project1",
        cues: [],
        tempo: null,
        warnings: [],
        fatal: "COMP not found: /project1",
      });
      const result = await exportSetlistToVaultImpl(ctxWith(vault), {
        target: "/project1",
        note: "Friday Set",
        folder: "Setlists",
        include_tempo: true,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Export failed");
    });
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("exportSetlistToVaultImpl — happy path", () => {
  it("writes a setlist note that import_setlist can parse (tracks + title)", async () => {
    await withVault(async (vault) => {
      const cues = [
        { name: "Intro", params: { level: 0.5, hue: 0.0 } },
        { name: "Drop", params: { level: 1.0, hue: 0.7 } },
      ];
      mockExec({ comp: "/project1/ctrl", cues, tempo: 128, warnings: [] });

      const result = await exportSetlistToVaultImpl(ctxWith(vault), {
        target: "/project1/ctrl",
        note: "Friday Set",
        folder: "Setlists",
        include_tempo: true,
      });

      expect(result.isError).toBeFalsy();

      // Note was written to the vault
      expect(vault.exists("Setlists/Friday Set.md")).toBe(true);

      // Parse the note and verify import_setlist-compatible frontmatter
      const parsed = vault.readNote("Setlists/Friday Set.md");
      const tracks = parsed.data.tracks as Array<{ title?: string; bpm?: number }>;
      expect(Array.isArray(tracks)).toBe(true);
      expect(tracks).toHaveLength(2);
      expect(tracks[0]?.title).toBe("Intro");
      expect(tracks[1]?.title).toBe("Drop");
      // bpm should be present because tempo was provided
      expect(tracks[0]?.bpm).toBe(128);

      // Summary should mention cue count
      const text = textOf(result);
      expect(text).toContain("2 cue(s)");
      expect(text).toContain("/project1/ctrl");
      expect(text).toContain("Setlists/Friday Set.md");
      expect(text).toContain("re-importable by import_setlist");

      // Structured JSON data
      const data = jsonOf<{ cues: string[]; path: string; tempo: number }>(result);
      // Bridge returns cues in sorted order; mock sends ["Intro","Drop"] → both present
      expect(data.cues).toEqual(expect.arrayContaining(["Intro", "Drop"]));
      expect(data.cues).toHaveLength(2);
      expect(data.path).toBe("Setlists/Friday Set.md");
      expect(data.tempo).toBe(128);
    });
  });

  it("omits bpm from tracks when include_tempo is false", async () => {
    await withVault(async (vault) => {
      mockExec({
        comp: "/project1/ctrl",
        cues: [{ name: "Verse", params: { x: 1 } }],
        tempo: null,
        warnings: [],
      });

      const result = await exportSetlistToVaultImpl(ctxWith(vault), {
        target: "/project1/ctrl",
        note: "No Tempo",
        folder: "Setlists",
        include_tempo: false,
      });

      expect(result.isError).toBeFalsy();
      const parsed = vault.readNote("Setlists/No Tempo.md");
      const tracks = parsed.data.tracks as Array<{ title?: string; bpm?: unknown }>;
      expect(tracks[0]?.bpm).toBeUndefined();
    });
  });

  it("writes a note with zero cues and does not error", async () => {
    await withVault(async (vault) => {
      mockExec({ comp: "/project1", cues: [], tempo: null, warnings: [] });

      const result = await exportSetlistToVaultImpl(ctxWith(vault), {
        target: "/project1",
        note: "Empty Show",
        folder: "Setlists",
        include_tempo: true,
      });

      expect(result.isError).toBeFalsy();
      expect(vault.exists("Setlists/Empty Show.md")).toBe(true);
      const text = textOf(result);
      expect(text).toContain("0 cue(s)");
    });
  });

  it("payload sent to the bridge contains the right comp and include_tempo fields", async () => {
    await withVault(async (vault) => {
      let capturedScript = "";
      server.use(
        http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
          const body = (await request.json()) as { script: string };
          capturedScript = body.script ?? "";
          return HttpResponse.json({
            ok: true,
            data: {
              result: null,
              stdout: JSON.stringify({
                comp: "/project1/panel",
                cues: [{ name: "A", params: { v: 1 } }],
                tempo: 90,
                warnings: [],
              }),
            },
          });
        }),
      );

      await exportSetlistToVaultImpl(ctxWith(vault), {
        target: "/project1/panel",
        note: "Payload Check",
        folder: "Setlists",
        include_tempo: true,
      });

      // Extract the base64 payload from the script
      const b64Match = /b64decode\("([^"]+)"\)/.exec(capturedScript);
      expect(b64Match).not.toBeNull();
      const payload = JSON.parse(
        Buffer.from(b64Match?.[1] ?? "", "base64").toString("utf8"),
      ) as Record<string, unknown>;

      expect(payload.comp).toBe("/project1/panel");
      expect(payload.include_tempo).toBe(true);
    });
  });
});
