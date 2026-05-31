import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createChromaReactiveSchema = z.object({
  name: z.string().min(1).default("chroma_reactive"),
  parent: z.string().default("/"),
  audioSource: z
    .string()
    .optional()
    .describe(
      "Optional path to an existing CHOP to use as audio input. If omitted, an internal Audio Device In CHOP is created (may prompt for macOS microphone permission).",
    ),
  fftSize: z
    .union([z.literal(1024), z.literal(2048), z.literal(4096)])
    .default(2048)
    .describe("FFT size for the Audio Spectrum CHOP."),
  smoothing: z
    .number()
    .min(0)
    .max(1)
    .default(0.7)
    .describe(
      "Temporal smoothing on chroma vector (0 = raw, 1 = frozen). Maps to Filter CHOP width.",
    ),
});
type CreateChromaReactiveArgs = z.infer<typeof createChromaReactiveSchema>;

interface ChromaReportChild {
  name: string;
  type: string;
  path: string;
}
interface ChromaReport {
  parent_path?: string;
  output_path?: string;
  channels?: string[];
  children?: ChromaReportChild[];
  warnings: string[];
  fatal?: string;
}

const CHROMA_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"warnings": []}
try:
    parent = op(_p["parent"])
    if parent is None:
        report["fatal"] = "Parent not found: " + str(_p["parent"])
    else:
        name = _p["name"]
        existing = parent.op(name)
        if existing is not None:
            existing.destroy()
        comp = parent.create(baseCOMP, name)
        report["parent_path"] = comp.path

        children = []

        audio_source = _p.get("audioSource")
        if not audio_source:
            audioin = comp.create(audiodeviceinCHOP, "audioin")
            children.append({"name": "audioin", "type": "audiodeviceinCHOP", "path": audioin.path})
            audio_source_path = audioin.path
            report["warnings"].append(
                "Audio Device In may prompt for microphone permission on macOS — consider passing audioSource."
            )
        else:
            src = op(audio_source)
            if src is None:
                report["warnings"].append("audioSource not found: " + str(audio_source) + " — wire manually.")
            audio_source_path = audio_source

        spectrum = comp.create(audiospectrumCHOP, "spectrum")
        try:
            spectrum.par.fftsize = _p["fftSize"]
        except Exception as e:
            report["warnings"].append("could not set fftsize: " + str(e))
        children.append({"name": "spectrum", "type": "audiospectrumCHOP", "path": spectrum.path})

        # wire audio_source → spectrum
        try:
            src_op = op(audio_source_path)
            if src_op is not None:
                spectrum.inputConnectors[0].connect(src_op.outputConnectors[0])
        except Exception as e:
            report["warnings"].append("could not wire audio→spectrum: " + str(e))

        analyze = comp.create(mathCHOP, "analyze")
        try:
            analyze.par.gain = 1.0
        except Exception:
            pass
        children.append({"name": "analyze", "type": "mathCHOP", "path": analyze.path})
        try:
            analyze.inputConnectors[0].connect(spectrum.outputConnectors[0])
        except Exception as e:
            report["warnings"].append("could not wire spectrum→analyze: " + str(e))

        script = comp.create(scriptCHOP, "script")
        children.append({"name": "script", "type": "scriptCHOP", "path": script.path})

        # custom par Refpitch (A4 reference)
        try:
            page = script.appendCustomPage("Chroma")
            page.appendFloat("Refpitch", label="Ref Pitch")
            script.par.Refpitch = 440.0
        except Exception as e:
            report["warnings"].append("could not add Refpitch custom par: " + str(e))

        # FFT bin → pitch-class fold body for the Script CHOP DAT
        fold_body = (
            "import math\\n"
            "def onCook(scriptOp):\\n"
            "    scriptOp.clear()\\n"
            "    src = op('../spectrum')\\n"
            "    if src is None or src.numSamples == 0:\\n"
            "        for i in range(12):\\n"
            "            c = scriptOp.appendChan('chroma_' + str(i))\\n"
            "            c[0] = 0.0\\n"
            "        return\\n"
            "    try:\\n"
            "        refpitch = float(scriptOp.par.Refpitch.eval())\\n"
            "    except Exception:\\n"
            "        refpitch = 440.0\\n"
            "    try:\\n"
            "        sr = float(src.par.samplerate.eval())\\n"
            "    except Exception:\\n"
            "        sr = 44100.0\\n"
            "    n_bins = src.numSamples\\n"
            "    fft_size = n_bins * 2\\n"
            "    chroma = [0.0] * 12\\n"
            "    mag_chan = src.chan(0)\\n"
            "    for k in range(n_bins):\\n"
            "        bin_hz = k * sr / fft_size\\n"
            "        if bin_hz < 27.5:\\n"
            "            continue\\n"
            "        midi = 69.0 + 12.0 * math.log2(bin_hz / refpitch)\\n"
            "        pc = int(round(midi)) % 12\\n"
            "        chroma[pc] += float(mag_chan[k])\\n"
            "    total = sum(chroma)\\n"
            "    if total > 1e-9:\\n"
            "        chroma = [v / total for v in chroma]\\n"
            "    for i, v in enumerate(chroma):\\n"
            "        c = scriptOp.appendChan('chroma_' + str(i))\\n"
            "        c[0] = v\\n"
        )
        try:
            cb = script.par.callbacks.eval()
            dat = op(cb) if cb else None
            if dat is None:
                dat = script.parent().create(textDAT, name + "_script_dat")
            dat.text = fold_body
            script.par.callbacks = dat.path
        except Exception as e:
            report["warnings"].append("could not write Script CHOP body: " + str(e))

        try:
            script.inputConnectors[0].connect(analyze.outputConnectors[0])
        except Exception as e:
            report["warnings"].append("could not wire analyze→script: " + str(e))

        filt = comp.create(filterCHOP, "filter")
        try:
            filt.par.type = "gauss"
            filt.par.width = 1.0 + float(_p["smoothing"]) * 30.0
        except Exception as e:
            report["warnings"].append("could not set filter pars: " + str(e))
        children.append({"name": "filter", "type": "filterCHOP", "path": filt.path})
        try:
            filt.inputConnectors[0].connect(script.outputConnectors[0])
        except Exception as e:
            report["warnings"].append("could not wire script→filter: " + str(e))

        out_null = comp.create(nullCHOP, "out")
        children.append({"name": "out", "type": "nullCHOP", "path": out_null.path})
        try:
            out_null.inputConnectors[0].connect(filt.outputConnectors[0])
        except Exception as e:
            report["warnings"].append("could not wire filter→out: " + str(e))

        report["children"] = children
        report["output_path"] = out_null.path
        report["channels"] = ["chroma_" + str(i) for i in range(12)]
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildCreateChromaReactiveScript(payload: object): string {
  return buildPayloadScript(CHROMA_SCRIPT, payload);
}

