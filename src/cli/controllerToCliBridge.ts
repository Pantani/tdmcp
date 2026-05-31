/**
 * controller_to_cli_bridge — bind MIDI/OSC controller events on a TouchDesigner
 * input CHOP to local shell commands.
 *
 * This is a CLI subcommand (not an MCP tool). The TD bridge already owns device
 * I/O via the user's MIDI In / OSC In CHOP; we poll that CHOP's channel values
 * over the existing `executePythonScript` route, detect edges/thresholds per
 * binding, and spawn external processes (fire-and-forget) with per-binding
 * debounce.
 *
 * The runner factors into:
 *   - a pure `tickOnce(state, sample, now)` reducer (the unit-test seam)
 *   - an imperative `runControllerBridge(ctx, args, deps)` loop that polls TD
 *     and calls the injected spawner.
 *
 * No new TD-side surface, no new client method, no validator change.
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../tools/pythonReport.js";
import type { ToolContext } from "../tools/types.js";

// ---------------------------------------------------------------------------
// CLI argument schema (parsed in agent.ts via parseArgs, handed in here)
// ---------------------------------------------------------------------------
export const controllerBridgeCliSchema = z.object({
  config: z.string().min(1).describe("Path to a JSON bindings file."),
  listener: z
    .string()
    .optional()
    .describe("Default TD op path of the input CHOP (e.g. /project1/midi_in1)."),
  poll_ms: z.number().int().min(5).max(1000).default(30),
  dry_run: z.boolean().default(false),
  once: z.boolean().default(false),
  max_spawns: z.number().int().nonnegative().default(0),
  log_json: z.boolean().default(false),
  shell: z.boolean().default(false),
});
export type ControllerBridgeCliArgs = z.infer<typeof controllerBridgeCliSchema>;

// ---------------------------------------------------------------------------
// Event variants (discriminated union)
// ---------------------------------------------------------------------------
export const midiNoteEventSchema = z.object({
  type: z.literal("midi-note"),
  value: z.number().int().min(0).max(127),
  edge: z.enum(["on", "off", "any"]).default("on"),
  channel: z.number().int().min(1).max(16).optional(),
});

export const midiCcEventSchema = z.object({
  type: z.literal("midi-cc"),
  value: z.number().int().min(0).max(127),
  threshold: z.number().min(0).max(1).default(0.5),
  edge: z.enum(["rising", "falling", "any"]).default("rising"),
  channel: z.number().int().min(1).max(16).optional(),
});

export const oscAddrEventSchema = z.object({
  type: z.literal("osc-addr"),
  value: z.string().min(1),
  edge: z.enum(["rising", "any"]).default("rising"),
});

export const channelEventSchema = z.object({
  type: z.literal("channel"),
  value: z.string().min(1),
  threshold: z.number().min(0).default(0.5),
  edge: z.enum(["rising", "falling", "any"]).default("rising"),
});

export const bindingEventSchema = z.discriminatedUnion("type", [
  midiNoteEventSchema,
  midiCcEventSchema,
  oscAddrEventSchema,
  channelEventSchema,
]);
export type BindingEvent = z.infer<typeof bindingEventSchema>;

export const bindingSchema = z.object({
  id: z.string().min(1),
  event: bindingEventSchema,
  command: z.array(z.string().min(1)).min(1),
  debounce_ms: z.number().int().min(0).default(250),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  listener_path: z.string().optional(),
});
export type Binding = z.infer<typeof bindingSchema>;

export const bindingsFileSchema = z.object({
  listener_path: z.string().optional(),
  bindings: z.array(bindingSchema).min(1),
});
export type BindingsFile = z.infer<typeof bindingsFileSchema>;

// ---------------------------------------------------------------------------
// Reducer types
// ---------------------------------------------------------------------------
/** Per-binding state: previous sampled value + last-fire timestamp. */
export interface BindingState {
  prev: number | null;
  lastFiredAt: number | null;
}

export type TickState = Record<string, BindingState>;

/** A sample of the listener CHOP's channels at one tick. */
export type ChannelSample = Record<string, number>;

export interface FireDecision {
  binding_id: string;
  event_type: BindingEvent["type"];
  channel: string;
  value: number;
  edge: string;
}

export interface DebounceDecision {
  binding_id: string;
  reason: "debounced";
  remaining_ms: number;
}

export interface TickDecisions {
  fires: FireDecision[];
  debounced: DebounceDecision[];
  state: TickState;
}

// ---------------------------------------------------------------------------
// Channel resolution
// ---------------------------------------------------------------------------
/**
 * Resolve which channel name on the listener CHOP a binding watches. Returns
 * the list of candidate names (the bridge poll already returns all channels,
 * so we just look them up in the sample).
 */
