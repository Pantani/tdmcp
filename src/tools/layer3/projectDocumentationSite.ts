import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { capturePreview } from "../../feedback/previewCapture.js";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const projectDocumentationSiteSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("The network to document (project or COMP), e.g. /project1 or /project1/myComp."),
  out_dir: z
    .string()
    .describe("Folder to write the documentation package into (relative or absolute)."),
  title: z
    .string()
    .default("")
    .describe("Document title. Defaults to the basename of parent_path when blank."),
  include_thumbnails: z
    .boolean()
    .default(false)
    .describe("Capture preview PNGs of output TOPs into thumbs/ and link them in gallery.md."),
  max_thumbnails: z.coerce
    .number()
    .int()
    .min(0)
    .default(6)
    .describe("Maximum number of output-TOP previews to capture when include_thumbnails is set."),
});
type ProjectDocumentationSiteArgs = z.infer<typeof projectDocumentationSiteSchema>;

export interface DocSiteNode {
  path: string;
  type: string;
  name: string;
}

export interface DocSiteConnection {
  source_path: string;
  target_path: string;
}

export interface DocSiteReport {
  nodes: DocSiteNode[];
  connections: DocSiteConnection[];
  warnings: string[];
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Python script: walk the subtree in ONE pass inside TD and report nodes +
// connections. Mirrors the bridge's get_network_topology connector walk
// (child.inputConnectors -> .connections -> cab.outOP.path), so the edge data
// matches what document_network/generate_readme already rely on. Every section
// is guarded so a single bad node lands in warnings[] instead of dropping the
// whole report.
// ---------------------------------------------------------------------------
const DOC_SITE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"nodes": [], "connections": [], "warnings": []}
try:
    _root = op(_p["parent_path"])
    if _root is None:
        report["fatal"] = "Network not found: " + str(_p["parent_path"])
        print(json.dumps(report)); raise SystemExit
    _children = list(_root.children)
    for _c in _children:
        try:
            _otype = getattr(_c, "OPType", None) or _c.type
            report["nodes"].append({"path": _c.path, "type": _otype, "name": _c.name})
        except Exception:
            report["warnings"].append("node-enum: " + traceback.format_exc().splitlines()[-1])
    for _c in _children:
        try:
            for _inconn in getattr(_c, "inputConnectors", None) or []:
                for _cab in _inconn.connections:
                    try:
                        _src = _cab.outOP
                        if _src is not None:
                            report["connections"].append({
                                "source_path": _src.path,
                                "target_path": _c.path,
                            })
                    except Exception:
                        report["warnings"].append("conn: " + traceback.format_exc().splitlines()[-1])
        except Exception:
            report["warnings"].append("conn-node: " + traceback.format_exc().splitlines()[-1])
except SystemExit:
    pass
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildDocSiteScript(payload: object): string {
  return buildPayloadScript(DOC_SITE_SCRIPT, payload);
}

// ---------------------------------------------------------------------------
// Pure composers - no TD calls, fully unit-testable.
// ---------------------------------------------------------------------------

/** Operator family from a type like 'noiseTOP' -> 'TOP'. */
function family(type: string): string {
  const m = /(TOP|CHOP|SOP|COMP|DAT|MAT|POP)$/.exec(type);
  return m?.[1] ?? "other";
}

/** Counts nodes by operator family, descending. */
export function countFamilies(nodes: DocSiteNode[]): Array<[string, number]> {
  const byFamily: Record<string, number> = {};
  for (const n of nodes) {
    byFamily[family(n.type)] = (byFamily[family(n.type)] ?? 0) + 1;
  }
  return Object.entries(byFamily).sort((a, b) => b[1] - a[1]);
}

/** Output TOPs to thumbnail: those named out.../null... first, then any remaining TOPs. */
export function pickOutputTops(nodes: DocSiteNode[], max: number): DocSiteNode[] {
  if (max <= 0) return [];
  const tops = nodes.filter((n) => family(n.type) === "TOP");
  const preferred = tops.filter((n) => n.name.startsWith("out") || n.name.startsWith("null"));
  const rest = tops.filter((n) => !preferred.includes(n));
  return [...preferred, ...rest].slice(0, max);
}

