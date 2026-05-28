import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const RESOLUTIONS = {
  "720p": [1280, 720],
  "1080p": [1920, 1080],
  "4K": [3840, 2160],
} as const;

/** "#rrggbb" (or "rrggbb") → [r,g,b] in 0..1; falls back to white on anything malformed. */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [1, 1, 1];
  return [
    Number.parseInt(h.slice(0, 2), 16) / 255,
    Number.parseInt(h.slice(2, 4), 16) / 255,
    Number.parseInt(h.slice(4, 6), 16) / 255,
  ];
}

export const createTextOverlaySchema = z.object({
  text: z.string().default("TEXT").describe("The text to display."),
  source_path: z
    .string()
    .optional()
    .describe(
      "Optional TOP to composite the text over (e.g. a finished visual). Omit to get the text alone on a transparent background, ready to composite later.",
    ),
  font_size: z.coerce.number().positive().default(64).describe("Font size in pixels."),
  color: z.string().default("#ffffff").describe("Text color as a hex string, e.g. '#ff3366'."),
  align: z.enum(["left", "center", "right"]).default("center").describe("Horizontal alignment."),
  valign: z.enum(["top", "center", "bottom"]).default("center").describe("Vertical alignment."),
  resolution: z
    .enum(["720p", "1080p", "4K"])
    .default("1080p")
    .describe(
      "Output resolution of the Text TOP: '720p' (1280×720), '1080p' (1920×1080), or '4K' (3840×2160).",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the self-contained 'text_overlay' container is created inside."),
});
type CreateTextOverlayArgs = z.infer<typeof createTextOverlaySchema>;

export async function createTextOverlayImpl(ctx: ToolContext, args: CreateTextOverlayArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "text_overlay");
    const [width, height] = RESOLUTIONS[args.resolution];
    const [r, g, b] = hexToRgb(args.color);

    // Transparent-background Text TOP: only the glyphs are opaque, so it composites cleanly.
    const text = await builder.add("textTOP", "text", {
      text: args.text,
      fontsizex: args.font_size,
      fontsizey: args.font_size,
      fontcolorr: r,
      fontcolorg: g,
      fontcolorb: b,
      fontalpha: 1,
      alignx: args.align,
      aligny: args.valign,
      bgalpha: 0,
      outputresolution: "custom",
      resolutionw: width,
      resolutionh: height,
    });

    let output = text;
    if (args.source_path) {
      // Pull the source in through a Select TOP (works across COMP boundaries), then composite
      // the text 'over' it — input 0 is the top layer.
      const src = await builder.add("selectTOP", "src", { top: args.source_path });
      const comp = await builder.add("compositeTOP", "comp", { operand: "over" });
      await builder.connect(text, comp, 0, 0);
      await builder.connect(src, comp, 0, 1);
      output = comp;
    }
    const out = await builder.add("nullTOP", "out1");
    await builder.connect(output, out);

    return finalize(ctx, {
      summary: `Built a text overlay ("${args.text}") → ${out}${
        args.source_path ? ` composited over ${args.source_path}` : " on a transparent background"
      }.`,
      builder,
      outputPath: out,
      extra: {
        text: args.text,
        text_node: text,
        output_path: out,
        over_source: args.source_path ?? null,
        resolution: args.resolution,
      },
    });
  });
}

export const registerCreateTextOverlay: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_text_overlay",
    {
      title: "Create text overlay",
      description:
        "Composite styled text over a visual (or on its own transparent background) — a Text TOP with font size, color, and alignment, optionally laid 'over' a source TOP through a Composite TOP, output as a Null. For lyrics, titles, song names, or credits in a set. Distinct from the vault's bind_vault_text (which data-syncs a Text DAT to a note); this is a finished visual layer ready for setup_output.",
      inputSchema: createTextOverlaySchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createTextOverlayImpl(ctx, args),
  );
};
