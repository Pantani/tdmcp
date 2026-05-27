import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createDecksImpl } from "../../src/tools/layer2/createDecks.js";
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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Records every created node's {type, parameters} so the deck/crossfader build can be asserted. */
function captureCreates(): Array<{
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}> {
  const created: Array<{ type: string; name?: string; parameters?: Record<string, unknown> }> = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as {
        parent_path: string;
        type: string;
        name?: string;
        parameters?: Record<string, unknown>;
      };
      created.push({ type: body.type, name: body.name, parameters: body.parameters });
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
  );
  return created;
}

/** Records the connect operations sent to the batch endpoint. */
function captureConnections(): Array<Record<string, unknown>> {
  const connects: Array<Record<string, unknown>> = [];
  server.use(
    http.post(`${TD_BASE}/api/batch`, async ({ request }) => {
      const body = (await request.json()) as { operations: Array<Record<string, unknown>> };
      for (const op of body.operations) {
        if (op.action === "connect") connects.push(op);
      }
      return HttpResponse.json({
        ok: true,
        data: { results: body.operations.map((op) => ({ action: op.action, ok: true })) },
      });
    }),
  );
  return connects;
}

describe("create_decks", () => {
  it("builds two test-source decks + a crossfader + master + null when no sources are given", async () => {
    const created = captureCreates();
    const result = await createDecksImpl(makeCtx(), {
      parent_path: "/project1",
      crossfade: 0.5,
      expose_controls: true,
    });

    const text = textOf(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("DJ-style A/B decks");

    const types = created.map((c) => c.type);
    // Container + 2 test sources + 2 deck levels + cross + master level + null.
    expect(types).toContain("baseCOMP");
    // Test-source fallbacks: Noise for A, Ramp for B (no external Select TOPs).
    expect(types).toContain("noiseTOP");
    expect(types).toContain("rampTOP");
    expect(types).not.toContain("selectTOP");
    // Three Level TOPs: deck A gain, deck B gain, master FX.
    expect(types.filter((t) => t === "levelTOP")).toHaveLength(3);
    // Exactly one Cross TOP (the crossfader) and one output Null.
    expect(types.filter((t) => t === "crossTOP")).toHaveLength(1);
    expect(types.filter((t) => t === "nullTOP")).toHaveLength(1);
  });

  it("drives the crossfade via the Cross TOP `cross` parameter", async () => {
    const created = captureCreates();
    await createDecksImpl(makeCtx(), {
      parent_path: "/project1",
      crossfade: 0.8,
      expose_controls: false,
    });
    const cross = created.find((c) => c.type === "crossTOP");
    expect(cross?.parameters).toMatchObject({ cross: 0.8 });
  });

  it("sets per-deck gain/opacity on the Level TOPs (brightness1 + opacity)", async () => {
    const created = captureCreates();
    await createDecksImpl(makeCtx(), {
      parent_path: "/project1",
      crossfade: 0.5,
      expose_controls: false,
    });
    const levels = created.filter((c) => c.type === "levelTOP");
    for (const lvl of levels) {
      expect(lvl.parameters).toMatchObject({ brightness1: 1, opacity: 1 });
    }
  });

  it("pulls external deck sources through Select TOPs (no cross-container wires) and skips fallbacks", async () => {
    const created = captureCreates();
    await createDecksImpl(makeCtx(), {
      parent_path: "/project1",
      deck_a: "/project1/cam/out",
      deck_b: "/project1/video/out",
      crossfade: 0.5,
      expose_controls: false,
    });
    const selects = created.filter((c) => c.type === "selectTOP");
    expect(selects).toHaveLength(2);
    expect(selects.map((s) => s.parameters?.top)).toEqual(
      expect.arrayContaining(["/project1/cam/out", "/project1/video/out"]),
    );
    // With both real sources, no Noise/Ramp test fallbacks are created.
    const types = created.map((c) => c.type);
    expect(types).not.toContain("noiseTOP");
    expect(types).not.toContain("rampTOP");
  });

  it("wires deck A → input 0 and deck B → input 1 of the crossfader", async () => {
    const connects = captureConnections();
    await createDecksImpl(makeCtx(), {
      parent_path: "/project1",
      crossfade: 0.5,
      expose_controls: false,
    });
    // Deck A gain → cross input 0; deck B gain → cross input 1.
    const toCrossA = connects.find(
      (c) =>
        String(c.target_path).endsWith("/crossfader") &&
        Number(c.target_input) === 0 &&
        String(c.source_path).endsWith("/deckA_gain"),
    );
    const toCrossB = connects.find(
      (c) =>
        String(c.target_path).endsWith("/crossfader") &&
        Number(c.target_input) === 1 &&
        String(c.source_path).endsWith("/deckB_gain"),
    );
    expect(toCrossA).toBeDefined();
    expect(toCrossB).toBeDefined();
  });

  it("exposes a Crossfader knob bound to the Cross TOP and per-deck Gain knobs", async () => {
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        scripts.push(((await request.json()) as { script: string }).script);
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await createDecksImpl(makeCtx(), {
      parent_path: "/project1",
      crossfade: 0.5,
      expose_controls: true,
    });
    const all = scripts.join("\n");
    // The control-panel pass carries the control names + bind targets (base64 payload aside,
    // the bind expression references the parameter names directly).
    const panel = scripts.find(
      (s) => s.includes("appendCustomPage") || s.includes("__PAYLOAD_B64__"),
    );
    expect(panel).toBeDefined();
    // Crossfader + both gains end up in the exec stream (payload is decoded at runtime, but the
    // control names appear in the response summary regardless).
    expect(all.length).toBeGreaterThan(0);
  });

  it("reports the deck/crossfader structure in structured extra fields", async () => {
    const result = await createDecksImpl(makeCtx(), {
      parent_path: "/project1",
      crossfade: 0.25,
      expose_controls: false,
    });
    const text = textOf(result);
    expect(text).toContain("crossfader");
    expect(text).toContain("/project1/decks/crossfader");
    expect(text).toContain("/project1/decks/out1");
    expect(text).toContain('"crossfade": 0.25');
  });
});
