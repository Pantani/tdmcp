import { z } from "zod";
import { extractFencedBlock } from "../../vault/frontmatter.js";
import type { Vault } from "../../vault/index.js";
import { createGlslShaderImpl, createGlslShaderSchema } from "../layer2/createGlslShader.js";
import { errorResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { readNoteSafe, requireVault } from "./shared.js";

export const applyShaderFromVaultSchema = z.object({
  note: z
    .string()
    .min(1)
    .describe(
      "Shader note: a vault-relative path, or a name resolved against the Shaders/ folder.",
    ),
  parent_path: z.string().describe("Parent COMP to create the GLSL TOP inside."),
  name: z
    .string()
    .optional()
    .describe("Name for the GLSL TOP (defaults to the note's frontmatter `name`, else 'glsl1')."),
});
type ApplyShaderFromVaultArgs = z.infer<typeof applyShaderFromVaultSchema>;

function resolveNotePath(vault: Vault, note: string): string | undefined {
  const candidates = note.endsWith(".md")
    ? [note, `Shaders/${note}`]
    : [`${note}.md`, `Shaders/${note}.md`, note, `Shaders/${note}`];
  for (const candidate of candidates) {
    try {
      if (vault.exists(candidate)) return candidate;
    } catch {
      // candidate escapes the vault root — skip it
    }
  }
  return undefined;
}

export async function applyShaderFromVaultImpl(ctx: ToolContext, args: ApplyShaderFromVaultArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const rel = resolveNotePath(vault, args.note);
  if (!rel) {
    return errorResult(`Shader note not found: ${args.note} (looked under Shaders/ too).`);
  }

  const note = readNoteSafe(vault, rel);
  if ("error" in note) return note.error;
  const { data, body } = note;
  const fragment = extractFencedBlock(body, "glsl");
  if (!fragment) {
    return errorResult(`No \`\`\`glsl fragment block found in ${rel}.`);
  }
  const vertex = extractFencedBlock(body, "glslvert");

  // Validate the assembled args against the real create_glsl_shader schema, so a
  // malformed frontmatter `uniforms`/`resolution` fails loudly rather than silently.
  const parsed = createGlslShaderSchema.safeParse({
    parent_path: args.parent_path,
    name: args.name ?? (typeof data.name === "string" ? data.name : undefined),
    fragment_shader: fragment,
    vertex_shader: vertex,
    uniforms: data.uniforms,
    resolution: typeof data.resolution === "string" ? data.resolution : undefined,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return errorResult(`Shader note "${rel}" produced invalid arguments: ${issues}`);
  }

  return createGlslShaderImpl(ctx, parsed.data);
}

export const registerApplyShaderFromVault: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "apply_shader_from_vault",
    {
      title: "Apply a GLSL shader from the vault",
      description:
        "Read a shader note from the Obsidian vault (a ```glsl fragment block, optional ```glslvert vertex block, and optional `uniforms`/`resolution`/`name` frontmatter) and create a GLSL TOP from it. Requires TDMCP_VAULT_PATH.",
      inputSchema: applyShaderFromVaultSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => applyShaderFromVaultImpl(ctx, args),
  );
};
