import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const loadSessionProfileSchema = z.object({
  profile_path: z
    .string()
    .optional()
    .describe(
      "Absolute path to the session-profile JSON file. Defaults to ~/.tdmcp/session-profile.json.",
    ),
  reset: z
    .boolean()
    .default(false)
    .describe(
      "If true, overwrite the existing profile with the built-in defaults and return them.",
    ),
});

type LoadSessionProfileArgs = z.infer<typeof loadSessionProfileSchema>;

// ---------------------------------------------------------------------------
// Output schema — a structured read tool
// ---------------------------------------------------------------------------

const StyleMemorySnapshotSchema = z.object({
  default_energy: z.string().optional(),
  palettes: z.array(z.record(z.string(), z.unknown())).optional(),
  favorite_generators: z.array(z.string()).optional(),
  naming: z.string().optional(),
  layout: z.string().optional(),
  tags: z.array(z.string()).optional(),
  banned: z.array(z.string()).optional(),
});

const RecallHitSchema = z.object({
  path: z.string(),
  title: z.string(),
  score: z.number(),
  tags: z.array(z.string()),
  ops: z.array(z.string()),
  intent: z.string().optional(),
  recipe: z.string().optional(),
  snippet: z.string().optional(),
});

const ConventionsSnapshotSchema = z.object({
  naming_label: z.string().optional(),
  layout: z.string().optional(),
  color_tags: z.array(z.record(z.string(), z.unknown())).optional(),
  param_defaults: z.array(z.record(z.string(), z.unknown())).optional(),
});

const CorpusStyleSnapshotSchema = z.object({
  naming_label: z.string().optional(),
  favorite_generators: z.array(z.string()).optional(),
  palettes: z.array(z.record(z.string(), z.unknown())).optional(),
  top_hexes: z.array(z.string()).optional(),
});

export const loadSessionProfileOutputSchema = z.object({
  profile_path: z.string().describe("Absolute path of the profile file read or written."),
  created: z.boolean().describe("True when the profile was created fresh (no prior file)."),
  reset: z.boolean().describe("True when reset=true was requested."),
  loaded_at: z.string().describe("ISO-8601 timestamp of this read."),
  style_memory: StyleMemorySnapshotSchema.optional().describe(
    "Snapshot from style_memory (Memory/style.md) if previously captured.",
  ),
  recent_work: z
    .array(RecallHitSchema)
    .optional()
    .describe("Top hits from recall_similar_work if previously captured."),
  conventions: ConventionsSnapshotSchema.optional().describe(
    "Snapshot from learn_conventions (Memory/conventions.md) if previously captured.",
  ),
  corpus_style: CorpusStyleSnapshotSchema.optional().describe(
    "Snapshot from learn_from_my_corpus (Memory/corpus_style.md) if previously captured.",
  ),
  notes: z.array(z.string()).describe("Human-readable notes about what was loaded or defaulted."),
});

export type SessionProfile = z.infer<typeof loadSessionProfileOutputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_PROFILE_PATH = join(homedir(), ".tdmcp", "session-profile.json");

function resolveProfilePath(override?: string): string {
  if (override) return resolve(override);
  // Honor TDMCP_SESSION_PROFILE_PATH so the tool and the tdmcp://session/profile
  // MCP resource always read/write the same file. The resource module reads the
  // same env var; if they diverged, agents would see stale data.
  const fromEnv = process.env.TDMCP_SESSION_PROFILE_PATH;
  if (fromEnv) return resolve(fromEnv);
  return DEFAULT_PROFILE_PATH;
}

function defaultProfile(profilePath: string): SessionProfile {
  return {
    profile_path: profilePath,
    created: true,
    reset: false,
    loaded_at: new Date().toISOString(),
    notes: [
      "No session profile found — created defaults.",
      "Populate by running: style_memory (mode='show'), recall_similar_work, learn_conventions, learn_from_my_corpus.",
      "Then call load_session_profile again; it will read and cache the results.",
    ],
  };
}

