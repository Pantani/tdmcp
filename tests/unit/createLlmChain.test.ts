import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  buildLlmChainScript,
  createLlmChainImpl,
  createLlmChainSchema,
} from "../../src/tools/layer2/createLlmChain.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Fixtures (needed for tox_drop tests — precheck validates abs path on disk)
// ---------------------------------------------------------------------------

const TMP_DIR = mkdtempSync(join(tmpdir(), "tdmcp-llm-test-"));
const FIXTURE_TOX = join(TMP_DIR, "LLM.tox");
writeFileSync(FIXTURE_TOX, "stub");
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: { executePythonScript: exec },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function decodePayload(script: string): Record<string, unknown> {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const s = exec.mock.calls[0]?.[0];
  if (typeof s !== "string") throw new Error("executePythonScript not called with a string");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function happyReport(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    container_path: "/project1/llm_chain",
    prompt_dat_path: "/project1/llm_chain/prompt",
    response_dat_path: "/project1/llm_chain/response",
    status_chan: "/project1/llm_chain/status_out:busy",
    mode: "webclient",
    provider: "ollama",
    model: "llama3.2",
    endpoint_url: "http://127.0.0.1:11434/v1/chat/completions",
    env_var_name: "OLLAMA_HOST",
    warnings: [],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Case 1: webclient + openai — correct auth payload fields
// ---------------------------------------------------------------------------

describe("createLlmChainImpl — webclient + openai", () => {
  it("sets env_var_name=OPENAI_API_KEY, Authorization header prefix in payload", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        provider: "openai",
        model: "gpt-4o-mini",
        endpoint_url: "https://api.openai.com/v1/chat/completions",
        env_var_name: "OPENAI_API_KEY",
      }),
    }));
    const result = await createLlmChainImpl(fakeCtx(exec), {
      mode: "webclient",
      parent_path: "/project1",
      provider: "openai",
      system_prompt: "You are a concise creative assistant for a TouchDesigner live show.",
      max_tokens: 512,
      temperature: 0.7,
      json_mode: false,
      auto_request: false,
      expose_controls: true,
    });

    expect(result.isError).toBeFalsy();

    const payload = decodePayload(scriptArg(exec));
    expect(payload.env_var_name).toBe("OPENAI_API_KEY");
    expect(payload.auth_header_name).toBe("Authorization");
    expect(payload.auth_header_prefix).toBe("Bearer ");
    expect(payload.endpoint_url).toBe("https://api.openai.com/v1/chat/completions");
    expect(payload.provider).toBe("openai");

    const text = textOf(result);
    expect(text).toContain("openai");
    expect(text).toContain("gpt-4o-mini");
  });
});

// ---------------------------------------------------------------------------
// Case 2: webclient + anthropic — x-api-key + anthropic-version in payload
// ---------------------------------------------------------------------------

describe("createLlmChainImpl — webclient + anthropic", () => {
  it("sets x-api-key header, anthropic-version, and ANTHROPIC_API_KEY env var", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        endpoint_url: "https://api.anthropic.com/v1/messages",
        env_var_name: "ANTHROPIC_API_KEY",
      }),
    }));

    await createLlmChainImpl(fakeCtx(exec), {
      mode: "webclient",
      parent_path: "/project1",
      provider: "anthropic",
      system_prompt: "You are a concise creative assistant for a TouchDesigner live show.",
      max_tokens: 512,
      temperature: 0.7,
      json_mode: false,
      auto_request: false,
      expose_controls: true,
    });

    const payload = decodePayload(scriptArg(exec));
    expect(payload.auth_header_name).toBe("x-api-key");
    expect(payload.auth_header_prefix).toBe("");
    expect(payload.env_var_name).toBe("ANTHROPIC_API_KEY");
    expect(payload.anthropic_version_header).toBe("2023-06-01");
    expect(payload.endpoint_url).toBe("https://api.anthropic.com/v1/messages");
  });
});

// ---------------------------------------------------------------------------
// Case 3: webclient + ollama (no key, missing_env NOT set even if env unset)
// ---------------------------------------------------------------------------

describe("createLlmChainImpl — webclient + ollama (no key)", () => {
  it("auth_header_name is null; missing_env not set even when OLLAMA_HOST env is absent", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        provider: "ollama",
        model: "llama3.2",
        endpoint_url: "http://127.0.0.1:11434/v1/chat/completions",
        env_var_name: "OLLAMA_HOST",
        // missing_env NOT present
      }),
    }));

    const result = await createLlmChainImpl(fakeCtx(exec), {
      mode: "webclient",
      parent_path: "/project1",
      provider: "ollama",
      system_prompt: "You are a concise creative assistant for a TouchDesigner live show.",
      max_tokens: 512,
      temperature: 0.7,
      json_mode: false,
      auto_request: false,
      expose_controls: true,
    });

    expect(result.isError).toBeFalsy();

    const payload = decodePayload(scriptArg(exec));
    expect(payload.auth_header_name).toBeNull();
    expect(payload.provider).toBe("ollama");

    // missing_env should NOT appear in result when not returned by bridge
    const text = textOf(result);
    expect(text).not.toContain("missing_env");
    expect(text).toContain("ollama");
  });
});

// ---------------------------------------------------------------------------
// Case 4: webclient + custom — schema rejects missing endpoint_url
// ---------------------------------------------------------------------------

