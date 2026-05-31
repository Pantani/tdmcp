import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createEuclideanSequencerSchema = z.object({
  name: z.string().default("euclidean").describe("Name for the sequencer COMP."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP path to create the sequencer inside."),
  target: z
    .string()
    .describe("COMP whose parameter or cue each active step fires on a beat boundary."),
  steps: z
    .number()
    .int()
    .min(1)
    .max(64)
    .default(16)
    .describe("Number of steps in the Euclidean grid."),
  pulses: z
    .number()
    .int()
    .min(0)
    .max(64)
    .default(4)
    .describe(
      "Number of active pulses distributed evenly across `steps` via Bjorklund's algorithm. Clamped to <= steps at build time.",
    ),
  rotation: z
    .number()
    .int()
    .min(0)
    .max(63)
    .default(0)
    .describe("Cyclic rotation of the generated pattern (downbeat offset)."),
  action: z
    .enum(["param", "cue"])
    .default("param")
    .describe(
      "param: set a target custom-parameter value per active step; cue: recall a named cue per active step (cues stored with manage_cue).",
    ),
  param: z
    .string()
    .optional()
    .describe(
      "(action=param) The custom-parameter name on the target COMP to set on each active step.",
    ),
  on_value: z
    .number()
    .default(1.0)
    .describe("(action=param) Value written into the table cell for active steps."),
  off_value: z
    .number()
    .default(0.0)
    .describe("(action=param) Value written into the table cell for inactive steps."),
  bpm_source: z
    .string()
    .optional()
    .describe(
      "Path to an existing Beat CHOP or tempo source. Omit to create a new Beat CHOP (on the global TD tempo).",
    ),
});
type CreateEuclideanSequencerArgs = z.infer<typeof createEuclideanSequencerSchema>;

interface EuclideanReport {
  comp: string;
  beat: string;
  table: string;
  dispatch: string;
  controls_exec: string;
  controls: string[];
  steps: number;
  pulses: number;
  rotation: number;
  action: string;
  warnings: string[];
  fatal?: string;
}

/**
 * Bjorklund's algorithm — distribute `pulses` evenly across `steps`.
 * Exported so tests can verify the canonical Euclidean patterns directly.
 */
export function bjorklundPattern(pulses: number, steps: number): number[] {
  const n = Math.max(1, Math.floor(steps));
  const p = Math.max(0, Math.min(Math.floor(pulses), n));
  if (p === 0) return new Array(n).fill(0);
  if (p === n) return new Array(n).fill(1);
  const counts: number[] = [];
  const remainders: number[] = [p];
  let divisor = n - p;
  let level = 0;
  while (true) {
    const rem = remainders[level] ?? 0;
    if (rem <= 0) break;
    counts.push(Math.floor(divisor / rem));
    remainders.push(divisor % rem);
    divisor = remainders[level] ?? 0;
    level += 1;
    if ((remainders[level] ?? 0) <= 1) break;
  }
  counts.push(divisor);
  const build = (lvl: number): number[] => {
    if (lvl === -1) return [0];
    if (lvl === -2) return [1];
    const out: number[] = [];
    const c = counts[lvl] ?? 0;
    for (let i = 0; i < c; i += 1) out.push(...build(lvl - 1));
    if ((remainders[lvl] ?? 0) !== 0) out.push(...build(lvl - 2));
    return out;
  };
  const pat: number[] = [];
  const topCount = counts[level] ?? 0;
  for (let i = 0; i < topCount; i += 1) pat.push(...build(level - 1));
  if ((remainders[level] ?? 0) !== 0) pat.push(...build(level - 2));
  const trimmed = pat.slice(0, n);
  // Canonical Euclidean rhythms are presented starting on a pulse — rotate so the
  // first 1 lands at index 0. This matches musical convention (E(3,8)=tresillo
  // starts on the downbeat) and the test expectations in the spec.
  const firstOne = trimmed.indexOf(1);
  if (firstOne <= 0) return trimmed;
  return trimmed.slice(firstOne).concat(trimmed.slice(0, firstOne));
}

export function rotatePattern(pattern: number[], rotation: number): number[] {
  const n = pattern.length;
  if (n === 0) return pattern;
  const r = ((rotation % n) + n) % n;
  if (r === 0) return pattern.slice();
  return pattern.slice(n - r).concat(pattern.slice(0, n - r));
}

// CHOP Execute dispatch — same semantics as create_beat_grid_sequencer; copy-paste
// (not import) so the two sequencers stay behaviourally identical at dispatch time.
const DISPATCH_CALLBACK = `import traceback

def onValueChange(channel, sampleIndex, val, prev):
    if channel.name != 'count':
        return
    seq = me.parent()
    act_par = getattr(seq.par, 'Active', None)
    if act_par is not None and not act_par.eval():
        return
    tbl = seq.op('step_table')
    if tbl is None:
        return
    n_steps = tbl.numCols
    if n_steps < 1:
        return
    step_idx = int(val) % n_steps
    try:
        cell_val = tbl[0, step_idx]
        raw = cell_val.val if hasattr(cell_val, 'val') else str(cell_val)
    except Exception:
        return
    tgt = op('__TARGET__')
    if tgt is None:
        return
    action = '__ACTION__'
    if action == 'param':
        par_name = '__PARAM__'
        if not par_name:
            return
        p = getattr(tgt.par, par_name, None)
        if p is None:
            return
        try:
            p.val = float(raw)
        except Exception:
            try:
                p.val = raw
            except Exception:
                pass
    elif action == 'cue':
        try:
            active_flag = int(float(raw))
        except Exception:
            active_flag = 0
        if not active_flag:
            return
        cues = tgt.fetch('tdmcp_cues', {})
        if not cues:
            return
        cue_names = list(cues.keys())
        cue_name = cue_names[step_idx % len(cue_names)] if cue_names else None
        if cue_name is None:
            return
        cue_vals = cues.get(cue_name, {})
        for k, v in cue_vals.items():
            par = getattr(tgt.par, k, None)
            if par is not None and not par.readOnly:
                try:
                    par.val = v
                except Exception:
                    pass
    return
`;

// Parameter Execute callback — recomputes Bjorklund + rewrites step_table when the
// artist sweeps Pulses or Rotation live. UNVERIFIED: parameterexecuteDAT signature
// not yet probed in our KB family.
const CONTROLS_EXEC_CALLBACK = `def _bjork(pulses, steps):
    pulses = max(0, min(pulses, steps))
    if steps <= 0:
        return []
    if pulses == 0:
        return [0]*steps
    if pulses == steps:
        return [1]*steps
    counts = []
    remainders = [pulses]
    divisor = steps - pulses
    level = 0
    while True:
        rem = remainders[level]
        if rem <= 0:
            break
        counts.append(divisor // rem)
        remainders.append(divisor % rem)
        divisor = remainders[level]
        level += 1
        if remainders[level] <= 1:
            break
    counts.append(divisor)
    def build(lvl):
        if lvl == -1: return [0]
        if lvl == -2: return [1]
        out = []
        for _ in range(counts[lvl]):
            out += build(lvl-1)
        if remainders[lvl] != 0:
            out += build(lvl-2)
        return out
    pat = []
    for _ in range(counts[level]):
        pat += build(level-1)
    if remainders[level] != 0:
        pat += build(level-2)
    pat = pat[:steps]
    # Rotate so the first pulse lands on index 0 (canonical Euclidean form).
    try:
        i = pat.index(1)
    except ValueError:
        return pat
    if i > 0:
        pat = pat[i:] + pat[:i]
    return pat


def _rewrite(seq):
    tbl = seq.op('step_table')
    if tbl is None:
        return
    n = int(seq.par.Steps)
    p = max(0, min(int(seq.par.Pulses), n))
    r = int(seq.par.Rotation) % max(1, n)
    pat = _bjork(p, n)
    if r:
        pat = pat[-r:] + pat[:n-r]
    action = '__ACTION__'
    on_v = __ON_VALUE__
    off_v = __OFF_VALUE__
    try:
        tbl.clear(keepFirstRow=False)
        tbl.setSize(1, n)
        for i, bit in enumerate(pat):
            if action == 'param':
                tbl[0, i] = str(on_v if bit else off_v)
            else:
                tbl[0, i] = '1' if bit else '0'
    except Exception:
        pass


def onValueChange(par, prev):
    if par.name not in ('Pulses', 'Rotation'):
        return
    _rewrite(par.owner)
`;

const EUCLIDEAN_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"comp": _p["parent"], "beat": "", "table": "", "dispatch": "", "controls_exec": "", "controls": [], "steps": _p["steps"], "pulses": _p["pulses"], "rotation": _p["rotation"], "action": _p["action"], "warnings": []}
_parent = op(_p["parent"])
try:
    if _parent is None:
        report["fatal"] = "COMP not found: " + _p["parent"]
    elif not hasattr(_parent, "create"):
        report["fatal"] = _p["parent"] + " is not a COMP, so it cannot hold the Euclidean sequencer."
    else:
        _seq = _parent.op(_p["name"]) or _parent.create(td.containerCOMP, _p["name"])
        try:
            _seq.store("tdmcp_role", "euclidean_sequencer")
        except Exception:
            pass
        report["comp"] = _seq.path

        _n = int(_p["steps"])
        _pulses_req = int(_p["pulses"])
        _pulses = max(0, min(_pulses_req, _n))
        if _pulses != _pulses_req:
            report["warnings"].append(
                "pulses (" + str(_pulses_req) + ") clamped to steps (" + str(_n) + ")."
            )
        _rot = int(_p["rotation"]) % max(1, _n)

        # Beat CHOP: reuse bpm_source if given, otherwise create a fresh one.
        _bpm_src = _p.get("bpm_source")
        if _bpm_src:
            _beat = op(_bpm_src)
            if _beat is None:
                report["warnings"].append("bpm_source not found: " + str(_bpm_src) + "; creating a new Beat CHOP instead.")
                _bpm_src = None
        if not _bpm_src:
            _beat = _seq.op("beat") or _seq.create(td.beatCHOP, "beat")
            for _pn, _v in (("count", 1), ("beat", 1)):
                try:
                    setattr(_beat.par, _pn, _v)
                except Exception:
                    pass
        report["beat"] = _beat.path

        # Use the pattern already computed by the TS impl (passed in payload).
        _pattern = _p["pattern"]
        _tbl = _seq.op("step_table") or _seq.create(td.tableDAT, "step_table")
        try:
            _tbl.clear(keepFirstRow=False)
            _tbl.setSize(1, _n)
            for _ci, _val in enumerate(_pattern):
                _tbl[0, _ci] = str(_val)
        except Exception as e:
            report["warnings"].append("Could not write step table: " + str(e))
        report["table"] = _tbl.path

        # CHOP Execute DAT: deploy the substituted dispatch callback.
        _disp = _seq.op("dispatch") or _seq.create(td.chopexecuteDAT, "dispatch")
        try:
            _disp.par.chop = _beat.path
            _disp.par.channel = "count"
            _disp.par.valuechange = True
            if hasattr(_disp.par, "offtoon"):
                _disp.par.offtoon = False
            _disp.par.active = True
        except Exception:
            report["warnings"].append("Could not fully wire the CHOP Execute dispatch DAT.")
        _disp.text = _p["dispatch_text"]
        report["dispatch"] = _disp.path

        # Parameter Execute DAT: watches Pulses/Rotation custom pars on this COMP and
        # recomputes Bjorklund + rewrites step_table in place. UNVERIFIED — KB lags.
        _cex = _seq.op("controls_exec")
        if _cex is None:
            try:
                _cex = _seq.create(td.parameterexecuteDAT, "controls_exec")
            except Exception:
                _cex = None
                report["warnings"].append(
                    "Could not create parameterexecuteDAT — live Pulses/Rotation sweep is disabled on this TD build."
                )
        if _cex is not None:
            try:
                # Watch this COMP's own custom parameters.
                if hasattr(_cex.par, "op"):
                    _cex.par.op = _seq.path
                _cex.par.active = True
                if hasattr(_cex.par, "valuechange"):
                    _cex.par.valuechange = True
                if hasattr(_cex.par, "custom"):
                    _cex.par.custom = True
                if hasattr(_cex.par, "builtin"):
                    _cex.par.builtin = False
            except Exception:
                report["warnings"].append("Could not fully wire the parameter-execute DAT.")
            _cex.text = _p["controls_exec_text"]
            report["controls_exec"] = _cex.path

        # Custom controls: Active (pause), Steps (informative), Pulses, Rotation.
        _page = None
        for _pg in _seq.customPages:
            if _pg.name == "Euclidean":
                _page = _pg; break
        if _page is None:
            _page = _seq.appendCustomPage("Euclidean")
        if getattr(_seq.par, "Active", None) is None:
            _ap = _page.appendToggle("Active")[0]
            _ap.default = True; _ap.val = True
        report["controls"].append("Active")
        if getattr(_seq.par, "Steps", None) is None:
            _sp = _page.appendInt("Steps")[0]
            _sp.normMin = 1; _sp.normMax = 64
            _sp.default = _n; _sp.val = _n
        else:
            try:
                _seq.par.Steps.val = _n
            except Exception:
                pass
        report["controls"].append("Steps")
        if getattr(_seq.par, "Pulses", None) is None:
            _pp = _page.appendInt("Pulses")[0]
            _pp.normMin = 0; _pp.normMax = _n
            _pp.default = _pulses; _pp.val = _pulses
        else:
            try:
                _seq.par.Pulses.val = _pulses
            except Exception:
                pass
        report["controls"].append("Pulses")
        if getattr(_seq.par, "Rotation", None) is None:
            _rp = _page.appendInt("Rotation")[0]
            _rp.normMin = 0; _rp.normMax = max(0, _n - 1)
            _rp.default = _rot; _rp.val = _rot
        else:
            try:
                _seq.par.Rotation.val = _rot
            except Exception:
                pass
        report["controls"].append("Rotation")

        report["pulses"] = _pulses
        report["rotation"] = _rot
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildEuclideanSequencerScript(payload: object): string {
  return buildPayloadScript(EUCLIDEAN_SCRIPT, payload);
}

