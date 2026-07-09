import { z } from "zod";
import type { TdNodeDetail } from "../../td-client/validators.js";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import {
  type ControlSpec,
  createControlPanelImpl,
  toTdCustomParameterName,
} from "./createControlPanel.js";

export const autoUiFromParamsSchema = z.object({
  source_path: z.string().describe("Node or COMP whose parameters should become controls."),
  comp_path: z
    .string()
    .optional()
    .describe("COMP that receives the generated control panel. Defaults to source_path."),
  page: z.string().default("Auto UI").describe("Custom-parameter page name for the controls."),
  parameters: z
    .array(z.string())
    .optional()
    .describe("Only expose these parameter names. Omit to infer useful primitive parameters."),
  exclude: z.array(z.string()).default([]).describe("Parameter names to skip."),
  max_controls: z.coerce
    .number()
    .int()
    .positive()
    .max(64)
    .default(12)
    .describe("Maximum inferred controls when parameters is omitted."),
  bind: z
    .boolean()
    .default(true)
    .describe("Bind generated controls back to source_path parameters."),
});
type AutoUiFromParamsArgs = z.infer<typeof autoUiFromParamsSchema>;

const DEFAULT_EXCLUDE = new Set([
  "name",
  "path",
  "clone",
  "externaltox",
  "tox",
  "help",
  "resetpulse",
  "reload",
  "active",
]);

function parameterType(value: unknown): ControlSpec["type"] | undefined {
  if (typeof value === "boolean") return "toggle";
  if (typeof value === "number" && Number.isFinite(value))
    return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "string";
  return undefined;
}

function numericBounds(value: number): Pick<ControlSpec, "min" | "max"> {
  if (value >= 0 && value <= 1) return { min: 0, max: 1 };
  const magnitude = Math.max(1, Math.abs(value));
  return { min: -magnitude * 2, max: magnitude * 2 };
}

export function inferControlsFromNode(
  node: TdNodeDetail,
  args: Pick<AutoUiFromParamsArgs, "parameters" | "exclude" | "max_controls" | "bind">,
): { controls: ControlSpec[]; skipped: string[] } {
  const requested = args.parameters ? new Set(args.parameters) : undefined;
  const excluded = new Set([...DEFAULT_EXCLUDE, ...args.exclude]);
  const controls: ControlSpec[] = [];
  const skipped: string[] = [];

  for (const [name, value] of Object.entries(node.parameters)) {
    if (requested && !requested.has(name)) continue;
    if (excluded.has(name.toLowerCase())) {
      skipped.push(name);
      continue;
    }
    const type = parameterType(value);
    if (!type) {
      skipped.push(name);
      continue;
    }
    const control: ControlSpec = {
      name,
      label: name,
      type,
      default: value as number | boolean | string,
      bind_to: args.bind ? [`${node.path}.${name}`] : undefined,
    };
    if (typeof value === "number") Object.assign(control, numericBounds(value));
    controls.push(control);
    if (!requested && controls.length >= args.max_controls) break;
  }

  if (requested) {
    for (const name of requested) {
      if (!Object.hasOwn(node.parameters, name)) skipped.push(name);
    }
  }

  return { controls, skipped };
}

export async function autoUiFromParamsImpl(ctx: ToolContext, args: AutoUiFromParamsArgs) {
  const node = await ctx.client.getNode(args.source_path);
  const { controls, skipped } = inferControlsFromNode(node, args);
  if (controls.length === 0) {
    return errorResult(`No eligible primitive parameters found on ${args.source_path}.`, {
      source_path: args.source_path,
      skipped,
    });
  }

  const compPath = args.comp_path ?? args.source_path;
  const panel = await createControlPanelImpl(ctx, {
    comp_path: compPath,
    page: args.page,
    controls,
  });
  if (panel.isError) return panel;

  return jsonResult(`Generated ${controls.length} auto UI control(s) on ${compPath}.`, {
    source_path: args.source_path,
    comp_path: compPath,
    page: args.page,
    controls: controls.map((control) => ({
      source_parameter: control.name,
      custom_parameter: toTdCustomParameterName(control.name),
      type: control.type,
      bind_to: control.bind_to ?? [],
    })),
    skipped,
  });
}

export const registerAutoUiFromParams: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "auto_ui_from_params",
    {
      title: "Auto UI from parameters",
      description:
        "Generate a performable control panel from an existing node/COMP's primitive parameters. It reads source_path, infers sliders/toggles/text fields, appends them as custom parameters on comp_path (default source_path), and optionally binds each control back to the source parameter. Use when a generated component has useful parameters but no playable UI yet.",
      inputSchema: autoUiFromParamsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => autoUiFromParamsImpl(ctx, args),
  );
};
