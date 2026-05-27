import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerTextToShader: PromptRegistrar = (server) => {
  server.registerPrompt(
    "text_to_shader",
    {
      title: "Text to shader",
      description:
        "Author a GLSL TOP fragment shader from a plain-language description, then create and validate it in TD.",
      argsSchema: {
        description: z
          .string()
          .describe(
            "What the shader should look like, e.g. 'warping plasma in teal and magenta', 'raymarched tunnel', 'animated voronoi'.",
          ),
        parent_path: z
          .string()
          .optional()
          .describe("Where to create the GLSL TOP (default: a sensible container at /project1)."),
        resolution: z
          .string()
          .optional()
          .describe("Output resolution, e.g. '1280x720' (default 1280x720)."),
      },
    },
    ({ description, parent_path, resolution }) =>
      userPrompt(
        [
          `Write a GLSL TOP fragment shader for: "${description}". Author it, create it, and confirm it compiles and renders.`,
          "",
          "Follow TouchDesigner's GLSL conventions while writing — these are the rules that make or break it:",
          "   - Declare `out vec4 fragColor;` and write the final color through `fragColor = TDOutputSwizzle(vec4(rgb, a));` (TD has no implicit gl_FragColor, and the swizzle respects the output format).",
          "   - Sample inputs with `texture(sTD2DInputs[0], vUV.st)` (not `texture2D`); read resolution from `uTD2DInfos[0].res`. The default UV is `vUV.st`.",
          "   - There is no built-in `uTime`. Declare your own uniform (e.g. `uniform float uTime;`) and bind it via the GLSL TOP's Vectors sequence — drive it from a CHOP (a tempo ramp, or `absTime.seconds`). Do not assume a time variable exists.",
          "   - Avoid short UPPERCASE identifiers like F1, F2, PI, etc. — TD's preamble already #defines several of them and you'll get redefinition errors. Use lowercase or longer names (`f1`, `kPi`).",
          `2. Create it: create_glsl_shader (or create_td_node of type glslTOP) under ${parent_path || "a fitting container"} at ${resolution || "1280x720"}, feeding your fragment code into its Text/Pixel DAT (the 'pixeldat'). Set up the time uniform in the Vectors sequence and wire a tempo/ramp CHOP into it if the look animates.`,
          "3. Validate immediately: get_td_node_errors on the GLSL TOP (and read its Info DAT) to catch compile errors — the message carries the failing line. If it doesn't compile, fix the reported issue in the DAT and re-check; iterate until clean.",
          "4. get_preview to confirm it actually renders the intended look. Refine the maths/colors if it's off, then tell the user what the shader does and which uniform drives time so they can tweak it.",
        ].join("\n"),
      ),
  );
};
