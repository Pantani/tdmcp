import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

export const createShowFailoverSchema = z.object({
  primary_path: z
    .string()
    .default("")
    .describe(
      "Absolute TD path to the primary source TOP (NDI/camera/Spout/Syphon/any TOP). Empty → builds a synthetic noiseTOP so the network is offline-safe.",
    ),
  fallback_file: z
    .string()
    .default("")
    .describe(
      "Filesystem path to the fallback MP4 / still. Empty → a constantTOP (dark grey) is used as a safe fallback.",
    ),
  stall_ms: z.coerce
    .number()
    .int()
    .min(50)
    .max(10000)
    .default(500)
    .describe("Consecutive ms of zero cook progress before failover trips."),
  fade_ms: z.coerce
    .number()
    .int()
    .min(0)
    .max(5000)
    .default(250)
    .describe(
      "Crossfade duration in ms (0 = hard cut). Drives the Filter CHOP that smooths the Switch TOP index.",
    ),
  sticky_recover: z.coerce
    .boolean()
    .default(false)
    .describe(
      "When true, auto-switch back to primary after `recover_ms` of healthy cooking. When false, stays on fallback until Reset is pressed.",
    ),
  recover_ms: z.coerce
    .number()
    .int()
    .min(100)
    .max(60000)
    .default(2000)
    .describe("Healthy duration before auto-recover (only used when sticky_recover=true)."),
  watch_errors: z.coerce
    .boolean()
    .default(true)
    .describe("Also trip on primary cook errors (`errors > 0`), not just on stall."),
  status_overlay: z.coerce
    .boolean()
    .default(true)
    .describe("Composite a small LIVE/FALLBACK badge (textTOP + compTOP) into the output."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Where to create the show_failover system container."),
});
type CreateShowFailoverArgs = z.infer<typeof createShowFailoverSchema>;

// Watchdog callback: runs in TD's normal op context as an Execute DAT firing on
// every frame start. It samples the primary's Info CHOP each frame, latches a
// stall when `total_cooks` stops incrementing for stall_ms (and optionally when
// `errors` > 0), and drives the `target_index` constant CHOP — the Filter CHOP
// smooths that integer step into a 0→1 crossfade fed to the Switch TOP's index
// (blend=1). We use frameStart (not chopexecute valueChange) because an Info
// CHOP's `total_cooks` value-change semantics don't tick reliably while the
// source cooks normally; we need a guaranteed per-frame tick to compute
// `delta = total_cooks_now - total_cooks_last_frame`.
// Placeholders: __STALL_MS__ __RECOVER_MS__ __STICKY__ __WATCH_ERRORS__
const WATCHDOG = `
def _cfg(name, default):
    par = getattr(me.parent().par, name, None)
    if par is None:
        return default
    try:
        return par.eval()
    except Exception:
        return default

def _read_info():
    info = op('info')
    cooks = 0.0
    errs = 0.0
    if info is None:
        return cooks, errs
    try:
        for ch in info.chans():
            if ch.name == 'total_cooks':
                cooks = float(ch[0])
            elif ch.name == 'errors':
                errs = float(ch[0])
    except Exception:
        pass
    return cooks, errs

def onStart():
    fo = me.parent()
    cooks, _ = _read_info()
    fo.store('tdmcp_failover_state', {
        'last_cooks': cooks,
        'stall_frames': 0,
        'healthy_frames': 0,
        'on_fallback': False,
        'failovers_total': 0,
    })
    return

def onFrameStart(frame):
    fo = me.parent()
    if not _cfg('Active', 1):
        return
    info = op('info')
    target = op('target_index')
    if info is None or target is None:
        return
    cooks, errs = _read_info()
    state = fo.fetch('tdmcp_failover_state', None)
    if state is None:
        state = {
            'last_cooks': cooks,
            'stall_frames': 0,
            'healthy_frames': 0,
            'on_fallback': False,
            'failovers_total': 0,
        }
        fo.store('tdmcp_failover_state', state)
        return
    fps = float(getattr(project, 'cookRate', 60.0) or 60.0)
    stall_frames_needed = max(1, int(round((__STALL_MS__ / 1000.0) * fps)))
    recover_frames_needed = max(1, int(round((__RECOVER_MS__ / 1000.0) * fps)))
    sticky = bool(_cfg('Stickyrecover', __STICKY__))
    watch_errors = bool(__WATCH_ERRORS__)

    delta = cooks - state['last_cooks']
    advanced = delta > 0
    error_trip = watch_errors and errs > 0
    if advanced and not error_trip:
        state['stall_frames'] = 0
        state['healthy_frames'] += 1
    else:
        state['stall_frames'] += 1
        state['healthy_frames'] = 0
    state['last_cooks'] = cooks

    if not state['on_fallback'] and state['stall_frames'] >= stall_frames_needed:
        state['on_fallback'] = True
        state['failovers_total'] += 1
        try:
            target.par.value0 = 1
        except Exception:
            pass
    elif state['on_fallback'] and sticky and state['healthy_frames'] >= recover_frames_needed:
        state['on_fallback'] = False
        try:
            target.par.value0 = 0
        except Exception:
            pass

    fo.store('tdmcp_failover_state', state)
    return

def onCreate():
    onStart()
    return

def onPulse(par):
    fo = me.parent()
    target = op('target_index')
    state = fo.fetch('tdmcp_failover_state', {})
    if par.name == 'Reset':
        try:
            target.par.value0 = 0
        except Exception:
            pass
        state['on_fallback'] = False
        state['stall_frames'] = 0
        state['healthy_frames'] = 0
    elif par.name == 'Forcefallback':
        try:
            target.par.value0 = 1
        except Exception:
            pass
        state['on_fallback'] = True
        state['failovers_total'] = state.get('failovers_total', 0) + 1
    fo.store('tdmcp_failover_state', state)
    return
`;

export async function createShowFailoverImpl(ctx: ToolContext, args: CreateShowFailoverArgs) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "show_failover");

    // Primary source: a Select TOP pointing at the artist's source TOP, or a
    // synthetic noiseTOP when primary_path is empty (offline-safe build).
    const usingSyntheticPrimary = !args.primary_path;
    const primaryIn = usingSyntheticPrimary
      ? await builder.add("noiseTOP", "primary_in", { type: "sparse", period: 4 })
      : await builder.add("selectTOP", "primary_in", { top: args.primary_path });

    // Fallback: moviefileinTOP when a file is given; constantTOP otherwise so
    // the build is always valid even without the asset on disk.
    const usingSyntheticFallback = !args.fallback_file;
    const fallback = usingSyntheticFallback
      ? await builder.add("constantTOP", "fallback", {
          colorr: 0.05,
          colorg: 0.05,
          colorb: 0.05,
          alpha: 1,
        })
      : await builder.add("moviefileinTOP", "fallback", { file: args.fallback_file, play: 1 });

    // Switch TOP with blend=1 cross-dissolves between inputs by a float index
    // (0 = primary, 1 = fallback). The Filter CHOP smooths the integer step.
    const switchTop = await builder.add("switchTOP", "switch", { blend: 1, index: 0 });
    await builder.connect(primaryIn, switchTop, 0, 0);
    await builder.connect(fallback, switchTop, 0, 1);

    // Watchdog rail: Info CHOP samples the primary; a Constant CHOP holds the
    // raw integer target (0/1) which the Filter CHOP smooths over fade_ms.
    const info = await builder.add("infoCHOP", "info", { op: primaryIn });
    const targetIndex = await builder.add("constantCHOP", "target_index", {
      name0: "value",
      value0: 0,
    });
    const fade = await builder.add("filterCHOP", "fade", {
      type: "gauss",
      width: args.fade_ms / 1000,
    });
    await builder.connect(targetIndex, fade, 0, 0);
    // Optional Logic CHOP — documented in the spec; here it acts as a fallback
    // health-latch readable from `status`. The watchdog DAT does the precise
    // stall accounting; the downstream Trigger CHOP provides the debounce
    // window (Logic CHOP has no offdelay/ondelay parameter on TD 099).
    const stallDetect = await builder.add("logicCHOP", "stall_detect", {
      convert: "off",
    });
    await builder.connect(info, stallDetect, 0, 0);
    // Trigger CHOP debounce: `release` holds the trip signal high for
    // stall_ms after the Logic CHOP falls back to 0, smoothing out one-frame
    // hiccups so the failover doesn't flap.
    const stallDebounce = await builder.add("triggerCHOP", "stall_debounce", {
      release: args.stall_ms / 1000,
    });
    await builder.connect(stallDetect, stallDebounce, 0, 0);

    // Status Null CHOP exposes channels for bind_to_channel.
    const status = await builder.add("nullCHOP", "status", {});
    await builder.connect(targetIndex, status, 0, 0);

    // Watchdog DAT: Execute DAT firing onFrameStart so we get a guaranteed
    // per-frame tick (Info CHOP value-change semantics don't reliably fire
    // while the source cooks normally — we need to compute a delta against
    // last frame's `total_cooks` every frame).
    const watchdog = await builder.add("executeDAT", "watchdog", {
      framestart: 1,
      start: 1,
      create: 1,
      active: 1,
    });
    const watchdogText = WATCHDOG.replaceAll("__STALL_MS__", String(args.stall_ms))
      .replaceAll("__RECOVER_MS__", String(args.recover_ms))
      .replaceAll("__STICKY__", args.sticky_recover ? "True" : "False")
      .replaceAll("__WATCH_ERRORS__", args.watch_errors ? "True" : "False");
    await builder.python(`op(${q(watchdog)}).text = ${q(watchdogText)}`);

    // Output stage. Optional LIVE/FALLBACK badge composited over the switch.
    let outputSource = switchTop;
    let statusText: string | undefined;
    let overlay: string | undefined;
    if (args.status_overlay) {
      statusText = await builder.add("textTOP", "status_text", {
        text: "LIVE",
        fontsizex: 24,
        alignx: "left",
        aligny: "top",
        resolutionw: 256,
        resolutionh: 64,
      });
      overlay = await builder.add("compTOP", "overlay", { operand: "over" });
      await builder.connect(switchTop, overlay, 0, 0);
      await builder.connect(statusText, overlay, 0, 1);
      outputSource = overlay;
    }

    const out = await builder.add("nullTOP", "out", {});
    await builder.connect(outputSource, out, 0, 0);

    // Drive the Filter CHOP width from the live FadeMs knob so the artist can
    // retune the crossfade on stage without rebuilding. TD strips underscores
    // from custom-par attribute names — `Fade_Ms` is exposed as `FadeMs`.
    await builder.python(
      [
        `_p = op(${q(fade)}).par.width`,
        `_p.expr = ${q(`parent().par.FadeMs / 1000`)}`,
        `_p.mode = type(_p.mode).EXPRESSION`,
      ].join("\n"),
    );

    // Bind the Switch TOP index to the smoothed fade rail so the crossfade
    // actually drives output (watchdog writes target_index → fade smooths over
    // FadeMs → switch reads here). Without this expression the smoothing chain
    // is decorative.
    await builder.python(
      [
        `_p = op(${q(switchTop)}).par.index`,
        `_p.expr = ${q(`op('fade')[0]`)}`,
        `_p.mode = type(_p.mode).EXPRESSION`,
      ].join("\n"),
    );

    // Make the status badge reactive: shows LIVE when target_index<0.5,
    // FALLBACK otherwise — no Python cook-time ticking, just an expression
    // on the textTOP's `text` par.
    if (args.status_overlay && statusText) {
      await builder.python(
        [
          `_p = op(${q(statusText)}).par.text`,
          `_p.expr = ${q(`'LIVE' if op('target_index')[0] < 0.5 else 'FALLBACK'`)}`,
          `_p.mode = type(_p.mode).EXPRESSION`,
        ].join("\n"),
      );
    }

    const controls: ControlSpec[] = [
      { name: "Active", type: "toggle", default: 1, bind_to: [] },
      {
        name: "Stall_Ms",
        type: "int",
        min: 50,
        max: 10000,
        default: args.stall_ms,
        bind_to: [],
      },
      { name: "Fade_Ms", type: "int", min: 0, max: 5000, default: args.fade_ms, bind_to: [] },
      {
        name: "Sticky_Recover",
        type: "toggle",
        default: args.sticky_recover ? 1 : 0,
        bind_to: [],
      },
      { name: "Reset", type: "pulse", bind_to: [] },
      { name: "Force_Fallback", type: "pulse", bind_to: [] },
    ];

    const primaryDesc = usingSyntheticPrimary
      ? "a synthetic noiseTOP (no primary_path given)"
      : args.primary_path;
    const fallbackDesc = usingSyntheticFallback
      ? "a constantTOP (no fallback_file given)"
      : args.fallback_file;
    const summary = `Built show_failover watching ${primaryDesc} with fallback ${fallbackDesc}. Trips after ${args.stall_ms}ms stall${args.watch_errors ? " or on cook errors" : ""}, crossfades over ${args.fade_ms}ms, ${
      args.sticky_recover
        ? `auto-recovers after ${args.recover_ms}ms healthy`
        : "stays on fallback until Reset"
    }. Status channels on \`status\` Null CHOP (use bind_to_channel).`;

    return finalize(ctx, {
      summary,
      builder,
      outputPath: out,
      controls,
      extra: {
        output_top: out,
        status_chop: status,
        primary_in: primaryIn,
        fallback,
        switch: switchTop,
        watchdog,
        info,
        fade,
        target_index: targetIndex,
        stall_detect: stallDetect,
        stall_debounce: stallDebounce,
        status_text: statusText,
        overlay,
        synthetic_primary: usingSyntheticPrimary,
        synthetic_fallback: usingSyntheticFallback,
        primary_path: args.primary_path,
        fallback_file: args.fallback_file,
        stall_ms: args.stall_ms,
        fade_ms: args.fade_ms,
        sticky_recover: args.sticky_recover,
        recover_ms: args.recover_ms,
        watch_errors: args.watch_errors,
      },
    });
  });
}

export const registerCreateShowFailover: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_show_failover",
    {
      title: "Create show failover",
      description:
        "Build a live-show watchdog: a Switch TOP (blend=1 cross-dissolve) between a primary source TOP (NDI/camera/Spout/Syphon path, or a synthetic noiseTOP when none is given) and an MP4 fallback (or a constantTOP when no file is given), driven by an Info CHOP + watchdog CHOP-Execute DAT that trips on cook stall (total_cooks delta stays flat for stall_ms) and, optionally, primary cook errors. A Filter CHOP smooths the integer Switch index into a fade_ms crossfade. Sticky-recover auto-returns to primary after recover_ms healthy; otherwise stays on fallback until Reset. Exposes Active / Stall_Ms / Fade_Ms / Sticky_Recover / Reset / Force_Fallback controls and a Null CHOP of status channels for bind_to_channel. Returns the container, output TOP, status CHOP, control names, and the operator paths.",
      inputSchema: createShowFailoverSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createShowFailoverImpl(ctx, args),
  );
};
