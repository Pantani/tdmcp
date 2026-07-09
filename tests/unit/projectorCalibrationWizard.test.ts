import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  projectorCalibrationWizardImpl,
  projectorCalibrationWizardSchema,
} from "../../src/tools/layer1/projectorCalibrationWizard.js";
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

describe("projector_calibration_wizard", () => {
  it("schema defaults are a one-projector generated-pattern rehearsal build", () => {
    const parsed = projectorCalibrationWizardSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("projector_calibration");
    expect(parsed.projectors).toBe(1);
    expect(parsed.include_corner_pin).toBe(true);
  });

  it("builds generated pattern plus per-projector crop/corner-pin/level/output lanes", async () => {
    const bodies = captureCreateBodies();
    const result = await projectorCalibrationWizardImpl(
      makeCtx(),
      projectorCalibrationWizardSchema.parse({ projectors: 2 }),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("UNVERIFIED-projector");
    expect(result.content.some((c) => c.type === "image")).toBe(true);
    expect(
      bodies.some((body) => body.type === "glslTOP" && body.name === "calibration_pattern"),
    ).toBe(true);
    expect(bodies.filter((body) => body.type === "cornerpinTOP")).toHaveLength(2);
    expect(bodies.filter((body) => body.type === "levelTOP")).toHaveLength(2);
    for (const level of bodies.filter((body) => body.type === "levelTOP")) {
      expect(level.parameters).toMatchObject({ brightness1: 1, gamma1: 1, opacity: 1 });
      expect(level.parameters).not.toHaveProperty("brightness");
      expect(level.parameters).not.toHaveProperty("gamma");
    }
    expect(bodies.find((body) => body.type === "layoutTOP")?.parameters?.align).toBe("horizlr");
    expect(bodies.some((body) => body.type === "layoutTOP")).toBe(true);
    expect(bodies.some((body) => body.name === "p2_out")).toBe(true);
  });

  it("uses a Select TOP when source_path is provided", async () => {
    const bodies = captureCreateBodies();
    await projectorCalibrationWizardImpl(
      makeCtx(),
      projectorCalibrationWizardSchema.parse({ source_path: "/project1/show/out1" }),
    );
    const select = bodies.find((body) => body.type === "selectTOP");
    expect(select?.parameters?.top).toBe("/project1/show/out1");
    expect(bodies.some((body) => body.name === "calibration_pattern")).toBe(false);
  });
});
