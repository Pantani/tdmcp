#!/usr/bin/env node
import dgram from "node:dgram";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runJsonLineHelper } from "./external-helper-supervisor.mjs";

const DEFAULT_HELPER = "_workspace/kinect-wall-harp/external/kinect_harp_depth_bridge";
const STATUS_FRAME_WRITE_INTERVAL_MS = 500;
const STRING_OPTIONS = new Map([
  ["--host", "host"],
  ["--source", "source"],
  ["--helper", "helper"],
  ["--status-json", "statusJson"],
  ["--projection-calibration-json", "projectionCalibrationJson"],
]);
const FLOAT_OPTIONS = new Map([
  ["--rate", "rate"],
  ["--wall-mm", "wallMm"],
  ["--near-min-mm", "nearMinMm"],
  ["--near-max-mm", "nearMaxMm"],
  ["--min-size", "minSize"],
  ["--max-size", "maxSize"],
  ["--max-width", "maxWidth"],
  ["--max-height", "maxHeight"],
  ["--crop-left", "cropLeft"],
  ["--crop-right", "cropRight"],
  ["--crop-top", "cropTop"],
  ["--crop-bottom", "cropBottom"],
  ["--projection-crop-margin", "projectionCropMargin"],
]);
const INTEGER_OPTIONS = new Map([
  ["--port", "port"],
  ["--frames", "frames"],
  ["--calibration-frames", "calibrationFrames"],
  ["--background-frames", "backgroundFrames"],
  ["--debug-every", "debugEvery"],
  ["--min-pixels", "minPixels"],
  ["--stride", "stride"],
  ["--stall-timeout-ms", "stallTimeoutMs"],
]);
const BOOLEAN_OPTIONS = new Map([
  ["--undistort-depth", "undistortDepth"],
  ["--mirror", "mirror"],
]);
const LIBFREENECT2_HELPER_OPTION_FLAGS = [
  ["--calibration-frames", "calibrationFrames"],
  ["--background-frames", "backgroundFrames"],
  ["--debug-every", "debugEvery"],
  ["--wall-mm", "wallMm"],
  ["--near-min-mm", "nearMinMm"],
  ["--near-max-mm", "nearMaxMm"],
  ["--min-pixels", "minPixels"],
  ["--stride", "stride"],
  ["--min-size", "minSize"],
  ["--max-size", "maxSize"],
  ["--max-width", "maxWidth"],
  ["--max-height", "maxHeight"],
];
const LIBFREENECT2_CROP_OPTION_FLAGS = [
  ["--crop-left", "left"],
  ["--crop-right", "right"],
  ["--crop-top", "top"],
  ["--crop-bottom", "bottom"],
];
const OPTIONAL_NUMBER_NAMES = [
  "calibrationFrames",
  "backgroundFrames",
  "debugEvery",
  "wallMm",
  "nearMinMm",
  "nearMaxMm",
  "minPixels",
  "stride",
  "minSize",
  "maxSize",
  "maxWidth",
  "maxHeight",
  "cropLeft",
  "cropRight",
  "cropTop",
  "cropBottom",
  "stallTimeoutMs",
];

function defaultArgs() {
  return {
    host: "127.0.0.1",
    port: 7400,
    source: "synthetic",
    rate: 30,
    frames: 0,
    helper: DEFAULT_HELPER,
    statusJson: undefined,
    projectionCalibrationJson: undefined,
    projectionCropMargin: 0.02,
    mirror: false,
    calibrationFrames: undefined,
    backgroundFrames: undefined,
    debugEvery: undefined,
    wallMm: undefined,
    nearMinMm: undefined,
    nearMaxMm: undefined,
    minPixels: undefined,
    stride: undefined,
    minSize: undefined,
    maxSize: undefined,
    maxWidth: undefined,
    maxHeight: undefined,
    cropLeft: undefined,
    cropRight: undefined,
    cropTop: undefined,
    cropBottom: undefined,
    undistortDepth: false,
    stallTimeoutMs: 8000,
  };
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function assignValueOption(args, key, value, parser) {
  args[key] = parser(value);
}

function validatePort(args) {
  if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535) {
    throw new Error(`Invalid --port: ${args.port}`);
  }
}

