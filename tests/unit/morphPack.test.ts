import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import {
  computeMorphPackHash,
  type MorphLook,
  type MorphPackDoc,
  morphPackImpl,
  morphPackSchema,
} from "../../src/tools/vault/morphPack.js";
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
  } as unknown as ToolContext;
}

function ctxWith(vault: Vault): ToolContext {
  return {
    client: client(),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
    vault,
  } as unknown as ToolContext;
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
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-morphpack-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

// Decode the base64 payload from a captured script body.
function decodePayload(script: string): Record<string, unknown> {
  const m = /b64decode\("([^"]+)"\)/.exec(script);
  if (!m) throw new Error("no payload in script");
  return JSON.parse(Buffer.from(m[1] ?? "", "base64").toString("utf8")) as Record<string, unknown>;
}

interface ExecCall {
  script: string;
  payload: Record<string, unknown>;
}

/**
 * Drive sequential /api/exec responses, capturing each call. `replies` is a
 * queue of stdout reports (JSON-stringified). Once exhausted, returns an empty
 * stdout (which will surface as a parse error — tests should provide enough).
 */
function mockExecSequence(replies: Record<string, unknown>[]): { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  let i = 0;
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      const script = body.script ?? "";
      let payload: Record<string, unknown> = {};
      try {
        payload = decodePayload(script);
      } catch {
        // not a payload-style script
      }
      calls.push({ script, payload });
      const reply = replies[i++] ?? { warnings: [] };
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(reply) },
      });
    }),
  );
  return { calls };
}

const FIXTURE_LOOKS = [
  { id: "dim", parameters: { feedback: 0.9, tx: 0.0, blur: 0.2 } },
  { id: "bright", parameters: { feedback: 0.4, tx: 0.1, blur: 0.0 } },
];

function makeFixtureDoc(): MorphPackDoc {
  const base = {
    schema: "tdmcp.morphpack" as const,
    schema_version: 1,
    name: "warm_room",
    created: "2026-05-31T00:00:00Z",
    provenance: {
      tdmcp_version: "0.9.0",
      container_path: "/project1/preset_morph",
      target_path: "/project1/visual/feedback1",
      target_optype: "feedbackTOP",
      interpolation: "linear",
      captured_param_names: ["blur", "feedback", "tx"],
    },
    looks: FIXTURE_LOOKS,
  };
  const sha256 = computeMorphPackHash(base);
  return { ...base, sha256 };
}

// ─── Schema ──────────────────────────────────────────────────────────────────

describe("morphPackSchema", () => {
  it("applies defaults", () => {
    const parsed = morphPackSchema.parse({ action: "pack", name: "warm_room" });
    expect(parsed.parent).toBe("/project1");
    expect(parsed.overwrite).toBe(false);
    expect(parsed.merge).toBe("replace");
  });

  it("requires action + name", () => {
    expect(() => morphPackSchema.parse({ action: "pack" })).toThrow();
    expect(() => morphPackSchema.parse({ name: "x" })).toThrow();
  });
});

// ─── No vault ────────────────────────────────────────────────────────────────

