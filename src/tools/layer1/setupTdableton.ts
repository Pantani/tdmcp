import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const setupTdabletonSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP to host the container (default '/project1')."),
  name: z.string().default("tdableton").describe("Container baseCOMP name."),
  mode: z
    .enum(["auto", "palette", "osc"])
    .default("auto")
    .describe(
      "Bridge mode. 'auto' = probe palette then fall back to OSC. 'palette' = require Palette (warn on miss, still builds OSC fallback). 'osc' = skip palette probe entirely.",
    ),
  host: z.string().default("127.0.0.1").describe("Ableton host IP for the OSC Out CHOP."),
  port_in: z.coerce.number().int().default(9001).describe("UDP port TD listens on (Live → TD)."),
  port_out: z.coerce.number().int().default(9000).describe("UDP port TD sends to (TD → Live)."),
  track_count: z.coerce
    .number()
    .int()
    .min(1)
    .max(32)
    .default(8)
    .describe("Number of /live/track/<i>/volume channels to materialise as bind-ready Nulls."),
  expose_devices: z
    .boolean()
    .default(false)
    .describe(
      "If true, generate /live/track/<i>/device/<j>/parameter/<k> listener rows up to device_param_count.",
    ),
  device_param_count: z.coerce
    .number()
    .int()
    .min(0)
    .max(16)
    .default(0)
    .describe("Per-track device-param count to materialise (used only when expose_devices)."),
  include_master: z
    .boolean()
    .default(true)
    .describe("Add Null CHOPs for /live/master/volume and /live/master/crossfader."),
  include_tempo: z.boolean().default(true).describe("Add Null CHOPs for tempo, beat, and bar."),
});

type SetupTdabletonArgs = z.infer<typeof setupTdabletonSchema>;

// ---------------------------------------------------------------------------
// Report type
// ---------------------------------------------------------------------------

interface TdAbletonReport {
  container: string;
  resolved_mode: "palette" | "osc" | "osc_with_palette_miss";
  palette_resolved: boolean;
  palette_path?: string;
  nulls: {
    tempo?: string;
    master?: string;
    tracks?: string;
    devices?: string;
  };
  port_in: number;
  port_out: number;
  host: string;
  warnings: string[];
  errors?: string[];
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Python payload script
// ---------------------------------------------------------------------------

const TDABLETON_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "resolved_mode": "osc",
    "palette_resolved": False,
    "palette_path": None,
    "nulls": {},
    "port_in": _p["port_in"],
    "port_out": _p["port_out"],
    "host": _p["host"],
    "warnings": [],
    "errors": [],
}

ADDRESS_MAP = """# TDAbleton OSC address → channel name mapping
# Paste into LiveOSC config and verify with oscin_dat
/live/tempo                              → tempo
/live/song/beat                          → beat
/live/song/bar                           → bar
/live/master/volume                      → master_volume
/live/master/crossfader                  → master_crossfader
/live/track/<i>/volume                   → track_<i>_volume  (i = 1..track_count)
/live/track/<i>/device/<j>/parameter/<k>/value → track_<i>_dev_<j>_p_<k>  (when expose_devices)
"""

def _try(label, fn):
    try:
        return fn()
    except Exception as _e:
        report["warnings"].append(label + ": " + str(_e))
        return None

