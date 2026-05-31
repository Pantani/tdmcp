import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createTransientReactiveSchema = z.object({
  name: z
    .string()
    .regex(
      /^[A-Za-z][A-Za-z0-9_]*$/,
      "name must start with a letter and be alphanumeric/underscore",
    )
    .describe("Container COMP name (required)."),
  parent: z.string().default("/").describe("Parent path of the container COMP (must exist)."),
  audioSource: z
    .string()
    .default("")
    .describe(
      "Optional CHOP path or shared audioBus Null CHOP path. When empty, an internal audioDeviceIn CHOP is used.",
    ),
  fastAttackMs: z
    .number()
    .min(0.1)
    .max(50)
    .default(1)
    .describe("Fast envelope attack in ms — captures clicks/onsets."),
  fastReleaseMs: z.number().min(1).max(200).default(20).describe("Fast envelope release in ms."),
  slowAttackMs: z
    .number()
    .min(1)
    .max(500)
    .default(50)
    .describe("Slow envelope attack in ms — tonal floor."),
  slowReleaseMs: z.number().min(10).max(2000).default(200).describe("Slow envelope release in ms."),
  sensitivity: z
    .number()
    .min(0)
    .max(4)
    .default(1.0)
    .describe("Gain applied to transient before clamp to 0..1."),
});
export type CreateTransientReactiveArgs = z.infer<typeof createTransientReactiveSchema>;

interface TransientReactiveReport {
  compPath: string;
  outPath: string;
  channels: string[];
  warnings: string[];
  fatal?: string;
}

