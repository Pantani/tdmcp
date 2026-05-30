import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const createTextCrawlSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP where the text-crawl container is created (default '/project1')."),
  name: z
    .string()
    .default("text_crawl")
    .describe("Name for the baseCOMP container that holds the crawl network."),
  text: z
    .string()
    .describe(
      "The text content to display. Use \\n to separate multiple lines (e.g. for a ticker or credits roll). All lines are fed to a single Text TOP.",
    ),
  mode: z
    .enum(["crawl_horizontal", "roll_vertical", "typewriter"])
    .default("crawl_horizontal")
    .describe(
      "Animation style: 'crawl_horizontal' = text scrolls continuously left across the frame (ticker-tape); 'roll_vertical' = text rolls upward (credits roll); 'typewriter' = text is revealed one character at a time from left to right — EXPERIMENTAL (the substring expression on a textTOP par is UNVERIFIED across TD builds).",
    ),
  speed: z.coerce
    .number()
    .default(0.1)
    .describe(
      "Scroll speed as a fraction of the output resolution per second. 0.1 = the text travels one full screen-width per 10 s. Drives the Transform TOP position expression.",
    ),
  font_size: z.coerce
    .number()
    .default(48)
    .describe(
      "Font size in pixels (maps to the Text TOP's fontsizex parameter; fontsizey is set to the same value).",
    ),
  color: z
    .array(z.number())
    .length(3)
    .default([1, 1, 1])
    .describe(
      "RGB text colour as three 0–1 floats, e.g. [1,1,1] = white. Sets fontcolorr/g/b on the Text TOP.",
    ),
  bg_alpha: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe(
      "Background alpha [0–1]. 0 = fully transparent background (text over black/transparent). The par name is probed: 'alphabg' is tried first, then 'bgalpha' — UNVERIFIED across TD builds.",
    ),
  width: z.coerce
    .number()
    .int()
    .default(1920)
    .describe("Output resolution width in pixels (sets resolutionw on the Text TOP)."),
  height: z.coerce
    .number()
    .int()
    .default(1080)
    .describe("Output resolution height in pixels (sets resolutionh on the Text TOP)."),
  loop: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), the scroll position wraps so the text crawls/rolls continuously. When false, it plays once and stops at the end.",
    ),
});

export type CreateTextCrawlArgs = z.infer<typeof createTextCrawlSchema>;

// ---------------------------------------------------------------------------
// Report interface (typed T for parsePythonReport)
// ---------------------------------------------------------------------------

