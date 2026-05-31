import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { type Recipe, RecipeSchema } from "../../recipes/schema.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const diffLibraryAssetsSchema = z.object({
  a_path: z
    .string()
    .describe("First saved library asset on disk (recipe / component manifest / spec JSON)."),
  b_path: z
    .string()
    .describe("Second saved library asset to compare against the first (same kind)."),
  mode: z
    .enum(["auto", "recipe", "manifest", "json"])
    .default("auto")
    .describe(
      "How to interpret both files. 'auto' picks by parsing (recipe-aware if both validate " +
        "against the recipe schema, otherwise a generic deep diff). 'recipe' forces recipe-aware " +
        "diffing (node/param/connection level). 'manifest' uses the same generic deep object " +
        "diff as 'json' but reports mode_used='manifest' for component-manifest callers.",
    ),
});
type DiffLibraryAssetsArgs = z.infer<typeof diffLibraryAssetsSchema>;

type Json = unknown;
type JsonObject = { [key: string]: Json };

interface ChangedEntry {
  path: string;
  old: Json;
  new: Json;
}

interface DeepDiff {
  added: Array<{ path: string; value: Json }>;
  removed: Array<{ path: string; value: Json }>;
  changed: ChangedEntry[];
}

interface NodeParamChange {
  node: string;
  param: string;
  old: Json;
  new: Json;
}

interface RecipeDiff {
  nodes_added: string[];
  nodes_removed: string[];
  params_changed: NodeParamChange[];
  connections_added: string[];
  connections_removed: string[];
}

function isPlainObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinKey(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

function joinIndex(prefix: string, index: number): string {
  return `${prefix}[${index}]`;
}

function displayPath(prefix: string): string {
  return prefix || "$";
}

/** Deterministic structural equality via a canonical JSON string with sorted object keys. */
function canonical(value: Json): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function valuesEqual(a: Json, b: Json): boolean {
  return canonical(a) === canonical(b);
}

/** A deterministic, recursive deep diff of two parsed JSON values (object keys sorted). */
function deepDiff(a: Json, b: Json, prefix: string, out: DeepDiff): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
    for (const key of keys) {
      const path = joinKey(prefix, key);
      const hasA = Object.hasOwn(a, key);
      const hasB = Object.hasOwn(b, key);
      if (hasA && !hasB) {
        out.removed.push({ path, value: a[key] });
      } else if (!hasA && hasB) {
        out.added.push({ path, value: b[key] });
      } else {
        deepDiff(a[key], b[key], path, out);
      }
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i += 1) {
      const path = joinIndex(prefix, i);
      const hasA = i < a.length;
      const hasB = i < b.length;
      if (hasA && !hasB) {
        out.removed.push({ path, value: a[i] });
      } else if (!hasA && hasB) {
        out.added.push({ path, value: b[i] });
      } else {
        deepDiff(a[i], b[i], path, out);
      }
    }
    return;
  }
  if (!valuesEqual(a, b)) {
    out.changed.push({ path: displayPath(prefix), old: a, new: b });
  }
}

function emptyDiff(): DeepDiff {
  return { added: [], removed: [], changed: [] };
}

function nodeMap(recipe: Recipe): Map<string, Recipe["nodes"][number]> {
  const map = new Map<string, Recipe["nodes"][number]>();
  for (const node of recipe.nodes) map.set(node.name, node);
  return map;
}

function connectionKey(conn: Recipe["connections"][number]): string {
  return `${conn.from}[${conn.from_output}] -> ${conn.to}[${conn.to_input}]`;
}