describe("createLlmChainSchema — custom provider validation", () => {
  it("rejects provider=custom without endpoint_url", () => {
    const result = createLlmChainSchema.safeParse({
      provider: "custom",
      model: "my-model",
    });
    expect(result.success).toBe(false);
  });

  it("accepts provider=custom with both endpoint_url and model", () => {
    const result = createLlmChainSchema.safeParse({
      provider: "custom",
      endpoint_url: "http://localhost:8080/v1/chat/completions",
      model: "my-model",
    });
    expect(result.success).toBe(true);
  });

  it("custom provider happy path passes endpoint_url through payload", async () => {
    const customEndpoint = "http://localhost:8080/v1/chat/completions";
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        provider: "custom",
        model: "my-model",
        endpoint_url: customEndpoint,
        env_var_name: null,
      }),
    }));

    await createLlmChainImpl(fakeCtx(exec), {
      mode: "webclient",
      parent_path: "/project1",
      provider: "custom",
      endpoint_url: customEndpoint,
      model: "my-model",
      system_prompt: "You are a concise creative assistant for a TouchDesigner live show.",
      max_tokens: 512,
      temperature: 0.7,
      json_mode: false,
      auto_request: false,
      expose_controls: true,
    });

    const payload = decodePayload(scriptArg(exec));
    expect(payload.endpoint_url).toBe(customEndpoint);
    expect(payload.model).toBe("my-model");
  });
});

// ---------------------------------------------------------------------------
// Case 5: tox_drop — success; missing TOX par yields warning, not error
// ---------------------------------------------------------------------------

describe("createLlmChainImpl — tox_drop", () => {
  it("returns mode=tox_drop and container_path; missing Prompt par yields warning not error", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        mode: "tox_drop",
        provider: "ollama",
        container_path: "/project1/llm_chain",
        prompt_dat_path: "/project1/llm_chain/prompt",
        response_dat_path: "/project1/llm_chain/response",
        status_chan: "/project1/llm_chain/status_out:busy",
        warnings: ["TOX par 'Prompt' not found (on_missing=warn)."],
      }),
    }));

    const result = await createLlmChainImpl(fakeCtx(exec), {
      mode: "tox_drop",
      parent_path: "/project1",
      provider: "ollama",
      tox_path: FIXTURE_TOX,
      system_prompt: "You are a concise creative assistant for a TouchDesigner live show.",
      max_tokens: 512,
      temperature: 0.7,
      json_mode: false,
      auto_request: false,
      expose_controls: true,
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("tox_drop");
    expect(text).toContain("/project1/llm_chain");
    expect(text).toContain("warning");
  });
});

// ---------------------------------------------------------------------------
// Case 6: missing API key — friendly result with missing_env + warning
// ---------------------------------------------------------------------------

describe("createLlmChainImpl — missing API key friendly result", () => {
  it("returns ok=true with missing_env field and export guidance in warnings", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        provider: "openai",
        model: "gpt-4o-mini",
        endpoint_url: "https://api.openai.com/v1/chat/completions",
        env_var_name: "OPENAI_API_KEY",
        missing_env: "OPENAI_API_KEY",
        warnings: [],
      }),
    }));

    const result = await createLlmChainImpl(fakeCtx(exec), {
      mode: "webclient",
      parent_path: "/project1",
      provider: "openai",
      system_prompt: "You are a concise creative assistant for a TouchDesigner live show.",
      max_tokens: 512,
      temperature: 0.7,
      json_mode: false,
      auto_request: false,
      expose_controls: true,
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // Result carries guidance
    expect(text).toContain("OPENAI_API_KEY");
    expect(text).toContain("warning");
  });
});

// ---------------------------------------------------------------------------
// TD offline
// ---------------------------------------------------------------------------

describe("createLlmChainImpl — TD offline", () => {
  it("returns isError:true without throwing when bridge is unreachable", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createLlmChainImpl(fakeCtx(exec), {
      mode: "webclient",
      parent_path: "/project1",
      provider: "ollama",
      system_prompt: "You are a concise creative assistant for a TouchDesigner live show.",
      max_tokens: 512,
      temperature: 0.7,
      json_mode: false,
      auto_request: false,
      expose_controls: true,
    });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------

describe("createLlmChainSchema defaults", () => {
  it("applies documented defaults", () => {
    const parsed = createLlmChainSchema.parse({});
    expect(parsed.mode).toBe("webclient");
    expect(parsed.provider).toBe("ollama");
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.system_prompt).toBe(
      "You are a concise creative assistant for a TouchDesigner live show.",
    );
    expect(parsed.max_tokens).toBe(512);
    expect(parsed.temperature).toBe(0.7);
    expect(parsed.json_mode).toBe(false);
    expect(parsed.auto_request).toBe(false);
    expect(parsed.expose_controls).toBe(true);
  });

  it("rejects temperature > 2", () => {
    expect(() => createLlmChainSchema.parse({ temperature: 3 })).toThrow();
  });

  it("rejects max_tokens > 8192", () => {
    expect(() => createLlmChainSchema.parse({ max_tokens: 9000 })).toThrow();
  });

  it("rejects invalid provider", () => {
    expect(() => createLlmChainSchema.parse({ provider: "groq" })).toThrow();
  });

  it("rejects mode=tox_drop without tox_path", () => {
    const result = createLlmChainSchema.safeParse({ mode: "tox_drop" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildLlmChainScript — pure, no TD
// ---------------------------------------------------------------------------

describe("buildLlmChainScript (pure)", () => {
  it("embeds payload as base64 and contains import json, base64", () => {
    const script = buildLlmChainScript({ mode: "webclient", provider: "ollama", test: true });
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
    const payload = decodePayload(script);
    expect(payload.provider).toBe("ollama");
    expect(payload.test).toBe(true);
  });
});
