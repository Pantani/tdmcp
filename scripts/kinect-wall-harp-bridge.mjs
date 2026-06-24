#!/usr/bin/env node
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { createInterface } from "node:readline";

const DEFAULT_HELPER = "_workspace/kinect-wall-harp/external/kinect_harp_depth_bridge";

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 7400,
    source: "synthetic",
    rate: 30,
    frames: 0,
    helper: DEFAULT_HELPER,
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
    cropLeft: undefined,
    cropRight: undefined,
    cropTop: undefined,
    cropBottom: undefined,
    undistortDepth: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--host" && next) {
      args.host = next;
      i += 1;
    } else if (arg === "--port" && next) {
      args.port = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--source" && next) {
      args.source = next;
      i += 1;
    } else if (arg === "--rate" && next) {
      args.rate = Number.parseFloat(next);
      i += 1;
    } else if (arg === "--frames" && next) {
      args.frames = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--helper" && next) {
      args.helper = next;
      i += 1;
    } else if (arg === "--calibration-frames" && next) {
      args.calibrationFrames = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--background-frames" && next) {
      args.backgroundFrames = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--debug-every" && next) {
      args.debugEvery = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--wall-mm" && next) {
      args.wallMm = Number.parseFloat(next);
      i += 1;
    } else if (arg === "--near-min-mm" && next) {
      args.nearMinMm = Number.parseFloat(next);
      i += 1;
    } else if (arg === "--near-max-mm" && next) {
      args.nearMaxMm = Number.parseFloat(next);
      i += 1;
    } else if (arg === "--min-pixels" && next) {
      args.minPixels = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--stride" && next) {
      args.stride = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--min-size" && next) {
      args.minSize = Number.parseFloat(next);
      i += 1;
    } else if (arg === "--max-size" && next) {
      args.maxSize = Number.parseFloat(next);
      i += 1;
    } else if (arg === "--crop-left" && next) {
      args.cropLeft = Number.parseFloat(next);
      i += 1;
    } else if (arg === "--crop-right" && next) {
      args.cropRight = Number.parseFloat(next);
      i += 1;
    } else if (arg === "--crop-top" && next) {
      args.cropTop = Number.parseFloat(next);
      i += 1;
    } else if (arg === "--crop-bottom" && next) {
      args.cropBottom = Number.parseFloat(next);
      i += 1;
    } else if (arg === "--undistort-depth") {
      args.undistortDepth = true;
    } else if (arg === "--mirror") {
      args.mirror = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535) {
    throw new Error(`Invalid --port: ${args.port}`);
  }
  if (!Number.isFinite(args.rate) || args.rate <= 0) {
    throw new Error(`Invalid --rate: ${args.rate}`);
  }
  if (!["synthetic", "libfreenect2"].includes(args.source)) {
    throw new Error(`Invalid --source: ${args.source}`);
  }
  for (const [name, value] of Object.entries(args)) {
    if (
      [
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
        "cropLeft",
        "cropRight",
        "cropTop",
        "cropBottom",
      ].includes(name) &&
      value !== undefined &&
      !Number.isFinite(value)
    ) {
      throw new Error(
        `Invalid --${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value}`,
      );
    }
  }
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
  --crop-left <0..1>  Ignore depth blobs left of this normalized X.
  --crop-right <0..1> Ignore depth blobs right of this normalized X.
  --crop-top <0..1>   Ignore depth blobs above this normalized Y.
  --crop-bottom <0..1>
                      Ignore depth blobs below this normalized Y.
  --undistort-depth   Undistort depth before crop/tracking. Use with crops derived from libfreenect2 registration.
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

function normalizeFrame(frame, mirror) {
  const hand = (raw = {}) => {
    const x = clamp01(Number(raw.x ?? 0));
    return {
      present: Number(raw.present ?? 0) > 0.5 ? 1 : 0,
      x: mirror ? 1 - x : x,
      y: clamp01(Number(raw.y ?? 0)),
      size: clamp01(Number(raw.size ?? 0)),
    };
  };
  return {
    left: hand(frame.left),
    right: hand(frame.right),
  };
}

function sendFrame(socket, args, frame) {
  const normalized = normalizeFrame(frame, args.mirror);
  for (const side of ["left", "right"]) {
    for (const field of ["present", "x", "y", "size"]) {
      const address = `/kinect/${side}/${field}`;
      const packet = oscFloatMessage(address, normalized[side][field]);
      socket.send(packet, args.port, args.host);
    }
  }
}

function syntheticFrame(t) {
  return {
    left: {
      present: 1,
      x: 0.22 + 0.22 * ((Math.sin(t * 0.85) + 1) * 0.5),
      y: 0.48,
      size: 0.08,
    },
    right: {
      present: 1,
      x: 0.56 + 0.26 * ((Math.cos(t * 0.7) + 1) * 0.5),
      y: 0.52,
      size: 0.08,
    },
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

async function runLibfreenect2(socket, args) {
  const helperArgs = [];
  if (args.frames > 0) helperArgs.push("--frames", String(args.frames));
  const pushOptional = (flag, value) => {
    if (value !== undefined) helperArgs.push(flag, String(value));
  };
  pushOptional("--calibration-frames", args.calibrationFrames);
  pushOptional("--background-frames", args.backgroundFrames);
  pushOptional("--debug-every", args.debugEvery);
  pushOptional("--wall-mm", args.wallMm);
  pushOptional("--near-min-mm", args.nearMinMm);
  pushOptional("--near-max-mm", args.nearMaxMm);
  pushOptional("--min-pixels", args.minPixels);
  pushOptional("--stride", args.stride);
  pushOptional("--min-size", args.minSize);
  pushOptional("--max-size", args.maxSize);
  pushOptional("--crop-left", args.cropLeft);
  pushOptional("--crop-right", args.cropRight);
  pushOptional("--crop-top", args.cropTop);
  pushOptional("--crop-bottom", args.cropBottom);
  if (args.undistortDepth) helperArgs.push("--undistort-depth");
  const child = spawn(args.helper, helperArgs, { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim().startsWith("{")) return;
    try {
      sendFrame(socket, args, JSON.parse(line));
    } catch (err) {
      process.stderr.write(`[kinect-wall-harp-bridge] ignored helper line: ${err.message}\n`);
    }
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`libfreenect2 helper exited with code ${code}`));
    });
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
