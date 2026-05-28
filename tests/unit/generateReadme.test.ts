import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import type { ReadmeReport } from "../../src/tools/layer3/generateReadme.js";
import {
  buildGenerateReadmeScript,
  buildReadme,
  generateReadmeImpl,
  generateReadmeSchema,
} from "../../src/tools/layer3/generateReadme.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// Shared MSW server
// ---------------------------------------------------------------------------
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
// Helper: a hand-crafted report for pure unit tests
// ---------------------------------------------------------------------------
function makeReport(overrides: Partial<ReadmeReport> = {}): ReadmeReport {
  return {
    title_default: "myComp",
    node_count: 3,
    nodes: [
      { path: "/project1/myComp/noise1", name: "noise1", type: "noiseTOP", family: "TOP" },
      { path: "/project1/myComp/blur1", name: "blur1", type: "blurTOP", family: "TOP" },
      { path: "/project1/myComp/lfo1", name: "lfo1", type: "lfoCHOP", family: "CHOP" },
    ],
    custom_params: [
      {
        comp: "noise1",
        name: "Speed",
        label: "Speed",
        value: "1.0",
        style: "Float",
      },
      {
        comp: "lfo1",
        name: "Rate",
        label: "LFO Rate",
        value: "0.5",
        style: "Float",
      },
    ],
    io: {
      inputs: ["noise1"],
      outputs: ["blur1"],
    },
    file_deps: [
      {
        path: "/project1/myComp/moviein1",
        par: "File",
        file: "/Users/me/footage.mov",
        exists: true,
      },
      {
        path: "/project1/myComp/videodev1",
        par: "File",
        file: "/missing/file.mov",
        exists: false,
      },
    ],
    output_top: "/project1/myComp/blur1",
    warnings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure buildReadme tests (no network, no MSW)
// ---------------------------------------------------------------------------
describe("buildReadme (pure)", () => {
  it("produces an H1 title from report.title_default when no title override", () => {
    const md = buildReadme(makeReport());
    expect(md).toContain("# myComp");
  });

  it("uses the explicit title override when provided", () => {
    const md = buildReadme(makeReport(), { title: "My Awesome Project" });
    expect(md).toContain("# My Awesome Project");
    expect(md).not.toContain("# myComp");
  });

  it("includes a Families table with correct family counts", () => {
    const md = buildReadme(makeReport());
    // Two TOPs (noise + blur), one CHOP (lfo)
    expect(md).toContain("## Families");
    expect(md).toMatch(/\|\s*TOP\s*\|\s*2\s*\|/);
    expect(md).toMatch(/\|\s*CHOP\s*\|\s*1\s*\|/);
  });

  it("includes a custom parameters table with all rows", () => {
    const md = buildReadme(makeReport());
    expect(md).toContain("## Custom parameters");
    expect(md).toContain("| noise1 | Speed | Speed | 1.0 | Float |");
    expect(md).toContain("| lfo1 | Rate | LFO Rate | 0.5 | Float |");
  });

  it("escapes pipe characters in custom parameter values", () => {
    const md = buildReadme(
      makeReport({
        custom_params: [
          { comp: "dat1", name: "Script", label: "Script", value: "a|b|c", style: "StrMenu" },
        ],
      }),
    );
    expect(md).toContain("a\\|b\\|c");
  });

  it("includes an Inputs / Outputs section", () => {
    const md = buildReadme(makeReport());
    expect(md).toContain("## Inputs / Outputs");
    expect(md).toContain("**Inputs:** noise1");
    expect(md).toContain("**Outputs:** blur1");
  });

  it("shows 'none detected' when there are no detected inputs or outputs", () => {
    const md = buildReadme(makeReport({ io: { inputs: [], outputs: [] } }));
    expect(md).toContain("**Inputs:** none detected");
    expect(md).toContain("**Outputs:** none detected");
  });

  it("includes a Child inventory table with node names and types", () => {
    const md = buildReadme(makeReport());
    expect(md).toContain("## Child inventory");
    expect(md).toContain("| noise1 | noiseTOP |");
    expect(md).toContain("| blur1 | blurTOP |");
    expect(md).toContain("| lfo1 | lfoCHOP |");
  });

  it("includes External files table with missing flag for absent files", () => {
    const md = buildReadme(makeReport());
    expect(md).toContain("## External files");
    expect(md).toContain("/Users/me/footage.mov");
    expect(md).toContain("yes");
    expect(md).toContain("**missing**");
  });

  it("omits External files section when there are no file deps", () => {
    const md = buildReadme(makeReport({ file_deps: [] }));
    expect(md).not.toContain("## External files");
  });

  it("includes a Warnings section when warnings are present", () => {
    const md = buildReadme(makeReport({ warnings: ["custom-par: something broke"] }));
    expect(md).toContain("## Warnings");
    expect(md).toContain("- custom-par: something broke");
  });

  it("omits the Warnings section when warnings are empty", () => {
    const md = buildReadme(makeReport({ warnings: [] }));
    expect(md).not.toContain("## Warnings");
  });

  it("does NOT include a Mermaid block by default (no connections from Python pass)", () => {
    const md = buildReadme(makeReport());
    expect(md).not.toContain("```mermaid");
  });

  it("includes a Mermaid block when includeMermaid is set", () => {
    const md = buildReadme(makeReport(), { includeMermaid: true });
    expect(md).toContain("```mermaid");
    expect(md).toContain("flowchart LR");
  });
});

// ---------------------------------------------------------------------------
// buildGenerateReadmeScript payload encoding
// ---------------------------------------------------------------------------
describe("buildGenerateReadmeScript", () => {
  it("encodes the path into the base64 payload", () => {
    const script = buildGenerateReadmeScript({ path: "/project1/myComp" });
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
    if (b64 === undefined) throw new Error("no base64 payload in script");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as {
      path: string;
    };
    expect(payload.path).toBe("/project1/myComp");
  });
});

// ---------------------------------------------------------------------------
// generateReadmeImpl — integration tests with mocked bridge (MSW)
// ---------------------------------------------------------------------------

/** Craft a JSON stdout line that parsePythonReport picks up. */
function makeExecStdout(report: ReadmeReport): string {
  return JSON.stringify(report);
}

function overrideExec(stdout: string): void {
  server.use(
    http.post(`${TD_BASE}/api/exec`, () =>
      HttpResponse.json({ ok: true, data: { result: null, stdout } }),
    ),
  );
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("generateReadmeImpl", () => {
  it("returns a non-empty structuredContent.markdown containing the title", async () => {
    const report = makeReport();
    overrideExec(makeExecStdout(report));

    const result = await generateReadmeImpl(makeCtx(), {
      path: "/project1/myComp",
      title: "My VJ Network",
      include_preview: false,
    });

    expect(result.isError).toBeFalsy();
    const sc = (result as { structuredContent?: { markdown: string; has_preview: boolean } })
      .structuredContent;
    expect(sc?.markdown).toBeTruthy();
    expect(sc?.markdown).toContain("# My VJ Network");
    expect(sc?.has_preview).toBe(false);
  });

  it("embeds preview when include_preview is true and output_top is set", async () => {
    // The default mock at GET /api/preview/:seg returns a 1x1 PNG base64.
    const report = makeReport({ output_top: "/project1/myComp/blur1" });
    overrideExec(makeExecStdout(report));

    const result = await generateReadmeImpl(makeCtx(), {
      path: "/project1/myComp",
      include_preview: true,
    });

    expect(result.isError).toBeFalsy();
    const sc = (result as { structuredContent?: { markdown: string; has_preview: boolean } })
      .structuredContent;
    expect(sc?.has_preview).toBe(true);
    expect(sc?.markdown).toContain("![preview](data:image/png;base64,");
  });

  it("sets has_preview=false when output_top is null even with include_preview=true", async () => {
    const report = makeReport({ output_top: null });
    overrideExec(makeExecStdout(report));

    const result = await generateReadmeImpl(makeCtx(), {
      path: "/project1/myComp",
      include_preview: true,
    });

    expect(result.isError).toBeFalsy();
    const sc = (result as { structuredContent?: { has_preview: boolean } }).structuredContent;
    expect(sc?.has_preview).toBe(false);
  });

  it("returns an isError result when the Python report carries a fatal field", async () => {
    overrideExec(
      JSON.stringify({
        title_default: "project1",
        node_count: 0,
        nodes: [],
        custom_params: [],
        io: { inputs: [], outputs: [] },
        file_deps: [],
        output_top: null,
        warnings: [],
        fatal: "COMP not found: /project1/ghost",
      }),
    );

    const result = await generateReadmeImpl(makeCtx(), {
      path: "/project1/ghost",
      include_preview: false,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMP not found");
  });

  it("does NOT throw when the bridge is offline — returns an isError result", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));

    const result = await generateReadmeImpl(makeCtx(), {
      path: "/project1",
      include_preview: false,
    });

    expect(result.isError).toBe(true);
    // Should mention a connection failure, not throw.
    expect(textOf(result).length).toBeGreaterThan(0);
  });

  it("defaults path to /project1 from the schema", () => {
    const parsed = generateReadmeSchema.parse({});
    expect(parsed.path).toBe("/project1");
    expect(parsed.include_preview).toBe(true);
  });

  it("exposes node_count and families on structuredContent", async () => {
    const report = makeReport();
    overrideExec(makeExecStdout(report));

    const result = await generateReadmeImpl(makeCtx(), {
      path: "/project1/myComp",
      include_preview: false,
    });

    const sc = (
      result as {
        structuredContent?: {
          node_count: number;
          families: Record<string, number>;
        };
      }
    ).structuredContent;
    expect(sc?.node_count).toBe(3);
    expect(sc?.families).toMatchObject({ TOP: 2, CHOP: 1 });
  });
});
