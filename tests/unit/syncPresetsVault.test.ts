import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { syncPresetsVaultImpl } from "../../src/tools/vault/syncPresetsVault.js";
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
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-presets-"));
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

describe("syncPresetsVaultImpl", () => {
  it("errors with a TDMCP_VAULT_PATH hint when no vault is configured", async () => {
    const result = await syncPresetsVaultImpl(ctxNoVault(), {
      action: "export",
      comp_path: "/project1",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  it("export errors when the COMP has no stored presets", async () => {
    await withVault(async (vault) => {
      mockExec({ comp: "/project1", presets: {} });
      const result = await syncPresetsVaultImpl(ctxWith(vault), {
        action: "export",
        comp_path: "/project1",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("No presets stored");
    });
  });

  it("export writes a Presets/<comp>.md note with the preset JSON", async () => {
    await withVault(async (vault) => {
      mockExec({
        comp: "/project1",
        presets: { warm: { level: 0.8 }, cool: { level: 0.2 } },
      });
      const result = await syncPresetsVaultImpl(ctxWith(vault), {
        action: "export",
        comp_path: "/project1",
      });
      expect(result.isError).toBeFalsy();
      expect(vault.exists("Presets/project1.md")).toBe(true);
      const data = jsonOf<{ presets: string[] }>(result);
      expect(data.presets).toEqual(expect.arrayContaining(["warm", "cool"]));
    });
  });

  it("import errors when the preset note does not exist", async () => {
    await withVault(async (vault) => {
      const result = await syncPresetsVaultImpl(ctxWith(vault), {
        action: "import",
        comp_path: "/project1",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not found");
    });
  });

  it("import reads a note's JSON block and pushes presets back into TD", async () => {
    await withVault(async (vault) => {
      const note = `Presets.\n\n\`\`\`json tdmcp-presets\n${JSON.stringify({ warm: { level: 0.8 } }, null, 2)}\n\`\`\`\n`;
      vault.write("Presets/project1.md", note);
      mockExec({ comp: "/project1", imported: ["warm"], presets: ["warm"] });
      const result = await syncPresetsVaultImpl(ctxWith(vault), {
        action: "import",
        comp_path: "/project1",
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("Imported 1 preset(s)");
    });
  });
});
