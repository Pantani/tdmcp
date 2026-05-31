import { createHash } from "node:crypto";
import { z } from "zod";
import { buildPresetMorphScript } from "../layer2/createPresetMorph.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { requireVault } from "./shared.js";

const PACK_SCHEMA = "tdmcp.morphpack";
const PACK_SCHEMA_VERSION = 1;

export const morphPackSchema = z.object({
  action: z
    .enum(["pack", "unpack"])
    .describe(
      "pack: read an existing create_preset_morph container and serialise its slots to a vault JSON. unpack: re-hydrate a pack file into a (newly built if missing) create_preset_morph container, optionally rebinding to a new target.",
    ),
  name: z
    .string()
    .describe(
      "Pack name. Used as the JSON filename (<folder>/<name>.morphpack.json) and the morph container default name on unpack.",
    ),
  parent: z
    .string()
    .default("/project1")
    .describe(
      "(pack) Parent COMP holding the existing morph container (defaults to /project1, matches create_preset_morph). (unpack) Parent COMP where the container is (re)built.",
    ),
  container: z
    .string()
    .optional()
    .describe(
      "(pack) Name of the existing morph container inside `parent` to read from. Defaults to `name`. (unpack) Name to (re)build; defaults to `name`.",
    ),
  target_path: z
    .string()
    .optional()
    .describe(
      "(unpack) Override the target_path stored in the pack provenance (use when the pack came from a different show file and the target's path is different here). Omit to reuse pack provenance.target_path.",
    ),
  looks: z
    .array(
      z.object({
        id: z.string().describe("Slot name (matches create_preset_morph slots)."),
        parameters: z
          .record(z.string(), z.coerce.number())
          .describe("Param-name -> numeric value snapshot for this slot."),
      }),
    )
    .optional()
    .describe(
      "(unpack, advanced) Inline-supply the slot set instead of reading vaultPath. Mutually exclusive with vaultPath on unpack; ignored on pack.",
    ),
  vault_path: z
    .string()
    .optional()
    .describe(
      "Vault-relative path to the pack file. Defaults to `MorphPacks/<name>.morphpack.json`. Resolved through Vault.resolve (cannot escape the vault root).",
    ),
  overwrite: z
    .boolean()
    .default(false)
    .describe("(pack) Overwrite an existing pack file at vault_path."),
  merge: z
    .enum(["replace", "union"])
    .default("replace")
    .describe(
      "(unpack) replace: wipe presets and write only the pack's slots. union: keep existing slots and add/overwrite the pack's slots by id.",
    ),
});
export type MorphPackArgs = z.infer<typeof morphPackSchema>;

export interface MorphLook {
  id: string;
  parameters: Record<string, number>;
}

export interface MorphPackProvenance {
  tdmcp_version: string;
  container_path: string;
  target_path: string;
  target_optype: string;
  interpolation: string;
  captured_param_names: string[];
}

export interface MorphPackDoc {
  schema: typeof PACK_SCHEMA;
  schema_version: number;
  name: string;
  created: string;
  provenance: MorphPackProvenance;
  looks: MorphLook[];
  sha256: string;
}

interface PackReadReport {
  container?: string;
  target?: string;
  target_optype?: string;
  interpolation?: string;
  slots?: string[];
  params_by_slot?: Record<string, Record<string, number>>;
  container_missing?: boolean;
  warnings: string[];
  fatal?: string;
}

interface UnpackWriteReport {
  container?: string;
  target?: string;
  container_missing?: boolean;
  slots_written?: string[];
  slots_skipped?: string[];
  warnings: string[];
  fatal?: string;
}

