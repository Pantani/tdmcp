import { z } from "zod";
import { recipeToMarkdown } from "../../recipes/markdown.js";
import { RecipeSchema } from "../../recipes/schema.js";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  captureThumbnail,
  injectAfterFrontmatter,
  resolveOutputTop,
  type ThumbnailResult,
} from "./recipeThumbnail.js";
import { requireVault } from "./shared.js";

export const saveRecipeToVaultSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe("Recipe id/slug; also the note filename written under Recipes/ in the vault."),
  comp_path: z
    .string()
    .default("/project1")
    .describe("COMP whose direct children are captured as the recipe."),
  name: z.string().optional().describe("Human-friendly title (defaults to the id)."),
  description: z
    .string()
    .optional()
    .describe("One-line summary stored in the recipe note's frontmatter (defaults to empty)."),
  tags: z
    .array(z.string())
    .optional()
    .describe("Free-form tags for searching/filtering the recipe later (defaults to none)."),
  difficulty: z
    .enum(["beginner", "intermediate", "advanced"])
    .optional()
    .describe("Skill-level label saved in the recipe metadata (defaults to 'intermediate')."),
  overwrite: z
    .boolean()
    .default(false)
    .describe(
      "When false, refuse to replace an existing Recipes/<id>.md note; set true to overwrite it.",
    ),
  preview_top: z
    .string()
    .optional()
    .describe(
      "Output TOP to thumbnail for the recipe note (e.g. <comp_path>/out1). " +
        "Defaults to the comp's first/last TOP child; omit a TOP entirely to skip the thumbnail.",
    ),
  thumbnail: z
    .boolean()
    .default(true)
    .describe("Capture a preview PNG next to the recipe note and embed it. Set false to skip."),
});
type SaveRecipeToVaultArgs = z.infer<typeof saveRecipeToVaultSchema>;

interface CaptureReport {
  comp: string;
  nodes: Array<{ name: string; type: string; parameters: Record<string, unknown> }>;
  connections: Array<{ from: string; to: string; from_output: number; to_input: number }>;
  python_code: Record<string, string>;
  warnings: string[];
  fatal?: string;
}

