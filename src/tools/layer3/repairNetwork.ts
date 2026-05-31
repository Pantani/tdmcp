import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const repairNetworkSchema = z.object({
  parent_path: z.string().default("/project1").describe("Root of the subtree to scan + repair."),
  max_steps: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe("Hard cap on repair attempts — the bound that prevents runaway repair."),
  dry_run: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), only PLAN fixes (no changes applied). Set false to apply within the bound.",
    ),
});
type RepairNetworkArgs = z.infer<typeof repairNetworkSchema>;

interface RepairStep {
  /** Path of the operator the planned fix targets. */
  node: string;
  /** The error message that triggered this step. */
  error: string;
  /** Plain-language description of the fix we planned. */
  planned_fix: string;
  /** Classification bucket for the fix (e.g. "clear_expression", "enable_op", "note"). */
  kind: string;
  /** True only when the fix was actually applied to TD (never true in dry_run). */
  applied: boolean;
}

interface RemainingError {
  /** Path of the operator still reporting an error after the bounded loop. */
  node: string;
  /** The residual error message. */
  error: string;
}

interface RepairNetworkReport {
  parent_path: string;
  dry_run: boolean;
  max_steps: number;
  errors_before: number;
  errors_after: number;
  steps: RepairStep[];
  remaining: RemainingError[];
  warnings: string[];
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Python bridge script — the WHOLE bounded loop runs server-side in one pass.
//
// Discipline this tool exists to enforce:
//   * BOUNDED — it never plans/applies more than `max_steps` fixes.
//   * DRY-RUN by default — with dry_run=true it classifies + plans only and
//     touches nothing, so it can never run away.
//
// Auto-fix classes (only known-safe ones are applied; everything else is
// PLAN-ONLY even when dry_run=false):
//   * clear_expression — a parameter stuck in expression/export mode whose
//     broken expression is the cook error: reset that par's mode back to
//     constant (ParMode.CONSTANT) so the bad expression stops cooking. SAFE.
//   * enable_op — an op left bypassed or display-off that is reporting an
//     error: clear .bypass / set .display back on. SAFE (a flag toggle).
//   * note — DAT syntax errors, missing-input warnings, and anything we cannot
//     classify confidently: recorded as a planned_fix with kind "note" and
//     NEVER applied (applied stays false regardless of dry_run).
//
// Par-name / API notes (probed at runtime where they vary by build):
//   * op.errors(recurse=True) — preferred; falls back to errors() with no args.
//   * Par.mode / ParMode.CONSTANT — read from the live `ParMode` global; if it
//     is unavailable we record a warning and leave the par untouched (no guess).
//   * op.bypass / op.display — flags exist on most COMP/TOP/CHOP families; reads
//     and writes are wrapped so a missing attr degrades to a warning, not a crash.
// All of the above are UNVERIFIED-live until run against a real TD build.
// ---------------------------------------------------------------------------
const REPAIR_NETWORK_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "parent_path": _p["parent_path"],
    "dry_run": bool(_p["dry_run"]),
    "max_steps": int(_p["max_steps"]),
    "errors_before": 0,
    "errors_after": 0,
    "steps": [],
    "remaining": [],
    "warnings": [],
}


def _collect_errors(root):
    """Return a flat list of (op, message) under root, including root itself."""
    out = []
    try:
        _kids = list(root.findChildren(type=baseCOMP)) if False else None
    except Exception:
        _kids = None
    # Walk root + all descendants regardless of family.
    _ops = [root]
    try:
        _ops.extend(root.findChildren(depth=10))
    except Exception:
        try:
            _ops.extend(root.findChildren())
        except Exception as _e:
            report["warnings"].append("findChildren: " + str(_e))
    for _o in _ops:
        try:
            try:
                _errs = _o.errors(recurse=False)
            except TypeError:
                _errs = _o.errors()
        except Exception:
            _errs = None
        if _errs:
            for _e in _errs:
                for _line in str(_e).splitlines():
                    if _line.strip():
                        out.append((_o, _line.strip()))
    return out


def _classify(_o, _msg):
    """Return (kind, planned_fix, safe_to_apply) for one error."""
    _low = _msg.lower()
    # DAT / script syntax errors — never auto-fixed (needs human edit).
    if ("syntax" in _low) or ("traceback" in _low) or ("indentation" in _low):
        return ("note", "DAT/script syntax error — needs a manual edit; left as-is.", False)
    # Broken parameter expression — the safe fix is to reset the par to constant.
    if ("expression" in _low) or ("invalid" in _low and "par" in _low) or ("name '" in _low):
        return (
            "clear_expression",
            "Reset the broken parameter expression to constant mode.",
            True,
        )
    # Bypassed / disabled op that still errors — safe to re-enable.
    if ("bypass" in _low) or ("disabled" in _low):
        return ("enable_op", "Re-enable the bypassed/disabled operator.", True)
    # Missing input — informative only; we cannot guess the wiring.
    if ("input" in _low) and ("missing" in _low or "no input" in _low or "requires" in _low):
        return ("note", "Missing input — note only; wiring left to the caller.", False)
    return ("note", "Unclassified error — left as-is for manual review.", False)


