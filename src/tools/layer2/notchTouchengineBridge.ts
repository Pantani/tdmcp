import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import type { ControlSpec } from "./createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

export const notchTouchengineBridgeSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP path to build inside."),
  name: z.string().default("notch_touchengine_bridge").describe("Generated container name."),
  mode: z
    .enum(["notch_top", "engine_comp"])
    .default("notch_top")
    .describe("Create a Notch TOP bridge or an Engine COMP TouchEngine bridge."),
  block_path: z.string().optional().describe("Notch .dfxdll block path for mode=notch_top."),
  tox_path: z.string().optional().describe("TouchEngine .tox path for mode=engine_comp."),
  width: z.coerce.number().int().positive().default(1920).describe("Output width."),
  height: z.coerce.number().int().positive().default(1080).describe("Output height."),
  active: z.boolean().default(false).describe("Start the bridge active. Defaults false."),
  play: z.boolean().default(false).describe("Start playback/cooking where supported."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose Play and Speed controls where possible."),
});
type NotchTouchengineBridgeArgs = z.infer<typeof notchTouchengineBridgeSchema>;

export async function notchTouchengineBridgeImpl(
  ctx: ToolContext,
  args: NotchTouchengineBridgeArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const bridge =
      args.mode === "notch_top"
        ? await builder.add("notchTOP", "notch", {
            block: args.block_path,
            active: args.active,
            play: args.play,
            resolutionw: args.width,
            resolutionh: args.height,
          })
        : await builder.add("engineCOMP", "touchengine", {
            file: args.tox_path,
            play: args.play,
          });

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(bridge, out);
    const notes = await builder.add("textDAT", "bridge_notes");
    const requiredPath = args.mode === "notch_top" ? args.block_path : args.tox_path;
    await builder.python(
      `op(${q(notes)}).text = ${q(
        [
          "Notch / TouchEngine bridge scaffold",
          `mode=${args.mode}`,
          `asset=${requiredPath ?? "(not provided)"}`,
          "Live license/runtime validation is UNVERIFIED until the target Notch block or .tox loads in TouchDesigner.",
        ].join("\n"),
      )}`,
    );

    const controls: ControlSpec[] =
      args.expose_controls && args.mode === "notch_top"
        ? [
            {
              name: "Play",
              type: "toggle",
              default: args.play,
              bind_to: [`${bridge}.play`],
            },
            {
              name: "Speed",
              type: "float",
              min: 0,
              max: 4,
              default: 1,
              bind_to: [`${bridge}.speed`],
            },
          ]
        : [];

    if (!requiredPath) {
      builder.warnings.push(
        `${args.mode} bridge created without an asset path; set ${args.mode === "notch_top" ? "block_path" : "tox_path"} before live playback.`,
      );
    }
    builder.warnings.push(
      "Notch/TouchEngine runtime and license validation remain UNVERIFIED until this scaffold is loaded on the target machine.",
    );

    return finalize(ctx, {
      summary: `Built a ${args.mode} bridge scaffold ending at ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        mode: args.mode,
        bridge,
        output_path: out,
        block_path: args.block_path,
        tox_path: args.tox_path,
        live_validation: "UNVERIFIED-license-runtime",
      },
    });
  });
}

export const registerNotchTouchengineBridge: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "notch_touchengine_bridge",
    {
      title: "Notch TouchEngine bridge",
      description:
        "Build a guarded Notch TOP or Engine COMP/TouchEngine bridge scaffold with notes, output, and optional Notch play/speed controls. This does not validate a Notch license or target runtime; live validation remains explicit.",
      inputSchema: notchTouchengineBridgeSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => notchTouchengineBridgeImpl(ctx, args),
  );
};
