interface ExternalSensorStatusDriverOptions {
  parameterName?: string;
  statusChopName?: string;
  statusDatName?: string;
  statusJsonPlaceholder?: string;
  storeKey?: string;
}

interface ExternalSensorStatusChopOptions {
  channelPrefix?: string;
  storeKey?: string;
}

interface ExternalSensorLocalStatusDriverOptions {
  outputPath?: string;
  sourceKind?: string;
  sourcePath?: string;
  statusChopName?: string;
  statusDatName?: string;
  storeKey?: string;
}

interface ExternalSensorStatusSurfaceBuilder {
  add(type: string, name?: string, parameters?: Record<string, unknown>): Promise<string>;
  setParams(path: string, parameters: Record<string, unknown>): Promise<void>;
  python(code: string): Promise<void>;
}

interface AddExternalSensorLocalStatusSurfaceOptions
  extends ExternalSensorLocalStatusDriverOptions {
  channelPrefix?: string;
  initialPayload?: Record<string, unknown>;
  statusCallbacksName?: string;
  statusDriverName?: string;
}

export interface ExternalSensorStatusSurfacePaths {
  statusCallbacks: string;
  statusChop: string;
  statusDat: string;
  statusDriver: string;
}

function pyString(value: string): string {
  return JSON.stringify(value);
}

function pyLiteral(value: unknown): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return pyString(value);
  if (value === null || value === undefined) return "None";
  if (Array.isArray(value)) return `[${value.map((item) => pyLiteral(item)).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${pyString(key)}: ${pyLiteral(item)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return pyString(String(value));
}

async function setDatText(
  builder: ExternalSensorStatusSurfaceBuilder,
  path: string,
  text: string,
): Promise<void> {
  await builder.python(
    `_dat = op(${pyString(path)})\nif _dat is not None:\n    _dat.text = ${pyString(text)}`,
  );
}

async function setCallbacks(
  builder: ExternalSensorStatusSurfaceBuilder,
  scriptOpPath: string,
  callbackDatPath: string,
): Promise<void> {
  await builder.python(
    `_script = op(${pyString(scriptOpPath)})\n_cb = op(${pyString(callbackDatPath)})\nif _script is not None and _cb is not None:\n    try:\n        _script.par.callbacks = _cb\n    except Exception:\n        try:\n            _script.par.callbackdat = _cb.path\n        except Exception:\n            pass`,
  );
}

async function setExistingPars(
  builder: ExternalSensorStatusSurfaceBuilder,
  path: string,
  parameters: Record<string, unknown>,
): Promise<void> {
  await builder.python(
    `_node = op(${pyString(path)})\n_values = ${pyLiteral(parameters)}\nif _node is not None:\n    for _name, _value in _values.items():\n        _par = getattr(_node.par, _name, None)\n        if _par is not None:\n            try:\n                _par.val = _value\n            except Exception:\n                pass`,
  );
}

export function externalSensorStatusReportFields(prefix: string): Record<string, string> {
  return {
    [`${prefix}_chop`]: "",
    [`${prefix}_dat`]: "",
    [`${prefix}_driver`]: "",
    [`${prefix}_json`]: "",
  };
}

export function buildExternalSensorStatusDriverDatCode(
  options: ExternalSensorStatusDriverOptions = {},
): string {
  const parameterName = options.parameterName ?? "Sensorstatusjson";
  const statusChopName = options.statusChopName ?? "sensor_status_chop";
  const statusDatName = options.statusDatName ?? "sensor_status";
  const statusJsonPlaceholder = options.statusJsonPlaceholder ?? "__SENSOR_STATUS_JSON__";
  const storeKey = options.storeKey ?? "tdmcp_sensor_status";

  return `# Mirrors an external sensor bridge status JSON into a TouchDesigner DAT and project store.
import json, time

def _par_value(name, default):
    try:
        p = getattr(parent().par, name, None)
        return p.eval() if p is not None else default
    except Exception:
        return default

def _status_path():
    return str(_par_value(${pyString(parameterName)}, ${pyString(statusJsonPlaceholder)})).strip()

def _cook(node):
    if node is not None:
        try:
            node.cook(force=True)
        except Exception:
            pass

