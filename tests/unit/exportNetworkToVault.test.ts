import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { exportNetworkToVaultImpl } from "../../src/tools/vault/exportNetworkToVault.js";
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

function jsonOf<T = Record<string, unknown>>(result: CallToolResult): T {
  const m = /```json\n([\s\S]*?)\n```/.exec(textOf(result));
  return JSON.parse(m?.[1] ?? "{}") as T;
}

function withVault(fn: (vault: Vault) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-exportnet-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

describe("exportNetworkToVaultImpl", () => {
  it("errors with a TDMCP_VAULT_PATH hint when no vault is configured", async () => {
    const result = await exportNetworkToVaultImpl(ctxNoVault(), {
      path: "/project1",
      recursive: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  it("writes a Networks/<path>.md note with a Mermaid diagram by default", async () => {
    await withVault(async (vault) => {
      const result = await exportNetworkToVaultImpl(ctxWith(vault), {
        path: "/project1",
        recursive: false,
      });
      expect(result.isError).toBeFalsy();
      // Default note location derived from the network path.
      expect(vault.exists("Networks/project1.md")).toBe(true);
      const note = vault.readNote("Networks/project1.md");
      expect(note.body).toContain("```mermaid");
      // The mock topology has one noise1 operator → it appears as a wikilink.
      expect(note.body).toContain("[[noise1]]");
    });
  });

  it("honors an explicit note path and appends .md when missing", async () => {
    await withVault(async (vault) => {
      const result = await exportNetworkToVaultImpl(ctxWith(vault), {
        path: "/project1",
        recursive: false,
        note: "Docs/my-patch",
      });
      expect(result.isError).toBeFalsy();
      expect(vault.exists("Docs/my-patch.md")).toBe(true);
      expect(jsonOf<{ path: string }>(result).path).toBe("Docs/my-patch.md");
    });
  });
});