describe("morphPackImpl — no vault configured", () => {
  it("pack: returns isError with TDMCP_VAULT_PATH hint, no bridge call", async () => {
    const { calls } = mockExecSequence([]);
    const result = await morphPackImpl(ctxNoVault(), {
      action: "pack",
      name: "warm_room",
      parent: "/project1",
      overwrite: false,
      merge: "replace",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
    expect(calls).toHaveLength(0);
  });

  it("unpack: returns isError, no bridge call", async () => {
    const { calls } = mockExecSequence([]);
    const result = await morphPackImpl(ctxNoVault(), {
      action: "unpack",
      name: "warm_room",
      parent: "/project1",
      overwrite: false,
      merge: "replace",
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

// ─── Vault escape ────────────────────────────────────────────────────────────

describe("morphPackImpl — vault path escape", () => {
  it("pack: returns errorResult, no bridge call", async () => {
    await withVault(async (vault) => {
      const { calls } = mockExecSequence([]);
      const result = await morphPackImpl(ctxWith(vault), {
        action: "pack",
        name: "x",
        parent: "/project1",
        vault_path: "../escape.json",
        overwrite: false,
        merge: "replace",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Invalid vault path");
      expect(calls).toHaveLength(0);
    });
  });
});

// ─── Pack happy path ─────────────────────────────────────────────────────────

describe("morphPackImpl — pack happy path", () => {
  it("writes a valid .morphpack.json with correct schema, provenance, and sha256", async () => {
    await withVault(async (vault) => {
      mockExecSequence([
        {
          container: "/project1/warm_room",
          target: "/project1/visual/feedback1",
          target_optype: "feedbackTOP",
          interpolation: "linear",
          slots: ["dim", "bright"],
          params_by_slot: {
            dim: { feedback: 0.9, tx: 0.0, blur: 0.2 },
            bright: { feedback: 0.4, tx: 0.1, blur: 0.0 },
          },
          warnings: [],
        },
      ]);
      const result = await morphPackImpl(ctxWith(vault), {
        action: "pack",
        name: "warm_room",
        parent: "/project1",
        overwrite: false,
        merge: "replace",
      });

      expect(result.isError).toBeFalsy();
      const rel = "MorphPacks/warm_room.morphpack.json";
      expect(vault.exists(rel)).toBe(true);
      const raw = vault.read(rel);
      const doc = JSON.parse(raw) as MorphPackDoc;
      expect(doc.schema).toBe("tdmcp.morphpack");
      expect(doc.schema_version).toBe(1);
      expect(doc.looks).toHaveLength(2);
      expect(doc.provenance.container_path).toBe("/project1/warm_room");
      expect(doc.provenance.target_path).toBe("/project1/visual/feedback1");
      expect(doc.provenance.interpolation).toBe("linear");
      expect(doc.provenance.captured_param_names).toEqual(["blur", "feedback", "tx"]);
      // sha256 must be a 64-hex digest that re-verifies.
      expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(computeMorphPackHash(doc)).toBe(doc.sha256);

      const data = jsonOf<{ sha256: string; looks: string[] }>(result);
      expect(data.looks).toEqual(["dim", "bright"]);
      expect(data.sha256).toBe(doc.sha256);
    });
  });

  it("refuses to overwrite an existing pack unless overwrite=true", async () => {
    await withVault(async (vault) => {
      const rel = "MorphPacks/warm_room.morphpack.json";
      vault.write(rel, "{}");
      const { calls } = mockExecSequence([]);
      const result = await morphPackImpl(ctxWith(vault), {
        action: "pack",
        name: "warm_room",
        parent: "/project1",
        overwrite: false,
        merge: "replace",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("already exists");
      expect(calls).toHaveLength(0);
    });
  });

  it("returns errorResult when the container is missing on pack", async () => {
    await withVault(async (vault) => {
      mockExecSequence([{ container_missing: true, warnings: [] }]);
      const result = await morphPackImpl(ctxWith(vault), {
        action: "pack",
        name: "warm_room",
        parent: "/project1",
        overwrite: false,
        merge: "replace",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("not found");
    });
  });
});

// ─── Unpack ──────────────────────────────────────────────────────────────────

describe("morphPackImpl — unpack", () => {
  it("replace: probes the container, then writes looks with merge=replace", async () => {
    await withVault(async (vault) => {
      const doc = makeFixtureDoc();
      vault.write("MorphPacks/warm_room.morphpack.json", JSON.stringify(doc));

      const { calls } = mockExecSequence([
        // probe: container exists
        {
          container: "/project1/warm_room",
          slots: [],
          params_by_slot: {},
          target: "/project1/visual/feedback1",
          interpolation: "linear",
          warnings: [],
        },
        // write
        {
          container: "/project1/warm_room",
          target: "/project1/visual/feedback1",
          slots_written: ["dim", "bright"],
          slots_skipped: [],
          warnings: [],
        },
      ]);

      const result = await morphPackImpl(ctxWith(vault), {
        action: "unpack",
        name: "warm_room",
        parent: "/project1",
        overwrite: false,
        merge: "replace",
      });

      expect(result.isError).toBeFalsy();
      expect(calls).toHaveLength(2);
      const writePayload = calls[1]?.payload as Record<string, unknown>;
      expect(writePayload.merge).toBe("replace");
      expect(writePayload.container).toBe("/project1/warm_room");
      const looks = writePayload.looks as Array<{ id: string; parameters: Record<string, number> }>;
      expect(looks).toHaveLength(2);
      const dim = looks.find((l) => l.id === "dim");
      expect(dim?.parameters.feedback).toBe(0.9);
    });
  });

  it("builds the container first when probe reports container_missing", async () => {
    await withVault(async (vault) => {
      const doc = makeFixtureDoc();
      vault.write("MorphPacks/warm_room.morphpack.json", JSON.stringify(doc));

      const { calls } = mockExecSequence([
        // probe: missing
        { container_missing: true, warnings: [] },
        // build
        {
          action: "build",
          container: "/project1/warm_room",
          target: "/project1/visual/feedback1",
          warnings: [],
        },
        // write
        {
          container: "/project1/warm_room",
          target: "/project1/visual/feedback1",
          slots_written: ["dim", "bright"],
          slots_skipped: [],
          warnings: [],
        },
      ]);

      const result = await morphPackImpl(ctxWith(vault), {
        action: "unpack",
        name: "warm_room",
        parent: "/project1",
        overwrite: false,
        merge: "replace",
      });
      expect(result.isError).toBeFalsy();
      expect(calls).toHaveLength(3);
      const buildPayload = calls[1]?.payload as Record<string, unknown>;
      expect(buildPayload.action).toBe("build");
      expect(buildPayload.target_path).toBe("/project1/visual/feedback1");
    });
  });

  it("target_path override flows through to the build call", async () => {
    await withVault(async (vault) => {
      const doc = makeFixtureDoc();
      vault.write("MorphPacks/warm_room.morphpack.json", JSON.stringify(doc));

      const { calls } = mockExecSequence([
        { container_missing: true, warnings: [] },
        { action: "build", container: "/project1/warm_room", warnings: [] },
        {
          container: "/project1/warm_room",
          slots_written: ["dim", "bright"],
          warnings: [],
        },
      ]);

      await morphPackImpl(ctxWith(vault), {
        action: "unpack",
        name: "warm_room",
        parent: "/project1",
        target_path: "/project1/elsewhere/feedback2",
        overwrite: false,
        merge: "replace",
      });

      const buildPayload = calls[1]?.payload as Record<string, unknown>;
      expect(buildPayload.target_path).toBe("/project1/elsewhere/feedback2");
    });
  });

  it("rejects schema_version newer than supported (no bridge calls)", async () => {
    await withVault(async (vault) => {
      const doc = makeFixtureDoc();
      const bad = { ...doc, schema_version: 99 };
      vault.write("MorphPacks/warm_room.morphpack.json", JSON.stringify(bad));

      const { calls } = mockExecSequence([]);
      const result = await morphPackImpl(ctxWith(vault), {
        action: "unpack",
        name: "warm_room",
        parent: "/project1",
        overwrite: false,
        merge: "replace",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("schema_version");
      expect(calls).toHaveLength(0);
    });
  });

  it("sha256 mismatch surfaces as a warning, not a fatal — write still proceeds", async () => {
    await withVault(async (vault) => {
      const doc = makeFixtureDoc();
      // Tamper with looks AFTER hashing — sha256 in file no longer matches contents.
      const tampered = {
        ...doc,
        looks: [{ id: "dim", parameters: { feedback: 0.123 } }, doc.looks[1] as MorphLook],
      };
      vault.write("MorphPacks/warm_room.morphpack.json", JSON.stringify(tampered));

      mockExecSequence([
        {
          container: "/project1/warm_room",
          slots: [],
          params_by_slot: {},
          target: "/project1/visual/feedback1",
          interpolation: "linear",
          warnings: [],
        },
        {
          container: "/project1/warm_room",
          slots_written: ["dim", "bright"],
          warnings: [],
        },
      ]);

      const result = await morphPackImpl(ctxWith(vault), {
        action: "unpack",
        name: "warm_room",
        parent: "/project1",
        overwrite: false,
        merge: "replace",
      });
      expect(result.isError).toBeFalsy();
      const data = jsonOf<{ warnings: string[] }>(result);
      expect(data.warnings.some((w) => w.includes("sha256 mismatch"))).toBe(true);
    });
  });

  it("inline looks bypass the vault read", async () => {
    await withVault(async (vault) => {
      const { calls } = mockExecSequence([
        {
          container: "/project1/warm_room",
          slots: [],
          params_by_slot: {},
          target: "/project1/visual/feedback1",
          interpolation: "linear",
          warnings: [],
        },
        {
          container: "/project1/warm_room",
          slots_written: ["a"],
          warnings: [],
        },
      ]);
      const result = await morphPackImpl(ctxWith(vault), {
        action: "unpack",
        name: "warm_room",
        parent: "/project1",
        target_path: "/project1/visual/feedback1",
        looks: [{ id: "a", parameters: { tx: 0.5 } }],
        overwrite: false,
        merge: "union",
      });
      expect(result.isError).toBeFalsy();
      // No file in vault — proves no vault read was required.
      expect(vault.exists("MorphPacks/warm_room.morphpack.json")).toBe(false);
      const writePayload = calls[1]?.payload as Record<string, unknown>;
      expect(writePayload.merge).toBe("union");
      const looks = writePayload.looks as Array<{ id: string }>;
      expect(looks[0]?.id).toBe("a");
    });
  });
});

// ─── Bridge offline ──────────────────────────────────────────────────────────

describe("morphPackImpl — bridge offline", () => {
  it("pack returns a friendly errorResult and never throws", async () => {
    await withVault(async (vault) => {
      server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));
      const result = await morphPackImpl(ctxWith(vault), {
        action: "pack",
        name: "warm_room",
        parent: "/project1",
        overwrite: false,
        merge: "replace",
      });
      expect(result.isError).toBe(true);
    });
  });
});
