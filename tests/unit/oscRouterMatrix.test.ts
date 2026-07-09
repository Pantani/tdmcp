import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildOscRouterMatrixScript,
  defaultOscChannel,
  normalizeOscRouterArgs,
  oscRouterMatrixImpl,
  oscRouterMatrixSchema,
} from "../../src/tools/layer2/oscRouterMatrix.js";
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

function decodePayload(script: string) {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (!b64) throw new Error("no embedded payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    routes: Array<{ address: string; channel: string; target_channels: Record<string, string> }>;
    targets: Array<{ name: string; host: string; port: number; prefix: string }>;
  };
}

function captureExec(report: object) {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(report) },
      });
    }),
  );
  return { scripts };
}

describe("osc_router_matrix", () => {
  it("normalizes route addresses into per-target OSC channel names", () => {
    const normalized = normalizeOscRouterArgs(
      oscRouterMatrixSchema.parse({
        routes: [{ address: "/go" }, { address: "layer/1/opacity" }],
        targets: [
          { name: "qlab", host: "127.0.0.1", port: 53000 },
          { name: "resolume", host: "127.0.0.1", port: 7000, prefix: "/composition" },
        ],
      }),
    );
    const payload = decodePayload(buildOscRouterMatrixScript(normalized));
    expect(payload.routes[0]?.address).toBe("/go");
    expect(payload.routes[0]?.channel).toBe("go");
    expect(payload.routes[0]?.target_channels).toMatchObject({
      qlab: "go",
      resolume: "composition/go",
    });
    expect(payload.routes[1]?.target_channels.resolume).toBe("composition/layer/1/opacity");
  });

  it("sanitizes a default local channel name from the address tail", () => {
    expect(defaultOscChannel("/cue/1.5/start")).toBe("start");
    expect(defaultOscChannel("/1/bad-name")).toBe("bad_name");
  });

  it("builds a router and reports target addresses", async () => {
    const cap = captureExec({
      container: "/project1/osc_router_matrix",
      routes: [{ address: "/go", channel: "go", default: 0 }],
      targets: [
        {
          name: "qlab",
          host: "127.0.0.1",
          port: 53000,
          source: "/project1/osc_router_matrix/controls_qlab",
          osc_out: "/project1/osc_router_matrix/osc_qlab",
          addresses: ["/go"],
        },
      ],
      warnings: [],
    });

    const result = await oscRouterMatrixImpl(
      makeCtx(),
      oscRouterMatrixSchema.parse({
        routes: [{ address: "/go" }],
        targets: [{ name: "qlab", host: "127.0.0.1", port: 53000 }],
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Built OSC router matrix");
    expect(cap.scripts[0]).toContain("oscoutCHOP");
    expect(cap.scripts[0]).toContain("constantCHOP");
  });

  it("returns an isError result on bridge fatal", async () => {
    captureExec({ routes: [], targets: [], warnings: [], fatal: "Parent COMP not found: /nope" });
    const result = await oscRouterMatrixImpl(
      makeCtx(),
      oscRouterMatrixSchema.parse({
        parent_path: "/nope",
        routes: [{ address: "/go" }],
        targets: [{ name: "qlab", host: "127.0.0.1", port: 53000 }],
      }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });

  it("rejects empty route lists at the schema boundary", () => {
    expect(() =>
      oscRouterMatrixSchema.parse({
        routes: [],
        targets: [{ name: "qlab", host: "127.0.0.1", port: 53000 }],
      }),
    ).toThrow();
  });
});
