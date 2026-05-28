import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const writeAgentGuideSchema = z.object({
  filename: z
    .string()
    .default("CLAUDE.md")
    .describe(
      "Name of the guide file to emit, e.g. CLAUDE.md or AGENTS.md. Defaults to CLAUDE.md.",
    ),
  output_dir: z
    .string()
    .optional()
    .describe(
      "Absolute path on the machine running TouchDesigner where the guide file should be written. " +
        "If omitted the guide is returned in the result but not written to disk.",
    ),
  path: z
    .string()
    .default("/project1")
    .describe(
      "TouchDesigner project/COMP path to summarise in the guide header, e.g. /project1. " +
        "A one-line dynamic summary (node count + top families) is prepended to the static body.",
    ),
});

export type WriteAgentGuideArgs = z.infer<typeof writeAgentGuideSchema>;

// ---------------------------------------------------------------------------
// Bridge — summary + optional write
// ---------------------------------------------------------------------------

interface AgentGuideReport {
  project_name: string;
  node_count: number;
  families: Record<string, number>;
  written: boolean;
  written_path?: string;
  warnings: string[];
  fatal?: string;
}

/**
 * One Python pass: walk the children of `path`, tally families, optionally
 * write the guide file.  All results land in the JSON report.
 */
const AGENT_GUIDE_SCRIPT = `
import json, base64, traceback, os
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"project_name": _p["path"], "node_count": 0, "families": {}, "written": False, "warnings": []}
try:
    _root = op(_p["path"])
    if _root is None:
        report["warnings"].append("Path not found: " + _p["path"])
    else:
        report["project_name"] = _root.name
        _children = _root.findChildren(depth=1) if hasattr(_root, "findChildren") else list(_root.children)
        report["node_count"] = len(_children)
        _fam = {}
        for _ch in _children:
            # op.family is already 'TOP'/'CHOP'/'SOP'/... — op.type is the short name
            # (e.g. 'noise'), which would never match a TOP/CHOP suffix and collapse to 'other'.
            _k = getattr(_ch, "family", None) or "other"
            _fam[_k] = _fam.get(_k, 0) + 1
        report["families"] = _fam
    _text = _p["guide_text"]
    _odir = _p.get("output_dir")
    _fn = _p.get("filename", "CLAUDE.md")
    if _odir:
        _dest = os.path.join(_odir, _fn)
        try:
            os.makedirs(_odir, exist_ok=True)
            with open(_dest, "w", encoding="utf-8") as _f:
                _f.write(_text)
            report["written"] = True
            report["written_path"] = _dest
        except Exception as _we:
            report["warnings"].append("Write failed: " + str(_we))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildWriteAgentGuideScript(payload: object): string {
  return buildPayloadScript(AGENT_GUIDE_SCRIPT, payload);
}

// ---------------------------------------------------------------------------
// Pure guide builder (exported for unit tests)
// ---------------------------------------------------------------------------

export interface AgentGuideSummary {
  project_name: string;
  node_count: number;
  families: Record<string, number>;
}

/**
 * Build the full agent-guide markdown from a dynamic project summary.
 * The summary is optional — if the bridge was offline we produce the guide
 * anyway (fail-forward) and note that the dynamic section is unavailable.
 */
export function buildAgentGuide(summary?: AgentGuideSummary): string {
  const BT = "`"; // single backtick — used inside template literal rows to avoid parse errors
  const BT3 = "```"; // triple backtick fence

  const projectLine = summary
    ? `> **Active project:** ${BT}${summary.project_name}${BT} — ` +
      `${summary.node_count} direct child node(s); ` +
      `families: ${
        Object.entries(summary.families)
          .sort((a, b) => b[1] - a[1])
          .map(([f, n]) => `${f}×${n}`)
          .join(", ") || "none"
      }.`
    : "> **Active project summary:** unavailable (TouchDesigner bridge was offline when the guide was generated).";

  const familyTable = [
    "| Family | Suffix | Purpose |",
    "|--------|--------|---------|",
    `| **TOP**  | ${BT}noiseTOP${BT}, ${BT}blurTOP${BT}, ...      | Texture / image processing (GPU) |`,
    `| **CHOP** | ${BT}audiodeviceinCHOP${BT}, ${BT}noiseCHOP${BT}, ... | Channel / audio data |`,
    `| **SOP**  | ${BT}boxSOP${BT}, ${BT}lineSOP${BT}, ...        | 3-D geometry |`,
    `| **MAT**  | ${BT}phongMAT${BT}, ${BT}glslMAT${BT}, ...      | Materials / shaders |`,
    `| **DAT**  | ${BT}textDAT${BT}, ${BT}scriptDAT${BT}, ...     | Data, tables, Python scripts |`,
    `| **COMP** | ${BT}baseCOMP${BT}, ${BT}containerCOMP${BT}, ... | Containers / components |`,
  ].join("\n");

  const renderTable = [
    "| Rule | Value / detail |",
    "|------|---------------|",
    `| **UV origin**          | **Bottom-left** — UV (0,0) is at the bottom-left of every TOP. Flip Y if you expect top-left convention. |`,
    `| **NDC range**          | -1 ... +1 on both axes |`,
    `| **Camera FOV**         | **Horizontal** — ${BT}fovx${BT} is the horizontal angle; the vertical angle derives from aspect ratio. |`,
    `| **Default resolution** | **1280 x 720** (HD 720p) unless the operator inherits from its input. |`,
    `| **Normalized colours** | 0.0 ... 1.0 float per channel (32-bit float TOPs by default). |`,
    `| **GLSL preamble**      | Do **not** declare ${BT}#version${BT}; TD injects it. Declare ${BT}out vec4 fragColor;${BT} — it is not built in. No built-in ${BT}uTime${BT}; use TD's ${BT}absTime.seconds${BT} via a uniform DAT or the provided ${BT}iGlobalTime${BT}. Beware preamble ${BT}#define${BT} collisions (F1, F2). |`,
    `| **Camera placement**   | For a full-body tracking view: ${BT}tz ≈ 4.6${BT} places a Render TOP camera far enough to see a standing person in 16:9 frame. |`,
  ].join("\n");

  const lookupTable = [
    "| What you need | Where to find it |",
    "|---------------|-----------------|",
    `| Valid operator types for a family             | ${BT}tdmcp://operators/TOP${BT}, ${BT}tdmcp://operators/CHOP${BT}, etc. |`,
    `| Full parameter list for a specific operator   | ${BT}search_operators${BT} tool -> pick the op -> ${BT}tdmcp://operators/<type>${BT} |`,
    `| Python class / method reference               | ${BT}tdmcp://classes/<ClassName>${BT} |`,
    `| GLSL snippets                                 | ${BT}tdmcp://patterns/glsl${BT} |`,
    `| Pre-built network templates                   | ${BT}tdmcp://recipes/<name>${BT} |`,
    `| Live project topology                         | ${BT}document_network${BT} or ${BT}snapshot_td_graph${BT} |`,
    `| Node errors                                   | ${BT}get_td_node_errors${BT} / ${BT}summarize_td_errors${BT} |`,
  ].join("\n");

  return `# Agent guide — tdmcp / TouchDesigner

${projectLine}

*Generated by ${BT}write_agent_guide${BT}. Re-run to refresh the project summary.*

---

## 1 — What tdmcp is

**tdmcp** is an MCP (Model Context Protocol) server for [TouchDesigner](https://derivative.ca/).
Three programs talk to each other on one machine:

${BT3}
MCP client --stdio/HTTP--> tdmcp server (Node/TS)  --HTTP REST--> TD bridge (Python, td/)
(Claude / Cursor / Codex)  tools + operator KB          runs inside TouchDesigner on :9980
${BT3}

The Node server exposes TouchDesigner **tools** and an embedded **operator knowledge base**
to an AI. The Python bridge running inside TD actually creates, connects, inspects, and
previews nodes. The server stays usable when TD is offline — tools return friendly errors.

---

## 2 — Operator families and conventions

TouchDesigner has six primary operator families. Every operator type ends with its family
suffix:

${familyTable}

### Picking the right tool altitude

1. **Layer-1 tools first.** Use ${BT}create_audio_reactive${BT}, ${BT}create_feedback_network${BT},
   ${BT}create_generative_art${BT}, etc. when you need a complete, wired sub-system. They
   auto-layout, expose controls, and capture a preview.
2. **Layer-2 for building blocks.** Use ${BT}connect_nodes${BT}, ${BT}create_control_panel${BT},
   ${BT}animate_parameter${BT}, ${BT}bind_to_channel${BT} when the Layer-1 tool is too opinionated.
3. **Layer-3 for atomic ops.** Drop to ${BT}create_td_node${BT}, ${BT}find_td_nodes${BT},
   ${BT}update_td_node_parameters${BT} only when you need fine-grained control.

### Golden rules

- **Never invent operator types.** Look up valid types in the knowledge base
  (${BT}tdmcp://operators/<family>${BT}) or search with ${BT}search_operators${BT}.
- **Check errors after every cook.** Always call ${BT}get_td_node_errors${BT} (or
  ${BT}summarize_td_errors${BT}) on the newly created node after it has a chance to cook —
  don't assume success from the create response alone.
- **Per-item failures go to warnings.** Reserve fatal errors for "nothing was done".
  Partial success (4 of 5 nodes connected) is more useful than an all-or-nothing abort.
- **No cross-container wires.** TouchDesigner cannot directly wire nodes across COMP
  boundaries — use a ${BT}selectTOP${BT} / ${BT}selectCHOP${BT} / ${BT}selectSOP${BT} to pull data in from
  another container.

---

## 3 — TouchDesigner render-coordinate rules

Agents that write GLSL shaders or position geometry must know these defaults:

${renderTable}

---

## 4 — The create -> verify -> preview loop

Every time you build or modify a network, close the loop:

${BT3}
create_td_node  (or layer-1/2 builder)
      |
      v
get_td_node_errors   <- cook happens here; check for red errors
      |
      +-- errors? -> fix parameters / rewire, then re-check
      |
      v
get_preview          <- capture a visual snapshot so the artist can see the result
${BT3}

Layer-1 tools run this loop automatically (create -> verify -> preview) and return
the preview image in the result. For Layer-2/3 work, run the loop yourself.

---

## 5 — Where to look things up

${lookupTable}

---

*End of guide — re-run ${BT}write_agent_guide${BT} any time to refresh the project summary.*
`;
}

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const writeAgentGuideOutputSchema = z.object({
  filename: z.string().describe("Name of the guide file."),
  written: z.boolean().describe("Whether the file was written to disk."),
  path: z.string().optional().describe("Absolute path the file was written to (if written)."),
  guide: z.string().describe("The full guide markdown text."),
});

