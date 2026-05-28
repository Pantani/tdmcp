import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerStyleReference } from "../../src/prompts/styleReference.js";

interface CapturedPrompt {
  name: string;
  config: { title?: string; description?: string; argsSchema?: Record<string, unknown> };
  handler: (args: { reference: string; target?: string }) => {
    messages: { role: string; content: { type: string; text: string } }[];
  };
}

/** A tiny stand-in for McpServer that records the single registerPrompt call. */
function captureRegistration(): CapturedPrompt {
  const captured = {} as CapturedPrompt;
  const stub = {
    registerPrompt(name: string, config: CapturedPrompt["config"], handler: unknown) {
      captured.name = name;
      captured.config = config;
      captured.handler = handler as CapturedPrompt["handler"];
    },
  };
  registerStyleReference(stub as unknown as McpServer, {} as never);
  return captured;
}

function textOf(reference: string, target?: string): string {
  const { handler } = captureRegistration();
  return handler({ reference, target }).messages[0]?.content.text ?? "";
}

describe("registerStyleReference", () => {
  it("registers the style_reference prompt with title, description and arg schema", () => {
    const { name, config } = captureRegistration();
    expect(name).toBe("style_reference");
    expect(config.title).toBeTruthy();
    expect(config.description).toBeTruthy();
    expect(Object.keys(config.argsSchema ?? {})).toEqual(
      expect.arrayContaining(["reference", "target"]),
    );
  });

  it("produces a single user-message plan that interpolates the reference and target", () => {
    const { handler } = captureRegistration();
    const result = handler({
      reference: "Drum & bass warehouse rave — strobes, RGB glitch, dark",
      target: "/project1",
    });
    expect(result.messages).toHaveLength(1);
    const message = result.messages[0];
    expect(message?.role).toBe("user");
    expect(message?.content.type).toBe("text");
    expect(message?.content.text).toContain("Drum & bass warehouse rave");
    expect(message?.content.text).toContain("/project1");
  });

  it("maps the look onto concrete tdmcp tool calls and an analyze → build → verify flow", () => {
    const text = textOf("Drum & bass warehouse rave — strobes, RGB glitch, dark");
    for (const tool of [
      "create_generative_art",
      "create_palette",
      "create_glitch",
      "create_strobe",
      "create_color_grade",
      "get_preview",
    ]) {
      expect(text).toContain(tool);
    }
    // Captures a style/aesthetic (palette / motion / texture / energy), not one frame.
    expect(text).toMatch(/palette/i);
    expect(text).toMatch(/energy/i);
    // Distinct from image_to_visual: usable from a text description alone.
    expect(text).toMatch(/text description/i);
  });

  it("omits the target clause when no target is supplied", () => {
    const text = textOf("warm ambient drift, slow and grainy");
    expect(text).toContain("warm ambient drift");
    expect(text).not.toContain(" at undefined");
  });
});
