import { z } from "zod";
import type { Vault } from "../../vault/index.js";
import {
  createGenerativeArtImpl,
  createGenerativeArtSchema,
} from "../layer1/createGenerativeArt.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { readNoteSafe, requireVault } from "./shared.js";

export const generateFromMoodboardSchema = z.object({
  note: z
    .string()
    .min(1)
    .describe("Moodboard note: a vault path, or a name resolved against the Moodboards/ folder."),
  parent_path: z.string().default("/project1").describe("COMP to build the generative system in."),
  technique: z
    .string()
    .optional()
    .describe(
      "Override the technique (otherwise the note's `technique` frontmatter, else fractal).",
    ),
});
type GenerateFromMoodboardArgs = z.infer<typeof generateFromMoodboardSchema>;

function resolveNotePath(vault: Vault, note: string): string | undefined {
  const candidates = note.endsWith(".md")
    ? [note, `Moodboards/${note}`]
    : [`${note}.md`, `Moodboards/${note}.md`, note, `Moodboards/${note}`];
  for (const candidate of candidates) {
    try {
      if (vault.exists(candidate)) return candidate;
    } catch {
      // candidate escapes the vault root — skip it
    }
  }
  return undefined;
}

/** Folds palette/mood frontmatter + the note's first prose line into one best-effort hint. */
function paletteHint(data: Record<string, unknown>, body: string): string | undefined {
  const parts: string[] = [];
  for (const key of ["palette", "colors", "mood", "style"]) {
    const val = data[key];
    if (Array.isArray(val)) parts.push(val.map(String).join(", "));
    else if (typeof val === "string") parts.push(val);
  }
  const firstLine = body
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  if (firstLine) parts.push(firstLine);
  const hint = parts.filter(Boolean).join(" — ");
  return hint || undefined;
}

export async function generateFromMoodboardImpl(ctx: ToolContext, args: GenerateFromMoodboardArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const rel = resolveNotePath(vault, args.note);
  if (!rel) {
    return errorResult(`Moodboard note not found: ${args.note} (looked under Moodboards/ too).`);
  }

  const note = readNoteSafe(vault, rel);
  if ("error" in note) return note.error;
  const { data, body } = note;
  const technique =
    args.technique ?? (typeof data.technique === "string" ? data.technique : "fractal");

  const parsed = createGenerativeArtSchema.safeParse({
    technique,
    color_palette: paletteHint(data, body),
    evolution_speed: typeof data.speed === "number" ? data.speed : undefined,
    parent_path: args.parent_path,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return errorResult(`Moodboard "${rel}" produced invalid arguments: ${issues}`);
  }

  return createGenerativeArtImpl(ctx, parsed.data);
}

export const registerGenerateFromMoodboard: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "generate_from_moodboard",
    {
      title: "Generate art from a moodboard note",
      description:
        "READ a moodboard note (frontmatter `technique`/`palette`/`colors`/`speed` plus a prose description) and CREATE a matching generative system in TouchDesigner via create_generative_art. Side effect is node creation in TD, not file writes; the palette/mood is passed only as a best-effort color hint. Use this to seed a system from a vault moodboard; call create_generative_art directly to specify the technique and palette inline. Returns the created generative-art network (same result as create_generative_art). Requires a configured TDMCP_VAULT_PATH.",
      inputSchema: generateFromMoodboardSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => generateFromMoodboardImpl(ctx, args),
  );
};
