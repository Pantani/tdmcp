import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { showPreflightReportImpl } from "../layer3/showPreflightReport.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { autoUiFromParamsImpl, inferControlsFromNode } from "./autoUiFromParams.js";
import { toTdCustomParameterName } from "./createControlPanel.js";
import { createControlSurfaceImpl } from "./createControlSurface.js";

const companionCueButtonSchema = z.object({
  cue: z.string().describe("Name of a cue stored on the companion COMP."),
  label: z.string().optional().describe("Button label; defaults to the cue name."),
  morph_seconds: z.coerce
    .number()
    .min(0)
    .default(0)
    .describe("0 = jump instantly to the cue; >0 = morph over this many seconds."),
});

export const createCompanionSurfaceSchema = z.object({
  source_path: z.string().describe("Node or COMP whose useful parameters should be surfaced."),
  comp_path: z
    .string()
    .optional()
    .describe("COMP that receives the custom parameters and panel. Defaults to source_path."),
  name: z
    .string()
    .default("companion_surface")
    .describe("Name of the playable panel container to build."),
  page: z
    .string()
    .default("Companion")
    .describe("Custom-parameter page added by the auto UI pass."),
  parameters: z
    .array(z.string())
    .optional()
    .describe("Only expose these source parameter names. Omit to infer primitive controls."),
  exclude: z.array(z.string()).default([]).describe("Source parameter names to skip."),
  max_controls: z.coerce
    .number()
    .int()
    .positive()
    .max(32)
    .default(8)
    .describe("Maximum inferred controls when parameters is omitted."),
  include_faders: z
    .boolean()
    .default(true)
    .describe("Build a playable fader/toggle surface for numeric inferred controls."),
  cue_buttons: z
    .array(companionCueButtonSchema)
    .default([])
    .describe("Optional cue buttons to add to the playable surface."),
  include_preflight: z
    .boolean()
    .default(true)
    .describe("Append a read-only show_preflight_report result for the companion COMP."),
  target_fps: z.coerce.number().positive().default(60).describe("Frame-rate target for preflight."),
  bind: z
    .boolean()
    .default(true)
    .describe("Bind generated custom parameters back to source_path parameters."),
});
type CreateCompanionSurfaceArgs = z.infer<typeof createCompanionSurfaceSchema>;

function parseFence<T>(result: CallToolResult): T | undefined {
  const text = result.content?.find((c) => c.type === "text") as { text?: string } | undefined;
  const match = text?.text?.match(/```json\n([\s\S]*?)\n```/);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(match[1]) as T;
  } catch {
    return undefined;
  }
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export async function createCompanionSurfaceImpl(
  ctx: ToolContext,
  args: CreateCompanionSurfaceArgs,
): Promise<CallToolResult> {
  const compPath = args.comp_path ?? args.source_path;
  try {
    const node = await ctx.client.getNode(args.source_path);
    const { controls, skipped } = inferControlsFromNode(node, args);
    if (controls.length === 0) {
      return errorResult(`No eligible primitive parameters found on ${args.source_path}.`, {
        source_path: args.source_path,
        skipped,
      });
    }

    const autoUi = await autoUiFromParamsImpl(ctx, {
      source_path: args.source_path,
      comp_path: compPath,
      page: args.page,
      parameters: args.parameters,
      exclude: args.exclude,
      max_controls: args.max_controls,
      bind: args.bind,
    });
    if (autoUi.isError) return autoUi;

    const faders = args.include_faders
      ? controls
          .filter((control) => ["float", "int", "toggle"].includes(control.type))
          .map((control) => ({
            param: `${compPath}.${toTdCustomParameterName(control.name)}`,
            label: control.label ?? control.name,
            min: control.type === "toggle" ? 0 : (control.min ?? 0),
            max: control.type === "toggle" ? 1 : (control.max ?? 1),
          }))
      : [];

    const surface =
      faders.length > 0 || args.cue_buttons.length > 0
        ? await createControlSurfaceImpl(ctx, {
            comp_path: compPath,
            name: args.name,
            align: "horizlr",
            faders,
            cue_buttons: args.cue_buttons,
          })
        : undefined;
    if (surface?.isError) {
      return errorResult("create_companion_surface: control surface build failed.", {
        auto_ui: parseFence(autoUi),
        surface_error: textOf(surface),
      });
    }

    const preflight = args.include_preflight
      ? await showPreflightReportImpl(ctx, {
          root_path: compPath,
          target_fps: args.target_fps,
          recursive: true,
          include_displays: false,
          include_performance: true,
        })
      : undefined;

    const summary = `Created companion surface for ${args.source_path} on ${compPath}: ${controls.length} auto UI control(s), ${faders.length} fader(s)${
      args.cue_buttons.length ? `, ${args.cue_buttons.length} cue button(s)` : ""
    }${preflight?.structuredContent ? `, preflight ${String(preflight.structuredContent.status).toUpperCase()}` : ""}.`;

    return jsonResult(summary, {
      source_path: args.source_path,
      comp_path: compPath,
      page: args.page,
      controls: controls.map((control) => ({
        source_parameter: control.name,
        custom_parameter: toTdCustomParameterName(control.name),
        type: control.type,
      })),
      skipped,
      auto_ui: parseFence(autoUi),
      surface: surface ? parseFence(surface) : undefined,
      preflight: preflight?.structuredContent,
    });
  } catch (err) {
    return errorResult(friendlyTdError(err));
  }
}

export const registerCreateCompanionSurface: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_companion_surface",
    {
      title: "Create companion surface",
      description:
        "Build a companion performance surface for an existing node/COMP: infer useful primitive parameters, add bound custom parameters, create a playable fader/cue panel, and optionally append a read-only preflight report. Use after generating a component that needs a human-facing control surface without hand-wiring every parameter.",
      inputSchema: createCompanionSurfaceSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createCompanionSurfaceImpl(ctx, args),
  );
};
