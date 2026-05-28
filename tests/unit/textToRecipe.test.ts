import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerTextToRecipe } from "../../src/prompts/textToRecipe.js";

interface Captured {
  name: string;
  config: { title?: string; description?: string; argsSchema?: Record<string, unknown> };
  cb: (args: Record<string, string>) => {
    messages: Array<{ role: string; content: { type: string; text: string } }>;
  };
}

/** Minimal fake McpServer that captures the single registerPrompt call. */
function captureRegistration(): Captured {
  let captured: Captured | undefined;
  const fakeServer = {
    registerPrompt(name: string, config: Captured["config"], cb: Captured["cb"]) {
      captured = { name, config, cb };
      return {};
    },
  } as unknown as McpServer;

  registerTextToRecipe(fakeServer, {} as never);
  if (!captured) throw new Error("registerTextToRecipe did not register a prompt");
  return captured;
}

function textFor(args: Record<string, string>): string {
  const { cb } = captureRegistration();
  return cb(args).messages[0]?.content.text ?? "";
}

describe("registerTextToRecipe", () => {
  it("registers a prompt named text_to_recipe with a title, description, and a description arg", () => {
    const { name, config } = captureRegistration();
    expect(name).toBe("text_to_recipe");
    expect(config.title).toBeTruthy();
    expect(config.description).toBeTruthy();
    expect(config.argsSchema).toBeDefined();
    expect(Object.keys(config.argsSchema ?? {})).toContain("description");
  });

  it("echoes the user's description into the guidance text", () => {
    const text = textFor({ description: "a hypnotic feedback tunnel over noise" });
    expect(text).toContain("a hypnotic feedback tunnel over noise");
  });

  it("teaches every load-bearing RecipeSchema field", () => {
    const text = textFor({ description: "anything" });
    for (const field of ["nodes", "connections", "parameters", "controls"]) {
      expect(text).toContain(field);
    }
    // Top-level required fields are mentioned by name.
    expect(text).toContain("`id`");
    expect(text).toContain("`name`");
    expect(text).toContain("difficulty");
  });

  it("instructs the author → validate loop: real operators, schema validation, apply_recipe", () => {
    const text = textFor({ description: "anything" });
    expect(text).toContain("search_operators");
    expect(text).toContain("RecipeSchema");
    expect(text).toContain("apply_recipe");
    // Must warn against inventing operator types.
    expect(text.toLowerCase()).toContain("never invent operator types");
  });

  it("documents the node-name → path value resolution rule", () => {
    const text = textFor({ description: "anything" });
    expect(text).toContain("resolves to that node's real created path");
  });

  it("documents that controls' bind_to uses recipe node names", () => {
    const text = textFor({ description: "anything" });
    expect(text).toContain("bind_to");
    expect(text).toContain("nodeName.parName");
  });

  it("weaves optional name and difficulty hints into the text when provided", () => {
    const text = textFor({
      description: "a kaleidoscope",
      name: "warp_kaleido",
      difficulty: "advanced",
    });
    expect(text).toContain("warp_kaleido");
    expect(text).toContain("advanced");
  });
});