export async function createChromaReactiveImpl(ctx: ToolContext, args: CreateChromaReactiveArgs) {
  const payload = {
    parent: args.parent,
    name: args.name,
    audioSource: args.audioSource ?? null,
    fftSize: args.fftSize,
    smoothing: args.smoothing,
  };
  const script = buildCreateChromaReactiveScript(payload);
  return guardTd(
    () => ctx.client.executePythonScript(script, true),
    (exec) => {
      const report = parsePythonReport<ChromaReport>(exec.stdout);
      if (report.fatal) {
        return errorResult(`create_chroma_reactive failed: ${report.fatal}`, report);
      }
      const summary = `Built chroma_reactive '${args.name}' → ${report.output_path ?? "(unknown)"} with 12 channels chroma_0..chroma_11 (fftSize=${args.fftSize}, smoothing=${args.smoothing}).`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateChromaReactive: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_chroma_reactive",
    {
      title: "Create Chroma Reactive (experimental)",
      description:
        "[experimental] Builds a 12-channel pitch-class chroma vector (chroma_0..chroma_11) from an audio bus via FFT bin → pitch-class fold. Outputs a Null CHOP ready for bind_to_channel. Shares audioSource convention with create_transient_reactive / create_energy_reactive.",
      inputSchema: createChromaReactiveSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createChromaReactiveImpl(ctx, args),
  );
};
