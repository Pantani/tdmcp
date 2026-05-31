import { z } from "zod";

/**
 * Shared setlist/scene schema for the show-automation stack.
 *
 * Backward-compatible superset of the legacy `tracks[]` vault shape, plus the
 * richer `scenes[]` form the new automation tools (`setlist_runner`,
 * `create_scene_timeline`, `compose_cue_list`, `scene_scheduler`) consume.
 *
 * Pure module — no TD, no filesystem, no network.
 */

// ---------- input (on-disk / wire) schemas ----------

const TrackObjectSchema = z
  .object({
    title: z.string().optional().describe("Human label for the track/scene."),
    recipe: z.string().optional().describe("Recipe id to BUILD (import_setlist wires it)."),
    preset: z.string().optional().describe("Preset name to recall live (not buildable)."),
    bpm: z.number().positive().optional().describe("Per-track tempo hint, in BPM."),
    notes: z.string().optional().describe("Free-text performer notes."),
  })
  .passthrough();

export const TrackSchema = z.union([
  z.string().describe("A recipe id (shorthand for { recipe: <id> })."),
  TrackObjectSchema,
]);

export const SceneStepSchema = z.object({
  cue: z
    .string()
    .min(1)
    .describe("Cue name to fire (same meaning as createCueSequencer stepSchema.cue)."),
  hold_beats: z.number().positive().optional().describe("Beats this step holds before the next."),
  hold_seconds: z.number().positive().optional().describe("…or wall-clock seconds the step holds."),
  morph_seconds: z
    .number()
    .nonnegative()
    .default(0)
    .describe("Crossfade into this step (0 = snap)."),
});

export const SceneSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .optional()
      .describe("Stable scene id/slug. If omitted, normalize derives one."),
    title: z.string().optional().describe("Human label for the scene."),
    cue: z
      .string()
      .min(1)
      .optional()
      .describe("A single cue name (manage_cue) to recall when this scene fires."),
    steps: z
      .array(SceneStepSchema)
      .optional()
      .describe("Ordered micro-sequence of cues to run within this scene."),
    recipe: z
      .string()
      .optional()
      .describe("Recipe id to BUILD for this scene (so scenes[] is still buildable)."),
    preset: z.string().optional().describe("Preset to recall live (not buildable)."),
    hold_seconds: z
      .number()
      .nonnegative()
      .optional()
      .describe("Wall-clock dwell before auto-advance. Omit for manual/held."),
    hold_beats: z
      .number()
      .nonnegative()
      .optional()
      .describe("Musical dwell (beats) before auto-advance."),
    morph_seconds: z
      .number()
      .nonnegative()
      .default(0)
      .describe("Crossfade INTO this scene (0 = snap)."),
    bars: z
      .number()
      .positive()
      .optional()
      .describe("Bar-length of the scene (create_scene_timeline)."),
    bpm: z.number().positive().optional().describe("Per-scene tempo override hint."),
    notes: z.string().optional().describe("Free-text performer notes."),
  })
  .passthrough()
  .superRefine((scene, ctx) => {
    if (scene.steps !== undefined && scene.steps.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scene.steps must be non-empty when present",
        path: ["steps"],
      });
    }
  });

const KNOWN_TOP_KEYS = new Set(["version", "title", "bpm", "tempo", "tracks", "scenes"]);

const KNOWN_TRACK_KEYS = new Set(["title", "recipe", "preset", "bpm", "notes"]);

const KNOWN_SCENE_KEYS = new Set([
  "id",
  "title",
  "cue",
  "steps",
  "recipe",
  "preset",
  "hold_seconds",
  "hold_beats",
  "morph_seconds",
  "bars",
  "bpm",
  "notes",
]);

// Heuristic: a bare-array element "looks like a track" if it's a string, or an
// object lacking scene-only keys (cue/steps/hold_*/morph_seconds/bars/id).
const SCENE_DISCRIMINATOR_KEYS = [
  "cue",
  "steps",
  "hold_seconds",
  "hold_beats",
  "morph_seconds",
  "bars",
  "id",
];