def _write_status(payload):
    parent().store(${pyString(storeKey)}, payload)
    dat = op(${pyString(statusDatName)})
    if dat is not None:
        try:
            dat.text = json.dumps(payload, indent=2, sort_keys=True)
        except Exception:
            pass
    _cook(op(${pyString(statusChopName)}))

def _read_status():
    path = _status_path()
    if not path:
        _write_status({
            "ok": False,
            "stale": True,
            "state": "unconfigured",
            "updatedAt": time.time(),
        })
        return
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.loads(handle.read())
        if not isinstance(payload, dict):
            raise ValueError("status JSON root must be an object")
        _write_status(payload)
    except Exception as exc:
        _write_status({
            "error": str(exc),
            "ok": False,
            "path": path,
            "stale": True,
            "state": "missing",
            "updatedAt": time.time(),
        })

def onFrameStart(frame):
    _read_status()
    return

def onStart():
    _read_status()
    return`;
}

export function buildExternalSensorLocalStatusDriverDatCode(
  options: ExternalSensorLocalStatusDriverOptions = {},
): string {
  const outputPath = options.outputPath ?? "__SENSOR_OUTPUT_PATH__";
  const sourceKind = options.sourceKind ?? "sensor";
  const sourcePath = options.sourcePath ?? "__SENSOR_SOURCE_PATH__";
  const statusChopName = options.statusChopName ?? "sensor_status_chop";
  const statusDatName = options.statusDatName ?? "sensor_status";
  const storeKey = options.storeKey ?? "tdmcp_sensor_status";

  return `# Mirrors local TouchDesigner source/operator health into a DAT and project store.
import json, time

SOURCE_KIND = ${pyString(sourceKind)}
SOURCE_PATH = ${pyString(sourcePath)}
OUTPUT_PATH = ${pyString(outputPath)}

def _cook(node):
    if node is not None:
        try:
            node.cook(force=True)
        except Exception:
            pass

def _node(path):
    try:
        return op(path)
    except Exception:
        return None

def _messages(node, method_name):
    if node is None:
        return []
    try:
        method = getattr(node, method_name, None)
        values = method() if callable(method) else []
        if isinstance(values, str):
            return [values] if values else []
        try:
            return [str(value) for value in values] if values else []
        except Exception:
            return [str(values)] if values else []
    except Exception:
        return []

def _dimension(node, name):
    if node is None:
        return 0
    try:
        return int(getattr(node, name, 0) or 0)
    except Exception:
        return 0

def _frame():
    try:
        return int(absTime.frame)
    except Exception:
        return 0

def _write_status(payload):
    parent().store(${pyString(storeKey)}, payload)
    dat = op(${pyString(statusDatName)})
    if dat is not None:
        try:
            dat.text = json.dumps(payload, indent=2, sort_keys=True)
        except Exception:
            pass
    _cook(op(${pyString(statusChopName)}))

def _read_status():
    source = _node(SOURCE_PATH)
    output = _node(OUTPUT_PATH)
    errors = _messages(source, "errors") + _messages(output, "errors")
    warnings = _messages(source, "warnings") + _messages(output, "warnings")
    width = _dimension(output, "width")
    height = _dimension(output, "height")
    missing = source is None or output is None
    has_frame = width > 0 and height > 0
    ok = (not missing) and has_frame and len(errors) == 0
    if missing:
        state = "missing"
    elif errors:
        state = "failed"
    elif not has_frame:
        state = "waiting"
    else:
        state = "running"
    _write_status({
        "cookFrame": _frame(),
        "errors": errors,
        "height": height,
        "ok": ok,
        "outputPath": OUTPUT_PATH,
        "sourceKind": SOURCE_KIND,
        "sourcePath": SOURCE_PATH,
        "stale": not ok,
        "state": state,
        "updatedAt": time.time(),
        "warnings": warnings,
        "width": width,
    })

def onFrameStart(frame):
    _read_status()
    return

def onStart():
    _read_status()
    return`;
}

export function buildExternalSensorStatusChopCode(
  options: ExternalSensorStatusChopOptions = {},
): string {
  const channelPrefix = options.channelPrefix ?? "sensor";
  const storeKey = options.storeKey ?? "tdmcp_sensor_status";

  return `# Converts external sensor status dictionaries into numeric channels for panels, overlays, and logic.
