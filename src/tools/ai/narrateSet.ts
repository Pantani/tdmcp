import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// narrate_set — persist a live VJ-set narration log.
//
// auto_vj_director asks the agent to narrate its decisions ("holding through the
// build → cue 'drop' on the next bar"), but that narration is ephemeral chat.
// This tool APPENDS each narration line — timestamped, with the current section
// and optional cue — to a running session note so a set's decisions can be
// recalled afterwards (a post-mortem, a repeatable setlist, or just a diary).
//
// Delta vs log_performance (a one-shot dated snapshot of the network): this is
// an *append-only running log* you call repeatedly during a set. It writes to a
// plain markdown session file (default ~/.tdmcp/narration-<date>.md) so it works
// with or without a configured vault. When a vault IS configured, mode='recall'
// still reads the same file.
// ---------------------------------------------------------------------------

export const narrateSetSchema = z.object({
  mode: z
    .enum(["append", "recall"])
    .default("append")
    .describe(
      "append: add a narration line to the running set log. recall: read back the log lines.",
    ),
  line: z
    .string()
    .optional()
    .describe(
      "The narration line to record (required for mode='append'), e.g. \"holding through the build → cue 'drop' on the next bar\".",
    ),
  section: z
    .string()
    .optional()
    .describe(
      "Optional song section/phase this line belongs to, e.g. 'intro', 'drop', 'breakdown'.",
    ),
  cue: z
    .string()
    .optional()
    .describe("Optional cue name being fired/recalled, for cross-reference."),
  set_name: z
    .string()
    .optional()
    .describe(
      "Session name; picks the log file ~/.tdmcp/narration-<set_name>.md. Defaults to today's date.",
    ),
  log_path: z
    .string()
    .optional()
    .describe(
      "Explicit path to the narration log file, overriding set_name. Honors TDMCP_NARRATION_PATH otherwise.",
    ),
  tail: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe("For mode='recall': return at most the last N narration lines."),
});
type NarrateSetArgs = z.infer<typeof narrateSetSchema>;

export const narrateSetOutputSchema = z.object({
  mode: z.enum(["append", "recall"]),
  log_path: z.string().describe("Absolute path of the narration log file."),
  appended: z
    .object({
      timestamp: z.string(),
      section: z.string().optional(),
      cue: z.string().optional(),
      line: z.string(),
    })
    .optional()
    .describe("The entry that was appended (mode='append')."),
  entries: z
    .array(
      z.object({
        timestamp: z.string().optional(),
        section: z.string().optional(),
        cue: z.string().optional(),
        line: z.string(),
      }),
    )
    .optional()
    .describe("Parsed narration entries (mode='recall')."),
  count: z.number().describe("Total narration lines in the log."),
});

function stampDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function slug(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "set"
  );
}

function resolveLogPath(args: NarrateSetArgs): string {
  if (args.log_path) return resolve(args.log_path);
  const fromEnv = process.env.TDMCP_NARRATION_PATH;
  if (fromEnv) return resolve(fromEnv);
  const name = args.set_name ? slug(args.set_name) : stampDate(new Date());
  return join(homedir(), ".tdmcp", `narration-${name}.md`);
}

