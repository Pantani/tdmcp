/**
 * scene_scheduler — offline cron-lite that fires actions at wall-clock times.
 *
 * Pure driver with DI clock and action runner; no TD bridge calls here.
 * The agent.ts dispatch block wires real clock + action runners.
 *
 * Three trigger flavours:
 *   at HH:MM[:SS]       — once per day at local wall-clock time
 *   every Ns/m/h        — repeating interval from scheduler start
 *   cron YYYY/MM/DD HH:MM[:SS]  — one-shot absolute local datetime
 *
 * Three action types: command (shell), cue (manageCueImpl), setlist (runSetlist).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import matter from "gray-matter";
import { z } from "zod";
import type { CanonicalSetlist } from "../automation/setlistSchema.js";

// ---------- CLI args schema ----------

export const schedulerCliSchema = z.object({
  file: z.string().min(1).describe("Path to schedule file (.json/.yaml/.md)."),
  dry_run: z.boolean().default(false).describe("Log planned fires, do not run actions."),
  once: z.boolean().default(false).describe("Exit after the first action of every entry fires."),
  loop: z.boolean().default(false).describe("Re-schedule `at` entries for tomorrow after firing."),
  comp_path: z.string().default("/project1").describe("Forwarded to cue + setlist actions."),
  tz_info: z
    .boolean()
    .default(false)
    .describe("Print resolved timezone + next 5 fire times then exit."),
  json: z.boolean().default(false).describe("Emit one JSON event per line on stdout."),
});

export type SchedulerCliArgs = z.infer<typeof schedulerCliSchema>;

// ---------- schedule file schema ----------

const TriggerAtSchema = z.object({
  kind: z.literal("at"),
  time: z
    .string()
    .regex(
      /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/,
      "time must be HH:MM or HH:MM:SS (hour 0-23, minute/second 0-59)",
    ),
});
const TriggerEverySchema = z.object({
  kind: z.literal("every"),
  seconds: z.number().int().positive(),
});
const TriggerCronSchema = z.object({
  kind: z.literal("cron"),
  at: z
    .string()
    .regex(
      /^\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}(:\d{2})?$/,
      "cron must be YYYY/MM/DD HH:MM or YYYY/MM/DD HH:MM:SS",
    ),
});

const CommandActionSchema = z.object({
  type: z.literal("command"),
  cmd: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeout_ms: z.number().int().positive().default(30_000),
});
const CueActionSchema = z.object({
  type: z.literal("cue"),
  cue_action: z.enum(["store", "recall", "morph", "delete"]).default("recall"),
  name: z.string().min(1),
  duration: z.number().nonnegative().optional(),
  quantize: z.enum(["off", "beat", "bar"]).default("off"),
});
const SetlistActionSchema = z.object({
  type: z.literal("setlist"),
  file: z.string().min(1),
  mode: z.enum(["duration", "beat", "manual"]).default("duration"),
  loop: z.boolean().default(false),
});

const ScheduleEntrySchema = z.object({
  id: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  trigger: z.discriminatedUnion("kind", [TriggerAtSchema, TriggerEverySchema, TriggerCronSchema]),
  action: z.discriminatedUnion("type", [CommandActionSchema, CueActionSchema, SetlistActionSchema]),
});

export const scheduleFileSchema = z.object({
  timezone: z.string().optional(),
  entries: z.array(ScheduleEntrySchema).min(1),
});

export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;
export type NormalizedEntry = ScheduleEntry & { id: string };

export type CanonicalSchedule = {
  timezone?: string;
  entries: NormalizedEntry[];
};

// Re-export for external referencing
export type { CanonicalSetlist };

// ---------- input parsing ----------

/** Tokenize a shell command string without invoking a shell. */
export function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? "";
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === " " && !inDouble && !inSingle) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** Normalize shorthand trigger/action forms into strict discriminated-union shapes. */
function normalizeEntry(raw: Record<string, unknown>, idx: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };

  // trigger shorthands
  if (typeof raw.at === "string" && !raw.trigger) {
    out.trigger = { kind: "at", time: raw.at };
    delete out.at;
  }
  if (typeof raw.every === "string" && !raw.trigger) {
    const s = parseEveryString(raw.every);
    out.trigger = { kind: "every", seconds: s };
    delete out.every;
  }
  if (typeof raw.cron === "string" && !raw.trigger) {
    out.trigger = { kind: "cron", at: raw.cron };
    delete out.cron;
  }

  // action shorthands
  if (typeof raw.command === "string" && !raw.action) {
    const parts = shellSplit(raw.command as string);
    const cmd = parts[0] ?? "";
    out.action = { type: "command", cmd, args: parts.slice(1) };
    delete out.command;
  }

  // auto-assign id
  if (!out.id) {
    out.id = `entry_${idx}`;
  }

  return out;
}

