import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { generateFromMoodboardImpl } from "../../src/tools/vault/generateFromMoodboard.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function ctxNoVault(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
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

function withVault(fn: (vault: Vault) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-mood-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

const MOODBOARD_NOTE = `---
technique: reaction_diffusion
palette: [teal, magenta]
speed: 1.2
---

Dark organic membranes pulsing slowly.
`;

describe("generateFromMoodboardImpl", () => {
  it("errors with a TDMCP_VAULT_PATH hint when no vault is configured", async () => {
    const result = await generateFromMoodboardImpl(ctxNoVault(), {
      note: "sunset",
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  it("errors when the moodboard note cannot be found", async () => {
    await withVault(async (vault) => {
      const result = await generateFromMoodboardImpl(ctxWith(vault), {
        note: "nope",
        parent_path: "/project1",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not found");
    });
  });

  it("returns a friendly error (never throws) when the note has malformed YAML frontmatter", async () => {
    await withVault(async (vault) => {
      // Unclosed flow sequence — gray-matter's matter() throws on this. The tool
      // must catch it and return an isError result, not crash the handler.
      vault.write("Moodboards/broken.md", "---\ntechnique: [a, b\n---\n\nBody.\n");
      const result = await generateFromMoodboardImpl(ctxWith(vault), {
        note: "broken",
        parent_path: "/project1",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("broken");
    });
  });

  it("reads the note's technique frontmatter and builds a matching generative system", async () => {
    await withVault(async (vault) => {
      vault.write("Moodboards/membranes.md", MOODBOARD_NOTE);
      const result = await generateFromMoodboardImpl(ctxWith(vault), {
        note: "membranes",
        parent_path: "/project1",
      });
      expect(result.isError).toBeFalsy();
    });
  });

  it("lets an explicit technique override the note frontmatter", async () => {
    await withVault(async (vault) => {
      vault.write("Moodboards/membranes.md", MOODBOARD_NOTE);
      const result = await generateFromMoodboardImpl(ctxWith(vault), {
        note: "membranes",
        parent_path: "/project1",
        technique: "custom_glsl",
      });
      expect(result.isError).toBeFalsy();
    });
  });
});
