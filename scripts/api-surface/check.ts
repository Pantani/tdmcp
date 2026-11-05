// `npm run api:check`: fail when the working tree breaks the pinned tool API
// surface recorded in api-surface/baseline.json (docs/reference/API_STABILITY.md).
//
// Exit codes: 0 compatible, 1 unacknowledged break or stale state, 2 could not run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  type Acknowledgement,
  type ApiBreak,
  type ApiSurface,
  compareSurfaces,
  resolveAcknowledgements,
} from "./diff.js";
import { extractApiSurface } from "./extract.js";

const MIN_REASON_LENGTH = 10;

const AckFileSchema = z.strictObject({
  acknowledged: z.array(
    z.strictObject({
      id: z.string().min(1),
      reason: z.string().trim().min(MIN_REASON_LENGTH),
    }),
  ),
  history: z.array(
    z.strictObject({
      id: z.string(),
      reason: z.string(),
      acceptedInBaseline: z.string(),
    }),
  ),
});
type AckFile = z.infer<typeof AckFileSchema>;

type Baseline = ApiSurface & { formatVersion: 1; version: string };

interface Options {
  root: string;
  baselinePath: string;
  acksPath: string;
  update: boolean;
}

function readOptions(): Options {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      baseline: { type: "string" },
      acks: { type: "string" },
      "update-baseline": { type: "boolean", default: false },
    },
  });
  const root = resolve(values.root ?? process.cwd());
  return {
    root,
    baselinePath: resolve(values.baseline ?? join(root, "api-surface/baseline.json")),
    acksPath: resolve(values.acks ?? join(root, "api-surface/acknowledged-breaks.json")),
    update: values["update-baseline"] ?? false,
  };
}

function readAcks(path: string): AckFile {
  if (!existsSync(path)) return { acknowledged: [], history: [] };
  const parsed = AckFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (parsed.success) return parsed.data;
  throw new Error(
    `${path} is invalid. Every acknowledgement needs an "id" and a "reason" of at least ${MIN_REASON_LENGTH} characters.\n${z.prettifyError(parsed.error)}`,
  );
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function describeBreak(item: ApiBreak): string {
  const brief = (value: unknown) => JSON.stringify(value)?.slice(0, 200);
  const changed = item.was !== undefined || item.now !== undefined;
  const change = changed ? ` (was ${brief(item.was)}, now ${brief(item.now)})` : "";
  return `  ${item.name}${item.path} ${item.kind}${change}\n    id: ${item.id}`;
}

function printStale(stale: Acknowledgement[]): void {
  console.error(`\nStale acknowledgements (${stale.length}): these match no current break.`);
  console.error("Remove them, or re-acknowledge the change that is actually in the tree:");
  for (const ack of stale) console.error(`  ${ack.id}`);
}

function printUnacknowledged(breaks: ApiBreak[], options: Options): void {
  const tools = new Set(breaks.map((item) => item.name));
  console.error(
    `\nBreaking changes to the pinned tool API (${breaks.length} in ${tools.size} tool(s)/ToolContext):`,
  );
  for (const item of breaks) console.error(describeBreak(item));
  console.error(
    [
      "",
      "These reject input the baseline accepted, or change ToolContext, which",
      "docs/reference/API_STABILITY.md does not allow within a release cycle.",
      "Either make the change backward compatible, or, if the break is intended, add each",
      `id with a reason to "acknowledged" in ${options.acksPath} so it is reviewed in the PR.`,
    ].join("\n"),
  );
}

function updateBaseline(
  options: Options,
  surface: ApiSurface,
  version: string,
  acks: AckFile,
): void {
  const baseline: Baseline = { formatVersion: 1, version, ...surface };
  writeJson(options.baselinePath, baseline);
  const accepted = acks.acknowledged.map((ack) => ({ ...ack, acceptedInBaseline: version }));
  writeJson(options.acksPath, { acknowledged: [], history: [...acks.history, ...accepted] });
  console.log(
    `api-surface: baseline written for ${version} (${Object.keys(surface.tools).length} tools).`,
  );
  if (accepted.length > 0) {
    console.log(
      `Moved ${accepted.length} acknowledged break(s) to history: record them in CHANGELOG.md.`,
    );
  }
}

async function main(): Promise<number> {
  const options = readOptions();
  const version = (
    JSON.parse(readFileSync(join(options.root, "package.json"), "utf8")) as { version: string }
  ).version;
  const acks = readAcks(options.acksPath);
  const surface = await extractApiSurface(options.root);

  if (!existsSync(options.baselinePath)) {
    if (options.update) {
      updateBaseline(options, surface, version, acks);
      return 0;
    }
    console.error(`No baseline at ${options.baselinePath}. Run: npm run api:update`);
    return 2;
  }
  const baseline = JSON.parse(readFileSync(options.baselinePath, "utf8")) as Baseline;
  const { breaks, notices } = compareSurfaces(baseline, surface, {
    baselineVersion: baseline.version,
    packageVersion: version,
  });
  const { unacknowledged, acknowledged, stale } = resolveAcknowledgements(
    breaks,
    acks.acknowledged,
  );

  for (const notice of notices) console.log(`note: ${notice}`);
  for (const item of acknowledged) {
    console.log(`acknowledged break: ${item.id}\n  reason: ${item.reason}`);
  }
  if (unacknowledged.length > 0) printUnacknowledged(unacknowledged, options);
  if (stale.length > 0) printStale(stale);
  if (unacknowledged.length > 0 || stale.length > 0) return 1;

  if (options.update) {
    updateBaseline(options, surface, version, acks);
    return 0;
  }
  if (baseline.version !== version) {
    console.error(
      `\nThe baseline pins ${baseline.version} but package.json is ${version}. A release must pin what it ships. Run: npm run api:update`,
    );
    return 1;
  }
  const excepted =
    acknowledged.length > 0 ? `, apart from ${acknowledged.length} acknowledged` : "";
  console.log(
    `api-surface: ${Object.keys(surface.tools).length} tools and ToolContext are compatible with the ${baseline.version} baseline${excepted}.`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`api-surface: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
