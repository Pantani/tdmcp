import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createPhraseLockedCueEngineImpl,
  createPhraseLockedCueEngineSchema,
} from "../../src/tools/layer1/createPhraseLockedCueEngine.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// Helpers
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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

function captureCreateBodies(): CreatedNodeBody[] {
  const bodies: CreatedNodeBody[] = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as CreatedNodeBody;
      bodies.push(body);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
  );
  return bodies;
}

function captureExecScripts(): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPhraseLockedCueEngine", () => {
  // 1. Happy path / 'next' mode default
  it("happy path — creates container, out CHOP, controls for phrase_length_bars=16", async () => {
    const ctx = makeCtx();
    const result = await createPhraseLockedCueEngineImpl(ctx, {
      pending_chop_path: "/project1/btn/out1",
      phrase_length_bars: 16,
      quantize_mode: "next",
      queue_capacity: 8,
      expose_controls: true,
      name: "phrase_lock",
      parent_path: "/project1",
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);

    // Container and trigger out path present in summary
    expect(text).toMatch(/phrase_lock/);
    expect(text).toMatch(/\/out/);

    // Reported phrase_length_bars and quantize_mode
    expect(text).toContain('"phrase_length_bars": 16');
    expect(text).toContain('"quantize_mode": "next"');

    // Controls list present
    expect(text).toContain("Active");
    expect(text).toContain("PhraseLength");
    expect(text).toContain("Flush");
    expect(text).toContain("QueueDepth");
  });

  // 2. 'aligned' mode — gate callback text contains 'aligned'
  it("aligned mode — gate callback contains 'aligned' literal", async () => {
    const scripts = captureExecScripts();
    const ctx = makeCtx();

    await createPhraseLockedCueEngineImpl(ctx, {
      pending_chop_path: "/project1/src/out1",
      phrase_length_bars: 8,
      quantize_mode: "aligned",
      queue_capacity: 8,
      expose_controls: true,
      name: "phrase_lock",
      parent_path: "/project1",
    });

    // Gate callback for 'aligned' mode has ARMED_CHECK baked to False (no arm logic).
    const gateScript = scripts.find((s) => s.includes("onValueChange") && s.includes("False"));
    expect(gateScript).toBeDefined();
    // 'False' means the arm check is disabled (aligned mode — no same-bar fire).
    expect(gateScript).toMatch(/if False:/);
    // Should NOT contain 'True' as the arm check (that would be 'next' mode).
    expect(gateScript).not.toMatch(/if True:/);
    // The enqueue script should carry 'aligned' mode literal.
    const enqScript = scripts.find((s) => s.includes("onOffToOn") && s.includes("aligned"));
    expect(enqScript).toBeDefined();
  });

  // 3. Non-default phrase_length_bars=32 — Beat CHOP period = 128
  it("phrase_length_bars=32 — Beat CHOP created with period=128", async () => {
    const bodies = captureCreateBodies();
    const ctx = makeCtx();

    await createPhraseLockedCueEngineImpl(ctx, {
      pending_chop_path: "/project1/src/out1",
      phrase_length_bars: 32,
      quantize_mode: "next",
      queue_capacity: 8,
      expose_controls: true,
      name: "phrase_lock",
      parent_path: "/project1",
    });

    const beatBody = bodies.find((b) => b.type === "beatCHOP" && b.name === "clock");
    expect(beatBody).toBeDefined();
    expect(beatBody?.parameters?.period).toBe(128); // 32 bars × 4 beats
  });

  // 4. FIFO depth — queue_capacity=4 appears in ENQUEUE_CALLBACK text
  it("queue_capacity=4 is substituted into enqueue callback text", async () => {
    const scripts = captureExecScripts();
    const ctx = makeCtx();

    await createPhraseLockedCueEngineImpl(ctx, {
      pending_chop_path: "/project1/src/out1",
      phrase_length_bars: 16,
      quantize_mode: "next",
      queue_capacity: 4,
      expose_controls: true,
      name: "phrase_lock",
      parent_path: "/project1",
    });

    const enqueueScript = scripts.find((s) => s.includes("onOffToOn") && s.includes("4"));
    expect(enqueueScript).toBeDefined();
    // The literal capacity value 4 should appear in the script (cap = 4)
    expect(enqueueScript).toMatch(/cap = 4/);
  });

  // 5. Invalid phrase_length — Zod rejects phrase_length_bars=6
  it("Zod rejects invalid phrase_length_bars=6", () => {
    const result = createPhraseLockedCueEngineSchema.safeParse({
      pending_chop_path: "/project1/src/out1",
      phrase_length_bars: 6,
    });
    expect(result.success).toBe(false);
  });

  // 6. Invalid quantize_mode — Zod rejects 'swing'
  it("Zod rejects invalid quantize_mode='swing'", () => {
    const result = createPhraseLockedCueEngineSchema.safeParse({
      pending_chop_path: "/project1/src/out1",
      quantize_mode: "swing",
    });
    expect(result.success).toBe(false);
  });

  // 7. Bridge offline — msw returns fatal in report; impl returns isError
  it("bridge fatal error is surfaced as isError result", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({ fatal: "COMP not found: /nope" }),
          },
        }),
      ),
    );

    const ctx = makeCtx();
    const result = await createPhraseLockedCueEngineImpl(ctx, {
      pending_chop_path: "/nope/out1",
      phrase_length_bars: 16,
      quantize_mode: "next",
      queue_capacity: 8,
      expose_controls: true,
      name: "phrase_lock",
      parent_path: "/nope",
    });

    // Either isError is set OR the text contains the fatal message
    const text = textOf(result);
    const isFatal = result.isError === true || text.includes("COMP not found");
    expect(isFatal).toBe(true);
  });
});
