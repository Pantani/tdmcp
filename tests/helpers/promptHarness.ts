import type { z } from "zod";

export interface PromptEntry {
  name: string;
  meta: {
    title: string;
    description: string;
    argsSchema: Record<string, z.ZodTypeAny>;
  };
  handler: (args: Record<string, unknown>) => {
    messages: Array<{ role: string; content: { type: string; text: string } }>;
  };
}

export interface McpServerLike {
  registerPrompt(
    name: string,
    meta: { title: string; description: string; argsSchema: Record<string, z.ZodTypeAny> },
    handler: (args: Record<string, unknown>) => unknown,
  ): void;
  registerTool?: (...args: unknown[]) => void;
  registerResource?: (...args: unknown[]) => void;
}

export function makeStubServer(): { server: McpServerLike; prompts: PromptEntry[] } {
  const prompts: PromptEntry[] = [];
  const server: McpServerLike = {
    registerPrompt(name, meta, handler) {
      prompts.push({ name, meta, handler: handler as PromptEntry["handler"] });
    },
    registerTool() {},
    registerResource() {},
  };
  return { server, prompts };
}

export const CRITERIA = {
  maxTokens: 2000,
  minDescLen: 50,
  maxDescLen: 280,
} as const;

/** Synthesize a deterministic fixture value for a single Zod type. */
export function synthesizeValue(schema: z.ZodTypeAny, argName: string): unknown {
  // Zod v4 uses _def.type; Zod v3 uses _def.typeName — support both
  const def = schema._def as unknown as Record<string, unknown>;
  const typeName: string =
    (def.typeName as string | undefined) ?? (def.type as string | undefined) ?? "";

  // Unwrap optional / default
  if (typeName === "ZodOptional" || typeName === "optional") {
    const inner =
      (def.innerType as z.ZodTypeAny | undefined) ?? (def.type as z.ZodTypeAny | undefined);
    if (inner && typeof inner === "object" && "_def" in inner) {
      return synthesizeValue(inner as z.ZodTypeAny, argName);
    }
    return `${argName}_FIXTURE`;
  }
  if (typeName === "ZodDefault" || typeName === "default") {
    const inner = def.innerType as z.ZodTypeAny | undefined;
    if (inner) return synthesizeValue(inner, argName);
    return `${argName}_FIXTURE`;
  }

  if (typeName === "ZodString" || typeName === "string") return `${argName}_FIXTURE`;
  if (typeName === "ZodNumber" || typeName === "number") return 1;
  if (typeName === "ZodBoolean" || typeName === "boolean") return true;
  if (typeName === "ZodEnum" || typeName === "enum") {
    // Zod v3: .values, Zod v4: .entries (object keys)
    const values = def.values as unknown[] | undefined;
    if (values && values.length > 0) return values[0];
    const entries = def.entries as Record<string, unknown> | undefined;
    if (entries) {
      const keys = Object.keys(entries);
      if (keys.length > 0) return keys[0];
    }
    return "VALUE";
  }
  // Fallback for unknown types
  return `${argName}_FIXTURE`;
}

/** Build a full args fixture for an argsSchema. */
export function synthesizeArgs(argsSchema: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(argsSchema)) {
    out[key] = synthesizeValue(schema, key);
  }
  return out;
}

export interface EvalResult {
  name: string;
  pass: boolean;
  failures: string[];
  warnings: string[];
  descLen: number;
  tokens: number;
}

const BAD_TOKENS = ["{{", "}}", "undefined", "[object Object]", "NaN"];
const NAME_REGEX = /^[a-z][a-z0-9_]*$/;

export function evalPrompt(entry: PromptEntry): EvalResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  // --- structural ---
  if (!NAME_REGEX.test(entry.name)) {
    failures.push(`name "${entry.name}" does not match /^[a-z][a-z0-9_]*$/`);
  }
  if (!entry.meta.title || entry.meta.title.trim() === "") {
    failures.push("title is empty");
  }
  const desc = entry.meta.description ?? "";
  const descLen = desc.length;
  if (descLen <= CRITERIA.minDescLen) {
    failures.push(`description too short: ${descLen} chars (> ${CRITERIA.minDescLen} required)`);
  }
  if (descLen > CRITERIA.maxDescLen) {
    failures.push(`description too long: ${descLen} chars (max ${CRITERIA.maxDescLen})`);
  }
  if (desc.startsWith("TODO")) {
    failures.push("description starts with TODO");
  }
  if (desc.length > 0 && desc[0] !== desc[0]?.toUpperCase()) {
    failures.push("description does not start with an uppercase letter");
  }
  if (!desc.endsWith(".")) {
    failures.push("description does not end with '.'");
  }
  if (typeof entry.meta.argsSchema !== "object" || entry.meta.argsSchema === null) {
    failures.push("argsSchema is not an object");
  }

  // --- rendering ---
  let text = "";
  let tokens = 0;
  try {
    const args = synthesizeArgs(entry.meta.argsSchema ?? {});
    const result = entry.handler(args);
    if (!result || !Array.isArray(result.messages) || result.messages.length === 0) {
      failures.push("handler returned no messages");
    } else {
      const msg = result.messages[0];
      if (!msg || msg.role !== "user") {
        failures.push("first message role is not 'user'");
      }
      if (!msg?.content || msg.content.type !== "text") {
        failures.push("first message content type is not 'text'");
      }
      text = msg?.content?.text ?? "";
      if (text.trim() === "") {
        failures.push("rendered text is empty");
      }
      for (const bad of BAD_TOKENS) {
        if (text.includes(bad)) {
          failures.push(`rendered text contains "${bad}"`);
        }
      }
    }
  } catch (err: unknown) {
    failures.push(`handler threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- token budget ---
  tokens = Math.ceil(text.length / 4);
  if (tokens >= CRITERIA.maxTokens) {
    failures.push(`token estimate ${tokens} >= budget ${CRITERIA.maxTokens}`);
  } else if (tokens >= CRITERIA.maxTokens * 0.9) {
    warnings.push(`near token budget: ${tokens}t`);
  }

  return {
    name: entry.name,
    pass: failures.length === 0,
    failures,
    warnings,
    descLen,
    tokens,
  };
}
