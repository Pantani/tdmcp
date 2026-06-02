import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applySettings, ChatAccumulator, LlmClient, type LlmConfig } from "../../src/llm/client.js";

const BASE = "http://127.0.0.1:11500";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const cfg = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  llmBaseUrl: BASE,
  llmModel: "m1",
  llmApiKey: undefined,
  ...over,
});

describe("applySettings", () => {
  it("ignores empty model/baseUrl and clears apiKey on empty string", () => {
    const out = applySettings(
      { llmBaseUrl: "a", llmModel: "m", llmApiKey: "k" },
      { model: "  ", baseUrl: "", apiKey: "" },
    );
    expect(out.llmBaseUrl).toBe("a");
    expect(out.llmModel).toBe("m");
    expect(out.llmApiKey).toBeUndefined();
  });

  it("trims non-empty values and updates", () => {
    const out = applySettings(
      { llmBaseUrl: "a", llmModel: "m", llmApiKey: undefined },
      { model: "  new ", baseUrl: " http://x ", apiKey: " tok " },
    );
    expect(out.llmModel).toBe("new");
    expect(out.llmBaseUrl).toBe("http://x");
    expect(out.llmApiKey).toBe("tok");
  });

  it("leaves apiKey alone when omitted from patch", () => {
    const out = applySettings({ llmBaseUrl: "a", llmModel: "m", llmApiKey: "k" }, {});
    expect(out.llmApiKey).toBe("k");
  });
});

describe("ChatAccumulator", () => {
  it("merges text deltas and forwards tokens", () => {
    const tokens: string[] = [];
    const acc = new ChatAccumulator((t) => tokens.push(t));
    acc.push({ choices: [{ delta: { content: "hel" } }] });
    acc.push({ choices: [{ delta: { content: "lo" } }] });
    const msg = acc.finish();
    expect(msg.content).toBe("hello");
    expect(msg.tool_calls).toBeUndefined();
    expect(tokens).toEqual(["hel", "lo"]);
  });

  it("reassembles streaming tool-call fragments by index", () => {
    const acc = new ChatAccumulator();
    acc.push({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "c1", function: { name: "create_td_node", arguments: '{"o":' } },
            ],
          },
        },
      ],
    });
    acc.push({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"noiseTOP"}' } }] } }],
    });
    const msg = acc.finish();
    expect(msg.content).toBeNull();
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls?.[0]?.function.name).toBe("create_td_node");
    expect(msg.tool_calls?.[0]?.function.arguments).toBe('{"o":"noiseTOP"}');
    expect(msg.tool_calls?.[0]?.id).toBe("c1");
  });

  it("synthesizes an id when none was streamed", () => {
    const acc = new ChatAccumulator();
    acc.push({
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { name: "x", arguments: "{}" } }] } },
      ],
    });
    expect(acc.finish().tool_calls?.[0]?.id).toBe("call_x");
  });

  it("ignores chunks without delta", () => {
    const acc = new ChatAccumulator();
    acc.push({ choices: [{}] });
    acc.push({});
    expect(acc.finish().content).toBeNull();
  });
});