/** Recipe-aware diff: node add/remove, per-node param changes, connection add/remove. */
function diffRecipes(a: Recipe, b: Recipe): RecipeDiff {
  const aNodes = nodeMap(a);
  const bNodes = nodeMap(b);
  const nodesAdded = [...bNodes.keys()].filter((name) => !aNodes.has(name)).sort();
  const nodesRemoved = [...aNodes.keys()].filter((name) => !bNodes.has(name)).sort();

  const paramsChanged: NodeParamChange[] = [];
  for (const name of [...aNodes.keys()].filter((n) => bNodes.has(n)).sort()) {
    const aNode = aNodes.get(name);
    const bNode = bNodes.get(name);
    if (!aNode || !bNode) continue;
    const aParams = aNode.parameters ?? {};
    const bParams = bNode.parameters ?? {};
    const paramNames = Array.from(
      new Set([...Object.keys(aParams), ...Object.keys(bParams)]),
    ).sort();
    for (const param of paramNames) {
      const hasA = Object.hasOwn(aParams, param);
      const hasB = Object.hasOwn(bParams, param);
      const oldValue = hasA ? aParams[param] : undefined;
      const newValue = hasB ? bParams[param] : undefined;
      if (!valuesEqual(oldValue ?? null, newValue ?? null)) {
        paramsChanged.push({ node: name, param, old: oldValue ?? null, new: newValue ?? null });
      }
    }
  }

  const aConns = new Set(a.connections.map(connectionKey));
  const bConns = new Set(b.connections.map(connectionKey));
  const connectionsAdded = [...bConns].filter((c) => !aConns.has(c)).sort();
  const connectionsRemoved = [...aConns].filter((c) => !bConns.has(c)).sort();

  return {
    nodes_added: nodesAdded,
    nodes_removed: nodesRemoved,
    params_changed: paramsChanged,
    connections_added: connectionsAdded,
    connections_removed: connectionsRemoved,
  };
}

function readJsonFile(path: string): Json {
  const full = resolve(path);
  if (!existsSync(full) || !statSync(full).isFile()) {
    throw new Error(`File not found: ${full}`);
  }
  let raw: string;
  try {
    raw = readFileSync(full, "utf8");
  } catch (err) {
    throw new Error(`Could not read ${full}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw) as Json;
  } catch (err) {
    throw new Error(`Invalid JSON in ${full}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function tryRecipe(value: Json): Recipe | undefined {
  const parsed = RecipeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export async function diffLibraryAssetsImpl(_ctx: ToolContext, args: DiffLibraryAssetsArgs) {
  const parsedArgs = diffLibraryAssetsSchema.safeParse(args);
  if (!parsedArgs.success) return errorResult(`Invalid arguments: ${parsedArgs.error.message}`);
  const { a_path, b_path, mode } = parsedArgs.data;
  let a: Json;
  let b: Json;
  try {
    a = readJsonFile(a_path);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
  try {
    b = readJsonFile(b_path);
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }

  let modeUsed: "recipe" | "manifest" | "json" = mode === "manifest" ? "manifest" : "json";
  let recipeDiff: RecipeDiff | undefined;

  if (mode === "recipe" || mode === "auto") {
    const aRecipe = tryRecipe(a);
    const bRecipe = tryRecipe(b);
    if (aRecipe && bRecipe) {
      modeUsed = "recipe";
      recipeDiff = diffRecipes(aRecipe, bRecipe);
    } else if (mode === "recipe") {
      const which = !aRecipe && !bRecipe ? "both files" : !aRecipe ? "a_path" : "b_path";
      return errorResult(
        `recipe mode requested but ${which} did not validate against the recipe schema. ` +
          "Use mode 'json' or 'manifest' for a generic diff.",
      );
    }
  }

  const deep = emptyDiff();
  deepDiff(a, b, "", deep);

  const summary = {
    added: deep.added.length,
    removed: deep.removed.length,
    changed: deep.changed.length,
  };

  const details: { deep: DeepDiff; recipe?: RecipeDiff } = { deep };
  if (recipeDiff) details.recipe = recipeDiff;

  const humanSummary = `${summary.changed} changed, ${summary.added} added, ${summary.removed} removed`;

  return structuredResult(humanSummary, {
    a_path: resolve(a_path),
    b_path: resolve(b_path),
    mode_used: modeUsed,
    summary,
    details,
  });
}

export const diffLibraryAssetsOutputSchema = z.object({
  a_path: z.string(),
  b_path: z.string(),
  mode_used: z.enum(["recipe", "manifest", "json"]),
  summary: z.object({
    added: z.number(),
    removed: z.number(),
    changed: z.number(),
  }),
  details: z.object({}).passthrough(),
});

export const registerDiffLibraryAssets: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "diff_library_assets",
    {
      title: "Diff library assets",
      description:
        "Offline deep diff of two saved library assets on disk (recipe JSONs, component " +
        "manifests, or serialize-network spec JSONs). Reports added/removed keys and changed " +
        "values (old to new); for recipes it also diffs nodes, per-node params, and connections. " +
        "Does not touch TouchDesigner. Use diff_snapshots to compare two live TD graphs.",
      inputSchema: diffLibraryAssetsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      outputSchema: diffLibraryAssetsOutputSchema.shape,
    },
    (args) => diffLibraryAssetsImpl(ctx, args),
  );
