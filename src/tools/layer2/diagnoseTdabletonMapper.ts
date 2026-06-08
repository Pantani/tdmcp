import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const diagnoseTdabletonMapperSchema = z.object({
  parent_path: z
    .string()
    .default("/project1")
    .describe("Parent COMP/project used when auto-searching for a TDA_Mapper COMP."),
  mapper_path: z
    .string()
    .optional()
    .describe("Optional explicit path to the TDAbleton TDA_Mapper COMP."),
  source_chop: z
    .string()
    .default("/project1/hand_ableton_mapper/mapper_send")
    .describe("CHOP expected to drive the TDAbleton mapper."),
  expected_reorder: z
    .string()
    .default("map1 map2 map3 map4")
    .describe("Expected Reorder parameter value and required source channel list."),
  repair: z
    .boolean()
    .default(false)
    .describe("If true, apply best-effort mapper parameter repairs inside TouchDesigner."),
});

type DiagnoseTdabletonMapperArgs = z.infer<typeof diagnoseTdabletonMapperSchema>;

type Symptom =
  | "mapper_missing"
  | "source_missing"
  | "source_missing_channels"
  | "oscinput_mismatch"
  | "reorder_mismatch"
  | "bypass_enabled"
  | "range_not_0_1";

type ParameterValue = boolean | number | string | null;

interface DiagnoseTdabletonMapperReport {
  parent_path: string;
  repair_requested: boolean;
  expected: {
    source_chop: string;
    reorder: string;
    channels: string[];
  };
  mapper: {
    found: boolean;
    path: string | null;
    requested_path?: string;
    search_mode: "auto" | "explicit";
    candidates: string[];
    parameters: Record<string, ParameterValue>;
    bypass_enabled: string[];
    range_issues: Array<{ index: number; min: ParameterValue; max: ParameterValue }>;
  };
  source: {
    exists: boolean;
    path: string;
    channels: string[];
    missing_channels: string[];
  };
  symptoms: Symptom[];
  warnings: string[];
  repairs_applied: string[];
  remaining_symptoms?: Symptom[];
  post_repair?: {
    parameters: Record<string, ParameterValue>;
    bypass_enabled: string[];
    range_issues: Array<{ index: number; min: ParameterValue; max: ParameterValue }>;
  };
  fatal?: string;
}