// Captures the direct children of a COMP as a recipe: node name+type, the
// non-default constant parameters, text-DAT bodies (round-tripped via python_code),
// and the wiring — including converter ops (choptoTOP, …) that read their source
// from a parameter rather than a wire.
const CAPTURE_SCRIPT = `
import json, base64, re, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["comp"], "nodes": [], "connections": [], "python_code": {}, "warnings": []}
try:
    _root = op(_p["comp"])
    if _root is None:
        report["fatal"] = "Operator not found: " + _p["comp"]
    elif not hasattr(_root, "children"):
        report["fatal"] = _p["comp"] + " is not a COMP (no children to capture)."
    else:
        _kids = list(_root.children)
        _names = set(c.name for c in _kids)
        for _c in _kids:
            _node = {"name": _c.name, "type": _c.OPType, "parameters": {}}
            try:
                for _pr in _c.pars():
                    try:
                        if _pr.readOnly or _pr.isDefault:
                            continue
                        if _pr.mode.name != "CONSTANT":
                            continue
                        _v = _pr.eval()
                        if isinstance(_v, (bool, int, float, str)):
                            _node["parameters"][_pr.name] = _v
                    except Exception:
                        pass
            except Exception:
                pass
            try:
                if hasattr(_c, "text") and isinstance(_c.text, str) and _c.text.strip():
                    report["python_code"][_c.name] = _c.text
            except Exception:
                pass
            try:
                _m = re.match(r"^(chop|dat|top|sop)to", _c.OPType or "")
                if _m:
                    _sp = _m.group(1)
                    _spar = getattr(_c.par, _sp, None)
                    if _spar is not None:
                        _srcop = _c.op(_spar.eval())
                        if _srcop is not None and _srcop.name in _names:
                            report["connections"].append({"from": _srcop.name, "to": _c.name, "from_output": 0, "to_input": 0})
                            _node["parameters"].pop(_sp, None)
            except Exception:
                pass
            report["nodes"].append(_node)
            try:
                for _ic in _c.inputConnectors:
                    for _oc in _ic.connections:
                        _src = _oc.owner
                        if _src is not None and _src.name in _names:
                            report["connections"].append({"from": _src.name, "to": _c.name, "from_output": _oc.index, "to_input": _ic.index})
            except Exception:
                pass
        if not _kids:
            report["warnings"].append("No child operators under " + _p["comp"])
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

function slug(id: string): string {
  return (
    id
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "recipe"
  );
}

export async function saveRecipeToVaultImpl(ctx: ToolContext, args: SaveRecipeToVaultArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const relPath = `Recipes/${slug(args.id)}.md`;
  if (vault.exists(relPath) && !args.overwrite) {
    return errorResult(
      `A recipe note already exists at ${relPath}. Pass overwrite:true to replace it.`,
    );
  }

  // Plain try/catch (not guardTd) because the thumbnail capture is an awaited step
  // AFTER the report parse, and guardTd's onOk mapper is synchronous. captureThumbnail
  // itself never throws, so a thumbnail failure never fails the note save.
  try {
    const script = buildPayloadScript(CAPTURE_SCRIPT, { comp: args.comp_path });
    const exec = await ctx.client.executePythonScript(script, true);
    const report = parsePythonReport<CaptureReport>(exec.stdout);

    if (report.fatal) return errorResult(`Capture failed: ${report.fatal}`);
    if (report.nodes.length === 0) {
      return errorResult(`No operators found under ${args.comp_path} to capture as a recipe.`);
    }
    const parsed = RecipeSchema.safeParse({
      id: args.id,
      name: args.name ?? args.id,
      description: args.description ?? "",
      tags: args.tags ?? [],
      difficulty: args.difficulty ?? "intermediate",
      nodes: report.nodes,
      connections: report.connections,
      python_code: Object.keys(report.python_code).length > 0 ? report.python_code : undefined,
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return errorResult(`Captured network is not a valid recipe: ${issues}`);
    }
    const recipe = parsed.data;

    // Capture a sibling thumbnail and embed it after the note's frontmatter. The
    // PNG stem matches the note stem (slug(args.id)) so they pair up in the vault.
    const baseName = slug(args.id);
    let thumb: ThumbnailResult = { imageRel: null, embed: "" };
    if (args.thumbnail) {
      const topPath = args.preview_top ?? resolveOutputTop(report.nodes, args.comp_path);
      thumb = await captureThumbnail(ctx.client, vault, "Recipes", baseName, { topPath });
    }
    const md = recipeToMarkdown(recipe);
    const withThumb = thumb.embed ? injectAfterFrontmatter(md, `${thumb.embed}\n`) : md;
    vault.write(relPath, withThumb);

    return jsonResult(
      `Saved recipe "${recipe.id}" to ${relPath} (${recipe.nodes.length} node(s), ${recipe.connections.length} connection(s)). Apply it later with apply_recipe.`,
      {
        path: relPath,
        id: recipe.id,
        nodes: recipe.nodes.length,
        connections: recipe.connections.length,
        captured_text: Object.keys(report.python_code),
        warnings: report.warnings,
        thumbnail: thumb.imageRel,
        ...(thumb.warning ? { thumbnail_warning: thumb.warning } : {}),
      },
    );
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }
}

export const registerSaveRecipeToVault: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "save_recipe_to_vault",
    {
      title: "Save network as a vault recipe",
      description:
        "Capture an existing COMP's network (child nodes, non-default parameters, wiring, and text/script DAT bodies) by reading TD, then WRITE it as a reusable recipe note in the Obsidian vault at Recipes/<id>.md; list_recipes/apply_recipe then see it alongside the built-in recipes. Use this to turn a patch you already built into a template — to instantiate a template instead, use apply_recipe. Refuses to overwrite an existing note unless overwrite:true. Returns the note path, recipe id, and node/connection counts. Requires a configured TDMCP_VAULT_PATH.",
      inputSchema: saveRecipeToVaultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => saveRecipeToVaultImpl(ctx, args),
  );
};
