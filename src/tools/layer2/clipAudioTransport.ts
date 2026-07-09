import { z } from "zod";
import type { ToolContext, ToolRegistrar } from "../types.js";
import type { ControlSpec } from "./createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

export const clipAudioTransportSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path where the transport container is created."),
  name: z
    .string()
    .default("clip_audio_transport")
    .describe("Name of the transport container COMP to create."),
  movie_file: z.string().optional().describe("Optional movie file path for the Movie File In TOP."),
  audio_file: z
    .string()
    .optional()
    .describe("Optional audio file path for the Audio File In CHOP."),
  include_audio: z
    .boolean()
    .default(true)
    .describe("Create an Audio File In CHOP transport lane alongside the movie lane."),
  autoplay: z.boolean().default(true).describe("Initial play state for movie/audio file inputs."),
  loop: z.boolean().default(true).describe("Initial loop state for movie/audio file inputs."),
  speed: z.coerce
    .number()
    .min(-4)
    .max(4)
    .default(1)
    .describe("Initial playback speed. Negative values reverse where the operator supports it."),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Expose Play, Loop and Speed custom parameters on the transport container."),
});
type ClipAudioTransportArgs = z.infer<typeof clipAudioTransportSchema>;

function cleanParams(parameters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== undefined));
}

function movieLoopParams(loop: boolean): Record<string, string> {
  const extend = loop ? "cycle" : "hold";
  return { textendleft: extend, textendright: extend };
}

function audioLoopParam(loop: boolean): Record<string, string> {
  return { repeat: loop ? "on" : "off" };
}

export async function clipAudioTransportImpl(ctx: ToolContext, args: ClipAudioTransportArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const play = args.autoplay ? 1 : 0;

    const movie = await builder.add(
      "moviefileinTOP",
      "movie_clip",
      cleanParams({
        file: args.movie_file,
        play,
        ...movieLoopParams(args.loop),
        speed: args.speed,
      }),
    );
    const videoOut = await builder.add("nullTOP", "video_out");
    await builder.connect(movie, videoOut);

    let audio: string | undefined;
    let audioOut: string | undefined;
    if (args.include_audio) {
      audio = await builder.add(
        "audiofileinCHOP",
        "audio_clip",
        cleanParams({
          file: args.audio_file,
          play,
          ...audioLoopParam(args.loop),
          speed: args.speed,
        }),
      );
      audioOut = await builder.add("nullCHOP", "audio_out");
      await builder.connect(audio, audioOut);
    }

    const bindTargets = (param: string) => [
      `${movie}.${param}`,
      ...(audio ? [`${audio}.${param}`] : []),
    ];
    const loopBindTargets = [
      `${movie}.textendleft`,
      `${movie}.textendright`,
      ...(audio ? [`${audio}.repeat`] : []),
    ];
    const controls: ControlSpec[] = args.expose_controls
      ? [
          {
            name: "Play",
            type: "toggle",
            default: args.autoplay,
            bind_to: bindTargets("play"),
          },
          {
            name: "Loop",
            type: "toggle",
            default: args.loop,
            bind_to: loopBindTargets,
          },
          {
            name: "Speed",
            type: "float",
            min: -4,
            max: 4,
            default: args.speed,
            bind_to: bindTargets("speed"),
          },
        ]
      : [];

    const fileNote =
      args.movie_file || args.audio_file ? "" : " (set movie/audio file paths in TouchDesigner)";
    return finalize(ctx, {
      summary: `Built clip/audio transport ${builder.containerPath}: movie lane → ${videoOut}${
        audioOut ? `, audio lane → ${audioOut}` : ""
      }${fileNote}.`,
      builder,
      outputPath: videoOut,
      controls,
      extra: {
        movie,
        video_output: videoOut,
        audio,
        audio_output: audioOut,
        movie_file: args.movie_file,
        audio_file: args.audio_file,
        autoplay: args.autoplay,
        loop: args.loop,
        speed: args.speed,
      },
    });
  });
}

export const registerClipAudioTransport: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "clip_audio_transport",
    {
      title: "Clip/audio transport",
      description:
        "Create a synchronized clip transport container: a Movie File In TOP video lane, optional Audio File In CHOP lane, Null outputs, deterministic layout, and Play/Loop/Speed controls bound across both lanes. Use it as a reusable building block before clip launchers, VJ decks, or stream/output chains.",
      inputSchema: clipAudioTransportSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => clipAudioTransportImpl(ctx, args),
  );
};
