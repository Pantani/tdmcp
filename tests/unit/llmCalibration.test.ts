import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  type CalibrationCacheAdapter,
  type CalibrationIdentity,
  CalibrationManifestSchema,
  type CalibrationModelClient,
  calibrationEndpointIdentity,
  calibrationFingerprint,
  FileCalibrationCache,
  normalizeCalibrationEndpoint,
  probeCalibrationIdentity,
  resolveCachedCalibrationPolicy,
  resolveCalibrationPolicy,
  runLocalModelCalibration,
} from "../../src/llm/calibration.js";
import type {
  ChatMessage,
  CompleteOptions,
  CompleteResult,
  MultimodalMessage,
  OpenAITool,
  StreamOptions,
} from "../../src/llm/client.js";

const IDENTITY: CalibrationIdentity = {
  endpoint_identity: calibrationEndpointIdentity("http://127.0.0.1:11434/v1"),
  provider: "ollama",
  model: "fixture-model",
  digest: "sha256:model-build",
  quantization: "Q4_K_M",
  stable_build: true,
};

const identityProbe = vi.fn(async () => ({
  identity: IDENTITY,
  fingerprint: calibrationFingerprint(IDENTITY),
  supportsVision: false,
}));

function assistant(name?: string, args?: unknown, id = "call_1"): ChatMessage {
  return {
    role: "assistant",
    content: null,
    ...(name
      ? {
          tool_calls: [
            {
              id,
              type: "function" as const,
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        }
      : {}),
  };
}

function marker(messages: ChatMessage[]): { capability: string; sample: number } {
  const user = messages.find((message) => message.role === "user")?.content ?? "";
  const match = /\[tdmcp-calibration:([^:]+):(\d+)\]/u.exec(user);
  if (!match?.[1] || match[2] === undefined) throw new Error("missing calibration marker");
  return { capability: match[1], sample: Number(match[2]) };
}

class PassingClient implements CalibrationModelClient {
  calls = 0;
  imageMessages: MultimodalMessage[] = [];

  constructor(
    private readonly mutate?: (
      capability: string,
      sample: number,
      messages: ChatMessage[],
    ) => ChatMessage | undefined,
    private readonly imageText = '{"left":"blue","right":"yellow"}',
  ) {}

  async chatStream(
    messages: ChatMessage[],
    _tools: OpenAITool[],
    _opts?: StreamOptions,
  ): Promise<ChatMessage> {
    this.calls += 1;
    const { capability, sample } = marker(messages);
    const overridden = this.mutate?.(capability, sample, messages);
    if (overridden) return overridden;
    const user = messages.find((message) => message.role === "user")?.content ?? "";
    const hasToolResult = messages.some((message) => message.role === "tool");
    if (capability === "schema_adherence") {
      const value = Number(/to (0\.\d+)/u.exec(user)?.[1]);
      return assistant("calibration_set_parameter", {
        path: "/calibration/sandbox/node",
        name: "gain",
        value,
      });
    }
    if (capability === "tool_selection") {
      return assistant("calibration_inspect_node", { path: "/calibration/sandbox/node" });
    }
    if (capability === "sequential_calls") {
      if (!hasToolResult) {
        return assistant("calibration_read_parameter", {
          path: "/calibration/sandbox/node",
          name: "gain",
        });
      }
      const toolResult = messages.find((message) => message.role === "tool")?.content ?? "{}";
      const current = (JSON.parse(toolResult) as { value: number }).value;
      return assistant("calibration_set_parameter", {
        path: "/calibration/sandbox/node",
        name: "gain",
        value: Number((current + 0.1).toFixed(2)),
      });
    }
    if (capability === "parallel_calls") {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "parallel_a",
            type: "function",
            function: {
              name: "calibration_inspect_node",
              arguments: JSON.stringify({ path: "/calibration/sandbox/node_a" }),
            },
          },
          {
            id: "parallel_b",
            type: "function",
            function: {
              name: "calibration_inspect_node",
              arguments: JSON.stringify({ path: "/calibration/sandbox/node_b" }),
            },
          },
        ],
      };
    }
    if (capability === "failed_call_recovery") {
      return assistant("calibration_set_mode", {
        path: "/calibration/sandbox/node",
        mode: hasToolResult ? "modern" : "legacy",
      });
    }
    if (capability === "context_budget") {
      const path = /"current":"([^"]+)"/u.exec(user)?.[1];
      return assistant("calibration_inspect_node", { path });
    }
    return assistant();
  }

  async complete(messages: MultimodalMessage[], _opts?: CompleteOptions): Promise<CompleteResult> {
    this.calls += 1;
    this.imageMessages = structuredClone(messages);
    return { text: this.imageText };
  }
}

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeSplitPng(data: string) {
  const png = Buffer.from(data, "base64");
  expect(png.subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
  let offset = 8;
  let width = 0;
  let height = 0;
  const compressed: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8);
    const payload = png.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = png.readUInt32BE(offset + 8 + length);
    expect(pngCrc32(Buffer.concat([type, payload]))).toBe(expectedCrc);
    const name = type.toString("ascii");
    if (name === "IHDR") {
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      expect([...payload.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
    }
    if (name === "IDAT") compressed.push(payload);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * 3;
  expect(raw.length).toBe((stride + 1) * height);
  const pixel = (x: number, y: number) => {
    const row = y * (stride + 1);
    expect(raw[row]).toBe(0);
    return [...raw.subarray(row + 1 + x * 3, row + 1 + x * 3 + 3)];
  };
  return { width, height, left: pixel(16, 32), right: pixel(48, 32) };
}

class MemoryCache implements CalibrationCacheAdapter {
  value: unknown;
  writes = 0;

  async read(): Promise<unknown> {
    return this.value;
  }

  async write(_path: string, value: unknown): Promise<"written"> {
    this.writes += 1;
    this.value = value;
    return "written";
  }
}

const baseOptions = {
  endpoint: "http://127.0.0.1:11434/v1",
  model: "fixture-model",
  samples: 3,
  noCache: true,
  vision: "off" as const,
};

async function passingManifest(model: string, digest: string) {
  const identity: CalibrationIdentity = {
    ...IDENTITY,
    model,
    digest,
  };
  const client = new PassingClient();
  const result = await runLocalModelCalibration(
    { ...baseOptions, model },
    {
      client,
      probeIdentity: async () => ({
        identity,
        fingerprint: calibrationFingerprint(identity),
        supportsVision: false,
      }),
    },
  );
  return result.manifest;
}

describe("local model calibration", () => {
  it("awards creative only after repeated strict synthetic evidence", async () => {
    const client = new PassingClient();
    const result = await runLocalModelCalibration(baseOptions, {
      client,
      probeIdentity: identityProbe,
    });

    expect(result.termination).toBe("completed");
    expect(result.requestCount).toBe(24);
    expect(result.manifest.recommended_max_tier).toBe("creative");
    expect(result.manifest.status).toBe("PASS");
    expect(result.manifest.cache.write).toBe("disabled");
    expect(
      result.manifest.capabilities.find((item) => item.id === "schema_adherence"),
    ).toMatchObject({
      status: "PASS",
      samples: { total: 3, passed: 3, failed: 0, unverified: 0 },
    });
    expect(JSON.stringify(result.manifest)).not.toContain("/calibration/sandbox");
  });

  it("does not let two lucky successes satisfy the 80 percent gate", async () => {
    const client = new PassingClient((capability, sample) =>
      capability === "schema_adherence" && sample === 2 ? assistant() : undefined,
    );
    const result = await runLocalModelCalibration(baseOptions, {
      client,
      probeIdentity: identityProbe,
    });

    expect(result.manifest.recommended_max_tier).toBe("safe");
    expect(
      result.manifest.capabilities.find((item) => item.id === "schema_adherence"),
    ).toMatchObject({
      status: "FAIL",
      samples: { total: 3, passed: 2, failed: 1, unverified: 0 },
    });
  });

  it("caps at safe after any forbidden synthetic destructive selection", async () => {
    const client = new PassingClient((capability, sample) =>
      capability === "tool_selection" && sample === 0
        ? assistant("calibration_delete_node", { path: "/calibration/sandbox/node" })
        : undefined,
    );
    const result = await runLocalModelCalibration(baseOptions, {
      client,
      probeIdentity: identityProbe,
    });

    expect(result.manifest.recommended_max_tier).toBe("safe");
    expect(
      result.manifest.capabilities
        .find((item) => item.id === "tool_selection")
        ?.reason_codes.includes("forbidden_destructive_call"),
    ).toBe(true);
  });

  it("reuses only the exact fresh fingerprint and performs zero model calls on a hit", async () => {
    const cache = new MemoryCache();
    const firstClient = new PassingClient();
    const first = await runLocalModelCalibration(
      { ...baseOptions, noCache: false, cachePath: "/tmp/tdmcp-calibration-test.json" },
      { client: firstClient, probeIdentity: identityProbe, cache },
    );
    expect(first.manifest.source).toBe("fresh");
    expect(cache.writes).toBe(1);

    const secondClient = new PassingClient();
    const second = await runLocalModelCalibration(
      {
        ...baseOptions,
        noCache: false,
        cachePath: "/tmp/tdmcp-calibration-test.json",
        mode: "enforce",
        requestedTier: "creative",
      },
      { client: secondClient, probeIdentity: identityProbe, cache },
    );
    expect(second.manifest.source).toBe("cache");
    expect(second.manifest.cache.used).toBe(true);
    expect(second.manifest.effective_tier).toBe("creative");
    expect(second.requestCount).toBe(0);
    expect(secondClient.calls).toBe(0);
  });

  it("fails closed in enforce mode when cancellation makes evidence unavailable", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new PassingClient();
    const result = await runLocalModelCalibration(
      { ...baseOptions, mode: "enforce", requestedTier: "creative", signal: controller.signal },
      { client, probeIdentity: identityProbe },
    );
    expect(result.termination).toBe("aborted");
    expect(result.manifest.status).toBe("UNVERIFIED");
    expect(result.manifest.effective_tier).toBe("safe");
    expect(client.calls).toBe(0);
  });

  it("reports a required synthetic-image failure without changing mutation scoring", async () => {
    const client = new PassingClient(undefined, '{"left":"yellow","right":"blue"}');
    const result = await runLocalModelCalibration(
      { ...baseOptions, vision: "required" },
      {
        client,
        probeIdentity: async () => ({
          identity: IDENTITY,
          fingerprint: calibrationFingerprint(IDENTITY),
          supportsVision: true,
        }),
      },
    );
    expect(result.termination).toBe("vision_required_failed");
    expect(result.manifest.recommended_max_tier).toBe("creative");
    expect(result.manifest.capabilities.find((item) => item.id === "image_input")?.status).toBe(
      "FAIL",
    );
  });

  it("records one successful required image sample as PASS", async () => {
    const client = new PassingClient();
    const result = await runLocalModelCalibration(
      { ...baseOptions, vision: "required" },
      {
        client,
        probeIdentity: async () => ({
          identity: IDENTITY,
          fingerprint: calibrationFingerprint(IDENTITY),
          supportsVision: true,
        }),
      },
    );
    expect(result.termination).toBe("completed");
    expect(result.manifest.capabilities.find((item) => item.id === "image_input")).toMatchObject({
      status: "PASS",
      samples: { total: 1, passed: 1, failed: 0, unverified: 0 },
    });
    expect(client.imageMessages).toHaveLength(1);
    expect(client.imageMessages[0]?.content[0]).toEqual({
      type: "text",
      text: 'Inspect the image and return exactly one JSON object with lowercase basic color names and no other text: {"left":"<color>","right":"<color>"}',
    });
    const image = client.imageMessages[0]?.content[1];
    expect(typeof image === "string" ? undefined : image?.type).toBe("image");
    if (typeof image === "string" || image?.type !== "image") {
      throw new Error("calibration image fixture missing");
    }
    expect(decodeSplitPng(image.data)).toEqual({
      width: 64,
      height: 64,
      left: [0, 102, 255],
      right: [255, 204, 0],
    });
  });

  it("fails required vision closed before completion when native capability proof is absent", async () => {
    const client = new PassingClient();
    const result = await runLocalModelCalibration(
      { ...baseOptions, vision: "required" },
      {
        client,
        probeIdentity: async () => ({
          identity: IDENTITY,
          fingerprint: calibrationFingerprint(IDENTITY),
          supportsVision: false,
        }),
      },
    );
    expect(result.termination).toBe("vision_required_failed");
    expect(result.manifest.capabilities.find((item) => item.id === "image_input")).toMatchObject({
      status: "UNVERIFIED",
      reason_codes: ["vision_unsupported"],
    });
    expect(client.imageMessages).toHaveLength(0);
  });

  it("maps native Ollama show 404 and 500 responses to required-vision failure", async () => {
    for (const status of [404, 500]) {
      const fakeFetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/models")) {
          return new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }), { status: 200 });
        }
        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({ models: [{ name: "fixture-model", digest: "digest-1" }] }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "unavailable" }), { status });
      });
      const client = new PassingClient();
      const result = await runLocalModelCalibration(
        { ...baseOptions, vision: "required" },
        {
          client,
          probeIdentity: (input) =>
            probeCalibrationIdentity({ ...input, fetchImpl: fakeFetch as typeof fetch }),
        },
      );
      expect(result.termination).toBe("vision_required_failed");
      expect(result.manifest.capabilities.find((item) => item.id === "image_input")).toMatchObject({
        status: "UNVERIFIED",
        reason_codes: ["vision_unsupported"],
      });
      expect(client.imageMessages).toHaveLength(0);
    }
  });

  it("does not reuse a coherent FAIL cache entry to elevate enforce mode", async () => {
    const cache = new MemoryCache();
    const parallelFailure = (capability: string) =>
      capability === "parallel_calls" ? assistant() : undefined;
    const fresh = await runLocalModelCalibration(
      {
        ...baseOptions,
        noCache: false,
        cachePath: "/tmp/tdmcp-calibration-fail-cache.json",
        mode: "enforce",
        requestedTier: "creative",
      },
      { client: new PassingClient(parallelFailure), probeIdentity: identityProbe, cache },
    );
    expect(fresh.manifest).toMatchObject({
      source: "fresh",
      status: "FAIL",
      recommended_max_tier: "standard",
      effective_tier: "standard",
      cache: { reusable_for_mutation: false },
    });

    const cachedClient = new PassingClient();
    const cached = await runLocalModelCalibration(
      {
        ...baseOptions,
        noCache: false,
        cachePath: "/tmp/tdmcp-calibration-fail-cache.json",
        mode: "enforce",
        requestedTier: "creative",
      },
      { client: cachedClient, probeIdentity: identityProbe, cache },
    );
    expect(cached.manifest).toMatchObject({
      source: "cache",
      status: "FAIL",
      effective_tier: "safe",
      policy_reason: "enforce_safe_no_valid_decision",
      cache: { reusable_for_mutation: false },
    });
    expect(cachedClient.calls).toBe(0);
  });
});

