import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { analyzeProjectImpl, analyzeProjectSchema } from "../../src/tools/layer3/analyzeProject.js";
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

/** Decode the base64 payload embedded in a captured /api/exec script. */
function decodePayload(script: string): { path: string; recursive: boolean } {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

/** Override /api/exec to capture the script and return a crafted JSON report on stdout. */
function captureWithReport(report: unknown): { scripts: string[] } {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: `${JSON.stringify(report)}\n` },
      });
    }),
  );
  return { scripts };
}

const CRAFTED_REPORT = {
  path: "/project1",
  recursive: true,
  counts: { nodes: 5, by_family: { TOP: 3, CHOP: 1, COMP: 1 } },
  unused: [
    {
      path: "/project1/dead1",
      type: "constantTOP",
      reason: "no output connections, not referenced by any op(), not displayed/rendered",
    },
  ],
  broken_file_deps: [{ path: "/project1/movie1", par: "file", file: "/missing/clip.mov" }],
  orphan_comps: [
    { path: "/project1/emptybase", reason: "empty COMP with no connections and not referenced" },
  ],
  dependency_map: { "/project1/blur1": ["/project1/lfo1"] },
  warnings: [],
};

describe("analyze_project", () => {
  it("sends the walk + payload (path, recursive) to the bridge", async () => {
    const { scripts } = captureWithReport(CRAFTED_REPORT);
    const result = await analyzeProjectImpl(makeCtx(), { path: "/project1", recursive: true });
    expect(result.isError).toBeFalsy();

    expect(scripts).toHaveLength(1);
    const script = scripts[0] ?? "";
    // The analysis walks descendants inside TD.
    expect(script).toContain("findChildren");
    expect(script).toContain("outputConnectors");
    // The payload carries the requested root + recursion flag.
    const payload = decodePayload(script);
    expect(payload).toEqual({ path: "/project1", recursive: true });
  });

  it("passes recursive:false through to the payload", async () => {
    const { scripts } = captureWithReport({ ...CRAFTED_REPORT, recursive: false });
    await analyzeProjectImpl(makeCtx(), { path: "/project1/sys", recursive: false });
    const payload = decodePayload(scripts[0] ?? "");
    expect(payload).toEqual({ path: "/project1/sys", recursive: false });
  });

  it("surfaces unused / broken file deps / orphan COMPs in structuredContent", async () => {
    captureWithReport(CRAFTED_REPORT);
    const result = await analyzeProjectImpl(makeCtx(), { path: "/project1", recursive: true });
    const data = (
      result as {
        structuredContent?: {
          unused: unknown[];
          broken_file_deps: Array<{ par: string }>;
          orphan_comps: unknown[];
          dependency_map: Record<string, string[]>;
        };
      }
    ).structuredContent;
    expect(data?.unused).toHaveLength(1);
    expect(data?.broken_file_deps[0]?.par).toBe("file");
    expect(data?.orphan_comps).toHaveLength(1);
    expect(data?.dependency_map["/project1/blur1"]).toEqual(["/project1/lfo1"]);
  });

  it("writes a friendly one-line summary with the counts", async () => {
    captureWithReport(CRAFTED_REPORT);
    const result = await analyzeProjectImpl(makeCtx(), { path: "/project1", recursive: true });
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toBe(
      "Analyzed /project1: 5 node(s), 1 likely-unused, 1 broken file dep(s), 1 orphan COMP(s).",
    );
  });

  it("returns an isError result (no throw) when the bridge reports a fatal", async () => {
    captureWithReport({ ...CRAFTED_REPORT, fatal: "Network not found: /nope" });
    const result = await analyzeProjectImpl(makeCtx(), { path: "/nope", recursive: true });
    expect(result.isError).toBe(true);
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("Network not found: /nope");
  });

  it("does not throw when TD is unreachable — returns a friendly error", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));
    const result = await analyzeProjectImpl(makeCtx(), { path: "/project1", recursive: true });
    expect(result.isError).toBe(true);
  });

  it("defaults path to /project1 and recursive to true", () => {
    const parsed = analyzeProjectSchema.parse({});
    expect(parsed.path).toBe("/project1");
    expect(parsed.recursive).toBe(true);
  });

  it("prefers REST endpoint when present (no exec roundtrip)", async () => {
    let execCalls = 0;
    let analysisHits = 0;
    server.use(
      http.get(`${TD_BASE}/api/projects/:seg/analysis`, ({ request }) => {
        analysisHits += 1;
        const url = new URL(request.url);
        expect(url.searchParams.get("recursive")).toBe("true");
        return HttpResponse.json({ ok: true, data: CRAFTED_REPORT });
      }),
      http.post(`${TD_BASE}/api/exec`, () => {
        execCalls += 1;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    const result = await analyzeProjectImpl(makeCtx(), { path: "/project1", recursive: true });
    expect(result.isError).toBeFalsy();
    expect(analysisHits).toBe(1);
    expect(execCalls).toBe(0);
    const data = (result as { structuredContent?: { unused: unknown[] } }).structuredContent;
    expect(data?.unused).toHaveLength(1);
  });

  it("falls back to /api/exec when the REST endpoint is absent (404)", async () => {
    // tdMock default already returns 404 for /api/projects/*/analysis. Confirm
    // the tool still produces the same shape via the legacy exec path.
    const { scripts } = captureWithReport(CRAFTED_REPORT);
    const result = await analyzeProjectImpl(makeCtx(), { path: "/project1", recursive: true });
    expect(result.isError).toBeFalsy();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("findChildren");
  });
});
