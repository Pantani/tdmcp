import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  TdCompatibilityChange,
  TdOperatorCompatibility,
  TdPythonApiCompatibilityEntry,
  TdReleaseHighlight,
  TdVersionInfo,
} from "../../knowledge/types.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const planTdVersionMigrationSchema = z.object({
  from_version: z
    .string()
    .min(1)
    .describe("Current TouchDesigner stable version, e.g. 099, 2023, or 2024."),
  to_version: z
    .string()
    .min(1)
    .optional()
    .describe("Target TouchDesigner stable version. Defaults to the current stable release."),
  query: z
    .string()
    .optional()
    .describe("Optional project focus terms, e.g. web render, POP, script, DMX."),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .default(25)
    .describe("Maximum entries to return in each compatibility section."),
});
type PlanTdVersionMigrationInput = z.input<typeof planTdVersionMigrationSchema>;
type PlanTdVersionMigrationArgs = z.output<typeof planTdVersionMigrationSchema>;

const versionSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  supportStatus: z.string().optional(),
  pythonVersion: z.string().optional(),
  notes: z.string().optional(),
});

const releaseHighlightSchema = z.object({
  version: z.string(),
  label: z.string().optional(),
  releaseYear: z.number().optional(),
  theme: z.string().optional(),
  highlights: z.array(z.string()),
  newOperators: z.array(z.string()),
  pythonHighlights: z.array(z.string()),
  breakingChanges: z.array(z.string()),
});

const operatorCompatibilitySchema = z.object({
  name: z.string(),
  category: z.string().optional(),
  addedIn: z.string().optional(),
  removedIn: z.string().nullable().optional(),
  notes: z.string().optional(),
  changes: z.array(z.string()).optional(),
});

const pythonApiAdditionSchema = z.object({
  ref: z.string(),
  className: z.string(),
  name: z.string(),
  kind: z.enum(["method", "member"]),
  signature: z.string().optional(),
  addedIn: z.string().optional(),
  description: z.string().optional(),
});

export const planTdVersionMigrationOutputSchema = z.object({
  fromVersion: versionSummarySchema,
  toVersion: versionSummarySchema,
  query: z.string().optional(),
  direction: z.enum(["upgrade", "same_version", "downgrade"]),
  versionPath: z.array(z.string()).describe("Stable versions crossed after from_version."),
  releaseHighlights: z.array(releaseHighlightSchema),
  operatorAdditions: z.array(operatorCompatibilitySchema),
  operatorChanges: z.array(operatorCompatibilitySchema),
  pythonApiAdditions: z.array(pythonApiAdditionSchema),
  checklist: z.array(z.string()),
  warnings: z.array(z.string()),
});

type VersionSummary = z.output<typeof versionSummarySchema>;
type ReleaseHighlightReport = z.output<typeof releaseHighlightSchema>;
type OperatorCompatibilityReport = z.output<typeof operatorCompatibilitySchema>;
type PythonApiAdditionReport = z.output<typeof pythonApiAdditionSchema>;

function versionSummary(version: TdVersionInfo): VersionSummary {
  return {
    id: version.id,
    label: version.label,
    supportStatus: version.supportStatus,
    pythonVersion: version.pythonVersion ?? version.pythonMajorMinor,
    notes: version.notes,
  };
}

