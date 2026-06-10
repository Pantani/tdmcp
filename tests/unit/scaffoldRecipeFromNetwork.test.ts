import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeSchema } from "../../src/recipes/schema.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { buildFromRecipe } from "../../src/tools/layer2/orchestration.js";
import type { ToolContext } from "../../src/tools/types.js";
import { scaffoldRecipeFromNetworkImpl } from "../../src/tools/vault/scaffoldRecipeFromNetwork.js";
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

function makeCtx(vault?: Vault): ToolContext {
  return {
    client: client(),
    knowledge: new KnowledgeBase(),
    logger: silentLogger,
    ...(vault ? { vault } : {}),
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
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-scaffrec-"));
  return Promise.resolve(fn(new Vault(dir))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

function mockCapture(report: Record<string, unknown>): void {
  server.use(
    http.post(`${TD_BASE}/api/exec`, () =>
      HttpResponse.json({ ok: true, data: { result: null, stdout: JSON.stringify(report) } }),
    ),
  );
}

// Fixture: noiseTOP → levelTOP → outTOP, a mathCHOP whose `chop` references sibling
// `lfo1` (converter promotion), and a geometryCOMP `geo1` with a `sphereSOP` rendered.
const FIXTURE = {
  comp: "/project1",
  nodes: [
    { name: "noise1", type: "noiseTOP", parameters: { period: 4 } },
    { name: "level1", type: "levelTOP", parameters: { brightness1: 1.2 } },
    { name: "out1", type: "outTOP", parameters: {} },
    { name: "lfo1", type: "lfoCHOP", parameters: { frequency: 2 } },
    // The capture script's converter-promotion path strips `chop` and emits a
    // synthesized connection lfo1 → math1; we hand that pre-stripped shape here.
    { name: "math1", type: "mathCHOP", parameters: { gain: 2 } },
    { name: "geo1", type: "geometryCOMP", parameters: {} },
    {
      name: "sphere1",
      type: "sphereSOP",
      parameters: { rad: 0.5 },
      parent: "geo1",
      render: true,
    },
  ],
  connections: [
    { from: "noise1", to: "level1", from_output: 0, to_input: 0 },
    { from: "level1", to: "out1", from_output: 0, to_input: 0 },
    { from: "lfo1", to: "math1", from_output: 0, to_input: 0 },
  ],
  python_code: {},
  cross_refs: [],
  warnings: [],
};

describe("scaffoldRecipeFromNetworkImpl", () => {
  it("captures the network and returns a RecipeSchema-valid recipe", async () => {
    mockCapture(FIXTURE);
    const result = await scaffoldRecipeFromNetworkImpl(makeCtx(), {
      id: "myrec",
      root_path: "/project1",
      name: "My Recipe",
      description: "",
      tags: [],
      difficulty: "intermediate",
      include_defaults: false,
      detect_cross_refs: true,
      write_path: null,
      overwrite: false,
    });
    expect(result.isError).toBeFalsy();
    const data = jsonOf<{ recipe: unknown; nodes: number; connections: number; path: null }>(
      result,
    );
    // Re-parse from scratch — the returned recipe must round-trip through RecipeSchema.
    const reparsed = RecipeSchema.safeParse(data.recipe);
    expect(reparsed.success).toBe(true);
    expect(data.nodes).toBe(7);
    expect(data.connections).toBe(3);
    expect(data.path).toBeNull();
    if (reparsed.success) {
      const types = reparsed.data.nodes.map((n) => n.type).sort();
      expect(types).toEqual(
        [
          "geometryCOMP",
          "levelTOP",
          "lfoCHOP",
          "mathCHOP",
          "noiseTOP",
          "outTOP",
          "sphereSOP",
        ].sort(),
      );
      const sphere = reparsed.data.nodes.find((n) => n.name === "sphere1");
      expect(sphere?.parent).toBe("geo1");
      expect(sphere?.render).toBe(true);
      // Converter-promotion connection survived.
      expect(reparsed.data.connections.some((c) => c.from === "lfo1" && c.to === "math1")).toBe(
        true,
      );
    }
  });

  it("writes pretty JSON to the vault when write_path is set", async () => {
    await withVault(async (vault) => {
      mockCapture(FIXTURE);
      const result = await scaffoldRecipeFromNetworkImpl(makeCtx(vault), {
        id: "myrec",
        root_path: "/project1",
        description: "",
        tags: [],
        difficulty: "intermediate",
        include_defaults: false,
        detect_cross_refs: true,
        write_path: "Recipes/myrec.json",
        overwrite: false,
      });
      expect(result.isError).toBeFalsy();
      expect(vault.exists("Recipes/myrec.json")).toBe(true);
      const written = JSON.parse(vault.read("Recipes/myrec.json"));
      expect(written.id).toBe("myrec");
      // Same shape as the structuredContent recipe.
      const data = jsonOf<{ recipe: { id: string }; path: string }>(result);
      expect(data.path).toBe("Recipes/myrec.json");
      expect(data.recipe.id).toBe(written.id);
    });
  });

  it("refuses to overwrite an existing JSON file unless overwrite is true", async () => {
    await withVault(async (vault) => {
      vault.write("Recipes/myrec.json", "{}");
      mockCapture(FIXTURE);
      const result = await scaffoldRecipeFromNetworkImpl(makeCtx(vault), {
        id: "myrec",
        root_path: "/project1",
        description: "",
        tags: [],
        difficulty: "intermediate",
        include_defaults: false,
        detect_cross_refs: true,
        write_path: "Recipes/myrec.json",
        overwrite: false,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("overwrite:true");
    });
  });

  it("errors with a vault hint when write_path is set but no vault is configured", async () => {
    const result = await scaffoldRecipeFromNetworkImpl(makeCtx(), {
      id: "myrec",
      root_path: "/project1",
      description: "",
      tags: [],
      difficulty: "intermediate",
      include_defaults: false,
      detect_cross_refs: true,
      write_path: "Recipes/myrec.json",
      overwrite: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TDMCP_VAULT_PATH");
  });

  it("works without a vault when write_path is null (returns the JSON inline)", async () => {
    mockCapture(FIXTURE);
    const result = await scaffoldRecipeFromNetworkImpl(makeCtx(), {
      id: "myrec",
      root_path: "/project1",
      description: "",
      tags: [],
      difficulty: "intermediate",
      include_defaults: false,
      detect_cross_refs: true,
      write_path: null,
      overwrite: false,
    });
    expect(result.isError).toBeFalsy();
  });

  it("surfaces a capture fatal as an error", async () => {
    mockCapture({
      comp: "/nope",
      nodes: [],
      connections: [],
      python_code: {},
      cross_refs: [],
      warnings: [],
      fatal: "Operator not found: /nope",
    });
    const result = await scaffoldRecipeFromNetworkImpl(makeCtx(), {
      id: "rec",
      root_path: "/nope",
      description: "",
      tags: [],
      difficulty: "intermediate",
      include_defaults: false,
      detect_cross_refs: true,
      write_path: null,
      overwrite: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Scaffold failed");
  });

  it("errors when the captured network has no operators", async () => {
    mockCapture({
      comp: "/project1",
      nodes: [],
      connections: [],
      python_code: {},
      cross_refs: [],
      warnings: [],
    });
    const result = await scaffoldRecipeFromNetworkImpl(makeCtx(), {
      id: "empty",
      root_path: "/project1",
      description: "",
      tags: [],
      difficulty: "intermediate",
      include_defaults: false,
      detect_cross_refs: true,
      write_path: null,
      overwrite: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No operators found");
  });

  it("round-trip: the scaffolded recipe rebuilds via buildFromRecipe with no fatal errors", async () => {
    // Use a smaller fixture so the round-trip rebuild stays tractable. The msw
    // /api/nodes handler in the default mock generates `${type}1`-style names; to keep
    // recipe-node name resolution stable, we override it to honour the requested name.
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
        const body = (await request.json()) as {
          parent_path: string;
          type: string;
          name?: string;
        };
        const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
        return HttpResponse.json({
          ok: true,
          data: { path: `${body.parent_path}/${name}`, type: body.type, name },
        });
      }),
    );
    // First scaffold from a fixture report (override only /api/exec for this call).
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              comp: "/project1",
              nodes: [
                { name: "noise1", type: "noiseTOP", parameters: { period: 4 } },
                { name: "level1", type: "levelTOP", parameters: { brightness1: 1.2 } },
                { name: "out1", type: "outTOP", parameters: {} },
              ],
              connections: [
                { from: "noise1", to: "level1", from_output: 0, to_input: 0 },
                { from: "level1", to: "out1", from_output: 0, to_input: 0 },
              ],
              python_code: {},
              cross_refs: [],
              warnings: [],
            }),
          },
        }),
      ),
    );
    const ctx = makeCtx();
    const scaffolded = await scaffoldRecipeFromNetworkImpl(ctx, {
      id: "round_trip",
      root_path: "/project1",
      description: "",
      tags: [],
      difficulty: "intermediate",
      include_defaults: false,
      detect_cross_refs: true,
      write_path: null,
      overwrite: false,
    });
    expect(scaffolded.isError).toBeFalsy();
    const { recipe } = jsonOf<{ recipe: unknown }>(scaffolded);
    const parsed = RecipeSchema.safeParse(recipe);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // Now reset /api/exec to the default mock (returns empty stdout, used by
    // builder.python() for nested setters) so buildFromRecipe can run.
    server.resetHandlers();
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
        const body = (await request.json()) as {
          parent_path: string;
          type: string;
          name?: string;
        };
        const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
        return HttpResponse.json({
          ok: true,
          data: { path: `${body.parent_path}/${name}`, type: body.type, name },
        });
      }),
    );

    const built = await buildFromRecipe(makeCtx(), parsed.data, "/project1");
    // All recipe nodes must have been requested for creation.
    const createdNames = built.builder.created.map((c) => c.name).sort();
    expect(createdNames).toEqual(["level1", "noise1", "out1"]);
    // The scaffold→apply loop should not have produced any warnings (every node
    // resolved, every connection wired).
    expect(built.builder.warnings).toEqual([]);
  });
});
