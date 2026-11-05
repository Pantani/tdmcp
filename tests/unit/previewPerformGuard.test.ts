import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assertNotPerforming, capturePreview } from "../../src/feedback/previewCapture.js";
import { runBridgeAnalyze } from "../../src/projectRag/extractors/bridgeAnalyze.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { TdConnectionError, TdTimeoutError } from "../../src/td-client/types.js";
import { createVisualCritiqueDependencies } from "../../src/tools/layer1/enhanceBuildVisualRuntime.js";
import { getPreviewImpl } from "../../src/tools/layer1/getPreview.js";
import { finalize, NetworkBuilder } from "../../src/tools/layer2/orchestration.js";
import { getInlinePreviewImpl } from "../../src/tools/layer3/getInlinePreview.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import policy from "../fixtures/exec-off-policy.json" with { type: "json" };
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const NODE = "/project1/out1";
const client = (timeoutMs = 2000) => new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs });

/** Serves `/api/system` and records whether exec and the preview itself were requested. */
function bridge(system: () => Response, exec?: () => Response) {
  const calls = { exec: 0, preview: 0, include: [] as Array<string | null> };
  server.use(
    http.get(`${TD_BASE}/api/system`, ({ request }) => {
      calls.include.push(new URL(request.url).searchParams.get("include"));
      return system();
    }),
    http.post(`${TD_BASE}/api/exec`, () => {
      calls.exec += 1;
      return exec ? exec() : execReply("");
    }),
    http.post(`${TD_BASE}/api/preview/:seg`, () => {
      calls.preview += 1;
      return data({ path: NODE, width: 8, height: 8, format: "png", base64: "AAAA" });
    }),
    http.get(`${TD_BASE}/api/preview/:seg`, () => {
      calls.preview += 1;
      return HttpResponse.json({
        ok: true,
        data: { path: NODE, width: 8, height: 8, format: "png", base64: "AAAA" },
      });
    }),
  );
  return calls;
}

const data = (body: unknown) => HttpResponse.json({ ok: true, data: body });
const fail = (status: number, message: string) =>
  HttpResponse.json({ ok: false, error: { message } }, { status });
const execReply = (stdout: string) => data({ result: null, stdout });
const execRefused = () => fail(403, policy.messages.exec);
const routeMissing = () => fail(404, "endpoint not supported (older bridge)");

const ACTIVE = /Perform mode is active/;
const UNKNOWN = /Could not confirm Perform mode is off/;

