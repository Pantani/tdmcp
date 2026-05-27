import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { applyRecipeImpl } from "../../src/tools/layer1/applyRecipe.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("applyRecipeImpl", () => {
  it("returns an error listing available ids when the recipe id is not found", async () => {
    const ctx = makeCtx();
    const result = await applyRecipeImpl(ctx, {
      id: "xyzzy_nonexistent",
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("xyzzy_nonexistent");
    expect(text).toContain("not found");
    // The error message lists the available recipe ids so the caller knows what to pick.
    const available = ctx.recipes.list().map((r) => r.id);
    for (const id of available.slice(0, 2)) {
      expect(text).toContain(id);
    }
  });

  it("builds a known recipe and mentions its name in the summary", async () => {
    // Supply our own node-creation handler so the builder doesn't hang.
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
        const body = (await request.json()) as { parent_path: string; type: string; name?: string };
        const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
        return HttpResponse.json({
          ok: true,
          data: { path: `${body.parent_path}/${name}`, type: body.type, name },
        });
      }),
    );
    // Use 'reaction_diffusion' — a recipe that is validated in the test suite elsewhere.
    const result = await applyRecipeImpl(makeCtx(), {
      id: "reaction_diffusion",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("reaction_diffusion");
  });
});
