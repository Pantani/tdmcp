import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerFixShader: PromptRegistrar = (server) => {
  server.registerPrompt(
    "fix_shader",
    {
      title: "Fix shader",
      description: "Diagnose and fix a GLSL TOP that won't compile.",
      argsSchema: {
        glsl_path: z
          .string()
          .describe("Path of the GLSL TOP (or its container) that has an error."),
      },
    },
    ({ glsl_path }) =>
      userPrompt(
        [
          `Fix the GLSL TOP at ${glsl_path} that isn't compiling.`,
          "",
          `1. Read the actual error: get_td_node_errors on ${glsl_path} (it carries the compiler message and line). Find the Text DAT feeding its 'pixeldat'.`,
          "2. Check it against TouchDesigner's GLSL conventions (the usual culprits):",
          "   - The fragment shader must declare `out vec4 fragColor;` and write it (TD has no implicit gl_FragColor).",
          "   - Sample inputs with `texture(sTD2DInputs[0], vUV.st)` — not `texture2D`, and the coordinate is `vUV.st`.",
          "   - There is no built-in `uTime`; use `absTime.seconds` via a uniform, or drive time from a CHOP. Resolution is `uTD2DInfos[0].res`.",
          "   - Wrap the final color in `TDOutputSwizzle(...)` so it respects the output format.",
          "   - Don't redefine names the TD preamble already provides (e.g. F1/F2 macros).",
          "3. Edit the Text DAT's code to fix the reported error, re-point pixeldat if needed, then re-check get_td_node_errors and get_preview to confirm it compiles and renders. Explain what was wrong.",
        ].join("\n"),
      ),
  );
};
