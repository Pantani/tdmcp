import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// Single source of truth for DMX fixture profiles. Channel name + default
// (0–255) per slot. The merged CHOP channels are prefixed with the fixture id
// (e.g. "fix1/r") so duplicate names across fixtures never collide.
export const FIXTURE_PROFILES = {
  rgb: { channels: ["r", "g", "b"], defaults: [0, 0, 0] },
  rgbw: { channels: ["r", "g", "b", "w"], defaults: [0, 0, 0, 0] },
  par64: {
    channels: ["dimmer", "r", "g", "b", "strobe", "macro", "speed"],
    defaults: [255, 0, 0, 0, 0, 0, 0],
  },
  movingHead8: {
    channels: ["pan", "tilt", "dimmer", "r", "g", "b", "strobe", "gobo"],
    defaults: [128, 128, 255, 255, 255, 255, 0, 0],
  },
  movingHead16: {
    channels: [
      "pan",
      "panFine",
      "tilt",
      "tiltFine",
      "speed",
      "dimmer",
      "shutter",
      "r",
      "g",
      "b",
      "w",
      "ct",
      "gobo",
      "goboRot",
      "focus",
      "prism",
    ],
    defaults: [128, 0, 128, 0, 0, 255, 255, 255, 255, 255, 0, 128, 0, 0, 128, 0],
  },
} as const satisfies Record<string, { channels: readonly string[]; defaults: readonly number[] }>;

export type FixtureProfile = keyof typeof FIXTURE_PROFILES;

export function getProfile(p: FixtureProfile): {
  channels: readonly string[];
  defaults: readonly number[];
} {
  return FIXTURE_PROFILES[p];
}

const FixtureSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Fixture id must be a valid TD-style name")
    .describe("Constant CHOP name + channel-name prefix; must be a valid TD name."),
  profile: z
    .enum(["rgb", "rgbw", "par64", "movingHead8", "movingHead16"])
    .describe("Fixture profile — drives channel count, names, and default values."),
  startChannel: z.coerce
    .number()
    .int()
    .min(1)
    .max(512)
    .describe("1-based DMX slot of the fixture's first channel (1–512)."),
});

