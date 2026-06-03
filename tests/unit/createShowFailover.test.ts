import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createShowFailoverImpl } from "../../src/tools/layer1/createShowFailover.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

interface PatchBody {
  parameters: Record<string, unknown>;
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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

interface Recorder {
  creates: CreatedNodeBody[];
  patches: Array<{ path: string; parameters: Record<string, unknown> }>;
  scripts: string[];
}

function record(): Recorder {
  const rec: Recorder = { creates: [], patches: [], scripts: [] };
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as CreatedNodeBody;
      rec.creates.push(body);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
    http.patch(`${TD_BASE}/api/nodes/:seg`, async ({ params, request }) => {
      const body = (await request.json()) as PatchBody;
      const seg = decodeURIComponent(String(params.seg ?? ""));
      rec.patches.push({ path: seg, parameters: body.parameters });
      return HttpResponse.json({
        ok: true,
        data: { path: seg, type: "x", name: "x", parameters: body.parameters },
      });
    }),
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      rec.scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return rec;
}

describe("create_show_failover", () => {
  it("builds Switch TOP (blend=1) with watchdog DAT, fade, status CHOP", async () => {
    const rec = record();
    const result = await createShowFailoverImpl(makeCtx(), {
      primary_path: "/project1/cam",
      fallback_file: "/tmp/fb.mp4",
      stall_ms: 500,
      fade_ms: 250,
      sticky_recover: false,
      recover_ms: 2000,
      watch_errors: true,
      status_overlay: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    const byName = (name: string) => rec.creates.find((b) => b.name === name);

    // Container.
    const container = rec.creates.find((b) => b.type === "baseCOMP");
    expect(container?.name).toBe("show_failover");

    // Primary path → selectTOP with top = primary_path.
    const primary = byName("primary_in");
    expect(primary?.type).toBe("selectTOP");
    expect(primary?.parameters).toMatchObject({ top: "/project1/cam" });

    // Fallback file → moviefileinTOP with file param.
    const fallback = byName("fallback");
    expect(fallback?.type).toBe("moviefileinTOP");
    expect(fallback?.parameters).toMatchObject({ file: "/tmp/fb.mp4" });

    // Switch TOP with blend=1 (cross-dissolve via float index).
    const sw = byName("switch");
    expect(sw?.type).toBe("switchTOP");
    expect(sw?.parameters).toMatchObject({ blend: 1 });

    // Watchdog rail + status output.
    expect(byName("info")?.type).toBe("infoCHOP");
    expect(byName("stall_detect")?.type).toBe("logicCHOP");
    expect(byName("target_index")?.type).toBe("constantCHOP");
    expect(byName("fade")?.type).toBe("filterCHOP");
    expect(byName("status")?.type).toBe("nullCHOP");
    expect(byName("watchdog")?.type).toBe("executeDAT");
    expect(byName("watchdog")?.parameters).toMatchObject({ framestart: 1 });
    expect(byName("out")?.type).toBe("nullTOP");

    // status_overlay=true → textTOP + compTOP.
    expect(byName("status_text")?.type).toBe("textTOP");
    expect(byName("overlay")?.type).toBe("compTOP");

    // Info CHOP reads primary_in.
    expect(String(byName("info")?.parameters?.op)).toMatch(/\/primary_in$/);

    // Logic CHOP carries no offdelay on TD 099 — debounce is a downstream
    // Trigger CHOP with `release` = stall_ms/1000. Filter CHOP smooths the
    // Switch index over fade_ms/1000.
    expect(byName("stall_detect")?.parameters?.offdelay).toBeUndefined();
    expect(byName("stall_debounce")?.type).toBe("triggerCHOP");
    expect(byName("stall_debounce")?.parameters?.release).toBeCloseTo(0.5);
    expect(byName("fade")?.parameters?.width).toBeCloseTo(0.25);

    // Watchdog DAT text has substituted placeholders & references total_cooks + num_errors.
    const wdScript = rec.scripts.find((s) => s.includes("def onFrameStart"));
    expect(wdScript).toBeDefined();
    expect(wdScript).not.toContain("__STALL_MS__");
    expect(wdScript).not.toContain("__STICKY__");
    expect(wdScript).not.toContain("__WATCH_ERRORS__");
    expect(wdScript).toContain("500");
    expect(wdScript).toContain("total_cooks");
    expect(wdScript).toContain("'errors'");
    expect(wdScript).not.toContain("num_errors");
    expect(wdScript).toContain("False"); // sticky=false substituted
  });

  it("uses noiseTOP primary when primary_path is empty (offline-safe)", async () => {
    const rec = record();
    const result = await createShowFailoverImpl(makeCtx(), {
      primary_path: "",
      fallback_file: "/tmp/fb.mp4",
      stall_ms: 500,
      fade_ms: 250,
      sticky_recover: false,
      recover_ms: 2000,
      watch_errors: true,
      status_overlay: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const primary = rec.creates.find((b) => b.name === "primary_in");
    expect(primary?.type).toBe("noiseTOP");
    expect(textOf(result)).toContain("synthetic noiseTOP");
  });

  it("uses constantTOP fallback when fallback_file is empty", async () => {
    const rec = record();
    await createShowFailoverImpl(makeCtx(), {
      primary_path: "/project1/cam",
      fallback_file: "",
      stall_ms: 500,
      fade_ms: 250,
      sticky_recover: false,
      recover_ms: 2000,
      watch_errors: true,
      status_overlay: true,
      parent_path: "/project1",
    });
    const fb = rec.creates.find((b) => b.name === "fallback");
    expect(fb?.type).toBe("constantTOP");
  });

  it("omits the LIVE/FALLBACK overlay when status_overlay=false", async () => {
    const rec = record();
    await createShowFailoverImpl(makeCtx(), {
      primary_path: "/project1/cam",
      fallback_file: "/tmp/fb.mp4",
      stall_ms: 500,
      fade_ms: 250,
      sticky_recover: false,
      recover_ms: 2000,
      watch_errors: true,
      status_overlay: false,
      parent_path: "/project1",
    });
    expect(rec.creates.find((b) => b.name === "status_text")).toBeUndefined();
    expect(rec.creates.find((b) => b.name === "overlay")).toBeUndefined();
  });

  it("bakes sticky=True into the watchdog when sticky_recover is on", async () => {
    const rec = record();
    await createShowFailoverImpl(makeCtx(), {
      primary_path: "/project1/cam",
      fallback_file: "/tmp/fb.mp4",
      stall_ms: 500,
      fade_ms: 250,
      sticky_recover: true,
      recover_ms: 2000,
      watch_errors: true,
      status_overlay: true,
      parent_path: "/project1",
    });
    const wdScript = rec.scripts.find((s) => s.includes("def onFrameStart"));
    expect(wdScript).toContain("True"); // sticky=True
    expect(wdScript).toContain("2000"); // recover_ms baked in
  });

  it("collects failed connect calls as warnings (fail-forward)", async () => {
    // Force the legacy connect path (`/api/exec` containing `connect(`) to fail
    // so the builder's connect step records a warning rather than throwing.
    const rec = record();
    server.use(
      http.post(`${TD_BASE}/api/connect`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        rec.scripts.push(body.script);
        if (body.script.includes(".inputConnectors")) {
          return HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 });
        }
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    const result = await createShowFailoverImpl(makeCtx(), {
      primary_path: "/project1/cam",
      fallback_file: "/tmp/fb.mp4",
      stall_ms: 500,
      fade_ms: 250,
      sticky_recover: false,
      recover_ms: 2000,
      watch_errors: true,
      status_overlay: true,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/warnings/i);
  });
});
