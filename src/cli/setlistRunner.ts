import { z } from "zod";
import {
  type CanonicalScene,
  type CanonicalSetlist,
  type CanonicalStep,
  normalize,
} from "../automation/setlistSchema.js";
import { TdConnectionError, TdError } from "../td-client/types.js";

/**
 * setlist_runner — walk a CanonicalSetlist scene-by-scene and fire each
 * scene's cue / steps through the existing manage_cue bridge engine.
 *
 * Implemented as a pure-ish driver with dependency injection:
 *   - `client`     — the manage_cue caller (TouchDesignerClient-shaped subset).
 *   - `clock`      — setTimeout/clearTimeout/now wrapper (swappable for tests).
 *   - `beatSource` — pub-sub for `clock.beat` events from TdEventStream.
 *   - `signals`    — async iterator of {next|prev|goto|stop} control signals.
 *   - `emit`       — receives one structured event per state change.
 *
 * This module is exported from the CLI directory because it is the driver
 * the `tdmcp setlist run` subcommand wraps. The CLI wrapper (added by the
 * integrator in `src/cli/agent.ts`) wires the real client/clock/event stream
 * and a stdin line-reader as the signal source.
 *
 * Zero new TD-side surface: only the existing manage_cue payload is invoked,
 * via `client.executePythonScript`-routed callers passed in as `cueCaller`.
 */

// ---------- input schema (mirrors the COMMANDS surface) ----------

export const setlistRunnerCliSchema = z.object({
  setlist: z
    .string()
    .min(1)
    .describe("Path to a setlist file (.md / .json / .yaml) or a JSON string."),
  mode: z
    .enum(["duration", "beat", "manual"])
    .default("duration")
    .describe("Global advance mode; per-scene holds always win when present."),
  start: z
    .union([z.string(), z.number().int().nonnegative()])
    .optional()
    .describe("Resume from a scene id (string) or zero-based index (number)."),
  loop: z.boolean().default(false).describe("Loop back to scene[0] after the last scene."),
  dry_run: z
    .boolean()
    .default(false)
    .describe("Never call manage_cue; print the plan + simulated timing."),
  comp_path: z.string().default("/project1").describe("Forwarded to every manage_cue call."),
  beats_per_bar: z
    .number()
    .int()
    .positive()
    .default(4)
    .describe("Used to convert scene.bars → hold_beats at runtime."),
  quantize: z
    .enum(["off", "beat", "bar"])
    .default("off")
    .describe("Forwarded to manage_cue.recall/morph."),
  json: z.boolean().default(false).describe("Emit JSON-lines progress on stdout."),
});

export type SetlistRunnerCliArgs = z.infer<typeof setlistRunnerCliSchema>;

// ---------- emitted event shape ----------

export type RunnerEvent =
  | { t: "started"; total: number; bpm?: number; title?: string }
  | {
      t: "scene_enter";
      index: number;
      total: number;
      id: string;
      title?: string;
      hold: "duration" | "beat" | "manual";
    }
  | {
      t: "cued";
      cue: string;
      action: "recall" | "morph";
      morph: number;
      scene_id: string;
      step?: number;
    }
  | {
      t: "would_fire";
      cue: string;
      action: "recall" | "morph";
      morph: number;
      scene_id: string;
      step?: number;
    }
  | { t: "info"; msg: string; scene_id: string }
  | { t: "warning"; msg: string; scene_id?: string; cue?: string }
  | { t: "advanced"; reason: "duration" | "beat" | "manual" | "goto" | "prev"; scene_id: string }
  | { t: "ended"; reason: "complete" | "stopped"; scenes_fired: number };

// ---------- DI shapes ----------

/** Subset of the cue-firing surface we need. */
export interface CueCaller {
  fire(args: {
    action: "recall" | "morph";
    comp_path: string;
    name: string;
    duration: number;
    quantize: "off" | "beat" | "bar";
  }): Promise<void>;
}