// Layer-1 transient/sustain splitter:
//   audioin (or `in1` Select CHOP pointing at audioSource)
//     ├──▶ rms_fast (analyzeCHOP RMS) ──▶ env_fast (filterCHOP, tcompup/tcompdown = fast attack/release in sec)
//     ├──▶ rms_slow (analyzeCHOP RMS) ──▶ env_slow (filterCHOP, tcompup/tcompdown = slow attack/release in sec)
//     └──▶ script (scriptCHOP, inputs[0]=env_fast, inputs[1]=env_slow)
//             transient = clamp((fast - slow) * Sensitivity, 0, 1)
//             sustain   = clamp(slow, 0, 1)
//             outputs channels ['transient', 'sustain']
//             ▼
//          out (nullCHOP, cookType=Selective)
// Custom pars on the parent COMP: Sensitivity, Fastattack, Fastrelease, Slowattack, Slowrelease.
const SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"compPath": "", "outPath": "", "channels": ["transient", "sustain"], "warnings": []}
try:
    _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
    else:
        try:
            _comp = _parent.create(baseCOMP, _p["name"])
        except Exception as _e:
            report["fatal"] = "Could not create container: " + str(_e)
            _comp = None
        if _comp is not None:
            report["compPath"] = _comp.path

            # --- Audio source: internal audioDeviceIn or Select referencing audioSource ---
            _src = None
            _audio_source = _p.get("audioSource", "") or ""
            if _audio_source:
                try:
                    _src = _comp.create(selectCHOP, "in1")
                    try:
                        _src.par.chop = _audio_source
                    except Exception as _e:
                        report["warnings"].append("selectCHOP.par.chop failed: " + str(_e))
                except Exception as _e:
                    report["warnings"].append("selectCHOP create failed: " + str(_e))
            else:
                try:
                    _src = _comp.create(audiodeviceinCHOP, "audioin")
                except Exception as _e:
                    report["warnings"].append("audiodeviceinCHOP create failed: " + str(_e))

            # --- env_fast / env_slow envelope followers ---
            # analyzeCHOP (RMS) → filterCHOP (tcompup=attack/sec, tcompdown=release/sec).
            # filterCHOP (lag) gives independent attack/release; the legacy envelope op has no such pars in TD 099.
            _env_fast = None
            try:
                _rms_fast = _comp.create(analyzeCHOP, "rms_fast")
                try:
                    _rms_fast.par.function = "rms"
                except Exception as _e:
                    report["warnings"].append("rms_fast function failed: " + str(_e))
                if _src is not None:
                    try:
                        _rms_fast.inputConnectors[0].connect(_src)
                    except Exception as _e:
                        report["warnings"].append("rms_fast wire failed: " + str(_e))
                _env_fast = _comp.create(filterCHOP, "env_fast")
                try:
                    _env_fast.par.filter = "lag"
                except Exception as _e:
                    report["warnings"].append("env_fast filter failed: " + str(_e))
                try:
                    _env_fast.inputConnectors[0].connect(_rms_fast)
                except Exception as _e:
                    report["warnings"].append("env_fast wire failed: " + str(_e))
                for _pn, _v in (
                    ("tcompup", float(_p["fastAttackMs"]) / 1000.0),
                    ("tcompdown", float(_p["fastReleaseMs"]) / 1000.0),
                ):
                    try:
                        setattr(_env_fast.par, _pn, _v)
                    except Exception as _e:
                        report["warnings"].append("env_fast.par.%s failed: %s" % (_pn, _e))
            except Exception as _e:
                report["warnings"].append("env_fast chain create failed: " + str(_e))

            _env_slow = None
            try:
                _rms_slow = _comp.create(analyzeCHOP, "rms_slow")
                try:
                    _rms_slow.par.function = "rms"
                except Exception as _e:
                    report["warnings"].append("rms_slow function failed: " + str(_e))
                if _src is not None:
                    try:
                        _rms_slow.inputConnectors[0].connect(_src)
                    except Exception as _e:
                        report["warnings"].append("rms_slow wire failed: " + str(_e))
                _env_slow = _comp.create(filterCHOP, "env_slow")
                try:
                    _env_slow.par.filter = "lag"
                except Exception as _e:
                    report["warnings"].append("env_slow filter failed: " + str(_e))
                try:
                    _env_slow.inputConnectors[0].connect(_rms_slow)
                except Exception as _e:
                    report["warnings"].append("env_slow wire failed: " + str(_e))
                for _pn, _v in (
                    ("tcompup", float(_p["slowAttackMs"]) / 1000.0),
                    ("tcompdown", float(_p["slowReleaseMs"]) / 1000.0),
                ):
                    try:
                        setattr(_env_slow.par, _pn, _v)
                    except Exception as _e:
                        report["warnings"].append("env_slow.par.%s failed: %s" % (_pn, _e))
            except Exception as _e:
                report["warnings"].append("env_slow chain create failed: " + str(_e))

            # --- script_callbacks textDAT + scriptCHOP ---
            _cb = None
            try:
                _cb = _comp.create(textDAT, "script_callbacks")
            except Exception as _e:
                report["warnings"].append("textDAT create failed: " + str(_e))

            _script = None
            try:
                _script = _comp.create(scriptCHOP, "script")
                if _cb is not None:
                    try:
                        _script.par.callbacks = _cb.path
                    except Exception:
                        try:
                            _script.par.dat = _cb.path
                        except Exception as _e:
                            report["warnings"].append("scriptCHOP callbacks param not found: " + str(_e))
                if _env_fast is not None:
                    try:
                        _script.inputConnectors[0].connect(_env_fast)
                    except Exception as _e:
                        report["warnings"].append("script in0 wire failed: " + str(_e))
                if _env_slow is not None:
                    try:
                        _script.inputConnectors[1].connect(_env_slow)
                    except Exception as _e:
                        report["warnings"].append("script in1 wire failed: " + str(_e))
            except Exception as _e:
                report["warnings"].append("scriptCHOP create failed: " + str(_e))

            if _cb is not None:
                _cb_src = (
                    "# Auto-generated by tdmcp create_transient_reactive.\\n"
                    "def onCook(scriptOp):\\n"
                    "    scriptOp.clear()\\n"
                    "    fast = scriptOp.inputs[0] if len(scriptOp.inputs) > 0 else None\\n"
                    "    slow = scriptOp.inputs[1] if len(scriptOp.inputs) > 1 else None\\n"
                    "    try:\\n"
                    "        sens = float(parent().par.Sensitivity.eval())\\n"
                    "    except Exception:\\n"
                    "        sens = 1.0\\n"
                    "    f = fast[0][0] if fast is not None and len(fast.chans()) > 0 else 0.0\\n"
                    "    s = slow[0][0] if slow is not None and len(slow.chans()) > 0 else 0.0\\n"
                    "    transient = max(0.0, min(1.0, (f - s) * sens))\\n"
                    "    sustain = max(0.0, min(1.0, s))\\n"
                    "    t = scriptOp.appendChan('transient')\\n"
                    "    t[0] = transient\\n"
                    "    u = scriptOp.appendChan('sustain')\\n"
                    "    u[0] = sustain\\n"
                    "    return\\n"
                )
                try:
                    _cb.text = _cb_src
                except Exception as _e:
                    report["warnings"].append("textDAT.text set failed: " + str(_e))

            # --- out: nullCHOP, cookType=Selective ---
            _out = None
            try:
                _out = _comp.create(nullCHOP, "out")
                if _script is not None:
                    try:
                        _out.inputConnectors[0].connect(_script)
                    except Exception as _e:
                        report["warnings"].append("out wire failed: " + str(_e))
                try:
                    _out.par.cooktype = "selective"
                except Exception as _e:
                    report["warnings"].append("nullCHOP cooktype set failed: " + str(_e))
                report["outPath"] = _out.path
            except Exception as _e:
                report["warnings"].append("nullCHOP create failed: " + str(_e))

            # --- custom pars on the parent COMP ---
            try:
                _page = _comp.appendCustomPage("Tune")
                _specs = (
                    ("Sensitivity", "Float", _p["sensitivity"], 0, 4),
                    ("Fastattack", "Float", _p["fastAttackMs"], 0.1, 50),
                    ("Fastrelease", "Float", _p["fastReleaseMs"], 1, 200),
                    ("Slowattack", "Float", _p["slowAttackMs"], 1, 500),
                    ("Slowrelease", "Float", _p["slowReleaseMs"], 10, 2000),
                )
                for _nm, _ty, _val, _lo, _hi in _specs:
                    try:
                        _par = _page.appendFloat(_nm)[0]
                        _par.default = _val
                        _par.val = _val
                        try:
                            _par.normMin = _lo
                            _par.normMax = _hi
                        except Exception:
                            pass
                    except Exception as _e:
                        report["warnings"].append("custom par %s failed: %s" % (_nm, _e))
            except Exception as _e:
                report["warnings"].append("appendCustomPage failed: " + str(_e))

            # --- bind filterCHOP tcompup/tcompdown via expression to parent custom pars (ms→sec) ---
            _binds = (
                (_env_fast, "tcompup", "Fastattack"),
                (_env_fast, "tcompdown", "Fastrelease"),
                (_env_slow, "tcompup", "Slowattack"),
                (_env_slow, "tcompdown", "Slowrelease"),
            )
            for _node, _pn, _src_par in _binds:
                if _node is None:
                    continue
                try:
                    _par = getattr(_node.par, _pn, None)
                    if _par is None:
                        continue
                    _par.expr = "parent().par.%s.eval() / 1000.0" % _src_par
                    _PM = type(_par.mode)
                    _par.mode = _PM.EXPRESSION
                except Exception as _e:
                    report["warnings"].append("bind %s.%s failed: %s" % (_pn, _src_par, _e))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildTransientReactiveScript(payload: object): string {
  return buildPayloadScript(SCRIPT, payload);
}

