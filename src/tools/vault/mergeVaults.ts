import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { z } from "zod";
import { Vault } from "../../vault/index.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requireVault } from "./shared.js";

export const mergeVaultsSchema = z.object({
  sourceVaultPath: z.string().min(1).describe("Absolute path to the source vault."),
  targetVaultPath: z.string().optional().describe("Defaults to the configured TDMCP_VAULT_PATH."),
  strategy: z.enum(["theirs", "ours", "rename", "skip"]).default("rename"),
  kinds: z
    .array(z.enum(["recipes", "shaders", "presets", "components", "setlists", "memory", "all"]))
    .default(["all"]),
  dryRun: z.boolean().default(false),
});

const KIND_FOLDERS: Record<string, string> = {
  recipes: "Recipes",
  shaders: "Shaders",
  presets: "Presets",
  components: "Components",
  setlists: "Setlists",
  memory: "Memory",
};
const ALL_KINDS = Object.keys(KIND_FOLDERS);
const TEXT_EXTS = new Set([".md", ".json", ".glsl", ".frag", ".vert", ".txt"]);
const MAX_ENTRIES = 500;

export interface MergeEntry {
  kind: string;
  action: "add" | "identical" | "theirs" | "ours" | "skip" | "rename";
  sourceRel: string;
  targetRel?: string;
  sourceSha?: string;
  targetSha?: string;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function walkRel(root: string, sub: string): string[] {
  const full = join(root, sub);
  if (!existsSync(full)) return [];
  const results: string[] = [];
  const stack = [sub];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const curFull = join(root, cur);
    const stat = statSync(curFull);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(curFull)) {
        stack.push(join(cur, entry));
      }
    } else {
      results.push(cur);
    }
  }
  return results;
}

function uniqueRenamePath(
  targetVault: Vault,
  dir: string,
  stem: string,
  suffix: string,
  ext: string,
): string {
  let candidate = join(dir, `${stem}.from-${suffix}${ext}`);
  if (!targetVault.exists(candidate)) return candidate;
  let n = 2;
  while (n < 10000) {
    candidate = join(dir, `${stem}.from-${suffix}-${n}${ext}`);
    if (!targetVault.exists(candidate)) return candidate;
    n++;
  }
  return candidate;
}

function buildMergeLog(
  source: string,
  target: string,
  strategy: string,
  dryRun: boolean,
  entries: MergeEntry[],
): string {
  const iso = new Date().toISOString();
  let md = `# Vault merge ${iso}\n\n`;
  md += `- source: ${source}\n`;
  md += `- target: ${target}\n`;
  md += `- strategy: ${strategy}\n`;
  md += `- dryRun: ${dryRun}\n\n`;

  const byKind: Record<string, MergeEntry[]> = {};
  for (const e of entries) {
    if (!byKind[e.kind]) byKind[e.kind] = [];
    (byKind[e.kind] as MergeEntry[]).push(e);
  }

  for (const kind of Object.keys(byKind)) {
    const group = byKind[kind]!;
    const counts: Record<string, number> = {};
    for (const e of group) counts[e.action] = (counts[e.action] ?? 0) + 1;
    const summary = Object.entries(counts)
      .map(([a, c]) => `${a} ${c}`)
      .join(", ");
    md += `## ${KIND_FOLDERS[kind] ?? kind}  (${summary})\n`;
    for (const e of group) {
      if (e.action === "rename" && e.targetRel) {
        md += `- rename     ${e.sourceRel} → ${e.targetRel}\n`;
      } else if (e.action === "theirs" && e.sourceSha && e.targetSha) {
        md += `- theirs     ${e.sourceRel}           (sha ${e.targetSha.slice(0, 8)}… → ${e.sourceSha.slice(0, 8)}…)\n`;
      } else {
        md += `- ${e.action.padEnd(10)} ${e.sourceRel}\n`;
      }
    }
    md += "\n";
  }
  return md;
}