/** Swappable clock so the test can advance time without real sleeps. */
export interface RunnerClock {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

/** Pub-sub for `clock.beat` events from the live TdEventStream. */
export interface BeatSource {
  /** Subscribe; returns an unsubscribe function. */
  on(listener: () => void): () => void;
}

export type Signal =
  | { t: "next" }
  | { t: "prev" }
  | { t: "stop" }
  | { t: "goto"; target: string | number };

export interface SignalSource {
  /** Async iterator that yields control signals. End of iteration = unattended. */
  [Symbol.asyncIterator](): AsyncIterator<Signal>;
}

export interface RunnerOptions {
  setlist: CanonicalSetlist;
  args: SetlistRunnerCliArgs;
  client: CueCaller;
  clock: RunnerClock;
  beatSource?: BeatSource;
  signals?: SignalSource;
  emit: (event: RunnerEvent) => void;
}

export interface RunnerSummary {
  scenes_total: number;
  scenes_fired: number;
  warnings: number;
  ended_reason: "complete" | "stopped";
}

// ---------- helpers ----------

function resolveStart(
  scenes: CanonicalScene[],
  start: string | number | undefined,
): { ok: true; index: number } | { ok: false; message: string } {
  if (start === undefined) return { ok: true, index: 0 };
  if (typeof start === "number") {
    if (start < 0 || start >= scenes.length) {
      return { ok: false, message: `start index ${start} out of range (0..${scenes.length - 1})` };
    }
    return { ok: true, index: start };
  }
  const idx = scenes.findIndex((s) => s.id === start);
  if (idx === -1) {
    const ids = scenes.map((s) => s.id).join(", ");
    return { ok: false, message: `start id "${start}" not found; available: ${ids}` };
  }
  return { ok: true, index: idx };
}

function pickHoldMode(
  scene: CanonicalScene,
  globalMode: "duration" | "beat" | "manual",
  beatsPerBar: number,
): { kind: "duration"; seconds: number } | { kind: "beat"; beats: number } | { kind: "manual" } {
  if (typeof scene.hold_seconds === "number") {
    return { kind: "duration", seconds: scene.hold_seconds };
  }
  if (typeof scene.hold_beats === "number") {
    return { kind: "beat", beats: scene.hold_beats };
  }
  if (typeof scene.bars === "number") {
    return { kind: "beat", beats: scene.bars * beatsPerBar };
  }
  if (globalMode === "duration") return { kind: "duration", seconds: 0 };
  if (globalMode === "beat") return { kind: "beat", beats: 0 };
  return { kind: "manual" };
}

function pickStepHoldMode(
  step: CanonicalStep,
  globalMode: "duration" | "beat" | "manual",
): { kind: "duration"; seconds: number } | { kind: "beat"; beats: number } | { kind: "manual" } {
  if (typeof step.hold_seconds === "number") {
    return { kind: "duration", seconds: step.hold_seconds };
  }
  if (typeof step.hold_beats === "number") {
    return { kind: "beat", beats: step.hold_beats };
  }
  if (globalMode === "duration") return { kind: "duration", seconds: 0 };
  if (globalMode === "beat") return { kind: "beat", beats: 0 };
  return { kind: "manual" };
}

// ---------- main driver ----------

/**
 * Runs the setlist through the dependency-injected client/clock/beat-source.
 * Resolves when the show ends (complete or stopped). Never throws on TD
 * failures — they are emitted as warnings (fail-forward) per spec.
 */
export async function runSetlist(opts: RunnerOptions): Promise<RunnerSummary> {
  const { setlist, args, client, clock, beatSource, signals, emit } = opts;
  const scenes = setlist.scenes;
  let scenesFired = 0;
  let warnings = 0;
  let endedReason: "complete" | "stopped" = "complete";
  let bridgeDegraded = args.dry_run;

  const safeEmit = (e: RunnerEvent): void => {
    if (e.t === "warning") warnings++;
    emit(e);
  };

  // ---- signals queue ----
  const signalQueue: Signal[] = [];
  const signalWaiters: Array<(s: Signal | null) => void> = [];
  let signalsDone = false;

  const pushSignal = (s: Signal): void => {
    const waiter = signalWaiters.shift();
    if (waiter) waiter(s);
    else signalQueue.push(s);
  };
  const nextSignal = (): Promise<Signal | null> => {
    const queued = signalQueue.shift();
    if (queued) return Promise.resolve(queued);
    if (signalsDone) return Promise.resolve(null);
    return new Promise((resolve) => signalWaiters.push(resolve));
  };

  // pump signals into the queue concurrently
  if (signals) {
    (async () => {
      try {
        for await (const s of signals) pushSignal(s);
      } finally {
        signalsDone = true;
        while (signalWaiters.length) {
          const w = signalWaiters.shift();
          if (w) w(null);
        }
      }
    })();
  } else {
    signalsDone = true;
  }

  // ---- one cue fire ----
  const fireCue = async (
    cue: string,
    morph: number,
    sceneId: string,
    step?: number,
  ): Promise<void> => {
    const action: "recall" | "morph" = morph > 0 ? "morph" : "recall";
    if (bridgeDegraded) {
      safeEmit({ t: "would_fire", cue, action, morph, scene_id: sceneId, step });
      return;
    }
    try {
      await client.fire({
        action,
        comp_path: args.comp_path,
        name: cue,
        duration: morph,
        quantize: args.quantize,
      });
      safeEmit({ t: "cued", cue, action, morph, scene_id: sceneId, step });
    } catch (err) {
      if (err instanceof TdConnectionError) {
        bridgeDegraded = true;
        safeEmit({
          t: "warning",
          msg: "bridge offline, switching to dry-run for the rest of the show",
          scene_id: sceneId,
          cue,
        });
        safeEmit({ t: "would_fire", cue, action, morph, scene_id: sceneId, step });
        return;
      }
      if (err instanceof TdError) {
        safeEmit({ t: "warning", msg: err.message, scene_id: sceneId, cue });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      safeEmit({ t: "warning", msg, scene_id: sceneId, cue });
    }
  };

  // ---- wait for hold; preempted by signals ----
  type PreemptReason = "next" | "prev" | "goto" | "stop";
  type HoldOutcome =
    | { type: "elapsed" }
    | { type: "preempt"; reason: PreemptReason; target?: string | number };

  const waitForHold = async (
    mode: ReturnType<typeof pickHoldMode>,
    sceneId: string,
  ): Promise<HoldOutcome> => {
    if (mode.kind === "duration" && mode.seconds === 0) return { type: "elapsed" };
    if (mode.kind === "beat" && mode.beats === 0) return { type: "elapsed" };

    return new Promise<HoldOutcome>((resolve) => {
      let resolved = false;
      const finish = (out: HoldOutcome): void => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(out);
      };
      let timer: unknown = null;
      let unsub: (() => void) | null = null;
      let beatsLeft = mode.kind === "beat" ? mode.beats : 0;
      const cleanup = (): void => {
        if (timer !== null) clock.clearTimeout(timer);
        if (unsub) unsub();
      };

      if (mode.kind === "duration") {
        timer = clock.setTimeout(() => finish({ type: "elapsed" }), mode.seconds * 1000);
      } else if (mode.kind === "beat") {
        if (!beatSource) {
          safeEmit({
            t: "warning",
            msg: "no event stream; beat mode requires TDMCP_EVENTS — waiting on manual signal",
            scene_id: sceneId,
          });
        } else {
          unsub = beatSource.on(() => {
            beatsLeft--;
            if (beatsLeft <= 0) finish({ type: "elapsed" });
          });
        }
      }
      // manual: wait only on signals

      // poll the signal queue
      (async () => {
        while (!resolved) {
          const s = await nextSignal();
          if (resolved) return;
          if (s === null) {
            // signals closed — keep waiting for timer/beats; in manual mode this means hang.
            if (mode.kind === "manual") finish({ type: "elapsed" });
            return;
          }
          if (s.t === "stop") return finish({ type: "preempt", reason: "stop" });
          if (s.t === "next") return finish({ type: "preempt", reason: "next" });
          if (s.t === "prev") return finish({ type: "preempt", reason: "prev" });
          if (s.t === "goto") return finish({ type: "preempt", reason: "goto", target: s.target });
        }
      })();
    });
  };

  // ---- start ----
  const startRes = resolveStart(scenes, args.start);
  if (!startRes.ok) {
    safeEmit({ t: "warning", msg: startRes.message });
    safeEmit({ t: "ended", reason: "complete", scenes_fired: 0 });
    return {
      scenes_total: scenes.length,
      scenes_fired: 0,
      warnings,
      ended_reason: "complete",
    };
  }

  safeEmit({ t: "started", total: scenes.length, bpm: setlist.bpm, title: setlist.title });

  let cursor = startRes.index;
  let stopRequested = false;

  while (cursor < scenes.length && !stopRequested) {
    const scene = scenes[cursor];
    if (!scene) break;
    const holdMode = pickHoldMode(scene, args.mode, args.beats_per_bar);
    safeEmit({
      t: "scene_enter",
      index: cursor,
      total: scenes.length,
      id: scene.id,
      title: scene.title,
      hold: holdMode.kind,
    });
    scenesFired++;

    // ---- fire ----
    if (scene.cue) {
      await fireCue(scene.cue, scene.morph_seconds, scene.id);
    } else if (scene.steps && scene.steps.length > 0) {
      let stepPreempt: HoldOutcome | null = null;
      for (let si = 0; si < scene.steps.length; si++) {
        const step = scene.steps[si];
        if (!step) continue;
        await fireCue(step.cue, step.morph_seconds, scene.id, si);
        const stepHold = pickStepHoldMode(step, args.mode);
        const outcome = await waitForHold(stepHold, scene.id);
        if (outcome.type === "preempt") {
          stepPreempt = outcome;
          break;
        }
      }
      if (stepPreempt) {
        // apply the preempt to the scene cursor
        if (stepPreempt.reason === "stop") {
          stopRequested = true;
          break;
        }
        if (stepPreempt.reason === "next") {
          safeEmit({ t: "advanced", reason: "manual", scene_id: scene.id });
          cursor++;
          continue;
        }
        if (stepPreempt.reason === "prev") {
          safeEmit({ t: "advanced", reason: "prev", scene_id: scene.id });
          cursor = Math.max(0, cursor - 1);
          continue;
        }
        if (stepPreempt.reason === "goto") {
          const target = stepPreempt.target;
          const res = resolveStart(scenes, target);
          if (!res.ok) {
            safeEmit({ t: "warning", msg: res.message, scene_id: scene.id });
            cursor++;
          } else {
            safeEmit({ t: "advanced", reason: "goto", scene_id: scene.id });
            cursor = res.index;
          }
          continue;
        }
      }
    } else {
      safeEmit({
        t: "info",
        msg: scene.recipe
          ? `scene has recipe "${scene.recipe}" — runner does not build; use import_setlist first`
          : scene.preset
            ? `scene has preset "${scene.preset}" — runner does not recall presets`
            : "scene has no cue/steps; honoring hold only",
        scene_id: scene.id,
      });
    }

    // ---- hold ----
    const outcome = await waitForHold(holdMode, scene.id);
    if (outcome.type === "elapsed") {
      const reason: "duration" | "beat" | "manual" =
        holdMode.kind === "duration" ? "duration" : holdMode.kind === "beat" ? "beat" : "manual";
      safeEmit({ t: "advanced", reason, scene_id: scene.id });
      cursor++;
    } else {
      if (outcome.reason === "stop") {
        stopRequested = true;
        break;
      }
      if (outcome.reason === "next") {
        safeEmit({ t: "advanced", reason: "manual", scene_id: scene.id });
        cursor++;
      } else if (outcome.reason === "prev") {
        safeEmit({ t: "advanced", reason: "prev", scene_id: scene.id });
        cursor = Math.max(0, cursor - 1);
      } else if (outcome.reason === "goto") {
        const res = resolveStart(scenes, outcome.target);
        if (!res.ok) {
          safeEmit({ t: "warning", msg: res.message, scene_id: scene.id });
          cursor++;
        } else {
          safeEmit({ t: "advanced", reason: "goto", scene_id: scene.id });
          cursor = res.index;
        }
      }
    }

    // ---- loop ----
    if (cursor >= scenes.length && args.loop && !stopRequested) {
      cursor = 0;
    }
  }

  endedReason = stopRequested ? "stopped" : "complete";
  safeEmit({ t: "ended", reason: endedReason, scenes_fired: scenesFired });
  return {
    scenes_total: scenes.length,
    scenes_fired: scenesFired,
    warnings,
    ended_reason: endedReason,
  };
}

// ---------- input loader (pure; consumed by the CLI wrapper) ----------

/**
 * Parse a raw setlist (JSON string or already-decoded object) into a
 * CanonicalSetlist. The CLI wrapper handles file I/O (and the .md/.yaml
 * cases) before calling this; this keeps the loader unit-testable.
 */
export function loadCanonicalSetlist(
  raw: unknown,
): { ok: true; setlist: CanonicalSetlist } | { ok: false; message: string } {
  let input: unknown = raw;
  if (typeof raw === "string") {
    try {
      input = JSON.parse(raw);
    } catch {
      return { ok: false, message: "setlist string is not valid JSON" };
    }
  }
  try {
    return { ok: true, setlist: normalize(input) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `setlist is invalid: ${msg}` };
  }
}