export function channelCandidatesFor(event: BindingEvent): string[] {
  switch (event.type) {
    case "midi-note":
      // MIDI In CHOP exposes notes as `n<value>` (e.g. n60). Channel prefix
      // (chN_) is optional depending on the CHOP's Channel param.
      if (event.channel !== undefined) {
        return [`ch${event.channel}n${event.value}`, `n${event.value}`];
      }
      return [`n${event.value}`];
    case "midi-cc":
      if (event.channel !== undefined) {
        return [`ch${event.channel}c${event.value}`, `c${event.value}`];
      }
      return [`c${event.value}`];
    case "osc-addr": {
      const v = event.value;
      // OSC In CHOP commonly converts /scene/next -> scene_next; also keep raw.
      const stripped = v.startsWith("/") ? v.slice(1) : v;
      const underscored = stripped.replace(/\//g, "_");
      return Array.from(new Set([v, stripped, underscored]));
    }
    case "channel":
      return [event.value];
  }
}

interface MatchedChannel {
  name: string;
  value: number;
}

function pickSampleChannel(sample: ChannelSample, candidates: string[]): MatchedChannel | null {
  for (const c of candidates) {
    if (Object.hasOwn(sample, c)) {
      const v = sample[c];
      if (typeof v === "number") return { name: c, value: v };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Edge detection per event type
// ---------------------------------------------------------------------------
function detectEdge(
  event: BindingEvent,
  prev: number | null,
  curr: number,
): { fired: boolean; edge: string } {
  switch (event.type) {
    case "midi-note": {
      const wasOn = (prev ?? 0) > 0;
      const isOn = curr > 0;
      if (event.edge === "on") return { fired: !wasOn && isOn, edge: "on" };
      if (event.edge === "off") return { fired: wasOn && !isOn, edge: "off" };
      return { fired: wasOn !== isOn, edge: isOn ? "on" : "off" };
    }
    case "midi-cc": {
      const t = event.threshold;
      const wasAbove = (prev ?? 0) >= t;
      const isAbove = curr >= t;
      if (event.edge === "rising") return { fired: !wasAbove && isAbove, edge: "rising" };
      if (event.edge === "falling") return { fired: wasAbove && !isAbove, edge: "falling" };
      return { fired: wasAbove !== isAbove, edge: isAbove ? "rising" : "falling" };
    }
    case "osc-addr": {
      const wasTruthy = (prev ?? 0) > 0.5;
      const isTruthy = curr > 0.5;
      if (event.edge === "rising") return { fired: !wasTruthy && isTruthy, edge: "rising" };
      return { fired: wasTruthy !== isTruthy, edge: isTruthy ? "rising" : "falling" };
    }
    case "channel": {
      const t = event.threshold;
      const wasAbove = (prev ?? 0) >= t;
      const isAbove = curr >= t;
      if (event.edge === "rising") return { fired: !wasAbove && isAbove, edge: "rising" };
      if (event.edge === "falling") return { fired: wasAbove && !isAbove, edge: "falling" };
      return { fired: wasAbove !== isAbove, edge: isAbove ? "rising" : "falling" };
    }
  }
}

// ---------------------------------------------------------------------------
// Pure reducer — the unit-test seam
// ---------------------------------------------------------------------------
/**
 * Apply one sample of the listener CHOP to the state, returning fires +
 * debounced suppressions and the next state. Pure: no I/O, no side effects.
 */
export function tickOnce(
  state: TickState,
  bindings: Binding[],
  sample: ChannelSample,
  now: number,
): TickDecisions {
  const fires: FireDecision[] = [];
  const debounced: DebounceDecision[] = [];
  const next: TickState = { ...state };

  for (const b of bindings) {
    const candidates = channelCandidatesFor(b.event);
    const match = pickSampleChannel(sample, candidates);
    const prevState = next[b.id] ?? { prev: null, lastFiredAt: null };
    if (match === null) {
      next[b.id] = prevState;
      continue;
    }
    const { fired, edge } = detectEdge(b.event, prevState.prev, match.value);
    if (!fired) {
      next[b.id] = { prev: match.value, lastFiredAt: prevState.lastFiredAt };
      continue;
    }
    const lastFiredAt = prevState.lastFiredAt;
    if (lastFiredAt !== null && now - lastFiredAt < b.debounce_ms) {
      debounced.push({
        binding_id: b.id,
        reason: "debounced",
        remaining_ms: b.debounce_ms - (now - lastFiredAt),
      });
      next[b.id] = { prev: match.value, lastFiredAt };
      continue;
    }
    fires.push({
      binding_id: b.id,
      event_type: b.event.type,
      channel: match.name,
      value: match.value,
      edge,
    });
    next[b.id] = { prev: match.value, lastFiredAt: now };
  }

  return { fires, debounced, state: next };
}

// ---------------------------------------------------------------------------
// argv shaping — exported for tests
// ---------------------------------------------------------------------------
export function shapeArgv(command: string[], useShell: boolean): { file: string; args: string[] } {
  if (useShell) {
    const joined = command.join(" ");
    if (process.platform === "win32") {
      return { file: process.env.COMSPEC || "cmd.exe", args: ["/c", joined] };
    }
    return { file: "/bin/sh", args: ["-lc", joined] };
  }
  const file = command[0];
  if (typeof file !== "string") {
    throw new Error("command must have at least one argv element");
  }
  return { file, args: command.slice(1) };
}

// ---------------------------------------------------------------------------
// Bindings file loader
// ---------------------------------------------------------------------------
export async function loadBindingsFile(
  path: string,
): Promise<{ ok: true; bindings: BindingsFile } | { ok: false; message: string }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `could not read bindings file ${path}: ${msg}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `bindings file is not valid JSON: ${msg}` };
  }
  const parsed = bindingsFileSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      message: `bindings file failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, bindings: parsed.data };
}

// ---------------------------------------------------------------------------
// Python payload — read one CHOP's channels + a frame counter
// ---------------------------------------------------------------------------
const POLL_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"frame": 0, "channels": {}, "fatal": None}
try:
    _n = op(_p["listener"])
    if _n is None:
        report["fatal"] = "Listener op not found: " + str(_p["listener"])
    else:
        try:
            report["frame"] = int(absTime.frame)
        except Exception:
            report["frame"] = 0
        _want = set(_p.get("channels") or [])
        try:
            for c in _n.chans():
                if (not _want) or (c.name in _want):
                    try:
                        report["channels"][c.name] = float(c.eval())
                    except Exception:
                        report["channels"][c.name] = 0.0
        except Exception as _e:
            report["fatal"] = "Could not read channels: " + str(_e)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

interface PollReport {
  frame: number;
  channels: ChannelSample;
  fatal: string | null;
}

// ---------------------------------------------------------------------------
// Logger + spawn DI shapes
// ---------------------------------------------------------------------------
export interface SpawnedChildSummary {
  pid: number | null;
}

/** Minimal spawner shape; real impl uses node:child_process. */
export type SpawnLike = (
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: "inherit" | "ignore" },
) => SpawnedChildSummary;