function looksLikeTrack(el: unknown): boolean {
  if (typeof el === "string") return true;
  if (el && typeof el === "object" && !Array.isArray(el)) {
    const keys = Object.keys(el as Record<string, unknown>);
    return !keys.some((k) => SCENE_DISCRIMINATOR_KEYS.includes(k));
  }
  return false;
}

export const SetlistSchema = z.preprocess(
  (raw) => {
    if (Array.isArray(raw)) {
      if (raw.length === 0) return { tracks: [] };
      const allTrackish = raw.every(looksLikeTrack);
      return allTrackish ? { tracks: raw } : { scenes: raw };
    }
    return raw;
  },
  z
    .object({
      version: z.literal(1).default(1).describe("Schema version. Bump only on a breaking change."),
      title: z.string().optional().describe("Human-readable setlist / show name."),
      bpm: z
        .number()
        .positive()
        .optional()
        .describe("Show-level default tempo in BPM. bpm wins if both set."),
      tempo: z
        .number()
        .positive()
        .optional()
        .describe("Alias for bpm (vault writer emits `tempo`)."),
      tracks: z
        .array(TrackSchema)
        .optional()
        .describe("LEGACY scene list (flat build/recall list)."),
      scenes: z
        .array(SceneSchema)
        .optional()
        .describe("The show scene list (ordered). Preferred for new setlists."),
    })
    .passthrough()
    .superRefine((data, ctx) => {
      const hasTracks = Array.isArray(data.tracks) && data.tracks.length > 0;
      const hasScenes = Array.isArray(data.scenes) && data.scenes.length > 0;
      if (!hasTracks && !hasScenes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Setlist must include a non-empty `tracks` or `scenes` array.",
          path: ["tracks"],
        });
      }
    }),
);

// ---------- inferred TS types ----------

export type Setlist = z.infer<typeof SetlistSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type SceneStep = z.infer<typeof SceneStepSchema>;
export type Track = z.infer<typeof TrackSchema>;

// ---------- canonical (post-normalize) shape ----------

export interface CanonicalStep {
  cue: string;
  hold_beats?: number;
  hold_seconds?: number;
  morph_seconds: number;
}

export interface CanonicalScene {
  id: string;
  title?: string;
  source: "scene" | "track";
  cue?: string;
  steps?: CanonicalStep[];
  recipe?: string;
  preset?: string;
  hold_seconds?: number;
  hold_beats?: number;
  morph_seconds: number;
  bars?: number;
  bpm?: number;
  notes?: string;
  meta: Record<string, unknown>;
}

export interface CanonicalSetlist {
  version: 1;
  title?: string;
  bpm?: number;
  tempo?: number;
  meta: Record<string, unknown>;
  scenes: CanonicalScene[];
}

// ---------- helpers ----------

// Copy of exportSetlistToVault's safeName regex (kept local to avoid a vault dep).
function slug(input: string): string {
  const lowered = input.toLowerCase().trim();
  const replaced = lowered.replace(/[^a-z0-9._-]+/g, "_");
  const trimmed = replaced.replace(/^_+|_+$/g, "");
  return trimmed.length > 0 ? trimmed : "scene";
}

function pickMeta(src: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (!known.has(k)) meta[k] = v;
  }
  return meta;
}

function trackToScene(track: Track, index: number): CanonicalScene {
  if (typeof track === "string") {
    return {
      id: "",
      source: "track",
      recipe: track,
      morph_seconds: 0,
      meta: {},
    };
  }

  const obj = track as Record<string, unknown>;
  const meta = pickMeta(
    obj,
    new Set([
      ...KNOWN_TRACK_KEYS,
      // promoted scene-ish keys flow into canonical fields, not meta
      ...SCENE_DISCRIMINATOR_KEYS,
    ]),
  );

  let promotedSteps: CanonicalStep[] | undefined;
  if (Array.isArray(obj.steps)) {
    const arrResult = z.array(SceneStepSchema).safeParse(obj.steps);
    if (arrResult.success) {
      promotedSteps = arrResult.data.map(stepToCanonical);
    }
  }

  const scene: CanonicalScene = {
    id: typeof obj.id === "string" ? obj.id : "",
    title: typeof obj.title === "string" ? obj.title : undefined,
    source: "track",
    cue: typeof obj.cue === "string" ? obj.cue : undefined,
    steps: promotedSteps,
    recipe: typeof obj.recipe === "string" ? obj.recipe : undefined,
    preset: typeof obj.preset === "string" ? obj.preset : undefined,
    hold_seconds: typeof obj.hold_seconds === "number" ? obj.hold_seconds : undefined,
    hold_beats: typeof obj.hold_beats === "number" ? obj.hold_beats : undefined,
    morph_seconds: typeof obj.morph_seconds === "number" ? obj.morph_seconds : 0,
    bars: typeof obj.bars === "number" ? obj.bars : undefined,
    bpm: typeof obj.bpm === "number" ? obj.bpm : undefined,
    notes: typeof obj.notes === "string" ? obj.notes : undefined,
    meta,
  };
  void index;
  return scene;
}