// Read the existing morph container's presets table + provenance storage.
// Returns container_missing=true (without fatal) so unpack can build first.
const PACK_READ_SCRIPT = `
import json, base64, traceback, ast
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"warnings": []}
try:
    _c = op(_p["container"])
    if _c is None:
        report["container_missing"] = True
    else:
        report["container"] = _c.path
        _pres = _c.op("presets")
        if _pres is None:
            report["fatal"] = "Container has no 'presets' Table DAT: " + _c.path
        else:
            _slots = []
            _params_by_slot = {}
            _ncols = _pres.numCols
            _nrows = _pres.numRows
            # col 0 = param-name header; data slots are cols 1..N
            for _ci in range(1, _ncols):
                _slot = str(_pres[0, _ci].val)
                if not _slot:
                    continue
                _slots.append(_slot)
                _pmap = {}
                for _ri in range(1, _nrows):
                    _pname = str(_pres[_ri, 0].val)
                    _raw = str(_pres[_ri, _ci].val)
                    if _pname == "" or _raw == "":
                        continue
                    try:
                        _v = ast.literal_eval(_raw)
                    except Exception:
                        try:
                            _v = float(_raw)
                        except Exception:
                            report["warnings"].append("Non-numeric cell skipped: " + _slot + "/" + _pname + "=" + _raw)
                            continue
                    if isinstance(_v, bool):
                        _v = 1.0 if _v else 0.0
                    elif isinstance(_v, (int, float)):
                        _v = float(_v)
                    else:
                        report["warnings"].append("Non-scalar cell skipped: " + _slot + "/" + _pname)
                        continue
                    _pmap[_pname] = _v
                _params_by_slot[_slot] = _pmap
            report["slots"] = _slots
            report["params_by_slot"] = _params_by_slot
            try:
                report["target"] = _c.fetch("tdmcp_preset_morph_target", "")
            except Exception:
                report["target"] = ""
            try:
                _meta = _c.fetch("tdmcp_preset_morph", {})
                if isinstance(_meta, dict):
                    report["interpolation"] = _meta.get("interpolation", "linear")
                else:
                    report["interpolation"] = "linear"
            except Exception:
                report["interpolation"] = "linear"
            _tgt = report.get("target")
            if _tgt:
                _to = op(_tgt)
                report["target_optype"] = _to.OPType if _to is not None else ""
            else:
                report["target_optype"] = ""
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

// Write looks into the container's presets Table DAT.
const UNPACK_WRITE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"slots_written": [], "slots_skipped": [], "warnings": []}
try:
    _c = op(_p["container"])
    if _c is None:
        report["container_missing"] = True
        report["fatal"] = "Container not found after build: " + str(_p["container"])
    else:
        report["container"] = _c.path
        _pres = _c.op("presets")
        if _pres is None:
            report["fatal"] = "Container has no 'presets' Table DAT: " + _c.path
        else:
            _merge = _p.get("merge", "replace")
            _looks = _p.get("looks", [])
            if _merge == "replace":
                # Drop every data column (keep col 0 = param header).
                while _pres.numCols > 1:
                    _pres.deleteCol(_pres.numCols - 1)

            def _header_cols():
                return [str(_pres[0, _ci].val) for _ci in range(_pres.numCols)]

            def _row_index(_pname):
                for _ri in range(1, _pres.numRows):
                    if str(_pres[_ri, 0].val) == _pname:
                        return _ri
                _pres.appendRow([_pname])
                return _pres.numRows - 1

            for _look in _looks:
                _slot = _look.get("id")
                _params = _look.get("parameters") or {}
                if not _slot:
                    report["slots_skipped"].append("<empty-id>")
                    continue
                _hdr = _header_cols()
                if _slot in _hdr[1:]:
                    _ci = _hdr.index(_slot)
                else:
                    _pres.appendCol([_slot])
                    _ci = _pres.numCols - 1
                for _pname, _pval in _params.items():
                    _ri = _row_index(str(_pname))
                    _pres[_ri, _ci] = repr(float(_pval))
                report["slots_written"].append(_slot)
            try:
                _tgt = _p.get("target_path")
                if _tgt:
                    _c.store("tdmcp_preset_morph_target", _tgt)
                report["target"] = _c.fetch("tdmcp_preset_morph_target", "")
            except Exception:
                report["target"] = ""
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildMorphPackReadScript(payload: object): string {
  return buildPayloadScript(PACK_READ_SCRIPT, payload);
}

export function buildMorphPackWriteScript(payload: object): string {
  return buildPayloadScript(UNPACK_WRITE_SCRIPT, payload);
}

/** Canonical JSON for sha256: stable key order, blanked sha256 field. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export function computeMorphPackHash(
  doc: Omit<MorphPackDoc, "sha256"> & { sha256?: string },
): string {
  const blanked = { ...doc, sha256: "" };
  return createHash("sha256").update(canonicalize(blanked)).digest("hex");
}

function capturedParamUnion(looks: MorphLook[]): string[] {
  const set = new Set<string>();
  for (const look of looks) {
    for (const k of Object.keys(look.parameters)) set.add(k);
  }
  return [...set].sort();
}

function defaultVaultPath(name: string): string {
  return `MorphPacks/${name}.morphpack.json`;
}

async function doPack(ctx: ToolContext, args: MorphPackArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const containerName = args.container ?? args.name;
  const containerPath = `${args.parent}/${containerName}`;
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

  return guardTd(
    async () => {
      const script = buildMorphPackReadScript({ container: containerPath });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<PackReadReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) return errorResult(`Pack read failed: ${report.fatal}`, report);
      if (report.container_missing) {
        return errorResult(
          `Morph container not found: ${containerPath}. Build it first with create_preset_morph (action=build).`,
        );
      }
      const paramsBySlot = report.params_by_slot ?? {};
      const slots = report.slots ?? Object.keys(paramsBySlot);
      const looks: MorphLook[] = slots.map((id) => ({
        id,
        parameters: paramsBySlot[id] ?? {},
      }));
      const docBase: Omit<MorphPackDoc, "sha256"> = {
        schema: PACK_SCHEMA,
        schema_version: PACK_SCHEMA_VERSION,
        name: args.name,
        created: new Date().toISOString(),
        provenance: {
          tdmcp_version: "0.9.0",
          container_path: report.container ?? containerPath,
          target_path: report.target ?? "",
          target_optype: report.target_optype ?? "",
          interpolation: report.interpolation ?? "linear",
          captured_param_names: capturedParamUnion(looks),
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

      const summary = `Packed ${looks.length} look(s) from ${docBase.provenance.container_path} → ${relPath}.`;
      return jsonResult(summary, {
        vault_path: relPath,
        looks: looks.map((l) => l.id),
        sha256,
        provenance: doc.provenance,
        warnings: report.warnings ?? [],
      });
    },
  );
}

async function doUnpack(ctx: ToolContext, args: MorphPackArgs) {
  const v = requireVault(ctx);
  if ("error" in v) return v.error;
  const { vault } = v;

  const containerName = args.container ?? args.name;
  const containerPath = `${args.parent}/${containerName}`;
  const warnings: string[] = [];

  // Resolve the slot set: either inline `looks` or a pack file from the vault.
  let looks: MorphLook[];
  let provenance: MorphPackProvenance | undefined;
  let schemaName = PACK_SCHEMA;

  if (args.looks && args.looks.length > 0) {
    looks = args.looks.map((l) => ({ id: l.id, parameters: { ...l.parameters } }));
  } else {
    const relPath = args.vault_path ?? defaultVaultPath(args.name);
    try {
      vault.resolve(relPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return errorResult(`Invalid vault path: ${reason}`);
    }
    if (!vault.exists(relPath)) {
      return errorResult(
        `Pack file not found: ${relPath}. Pass inline 'looks' or pack one first with action=pack.`,
      );
    }
    let raw: string;
    try {
      raw = vault.read(relPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return errorResult(`Could not read pack file ${relPath}: ${reason}`);
    }
    let parsed: MorphPackDoc;
    try {
      parsed = JSON.parse(raw) as MorphPackDoc;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return errorResult(`Pack file is not valid JSON (${relPath}): ${reason}`);
    }
    if (parsed.schema !== PACK_SCHEMA) {
      return errorResult(
        `Pack file has unknown schema "${parsed.schema}" (expected "${PACK_SCHEMA}").`,
      );
    }
    if (typeof parsed.schema_version !== "number" || parsed.schema_version > PACK_SCHEMA_VERSION) {
      return errorResult(
        `Pack file schema_version ${parsed.schema_version} is newer than this tdmcp supports (max ${PACK_SCHEMA_VERSION}). Upgrade tdmcp to unpack it.`,
      );
    }
    // sha256 verify (warning, not fatal)
    const expected = parsed.sha256;
    const recomputed = computeMorphPackHash(parsed);
    if (expected && expected !== recomputed) {
      warnings.push(
        `Pack sha256 mismatch (file may have been hand-edited): expected ${expected}, got ${recomputed}.`,
      );
    }
    looks = Array.isArray(parsed.looks) ? parsed.looks : [];
    provenance = parsed.provenance;
    schemaName = parsed.schema;
  }

  const effectiveTargetPath = args.target_path ?? provenance?.target_path ?? "";
  const interpolation =
    (provenance?.interpolation as "linear" | "cosine" | "cubic" | undefined) ?? "linear";

  return guardTd(
    async () => {
      // Probe the container first.
      const probeScript = buildMorphPackReadScript({ container: containerPath });
      const probeExec = await ctx.client.executePythonScript(probeScript, true);
      const probe = parsePythonReport<PackReadReport>(probeExec.stdout);

      // Build the container first if missing (or if a fatal indicates a missing op).
      if (probe.container_missing) {
        if (!effectiveTargetPath) {
          return {
            fatal:
              "Container is missing and no target_path is available (pack provenance has none — pass target_path).",
            warnings,
            slots_written: [],
            slots_skipped: [],
          } satisfies UnpackWriteReport;
        }
        const buildScript = buildPresetMorphScript({
          action: "build",
          parent_path: args.parent,
          name: containerName,
          target_path: effectiveTargetPath,
          interpolation,
        });
        const buildExec = await ctx.client.executePythonScript(buildScript, true);
        const buildReport = parsePythonReport<{ fatal?: string; warnings?: string[] }>(
          buildExec.stdout,
        );
        if (buildReport.fatal) {
          return {
            fatal: `Container build failed: ${buildReport.fatal}`,
            warnings,
            slots_written: [],
            slots_skipped: [],
          } satisfies UnpackWriteReport;
        }
        if (buildReport.warnings) warnings.push(...buildReport.warnings);
      }

      const writeScript = buildMorphPackWriteScript({
        container: containerPath,
        merge: args.merge,
        looks,
        target_path: effectiveTargetPath || undefined,
      });
      const writeExec = await ctx.client.executePythonScript(writeScript, true);
      const writeReport = parsePythonReport<UnpackWriteReport>(writeExec.stdout);
      writeReport.warnings = [...warnings, ...(writeReport.warnings ?? [])];
      return writeReport;
    },
    (report) => {
      if (report.fatal) return errorResult(`Unpack failed: ${report.fatal}`, report);
      const written = report.slots_written ?? [];
      const summary = `Unpacked ${written.length} look(s) into ${report.container ?? containerPath} (merge=${args.merge}, schema=${schemaName}).`;
      return jsonResult(summary, {
        container: report.container ?? containerPath,
        target: report.target ?? effectiveTargetPath,
        slots_written: written,
        slots_skipped: report.slots_skipped ?? [],
        warnings: report.warnings ?? [],
      });
    },
  );
}

export async function morphPackImpl(ctx: ToolContext, args: MorphPackArgs) {
  if (args.action === "pack") return doPack(ctx, args);
  return doUnpack(ctx, args);
}

export const registerMorphPack: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "morph_pack",
    {
      title: "Pack / unpack a create_preset_morph slot set to a vault JSON",
      description:
        "Export an existing create_preset_morph container's slots ('looks') to a portable, sha256-verified JSON file in the Obsidian vault (action=pack), or re-hydrate a pack file back into a (newly built if missing) create_preset_morph container (action=unpack). Reuses the create_preset_morph engine — does not invent a new morph topology. Requires TDMCP_VAULT_PATH unless inline 'looks' are supplied on unpack.",
      inputSchema: morphPackSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => morphPackImpl(ctx, args),
  );
};
