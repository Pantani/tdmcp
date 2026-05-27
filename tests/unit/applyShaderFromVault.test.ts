import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { applyShaderFromVaultImpl } from "../../src/tools/vault/applyShaderFromVault.js";
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
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-shader-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

const SHADER_NOTE = `---
name: plasma
---

\`\`\`glsl
out vec4 fragColor;
void main(){ fragColor = vec4(vUV.s, vUV.t, 0.0, 1.0); }
\`\`\`
`;

describe("applyShaderFromVaultImpl", () => {
  it("errors with a TDMCP_VAULT_PATH hint when no vault is configured", async () => {
    const result = await applyShaderFromVaultImpl(ctxNoVault(), {
      note: "plasma",
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  it("errors when the shader note cannot be found (under Shaders/ either)", async () => {
    await withVault(async (vault) => {
      const result = await applyShaderFromVaultImpl(ctxWith(vault), {
        note: "missing",
        parent_path: "/project1",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not found");
    });
  });

  it("errors when the note has no ```glsl fragment block", async () => {
    await withVault(async (vault) => {
      vault.write("Shaders/empty.md", "just prose, no shader here");
      const result = await applyShaderFromVaultImpl(ctxWith(vault), {
        note: "empty",
        parent_path: "/project1",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("glsl");
    });
  });

  it("resolves a note under Shaders/ and builds a GLSL TOP from its fragment", async () => {
    await withVault(async (vault) => {
      vault.write("Shaders/plasma.md", SHADER_NOTE);
      const result = await applyShaderFromVaultImpl(ctxWith(vault), {
        note: "plasma",
        parent_path: "/project1",
      });
      expect(result.isError).toBeFalsy();
    });
  });
});