function stepToCanonical(step: SceneStep): CanonicalStep {
  return {
    cue: step.cue,
    hold_beats: step.hold_beats,
    hold_seconds: step.hold_seconds,
    morph_seconds: step.morph_seconds ?? 0,
  };
}

function sceneToCanonical(scene: Scene): CanonicalScene {
  const obj = scene as unknown as Record<string, unknown>;
  const meta = pickMeta(obj, KNOWN_SCENE_KEYS);
  return {
    id: scene.id ?? "",
    title: scene.title,
    source: "scene",
    cue: scene.cue,
    steps: scene.steps?.map(stepToCanonical),
    recipe: scene.recipe,
    preset: scene.preset,
    hold_seconds: scene.hold_seconds,
    hold_beats: scene.hold_beats,
    morph_seconds: scene.morph_seconds ?? 0,
    bars: scene.bars,
    bpm: scene.bpm,
    notes: scene.notes,
    meta,
  };
}

function ensureIds(scenes: CanonicalScene[]): void {
  const seen = new Map<string, number>();
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (!s) continue;
    let base = s.id && s.id.length > 0 ? s.id : "";
    if (!base) {
      const source = s.title ?? s.cue ?? s.recipe ?? s.preset ?? `scene_${i}`;
      base = slug(source);
    }
    let candidate = base;
    const count = seen.get(base) ?? 0;
    if (count > 0) candidate = `${base}-${count + 1}`;
    // also guard against collisions with a different base producing the same slug
    while ([...seen.keys()].includes(candidate) && candidate !== base) {
      const c2 = (seen.get(candidate) ?? 0) + 1;
      candidate = `${base}-${c2 + 1}`;
      seen.set(candidate, c2);
    }
    seen.set(base, count + 1);
    if (candidate !== base) seen.set(candidate, 1);
    s.id = candidate;
  }
}

/**
 * Safe parse — returns Zod's SafeParseReturnType. Callers that want a friendly
 * error message (e.g. import_setlist) use this and format `result.error`.
 */
export type ParseSetlistResult = ReturnType<typeof SetlistSchema.safeParse>;

export function parseSetlist(input: unknown): ParseSetlistResult {
  return SetlistSchema.safeParse(input);
}

/**
 * Parse + project onto the canonical in-memory shape. Throws ZodError if the
 * input does not satisfy SetlistSchema.
 */
export function normalize(input: unknown): CanonicalSetlist {
  const parsed = SetlistSchema.parse(input) as Setlist & {
    [k: string]: unknown;
  };

  const bpm = parsed.bpm ?? parsed.tempo;
  const tempo = bpm; // keep populated for vault writer round-trip

  const topMeta = pickMeta(parsed as unknown as Record<string, unknown>, KNOWN_TOP_KEYS);

  const scenes: CanonicalScene[] = [];
  const tracks = parsed.tracks ?? [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (t === undefined) continue;
    scenes.push(trackToScene(t, i));
  }
  const sceneInputs = parsed.scenes ?? [];
  for (const s of sceneInputs) {
    scenes.push(sceneToCanonical(s));
  }

  ensureIds(scenes);

  return {
    version: 1,
    title: parsed.title,
    bpm,
    tempo,
    meta: topMeta,
    scenes,
  };
}
