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
import { computeMorphPackHash, type MorphPackDoc } from "../../src/tools/vault/morphPack.js";
import { variantPackImpl, variantPackSchema } from "../../src/tools/vault/variantPack.js";
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
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-variantpack-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

function mockExecOnce(reply: Record<string, unknown>): {
  calls: { payload: Record<string, unknown> }[];
} {
  const calls: { payload: Record<string, unknown> }[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      const script = body.script ?? "";
      const m = /b64decode\("([^"]+)"\)/.exec(script);
      const payload = m
        ? (JSON.parse(Buffer.from(m[1] ?? "", "base64").toString("utf8")) as Record<
            string,
            unknown
          >)
        : {};
      calls.push({ payload });
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(reply) },
      });
    }),
  );
  return { calls };
}

const DEFAULTS = {
  parent: "/project1",
  count: 3,
  delta_range: 0.2,
  variant_prefix: "",
  include_seed: true,
  interpolation: "linear" as const,
  overwrite: false,
};

const PROBE_REPLY = {
  comp: "/project1/look",
  params: [
    { name: "Speed", normMin: 0, normMax: 10, style: "Float", isNumber: true, readOnly: false },
    { name: "Steps", normMin: 1, normMax: 16, style: "Int", isNumber: true, readOnly: false },
  ],
  missing: [],
  target_optype: "noiseTOP",
  warnings: [],
};

describe("variantPackSchema", () => {
  it("applies defaults", () => {
    const parsed = variantPackSchema.parse({ name: "x", seed_look: { a: 1 } });
    expect(parsed.count).toBe(8);
    expect(parsed.delta_range).toBe(0.15);
    expect(parsed.include_seed).toBe(true);
    expect(parsed.interpolation).toBe("linear");
  });
  it("requires name + seed_look", () => {
    expect(() => variantPackSchema.parse({ seed_look: { a: 1 } })).toThrow();
    expect(() => variantPackSchema.parse({ name: "x" })).toThrow();
  });
});

