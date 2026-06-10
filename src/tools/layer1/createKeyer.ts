import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// Converts a '#rrggbb' or '#rgb' hex string to 0–1 RGB components.
// Falls back to green (#00ff00) if the string is malformed so a bad colour
// string can't sink the whole build.
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 1, b: 0 };
  const raw = m[1] ?? "";
  const h = raw.length === 3 ? raw.replace(/./g, (c) => c + c) : raw;
  const int = Number.parseInt(h, 16);
  return {
    r: ((int >> 16) & 0xff) / 255,
    g: ((int >> 8) & 0xff) / 255,
    b: (int & 0xff) / 255,
  };
}

export const createKeyerSchema = z.object({
  name: z.string().default("keyer").describe("Name for the keyer COMP."),
  parent_path: z.string().default("/project1").describe("Where to build it."),
  source: z
    .string()
    .optional()
    .describe(
      "TOP to pull the key FROM (e.g. a camera/live source). Omit → a built-in test source.",
    ),
  background: z
    .string()
    .optional()
    .describe("TOP to composite the keyed result OVER. Omit → a built-in test background."),
  key_type: z
    .enum(["chroma", "luma", "rgb"])
    .default("chroma")
    .describe(
      "chroma: green/blue-screen (Chroma Key TOP, keys on Hue+Sat+Val range); luma: brightness key (Level TOP + Matte TOP, keys on luminance); rgb: key a specific RGB color (RGB Key TOP, keys on R/G/B channel ranges).",
    ),
  key_color: z.string().default("#00ff00").describe("(chroma/rgb) Hex color to key out."),
  tolerance: z.coerce.number().min(0).max(1).default(0.3).describe("Key tolerance/range."),
  softness: z.coerce.number().min(0).max(1).default(0.1).describe("Edge softness/feather."),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Output resolution [w,h]."),
});
type CreateKeyerArgs = z.infer<typeof createKeyerSchema>;

