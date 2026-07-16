import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const manageAnnotationSchema = z.object({
  action: z
    .enum(["create", "comment", "list", "enclosed", "edit"])
    .describe(
      "'create' a titled annotation box, 'edit' an Annotate COMP's text/style/bounds, 'comment' to set an op's comment, 'list' the annotations in a network, or 'enclosed' to list the ops a box geometrically encloses.",
    ),
  parent_path: z
    .string()
    .default("/project1")
    .describe("(create/list) The network (COMP) to act in."),
  text: z
    .string()
    .optional()
    .describe("(create) The title/text shown on the box; (comment) the comment string to set."),
  name: z
    .string()
    .optional()
    .describe("(create) Name for the annotation COMP (defaults to 'anno')."),
  node_path: z
    .string()
    .optional()
    .describe(
      "(comment) The op to comment on; (enclosed) the annotation box whose enclosed ops to list.",
    ),
  x: z.coerce
    .number()
    .optional()
    .describe("(create) Node-space X position for the box's left edge."),
  y: z.coerce
    .number()
    .optional()
    .describe("(create) Node-space Y position for the box's top edge."),
  w: z.coerce.number().optional().describe("(create) Node-space width of the box."),
  h: z.coerce.number().optional().describe("(create) Node-space height of the box."),
  title: z
    .string()
    .max(512)
    .optional()
    .describe("(edit) Exact Annotate COMP title; empty clears it."),
  body: z
    .string()
    .max(8192)
    .optional()
    .describe("(edit) Exact Annotate COMP body; empty clears it."),
  color: z
    .tuple([
      z.number().finite().min(0).max(1),
      z.number().finite().min(0).max(1),
      z.number().finite().min(0).max(1),
      z.number().finite().min(0).max(1),
    ])
    .optional()
    .describe("(edit) Exact RGBA background colour, four channels from 0 to 1."),
});
type ManageAnnotationArgs = z.infer<typeof manageAnnotationSchema>;

interface AnnotationEntry {
  path: string;
  text?: string | null;
}

interface NetworkBoxEntry {
  id?: number | string | null;
  text?: string | null;
}

interface AnnotationReport {
  action: string;
  created?: string;
  pars_set?: string[];
  node?: string;
  comment?: string | null;
  commented?: boolean;
  box?: string;
  annotations?: AnnotationEntry[];
  network_boxes?: NetworkBoxEntry[];
  enclosed?: string[];
  warnings: string[];
  fatal?: string;
}

// Annotations have no structured bridge endpoint, and the TD network-box / annotate
// API varies by build, so everything is probed in one Python pass:
//   * the Annotate COMP (annotateCOMP) is the reliably-createable titled sticky-note;
//     its title parameter name varies (Text/Title/Header), so we inspect _a.pars()
//     and set the best match, falling forward on failure.
//   * per-op comments live on op.comment when hasattr(op, "comment").
//   * legacy network boxes are reached via the parent COMP's .networkBoxes (probed).
//   * enclosure is geometric: every op/box exposes nodeX/nodeY/nodeWidth/nodeHeight,
//     and an op counts as enclosed when its node-rect center is inside the box rect.
// The script runs inside TouchDesigner, so all TD globals stay in this string.
const ANNOTATION_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {"action": _p["action"], "warnings": []}

def _num(v):
    try:
        return float(v)
    except Exception:
        return None

def _rect(o):
    # (left, top, right, bottom) in node space from nodeX/nodeY (top-left) + size.
    try:
        x = float(o.nodeX); y = float(o.nodeY)
        w = float(o.nodeWidth); h = float(o.nodeHeight)
        return (x, y, x + w, y - h)
    except Exception:
        return None

def _center_in(o, rect):
    r = _rect(o)
    if r is None:
        return False
    cx = (r[0] + r[2]) / 2.0
    cy = (r[1] + r[3]) / 2.0
    left, top, right, bottom = rect
    return (left <= cx <= right) and (bottom <= cy <= top)

