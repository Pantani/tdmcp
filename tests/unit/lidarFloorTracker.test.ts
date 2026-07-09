import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  lidarFloorTrackerImpl,
  lidarFloorTrackerSchema,
} from "../../src/tools/layer1/lidarFloorTracker.js";
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

describe("lidar_floor_tracker", () => {
  it("schema defaults to inactive synthetic rehearsal mode", () => {
    const parsed = lidarFloorTrackerSchema.parse({});
    expect(parsed.sensor).toBe("synthetic");
    expect(parsed.active).toBe(false);
    expect(parsed.threshold).toBe(0.35);
  });

  it("builds a synthetic CHOP tracker plus floor preview", async () => {
    const bodies = captureCreateBodies();
    const result = await lidarFloorTrackerImpl(makeCtx(), lidarFloorTrackerSchema.parse({}));

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("offline-synthetic");
    for (const type of [
      "constantCHOP",
      "mathCHOP",
      "logicCHOP",
      "nullCHOP",
      "glslTOP",
      "nullTOP",
    ]) {
      expect(bodies.some((body) => body.type === type)).toBe(true);
    }
    expect(bodies.find((body) => body.name === "synthetic_points")?.parameters).toMatchObject({
      name0: "x",
      name1: "y",
      name2: "intensity",
      name3: "id",
    });
    expect(bodies.find((body) => body.name === "occupancy")?.parameters).toMatchObject({
      convert: "bound",
      boundmin: 0.35,
      boundmax: 1,
    });
    expect(bodies.some((body) => body.name === "tracked_points")).toBe(true);
  });

  it("scaffolds Ouster hardware inactive by default and reports unverified live validation", async () => {
    const bodies = captureCreateBodies();
    const result = await lidarFloorTrackerImpl(
      makeCtx(),
      lidarFloorTrackerSchema.parse({
        sensor: "ouster",
        sensor_address: "192.168.1.42",
        port: 7502,
      }),
    );

    const ouster = bodies.find((body) => body.type === "ousterTOP");
    expect(ouster?.parameters?.deviceaddress).toBe("192.168.1.42");
    expect(ouster?.parameters?.active).toBe(false);
    expect(textOf(result)).toContain("UNVERIFIED-hardware");
  });
});
