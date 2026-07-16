import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applySettings,
  ChatAccumulator,
  type ChatMessage,
  COMPLETE_RESPONSE_BYTES_MAX,
  InvalidCompleteOptionsError,
  LlmClient,
  type LlmConfig,
  LlmResponseTooLargeError,
  type OpenAITool,
} from "../../src/llm/client.js";

const BASE = "http://127.0.0.1:11434/v1";
const cfg: LlmConfig = {
  llmBaseUrl: BASE,
  llmModel: "llama3",
  llmApiKey: undefined,
  llmTemperature: 0.5,
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function chunkedResponse(
  chunks: Uint8Array[],
  options: { holdOpenAfterChunks?: boolean; onCancel?: () => void } = {},
): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk) {
          controller.enqueue(chunk);
          return;
        }
        if (options.holdOpenAfterChunks) return new Promise<void>(() => {});
        controller.close();
      },
      cancel() {
        options.onCancel?.();
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("applySettings", () => {
  it("only overrides provided non-empty fields and clears apiKey on empty string", () => {
    const cur: LlmConfig = { llmBaseUrl: "a", llmModel: "m", llmApiKey: "k" };
    expect(applySettings(cur, { model: "  ", baseUrl: "" })).toEqual(cur);
    expect(applySettings(cur, { model: " new ", baseUrl: " http://x ", apiKey: " tok " })).toEqual({
      llmBaseUrl: "http://x",
      llmModel: "new",
      llmApiKey: "tok",
    });
    expect(applySettings(cur, { apiKey: "" }).llmApiKey).toBeUndefined();
    expect(applySettings(cur, {}).llmApiKey).toBe("k");
  });
});

describe("ChatAccumulator", () => {
  it("merges streamed text + tool-call fragments by index, forwarding tokens", () => {
    const tokens: string[] = [];
    const acc = new ChatAccumulator((t) => tokens.push(t));
    acc.push({ choices: [{ delta: { content: "He" } }] });
    acc.push({ choices: [{ delta: { content: "llo" } }] });
    acc.push({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "c1", function: { name: "foo", arguments: '{"a":' } }],
          },
        },
      ],
    });
    acc.push({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }],
    });
    // empty delta + nameless slot get filtered out
    acc.push({ choices: [{ delta: undefined }] });
    acc.push({
      choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "x" } }] } }],
    });
    const msg = acc.finish();
    expect(tokens).toEqual(["He", "llo"]);
    expect(msg.content).toBe("Hello");
    expect(msg.tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "foo", arguments: '{"a":1}' } },
    ]);
  });

  it("returns null content when no text streamed and synthesizes id when missing", () => {
    const acc = new ChatAccumulator();
    acc.push({
      choices: [{ delta: { tool_calls: [{ function: { name: "bar", arguments: "{}" } }] } }],
    });
    const msg = acc.finish();
    expect(msg.content).toBeNull();
    expect(msg.tool_calls?.[0]?.id).toBe("call_bar");
  });
});

