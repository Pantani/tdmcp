import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

const PATTERN_SHADER = `out vec4 fragColor;
void main() {
  vec2 uv = vUV.st;
  vec2 grid = abs(fract(uv * 16.0) - 0.5);
  float line = step(min(grid.x, grid.y), 0.018);
  float cross = step(abs(uv.x - 0.5), 0.004) + step(abs(uv.y - 0.5), 0.004);
  float border = step(uv.x, 0.02) + step(uv.y, 0.02) + step(0.98, uv.x) + step(0.98, uv.y);
  vec3 bg = vec3(0.015, 0.018, 0.025);
  vec3 gridCol = vec3(0.0, 0.85, 0.55);
  vec3 crossCol = vec3(1.0, 0.25, 0.12);
  vec3 col = mix(bg, gridCol, clamp(line + border, 0.0, 1.0));
  col = mix(col, crossCol, clamp(cross, 0.0, 1.0));
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}`;

export const projectorCalibrationWizardSchema = z.object({
  parent_path: z.string().default("/project1").describe("Parent COMP path to build inside."),
  name: z
    .string()
    .default("projector_calibration")
    .describe("Name for the generated calibration container."),
  source_path: z
    .string()
    .optional()
    .describe("Optional existing TOP to calibrate. Omit to generate a built-in grid/crosshair."),
  projectors: z.coerce
    .number()
    .int()
    .min(1)
    .max(8)
    .default(1)
    .describe("Number of projector lanes to scaffold."),
  width: z.coerce.number().int().positive().default(1920).describe("Per-lane output width."),
  height: z.coerce.number().int().positive().default(1080).describe("Per-lane output height."),
  overlap: z.coerce
    .number()
    .min(0)
    .max(0.5)
    .default(0.08)
    .describe("Normalized overlap reserved for soft-edge alignment notes."),
  include_corner_pin: z
    .boolean()
    .default(true)
    .describe("Insert a Corner Pin TOP per projector lane for keystone alignment."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose Brightness and Gamma controls on every projector lane."),
});
type ProjectorCalibrationWizardArgs = z.infer<typeof projectorCalibrationWizardSchema>;

export async function projectorCalibrationWizardImpl(
  ctx: ToolContext,
  args: ProjectorCalibrationWizardArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);

    const source = args.source_path
      ? await builder.add("selectTOP", "source_in", {
          top: args.source_path,
          resolutionw: args.width,
          resolutionh: args.height,
        })
      : await builder.add("glslTOP", "calibration_pattern", {
          resolutionw: args.width,
          resolutionh: args.height,
        });
    if (!args.source_path) {
      const frag = await builder.add("textDAT", "calibration_pattern_frag");
      await builder.python(
        `op(${q(frag)}).text = ${q(PATTERN_SHADER)}\nop(${q(source)}).par.pixeldat = op(${q(frag)}).name`,
      );
    }

    const layout = await builder.add("layoutTOP", "projector_preview", {
      align: args.projectors > 2 ? "gridrows" : "horizlr",
      resolutionw: args.width,
      resolutionh: args.height,
    });

    const laneOutputs: string[] = [];
    const controls: ControlSpec[] = [];
    for (let i = 0; i < args.projectors; i++) {
      const crop = await builder.add(`cropTOP`, `p${i + 1}_crop`, {
        resolutionw: args.width,
        resolutionh: args.height,
      });
      await builder.connect(source, crop);
      const warp = args.include_corner_pin
        ? await builder.add("cornerpinTOP", `p${i + 1}_cornerpin`, {
            resolutionw: args.width,
            resolutionh: args.height,
          })
        : crop;
      if (args.include_corner_pin) await builder.connect(crop, warp);
      const level = await builder.add("levelTOP", `p${i + 1}_level`, {
        brightness1: 1,
        gamma1: 1,
        opacity: 1,
      });
      await builder.connect(warp, level);
      const out = await builder.add("nullTOP", `p${i + 1}_out`);
      await builder.connect(level, out);
      await builder.connect(out, layout, 0, i);
      laneOutputs.push(out);
      if (args.expose_controls) {
        controls.push(
          {
            name: `P${i + 1}Brightness`,
            type: "float",
            min: 0,
            max: 2,
            default: 1,
            bind_to: [`${level}.brightness1`],
          },
          {
            name: `P${i + 1}Gamma`,
            type: "float",
            min: 0.1,
            max: 4,
            default: 1,
            bind_to: [`${level}.gamma1`],
          },
        );
      }
    }

    const notes = await builder.add("textDAT", "calibration_notes");
    await builder.python(
      `op(${q(notes)}).text = ${q(
        [
          "Projector calibration wizard",
          `projectors=${args.projectors}`,
          `overlap=${args.overlap}`,
          "Live projector alignment is UNVERIFIED until each lane is sent to the real output and adjusted on site.",
        ].join("\n"),
      )}`,
    );
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(layout, out);
    const validationNotes = [
      "Live projector alignment remains UNVERIFIED: send each pN_out lane to the real projector output and inspect the physical grid.",
    ];

    return finalize(ctx, {
      summary: `Built a ${args.projectors}-projector calibration wizard ending at ${out}.`,
      builder,
      outputPath: out,
      controls,
      extra: {
        source_path: args.source_path,
        projectors: args.projectors,
        lane_outputs: laneOutputs,
        overlap: args.overlap,
        validation_notes: validationNotes,
        live_validation: "UNVERIFIED-projector",
      },
    });
  });
}

export const registerProjectorCalibrationWizard: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "projector_calibration_wizard",
    {
      title: "Projector calibration wizard",
      description:
        "Build a rehearsal-safe projector calibration network: generated grid/crosshair or selected source TOP, per-projector crop/corner-pin/level/output lanes, preview layout, notes, and brightness/gamma controls. Live projector alignment remains explicitly unverified until run on the physical outputs.",
      inputSchema: projectorCalibrationWizardSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => projectorCalibrationWizardImpl(ctx, args),
  );
};