try:
    _action = _p["action"]
    if _action == "create":
        _parent = op(_p["parent"])
        if _parent is None:
            report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
        else:
            _nm = _p.get("name") or "anno"
            _a = None
            try:
                _a = _parent.create(annotateCOMP, _nm)
            except Exception as _e:
                report["warnings"].append("annotateCOMP create failed: " + str(_e))
            if _a is None:
                # Fallback: a Text DAT still records the note in-network.
                try:
                    _a = _parent.create(textDAT, _nm)
                    if _p.get("text") is not None:
                        _a.text = str(_p.get("text"))
                    report["warnings"].append("Used a Text DAT fallback (annotateCOMP unavailable).")
                except Exception as _e2:
                    report["fatal"] = "Could not create an annotation: " + str(_e2)
            if _a is not None and "fatal" not in report:
                # create() doesn't always honor the requested name for an Annotate COMP,
                # so set it explicitly (guarded) before reporting the path.
                if _p.get("name"):
                    try:
                        _a.name = str(_p.get("name"))
                    except Exception:
                        pass
                report["created"] = _a.path
                _set = []
                _txt = _p.get("text")
                if _txt is not None and _a.isCOMP:
                    _names = [pp.name for pp in _a.pars()]
                    # The Annotate COMP's text lives in Titletext (header) + Bodytext on current
                    # builds; older/other builds may use Text/Title/etc. Set the title to the given
                    # text via the first matching par, and mirror it to a body par when present so
                    # the box never renders blank.
                    for _cand in ("Titletext", "Title", "Text", "Header", "Note", "Annotation"):
                        if _cand in _names:
                            try:
                                setattr(_a.par, _cand, str(_txt))
                                _set.append(_cand)
                                break
                            except Exception as _e3:
                                report["warnings"].append("Could not set par " + _cand + ": " + str(_e3))
                    for _body in ("Bodytext", "Body"):
                        if _body in _names:
                            try:
                                setattr(_a.par, _body, str(_txt))
                                _set.append(_body)
                                break
                            except Exception:
                                pass
                    if not _set:
                        report["warnings"].append(
                            "No title parameter found among: " + ", ".join(_names[:24])
                        )
                for _attr, _key in (("nodeX", "x"), ("nodeY", "y"), ("nodeWidth", "w"), ("nodeHeight", "h")):
                    _v = _num(_p.get(_key)) if _p.get(_key) is not None else None
                    if _v is not None:
                        try:
                            setattr(_a, _attr, _v)
                            _set.append(_attr)
                        except Exception as _e4:
                            report["warnings"].append("Could not set " + _attr + ": " + str(_e4))
                report["pars_set"] = _set
    elif _action == "comment":
        _o = op(_p["node"])
        if _o is None:
            report["fatal"] = "Node not found: " + str(_p["node"])
        else:
            report["node"] = _o.path
            _txt = _p.get("text")
            if hasattr(_o, "comment"):
                try:
                    _o.comment = str(_txt)
                    report["comment"] = str(_txt)
                    report["commented"] = True
                except Exception as _e:
                    report["warnings"].append("Setting comment failed: " + str(_e))
                    report["commented"] = False
            else:
                report["warnings"].append("This op has no 'comment' attribute on this TD build.")
                report["commented"] = False
    elif _action == "list":
        _parent = op(_p["parent"])
        if _parent is None:
            report["fatal"] = "Parent COMP not found: " + str(_p["parent"])
        else:
            _annos = []
            try:
                for _c in _parent.findChildren(type=annotateCOMP):
                    _t = None
                    _names = [pp.name for pp in _c.pars()]
                    # Titletext/Bodytext first: that's what the create branch writes on
                    # current Annotate COMPs, so listing round-trips tool-created annotations.
                    for _cand in ("Titletext", "Bodytext", "Text", "Title", "Header", "Note", "Annotation"):
                        if _cand in _names:
                            try:
                                _t = str(getattr(_c.par, _cand))
                            except Exception:
                                _t = None
                            break
                    _annos.append({"path": _c.path, "text": _t})
            except Exception as _e:
                report["warnings"].append("findChildren(annotateCOMP) failed: " + str(_e))
            report["annotations"] = _annos
            _boxes = []
            if hasattr(_parent, "networkBoxes"):
                try:
                    for _b in _parent.networkBoxes:
                        _entry = {}
                        try:
                            _entry["id"] = getattr(_b, "id", None)
                        except Exception:
                            _entry["id"] = None
                        try:
                            _entry["text"] = getattr(_b, "text", None)
                        except Exception:
                            _entry["text"] = None
                        _boxes.append(_entry)
                except Exception as _e:
                    report["warnings"].append("Reading networkBoxes failed: " + str(_e))
            else:
                report["warnings"].append("Parent has no 'networkBoxes' on this TD build.")
            report["network_boxes"] = _boxes
    elif _action == "enclosed":
        _b = op(_p["node"])
        if _b is None:
            report["fatal"] = "Box/op not found: " + str(_p["node"])
        else:
            report["box"] = _b.path
            _rb = _rect(_b)
            if _rb is None:
                report["fatal"] = "Could not read the box's node geometry."
            else:
                _enc = []
                _par = _b.parent()
                if _par is None:
                    report["warnings"].append("Box has no parent to scan for siblings.")
                else:
                    try:
                        _sibs = _par.findChildren(depth=1)
                    except Exception as _e:
                        _sibs = []
                        report["warnings"].append("findChildren(depth=1) failed: " + str(_e))
                    for _s in _sibs:
                        if _s.path == _b.path:
                            continue
                        if _center_in(_s, _rb):
                            _enc.append(_s.path)
                report["enclosed"] = sorted(_enc)
    else:
        report["fatal"] = "Unknown action: " + str(_action)
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

