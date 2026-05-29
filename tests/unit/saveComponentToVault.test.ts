import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import {
  saveComponentToVaultImpl,
  saveComponentToVaultSchema,
} from "../../src/tools/vault/saveComponentToVault.js";
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
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-savecomp-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

/** Override /api/exec to return a SaveComponentReport. */
function mockSaveReport(report: Record<string, unknown>): void {
  server.use(
    http.post(`${TD_BASE}/api/exec`, () =>
      HttpResponse.json({ ok: true, data: { result: null, stdout: JSON.stringify(report) } }),
    ),
  );
}

/** Decode the base64 payload out of the captured exec script. */
function decodePayloadFromScript(capturedScript: string): Record<string, unknown> {
  const match = /b64decode\("([^"]+)"\)/.exec(capturedScript);
  if (!match?.[1]) throw new Error("No b64 payload found in script");
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as Record<string, unknown>;
}

const GOOD_REPORT = {
  comp: "/project1/myComp",
  tox_path: "/tmp/fake.tox",
  saved: "/tmp/fake.tox",
  comp_name: "myComp",
  size: 12345,
  warnings: [],
};

describe("saveComponentToVaultImpl", () => {
  it("errors with a TDMCP_VAULT_PATH hint when no vault is configured", async () => {
    const result = await saveComponentToVaultImpl(ctxNoVault(), {
      comp_path: "/project1/myComp",
      name: undefined,
      folder: "Components",
      tags: [],
      description: undefined,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  it("sends comp_path and vault-resolved tox_path in the bridge payload", async () => {
    await withVault(async (vault) => {
      let capturedScript = "";
      server.use(
        http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
          const body = (await request.json()) as { script: string };
          capturedScript = body.script ?? "";
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: JSON.stringify(GOOD_REPORT) },
          });
        }),
      );

      const result = await saveComponentToVaultImpl(ctxWith(vault), {
        comp_path: "/project1/myComp",
        name: "myComp",
        folder: "Components",
        tags: ["vj", "generative"],
        description: "A cool component",
      });

      expect(result.isError).toBeFalsy();

      const payload = decodePayloadFromScript(capturedScript);
      expect(payload["comp"]).toBe("/project1/myComp");
      // tox path must be inside the vault and end with .tox
      const toxPath = payload["tox_path"] as string;
      expect(toxPath).toContain("Components");
      expect(toxPath).toContain("myComp.tox");
      expect(toxPath.startsWith(vault.root)).toBe(true);
    });
  });

  it("happy path: saves .tox and writes a vault note with frontmatter", async () => {
    await withVault(async (vault) => {
      mockSaveReport(GOOD_REPORT);

      const result = await saveComponentToVaultImpl(ctxWith(vault), {
        comp_path: "/project1/myComp",
        name: "myComp",
        folder: "Components",
        tags: ["vj"],
        description: "Great comp",
      });

      expect(result.isError).toBeFalsy();

      // Note file was written
      expect(vault.exists("Components/myComp.md")).toBe(true);

      // Note has expected frontmatter fields
      const note = vault.readNote("Components/myComp.md");
      expect(note.data["type"]).toBe("component");
      expect(note.data["tox"]).toBe("Components/myComp.tox");
      expect(Array.isArray(note.data["tags"])).toBe(true);
      expect(note.data["created"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // Note body contains source comp path and load instructions
      expect(note.body).toContain("/project1/myComp");
      expect(note.body).toContain("manage_component");

      // JSON result has expected shape
      const data = jsonOf<{
        tox_path: string;
        note_path: string;
        comp_name: string;
        size: number;
      }>(result);
      expect(data.tox_path).toBe("Components/myComp.tox");
      expect(data.note_path).toBe("Components/myComp.md");
      expect(data.comp_name).toBe("myComp");
      expect(data.size).toBe(12345);

      // Summary text mentions the comp + byte size
      const text = textOf(result);
      expect(text).toContain("myComp.tox");
      expect(text).toContain("12345 bytes");
    });
  });

  it("falls back to last path segment as name when name is omitted", async () => {
    await withVault(async (vault) => {
      mockSaveReport({
        ...GOOD_REPORT,
        comp: "/project1/myWidget",
        comp_name: "myWidget",
      });

      const result = await saveComponentToVaultImpl(ctxWith(vault), {
        comp_path: "/project1/myWidget",
        name: undefined,
        folder: "Components",
        tags: [],
        description: undefined,
      });

      expect(result.isError).toBeFalsy();
      expect(vault.exists("Components/myWidget.md")).toBe(true);
    });
  });

  it("surfaces bridge fatal (not a COMP) as isError without throwing", async () => {
    await withVault(async (vault) => {
      mockSaveReport({
        comp: "/project1/myComp",
        tox_path: "/some/path.tox",
        warnings: [],
        fatal: "/project1/myComp is not a COMP, so it cannot be saved as a .tox.",
      });

      const result = await saveComponentToVaultImpl(ctxWith(vault), {
        comp_path: "/project1/myComp",
        name: "myComp",
        folder: "Components",
        tags: [],
        description: undefined,
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Component save failed");
      // No note should have been written
      expect(vault.exists("Components/myComp.md")).toBe(false);
    });
  });

  it("surfaces bridge fatal (COMP not found) as isError without throwing", async () => {
    await withVault(async (vault) => {
      mockSaveReport({
        comp: "/nope",
        tox_path: "/some/path.tox",
        warnings: [],
        fatal: "COMP not found: /nope",
      });

      const result = await saveComponentToVaultImpl(ctxWith(vault), {
        comp_path: "/nope",
        name: "nope",
        folder: "Components",
        tags: [],
        description: undefined,
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Component save failed");
    });
  });

  it("schema defaults: folder defaults to Components, tags defaults to []", () => {
    const parsed = saveComponentToVaultSchema.parse({ comp_path: "/project1/foo" });
    expect(parsed.folder).toBe("Components");
    expect(parsed.tags).toEqual([]);
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBeUndefined();
  });

  it("schema rejects missing comp_path", () => {
    expect(() => saveComponentToVaultSchema.parse({})).toThrow();
  });
});