describe("LlmClient.health and listModels", () => {
  it("health: ok+modelReady when configured model is listed", async () => {
    server.use(
      http.get(`${BASE}/models`, () => HttpResponse.json({ data: [{ id: "m1" }, { id: "m2" }] })),
    );
    const r = await new LlmClient(cfg()).health();
    expect(r).toEqual({ ok: true, modelReady: true, detail: expect.stringContaining("m1") });
  });

  it("health: ok but modelReady=false lists available", async () => {
    server.use(http.get(`${BASE}/models`, () => HttpResponse.json({ data: [{ id: "other" }] })));
    const r = await new LlmClient(cfg()).health();
    expect(r.ok).toBe(true);
    expect(r.modelReady).toBe(false);
    expect(r.detail).toContain("not pulled");
    expect(r.detail).toContain("other");
  });

  it("health: HTTP error surfaces detail", async () => {
    server.use(http.get(`${BASE}/models`, () => new HttpResponse(null, { status: 500 })));
    const r = await new LlmClient(cfg()).health();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("HTTP 500");
  });

  it("health: network error returns ok=false", async () => {
    server.use(http.get(`${BASE}/models`, () => HttpResponse.error()));
    const r = await new LlmClient(cfg()).health();
    expect(r.ok).toBe(false);
    expect(r.modelReady).toBe(false);
  });

  it("listModels: returns ids on success, [] on error", async () => {
    server.use(
      http.get(`${BASE}/models`, () => HttpResponse.json({ data: [{ id: "a" }, { id: "b" }] })),
    );
    expect(await new LlmClient(cfg()).listModels()).toEqual(["a", "b"]);

    server.use(http.get(`${BASE}/models`, () => new HttpResponse(null, { status: 500 })));
    expect(await new LlmClient(cfg()).listModels()).toEqual([]);

    server.use(http.get(`${BASE}/models`, () => HttpResponse.error()));
    expect(await new LlmClient(cfg()).listModels()).toEqual([]);
  });

  it("sets Bearer header when apiKey is configured", async () => {
    let seen: string | null = null;
    server.use(
      http.get(`${BASE}/models`, ({ request }) => {
        seen = request.headers.get("authorization");
        return HttpResponse.json({ data: [] });
      }),
    );
    await new LlmClient(cfg({ llmApiKey: "secret" })).listModels();
    expect(seen).toBe("Bearer secret");
  });
});

describe("LlmClient.complete", () => {
  it("returns text + model + stopReason from /chat/completions", async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${BASE}/chat/completions`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          model: "m1",
          choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
        });
      }),
    );
    const out = await new LlmClient(cfg()).complete([{ role: "user", content: "ping" }], {
      maxTokens: 100,
      temperature: 0.2,
      stopSequences: ["END"],
    });
    expect(out).toEqual({ text: "hi there", model: "m1", stopReason: "stop" });
    expect(receivedBody).toMatchObject({
      model: "m1",
      stream: false,
      max_tokens: 100,
      temperature: 0.2,
      stop: ["END"],
    });
  });

  it("system override is prepended when no system message was given", async () => {
    let bodyAny: unknown = null;
    server.use(
      http.post(`${BASE}/chat/completions`, async ({ request }) => {
        bodyAny = await request.json();
        return HttpResponse.json({ choices: [{ message: { content: "ok" } }] });
      }),
    );
    await new LlmClient(cfg()).complete([{ role: "user", content: "hi" }], { system: "sys-msg" });
    const body = bodyAny as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]).toEqual({ role: "system", content: "sys-msg" });
    expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("multimodal parts become OpenAI image_url payload", async () => {
    let bodyAny: unknown = null;
    server.use(
      http.post(`${BASE}/chat/completions`, async ({ request }) => {
        bodyAny = await request.json();
        return HttpResponse.json({ choices: [{ message: { content: "" } }] });
      }),
    );
    await new LlmClient(cfg()).complete([
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      },
    ]);
    const body = bodyAny as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const parts = body.messages[0]?.content ?? [];
    expect(parts[0]?.type).toBe("text");
    expect(parts[1]?.type).toBe("image_url");
    expect(parts[1]?.image_url?.url).toBe("data:image/png;base64,AAAA");
  });

  it("HTTP error path surfaces status + truncated body", async () => {
    server.use(
      http.post(`${BASE}/chat/completions`, () =>
        HttpResponse.json({ error: "bad" }, { status: 503 }),
      ),
    );
    await expect(new LlmClient(cfg()).complete([{ role: "user", content: "hi" }])).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it("times out via timeoutMs", async () => {
    vi.useFakeTimers();
    server.use(
      http.post(
        `${BASE}/chat/completions`,
        async () =>
          new Promise<Response>(() => {
            /* never resolves */
          }),
      ),
    );
    const p = new LlmClient(cfg()).complete([{ role: "user", content: "hi" }], { timeoutMs: 50 });
    vi.advanceTimersByTime(60);
    await expect(p).rejects.toBeTruthy();
    vi.useRealTimers();
  });
});
