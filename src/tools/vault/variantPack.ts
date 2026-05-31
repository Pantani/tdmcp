import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { computeMorphPackHash, type MorphLook, type MorphPackDoc } from "./morphPack.js";
import { requireVault } from "./shared.js";

const PACK_SCHEMA = "tdmcp.morphpack";
const PACK_SCHEMA_VERSION = 1;

export const variantPackSchema = z.object({
  name: z.string().describe("Pack name. File defaults to MorphPacks/<name>.morphpack.json."),
  parent: z
    .string()
    .default("/project1")
    .describe("Parent COMP recorded into provenance.container_path."),
  comp_path: z
    .string()
    .optional()
    .describe(
      "COMP whose customPars give slider ranges for clamping. Defaults to target_path else parent.",
    ),
  seed_look: z
    .record(z.string(), z.coerce.number())
    .describe(
      "Anchor look: { paramName: number }. Names must be numeric custom pars on comp_path.",
    ),
  count: z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .default(8)
    .describe("Number of perturbed variants (1..64)."),
  delta_range: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.15)
    .describe("Perturbation magnitude as fraction of each param's slider span."),
  seed: z.coerce.number().int().optional().describe("RNG seed for repeatable packs."),
  variant_prefix: z.string().default("").describe("Slot id prefix."),
  include_seed: z.boolean().default(true).describe("If true, slot v00 is the seed look itself."),
  target_path: z
    .string()
    .optional()
    .describe("Recorded into provenance.target_path so morph_pack can unpack standalone."),
  interpolation: z
    .enum(["linear", "cosine", "cubic"])
    .default("linear")
    .describe("Recorded into provenance."),
  vault_path: z
    .string()
    .optional()
    .describe("Override default MorphPacks/<name>.morphpack.json. Resolved via Vault.resolve."),
  overwrite: z.boolean().default(false).describe("Allow replacing an existing pack file."),
});
export type VariantPackArgs = z.infer<typeof variantPackSchema>;

interface ParamMeta {
  name: string;
  normMin: number;
  normMax: number;
  style: string;
  isNumber: boolean;
  readOnly: boolean;
}

interface ParamMetaReport {
  comp?: string;
  params?: ParamMeta[];
  missing?: string[];
  target_optype?: string;
  warnings: string[];
  fatal?: string;
}

const PARAM_META_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"params": [], "missing": [], "warnings": [], "target_optype": ""}
try:
    _comp_path = _p.get("comp")
    _names = _p.get("names") or []
    _tgt = _p.get("target_path") or ""
    _c = op(_comp_path) if _comp_path else None
    if _c is not None:
        report["comp"] = _c.path
    for _n in _names:
        _par = getattr(_c.par, _n, None) if _c is not None else None
        if _par is None:
            report["missing"].append(_n)
            continue
        try:
            _nmin = float(_par.normMin) if _par.normMin is not None else 0.0
        except Exception:
            _nmin = 0.0
        try:
            _nmax = float(_par.normMax) if _par.normMax is not None else 1.0
        except Exception:
            _nmax = 1.0
        try:
            _style = str(_par.style)
        except Exception:
            _style = ""
        try:
            _isnum = bool(_par.isNumber)
        except Exception:
            _isnum = True
        try:
            _ro = bool(_par.readOnly)
        except Exception:
            _ro = False
        report["params"].append({
            "name": _n,
            "normMin": _nmin,
            "normMax": _nmax,
            "style": _style,
            "isNumber": _isnum,
            "readOnly": _ro,
        })
    if _tgt:
        _to = op(_tgt)
        if _to is not None:
            try:
                report["target_optype"] = _to.OPType
            except Exception:
                report["target_optype"] = ""
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildVariantPackProbeScript(payload: object): string {
  return buildPayloadScript(PARAM_META_SCRIPT, payload);
}

function defaultVaultPath(name: string): string {
  return `MorphPacks/${name}.morphpack.json`;
}

// mulberry32 — deterministic, no deps.
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v: number, lo: number, hi: number): number {
  if (lo > hi) return v;
  return Math.min(hi, Math.max(lo, v));
}

function padId(n: number, width: number): string {
  return n.toString().padStart(width, "0");
}