def _apply_clear_expression(_o):
    """Reset any expression/export-mode par on this op back to constant. Returns
    True if at least one par mode was changed."""
    _changed = False
    try:
        _const = None
        try:
            _const = ParMode.CONSTANT  # noqa: F821 — live bridge global
        except Exception:
            _const = None
        if _const is None:
            report["warnings"].append(
                "ParMode.CONSTANT unavailable — cannot reset expression on " + _o.path
            )
            return False
        for _par in _o.pars():
            try:
                if _par.mode != _const:
                    _par.mode = _const
                    _changed = True
            except Exception:
                pass
    except Exception as _e:
        report["warnings"].append("clear_expression on " + _o.path + ": " + str(_e))
    return _changed


def _apply_enable_op(_o):
    """Clear bypass / turn display on. Returns True if a flag was changed."""
    _changed = False
    try:
        if getattr(_o, "bypass", False):
            try:
                _o.bypass = False
                _changed = True
            except Exception:
                pass
    except Exception:
        pass
    try:
        if getattr(_o, "display", True) is False:
            try:
                _o.display = True
                _changed = True
            except Exception:
                pass
    except Exception:
        pass
    return _changed


try:
    _root = op(_p["parent_path"])
    if _root is None:
        report["fatal"] = "Not found: " + str(_p["parent_path"])
    else:
        _errors = _collect_errors(_root)
        report["errors_before"] = len(_errors)
        _budget = int(_p["max_steps"])
        for (_o, _msg) in _errors:
            if len(report["steps"]) >= _budget:
                break
            _kind, _fix, _safe = _classify(_o, _msg)
            _applied = False
            if (not report["dry_run"]) and _safe:
                if _kind == "clear_expression":
                    _applied = _apply_clear_expression(_o)
                elif _kind == "enable_op":
                    _applied = _apply_enable_op(_o)
            report["steps"].append({
                "node": _o.path,
                "error": _msg,
                "planned_fix": _fix,
                "kind": _kind,
                "applied": bool(_applied),
            })
        # Re-read errors after any applied fixes; in dry_run nothing changed so
        # the count is identical to errors_before by construction.
        if report["dry_run"]:
            _after = _errors
        else:
            _after = _collect_errors(_root)
        report["errors_after"] = len(_after)
        for (_o, _msg) in _after:
            report["remaining"].append({"node": _o.path, "error": _msg})
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildRepairNetworkScript(payload: object): string {
  return buildPayloadScript(REPAIR_NETWORK_SCRIPT, payload);
}

export async function repairNetworkImpl(ctx: ToolContext, args: RepairNetworkArgs) {
  return guardTd(
    async () => {
      const script = buildRepairNetworkScript({
        parent_path: args.parent_path,
        max_steps: args.max_steps,
        dry_run: args.dry_run,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<RepairNetworkReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`repair_network failed: ${report.fatal}`, report);
      }
      const appliedCount = report.steps.filter((s) => s.applied).length;
      const planned = report.steps.length;
      const mode = report.dry_run ? "dry-run (planned only)" : "applied";
      const cleared = report.errors_before - report.errors_after;
      const clearedPart = !report.dry_run && cleared > 0 ? `, cleared ${cleared} error(s)` : "";
      const summary =
        report.errors_before === 0
          ? `No errors under ${report.parent_path} — nothing to repair.`
          : `repair_network ${mode}: ${planned} step(s) (${appliedCount} applied) within max_steps=${report.max_steps}; ${report.errors_after}/${report.errors_before} error(s) remain${clearedPart}.`;
      return jsonResult(summary, report);
    },
  );
}

export const registerRepairNetwork: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "repair_network",
    {
      title: "Repair network (bounded)",
      description:
        "Bounded, autonomous repair: scan cook errors under a subtree, classify each, and plan a safe fix, capped at max_steps so it can never run away. Defaults to dry_run (PLAN only, no changes). Set dry_run:false to apply the known-safe fixes — resetting a broken parameter expression to constant mode, and re-enabling a bypassed/display-off op — within the same bound; risky cases (DAT syntax errors, missing inputs, unclassified errors) are always PLAN-only. Re-checks errors after applying and stops at the bound or when errors clear. Returns {parent_path, dry_run, max_steps, errors_before, errors_after, steps[], remaining[], warnings}. Use it as the diagnostic 'try the obvious safe fixes' loop after a build; for raw triage use summarize_td_errors / get_td_node_errors instead.",
      inputSchema: repairNetworkSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => repairNetworkImpl(ctx, args),
  );
};
