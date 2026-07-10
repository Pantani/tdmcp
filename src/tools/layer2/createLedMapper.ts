import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const createLedMapperSchema = z.object({
  source: z
    .string()
    .optional()
    .describe(
      "TOP path whose image is mapped to the fixtures. If omitted, a built-in moving Ramp TOP test source is created so the chain cooks with no input.",
    ),
  width: z.coerce
    .number()
    .int()
    .min(1)
    .default(16)
    .describe("Pixels per row (columns). Each texel of the WxH grid drives one LED fixture."),
  height: z.coerce
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("Rows of pixels. 1 = a single LED strip."),
  layout: z
    .enum(["horizontal", "vertical", "serpentine"])
    .default("horizontal")
    .describe(
      "Pixel wiring order along the strip/grid: horizontal (rows left-to-right), vertical (columns), or serpentine (alternate rows reversed — boustrophedon strips).",
    ),
  start_universe: z.coerce
    .number()
    .int()
    .default(1)
    .describe("Art-Net / sACN universe of the first pixel."),
  start_channel: z.coerce
    .number()
    .int()
    .min(1)
    .max(512)
    .default(1)
    .describe("DMX start channel (1-512) of the first pixel within the starting universe."),
  net: z
    .enum(["artnet", "sacn"])
    .default("artnet")
    .describe("Network DMX protocol: Art-Net or sACN (streaming ACN)."),
  net_address: z
    .string()
    .optional()
    .describe("Target IP address for Art-Net / sACN. Defaults to the operator's own default."),
  fps: z.coerce.number().default(30).describe("Output frame rate (DMX Out CHOP sample rate)."),
  parent_path: z.string().default("/project1").describe("COMP to build the pixel-map chain in."),
  name: z.string().optional().describe("Base name for the created nodes."),
});
type CreateLedMapperArgs = z.infer<typeof createLedMapperSchema>;

interface LedMapperReport {
  parent: string;
  nodes: Partial<{
    source: string;
    bright: string;
    grid: string;
    pixels: string;
    pad: string;
    offset: string;
    dmx: string;
    out: string;
  }>;
  source_built: boolean;
  channels: number;
  layout: string;
  universe: number;
  controls: Array<{ name: string; target: string }>;
  errors?: string[];
  warnings: string[];
  fatal?: string;
}

