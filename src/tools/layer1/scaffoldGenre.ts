import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import {
  createSystemContainer,
  finalize,
  type NetworkBuilder,
  runBuild,
} from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

// Maps a grayscale luminance through a two-color gradient so each genre's palette survives
// to the output. Mirrors createFeedbackNetwork.colorizeShader (same TD-ready GLSL: declares
// `out vec4 fragColor`, uses TDOutputSwizzle, needs no uTime). Colors are baked hex per genre.
function colorizeShader(lo: string, hi: string): string {
  const toVec3 = (hex: string): string => {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
    if (!m?.[1]) return "vec3(1.0)";
    const n = Number.parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    return `vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)})`;
  };
  return `out vec4 fragColor;
void main(){
    float l = texture(sTD2DInputs[0], vUV.st).r;
    fragColor = TDOutputSwizzle(vec4(mix(${toVec3(lo)}, ${toVec3(hi)}, l), 1.0));
}
`;
}

interface GenrePreset {
  /** Default project tempo for the beat clock. Undefined → no beat clock (installation). */
  bpm?: number;
  /** Dark/warm/muted two-color palette baked into the look's colorize shader. */
  palette: { lo: string; hi: string };
  /** One-line description woven into the build summary. */
  flavor: string;
}

type Genre = "techno" | "ambient" | "installation";

// Genre presets: tempo + palette + flavor. The look itself is built per-genre below; these
// hold only the values that differ. Palettes are low→high luminance (dark base → accent).
// Annotated (not `satisfies`) so every member's `bpm` is uniformly `number | undefined`
// (installation omits it → no beat clock by default).
const GENRES: Record<Genre, GenrePreset> = {
  techno: {
    bpm: 130,
    palette: { lo: "#04060a", hi: "#00e6ff" }, // near-black → hard cyan
    flavor: "fast 130 BPM clock + a hard strobe-y feedback look (fast decay) in a dark palette",
  },
  ambient: {
    bpm: 70,
    palette: { lo: "#0a1430", hi: "#ffb060" }, // deep blue → warm amber
    flavor: "slow 70 BPM clock + a soft blurred-feedback look (long trails) in a warm palette",
  },
  installation: {
    palette: { lo: "#101418", hi: "#3a6e6e" }, // charcoal → dim teal
    flavor: "no beat clock + a slow-evolving generative noise look in a muted palette",
  },
};