export async function createTransientReactiveImpl(
  ctx: ToolContext,
  args: CreateTransientReactiveArgs,
) {
  return guardTd(
    async () => {
      const script = buildTransientReactiveScript({
        name: args.name,
        parent: args.parent,
        audioSource: args.audioSource,
        fastAttackMs: args.fastAttackMs,
        fastReleaseMs: args.fastReleaseMs,
        slowAttackMs: args.slowAttackMs,
        slowReleaseMs: args.slowReleaseMs,
        sensitivity: args.sensitivity,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<TransientReactiveReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Transient-reactive build failed: ${report.fatal}`, report);
      }
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const summary = `Built transient/sustain splitter at ${report.compPath} → ${report.outPath} (channels: transient, sustain)${warnNote}.`;
      return structuredResult(summary, {
        compPath: report.compPath,
        outPath: report.outPath,
        channels: report.channels,
        warnings: report.warnings,
      });
    },
  );
}

export const registerCreateTransientReactive: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_transient_reactive",
    {
      title: "Create transient/sustain reactive",
      description:
        "Layer-1 audio splitter: differences a fast and a slow envelope follower to expose two normalized 0..1 channels — 'transient' (percussive onsets) and 'sustain' (tonal floor) — on a Null CHOP at {comp}/out. Pair with bind_to_channel to drive visuals from percussion vs sustain independently. Custom-par page 'Tune' on the parent COMP exposes Sensitivity + per-envelope attack/release for live tweaking.",
      inputSchema: createTransientReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createTransientReactiveImpl(ctx, args),
  );
};
