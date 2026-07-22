import { z } from "zod";
import { manageAgentSkills } from "../../skills/installer.js";
import {
  CURATED_SKILL_NAMES,
  type ManageAgentSkillsOptions,
  type ManageAgentSkillsResult,
  SKILL_CATALOG_LIMITS,
  SkillManagerError,
} from "../../skills/types.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const curatedSkillNameSchema = z
  .string()
  .regex(/^tdmcp-[a-z0-9-]+$/u)
  .refine((name) => (CURATED_SKILL_NAMES as readonly string[]).includes(name), {
    message: "Skill is not in the bundled tdmcp catalog.",
  });

export const manageAgentSkillsSchema = z.object({
  action: z
    .enum(["status", "install", "update", "uninstall"])
    .describe("Inspect, install, update, or uninstall manifest-owned bundled tdmcp skills."),
  host: z.enum(["codex", "claude"]).describe("Agent host whose skill directory is managed."),
  scope: z
    .enum(["project", "user"])
    .describe("Project-local or current-user skill installation scope."),
  project_root: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .optional()
    .describe("Absolute project path. Required for project scope unless a CLI injects its cwd."),
  skills: z
    .array(curatedSkillNameSchema)
    .max(SKILL_CATALOG_LIMITS.maxSkills)
    .optional()
    .describe("Bundled skills to manage. Omit for the complete curated catalog."),
  dry_run: z
    .boolean()
    .default(true)
    .describe("Plan without writing. Must be explicitly false to apply a mutation."),
  force_owned_drift: z
    .boolean()
    .default(false)
    .describe(
      "Allow replacement/removal of content already recorded by the manifest but locally changed. Never permits touching unowned paths.",
    ),
});

type ManageAgentSkillsArgs = z.infer<typeof manageAgentSkillsSchema>;

const skillOperationOutputSchema = z.object({
  operation: z.enum(["install", "update", "remove", "unchanged"]),
  name: curatedSkillNameSchema,
  path: z.string(),
  from_sha256: z.string().optional(),
  to_sha256: z.string().optional(),
});

const skillStatusOutputSchema = z.object({
  name: curatedSkillNameSchema,
  path: z.string(),
  state: z.enum([
    "not_installed",
    "installed",
    "outdated",
    "missing",
    "drifted",
    "unowned_conflict",
  ]),
  source_sha256: z.string(),
  installed_sha256: z.string().optional(),
  owned: z.boolean(),
});

export const manageAgentSkillsOutputSchema = z.object({
  action: z.enum(["status", "install", "update", "uninstall"]),
  status: z.enum(["planned", "applied", "no_change", "conflict", "failed"]),
  dry_run: z.boolean(),
  host: z.enum(["codex", "claude"]),
  scope: z.enum(["project", "user"]),
  target_root: z.string(),
  manifest_path: z.string(),
  source_version: z.string(),
  planned: z.array(skillOperationOutputSchema),
  applied: z.array(skillOperationOutputSchema),
  skills: z.array(skillStatusOutputSchema),
  warnings: z.array(z.string()),
});

function summarizeManageAgentSkills(result: ManageAgentSkillsResult): string {
  switch (result.status) {
    case "planned":
      return `Planned ${result.planned.filter((item) => item.operation !== "unchanged").length} tdmcp skill change(s); dry run made no writes.`;
    case "applied":
      return `Applied ${result.applied.length} tdmcp skill change(s) to ${result.target_root}.`;
    case "no_change":
      return `No tdmcp skill changes are needed in ${result.target_root}.`;
    case "conflict":
      return `No tdmcp skill changes were applied because ${result.warnings.length} conflict(s) require attention.`;
    case "failed":
      return "The tdmcp skill transaction failed and was rolled back.";
  }
}

function isFailedSkillResult(result: ManageAgentSkillsResult): boolean {
  return result.status === "conflict" || result.status === "failed";
}

export async function manageAgentSkillsImpl(
  ctx: ToolContext,
  args: ManageAgentSkillsArgs,
  options: ManageAgentSkillsOptions = {},
) {
  void ctx;
  try {
    const result = manageAgentSkills(args, options);
    const response = structuredResult(summarizeManageAgentSkills(result), result);
    return isFailedSkillResult(result) ? { ...response, isError: true as const } : response;
  } catch (error) {
    const code = error instanceof SkillManagerError ? `${error.code}: ` : "";
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Agent skill management rejected: ${code}${message}`);
  }
}

export const registerManageAgentSkills: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "manage_agent_skills",
    {
      title: "Manage bundled agent skills",
      description:
        "Safely inspect, install, update, or uninstall the small bundled tdmcp skill catalog for Codex or Claude. Mutations default to dry-run, use exact manifest ownership, reject unowned conflicts and symlinks, and roll back partial filesystem changes. Only package-bundled skills are accepted; this is not a remote or arbitrary skill installer.",
      inputSchema: manageAgentSkillsSchema.shape,
      outputSchema: manageAgentSkillsOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (args) => manageAgentSkillsImpl(ctx, args),
  );
};