export type LogEvent =
  | {
      type: "started";
      listener: string;
      poll_ms: number;
      bindings: string[];
    }
  | {
      type: "fired";
      ts: string;
      binding_id: string;
      event: BindingEvent["type"];
      channel: string;
      value: number;
      edge: string;
      command: string[];
      pid: number | null;
      dry_run: boolean;
    }
  | {
      type: "debounced";
      ts: string;
      binding_id: string;
      remaining_ms: number;
    }
  | { type: "fatal"; ts: string; message: string }
  | {
      type: "stopped";
      ts: string;
      events: number;
      spawns: number;
      debounced: number;
    };

export type EmitLog = (ev: LogEvent) => void;

export interface RunnerDeps {
  spawn?: SpawnLike;
  now?: () => number;
  /** Sleeps for ms; tests can inject a fake. */
  sleep?: (ms: number) => Promise<void>;
  /** Receives every structured event (tests assert against this). */
  emit?: EmitLog;
  /** Abort signal to stop the loop. */
  signal?: AbortSignal;
}

export interface RunnerSummary {
  events: number;
  spawns: number;
  debounced: number;
  fatal: string | null;
  exit_code: number;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------
export async function runControllerBridge(
  ctx: ToolContext,
  rawArgs: Partial<ControllerBridgeCliArgs>,
  deps: RunnerDeps = {},
): Promise<RunnerSummary> {
  const args = controllerBridgeCliSchema.parse(rawArgs);
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const emit = deps.emit ?? (() => {});

  const loaded = await loadBindingsFile(args.config);
  if (!loaded.ok) {
    emit({ type: "fatal", ts: new Date(now()).toISOString(), message: loaded.message });
    return { events: 0, spawns: 0, debounced: 0, fatal: loaded.message, exit_code: 2 };
  }
  const file = loaded.bindings;

  const defaultListener = file.listener_path ?? args.listener;
  // Group bindings by listener path; per-binding override wins.
  const byListener = new Map<string, Binding[]>();
  for (const b of file.bindings) {
    const path = b.listener_path ?? defaultListener;
    if (!path) {
      const msg = `binding "${b.id}" has no listener_path and no default --listener was provided`;
      emit({ type: "fatal", ts: new Date(now()).toISOString(), message: msg });
      return { events: 0, spawns: 0, debounced: 0, fatal: msg, exit_code: 2 };
    }
    const list = byListener.get(path) ?? [];
    list.push(b);
    byListener.set(path, list);
  }

  const primaryListener = defaultListener ?? Array.from(byListener.keys())[0] ?? "(unknown)";
  emit({
    type: "started",
    listener: primaryListener,
    poll_ms: args.poll_ms,
    bindings: file.bindings.map((b) => b.id),
  });

  // Pre-compute the channel-name allow-list per listener for the bridge payload.
  const wanted = new Map<string, string[]>();
  for (const [path, list] of byListener) {
    const names = new Set<string>();
    for (const b of list) {
      for (const c of channelCandidatesFor(b.event)) names.add(c);
    }
    wanted.set(path, Array.from(names));
  }

  // Per-listener state.
  const stateByListener = new Map<string, TickState>();
  for (const path of byListener.keys()) stateByListener.set(path, {});

  // Spawner default: lazy-load child_process so tests don't need to mock it.
  const spawner: SpawnLike =
    deps.spawn ??
    ((file2, args2, opts) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- defer; tests inject
      const cp = require("node:child_process") as typeof import("node:child_process");
      const child = cp.spawn(file2, args2, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: opts.stdio ?? "inherit",
        detached: false,
      });
      child.on("error", () => {
        // swallow — fire-and-forget; main loop must keep running.
      });
      return { pid: child.pid ?? null };
    });

  let events = 0;
  let spawns = 0;
  let debouncedCount = 0;
  let fatal: string | null = null;
  let exitCode = 0;
  let stop = false;

  const aborted = () => deps.signal?.aborted === true || stop;

  // Poll loop.
  while (!aborted()) {
    for (const [path, list] of byListener) {
      if (aborted()) break;
      const channels = wanted.get(path) ?? [];
      const script = buildPayloadScript(POLL_SCRIPT, { listener: path, channels });
      let report: PollReport;
      try {
        const exec = await ctx.client.executePythonScript(script, true);
        report = parsePythonReport<PollReport>(exec.stdout);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ type: "fatal", ts: new Date(now()).toISOString(), message: msg });
        fatal = msg;
        exitCode = 3;
        stop = true;
        break;
      }
      if (report.fatal) {
        emit({ type: "fatal", ts: new Date(now()).toISOString(), message: report.fatal });
        fatal = report.fatal;
        exitCode = 3;
        stop = true;
        break;
      }

      const t = now();
      const prev = stateByListener.get(path) ?? {};
      const result = tickOnce(prev, list, report.channels, t);
      stateByListener.set(path, result.state);

      for (const d of result.debounced) {
        debouncedCount++;
        emit({
          type: "debounced",
          ts: new Date(t).toISOString(),
          binding_id: d.binding_id,
          remaining_ms: d.remaining_ms,
        });
      }
      for (const f of result.fires) {
        events++;
        const binding = list.find((b) => b.id === f.binding_id);
        if (!binding) continue;
        let pid: number | null = null;
        if (!args.dry_run) {
          try {
            const shaped = shapeArgv(binding.command, args.shell);
            const env = binding.env ? { ...process.env, ...binding.env } : process.env;
            const summary = spawner(shaped.file, shaped.args, {
              cwd: binding.cwd,
              env,
              stdio: "inherit",
            });
            pid = summary.pid;
            spawns++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            emit({
              type: "fatal",
              ts: new Date(t).toISOString(),
              message: `spawn failed for ${binding.id}: ${msg}`,
            });
            // non-fatal to the loop; continue with other bindings.
          }
        } else {
          spawns++; // count would-spawns in dry-run for accounting
        }

        emit({
          type: "fired",
          ts: new Date(t).toISOString(),
          binding_id: f.binding_id,
          event: f.event_type,
          channel: f.channel,
          value: f.value,
          edge: f.edge,
          command: binding.command,
          pid,
          dry_run: args.dry_run,
        });

        if (args.once) {
          stop = true;
          break;
        }
        if (args.max_spawns > 0 && spawns >= args.max_spawns) {
          stop = true;
          break;
        }
      }
    }
    if (aborted()) break;
    await sleep(args.poll_ms);
  }

  emit({
    type: "stopped",
    ts: new Date(now()).toISOString(),
    events,
    spawns,
    debounced: debouncedCount,
  });

  return { events, spawns, debounced: debouncedCount, fatal, exit_code: exitCode };
}
