import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildAgentGuide,
  writeAgentGuideImpl,
  writeAgentGuideSchema,
} from "../../src/tools/layer3/writeAgentGuide.js";
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

// ---------------------------------------------------------------------------
// Pure buildAgentGuide tests
// ---------------------------------------------------------------------------

describe("buildAgentGuide (pure)", () => {
  it("contains the operator-conventions section", () => {
    const guide = buildAgentGuide();
    expect(guide).toContain("TOP");
    expect(guide).toContain("CHOP");
    expect(guide).toContain("SOP");
    expect(guide).toContain("MAT");
    expect(guide).toContain("DAT");
    expect(guide).toContain("COMP");
    expect(guide).toContain("Never invent operator types");
    expect(guide).toContain("get_td_node_errors");
    expect(guide).toContain("search_operators");
  });

  it("contains the render-coordinate rules with key values", () => {
    const guide = buildAgentGuide();
    // UV origin
    expect(guide).toContain("Bottom-left");
    // Default resolution
    expect(guide).toContain("1280");
    expect(guide).toContain("720");
    // NDC range present (ASCII minus)
    expect(guide).toMatch(/-1/);
    // Camera FOV note
    expect(guide).toContain("Horizontal");
    expect(guide).toContain("fovx");
  });

  it("contains the create -> verify -> preview loop", () => {
    const guide = buildAgentGuide();
    // The section heading uses ASCII arrows.
    expect(guide).toContain("create -> verify -> preview");
    expect(guide).toContain("get_td_node_errors");
    expect(guide).toContain("get_preview");
  });

  it("includes dynamic project summary when provided", () => {
    const guide = buildAgentGuide({
      project_name: "myPatch",
      node_count: 42,
      families: { TOP: 30, CHOP: 8, SOP: 4 },
    });
    expect(guide).toContain("myPatch");
    expect(guide).toContain("42");
    expect(guide).toContain("TOP×30");
    expect(guide).toContain("CHOP×8");
  });

  it("notes bridge offline when no summary is provided", () => {
    const guide = buildAgentGuide(undefined);
    expect(guide).toContain("unavailable");
  });

  it("references the knowledge base resources", () => {
    const guide = buildAgentGuide();
    expect(guide).toContain("tdmcp://operators/");
    expect(guide).toContain("tdmcp://classes/");
    expect(guide).toContain("tdmcp://recipes/");
  });
});

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------

describe("writeAgentGuideSchema", () => {
  it("defaults filename to CLAUDE.md and path to /project1", () => {
    const parsed = writeAgentGuideSchema.parse({});
    expect(parsed.filename).toBe("CLAUDE.md");
    expect(parsed.path).toBe("/project1");
    expect(parsed.output_dir).toBeUndefined();
  });

  it("accepts an AGENTS.md filename override", () => {
    const parsed = writeAgentGuideSchema.parse({ filename: "AGENTS.md" });
    expect(parsed.filename).toBe("AGENTS.md");
  });
});

// ---------------------------------------------------------------------------
// Happy path — bridge returns a project summary
// ---------------------------------------------------------------------------