try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        # Reuse existing container (idempotent rebuild)
        _cont_path = _p["parent_path"].rstrip("/") + "/" + _p["name"]
        _existing = op(_cont_path)
        if _existing is not None and hasattr(_existing, "ops"):
            _cont = _existing
        else:
            _cont = _parent.create(baseCOMP, _p["name"])
        report["container"] = _cont.path

        # ── Palette probe ────────────────────────────────────────────────────
        _palette_comp = None
        _mode = _p["mode"]
        if _mode in ("auto", "palette"):
            try:
                _palette_comp = (
                    op("/palette/tdableton")
                    or op("/sys/palette/tdableton")
                )
                if _palette_comp is None:
                    try:
                        import palette as _pal
                        _palette_comp = getattr(_pal, "tdableton", None)
                    except Exception:
                        pass
                if _palette_comp is not None:
                    report["palette_resolved"] = True
                    report["palette_path"] = _palette_comp.path
            except Exception as _pe:
                report["warnings"].append("Palette probe error: " + str(_pe))

        # ── Branch decision ──────────────────────────────────────────────────
        _build_palette = (
            _mode == "auto" and _palette_comp is not None
        ) or (
            _mode == "palette" and _palette_comp is not None
        )

        if _mode == "palette" and _palette_comp is None:
            report["warnings"].append(
                "TDAbleton Palette component not found (probed /palette/tdableton, "
                "/sys/palette/tdableton, palette module). Falling back to OSC."
            )
            report["resolved_mode"] = "osc_with_palette_miss"
            _build_palette = False
        elif _mode == "auto" and _palette_comp is None:
            report["resolved_mode"] = "osc"
        elif _build_palette:
            report["resolved_mode"] = "palette"
        else:
            report["resolved_mode"] = "osc"

        # ── BRANCH A: Palette ────────────────────────────────────────────────
        if _build_palette:
            _tdab = _try("Copy TDAbleton comp", lambda: _cont.copy(_palette_comp, name="tdableton1"))
            _sel_tempo = _try("selectCHOP tempo", lambda: _cont.create(selectCHOP, "select_tempo"))
            _sel_tracks = _try("selectCHOP tracks", lambda: _cont.create(selectCHOP, "select_track_vol"))
            _sel_master = _try("selectCHOP master", lambda: _cont.create(selectCHOP, "select_master"))

            if _sel_tempo is not None and _tdab is not None:
                _try("sel_tempo chop par", lambda: setattr(_sel_tempo.par, "chop", _tdab.path + "/null_tempo") or None)
            if _sel_tracks is not None and _tdab is not None:
                _try("sel_tracks chop par", lambda: setattr(_sel_tracks.par, "chop", _tdab.path + "/null_tracks") or None)
            if _sel_master is not None and _tdab is not None:
                _try("sel_master chop par", lambda: setattr(_sel_master.par, "chop", _tdab.path + "/null_master") or None)

            if _p["include_tempo"]:
                _n_tempo = _try("null_tempo", lambda: _cont.create(nullCHOP, "null_tempo"))
                if _n_tempo is not None and _sel_tempo is not None:
                    _try("null_tempo connect", lambda: _n_tempo.inputConnectors[0].connect(_sel_tempo))
                if _n_tempo is not None:
                    report["nulls"]["tempo"] = _n_tempo.path

            if _p["include_master"]:
                _n_master = _try("null_master", lambda: _cont.create(nullCHOP, "null_master"))
                if _n_master is not None and _sel_master is not None:
                    _try("null_master connect", lambda: _n_master.inputConnectors[0].connect(_sel_master))
                if _n_master is not None:
                    report["nulls"]["master"] = _n_master.path

            _n_tracks = _try("null_tracks", lambda: _cont.create(nullCHOP, "null_tracks"))
            if _n_tracks is not None and _sel_tracks is not None:
                _try("null_tracks connect", lambda: _n_tracks.inputConnectors[0].connect(_sel_tracks))
            if _n_tracks is not None:
                report["nulls"]["tracks"] = _n_tracks.path

        # ── BRANCH B: OSC ────────────────────────────────────────────────────
        else:
            _oscin = _try("oscinCHOP", lambda: _cont.create(oscinCHOP, "oscin1"))
            if _oscin is not None:
                _try("oscin port", lambda: setattr(_oscin.par, "port", _p["port_in"]))
                _try("oscin queued", lambda: setattr(_oscin.par, "queued", 1))
                _try("oscin bundleAddress", lambda: setattr(_oscin.par, "bundleaddress", 1))

            _oscin_dat = _try("oscinDAT", lambda: _cont.create(oscinDAT, "oscin_dat"))
            if _oscin_dat is not None:
                _try("oscin_dat port", lambda: setattr(_oscin_dat.par, "port", _p["port_in"]))

            _oscout = _try("oscoutCHOP", lambda: _cont.create(oscoutCHOP, "oscout1"))
            if _oscout is not None:
                _try("oscout host", lambda: setattr(_oscout.par, "netaddress", _p["host"]))
                _try("oscout port", lambda: setattr(_oscout.par, "port", _p["port_out"]))

            if _p["include_tempo"]:
                _sel_tempo = _try("selectCHOP tempo", lambda: _cont.create(selectCHOP, "select_tempo"))
                if _sel_tempo is not None and _oscin is not None:
                    _try("sel_tempo connect", lambda: _sel_tempo.inputConnectors[0].connect(_oscin))
                    _try("sel_tempo channames", lambda: setattr(_sel_tempo.par, "channames", "tempo bar beat"))
                _n_tempo = _try("null_tempo", lambda: _cont.create(nullCHOP, "null_tempo"))
                if _n_tempo is not None and _sel_tempo is not None:
                    _try("null_tempo connect", lambda: _n_tempo.inputConnectors[0].connect(_sel_tempo))
                if _n_tempo is not None:
                    report["nulls"]["tempo"] = _n_tempo.path

            if _p["include_master"]:
                _sel_master = _try("selectCHOP master", lambda: _cont.create(selectCHOP, "select_master"))
                if _sel_master is not None and _oscin is not None:
                    _try("sel_master connect", lambda: _sel_master.inputConnectors[0].connect(_oscin))
                    _try("sel_master channames", lambda: setattr(_sel_master.par, "channames", "master_volume master_crossfader"))
                _n_master = _try("null_master", lambda: _cont.create(nullCHOP, "null_master"))
                if _n_master is not None and _sel_master is not None:
                    _try("null_master connect", lambda: _n_master.inputConnectors[0].connect(_sel_master))
                if _n_master is not None:
                    report["nulls"]["master"] = _n_master.path

            _sel_tracks = _try("selectCHOP tracks", lambda: _cont.create(selectCHOP, "select_tracks"))
            if _sel_tracks is not None and _oscin is not None:
                _try("sel_tracks connect", lambda: _sel_tracks.inputConnectors[0].connect(_oscin))
                _try("sel_tracks channames", lambda: setattr(_sel_tracks.par, "channames", "track_*_volume"))
            _n_tracks = _try("null_tracks", lambda: _cont.create(nullCHOP, "null_tracks"))
            if _n_tracks is not None and _sel_tracks is not None:
                _try("null_tracks connect", lambda: _n_tracks.inputConnectors[0].connect(_sel_tracks))
            if _n_tracks is not None:
                report["nulls"]["tracks"] = _n_tracks.path

            if _p["expose_devices"]:
                _sel_dev = _try("selectCHOP devices", lambda: _cont.create(selectCHOP, "select_devices"))
                if _sel_dev is not None and _oscin is not None:
                    _try("sel_dev connect", lambda: _sel_dev.inputConnectors[0].connect(_oscin))
                    _try("sel_dev channames", lambda: setattr(_sel_dev.par, "channames", "track_*_dev_*_p_*"))
                _n_dev = _try("null_devices", lambda: _cont.create(nullCHOP, "null_devices"))
                if _n_dev is not None and _sel_dev is not None:
                    _try("null_devices connect", lambda: _n_dev.inputConnectors[0].connect(_sel_dev))
                if _n_dev is not None:
                    report["nulls"]["devices"] = _n_dev.path

            # Address map TEXTDAT
            _amap = _try("address_map DAT", lambda: _cont.create(textDAT, "address_map"))
            if _amap is not None:
                _try("address_map text", lambda: setattr(_amap, "text", ADDRESS_MAP))

        # ── Custom page ──────────────────────────────────────────────────────
        _menu_map = {"auto": 0, "palette": 1, "osc": 2}
        _try("custom page", lambda: _cont.appendCustomPage("TDAbleton"))
        _page = _try("get page", lambda: _cont.customPages[0] if _cont.customPages else None)
        if _page is not None:
            _try("par Mode", lambda: _page.appendMenu("Mode", label="Mode") and setattr(_cont.par, "Mode", _menu_map.get(_p["mode"], 0)))
            _try("par Host", lambda: _page.appendStr("Host", label="Host") and setattr(_cont.par, "Host", _p["host"]))
            _try("par Portin", lambda: _page.appendInt("Portin", label="Port In") and setattr(_cont.par, "Portin", _p["port_in"]))
            _try("par Portout", lambda: _page.appendInt("Portout", label="Port Out") and setattr(_cont.par, "Portout", _p["port_out"]))
            _try("par Trackcount", lambda: _page.appendInt("Trackcount", label="Track Count") and setattr(_cont.par, "Trackcount", _p["track_count"]))

        # Collect node errors
        for _node in _cont.ops():
            for _err in (_node.errors() or [])[:3]:
                report["errors"].append(str(_err))