function readProfile(profilePath: string): SessionProfile | undefined {
  try {
    const raw = readFileSync(profilePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const result = loadSessionProfileOutputSchema.safeParse(parsed);
    if (result.success) return result.data;
    // Partial / legacy file — normalize to satisfy outputSchema validation
    // downstream (structuredContent must conform). Missing required fields
    // get safe defaults so the tool degrades instead of throwing.
    const raw_ = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
    return {
      profile_path: typeof raw_.profile_path === "string" ? raw_.profile_path : profilePath,
      created: typeof raw_.created === "boolean" ? raw_.created : false,
      reset: typeof raw_.reset === "boolean" ? raw_.reset : false,
      loaded_at: typeof raw_.loaded_at === "string" ? raw_.loaded_at : new Date().toISOString(),
      notes: Array.isArray(raw_.notes) ? (raw_.notes as string[]) : [],
      ...(raw_.style_memory && typeof raw_.style_memory === "object"
        ? { style_memory: raw_.style_memory as SessionProfile["style_memory"] }
        : {}),
      ...(Array.isArray(raw_.recent_work)
        ? { recent_work: raw_.recent_work as SessionProfile["recent_work"] }
        : {}),
      ...(raw_.conventions && typeof raw_.conventions === "object"
        ? { conventions: raw_.conventions as SessionProfile["conventions"] }
        : {}),
      ...(raw_.corpus_style && typeof raw_.corpus_style === "object"
        ? { corpus_style: raw_.corpus_style as SessionProfile["corpus_style"] }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function writeProfile(profilePath: string, profile: SessionProfile): void {
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function loadSessionProfileImpl(
  _ctx: ToolContext,
  args: LoadSessionProfileArgs,
): Promise<ReturnType<typeof structuredResult>> {
  const profilePath = resolveProfilePath(args.profile_path);

  if (args.reset) {
    const profile = defaultProfile(profilePath);
    profile.reset = true;
    profile.created = false;
    try {
      writeProfile(profilePath, profile);
    } catch (err) {
      return errorResult(
        `Could not write reset profile to ${profilePath}: ${err instanceof Error ? err.message : String(err)}`,
      ) as ReturnType<typeof structuredResult>;
    }
    return structuredResult(
      `Session profile reset to defaults at ${profilePath}.`,
      profile as object,
    );
  }

  const fileExists = existsSync(profilePath);

  if (!fileExists) {
    const profile = defaultProfile(profilePath);
    try {
      writeProfile(profilePath, profile);
    } catch (err) {
      // Non-fatal: return defaults even if we can't persist
      const withNote: SessionProfile = {
        ...profile,
        notes: [
          ...profile.notes,
          `Warning: could not persist profile (${err instanceof Error ? err.message : String(err)}).`,
        ],
      };
      return structuredResult(
        `No session profile found at ${profilePath}; using defaults (could not persist).`,
        withNote as object,
      );
    }
    return structuredResult(
      `Created default session profile at ${profilePath}. Run style_memory, recall_similar_work, learn_conventions, learn_from_my_corpus to populate it.`,
      profile as object,
    );
  }

  const stored = readProfile(profilePath);
  if (!stored) {
    return errorResult(
      `Session profile at ${profilePath} exists but could not be parsed — it may be corrupt. Pass reset=true to overwrite with defaults.`,
    ) as ReturnType<typeof structuredResult>;
  }

  // Refresh the loaded_at timestamp on each load so callers know when the
  // profile was last accessed, but keep all the stored content intact.
  const refreshed: SessionProfile = {
    ...stored,
    profile_path: profilePath,
    loaded_at: new Date().toISOString(),
    created: false,
    reset: false,
  };

  const sectionCount = [
    refreshed.style_memory,
    refreshed.recent_work,
    refreshed.conventions,
    refreshed.corpus_style,
  ].filter(Boolean).length;

  const summary =
    sectionCount === 0
      ? `Session profile loaded from ${profilePath} — no sections populated yet. Run the memory tools to fill it.`
      : `Session profile loaded from ${profilePath} — ${sectionCount} section(s) populated.`;

  return structuredResult(summary, refreshed as object);
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerLoadSessionProfile: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "load_session_profile",
    {
      title: "Load or initialise the persistent session profile",
      description:
        "Reads ~/.tdmcp/session-profile.json (or a custom path) and returns a unified JSON " +
        "snapshot that an agent should load at the start of every session. The profile caches " +
        "the most recent outputs of style_memory, recall_similar_work, learn_conventions, and " +
        "learn_from_my_corpus so the agent has the artist's preferences and past work at hand " +
        "without running all four tools every time. If no file exists, a default skeleton is " +
        "created and returned. Pass reset=true to overwrite with fresh defaults. The profile_path " +
        "field in the returned object is always the resolved path that was read or written.",
      inputSchema: loadSessionProfileSchema.shape,
      outputSchema: loadSessionProfileOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => loadSessionProfileImpl(ctx, args),
  );
};