describe("writeAgentGuideImpl — happy path", () => {
  it("returns a non-empty guide that includes static sections", async () => {
    // Capture the exec script payloads so we can inspect what was sent.
    const payloads: Array<Record<string, unknown>> = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        // Decode the base64 payload from the script.
        const b64Match = /b64decode\("([^"]+)"\)/.exec(body.script);
        if (b64Match?.[1]) {
          try {
            const decoded = JSON.parse(
              Buffer.from(b64Match[1], "base64").toString("utf-8"),
            ) as Record<string, unknown>;
            payloads.push(decoded);
          } catch {
            /* ignore */
          }
        }
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              project_name: "project1",
              node_count: 7,
              families: { TOP: 5, CHOP: 2 },
              written: false,
              warnings: [],
            }),
          },
        });
      }),
    );

    const result = await writeAgentGuideImpl(makeCtx(), {
      filename: "CLAUDE.md",
      output_dir: undefined,
      path: "/project1",
    });

    expect(result.isError).toBeFalsy();

    const structured = (result as { structuredContent?: Record<string, unknown> })
      .structuredContent;
    expect(structured).toBeDefined();
    expect(typeof structured?.guide).toBe("string");

    const guide = structured?.guide as string;
    expect(guide.length).toBeGreaterThan(100);
    // Static sections must be present.
    expect(guide).toContain("operator");
    expect(guide).toContain("Bottom-left");
    expect(guide).toContain("1280");
    expect(guide).toContain("create -> verify -> preview");
    // Dynamic summary from the mocked bridge.
    expect(guide).toContain("project1");
    expect(guide).toContain("7");
  });

  it("sets written:false and no path when output_dir is omitted", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              project_name: "demo",
              node_count: 3,
              families: { TOP: 3 },
              written: false,
              warnings: [],
            }),
          },
        }),
      ),
    );

    const result = await writeAgentGuideImpl(makeCtx(), {
      filename: "CLAUDE.md",
      output_dir: undefined,
      path: "/project1",
    });

    const structured = (result as { structuredContent?: Record<string, unknown> })
      .structuredContent;
    expect(structured?.written).toBe(false);
    expect(structured?.path).toBeUndefined();
  });

  it("reflects written:true and the path when output_dir is given and bridge confirms write", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              project_name: "stage",
              node_count: 10,
              families: { TOP: 8, CHOP: 2 },
              written: true,
              written_path: "/tmp/testguide/CLAUDE.md",
              warnings: [],
            }),
          },
        }),
      ),
    );

    const result = await writeAgentGuideImpl(makeCtx(), {
      filename: "CLAUDE.md",
      output_dir: "/tmp/testguide",
      path: "/project1",
    });

    const structured = (result as { structuredContent?: Record<string, unknown> })
      .structuredContent;
    expect(structured?.written).toBe(true);
    expect(structured?.path).toBe("/tmp/testguide/CLAUDE.md");
    expect(result.isError).toBeFalsy();
  });

  it("sends the path in the payload that reaches the bridge", async () => {
    const capturedPayloads: Array<Record<string, unknown>> = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        const b64Match = /b64decode\("([^"]+)"\)/.exec(body.script);
        if (b64Match?.[1]) {
          try {
            const decoded = JSON.parse(
              Buffer.from(b64Match[1], "base64").toString("utf-8"),
            ) as Record<string, unknown>;
            capturedPayloads.push(decoded);
          } catch {
            /* ignore */
          }
        }
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              project_name: "my_project",
              node_count: 1,
              families: {},
              written: false,
              warnings: [],
            }),
          },
        });
      }),
    );

    await writeAgentGuideImpl(makeCtx(), {
      filename: "CLAUDE.md",
      output_dir: undefined,
      path: "/project1/myComp",
    });

    // At least one exec call should have carried our path.
    expect(capturedPayloads.length).toBeGreaterThan(0);
    expect(capturedPayloads[0]?.path).toBe("/project1/myComp");
  });
});

// ---------------------------------------------------------------------------
// Bridge fatal path — must fail-forward (return guide, not throw)
// ---------------------------------------------------------------------------

describe("writeAgentGuideImpl — bridge fatal", () => {
  it("returns the static guide (isError=false) when the bridge returns a fatal", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              project_name: "/project1",
              node_count: 0,
              families: {},
              written: false,
              warnings: [],
              fatal: "Path not found: /bad",
            }),
          },
        }),
      ),
    );

    // A fatal in the bridge report is non-fatal for this tool (fail-forward).
    // The guide is still returned with an "unavailable" note.
    const result = await writeAgentGuideImpl(makeCtx(), {
      filename: "CLAUDE.md",
      output_dir: undefined,
      path: "/bad",
    });

    // Should NOT throw, and should return a guide.
    expect(result.isError).toBeFalsy();
    const structured = (result as { structuredContent?: Record<string, unknown> })
      .structuredContent;
    const guide = structured?.guide as string;
    expect(guide).toBeDefined();
    expect(guide.length).toBeGreaterThan(50);
  });

  it("returns the static guide (isError=false) when the bridge is completely offline", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));

    const result = await writeAgentGuideImpl(makeCtx(), {
      filename: "CLAUDE.md",
      output_dir: undefined,
      path: "/project1",
    });

    // Even with the bridge down, we should not throw.
    expect(result.isError).toBeFalsy();
    const structured = (result as { structuredContent?: Record<string, unknown> })
      .structuredContent;
    const guide = structured?.guide as string;
    expect(guide).toBeDefined();
    // The offline notice should be in the guide.
    expect(guide).toContain("unavailable");
  });
});
