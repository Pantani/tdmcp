import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const opSpecSchema = z.object({
  type: z
    .string()
    .regex(/CHOP$/i, "Operator type must end with 'CHOP' (e.g. mathCHOP, lagCHOP).")
    .describe(
      "CHOP operator type (e.g. `audiofileinCHOP`, `mathCHOP`, `lagCHOP`, `filterCHOP`, `nullCHOP`). Must end with `CHOP`.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "Optional explicit node name. Defaults to '<name>_<i>_<typeStem>' (the type with trailing CHOP stripped).",
    ),
  params: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .optional()
    .describe(
      "Parameter name → value map applied after creation. A string value matching an earlier op's name resolves to that op's absolute path.",
    ),
});

export const buildChopChainSchema = z.object({
  parent: z.string().default("/project1").describe("Parent component path. Defaults to /project1."),
  name: z
    .string()
    .describe(
      "Base name for the chain; used as a name prefix when ops omit `name`, and as the chain's reported id.",
    ),
  ops: z
    .array(opSpecSchema)
    .min(1)
    .describe("Ordered list of CHOPs. Each op[i] is wired output 0 → input 0 of op[i+1]."),
});
export type BuildChopChainArgs = z.infer<typeof buildChopChainSchema>;

interface ChainReport {
  container: string;
  created: Array<{ name: string; path: string; type: string }>;
  output_path: string | null;
  warnings: string[];
  fatal?: string;
}

// One Python pass: create each CHOP via getattr(td, type), apply params (with
// sibling-name → path resolution), wire prev→this on input 0. Per-op failures
// become warnings (fail-forward) so a partial chain still returns useful info.
const CHAIN_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"container": _p["parent"], "created": [], "output_path": None, "warnings": []}

_parent = op(_p["parent"])
try:
    if _parent is None:
        report["fatal"] = "Parent not found: " + _p["parent"]
    else:
        report["container"] = _parent.path
        _created = []
        _name_to_path = {}
        for _i, _spec in enumerate(_p["ops"]):
            _typ = _spec["type"]
            _stem = _typ
            if _stem.lower().endswith("chop"):
                _stem = _stem[:-4]
            _nm = _spec.get("name") or ("%s_%d_%s" % (_p["name"], _i, _stem))
            _node = None
            try:
                _cls = getattr(td, _typ)
                _node = _parent.create(_cls, _nm)
            except Exception:
                report["warnings"].append("create[%d] %s failed: %s" % (_i, _typ, traceback.format_exc().splitlines()[-1]))
                _created.append(None)
                continue
            _entry = {"name": _node.name, "path": _node.path, "type": _node.OPType}
            _created.append(_entry)
            report["created"].append(_entry)
            _name_to_path[_node.name] = _node.path

            for _pname, _pval in (_spec.get("params") or {}).items():
                try:
                    _v = _pval
                    if isinstance(_v, str) and _v in _name_to_path:
                        _v = _name_to_path[_v]
                    _node.par[_pname].val = _v
                except Exception:
                    report["warnings"].append("param[%d].%s failed: %s" % (_i, _pname, traceback.format_exc().splitlines()[-1]))

            if _i > 0 and _created[_i - 1] is not None:
                try:
                    _prev = op(_created[_i - 1]["path"])
                    _node.inputConnectors[0].connect(_prev.outputConnectors[0])
                except Exception:
                    report["warnings"].append("connect[%d->%d] failed: %s" % (_i - 1, _i, traceback.format_exc().splitlines()[-1]))

        if _created and _created[-1] is not None:
            report["output_path"] = _created[-1]["path"]
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildChainScript(payload: object): string {
  return buildPayloadScript(CHAIN_SCRIPT, payload);
}

export async function buildChopChainImpl(ctx: ToolContext, args: BuildChopChainArgs) {
  return guardTd(
    async () => {
      const script = buildChainScript({
        parent: args.parent,
        name: args.name,
        ops: args.ops,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ChainReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build CHOP chain: ${report.fatal}`, report);
      }
      const summary = `Built CHOP chain "${args.name}" under ${report.container}: ${report.created.length}/${args.ops.length} op(s) created${
        report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""
      }${report.output_path ? `, output ${report.output_path}` : ""}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerBuildChopChain: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "build_chop_chain",
    {
      title: "Build CHOP chain",
      description:
        "Declarative Layer-2 builder for an ordered CHOP processing chain. Pass an `ops` list (type + optional name + optional params); each op[i] is wired output 0 → input 0 of op[i+1] under `parent` (default `/project1`). Per-op create/param/connect failures become warnings (fail-forward) — a partial chain still returns useful info. Tip: end the chain in a `nullCHOP` to make it `bind_to_channel`-ready.",
      inputSchema: buildChopChainSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => buildChopChainImpl(ctx, args),
  );
};
