import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildSetPerformModeScript,
  setPerformModeImpl,
  setPerformModeSchema,
} from "../../src/tools/layer2/setPerformMode.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface ExecBody {
  script: string;
  return_stdout?: boolean;
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

/** Capture the script sent to /api/exec and shape the bridge response. */
function captureExec(stdout: string): { captured: { script: string }[] } {
  const captured: { script: string }[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as ExecBody;
      captured.push({ script: body.script });
      return HttpResponse.json({ ok: true, data: { result: null, stdout } });
    }),
  );
  return { captured };
}

/** Decode the base64 payload embedded in the generated script. */
function decodePayload(script: string): Record<string, unknown> {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// buildSetPerformModeScript (unit — no HTTP)
// ---------------------------------------------------------------------------

describe("buildSetPerformModeScript", () => {
  it("embeds enabled=true in the base64 payload", () => {
    const script = buildSetPerformModeScript({ enabled: true });
    const payload = decodePayload(script);
    expect(payload.enabled).toBe(true);
  });

  it("embeds enabled=false in the base64 payload", () => {
    const script = buildSetPerformModeScript({ enabled: false });
    const payload = decodePayload(script);
    expect(payload.enabled).toBe(false);
  });

  it("stores the flag via op('/').store('tdmcp_perform_mode', ...)", () => {
    const script = buildSetPerformModeScript({ enabled: true });
    expect(script).toContain("_root.store('tdmcp_perform_mode'");
    expect(script).toContain("_root.fetch('tdmcp_perform_mode'");
  });
});

// ---------------------------------------------------------------------------
// setPerformModeImpl (integration with msw)
// ---------------------------------------------------------------------------

describe("setPerformModeImpl", () => {
  it("enabling → result not isError, summary says ON", async () => {
    const bridgeReport = JSON.stringify({
      enabled: true,
      stored: true,
      was: false,
      warnings: [],
    });
    const { captured } = captureExec(bridgeReport);

    const result = await setPerformModeImpl(makeCtx(), { enabled: true });

    expect(result.isError).toBeFalsy();

    // The payload sent to the bridge must carry enabled=true.
    expect(captured).toHaveLength(1);
    const payload = decodePayload(captured[0]?.script ?? "");
    expect(payload.enabled).toBe(true);

    // Summary text must say ON and mention skipping.
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("ON");
    expect(text?.text).toContain("skip");
    expect(text?.text).toContain("preview capture");
    expect(text?.text).not.toContain("event streaming");
    expect(text?.text).not.toContain("externalization");
  });

  it("disabling → result not isError, summary says OFF", async () => {
    const bridgeReport = JSON.stringify({
      enabled: false,
      stored: false,
      was: true,
      warnings: [],
    });
    const { captured } = captureExec(bridgeReport);

    const result = await setPerformModeImpl(makeCtx(), { enabled: false });

    expect(result.isError).toBeFalsy();

    const payload = decodePayload(captured[0]?.script ?? "");
    expect(payload.enabled).toBe(false);

    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("OFF");
    expect(text?.text).toContain("resume");
  });

  it("fatal from bridge → isError result, does not throw", async () => {
    const bridgeReport = JSON.stringify({
      enabled: true,
      stored: false,
      was: false,
      warnings: [],
      fatal: "NameError: name 'op' is not defined",
    });
    captureExec(bridgeReport);

    const result = await setPerformModeImpl(makeCtx(), { enabled: true });

    expect(result.isError).toBe(true);
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("NameError");
  });

  it("bridge returns warnings but no fatal → still succeeds", async () => {
    const bridgeReport = JSON.stringify({
      enabled: true,
      stored: true,
      was: false,
      warnings: [
        "ui.performMode not found on this TD build — flag stored but no native knob adjusted.",
      ],
    });
    captureExec(bridgeReport);

    const result = await setPerformModeImpl(makeCtx(), { enabled: true });

    expect(result.isError).toBeFalsy();
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("ON");
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("setPerformModeSchema", () => {
  it("enabled is required — parsing {} throws", () => {
    expect(() => setPerformModeSchema.parse({})).toThrow();
  });

  it("accepts enabled=true", () => {
    expect(setPerformModeSchema.parse({ enabled: true }).enabled).toBe(true);
  });

  it("accepts enabled=false", () => {
    expect(setPerformModeSchema.parse({ enabled: false }).enabled).toBe(false);
  });

  it("rejects non-boolean enabled", () => {
    expect(() => setPerformModeSchema.parse({ enabled: "yes" })).toThrow();
  });
});