describe("capturePreview Perform-mode guard", () => {
  describe("bridge with the stored flag", () => {
    it("asks only for the stored flag, and captures when it is off", async () => {
      const calls = bridge(() => data({ storedPerformMode: false }));
      const preview = await capturePreview(client(), NODE);
      expect(preview.base64).toBe("AAAA");
      expect(calls).toMatchObject({ include: ["storedPerformMode"], exec: 0, preview: 1 });
    });

    it("refuses when the flag is on, without touching exec or rendering", async () => {
      const calls = bridge(() => data({ storedPerformMode: true }));
      await expect(capturePreview(client(), NODE)).rejects.toThrow(ACTIVE);
      expect(calls).toMatchObject({ exec: 0, preview: 0 });
    });

    it("still refuses on an exec-off bridge, the case the exec probe got wrong", async () => {
      const calls = bridge(() => data({ storedPerformMode: true }), execRefused);
      await expect(capturePreview(client(), NODE)).rejects.toThrow(ACTIVE);
      expect(calls).toMatchObject({ exec: 0, preview: 0 });
    });

    it("captures on an exec-off bridge when the flag is off", async () => {
      const calls = bridge(() => data({ storedPerformMode: false }), execRefused);
      await expect(capturePreview(client(), NODE)).resolves.toMatchObject({ path: NODE });
      expect(calls).toMatchObject({ exec: 0, preview: 1 });
    });

    it("ignores the native flag, which can disagree with the stored one", async () => {
      bridge(() => data({ performMode: true, storedPerformMode: false }));
      await expect(capturePreview(client(), NODE)).resolves.toMatchObject({ path: NODE });
    });

    it("refuses when the bridge reports it could not read the flag", async () => {
      const calls = bridge(() => data({ storedPerformMode: { error: "td.op unavailable" } }));
      await expect(capturePreview(client(), NODE)).rejects.toThrow(/td\.op unavailable/);
      expect(calls).toMatchObject({ exec: 0, preview: 0 });
    });

    it("refuses on a route error, without treating it as a missing route", async () => {
      const calls = bridge(() => fail(500, "boom"));
      await expect(capturePreview(client(), NODE)).rejects.toThrow(UNKNOWN);
      expect(calls).toMatchObject({ exec: 0, preview: 0 });
    });
  });

  describe("older bridge", () => {
    const olderBridges: Array<[string, () => Response]> = [
      ["no /api/system route (404)", routeMissing],
      ["no /api/system route (router 400)", () => fail(400, "Unsupported GET /api/system")],
      ["/api/system that ignores the unknown section", () => data({})],
    ];

    it.each(olderBridges)("falls back to exec: %s", async (_name, system) => {
      const calls = bridge(system, () => execReply('{"perform": true}'));
      await expect(capturePreview(client(), NODE)).rejects.toThrow(ACTIVE);
      expect(calls).toMatchObject({ exec: 1, preview: 0 });
    });

    it("captures when the exec fallback says the flag is off", async () => {
      const calls = bridge(routeMissing, () => execReply('{"perform": false}'));
      await expect(capturePreview(client(), NODE)).resolves.toMatchObject({ path: NODE });
      expect(calls).toMatchObject({ exec: 1, preview: 1 });
    });

    it.each(
      olderBridges,
    )("refuses and names the fix if exec is refused: %s", async (_n, system) => {
      const calls = bridge(system, execRefused);
      const failure = capturePreview(client(), NODE);
      await expect(failure).rejects.toThrow(UNKNOWN);
      await expect(failure).rejects.toThrow(/tdmcp install-bridge/);
      expect(calls.preview).toBe(0);
    });

    it.each([
      ["empty", ""],
      ["not JSON", "hello"],
      ["JSON without the flag", '{"other": 1}'],
      ["a non-boolean flag", '{"perform": "yes"}'],
    ])("refuses when the exec reply is %s", async (_name, stdout) => {
      const calls = bridge(routeMissing, () => execReply(stdout));
      await expect(capturePreview(client(), NODE)).rejects.toThrow(UNKNOWN);
      expect(calls.preview).toBe(0);
    });
  });

  it("applies the caller's timeout to the exec fallback too", async () => {
    server.use(
      http.get(`${TD_BASE}/api/system`, routeMissing),
      http.post(`${TD_BASE}/api/exec`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return execReply('{"perform": false}');
      }),
    );
    const guard = assertNotPerforming(client(), { timeoutMs: 20 });
    await expect(guard).rejects.toBeInstanceOf(TdTimeoutError);
  });

  it("stops the exec fallback when the caller aborts", async () => {
    const abort = new AbortController();
    server.use(
      http.get(`${TD_BASE}/api/system`, routeMissing),
      http.post(`${TD_BASE}/api/exec`, async () => {
        abort.abort();
        await new Promise((resolve) => setTimeout(resolve, 500));
        return execReply('{"perform": false}');
      }),
    );
    const started = Date.now();
    await expect(assertNotPerforming(client(), { signal: abort.signal })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(400);
  });

  describe("unreachable bridge", () => {
    it("keeps the connection error, so callers report TD as offline", async () => {
      const calls = bridge(() => HttpResponse.error());
      await expect(capturePreview(client(), NODE)).rejects.toBeInstanceOf(TdConnectionError);
      expect(calls).toMatchObject({ exec: 0, preview: 0 });
    });

    it("keeps a timeout on the read", async () => {
      server.use(
        http.get(`${TD_BASE}/api/system`, async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return data({ storedPerformMode: false });
        }),
      );
      await expect(capturePreview(client(20), NODE)).rejects.toBeInstanceOf(TdTimeoutError);
    });

    it("keeps a connection failure during the exec fallback", async () => {
      const calls = bridge(routeMissing, () => HttpResponse.error());
      await expect(capturePreview(client(), NODE)).rejects.toBeInstanceOf(TdConnectionError);
      expect(calls.preview).toBe(0);
    });
  });
});

