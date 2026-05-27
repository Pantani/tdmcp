import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { saveRecipeToVaultImpl } from "../../src/tools/vault/saveRecipeToVault.js";
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
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-saverec-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

// Override the bridge's exec to return a captured-network report (the Python capture pass result).
function mockCapture(report: Record<string, unknown>): void {
  server.use(
    http.post(`${TD_BASE}/api/exec`, () =>
      HttpResponse.json({ ok: true, data: { result: null, stdout: JSON.stringify(report) } }),
    ),
  );
}

const FULL_CAPTURE = {
  comp: "/project1",
  nodes: [
    { name: "noise1", type: "noiseTOP", parameters: { period: 4 } },
    { name: "blur1", type: "blurTOP", parameters: { size: 2 } },
  ],
  connections: [{ from: "noise1", to: "blur1", from_output: 0, to_input: 0 }],
  python_code: {},
  warnings: [],
};

describe("saveRecipeToVaultImpl", () => {
  it("errors with a TDMCP_VAULT_PATH hint when no vault is configured", async () => {
    const result = await saveRecipeToVaultImpl(ctxNoVault(), {
      id: "myrec",
      comp_path: "/project1",
      overwrite: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  it("refuses to clobber an existing recipe note unless overwrite is set", async () => {
    await withVault(async (vault) => {
      vault.write("Recipes/myrec.md", "existing");
      const result = await saveRecipeToVaultImpl(ctxWith(vault), {
        id: "myrec",
        comp_path: "/project1",
        overwrite: false,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("overwrite:true");
    });
  });

  it("captures the COMP's children and writes a recipe note", async () => {
    await withVault(async (vault) => {
      mockCapture(FULL_CAPTURE);
      const result = await saveRecipeToVaultImpl(ctxWith(vault), {
        id: "myrec",
        comp_path: "/project1",
        name: "My Recipe",
        overwrite: false,
      });
      expect(result.isError).toBeFalsy();
      // The recipe note now exists in the vault.
      expect(vault.exists("Recipes/myrec.md")).toBe(true);
      const data = jsonOf<{ id: string; nodes: number; connections: number }>(result);
      expect(data.id).toBe("myrec");
      expect(data.nodes).toBe(2);
      expect(data.connections).toBe(1);
    });
  });

  it("errors when the captured network has no operators", async () => {
    await withVault(async (vault) => {
      mockCapture({ comp: "/project1", nodes: [], connections: [], python_code: {}, warnings: [] });
      const result = await saveRecipeToVaultImpl(ctxWith(vault), {
        id: "empty",
        comp_path: "/project1",
        overwrite: false,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("No operators found");
    });
  });

  it("surfaces a capture fatal as an error", async () => {
    await withVault(async (vault) => {
      mockCapture({
        comp: "/nope",
        nodes: [],
        connections: [],
        python_code: {},
        warnings: [],
        fatal: "Operator not found: /nope",
      });
      const result = await saveRecipeToVaultImpl(ctxWith(vault), {
        id: "rec",
        comp_path: "/nope",
        overwrite: false,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Capture failed");
    });
  });
});
