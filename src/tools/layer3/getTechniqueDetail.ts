import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  TechniquePackSummary,
  TouchDesignerTechnique,
  TouchDesignerTechniquePack,
} from "../../knowledge/types.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const getTechniqueDetailSchema = z.object({
  category: z.string().min(1).optional().describe("Technique pack category id or display name."),
  technique_id: z
    .string()
    .min(1)
    .optional()
    .describe("Technique id or name inside the selected category."),
  include_code: z
    .boolean()
    .default(false)
    .describe("Include code snippets in technique detail results."),
  include_setup: z
    .boolean()
    .default(true)
    .describe("Include setup/workflow guidance in technique detail results."),
});

export const techniquePackSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  count: z.number().optional(),
});

export const techniqueSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  subcategory: z.string().optional(),
  description: z.string().optional(),
  difficulty: z.string().optional(),
  operators: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  requiresVersion: z.string().optional(),
});

export const techniquePackMetadataSchema = z.object({
  category: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  versionRequirement: z.string().optional(),
  resources: z.unknown().optional(),
  techniqueCount: z.number(),
});

export const getTechniqueDetailOutputSchema = z.object({
  mode: z.enum(["packs", "pack", "technique"]),
  packs: z.array(techniquePackSummarySchema).optional(),
  pack: techniquePackMetadataSchema.optional(),
  techniques: z.array(techniqueSummarySchema).optional(),
  technique: z.unknown().optional(),
  availableTechniqueIds: z.array(z.string()).optional(),
  nextToolHints: z.array(z.string()),
});

type GetTechniqueDetailArgs = z.input<typeof getTechniqueDetailSchema>;
type ParsedTechniqueDetailArgs = z.infer<typeof getTechniqueDetailSchema>;

function packMetadata(
  pack: TouchDesignerTechniquePack,
): z.infer<typeof techniquePackMetadataSchema> {
  return {
    category: pack.category,
    displayName: pack.displayName,
    description: pack.description,
    versionRequirement: pack.versionRequirement,
    resources: pack.resources,
    techniqueCount: pack.techniques.length,
  };
}

function techniqueSummary(
  technique: TouchDesignerTechnique,
): z.infer<typeof techniqueSummarySchema> {
  return {
    id: technique.id,
    name: technique.name,
    subcategory: technique.subcategory,
    description: technique.description,
    difficulty: technique.difficulty,
    operators: technique.operators,
    tags: technique.tags,
    requiresVersion: technique.requiresVersion,
  };
}

function techniqueDetail(
  technique: TouchDesignerTechnique,
  args: Pick<ParsedTechniqueDetailArgs, "include_code" | "include_setup">,
): TouchDesignerTechnique {
  const detail = { ...technique };
  if (!args.include_code) delete detail.code;
  if (!args.include_setup) delete detail.workflow;
  return detail;
}

function availableTechniqueIds(pack: TouchDesignerTechniquePack): string[] {
  return pack.techniques.map((technique) => technique.id);
}

function unknownCategoryResult(category: string, packs: TechniquePackSummary[]): CallToolResult {
  const suggestions = packs.map((pack) => pack.id);
  return errorResult(`Unknown technique category "${category}".`, {
    suggestions,
    availableCategoryIds: suggestions,
  });
}

function unknownTechniqueResult(
  category: string,
  techniqueId: string,
  ids: string[],
): CallToolResult {
  return errorResult(`Unknown technique "${techniqueId}" in category "${category}".`, {
    suggestions: ids,
    availableTechniqueIds: ids,
  });
}

export function getTechniqueDetailImpl(
  ctx: ToolContext,
  rawArgs: GetTechniqueDetailArgs,
): CallToolResult {
  const parsed = getTechniqueDetailSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult("Invalid get_technique_detail input.", {
      issues: parsed.error.issues,
    });
  }

  const args = parsed.data;
  try {
    const packs = ctx.knowledge.listTechniquePacks();
    if (!args.category) {
      return structuredResult(`Found ${packs.length} TouchDesigner technique pack(s).`, {
        mode: "packs",
        packs,
        nextToolHints: ["get_technique_detail", "search_touchdesigner_knowledge"],
      });
    }

    const pack = ctx.knowledge.getTechniquePack(args.category);
    if (!pack) return unknownCategoryResult(args.category, packs);

    const ids = availableTechniqueIds(pack);
    if (!args.technique_id) {
      return structuredResult(
        `Technique pack ${pack.displayName}: ${pack.techniques.length} technique(s).`,
        {
          mode: "pack",
          pack: packMetadata(pack),
          techniques: pack.techniques.map(techniqueSummary),
          availableTechniqueIds: ids,
          nextToolHints: ["get_technique_detail", "search_touchdesigner_knowledge"],
        },
      );
    }

    const technique = ctx.knowledge.getTechnique(pack.category, args.technique_id);
    if (!technique) return unknownTechniqueResult(pack.category, args.technique_id, ids);

    return structuredResult(`Technique ${technique.name} from ${pack.displayName}.`, {
      mode: "technique",
      pack: packMetadata(pack),
      technique: techniqueDetail(technique, args),
      availableTechniqueIds: ids,
      nextToolHints: ["draft_recipe_from_technique", "search_touchdesigner_knowledge"],
    });
  } catch (err) {
    return errorResult("Failed to read TouchDesigner technique detail.", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const registerGetTechniqueDetail: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "get_technique_detail",
    {
      title: "Get technique detail",
      description:
        "Read-only: inspect embedded TouchDesigner technique packs and individual techniques, with optional code snippets and setup/workflow details.",
      inputSchema: getTechniqueDetailSchema.shape,
      outputSchema: getTechniqueDetailOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => getTechniqueDetailImpl(ctx, args),
  );
};
