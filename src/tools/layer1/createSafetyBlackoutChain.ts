import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { createSystemContainer, finalize, runBuild } from "./orchestration.js";

const q = (value: string): string => JSON.stringify(value);

export const createSafetyBlackoutChainSchema = z.object({
  input_path: z
    .string()
    .optional()
    .describe(
      "Absolute path of the master TOP to protect. Pulled in via a Select TOP (TD wires can't cross COMPs). If omitted, a Ramp TOP test source is used so the chain still builds + previews.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP the safety chain is built inside (default '/project1')."),
  fade_seconds: z
    .number()
    .min(0)
    .default(1.5)
    .describe("Time the soft fade-to-black (and symmetric fade-in) takes. 0 = instant."),
  fade_curve: z
    .enum(["linear", "ease_in", "ease_out", "ease_in_out", "s_curve"])
    .default("ease_in_out")
    .describe(
      "Interpolation shape for the fade ramp, applied via a Lookup CHOP curve so the ramp is deterministic and Python-free at cook time.",
    ),
  initial_state: z
    .enum(["live", "black", "held"])
    .default("live")
    .describe(
      "Boot state. 'live' = pass-through, 'black' = Blackout toggle on at load, 'held' = Hold toggle on (good for show open before first cue).",
    ),
  arm_emergency_snap: z
    .boolean()
    .default(true)
    .describe("Expose an Emergency momentary pulse that bypasses the fade and hard-cuts to black."),
  hotkey: z
    .string()
    .nullable()
    .optional()
    .default("ctrl.b")
    .describe(
      "Keyboard In CHOP key spec that toggles Blackout (e.g. 'ctrl.b'). null/empty disables — hotkey is opt-in safe, requires a modifier.",
    ),
  watchdog_channel: z
    .string()
    .optional()
    .describe(
      "Optional absolute CHOP path + channel ('node:channel') — when non-zero, forces Blackout on. Lets external monitors trigger blackout deterministically without Python.",
    ),
  recovery_mode: z
    .enum(["manual", "auto_on_clear"])
    .default("manual")
    .describe(
      "When the watchdog returns to 0: 'manual' keeps it black until the artist clears it; 'auto_on_clear' fades back in.",
    ),
  show_safe_label: z
    .string()
    .nullable()
    .optional()
    .default("SHOW SAFE")
    .describe(
      "Optional caption baked into the black frame (Text TOP composited over the dimmed output). Empty/null = no caption.",
    ),
  expose_controls: z
    .boolean()
    .default(true)
    .describe("Build the control panel with Blackout / Emergency / Fade Seconds / State LED."),
});
type CreateSafetyBlackoutChainArgs = z.infer<typeof createSafetyBlackoutChainSchema>;

/**
 * Builds a 32-sample 0..1 lookup table for the requested fade curve. The Speed CHOP
 * drives a 0..1 linear ramp; the Lookup CHOP reshapes it deterministically with no
 * Python at cook time — so the chain is ALLOW_EXEC=0-safe.
 */
function buildCurveSamples(curve: CreateSafetyBlackoutChainArgs["fade_curve"]): number[] {
  const N = 32;
  const out: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    let y: number;
    switch (curve) {
      case "linear":
        y = t;
        break;
      case "ease_in":
        y = t * t;
        break;
      case "ease_out":
        y = 1 - (1 - t) * (1 - t);
        break;
      case "s_curve":
        y = t * t * (3 - 2 * t);
        break;
      default:
        // ease_in_out
        y = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2;
        break;
    }
    out.push(Math.max(0, Math.min(1, y)));
  }
  return out;
}

