import { z } from "zod";
import type { ControlSpec } from "../layer2/createControlPanel.js";
import { createSystemContainer, finalize, runBuild } from "../layer2/orchestration.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

const q = (value: string): string => JSON.stringify(value);

const zoneSchema = z.object({
  name: z
    .string()
    .optional()
    .describe("Optional label for the zone; falls back to zone0, zone1, … when omitted."),
  x: z
    .number()
    .min(0)
    .max(1)
    .describe("Normalized left edge of the zone (0 = left, 1 = right), the top-left corner X."),
  y: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Normalized top edge of the zone (0 = top, 1 = bottom), the top-left corner Y in image/UI convention. Internally mapped to TD's bottom-left uv origin.",
    ),
  w: z.number().min(0).max(1).describe("Normalized width of the zone (fraction of image width)."),
  h: z.number().min(0).max(1).describe("Normalized height of the zone (fraction of image height)."),
});

export const createInteractionZonesSchema = z.object({
  source_path: z
    .string()
    .optional()
    .describe(
      "TOP to watch for motion (pulled via selectTOP). Omit for a built-in synthetic animated Noise TOP that cooks clean on any install (offline-safe, no external asset).",
    ),
  zones: z
    .array(zoneSchema)
    .min(1)
    .max(16)
    .default([
      { name: "left", x: 0, y: 0, w: 0.5, h: 1 },
      { name: "right", x: 0.5, y: 0, w: 0.5, h: 1 },
    ])
    .describe("Rectangular zones (normalized 0..1) to watch."),
  threshold: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.05)
    .describe("Motion level above which a zone counts as active."),
  resolution: z
    .tuple([z.number(), z.number()])
    .default([640, 360])
    .describe(
      "Analysis resolution [width, height] in pixels (cheap; motion detection is bandwidth-bound).",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe(
      "Parent COMP the interaction-zones container is created inside (default '/project1').",
    ),
  name: z
    .string()
    .default("interaction_zones")
    .describe("Name of the container COMP created under parent_path."),
});

type CreateInteractionZonesArgs = z.infer<typeof createInteractionZonesSchema>;

