// Captures the pinned tool API surface from a source tree: every tool's input
// schema through the real `registerAllTools`, and the `ToolContext` shape through
// the TypeScript compiler API. Nothing here reads a hand-kept list of tools.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type ts from "typescript";
import type { ApiSurface, ContextField, JsonSchema, ToolSnapshot } from "./diff.js";

interface ZodDef {
  type?: string;
  checks?: Array<{ _zod?: { check?: unknown; def?: { check?: string; fn?: unknown } } }>;
  transform?: unknown;
  fn?: unknown;
  innerType?: ZodNode;
  element?: ZodNode;
  in?: ZodNode;
  out?: ZodNode;
  getter?: () => ZodNode;
  valueType?: ZodNode;
  keyType?: ZodNode;
  catchall?: ZodNode;
  rest?: ZodNode;
  left?: ZodNode;
  right?: ZodNode;
  options?: ZodNode[];
  items?: ZodNode[];
  shape?: Record<string, ZodNode> | (() => Record<string, ZodNode>);
}

interface ZodNode {
  _zod?: { def?: ZodDef };
}

interface ZodModule {
  z: {
    object(shape: Record<string, unknown>): ZodNode;
    toJSONSchema(schema: ZodNode, options: { io: "input"; unrepresentable: "any" }): JsonSchema;
  };
}

interface RegisteredTool {
  inputSchema?: Record<string, unknown> | ZodNode;
  description?: string;
}

const sourceText = (fn: unknown): string => String(fn).replace(/\s+/g, " ").trim();

function childNodes(def: ZodDef, path: string): Array<[ZodNode | undefined, string]> {
  const shape = typeof def.shape === "function" ? def.shape() : def.shape;
  return [
    [def.innerType, path],
    [def.in, path],
    [def.out, path],
    [def.left, path],
    [def.right, path],
    [def.getter?.(), path],
    [def.element, `${path}[]`],
    [def.valueType, `${path}{}`],
    [def.catchall, `${path}{}`],
    [def.keyType, `${path}{key}`],
    [def.rest, `${path}[]`],
    // Union members share a path, so inserting a member does not read as a new refinement.
    ...(def.options ?? []).map((option): [ZodNode, string] => [option, `${path}|*`]),
    ...(def.items ?? []).map((item, index): [ZodNode, string] => [item, `${path}[${index}]`]),
    ...Object.entries(shape ?? {}).map(([key, value]): [ZodNode, string] => [
      value,
      `${path}.${key}`,
    ]),
  ];
}

function nodeFingerprints(def: ZodDef): string[] {
  const out: string[] = [];
  let superRefines = 0;
  for (const check of def.checks ?? []) {
    const checkDef = check?._zod?.def;
    if (checkDef?.check !== "custom") continue;
    // `.refine()` keeps its function on the def. `.superRefine()` is hidden behind a
    // Zod wrapper closure, so its body cannot be read: count it instead of recording
    // wrapper text that would change with every Zod upgrade.
    const text = sourceText(checkDef.fn ?? check._zod?.check);
    if (/payload\.addIssue\s*=/.test(text)) out.push(`refine:superRefine#${++superRefines}`);
    else out.push(`refine:${text}`);
  }
  if (def.type === "transform") out.push(`transform:${sourceText(def.transform)}`);
  if (def.type === "custom") out.push(`custom:${sourceText(def.fn)}`);
  return out;
}

/**
 * Custom refinements and transforms do not appear in JSON Schema, so record their
 * source text by field path. `ancestors` holds only the current branch: a shared
 * sub-schema used by two fields must be reported under both paths.
 */
export function collectChecks(
  node: ZodNode | undefined,
  path = "",
  acc: Record<string, string[]> = {},
  ancestors = new Set<ZodNode>(),
): Record<string, string[]> {
  const def = node?._zod?.def;
  if (!node || !def || ancestors.has(node)) return acc;
  ancestors.add(node);
  const found = nodeFingerprints(def);
  if (found.length > 0) acc[path] = [...new Set([...(acc[path] ?? []), ...found])].sort();
  for (const [child, childPath] of childNodes(def, path)) {
    collectChecks(child, childPath, acc, ancestors);
  }
  ancestors.delete(node);
  return acc;
}

const VERBATIM_KEYWORDS = new Set(["default", "const", "enum"]);
const DOC_KEYWORDS = new Set(["description", "title", "$schema", "examples"]);

