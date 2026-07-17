import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { duplicateNetworkImpl } from "../../src/tools/layer2/duplicateNetwork.js";
import { getTdPerformanceImpl } from "../../src/tools/layer3/getTdPerformance.js";
import {
  getTdTopologyImpl,
  getTdTopologyOutputSchema,
} from "../../src/tools/layer3/getTdTopology.js";
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

describe("analysis tool handlers", () => {
  describe("get_td_performance", () => {
    it("reports cook times on structuredContent without error", async () => {
      const result = await getTdPerformanceImpl(makeCtx(), {
        root_path: "/project1",
        target_fps: 60,
        recursive: true,
      });
      expect(result.isError).toBeFalsy();
      // Summary text stays small; full data travels on structuredContent.
      expect(textOf(result)).toContain("/project1");
      const data = JSON.stringify(result.structuredContent);
      expect(data).toContain("/project1/noise1");
      expect(data).toContain("totalCookMs");
      expect(data).toContain("frameBudgetMs");
    });
  });

  describe("get_td_topology", () => {
    it("reports nodes/connections on structuredContent without error", async () => {
      const result = await getTdTopologyImpl(makeCtx(), { root_path: "/project1" });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("node(s)");
      const data = JSON.stringify(result.structuredContent);
      expect(data).toContain("nodeCount");
      expect(data).toContain("connectionCount");
      expect(data).toContain("/project1/noise1");
      expect(getTdTopologyOutputSchema.parse(result.structuredContent)).toMatchObject({
        topological_order: ["/project1/noise1"],
        cycle_members: [],
        has_cycles: false,
      });
    });

    it("returns deterministic order for shuffled, disconnected, and noisy DAG input", async () => {
      server.use(
        http.get(`${TD_BASE}/api/network/:seg/topology`, () =>
          HttpResponse.json({
            ok: true,
            data: {
              nodes: ["d", "b", "e", "a", "c"].map((name) => ({
                path: `/project1/${name}`,
                name,
                type: "nullTOP",
              })),
              connections: [
                { source_path: "/project1/b", target_path: "/project1/c" },
                { source_path: "/project1/a", target_path: "/project1/c" },
                { source_path: "/project1/c", target_path: "/project1/d" },
                { source_path: "/project1/a", target_path: "/project1/c" },
                { source_path: "/unknown", target_path: "/project1/d" },
              ],
            },
          }),
        ),
      );

      const result = await getTdTopologyImpl(makeCtx(), { root_path: "/project1" });
      expect(getTdTopologyOutputSchema.parse(result.structuredContent)).toMatchObject({
        topological_order: [
          "/project1/a",
          "/project1/b",
          "/project1/c",
          "/project1/d",
          "/project1/e",
        ],
        cycle_members: [],
        has_cycles: false,
      });
    });

    it("orders SCC condensation and reports only real cycle members", async () => {
      server.use(
        http.get(`${TD_BASE}/api/network/:seg/topology`, () =>
          HttpResponse.json({
            ok: true,
            data: {
              nodes: ["e", "d", "c", "b", "a"].map((name) => ({
                path: `/project1/${name}`,
                name,
                type: "nullTOP",
              })),
              connections: [
                { source_path: "/project1/a", target_path: "/project1/b" },
                { source_path: "/project1/b", target_path: "/project1/a" },
                { source_path: "/project1/b", target_path: "/project1/c" },
                { source_path: "/project1/d", target_path: "/project1/d" },
              ],
            },
          }),
        ),
      );

      const result = await getTdTopologyImpl(makeCtx(), { root_path: "/project1" });
      expect(getTdTopologyOutputSchema.parse(result.structuredContent)).toMatchObject({
        topological_order: [
          "/project1/a",
          "/project1/b",
          "/project1/c",
          "/project1/d",
          "/project1/e",
        ],
        cycle_members: ["/project1/a", "/project1/b", "/project1/d"],
        has_cycles: true,
      });
    });
  });

  describe("duplicate_network", () => {
    it("prefers the first-class POST /api/duplicate route", async () => {
      server.use(
        http.post(`${TD_BASE}/api/duplicate`, async ({ request }) => {
          const body = (await request.json()) as { source_path: string };
          expect(body.source_path).toBe("/project1/noise1");
          return HttpResponse.json({
            ok: true,
            data: { source: "/project1/noise1", copy: "/project1/noise2", parent: "/project1" },
          });
        }),
      );
      const result = await duplicateNetworkImpl(makeCtx(), {
        source_path: "/project1/noise1",
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("Duplicated /project1/noise1 → /project1/noise2");
    });

    it("falls back to /api/exec when the endpoint is absent (older bridge)", async () => {
      // tdMock defaults POST /api/duplicate to 404; stub /api/exec to print the report.
      server.use(
        http.post(`${TD_BASE}/api/exec`, () =>
          HttpResponse.json({
            ok: true,
            data: {
              result: null,
              stdout: `${JSON.stringify({
                source: "/project1/noise1",
                copy: "/project1/noise2",
                parent: "/project1",
              })}\n`,
            },
          }),
        ),
      );
      const result = await duplicateNetworkImpl(makeCtx(), {
        source_path: "/project1/noise1",
      });
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("Duplicated /project1/noise1 → /project1/noise2");
    });
  });
});
