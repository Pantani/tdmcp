import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

export const createMediaBinSchema = z.object({
  name: z.string().default("media_bin").describe("Name for the bin COMP."),
  parent_path: z.string().default("/project1").describe("Where to build it."),
  folder: z.string().describe("Folder on the TD machine to scan for clips/stills."),
  extensions: z
    .array(z.string())
    .default(["mov", "mp4", "png", "jpg", "jpeg", "tif", "exr"])
    .describe("File extensions to include (lower-case, no dot)."),
  max_clips: z
    .number()
    .int()
    .min(1)
    .max(64)
    .default(16)
    .describe("Cap how many files become Movie File In TOPs."),
  crossfade: z.coerce
    .number()
    .min(0)
    .default(0.5)
    .describe("Crossfade seconds when switching clips (0 = hard cut)."),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([1280, 720])
    .describe("Output resolution [w,h]."),
});
type CreateMediaBinArgs = z.infer<typeof createMediaBinSchema>;

// The folder lives on the *TD* machine (not the MCP server), so the scan has to run inside the
// bridge. One pass: list the folder, keep files whose lower-cased extension is in the allow-list,
// sort for a stable clip order, cap at max_clips. The payload (folder path + extensions) travels
// as base64 so an artist's path with spaces/unicode can never break Python quoting. Fail-forward:
// a missing/unreadable folder reports `fatal` (and we still build an empty, pointable bin).
const SCAN_SCRIPT = `
import os, json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"files": [], "found": 0, "scanned": 0, "warnings": []}
try:
    _folder = _p["folder"]
    _exts = set(str(e).lower().lstrip(".") for e in _p["extensions"])
    _cap = int(_p["max_clips"])
    if not os.path.isdir(_folder):
        report["fatal"] = "Folder not found: " + str(_folder)
    else:
        _names = sorted(os.listdir(_folder))
        report["scanned"] = len(_names)
        _matched = []
        for _n in _names:
            _full = os.path.join(_folder, _n)
            if not os.path.isfile(_full):
                continue
            _ext = os.path.splitext(_n)[1].lower().lstrip(".")
            if _ext in _exts:
                _matched.append(_full)
        report["found"] = len(_matched)
        if len(_matched) > _cap:
            report["warnings"].append(
                "Found " + str(len(_matched)) + " files; capped to first " + str(_cap) + "."
            )
        report["files"] = _matched[:_cap]
        if not _matched:
            report["warnings"].append("No files matched the extensions in " + str(_folder) + ".")
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

interface ScanReport {
  files: string[];
  found: number;
  scanned: number;
  warnings: string[];
  fatal?: string;
}

// Parameter Execute DAT, deployed on the bin COMP. It turns the Index/Next/Prev/Crossfade custom
// knobs into a smooth ramp of the Switch TOP's *float* index: a fractional Switch index blends the
// two adjacent inputs (verified in the operator KB: `switch.par.index = 0.5`), so animating the
// index from one integer to the next IS the crossfade. Next/Prev step the target with wrap; a
// 0-second crossfade snaps (hard cut). The DAT imports td and runs in TD's normal op context, so
// `op`, `absTime`, and `me` resolve there (never in the MCP server). Index/Next/Prev/Crossfade par
// names are the custom controls exposed by finalize; the Switch index par is `index`.
const ENGINE = (switchName: string, clipCount: number): string => `import td

SWITCH = ${q(switchName)}
COUNT = ${clipCount}

def _switch():
    ap = me.parent()
    return ap.op(SWITCH)

def _target(ap):
    try:
        return int(round(float(ap.par.Index.eval()))) % COUNT
    except Exception:
        return 0

def _start_ramp(ap, target):
    sw = _switch()
    if sw is None or COUNT <= 1:
        return
    try:
        cur = float(sw.par.index)
    except Exception:
        cur = 0.0
    xf = 0.0
    try:
        xf = max(0.0, float(ap.par.Crossfade.eval()))
    except Exception:
        xf = 0.0
    ap.store('tdmcp_bin', {'from': cur, 'to': float(target), 'start': absTime.seconds, 'dur': xf})
    if xf <= 0.0:
        sw.par.index = float(target)
        ap.store('tdmcp_bin', None)

