import { z } from "zod";
import type { Vault } from "../../vault/index.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requireVault } from "./shared.js";

export const bindVaultTextSchema = z.object({
  note: z
    .string()
    .min(1)
    .describe("Vault-relative note to read into TD (lyrics, poetry, any text content)."),
  parent_path: z.string().describe("Parent COMP to create the Text DAT inside."),
  name: z.string().optional().describe("Name for the Text DAT (defaults to a slug of the note)."),
  sync: z
    .boolean()
    .default(true)
    .describe("Keep the DAT synced to the file, so edits in Obsidian show up live in TD."),
});
type BindVaultTextArgs = z.infer<typeof bindVaultTextSchema>;

const q = (value: string): string => JSON.stringify(value);

function defaultName(note: string): string {
  const stem = note.replace(/\.md$/i, "").split(/[\\/]/).pop() ?? "vaulttext";
  return (
    stem
      .trim()
      .replace(/[^a-zA-Z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || "vaulttext"
  );
}

function resolveNotePath(vault: Vault, note: string): string | undefined {
  const candidates = note.endsWith(".md") ? [note] : [`${note}.md`, note];
  for (const candidate of candidates) {
    try {
      if (vault.exists(candidate)) return candidate;
    } catch {
      // candidate escapes the vault root — skip it
    }
  }
  return undefined;
}

export async function bindVaultTextImpl(ctx: ToolContext, args: BindVaultTextArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const rel = resolveNotePath(vault, args.note);
  if (!rel) {
    return errorResult(`Text note not found in the vault: ${args.note}.`);
  }
  const absPath = vault.resolve(rel);

  return guardTd(
    async () => {
      const dat = await ctx.client.createNode({
        parent_path: args.parent_path,
        type: "textDAT",
        name: args.name ?? defaultName(rel),
      });
      // `file` always exists on a Text DAT; `syncfile` / the load pulse are guarded
      // so a TD build that names them differently degrades to a one-shot load.
      const script =
        `_d = op(${q(dat.path)})\n` +
        `_d.par.file = ${q(absPath)}\n` +
        `try:\n    _d.par.syncfile = ${args.sync ? "True" : "False"}\nexcept Exception:\n    pass\n` +
        `try:\n    _d.par.loadonstartpulse.pulse()\nexcept Exception:\n    pass`;
      await ctx.client.executePythonScript(script, false);
      return dat;
    },
    (dat) =>
      jsonResult(`Bound Text DAT ${dat.path} to ${rel}.`, {
        dat: dat.path,
        note: rel,
        file: absPath,
        synced: args.sync,
      }),
  );
}

export const registerBindVaultText: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "bind_vault_text",
    {
      title: "Bind a Text DAT to a vault note",
      description:
        "Create a Text DAT whose content is read from a vault note (and, with sync on, kept live as you edit the note in Obsidian) — turning the vault into the text/lyrics source for your visuals. Wire the DAT into a Text TOP to render it. Requires TDMCP_VAULT_PATH.",
      inputSchema: bindVaultTextSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => bindVaultTextImpl(ctx, args),
  );
};
