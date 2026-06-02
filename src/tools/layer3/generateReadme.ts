import { z } from "zod";
import { capturePreview } from "../../feedback/previewCapture.js";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { buildDocument } from "./documentNetwork.js";

export const generateReadmeOutputSchema = z.object({
  markdown: z.string().describe("Full Markdown document."),
  node_count: z.number().describe("Total child nodes inspected."),
  families: z.record(z.string(), z.number()).describe("Node counts by operator family."),
  has_preview: z.boolean().describe("Whether a preview thumbnail was successfully embedded."),
});

export const generateReadmeSchema = z.object({
  path: z
    .string()
    .default("/project1")
    .describe("Path of the project or COMP to document (e.g. /project1 or /project1/myComp)."),
  title: z.string().optional().describe("Document title. Defaults to the COMP name when omitted."),
  include_preview: z
    .boolean()
    .default(true)
    .describe("Capture and embed a preview thumbnail of the output TOP as a base64 inline image."),
  include_mermaid: z
    .boolean()
    .default(false)
    .describe(
      "Embed a Mermaid flowchart block in the ## Data flow section. Off by default to keep output compact.",
    ),
  max_nodes: z
    .number()
    .int()
    .positive()
    .default(200)
    .describe(
      "Maximum child nodes to include in the Child inventory table. " +
        "Nodes beyond this limit are omitted and a note is appended. Default 200.",
    ),
});
type GenerateReadmeArgs = z.infer<typeof generateReadmeSchema>;

export interface ReadmeNode {
  path: string;
  name: string;
  type: string;
  family: string;
}

export interface ReadmeCustomParam {
  comp: string;
  name: string;
  label: string;
  value: string;
  style: string;
}

export interface ReadmeIo {
  inputs: string[];
  outputs: string[];
}

export interface ReadmeFileDep {
  path: string;
  par: string;
  file: string;
  exists: boolean;
}

