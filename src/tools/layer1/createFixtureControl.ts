import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// A moving-head "fixture" for the 3D previz rig. Each maps to one movingHead8 DMX
// slot block (pan, tilt, dimmer, r, g, b, strobe, gobo) starting at `startChannel`.
const FixtureSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Fixture id must be a valid TD-style name")
    .describe(
      "Constant-CHOP name + channel prefix + previz Geometry name. Must be a valid TD name.",
    ),
  startChannel: z.coerce
    .number()
    .int()
    .min(1)
    .max(505)
    .describe("1-based DMX slot of this fixture's pan channel (movingHead8 uses 8 slots)."),
  x: z.coerce
    .number()
    .default(0)
    .describe("World X position of the fixture head in the 3D previz rig (metres)."),
  y: z.coerce
    .number()
    .default(3)
    .describe("World Y position (rig height) of the fixture head in the previz rig (metres)."),
  z: z.coerce
    .number()
    .default(0)
    .describe("World Z position of the fixture head in the 3D previz rig (metres)."),
});

export const createFixtureControlSchema = z.object({
  name: z.string().default("fixture_rig").describe("Base name for the container COMP."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP to create the fixture rig container in (default '/project1')."),
  host: z
    .string()
    .nullable()
    .default(null)
    .describe("Target IP for Art-Net / sACN (dmxoutCHOP `netaddress`). Null = leave default."),
  universe: z.coerce
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("DMX universe written to the dmxoutCHOP."),
  net: z
    .enum(["artnet", "sacn"])
    .default("artnet")
    .describe("Network protocol — written to the dmxoutCHOP `interface` par."),
  fps: z.coerce
    .number()
    .min(1)
    .max(60)
    .default(40)
    .describe("DMX refresh rate (dmxoutCHOP `rate`)."),
  pan_range: z.coerce
    .number()
    .min(1)
    .max(720)
    .default(540)
    .describe(
      "Physical pan sweep in degrees the fixture spans across DMX 0-255 (previz rotation).",
    ),
  tilt_range: z.coerce
    .number()
    .min(1)
    .max(360)
    .default(270)
    .describe(
      "Physical tilt sweep in degrees the fixture spans across DMX 0-255 (previz rotation).",
    ),
  beam_length: z.coerce
    .number()
    .min(0.1)
    .max(100)
    .default(8)
    .describe("Length of the previz beam cone from the head (metres)."),
  beam_angle: z.coerce
    .number()
    .min(1)
    .max(90)
    .default(12)
    .describe("Half-angle of the previz beam cone (degrees) — narrow = spot, wide = wash."),
  fixtures: z
    .array(FixtureSchema)
    .min(1, "At least one fixture is required.")
    .describe("Moving-head fixtures. Each becomes a DMX movingHead8 block + a 3D previz head+beam.")
    .superRefine((fixtures, ctx) => {
      const seen = new Set<string>();
      for (const f of fixtures) {
        if (seen.has(f.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate fixture id: ${f.id}` });
        }
        seen.add(f.id);
      }
    }),
});

export type CreateFixtureControlArgs = z.infer<typeof createFixtureControlSchema>;

interface FixtureControlReport {
  container: string;
  fixtures: Array<{
    id: string;
    constant: string;
    geo: string;
    beam: string;
    startChannel: number;
  }>;
  merge: string;
  out: string;
  dmx: string;
  render: string;
  universe: number;
  totalChannels: number;
  controls: Array<{ name: string; target: string }>;
  errors?: string[];
  warnings: string[];
  fatal?: string;
}

// Channel layout for a movingHead8 fixture (matches FIXTURE_PROFILES.movingHead8).
const MH8_CHANNELS = ["pan", "tilt", "dimmer", "r", "g", "b", "strobe", "gobo"] as const;
const MH8_DEFAULTS = [128, 128, 255, 255, 255, 255, 0, 0] as const;

// One Python pass. Fail-forward: a missing par on one fixture must not kill the rig.
// Builds two coupled halves: (1) a DMX-out chain of Constant CHOPs → Merge → Null → DMX Out,
// and (2) a 3D previz — per-fixture Geometry COMP head + a cone beam whose rotation is driven
// by that fixture's pan/tilt CHOP channels, all under one Render TOP with a camera + light.
const FIXTURE_SCRIPT = `
import json, base64, traceback, math
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "", "fixtures": [], "merge": "", "out": "", "dmx": "", "render": "",
    "universe": int(_p.get("universe", 1)), "totalChannels": int(_p.get("totalChannels", 0)),
    "controls": [], "errors": [], "warnings": list(_p.get("warnings", [])),
}

def _try(label, fn):
    try:
        return fn()
    except Exception as _e:
        report["warnings"].append(label + ": " + str(_e))
        return None

# Position a node in the network editor (nodeX/nodeY are attributes, not params) so the
# rig reads on a readable grid instead of every op stacking at the default drop point.
def _place(_op, _x, _y):
    if _op is None:
        return
    try:
        _op.nodeX = _x
        _op.nodeY = _y
    except Exception:
        pass

try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        _cont = _parent.create(baseCOMP, _p["name"])
        report["container"] = _cont.path
        _chans = _p["channels"]
        _defs = _p["defaults"]
        _pan_range = float(_p["pan_range"])
        _tilt_range = float(_p["tilt_range"])
        _beam_len = float(_p["beam_length"])
        _beam_angle = float(_p["beam_angle"])
        _beam_radius = max(0.01, math.tan(math.radians(_beam_angle)) * _beam_len)

        _fixtures = sorted(_p["fixtures"], key=lambda f: int(f["startChannel"]))
        _ordered_inputs = []
        _cursor = 1
        # DMX Constant CHOPs / pads stack in a left column (x=0); previz heads sit in a
        # separate lower band (x=0, y below the DMX column) so the two halves don't overlap.
        _HEAD_Y0 = -900
        for _hi, _f in enumerate(_fixtures):
            _fid = _f["id"]
            _start = int(_f["startChannel"])
            # Pad to keep merged-CHOP index aligned with DMX slot.
            if _start > _cursor:
                _gap = _start - _cursor
                _pad = _try("pad %s" % _fid, lambda: _cont.create(constantCHOP, "pad_%s" % _fid))
                if _pad is not None:
                    _place(_pad, 0, -len(_ordered_inputs) * 160)
                    for _k in range(_gap):
                        _try("pad name", lambda k=_k, n=_pad: setattr(n.par, "name%d" % k, "pad/%d" % k))
                        _try("pad val", lambda k=_k, n=_pad: setattr(n.par, "value%d" % k, 0.0))
                    _ordered_inputs.append(_pad)
            elif _start < _cursor:
                report["warnings"].append("Fixture '%s' overlaps a prior fixture at slot %d." % (_fid, _start))

            # DMX Constant CHOP for this fixture.
            _node = _try("fixture %s" % _fid, lambda fid=_fid: _cont.create(constantCHOP, fid))
            if _node is None:
                continue
            _place(_node, 0, -len(_ordered_inputs) * 160)
            for _k, _cn in enumerate(_chans):
                _def = _defs[_k] if _k < len(_defs) else 0
                _try("%s name%d" % (_fid, _k), lambda k=_k, cn=_cn, fid=_fid, n=_node: setattr(n.par, "name%d" % k, "%s/%s" % (fid, cn)))
                _try("%s val%d" % (_fid, _k), lambda k=_k, v=_def, n=_node: setattr(n.par, "value%d" % k, float(v)))
            _ordered_inputs.append(_node)
            if _start + len(_chans) - 1 > 512:
                report["warnings"].append("Fixture '%s' at %d exceeds universe 512 — split across universes." % (_fid, _start))
            _cursor = max(_cursor, _start + len(_chans))

            # --- 3D previz head: a Geometry COMP with a tube (beam) whose rotation is driven
            #     by the fixture's pan/tilt DMX channels. pan → ry, tilt → rx.
            _geo = _try("geo %s" % _fid, lambda fid=_fid: _cont.create(geometryCOMP, "head_%s" % fid))
            _beam = None
            if _geo is not None:
                _place(_geo, 0, _HEAD_Y0 - _hi * 160)
                _try("geo pos", lambda g=_geo, f=_f: (setattr(g.par, "tx", float(f["x"])), setattr(g.par, "ty", float(f["y"])), setattr(g.par, "tz", float(f["z"]))))
                # Drive pan (ry) and tilt (rx) by expression from the fixture Constant CHOP.
                # DMX 0-255 maps linearly onto +/- half the physical range.
                _pan_expr = "(op(%r)[%r]/255.0 - 0.5) * %f" % (_node.path, "%s/pan" % _fid, _pan_range)
                _tilt_expr = "(op(%r)[%r]/255.0 - 0.5) * %f" % (_node.path, "%s/tilt" % _fid, _tilt_range)
                _try("geo ry expr", lambda g=_geo, e=_pan_expr: (setattr(g.par.ry, "expr", e), setattr(g.par.ry, "mode", type(g.par.ry.mode).EXPRESSION)))
                _try("geo rx expr", lambda g=_geo, e=_tilt_expr: (setattr(g.par.rx, "expr", e), setattr(g.par.rx, "mode", type(g.par.rx.mode).EXPRESSION)))
                # Inner tube SOP as the beam cone (radius grows toward the far end).
                _tube = _try("tube %s" % _fid, lambda g=_geo: g.create(tubeSOP, "beam"))
                if _tube is not None:
                    _try("tube rad1", lambda t=_tube: setattr(t.par, "rad1", 0.05))
                    _try("tube rad2", lambda t=_tube, r=_beam_radius: setattr(t.par, "rad2", r))
                    _try("tube height", lambda t=_tube, h=_beam_len: setattr(t.par, "height", h))
                    _try("tube orient", lambda t=_tube: setattr(t.par, "orient", "z"))
                    _beam = _tube
                report["fixtures"].append({
                    "id": _fid, "constant": _node.path, "geo": _geo.path,
                    "beam": _beam.path if _beam is not None else "", "startChannel": _start,
                })
            else:
                report["fixtures"].append({"id": _fid, "constant": _node.path, "geo": "", "beam": "", "startChannel": _start})

        # --- DMX out chain: left input column -> merge -> rig_out -> dmx (x = 200/400/600) ---
        _merge = _try("merge", lambda: _cont.create(mergeCHOP, "merge"))
        if _merge is not None:
            _place(_merge, 200, 0)
            _try("merge dup", lambda: setattr(_merge.par, "duplicate", "rename"))
            for _i, _n in enumerate(_ordered_inputs):
                _try("merge connect %d" % _i, lambda i=_i, n=_n: _merge.inputConnectors[i].connect(n))
            report["merge"] = _merge.path
        _null = _try("rig_out", lambda: _cont.create(nullCHOP, "rig_out"))
        if _null is not None:
            _place(_null, 400, 0)
            if _merge is not None:
                _try("rig_out connect", lambda: _null.inputConnectors[0].connect(_merge))
                report["out"] = _null.path
        _dmx = _try("dmx", lambda: _cont.create(dmxoutCHOP, "dmx"))
        if _dmx is not None:
            _place(_dmx, 600, 0)
            _try("dmx interface", lambda: setattr(_dmx.par, "interface", _p["interface"]))
            _try("dmx universe", lambda: setattr(_dmx.par, "universe", int(_p["universe"])))
            if _p.get("host"):
                _try("dmx netaddress", lambda: setattr(_dmx.par, "netaddress", _p["host"]))
            _try("dmx rate", lambda: setattr(_dmx.par, "rate", float(_p["fps"])))
            if _null is not None:
                _try("dmx connect", lambda: _dmx.inputConnectors[0].connect(_null))
            report["dmx"] = _dmx.path
            try:
                _e = _dmx.errors()
                if _e:
                    report["errors"].append(str(_e))
            except Exception:
                pass

        # --- 3D previz render: camera + light + render TOP over all heads (lower band) ---
        _cam = _try("cam", lambda: _cont.create(cameraCOMP, "previz_cam"))
        if _cam is not None:
            _place(_cam, 200, _HEAD_Y0)
            _try("cam pos", lambda: (setattr(_cam.par, "tz", 12.0), setattr(_cam.par, "ty", 3.0)))
        _light = _try("light", lambda: _cont.create(lightCOMP, "previz_light"))
        _place(_light, 200, _HEAD_Y0 - 160)
        _render = _try("render", lambda: _cont.create(renderTOP, "previz"))
        if _render is not None:
            _place(_render, 400, _HEAD_Y0)
            _try("render res", lambda: (setattr(_render.par, "resolutionw", 1280), setattr(_render.par, "resolutionh", 720)))
            if _cam is not None:
                _try("render cam", lambda: setattr(_render.par, "camera", _cam.name))
            if _light is not None:
                _try("render light", lambda: setattr(_render.par, "lights", _light.name))
            report["render"] = _render.path

        report["controls"] = [
            {"name": "Universe", "target": (report["dmx"] or "dmx") + ".universe"},
            {"name": "Rate", "target": (report["dmx"] or "dmx") + ".rate"},
        ]
        _last = 0
        for _f in _fixtures:
            _last = max(_last, int(_f["startChannel"]) + len(_chans) - 1)
        report["totalChannels"] = _last
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildFixtureControlScript(payload: object): string {
  return buildPayloadScript(FIXTURE_SCRIPT, payload);
}

export async function createFixtureControlImpl(ctx: ToolContext, args: CreateFixtureControlArgs) {
  return guardTd(
    async () => {
      const script = buildFixtureControlScript({
        parent_path: args.parent_path,
        name: args.name,
        universe: args.universe,
        interface: args.net,
        host: args.host,
        fps: args.fps,
        pan_range: args.pan_range,
        tilt_range: args.tilt_range,
        beam_length: args.beam_length,
        beam_angle: args.beam_angle,
        channels: MH8_CHANNELS,
        defaults: MH8_DEFAULTS,
        totalChannels: 0,
        warnings: [],
        fixtures: args.fixtures.map((f) => ({
          id: f.id,
          startChannel: f.startChannel,
          x: f.x,
          y: f.y,
          z: f.z,
        })),
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<FixtureControlReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Fixture control rig build failed: ${report.fatal}`, report);
      }
      const count = report.fixtures.length;
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const errNote =
        report.errors && report.errors.length > 0
          ? `, ${report.errors.length} dmxout warning(s)`
          : "";
      const summary = `Built a moving-head fixture rig with 3D previz (${count} fixture(s), universe ${report.universe}, ${args.net}) → DMX ${report.dmx || "dmx"} + previz ${report.render || "previz"}${warnNote}${errNote}. Drive each head by binding to op('${report.out}')['<id>/pan'] etc.; the previz heads' pan/tilt rotate from those same channels.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateFixtureControl: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_fixture_control",
    {
      title: "Create moving-head fixture control + 3D previz",
      description:
        "Build a moving-head lighting rig with BOTH a DMX/Art-Net output chain AND a 3D visual previsualization. For each fixture: a Constant CHOP holds an 8-channel movingHead8 block (pan, tilt, dimmer, r, g, b, strobe, gobo, prefixed '<id>/…'), padded and merged into a dmxoutCHOP (`interface`, `universe`, `netaddress`, `rate`); and a Geometry COMP 'head' with a tube-cone beam whose pan→ry and tilt→rx rotation is expression-driven straight from that fixture's DMX pan/tilt channels (0-255 mapped across pan_range/tilt_range degrees), all rendered under one camera+light Render TOP. This adds the live 3D preview on top of what create_dmx_fixture_pipeline (DMX-out only) does. Bind individual channels later with bind_to_channel / animate_parameter on op('rig_out')['fix1/pan']; the previz updates automatically.",
      inputSchema: createFixtureControlSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createFixtureControlImpl(ctx, args),
  );
};
