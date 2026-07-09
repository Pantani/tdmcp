import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  notchTouchengineBridgeImpl,
  notchTouchengineBridgeSchema,
} from "../../src/tools/layer2/notchTouchengineBridge.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
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

describe("notch_touchengine_bridge", () => {
  it("schema defaults to an inactive Notch TOP scaffold", () => {
    const parsed = notchTouchengineBridgeSchema.parse({});
    expect(parsed.mode).toBe("notch_top");
    expect(parsed.active).toBe(false);
    expect(parsed.play).toBe(false);
  });

  it("builds a Notch TOP scaffold with block path and live-validation warning", async () => {
    const bodies = captureCreateBodies();
    const result = await notchTouchengineBridgeImpl(
      makeCtx(),
      notchTouchengineBridgeSchema.parse({ block_path: "/blocks/show.dfxdll", play: true }),
    );

    expect(result.isError).toBeFalsy();
    const notch = bodies.find((body) => body.type === "notchTOP");
    expect(notch?.parameters?.block).toBe("/blocks/show.dfxdll");
    expect(notch?.parameters?.play).toBe(true);
    expect(bodies.some((body) => body.type === "nullTOP" && body.name === "out1")).toBe(true);
    expect(textOf(result)).toContain("UNVERIFIED-license-runtime");
  });

  it("builds an Engine COMP scaffold in TouchEngine mode", async () => {
    const bodies = captureCreateBodies();
    const result = await notchTouchengineBridgeImpl(
      makeCtx(),
      notchTouchengineBridgeSchema.parse({ mode: "engine_comp", tox_path: "/tox/scene.tox" }),
    );

    const engine = bodies.find((body) => body.type === "engineCOMP");
    expect(engine?.parameters?.file).toBe("/tox/scene.tox");
    expect(textOf(result)).toContain("engine_comp");
  });
});