function parseEveryString(s: string): number {
  const m = /^(\d+(\.\d+)?)\s*([smh])$/.exec(s.trim());
  if (!m) throw new Error(`Cannot parse interval "${s}" — use Ns, Nm, or Nh`);
  const n = parseFloat(m[1] ?? "0");
  const unit = m[3] ?? "s";
  if (unit === "s") return Math.round(n);
  if (unit === "m") return Math.round(n * 60);
  return Math.round(n * 3600);
}

export function parseScheduleInput(
  raw: string,
  sourcePath?: string,
): { ok: true; input: unknown } | { ok: false; message: string } {
  try {
    // Try JSON first
    if (raw.trimStart().startsWith("{") || raw.trimStart().startsWith("[")) {
      return { ok: true, input: JSON.parse(raw) };
    }
    // Markdown front-matter
    const parsed = matter(raw);
    if (parsed.data && Object.keys(parsed.data).length > 0) {
      return { ok: true, input: parsed.data };
    }
    // Plain YAML (no front-matter) — parse the raw body via gray-matter's
    // bundled YAML engine. Returning `parsed.data` here would always be `{}`,
    // which would later fail with an empty `entries` list.
    const yamlEngine = (
      matter as unknown as { engines: { yaml: { parse: (s: string) => unknown } } }
    ).engines.yaml;
    const yamlInput = yamlEngine.parse(raw);
    return { ok: true, input: yamlInput ?? {} };
  } catch (e: unknown) {
    return {
      ok: false,
      message: `Failed to parse schedule file${sourcePath ? ` (${sourcePath})` : ""}: ${String(e)}`,
    };
  }
}

export function loadCanonicalSchedule(
  input: unknown,
): { ok: true; schedule: CanonicalSchedule } | { ok: false; message: string } {
  try {
    const raw = input as Record<string, unknown>;
    // normalize entries
    const rawEntries = Array.isArray(raw.entries) ? raw.entries : [];
    const normalizedEntries = rawEntries.map((e: unknown, idx: number) =>
      normalizeEntry(e as Record<string, unknown>, idx),
    );
    const normalized = { ...raw, entries: normalizedEntries };

    const result = scheduleFileSchema.safeParse(normalized);
    if (!result.success) {
      const first = result.error.issues[0];
      return {
        ok: false,
        message: `Schedule file invalid: ${first?.message ?? String(result.error)} at ${first?.path?.join(".") ?? "root"}`,
      };
    }
    const schedule: CanonicalSchedule = {
      timezone: result.data.timezone,
      entries: result.data.entries.map((e, i) => ({
        ...e,
        id: e.id ?? `entry_${i}`,
      })) as NormalizedEntry[],
    };
    return { ok: true, schedule };
  } catch (e: unknown) {
    return { ok: false, message: `Failed to load schedule: ${String(e)}` };
  }
}

// ---------- time math ----------

