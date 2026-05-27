import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { logPerformanceImpl } from "../../src/tools/vault/logPerformance.js";
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
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-logperf-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

describe("logPerformanceImpl", () => {
  it("errors with a TDMCP_VAULT_PATH hint when no vault is configured", async () => {
    const result = await logPerformanceImpl(ctxNoVault(), {
      comp_path: "/project1",
      width: 640,
      height: 360,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  it("writes a dated Performances/ note with the network snapshot (no thumbnail when no output)", async () => {
    await withVault(async (vault) => {
      const result = await logPerformanceImpl(ctxWith(vault), {
        title: "Warehouse Set",
        comp_path: "/project1",
        notes: "Heavy bass response was great.",
        width: 640,
        height: 360,
      });
      expect(result.isError).toBeFalsy();
      const data = jsonOf<{ path: string; thumbnail: boolean }>(result);
      expect(data.thumbnail).toBe(false);
      expect(data.path).toMatch(/^Performances\/.*warehouse-set\.md$/);
      expect(vault.exists(data.path)).toBe(true);
    });
  });

  it("captures a thumbnail when an output TOP is given", async () => {
    await withVault(async (vault) => {
      const result = await logPerformanceImpl(ctxWith(vault), {
        title: "With Preview",
        comp_path: "/project1",
        output_path: "/project1/render1",
        width: 640,
        height: 360,
      });
      expect(result.isError).toBeFalsy();
      expect(jsonOf<{ thumbnail: boolean }>(result).thumbnail).toBe(true);
      // The thumbnail attachment was written alongside the note.
      const attachments = vault.list("Performances/attachments");
      expect(attachments.length).toBeGreaterThan(0);
    });
  });
});
