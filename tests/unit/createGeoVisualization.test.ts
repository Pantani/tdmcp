import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createGeoVisualizationImpl,
  createGeoVisualizationSchema,
  projectFeatures,
} from "../../src/tools/layer1/createGeoVisualization.js";
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

function captureExec(reportStdout?: string): { scripts: string[]; payloads: unknown[] } {
  const scripts: string[] = [];
  const payloads: unknown[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      const m = body.script.match(/b64decode\("([^"]+)"\)/);
      if (m?.[1]) payloads.push(JSON.parse(Buffer.from(m[1], "base64").toString("utf8")));
      return HttpResponse.json({ ok: true, data: { result: null, stdout: reportStdout ?? "" } });
    }),
  );
  return { scripts, payloads };
}

const FC = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { height: 5 },
      geometry: { type: "Point" as const, coordinates: [-0.1, 51.5] },
    },
    {
      type: "Feature",
      properties: { height: 20 },
      geometry: {
        type: "LineString" as const,
        coordinates: [
          [-0.11, 51.5],
          [-0.09, 51.51],
        ],
      },
    },
  ],
};

const okReport = JSON.stringify({
  container: "/project1/geo_viz",
  script_sop: "/project1/geo_viz/city",
  out: "/project1/geo_viz/city_out",
  render: "/project1/geo_viz/render",
  feature_count: 2,
  point_features: 1,
  line_features: 1,
  errors: [],
  warnings: [],
});

describe("projectFeatures", () => {
  it("projects lng/lat into a normalized box and reads heights", () => {
    const { features, warnings } = projectFeatures(FC, 0.1);
    expect(warnings).toHaveLength(0);
    expect(features).toHaveLength(2);
    const point = features.find((f) => f.kind === "point");
    const line = features.find((f) => f.kind === "line");
    expect(point?.height).toBe(5);
    expect(line?.height).toBe(20);
    // Every projected coordinate lands within [-2, 2] after normalization+scaling to unit box*2.
    for (const f of features) {
      for (const [x, y] of f.points) {
        expect(Math.abs(x)).toBeLessThanOrEqual(2.01);
        expect(Math.abs(y)).toBeLessThanOrEqual(2.01);
      }
    }
  });

  it("falls back to default_height when a feature has no numeric height", () => {
    const { features } = projectFeatures(
      {
        type: "FeatureCollection",
        features: [{ geometry: { type: "Point", coordinates: [0, 0] } }],
      },
      0.7,
    );
    expect(features[0]?.height).toBe(0.7);
  });

  it("warns on empty geometry", () => {
    const { features, warnings } = projectFeatures(
      { type: "FeatureCollection", features: [] },
      0.1,
    );
    expect(features).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("create_geo_visualization", () => {
  it("projects features in TS and passes them + scale/extrude to the bridge", async () => {
    const { scripts, payloads } = captureExec(okReport);
    const result = await createGeoVisualizationImpl(makeCtx(), {
      name: "geo_viz",
      parent_path: "/project1",
      geojson: FC,
      scale: 100,
      extrude: true,
      default_height: 0.1,
    });
    expect(result.isError).toBeFalsy();

    const payload = payloads[0] as {
      scale: number;
      extrude: boolean;
      features: Array<{ kind: string; points: number[][]; height: number }>;
    };
    expect(payload.scale).toBe(100);
    expect(payload.extrude).toBe(true);
    expect(payload.features).toHaveLength(2);
    expect(payload.features.some((f) => f.kind === "point")).toBe(true);
    expect(payload.features.some((f) => f.kind === "line")).toBe(true);

    expect(scripts[0]).toContain("scriptSOP");
    expect(scripts[0]).toContain("renderTOP");

    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("OpenStreetMap");
    expect(text?.text).toContain("ODbL");
  });

  it("applies schema defaults", () => {
    const parsed = createGeoVisualizationSchema.parse({
      geojson: { type: "FeatureCollection", features: [] },
    });
    expect(parsed.name).toBe("geo_viz");
    expect(parsed.scale).toBe(100);
    expect(parsed.extrude).toBe(true);
    expect(parsed.default_height).toBe(0.1);
  });

  it("rejects bad input at the schema boundary", () => {
    expect(() => createGeoVisualizationSchema.parse({})).toThrow(); // geojson required
    expect(() =>
      createGeoVisualizationSchema.parse({ geojson: { type: "FeatureCollection" }, scale: 0 }),
    ).toThrow();
  });

  it("returns isError (never throws) on bridge fatal", async () => {
    captureExec(JSON.stringify({ fatal: "Parent COMP not found: /nope", warnings: [] }));
    const result = await createGeoVisualizationImpl(makeCtx(), {
      name: "geo_viz",
      parent_path: "/nope",
      geojson: FC,
      scale: 100,
      extrude: true,
      default_height: 0.1,
    });
    expect(result.isError).toBe(true);
  });

  it("returns isError when the bridge is offline", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({ ok: false, error: "offline" }, { status: 502 }),
      ),
    );
    const result = await createGeoVisualizationImpl(makeCtx(), {
      name: "geo_viz",
      parent_path: "/project1",
      geojson: FC,
      scale: 100,
      extrude: true,
      default_height: 0.1,
    });
    expect(result.isError).toBe(true);
  });
});
