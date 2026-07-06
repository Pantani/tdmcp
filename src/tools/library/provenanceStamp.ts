import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { errorResult, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ── Input schema ──────────────────────────────────────────────────────────────

export const provenanceStampSchema = z.object({
  artifact_path: z.string().describe("Absolute or vault-resolved path to the file to stamp."),
  artifact_kind: z
    .enum(["tox", "recipe_note", "recipe_bundle", "component_bundle", "other"])
    .default("other")
    .describe("What kind of artifact this is — hint only, not validated."),
  source: z
    .object({
      comp_path: z.string().optional().describe("Source COMP path inside TD, e.g. /project1."),
      recipe_id: z.string().optional().describe("Recipe identifier for recipe notes/bundles."),
      tool: z.string().optional().describe("Originating tdmcp tool name, e.g. make_portable_tox."),
    })
    .default({})
    .describe("Where/what produced this artifact."),
  author: z
    .string()
    .optional()
    .describe("Author label. Defaults to TDMCP_AUTHOR env var then os.userInfo().username."),
  tags: z.array(z.string()).default([]).describe("Free-form tags for vault search."),
  notes: z.string().optional().describe("Short human note to attach to the sidecar."),
  extra: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("Tool-specific extras, e.g. {nodes:7, connections:9}."),
  overwrite: z
    .boolean()
    .default(true)
    .describe("Replace an existing sidecar. Set false to refuse if one exists."),
  include_git: z
    .boolean()
    .default(true)
    .describe("Capture git commit/branch/dirty from the artifact's directory (best-effort)."),
});

export type ProvenanceStampArgs = z.infer<typeof provenanceStampSchema>;

// ── Sidecar schema (exported for consumers + tests) ──────────────────────────

export const ProvenanceSidecarSchema = z.object({
  schema_version: z.literal(1),
  kind: z.enum(["tox", "recipe_note", "recipe_bundle", "component_bundle", "other"]),
  artifact: z.object({
    path: z.string(),
    sha256: z.string(),
    size: z.number(),
    mtime: z.string(),
  }),
  source: z.object({
    comp_path: z.string().optional(),
    recipe_id: z.string().optional(),
    tool: z.string().optional(),
  }),
  toolchain: z.object({
    tdmcp_version: z.string(),
    node_version: z.string(),
    platform: z.string(),
  }),
  git: z
    .object({
      commit: z.string(),
      branch: z.string(),
      dirty: z.boolean(),
    })
    .optional(),
  author: z.string(),
  created_at: z.string(),
  tags: z.array(z.string()),
  notes: z.string().optional(),
  extra: z.record(z.string(), z.unknown()),
});

export type ProvenanceSidecar = z.infer<typeof ProvenanceSidecarSchema>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256File(filePath: string): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => res(hash.digest("hex")));
    stream.on("error", rej);
  });
}

function resolveAuthor(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.TDMCP_AUTHOR;
  if (env) return env;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

function captureGit(dir: string): { commit: string; branch: string; dirty: boolean } | undefined {
  const run = (args: string[]) =>
    spawnSync("git", ["-C", dir, ...args], { timeout: 500, encoding: "utf8" });

  const headResult = run(["rev-parse", "HEAD"]);
  if (headResult.status !== 0 || headResult.error) return undefined;

  const branchResult = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const statusResult = run(["status", "--porcelain"]);

  return {
    commit: (headResult.stdout ?? "").trim(),
    branch: branchResult.status === 0 ? (branchResult.stdout ?? "").trim() : "unknown",
    dirty: statusResult.status === 0 ? (statusResult.stdout ?? "").trim().length > 0 : false,
  };
}

function tdmcpVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkg = req("../../../package.json") as Record<string, unknown>;
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── Impl ──────────────────────────────────────────────────────────────────────

export async function provenanceStampImpl(
  _ctx: ToolContext,
  args: ProvenanceStampArgs,
): Promise<ReturnType<typeof jsonResult>> {
  const artifactPath = resolve(args.artifact_path);

  if (!existsSync(artifactPath)) {
    return errorResult(`Artifact not found: ${artifactPath}`);
  }

  const sidecarPath = `${artifactPath}.provenance.json`;

  if (!args.overwrite && existsSync(sidecarPath)) {
    return errorResult(`Sidecar already exists and overwrite=false: ${sidecarPath}`);
  }

  let sha256: string;
  try {
    sha256 = await sha256File(artifactPath);
  } catch (err) {
    return errorResult(`Failed to hash artifact: ${String(err)}`);
  }

  const stat = statSync(artifactPath);
  const dir = dirname(artifactPath);

  const git = args.include_git ? captureGit(dir) : undefined;

  const sidecar: ProvenanceSidecar = {
    schema_version: 1,
    kind: args.artifact_kind,
    artifact: {
      path: basename(artifactPath),
      sha256,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    },
    source: args.source,
    toolchain: {
      tdmcp_version: tdmcpVersion(),
      node_version: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    ...(git !== undefined ? { git } : {}),
    author: resolveAuthor(args.author),
    created_at: new Date().toISOString(),
    tags: args.tags,
    ...(args.notes !== undefined ? { notes: args.notes } : {}),
    extra: args.extra,
  };

  try {
    writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), "utf8");
  } catch (err) {
    return errorResult(`Failed to write sidecar: ${String(err)}`);
  }

  return jsonResult(`Provenance sidecar written: ${sidecarPath}`, {
    sidecar_path: sidecarPath,
    sha256,
    size: stat.size,
    schema_version: 1,
  });
}

// ── Registrar ─────────────────────────────────────────────────────────────────

export const registerProvenanceStamp: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "provenance_stamp",
    {
      title: "Provenance Stamp",
      description:
        "Writes a `.provenance.json` sidecar next to a saved artifact (tox, recipe note, " +
        "recipe bundle, component bundle). Records the sha256 checksum, file size, mtime, " +
        "source COMP path, originating tdmcp tool, toolchain versions, best-effort git " +
        "metadata, author, tags, and freeform notes. Offline — no TD bridge required.",
      inputSchema: provenanceStampSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (callArgs) => provenanceStampImpl(ctx, callArgs),
  );