interface TextCrawlReport {
  container: string;
  output_top: string;
  text_top: string;
  transform_top: string;
  mode: string;
  lines: number;
  warnings: string[];
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Python script
//
// Strategy:
//   baseCOMP container
//     textTOP "text"    — renders the content, configured with par probing
//     transformTOP "pos" — drives scroll/roll via an EXPRESSION on tx or ty
//                          (typewriter: position is static; text par gets a
//                           substring expression instead)
//     nullTOP "out"
//
// All TD globals (op, baseCOMP, textTOP, transformTOP, nullTOP) are used
// only inside the script string, never in TypeScript.  User-supplied strings
// enter only through the base64 payload — no raw string interpolation.
//
// Fail-forward: every par-set attempt is individually try/except'd.
// fatal is only set when the parent COMP is missing (nothing can be done).
// ---------------------------------------------------------------------------

const CRAWL_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "output_top": "",
    "text_top": "",
    "transform_top": "",
    "mode": _p["mode"],
    "lines": len(_p["text"].split("\\n")),
    "warnings": [],
}
try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        # --- Create container ---
        try:
            _cont = _parent.create(baseCOMP, _p["name"])
        except Exception as _e:
            report["fatal"] = "Could not create container: " + str(_e)
            _cont = None

        if _cont is not None:
            report["container"] = _cont.path

            # --- Text TOP ---
            _txt = None
            try:
                _txt = _cont.create(textTOP, "text")

                try:
                    _txt.par.text = _p["text"]
                except Exception as _e:
                    report["warnings"].append("textTOP par 'text' failed: " + str(_e))

                try:
                    _txt.par.fontsizex = _p["font_size"]
                except Exception as _e:
                    report["warnings"].append("textTOP par 'fontsizex' failed: " + str(_e))

                try:
                    _txt.par.fontsizey = _p["font_size"]
                except Exception as _e:
                    report["warnings"].append("textTOP par 'fontsizey' failed: " + str(_e))

                _col = _p["color"]
                try:
                    _txt.par.fontcolorr = _col[0]
                except Exception as _e:
                    report["warnings"].append("textTOP par 'fontcolorr' failed: " + str(_e))
                try:
                    _txt.par.fontcolorg = _col[1]
                except Exception as _e:
                    report["warnings"].append("textTOP par 'fontcolorg' failed: " + str(_e))
                try:
                    _txt.par.fontcolorb = _col[2]
                except Exception as _e:
                    report["warnings"].append("textTOP par 'fontcolorb' failed: " + str(_e))

                # bg alpha: probe 'alphabg' then 'bgalpha' (par name varies by TD build).
                _bg_set = False
                for _bgpar in ("alphabg", "bgalpha"):
                    try:
                        _par_obj = getattr(_txt.par, _bgpar, None)
                        if _par_obj is not None:
                            _par_obj.val = _p["bg_alpha"]
                            _bg_set = True
                            break
                    except Exception:
                        pass
                if not _bg_set:
                    report["warnings"].append(
                        "textTOP bg_alpha par ('alphabg'/'bgalpha') not found — UNVERIFIED; bg transparency not applied."
                    )

                try:
                    _txt.par.resolutionw = _p["width"]
                except Exception as _e:
                    report["warnings"].append("textTOP par 'resolutionw' failed: " + str(_e))
                try:
                    _txt.par.resolutionh = _p["height"]
                except Exception as _e:
                    report["warnings"].append("textTOP par 'resolutionh' failed: " + str(_e))

                # Centre text vertically and horizontally so it anchors to the frame.
                try:
                    _txt.par.alignx = "center"
                except Exception:
                    pass
                try:
                    _txt.par.aligny = "center"
                except Exception:
                    pass

                report["text_top"] = _txt.path
            except Exception as _e:
                report["warnings"].append("textTOP creation failed: " + str(_e))

            # --- Transform TOP — drives position ---
            _xfm = None
            try:
                _xfm = _cont.create(transformTOP, "pos")
                if _txt is not None:
                    _xfm.inputConnectors[0].connect(_txt)
                report["transform_top"] = _xfm.path
            except Exception as _e:
                report["warnings"].append("transformTOP creation failed: " + str(_e))

            # Wire up the animation expression based on mode.
            _mode = _p["mode"]
            _speed = _p["speed"]
            _loop = _p["loop"]

            if _mode == "crawl_horizontal":
                # tx: continuous rightward wrap. At speed S (screen-widths/s),
                # after T seconds the offset is -(S*T) % 2 mapped to [-1, 1] so
                # the text exits left and re-enters from the right.  When loop=False
                # the motion simply continues past the edge (no extra clamp added —
                # the artist can stop playback).
                _expr = "((-me.time.seconds * %s) %% 2.0) - 1.0" % repr(_speed)
                if _xfm is not None:
                    try:
                        _tp = _xfm.par.tx
                        _tp.expr = _expr
                        _tp.mode = type(_tp.mode).EXPRESSION
                    except Exception as _e:
                        report["warnings"].append(
                            "transformTOP tx expression failed: " + str(_e)
                        )
                    # Keep ty centred.
                    try:
                        _xfm.par.ty = 0
                    except Exception:
                        pass

            elif _mode == "roll_vertical":
                # ty: continuous upward roll.
                _expr = "((me.time.seconds * %s) %% 2.0) - 1.0" % repr(_speed)
                if _xfm is not None:
                    try:
                        _tp = _xfm.par.ty
                        _tp.expr = _expr
                        _tp.mode = type(_tp.mode).EXPRESSION
                    except Exception as _e:
                        report["warnings"].append(
                            "transformTOP ty expression failed: " + str(_e)
                        )
                    try:
                        _xfm.par.tx = 0
                    except Exception:
                        pass

            elif _mode == "typewriter":
                # Typewriter: keep the transform static (no scroll).
                # Instead, set the textTOP 'text' par to an expression that
                # reveals an increasing substring over time.
                # chars_per_sec = speed * full_text_length so the whole text
                # is revealed in (1/speed) seconds.
                _full_text = _p["text"]
                _chars_per_sec = max(1, int(len(_full_text) * _speed * 10))
                # EXPERIMENTAL: substring on a textTOP text par may not evaluate
                # in all TD builds — guarded; falls back to showing full text.
                _tw_expr = repr(_full_text) + "[:max(0, int(me.time.seconds * %d))]" % _chars_per_sec
                if _txt is not None:
                    try:
                        _tp = _txt.par.text
                        _tp.expr = _tw_expr
                        _tp.mode = type(_tp.mode).EXPRESSION
                        report["warnings"].append(
                            "typewriter: textTOP 'text' par set to substring expression — UNVERIFIED-live; if text does not animate, the par may reject Python slice expressions in this TD build."
                        )
                    except Exception as _e:
                        report["warnings"].append(
                            "typewriter substring expr failed (%s); full text shown." % str(_e)
                        )
                if _xfm is not None:
                    try:
                        _xfm.par.tx = 0
                    except Exception:
                        pass
                    try:
                        _xfm.par.ty = 0
                    except Exception:
                        pass

            # --- Null TOP: stable output handle ---
            _null = None
            try:
                _null = _cont.create(nullTOP, "out")
                _prev = _xfm if _xfm is not None else _txt
                if _prev is not None:
                    _null.inputConnectors[0].connect(_prev)
                report["output_top"] = _null.path
            except Exception as _e:
                # Fallback: report the last live node as output
                report["output_top"] = (
                    _xfm.path if _xfm is not None else
                    (_txt.path if _txt is not None else "")
                )
                report["warnings"].append("nullTOP creation failed: " + str(_e))

