import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requireVault } from "./shared.js";

/**
 * `tutorial_companion_pack` — scaffold a teaching/selling companion for a build:
 * a Markdown lesson plan + annotated topology snapshot + previews of any output
 * TOPs found inside the COMP. Writes into `<vault>/<folder>/<slug>/` (folder
 * defaults to "Tutorials" but is user-configurable via the `folder` arg) with:
 *   - tutorial.md (steps + node list + embedded preview links)
 *   - topology.json (full node/connection dump from get_network_topology)
 *   - previews/*.png (per-output-TOP base64 PNG decoded to disk)
 *   - network_snapshot.json (a documentary snapshot of the COMP's children and
 *     connections by TD path — NOT a RecipeSchema-compatible installable
 *     recipe; the captured topology references absolute TD paths that can't
 *     always be re-instantiated. Use it as reference, not as `apply_recipe`
 *     input.)
 *
 * Composes existing read-only bridge calls. Vault-gated.
 */

export const tutorialCompanionPackSchema = z.object({
  source_comp: z.string().describe("COMP whose contents are the subject of the tutorial."),
  name: z.string().optional().describe("Pack name; defaults to the COMP's name."),
  folder: z.string().default("Tutorials").describe("Vault subfolder for the pack."),
  lesson_count: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Number of lesson steps to scaffold (1..20)."),
  preview_width: z.coerce.number().int().positive().max(2048).default(480),
  preview_height: z.coerce.number().int().positive().max(2048).default(270),
  description: z.string().optional().describe("One-paragraph human description for the lesson."),
  tags: z.array(z.string()).default([]).describe("Tags written to the pack's frontmatter."),
});
export type TutorialCompanionPackArgs = z.infer<typeof tutorialCompanionPackSchema>;

function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "tutorial";
}

function buildLessonSteps(
  nodeCount: number,
  outputs: string[],
  lessonCount: number,
): Array<{ title: string; body: string }> {
  // Deterministic, content-aware scaffold — the artist will edit these.
  const steps: Array<{ title: string; body: string }> = [];
  const intros = [
    "Survey the patch",
    "Wire the core chain",
    "Tune the look",
    "Bind a control",
    "Render the output",
    "Polish the timing",
    "Add a variation",
    "Save your preset",
  ];
  for (let i = 0; i < lessonCount; i++) {
    const title = `${i + 1}. ${intros[i % intros.length]}`;
    const body =
      i === 0
        ? `This patch has ${nodeCount} nodes. Open the COMP and walk the network left→right; note where each operator family changes (TOP → CHOP → SOP). The output(s) under study: ${outputs.join(", ") || "(none yet)"}.`
        : i === lessonCount - 1
          ? "Capture a preview of the final output, save your settings as a preset, and write down one variation you'd like to try next."
          : "Pick the next operator along the chain, identify its 2-3 most important parameters, and experiment until the change you make is visible in the output preview.";
    steps.push({ title, body });
  }
  return steps;
}

interface TutorialPackReport {
  source_comp: string;
  pack_path: string;
  tutorial_path: string;
  topology_path: string;
  network_snapshot_path: string;
  previews: Array<{ source_top: string; file: string; width: number; height: number }>;
  node_count: number;
  warnings: string[];
}

