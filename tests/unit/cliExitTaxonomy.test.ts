import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/agent.js";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const makeCtx = (): ToolContext => ({
  client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 1500 }),
  knowledge: new KnowledgeBase(),
  recipes: new RecipeLibrary(),
  logger: silentLogger,
});

describe("CLI exit-code taxonomy through runCli", () => {
  it("exits 2 for invalid arguments (usage/config), never touching TD", async () => {
    const r = await runCli(["nodes", "get", "--params", "{ not valid json"], {
      makeCtx: () => {
        throw new Error("must not build a TD context for a usage error");
      },
    });
    expect(r.code).toBe(2);
  });

  it("exits 3 when a tool command cannot reach TouchDesigner", async () => {
    // collect-assets runs through /api/exec; a socket error is a connection failure.
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));
    const r = await runCli(
      ["collect-assets", "--params", JSON.stringify({ parent_path: "/project1" })],
      { makeCtx: makeCtx },
    );
    expect(r.code).toBe(3);
    expect(r.stderr.toLowerCase()).toContain("cannot reach touchdesigner");
  });

  it("exits 4 when TD is reached but the operation fails", async () => {
    // The bridge is reached and answers, but reports a fatal (bad path) — code 4.
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              parent: "/nope",
              assets: [],
              count: 0,
              missing_count: 0,
              warnings: [],
              fatal: "Parent not found: /nope",
            }),
          },
        }),
      ),
    );
    const r = await runCli(
      ["collect-assets", "--params", JSON.stringify({ parent_path: "/nope" })],
      { makeCtx: makeCtx },
    );
    // Reached-but-failed → TD error (4), not offline (3).
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("Parent not found");
  });
});
