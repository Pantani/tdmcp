import { describe, expect, it } from "vitest";
import { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { registerAllPrompts } from "../../src/prompts/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { silentLogger } from "../../src/utils/logger.js";
import type { PromptEntry } from "../helpers/promptHarness.js";
import {
  CRITERIA,
  evalPrompt,
  makeStubServer,
  synthesizeArgs,
  synthesizeValue,
} from "../helpers/promptHarness.js";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const ctx = {
  knowledge: new KnowledgeBase(),
  recipes: new RecipeLibrary(),
  logger: silentLogger,
};

function collectPrompts(): PromptEntry[] {
  const { server, prompts } = makeStubServer();
  // McpServer is duck-typed; the stub captures registerPrompt calls
  registerAllPrompts(server as never, ctx);
  return prompts;
}

const ALL_PROMPTS = collectPrompts();

// ---------------------------------------------------------------------------
// 1. Registration count — guards against accidental delete
// ---------------------------------------------------------------------------

describe("prompt registration", () => {
  it("registers at least 30 prompts", () => {
    expect(ALL_PROMPTS.length).toBeGreaterThanOrEqual(30);
  });

  it("all prompt names are unique", () => {
    const names = ALL_PROMPTS.map((p) => p.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("all prompt names match /^[a-z][a-z0-9_]*$/", () => {
    const bad = ALL_PROMPTS.filter((p) => !/^[a-z][a-z0-9_]*$/.test(p.name));
    expect(bad.map((p) => p.name)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Snapshot the alphabetized name list
// ---------------------------------------------------------------------------

it("prompt name list snapshot", () => {
  const sorted = ALL_PROMPTS.map((p) => p.name).sort();
  expect(sorted).toMatchSnapshot();
});

// ---------------------------------------------------------------------------
// 3. Per-prompt eval: structural + rendering + budget + description quality
// ---------------------------------------------------------------------------

describe.each(ALL_PROMPTS.map((p) => ({ prompt: p, name: p.name })))("prompt: $name", ({
  prompt,
}) => {
  it("passes all eval criteria", () => {
    const result = evalPrompt(prompt);
    expect(result.failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. synthesizeArgs unit tests
// ---------------------------------------------------------------------------

describe("synthesizeArgs", () => {
  const schema: Record<string, z.ZodTypeAny> = {
    label: z.string(),
    level: z.number(),
    enabled: z.boolean(),
    mode: z.enum(["fast", "slow", "medium"]),
    note: z.string().optional(),
  };

  it("string → '<name>_FIXTURE'", () => {
    expect(synthesizeValue(z.string(), "foo")).toBe("foo_FIXTURE");
  });

  it("number → 1", () => {
    expect(synthesizeValue(z.number(), "x")).toBe(1);
  });

  it("boolean → true", () => {
    expect(synthesizeValue(z.boolean(), "flag")).toBe(true);
  });

  it("enum → first value", () => {
    expect(synthesizeValue(z.enum(["a", "b", "c"]), "choice")).toBe("a");
  });

  it("optional string → unwraps to string fixture", () => {
    expect(synthesizeValue(z.string().optional(), "note")).toBe("note_FIXTURE");
  });

  it("synthesizeArgs produces a value for each key", () => {
    const args = synthesizeArgs(schema);
    expect(Object.keys(args).sort()).toEqual(["enabled", "label", "level", "mode", "note"]);
    expect(args.label).toBe("label_FIXTURE");
    expect(args.level).toBe(1);
    expect(args.enabled).toBe(true);
    expect(args.mode).toBe("fast");
    expect(args.note).toBe("note_FIXTURE");
  });
});

// ---------------------------------------------------------------------------
// 5. Negative test — broken prompt must be reported as FAIL
// ---------------------------------------------------------------------------

describe("evalPrompt negative cases", () => {
  it("reports FAIL for empty description", () => {
    const broken: PromptEntry = {
      name: "broken_empty_desc",
      meta: { title: "Broken", description: "", argsSchema: {} },
      handler: () => ({ messages: [{ role: "user", content: { type: "text", text: "hello" } }] }),
    };
    const result = evalPrompt(broken);
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.includes("description too short"))).toBe(true);
  });

  it("reports FAIL for {{unresolved}} mustache in body", () => {
    const broken: PromptEntry = {
      name: "broken_mustache",
      meta: {
        title: "Broken mustache",
        description:
          "A prompt that has a very long enough description to pass the length check clearly.",
        argsSchema: {},
      },
      handler: () => ({
        messages: [
          {
            role: "user",
            content: { type: "text", text: "Hello {{name}}, welcome to {{place}}." },
          },
        ],
      }),
    };
    const result = evalPrompt(broken);
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.includes("{{"))).toBe(true);
  });

  it("reports FAIL for description starting with TODO", () => {
    const broken: PromptEntry = {
      name: "broken_todo_desc",
      meta: {
        title: "Broken TODO",
        description:
          "TODO: fill in this description properly before shipping. At least 50 chars now.",
        argsSchema: {},
      },
      handler: () => ({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] }),
    };
    const result = evalPrompt(broken);
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.includes("TODO"))).toBe(true);
  });

  it("reports FAIL when handler interpolates undefined into text", () => {
    const broken: PromptEntry = {
      name: "broken_undefined",
      meta: {
        title: "Broken undefined",
        description:
          "A valid description that is long enough to pass the length check. More words here.",
        argsSchema: {},
      },
      handler: () => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `The path is ${undefined} and the node is undefined in content.`,
            },
          },
        ],
      }),
    };
    const result = evalPrompt(broken);
    expect(result.pass).toBe(false);
    expect(result.failures.some((f) => f.includes("undefined"))).toBe(true);
  });

  it("confirms CRITERIA constants are exported correctly", () => {
    expect(CRITERIA.maxTokens).toBe(2000);
    expect(CRITERIA.minDescLen).toBe(50);
    expect(CRITERIA.maxDescLen).toBe(280);
  });
});
