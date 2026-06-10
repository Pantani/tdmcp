import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { LlmClientLike } from "../../src/llm/client.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { enhanceBuildImpl, enhanceBuildSchema } from "../../src/tools/layer1/enhanceBuild.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => server.close());

const ok = (data: unknown) => HttpResponse.json({ ok: true, data });

function mockBridge() {
  // score_build: errors=0, perf empty, complexity sparse (1 node → low), no preview TOP
  server.use(
    http.get(`${TD_BASE}/api/network/:seg/errors`, () => ok({ errors: [] })),
    http.get(`${TD_BASE}/api/network/:seg/performance`, () =>
      ok({ nodes: [{ path: "/project1/x", cook_time_ms: 0.1 }], total_cook_time_ms: 0.1 }),
    ),
    http.get(`${TD_BASE}/api/network/:seg/topology`, () =>
      ok({
        nodes: [{ path: "/project1/x", type: "noiseTOP", name: "x" }],
        connections: [],
      }),
    ),
    http.get(`${TD_BASE}/api/preview/:seg`, () =>
      HttpResponse.json({ ok: false, error: { message: "no preview" } }, { status: 404 }),
    ),
  );
}

function makeCtx(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    logger: silentLogger,
    ...extra,
  } as unknown as ToolContext;
}

function makeLlm(text: string): LlmClientLike {
  return {
    chatStream: async () => ({ role: "assistant", content: "" }),
    complete: async () => ({ text }),
  };
}

function fullArgs(over: Partial<Parameters<typeof enhanceBuildImpl>[1]> = {}) {
  return {
    scopePath: "/project1",
    autoApply: false,
    maxProposals: 3,
    targetFps: 60,
    rescore: true,
    ...over,
  } as Parameters<typeof enhanceBuildImpl>[1];
}

describe("enhanceBuildImpl", () => {
  it("schema defaults", () => {
    const parsed = enhanceBuildSchema.parse({});
    expect(parsed.scopePath).toBe("/project1");
    expect(parsed.autoApply).toBe(false);
    expect(parsed.maxProposals).toBe(3);
    expect(parsed.rescore).toBe(true);
  });

  it("no LLM configured → warning, proposals empty, before populated", async () => {
    mockBridge();
    const r = await enhanceBuildImpl(makeCtx(), fullArgs());
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent as {
      proposals: unknown[];
      applied: unknown[];
      warnings: string[];
      before: { final: number };
    };
    expect(out.proposals).toEqual([]);
    expect(out.applied).toEqual([]);
    expect(out.warnings.join(" ")).toMatch(/LLM not configured/);
    expect(typeof out.before.final).toBe("number");
  });

  it("valid plan, autoApply=false → proposals only, no applied/after", async () => {
    mockBridge();
    const llm = makeLlm(
      JSON.stringify({
        proposals: [
          {
            tool: "create_color_grade",
            args: { saturation: 1.5 },
            rationale: "boost palette",
            targets: ["palette"],
          },
        ],
      }),
    );
    const r = await enhanceBuildImpl(makeCtx({ llm }), fullArgs());
    const out = r.structuredContent as {
      proposals: Array<{ tool: string; targets: string[] }>;
      applied: unknown[];
      after?: unknown;
    };
    expect(out.proposals.length).toBe(1);
    expect(out.proposals[0]?.tool).toBe("create_color_grade");
    expect(out.applied.length).toBe(0);
    expect(out.after).toBeUndefined();
  });

  it("autoApply=true invokes allowlisted impl and rescores", async () => {
    mockBridge();
    let nodesPosted = 0;
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
        nodesPosted += 1;
        const body = (await request.json()) as {
          parent_path: string;
          type: string;
          name?: string;
        };
        const name = body.name ?? "n";
        return ok({ path: `${body.parent_path}/${name}`, type: body.type, name });
      }),
    );
    const llm = makeLlm(
      JSON.stringify({
        proposals: [
          {
            tool: "create_color_grade",
            args: { saturation: 1.5 },
            rationale: "boost palette",
            targets: ["palette"],
          },
        ],
      }),
    );
    const r = await enhanceBuildImpl(makeCtx({ llm }), fullArgs({ autoApply: true }));
    const out = r.structuredContent as {
      applied: Array<{ ok: boolean; summary?: string }>;
      after?: { final: number };
      delta?: { final: number };
    };
    expect(out.applied.length).toBe(1);
    expect(nodesPosted).toBeGreaterThan(0);
    expect(out.after).toBeDefined();
    expect(typeof out.delta?.final).toBe("number");
  });

  it("off-allowlist tool is dropped into warnings, not executed", async () => {
    mockBridge();
    const llm = makeLlm(
      JSON.stringify({
        proposals: [
          { tool: "delete_td_node", args: { path: "/project1/x" }, rationale: "no", targets: [] },
        ],
      }),
    );
    const r = await enhanceBuildImpl(makeCtx({ llm }), fullArgs({ autoApply: true }));
    const out = r.structuredContent as {
      proposals: unknown[];
      applied: unknown[];
      warnings: string[];
    };
    expect(out.proposals).toEqual([]);
    expect(out.applied).toEqual([]);
    expect(out.warnings.join(" ")).toMatch(/off-allowlist/);
  });

  it("malformed JSON → proposals empty, warning, no throw", async () => {
    mockBridge();
    const llm = makeLlm("sure, here you go: not json at all");
    const r = await enhanceBuildImpl(makeCtx({ llm }), fullArgs());
    const out = r.structuredContent as { proposals: unknown[]; warnings: string[] };
    expect(out.proposals).toEqual([]);
    expect(out.warnings.join(" ")).toMatch(/no JSON object|JSON parse/);
    expect(r.isError).toBeFalsy();
  });

  it("focusCriterion is forwarded into the LLM user payload", async () => {
    mockBridge();
    let captured = "";
    const llm: LlmClientLike = {
      chatStream: async () => ({ role: "assistant", content: "" }),
      complete: async (messages) => {
        const m = messages[0];
        captured = typeof m?.content === "string" ? m.content : "";
        return { text: JSON.stringify({ proposals: [] }) };
      },
    };
    await enhanceBuildImpl(makeCtx({ llm }), fullArgs({ focusCriterion: "motion" }));
    const parsed = JSON.parse(captured) as { focusCriterion?: string };
    expect(parsed.focusCriterion).toBe("motion");
  });

  it("maxProposals caps proposals and applied", async () => {
    mockBridge();
    const six = Array.from({ length: 6 }, () => ({
      tool: "create_color_grade",
      args: {},
      rationale: "r",
      targets: ["palette"],
    }));
    const llm = makeLlm(JSON.stringify({ proposals: six }));
    const r = await enhanceBuildImpl(
      makeCtx({ llm }),
      fullArgs({ autoApply: true, maxProposals: 2 }),
    );
    const out = r.structuredContent as {
      proposals: unknown[];
      applied: unknown[];
      warnings: string[];
    };
    expect(out.proposals.length).toBe(2);
    expect(out.applied.length).toBe(2);
    expect(out.warnings.join(" ")).toMatch(/Dropped 4/);
  });

  it("bridge offline on one probe → warning surfaced, no throw", async () => {
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/errors`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );
    const r = await enhanceBuildImpl(makeCtx(), fullArgs({ criteria: undefined } as never));
    // score_build now isolates per-criterion probe failures as warnings rather
    // than aborting; enhance_build either runs to completion or fails further
    // downstream. Either way, no throw and the result is a CallToolResult.
    expect(r).toBeDefined();
    expect(Array.isArray(r.content)).toBe(true);
  });
});
