import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  getInlinePreviewImpl,
  getInlinePreviewSchema,
} from "../../src/tools/layer3/getInlinePreview.js";
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
    logger: silentLogger,
  } as unknown as ToolContext;
}

interface Out {
  path: string;
  type: string;
  alive: boolean;
  thumbnail: { base64: string; format: "jpeg" | "png"; bytes: number };
  cook: { summary: string; cook_count?: number; resolution?: [number, number] };
  errors: { total: number; by_path: Record<string, unknown[]>; inspected_paths: string[] };
  changed_params: Array<{ name: string }>;
  parameters?: Record<string, unknown>;
  warnings?: string[];
}
function sc(result: CallToolResult): Out {
  return (result as { structuredContent?: Out }).structuredContent as Out;
}

// Helper: install an exec mock that captures the decoded payload and returns a
// fixed python report (as the LAST line of stdout, per parsePythonReport).
function mockExec(
  reportFn: (payload: Record<string, unknown>) => Record<string, unknown>,
  capture?: { payload?: Record<string, unknown> },
) {
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      const m = body.script.match(/b64decode\("([^"]+)"\)/);
      const payload = m?.[1]
        ? (JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) as Record<string, unknown>)
        : {};
      if (capture) capture.payload = payload;
      const report = reportFn(payload);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: `${JSON.stringify(report)}\n` },
      });
    }),
  );
}

const baseCook = {
  cook_time_ms: 0.42,
  cook_count: 100,
  width: 1920,
  height: 1080,
  pixel_format: "RGBA8",
};

describe("getInlinePreviewImpl", () => {
  const args = getInlinePreviewSchema.parse({ path: "/project1/out1" });

  it("happy path: assembles thumbnail + cook + 0 errors + changed_params", async () => {
    mockExec((p) => ({
      type: "compositeTOP",
      family: "TOP",
      cook: baseCook,
      errors: [],
      inspected_paths: ["/project1/out1"],
      changed_params: [
        { name: "amp", value: 0.5, default: 1.0 },
        { name: "phase", value: 0.1, default: 0.0 },
        { name: "size", value: 4, default: 1 },
      ],
      parameters: null,
      thumbnail: { base64: "AAAA", format: p.target_format, bytes: 1234 },
      warnings: [],
    }));
    const result = await getInlinePreviewImpl(makeCtx(), args);
    expect(result.isError).toBeFalsy();
    const data = sc(result);
    expect(data.alive).toBe(true);
    expect(data.thumbnail.format).toBe("jpeg");
    expect(data.changed_params).toHaveLength(3);
    expect(data.errors.total).toBe(0);
    expect(data.cook.summary).toContain("compositeTOP");
    expect(data.cook.summary).toContain("1920×1080");
  });

  it("png requested: thumbnail format stays png", async () => {
    mockExec((p) => ({
      type: "noiseTOP",
      cook: baseCook,
      errors: [],
      inspected_paths: ["/project1/out1"],
      changed_params: [],
      parameters: null,
      thumbnail: { base64: "AAAA", format: p.target_format, bytes: 100 },
      warnings: [],
    }));
    const result = await getInlinePreviewImpl(
      makeCtx(),
      getInlinePreviewSchema.parse({ path: "/project1/out1", format: "png" }),
    );
    expect(sc(result).thumbnail.format).toBe("png");
  });

  it("parent error marks alive=false and groups by_path", async () => {
    mockExec(() => ({
      type: "compositeTOP",
      cook: baseCook,
      errors: [{ path: "/project1/blur1", message: "compile failed", type: "error" }],
      inspected_paths: ["/project1/out1", "/project1/blur1"],
      changed_params: [],
      parameters: null,
      thumbnail: { base64: "AA", format: "jpeg", bytes: 50 },
      warnings: [],
    }));
    const data = sc(await getInlinePreviewImpl(makeCtx(), args));
    expect(data.errors.total).toBe(1);
    expect(data.errors.by_path["/project1/blur1"]).toHaveLength(1);
    expect(data.errors.inspected_paths).toContain("/project1/blur1");
    expect(data.alive).toBe(false);
  });

  it("clamps changed_params to max_changed_params (alphabetic prefix)", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `p${String(i).padStart(2, "0")}`,
      value: i,
    }));
    mockExec(() => ({
      type: "noiseTOP",
      cook: baseCook,
      errors: [],
      inspected_paths: ["/project1/out1"],
      changed_params: many.slice(0, 5), // python clamps; mock mirrors that
      parameters: null,
      thumbnail: { base64: "A", format: "jpeg", bytes: 10 },
      warnings: [],
    }));
    const data = sc(
      await getInlinePreviewImpl(
        makeCtx(),
        getInlinePreviewSchema.parse({ path: "/project1/out1", max_changed_params: 5 }),
      ),
    );
    expect(data.changed_params).toHaveLength(5);
    expect(data.changed_params[0]?.name).toBe("p00");
  });

  it("include_full_params: parameters key surfaces", async () => {
    mockExec(() => ({
      type: "noiseTOP",
      cook: baseCook,
      errors: [],
      inspected_paths: ["/project1/out1"],
      changed_params: [],
      parameters: { amp: 1, phase: 0 },
      thumbnail: { base64: "A", format: "jpeg", bytes: 10 },
      warnings: [],
    }));
    const data = sc(
      await getInlinePreviewImpl(
        makeCtx(),
        getInlinePreviewSchema.parse({ path: "/project1/out1", include_full_params: true }),
      ),
    );
    expect(data.parameters).toMatchObject({ amp: 1, phase: 0 });
  });

  it("parent_depth: 0 propagates into the bridge payload", async () => {
    const cap: { payload?: Record<string, unknown> } = {};
    mockExec(
      () => ({
        type: "noiseTOP",
        cook: baseCook,
        errors: [],
        inspected_paths: ["/project1/out1"],
        changed_params: [],
        parameters: null,
        thumbnail: { base64: "A", format: "jpeg", bytes: 10 },
        warnings: [],
      }),
      cap,
    );
    const data = sc(
      await getInlinePreviewImpl(
        makeCtx(),
        getInlinePreviewSchema.parse({ path: "/project1/out1", parent_depth: 0 }),
      ),
    );
    expect(cap.payload?.parent_depth).toBe(0);
    expect(data.errors.inspected_paths).toEqual(["/project1/out1"]);
  });

  it("rejects out-of-range width at the schema layer", () => {
    expect(() => getInlinePreviewSchema.parse({ path: "/x", width: 4096 })).toThrow();
  });

  it("TD offline (preview call errors) → friendly isError, no throw", async () => {
    server.use(http.get(`${TD_BASE}/api/preview/:seg`, () => HttpResponse.error()));
    const result = await getInlinePreviewImpl(makeCtx(), args);
    expect(result.isError).toBe(true);
  });

  it("bridge fatal in the python report → isError surfaces the path", async () => {
    mockExec(() => ({
      cook: {},
      errors: [],
      inspected_paths: [],
      changed_params: [],
      parameters: null,
      thumbnail: null,
      warnings: [],
      fatal: "Not found: /project1/out1",
    }));
    const result = await getInlinePreviewImpl(makeCtx(), args);
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("/project1/out1");
  });
});