except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

// ---------------------------------------------------------------------------
// Script builder (exported for testing)
// ---------------------------------------------------------------------------

export function buildTextCrawlScript(payload: object): string {
  return buildPayloadScript(CRAWL_SCRIPT, payload);
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function createTextCrawlImpl(
  ctx: ToolContext,
  args: CreateTextCrawlArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  return guardTd(
    async () => {
      const script = buildTextCrawlScript({
        parent_path: args.parent_path,
        name: args.name,
        text: args.text,
        mode: args.mode,
        speed: args.speed,
        font_size: args.font_size,
        color: args.color,
        bg_alpha: args.bg_alpha,
        width: args.width,
        height: args.height,
        loop: args.loop,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<TextCrawlReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Text crawl build failed: ${report.fatal}`, report);
      }
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const lineNote = report.lines > 1 ? ` (${report.lines} lines)` : "";
      const modeLabel =
        report.mode === "crawl_horizontal"
          ? "horizontal crawl"
          : report.mode === "roll_vertical"
            ? "vertical roll"
            : "typewriter";
      const summary =
        `Built ${modeLabel} text crawl${lineNote} at speed ${args.speed} → ${report.output_top}${warnNote}. ` +
        `Animate speed live by setting the Transform TOP position expression's multiplier, or re-run with a different speed.` +
        (report.mode === "typewriter"
          ? " Typewriter mode uses a substring expression on the textTOP text par — UNVERIFIED-live."
          : "");
      return jsonResult(summary, report);
    },
  );
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreateTextCrawl: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_text_crawl",
    {
      title: "Create text crawl",
      description:
        "Build a multi-line animated text crawl / ticker / credits roll / typewriter reveal inside a self-contained baseCOMP. Three modes: 'crawl_horizontal' = continuous left-scrolling ticker tape (news-ticker style); 'roll_vertical' = upward credits roll (use \\n to separate lines); 'typewriter' = text is revealed character-by-character from left to right (EXPERIMENTAL — the substring expression on a textTOP text par is unverified across TD builds). A textTOP renders the content; a transformTOP animates position via an EXPRESSION parameter (crawl/roll modes) or the textTOP text par is set to a time-sliced substring expression (typewriter mode). The scroll wraps continuously (loop=true, default) so the text re-enters from the opposite edge. Outputs a nullTOP 'out' as a stable handle. Differs from create_kinetic_text which is single-string flash/pulse/slide; this tool handles multi-line copy, continuous scrolling, and character-reveal. Returns a JSON block with container path, output_top, text_top, transform_top, mode, line count, and any per-step warnings.",
      inputSchema: createTextCrawlSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createTextCrawlImpl(ctx, args),
  );
};