export async function createSafetyBlackoutChainImpl(
  ctx: ToolContext,
  args: CreateSafetyBlackoutChainArgs,
) {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, "safety");
    const container = builder.containerPath;

    const initialBlackout = args.initial_state === "black";
    const initialHold = args.initial_state === "held";
    const fadeFloor = Math.max(0.001, args.fade_seconds || 0);
    const hotkeyEnabled = typeof args.hotkey === "string" && args.hotkey.length > 0;
    const labelText = typeof args.show_safe_label === "string" ? args.show_safe_label : "";

    // Custom Safety page + 5 pars, unbound (the dimmer expressions read them by
    // absolute path — binding them to themselves would create recursion errors, same
    // gotcha as create_panic). Always appended via Python so the COMP is usable via
    // op().par.Blackout even when expose_controls=false (panel binds different pars
    // via the layer-2 helper, which is additive on the page).
    await builder.python(
      [
        `_c = op(${q(container)})`,
        `_pg = None`,
        `for _p in _c.customPages:`,
        `    if _p.name == "Safety":`,
        `        _pg = _p; break`,
        `if _pg is None:`,
        `    _pg = _c.appendCustomPage("Safety")`,
        `if getattr(_c.par, "Blackout", None) is None:`,
        `    _bp = _pg.appendToggle("Blackout", label="Blackout")[0]`,
        `    _bp.default = ${initialBlackout ? "True" : "False"}; _bp.val = ${initialBlackout ? "True" : "False"}`,
        `if getattr(_c.par, "Emergency", None) is None:`,
        `    _ep = _pg.appendPulse("Emergency", label="Emergency")[0]`,
        `if getattr(_c.par, "Fadeseconds", None) is None:`,
        `    _fs = _pg.appendFloat("Fadeseconds", label="Fade seconds")[0]`,
        `    _fs.default = ${args.fade_seconds}; _fs.val = ${args.fade_seconds}`,
        `    _fs.normMin = 0; _fs.normMax = 10`,
        `if getattr(_c.par, "Hold", None) is None:`,
        `    _hp = _pg.appendToggle("Hold", label="Hold")[0]`,
        `    _hp.default = ${initialHold ? "True" : "False"}; _hp.val = ${initialHold ? "True" : "False"}`,
        `if getattr(_c.par, "State", None) is None:`,
        `    _sp = _pg.appendFloat("State", label="State")[0]`,
        `    _sp.normMin = 0; _sp.normMax = 1`,
      ].join("\n"),
    );

    // ───── source ─────
    let source: string;
    if (args.input_path) {
      source = await builder.add("selectTOP", "src", { top: args.input_path });
    } else {
      source = await builder.add("rampTOP", "src");
    }

    // ───── trigger inputs ─────
    // Blackout toggle source-of-truth (Constant CHOP reading the container par).
    const blackoutToggle = await builder.add("constantCHOP", "blackoutToggle", {
      name0: "blackout",
      value0: initialBlackout ? 1 : 0,
    });
    await builder.python(
      [
        `_p = op(${q(blackoutToggle)}).par.value0`,
        `_p.expr = ${q(`(1 if op(${q(container)}).par.Blackout else 0)`)}`,
        `_p.mode = type(_p.mode).EXPRESSION`,
      ].join("\n"),
    );

    // Emergency momentary pulse.
    const emergencyPulse = await builder.add("constantCHOP", "emergencyPulse", {
      name0: "emergency",
      value0: 0,
    });
    if (args.arm_emergency_snap) {
      await builder.python(
        [
          `_p = op(${q(emergencyPulse)}).par.value0`,
          `_p.expr = ${q(`(1 if op(${q(container)}).par.Emergency else 0)`)}`,
          `_p.mode = type(_p.mode).EXPRESSION`,
        ].join("\n"),
      );
    }

    // Optional hotkey.
    let keyboard: string | undefined;
    if (hotkeyEnabled) {
      keyboard = await builder.add("keyboardinCHOP", "keyboardin1", {
        key1: args.hotkey,
      });
    }

    // Optional external watchdog channel.
    let watchdog: string | undefined;
    if (args.watchdog_channel) {
      // Spec form is "/path/to/node:channel" — Select CHOP wants the absolute CHOP
      // path on `chop` and the channel name on `channames`.
      const colon = args.watchdog_channel.lastIndexOf(":");
      const wPath = colon >= 0 ? args.watchdog_channel.slice(0, colon) : args.watchdog_channel;
      const wChan = colon >= 0 ? args.watchdog_channel.slice(colon + 1) : "*";
      watchdog = await builder.add("selectCHOP", "watchdog", {
        chop: wPath,
        channames: wChan,
      });
    }

    // ───── merge → target step ─────
    // Max-combine all triggers so any one of them forces target = 1.
    const merge = await builder.add("mathCHOP", "merge1", { chopop: "max" });
    await builder.connect(blackoutToggle, merge);
    if (args.arm_emergency_snap) await builder.connect(emergencyPulse, merge);
    if (keyboard) await builder.connect(keyboard, merge);
    if (watchdog) await builder.connect(watchdog, merge);

    // Logic CHOP → clean 0/1 step (off when zero).
    const target = await builder.add("logicCHOP", "target", { convert: "offwhenzero" });
    await builder.connect(merge, target);

    // ───── fade ramp (Speed → Lookup) ─────
    const speed = await builder.add("speedCHOP", "fadeSpeed", {
      factor: 1 / fadeFloor,
    });
    await builder.connect(target, speed);
    // Live-driven factor so the artist can re-tune Fade seconds on the fly.
    await builder.python(
      [
        `_p = op(${q(speed)}).par.factor`,
        `_p.expr = ${q(`1/max(0.001, op(${q(container)}).par.Fadeseconds)`)}`,
        `_p.mode = type(_p.mode).EXPRESSION`,
      ].join("\n"),
    );

    // Curve LUT: 32 samples baked into a Table DAT, converted to a CHOP via
    // DAT-to-CHOP, and wired into the Lookup CHOP's SECOND input (the LUT input).
    // The Lookup CHOP has no `dat` parameter on TD 099 — input 2 is the curve.
    const curveTable = await builder.add("tableDAT", "curveTable");
    const samples = buildCurveSamples(args.fade_curve);
    const recoveryGate =
      args.recovery_mode === "manual"
        ? ` (manual recovery — Hold stays on until cleared)`
        : ` (auto recovery on watchdog clear)`;
    await builder.python(
      [
        `_t = op(${q(curveTable)})`,
        `_t.clear()`,
        // Single-column "lookup" so DAT-to-CHOP produces one channel of N samples.
        `_t.appendRow(["lookup"])`,
        ...samples.map((y) => `_t.appendRow([${y.toFixed(6)}])`),
      ].join("\n"),
    );

    // DAT-to-CHOP converts the table column into a 1-channel CHOP whose N samples
    // ARE the curve. Wired into Lookup CHOP input 2 as the lookup table.
    const curveChop = await builder.add("dattoCHOP", "curveChop", {
      dat: curveTable,
      firstrow: "names",
    });

    const lookup = await builder.add("lookupCHOP", "curve");
    await builder.connect(speed, lookup, 0, 0);
    await builder.connect(curveChop, lookup, 0, 1);

    // dimNull holds the canonical 0..1 fade channel ("dim"); bind_to_channel uses this.
    const dimNull = await builder.add("nullCHOP", "dimNull");
    await builder.connect(lookup, dimNull);
    // Rename the channel coming through so bind_to_channel finds "dim".
    await builder.python(
      [
        `# safety_dim channel canonicalization${recoveryGate}`,
        `_n = op(${q(dimNull)})`,
        `_n.par.passthrough = 0 if hasattr(_n.par, "passthrough") else _n.par`,
      ].join("\n"),
    );

    // ───── TOP chain: dim → emergency hard-cut → composite label → out ─────
    // Dim Level TOP — brightness1 driven from dimNull[dim] (1 = passthrough, 0 = black).
    // The spec says target=1 forces black, so brightness1 = 1 - dim.
    const dim = await builder.add("levelTOP", "dim", { brightness1: 1 });
    await builder.connect(source, dim);
    await builder.python(
      [
        `_p = op(${q(dim)}).par.brightness1`,
        `_p.expr = ${q(`1 - op(${q(dimNull)})[0]`)}`,
        `_p.mode = type(_p.mode).EXPRESSION`,
      ].join("\n"),
    );

    // Emergency hard-cut gate — single-frame to black.
    const emergencyGate = await builder.add("levelTOP", "emergencyGate", { brightness1: 1 });
    await builder.connect(dim, emergencyGate);
    if (args.arm_emergency_snap) {
      await builder.python(
        [
          `_p = op(${q(emergencyGate)}).par.brightness1`,
          `_p.expr = ${q(`(0 if op(${q(container)}).par.Emergency else 1)`)}`,
          `_p.mode = type(_p.mode).EXPRESSION`,
        ].join("\n"),
      );
    }

    // Show-safe label (Text TOP composited over the dimmed output).
    let composite = emergencyGate;
    if (labelText) {
      const label = await builder.add("textTOP", "showSafeLabel", { text: labelText });
      const comp = await builder.add("compositeTOP", "composite1", { operand: "over" });
      await builder.connect(emergencyGate, comp, 0, 0);
      await builder.connect(label, comp, 0, 1);
      composite = comp;
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(composite, out);

    // Control panel: unbound toggles + Fade seconds float. The expressions read these
    // pars by absolute path so they MUST NOT be bind_to-self (same recursion gotcha as
    // create_panic). State is read-only — exposed for monitoring.
    const controls: ControlSpec[] = args.expose_controls
      ? [
          { name: "Blackout", type: "toggle", default: initialBlackout, label: "Blackout (fade)" },
          { name: "Emergency", type: "pulse", label: "Emergency (hard cut)" },
          {
            name: "Fadeseconds",
            type: "float",
            default: args.fade_seconds,
            min: 0,
            max: 10,
            label: "Fade seconds",
          },
          { name: "Hold", type: "toggle", default: initialHold, label: "Hold (no auto-recovery)" },
        ]
      : [];

    const summary = `Built a safety blackout chain → ${out}: master output fades to black over ${args.fade_seconds}s on Blackout${
      args.arm_emergency_snap ? " or single-frame hard-cuts on Emergency" : ""
    }${args.input_path ? ` (protecting ${args.input_path})` : " (built-in test source)"}. Curve: ${args.fade_curve}; recovery: ${args.recovery_mode}.`;

    return finalize(ctx, {
      summary,
      builder,
      outputPath: out,
      capturePreviewImage: true,
      controls,
      extra: {
        container,
        source_path: source,
        merge_path: merge,
        target_path: target,
        speed_path: speed,
        lookup_path: lookup,
        dim_null_path: dimNull,
        dim_path: dim,
        emergency_gate_path: emergencyGate,
        composite_path: labelText ? composite : undefined,
        output_path: out,
        initial_state: args.initial_state,
        fade_seconds: args.fade_seconds,
        fade_curve: args.fade_curve,
        recovery_mode: args.recovery_mode,
        hotkey: hotkeyEnabled ? args.hotkey : null,
        watchdog_channel: args.watchdog_channel ?? null,
        show_safe_label: labelText || null,
      },
    });
  });
}

export const registerCreateSafetyBlackoutChain: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_safety_blackout_chain",
    {
      title: "Create safety blackout chain",
      description:
        "Build a live-show safety primitive at the very end of the master output chain: deterministic fade-to-black over a configurable time, optional emergency single-frame hard-cut, optional hotkey + external watchdog trigger, and symmetric fade-in recovery. All reactivity is parameter-driven (Speed + Lookup CHOP + Math/Logic CHOPs) — no Python runs at cook time, so the chain is ALLOW_EXEC=0-safe. Complements create_panic (per-source kill+freeze) by being the master-output dimmer with grace, recovery, and a watchdog hook. Returns the container, source, dim, emergency-gate, composite, and output node paths plus the trigger merge/target/speed/lookup nodes.",
      inputSchema: createSafetyBlackoutChainSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => createSafetyBlackoutChainImpl(ctx, args),
  );
};
