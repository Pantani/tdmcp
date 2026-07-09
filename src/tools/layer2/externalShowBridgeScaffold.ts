import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext } from "../types.js";

type Scalar = string | number | boolean | null;

export interface ExternalShowNodeSpec {
  name: string;
  optype: string;
  x: number;
  y: number;
  params?: Record<string, Scalar>;
  text?: string;
  table?: string[][];
}

export interface ExternalShowConnectionSpec {
  from: string;
  to: string;
  input?: number;
}

export interface ExternalShowScaffoldPayload {
  kind: string;
  parent_path: string;
  name: string;
  metadata: Record<string, Scalar | Scalar[] | Record<string, Scalar>>;
  nodes: ExternalShowNodeSpec[];
  connections?: ExternalShowConnectionSpec[];
  warnings: string[];
}

export interface ExternalShowScaffoldReport {
  kind?: string;
  container_path?: string;
  nodes?: Record<string, string>;
  metadata?: Record<string, unknown>;
  warnings: string[];
  fatal?: string;
}

const EXTERNAL_SHOW_SCAFFOLD_SCRIPT = `
import json, base64, traceback
import platform
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "kind": _p.get("kind"),
    "nodes": {},
    "metadata": _p.get("metadata", {}),
    "warnings": list(_p.get("warnings", [])),
}

def _warn(message):
    report["warnings"].append(str(message))

def _place(node, x, y):
    if node is None:
        return
    try:
        node.nodeX = float(x)
        node.nodeY = float(y)
    except Exception:
        pass
    _place_generated_callbacks(node, float(x) + 140.0, float(y) - 120.0)

def _place_generated_callbacks(node, x, y):
    try:
        callback = node.parent().op(node.name + "_callbacks")
        if callback is not None and callback.path != node.path:
            callback.nodeX = float(x)
            callback.nodeY = float(y)
    except Exception:
        pass

def _free_x(parent, y, start=0.0, step=280.0, exclude=None):
    try:
        occupied = set()
        for child in parent.children:
            if exclude is not None and getattr(child, "path", None) == getattr(exclude, "path", None):
                continue
            try:
                if abs(float(child.nodeY) - float(y)) < 1.0:
                    occupied.add(round(float(child.nodeX) / step) * step)
            except Exception:
                continue
        x = float(start)
        while round(x / step) * step in occupied:
            x += step
        return x
    except Exception:
        return float(start)

def _optype(name):
    return globals().get(str(name))

def _is_non_windows():
    try:
        return not platform.system().lower().startswith("win")
    except Exception:
        return True

def _create_platform_placeholder(parent, existing, name, optype_name):
    if getattr(existing, "type", None) == "textDAT":
        return existing
    _warn(
        "%s is supported only on specific show-output platforms; replaced %s with a textDAT placeholder on this OS."
        % (optype_name, name)
    )
    if existing is not None:
        try:
            existing.destroy()
        except Exception as exc:
            _warn("Could not replace platform-specific %s %s: %s" % (optype_name, name, exc))
            return existing
    placeholder = parent.op(name)
    if placeholder is None:
        try:
            placeholder = parent.create(textDAT, name)
        except Exception as exc:
            _warn("Could not create placeholder for platform-specific %s %s: %s" % (optype_name, name, exc))
            return None
    try:
        placeholder.text = "\\n".join([
            optype_name + " platform placeholder",
            "This operator is not supported on this operating system.",
            "Validate this scaffold on the target show machine before enabling live output.",
        ])
    except Exception:
        pass
    return placeholder

def _needs_platform_placeholder(optype_name):
    return _is_non_windows() and optype_name in ("pangolinCHOP", "directdisplayoutTOP")

def _error_messages(node):
    messages = []
    try:
        errors = node.errors()
        if isinstance(errors, str):
            messages.extend([line.strip() for line in errors.splitlines() if line.strip()])
        else:
            messages.extend([str(error).strip() for error in errors if str(error).strip()])
    except Exception:
        pass
    return messages

def _replace_unsupported_node(parent, node, name, optype_name):
    messages = _error_messages(node)
    if not any("not supported on this operating system" in message.lower() for message in messages):
        return node
    _warn(
        "%s is not supported on this operating system; replaced %s with a textDAT placeholder."
        % (optype_name, name)
    )
    try:
        node.destroy()
    except Exception as exc:
        _warn("Could not replace unsupported %s %s: %s" % (optype_name, name, exc))
        return node
    placeholder = parent.op(name)
    if placeholder is None:
        try:
            placeholder = parent.create(textDAT, name)
        except Exception as exc:
            _warn("Could not create placeholder for unsupported %s %s: %s" % (optype_name, name, exc))
            return None
    try:
        placeholder.text = "\\n".join([
            optype_name + " placeholder",
            "The requested operator is not supported on this operating system.",
            "Validate this scaffold on the target show machine before enabling live output.",
        ])
    except Exception:
        pass
    return placeholder

def _or_create(parent, name, optype_name):
    existing = parent.op(name)
    if _needs_platform_placeholder(optype_name):
        return _create_platform_placeholder(parent, existing, name, optype_name)
    if existing is not None:
        return _replace_unsupported_node(parent, existing, name, optype_name)
    optype = _optype(optype_name)
    if optype is None:
        _warn("%s is not available in this TouchDesigner build; skipped %s." % (optype_name, name))
        return None
    try:
        return _replace_unsupported_node(parent, parent.create(optype, name), name, optype_name)
    except Exception as exc:
        _warn("Could not create %s %s: %s" % (optype_name, name, exc))
        return None

def _setpar(node, par_name, value):
    if node is None or value is None:
        return False
    try:
        par = getattr(node.par, par_name, None)
    except Exception:
        par = None
    if par is None:
        _warn("No parameter '%s' on %s." % (par_name, getattr(node, "path", node)))
        return False
    try:
        par.val = value
        return True
    except Exception as exc:
        _warn("Could not set %s on %s: %s" % (par_name, getattr(node, "path", node), exc))
        return False

def _fill_table(node, rows):
    if node is None:
        return
    try:
        node.clear()
        for row in rows:
            node.appendRow([str(cell) for cell in row])
    except Exception as exc:
        _warn("Could not fill table %s: %s" % (getattr(node, "path", node), exc))

def _connect(nodes_by_name, spec):
    src = nodes_by_name.get(spec.get("from"))
    dst = nodes_by_name.get(spec.get("to"))
    if src is None or dst is None:
        _warn("Could not connect missing node %s -> %s." % (spec.get("from"), spec.get("to")))
        return False
    try:
        dst.inputConnectors[int(spec.get("input", 0))].connect(src)
        return True
    except Exception as exc:
        _warn("Could not connect %s -> %s: %s" % (getattr(src, "name", src), getattr(dst, "name", dst), exc))
        return False

try:
    parent = op(_p["parent_path"])
    if parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        comp = parent.op(_p["name"])
        if comp is None:
            comp = parent.create(baseCOMP, _p["name"])
        _place(comp, _free_x(parent, -180, exclude=comp), -180)
        report["container_path"] = comp.path

        nodes_by_name = {}
        for spec in _p.get("nodes", []):
            node = _or_create(comp, spec.get("name"), spec.get("optype"))
            if node is None:
                continue
            _place(node, spec.get("x", 0), spec.get("y", 0))
            nodes_by_name[spec.get("name")] = node
            report["nodes"][spec.get("name")] = node.path

            for par_name, value in (spec.get("params") or {}).items():
                _setpar(node, par_name, value)
            if spec.get("text") is not None:
                try:
                    node.text = str(spec.get("text"))
                except Exception as exc:
                    _warn("Could not write text to %s: %s" % (getattr(node, "path", node), exc))
            if spec.get("table") is not None:
                _fill_table(node, spec.get("table") or [])

        for connection in _p.get("connections", []):
            _connect(nodes_by_name, connection)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]

result = report
print(json.dumps(report))
`;

export function buildExternalShowScaffoldScript(payload: ExternalShowScaffoldPayload): string {
  return buildPayloadScript(EXTERNAL_SHOW_SCAFFOLD_SCRIPT, payload);
}

export async function runExternalShowScaffold(
  ctx: ToolContext,
  payload: ExternalShowScaffoldPayload,
  failurePrefix: string,
  summary: (report: ExternalShowScaffoldReport) => string,
) {
  const script = buildExternalShowScaffoldScript(payload);
  return guardTd(
    async () =>
      parsePythonReport<ExternalShowScaffoldReport>(
        (await ctx.client.executePythonScript(script, true)).stdout,
      ),
    (report) => {
      if (report.fatal) {
        return errorResult(`${failurePrefix}: ${report.fatal}`, report);
      }
      return jsonResult(summary(report), report);
    },
  );
}