export const scaffoldGenreSchema = z.object({
  genre: z
    .enum(["techno", "ambient", "installation"])
    .default("techno")
    .describe("Genre preset selecting the tempo, look, and palette of the starting network."),
  bpm: z.coerce
    .number()
    .positive()
    .optional()
    .describe(
      "Override the preset BPM (written to the global tempo). For 'installation' (no clock by default), supplying a bpm adds a beat clock at that tempo.",
    ),
  name: z.string().optional().describe("Name of the show container (default: '<genre>_show')."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path the show container is created inside."),
});
type ScaffoldGenreArgs = z.infer<typeof scaffoldGenreSchema>;

/**
 * Builds a hard, strobe-leaning feedback look (techno): a sharp monochrome noise seed feeds a
 * `maximum` composite loop with a fast-decay Level gain, then a 2-color colorize. Mirrors
 * createFeedbackNetwork's structure and its gotcha fixes (operand `maximum`, NOT a Level
 * `gain` param but `brightness1`, feedbackTOP seeded then closed via `par.top`).
 */
async function buildTechnoLook(builder: NetworkBuilder, palette: GenrePreset["palette"]) {
  const seed = await builder.add("noiseTOP", "seed", { monochrome: 1, period: 2 });
  const comp = await builder.add("compositeTOP", "comp", { operand: "maximum" });
  const feedback = await builder.add("feedbackTOP", "feedback1");
  await builder.connect(seed, comp, 0, 0);
  await builder.connect(feedback, comp, 0, 1);
  await builder.connect(seed, feedback); // seed the loop's first frame
  // Fast decay → sharp, strobing trails. A Level TOP has no `gain` param (silent no-op); the
  // RGB multiplier is `brightness1`.
  const gain = await builder.add("levelTOP", "gain", { brightness1: 0.85 });
  await builder.connect(comp, gain);
  await builder.python(`op(${q(feedback)}).par.top = op(${q(gain)}).name`);
  const look = await colorizeInto(builder, gain, palette);
  return { look, decayPath: `${gain}.brightness1`, decayDefault: 0.85 };
}

/** A soft feedback look (ambient): large-period noise, an extra heavy blur, slow decay. */
async function buildAmbientLook(builder: NetworkBuilder, palette: GenrePreset["palette"]) {
  const seed = await builder.add("noiseTOP", "seed", { monochrome: 1, period: 12 });
  const comp = await builder.add("compositeTOP", "comp", { operand: "maximum" });
  const feedback = await builder.add("feedbackTOP", "feedback1");
  await builder.connect(seed, comp, 0, 0);
  await builder.connect(feedback, comp, 0, 1);
  await builder.connect(seed, feedback);
  const blur = await builder.add("blurTOP", "blur", { size: 24 });
  await builder.connect(comp, blur);
  // Slow decay → long, smeared trails.
  const gain = await builder.add("levelTOP", "gain", { brightness1: 0.97 });
  await builder.connect(blur, gain);
  await builder.python(`op(${q(feedback)}).par.top = op(${q(gain)}).name`);
  const look = await colorizeInto(builder, gain, palette);
  return { look, decayPath: `${gain}.brightness1`, decayDefault: 0.97 };
}

/** A generative noise look (installation): a slowly translating large-period noise field. */
async function buildInstallationLook(builder: NetworkBuilder, palette: GenrePreset["palette"]) {
  const seed = await builder.add("noiseTOP", "seed", { monochrome: 1, period: 8 });
  // A slow translate so the field drifts rather than sits still — gentle, ambient evolution.
  // The Transform TOP's translate params are `tx`/`ty` (translate X/Y, NOT translate1/translate2 —
  // verified against a live transformTOP). A CONSTANT tx/ty only offsets the field ONCE; to make it
  // actually DRIFT over time the params must be TIME-BASED EXPRESSIONS, set the same way
  // createKineticText drives its slide: `_p.expr = …; _p.mode = type(_p.mode).EXPRESSION`. Here the
  // expressions are `absTime.seconds * <speed>` so the field creeps continuously while the timeline
  // plays (different X/Y speeds so it drifts diagonally rather than straight).
  const move = await builder.add("transformTOP", "drift", { tx: 0, ty: 0 });
  await builder.connect(seed, move);
  await builder.python(
    [
      `_t = op(${q(move)})`,
      `for _name, _speed in (('tx', 0.02), ('ty', 0.01)):`,
      `    _p = getattr(_t.par, _name)`,
      `    _p.expr = f'absTime.seconds * {_speed}'`,
      `    _p.mode = type(_p.mode).EXPRESSION`,
    ].join("\n"),
  );
  const look = await colorizeInto(builder, move, palette);
  return { look, periodPath: `${seed}.period`, periodDefault: 8 };
}

/** Appends a GLSL colorize (2-color luminance gradient) + an `out` Null and returns the Null. */
async function colorizeInto(
  builder: NetworkBuilder,
  from: string,
  palette: GenrePreset["palette"],
): Promise<string> {
  const colorize = await builder.add("glslTOP", "colorize");
  const frag = await builder.add("textDAT", "colorize_frag");
  await builder.python(
    `op(${q(frag)}).text = ${q(colorizeShader(palette.lo, palette.hi))}\nop(${q(colorize)}).par.pixeldat = op(${q(frag)}).name`,
  );
  await builder.connect(from, colorize);
  const look = await builder.add("nullTOP", "look");
  await builder.connect(colorize, look);
  return look;
}

export async function scaffoldGenreImpl(ctx: ToolContext, args: ScaffoldGenreArgs) {
  return runBuild(async () => {
    const genre = args.genre as Genre;
    const preset = GENRES[genre];
    const containerName = args.name ?? `${genre}_show`;
    const builder = await createSystemContainer(ctx, args.parent_path, containerName);

    // The master output Null (where the mix lands), exactly like scaffold_show.
    const master = await builder.add("nullTOP", "master");

    // Beat clock — present for techno/ambient, and for installation only if a bpm is given.
    // The clock follows TD's GLOBAL tempo, which we pin via op('/').time.tempo (the same
    // mechanism create_sync_external_clock uses); the Beat CHOP's own `bpm` param is just an
    // output-channel toggle, not a settable input.
    const bpm = args.bpm ?? preset.bpm;
    let tempo: string | undefined;
    // The BPM actually written to the global tempo (clamped to the sane range). The user-facing
    // note shows this clamped value so it matches what was written, not the raw request.
    let writtenBpm: number | undefined;
    if (bpm !== undefined) {
      const beat = await builder.add("beatCHOP", "beat", {
        ramp: 1,
        pulse: 1,
        count: 1,
        beat: 1,
        bar: 1,
        bpm: 1,
      });
      tempo = await builder.add("nullCHOP", "tempo");
      await builder.connect(beat, tempo);
      // Clamp to the same sane range as the external-clock tool before writing the global tempo.
      const clamped = Math.max(40, Math.min(220, bpm));
      writtenBpm = clamped;
      await builder.python(`op('/').time.tempo = ${clamped}`);
    }

    // Genre-specific look, wired into master so the artist sees something on arrival.
    let look: string;
    let controls: ControlSpec[] = [];
    if (genre === "techno") {
      const built = await buildTechnoLook(builder, preset.palette);
      look = built.look;
      controls = [
        {
          name: "Feedback",
          type: "float",
          min: 0,
          max: 1,
          default: built.decayDefault,
          bind_to: [built.decayPath],
        },
      ];
    } else if (genre === "ambient") {
      const built = await buildAmbientLook(builder, preset.palette);
      look = built.look;
      controls = [
        {
          name: "Feedback",
          type: "float",
          min: 0,
          max: 1,
          default: built.decayDefault,
          bind_to: [built.decayPath],
        },
      ];
    } else {
      const built = await buildInstallationLook(builder, preset.palette);
      look = built.look;
      controls = [
        {
          name: "Evolve",
          type: "float",
          min: 1,
          max: 32,
          default: built.periodDefault,
          bind_to: [built.periodPath],
        },
      ];
    }
    await builder.connect(look, master);

    const tempoNote = tempo
      ? `a ${writtenBpm} BPM beat clock at "${tempo}"`
      : "no beat clock (drone/untimed)";
    return finalize(ctx, {
      summary: `Scaffolded a ${genre} show at ${builder.containerPath}: ${preset.flavor}. It has a "master" output Null (where your mix lands), ${tempoNote}, and a genre look already wired into master. Next: add your own scenes, create_layer_mixer into ${master}, store looks with manage_cue, and create_control_surface to play it.`,
      builder,
      outputPath: master,
      // Structural scaffold — no inline preview (matches scaffold_show).
      capturePreviewImage: false,
      controls,
      extra: {
        genre,
        show: builder.containerPath,
        master,
        tempo,
        bpm: writtenBpm ?? null,
        look,
        palette: preset.palette,
      },
    });
  });
}

export const registerScaffoldGenre: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "scaffold_genre",
    {
      title: "Scaffold a genre show",
      description:
        "Create a genre-flavored starting network under parent_path — beyond scaffold_show's blank skeleton. Picks a tempo, look, and palette per genre: 'techno' (fast ~130 BPM clock + a hard strobe-y feedback look + dark palette), 'ambient' (slow ~70 BPM + a soft blurred-feedback look + warm palette), or 'installation' (no clock + a slow generative noise look + muted palette). Each builds a 'master' output Null and a genre look already wired into it, and (when a tempo applies) writes the project's global tempo (op('/').time.tempo). Use scaffold_show instead for an empty skeleton with no look or palette. Returns the container path, the master/tempo/look node paths, the BPM written, and the palette. Then add scenes, a layer mixer into master, cues, and a control surface.",
      inputSchema: scaffoldGenreSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => scaffoldGenreImpl(ctx, args),
  );
};