describe("LlmClient.complete", () => {
  it("returns text/model/stopReason on a happy completion and sends Bearer header", async () => {
    let authHeader: string | null = null;
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/chat/completions`, async ({ request }) => {
        authHeader = request.headers.get("authorization");
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          model: "llama3",
          choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        });
      }),
    );
    const client = new LlmClient({ ...cfg, llmApiKey: "sk-x" });
    const res = await client.complete(
      [
        { role: "system", content: "ignored" },
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", data: "AAA", mimeType: "image/png" },
          ],
        },
      ],
      { system: "override", maxTokens: 10, temperature: 0.1, stopSequences: ["END"] },
    );
    expect(res).toEqual({ text: "hi", model: "llama3", stopReason: "stop" });
    expect(authHeader).toBe("Bearer sk-x");
    const msgs = body.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[0]).toEqual({ role: "system", content: "override" });
    const parts = msgs[1]?.content as Array<{ image_url?: { url: string } }>;
    expect(parts[1]?.image_url?.url).toBe("data:image/png;base64,AAA");
    expect(body.max_tokens).toBe(10);
    expect(body.stop).toEqual(["END"]);
  });

  it("prepends a synthetic system message when system override given and no system in messages", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/chat/completions`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ choices: [{ message: { content: "" } }] });
      }),
    );
    const res = await new LlmClient(cfg).complete([{ role: "user", content: "hi" }], {
      system: "be terse",
    });
    const msgs = body.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[0]).toEqual({ role: "system", content: "be terse" });
    expect(res.text).toBe("");
    expect(res.model).toBeUndefined();
  });

  it("throws on non-2xx", async () => {
    server.use(
      http.post(`${BASE}/chat/completions`, () =>
        HttpResponse.text("model not found", { status: 404 }),
      ),
    );
    await expect(new LlmClient(cfg).complete([{ role: "user", content: "x" }])).rejects.toThrow(
      /HTTP 404.*model not found/,
    );
  });

  it("accepts a multi-chunk UTF-8 response exactly at maxResponseBytes", async () => {
    const payload = JSON.stringify({
      model: "bounded",
      choices: [{ message: { content: "olá" }, finish_reason: "stop" }],
    });
    const bytes = new TextEncoder().encode(payload);
    const split = bytes.indexOf(0xc3) + 1;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      chunkedResponse([bytes.slice(0, split), bytes.slice(split)]),
    );

    const result = await new LlmClient(cfg).complete([{ role: "user", content: "x" }], {
      maxResponseBytes: bytes.byteLength,
    });

    expect(result).toEqual({ text: "olá", model: "bounded", stopReason: "stop" });
  });

  it("cancels a multi-chunk response as soon as it exceeds maxResponseBytes", async () => {
    const payload = `${JSON.stringify({ choices: [{ message: { content: "too large" } }] })} `;
    const bytes = new TextEncoder().encode(payload);
    const maximum = bytes.byteLength - 1;
    let cancelled = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      chunkedResponse([bytes.slice(0, maximum), bytes.slice(maximum)], {
        holdOpenAfterChunks: true,
        onCancel: () => {
          cancelled = true;
        },
      }),
    );

    const pending = new LlmClient(cfg).complete([{ role: "user", content: "x" }], {
      maxResponseBytes: maximum,
    });

    await expect(pending).rejects.toBeInstanceOf(LlmResponseTooLargeError);
    await expect(pending).rejects.toMatchObject({
      code: "LLM_RESPONSE_TOO_LARGE",
      maxResponseBytes: maximum,
    });
    expect(cancelled).toBe(true);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    COMPLETE_RESPONSE_BYTES_MAX + 1,
  ])("rejects invalid maxResponseBytes=%s before fetching", async (maxResponseBytes) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      new LlmClient(cfg).complete([{ role: "user", content: "x" }], {
        maxResponseBytes,
      }),
    ).rejects.toBeInstanceOf(InvalidCompleteOptionsError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("aborts when timeoutMs elapses", async () => {
    server.use(
      http.post(`${BASE}/chat/completions`, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return HttpResponse.json({ choices: [] });
      }),
    );
    await expect(
      new LlmClient(cfg).complete([{ role: "user", content: "x" }], { timeoutMs: 20 }),
    ).rejects.toThrow(/abort|timeout/i);
  });

  it("aborts immediately when a pre-aborted signal is passed", async () => {
    server.use(http.post(`${BASE}/chat/completions`, () => HttpResponse.json({ choices: [] })));
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      new LlmClient(cfg).complete([{ role: "user", content: "x" }], {
        signal: ctrl.signal,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/abort/i);
  });
});