export async function tutorialCompanionPackImpl(ctx: ToolContext, args: TutorialCompanionPackArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const fallback = args.source_comp.split("/").filter(Boolean).pop() ?? "tutorial";
  const name = args.name ?? fallback;
  const stem = slugify(name);
  const packRel = `${args.folder}/${stem}`;
  const warnings: string[] = [];

  try {
    const topology = await ctx.client.getNetworkTopology(args.source_comp, true);
    const nodes = topology.nodes;
    const connections = topology.connections;

    // Find output-ish TOPs inside the COMP (heuristic: nullTOP/outTOP, or any
    // TOP named like "out*"/"output"). Fall back to the first TOP if nothing matches.
    const tops = nodes.filter((n) => /TOP$/.test(n.type));
    const outputs = tops.filter(
      (n) => /out|null/i.test(n.name) || ["outTOP", "nullTOP"].includes(n.type),
    );
    const outputCandidates = outputs.length ? outputs : tops.slice(0, 1);

    // Capture previews for up to 4 outputs.
    const previews: TutorialPackReport["previews"] = [];
    for (const out of outputCandidates.slice(0, 4)) {
      try {
        const preview = await ctx.client.getPreview(
          out.path,
          args.preview_width,
          args.preview_height,
        );
        const pngRel = `${packRel}/previews/${slugify(out.name)}.png`;
        try {
          vault.writeBinary(pngRel, Buffer.from(preview.base64 ?? "", "base64"));
          previews.push({
            source_top: out.path,
            file: `previews/${slugify(out.name)}.png`,
            width: preview.width,
            height: preview.height,
          });
        } catch (err) {
          warnings.push(
            `Could not write preview for ${out.path}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      } catch (err) {
        warnings.push(
          `Preview failed for ${out.path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Lesson steps.
    const steps = buildLessonSteps(
      nodes.length,
      outputCandidates.map((o) => o.path),
      args.lesson_count,
    );

    // tutorial.md body.
    const previewSection = previews.length
      ? `\n## Previews\n\n${previews.map((p) => `![${p.source_top}](${p.file})`).join("\n\n")}\n`
      : "";
    const nodeSection = `\n## Nodes (${nodes.length})\n\n${nodes
      .slice(0, 40)
      .map((n) => `- \`${n.path}\` — \`${n.type}\``)
      .join("\n")}${nodes.length > 40 ? `\n- … ${nodes.length - 40} more` : ""}\n`;
    const stepSection = `\n## Lesson steps\n\n${steps
      .map((s) => `### ${s.title}\n\n${s.body}\n`)
      .join("\n")}`;
    const intro = args.description
      ? `${args.description}\n`
      : `A short lesson built around \`${args.source_comp}\`. Walk the network, tune one operator per step, and watch the output preview change.\n`;
    const snapshotNote =
      "\n## Files\n\n" +
      "- `topology.json` — raw `get_network_topology` dump.\n" +
      "- `network_snapshot.json` — documentary snapshot of nodes + connections by TD path. " +
      "**Not an installable recipe** (not `RecipeSchema`-compatible); for reference only, " +
      "not for `apply_recipe`.\n";
    const body = `# ${name}\n\n${intro}${stepSection}${previewSection}${nodeSection}${snapshotNote}`;

    const frontmatter: Record<string, unknown> = {
      id: stem,
      type: "tutorial",
      name,
      source_comp: args.source_comp,
      lesson_count: steps.length,
      node_count: nodes.length,
      previews: previews.map((p) => p.file),
      tags: Array.from(new Set(["tutorial", ...(args.tags ?? [])])),
      created: new Date().toISOString(),
    };
    if (args.description) frontmatter.description = args.description;

    const tutorialRel = `${packRel}/tutorial.md`;
    const topologyRel = `${packRel}/topology.json`;
    const snapshotRel = `${packRel}/network_snapshot.json`;

    try {
      vault.writeNote(tutorialRel, frontmatter, body);
      vault.write(
        topologyRel,
        `${JSON.stringify({ source_comp: args.source_comp, nodes, connections }, null, 2)}\n`,
      );
      // Documentary snapshot — NOT a RecipeSchema-compatible installable recipe.
      // Captured topology references absolute TD paths and cannot always be
      // re-instantiated by `apply_recipe`; use for reference only.
      const networkSnapshot = {
        kind: "network_snapshot",
        id: stem,
        name,
        description: args.description ?? `Snapshot captured from ${args.source_comp}.`,
        source_comp: args.source_comp,
        captured_at: new Date().toISOString(),
        nodes: nodes.map((n) => ({
          name: n.name,
          type: n.type,
          source_path: n.path,
        })),
        connections: connections.map((c) => ({
          from_path: c.source_path,
          to_path: c.target_path,
          to_input: c.target_input ?? 0,
        })),
      };
      vault.write(snapshotRel, `${JSON.stringify(networkSnapshot, null, 2)}\n`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return errorResult(`Could not write tutorial pack files: ${reason}`);
    }

    const report: TutorialPackReport = {
      source_comp: args.source_comp,
      pack_path: packRel,
      tutorial_path: tutorialRel,
      topology_path: topologyRel,
      network_snapshot_path: snapshotRel,
      previews,
      node_count: nodes.length,
      warnings,
    };
    return jsonResult(
      `Scaffolded tutorial pack "${name}" (${steps.length} steps, ${previews.length} previews) at ${packRel}.`,
      report,
    );
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }
}

export const registerTutorialCompanionPack: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "tutorial_companion_pack",
    {
      title: "Scaffold a teaching companion pack from a COMP",
      description:
        "Build a teaching/selling companion for a network: snapshot the COMP's topology, capture preview PNGs of its output TOPs, scaffold an N-step lesson plan in Markdown, and emit a documentary network snapshot. Writes into `<vault>/<folder>/<slug>/` as `tutorial.md` + `topology.json` + `network_snapshot.json` + `previews/*.png`. The snapshot captures nodes + connections by TD path for reference only — it is not a `RecipeSchema`-compatible installable recipe. Composes existing read-only bridge calls — the artist edits the lesson body afterwards. Requires TDMCP_VAULT_PATH and a running TouchDesigner bridge.",
      inputSchema: tutorialCompanionPackSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => tutorialCompanionPackImpl(ctx, args),
  );
};