describe("tools sharing the guard", () => {
  const ctx = () => ({ client: client(), logger: silentLogger }) as unknown as ToolContext;

  it("get_preview returns a friendly error while performing on an exec-off bridge", async () => {
    const calls = bridge(() => data({ storedPerformMode: true }), execRefused);
    const result = await getPreviewImpl(ctx(), { node_path: NODE, width: 64, height: 64 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(ACTIVE);
    expect(calls.preview).toBe(0);
  });

  it.each([
    ["sample_grid", { sample_grid: 4 }],
    ["pre_pulses", { pre_pulses: [{ path: "/project1/fb", par: "Reset" }] }],
    ["delay_frames", { delay_frames: 2 }],
  ])("get_preview's %s branch is guarded too", async (_name, extra) => {
    const calls = bridge(() => data({ storedPerformMode: true }), execRefused);
    const args = { node_path: NODE, width: 64, height: 64, ...extra };
    const result = await getPreviewImpl(ctx(), args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(ACTIVE);
    expect(calls.preview).toBe(0);
  });

  it("get_preview still collects a deferred capture while performing", async () => {
    const calls = bridge(() => data({ storedPerformMode: true }));
    server.use(
      http.get(`${TD_BASE}/api/preview_job/:seg`, () =>
        data({ job_id: "job1", status: "pending", path: NODE }),
      ),
    );
    const args = { job_id: "job1", width: 64, height: 64 };
    const result = await getPreviewImpl(ctx(), args);
    expect(result.isError).toBeFalsy();
    expect(calls.include).toEqual([]);
  });

  it("get_inline_preview refuses before capturing", async () => {
    const calls = bridge(() => data({ storedPerformMode: true }), execRefused);
    const result = await getInlinePreviewImpl(ctx(), {
      path: NODE,
      width: 64,
      height: 64,
      parent_depth: 0,
      max_changed_params: 8,
      include_full_params: false,
      format: "png",
      jpeg_quality: 70,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(ACTIVE);
    expect(calls).toMatchObject({ exec: 0, preview: 0 });
  });

  it("enhance-build's visual capture refuses before capturing", async () => {
    const calls = bridge(() => data({ storedPerformMode: true }), execRefused);
    server.use(http.get(`${TD_BASE}/api/editor/context`, () => data({ perform_mode: false })));
    const toolCtx = ctx();
    vi.spyOn(toolCtx.client, "getEditorContext").mockResolvedValue({
      perform_mode: false,
    } as never);
    const deps = createVisualCritiqueDependencies(toolCtx, "/project1", {} as never);
    const capture = deps.capture({ outputTopPath: NODE, width: 640, height: 360 });
    await expect(capture).rejects.toThrow(ACTIVE);
    expect(calls.preview).toBe(0);
  });

  it("the project RAG analyzer records no preview, and still succeeds, while performing", async () => {
    const quarantine = "http://127.0.0.1:9981";
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-guard-"));
    const artifactPath = join(dir, "show.toe");
    writeFileSync(artifactPath, "");
    let captures = 0;
    server.use(
      http.get(`${quarantine}/api/info`, () => data({ td_version: "2023.12000" })),
      http.post(`${quarantine}/api/project/load`, () =>
        data({ root_path: "/", node_count: 1, errors: [] }),
      ),
      http.get(`${quarantine}/api/network/:seg/errors`, () => data({ errors: [] })),
      http.get(`${quarantine}/api/system`, () => data({ storedPerformMode: true })),
      http.get(`${quarantine}/api/preview/:seg`, () => {
        captures += 1;
        return data({ path: "/", width: 8, height: 8, format: "png", base64: "AAAA" });
      }),
    );
    try {
      const result = await runBridgeAnalyze({ artifactPath, bridgePort: 9981 });
      expect(result.status).toBe("ok");
      expect(result.previewPng).toBeUndefined();
      expect(captures).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finalize keeps the build and warns when the preview is withheld", async () => {
    const calls = bridge(() => data({ storedPerformMode: true }), execRefused);
    const toolCtx = ctx();
    const builder = new NetworkBuilder(toolCtx, "/project1/sys");
    const result = await finalize(toolCtx, { builder, summary: "Built", outputPath: NODE });
    expect(result.isError).toBeFalsy();
    expect(result.content.some((c) => c.type === "image")).toBe(false);
    expect((result.structuredContent as { warnings: string[] }).warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(ACTIVE)]),
    );
    expect(calls.preview).toBe(0);
  });
});