function queryTerms(query: string | undefined): string[] {
  return (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesQuery(terms: string[], ...fields: Array<string | undefined>): boolean {
  if (terms.length === 0) return true;
  const text = fields.filter(Boolean).join(" ").toLowerCase();
  return terms.some((term) => text.includes(term));
}

function changeText(
  changes: TdCompatibilityChange[] | undefined,
  versionIds: Set<string>,
): string[] {
  return (changes ?? [])
    .filter((change) => versionIds.has(change.version))
    .map((change) => change.change);
}

function versionIndex(versions: TdVersionInfo[], version: TdVersionInfo): number {
  return versions.findIndex((entry) => entry.id === version.id);
}

function versionPath(
  versions: TdVersionInfo[],
  fromVersion: TdVersionInfo,
  toVersion: TdVersionInfo,
): {
  direction: z.output<typeof planTdVersionMigrationOutputSchema>["direction"];
  path: TdVersionInfo[];
} {
  const fromIndex = versionIndex(versions, fromVersion);
  const toIndex = versionIndex(versions, toVersion);
  if (fromVersion.id === toVersion.id) return { direction: "same_version", path: [] };
  if (fromIndex === -1 || toIndex === -1) return { direction: "upgrade", path: [toVersion] };
  if (fromIndex < toIndex)
    return { direction: "upgrade", path: versions.slice(fromIndex + 1, toIndex + 1) };
  return { direction: "downgrade", path: versions.slice(toIndex, fromIndex).reverse() };
}

function releaseHighlightReport(
  version: TdVersionInfo,
  highlight: TdReleaseHighlight | undefined,
): ReleaseHighlightReport | undefined {
  if (!highlight) return undefined;
  return {
    version: version.id,
    label: highlight.label,
    releaseYear: highlight.releaseYear,
    theme: highlight.theme,
    highlights: highlight.highlights ?? [],
    newOperators: highlight.newOperators ?? [],
    pythonHighlights: highlight.pythonHighlights ?? [],
    breakingChanges: highlight.breakingChanges ?? [],
  };
}

function operatorAdditionReport(record: TdOperatorCompatibility): OperatorCompatibilityReport {
  return {
    name: record.name,
    category: record.category,
    addedIn: record.addedIn,
    removedIn: record.removedIn,
    notes: record.notes,
  };
}

function operatorChangeReport(
  record: TdOperatorCompatibility,
  versionIds: Set<string>,
): OperatorCompatibilityReport {
  return {
    name: record.name,
    category: record.category,
    addedIn: record.addedIn,
    removedIn: record.removedIn,
    notes: record.notes,
    changes: changeText(record.changedIn, versionIds),
  };
}

function pythonAdditionReport(entry: TdPythonApiCompatibilityEntry): PythonApiAdditionReport {
  return {
    ref: `${entry.class}.${entry.name}`,
    className: entry.class,
    name: entry.name,
    kind: entry.kind,
    signature: entry.signature,
    addedIn: entry.addedIn,
    description: entry.description,
  };
}

function migrationChecklist(args: {
  direction: z.output<typeof planTdVersionMigrationOutputSchema>["direction"];
  releaseHighlights: ReleaseHighlightReport[];
  operatorAdditions: OperatorCompatibilityReport[];
  operatorChanges: OperatorCompatibilityReport[];
  pythonApiAdditions: PythonApiAdditionReport[];
}): string[] {
  const checklist: string[] = [];
  if (args.direction === "same_version") {
    checklist.push(
      "No version boundary crossed; use this as a compatibility audit for the current project.",
    );
  }
  if (args.direction === "downgrade") {
    checklist.push(
      "Downgrade requested; verify any operators or Python APIs introduced after the target version.",
    );
  }
  for (const release of args.releaseHighlights) {
    for (const change of release.breakingChanges) {
      checklist.push(`Review ${release.version} breaking change: ${change}`);
    }
  }
  for (const operator of args.operatorChanges) {
    const changes =
      operator.changes?.join("; ") || operator.notes || "compatibility behavior changed";
    checklist.push(`Validate ${operator.name}: ${changes}`);
  }
  for (const operator of args.operatorAdditions) {
    checklist.push(
      `Adopt ${operator.name} only behind a target-version guard if the project must stay portable.`,
    );
  }
  for (const addition of args.pythonApiAdditions) {
    checklist.push(
      `Gate Python API ${addition.ref} for projects that still open in older TouchDesigner builds.`,
    );
  }
  if (checklist.length === 0) {
    checklist.push(
      "No focused compatibility records matched; run a live smoke after opening the project in the target build.",
    );
  }
  return checklist;
}

function versionError(ctx: ToolContext, missing: string[]): CallToolResult {
  const availableVersions = ctx.knowledge.listTdVersions().map((version) => ({
    id: version.id,
    label: version.label,
  }));
  return errorResult("Unknown TouchDesigner version for plan_td_version_migration.", {
    missing,
    availableVersions,
  });
}

export function planTdVersionMigrationImpl(
  ctx: ToolContext,
  rawArgs: PlanTdVersionMigrationInput,
): CallToolResult {
  const parsed = planTdVersionMigrationSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return errorResult("Invalid plan_td_version_migration input.", { issues: parsed.error.issues });
  }

  const args: PlanTdVersionMigrationArgs = parsed.data;
  try {
    const fromVersion = ctx.knowledge.getTdVersion(args.from_version);
    const toVersion = args.to_version
      ? ctx.knowledge.getTdVersion(args.to_version)
      : ctx.knowledge.getCurrentStableTdVersion();
    const missing = [
      fromVersion ? undefined : args.from_version,
      toVersion ? undefined : (args.to_version ?? "current stable"),
    ].filter((entry): entry is string => Boolean(entry));
    if (!fromVersion || !toVersion) return versionError(ctx, missing);

    const versions = ctx.knowledge.listTdVersions();
    const pathReport = versionPath(versions, fromVersion, toVersion);
    const versionIds = new Set(pathReport.path.map((version) => version.id));
    const terms = queryTerms(args.query);
    const releaseHighlights = pathReport.path
      .map((version) =>
        releaseHighlightReport(version, ctx.knowledge.getTdReleaseHighlight(version.id)),
      )
      .filter((entry): entry is ReleaseHighlightReport => Boolean(entry));

    const operatorAdditions = ctx.knowledge
      .listOperatorCompatibility()
      .filter((record) => record.addedIn && versionIds.has(record.addedIn))
      .filter((record) =>
        matchesQuery(terms, record.name, record.category, record.notes, record.addedIn),
      )
      .slice(0, args.limit)
      .map(operatorAdditionReport);

    const operatorChanges = ctx.knowledge
      .listOperatorCompatibility()
      .filter((record) => changeText(record.changedIn, versionIds).length > 0)
      .filter((record) =>
        matchesQuery(
          terms,
          record.name,
          record.category,
          record.notes,
          changeText(record.changedIn, versionIds).join(" "),
        ),
      )
      .slice(0, args.limit)
      .map((record) => operatorChangeReport(record, versionIds));

    const pythonApiAdditions = pathReport.path
      .flatMap((version) => ctx.knowledge.getTdVersionPythonApiAdditions(version.id))
      .filter((entry) =>
        matchesQuery(
          terms,
          entry.class,
          entry.name,
          entry.signature,
          entry.description,
          entry.addedIn,
        ),
      )
      .slice(0, args.limit)
      .map(pythonAdditionReport);

    const warnings =
      pathReport.direction === "downgrade"
        ? [
            "Compatibility records are optimized for upgrade planning; downgrade plans are conservative.",
          ]
        : [];
    const checklist = migrationChecklist({
      direction: pathReport.direction,
      releaseHighlights,
      operatorAdditions,
      operatorChanges,
      pythonApiAdditions,
    });

    return structuredResult(
      `Migration plan ${fromVersion.id} -> ${toVersion.id}: ${pathReport.path.length} version boundary/boundaries, ${operatorChanges.length} operator change(s), ${pythonApiAdditions.length} Python API addition(s).`,
      {
        fromVersion: versionSummary(fromVersion),
        toVersion: versionSummary(toVersion),
        query: args.query,
        direction: pathReport.direction,
        versionPath: pathReport.path.map((version) => version.id),
        releaseHighlights,
        operatorAdditions,
        operatorChanges,
        pythonApiAdditions,
        checklist,
        warnings,
      },
    );
  } catch (err) {
    return errorResult("Failed to plan TouchDesigner version migration.", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const registerPlanTdVersionMigration: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "plan_td_version_migration",
    {
      title: "Plan TD version migration",
      description:
        "Read-only: plan a TouchDesigner stable-version migration from offline release highlights plus operator and Python API compatibility records. Returns upgrade boundaries, focused compatibility deltas, and an operator checklist without touching TouchDesigner.",
      inputSchema: planTdVersionMigrationSchema.shape,
      outputSchema: planTdVersionMigrationOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => planTdVersionMigrationImpl(ctx, args),
  );
};
