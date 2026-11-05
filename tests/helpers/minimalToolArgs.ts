import { z } from "zod";

/**
 * Deterministically derives the smallest input a tool's Zod schema accepts, so a
 * sweep can invoke hundreds of tools without a hand-written fixture for each.
 *
 * Only REQUIRED fields are filled: optional fields and defaults stay unset, which
 * means a sweep sees each tool's default path and nothing else. Callers must treat
 * that as a coverage limit, not as proof about every option a tool offers.
 */

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
};

const STRING_CANDIDATES = [
  "/project1/smoke",
  "smoke",
  "a",
  "noiseTOP",
  "https://example.test/smoke",
  "#ff0000",
  "1.0.0",
  "120",
  "smoke.json",
  "/smoke",
];

/** Field names whose value is a TouchDesigner operator path by repo convention. */
const OP_PATH_FIELD = /(^|_)(path|paths|parent|comp|node|target|source|top|chop|sop|dat|op)($|_)/i;
const FILE_FIELD = /(file|dir|folder|filename|output_path|bundle)/i;
const URL_FIELD = /(^|_)(url|uri|endpoint)($|_)/i;

function stringFor(key: string, schema: JsonSchema): string {
  const preferred = URL_FIELD.test(key)
    ? "https://example.test/smoke"
    : FILE_FIELD.test(key)
      ? "smoke-output.json"
      : OP_PATH_FIELD.test(key)
        ? "/project1/smoke"
        : schema.format === "uri" || schema.format === "url"
          ? "https://example.test/smoke"
          : "smoke";
  const pattern = schema.pattern ? new RegExp(schema.pattern) : undefined;
  const fits = (value: string): boolean =>
    (pattern ? pattern.test(value) : true) &&
    value.length >= (schema.minLength ?? 0) &&
    value.length <= (schema.maxLength ?? Number.MAX_SAFE_INTEGER);
  const found = [preferred, ...STRING_CANDIDATES].find(fits);
  if (found) return found;
  return "s".repeat(Math.max(schema.minLength ?? 1, 1)).slice(0, schema.maxLength ?? undefined);
}

function numberFor(schema: JsonSchema, integer: boolean): number {
  const step = integer ? 1 : 0.5;
  if (schema.minimum !== undefined) return schema.minimum;
  if (schema.exclusiveMinimum !== undefined) return schema.exclusiveMinimum + step;
  if (schema.maximum !== undefined) return schema.maximum;
  if (schema.exclusiveMaximum !== undefined) return schema.exclusiveMaximum - step;
  return 1;
}

function objectFor(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    const property = schema.properties?.[key];
    if (property) out[key] = valueFor(key, property);
  }
  return out;
}

function arrayFor(key: string, schema: JsonSchema): unknown[] {
  if (schema.prefixItems) return schema.prefixItems.map((item) => valueFor(key, item));
  const length = schema.minItems ?? 0;
  return Array.from({ length }, () => valueFor(key, schema.items ?? {}));
}

function valueFor(key: string, schema: JsonSchema): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  const union = schema.anyOf ?? schema.oneOf;
  if (union?.[0]) return valueFor(key, union[0]);
  if (schema.allOf?.[0]) return valueFor(key, schema.allOf[0]);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "string":
      return stringFor(key, schema);
    case "number":
      return numberFor(schema, false);
    case "integer":
      return numberFor(schema, true);
    case "boolean":
      return false;
    case "array":
      return arrayFor(key, schema);
    case "object":
      return objectFor(schema);
    case "null":
      return null;
    default:
      return "smoke";
  }
}

export type MinimalArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; attempted: Record<string, unknown>; issues: string[] };

/**
 * Builds and validates minimal args for a tool, layering `overrides` over the
 * generated values. The returned `args` are the schema's PARSED output, which is
 * what the MCP SDK hands a real handler (defaults applied, transforms run).
 */
export function minimalToolArgs(
  inputShape: z.ZodRawShape | undefined,
  overrides: Record<string, unknown> = {},
): MinimalArgs {
  const schema = z.object(inputShape ?? {});
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  const attempted = { ...objectFor(json), ...overrides };
  const parsed = schema.safeParse(attempted);
  if (parsed.success) return { ok: true, args: parsed.data as Record<string, unknown> };
  return {
    ok: false,
    attempted,
    issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}
