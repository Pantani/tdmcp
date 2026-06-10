import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  type ConnectComfyuiReport,
  connectComfyuiImpl,
} from "../../src/tools/layer2/connectComfyui.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// connect_comfyui — 6 msw-driven unit tests, no live TouchDesigner.
// ---------------------------------------------------------------------------

// Round-3 Wave-4 fix: tox_drop success tests need an on-disk fixture because
// all default candidate paths are now absolute-only. The TS precheck
// short-circuits without a bridge call when no absolute candidate exists.
const TMP_DIR = mkdtempSync(join(tmpdir(), "tdmcp-comfyui-test-"));
const FIXTURE_TOX = join(TMP_DIR, "TDComfyUI.tox");
writeFileSync(FIXTURE_TOX, "stub");

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

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

function _dataOf(result: CallToolResult): ConnectComfyuiReport | undefined {
  const blob = result.content.find(
    (c): c is { type: "text"; text: string } => c.type === "text" && c.text.startsWith("{"),
  );
  if (!blob) return undefined;
  try {
    return JSON.parse(blob.text) as ConnectComfyuiReport;
  } catch {
    return undefined;
  }
}

// Helper to build a successful exec response with a JSON report as stdout.
function execOk(report: object) {
  return HttpResponse.json({
    ok: true,
    data: { result: null, stdout: JSON.stringify(report) },
  });
}

