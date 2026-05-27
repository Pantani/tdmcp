import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { scaffoldShowImpl } from "../../src/tools/layer1/scaffoldShow.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
}

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

function captureCreateBodies(): CreatedNodeBody[] {
  const bodies: CreatedNodeBody[] = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as CreatedNodeBody;
      bodies.push(body);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
  );
  return bodies;
}

describe("scaffoldShowImpl", () => {
  it("creates a master nullTOP, a beatCHOP, and a tempo nullCHOP", async () => {
    const bodies = captureCreateBodies();
    const result = await scaffoldShowImpl(makeCtx(), { name: "show", parent_path: "/project1" });
    expect(result.isError).toBeFalsy();
    expect(bodies.find((b) => b.name === "master")?.type).toBe("nullTOP");
    expect(bodies.find((b) => b.name === "beat")?.type).toBe("beatCHOP");
    expect(bodies.find((b) => b.name === "tempo")?.type).toBe("nullCHOP");
  });

  it("mentions master and tempo in the summary text", async () => {
    captureCreateBodies();
    const result = await scaffoldShowImpl(makeCtx(), { name: "show", parent_path: "/project1" });
    const text = textOf(result);
    expect(text).toContain("master");
    expect(text).toContain("tempo");
  });

  it("does not capture a preview image (capturePreviewImage is false)", async () => {
    captureCreateBodies();
    const result = await scaffoldShowImpl(makeCtx(), { name: "show", parent_path: "/project1" });
    // Show scaffold produces no inline image — it's a structural scaffold, not a visual output.
    expect(result.content.some((c) => c.type === "image")).toBe(false);
  });
});
