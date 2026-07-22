import { describe, expect, it } from "vitest";
import { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { registerAllPrompts } from "../../src/prompts/index.js";
import {
  capturePromptRegistry,
  collectRegisteredPrompts,
  type PromptRegistryError,
} from "../../src/prompts/registry.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeStubServer } from "../helpers/promptHarness.js";

function promptCtx() {
  return {
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

const result = {
  messages: [{ role: "user" as const, content: { type: "text" as const, text: "ok" } }],
};

describe("canonical prompt registry", () => {
  it("captures the real registration order, descriptors, field schemas, and handlers", () => {
    const ctx = promptCtx();
    const { server, prompts } = makeStubServer();
    registerAllPrompts(server as never, ctx);

    const registry = collectRegisteredPrompts(ctx);
    expect(registry.entries.map((entry) => entry.descriptor.name)).toEqual(
      prompts.map((entry) => entry.name),
    );
    expect(registry.byName.size).toBe(registry.entries.length);

    const debug = registry.byName.get("debug_network");
    expect(debug?.descriptor).toMatchObject({
      name: "debug_network",
      title: "Debug network",
      args: ["root_path"],
    });
    expect(debug?.descriptor.summary).toContain("Systematically debug");
    expect(debug?.argsSchema.root_path).toBeDefined();
    expect(debug?.handler).toBeTypeOf("function");
  });

  it("creates a fresh registry for each context instead of retaining handlers globally", () => {
    const first = collectRegisteredPrompts(promptCtx());
    const second = collectRegisteredPrompts(promptCtx());

    expect(first).not.toBe(second);
    expect(first.byName).not.toBe(second.byName);
    expect(first.entries).not.toBe(second.entries);
  });

  it("preserves field insertion order and registered defaults in synthetic captures", () => {
    const defaulted = z.string().default("fallback");
    const registry = capturePromptRegistry((server) => {
      server.registerPrompt(
        "ordered_prompt",
        {
          title: "Ordered",
          description: "Synthetic prompt.",
          argsSchema: { first: z.string(), second: defaulted },
        },
        () => result,
      );
    });

    const entry = registry.entries[0];
    expect(entry?.descriptor.args).toEqual(["first", "second"]);
    expect(entry?.argsSchema.second).toBe(defaulted);
  });

  it("fails deterministically on a duplicate prompt name", () => {
    expect(() =>
      capturePromptRegistry((server) => {
        server.registerPrompt("duplicate", { argsSchema: {} }, () => result);
        server.registerPrompt("duplicate", { argsSchema: {} }, () => result);
      }),
    ).toThrowError(
      expect.objectContaining<Partial<PromptRegistryError>>({ code: "registry_duplicate" }),
    );
  });

  it.each([
    "",
    "Uppercase",
    "starts-with-dash",
    "1numeric",
  ])("rejects invalid registration name %j", (name) => {
    expect(() =>
      capturePromptRegistry((server) => {
        server.registerPrompt(name, { argsSchema: {} }, () => result);
      }),
    ).toThrowError(
      expect.objectContaining<Partial<PromptRegistryError>>({ code: "registry_invalid" }),
    );
  });
});
