import { z } from "zod";
import { type PromptRegistrar, userPrompt } from "./types.js";

export const registerTeachTouchDesigner: PromptRegistrar = (server) => {
  server.registerPrompt(
    "teach_touchdesigner",
    {
      title: "Teach a TouchDesigner concept",
      description:
        "Teach a TouchDesigner concept grounded in the embedded knowledge base, not generic web knowledge.",
      argsSchema: {
        topic: z
          .string()
          .describe(
            "The TouchDesigner concept to learn, e.g. 'feedback loops', 'CHOP-to-SOP', 'instancing', 'render TOP pipeline'.",
          ),
      },
    },
    ({ topic }) =>
      userPrompt(
        [
          `Teach me this TouchDesigner concept: ${topic}.`,
          "",
          "Ground the lesson in tdmcp's embedded knowledge base, not generic web knowledge.",
          "Before answering, consult the knowledge resources:",
          "- Read the relevant tdmcp://operators/{type} resources (TOP, CHOP, SOP, MAT, DAT, COMP) for the operators this concept involves, and use their real TouchDesigner type names.",
          "- Read the tdmcp://tutorials resource (and any tdmcp://tutorials/{slug} it points to) for worked patterns on this topic.",
          "",
          "Then structure the lesson:",
          "1. What it is — explain the concept plainly and why it matters in TouchDesigner.",
          "2. The key operators involved — name them with their real TD types (e.g. Feedback TOP, Noise CHOP) and say what each contributes.",
          "3. A minimal worked example — the smallest network that demonstrates it, described so the artist could build it with tdmcp tools.",
          "4. One common gotcha — a pitfall newcomers hit with this concept, and how to avoid it.",
          "",
          "This is about teaching the concept, not building a finished project. Keep it concise and concrete.",
        ].join("\n"),
      ),
  );
};