/** Compute next fire Date for an entry from `now`. Returns null if one-shot past. */
export function nextFireAt(
  entry: NormalizedEntry,
  now: Date,
  events?: ((e: SchedulerEvent) => void) | null,
): Date | null {
  const trig = entry.trigger;

  if (trig.kind === "at") {
    const parts = trig.time.split(":").map(Number);
    const h = parts[0] ?? 0;
    const m = parts[1] ?? 0;
    const s = parts[2] ?? 0;
    return computeNextAt(entry.id, h, m, s, now, events);
  }

  if (trig.kind === "every") {
    // First fire is from now + interval; subsequent fires re-anchor to scheduled time
    const next = new Date(now.getTime() + trig.seconds * 1000);
    return next;
  }

  if (trig.kind === "cron") {
    const cronDate = parseCronAt(trig.at);
    if (cronDate.getTime() <= now.getTime()) {
      events?.({ t: "skipped_past", id: entry.id });
      return null;
    }
    return cronDate;
  }

  return null;
}

function computeNextAt(
  id: string,
  h: number,
  m: number,
  s: number,
  now: Date,
  events?: ((e: SchedulerEvent) => void) | null,
): Date {
  const cand = new Date(now);
  cand.setHours(h, m, s, 0);

  // Detect DST spring-forward: JS silently advances the hour
  const actualH = cand.getHours();
  const actualM = cand.getMinutes();
  if (actualH !== h || actualM !== m) {
    events?.({
      t: "dst_skip",
      id,
      requested: `${pad2(h)}:${pad2(m)}:${pad2(s)}`,
      actual: `${pad2(actualH)}:${pad2(actualM)}:${pad2(cand.getSeconds())}`,
    });
  }

  // Detect DST fall-back: setHours picks the first occurrence — log ambiguity
  // We detect this heuristically: if the offset would place us before the fold
  // (when clocks repeat), the resulting time has the same wall clock but UTC offset differs.
  // Simplified: just check if we land in the repeated hour by looking at getTimezoneOffset
  // before/after. We accept first occurrence and log.
  const beforeOffset = now.getTimezoneOffset();
  const afterOffset = cand.getTimezoneOffset();
  if (afterOffset !== beforeOffset && cand.getHours() === h) {
    events?.({ t: "dst_ambiguous", id, chose: "first" as const });
  }

  if (cand.getTime() <= now.getTime()) {
    cand.setDate(cand.getDate() + 1);
  }
  return cand;
}