STATE_CODES = {
    "starting": 0.0,
    "running": 1.0,
    "stalled": 2.0,
    "failed": 3.0,
    "exited": 4.0,
    "missing": 5.0,
    "unconfigured": 6.0,
    "waiting": 7.0,
}

def _status():
    try:
        value = parent().fetch(${pyString(storeKey)}, {})
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}

def _boolish(value, default=False):
    if isinstance(value, str):
        return value.lower() not in ("0", "false", "off", "no", "")
    if value is None:
        return bool(default)
    return bool(value)

def _number(value, default=0.0):
    try:
        return float(value)
    except Exception:
        return float(default)

def _chan(scriptOp, name, value):
    channel = scriptOp.appendChan(name)
    channel[0] = float(value)

def onCook(scriptOp):
    scriptOp.clear()
    status = _status()
    state = str(status.get("state", "waiting")).lower()
    _chan(scriptOp, ${pyString(`${channelPrefix}_present`)}, 1.0 if status else 0.0)
    _chan(scriptOp, ${pyString(`${channelPrefix}_ok`)}, 1.0 if _boolish(status.get("ok"), False) else 0.0)
    _chan(scriptOp, ${pyString(`${channelPrefix}_stale`)}, 1.0 if _boolish(status.get("stale"), True) else 0.0)
    _chan(scriptOp, ${pyString(`${channelPrefix}_state_code`)}, STATE_CODES.get(state, 99.0))
    _chan(scriptOp, ${pyString(`${channelPrefix}_restart_count`)}, _number(status.get("restartCount"), 0.0))
    _chan(scriptOp, ${pyString(`${channelPrefix}_last_frame_age_ms`)}, _number(status.get("lastFrameAgeMs"), 0.0))
    _chan(scriptOp, ${pyString(`${channelPrefix}_pid`)}, _number(status.get("pid"), 0.0))
    return`;
}

export async function addExternalSensorLocalStatusSurface(
  builder: ExternalSensorStatusSurfaceBuilder,
  options: AddExternalSensorLocalStatusSurfaceOptions = {},
): Promise<ExternalSensorStatusSurfacePaths> {
  const channelPrefix = options.channelPrefix ?? "sensor";
  const outputPath = options.outputPath ?? "__SENSOR_OUTPUT_PATH__";
  const sourceKind = options.sourceKind ?? "sensor";
  const sourcePath = options.sourcePath ?? "__SENSOR_SOURCE_PATH__";
  const statusCallbacksName = options.statusCallbacksName ?? "source_status_chop_callbacks";
  const statusChopName = options.statusChopName ?? "source_status_chop";
  const statusDatName = options.statusDatName ?? "source_status";
  const statusDriverName = options.statusDriverName ?? "source_status_driver";
  const storeKey = options.storeKey ?? "tdmcp_sensor_status";

  const statusDat = await builder.add("textDAT", statusDatName);
  await setDatText(
    builder,
    statusDat,
    JSON.stringify(
      {
        ok: false,
        outputPath,
        sourceKind,
        sourcePath,
        stale: true,
        state: "waiting",
        ...options.initialPayload,
      },
      null,
      2,
    ),
  );

  const statusChop = await builder.add("scriptCHOP", statusChopName);
  await setExistingPars(builder, statusChop, { modoutsidecook: true, timeslice: false });

  const statusCallbacks = await builder.add("textDAT", statusCallbacksName);
  await setDatText(
    builder,
    statusCallbacks,
    buildExternalSensorStatusChopCode({ channelPrefix, storeKey }),
  );
  await setCallbacks(builder, statusChop, statusCallbacks);

  const statusDriver = await builder.add("executeDAT", statusDriverName);
  await setDatText(
    builder,
    statusDriver,
    buildExternalSensorLocalStatusDriverDatCode({
      outputPath,
      sourceKind,
      sourcePath,
      statusChopName,
      statusDatName,
      storeKey,
    }),
  );
  await setExistingPars(builder, statusDriver, {
    active: true,
    framestart: true,
    start: true,
  });

  return { statusCallbacks, statusChop, statusDat, statusDriver };
}