def onValueChange(par, prev):
    if par.name == 'Index':
        ap = par.owner
        _start_ramp(ap, _target(ap))
    return

def onPulse(par):
    ap = par.owner
    if par.name not in ('Next', 'Prev'):
        return
    step = 1 if par.name == 'Next' else -1
    nxt = (_target(ap) + step) % COUNT
    ap.par.Index = nxt
    _start_ramp(ap, nxt)
    return
`;

// CHOP Execute style is overkill for the ramp; a tiny Execute DAT advancing once per frame keeps the
// blend smooth without a CHOP network. It reads the stored ramp and interpolates the Switch's float
// index toward the target over the crossfade window, then clears the ramp when done.
const RAMP = (switchName: string): string => `import td

SWITCH = ${q(switchName)}

def onFrameStart(frame):
    ap = me.parent()
    state = ap.fetch('tdmcp_bin', None)
    if not state:
        return
    sw = ap.op(SWITCH)
    if sw is None:
        ap.store('tdmcp_bin', None)
        return
    dur = float(state.get('dur', 0.0) or 0.0)
    if dur <= 0.0:
        sw.par.index = float(state['to'])
        ap.store('tdmcp_bin', None)
        return
    t = (absTime.seconds - float(state['start'])) / dur
    if t >= 1.0:
        sw.par.index = float(state['to'])
        ap.store('tdmcp_bin', None)
        return
    a = float(state['from'])
    b = float(state['to'])
    sw.par.index = a + (b - a) * t
    return
