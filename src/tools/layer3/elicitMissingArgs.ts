import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { LlmClientLike } from "../../llm/client.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const elicitMissingArgsSchema = z.object({
  tool_name: z
    .string()
    .min(1)
    .describe("Registered tdmcp tool name, e.g. 'create_audio_reactive'."),
  partial_args: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("Args already known. Missing required fields will be elicited."),
  context: z
    .string()
    .optional()
    .describe("Natural-language context the user gave (a chat message, prompt, etc.)."),
  temperature: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.1)
    .describe("Sampling temperature for elicitation. Low by default for determinism."),
  max_fields: z.coerce
    .number()
    .int()
    .positive()
    .default(16)
    .describe("Cap on how many missing required fields to elicit in one call."),
});

export const elicitMissingArgsOutputSchema = z.object({
  tool_name: z.string(),
  filled: z
    .record(z.string(), z.unknown())
    .describe("Elicited values keyed by field name. `null` when LLM declined/unavailable."),
  proposed_args: z
    .record(z.string(), z.unknown())
    .describe("partial_args merged with non-null filled, validated against the tool schema."),
  missing: z
    .array(z.string())
    .describe("Required fields that were still missing after elicitation (filled[k] === null)."),
  source: z
    .enum(["llm", "offline", "none-needed"])
    .describe(
      "'llm' if the model answered, 'offline' if no LLM, 'none-needed' if nothing missing.",
    ),
  warnings: z.array(z.string()),
});

const CONTEXT_TRUNCATE = 4000;

interface FieldSpec {
  name: string;
  tsType: string;
  description?: string;
  enumOptions?: string[];
  min?: number;
  max?: number;
}

interface RegisteredToolEntry {
  inputSchema?: z.ZodRawShape;
  description?: string;
  title?: string;
}

/** Walk a Zod field, unwrap defaults/optionals/nullables, classify type. */
function classifyField(name: string, schema: z.ZodTypeAny): { required: boolean; spec: FieldSpec } {
  // Required = the schema rejects `undefined`. Robust across Zod v3/v4 internal renames.
  // A defaulted/optional/nullable schema accepts `undefined`; everything else is required.
  const required = !schema.safeParse(undefined).success;

  // Unwrap wrappers to find the inner type.
  let current: z.ZodTypeAny = schema;
  for (let i = 0; i < 8; i++) {
    const def = (
      current as { _def?: { type?: string; typeName?: string; innerType?: z.ZodTypeAny } }
    )._def;
    const t = def?.type ?? def?.typeName;
    if (
      (t === "default" ||
        t === "optional" ||
        t === "nullable" ||
        t === "ZodDefault" ||
        t === "ZodOptional" ||
        t === "ZodNullable") &&
      def?.innerType
    ) {
      current = def.innerType;
      continue;
    }
    break;
  }

  const def = (
    current as {
      _def?: {
        type?: string;
        typeName?: string;
        values?: unknown[];
        checks?: unknown[];
        entries?: Record<string, unknown>;
      };
    }
  )._def;
  const tn = (def?.type ?? def?.typeName ?? "unknown").toString().toLowerCase();

  let tsType = "unknown";
  let enumOptions: string[] | undefined;
  let min: number | undefined;
  let max: number | undefined;

  if (tn.includes("string")) tsType = "string";
  else if (tn.includes("number")) tsType = "number";
  else if (tn.includes("boolean")) tsType = "boolean";
  else if (tn.includes("enum")) {
    tsType = "enum";
    if (Array.isArray(def?.values)) enumOptions = def.values as string[];
    else if (def?.entries && typeof def.entries === "object") {
      enumOptions = Object.keys(def.entries);
    }
  } else if (tn.includes("array")) tsType = "array";
  else if (tn.includes("object") || tn.includes("record")) tsType = "object";

  // Number bounds: Zod v3 checks[].kind, v4 checks[].def.{check,minimum|maximum}
  if (tsType === "number" && Array.isArray(def?.checks)) {
    for (const c of def.checks as Array<{
      kind?: string;
      value?: number;
      def?: { check?: string; minimum?: number; maximum?: number };
    }>) {
      if (c.kind === "min" && typeof c.value === "number") min = c.value;
      else if (c.kind === "max" && typeof c.value === "number") max = c.value;
      else if (c.def?.check === "greater_than" || c.def?.check === "min_value") {
        if (typeof c.def.minimum === "number") min = c.def.minimum;
      } else if (c.def?.check === "less_than" || c.def?.check === "max_value") {
        if (typeof c.def.maximum === "number") max = c.def.maximum;
      }
    }
  }

  const description = (schema as { description?: string }).description;

  return {
    required,
    spec: { name, tsType, description, enumOptions, min, max },
  };
}