export function buildManageAnnotationScript(payload: object): string {
  return buildPayloadScript(ANNOTATION_SCRIPT, payload);
}

function validateManageAnnotationArgs(args: ManageAnnotationArgs): string | undefined {
  if (args.action === "comment" && (!args.node_path || args.text === undefined)) {
    return "`comment` requires both `node_path` (the op) and `text` (the comment).";
  }
  if (args.action === "enclosed" && !args.node_path) {
    return "`enclosed` requires `node_path` (the annotation box to inspect).";
  }
  if (args.action !== "edit") return undefined;
  if (!args.node_path) {
    return "`edit` requires `node_path` (the Annotate COMP to update).";
  }
  if (args.text !== undefined || args.name !== undefined) {
    return "`edit` uses `title`/`body`; legacy `text` and `name` are not allowed.";
  }
  return undefined;
}

function annotationChanges(args: ManageAnnotationArgs) {
  return {
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.body !== undefined ? { body: args.body } : {}),
    ...(args.color !== undefined ? { color: args.color } : {}),
    ...(args.x !== undefined ? { x: args.x } : {}),
    ...(args.y !== undefined ? { y: args.y } : {}),
    ...(args.w !== undefined ? { w: args.w } : {}),
    ...(args.h !== undefined ? { h: args.h } : {}),
  };
}

function editAnnotation(ctx: ToolContext, args: ManageAnnotationArgs) {
  const changes = annotationChanges(args);
  if (Object.keys(changes).length === 0) {
    return errorResult("`edit` requires at least one of title, body, color, x, y, w, or h.");
  }
  return guardTd(
    () => ctx.client.editAnnotation(args.node_path as string, changes),
    (report) => {
      if (!report.applied) {
        return errorResult(
          `Annotation edit failed: ${report.error?.message ?? "TouchDesigner did not confirm the requested state"}.`,
          report,
        );
      }
      const applied = Object.values(report.fields).filter(
        (field) => field.status === "applied",
      ).length;
      const unchanged = Object.values(report.fields).filter(
        (field) => field.status === "unchanged",
      ).length;
      return jsonResult(
        `Edited annotation ${report.final_path}: ${applied} applied, ${unchanged} unchanged.`,
        report,
      );
    },
  );
}

async function runLegacyAnnotation(ctx: ToolContext, args: ManageAnnotationArgs) {
  const script = buildManageAnnotationScript({
    action: args.action,
    parent: args.parent_path,
    text: args.text ?? null,
    name: args.name ?? null,
    node: args.node_path ?? null,
    x: args.x ?? null,
    y: args.y ?? null,
    w: args.w ?? null,
    h: args.h ?? null,
  });
  const exec = await ctx.client.executePythonScript(script, true);
  return parsePythonReport<AnnotationReport>(exec.stdout);
}

function annotationSummary(report: AnnotationReport, parentPath: string): string {
  const warn = report.warnings.length ? ` (${report.warnings.length} warning(s))` : "";
  switch (report.action) {
    case "create":
      return `Created annotation at ${report.created}${
        report.pars_set?.length ? ` — set ${report.pars_set.join(", ")}` : ""
      }${warn}.`;
    case "comment":
      return report.commented
        ? `Set comment on ${report.node}${warn}.`
        : `Could not set a comment on ${report.node}${warn}.`;
    case "list":
      return `Found ${report.annotations?.length ?? 0} annotation COMP(s) and ${
        report.network_boxes?.length ?? 0
      } network box(es) in ${parentPath}${warn}.`;
    default:
      return `${report.box} encloses ${report.enclosed?.length ?? 0} op(s)${warn}.`;
  }
}

function legacyAnnotationResult(report: AnnotationReport, parentPath: string) {
  if (report.fatal) {
    return errorResult(`Annotation ${report.action} failed: ${report.fatal}`, report);
  }
  return jsonResult(annotationSummary(report, parentPath), report);
}

export async function manageAnnotationImpl(ctx: ToolContext, args: ManageAnnotationArgs) {
  // Per-action argument pre-checks the schema can't express (avoid a wasted bridge call).
  const validationError = validateManageAnnotationArgs(args);
  if (validationError) return errorResult(validationError);
  if (args.action === "edit") return editAnnotation(ctx, args);

  return guardTd(
    () => runLegacyAnnotation(ctx, args),
    (report) => legacyAnnotationResult(report, args.parent_path),
  );
}

export const registerManageAnnotation: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "manage_annotation",
    {
      title: "Manage annotation",
      description:
        "Self-document a network: create a titled annotation box; safely edit an existing Annotate COMP's title, body, RGBA background, or exact node-space bounds; set an op comment; list annotations; or inspect geometric enclosure. The edit action is a structured, verified transaction that works with raw Python disabled.",
      inputSchema: manageAnnotationSchema.shape,
      // list/enclosed are read-ish, but create/comment mutate, so this is not read-only.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => manageAnnotationImpl(ctx, args),
  );
};