export async function createKeyerImpl(ctx: ToolContext, args: CreateKeyerArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const [resW, resH] = args.resolution;

    // Source: pull an external TOP via a Select TOP (wires can't cross COMPs) or
    // fall back to a constant colour test card (device-free default).
    let source: string;
    if (args.source) {
      source = await builder.add("selectTOP", "source", { top: args.source });
    } else {
      // A solid green test card matches the default chroma key colour so the
      // preview immediately shows a keyed result even without a real camera.
      source = await builder.add("constantTOP", "source", {
        outputresolution: "custom",
        resolutionw: resW,
        resolutionh: resH,
        colorr: 0,
        colorg: 1,
        colorb: 0,
        colora: 1,
      });
    }

    // Background: external TOP or a dark ramp.
    let background: string;
    if (args.background) {
      background = await builder.add("selectTOP", "bg", { top: args.background });
    } else {
      background = await builder.add("rampTOP", "bg", {
        type: "diagonal",
        outputresolution: "custom",
        resolutionw: resW,
        resolutionh: resH,
      });
    }

    const rgb = hexToRgb(args.key_color);

    // Keying stage — three paths depending on key_type.
    let keyStage: string;
    const controls: ControlSpec[] = [];
    let summary: string;

    if (args.key_type === "chroma") {
      // Chroma Key TOP: keys on Hue, Saturation, Value ranges independently.
      // The operator uses min/max pairs per channel:
      //   huemin / huemax   (0–360 degrees, UNVERIFIED: par name confirmed from KB)
      //   satmin / satmax   (0–1)
      //   valmin / valmax   (0–1)
      //   hsoftlow / hsofthigh  (hue feather, UNVERIFIED)
      //   ssoftlow / ssofthigh  (sat feather, UNVERIFIED)
      //   vsoftlow / vsofthigh  (val feather, UNVERIFIED)
      //   rgbout = 'multalpha'  (multiply source by the key alpha, UNVERIFIED)
      //
      // We derive a hue from the key colour and build a ±tolerance window.
      // hue in TD is 0–360; tolerance maps to half-width of the window.
      // All par names are set defensively so a wrong name just logs a warning.
      const { r, g, b } = rgb;
      // Rough HSV hue from the RGB key colour (no library, simple formula).
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      let hue = 0;
      if (delta > 0.001) {
        if (max === r) hue = 60 * (((g - b) / delta) % 6);
        else if (max === g) hue = 60 * ((b - r) / delta + 2);
        else hue = 60 * ((r - g) / delta + 4);
      }
      hue = ((hue % 360) + 360) % 360;
      const halfTol = args.tolerance * 180; // tolerance maps to 0..180 degrees half-width
      const hueMin = Math.max(0, hue - halfTol);
      const hueMax = Math.min(360, hue + halfTol);
      const soft = args.softness * halfTol;

      keyStage = await builder.add("chromakeyTOP", "key_chroma", {
        outputresolution: "custom",
        resolutionw: resW,
        resolutionh: resH,
      });
      // Set the key parameters defensively; unknown par names become builder warnings.
      await builder.setParams(keyStage, {
        huemin: hueMin,
        huemax: hueMax,
        hsoftlow: soft,
        hsofthigh: soft,
        satmin: 0.3,
        satmax: 1.0,
        ssoftlow: args.softness * 0.5,
        ssofthigh: args.softness * 0.5,
        valmin: 0.2,
        valmax: 1.0,
        vsoftlow: args.softness * 0.3,
        vsofthigh: args.softness * 0.3,
        rgbout: "multalpha",
      });
      await builder.connect(source, keyStage);

      controls.push(
        {
          name: "Tolerance",
          type: "float",
          min: 0,
          max: 1,
          default: args.tolerance,
          bind_to: [],
        },
        {
          name: "Softness",
          type: "float",
          min: 0,
          max: 1,
          default: args.softness,
          bind_to: [],
        },
        {
          name: "KeyColor",
          type: "rgb",
          default: args.key_color,
          bind_to: [],
        },
      );
      summary = `Built a chroma keyer (key_type chroma, colour ${args.key_color}, tolerance ${args.tolerance}, softness ${args.softness})`;
    } else if (args.key_type === "rgb") {
      // RGB Key TOP: keys on Red, Green, Blue channel ranges independently.
      // Par names from KB: redmin/redmax/rsoftlow/rsofthigh,
      //   greenmin/greenmax/gsoftlow/gsofthigh,
      //   bluemin/bluemax/bsoftlow/bsofthigh.
      // rgbout = 'multalpha' to pre-multiply alpha into RGB.
      const tol = args.tolerance * 0.5;
      const soft = args.softness * tol;
      keyStage = await builder.add("rgbkeyTOP", "key_rgb", {
        outputresolution: "custom",
        resolutionw: resW,
        resolutionh: resH,
      });
      await builder.setParams(keyStage, {
        redmin: Math.max(0, rgb.r - tol),
        redmax: Math.min(1, rgb.r + tol),
        rsoftlow: soft,
        rsofthigh: soft,
        greenmin: Math.max(0, rgb.g - tol),
        greenmax: Math.min(1, rgb.g + tol),
        gsoftlow: soft,
        gsofthigh: soft,
        bluemin: Math.max(0, rgb.b - tol),
        bluemax: Math.min(1, rgb.b + tol),
        bsoftlow: soft,
        bsofthigh: soft,
        rgbout: "multalpha",
      });
      await builder.connect(source, keyStage);

      controls.push(
        {
          name: "Tolerance",
          type: "float",
          min: 0,
          max: 1,
          default: args.tolerance,
          bind_to: [],
        },
        {
          name: "Softness",
          type: "float",
          min: 0,
          max: 1,
          default: args.softness,
          bind_to: [],
        },
        {
          name: "KeyColor",
          type: "rgb",
          default: args.key_color,
          bind_to: [],
        },
      );
      summary = `Built an RGB keyer (key_type rgb, colour ${args.key_color}, tolerance ${args.tolerance}, softness ${args.softness})`;
    } else {
      // luma key: threshold the brightness of the source with a Level TOP, then
      // use the resulting image as a matte via the Matte TOP (input3 = matte).
      // Matte TOP composites input1 OVER input2 using input3's channel.
      // The Level TOP `blacklevel` lifts the blacks; `brightness1` is a gain knob
      // that functions as the key threshold control.
      // We set `contrast` high to sharpen the alpha edge, and `gamma1` for softness.
      // These are approximate — the exact effect depends on scene brightness.
      const threshold = 1 - args.tolerance; // higher tolerance → lower threshold
      const gammaVal = Math.max(0.1, 1 - args.softness * 0.8); // lower gamma = softer edge

      keyStage = await builder.add("levelTOP", "key_luma", {
        outputresolution: "custom",
        resolutionw: resW,
        resolutionh: resH,
        brightness1: threshold > 0 ? 1 / Math.max(threshold, 0.01) : 10,
        gamma1: gammaVal,
        contrast: 1 + args.tolerance * 2,
        blacklevel: 0,
      });
      await builder.connect(source, keyStage);

      controls.push(
        {
          name: "Tolerance",
          type: "float",
          min: 0,
          max: 1,
          default: args.tolerance,
          bind_to: [`${keyStage}.contrast`],
        },
        {
          name: "Softness",
          type: "float",
          min: 0,
          max: 1,
          default: args.softness,
          bind_to: [`${keyStage}.gamma1`],
        },
      );
      summary = `Built a luma keyer (key_type luma, tolerance ${args.tolerance}, softness ${args.softness})`;
    }

    // Composite stage: key result OVER background using a Composite TOP.
    // Input 0 = keyed source (with premultiplied alpha); input 1 = background.
    // operand "over" is the standard Porter–Duff alpha over (verified in KB).
    const comp = await builder.add("compositeTOP", "comp", {
      operand: "over",
      outputresolution: "custom",
      resolutionw: resW,
      resolutionh: resH,
    });

    if (args.key_type === "luma") {
      // For luma: use a Matte TOP so we can use the luma-thresholded alpha as a
      // separate matte channel rather than relying on premultiplied alpha.
      // matteTOP: input1=source (foreground), input2=background, input3=matte.
      // We re-use `comp` as a different op — replace it with matteTOP.
      await builder.python(`_c = op(${JSON.stringify(comp)})\nif _c:\n    _c.destroy()`);
      const matte = await builder.add("matteTOP", "comp", {
        mattechannel: "luminance",
        outputresolution: "custom",
        resolutionw: resW,
        resolutionh: resH,
      });
      // source (foreground) → input0, background → input1, keyStage (matte) → input2
      await builder.connect(source, matte, 0, 0);
      await builder.connect(background, matte, 0, 1);
      await builder.connect(keyStage, matte, 0, 2);
      const out = await builder.add("nullTOP", "out1");
      await builder.connect(matte, out);

      return finalize(ctx, {
        summary: `${summary} → composite over background (Matte TOP) → Null out1.`,
        builder,
        outputPath: out,
        capturePreviewImage: true,
        controls,
        extra: {
          key_type: args.key_type,
          key_color: args.key_color,
          tolerance: args.tolerance,
          softness: args.softness,
          resolution: args.resolution,
          source_path: source,
          background_path: background,
          key_stage_path: keyStage,
          composite_path: matte,
          output_path: out,
          unverified: [
            "luma key threshold approach uses levelTOP brightness1+contrast+gamma1 — exact par names unverified against live TD build",
            "matteTOP mattechannel='luminance' unverified — confirmed from KB description but not live-tested",
          ],
        },
      });
    }

    // chroma / rgb: wire keyed source into comp input 0, background into input 1.
    await builder.connect(keyStage, comp, 0, 0);
    await builder.connect(background, comp, 0, 1);

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(comp, out);

    return finalize(ctx, {
      summary: `${summary} → composite over background (Composite TOP, operand=over) → Null out1.`,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        key_type: args.key_type,
        key_color: args.key_color,
        tolerance: args.tolerance,
        softness: args.softness,
        resolution: args.resolution,
        source_path: source,
        background_path: background,
        key_stage_path: keyStage,
        composite_path: comp,
        output_path: out,
        unverified: [
          "chromakeyTOP par names (huemin/huemax/hsoftlow/hsofthigh/satmin/satmax/ssoftlow/ssofthigh/valmin/valmax/vsoftlow/vsofthigh/rgbout) — confirmed from KB descriptions but exact Python token names unverified against live TD build",
          "rgbkeyTOP par names (redmin/redmax/rsoftlow/rsofthigh/greenmin/greenmax/gsoftlow/gsofthigh/bluemin/bluemax/bsoftlow/bsofthigh/rgbout) — confirmed from KB descriptions, unverified live",
          "compositeTOP operand='over' — verified from createKineticText.ts sibling usage",
        ],
      },
    });
  });
}

export const registerCreateKeyer: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_keyer",
    {
      title: "Create keyer",
      description:
        "Composite a keyed performer, logo, or any source over a background visual — the green-screen / chroma-key / matte tool for installations and live camera work. Creates a self-contained baseCOMP under `parent_path` that holds the full chain: source (Select TOP or test card) → key stage → composite → Null TOP output. Three key_type modes: 'chroma' (Chroma Key TOP, keys on Hue/Sat/Val range — best for green/blue-screen), 'luma' (Level TOP threshold + Matte TOP — keys by brightness), 'rgb' (RGB Key TOP, keys on R/G/B channel ranges — best for a solid background colour). key_color sets the target colour to remove (chroma/rgb modes); tolerance widens the key range; softness feathers the edge. With a source the footage is pulled in via a Select TOP (so it can live in another container); without one, a constant green test card is used so the chain builds and previews standalone. With a background the composited result is placed over it; without one, a diagonal ramp is used. Tolerance/Softness/KeyColor controls are exposed on the container. Output is a Null TOP. Returns a summary with the container path, created node paths, exposed controls, any node errors, warnings, and an inline preview image.",
      inputSchema: createKeyerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createKeyerImpl(ctx, args),
  );
};