export async function createEuclideanSequencerImpl(
  ctx: ToolContext,
  args: CreateEuclideanSequencerArgs,
) {
  if (args.action === "param" && !args.param) {
    return errorResult(
      "A `param` name is required when action is 'param'. Provide the custom-parameter name on the target COMP.",
    );
  }
  return guardTd(
    async () => {
      const dispatchText = DISPATCH_CALLBACK.replaceAll("__TARGET__", args.target)
        .replaceAll("__ACTION__", args.action)
        .replaceAll("__PARAM__", args.param ?? "");
      const controlsExecText = CONTROLS_EXEC_CALLBACK.replaceAll("__ACTION__", args.action)
        .replaceAll("__ON_VALUE__", String(args.on_value))
        .replaceAll("__OFF_VALUE__", String(args.off_value));

      // Compute the pattern in TS so the offline test can also verify it,
      // and so the Python side stays a thin writer.
      const clampedPulses = Math.max(0, Math.min(args.pulses, args.steps));
      const base = bjorklundPattern(clampedPulses, args.steps);
      const rotated = rotatePattern(base, args.rotation);
      const cells =
        args.action === "param"
          ? rotated.map((bit) => (bit ? args.on_value : args.off_value))
          : rotated;

      const script = buildEuclideanSequencerScript({
        name: args.name,
        parent: args.parent_path,
        target: args.target,
        steps: args.steps,
        pulses: args.pulses,
        rotation: args.rotation,
        action: args.action,
        param: args.param ?? "",
        on_value: args.on_value,
        off_value: args.off_value,
        pattern: cells,
        bpm_source: args.bpm_source ?? null,
        dispatch_text: dispatchText,
        controls_exec_text: controlsExecText,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<EuclideanReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build Euclidean sequencer: ${report.fatal}`, report);
      }
      const actionDesc =
        args.action === "param"
          ? `sets '${args.param ?? "?"}' on ${args.target}`
          : `recalls cues on ${args.target}`;
      const summary = `Built Euclidean sequencer ${report.comp}: E(${report.pulses},${report.steps}) rotated by ${report.rotation}, each active step ${actionDesc} on the beat boundary (UNVERIFIED — timing requires live TD). Sweep Pulses/Rotation on the COMP custom page to reshape the pattern live; toggle Active to pause.${
        report.warnings.length ? ` ${report.warnings.length} warning(s).` : ""
      }`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateEuclideanSequencer: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_euclidean_sequencer",
    {
      title: "Create Euclidean sequencer",
      description:
        "Build a Euclidean rhythm sequencer: given `pulses` evenly distributed across `steps` via Bjorklund's algorithm (with optional cyclic `rotation`), it writes the resulting on/off pattern to a Table DAT and fires one dispatch per active step on each beat boundary. The deterministic, mathematically-grounded sibling of create_beat_grid_sequencer — program rhythms by musical intent (e.g. E(3,8) tresillo, E(5,8) cinquillo, E(4,16) four-on-the-floor) rather than by hand-editing cells. Sweep the Pulses/Rotation custom parameters live and the table re-shapes in place. action=param sets a custom parameter to on_value/off_value per step; action=cue recalls a cue per active step (cues stored with manage_cue). NOTE: beat-callback timing is UNVERIFIED offline — check op().time.play if steps don't fire when the TD timeline is paused.",
      inputSchema: createEuclideanSequencerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createEuclideanSequencerImpl(ctx, args),
  );
};
