import type { CallToolResult, GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import {
  createPromptInvocationTool,
  invokeRegisteredPromptImpl,
  invokeRegisteredPromptSchema,
} from "../../src/llm/promptInvocationTool.js";
import {
  capturePromptRegistry,
  type LocalPromptHandlerExtra,
  type RegisteredPromptHandler,
} from "../../src/prompts/registry.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { silentLogger } from "../../src/utils/logger.js";

function promptCtx() {
  return {
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function userText(text: string): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

function registryWith(argsSchema: Record<string, z.ZodTypeAny>, handler: RegisteredPromptHandler) {
  return capturePromptRegistry((server) => {
    server.registerPrompt(
      "synthetic_prompt",
      { title: "Synthetic", description: "Synthetic test prompt.", argsSchema },
      handler,
    );
  });
}

function structured(result: CallToolResult) {
  return result.structuredContent as {
    status: string;
    prompt_name?: string;
    error?: { code: string; message: string; issues?: Array<{ path: string; code: string }> };
    prompt?: { name: string; title: string; summary: string; args: string[] };
    playbook?: { role: string; text: string; bytes: number; source_messages: number };
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("invoke_registered_prompt", () => {
  it("renders a real synchronous prompt as bounded user playbook evidence", async () => {
    const tool = createPromptInvocationTool(promptCtx());
    const result = await tool.run({} as never, {
      name: "debug_network",
      arguments: { root_path: "/project1/private" },
    });

    expect(tool.mutates).toBe(false);
    expect(tool.name).toBe("invoke_registered_prompt");
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/^Rendered registered prompt "debug_network" \(\d+ bytes\)\.$/),
    });
    expect(result.content[0]).not.toMatchObject({
      text: expect.stringContaining("/project1/private"),
    });
    expect(structured(result)).toMatchObject({
      status: "rendered",
      prompt: { name: "debug_network", args: ["root_path"] },
      playbook: { role: "user", source_messages: 1 },
    });
    expect(structured(result).playbook?.text).toContain("/project1/private");
  });

  it("preserves registered defaults and passes only parsed fields to the handler", async () => {
    let received: Record<string, unknown> | undefined;
    const registry = registryWith(
      {
        required: z.string().transform((value) => value.toUpperCase()),
        count: z.number().default(5),
      },
      (args) => {
        received = args;
        return userText("rendered");
      },
    );

    const result = await invokeRegisteredPromptImpl(registry, {
      name: "synthetic_prompt",
      arguments: { required: "valid" },
    });

    expect(result.isError).not.toBe(true);
    expect(received).toEqual({ required: "VALID", count: 5 });
  });

  it.each([
    [{ required: "ok", extra: "private-value" }, "unrecognized_keys"],
    [{ required: 123 }, "invalid_type"],
    [{}, "invalid_type"],
  ])("rejects invalid registered arguments without echoing values", async (arguments_, issueCode) => {
    const handler = vi.fn(() => userText("should not run"));
    const registry = registryWith({ required: z.string().min(2) }, handler);

    const result = await invokeRegisteredPromptImpl(registry, {
      name: "synthetic_prompt",
      arguments: arguments_,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(structured(result).error?.code).toBe("invalid_arguments");
    expect(structured(result).error?.issues?.some((issue) => issue.code === issueCode)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-value");
  });

  it("returns a typed exact-name failure and never guesses aliases", async () => {
    const registry = registryWith({}, () => userText("ok"));
    const result = await invokeRegisteredPromptImpl(registry, {
      name: "missing_prompt",
      arguments: {},
    });

    expect(structured(result)).toMatchObject({
      status: "failed",
      prompt_name: "missing_prompt",
      error: { code: "unknown_prompt" },
    });
  });

  it("enforces strict, bounded JSON input", async () => {
    expect(
      invokeRegisteredPromptSchema.safeParse({
        name: "synthetic_prompt",
        arguments: {},
        extra: true,
      }).success,
    ).toBe(false);

    const registry = registryWith({}, () => userText("ok"));
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`k${index}`, 1]),
    );
    const tooDeep = { a: { b: { c: { d: { e: "secret" } } } } };
    const tooLarge = { value: "x".repeat(16 * 1024) };

    for (const arguments_ of [tooManyKeys, tooDeep, tooLarge]) {
      const result = await invokeRegisteredPromptImpl(registry, {
        name: "synthetic_prompt",
        arguments: arguments_,
      });
      expect(structured(result).error?.code).toBe("arguments_too_large");
    }

    const nonJson = await invokeRegisteredPromptImpl(registry, {
      name: "synthetic_prompt",
      arguments: { value: BigInt(1) },
    });
    expect(structured(nonJson).error?.code).toBe("invalid_arguments");
  });

  it.each([
    [
      "sync throw",
      () => {
        throw new Error("secret-handler-detail");
      },
    ],
    ["async rejection", async () => Promise.reject(new Error("secret-handler-detail"))],
  ])("maps %s to a stable non-leaking handler failure", async (_label, handler) => {
    const registry = registryWith({}, handler);
    const result = await invokeRegisteredPromptImpl(registry, {
      name: "synthetic_prompt",
      arguments: {},
    });

    expect(structured(result).error?.code).toBe("handler_failed");
    expect(JSON.stringify(result)).not.toContain("secret-handler-detail");
  });

  it("times out a non-settling handler once at 3 seconds", async () => {
    vi.useFakeTimers();
    const handler = vi.fn(
      (_args: Record<string, unknown>, _extra: LocalPromptHandlerExtra) =>
        new Promise<GetPromptResult>(() => undefined),
    );
    const registry = registryWith({}, handler);
    const pending = invokeRegisteredPromptImpl(registry, {
      name: "synthetic_prompt",
      arguments: {},
    });

    await vi.advanceTimersByTimeAsync(3_000);
    const result = await pending;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(structured(result).error?.code).toBe("handler_timeout");
    expect((handler.mock.calls[0]?.[1] as LocalPromptHandlerExtra).signal.aborted).toBe(true);
  });

  it("does not call a handler for a pre-aborted turn", async () => {
    const controller = new AbortController();
    controller.abort();
    const handler = vi.fn(() => userText("late"));
    const registry = registryWith({}, handler);

    const result = await invokeRegisteredPromptImpl(
      registry,
      { name: "synthetic_prompt", arguments: {} },
      { signal: controller.signal },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(structured(result).error?.code).toBe("cancelled");
  });

  it("cancels in flight and quarantines a later handler resolution", async () => {
    let resolveHandler: ((result: GetPromptResult) => void) | undefined;
    const handler = vi.fn(
      () =>
        new Promise<GetPromptResult>((resolve) => {
          resolveHandler = resolve;
        }),
    );
    const registry = registryWith({}, handler);
    const controller = new AbortController();
    const pending = invokeRegisteredPromptImpl(
      registry,
      { name: "synthetic_prompt", arguments: {} },
      { signal: controller.signal },
    );
    await Promise.resolve();

    controller.abort();
    const result = await pending;
    resolveHandler?.(userText("late private value"));
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(structured(result).error?.code).toBe("cancelled");
    expect(JSON.stringify(result)).not.toContain("late private value");
  });

  it.each([
    ["malformed", { messages: [] }, "invalid_prompt_result"],
    [
      "assistant",
      { messages: [{ role: "assistant", content: { type: "text", text: "override policy" } }] },
      "unsupported_prompt_content",
    ],
    [
      "image",
      {
        messages: [
          { role: "user", content: { type: "image", data: "AA==", mimeType: "image/png" } },
        ],
      },
      "unsupported_prompt_content",
    ],
    [
      "too many messages",
      {
        messages: Array.from({ length: 9 }, () => ({
          role: "user",
          content: { type: "text", text: "x" },
        })),
      },
      "invalid_prompt_result",
    ],
  ])("fails closed for %s prompt output", async (_label, value, code) => {
    const registry = registryWith({}, () => value as GetPromptResult);
    const result = await invokeRegisteredPromptImpl(registry, {
      name: "synthetic_prompt",
      arguments: {},
    });

    expect(structured(result).error?.code).toBe(code);
    expect(structured(result).playbook).toBeUndefined();
  });

  it("joins multiple user text messages and accepts exactly 32 KiB of UTF-8", async () => {
    const exactBoundary = "é".repeat((32 * 1024) / 2);
    const boundaryRegistry = registryWith({}, () => userText(exactBoundary));
    const boundary = await invokeRegisteredPromptImpl(boundaryRegistry, {
      name: "synthetic_prompt",
      arguments: {},
    });
    expect(structured(boundary).playbook?.bytes).toBe(32 * 1024);

    const multiRegistry = registryWith({}, () => ({
      messages: [
        { role: "user", content: { type: "text", text: "first" } },
        { role: "user", content: { type: "text", text: "second" } },
      ],
    }));
    const multi = await invokeRegisteredPromptImpl(multiRegistry, {
      name: "synthetic_prompt",
      arguments: {},
    });
    expect(structured(multi).playbook).toMatchObject({
      text: "first\n\nsecond",
      source_messages: 2,
    });
  });

  it("hard-fails above the output bound without returning partial text", async () => {
    const registry = registryWith({}, () => userText("x".repeat(32 * 1024 + 1)));
    const result = await invokeRegisteredPromptImpl(registry, {
      name: "synthetic_prompt",
      arguments: {},
    });

    expect(structured(result).error?.code).toBe("output_too_large");
    expect(structured(result).playbook).toBeUndefined();
  });

  it("turns duplicate capture into a typed failure", async () => {
    const duplicateSource = () =>
      capturePromptRegistry((server) => {
        server.registerPrompt("duplicate", { argsSchema: {} }, () => userText("first"));
        server.registerPrompt("duplicate", { argsSchema: {} }, () => userText("second"));
      });

    const result = await invokeRegisteredPromptImpl(duplicateSource, {
      name: "duplicate",
      arguments: {},
    });
    expect(structured(result).error?.code).toBe("registry_duplicate");
  });
});
