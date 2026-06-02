import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { exportLookToxImpl } from "../../src/tools/vault/exportLookTox.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Vault } from "../../src/vault/index.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const tmpDirs: string[] = [];
function makeVault(): Vault {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-look-"));
  tmpDirs.push(dir);
  return new Vault(dir);
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function makeCtx(vault?: Vault): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
    vault,
  };
}

const ok = (data: unknown) => HttpResponse.json({ ok: true, data });

function jsonOf(result: { content: unknown[] }) {
  const text = (result.content[0] as { text: string }).text;
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  if (!m?.[1]) throw new Error(`no json: ${text}`);
  return JSON.parse(m[1]);
}

function mockExecOnce(report: Record<string, unknown>) {
  server.use(
    http.post(`${TD_BASE}/api/exec`, () =>
      ok({ result: null, stdout: `${JSON.stringify(report)}\n` }),
    ),
  );
}

describe("exportLookToxImpl", () => {
  it("errors when no vault is configured", async () => {
    const result = await exportLookToxImpl(makeCtx(undefined), {
      source_path: "/project1/myLook",
      folder: "Looks",
      tags: [],
      assets: [],
    });
    expect(result.isError).toBe(true);
  });

  it("writes a .md sidecar and reports the saved tox path on success", async () => {
    const vault = makeVault();
    mockExecOnce({
      saved: vault.resolve("Looks/mylook.tox"),
      size: 12345,
      comp_name: "myLook",
    });
    const result = await exportLookToxImpl(makeCtx(vault), {
      source_path: "/project1/myLook",
      folder: "Looks",
      tags: ["dark", "warm"],
      assets: [],
    });
    expect(result.isError).toBeFalsy();
    const r = jsonOf(result);
    expect(r.tox_path).toBe("Looks/mylook.tox");
    expect(r.note_path).toBe("Looks/mylook.md");
    expect(vault.exists("Looks/mylook.md")).toBe(true);
    const note = vault.readNote("Looks/mylook.md");
    expect(note.data.type).toBe("look");
    expect(note.data.tags).toContain("look");
    expect(note.data.tags).toContain("dark");
  });

  it("returns errorResult when the vault path escapes the root", async () => {
    const vault = makeVault();
    const result = await exportLookToxImpl(makeCtx(vault), {
      source_path: "/project1/myLook",
      folder: "../escape",
      tags: [],
      assets: [],
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain("invalid vault path");
  });

  it("surfaces a python fatal as a friendly error", async () => {
    const vault = makeVault();
    mockExecOnce({ fatal: "COMP not found: /nope" });
    const result = await exportLookToxImpl(makeCtx(vault), {
      source_path: "/nope",
      folder: "Looks",
      tags: [],
      assets: [],
    });
    expect(result.isError).toBe(true);
  });

  it("writes license + license_tier into the look's note frontmatter", async () => {
    const vault = makeVault();
    mockExecOnce({
      saved: vault.resolve("Looks/mylook.tox"),
      size: 500,
      comp_name: "myLook",
    });
    const result = await exportLookToxImpl(makeCtx(vault), {
      source_path: "/project1/myLook",
      folder: "Looks",
      tags: [],
      assets: [],
      license: "CC-BY-4.0",
      license_tier: "permissive",
    });
    expect(result.isError).toBeFalsy();
    const r = jsonOf(result);
    expect(r.license).toBe("CC-BY-4.0");
    expect(r.license_tier).toBe("permissive");
    const note = vault.readNote("Looks/mylook.md");
    expect(note.data.license).toBe("CC-BY-4.0");
    expect(note.data.license_tier).toBe("permissive");
  });

  it("omits license fields entirely when not provided (back-compat)", async () => {
    const vault = makeVault();
    mockExecOnce({
      saved: vault.resolve("Looks/mylook.tox"),
      size: 400,
      comp_name: "myLook",
    });
    const result = await exportLookToxImpl(makeCtx(vault), {
      source_path: "/project1/myLook",
      folder: "Looks",
      tags: [],
      assets: [],
    });
    expect(result.isError).toBeFalsy();
    const note = vault.readNote("Looks/mylook.md");
    expect(Object.prototype.hasOwnProperty.call(note.data, "license")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(note.data, "license_tier")).toBe(false);
  });
});