// NOTE: `_registeredTools` is a PRIVATE MCP SDK field, not part of its public
// API. TODO: replace with a public registry abstraction when the SDK exposes one.
function getRegistry(server: unknown): Record<string, RegisteredToolEntry> | undefined {
  const reg = (server as { _registeredTools?: unknown })?._registeredTools;
  if (reg && typeof reg === "object") return reg as Record<string, RegisteredToolEntry>;
  return undefined;
}

/** Extract first balanced {...} block from text. */
function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function renderFieldLine(s: FieldSpec): string {
  const parts = [`name: ${s.name}`, `type: ${s.tsType}`];
  if (s.enumOptions && s.enumOptions.length > 0) {
    parts.push(`enum: ${s.enumOptions.join("|")}`);
  }
  if (typeof s.min === "number" || typeof s.max === "number") {
    parts.push(`range: ${s.min ?? "-inf"}..${s.max ?? "+inf"}`);
  }
  if (s.description) parts.push(`desc: ${s.description}`);
  return `  - ${parts.join("; ")}`;
}

export async function elicitMissingArgsImpl(
  ctx: ToolContext,
  args: z.infer<typeof elicitMissingArgsSchema>,
): Promise<CallToolResult> {
  // ToolContext doesn't (yet) include `server`; spec asks integrator to add it.
  // For now, accept it via a non-throwing cast so the tool compiles and runs once
  // the integrator wires `ctx.server = server` in tdmcpServer.ts.
  const server = (ctx as ToolContext & { server?: McpServer }).server;
  if (!server) {
    return errorResult("server registry unavailable in this context (ctx.server not set by host).");
  }
  const registry = getRegistry(server);
  if (!registry) {
    return errorResult(
      "tool registry not accessible on this MCP server build (no _registeredTools).",
    );
  }
  const entry = registry[args.tool_name];
  if (!entry) {
    return errorResult(`unknown tool: ${args.tool_name}`);
  }
  const shape = entry.inputSchema;
  if (!shape) {
    return errorResult(`tool ${args.tool_name} has no inputSchema to introspect.`);
  }

  const schema = z.object(shape);
  const warnings: string[] = [];

  // Find missing required fields
  const missingSpecs: FieldSpec[] = [];
  const known = args.partial_args ?? {};
  for (const key of Object.keys(shape)) {
    const fieldSchema = shape[key];
    if (!fieldSchema) continue;
    const { required, spec } = classifyField(key, fieldSchema as z.ZodTypeAny);
    if (!required) continue;
    const supplied = key in known && known[key] !== undefined;
    if (supplied) continue;
    missingSpecs.push(spec);
  }

  if (missingSpecs.length === 0) {
    return structuredResult("no missing required fields", {
      tool_name: args.tool_name,
      filled: {},
      proposed_args: known,
      missing: [],
      source: "none-needed",
      warnings,
    });
  }

  let renderedSpecs = missingSpecs;
  if (missingSpecs.length > args.max_fields) {
    warnings.push(
      `too many missing required fields (${missingSpecs.length}); capped at ${args.max_fields}.`,
    );
    renderedSpecs = missingSpecs.slice(0, args.max_fields);
  }

  let context = args.context ?? "(none)";
  if (context.length > CONTEXT_TRUNCATE) {
    warnings.push(`context truncated from ${context.length} to ${CONTEXT_TRUNCATE} chars.`);
    context = context.slice(0, CONTEXT_TRUNCATE);
  }

  const llm: LlmClientLike | undefined = ctx.llm;
  const filled: Record<string, unknown> = {};
  let source: "llm" | "offline" | "none-needed" = "offline";

  if (!llm) {
    warnings.push("no LLM configured; cannot elicit values (offline).");
    for (const s of renderedSpecs) filled[s.name] = null;
    source = "offline";
  } else {
    source = "llm";
    const toolDesc = (entry.description ?? entry.title ?? "").slice(0, 400);
    const fieldsBlock = renderedSpecs.map(renderFieldLine).join("\n");
    const user =
      `TOOL: ${args.tool_name}\n` +
      `TOOL_DESCRIPTION: ${toolDesc}\n` +
      `CONTEXT: ${context}\n` +
      `KNOWN_ARGS: ${JSON.stringify(known)}\n` +
      `MISSING_REQUIRED_FIELDS:\n${fieldsBlock}\n` +
      `Reply with JSON: { "<field>": <value | null>, ... }`;
    const system =
      "You fill in missing arguments for a TouchDesigner tool call. " +
      "Respond with a single JSON object whose keys are exactly the requested field names. " +
      "Use `null` when the context does not justify a confident value. No prose.";

    try {
      const result = await llm.complete([{ role: "user", content: user }], {
        system,
        temperature: args.temperature,
        maxTokens: 512,
        timeoutMs: 15_000,
        stopSequences: ["```"],
      });
      const block = extractFirstJsonObject(result.text ?? "");
      if (!block) {
        warnings.push("llm returned non-JSON response; falling back to null for missing fields.");
        for (const s of renderedSpecs) filled[s.name] = null;
      } else {
        try {
          const parsed = JSON.parse(block) as Record<string, unknown>;
          if (parsed && typeof parsed === "object") {
            for (const s of renderedSpecs) {
              filled[s.name] = s.name in parsed ? parsed[s.name] : null;
            }
          } else {
            warnings.push("llm JSON was not an object; falling back to null.");
            for (const s of renderedSpecs) filled[s.name] = null;
          }
        } catch {
          warnings.push("llm returned non-JSON response; falling back to null for missing fields.");
          for (const s of renderedSpecs) filled[s.name] = null;
        }
      }
    } catch (err) {
      warnings.push(`LLM call failed: ${(err as Error).message ?? String(err)}`);
      for (const s of renderedSpecs) filled[s.name] = null;
      source = "offline";
    }
  }

  // Path-like hallucination warning
  for (const s of renderedSpecs) {
    const v = filled[s.name];
    if (
      typeof v === "string" &&
      v.length > 0 &&
      `${s.name} ${s.description ?? ""}`.match(/node|path|op/i)
    ) {
      warnings.push(`elicited ${s.name} looks like a node path but was not verified in TD.`);
    }
  }

  // Build proposed args from non-null filled + known
  const merged: Record<string, unknown> = { ...known };
  for (const [k, v] of Object.entries(filled)) {
    if (v !== null && v !== undefined) merged[k] = v;
  }

  const parsed = schema.safeParse(merged);
  const missing: string[] = [];
  let proposedArgs: Record<string, unknown> = merged;

  if (!parsed.success) {
    // Map each Zod issue to its field; if a missing-spec field errored, push to missing.
    const erroredFields = new Set<string>();
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key) erroredFields.add(key);
      warnings.push(`schema: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    // Move offending fields back into missing and out of proposed_args
    const cleaned: Record<string, unknown> = { ...merged };
    for (const s of renderedSpecs) {
      if (erroredFields.has(s.name) || filled[s.name] === null || filled[s.name] === undefined) {
        missing.push(s.name);
        delete cleaned[s.name];
      }
    }
    proposedArgs = cleaned;
  } else {
    proposedArgs = parsed.data as Record<string, unknown>;
    for (const s of renderedSpecs) {
      if (filled[s.name] === null || filled[s.name] === undefined) missing.push(s.name);
    }
  }

  // De-dup missing
  const uniqueMissing = Array.from(new Set(missing));

  return structuredResult(
    `elicited ${renderedSpecs.length - uniqueMissing.length}/${renderedSpecs.length} field(s) (${source})`,
    {
      tool_name: args.tool_name,
      filled,
      proposed_args: proposedArgs,
      missing: uniqueMissing,
      source,
      warnings,
    },
  );
}

export const registerElicitMissingArgs: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "elicit_missing_args",
    {
      title: "Elicit missing tool args",
      description:
        "Use the schema + LLM to propose values for a tool call's missing required args.",
      inputSchema: elicitMissingArgsSchema.shape,
      outputSchema: elicitMissingArgsOutputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => elicitMissingArgsImpl(ctx, args),
  );
};
