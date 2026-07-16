import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { manageAgentSkills } from "../skills/installer.js";
import {
  CURATED_SKILL_NAMES,
  type ManageAgentSkillsInput,
  type ManageAgentSkillsResult,
  SkillManagerError,
} from "../skills/types.js";

export interface ManageSkillsCliResult {
  code: 0 | 1 | 2;
  stdout?: string;
  stderr?: string;
}

const ACTIONS = ["status", "install", "update", "uninstall"] as const;
type SkillAction = (typeof ACTIONS)[number];

interface ParsedSkillArgs {
  values: {
    host?: string;
    scope?: string;
    "project-root"?: string;
    skill?: string[];
    apply?: boolean;
    "force-owned-drift"?: boolean;
    json?: boolean;
    help?: boolean;
  };
  positionals: string[];
}

type ValidatedSkillArgs =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | {
      kind: "run";
      action: SkillAction;
      host: "codex" | "claude";
      scope: "project" | "user";
      values: ParsedSkillArgs["values"];
    };

export function renderManageSkillsHelp(): string {
  return [
    "Usage: tdmcp skills <status|install|update|uninstall> --host <codex|claude> --scope <project|user> [flags]",
    "",
    "Manage only the small, package-bundled tdmcp skill catalog.",
    "Mutations are dry-run by default; pass --apply to write manifest-owned files.",
    "",
    "Flags:",
    "  --host <host>            Required: codex or claude.",
    "  --scope <scope>          Required: project or user.",
    "  --project-root <path>    Project root; defaults to the current directory.",
    "  --skill <name>           Select one bundled skill; repeat to select several.",
    "  --apply                  Apply the planned mutation.",
    "  --force-owned-drift      Replace/remove locally changed manifest-owned content.",
    "  --json                   Print the exact structured result.",
    "  --help, -h               Show this help.",
    "",
    `Bundled skills: ${CURATED_SKILL_NAMES.join(", ")}`,
  ].join("\n");
}

function humanResult(result: ManageAgentSkillsResult): string {
  const changes = result.planned.filter((item) => item.operation !== "unchanged").length;
  const lines = [
    `Agent skills: ${result.status}`,
    `Host/scope: ${result.host}/${result.scope}`,
    `Dry run: ${result.dry_run ? "yes" : "no"}`,
    `Planned changes: ${changes}`,
    `Applied changes: ${result.applied.length}`,
  ];
  for (const skill of result.skills) lines.push(`- ${skill.name}: ${skill.state}`);
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}

function parseSkillArgs(argv: string[]): ParsedSkillArgs | { error: string } {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        host: { type: "string" },
        scope: { type: "string" },
        "project-root": { type: "string" },
        skill: { type: "string", multiple: true },
        apply: { type: "boolean", default: false },
        "force-owned-drift": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }) as ParsedSkillArgs;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function validateSkillArgs(parsed: ParsedSkillArgs): ValidatedSkillArgs {
  if (parsed.values.help) return { kind: "help" };
  const [action, ...extra] = parsed.positionals;
  if (!ACTIONS.includes(action as SkillAction) || extra.length > 0) {
    return { kind: "error", message: renderManageSkillsHelp() };
  }
  const host = parsed.values.host;
  if (host !== "codex" && host !== "claude") {
    return { kind: "error", message: "--host must be codex or claude." };
  }
  const scope = parsed.values.scope;
  if (scope !== "project" && scope !== "user") {
    return { kind: "error", message: "--scope must be project or user." };
  }
  return { kind: "run", action: action as SkillAction, host, scope, values: parsed.values };
}

function skillManagerInput(validated: Extract<ValidatedSkillArgs, { kind: "run" }>, cwd: string) {
  const projectRoot = validated.values["project-root"];
  const selectedSkills = validated.values.skill;
  return {
    action: validated.action,
    host: validated.host,
    scope: validated.scope,
    ...(validated.scope === "project" ? { project_root: resolve(cwd, projectRoot ?? cwd) } : {}),
    ...(selectedSkills ? { skills: selectedSkills } : {}),
    dry_run: validated.values.apply !== true,
    force_owned_drift: validated.values["force-owned-drift"] === true,
  } satisfies ManageAgentSkillsInput;
}

function executeSkillManagement(
  input: ManageAgentSkillsInput,
  cwd: string,
  json: boolean,
): ManageSkillsCliResult {
  try {
    const result = manageAgentSkills(input, { projectRoot: cwd });
    const output = json ? `${JSON.stringify(result)}\n` : humanResult(result);
    const failed = result.status === "conflict" || result.status === "failed";
    return { code: failed ? 1 : 0, stdout: output };
  } catch (error) {
    const code = error instanceof SkillManagerError ? `${error.code}: ` : "";
    const message = error instanceof Error ? error.message : String(error);
    return { code: 1, stderr: `${code}${message}\n` };
  }
}

export function runManageSkillsCli(
  argv: string[],
  options: { cwd?: string } = {},
): ManageSkillsCliResult {
  const parsed = parseSkillArgs(argv);
  if ("error" in parsed) return { code: 2, stderr: `${parsed.error}\n` };
  const validated = validateSkillArgs(parsed);
  if (validated.kind === "help") return { code: 0, stdout: `${renderManageSkillsHelp()}\n` };
  if (validated.kind === "error") return { code: 2, stderr: `${validated.message}\n` };
  const cwd = resolve(options.cwd ?? process.cwd());
  return executeSkillManagement(
    skillManagerInput(validated, cwd),
    cwd,
    validated.values.json === true,
  );
}