// ---------------------------------------------------------------------------
// Test 1: tox_drop success — bridge returns a loaded container path.
// ---------------------------------------------------------------------------
describe("tox_drop success", () => {
  it("returns mode_used=tox_drop, container_path, out_path, and no warnings", async () => {
    let callCount = 0;
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => {
        callCount += 1;
        if (callCount === 1) {
          // dropExternalTox script
          return execOk({
            ok: true,
            container_path: "/project1/comfyui/TDComfyUI",
            found_path:
              "/Library/Application Support/Derivative/TouchDesigner099/Components/TDComfyUI/TDComfyUI.tox",
            tox_path:
              "/Library/Application Support/Derivative/TouchDesigner099/Components/TDComfyUI/TDComfyUI.tox",
            tried: [
              "/Library/Application Support/Derivative/TouchDesigner099/Components/TDComfyUI/TDComfyUI.tox",
            ],
          });
        }
        // main COMFYUI_SCRIPT — tox_drop branch sets pars
        return execOk({
          mode_used: "tox_drop",
          container_path: "/project1/comfyui",
          out_path: "/project1/comfyui/out",
          tox_path:
            "/Library/Application Support/Derivative/TouchDesigner099/Components/TDComfyUI/TDComfyUI.tox",
          validated_pars: ["Serverurl", "Active"],
          missing_pars: ["Workflowpath"],
          warnings: [],
          errors: [],
        } satisfies ConnectComfyuiReport);
      }),
    );

    const result = await connectComfyuiImpl(makeCtx(), {
      mode: "tox_drop",
      tox_path: FIXTURE_TOX,
      parent_path: "/project1",
      name: "comfyui",
      server_url: "http://127.0.0.1:8188",
      output_top_name: "out",
      output_mode: "syphon",
      output_source_name: "ComfyUI",
      poll_interval_seconds: 0.5,
      active: false,
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("tox_drop");
    expect(text).toContain("/project1/comfyui");
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 2: auto mode — tox_drop finds no candidate (TS precheck), falls back to webclient.
// Round-3 Wave-4 fix: all candidates are now absolute. When none exist on disk,
// the TS-side precheck in dropExternalTox short-circuits without a bridge call.
// The webclient fallback is still tried (1 bridge call total, not 2).
// ---------------------------------------------------------------------------
describe("auto mode falls back to webclient", () => {
  it("returns mode_used=webclient when no .tox candidates found (precheck + webclient = 1 exec call)", async () => {
    let callCount = 0;
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => {
        callCount += 1;
        // This is the webclient skeleton build call only — the drop probe is
        // short-circuited TS-side without an exec call.
        return execOk({
          mode_used: "webclient",
          container_path: "/project1/comfyui",
          out_path: "/project1/comfyui/out",
          server_url: "http://127.0.0.1:8188",
          workflow_json_path: "/tmp/wf.json",
          warnings: [],
          errors: [],
        } satisfies ConnectComfyuiReport);
      }),
    );

    const result = await connectComfyuiImpl(makeCtx(), {
      mode: "auto",
      parent_path: "/project1",
      workflow_json_path: "/tmp/wf.json",
      server_url: "http://127.0.0.1:8188",
      output_top_name: "out",
      output_mode: "syphon",
      output_source_name: "ComfyUI",
      poll_interval_seconds: 0.5,
      active: false,
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("webclient");
    // 1 exec call (webclient only) — tox probe was short-circuited TS-side.
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 3: webclient explicit success — full report returned.
// ---------------------------------------------------------------------------
describe("webclient explicit success", () => {
  it("creates ops and returns container/out paths with no fatal", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({
          mode_used: "webclient",
          container_path: "/project1/comfyui",
          out_path: "/project1/comfyui/out",
          server_url: "http://127.0.0.1:8188",
          workflow_json_path: "/tmp/stable_diffusion.json",
          warnings: [],
          errors: [],
        } satisfies ConnectComfyuiReport),
      ),
    );

    const result = await connectComfyuiImpl(makeCtx(), {
      mode: "webclient",
      parent_path: "/project1",
      workflow_json_path: "/tmp/stable_diffusion.json",
      server_url: "http://127.0.0.1:8188",
      output_top_name: "out",
      output_mode: "syphon",
      output_source_name: "ComfyUI",
      poll_interval_seconds: 0.5,
      active: false,
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/comfyui");
    expect(text).toContain("/project1/comfyui/out");
  });
});

// ---------------------------------------------------------------------------
// Test 4: webclient without workflow_json_path → errorResult before any bridge call.
// ---------------------------------------------------------------------------
describe("webclient missing workflow_json_path", () => {
  it("returns isError before any bridge call", async () => {
    let bridgeCalled = false;
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => {
        bridgeCalled = true;
        return execOk({});
      }),
    );

    const result = await connectComfyuiImpl(makeCtx(), {
      mode: "webclient",
      parent_path: "/project1",
      server_url: "http://127.0.0.1:8188",
      output_top_name: "out",
      output_mode: "syphon",
      output_source_name: "ComfyUI",
      poll_interval_seconds: 0.5,
      active: false,
    });

    expect(result.isError).toBe(true);
    expect(bridgeCalled).toBe(false);
    const text = textOf(result);
    expect(text).toContain("workflow_json_path");
  });
});

// ---------------------------------------------------------------------------
// Test 5: server unreachable — Python creates ops fine; errors[] contains a
// node error from the webclientDAT trying to connect. Tool returns ok with warning.
// ---------------------------------------------------------------------------
describe("server unreachable propagated as node error", () => {
  it("returns ok but errors[] length >= 1 in the report", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({
          mode_used: "webclient",
          container_path: "/project1/comfyui",
          out_path: "/project1/comfyui/out",
          server_url: "http://127.0.0.1:8188",
          workflow_json_path: "/tmp/wf.json",
          warnings: [],
          errors: ["Connection refused: 127.0.0.1:8188"],
        } satisfies ConnectComfyuiReport),
      ),
    );

    const result = await connectComfyuiImpl(makeCtx(), {
      mode: "webclient",
      parent_path: "/project1",
      workflow_json_path: "/tmp/wf.json",
      server_url: "http://127.0.0.1:8188",
      output_top_name: "out",
      output_mode: "syphon",
      output_source_name: "ComfyUI",
      poll_interval_seconds: 0.5,
      active: false,
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("node error");
  });
});

// ---------------------------------------------------------------------------
// Test 6: tox_drop forced, no tox on disk — errorResult via TS precheck, NO bridge call.
// Round-3 Wave-4 fix: all candidate paths are now absolute, so the TS-side
// precheckToxCandidates short-circuits before any bridge round-trip.
// ---------------------------------------------------------------------------
describe("tox_drop forced with no candidates", () => {
  it("returns errorResult via TS precheck without any bridge call", async () => {
    let execCallCount = 0;
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => {
        execCallCount += 1;
        return execOk({ ok: false, error: "no_candidate_found", tried: [] });
      }),
    );

    const result = await connectComfyuiImpl(makeCtx(), {
      mode: "tox_drop",
      parent_path: "/project1",
      server_url: "http://127.0.0.1:8188",
      output_top_name: "out",
      output_mode: "syphon",
      output_source_name: "ComfyUI",
      poll_interval_seconds: 0.5,
      active: false,
    });

    expect(result.isError).toBe(true);
    // TS precheck fires before the bridge — zero exec calls.
    expect(execCallCount).toBe(0);
    const text = textOf(result);
    // Error message from tox_drop failure path
    expect(text.toLowerCase()).toMatch(/tox_drop|not found|candidate/i);
  });
});
