import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { bindVaultTextImpl } from "../../src/tools/vault/bindVaultText.js";
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
  return { client: client(), logger: silentLogger } as unknown as ToolContext;
}

function ctxWith(vault: Vault): ToolContext {
  return { client: client(), logger: silentLogger, vault } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// Vault tools use jsonResult, which embeds the payload in a ```json fence (not structuredContent).
function jsonOf<T = Record<string, unknown>>(result: CallToolResult): T {
  const m = /```json\n([\s\S]*?)\n```/.exec(textOf(result));
  return JSON.parse(m?.[1] ?? "{}") as T;
}

function withVault(fn: (vault: Vault) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-bindtext-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

describe("bindVaultTextImpl", () => {
  it("errors with a TDMCP_VAULT_PATH hint when no vault is configured", async () => {
    const result = await bindVaultTextImpl(ctxNoVault(), {
      note: "lyrics",
      parent_path: "/project1",
      sync: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  it("errors when the note is missing from the vault", async () => {
    await withVault(async (vault) => {
      const result = await bindVaultTextImpl(ctxWith(vault), {
        note: "missing",
        parent_path: "/project1",
        sync: true,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not found");
    });
  });

  it("creates a Text DAT bound to the resolved note and reports the sync state", async () => {
    await withVault(async (vault) => {
      vault.write("lyrics.md", "la la la");
      const result = await bindVaultTextImpl(ctxWith(vault), {
        note: "lyrics",
        parent_path: "/project1",
        sync: true,
      });
      expect(result.isError).toBeFalsy();
      const data = jsonOf<{ dat: string; note: string; synced: boolean }>(result);
      expect(data.note).toBe("lyrics.md");
      expect(data.synced).toBe(true);
      expect(data.dat).toMatch(/textdat1$|\/lyrics$/);
      expect(textOf(result)).toContain("lyrics.md");
    });
  });
});
