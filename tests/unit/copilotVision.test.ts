import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import type {
  CompleteOptions,
  CompleteResult,
  LlmClientLike,
  MultimodalMessage,
} from "../../src/llm/client.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { copilotVisionImpl } from "../../src/tools/layer3/copilotVision.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

class StubLlm implements LlmClientLike {
  public lastMessages: MultimodalMessage[] = [];
  constructor(private readonly answer: string) {}
  async chatStream(): Promise<never> {
    throw new Error("not used");
  }
  async complete(messages: MultimodalMessage[], _opts?: CompleteOptions): Promise<CompleteResult> {
    this.lastMessages = messages;
    return { text: this.answer, model: "stub-vision", stopReason: "endTurn" };
  }
}

function makeCtx(llm?: LlmClientLike): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
    llm,
  };
}

const ok = (data: unknown) => HttpResponse.json({ ok: true, data });

function jsonOf(result: { content: unknown[] }) {
  const text = (result.content[0] as { text: string }).text;
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  if (!m?.[1]) throw new Error(`no json: ${text}`);
  return JSON.parse(m[1]);
}

describe("copilotVisionImpl", () => {
  it("returns the LLM's answer and includes an image part", async () => {
    server.use(
      http.get(`${TD_BASE}/api/preview/:seg`, () =>
        ok({
          path: "/project1/out1",
          width: 32,
          height: 32,
          base64: "AAAA",
          mime_type: "image/png",
        }),
      ),
    );
    const llm = new StubLlm("Looks like a fiery orange constant — saturated.");
    const result = await copilotVisionImpl(makeCtx(llm), {
      source_top: "/project1/out1",
      question: "What dominant color do you see?",
      width: 32,
      height: 32,
      max_tokens: 128,
    });
    expect(result.isError).toBeFalsy();
    const r = jsonOf(result);
    expect(r.answer).toContain("orange");
    expect(r.model).toBe("stub-vision");
    const first = llm.lastMessages[0];
    expect(first?.content).toBeInstanceOf(Array);
    const parts = first?.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === "image")).toBe(true);
  });

  it("errors when no LLM backend is configured", async () => {
    const result = await copilotVisionImpl(makeCtx(undefined), {
      source_top: "/project1/out1",
      question: "Anything?",
      width: 32,
      height: 32,
      max_tokens: 128,
    });
    expect(result.isError).toBe(true);
  });

  it("warns when the LLM returns an empty response", async () => {
    server.use(
      http.get(`${TD_BASE}/api/preview/:seg`, () =>
        ok({
          path: "/project1/out1",
          width: 32,
          height: 32,
          base64: "AAAA",
          mime_type: "image/png",
        }),
      ),
    );
    const result = await copilotVisionImpl(makeCtx(new StubLlm("   ")), {
      source_top: "/project1/out1",
      question: "Anything?",
      width: 32,
      height: 32,
      max_tokens: 128,
    });
    expect(result.isError).toBeFalsy();
    const r = jsonOf(result);
    expect((r.warnings as string[]).some((w) => w.includes("empty"))).toBe(true);
  });
});