// One Python pass builds the pixel-mapping chain: a source TOP (or a built-in moving Ramp
// test source) -> Level TOP (Brightness gain on color) -> Resolution TOP that crushes the
// image to a tiny WxH grid where one texel = one fixture pixel, sampled with nearest
// filtering so colors are not blurred across pixels -> TOP-to-CHOP that turns the grid into
// per-pixel r/g/b channels (singleset OFF keeps per-color, per-scanline channels) -> DMX Out
// CHOP for Art-Net/sACN -> a Null CHOP tap. Every connect/param is fail-forward: failures
// land in `warnings` so a partial chain still reports useful paths. Brightness + Universe are
// exposed as custom parameters on the parent COMP, bound to the live nodes.
const LED_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"parent": _p["parent"], "nodes": {}, "source_built": False, "channels": _p["channels"], "layout": _p["layout"], "universe": _p["start_universe"], "controls": [], "warnings": []}
try:
    _parent = op(_p["parent"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
    else:
        _base = _p.get("name") or "led_map"
        def _mk(optype, suffix):
            return _parent.create(optype, _base + "_" + suffix)
        def _setpar(node, parname, val):
            if val is None:
                return
            pr = getattr(node.par, parname, None)
            if pr is None:
                report["warnings"].append("No parameter '%s' on %s" % (parname, node.type)); return
            try:
                pr.val = val
            except Exception:
                report["warnings"].append("Could not set parameter '%s' on %s" % (parname, node.type))
        def _conn(a, b):
            try:
                b.inputConnectors[0].connect(a)
            except Exception:
                report["warnings"].append("Could not connect %s -> %s" % (a.path, b.path))

        # Source: an explicit TOP, or a built-in moving Ramp test source.
        _src_path = _p.get("source")
        if _src_path:
            _source = op(_src_path)
            if _source is None:
                report["warnings"].append("Source TOP not found: " + _src_path + " (built a test Ramp instead)")
                _src_path = None
        if not _src_path:
            _source = _mk(rampTOP, "src_test")
            report["source_built"] = True
            _setpar(_source, "type", "horizontal")
        report["nodes"]["source"] = _source.path

        # Brightness gain on color (before the resize so it scales color, not pixel count).
        _bright = _mk(levelTOP, "bright")
        _setpar(_bright, "brightness1", 1.0)
        report["nodes"]["bright"] = _bright.path
        _conn(_source, _bright)

        # Crush to a WxH grid: one texel == one fixture pixel, nearest filtering = no blur.
        _grid = _mk(resolutionTOP, "grid")
        _setpar(_grid, "outputresolution", "custom")
        _setpar(_grid, "resolutionw", _p["width"])
        _setpar(_grid, "resolutionh", _p["height"])
        _setpar(_grid, "filtertype", "nearest")
        report["nodes"]["grid"] = _grid.path
        _conn(_bright, _grid)

        # vertical/serpentine reorder the scanlines before sampling (see probe notes).
        _to_sample = _grid
        _layout = _p["layout"]
        if _layout == "vertical":
            _rot = _mk(transformTOP, "rot")
            _setpar(_rot, "rotate", 90)
            report["nodes"]["rot"] = _rot.path
            _conn(_grid, _rot)
            _to_sample = _rot
        elif _layout == "serpentine":
            report["warnings"].append("Serpentine layout: verify alternate-row reversal against your fixture; v1 ships horizontal scanline order.")

        # Per-pixel sampling: r/g/b channel prefixes on, singleset OFF -> per-color,
        # per-scanline channels (r0 g0 b0 r1 ...). Channel order = DMX slot order.
        _pixels = _mk(toptoCHOP, "pixels")
        _setpar(_pixels, "top", _to_sample.name)
        _setpar(_pixels, "r", "r")
        _setpar(_pixels, "g", "g")
        _setpar(_pixels, "b", "b")
        _setpar(_pixels, "singleset", False)
        report["nodes"]["pixels"] = _pixels.path
        _conn(_to_sample, _pixels)

        # Start channel: the DMX Out CHOP maps its input channels to DMX slots 1..512 in
        # order and has NO start-channel parameter (verified against a live dmxoutCHOP), so
        # to make the first pixel land on slot start_channel we prepend (start_channel - 1)
        # zero "pad" channels via a Constant CHOP merged BEFORE the pixels. Merge keeps input
        # order (pad channels first), shifting every pixel slot down by the offset. With
        # start_channel == 1 there is no offset and the pixels feed the DMX out directly.
        # Fail-forward DMX-universe bounds check: a DMX universe holds 512 channels. If the pixel
        # channels (width×height×3) plus the start-channel offset overflow 512, the extra pixels
        # would silently fall off the end of this single universe — warn and suggest splitting
        # across multiple universes (don't throw; a partial map still cooks for inspection).
        _used = int(_p["channels"]) + (int(_p["start_channel"]) - 1)
        if _used > 512:
            _need = (_used + 511) // 512
            report["warnings"].append(
                "DMX overflow: %d channels (%d pixel + %d start-offset) exceed one 512-channel universe. "
                "Split across ~%d universes (raise start_universe per block) so no pixels are dropped."
                % (_used, int(_p["channels"]), int(_p["start_channel"]) - 1, _need)
            )
        _dmx_input = _pixels
        _pad_n = int(_p["start_channel"]) - 1
        if _pad_n > 0:
            _pad = _mk(constantCHOP, "pad")
            try:
                _pad.par.const.val = _pad_n
                for _i in range(_pad_n):
                    setattr(_pad.par, "const%dname" % _i, "pad%d" % _i)
                    setattr(_pad.par, "const%dvalue" % _i, 0)
            except Exception:
                report["warnings"].append("Could not configure the %d-channel start-channel pad." % _pad_n)
            report["nodes"]["pad"] = _pad.path
            _merge = _mk(mergeCHOP, "offset")
            try:
                _merge.inputConnectors[0].connect(_pad)
                _merge.inputConnectors[1].connect(_pixels)
            except Exception:
                report["warnings"].append("Could not merge the start-channel pad ahead of the pixels.")
            report["nodes"]["offset"] = _merge.path
            _dmx_input = _merge

        # DMX Out CHOP -> Art-Net / sACN. Created without hardware; real send needs a node.
        _dmx = _mk(dmxoutCHOP, "dmx")
        _setpar(_dmx, "interface", _p["net"])
        _setpar(_dmx, "universe", _p["start_universe"])
        _setpar(_dmx, "netaddress", _p.get("net_address"))
        _setpar(_dmx, "rate", _p.get("fps"))
        report["nodes"]["dmx"] = _dmx.path
        _conn(_dmx_input, _dmx)

        # Clean tap for inspection / bind_to_channel.
        _out = _mk(nullCHOP, "out1")
        report["nodes"]["out"] = _out.path
        _conn(_dmx, _out)

        # Expose Brightness + Universe as custom parameters on the parent, bound to nodes.
        try:
            _pg = None
            for _p0 in _parent.customPages:
                if _p0.name == "LED":
                    _pg = _p0; break
            if _pg is None:
                _pg = _parent.appendCustomPage("LED")
            if not hasattr(_parent.par, "Brightness"):
                _bp = _pg.appendFloat("Brightness")[0]
                _bp.normMin = 0; _bp.normMax = 2; _bp.default = 1; _bp.val = 1
            _bexpr = "op(%r).par.Brightness" % _parent.path
            _bright.par.brightness1.expr = _bexpr
            _bright.par.brightness1.mode = type(_bright.par.brightness1.mode).EXPRESSION
            report["controls"].append({"name": "Brightness", "target": _bright.path + ".brightness1"})
            if not hasattr(_parent.par, "Universe"):
                _up = _pg.appendInt("Universe")[0]
                _up.default = _p["start_universe"]; _up.val = _p["start_universe"]
            _uexpr = "int(op(%r).par.Universe)" % _parent.path
            _dmx.par.universe.expr = _uexpr
            _dmx.par.universe.mode = type(_dmx.par.universe.mode).EXPRESSION
            report["controls"].append({"name": "Universe", "target": _dmx.path + ".universe"})
        except Exception:
            report["warnings"].append("Control binding failed: " + traceback.format_exc().splitlines()[-1])

        _errs = []
        _check = [_source, _bright, _grid, _pixels, _dmx, _out]
        if _dmx_input is not _pixels:
            _check.append(_dmx_input)
        for _n in _check:
            for _e in _n.errors():
                _errs.append(str(_e))
        report["errors"] = _errs[:5]
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildLedMapperScript(payload: object): string {
  return buildPayloadScript(LED_SCRIPT, payload);
}

export async function createLedMapperImpl(ctx: ToolContext, args: CreateLedMapperArgs) {
  return guardTd(
    async () => {
      const script = buildLedMapperScript({
        parent: args.parent_path,
        name: args.name ?? null,
        source: args.source ?? null,
        width: args.width,
        height: args.height,
        layout: args.layout,
        start_universe: args.start_universe,
        start_channel: args.start_channel,
        net: args.net,
        net_address: args.net_address ?? null,
        fps: args.fps,
        channels: args.width * args.height * 3,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<LedMapperReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build the LED pixel-map: ${report.fatal}`, report);
      }
      const src = report.source_built ? " (built-in test Ramp source)" : "";
      const errs = report.errors?.length ? `, ${report.errors.length} node error(s)` : "";
      const warns = report.warnings.length ? `, ${report.warnings.length} warning(s)` : "";
      const startCh =
        args.start_channel > 1
          ? ` starting at DMX channel ${args.start_channel} (${args.start_channel - 1} pad channel(s))`
          : "";
      return jsonResult(
        `Mapped a ${args.width}x${args.height} ${report.layout} fixture grid (${report.channels} DMX channels) to ${report.nodes.dmx ?? "a DMX Out CHOP"} on universe ${report.universe}${startCh}${src}${errs}${warns}. Verify the per-pixel channel/slot order against your fixture before sending real Art-Net.`,
        report,
      );
    },
  );
}

export const registerCreateLedMapper: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_led_mapper",
    {
      title: "Create LED pixel-mapper",
      description:
        "Build a pixel-mapping chain from a source TOP to an LED fixture grid and DMX Out CHOP over Art-Net or sACN. " +
        "The generated network resizes to width×height, samples one texel per fixture pixel, preserves RGB channels, " +
        "and returns created node paths, channel count, warnings, and live Brightness/Universe controls on the parent " +
        "COMP. It defaults to a moving Ramp test source so the chain can cook without input; real network output still " +
        "requires a reachable fixture/node and should be verified before sending. Use create_dmx_fixture_pipeline for " +
        "fixture patching and this tool when you specifically need image-to-pixel mapping.",
      inputSchema: createLedMapperSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createLedMapperImpl(ctx, args),
  );
};