function parseCronAt(s: string): Date {
  // YYYY/MM/DD HH:MM[:SS]
  const [datePart, timePart] = s.split(" ");
  const [y, mo, d] = (datePart ?? "").split("/").map(Number);
  const [hh, mm, ss] = (timePart ?? "").split(":").map(Number);
  return new Date(y ?? 0, (mo ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, ss ?? 0, 0);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// ---------- clock DI ----------

export interface SchedulerClock {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  now: () => number;
}

export const realClock: SchedulerClock = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

// ---------- action runner DI ----------

export interface ActionRunner {
  command(a: z.infer<typeof CommandActionSchema>): Promise<void>;
  cue(a: z.infer<typeof CueActionSchema>): Promise<void>;
  setlist(a: z.infer<typeof SetlistActionSchema>): Promise<void>;
}

type ActionKind = "command" | "cue" | "setlist";

// ---------- events ----------

export type SchedulerEvent =
  | { t: "started"; entries: number; tz: string }
  | { t: "scheduled"; id: string; fireAt: string; in_ms: number }
  | { t: "firing"; id: string; kind: ActionKind }
  | { t: "fired"; id: string; kind: ActionKind; ms: number }
  | { t: "error"; id: string; message: string }
  | { t: "dst_skip"; id: string; requested: string; actual: string }
  | { t: "dst_ambiguous"; id: string; chose: "first" }
  | { t: "catch_up_skipped"; id: string; missed: number }
  | { t: "skipped_past"; id: string }
  | { t: "stopped"; reason: "sigint" | "complete" | "once" };

// ---------- max setTimeout cap ----------

const MAX_TIMEOUT_MS = 2_147_483_647;

// ---------- runScheduler ----------

export interface RunSchedulerOpts {
  schedule: CanonicalSchedule;
  args: SchedulerCliArgs;
  runner: ActionRunner;
  clock: SchedulerClock;
  signals?: AsyncIterable<{ kind: "stop" }>;
  emit?: (e: SchedulerEvent) => void;
}

export interface SchedulerSummary {
  fired: number;
  errors: number;
  ended_reason: "complete" | "sigint" | "once";
}

interface EntryState {
  entry: NormalizedEntry;
  nextFire: Date;
  handle: unknown;
  fired: boolean;
  lastScheduledFire?: Date;
}

export async function runScheduler(opts: RunSchedulerOpts): Promise<SchedulerSummary> {
  const { schedule, args, runner, clock, signals, emit = () => {} } = opts;

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let firedCount = 0;
  let errorCount = 0;
  let stopped = false;
  let endedReason: "complete" | "sigint" | "once" = "complete";

  const activeEntries: EntryState[] = [];
  const now = new Date(clock.now());

  // Initialize entries
  for (const entry of schedule.entries) {
    if (!entry.enabled) continue;

    const next = nextFireAt(entry, now, emit);
    if (next === null) continue; // skipped_past already emitted

    emit({
      t: "scheduled",
      id: entry.id,
      fireAt: next.toISOString(),
      in_ms: next.getTime() - now.getTime(),
    });
    activeEntries.push({ entry, nextFire: next, handle: null, fired: false });
  }

  emit({ t: "started", entries: activeEntries.length, tz });

  if (activeEntries.length === 0) {
    emit({ t: "stopped", reason: "complete" });
    return { fired: 0, errors: 0, ended_reason: "complete" };
  }

  // Promise that resolves when all entries complete (or stop is called)
  let resolveAll: (reason: "complete" | "sigint" | "once") => void;
  const allDone = new Promise<"complete" | "sigint" | "once">((res) => {
    resolveAll = res;
  });

  function stopAll(reason: "complete" | "sigint" | "once") {
    if (stopped) return;
    stopped = true;
    for (const state of activeEntries) {
      if (state.handle != null) clock.clearTimeout(state.handle);
    }
    resolveAll(reason);
  }

  // Schedule a single entry's next fire using chained timeouts for > MAX_TIMEOUT_MS
  function scheduleEntry(state: EntryState) {
    if (stopped) return;
    const delay = state.nextFire.getTime() - clock.now();
    if (delay <= MAX_TIMEOUT_MS) {
      state.handle = clock.setTimeout(() => fire(state), Math.max(0, delay));
    } else {
      // Chain: wait MAX_TIMEOUT_MS, then re-evaluate
      state.handle = clock.setTimeout(() => {
        if (!stopped) scheduleEntry(state);
      }, MAX_TIMEOUT_MS);
    }
  }

  async function fire(state: EntryState) {
    if (stopped) return;
    const { entry } = state;
    const kind = entry.action.type as ActionKind;
    const t0 = clock.now();

    if (!args.dry_run) {
      emit({ t: "firing", id: entry.id, kind });
      try {
        if (entry.action.type === "command") await runner.command(entry.action);
        else if (entry.action.type === "cue") await runner.cue(entry.action);
        else await runner.setlist(entry.action);
        emit({ t: "fired", id: entry.id, kind, ms: clock.now() - t0 });
        firedCount++;
      } catch (e: unknown) {
        errorCount++;
        emit({ t: "error", id: entry.id, message: String(e) });
      }
    } else {
      emit({ t: "firing", id: entry.id, kind });
      emit({ t: "fired", id: entry.id, kind, ms: 0 });
      firedCount++;
    }

    state.fired = true;

    // Re-schedule or retire
    if (entry.trigger.kind === "cron") {
      // one-shot — retire
      checkCompletion();
      return;
    }

    if (args.once) {
      stopAll("once");
      return;
    }

    if (entry.trigger.kind === "at") {
      if (args.loop) {
        // Re-schedule for tomorrow same wall-clock
        state.nextFire = nextFireAt(entry, new Date(clock.now()), emit) ?? state.nextFire;
        state.fired = false;
        emit({
          t: "scheduled",
          id: entry.id,
          fireAt: state.nextFire.toISOString(),
          in_ms: state.nextFire.getTime() - clock.now(),
        });
        scheduleEntry(state);
      } else {
        checkCompletion();
      }
      return;
    }

    if (entry.trigger.kind === "every") {
      const seconds = entry.trigger.seconds;
      const scheduledFire = state.lastScheduledFire ?? state.nextFire;
      const nextScheduled = new Date(scheduledFire.getTime() + seconds * 1000);
      const nowMs = clock.now();

      if (nextScheduled.getTime() < nowMs) {
        // Host was suspended — skip ahead
        const diff = nowMs - scheduledFire.getTime();
        const missed = Math.floor(diff / (seconds * 1000)) - 1;
        if (missed > 0) {
          emit({ t: "catch_up_skipped", id: entry.id, missed });
        }
        const remainder = seconds * 1000 - (diff % (seconds * 1000));
        state.nextFire = new Date(nowMs + remainder);
      } else {
        state.nextFire = nextScheduled;
      }
      state.lastScheduledFire = state.nextFire;
      state.fired = false;
      scheduleEntry(state);
    }
  }

  function checkCompletion() {
    const allRetired = activeEntries.every(
      (s) => s.fired || s.entry.trigger.kind === "cron" || (!args.loop && s.fired),
    );
    // For non-looping, non-every schedules: done when all at/cron entries fired
    const hasOngoing = activeEntries.some((s) => s.entry.trigger.kind === "every");
    if (!hasOngoing && activeEntries.every((s) => s.fired)) {
      stopAll("complete");
    }
    void allRetired; // suppress unused warning
  }

  // Start all timers
  for (const state of activeEntries) {
    state.lastScheduledFire = state.nextFire;
    scheduleEntry(state);
  }

  // Listen for signals
  if (signals) {
    (async () => {
      for await (const sig of signals) {
        if (sig.kind === "stop") {
          stopAll("sigint");
          break;
        }
      }
    })().catch(() => {});
  }

  endedReason = await allDone;
  emit({ t: "stopped", reason: endedReason });
  return { fired: firedCount, errors: errorCount, ended_reason: endedReason };
}

// ---------- tz-info helper ----------

export function tzInfo(schedule: CanonicalSchedule, now: Date): string[] {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines: string[] = [`timezone: ${tz}`];
  for (const entry of schedule.entries.filter((e) => e.enabled)) {
    const fires: Date[] = [];
    let cur = now;
    for (let i = 0; i < 5; i++) {
      const next = nextFireAt(entry, cur);
      if (next === null) break;
      fires.push(next);
      cur = new Date(next.getTime() + 1000);
      if (entry.trigger.kind === "cron" || entry.trigger.kind === "at") {
        // at: advance a day so we get 5 distinct
        if (entry.trigger.kind === "at") cur = new Date(next.getTime() + 60_000);
      }
    }
    lines.push(
      `${entry.id}: ${fires.map((f) => f.toLocaleTimeString(undefined, { timeZoneName: "short" })).join(", ")}`,
    );
  }
  return lines;
}

// ---------- load from file (convenience for agent.ts) ----------

export function loadScheduleFile(
  filePath: string,
): { ok: true; schedule: CanonicalSchedule } | { ok: false; message: string } {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseScheduleInput(raw, filePath);
    if (!parsed.ok) return parsed;
    return loadCanonicalSchedule(parsed.input);
  } catch (e: unknown) {
    return { ok: false, message: `Cannot read schedule file "${filePath}": ${String(e)}` };
  }
}

// Make spawnSync available for agent usage but keep it tree-shakeable
export { spawnSync };
