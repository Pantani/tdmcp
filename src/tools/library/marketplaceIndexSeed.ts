import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const entryKindSchema = z.enum([
  "recipe-pack",
  "component-pack",
  "look-pack",
  "asset-pack",
  "toolkit",
]);

const marketplaceEntrySchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i)
    .describe("Stable marketplace id."),
  name: z.string().min(1),
  version: z.string().default("0.1.0"),
  kind: entryKindSchema.default("toolkit"),
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
  source_path: z.string().optional().describe("Local path or relative pack path for this entry."),
  homepage: z.string().url().optional(),
  license: z.string().optional(),
});

export const marketplaceIndexSeedSchema = z.object({
  out_file: z.string().describe("Path to the seed marketplace JSON file to write."),
  name: z.string().default("tdmcp-local-marketplace"),
  entries: z.array(marketplaceEntrySchema).default([]),
  include_builtin_starters: z
    .boolean()
    .default(true)
    .describe("Include starter package ideas that can be replaced with real local package paths."),
  overwrite: z.boolean().default(false).describe("When false, fail if out_file already exists."),
});
type MarketplaceIndexSeedArgs = z.infer<typeof marketplaceIndexSeedSchema>;

const BUILTIN_STARTERS: Array<z.infer<typeof marketplaceEntrySchema>> = [
  {
    id: "vj-starter-recipes",
    name: "VJ Starter Recipes",
    version: "0.1.0",
    kind: "recipe-pack",
    description:
      "Base visual systems for fast show starts: feedback, strobe, kaleidoscope, and layer mixes.",
    tags: ["vj", "recipes", "starter"],
    source_path: "packs/vj-starter-recipes.pack",
    license: "UNLICENSED",
  },
  {
    id: "projection-mapping-kit",
    name: "Projection Mapping Kit",
    version: "0.1.0",
    kind: "component-pack",
    description:
      "Reusable masks, test patterns, mesh warp helpers, and projector calibration notes.",
    tags: ["projection", "mapping", "utility"],
    source_path: "packs/projection-mapping-kit.pack",
    license: "UNLICENSED",
  },
  {
    id: "shader-snippet-pack",
    name: "Shader Snippet Pack",
    version: "0.1.0",
    kind: "look-pack",
    description:
      "Small GLSL fragments and post-processing looks ready to adapt inside generated networks.",
    tags: ["shader", "glsl", "looks"],
    source_path: "packs/shader-snippet-pack.pack",
    license: "UNLICENSED",
  },
  {
    id: "show-control-presets",
    name: "Show Control Presets",
    version: "0.1.0",
    kind: "toolkit",
    description:
      "Starter OSC, MIDI, OBS, QLab, and ATEM control-surface presets for local show control.",
    tags: ["show-control", "osc", "midi"],
    source_path: "packs/show-control-presets.pack",
    license: "UNLICENSED",
  },
  {
    id: "pbr-material-studies",
    name: "PBR Material Studies",
    version: "0.1.0",
    kind: "asset-pack",
    description: "Reference material presets for Blender, USD, and TouchDesigner PBR render tests.",
    tags: ["pbr", "3d", "materials"],
    source_path: "packs/pbr-material-studies.pack",
    license: "UNLICENSED",
  },
];

function assertUniqueIds(entries: Array<{ id: string }>): string | undefined {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = entry.id.toLowerCase();
    if (seen.has(key)) return entry.id;
    seen.add(key);
  }
  return undefined;
}

export async function marketplaceIndexSeedImpl(_ctx: ToolContext, args: MarketplaceIndexSeedArgs) {
  const outFile = resolve(args.out_file);
  if (existsSync(outFile) && !args.overwrite) {
    return errorResult(
      `Marketplace seed already exists: ${outFile}. Pass overwrite:true to replace it.`,
    );
  }

  const entries = [...(args.include_builtin_starters ? BUILTIN_STARTERS : []), ...args.entries];
  const duplicate = assertUniqueIds(entries);
  if (duplicate) return errorResult(`Duplicate marketplace entry id: ${duplicate}.`);

  const index = {
    kind: "tdmcp-marketplace-index-seed",
    schema_version: 1,
    name: args.name,
    generated_at: new Date().toISOString(),
    entries,
  };

  try {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  } catch (err) {
    return errorResult(
      `Could not write marketplace seed to ${outFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return structuredResult(
    `Seeded ${entries.length} marketplace entr${entries.length === 1 ? "y" : "ies"} at ${outFile}.`,
    {
      index_path: outFile,
      name: args.name,
      entries,
      builtin_count: args.include_builtin_starters ? BUILTIN_STARTERS.length : 0,
      custom_count: args.entries.length,
    },
  );
}

export const marketplaceIndexSeedOutputSchema = z.object({
  index_path: z.string(),
  name: z.string(),
  entries: z.array(marketplaceEntrySchema),
  builtin_count: z.number(),
  custom_count: z.number(),
});

export const registerMarketplaceIndexSeed: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "marketplace_index_seed",
    {
      title: "Marketplace index seed",
      description:
        "Write a guarded starter marketplace index JSON with optional built-in seed entries and custom package entries. Use this before local_marketplace_index when planning a local package marketplace; overwrite=false protects existing index files.",
      inputSchema: marketplaceIndexSeedSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      outputSchema: marketplaceIndexSeedOutputSchema.shape,
    },
    (args) => marketplaceIndexSeedImpl(ctx, args),
  );
};
