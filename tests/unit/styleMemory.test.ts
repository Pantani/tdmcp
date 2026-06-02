import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { styleMemoryImpl } from "../../src/tools/vault/styleMemory.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";
import { readStyleMemory, STYLE_NOTE_REL } from "../../src/vault/memoryNote.js";
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
  };
}

function ctxWith(vault: Vault): ToolContext {
  return { ...ctxNoVault(), vault } as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function dataOf(result: CallToolResult): unknown {
  const text = textOf(result);
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match?.[1]) return undefined;
  return JSON.parse(match[1]);
}

function withVault(fn: (vault: Vault) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-style-mem-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

describe("styleMemoryImpl", () => {
  it("errors with a TDMCP_VAULT_PATH hint when no vault is configured", async () => {
    const result = await styleMemoryImpl(ctxNoVault(), { mode: "show" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  it("show on an empty vault returns the empty-memory summary", async () => {
    await withVault(async (vault) => {
      const result = await styleMemoryImpl(ctxWith(vault), { mode: "show" });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("Style memory is empty.");
      const data = dataOf(result) as { note: string; context: string };
      expect(data.note).toBe(STYLE_NOTE_REL);
      expect(data.context).toBe("");
    });
  });

  it("read returns the full structured style note", async () => {
    await withVault(async (vault) => {
      const result = await styleMemoryImpl(ctxWith(vault), { mode: "read" });
      expect(result.isError).toBeFalsy();
      const data = dataOf(result) as { style: { palettes: unknown[]; banned: string[] } };
      expect(data.style.palettes).toEqual([]);
      expect(data.style.banned).toEqual([]);
    });
  });

  it("update merges palettes/banned/favorites and bumps updated", { timeout: 20_000 }, async () => {
    await withVault(async (vault) => {
      const first = await styleMemoryImpl(ctxWith(vault), {
        mode: "update",
        patch: {
          default_energy: "high",
          banned: ["strobe"],
          favorite_generators: ["create_feedback_network"],
          palettes: [{ name: "sunset", colors: ["#ff7a00", "#1a1a2e"] }],
          tags: ["warm"],
        },
      });
      expect(first.isError).toBeFalsy();
      const firstData = dataOf(first) as {
        style: {
          default_energy?: string;
          banned: string[];
          favorite_generators: string[];
          palettes: Array<{ name?: string; colors: string[] }>;
          tags: string[];
          updated: string;
        };
        context: string;
      };
      expect(firstData.style.default_energy).toBe("high");
      expect(firstData.style.banned).toEqual(["strobe"]);
      expect(firstData.style.palettes).toHaveLength(1);
      expect(firstData.style.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(firstData.context).toContain("energy: high");

      // Second update adds + dedups (case-insensitive on banned).
      const second = await styleMemoryImpl(ctxWith(vault), {
        mode: "update",
        patch: {
          banned: ["STROBE", "flash"],
          favorite_generators: ["create_feedback_network", "create_audio_reactive"],
        },
      });
      expect(second.isError).toBeFalsy();
      const secondData = dataOf(second) as {
        style: { banned: string[]; favorite_generators: string[]; default_energy?: string };
      };
      // Dedup ci → original "strobe" kept; new "flash" added; sorted.
      expect(secondData.style.banned).toEqual(["flash", "strobe"]);
      expect(secondData.style.favorite_generators).toEqual([
        "create_feedback_network",
        "create_audio_reactive",
      ]);
      // Preserved across merge.
      expect(secondData.style.default_energy).toBe("high");

      // Vault really holds the merged value.
      const onDisk = readStyleMemory(vault);
      expect(onDisk.banned).toEqual(["flash", "strobe"]);
      expect(onDisk.default_energy).toBe("high");
    });
  });

  it("update with no patch is a no-op merge that still writes a valid note", async () => {
    await withVault(async (vault) => {
      const result = await styleMemoryImpl(ctxWith(vault), { mode: "update" });
      expect(result.isError).toBeFalsy();
      expect(vault.exists(STYLE_NOTE_REL)).toBe(true);
    });
  });
});