const DIAGNOSE_TDABLETON_MAPPER_SCRIPT = `
import json, base64, traceback

_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
_expected_reorder = str(_p["expected_reorder"]).strip()
_expected_channels = [c for c in _expected_reorder.split() if c]

report = {
    "parent_path": _p["parent_path"],
    "repair_requested": bool(_p["repair"]),
    "expected": {
        "source_chop": _p["source_chop"],
        "reorder": _expected_reorder,
        "channels": _expected_channels,
    },
    "mapper": {
        "found": False,
        "path": None,
        "search_mode": "explicit" if _p.get("mapper_path") else "auto",
        "candidates": [],
        "parameters": {},
        "bypass_enabled": [],
        "range_issues": [],
    },
    "source": {
        "exists": False,
        "path": _p["source_chop"],
        "channels": [],
        "missing_channels": [],
    },
    "symptoms": [],
    "warnings": [],
    "repairs_applied": [],
}

_MISSING = object()


def _warn(message):
    report["warnings"].append(str(message))


def _get_op(path):
    try:
        return op(path)
    except Exception:
        return None


def _get_par(owner, name):
    try:
        return getattr(owner.par, name)
    except Exception:
        return None


def _json_value(value):
    if value is _MISSING:
        return _MISSING
    if hasattr(value, "path"):
        return str(value.path)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    return str(value)


def _read_par(owner, name):
    par = _get_par(owner, name)
    if par is None:
        return _MISSING
    try:
        return _json_value(par.eval())
    except Exception:
        try:
            return _json_value(par.val)
        except Exception as err:
            _warn("Could not read mapper parameter " + name + ": " + str(err))
            return _MISSING


def _read_mapper_params(mapper):
    params = {}
    names = ["Oscinputchop", "Reorder"]
    for idx in range(1, 5):
        names.append("Bypass" + str(idx))
        names.append("Min" + str(idx))
        names.append("Max" + str(idx))
    for name in names:
        value = _read_par(mapper, name)
        if value is not _MISSING:
            params[name] = value
    return params


def _truthy(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    return text in ("1", "true", "on", "yes")


def _float_or_none(value):
    try:
        return float(value)
    except Exception:
        return None


def _near(value, expected):
    number = _float_or_none(value)
    if number is None:
        return False
    return abs(number - expected) <= 0.000001


def _text(value):
    if value is None:
        return ""
    return str(value).strip()


def _op_matches(value, target):
    if target is None:
        return False
    if hasattr(value, "path"):
        return value.path == target.path
    text = _text(value)
    if text == target.path:
        return True
    if not text:
        return False
    target_from_text = _get_op(text)
    return target_from_text is not None and target_from_text.path == target.path


def _source_channels(source):
    try:
        return [str(ch.name) for ch in source.chans()]
    except Exception as err:
        _warn("Could not list source CHOP channels: " + str(err))
        return []


def _has_channel(source, channel):
    try:
        return source.chan(channel) is not None
    except Exception:
        return False


def _find_mapper(parent):
    explicit = _p.get("mapper_path")
    if explicit:
        report["mapper"]["requested_path"] = explicit
        return _get_op(explicit)

    candidates = []
    try:
        for child in parent.findChildren(name="TDA_Mapper", maxDepth=99):
            try:
                is_comp = bool(getattr(child, "isCOMP", False))
            except Exception:
                is_comp = False
            if is_comp:
                candidates.append(child)
    except Exception as err:
        _warn("Could not search for TDA_Mapper under parent: " + str(err))

    report["mapper"]["candidates"] = [str(c.path) for c in candidates]
    if candidates:
        return candidates[0]
    return None


def _mapper_issue_details(params):
    bypass_enabled = []
    range_issues = []

    for idx in range(1, 5):
        bypass_name = "Bypass" + str(idx)
        if bypass_name in params and _truthy(params[bypass_name]):
            bypass_enabled.append(bypass_name)

        min_name = "Min" + str(idx)
        max_name = "Max" + str(idx)
        if min_name in params and max_name in params:
            min_value = params[min_name]
            max_value = params[max_name]
            if not (_near(min_value, 0.0) and _near(max_value, 1.0)):
                range_issues.append({"index": idx, "min": min_value, "max": max_value})

    return bypass_enabled, range_issues


def _add(symptoms, name):
    if name not in symptoms:
        symptoms.append(name)


def _symptoms_for(mapper, source, params, bypass_enabled, range_issues):
    symptoms = []
    missing_channels = report["source"]["missing_channels"]

    if mapper is None:
        _add(symptoms, "mapper_missing")
    if source is None:
        _add(symptoms, "source_missing")
    elif missing_channels:
        _add(symptoms, "source_missing_channels")

    if mapper is not None:
        if source is not None and "Oscinputchop" in params:
            if not _op_matches(params["Oscinputchop"], source):
                _add(symptoms, "oscinput_mismatch")
        if "Reorder" in params and _text(params["Reorder"]) != _expected_reorder:
            _add(symptoms, "reorder_mismatch")
        if bypass_enabled:
            _add(symptoms, "bypass_enabled")
        if range_issues:
            _add(symptoms, "range_not_0_1")

    return symptoms


def _warn_for_symptoms(symptoms):
    if "mapper_missing" in symptoms:
        if _p.get("mapper_path"):
            _warn("Mapper COMP not found at " + str(_p.get("mapper_path")))
        else:
            _warn("No COMP named TDA_Mapper found under " + str(_p["parent_path"]))
    if "source_missing" in symptoms:
        _warn("Source CHOP not found at " + str(_p["source_chop"]))
    if "source_missing_channels" in symptoms:
        missing = ", ".join(report["source"]["missing_channels"])
        _warn("Source CHOP is missing expected channels: " + missing)
    if "oscinput_mismatch" in symptoms:
        actual = _text(report["mapper"]["parameters"].get("Oscinputchop"))
        _warn("Oscinputchop points at " + actual + " instead of " + str(_p["source_chop"]))
    if "reorder_mismatch" in symptoms:
        actual = _text(report["mapper"]["parameters"].get("Reorder"))
        _warn("Reorder is '" + actual + "'; expected '" + _expected_reorder + "'")
    if "bypass_enabled" in symptoms:
        _warn("Enabled bypass parameters: " + ", ".join(report["mapper"]["bypass_enabled"]))
    if "range_not_0_1" in symptoms:
        _warn("One or more Min/Max ranges are not 0..1")


def _set_par(owner, name, value):
    par = _get_par(owner, name)
    if par is None:
        return
    try:
        par.val = value
        report["repairs_applied"].append(name + "=" + str(value))
    except Exception:
        try:
            setattr(owner.par, name, value)
            report["repairs_applied"].append(name + "=" + str(value))
        except Exception as err:
            _warn("Repair failed for " + name + ": " + str(err))


def _apply_repairs(mapper, source):
    _set_par(mapper, "Oscinputchop", source.path)
    _set_par(mapper, "Reorder", _expected_reorder)
    for idx in range(1, 5):
        _set_par(mapper, "Bypass" + str(idx), False)
        _set_par(mapper, "Min" + str(idx), 0)
        _set_par(mapper, "Max" + str(idx), 1)


try:
    parent = _get_op(_p["parent_path"])
    if parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        mapper = _find_mapper(parent)
        if mapper is not None:
            report["mapper"]["found"] = True
            report["mapper"]["path"] = str(mapper.path)

        source = _get_op(_p["source_chop"])
        if source is not None:
            report["source"]["exists"] = True
            report["source"]["path"] = str(source.path)
            report["source"]["channels"] = _source_channels(source)
            report["source"]["missing_channels"] = [
                channel for channel in _expected_channels if not _has_channel(source, channel)
            ]

        if mapper is not None:
            params = _read_mapper_params(mapper)
            report["mapper"]["parameters"] = params
            bypass_enabled, range_issues = _mapper_issue_details(params)
            report["mapper"]["bypass_enabled"] = bypass_enabled
            report["mapper"]["range_issues"] = range_issues
        else:
            params = {}
            bypass_enabled = []
            range_issues = []

        symptoms = _symptoms_for(mapper, source, params, bypass_enabled, range_issues)
        report["symptoms"] = symptoms
        _warn_for_symptoms(symptoms)

        if bool(_p["repair"]) and mapper is not None and source is not None:
            _apply_repairs(mapper, source)
            post_params = _read_mapper_params(mapper)
            post_bypass_enabled, post_range_issues = _mapper_issue_details(post_params)
            report["post_repair"] = {
                "parameters": post_params,
                "bypass_enabled": post_bypass_enabled,
                "range_issues": post_range_issues,
            }
            report["remaining_symptoms"] = _symptoms_for(
                mapper,
                source,
                post_params,
                post_bypass_enabled,
                post_range_issues,
            )

except Exception:
    report["fatal"] = traceback.format_exc(limit=5)

result = json.dumps(report)
print(result)
`;