/** Builds the README.md body. */
export function buildReadmeMd(report: DocSiteReport, title: string): string {
  const families = countFamilies(report.nodes);
  const familySummary = families.map(([f, n]) => `${f}x${n}`).join(", ") || "none";
  const lines: string[] = [`# ${title}`, ""];
  lines.push(
    `**Nodes:** ${report.nodes.length}  **Connections:** ${report.connections.length}`,
    "",
  );
  lines.push(`**Families:** ${familySummary}`, "");

  if (families.length > 0) {
    lines.push("## Families", "");
    lines.push("| Family | Count |");
    lines.push("|--------|-------|");
    for (const [fam, count] of families) {
      lines.push(`| ${fam} | ${count} |`);
    }
    lines.push("");
  }

  if (report.nodes.length > 0) {
    lines.push("## Nodes", "");
    lines.push("| Name | Type |");
    lines.push("|------|------|");
    for (const n of report.nodes) {
      const safe = (s: string) => s.replace(/\|/g, "\\|");
      lines.push(`| ${safe(n.name)} | ${safe(n.type)} |`);
    }
    lines.push("");
  }

  lines.push("## How to load", "");
  lines.push(
    "Open this project in TouchDesigner, or drag the saved `.tox` into a network. See",
    "`topology.md` for the data-flow diagram and `gallery.md` (when present) for previews.",
    "",
  );

  if (report.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const w of report.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Builds the topology.md body as a Mermaid `graph LR`. Deterministic. */
export function buildTopologyMd(report: DocSiteReport, title: string): string {
  const id = new Map<string, string>();
  report.nodes.forEach((n, i) => {
    id.set(n.path, `n${i}`);
  });

  const lines: string[] = [`# ${title} - topology`, "", "```mermaid", "graph LR"];
  for (const n of report.nodes) {
    const label = `${n.name} (${n.type})`.replace(/"/g, "'");
    lines.push(`  ${id.get(n.path)}["${label}"]`);
  }
  for (const c of report.connections) {
    const from = id.get(c.source_path);
    const to = id.get(c.target_path);
    if (from && to) lines.push(`  ${from} --> ${to}`);
  }
  lines.push("```", "");
  return lines.join("\n");
}

/** Builds the gallery.md body linking the captured thumbnails. */
export function buildGalleryMd(
  title: string,
  thumbs: Array<{ name: string; file: string }>,
): string {
  const lines: string[] = [`# ${title} - gallery`, ""];
  if (thumbs.length === 0) {
    lines.push("_No previews were captured._", "");
    return lines.join("\n");
  }
  for (const t of thumbs) {
    lines.push(`## ${t.name}`, "", `![${t.name}](${t.file})`, "");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function projectDocumentationSiteImpl(
  ctx: ToolContext,
  args: ProjectDocumentationSiteArgs,
) {
  let report: DocSiteReport;
  try {
    const script = buildDocSiteScript({ parent_path: args.parent_path });
    const exec = await ctx.client.executePythonScript(script, true);
    report = parsePythonReport<DocSiteReport>(exec.stdout);
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }

  if (report.fatal) {
    return errorResult(`project_documentation_site failed: ${report.fatal}`, report);
  }

  const title = args.title.trim() || basename(args.parent_path) || "project";
  const outDir = resolve(args.out_dir);
  const warnings = [...report.warnings];
  const filesWritten: string[] = [];

  // Guard the folder creation itself - without it no file can be written.
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (err) {
    return errorResult(
      `Failed to create out_dir ${outDir}: ${err instanceof Error ? err.message : String(err)}`,
      report,
    );
  }

  // README.md + topology.md - guard each so a single write failure is a warning,
  // not a hard stop, leaving any file that did write usable.
  const writeFile = (rel: string, body: string): void => {
    const target = join(outDir, rel);
    try {
      writeFileSync(target, body, "utf8");
      filesWritten.push(rel);
    } catch (err) {
      warnings.push(`write ${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  writeFile("README.md", buildReadmeMd(report, title));
  writeFile("topology.md", buildTopologyMd(report, title));

  // Thumbnails - fail-forward: a broken preview must not fail the package.
  const thumbnails: string[] = [];
  if (args.include_thumbnails) {
    const targets = pickOutputTops(report.nodes, args.max_thumbnails);
    if (targets.length > 0) {
      const thumbsDir = join(outDir, "thumbs");
      try {
        mkdirSync(thumbsDir, { recursive: true });
      } catch (err) {
        warnings.push(`thumbs dir: ${err instanceof Error ? err.message : String(err)}`);
      }
      const gallery: Array<{ name: string; file: string }> = [];
      for (const node of targets) {
        try {
          const preview = await capturePreview(ctx.client, node.path);
          const rel = `thumbs/${node.name}.png`;
          writeFileSync(join(outDir, rel), Buffer.from(preview.base64, "base64"));
          filesWritten.push(rel);
          thumbnails.push(rel);
          gallery.push({ name: node.name, file: `${node.name}.png` });
        } catch (err) {
          warnings.push(
            `thumbnail ${node.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      writeFile("gallery.md", buildGalleryMd(title, gallery));
    } else {
      warnings.push("No output TOPs found to thumbnail.");
    }
  }

  const result = {
    out_dir: outDir,
    files_written: filesWritten,
    node_count: report.nodes.length,
    thumbnails,
    warnings,
    ...(filesWritten.length === 0 ? { fatal: "No documentation files could be written." } : {}),
  };

  if (filesWritten.length === 0) {
    return errorResult("project_documentation_site wrote no files.", result);
  }

  const summary = `Wrote ${filesWritten.length} file(s) for ${args.parent_path} (${report.nodes.length} nodes${
    thumbnails.length > 0 ? `, ${thumbnails.length} thumbnail(s)` : ""
  }) into ${outDir}.`;
  return jsonResult(summary, result);
}

export const registerProjectDocumentationSite: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "project_documentation_site",
    {
      title: "Project documentation site",
      description:
        "Compose a one-folder handoff/portfolio documentation PACKAGE for a network: a README.md (title, node count, per-family summary, how-to-load note), a topology.md with a Mermaid graph of the connections, and - when include_thumbnails is set - preview PNGs of output TOPs under thumbs/ linked from gallery.md, all written into out_dir. Unlike generate_readme (a single file), this assembles a small multi-file site folder for sharing or archiving a project.",
      inputSchema: projectDocumentationSiteSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => projectDocumentationSiteImpl(ctx, args),
  );
};
