import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

const BARS_SHADER = `out vec4 fragColor;
void main(){
    vec2 uv = vUV.st;
    float v = texture(sTD2DInputs[0], vec2(uv.x, 0.5)).r;
    float bar = step(uv.y, clamp(v, 0.0, 1.0));
    vec3 col = mix(vec3(0.03, 0.05, 0.1), vec3(0.2, 0.9, 0.6), uv.x) * bar;
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

const SOURCE_TYPE = {
  table: "tableDAT",
  file: "fileinDAT",
  chop: "constantCHOP",
} as const;

export const createDataVisualizationSchema = z.object({
  data_source: z.enum(["table", "file", "chop"]).default("table"),
  chart_style: z.enum(["bars", "graph", "points"]).default("bars"),
  parent_path: z.string().default("/project1"),
});
type CreateDataVisualizationArgs = z.infer<typeof createDataVisualizationSchema>;

export async function createDataVisualizationImpl(
  ctx: ToolContext,
  args: CreateDataVisualizationArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "data_viz");
    const source = await builder.add(SOURCE_TYPE[args.data_source], "data");

    // Seed the placeholder table so the chart shows sample bars immediately instead of a
    // blank 1x1 output; an empty table yields a single zero-valued sample.
    if (args.data_source === "table") {
      const rows = Array.from({ length: 16 }, (_, i) =>
        (0.5 + 0.45 * Math.sin(i * 0.6)).toFixed(3),
      );
      await builder.python(
        `d = op(${q(source)})\nd.clear()\nfor v in ${JSON.stringify(rows)}:\n    d.appendRow([v])`,
      );
    }

    let chop = source;
    if (args.data_source !== "chop") {
      // dattoCHOP defaults firstcolumn to "names", which turns a single numeric column into
      // channel *names* with value 0; read the column as values (one channel, N samples).
      chop = await builder.add("dattoCHOP", "datto", {
        firstrow: "values",
        firstcolumn: "values",
        output: "chanpercol",
      });
      await builder.connect(source, chop);
    }

    const tex = await builder.add("choptoTOP", "data_tex");
    await builder.connect(chop, tex);

    let visual = tex;
    if (args.chart_style === "bars") {
      // Fixed canvas + RGBA. Left on "use input", the chart inherits the data texture's
      // tiny Nx1 mono resolution, collapsing the output to a grayscale speck.
      const glsl = await builder.add("glslTOP", "chart", {
        outputresolution: "custom",
        resolutionw: 1280,
        resolutionh: 720,
        format: "rgba8fixed",
      });
      const frag = await builder.add("textDAT", "chart_frag");
      await builder.python(
        `op(${q(frag)}).text = ${q(BARS_SHADER)}\nop(${q(glsl)}).par.pixeldat = op(${q(frag)}).name`,
      );
      await builder.connect(tex, glsl);
      visual = glsl;
    } else {
      builder.warnings.push(
        `Chart style "${args.chart_style}" renders the data as a texture strip; richer plotting needs customization.`,
      );
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(visual, out);
    builder.warnings.push(
      "Wire your real data into the 'data' node — a placeholder source was created.",
    );

    return finalize(ctx, {
      summary: `Created a data visualization (source: ${args.data_source}, style: ${args.chart_style}).`,
      builder,
      outputPath: out,
      extra: { data_source: args.data_source, chart_style: args.chart_style },
    });
  });
}

export const registerCreateDataVisualization: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_data_visualization",
    {
      title: "Create data visualization",
      description:
        "Build a data-driven visualization: a data source feeds a CHOP that drives a chart TOP. Wire your real data into the created 'data' node.",
      inputSchema: createDataVisualizationSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDataVisualizationImpl(ctx, args),
  );
};