function validateRate(args) {
  if (!Number.isFinite(args.rate) || args.rate <= 0) {
    throw new Error(`Invalid --rate: ${args.rate}`);
  }
}

function validateFrameLimit(args) {
  if (!Number.isInteger(args.frames) || args.frames < 0) {
    throw new Error(`Invalid --frames: ${args.frames}`);
  }
}

function validateSource(args) {
  if (!["synthetic", "libfreenect2"].includes(args.source)) {
    throw new Error(`Invalid --source: ${args.source}`);
  }
}

function optionalNumberFlag(name) {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function validateOptionalNumbers(args) {
  for (const name of OPTIONAL_NUMBER_NAMES) {
    const value = args[name];
    if (value !== undefined && !Number.isFinite(value)) {
      throw new Error(`Invalid --${optionalNumberFlag(name)}: ${value}`);
    }
  }
}

function validateProjectionCropMargin(args) {
  if (
    !Number.isFinite(args.projectionCropMargin) ||
    args.projectionCropMargin < 0 ||
    args.projectionCropMargin > 0.25
  ) {
    throw new Error(`Invalid --projection-crop-margin: ${args.projectionCropMargin}`);
  }
}

function validateArgs(args) {
  validatePort(args);
  validateRate(args);
  validateFrameLimit(args);
  validateSource(args);
  validateOptionalNumbers(args);
  validateProjectionCropMargin(args);
}

function parseArgs(argv) {
  const args = defaultArgs();
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    const stringKey = STRING_OPTIONS.get(arg);
    if (stringKey !== undefined) {
      args[stringKey] = requireValue(argv, i, arg);
      i += 1;
      continue;
    }

    const integerKey = INTEGER_OPTIONS.get(arg);
    if (integerKey !== undefined) {
      assignValueOption(args, integerKey, requireValue(argv, i, arg), (value) =>
        Number.parseInt(value, 10),
      );
      i += 1;
      continue;
    }

    const floatKey = FLOAT_OPTIONS.get(arg);
    if (floatKey !== undefined) {
      assignValueOption(args, floatKey, requireValue(argv, i, arg), Number.parseFloat);
      i += 1;
      continue;
    }

    const booleanKey = BOOLEAN_OPTIONS.get(arg);
    if (booleanKey !== undefined) {
      args[booleanKey] = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }
  validateArgs(args);
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/kinect-wall-harp-bridge.mjs --source synthetic --port 7400
  node scripts/kinect-wall-harp-bridge.mjs --source libfreenect2 --helper _workspace/kinect-wall-harp/external/kinect_harp_depth_bridge --port 7400

Options:
  --host <host>       OSC target host. Default: 127.0.0.1
  --port <port>       OSC target UDP port. Default: 7400
  --source <source>   synthetic | libfreenect2. Default: synthetic
  --rate <hz>         Synthetic send rate. Default: 30
  --frames <n>        Stop after n frames. 0 means run until interrupted.
  --helper <path>     libfreenect2 JSON helper path.
  --status-json <path>
                      Write normalized helper status JSON to this path.
  --projection-calibration-json <path>
                      Read /tmp/kinect_environment_diagnostic.json and use its
                      registered_projection_bbox as the default libfreenect2 crop.
                      Manual --crop-* flags override this automatic crop.
  --projection-crop-margin <0..0.25>
                      Extra normalized margin around registered projection crop.
                      Default: 0.02
  --wall-mm <mm>      Override wall depth instead of auto-calibrating.
  --calibration-frames <n>
                      Frames used for wall auto-calibration. Default helper value: 45
  --background-frames <n>
                      Frames used to learn a per-pixel empty-wall background.
  --debug-every <n>   Log helper foreground/candidate stats every n frames.
  --near-min-mm <mm>  Minimum distance in front of the wall to count as touch.
  --near-max-mm <mm>  Maximum distance in front of the wall to count as touch.
  --min-pixels <n>    Minimum connected-component pixels after stride sampling.
  --stride <n>        Depth sampling stride for helper. Default helper value: 2
  --min-size <0..1>   Minimum normalized blob area.
  --max-size <0..1>   Maximum normalized blob area, useful to reject body/wall blobs.
  --max-width <0..1>  Reject connected components wider than this normalized span.
  --max-height <0..1> Reject connected components taller than this normalized span.
  --crop-left <0..1>  Ignore depth blobs left of this normalized X.
  --crop-right <0..1> Ignore depth blobs right of this normalized X.
  --crop-top <0..1>   Ignore depth blobs above this normalized Y.
  --crop-bottom <0..1>
                      Ignore depth blobs below this normalized Y.
  --undistort-depth   Undistort depth before crop/tracking. Use with crops derived from libfreenect2 registration.
  --stall-timeout-ms <n>
                      Kill the helper if no JSON depth frame arrives for n ms. Default: 8000. Use 0 to disable.
  --mirror            Mirror outgoing X coordinates.
`);
}

function pad4(length) {
  return (4 - (length % 4)) % 4;
}

function oscString(value) {
  const raw = Buffer.from(`${value}\0`, "utf8");
  return Buffer.concat([raw, Buffer.alloc(pad4(raw.length))]);
}

function oscFloatMessage(address, value) {
  const head = Buffer.concat([oscString(address), oscString(",f")]);
  const body = Buffer.alloc(4);
  body.writeFloatBE(Number.isFinite(value) ? value : 0, 0);
  return Buffer.concat([head, body]);
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function firstDefinedNumber(raw, names, fallback) {
  for (const name of names) {
    if (raw[name] !== undefined && raw[name] !== null) return Number(raw[name]);
  }
  return Number(fallback);
}

function clampedHandValue(raw, names, fallback) {
  return clamp01(firstDefinedNumber(raw, names, fallback));
}

function mirroredX(value, mirror) {
  return mirror ? 1 - value : value;
}

function mapHorizontalBounds(bounds, mirror) {
  if (!mirror) return bounds;
  return {
    minX: 1 - bounds.maxX,
    maxX: 1 - bounds.minX,
    centerX: 1 - bounds.centerX,
  };
}

const HAND_OSC_FIELDS = [
  "present",
  "x",
  "y",
  "raw_x",
  "raw_y",
  "size",
  "open_score",
  "min_x",
  "min_y",
  "max_x",
  "max_y",
  "center_x",
  "center_y",
  "width",
  "height",
];

function normalizeHand(raw = {}, mirror) {
  const x = clampedHandValue(raw, ["x"], 0);
  const y = clampedHandValue(raw, ["y"], 0);
  const rawX = clampedHandValue(raw, ["raw_x", "rawX", "x"], 0);
  const horizontal = mapHorizontalBounds(
    {
      minX: clampedHandValue(raw, ["min_x", "minX"], x),
      maxX: clampedHandValue(raw, ["max_x", "maxX"], x),
      centerX: clampedHandValue(raw, ["center_x", "centerX"], x),
    },
    mirror,
  );

  return {
    present: firstDefinedNumber(raw, ["present"], 0) > 0.5 ? 1 : 0,
    x: mirroredX(x, mirror),
    y,
    raw_x: mirroredX(rawX, mirror),
    raw_y: clampedHandValue(raw, ["raw_y", "rawY", "y"], 0),
    size: clampedHandValue(raw, ["size"], 0),
    open_score: clampedHandValue(raw, ["open_score", "openScore", "palm_open"], 0),
    min_x: horizontal.minX,
    min_y: clampedHandValue(raw, ["min_y", "minY"], y),
    max_x: horizontal.maxX,
    max_y: clampedHandValue(raw, ["max_y", "maxY"], y),
    center_x: horizontal.centerX,
    center_y: clampedHandValue(raw, ["center_y", "centerY"], y),
    width: Math.max(0, horizontal.maxX - horizontal.minX),
    height: clampedHandValue(raw, ["height"], 0),
  };
}

function normalizeFrame(frame, mirror) {
  return {
    left: normalizeHand(frame.left, mirror),
    right: normalizeHand(frame.right, mirror),
  };
}

function sendFrame(socket, args, frame) {
  const normalized = normalizeFrame(frame, args.mirror);
  for (const side of ["left", "right"]) {
    for (const field of HAND_OSC_FIELDS) {
      const address = `/kinect/${side}/${field}`;
      const packet = oscFloatMessage(address, normalized[side][field]);
      socket.send(packet, args.port, args.host);
    }
  }
}

let lastStatusWriteAtMs = 0;
let lastStatusSignature = "";

function statusSignature(status) {
  return [
    status.type,
    status.state,
    status.ok,
    status.stale,
    status.restartCount,
    status.pid,
    status.error,
  ].join("|");
}

function shouldWriteStatusJson(status, nowMs) {
  const signature = statusSignature(status);
  if (status.type !== "frame") {
    lastStatusSignature = signature;
    lastStatusWriteAtMs = nowMs;
    return true;
  }
  if (signature !== lastStatusSignature) {
    lastStatusSignature = signature;
    lastStatusWriteAtMs = nowMs;
    return true;
  }
  if (nowMs - lastStatusWriteAtMs >= STATUS_FRAME_WRITE_INTERVAL_MS) {
    lastStatusWriteAtMs = nowMs;
    return true;
  }
  return false;
}

function writeStatusJson(args, status) {
  if (args.statusJson === undefined) return;
  const nowMs = Date.now();
  if (!shouldWriteStatusJson(status, nowMs)) return;
  const payload = {
    ...status,
    source: args.source,
    helper: args.helper,
    target: { host: args.host, port: args.port },
    updatedAt: new Date(nowMs).toISOString(),
  };
  try {
    mkdirSync(dirname(args.statusJson), { recursive: true });
    const tmp = `${args.statusJson}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(tmp, args.statusJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[kinect-wall-harp-bridge] failed to write status JSON: ${message}\n`);
  }
}

function syntheticFrame(t) {
  const hand = (present, x, y, size) => ({
    present,
    x,
    y,
    raw_x: x,
    raw_y: y,
    size,
    open_score: present ? 1 : 0,
    min_x: clamp01(x - size * 1.8),
    min_y: clamp01(y - size * 1.25),
    max_x: clamp01(x + size * 1.8),
    max_y: clamp01(y + size * 0.9),
    center_x: x,
    center_y: y,
    width: clamp01(size * 3.6),
    height: clamp01(size * 2.15),
  });
  return {
    left: hand(1, 0.22 + 0.22 * ((Math.sin(t * 0.85) + 1) * 0.5), 0.48, 0.08),
    right: hand(1, 0.56 + 0.26 * ((Math.cos(t * 0.7) + 1) * 0.5), 0.52, 0.08),
  };
}

async function runSynthetic(socket, args) {
  const intervalMs = Math.max(1, Math.round(1000 / args.rate));
  let sent = 0;
  const started = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const t = (Date.now() - started) / 1000;
      sendFrame(socket, args, syntheticFrame(t));
      sent += 1;
      if (args.frames > 0 && sent >= args.frames) {
        clearInterval(timer);
        resolve();
      }
    }, intervalMs);
  });
}

function finite01(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`Invalid ${label} in projection calibration JSON: ${value}`);
  }
  return number;
}

function loadProjectionCalibrationCrop(args) {
  if (args.projectionCalibrationJson === undefined) return undefined;
  const raw = readFileSync(args.projectionCalibrationJson, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.registered_projection_present !== true) {
    throw new Error(
      `Projection calibration JSON has no registered projection: ${args.projectionCalibrationJson}`,
    );
  }
  const bbox = parsed.registered_projection_bbox;
  if (bbox === null || typeof bbox !== "object") {
    throw new Error(`Projection calibration JSON is missing registered_projection_bbox`);
  }
  const margin = Number(args.projectionCropMargin ?? 0);
  const left = clamp01(finite01(bbox.x0, "registered_projection_bbox.x0") - margin);
  const top = clamp01(finite01(bbox.y0, "registered_projection_bbox.y0") - margin);
  const right = clamp01(finite01(bbox.x1, "registered_projection_bbox.x1") + margin);
  const bottom = clamp01(finite01(bbox.y1, "registered_projection_bbox.y1") + margin);
  if (right - left < 0.02 || bottom - top < 0.02) {
    throw new Error(`Projection calibration bbox is too small to use as a depth crop`);
  }
  return { left, right, top, bottom };
}

function logProjectionCrop(args, projectionCrop) {
  if (projectionCrop === undefined) return;
  process.stderr.write(
    `[kinect-wall-harp-bridge] auto projection crop from ${args.projectionCalibrationJson}: ` +
      `left=${projectionCrop.left.toFixed(4)} right=${projectionCrop.right.toFixed(4)} ` +
      `top=${projectionCrop.top.toFixed(4)} bottom=${projectionCrop.bottom.toFixed(4)}\n`,
  );
}

function pushOptionalHelperArg(helperArgs, flag, value) {
  if (value !== undefined) helperArgs.push(flag, String(value));
}

function pushHelperOptionSet(helperArgs, args) {
  for (const [flag, name] of LIBFREENECT2_HELPER_OPTION_FLAGS) {
    pushOptionalHelperArg(helperArgs, flag, args[name]);
  }
}

function cropValue(args, projectionCrop, name) {
  const manualName = `crop${name[0].toUpperCase()}${name.slice(1)}`;
  if (args[manualName] !== undefined && args[manualName] !== null) return args[manualName];
  if (projectionCrop !== undefined) return projectionCrop[name];
  return undefined;
}

function pushCropOptions(helperArgs, args, projectionCrop) {
  for (const [flag, name] of LIBFREENECT2_CROP_OPTION_FLAGS) {
    pushOptionalHelperArg(helperArgs, flag, cropValue(args, projectionCrop, name));
  }
}

function buildLibfreenect2HelperArgs(args) {
  const projectionCrop = loadProjectionCalibrationCrop(args);
  logProjectionCrop(args, projectionCrop);
  const helperArgs = [];
  if (args.frames > 0) helperArgs.push("--frames", String(args.frames));
  pushHelperOptionSet(helperArgs, args);
  pushCropOptions(helperArgs, args, projectionCrop);
  if (args.undistortDepth || projectionCrop !== undefined) helperArgs.push("--undistort-depth");
  return helperArgs;
}

async function runLibfreenect2(socket, args) {
  const helperArgs = buildLibfreenect2HelperArgs(args);
  const stallTimeoutMs = Math.max(0, Number(args.stallTimeoutMs ?? 8000));
  return runJsonLineHelper({
    command: args.helper,
    args: helperArgs,
    label: "kinect-wall-harp-bridge",
    stallTimeoutMs,
    onJson: (frame) => sendFrame(socket, args, frame),
    onStatus: (status) => writeStatusJson(args, status),
    formatStallMessage: ({ silenceMs }) =>
      `[kinect-wall-harp-bridge] LIBUSB/depth stream stalled for ${silenceMs}ms; restarting helper`,
    formatExitError: (code, signal) => `libfreenect2 helper exited with code ${code ?? signal}`,
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const socket = dgram.createSocket("udp4");
  const close = () =>
    new Promise((resolve) => {
      socket.close(resolve);
    });
  process.on("SIGINT", async () => {
    await close();
    process.exit(130);
  });

  console.error(`[kinect-wall-harp-bridge] source=${args.source} target=${args.host}:${args.port}`);
  try {
    if (args.source === "synthetic") await runSynthetic(socket, args);
    else await runLibfreenect2(socket, args);
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(`[kinect-wall-harp-bridge] ${err.message}`);
  process.exit(1);
});