// ---------------------------------------------------------------------------
// Helper: run one bridge script and return the parsed report, or undefined on
// any error (network / parse / TD fatal). This is the fail-forward wrapper: the
// guide is always emitted even when the bridge is unreachable.
// ---------------------------------------------------------------------------

async function tryBridgeReport(
  ctx: ToolContext,
  payload: object,
): Promise<AgentGuideReport | undefined> {
  try {
    const script = buildWriteAgentGuideScript(payload);
    const exec = await ctx.client.executePythonScript(script, true);
    const report = parsePythonReport<AgentGuideReport>(exec.stdout);
    return report;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function writeAgentGuideImpl(ctx: ToolContext, args: WriteAgentGuideArgs) {
  // ── Step 1: fetch the project summary via a bridge pass ──────────────────
  // This pass only FETCHES the project summary — it never writes (output_dir is
  // null), so there is no provisional file left behind if the single write below
  // later fails. Fail-forward: any bridge failure just leaves summary undefined
  // and we still produce the static guide.
  const firstReport = await tryBridgeReport(ctx, {
    path: args.path,
    guide_text: "",
    output_dir: null,
    filename: args.filename,
  });

  let summary: AgentGuideSummary | undefined;
  let written = false;
  let writtenPath: string | undefined;

  if (firstReport && !firstReport.fatal) {
    summary = {
      project_name: firstReport.project_name,
      node_count: firstReport.node_count,
      families: firstReport.families,
    };
  }

  // ── Step 2: build the real guide (with summary, if any) ──────────────────
  const guide = buildAgentGuide(summary);

  // ── Step 3: if output_dir is set, write the file once with the finalised
  //    guide text (the only write — the summary fetch above never writes). ─
  if (args.output_dir) {
    const writeReport = await tryBridgeReport(ctx, {
      path: args.path,
      guide_text: guide,
      output_dir: args.output_dir,
      filename: args.filename,
    });
    if (writeReport?.written && writeReport.written_path) {
      written = true;
      writtenPath = writeReport.written_path;
    }
  }

  // ── Step 4: build and return the structured result ────────────────────────
  const chars = guide.length;
  const wroteStr = written && writtenPath ? `, wrote to ${writtenPath}` : "";
  const summaryStr = summary
    ? `Generated agent guide (${chars} chars${wroteStr}).`
    : `Generated agent guide (${chars} chars, project summary unavailable${wroteStr}).`;

  const data: { filename: string; written: boolean; path?: string; guide: string } = {
    filename: args.filename,
    written,
    guide,
  };
  if (writtenPath) data.path = writtenPath;

  return structuredResult(summaryStr, data);
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerWriteAgentGuide: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "write_agent_guide",
    {
      title: "Write agent guide",
      description:
        "Emit a project-local CLAUDE.md / AGENTS.md seeded with tdmcp operator conventions and " +
        "TouchDesigner render-coordinate rules, so a future agent working on this project starts " +
        "with the right mental model. A small dynamic header (project name, node count, top families) " +
        "is prepended to a curated static body. Pass `output_dir` to also write the file to disk on " +
        "the machine running TouchDesigner. The guide is always returned in the structured result.",
      inputSchema: writeAgentGuideSchema.shape,
      outputSchema: writeAgentGuideOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => writeAgentGuideImpl(ctx, args),
  );
};