export const createDmxFixturePipelineSchema = z.object({
  name: z.string().default("dmx_rig").describe("Base name for the container COMP."),
  parent_path: z
    .string()
    .default("/project1")
    .describe("COMP to create the DMX rig container in (default '/project1')."),
  host: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "Target IP for Art-Net / sACN (maps to dmxoutCHOP `netaddress`). Null = leave default.",
    ),
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
  fixtures: z
    .array(FixtureSchema)
    .min(1, "At least one fixture is required.")
    .describe("Ordered list of fixtures (sorted by startChannel at build time).")
    .superRefine((fixtures, ctx) => {
      const seen = new Set<string>();
      for (const f of fixtures) {
        if (seen.has(f.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate fixture id: ${f.id}`,
          });
        }
        seen.add(f.id);
      }
    }),
});

export type CreateDmxFixturePipelineArgs = z.infer<typeof createDmxFixturePipelineSchema>;

export interface FlattenedFixture {
  id: string;
  profile: FixtureProfile;
  startChannel: number;
  channels: string[];
  defaults: number[];
}

export interface FlattenedPad {
  /** Index in the sorted fixtures array this pad is inserted BEFORE. */
  before: number;
  /** Number of zero-valued slot fillers. */
  gap: number;
}

export interface FlattenResult {
  fixtures: FlattenedFixture[];
  pads: FlattenedPad[];
  totalChannels: number;
  warnings: string[];
}

/**
 * Sort fixtures by startChannel, compute gap padding so the merged CHOP's
 * channel index lines up with the DMX slot index, and surface warnings for
 * overlap and over-512 ranges (non-fatal — multi-universe rigs are allowed).
 */
export function flattenFixtures(
  fixtures: ReadonlyArray<{ id: string; profile: FixtureProfile; startChannel: number }>,
): FlattenResult {
  const sorted = [...fixtures].sort((a, b) => a.startChannel - b.startChannel);
  const warnings: string[] = [];
  const flat: FlattenedFixture[] = [];
  const pads: FlattenedPad[] = [];

  let cursor = 1; // next free DMX slot
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    if (!f) continue;
    const prof = FIXTURE_PROFILES[f.profile];
    const count = prof.channels.length;
    if (f.startChannel < cursor) {
      warnings.push(
        `Fixture '${f.id}' starts at ${f.startChannel} but slot ${cursor} is already used (overlap with a prior fixture).`,
      );
    } else if (f.startChannel > cursor) {
      const gap = f.startChannel - cursor;
      pads.push({ before: i, gap });
    }
    if (f.startChannel + count - 1 > 512) {
      warnings.push(
        `Fixture '${f.id}' (${f.profile}, ${count} channels) at startChannel ${f.startChannel} exceeds universe 512 — split across universes.`,
      );
    }
    flat.push({
      id: f.id,
      profile: f.profile,
      startChannel: f.startChannel,
      channels: prof.channels.map((c) => `${f.id}/${c}`),
      defaults: [...prof.defaults],
    });
    cursor = Math.max(cursor, f.startChannel + count);
  }

  const lastSlot = flat.reduce((m, f) => Math.max(m, f.startChannel + f.channels.length - 1), 0);
  return { fixtures: flat, pads, totalChannels: lastSlot, warnings };
}

interface DmxFixtureReport {
  container: string;
  fixtures: Array<{
    id: string;
    node: string;
    profile: string;
    startChannel: number;
    channels: string[];
  }>;
  merge: string;
  out: string;
  dmx: string;
  universe: number;
  totalChannels: number;
  controls: Array<{ name: string; target: string }>;
  errors?: string[];
  warnings: string[];
  fatal?: string;
}

// Single Python pass. Fail-forward: a missing par on one fixture mustn't kill
// the rest of the rig — failures are collected as warnings[].
const DMX_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container": "",
    "fixtures": [],
    "merge": "",
    "out": "",
    "dmx": "",
    "universe": int(_p.get("universe", 1)),
    "totalChannels": int(_p.get("totalChannels", 0)),
    "controls": [],
    "errors": [],
    "warnings": list(_p.get("warnings", [])),
}

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
        _cont = _parent.create(baseCOMP, _p["name"])
        report["container"] = _cont.path

        # Build the canonical wired sequence: pad?, fix, pad?, fix, ...
        _pads_by_before = {}
        for _pad in _p.get("pads", []):
            _pads_by_before[int(_pad["before"])] = int(_pad["gap"])

        _ordered_inputs = []  # nodes to wire into merge in order

        for _i, _f in enumerate(_p["fixtures"]):
            # Insert pad before this fixture if needed.
            _gap = _pads_by_before.get(_i, 0)
            if _gap > 0:
                _pad_name = "pad_%d" % _i
                _pad_node = _try("pad create " + _pad_name, lambda: _cont.create(constantCHOP, _pad_name))
                if _pad_node is not None:
                    for _k in range(_gap):
                        _try(
                            "pad name%d" % _k,
                            lambda k=_k, n=_pad_node: setattr(n.par, "name%d" % k, "pad/%d" % k),
                        )
                        _try(
                            "pad value%d" % _k,
                            lambda k=_k, n=_pad_node: setattr(n.par, "value%d" % k, 0.0),
                        )
                    _ordered_inputs.append(_pad_node)

            # Fixture Constant CHOP.
            _fid = _f["id"]
            _node = _try("fixture create " + _fid, lambda fid=_fid: _cont.create(constantCHOP, fid))
            if _node is None:
                continue
            _chans = list(_f.get("channels", []))
            _defs = list(_f.get("defaults", []))
            for _k, _cname in enumerate(_chans):
                _def = _defs[_k] if _k < len(_defs) else 0
                _try(
                    "%s name%d" % (_fid, _k),
                    lambda k=_k, cn=_cname, n=_node: setattr(n.par, "name%d" % k, cn),
                )
                _try(
                    "%s value%d" % (_fid, _k),
                    lambda k=_k, v=_def, n=_node: setattr(n.par, "value%d" % k, float(v)),
                )
            _ordered_inputs.append(_node)
            report["fixtures"].append({
                "id": _fid,
                "node": _node.path,
                "profile": _f.get("profile", ""),
                "startChannel": int(_f.get("startChannel", 0)),
                "channels": _chans,
            })

        # Merge CHOP.
        _merge = _try("merge create", lambda: _cont.create(mergeCHOP, "merge"))
        if _merge is not None:
            _try("merge duplicate", lambda: setattr(_merge.par, "duplicate", "rename"))
            for _idx, _n in enumerate(_ordered_inputs):
                _try(
                    "merge connect %d" % _idx,
                    lambda i=_idx, n=_n: _merge.inputConnectors[i].connect(n),
                )
            report["merge"] = _merge.path

        # Null CHOP rig_out.
        _null = _try("rig_out create", lambda: _cont.create(nullCHOP, "rig_out"))
        if _null is not None and _merge is not None:
            _try("rig_out connect", lambda: _null.inputConnectors[0].connect(_merge))
            report["out"] = _null.path

        # DMX Out CHOP.
        _dmx = _try("dmx create", lambda: _cont.create(dmxoutCHOP, "dmx"))
        if _dmx is not None:
            _try("dmx interface", lambda: setattr(_dmx.par, "interface", _p["interface"]))
            _try("dmx universe", lambda: setattr(_dmx.par, "universe", int(_p["universe"])))
            if _p.get("host"):
                _try("dmx netaddress", lambda: setattr(_dmx.par, "netaddress", _p["host"]))
            _try("dmx rate", lambda: setattr(_dmx.par, "rate", float(_p["fps"])))
            if _null is not None:
                _try("dmx connect", lambda: _dmx.inputConnectors[0].connect(_null))
            report["dmx"] = _dmx.path
            # Surface device-not-found type warnings without making them fatal.
            try:
                _err = _dmx.errors()
                if _err:
                    report["errors"].append(str(_err))
            except Exception:
                pass
            report["controls"] = [
                {"name": "Universe", "target": _dmx.path + ".universe"},
                {"name": "Rate", "target": _dmx.path + ".rate"},
                {"name": "Net Address", "target": _dmx.path + ".netaddress"},
            ]
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildDmxFixturePipelineScript(payload: object): string {
  return buildPayloadScript(DMX_SCRIPT, payload);
}

export async function createDmxFixturePipelineImpl(
  ctx: ToolContext,
  args: CreateDmxFixturePipelineArgs,
) {
  const flat = flattenFixtures(args.fixtures);
  return guardTd(
    async () => {
      const script = buildDmxFixturePipelineScript({
        parent_path: args.parent_path,
        name: args.name,
        universe: args.universe,
        interface: args.net,
        host: args.host,
        fps: args.fps,
        totalChannels: flat.totalChannels,
        warnings: flat.warnings,
        fixtures: flat.fixtures.map((f) => ({
          id: f.id,
          profile: f.profile,
          startChannel: f.startChannel,
          channels: f.channels,
          defaults: f.defaults,
        })),
        pads: flat.pads,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<DmxFixtureReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`DMX fixture pipeline build failed: ${report.fatal}`, report);
      }
      const fixtureCount = report.fixtures.length;
      const warnNote = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : "";
      const errNote =
        report.errors && report.errors.length > 0
          ? `, ${report.errors.length} dmxout warning(s)`
          : "";
      const summary = `Built a DMX rig (${fixtureCount} fixture(s), ${report.totalChannels} channels, universe ${report.universe}, ${args.net}) → ${report.dmx || "dmx"}${warnNote}${errNote}. Bind parameters to op('${report.out}')['<id>/<channel>'] (e.g. 'fix1/r').`;
      return jsonResult(summary, report);
    },
  );
}

export const registerCreateDmxFixturePipeline: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_dmx_fixture_pipeline",
    {
      title: "Create DMX fixture pipeline",
      description:
        "Build a DMX/Art-Net (or sACN) output chain from a fixture list. For each fixture (rgb, rgbw, par64, movingHead8, movingHead16) creates a Constant CHOP with one named, default-valued channel per DMX slot (prefixed '<id>/<channel>'), inserts pad Constant CHOPs to keep DMX-slot alignment, merges them all into one stream, and drives a dmxoutCHOP (`interface`, `universe`, `netaddress`, `rate`). Returns the container + a JSON report with paths, fixtures, total channels, exposed controls (Universe / Rate / Net Address), and warnings. Per-fixture sliders are NOT auto-exposed — bind individual channels later with bind_to_channel / animate_parameter on op('rig_out')['fix1/r'] etc.",
      inputSchema: createDmxFixturePipelineSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createDmxFixturePipelineImpl(ctx, args),
  );
};