/**
 * Drop documentation so rewording a description never touches the baseline, and
 * sort field names so reordering a shape does not either. Keys are only treated as
 * keywords at schema level: a tool field may legitimately be named `description`.
 */
export function canonicalSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(canonicalSchema);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (DOC_KEYWORDS.has(key)) continue;
    if (VERBATIM_KEYWORDS.has(key)) out[key] = value;
    else if (key === "properties" || key === "$defs" || key === "definitions") {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, child]) => [name, canonicalSchema(child)]),
      );
    } else if (key === "required") out[key] = [...(value as string[])].sort();
    else out[key] = canonicalSchema(value);
  }
  return out;
}

/** A deprecation is announced at the start of the description (docs/reference/tool-contract). */
export function isDeprecatedDescription(description: string | undefined): boolean {
  return /^\s*[[(*_]*deprecated\b/i.test(description ?? "");
}

/** Conditional registrations must not depend on whoever runs the check. */
function pinRegistrationEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("TDMCP_")) delete process.env[key];
  }
  process.env.TDMCP_RAG_APPLY_CARD = "1";
}

async function captureRegisteredTools(root: string): Promise<Map<string, RegisteredTool>> {
  const tools = new Map<string, RegisteredTool>();
  const server = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop !== "registerTool") return () => {};
        return (name: string, config: RegisteredTool) => {
          if (tools.has(name)) throw new Error(`Tool registered twice: ${name}`);
          tools.set(name, config);
          return { enable() {}, disable() {}, remove() {}, update() {} };
        };
      },
    },
  );
  const entry = pathToFileURL(join(root, "src/tools/index.ts")).href;
  const { registerAllTools } = (await import(entry)) as {
    registerAllTools(server: unknown, ctx: unknown): void;
  };
  // Every optional dependency present and no restrictive profile, so conditional registrars fire.
  const noop = new Proxy({}, { get: () => () => {} });
  registerAllTools(server, {
    allowRawPython: true,
    vault: {},
    llm: {},
    creativeRag: {},
    projectRag: {},
    logger: noop,
  });
  return tools;
}

function snapshotTool(zod: ZodModule["z"], name: string, config: RegisteredTool): ToolSnapshot {
  const input = config.inputSchema ?? {};
  const schema =
    "_zod" in input ? (input as ZodNode) : zod.object(input as Record<string, unknown>);
  try {
    return {
      schema: canonicalSchema(
        zod.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
      ) as JsonSchema,
      checks: collectChecks(schema),
      deprecated: isDeprecatedDescription(config.description),
    };
  } catch (error) {
    throw new Error(`Cannot serialise the input schema of ${name}: ${String(error)}`);
  }
}

function extractToolContext(root: string, tsApi: typeof ts): ApiSurface["toolContext"] {
  const file = join(root, "src/tools/types.ts");
  const source = tsApi.createSourceFile(
    "types.ts",
    readFileSync(file, "utf8"),
    tsApi.ScriptTarget.Latest,
    true,
  );
  const printer = tsApi.createPrinter({ removeComments: true });
  const print = (node: ts.Node) =>
    printer.printNode(tsApi.EmitHint.Unspecified, node, source).replace(/\s+/g, " ").trim();
  const declaration = source.statements.find(
    (node): node is ts.InterfaceDeclaration =>
      tsApi.isInterfaceDeclaration(node) && node.name.text === "ToolContext",
  );
  if (!declaration) throw new Error(`${file} no longer declares \`interface ToolContext\`.`);
  const fields: Record<string, ContextField> = {};
  for (const member of declaration.members) {
    const type = tsApi.isPropertySignature(member) && member.type ? member.type : member;
    fields[member.name?.getText(source) ?? print(member)] = {
      optional: Boolean(member.questionToken),
      type: print(type),
    };
  }
  return { heritage: (declaration.heritageClauses ?? []).map(print), fields };
}

export async function extractApiSurface(root: string): Promise<ApiSurface> {
  pinRegistrationEnvironment();
  const require = createRequire(join(root, "package.json"));
  const { z } = (await import(pathToFileURL(require.resolve("zod")).href)) as ZodModule;
  const tsApi = require("typescript") as typeof ts;

  const registered = await captureRegisteredTools(root);
  if (registered.size === 0) throw new Error("registerAllTools registered no tools.");
  const tools: ApiSurface["tools"] = {};
  for (const name of [...registered.keys()].sort()) {
    tools[name] = snapshotTool(z, name, registered.get(name) as RegisteredTool);
  }
  return { tools, toolContext: extractToolContext(root, tsApi) };
}