describe("variantPackImpl — no vault", () => {
  it("returns isError, no bridge call", async () => {
    const { calls } = mockExecOnce({ params: [], missing: [], warnings: [] });
    const result = await variantPackImpl(ctxNoVault(), {
      ...DEFAULTS,
      name: "v",
      seed_look: { Speed: 5 },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
    expect(calls).toHaveLength(0);
  });
});

describe("variantPackImpl — happy path", () => {
  it("writes a clamp-correct pack with valid sha256 and v00 seed slot", async () => {
    await withVault(async (vault) => {
      mockExecOnce(PROBE_REPLY);
      const result = await variantPackImpl(ctxWith(vault), {
        ...DEFAULTS,
        name: "warm",
        comp_path: "/project1/look",
        seed_look: { Speed: 5, Steps: 8 },
        count: 3,
        delta_range: 0.2,
        seed: 42,
      });

      expect(result.isError).toBeFalsy();
      const rel = "MorphPacks/warm.morphpack.json";
      expect(vault.exists(rel)).toBe(true);
      const doc = JSON.parse(vault.read(rel)) as MorphPackDoc;
      expect(doc.schema).toBe("tdmcp.morphpack");
      expect(doc.schema_version).toBe(1);
      expect(doc.looks).toHaveLength(4); // v00 + v01..v03
      expect(doc.looks[0]?.parameters).toEqual({ Speed: 5, Steps: 8 });
      expect(doc.looks[0]?.id).toBe("warm_v00");
      expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(computeMorphPackHash(doc)).toBe(doc.sha256);

      // Clamp + Int round on the perturbed slots.
      for (let i = 1; i < doc.looks.length; i++) {
        const p = doc.looks[i]?.parameters as Record<string, number>;
        // delta = 0.2 * 10 = ±2 ⇒ Speed ∈ [3, 7]
        expect(p.Speed).toBeGreaterThanOrEqual(3);
        expect(p.Speed).toBeLessThanOrEqual(7);
        // Steps is Int-style, clamped to [1, 16]
        expect(p.Steps).toBeGreaterThanOrEqual(1);
        expect(p.Steps).toBeLessThanOrEqual(16);
        expect(Number.isInteger(p.Steps)).toBe(true);
      }
    });
  });

  it("is deterministic for the same seed and different for another seed", async () => {
    await withVault(async (v1) => {
      mockExecOnce(PROBE_REPLY);
      await variantPackImpl(ctxWith(v1), {
        ...DEFAULTS,
        name: "warm",
        comp_path: "/project1/look",
        seed_look: { Speed: 5, Steps: 8 },
        seed: 7,
      });
      const a = v1.read("MorphPacks/warm.morphpack.json");

      await withVault(async (v2) => {
        mockExecOnce(PROBE_REPLY);
        await variantPackImpl(ctxWith(v2), {
          ...DEFAULTS,
          name: "warm",
          comp_path: "/project1/look",
          seed_look: { Speed: 5, Steps: 8 },
          seed: 7,
        });
        const b = v2.read("MorphPacks/warm.morphpack.json");
        // Strip `created` timestamps (they differ).
        const stripCreated = (raw: string) =>
          (JSON.parse(raw) as MorphPackDoc).looks.map((l) => l.parameters);
        expect(stripCreated(a)).toEqual(stripCreated(b));
      });

      await withVault(async (v3) => {
        mockExecOnce(PROBE_REPLY);
        await variantPackImpl(ctxWith(v3), {
          ...DEFAULTS,
          name: "warm",
          comp_path: "/project1/look",
          seed_look: { Speed: 5, Steps: 8 },
          seed: 999,
        });
        const c = v3.read("MorphPacks/warm.morphpack.json");
        const looksA = (JSON.parse(a) as MorphPackDoc).looks.map((l) => l.parameters);
        const looksC = (JSON.parse(c) as MorphPackDoc).looks.map((l) => l.parameters);
        expect(looksA).not.toEqual(looksC);
      });
    });
  });

  it("missing params flow through with a warning, no fatal", async () => {
    await withVault(async (vault) => {
      mockExecOnce({
        comp: "/project1/look",
        params: [
          {
            name: "Speed",
            normMin: 0,
            normMax: 10,
            style: "Float",
            isNumber: true,
            readOnly: false,
          },
        ],
        missing: ["NotThere"],
        target_optype: "",
        warnings: [],
      });
      const result = await variantPackImpl(ctxWith(vault), {
        ...DEFAULTS,
        name: "v",
        seed_look: { Speed: 5, NotThere: 2 },
        seed: 1,
        count: 2,
      });
      expect(result.isError).toBeFalsy();
      const data = jsonOf<{ missing: string[]; warnings: string[] }>(result);
      expect(data.missing).toContain("NotThere");
      expect(data.warnings.some((w) => w.includes("NotThere"))).toBe(true);
      const doc = JSON.parse(vault.read("MorphPacks/v.morphpack.json")) as MorphPackDoc;
      // Variants contain both keys.
      const v1 = doc.looks[1]?.parameters as Record<string, number>;
      expect(v1).toHaveProperty("Speed");
      expect(v1).toHaveProperty("NotThere");
    });
  });

  it("morph_pack-compatible: schema, schema_version, sha256 verify", async () => {
    await withVault(async (vault) => {
      mockExecOnce(PROBE_REPLY);
      await variantPackImpl(ctxWith(vault), {
        ...DEFAULTS,
        name: "warm",
        comp_path: "/project1/look",
        seed_look: { Speed: 5, Steps: 8 },
        seed: 3,
      });
      const doc = JSON.parse(vault.read("MorphPacks/warm.morphpack.json")) as MorphPackDoc;
      expect(doc.schema).toBe("tdmcp.morphpack");
      expect(doc.schema_version).toBeLessThanOrEqual(1);
      expect(computeMorphPackHash(doc)).toBe(doc.sha256);
    });
  });
});

describe("variantPackImpl — guards", () => {
  it("refuses to overwrite existing file unless overwrite=true", async () => {
    await withVault(async (vault) => {
      vault.write("MorphPacks/warm.morphpack.json", "{}");
      const { calls } = mockExecOnce(PROBE_REPLY);
      const result = await variantPackImpl(ctxWith(vault), {
        ...DEFAULTS,
        name: "warm",
        seed_look: { Speed: 5 },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("already exists");
      expect(calls).toHaveLength(0);
    });
  });

  it("rejects vault path escape", async () => {
    await withVault(async (vault) => {
      const { calls } = mockExecOnce(PROBE_REPLY);
      const result = await variantPackImpl(ctxWith(vault), {
        ...DEFAULTS,
        name: "warm",
        seed_look: { Speed: 5 },
        vault_path: "../escape.json",
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Invalid vault path");
      expect(calls).toHaveLength(0);
    });
  });

  it("bridge fatal propagates as errorResult", async () => {
    await withVault(async (vault) => {
      mockExecOnce({ fatal: "exploded", warnings: [] });
      const result = await variantPackImpl(ctxWith(vault), {
        ...DEFAULTS,
        name: "warm",
        seed_look: { Speed: 5 },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("exploded");
    });
  });

  it("bridge offline returns a friendly errorResult and never throws", async () => {
    await withVault(async (vault) => {
      server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));
      const result = await variantPackImpl(ctxWith(vault), {
        ...DEFAULTS,
        name: "warm",
        seed_look: { Speed: 5 },
      });
      expect(result.isError).toBe(true);
    });
  });
});
