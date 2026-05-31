import { z } from "zod";
import { recipeToMarkdown } from "../../recipes/markdown.js";
import { RecipeSchema } from "../../recipes/schema.js";
import { STYLE_NOTE_REL, StyleMemorySchema, writeStyleMemory } from "../../vault/memoryNote.js";
import { jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requireVault } from "./shared.js";

export const scaffoldVaultSchema = z.object({
  overwrite: z
    .boolean()
    .default(false)
    .describe("Overwrite starter files that already exist (otherwise they're left untouched)."),
});
type ScaffoldVaultArgs = z.infer<typeof scaffoldVaultSchema>;

const README = `# tdmcp vault

This Obsidian vault is wired into TouchDesigner through tdmcp. Folders:

- **Recipes/** — reusable network templates. \`list_recipes\`/\`apply_recipe\` see them
  alongside the built-ins; capture new ones with \`save_recipe_to_vault\`.
- **Setlists/** — \`tracks\` lists that \`import_setlist\` builds into a show.
- **Shaders/** — \`\`\`glsl notes you drop into a GLSL TOP with \`apply_shader_from_vault\`.
- **Moodboards/** — palette + mood notes that seed \`generate_from_moodboard\`.
- **Presets/** — preset snapshots exported by \`sync_presets_vault\`.
- **Networks/** — patch maps written by \`export_network_to_vault\`.
- **Performances/** — a dated diary written by \`log_performance\`.
- **Memory/** — standing notes the assistant reads/merges (e.g. \`style.md\`)
  to remember the artist's palettes, banned moves, and conventions across
  sessions. Edit \`style.md\`'s frontmatter to seed the memory.
`;

const MEMORY_README = `# Memory

Standing notes the assistant reads/merges to remember preferences across
sessions. Each note's frontmatter is the structured payload; the body is
free-form notes the artist can edit.

- **style.md** — palettes, banned moves, favourite generators, naming/layout
  conventions. Read by every tool that benefits from artist context; written
  back when the assistant learns something new.

Add more topic notes here as \`Memory/<topic>.md\` (loose schema — see
\`MemoryNoteSchema\` in \`src/vault/memoryNote.ts\`).
`;

const PLASMA_SHADER = `out vec4 fragColor;
void main() {
  vec2 uv = vUV.st;
  vec3 col = 0.5 + 0.5 * cos(vec3(0.0, 2.0, 4.0) + (uv.x + uv.y) * 6.28318);
  fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
`;

function exampleRecipeMarkdown(): string {
  const recipe = RecipeSchema.parse({
    id: "example_glow",
    name: "Example Glow",
    description: "A starter recipe: animated noise softened by a blur.",
    tags: ["example", "starter"],
    difficulty: "beginner",
    nodes: [
      { name: "noise1", type: "noiseTOP", parameters: { period: 6 } },
      { name: "blur1", type: "blurTOP", parameters: { size: 8 } },
      { name: "out1", type: "nullTOP" },
    ],
    connections: [
      { from: "noise1", to: "blur1" },
      { from: "blur1", to: "out1" },
    ],
    preview_description: "Soft, slowly drifting colored glow.",
  });
  return recipeToMarkdown(recipe);
}

export function scaffoldVaultImpl(ctx: ToolContext, args: ScaffoldVaultArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const files: Array<{ rel: string; render: () => void }> = [
    { rel: "README.md", render: () => vault.write("README.md", README) },
    {
      rel: "Recipes/example_glow.md",
      render: () => vault.write("Recipes/example_glow.md", exampleRecipeMarkdown()),
    },
    {
      rel: "Setlists/example-set.md",
      render: () =>
        vault.writeNote(
          "Setlists/example-set.md",
          { type: "tdmcp-setlist", tracks: ["example_glow", "feedback_tunnel"] },
          "Example set — references the starter recipe plus a built-in. Build it with import_setlist.",
        ),
    },
    {
      rel: "Shaders/example-plasma.md",
      render: () =>
        vault.writeNote(
          "Shaders/example-plasma.md",
          { type: "tdmcp-shader", name: "plasma" },
          `A static plasma gradient — drop it into a GLSL TOP with apply_shader_from_vault.\n\n\`\`\`glsl\n${PLASMA_SHADER}\`\`\`\n`,
        ),
    },
    {
      rel: "Memory/README.md",
      render: () => vault.write("Memory/README.md", MEMORY_README),
    },
    {
      rel: STYLE_NOTE_REL,
      render: () => writeStyleMemory(vault, StyleMemorySchema.parse({})),
    },
    {
      rel: "Moodboards/sunset.md",
      render: () =>
        vault.writeNote(
          "Moodboards/sunset.md",
          {
            type: "tdmcp-moodboard",
            technique: "fractal",
            palette: ["#1a1a2e", "#e94560", "#0f3460"],
          },
          "Warm sunset bleeding into deep blue. Slow, organic drift. Feed it to generate_from_moodboard.",
        ),
    },
  ];

  const created: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (vault.exists(file.rel) && !args.overwrite) {
      skipped.push(file.rel);
      continue;
    }
    file.render();
    created.push(file.rel);
  }

  return jsonResult(
    `Scaffolded ${created.length} starter file(s) into the vault${skipped.length ? `, skipped ${skipped.length} existing` : ""}.`,
    { root: vault.root, created, skipped },
  );
}

export const registerScaffoldVault: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "scaffold_vault",
    {
      title: "Scaffold a starter vault",
      description:
        "Populate the configured Obsidian vault with a starter layout and worked examples (a README plus example recipe, setlist, shader, and moodboard notes) so you begin from a working vault instead of an empty folder. WRITES Markdown files into the vault root and its subfolders; existing files are skipped unless overwrite:true. Run this once when first setting up a vault, before save_recipe_to_vault/import_setlist/etc. Returns the vault root path and the lists of files created vs skipped. Requires a configured TDMCP_VAULT_PATH.",
      inputSchema: scaffoldVaultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => scaffoldVaultImpl(ctx, args),
  );
};