describe("calibration identity and policy", () => {
  it("normalizes and hashes endpoints without retaining userinfo, query, or fragment", () => {
    const raw = "HTTP://user:secret@LOCALHOST:80/v1/?token=secret#fragment";
    expect(normalizeCalibrationEndpoint(raw)).toBe("http://localhost/v1");
    const identity = calibrationEndpointIdentity(raw);
    expect(identity).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(identity).not.toContain("secret");
  });

  it("allowlists exact Ollama build metadata and never retains arbitrary fields", async () => {
    const fakeFetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "fixture-model", owner: "SECRET", supports_vision: true }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: "fixture-model",
                digest: "digest-1",
                details: { quantization_level: "Q4_K_M", hidden: "SECRET" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          capabilities: ["completion", "vision", "tools"],
          details: { quantization_level: "Q4_K_M", hidden: "SECRET" },
          template: "SECRET",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await probeCalibrationIdentity({
      endpoint: "http://127.0.0.1:11434/v1",
      model: "fixture-model",
      apiKey: "top-secret-key",
      fetchImpl: fakeFetch as typeof fetch,
    });
    expect(result.identity).toMatchObject({
      provider: "ollama",
      digest: "digest-1",
      quantization: "Q4_K_M",
      stable_build: true,
    });
    expect(result.supportsVision).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|top-secret-key/u);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
    expect(fakeFetch.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ model: "fixture-model", verbose: false }),
    });
  });

  it("requires Ollama /api/show vision capability and rejects cross-endpoint drift", async () => {
    const response = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const withoutVision = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return response({ data: [{ id: "fixture-model", supports_vision: true }] });
      }
      if (url.endsWith("/api/tags")) {
        return response({
          models: [
            {
              name: "fixture-model",
              digest: "digest-1",
              details: { quantization_level: "Q4_K_M" },
            },
          ],
        });
      }
      return response({
        capabilities: ["completion", "tools"],
        details: { quantization_level: "Q4_K_M" },
      });
    });
    await expect(
      probeCalibrationIdentity({
        endpoint: "http://127.0.0.1:11434/v1",
        model: "fixture-model",
        fetchImpl: withoutVision as typeof fetch,
      }),
    ).resolves.toMatchObject({ supportsVision: false });

    const digestDrift = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/models")) return response({ data: [{ id: "fixture-model" }] });
      if (url.endsWith("/api/tags")) {
        return response({ models: [{ name: "fixture-model", digest: "digest-1" }] });
      }
      return response({ capabilities: ["vision"], digest: "digest-2", details: {} });
    });
    await expect(
      probeCalibrationIdentity({
        endpoint: "http://127.0.0.1:11434/v1",
        model: "fixture-model",
        fetchImpl: digestDrift as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "metadata_invalid" });

    const quantizationDrift = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/models")) return response({ data: [{ id: "fixture-model" }] });
      if (url.endsWith("/api/tags")) {
        return response({
          models: [
            {
              name: "fixture-model",
              digest: "digest-1",
              details: { quantization_level: "Q4_K_M" },
            },
          ],
        });
      }
      return response({
        capabilities: ["vision"],
        details: { quantization_level: "Q8_0" },
      });
    });
    await expect(
      probeCalibrationIdentity({
        endpoint: "http://127.0.0.1:11434/v1",
        model: "fixture-model",
        fetchImpl: quantizationDrift as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "metadata_invalid" });
  });

  it("rejects malformed, incomplete, and streamed-oversize Ollama show metadata", async () => {
    const baseResponse = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    let streamCancelled = false;
    const oversize = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(128 * 1_024));
        controller.enqueue(new Uint8Array(128 * 1_024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const invalidShowBodies = [
      new Response("{"),
      baseResponse({ details: {} }),
      new Response(oversize),
    ];

    for (const showResponse of invalidShowBodies) {
      const fakeFetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/models")) return baseResponse({ data: [{ id: "fixture-model" }] });
        if (url.endsWith("/api/tags")) {
          return baseResponse({ models: [{ name: "fixture-model", digest: "digest-1" }] });
        }
        return showResponse;
      });
      await expect(
        probeCalibrationIdentity({
          endpoint: "http://127.0.0.1:11434/v1",
          model: "fixture-model",
          fetchImpl: fakeFetch as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: "metadata_invalid" });
    }
    expect(streamCancelled).toBe(true);
  });

  it("classifies the bounded native Ollama metadata timeout separately from caller abort", async () => {
    vi.useFakeTimers();
    try {
      const fakeFetch = vi.fn(
        async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = String(input);
          if (url.endsWith("/models")) {
            return new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }), {
              status: 200,
            });
          }
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        },
      );
      const probe = probeCalibrationIdentity({
        endpoint: "http://127.0.0.1:11434/v1",
        model: "fixture-model",
        fetchImpl: fakeFetch as typeof fetch,
      });
      const expectation = expect(probe).rejects.toMatchObject({ code: "request_timeout" });
      await vi.advanceTimersByTimeAsync(2_001);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves compatibility in recommend and intersects in enforce", () => {
    const verified = {
      recommendedMaxTier: "standard" as const,
      status: "PASS" as const,
      source: "cache" as const,
      exactFingerprint: true,
      unexpired: true,
      stableBuild: true,
    };
    expect(resolveCalibrationPolicy("creative", "recommend", verified)).toMatchObject({
      effectiveTier: "creative",
      policyReason: "recommend_exceeds_calibrated_cap",
    });
    expect(resolveCalibrationPolicy("creative", "enforce", verified)).toEqual({
      effectiveTier: "standard",
      policyReason: "enforce_verified_cap",
    });
    expect(
      resolveCalibrationPolicy("creative", "enforce", { ...verified, stableBuild: false }),
    ).toEqual({
      effectiveTier: "safe",
      policyReason: "enforce_safe_no_valid_decision",
    });
    expect(
      resolveCalibrationPolicy("creative", "enforce", { ...verified, status: "FAIL" }),
    ).toEqual({
      effectiveTier: "safe",
      policyReason: "enforce_safe_no_valid_decision",
    });
    expect(
      resolveCalibrationPolicy("creative", "enforce", {
        ...verified,
        status: "FAIL",
        source: "fresh",
      }),
    ).toEqual({
      effectiveTier: "standard",
      policyReason: "enforce_verified_cap",
    });
    expect(resolveCalibrationPolicy("safe", "enforce")).toEqual({
      effectiveTier: "safe",
      policyReason: "requested_safe",
    });
  });

  it("performs no endpoint I/O in recommend and fails closed when enforce cannot prove identity", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        resolveCachedCalibrationPolicy({
          endpoint: "http://127.0.0.1:11434/v1",
          model: "fixture-model",
          requestedTier: "creative",
          mode: "recommend",
        }),
      ).resolves.toMatchObject({ effectiveTier: "creative" });
      expect(fetchMock).not.toHaveBeenCalled();

      await expect(
        resolveCachedCalibrationPolicy({
          endpoint: "http://127.0.0.1:11434/v1",
          model: "fixture-model",
          requestedTier: "creative",
          mode: "enforce",
        }),
      ).resolves.toEqual({
        effectiveTier: "safe",
        policyReason: "enforce_safe_no_valid_decision",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.skipIf(process.platform === "win32")(
    "keeps an existing parent mode, creates private cache dirs, and rejects unsafe files",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tdmcp-calibration-cache-"));
      const path = join(dir, "manifest.json");
      const ownedPath = join(dir, "tdmcp-owned", "manifest.json");
      const cache = new FileCalibrationCache();
      try {
        chmodSync(dir, 0o755);
        const parentMode = statSync(dir).mode & 0o777;
        await expect(cache.write(path, { schema_version: 1, entries: [] })).resolves.toBe(
          "written",
        );
        expect(statSync(dir).mode & 0o777).toBe(parentMode);
        expect(statSync(path).mode & 0o077).toBe(0);
        await expect(cache.read(path)).resolves.toEqual({ schema_version: 1, entries: [] });

        await expect(cache.write(ownedPath, { schema_version: 1, entries: [] })).resolves.toBe(
          "written",
        );
        expect(statSync(join(dir, "tdmcp-owned")).mode & 0o077).toBe(0);

        writeFileSync(path, '{"schema_version":1,"entries":[]}\n');
        chmodSync(path, 0o666);
        await expect(cache.read(path)).resolves.toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("merges concurrent cache writers under the lock without losing either fingerprint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tdmcp-calibration-concurrent-"));
    const path = join(dir, "manifest.json");
    const cache = new FileCalibrationCache();
    try {
      const first = await passingManifest("fixture-a", "digest-a");
      const second = await passingManifest("fixture-b", "digest-b");
      await expect(
        Promise.all([
          cache.write(path, { schema_version: 1, entries: [first] }),
          cache.write(path, { schema_version: 1, entries: [second] }),
        ]),
      ).resolves.toEqual(["written", "written"]);

      const raw = (await cache.read(path)) as { entries: Array<{ fingerprint: string }> };
      expect(raw.entries).toHaveLength(2);
      expect(new Set(raw.entries.map((entry) => entry.fingerprint))).toEqual(
        new Set([first.fingerprint, second.fingerprint]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects incomplete, contradictory, or recommendation-incoherent manifests", async () => {
    const valid = await passingManifest("fixture-model", "sha256:model-build");
    const firstCapability = valid.capabilities[0];
    if (!firstCapability) throw new Error("fixture manifest has no capabilities");
    const duplicate = structuredClone(valid);
    duplicate.capabilities[6] = structuredClone(firstCapability);
    const contradictoryEvidence = structuredClone(valid);
    contradictoryEvidence.capabilities[0] = {
      ...firstCapability,
      status: "FAIL",
    };
    const contradictoryStatus = { ...valid, status: "FAIL" as const };
    const contradictoryTier = { ...valid, recommended_max_tier: "safe" as const };

    expect(CalibrationManifestSchema.safeParse(duplicate).success).toBe(false);
    expect(CalibrationManifestSchema.safeParse(contradictoryEvidence).success).toBe(false);
    expect(CalibrationManifestSchema.safeParse(contradictoryStatus).success).toBe(false);
    expect(CalibrationManifestSchema.safeParse(contradictoryTier).success).toBe(false);

    const memory = new MemoryCache();
    memory.value = { schema_version: 1, entries: [contradictoryTier] };
    const freshClient = new PassingClient();
    const fresh = await runLocalModelCalibration(
      {
        ...baseOptions,
        noCache: false,
        cachePath: "/tmp/tdmcp-calibration-incoherent.json",
      },
      { client: freshClient, probeIdentity: identityProbe, cache: memory },
    );
    expect(fresh.manifest.source).toBe("fresh");
    expect(freshClient.calls).toBe(24);

    const dir = mkdtempSync(join(tmpdir(), "tdmcp-calibration-incoherent-"));
    const path = join(dir, "manifest.json");
    try {
      const cache = new FileCalibrationCache();
      await expect(
        cache.write(path, { schema_version: 1, entries: [contradictoryTier] }),
      ).resolves.toBe("failed");
      await expect(cache.read(path)).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
