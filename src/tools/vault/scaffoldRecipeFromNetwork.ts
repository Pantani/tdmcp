import { z } from "zod";
import { RecipeSchema } from "../../recipes/schema.js";
import { friendlyTdError } from "../../td-client/types.js";
import type { Vault } from "../../vault/index.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requireVault } from "./shared.js";

export const scaffoldRecipeFromNetworkSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe("Recipe id/slug. Also the default filename stem when write_path is set."),
  root_path: z
    .string()
    .default("/project1")
    .describe("COMP whose direct children are serialized into the recipe."),
  name: z.string().optional().describe("Human-friendly title (defaults to the id)."),
  description: z.string().default("").describe("RecipeSchema description (defaults to empty)."),
  tags: z.array(z.string()).default([]).describe("RecipeSchema tags."),
  difficulty: z
    .enum(["beginner", "intermediate", "advanced"])
    .default("intermediate")
    .describe("RecipeSchema difficulty."),
  include_defaults: z
    .boolean()
    .default(false)
    .describe(
      "When true, keep every CONSTANT-mode parameter (verbose; useful for round-trip debugging).",
    ),
  detect_cross_refs: z
    .boolean()
    .default(true)
    .describe(
      "When true, rewrite str params whose value matches a sibling node's name to the bare " +
        "sibling name (the apply_recipe convention).",
    ),
  write_path: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "Optional vault-relative path to write the recipe JSON to (e.g. Recipes/myrec.json). " +
        "When null, the JSON is returned in structuredContent only.",
    ),
  overwrite: z.boolean().default(false).describe("Refuse to clobber an existing file unless true."),
});
export type ScaffoldRecipeFromNetworkArgs = z.infer<typeof scaffoldRecipeFromNetworkSchema>;

interface ScaffoldReport {
  comp: string;
  nodes: Array<{
    name: string;
    type: string;
    parameters: Record<string, unknown>;
    parent?: string;
    render?: boolean;
  }>;
  connections: Array<{ from: string; to: string; from_output: number; to_input: number }>;
  python_code: Record<string, string>;
  cross_refs: string[];
  warnings: string[];
  fatal?: string;
}

/**
 * Walks the children of `root_path` (and one level into geometryCOMPs) and emits a
 * superset of saveRecipeToVault's CAPTURE_SCRIPT report:
 *  - default-pruning toggle (`include_defaults`)
 *  - cross-reference rewriting for str params that name a captured sibling
 *  - render-flag detection for SOPs nested in a geometryCOMP
 */