describe("LlmClient.health / listModels", () => {
  it("reports modelReady true when model id is present", async () => {
    server.use(
      http.get(`${BASE}/models`, () =>
        HttpResponse.json({ data: [{ id: "llama3" }, { id: "other" }] }),
      ),
    );
    const h = await new LlmClient(cfg).health();
    expect(h).toEqual({ ok: true, modelReady: true, detail: "model 'llama3' is ready" });
  });

  it("reports modelReady false and lists available models", async () => {
    server.use(http.get(`${BASE}/models`, () => HttpResponse.json({ data: [{ id: "x" }] })));
    const h = await new LlmClient(cfg).health();
    expect(h.modelReady).toBe(false);
    expect(h.detail).toMatch(/not pulled.*available: x/);
  });

  it("reports !ok on HTTP error", async () => {
    server.use(http.get(`${BASE}/models`, () => HttpResponse.text("nope", { status: 500 })));
    const h = await new LlmClient(cfg).health();
    expect(h).toEqual({ ok: false, modelReady: false, detail: "endpoint returned HTTP 500" });
  });

  it("reports !ok on network error", async () => {
    server.use(http.get(`${BASE}/models`, () => HttpResponse.error()));
    const h = await new LlmClient(cfg).health();
    expect(h.ok).toBe(false);
    expect(h.modelReady).toBe(false);
  });

  it("listModels returns ids on success, [] on http error and [] on throw", async () => {
    server.use(
      http.get(`${BASE}/models`, () => HttpResponse.json({ data: [{ id: "a" }, { id: "b" }] })),
    );
    expect(await new LlmClient(cfg).listModels()).toEqual(["a", "b"]);
    server.use(http.get(`${BASE}/models`, () => HttpResponse.text("x", { status: 500 })));
    expect(await new LlmClient(cfg).listModels()).toEqual([]);
    server.use(http.get(`${BASE}/models`, () => HttpResponse.error()));
    expect(await new LlmClient(cfg).listModels()).toEqual([]);
  });
});

describe("LlmClient.chatStream", () => {
  function sseBody(chunks: object[], includeJunk = false): string {
    const lines = chunks.map((c) => `data: ${JSON.stringify(c)}`);
    if (includeJunk) lines.unshift(": keep-alive", "data: not-json");
    lines.push("data: [DONE]", "");
    return `${lines.join("\n")}\n`;
  }

  it("accumulates text + tool calls and forwards tokens; tolerates junk lines", async () => {
    server.use(
      http.post(`${BASE}/chat/completions`, () =>
        HttpResponse.text(
          sseBody(
            [
              { choices: [{ delta: { content: "Hi " } }] },
              { choices: [{ delta: { content: "there" } }] },
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        { index: 0, id: "t1", function: { name: "doit", arguments: "{}" } },
                      ],
                    },
                  },
                ],
              },
            ],
            true,
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );
    const tokens: string[] = [];
    const tools: OpenAITool[] = [
      { type: "function", function: { name: "doit", description: "", parameters: {} } },
    ];
    const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];
    const out = await new LlmClient(cfg).chatStream(msgs, tools, {
      onToken: (t) => tokens.push(t),
    });
    expect(tokens.join("")).toBe("Hi there");
    expect(out.content).toBe("Hi there");
    expect(out.tool_calls?.[0]?.function.name).toBe("doit");
  });

  it("throws on non-2xx", async () => {
    server.use(
      http.post(`${BASE}/chat/completions`, () => HttpResponse.text("boom", { status: 500 })),
    );
    await expect(
      new LlmClient(cfg).chatStream([{ role: "user", content: "x" }], []),
    ).rejects.toThrow(/HTTP 500.*boom/);
  });
});

describe("LlmClient.pull", () => {
  it("forwards parsed progress lines and tolerates junk", async () => {
    const ndjson = `{"status":"downloading","total":100,"completed":50}\nnot-json\n{"status":"success"}\n`;
    server.use(
      http.post("http://127.0.0.1:11434/api/pull", () =>
        HttpResponse.text(ndjson, { headers: { "content-type": "application/x-ndjson" } }),
      ),
    );
    const progress: Array<{ status: string; total?: number; completed?: number }> = [];
    await new LlmClient(cfg).pull((p) => progress.push(p));
    expect(progress).toEqual([
      { status: "downloading", total: 100, completed: 50 },
      { status: "success" },
    ]);
  });

  it("strips trailing /v1 from base URL when building native root", async () => {
    server.use(http.post("http://127.0.0.1:11434/api/pull", () => HttpResponse.text("")));
    // /v1/ trailing variant exercises the regex's `/?$`
    await new LlmClient({ ...cfg, llmBaseUrl: "http://127.0.0.1:11434/v1/" }).pull(() => {});
  });

  it("throws on non-2xx", async () => {
    server.use(
      http.post("http://127.0.0.1:11434/api/pull", () =>
        HttpResponse.text("nope", { status: 502 }),
      ),
    );
    await expect(new LlmClient(cfg).pull(() => {})).rejects.toThrow(/pull failed.*502/);
  });
});
