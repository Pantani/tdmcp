import { z } from "zod";
import { placeInGridScript } from "../layout.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const keyframeSchema = z.object({
  time: z.coerce.number().min(0).describe("Time of this key, in seconds from the loop start."),
  value: z.coerce.number().describe("Parameter value at this time."),
});

export const createKeyframeAnimationSchema = z.object({
  targets: z
    .array(z.string())
    .min(1)
    .describe("Parameters to animate, each written as 'nodePath.parName'."),
  keyframes: z
    .array(keyframeSchema)
    .min(2)
    .describe("Keyframes (time + value); the curve interpolates between them in order."),
  loop: z
    .boolean()
    .default(true)
    .describe("Loop the animation; otherwise it holds the last value."),
  easing: z
    .enum(["linear", "smooth"])
    .default("smooth")
    .describe("Interpolation between keys: linear, or smooth (eased) for organic motion."),
  parent_path: z
    .string()
    .default("/project1")
    .describe(
      "Parent network where the keyframe-animation container (a baseCOMP) is created (default '/project1').",
    ),
});
type CreateKeyframeAnimationArgs = z.infer<typeof createKeyframeAnimationSchema>;

interface KeyframeReport {
  container?: string;
  hook?: string;
  duration?: number;
  targets?: string[];
  warnings: string[];
  fatal?: string;
}

// Execute DAT body: each frame, interpolate the keyframes at the (optionally looping) current
// time and write the value onto every target parameter. Self-contained — reads its config from
// the container's storage.
const KEYFRAME_HOOK = `import td

def _interp(keys, t, easing):
    if not keys:
        return None
    if t <= keys[0][0]:
        return keys[0][1]
    if t >= keys[-1][0]:
        return keys[-1][1]
    for i in range(len(keys) - 1):
        t0, v0 = keys[i]
        t1, v1 = keys[i + 1]
        if t0 <= t <= t1:
            f = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
            if easing == 'smooth':
                f = f * f * (3.0 - 2.0 * f)
            return v0 + (v1 - v0) * f
    return keys[-1][1]

def onFrameStart(frame):
    comp = me.parent()
    cfg = comp.fetch('tdmcp_keyframes', None)
    if not cfg:
        return
    dur = cfg.get('duration') or 0.0001
    now = td.absTime.seconds
    t = (now % dur) if cfg.get('loop') else min(now, dur)
    val = _interp(cfg.get('keys', []), t, cfg.get('easing', 'smooth'))
    if val is None:
        return
    for tgt in cfg.get('targets', []):
        try:
            dot = tgt.rfind('.')
            n = op(tgt[:dot])
            par = getattr(n.par, tgt[dot + 1:], None) if n is not None else None
            if par is not None and not par.readOnly:
                par.val = val
        except Exception:
            pass
    return
`;

const KEYFRAME_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"warnings": []}
try:
    _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
    else:
        _cont = _parent.create(td.baseCOMP, "keyframe_anim")
        _cont.store("tdmcp_keyframes", {
            "keys": _p["keys"], "targets": _p["targets"],
            "duration": _p["duration"], "loop": _p["loop"], "easing": _p["easing"],
        })
        _hook = _cont.create(td.executeDAT, "anim")
        _hook.text = _p["hook"]
        if hasattr(_hook.par, "framestart"):
            _hook.par.framestart = True
        _hook.par.active = True
        report["container"] = _cont.path; report["hook"] = _hook.path
        report["duration"] = _p["duration"]; report["targets"] = _p["targets"]
        # surface any targets that don't resolve, as a warning
        for _t in _p["targets"]:
            _dot = _t.rfind(".")
            _n = op(_t[:_dot]) if _dot > 0 else None
            if _n is None or getattr(_n.par, _t[_dot + 1:], None) is None:
                report["warnings"].append("Target not found: " + _t)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildKeyframeScript(payload: object): string {
  return buildPayloadScript(KEYFRAME_SCRIPT, payload);
}

export async function createKeyframeAnimationImpl(
  ctx: ToolContext,
  args: CreateKeyframeAnimationArgs,
) {
  // Sort keys by time and derive the loop duration from the last key.
  const keys = [...args.keyframes]
    .sort((a, b) => a.time - b.time)
    .map((k) => [k.time, k.value] as [number, number]);
  const duration = keys[keys.length - 1]?.[0] ?? 1;
  if (duration <= 0) {
    return errorResult(
      "Keyframes must span a positive duration (the last key's time must be > 0).",
    );
  }
  return guardTd(
    async () => {
      const script = buildKeyframeScript({
        parent: args.parent_path,
        keys,
        targets: args.targets,
        duration,
        loop: args.loop,
        easing: args.easing,
        hook: KEYFRAME_HOOK,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      const report = parsePythonReport<KeyframeReport>(exec.stdout);
      // The keyframe container is created at the origin; tile it into the grid (cosmetic).
      if (report.container && !report.fatal) {
        try {
          await ctx.client.executePythonScript(
            placeInGridScript(args.parent_path, report.container),
            false,
          );
        } catch (err) {
          ctx.logger.debug("container placement skipped", { err: String(err) });
        }
      }
      return report;
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not create keyframe animation: ${report.fatal}`, report);
      }
      const summary = `Keyframe animation at ${report.container} drives ${report.targets?.length ?? 0} parameter(s) over a ${report.duration}s ${args.loop ? "loop" : "one-shot"} (${args.easing})${
        report.warnings.length ? `, ${report.warnings.length} warning(s)` : ""
      }.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateKeyframeAnimation: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_keyframe_animation",
    {
      title: "Create keyframe animation",
      description:
        "Animate parameters along a keyframed curve synced to the timeline — structured motion beyond animate_parameter's LFO (use animate_parameter instead for continuous LFO oscillation). Give time/value keyframes and the targets; this creates a baseCOMP 'keyframe_anim' under `parent_path` containing an Execute DAT that interpolates the curve each frame (linear or smooth easing) and writes the value onto every target parameter, looping over the keyframe span (or holding the last value). Use it for choreographed moves (a build-up, a drop, a sweep). Returns a summary plus a JSON block with the container path, the Execute DAT (hook) path, the loop duration, the targets, and warnings (including any targets that did not resolve). Returns a friendly error if the keyframes do not span a positive duration.",
      inputSchema: createKeyframeAnimationSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createKeyframeAnimationImpl(ctx, args),
  );
};