`;

export async function createMediaBinImpl(ctx: ToolContext, args: CreateMediaBinArgs) {
  return runBuild(async () => {
    // Scan the folder inside TD first so we know how many clips to instantiate. Fail-forward: a
    // missing/unreadable folder is recorded as a warning and we still build an empty, pointable bin
    // (mirrors create_video_player's empty-player behaviour) — never throw.
    const scanWarnings: string[] = [];
    let files: string[] = [];
    let scanFound = 0;
    let scanScanned = 0;
    let scanFatal: string | undefined;
    try {
      const exec = await ctx.client.executePythonScript(
        buildPayloadScript(SCAN_SCRIPT, {
          folder: args.folder,
          extensions: args.extensions,
          max_clips: args.max_clips,
        }),
        true,
      );
      const report = parsePythonReport<ScanReport>(exec.stdout);
      files = report.files ?? [];
      scanFound = report.found ?? files.length;
      scanScanned = report.scanned ?? 0;
      scanWarnings.push(...(report.warnings ?? []));
      if (report.fatal) scanFatal = report.fatal;
    } catch (err) {
      scanFatal = friendlyTdError(err);
    }
    if (scanFatal) {
      scanWarnings.push(`Folder scan: ${scanFatal} — built an empty bin you can point at files.`);
    }

    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    // finalize merges builder.warnings into the result, so fold the folder-scan warnings in here.
    builder.warnings.push(...scanWarnings);

    // One Movie File In TOP per file (file/play set, uniform output resolution). When the folder was
    // empty/unreadable, ship one empty clip slot the artist can point at a file — the bin still
    // works (matches create_video_player). Resolution lives on the Switch (clips vary in native
    // size); the moviefileins just play.
    const resPars = {
      outputresolution: "custom",
      resolutionw: args.resolution[0],
      resolutionh: args.resolution[1],
    };
    const clips: string[] = [];
    if (files.length === 0) {
      clips.push(await builder.add("moviefileinTOP", "clip1", { play: 1 }));
    } else {
      for (const [i, file] of files.entries()) {
        clips.push(await builder.add("moviefileinTOP", `clip${i + 1}`, { file, play: 1 }));
      }
    }

    // With 2+ clips, a Switch TOP selects/blends them: a *fractional* index blends adjacent inputs,
    // so the crossfade-on-switch is driven by ramping this index (see ENGINE/RAMP) — no separate
    // Cross TOP. `blend` (Blend between Inputs) is set best-effort: fractional-index blending works
    // without it on current builds, but the par name is UNVERIFIED offline, so a failure can't sink
    // the build. A single (or empty) clip wires straight to the Null (nothing to switch), matching
    // create_video_player.
    const clipCount = clips.length;
    let switchPath: string | undefined;
    let outputSource: string;
    if (clipCount > 1) {
      switchPath = await builder.add("switchTOP", "switch", { index: 0, ...resPars });
      for (const [i, clip] of clips.entries()) await builder.connect(clip, switchPath, 0, i);
      await builder.setParams(switchPath, { blend: 1 });
      outputSource = switchPath;
    } else {
      outputSource = clips[0] as string;
    }

    const out = await builder.add("nullTOP", "out1");
    await builder.connect(outputSource, out);

    const extra: Record<string, unknown> = {
      folder: args.folder,
      files,
      clips,
      output_path: out,
      switch_path: switchPath,
      files_found: scanFound,
      files_scanned: scanScanned,
      max_clips: args.max_clips,
      crossfade: args.crossfade,
      unverified: [
        "Switch TOP `blend` par name + fractional-index crossfade ramp (set best-effort offline).",
        "Next/Prev Parameter-Execute pulse logic (Index is the reliable control; Next/Prev best-effort).",
      ],
    };

    // Only deploy the Index→Switch ramp engine when there's more than one clip to switch between.
    if (clipCount > 1) {
      const engine = await builder.add("parameterexecuteDAT", "engine");
      await builder.python(
        `_e = op(${q(engine)})\n_e.par.op = _e.parent().path\n_e.par.pars = 'Index Next Prev'\n_e.par.custom = True\n_e.par.builtin = False\n_e.par.valuechange = True\n_e.par.onpulse = True\n_e.par.active = True\n_e.text = ${q(ENGINE("switch", clipCount))}`,
      );
      const ramp = await builder.add("executeDAT", "ramp");
      await builder.python(
        `_r = op(${q(ramp)})\ntry:\n    _r.par.framestart = True\n    _r.par.active = True\nexcept Exception:\n    pass\n_r.text = ${q(RAMP("switch"))}`,
      );
      extra.engine = engine;
      extra.ramp = ramp;
    }

    const controls: ControlSpec[] = [
      {
        name: "Index",
        type: "int",
        min: 0,
        max: Math.max(0, clipCount - 1),
        default: 0,
        bind_to: [],
      },
      { name: "Next", type: "pulse", bind_to: [] },
      { name: "Prev", type: "pulse", bind_to: [] },
      { name: "Crossfade", type: "float", min: 0, max: 10, default: args.crossfade, bind_to: [] },
    ];

    const summary =
      files.length === 0
        ? `Built an empty media bin → ${out} (no files found${scanFatal ? "" : ` in ${args.folder}`}; point the Movie File In at a clip or re-run once the folder has media).`
        : `Built a media bin of ${clips.length} clip(s) from ${args.folder} → ${out}. Index/Next/Prev switch clips; Crossfade (${args.crossfade}s) blends the transition.`;

    return finalize(ctx, {
      summary,
      builder,
      outputPath: out,
      controls,
      extra,
    });
  });
}

export const registerCreateMediaBin: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_media_bin",
    {
      title: "Create media bin",
      description:
        "Point at a folder on the TouchDesigner machine and build a clip BIN inside a new bin COMP: it scans the folder (filtered to the given extensions, capped at max_clips), creates one Movie File In TOP per file, feeds them through a Switch TOP, and ends on a Null TOP. Exposes Index (current clip), Next / Prev (pulse, wrapping), and Crossfade (seconds) controls — switching clips crossfades by ramping the Switch's fractional index (0s = hard cut). The folder is read inside TD (not the MCP server). If the folder is empty or missing you get an empty, pointable bin instead of an error. Use create_video_player for a hand-listed playlist; use create_media_bin to ingest a whole folder for clip-based VJing.",
      inputSchema: createMediaBinSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createMediaBinImpl(ctx, args),
  );
};