except Exception as _fatal:
    report["fatal"] = traceback.format_exc(limit=5)

print(json.dumps(report))
`;

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function setupTdabletonImpl(
  ctx: ToolContext,
  args: SetupTdabletonArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  const payload = {
    parent_path: args.parent_path,
    name: args.name,
    mode: args.mode,
    host: args.host,
    port_in: args.port_in,
    port_out: args.port_out,
    track_count: args.track_count,
    expose_devices: args.expose_devices,
    device_param_count: args.device_param_count,
    include_master: args.include_master,
    include_tempo: args.include_tempo,
  };

  const script = buildPayloadScript(TDABLETON_SCRIPT, payload);

  return guardTd(
    () => ctx.client.executePythonScript(script),
    ({ stdout }) => {
      const report = parsePythonReport<TdAbletonReport>(stdout);

      if (report.fatal) {
        return errorResult(`setup_tdableton failed: ${report.fatal}`, report);
      }

      const warnCount = report.warnings.length;
      const nullBindings = [
        report.nulls.tempo ? "null_tempo/tempo" : null,
        report.nulls.master ? "null_master/master_volume" : null,
        report.nulls.tracks ? `null_tracks/track_1_volume` : null,
        report.nulls.devices ? "null_devices/track_1_dev_1_p_1" : null,
      ]
        .filter(Boolean)
        .join(", ");

      const devNote = args.expose_devices ? `, ${args.device_param_count} device params/track` : "";
      const summary =
        `TDAbleton ready at ${report.container} ` +
        `(mode=${report.resolved_mode}, ${args.track_count} tracks${devNote}, ` +
        `${warnCount} warning${warnCount !== 1 ? "s" : ""}). ` +
        `Bind with ${nullBindings}.`;

      return jsonResult(summary, report);
    },
  );
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerSetupTdableton: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "setup_tdableton",
    {
      title: "Setup TDAbleton Bridge",
      description:
        "Wire up an Ableton Live bridge inside a tdmcp-managed container. Auto mode probes " +
        "for the official TDAbleton Palette COMP; if found, clones it and surfaces tempo/beat/track/device " +
        "channels as binding-ready Null CHOPs. Falls back to a full OSC fabric (oscinCHOP + selectCHOP fan-out) " +
        "if the Palette isn't available. Either branch exposes the same Null CHOP names at the container boundary " +
        "so downstream bind_to_channel calls work regardless of which path was taken.",
      inputSchema: setupTdabletonSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => setupTdabletonImpl(ctx, args),
  );