interface ResolvedZone {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function resolveZones(zones: CreateInteractionZonesArgs["zones"]): ResolvedZone[] {
  // Two distinct names can sanitize to the same key (e.g. "left zone" and "left/zone"
  // both → "left_zone"), which would collide in downstream node/channel names. Track
  // seen keys and disambiguate a collision by appending the zone index.
  const seen = new Set<string>();
  return zones.map((zone, index) => {
    const base = (zone.name ?? `zone${index}`).replace(/[^a-zA-Z0-9_]/g, "_");
    let key = base;
    if (seen.has(key)) key = `${base}_${index}`;
    seen.add(key);
    return { key, x: zone.x, y: zone.y, w: zone.w, h: zone.h };
  });
}

/**
 * Callbacks DAT text for the zones_out scriptCHOP. Each cook it reads every input
 * channel `zoneK` (raw motion level) and emits `zoneK_state` (1 if level>threshold
 * else 0) and `zoneK_dwell` (seconds continuously active). Dwell is accumulated per
 * zone via me.store/fetch; dt comes from absTime.seconds. Threshold is read live from
 * the container's Threshold custom parameter, falling back to the build-time default.
 *
 * UNVERIFIED: scriptCHOP callback signature (onCook(scriptOp)) and the
 * scriptOp.clear()/appendChan()/numSamples APIs vary slightly by TD build; kept
 * entirely inside this DAT text and set defensively below (failures → warnings).
 */
function zonesCallbackText(defaultThreshold: number): string {
  return [
    "def onCook(scriptOp):",
    "\tscriptOp.clear()",
    "\tsrc = scriptOp.inputs[0] if len(scriptOp.inputs) else None",
    "\tp = scriptOp.parent()",
    "\ttry:",
    `\t\tthr = float(p.par.Threshold)`,
    "\texcept Exception:",
    `\t\tthr = ${defaultThreshold}`,
    "\tnow = absTime.seconds",
    "\tprev = scriptOp.fetch('_zt', None)",
    "\tdt = 0.0 if prev is None else max(0.0, now - prev)",
    "\tscriptOp.store('_zt', now)",
    "\tdwell = scriptOp.fetch('_dwell', {})",
    "\tif src is not None:",
    "\t\tfor ch in src.chans():",
    "\t\t\tlevel = ch[0] if len(ch) else 0.0",
    "\t\t\tactive = 1.0 if level > thr else 0.0",
    "\t\t\td = dwell.get(ch.name, 0.0)",
    "\t\t\td = (d + dt) if active > 0.5 else 0.0",
    "\t\t\tdwell[ch.name] = d",
    "\t\t\tsc = scriptOp.appendChan(ch.name + '_state')",
    "\t\t\tsc[0] = active",
    "\t\t\tdc = scriptOp.appendChan(ch.name + '_dwell')",
    "\t\t\tdc[0] = d",
    "\tscriptOp.store('_dwell', dwell)",
    "\treturn",
    "",
  ].join("\n");
}

export async function createInteractionZonesImpl(
  ctx: ToolContext,
  args: CreateInteractionZonesArgs,
): Promise<import("@modelcontextprotocol/sdk/types.js").CallToolResult> {
  return runBuild(async () => {
    const builder = await createSystemContainer(ctx, args.parent_path, args.name);
    const [resW, resH] = args.resolution;
    const zones = resolveZones(args.zones);

    // ── Source ────────────────────────────────────────────────────────────────
    // selectTOP pulls an external TOP cross-container; otherwise a synthetic Noise TOP
    // (drifting on the timeline) gives the motion chain frame-to-frame change to detect
    // offline. A bundled movie (Mosaic.mp4) does NOT ship on every TD build and raises
    // "Failed to open file", so the demo uses a guaranteed-present generator instead —
    // it cooks clean on any install with no external asset and no camera permission.
    let sourceNode: string;
    if (args.source_path) {
      sourceNode = await builder.add("selectTOP", "source_in", {
        top: args.source_path,
        resolutionw: resW,
        resolutionh: resH,
      });
    } else {
      sourceNode = await builder.add("noiseTOP", "synthetic_src", {
        type: "sparse",
        resolutionw: resW,
        resolutionh: resH,
      });
      // Drift the field on the timeline so consecutive frames differ → real motion for
      // the difference TOP even with no camera.
      await builder.python(
        [
          `_n = op(${q(sourceNode)})`,
          `try:`,
          `    _n.par.tz.expr = 'absTime.seconds * 0.5'`,
          `    _n.par.tx.expr = 'absTime.seconds * 0.3'`,
          `except Exception:`,
          `    pass`,
        ].join("\n"),
      );
    }

    // ── Motion-energy TOP ─────────────────────────────────────────────────────
    // monochrome → previous-frame cache + difference = per-pixel motion. Zones
    // fire on movement (spec), not raw luminance.
    const mono = await builder.add("monochromeTOP", "mono", {
      resolutionw: resW,
      resolutionh: resH,
    });
    await builder.connect(sourceNode, mono);

    const cachePrev = await builder.add("cacheTOP", "prevframe", {
      active: 1,
      cachesize: 2,
      outputindexunit: "indices",
      outputindex: -1,
    });
    await builder.connect(mono, cachePrev, 0, 0);

    const motion = await builder.add("differenceTOP", "motion");
    await builder.connect(mono, motion, 0, 0);
    await builder.connect(cachePrev, motion, 0, 1);

    // ── Per-zone crop + region-average → one motion channel per zone ──────────
    // TD TOP uv origin is bottom-left; the schema's y is a top-left corner (image
    // convention), so cropbottom = 1 - (y + h) and croptop = 1 - y.
    const cropParNote =
      "cropTOP crop pars set defensively (tries cropleft/cropl, cropright/cropr, cropbottom/cropb, croptop/cropt).";
    const zoneChannels: string[] = [];
    const levelMerge = await builder.add("mergeCHOP", "zone_levels");
    for (const [i, zone] of zones.entries()) {
      const cropLeft = zone.x;
      const cropRight = zone.x + zone.w;
      // Map top-left image corner to TD's bottom-left uv origin.
      const cropBottom = 1 - (zone.y + zone.h);
      const cropTop = 1 - zone.y;

      const crop = await builder.add("cropTOP", `${zone.key}_crop`, {
        resolutionw: resW,
        resolutionh: resH,
      });
      await builder.connect(motion, crop);
      // Set the crop fractions defensively — token spelling varies by build.
      await builder.python(
        [
          `_cr = op(${q(crop)})`,
          `for _t, _v in [('cropleft', ${cropLeft}), ('cropl', ${cropLeft})]:`,
          `    try:`,
          `        setattr(_cr.par, _t, _v); break`,
          `    except Exception: pass`,
          `for _t, _v in [('cropright', ${cropRight}), ('cropr', ${cropRight})]:`,
          `    try:`,
          `        setattr(_cr.par, _t, _v); break`,
          `    except Exception: pass`,
          `for _t, _v in [('cropbottom', ${cropBottom}), ('cropb', ${cropBottom})]:`,
          `    try:`,
          `        setattr(_cr.par, _t, _v); break`,
          `    except Exception: pass`,
          `for _t, _v in [('croptop', ${cropTop}), ('cropt', ${cropTop})]:`,
          `    try:`,
          `        setattr(_cr.par, _t, _v); break`,
          `    except Exception: pass`,
        ].join("\n"),
      );

      const analyze = await builder.add("analyzeTOP", `${zone.key}_avg`, { op: "average" });
      await builder.connect(crop, analyze);

      const toChop = await builder.add("toptoCHOP", `${zone.key}_c`, {
        top: analyze,
        r: zone.key,
        g: "",
        b: "",
        a: "",
      });
      await builder.connect(analyze, toChop);
      await builder.connect(toChop, levelMerge, 0, i);
      zoneChannels.push(zone.key);
    }

    // ── Threshold + dwell + state via scriptCHOP ──────────────────────────────
    // A scriptCHOP whose callbacks DAT computes, per input channel zoneK:
    // zoneK_state (1 if level>Threshold) and zoneK_dwell (seconds active).
    const zonesOut = await builder.add("scriptCHOP", "zones_out");
    await builder.connect(levelMerge, zonesOut);
    const callbacksDat = await builder.add("textDAT", "zones_callbacks");
    await builder.python(`op(${q(callbacksDat)}).text = ${q(zonesCallbackText(args.threshold))}`);
    // Point the scriptCHOP at the callbacks DAT — the par token varies (callbacks vs dat).
    await builder.python(
      [
        `_so = op(${q(zonesOut)})`,
        `for _t in ['callbacks', 'dat', 'script']:`,
        `    try:`,
        `        setattr(_so.par, _t, ${q(callbacksDat)}); break`,
        `    except Exception: pass`,
      ].join("\n"),
    );

    // ── Output Null (the bind point) + per-frame cooker ───────────────────────
    const out = await builder.add("nullCHOP", "zones");
    await builder.connect(zonesOut, out);

    // TOP-derived CHOP chains freeze without something pulling them each frame;
    // an Execute DAT force-cooks the Null every frame (copied from motion_reactive).
    const cooker = await builder.add("executeDAT", "cooker");
    await builder.python(
      `_c = op(${q(cooker)})\n_c.text = "def onFrameStart(frame):\\n\\tparent().op('zones').cook(force=True)\\n\\treturn\\n"\n_c.par.framestart = True\n_c.par.active = True`,
    );

    // ── Controls ──────────────────────────────────────────────────────────────
    // A live Threshold knob; the scriptCHOP callback reads parent().par.Threshold
    // each cook, so the control drives the gating without a rebuild.
    const controls: ControlSpec[] = [
      {
        name: "Threshold",
        type: "float",
        min: 0,
        max: 1,
        default: args.threshold,
        bind_to: [],
      },
    ];

    const stateChannels = zoneChannels.map((z) => `${z}_state`);
    const dwellChannels = zoneChannels.map((z) => `${z}_dwell`);
    const sourceSummary = args.source_path
      ? args.source_path
      : "a built-in synthetic animated Noise TOP (no external asset)";
    const summary =
      `Built ${zones.length} interaction zone(s) over ${sourceSummary} → ${out} (threshold ${args.threshold}). ` +
      `Motion in each zone is reduced to a level; the zones_out scriptCHOP emits per zone a *_state channel (1 when active) and a *_dwell channel (seconds continuously active). ` +
      `Bind cues to op('${out}')['${stateChannels[0] ?? "zone0_state"}'] etc. via bind_to_channel. ` +
      `State channels: ${stateChannels.join(", ")}. Dwell channels: ${dwellChannels.join(", ")}.`;

    return finalize(ctx, {
      summary,
      builder,
      outputPath: out,
      // The output is a CHOP, not a TOP, so there is no image to capture.
      capturePreviewImage: false,
      controls,
      extra: {
        zones_path: out,
        channels: [...stateChannels, ...dwellChannels],
        zone_definitions: zones.map((z) => ({ name: z.key, x: z.x, y: z.y, w: z.w, h: z.h })),
        threshold: args.threshold,
        origin_mapping:
          "Schema y is a top-left corner (image convention); TD TOP uv origin is bottom-left, so cropbottom = 1 - (y + h), croptop = 1 - y.",
        unverified: [
          cropParNote,
          "scriptCHOP `callbacks`/`dat` par token set defensively (tries 'callbacks', 'dat', 'script').",
          "scriptCHOP onCook(scriptOp) callback signature + scriptOp.clear()/appendChan()/store/fetch APIs (probe live).",
          "analyzeTOP `op`='average' token assumed (matches create_motion_reactive; probe live to confirm).",
          "cacheTOP outputindexunit='indices' / outputindex=-1 previous-frame tokens (probe live).",
        ],
      },
    });
  });
}

export const registerCreateInteractionZones: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_interaction_zones",
    {
      title: "Create interaction zones",
      description:
        "Define N rectangular zones over a camera / motion input; each zone fires when motion in that region crosses a threshold. Builds a stock-TOP chain — a motion-energy TOP (monochrome → previous-frame cache → difference), then per zone a cropTOP (region isolate) + analyzeTOP average + toptoCHOP, merged into one level CHOP, then a scriptCHOP that emits per zone a `*_state` channel (0/1 active) and a `*_dwell` channel (seconds continuously active). Ends on a 'zones' Null CHOP as the bind point — wire cues via bind_to_channel to op('…/interaction_zones/zones')['zone0_state']. Camera-only (no depth cam). Source is a TOP pulled via selectTOP, or a built-in synthetic animated Noise TOP when omitted (offline-safe, cooks clean on any install with no external asset). A live Threshold knob tunes sensitivity. Zones are normalized rects (x,y = top-left corner, w,h = size); the top-left image convention is mapped to TD's bottom-left uv origin. Returns a summary plus JSON with the container path, created node paths, the zones Null path, per-zone state/dwell channel names, the zone definitions, threshold, and warnings (no preview image — the output is a CHOP, not a TOP).",
      inputSchema: createInteractionZonesSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createInteractionZonesImpl(ctx, args),
  );
};