export async function variantPackImpl(ctx: ToolContext, args: VariantPackArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const relPath = args.vault_path ?? defaultVaultPath(args.name);
  try {
    vault.resolve(relPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return errorResult(`Invalid vault path: ${reason}`);
  }
  if (!args.overwrite && vault.exists(relPath)) {
    return errorResult(`Pack file already exists: ${relPath}. Pass overwrite=true to replace it.`);
  }

  const seedNames = Object.keys(args.seed_look);
  const compPath = args.comp_path ?? args.target_path ?? args.parent;

  return guardTd(
    async () => {
      const script = buildVariantPackProbeScript({
        comp: compPath,
        names: seedNames,
        target_path: args.target_path ?? "",
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ParamMetaReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) return errorResult(`Variant pack probe failed: ${report.fatal}`, report);

      const warnings: string[] = [...(report.warnings ?? [])];
      const params = report.params ?? [];
      const metaByName = new Map<string, ParamMeta>();
      for (const p of params) metaByName.set(p.name, p);
      const missing = report.missing ?? [];
      if (missing.length > 0) {
        warnings.push(`No range metadata for: ${missing.join(", ")} (perturbed without clamp).`);
      }

      const rngSeed =
        typeof args.seed === "number" && Number.isFinite(args.seed)
          ? args.seed
          : Math.floor(Math.random() * 0xffffffff);
      const rng = makeRng(rngSeed);

      const width = Math.max(2, String(args.count).length);
      const looks: MorphLook[] = [];

      if (args.include_seed) {
        looks.push({
          id: `${args.variant_prefix}${args.name}_v${padId(0, width)}`,
          parameters: { ...args.seed_look },
        });
      }

      for (let i = 1; i <= args.count; i++) {
        const parameters: Record<string, number> = {};
        for (const name of seedNames) {
          const seedVal = args.seed_look[name] ?? 0;
          const meta = metaByName.get(name);
          let span: number;
          let lo: number;
          let hi: number;
          if (meta && Number.isFinite(meta.normMin) && Number.isFinite(meta.normMax)) {
            span = meta.normMax - meta.normMin;
            lo = meta.normMin;
            hi = meta.normMax;
          } else {
            // no-clamp fallback
            span = Math.abs(seedVal) > 1e-9 ? Math.abs(seedVal) : 1;
            lo = Number.NEGATIVE_INFINITY;
            hi = Number.POSITIVE_INFINITY;
          }
          const offset = (rng() * 2 - 1) * args.delta_range * span;
          let val = clamp(seedVal + offset, lo, hi);
          if (meta && meta.style === "Int") val = Math.round(val);
          parameters[name] = val;
        }
        looks.push({
          id: `${args.variant_prefix}${args.name}_v${padId(i, width)}`,
          parameters,
        });
      }

      const capturedParamNames = [...seedNames].sort();
      const docBase: Omit<MorphPackDoc, "sha256"> = {
        schema: PACK_SCHEMA,
        schema_version: PACK_SCHEMA_VERSION,
        name: args.name,
        created: new Date().toISOString(),
        provenance: {
          tdmcp_version: "0.7.0",
          container_path: `${args.parent}/${args.name}`,
          target_path: args.target_path ?? "",
          target_optype: report.target_optype ?? "",
          interpolation: args.interpolation,
          captured_param_names: capturedParamNames,
        },
        looks,
      };
      const sha256 = computeMorphPackHash(docBase);
      const doc: MorphPackDoc = { ...docBase, sha256 };

      try {
        vault.write(relPath, `${JSON.stringify(doc, null, 2)}\n`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return errorResult(`Could not write pack file: ${reason}`);
      }

      const summary = `Generated ${looks.length} variant look(s) around ${args.name} → ${relPath}.`;
      return jsonResult(summary, {
        vault_path: relPath,
        looks: looks.map((l) => l.id),
        sha256,
        seed: rngSeed,
        provenance: doc.provenance,
        missing,
        warnings,
      });
    },
  );
}

export const registerVariantPack: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "variant_pack",
    {
      title: "Generate a stochastic variant pack from a seed look",
      description:
        "Generate N perturbed variants around an anchor parameter look and write the whole pack to the Obsidian vault as a morph_pack-compatible JSON. Probes the target COMP's customPars for slider ranges to clamp + integer-round per param, then perturbs each variant uniformly within ±delta_range × (normMax − normMin). The resulting file is consumed directly by morph_pack (action=unpack). Requires TDMCP_VAULT_PATH.",
      inputSchema: variantPackSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => variantPackImpl(ctx, args),
  );
};