export interface ReadmeReport {
  title_default: string;
  node_count: number;
  nodes: ReadmeNode[];
  custom_params: ReadmeCustomParam[];
  io: ReadmeIo;
  file_deps: ReadmeFileDep[];
  output_top: string | null;
  warnings: string[];
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Python script that gathers everything in ONE pass inside TD.
// Each section is in its own try/except so a single failure can't drop the
// whole report — the failure lands in warnings[] instead.
// ---------------------------------------------------------------------------
const README_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
_root = op(_p["path"])
report = {
    "title_default": _root.name if _root else _p["path"].split("/")[-1],
    "node_count": 0,
    "nodes": [],
    "custom_params": [],
    "io": {"inputs": [], "outputs": []},
    "file_deps": [],
    "output_top": None,
    "warnings": [],
}
try:
    if _root is None:
        report["fatal"] = "COMP not found: " + _p["path"]
        print(json.dumps(report)); raise SystemExit
    _children = list(_root.children)
    report["node_count"] = len(_children)
    _tops = []
    for _c in _children:
        try:
            # op.type is the short name ("noise"); op.family is the family ("TOP") and op.OPType
            # is the full family-suffixed type ("noiseTOP"). Use family directly, and report the
            # full OPType so buildDocument's suffix-based classifier and the inventory both read it.
            _fam = getattr(_c, "family", None) or "other"
            _otype = getattr(_c, "OPType", None) or _c.type
            report["nodes"].append({"path": _c.path, "name": _c.name, "type": _otype, "family": _fam})
            if _fam == "TOP":
                _tops.append(_c)
        except Exception:
            report["warnings"].append("node-enum: " + traceback.format_exc().splitlines()[-1])
    # custom params
    try:
        for _c in _children:
            # Guard per-node: customPars exists on most ops, but a single node that
            # lacks it (or errors) must not abort the scan and lose every COMP's params.
            try:
                _cpars = getattr(_c, "customPars", None) or []
            except Exception:
                _cpars = []
            for _par in _cpars:
                try:
                    _val = ""
                    try: _val = str(_par.eval())
                    except Exception: _val = str(_par.val)
                    report["custom_params"].append({
                        "comp": _c.name,
                        "name": _par.name,
                        "label": _par.label,
                        "value": _val,
                        "style": _par.style,
                    })
                except Exception:
                    report["warnings"].append("custom-par: " + traceback.format_exc().splitlines()[-1])
    except Exception:
        report["warnings"].append("custom-params-block: " + traceback.format_exc().splitlines()[-1])
    # I/O terminals: a node is a network *input* (source) when it has input connectors
    # none of which are wired, and a network *output* (sink) when it has output
    # connectors none of which are wired. (op.inputs/op.outputs are empty lists when
    # unconnected, so iterating them never fires — inspect the connectors' state instead.)
    try:
        for _c in _children:
            try:
                _in_cons = getattr(_c, "inputConnectors", None) or []
                if _in_cons and all(len(_k.connections) == 0 for _k in _in_cons):
                    report["io"]["inputs"].append(_c.name)
            except Exception:
                pass
            try:
                _out_cons = getattr(_c, "outputConnectors", None) or []
                if _out_cons and all(len(_k.connections) == 0 for _k in _out_cons):
                    report["io"]["outputs"].append(_c.name)
            except Exception:
                pass
    except Exception:
        report["warnings"].append("io-block: " + traceback.format_exc().splitlines()[-1])
    # file deps
    try:
        for _c in _children:
            try:
                for _par in _c.pars():
                    try:
                        if _par.isFile and str(_par.val).strip():
                            import os as _os
                            _fval = str(_par.val)
                            report["file_deps"].append({
                                "path": _c.path,
                                "par": _par.name,
                                "file": _fval,
                                "exists": _os.path.isfile(_fval),
                            })
                    except Exception:
                        pass
            except Exception:
                report["warnings"].append("file-deps-node: " + traceback.format_exc().splitlines()[-1])
    except Exception:
        report["warnings"].append("file-deps-block: " + traceback.format_exc().splitlines()[-1])
    # output TOP: first out*/null* TOP, else last TOP
    try:
        _out_top = None
        for _t in _tops:
            if _t.name.startswith("out") or _t.name.startswith("null"):
                _out_top = _t.path; break
        if _out_top is None and _tops:
            _out_top = _tops[-1].path
        report["output_top"] = _out_top
    except Exception:
        report["warnings"].append("output-top: " + traceback.format_exc().splitlines()[-1])
except SystemExit:
    pass
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildGenerateReadmeScript(payload: object): string {
  return buildPayloadScript(README_SCRIPT, payload);
}

// ---------------------------------------------------------------------------
// Pure markdown builder — no TD calls, fully unit-testable.
// ---------------------------------------------------------------------------

export interface BuildReadmeOpts {
  title?: string;
  includeMermaid?: boolean;
  /** Cap on child nodes shown in the inventory table. Nodes beyond this are omitted with a note. */
  maxNodes?: number;
}

export function buildReadme(report: ReadmeReport, opts: BuildReadmeOpts = {}): string {
  const title = opts.title ?? report.title_default;
  const doc = buildDocument(
    report.nodes.length > 0
      ? report.nodes[0]?.path.split("/").slice(0, -1).join("/") || "/project1"
      : "/project1",
    report.nodes,
    [], // connections not available from the Python pass; omit edges
  );

  const lines: string[] = [];

  // H1 title
  lines.push(`# ${title}`, "");

  // Overview
  lines.push(
    `**Nodes:** ${report.node_count}  **Families:** ${
      Object.entries(doc.families)
        .map(([f, n]) => `${f}×${n}`)
        .join(", ") || "—"
    }`,
    "",
  );

  // Families table
  if (Object.keys(doc.families).length > 0) {
    lines.push("## Families", "");
    lines.push("| Family | Count |");
    lines.push("|--------|-------|");
    for (const [fam, count] of Object.entries(doc.families).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${fam} | ${count} |`);
    }
    lines.push("");
  }

  // Top types
  if (doc.top_types.length > 0) {
    lines.push(`**Top operator types:** ${doc.top_types.join(", ")}`, "");
  }

  // Mermaid (optional — skip when no connections known)
  if (opts.includeMermaid && report.nodes.length > 0) {
    lines.push("## Data flow", "");
    lines.push("```mermaid");
    lines.push(doc.mermaid);
    lines.push("```", "");
  }

  // Custom parameters table
  if (report.custom_params.length > 0) {
    lines.push("## Custom parameters", "");
    lines.push("| Comp | Name | Label | Value | Style |");
    lines.push("|------|------|-------|-------|-------|");
    for (const p of report.custom_params) {
      const safe = (s: string) => s.replace(/\|/g, "\\|");
      lines.push(
        `| ${safe(p.comp)} | ${safe(p.name)} | ${safe(p.label)} | ${safe(p.value)} | ${safe(p.style)} |`,
      );
    }
    lines.push("");
  }

  // Inputs / Outputs
  lines.push("## Inputs / Outputs", "");
  if (report.io.inputs.length > 0) {
    lines.push(`**Inputs:** ${report.io.inputs.join(", ")}`);
  } else {
    lines.push("**Inputs:** none detected");
  }
  if (report.io.outputs.length > 0) {
    lines.push(`**Outputs:** ${report.io.outputs.join(", ")}`);
  } else {
    lines.push("**Outputs:** none detected");
  }
  lines.push("");

  // Child inventory
  if (report.nodes.length > 0) {
    const cap = opts.maxNodes ?? 200;
    const visibleNodes = report.nodes.slice(0, cap);
    const truncated = report.nodes.length - visibleNodes.length;
    lines.push("## Child inventory", "");
    lines.push("| Name | Type |");
    lines.push("|------|------|");
    for (const n of visibleNodes) {
      lines.push(`| ${n.name} | ${n.type} |`);
    }
    if (truncated > 0) {
      lines.push(`| … | _${truncated} more nodes not shown_ |`);
    }
    lines.push("");
  }

  // External file dependencies
  if (report.file_deps.length > 0) {
    lines.push("## External files", "");
    lines.push("| File | Parameter | Exists |");
    lines.push("|------|-----------|--------|");
    for (const d of report.file_deps) {
      const exists = d.exists ? "yes" : "**missing**";
      lines.push(`| ${d.file.replace(/\|/g, "\\|")} | ${d.par} | ${exists} |`);
    }
    lines.push("");
  }

  // Warnings
  if (report.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const w of report.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function generateReadmeImpl(ctx: ToolContext, args: GenerateReadmeArgs) {
  let report: ReadmeReport;
  try {
    const script = buildGenerateReadmeScript({ path: args.path });
    const exec = await ctx.client.executePythonScript(script, true);
    report = parsePythonReport<ReadmeReport>(exec.stdout);
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }

  if (report.fatal) {
    return errorResult(`generate_readme failed: ${report.fatal}`, report);
  }

  let markdown = buildReadme(report, {
    title: args.title,
    includeMermaid: args.include_mermaid,
    maxNodes: args.max_nodes,
  });
  let hasPreview = false;

  // Preview section — fail-forward: a broken preview should not fail the whole tool.
  if (args.include_preview && report.output_top) {
    try {
      const preview = await capturePreview(ctx.client, report.output_top);
      markdown += `## Preview\n\n![preview](data:${preview.mimeType};base64,${preview.base64})\n`;
      hasPreview = true;
    } catch {
      markdown += `## Preview\n\n_Preview capture failed for \`${report.output_top}\`._\n`;
    }
  }

  const families = buildDocument(args.path, report.nodes, []).families;
  const summary = `Generated README for ${args.path} (${report.node_count} nodes, ${markdown.length} chars).`;

  return structuredResult(summary, {
    markdown,
    node_count: report.node_count,
    families,
    has_preview: hasPreview,
  });
}

export const registerGenerateReadme: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "generate_readme",
    {
      title: "Generate project README",
      description:
        "Produce a Markdown project document for any COMP or project: family/type counts, custom-parameter table, inputs/outputs, child inventory, external file dependencies, and an optional preview thumbnail of the output TOP. Use `include_mermaid` to add a Mermaid flowchart and `max_nodes` to cap large inventories. Returns the full Markdown on the structured channel under `markdown`.",
      inputSchema: generateReadmeSchema.shape,
      outputSchema: generateReadmeOutputSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => generateReadmeImpl(ctx, args),
  );
};