const CAPTURE_SCRIPT = `
import json, base64, re, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "comp": _p["comp"], "nodes": [], "connections": [], "python_code": {},
    "cross_refs": [], "warnings": [],
}
_include_defaults = bool(_p.get("include_defaults", False))
_detect_xrefs = bool(_p.get("detect_cross_refs", True))
_converter_pars = {"chop", "dat", "top", "sop"}
_ref_styles = {"OP", "CHOP", "DAT", "TOP", "SOP", "COMP", "MAT"}
try:
    _root = op(_p["comp"])
    if _root is None:
        report["fatal"] = "Operator not found: " + _p["comp"]
    elif not hasattr(_root, "children"):
        report["fatal"] = _p["comp"] + " is not a COMP (no children to capture)."
    else:
        _kids = list(_root.children)
        _all = []
        _name_to_owner = {}
        for _c in _kids:
            _all.append((_c, None))
            _name_to_owner[_c.name] = None
            if getattr(_c, "OPType", "") == "geometryCOMP":
                try:
                    for _sub in _c.children:
                        _all.append((_sub, _c.name))
                        _name_to_owner[_sub.name] = _c.name
                except Exception:
                    pass
        _names = set(_name_to_owner.keys())

        for _c, _parent in _all:
            _node = {"name": _c.name, "type": _c.OPType, "parameters": {}}
            if _parent is not None:
                _node["parent"] = _parent
            # Render flag detection for SOPs nested under a geometryCOMP.
            try:
                if _parent is not None and "SOP" in (_c.OPType or "") and bool(getattr(_c, "render", False)):
                    _node["render"] = True
            except Exception:
                pass
            try:
                for _pr in _c.pars():
                    try:
                        if _pr.readOnly:
                            continue
                        if not _include_defaults and _pr.isDefault:
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
            # Converter-op promotion (matches saveRecipeToVault).
            try:
                _m = re.match(r"^(chop|dat|top|sop)to", _c.OPType or "")
                if _m:
                    _sp = _m.group(1)
                    _spar = getattr(_c.par, _sp, None)
                    if _spar is not None:
                        _srcop = _c.op(_spar.eval())
                        if _srcop is not None and _srcop.name in _names:
                            report["connections"].append({
                                "from": _srcop.name, "to": _c.name,
                                "from_output": 0, "to_input": 0,
                            })
                            _node["parameters"].pop(_sp, None)
            except Exception:
                pass
            report["nodes"].append(_node)
            try:
                for _ic in _c.inputConnectors:
                    for _oc in _ic.connections:
                        _src = _oc.owner
                        if _src is not None and _src.name in _names:
                            report["connections"].append({
                                "from": _src.name, "to": _c.name,
                                "from_output": _oc.index, "to_input": _ic.index,
                            })
            except Exception:
                pass

        # Cross-reference rewrite pass.
        if _detect_xrefs:
            for _node in report["nodes"]:
                _params = _node.get("parameters", {})
                # Find live op by name+parent for style introspection.
                try:
                    if _node.get("parent"):
                        _owner = _root.op(_node["parent"]).op(_node["name"])
                    else:
                        _owner = _root.op(_node["name"])
                except Exception:
                    _owner = None
                for _pname in list(_params.keys()):
                    if _pname in _converter_pars:
                        continue
                    _val = _params[_pname]
                    if not isinstance(_val, str) or not _val:
                        continue
                    if _val not in _names:
                        continue
                    # Style guard: only rewrite OP-style references.
                    _style_ok = True
                    try:
                        if _owner is not None:
                            _pr = getattr(_owner.par, _pname, None)
                            if _pr is not None:
                                _style = getattr(_pr, "style", None)
                                if _style is not None and _style not in _ref_styles:
                                    _style_ok = False
                    except Exception:
                        pass
                    if not _style_ok:
                        continue
                    # _root.op(val) — must resolve and equal a captured sibling.
                    try:
                        _target = _root.op(_val)
                    except Exception:
                        _target = None
                    if _target is None or _target.name not in _names:
                        continue
                    report["cross_refs"].append(_node["name"] + "." + _pname + " -> " + _val)
                    # Already a bare sibling name — leave as-is. The apply_recipe
                    # convention is that buildFromRecipe rewrites string values that
                    # equal a node name back to the real path at apply time.

        if not _all:
            report["warnings"].append("No child operators under " + _p["comp"])
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

function dedupeConnections(conns: ScaffoldReport["connections"]): ScaffoldReport["connections"] {
  const seen = new Set<string>();
  const out: ScaffoldReport["connections"] = [];
  for (const c of conns) {
    const key = `${c.from}|${c.to}|${c.from_output}|${c.to_input}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export async function scaffoldRecipeFromNetworkImpl(
  ctx: ToolContext,
  args: ScaffoldRecipeFromNetworkArgs,
) {
  // Vault is OPTIONAL — only required when write_path is provided.
  let vault: Vault | undefined;
  if (args.write_path) {
    const v = requireVault(ctx);
    if ("error" in v) return v.error;
    vault = v.vault;
  }

  try {
    const script = buildPayloadScript(CAPTURE_SCRIPT, {
      comp: args.root_path,
      include_defaults: args.include_defaults,
      detect_cross_refs: args.detect_cross_refs,
    });
    const exec = await ctx.client.executePythonScript(script, true);
    const report = parsePythonReport<ScaffoldReport>(exec.stdout);

    if (report.fatal) return errorResult(`Scaffold failed: ${report.fatal}`);
    if (report.nodes.length === 0) {
      return errorResult(`No operators found under ${args.root_path} to scaffold as a recipe.`);
    }

    const warnings = [...(report.warnings ?? [])];
    warnings.push(
      "v1 does not capture glsl_uniforms, parameters, or controls — re-add by hand if needed.",
    );

    const connections = dedupeConnections(report.connections ?? []);

    const parsed = RecipeSchema.safeParse({
      id: args.id,
      name: args.name ?? args.id,
      description: args.description,
      tags: args.tags,
      difficulty: args.difficulty,
      nodes: report.nodes,
      connections,
      python_code:
        Object.keys(report.python_code ?? {}).length > 0 ? report.python_code : undefined,
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return errorResult(`Captured network is not a valid recipe: ${issues}`);
    }
    const recipe = parsed.data;

    let writtenPath: string | null = null;
    if (args.write_path && vault) {
      const rel = args.write_path;
      if (vault.exists(rel) && !args.overwrite) {
        return errorResult(`A file already exists at ${rel}. Pass overwrite:true to replace it.`);
      }
      vault.write(rel, `${JSON.stringify(recipe, null, 2)}\n`);
      writtenPath = rel;
    }

    const summary = writtenPath
      ? `Wrote recipe ${recipe.id} to ${writtenPath} (${recipe.nodes.length} node(s), ${recipe.connections.length} connection(s)).`
      : `Scaffolded recipe ${recipe.id} from ${args.root_path} (${recipe.nodes.length} node(s), ${recipe.connections.length} connection(s)).`;

    return jsonResult(summary, {
      recipe,
      path: writtenPath,
      nodes: recipe.nodes.length,
      connections: recipe.connections.length,
      cross_refs_detected: report.cross_refs ?? [],
      warnings,
    });
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }
}

export const registerScaffoldRecipeFromNetwork: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "scaffold_recipe_from_network",
    {
      title: "Scaffold a recipe from an existing TD network",
      description:
        "Inverse of apply_recipe: walk a COMP's child network in TouchDesigner and serialize it back to a draft RecipeSchema JSON (nodes + non-default parameters + connections + cross-references). " +
        "Validates against RecipeSchema before returning. When write_path is set, writes pretty JSON to that vault-relative path; otherwise returns the recipe in structuredContent. Read-only with respect to TD — no operators are created or modified.",
      inputSchema: scaffoldRecipeFromNetworkSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => scaffoldRecipeFromNetworkImpl(ctx, args),
  );
};