export async function diagnoseTdabletonMapperImpl(
  ctx: ToolContext,
  args: DiagnoseTdabletonMapperArgs,
): Promise<CallToolResult> {
  const payload = {
    parent_path: args.parent_path,
    mapper_path: args.mapper_path,
    source_chop: args.source_chop,
    expected_reorder: args.expected_reorder,
    repair: args.repair,
  };
  const script = buildPayloadScript(DIAGNOSE_TDABLETON_MAPPER_SCRIPT, payload);

  return guardTd(
    () => ctx.client.executePythonScript(script),
    ({ stdout }) => {
      const report = parsePythonReport<DiagnoseTdabletonMapperReport>(stdout);

      if (report.fatal) {
        return errorResult(`diagnose_tdableton_mapper failed: ${report.fatal}`, report);
      }

      const symptoms = report.symptoms ?? [];
      const warnings = report.warnings ?? [];
      const repairs = report.repairs_applied ?? [];
      const mapperPath = report.mapper?.path ?? "not found";
      const sourcePath = report.source?.exists ? report.source.path : "not found";
      const symptomSummary =
        symptoms.length === 0
          ? "no mapper symptoms found"
          : `${symptoms.length} symptom(s): ${symptoms.join(", ")}`;
      const repairSummary = args.repair ? `${repairs.length} repair(s) applied` : "repair disabled";
      const summary =
        `TDAbleton mapper diagnostic: ${symptomSummary}. ` +
        `mapper=${mapperPath}; source=${sourcePath}; ${repairSummary}; ` +
        `${warnings.length} warning(s).`;

      return jsonResult(summary, report);
    },
  );
}

export const registerDiagnoseTdabletonMapper: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "diagnose_tdableton_mapper",
    {
      title: "Diagnose TDAbleton Mapper",
      description:
        "Inspect a TouchDesigner TDAbleton mapper COMP and its source CHOP. Reports common " +
        "mapper symptoms and can optionally repair Oscinputchop, Reorder, Bypass, and Min/Max " +
        "parameters without requiring AbletonMCP or a live Ableton connection.",
      inputSchema: diagnoseTdabletonMapperSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => diagnoseTdabletonMapperImpl(ctx, args),
  );
