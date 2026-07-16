import { randomUUID } from "node:crypto";
import { z } from "zod";
import { planAnnotationAwareLayout } from "../annotationAwareLayout.js";
import {
  buildRepositionRequest,
  canonicalizeExplicitPlacement,
  explicitPositionsSchema,
} from "../explicitPlacement.js";
import { computeLayoutByParent, layoutScript } from "../layout.js";
import { guardTd, jsonResult, jsonStructuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const arrangeNetworkBaseSchema = z.object({
  path: z
    .string()
    .describe("COMP whose children to arrange, e.g. '/project1' or a container path."),
  recursive: z
    .boolean()
    .default(false)
    .describe("Also arrange the nodes inside nested COMPs (each network is tidied on its own)."),
  include_docked: z
    .boolean()
    .default(true)
    .describe(
      "Move each node's docked DATs (e.g. GLSL *_pixel or callbacks DATs) with it by the same delta, like an interactive drag. Set false to reposition only the nodes themselves.",
    ),
  annotation_aware: z
    .boolean()
    .default(false)
    .describe(
      "Treat each annotation and the operators it encloses as one layout unit. Uses structured bridge routes and never raw Python.",
    ),
  resize_annotations: z
    .boolean()
    .default(false)
    .describe(
      "With annotation_aware, resize non-empty annotation bounds to the enclosed content plus annotation_padding.",
    ),
  annotation_padding: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .default(80)
    .describe("Padding in network-editor units when resize_annotations is enabled."),
  layout_mode: z
    .enum(["auto", "explicit"])
    .default("auto")
    .describe("Keep automatic layout by default, or place exact coordinates atomically."),
  positions: explicitPositionsSchema
    .optional()
    .describe("Explicit mode only: normalized absolute child path to exact [x, y] coordinates."),
  target_source: z
    .enum(["provided_paths", "active_selection"])
    .optional()
    .describe("Explicit mode only: use the supplied paths or compare them with active selection."),
  idempotency_key: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional()
    .describe("Explicit mode only: stable response-loss recovery key."),
});

function rejectAutoOnlyFields(
  input: z.infer<typeof arrangeNetworkBaseSchema>,
  refineCtx: z.RefinementCtx,
) {
  for (const field of ["positions", "target_source", "idempotency_key"] as const) {
    if (input[field] !== undefined) {
      refineCtx.addIssue({
        code: "custom",
        path: [field],
        message: `${field} is accepted only when layout_mode is explicit`,
      });
    }
  }
}

function validateExplicitLayout(
  input: z.infer<typeof arrangeNetworkBaseSchema>,
  refineCtx: z.RefinementCtx,
) {
  const invalid: Array<
    ["positions" | "recursive" | "annotation_aware" | "resize_annotations", boolean, string]
  > = [
    ["positions", !input.positions, "positions is required when layout_mode is explicit"],
    ["recursive", input.recursive, "explicit placement supports one parent network only"],
    [
      "annotation_aware",
      input.annotation_aware,
      "explicit placement does not run the annotation-aware planner",
    ],
    [
      "resize_annotations",
      input.resize_annotations,
      "explicit placement does not resize annotations",
    ],
  ];
  for (const [path, rejected, message] of invalid) {
    if (rejected) refineCtx.addIssue({ code: "custom", path: [path], message });
  }
}

export const arrangeNetworkSchema = arrangeNetworkBaseSchema.superRefine((input, refineCtx) => {
  if (input.layout_mode === "auto") {
    rejectAutoOnlyFields(input, refineCtx);
    return;
  }
  validateExplicitLayout(input, refineCtx);
});
type ArrangeNetworkArgs = z.input<typeof arrangeNetworkSchema>;

function explicitPlacementVerb(status: "applied" | "unchanged" | "replayed") {
  if (status === "applied") return "Placed";
  if (status === "replayed") return "Replayed";
  return "Verified";
}

export async function arrangeNetworkImpl(ctx: ToolContext, args: ArrangeNetworkArgs) {
  const input = arrangeNetworkSchema.parse(args);
  return guardTd(
    async () => {
      if (input.layout_mode === "explicit") {
        const canonical = canonicalizeExplicitPlacement({
          root_path: input.path,
          positions: input.positions ?? {},
          target_source: input.target_source ?? "provided_paths",
          include_docked: input.include_docked,
          idempotency_key: input.idempotency_key ?? randomUUID().replaceAll("-", ""),
        });
        const { idempotency_key: _key, ...contextRequest } = canonical;
        const context = await ctx.client.getRepositionContext(contextRequest);
        const receipt = await ctx.client.applyReposition(
          buildRepositionRequest(canonical, context),
        );
        return { mode: "explicit" as const, receipt };
      }
      if (input.annotation_aware) {
        const context = await ctx.client.getAnnotationLayoutContext(input.path, input.recursive);
        const plans = context.networks.map((network) => ({
          path: network.path,
          ...planAnnotationAwareLayout({
            nodes: network.nodes,
            annotations: network.annotations,
            docked: network.docked,
            edges: network.edges,
            include_docked: input.include_docked,
            resize_annotations: input.resize_annotations,
            annotation_padding: input.annotation_padding,
          }),
        }));
        const planned = plans.reduce(
          (counts, plan) => ({
            units: counts.units + plan.counts.units,
            hosts: counts.hosts + plan.counts.hosts,
            docked: counts.docked + plan.counts.docked,
            annotations: counts.annotations + plan.counts.annotations,
            resized_annotations: counts.resized_annotations + plan.counts.resized_annotations,
          }),
          { units: 0, hosts: 0, docked: 0, annotations: 0, resized_annotations: 0 },
        );
        if (planned.hosts + planned.annotations === 0) {
          return { mode: "annotation_aware" as const, planned, apply: null };
        }
        const apply = await ctx.client.applyAnnotationLayout({
          root_path: context.root_path,
          recursive: context.recursive,
          fingerprint: context.fingerprint,
          networks: plans.map((plan) => ({
            path: plan.path,
            positions: plan.positions,
            annotation_bounds: plan.annotation_bounds,
          })),
        });
        return { mode: "annotation_aware" as const, planned, apply };
      }

      const topology = await ctx.client.getNetworkTopology(input.path, input.recursive);
      const nodes = topology.nodes.map((n) => n.path);
      const edges = topology.connections.map((c) => ({ from: c.source_path, to: c.target_path }));
      const positions = computeLayoutByParent(nodes, edges);
      if (nodes.length > 0) {
        await ctx.client.executePythonScript(layoutScript(positions, input.include_docked), false);
      }
      return { mode: "legacy" as const, arranged: Object.keys(positions).length };
    },
    (result) => {
      if (result.mode === "explicit") {
        const verb = explicitPlacementVerb(result.receipt.status);
        return jsonStructuredResult(
          `${verb} ${result.receipt.paths.length} operator position(s) under ${input.path}.`,
          result.receipt,
        );
      }
      if (result.mode === "legacy") {
        return jsonResult(
          result.arranged === 0
            ? `No nodes to arrange under ${input.path}.`
            : `Arranged ${result.arranged} node(s) under ${input.path} into a left→right data-flow layout.`,
          { path: input.path, arranged: result.arranged, recursive: input.recursive },
        );
      }
      const arranged = result.apply?.moved ?? 0;
      return jsonResult(
        result.apply === null
          ? `No nodes or annotations to arrange under ${input.path}.`
          : `Arranged ${arranged} operator(s) under ${input.path} with annotation-aware grouping.`,
        {
          path: input.path,
          recursive: input.recursive,
          annotation_aware: true,
          resize_annotations: input.resize_annotations,
          annotation_padding: input.annotation_padding,
          planned: result.planned,
          apply: result.apply,
        },
      );
    },
  );
}

export const registerArrangeNetwork: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "arrange_network",
    {
      title: "Arrange network layout",
      description:
        "Tidy an existing network into a readable left→right data-flow layout, or use layout_mode=explicit for one bounded, atomic exact-coordinate mutation with stale-context checks, readback and rollback. Annotation-aware automatic layout remains available, and omission of layout_mode preserves the legacy response. It never adds, deletes, or rewires nodes.",
      // Advertise the v1-compatible raw field map used across this repo. Keep
      // the cross-field superRefine contract in arrangeNetworkImpl below.
      inputSchema: arrangeNetworkBaseSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => arrangeNetworkImpl(ctx, args),
  );
};