export async function mergeVaultsImpl(
  ctx: ToolContext,
  args: z.infer<typeof mergeVaultsSchema>,
): Promise<ReturnType<typeof errorResult>> {
  // Resolve target vault
  let targetRoot: string;
  if (args.targetVaultPath) {
    targetRoot = resolve(args.targetVaultPath.replace(/^~/, process.env.HOME ?? "~"));
  } else {
    const v = requireVault(ctx);
    if ("error" in v) return v.error;
    targetRoot = v.vault.root;
  }

  // Source must exist
  const sourceRoot = resolve(args.sourceVaultPath.replace(/^~/, process.env.HOME ?? "~"));
  if (!existsSync(sourceRoot)) {
    return errorResult(`Source vault not found: ${sourceRoot}`);
  }
  if (sourceRoot === targetRoot) {
    return errorResult(
      "Source and target vault paths are the same. Refusing to merge a vault into itself.",
    );
  }

  const targetVault = new Vault(targetRoot);

  // Expand kinds
  const kindKeys = args.kinds.includes("all")
    ? ALL_KINDS
    : [...new Set(args.kinds.filter((k) => k !== "all"))];

  const entries: MergeEntry[] = [];
  const sourceVaultName = basename(sourceRoot);

  for (const kind of kindKeys) {
    const folder = KIND_FOLDERS[kind];
    if (!folder) continue;
    const relPaths = walkRel(sourceRoot, folder);
    for (const relPath of relPaths) {
      const srcBytes = readFileSync(join(sourceRoot, relPath));
      const srcSha = sha256(srcBytes);

      if (!targetVault.exists(relPath)) {
        if (!args.dryRun) {
          const isText = TEXT_EXTS.has(extname(relPath).toLowerCase());
          if (isText) {
            targetVault.write(relPath, srcBytes.toString("utf8"));
          } else {
            targetVault.writeBinary(relPath, srcBytes);
          }
        }
        entries.push({ kind, action: "add", sourceRel: relPath });
      } else {
        const tgtBytes = readFileSync(join(targetRoot, relPath));
        const tgtSha = sha256(tgtBytes);
        if (srcSha === tgtSha) {
          entries.push({ kind, action: "identical", sourceRel: relPath });
        } else {
          // Conflict
          switch (args.strategy) {
            case "theirs": {
              if (!args.dryRun) {
                const isText = TEXT_EXTS.has(extname(relPath).toLowerCase());
                if (isText) {
                  targetVault.write(relPath, srcBytes.toString("utf8"));
                } else {
                  targetVault.writeBinary(relPath, srcBytes);
                }
              }
              entries.push({
                kind,
                action: "theirs",
                sourceRel: relPath,
                sourceSha: srcSha,
                targetSha: tgtSha,
              });
              break;
            }
            case "ours": {
              entries.push({
                kind,
                action: "ours",
                sourceRel: relPath,
                sourceSha: srcSha,
                targetSha: tgtSha,
              });
              break;
            }
            case "skip": {
              entries.push({
                kind,
                action: "skip",
                sourceRel: relPath,
                sourceSha: srcSha,
                targetSha: tgtSha,
              });
              break;
            }
            case "rename": {
              const ext = extname(relPath);
              const stem = basename(relPath, ext);
              const dir = dirname(relPath);
              const newRel = uniqueRenamePath(targetVault, dir, stem, sourceVaultName, ext);
              if (!args.dryRun) {
                const isText = TEXT_EXTS.has(ext.toLowerCase());
                if (isText) {
                  targetVault.write(newRel, srcBytes.toString("utf8"));
                } else {
                  targetVault.writeBinary(newRel, srcBytes);
                }
              }
              entries.push({
                kind,
                action: "rename",
                sourceRel: relPath,
                targetRel: newRel,
                sourceSha: srcSha,
                targetSha: tgtSha,
              });
              break;
            }
          }
        }
      }

      if (entries.length >= MAX_ENTRIES + 1) break;
    }
    if (entries.length >= MAX_ENTRIES + 1) break;
  }

  const truncated = entries.length > MAX_ENTRIES;
  const displayEntries = truncated ? entries.slice(0, MAX_ENTRIES) : entries;

  // Counts
  const perKind: Record<string, Record<string, number>> = {};
  const perAction: Record<string, number> = {};
  for (const e of entries) {
    if (!perKind[e.kind]) perKind[e.kind] = {};
    const kindMap = perKind[e.kind] ?? {};
    kindMap[e.action] = (kindMap[e.action] ?? 0) + 1;
    perKind[e.kind] = kindMap;
    perAction[e.action] = (perAction[e.action] ?? 0) + 1;
  }

  let logPath: string | undefined;
  if (!args.dryRun) {
    const ts = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\.\d+Z$/, "Z");
    logPath = `Merge-Logs/${ts}.md`;
    const logContent = buildMergeLog(
      sourceRoot,
      targetRoot,
      args.strategy,
      args.dryRun,
      displayEntries,
    );
    targetVault.write(logPath, logContent);
  }

  const totalAdded = perAction.add ?? 0;
  const totalConflicts =
    (perAction.theirs ?? 0) +
    (perAction.ours ?? 0) +
    (perAction.skip ?? 0) +
    (perAction.rename ?? 0);
  const summary = args.dryRun
    ? `[dry-run] Would add ${totalAdded} files; ${totalConflicts} conflict(s) found.`
    : `Merged ${totalAdded} new file(s); ${totalConflicts} conflict(s) resolved with strategy '${args.strategy}'.`;

  return structuredResult(summary, {
    source: sourceRoot,
    target: targetRoot,
    strategy: args.strategy,
    dryRun: args.dryRun,
    counts: { perKind, perAction },
    entries: displayEntries,
    truncated,
    logPath,
  });
}

export const registerMergeVaults: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "merge_vaults",
    {
      title: "Merge Vaults",
      description:
        "Merge the contents of a source Obsidian vault into a target vault (defaulting to TDMCP_VAULT_PATH). " +
        "Walks Recipes/, Shaders/, Presets/, Components/, Setlists/, and Memory/ folders. " +
        "sha256-hashes each file pair and resolves conflicts with your chosen strategy: " +
        "'theirs' overwrites target, 'ours' keeps target, 'rename' writes a side-by-side copy, 'skip' logs and skips. " +
        "dryRun=true plans without writing. Note: LF/CRLF differences count as conflicts.",
      inputSchema: mergeVaultsSchema.shape,
    },
    (args) => mergeVaultsImpl(ctx, args),
  );