// Each line is a single markdown list item. Free-text fields are flattened to one
// line and stripped of the characters that delimit the record — backticks (timestamp),
// square brackets (section), and parens (cue) — so a stray delimiter can neither
// truncate the entry (newlines) nor misparse it back. `parseEntries` reads the same
// shape; because these characters are removed at write time it never has to unescape.
function sanitizeField(s: string): string {
  return s
    .replace(/[\r\n]+/g, " ")
    .replace(/[`[\]()]/g, "")
    .trim();
}

// Each line: "- `<ISO>` [section] (cue: <cue>) <line>". Parsed back leniently.
const LINE_RE = /^-\s+`([^`]+)`\s*(?:\[([^\]]*)\]\s*)?(?:\(cue:\s*([^)]*)\)\s*)?(.*)$/;

function parseEntries(content: string): Array<{
  timestamp?: string;
  section?: string;
  cue?: string;
  line: string;
}> {
  const out: Array<{ timestamp?: string; section?: string; cue?: string; line: string }> = [];
  for (const raw of content.split("\n")) {
    const m = raw.match(LINE_RE);
    if (!m) continue;
    const entry: { timestamp?: string; section?: string; cue?: string; line: string } = {
      line: (m[4] ?? "").trim(),
    };
    if (m[1]) entry.timestamp = m[1];
    if (m[2]) entry.section = m[2];
    if (m[3]) entry.cue = m[3].trim();
    out.push(entry);
  }
  return out;
}

export async function narrateSetImpl(
  _ctx: ToolContext,
  args: NarrateSetArgs,
): Promise<ReturnType<typeof structuredResult>> {
  const parsed = narrateSetSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${parsed.error.message}`) as ReturnType<
      typeof structuredResult
    >;
  }
  const data = parsed.data;
  const logPath = resolveLogPath(data);

  if (data.mode === "append") {
    if (!data.line?.trim()) {
      return errorResult("narrate_set mode='append' requires a non-empty `line`.") as ReturnType<
        typeof structuredResult
      >;
    }
    const timestamp = new Date().toISOString();
    const section = data.section ? sanitizeField(data.section) : "";
    const cue = data.cue ? sanitizeField(data.cue) : "";
    const line = sanitizeField(data.line);
    const sectionPart = section ? ` [${section}]` : "";
    const cuePart = cue ? ` (cue: ${cue})` : "";
    const entryLine = `- \`${timestamp}\`${sectionPart}${cuePart} ${line}\n`;
    // Count existing entries BEFORE appending so the post-write total is a pure
    // increment — never a second read that could throw outside this try/catch and
    // break the never-throw handler contract.
    let priorCount = 0;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      const isNew = !existsSync(logPath);
      if (!isNew) priorCount = parseEntries(readFileSync(logPath, "utf8")).length;
      const header = isNew ? `# Set narration — ${data.set_name ?? stampDate(new Date())}\n\n` : "";
      appendFileSync(logPath, header + entryLine, "utf8");
    } catch (err) {
      return errorResult(
        `Could not write narration to ${logPath}: ${err instanceof Error ? err.message : String(err)}`,
      ) as ReturnType<typeof structuredResult>;
    }
    const total = priorCount + 1;
    const appended: {
      timestamp: string;
      section?: string;
      cue?: string;
      line: string;
    } = { timestamp, line };
    if (section) appended.section = section;
    if (cue) appended.cue = cue;
    return structuredResult(`Narrated to ${logPath} (${total} line(s)).`, {
      mode: "append",
      log_path: logPath,
      appended,
      count: total,
    });
  }

  // recall
  if (!existsSync(logPath)) {
    return structuredResult(`No narration log at ${logPath} yet.`, {
      mode: "recall",
      log_path: logPath,
      entries: [],
      count: 0,
    });
  }
  let entries: Array<{ timestamp?: string; section?: string; cue?: string; line: string }>;
  try {
    entries = parseEntries(readFileSync(logPath, "utf8"));
  } catch (err) {
    return errorResult(
      `Could not read narration log ${logPath}: ${err instanceof Error ? err.message : String(err)}`,
    ) as ReturnType<typeof structuredResult>;
  }
  const tailed = entries.slice(-data.tail);
  return structuredResult(
    `Recalled ${tailed.length} of ${entries.length} narration line(s) from ${logPath}.`,
    { mode: "recall", log_path: logPath, entries: tailed, count: entries.length },
  );
}

export const registerNarrateSet: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "narrate_set",
    {
      title: "Narrate a live set (persisted decision log)",
      description:
        "Persist the running narration of a live VJ/show set so decisions can be recalled afterwards. mode='append' adds a timestamped line (with optional section + cue) to a markdown session log (default ~/.tdmcp/narration-<date>.md); mode='recall' reads the log back (last `tail` lines). Pair with the auto_vj_director prompt: instead of narrating only in chat, call narrate_set on each major move so the set leaves a diary/setlist trail. Writes a local file (not read-only). Delta vs log_performance, which writes a one-shot network snapshot rather than an append-only decision log.",
      inputSchema: narrateSetSchema.shape,
      outputSchema: narrateSetOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => narrateSetImpl(ctx, args),
  );
};
