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
  /** True when this applied step was reverted by the rollback pass after a regression. */
  reverted?: boolean;
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
  /**
   * True when the applied fixes were reverted because errors_after did not
   * improve over errors_before. Always false in dry_run, and always false when
   * errors_before was already 0 (no regression possible).
   */
  rolled_back: boolean;
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
//   * clear_expression — a named parameter stuck in expression/export mode
//     whose broken expression is the cook error: reset that specific par's mode
//     back to constant (ParMode.CONSTANT) so the bad expression stops cooking.
//     Ambiguous expression errors are planned but left untouched. SAFE.
//   * enable_op — an op left bypassed or display-off that is reporting an
//     error: clear .bypass / set .display back on. SAFE (a flag toggle).
//   * note — DAT syntax errors, missing-input warnings, and anything we cannot
//     classify confidently: recorded as a planned_fix with kind "note" and
//     NEVER applied (applied stays false regardless of dry_run).
//
// Par-name / API notes (probed at runtime where they vary by build):
//   * op.errors(recurse=False) — per-op only; _collect_errors walks descendants
//     itself, so recurse=False avoids double-counting. Falls back to errors() with
//     no args on older TD builds that don't accept the keyword.
//   * Par.mode / ParMode.CONSTANT — read from the live `ParMode` global; if it
//     is unavailable, or if the error does not name a specific parameter, we
//     record a warning and leave the par untouched (no guess).
//   * op.bypass / op.display — flags exist on most COMP/TOP/CHOP families; reads
//     and writes are wrapped so a missing attr degrades to a warning, not a crash.
// All of the above are UNVERIFIED-live until run against a real TD build.
// ---------------------------------------------------------------------------
const REPAIR_NETWORK_SCRIPT = `
import json, base64, re, traceback
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
    "rolled_back": False,
}


def _collect_errors(root):
    """Return a flat list of (op, message) under root, including root itself."""
    out = []
    # Walk root + all descendants regardless of family.
    _ops = [root]
    try:
        _ops.extend(root.findChildren())
    except Exception:
        try:
            _stack = list(root.children)
            while _stack:
                _child = _stack.pop()
                _ops.append(_child)
                try:
                    _stack.extend(list(_child.children))
                except Exception:
                    pass
        except Exception as _e:
            report["warnings"].append("findChildren/manual walk: " + str(_e))
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
    # Broken parameter expression — the safe fix is to reset the named par to constant.
    if (
        ("expression" in _low)
        or ("invalid" in _low and "par" in _low)
        or ("name '" in _low and ("expression" in _low or "par" in _low or "parameter" in _low))
    ):
        return (
            "clear_expression",
            "Reset the named broken parameter expression to constant mode.",
            True,
        )
    # Bypassed / disabled op that still errors — safe to re-enable.
    if ("bypass" in _low) or ("disabled" in _low):
        return ("enable_op", "Re-enable the bypassed/disabled operator.", True)
    # Missing input — informative only; we cannot guess the wiring.
    if ("input" in _low) and ("missing" in _low or "no input" in _low or "requires" in _low):
        return ("note", "Missing input — note only; wiring left to the caller.", False)
    return ("note", "Unclassified error — left as-is for manual review.", False)


def _message_targets_par(_name, _msg):
    """Return true when the error text names this specific parameter."""
    _escaped = re.escape(str(_name).lower())
    _low = str(_msg).lower()
    _patterns = (
        r"(?:par|parameter)\\s*[:=]?\\s*['\\"]?" + _escaped + r"['\\"]?",
        r"\\.par\\." + _escaped + r"\\b",
        r"\\['" + _escaped + r"'\\]",
        r'\\["' + _escaped + r'"\\]',
        r"['\\"]" + _escaped + r"['\\"]",
    )
    return any(re.search(_pat, _low) for _pat in _patterns)


def _target_expression_pars(_o, _msg):
    """Find only the par(s) named by this expression error. Empty means no-op."""
    _targets = []
    try:
        _pars = _o.pars()
    except Exception as _e:
        report["warnings"].append("pars() while clearing expression on " + _o.path + ": " + str(_e))
        return _targets
    for _par in _pars:
        try:
            _name = getattr(_par, "name", "")
        except Exception:
            _name = ""
        if _name and _message_targets_par(_name, _msg):
            _targets.append(_par)
    if not _targets:
        report["warnings"].append(
            "expression error did not identify a specific parameter on "
            + _o.path
            + "; left expressions unchanged"
        )
    return _targets


_snapshot = []  # forward-declared for helpers; cleared inside the main try below


def _apply_clear_expression(_o, _msg):
    """Reset only the expression/export-mode par named in this error."""
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
        for _par in _target_expression_pars(_o, _msg):
            try:
                if _par.mode != _const:
                    _snapshot.append({"kind": "par_mode", "par": _par, "mode": _par.mode})
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
        _prev_bypass = getattr(_o, "bypass", False)
        if _prev_bypass:
            try:
                _snapshot.append({"kind": "op_bypass", "op": _o, "bypass": _prev_bypass})
                _o.bypass = False
                _changed = True
            except Exception:
                pass
    except Exception:
        pass
    try:
        _prev_display = getattr(_o, "display", True)
        if _prev_display is False:
            try:
                _snapshot.append({"kind": "op_display", "op": _o, "display": _prev_display})
                _o.display = True
                _changed = True
            except Exception:
                pass
    except Exception:
        pass
    return _changed


def _rollback_snapshot():
    """Revert each captured mutation in reverse order. Returns True when every
    entry restored cleanly; False if any single revert raised (so the caller can
    avoid claiming a successful rollback / falsely marking steps as reverted)."""
    _ok = True
    for _entry in reversed(_snapshot):
        try:
            _k = _entry.get("kind")
            if _k == "par_mode":
                _entry["par"].mode = _entry["mode"]
            elif _k == "op_bypass":
                _entry["op"].bypass = _entry["bypass"]
            elif _k == "op_display":
                _entry["op"].display = _entry["display"]
        except Exception as _e:
            _ok = False
            report["warnings"].append("rollback failed for " + str(_entry.get("kind")) + ": " + str(_e))
    return _ok


try:
    # Reset snapshot per invocation: the bridge may keep module globals across
    # calls, so a stale list from a previous repair would corrupt rollback.
    _snapshot = []
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
                    _applied = _apply_clear_expression(_o, _msg)
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
        # Rollback: if we mutated TD and the regression check shows no
        # improvement (errors_after >= errors_before with errors_before > 0),
        # revert every mutation we made so the artist's graph returns to its
        # pre-repair state. Dry-run never mutates so there is nothing to revert.
        if (
            (not report["dry_run"])
            and report["errors_before"] > 0
            and report["errors_after"] >= report["errors_before"]
            and _snapshot
        ):
            _ok = _rollback_snapshot()
            if _ok:
                report["rolled_back"] = True
                for _step in report["steps"]:
                    if _step.get("applied"):
                        _step["reverted"] = True
            else:
                # Partial rollback failure — do not claim a clean revert.
                report["rolled_back"] = False
            # Re-read errors after rollback so the report reflects the restored state.
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
  const parsed = repairNetworkSchema.safeParse(args);
  if (!parsed.success) return errorResult(`Invalid arguments: ${parsed.error.message}`);
  const { parent_path, max_steps, dry_run } = parsed.data;
  return guardTd(
    async () => {
      const script = buildRepairNetworkScript({
        parent_path,
        max_steps,
        dry_run,
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
      const rollbackPart = report.rolled_back
        ? " Rolled back: yes (no improvement, applied fixes reverted to snapshot)."
        : "";
      const summary =
        report.errors_before === 0
          ? `No errors under ${report.parent_path} — nothing to repair.`
          : `repair_network ${mode}: ${planned} step(s) (${appliedCount} applied) within max_steps=${report.max_steps}; ${report.errors_after}/${report.errors_before} error(s) remain${clearedPart}.${rollbackPart}`;
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
        "Bounded, autonomous repair: scan cook errors under a subtree, classify each, and plan a safe fix, capped at max_steps so it can never run away. Defaults to dry_run (PLAN only, no changes). Set dry_run:false to apply the known-safe fixes — resetting a broken parameter expression to constant mode, and re-enabling a bypassed/display-off op — within the same bound; risky cases (DAT syntax errors, missing inputs, unclassified errors) are always PLAN-only. Re-checks errors after applying and stops at the bound or when errors clear. Returns {parent_path, dry_run, max_steps, errors_before, errors_after, steps[], remaining[], warnings, rolled_back}. Use it as the diagnostic 'try the obvious safe fixes' loop after a build; for raw triage use summarize_td_errors / get_td_node_errors instead.",
      inputSchema: repairNetworkSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => repairNetworkImpl(ctx, args),
  );
};
