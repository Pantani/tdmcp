import { z } from "zod";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const pulseTdParameterSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => value.startsWith("/"), "TouchDesigner operator paths must be absolute.")
    .describe("Full path of the operator that owns the Pulse."),
  parameter: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .describe("Exact name of the Pulse parameter."),
});
type PulseTdParameterArgs = z.infer<typeof pulseTdParameterSchema>;

export async function pulseTdParameterImpl(ctx: ToolContext, args: PulseTdParameterArgs) {
  return guardTd(
    () => ctx.client.pulseParameter(args.path, args.parameter),
    (result) =>
      result.pulsed
        ? jsonResult(`Pulsed ${result.path}.par.${result.parameter} (${result.style}).`, result)
        : errorResult(
            `TouchDesigner did not confirm that ${args.path}.par.${args.parameter} was pulsed.`,
            result,
          ),
  );
}

export const registerPulseTdParameter: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "pulse_td_parameter",
    {
      title: "Pulse TouchDesigner parameter",
      description:
        "Validate that an existing operator parameter is Pulse style, invoke its structured .pulse() operation, and confirm the result. Missing operators, missing parameters and non-Pulse styles return typed bridge errors. Does not use raw Python fallback.",
      inputSchema: pulseTdParameterSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => pulseTdParameterImpl(ctx, args),
  );
};
