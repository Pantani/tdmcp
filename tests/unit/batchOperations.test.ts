import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  batchOperationsImpl,
  batchOperationsSchema,
} from "../../src/tools/layer2/batchOperations.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

interface ConnectOperation {
  action: string;
  source_path?: string;
  target_path?: string;
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

function captureBatchOps(): ConnectOperation[] {
  const ops: ConnectOperation[] = [];
  server.use(
    http.post(`${TD_BASE}/api/batch`, async ({ request }) => {
      const body = (await request.json()) as { operations: ConnectOperation[] };
      ops.push(...body.operations);
      return HttpResponse.json({
        ok: true,
        data: { results: body.operations.map((o) => ({ action: o.action, ok: true })) },
      });
    }),
  );
  return ops;
}

describe("batch_operations", () => {
  it("runs create/connect/setParam in order and reports created paths", async () => {
    const bodies = captureCreateBodies();
    const batchOps = captureBatchOps();
    const result = await batchOperationsImpl(makeCtx(), {
      default_parent: "/project1",
      operations: [
        { action: "create", type: "noiseTOP", name: "a" },
        { action: "create", type: "levelTOP", name: "b" },
        { action: "connect", from: "a", to: "b", from_output: 0, to_input: 0 },
        { action: "setParam", path: "a", parameters: { period: 2 } },
      ],
    });

    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      default_parent: string;
      results: Array<{ action: string; type?: string; path?: string }>;
      warnings: string[];
    };

    // Both nodes were created at the expected paths.
    expect(bodies.map((b) => b.type)).toEqual(["noiseTOP", "levelTOP"]);
    const createResults = data.results.filter((r) => r.action === "create");
    expect(createResults.map((r) => r.path)).toEqual(["/project1/a", "/project1/b"]);

    // A clean batch produces no warnings, and the summary reflects the counts.
    expect(data.warnings).toEqual([]);
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("2 created, 1 connected, 1 set, 0 warning(s)");

    // The connect referencing the in-batch name "a" resolved to its created path.
    const connect = batchOps.find((o) => o.action === "connect");
    expect(connect?.source_path).toBe("/project1/a");
    expect(connect?.target_path).toBe("/project1/b");
  });

  it("fails forward: a broken create yields a warning, the rest still run, no throw", async () => {
    captureBatchOps();
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
        const body = (await request.json()) as CreatedNodeBody;
        if (body.type === "brokenTOP") {
          return HttpResponse.json(
            { ok: false, error: { message: "no such type" } },
            { status: 500 },
          );
        }
        const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
        return HttpResponse.json({
          ok: true,
          data: { path: `${body.parent_path}/${name}`, type: body.type, name },
        });
      }),
    );

    const result = await batchOperationsImpl(makeCtx(), {
      default_parent: "/project1",
      operations: [
        { action: "create", type: "brokenTOP", name: "x" },
        { action: "create", type: "noiseTOP", name: "ok" },
        { action: "setParam", path: "ok", parameters: { period: 1 } },
      ],
    });

    // Never throws; the partial result is not an error.
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      results: Array<{ action: string; type?: string; path?: string }>;
      warnings: string[];
    };

    // The broken create is a warning; the good create + setParam still ran.
    expect(data.warnings.some((w) => w.includes("Create brokenTOP failed"))).toBe(true);
    expect(data.results.filter((r) => r.action === "create").map((r) => r.path)).toEqual([
      "/project1/ok",
    ]);
    expect(data.results.some((r) => r.action === "setParam" && r.path === "/project1/ok")).toBe(
      true,
    );
  });

  it("rejects bad input at the schema (empty list and unknown action)", () => {
    expect(() => batchOperationsSchema.parse({ operations: [] })).toThrow();
    expect(() =>
      batchOperationsSchema.parse({ operations: [{ action: "explode", type: "noiseTOP" }] }),
    ).toThrow();
    // default_parent defaults when omitted; connect indices coerce/default.
    const parsed = batchOperationsSchema.parse({
      operations: [{ action: "connect", from: "a", to: "b" }],
    });
    expect(parsed.default_parent).toBe("/project1");
    const connect = parsed.operations[0];
    expect(connect?.action).toBe("connect");
    if (connect?.action === "connect") {
      expect(connect.from_output).toBe(0);
      expect(connect.to_input).toBe(0);
    }
  });
});
