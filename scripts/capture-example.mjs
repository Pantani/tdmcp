/**
 * Capture an animated GIF or MP4 of a TouchDesigner TOP for the docs site.
 *
 * Authoring tool (NOT part of the build): needs a live TouchDesigner with the
 * tdmcp bridge running, plus ffmpeg/ffprobe on PATH. It steps the timeline frame
 * by frame over the bridge (so paused/background projects still animate), grabs
 * each frame from the preview endpoint, and assembles a looping docs artifact.
 *
 *   node scripts/capture-example.mjs --preset cookbook --node /project1/feedback/out1 \
 *     --out docs/public/examples/feedback-tunnel.mp4
 *
 *   node scripts/capture-example.mjs --preset raytk-cookbook \
 *     --node /project1/raytk_scene/render1/out1 \
 *     --out docs/public/examples/raytk-sphere-box-nodegraph.mp4
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PRESETS = {
  cookbook: {
    description: "Docs MP4 from a live tdmcp TouchDesigner output.",
    frames: 56,
    step: 2,
    width: 480,
    height: 270,
    fps: 20,
    delayMs: 20,
    warmupFrames: 0,
    verify: true,
    motionMinUnique: 2,
  },
  "raytk-cookbook": {
    description: "Docs MP4 from a loaded RayTK graph render TOP, with shader warmup.",
    frames: 56,
    step: 2,
    width: 480,
    height: 270,
    fps: 20,
    delayMs: 80,
    warmupFrames: 12,
    verify: true,
    motionMinUnique: 2,
  },
};

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function numberArg(argv, name, fallback) {
  const value = Number(arg(argv, name, String(fallback)));
  if (!Number.isFinite(value)) throw new Error(`Invalid --${name}: expected a number.`);
  return value;
}

function usage() {
  const presetList = Object.entries(PRESETS)
    .map(([name, preset]) => `  ${name.padEnd(15)} ${preset.description}`)
    .join("\n");
  return `Usage: node scripts/capture-example.mjs --node <TOP path> --out <gif/mp4 path> [options]

Options:
  --preset <name>           Apply a capture preset.
  --node <path>             TouchDesigner TOP/COMP path to preview.
  --out <path>              Output .mp4 or .gif path.
  --frames <n>              Frames to capture.
  --step <n>                Timeline frames to advance before each capture.
  --size <n>                Square preview size, unless width/height are set.
  --width <n> --height <n>  Preview dimensions.
  --fps <n>                 Encoded output FPS.
  --delay-ms <n>            Delay after each timeline step before preview capture.
  --warmup-frames <n>       Advance/cook extra frames before recording.
  --verify / --no-verify    Run ffprobe and frozen-frame checks.
  --allow-still             Permit identical captured frames when verifying.
  --contact-sheet <path>    Write a sampled JPEG sheet before temp frames are removed.
  --print-plan              Print resolved options as JSON and exit.
  --list-presets            List presets and exit.

Presets:
${presetList}`;
}

export function resolveCaptureOptions(argv = process.argv.slice(2)) {
  const presetName = arg(argv, "preset");
  const preset = resolvePreset(presetName);
  const verify = resolveVerifyFlag(argv, preset);
  const { width, height } = resolveDimensions(argv, preset);

  return {
    node: arg(argv, "node"),
    out: arg(argv, "out"),
    preset: presetName,
    frames: numberArg(argv, "frames", presetValue(preset, "frames", 40)),
    step: numberArg(argv, "step", presetValue(preset, "step", 2)),
    width,
    height,
    fps: numberArg(argv, "fps", presetValue(preset, "fps", 16)),
    host: arg(argv, "host", "127.0.0.1:9980"),
    delayMs: numberArg(argv, "delay-ms", presetValue(preset, "delayMs", 0)),
    warmupFrames: numberArg(argv, "warmup-frames", presetValue(preset, "warmupFrames", 0)),
    verify,
    motionMinUnique: resolveMotionMinUnique(argv, preset, verify),
    contactSheet: arg(argv, "contact-sheet"),
  };
}

function resolvePreset(presetName) {
  const preset = presetName ? PRESETS[presetName] : undefined;
  if (presetName && !preset) {
    throw new Error(
      `Unknown --preset ${JSON.stringify(presetName)}. Known presets: ${Object.keys(PRESETS).join(", ")}`,
    );
  }
  return preset;
}

function presetValue(preset, key, fallback) {
  return preset?.[key] ?? fallback;
}

function resolveVerifyFlag(argv, preset) {
  if (hasFlag(argv, "no-verify")) return false;
  return hasFlag(argv, "verify") || Boolean(preset?.verify);
}

function resolveDimensions(argv, preset) {
  const size = arg(argv, "size");
  const fallbackWidth = presetValue(preset, "width", 480);
  const width = numberArg(argv, "width", size ?? fallbackWidth);
  const height = numberArg(argv, "height", size ?? presetValue(preset, "height", width));
  return { width, height };
}

function resolveMotionMinUnique(argv, preset, verify) {
  if (hasFlag(argv, "allow-still")) return 1;
  const fallback = presetValue(preset, "motionMinUnique", verify ? 2 : 1);
  return numberArg(argv, "motion-min-unique", fallback);
}

async function exec(base, script) {
  const response = await fetch(`${base}/api/exec`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ script, return_output: false }),
  });
  if (!response.ok) throw new Error(`/api/exec failed with HTTP ${response.status}`);
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function verifyCapturedFrames({ frameHashes, motionMinUnique, out }) {
  const unique = new Set(frameHashes).size;
  if (unique < motionMinUnique) {
    throw new Error(
      `Capture appears frozen: ${unique} unique frame(s) for ${out}. ` +
        "Use --allow-still only for intentional still docs media.",
    );
  }
}

function probeVideo(out) {
  const raw = execFileSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,nb_frames,duration,avg_frame_rate",
    "-of",
    "json",
    out,
  ]);
  const report = JSON.parse(raw.toString("utf8"));
  const stream = report.streams?.[0];
  if (!stream?.width || !stream?.height) throw new Error(`ffprobe found no video stream in ${out}`);
  console.log(
    `verified ${out}: ${stream.width}x${stream.height}, ${stream.nb_frames ?? "?"} frames, ` +
      `${stream.duration ?? "?"}s, ${stream.avg_frame_rate ?? "?"} fps`,
  );
}

function writeContactSheet({ dir, out, frames }) {
  const interval = Math.max(1, Math.floor(frames / 8));
  const seq = join(dir, "f_%03d.png");
  mkdirSync(dirname(out), { recursive: true });
  execFileSync("ffmpeg", [
    "-y",
    "-i",
    seq,
    "-vf",
    `select=not(mod(n\\,${interval})),scale=240:-1,tile=4x2`,
    "-frames:v",
    "1",
    out,
    "-loglevel",
    "error",
  ]);
  console.log(`wrote contact sheet ${out}`);
}

async function advanceTimeline({ base, step, delayMs }) {
  await exec(base, `tl=op("/").time; tl.frame = tl.frame + ${step}`);
  await sleep(delayMs);
}

async function captureFrames(options) {
  const { node, frames, step, width, height, delayMs, warmupFrames } = options;
  const base = `http://${options.host}`;
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-frames-"));
  const enc = encodeURIComponent(node);
  const frameHashes = [];
  let captured = 0;

  for (let i = 0; i < warmupFrames; i++) {
    await advanceTimeline({ base, step, delayMs });
  }
  if (warmupFrames > 0) {
    console.log(`warmed up ${warmupFrames} frame steps before capture`);
  }

  for (let i = 1; i <= frames; i++) {
    await advanceTimeline({ base, step, delayMs });
    const r = await fetch(`${base}/api/preview/${enc}?width=${width}&height=${height}`);
    const j = await r.json();
    if (!j.ok) throw new Error(`preview failed for ${node}: ${JSON.stringify(j.error ?? j)}`);
    const frame = Buffer.from(j.data.base64, "base64");
    frameHashes.push(hashBuffer(frame));
    writeFileSync(join(dir, `f_${String(i).padStart(3, "0")}.png`), frame);
    captured++;
  }
  console.log(`captured ${captured} frames from ${node}`);

  return { dir, frameHashes };
}

function encodeFrames({ dir, out, fps }) {
  mkdirSync(dirname(out), { recursive: true });
  const seq = join(dir, "f_%03d.png");
  if (out.endsWith(".mp4")) {
    // h264 + yuv420p + even dimensions for broad browser support; faststart for
    // streaming. Far smaller than GIF for detailed/animated visuals (use a looping
    // muted <video> to embed). crf 24 keeps files light.
    execFileSync("ffmpeg", [
      "-y",
      "-framerate",
      String(fps),
      "-i",
      seq,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "24",
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-movflags",
      "+faststart",
      out,
      "-loglevel",
      "error",
    ]);
  } else {
    const pal = join(dir, "palette.png");
    execFileSync("ffmpeg", [
      "-y",
      "-framerate",
      String(fps),
      "-i",
      seq,
      "-vf",
      "palettegen=stats_mode=diff",
      pal,
      "-loglevel",
      "error",
    ]);
    execFileSync("ffmpeg", [
      "-y",
      "-framerate",
      String(fps),
      "-i",
      seq,
      "-i",
      pal,
      "-lavfi",
      "paletteuse=dither=bayer:bayer_scale=3",
      "-loop",
      "0",
      out,
      "-loglevel",
      "error",
    ]);
  }
  console.log(`wrote ${out}`);
}

async function main(argv = process.argv.slice(2)) {
  if (handleInfoCommand(argv)) return;

  const options = resolveCaptureOptions(argv);
  if (hasFlag(argv, "print-plan")) {
    console.log(JSON.stringify(options, null, 2));
    return;
  }
  validateRequiredOptions(options);
  await runCapturePlan(options);
}

function handleInfoCommand(argv) {
  if (hasFlag(argv, "help") || hasFlag(argv, "h")) {
    console.log(usage());
    return true;
  }
  if (hasFlag(argv, "list-presets")) {
    console.log(JSON.stringify(PRESETS, null, 2));
    return true;
  }
  return false;
}

function validateRequiredOptions(options) {
  if (!options.node || !options.out) throw new Error(`${usage()}\n\nMissing --node or --out.`);
}

async function runCapturePlan(options) {
  const { dir, frameHashes } = await captureFrames(options);
  try {
    maybeVerifyCapturedFrames(options, frameHashes);
    maybeWriteContactSheet(options, dir);
    encodeFrames({ dir, out: options.out, fps: options.fps });
    maybeProbeVideo(options);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function maybeVerifyCapturedFrames(options, frameHashes) {
  if (!options.verify) return;
  verifyCapturedFrames({
    frameHashes,
    motionMinUnique: options.motionMinUnique,
    out: options.out,
  });
}

function maybeWriteContactSheet(options, dir) {
  if (!options.contactSheet) return;
  writeContactSheet({ dir, out: options.contactSheet, frames: options.frames });
}

function maybeProbeVideo(options) {
  if (options.verify) probeVideo(options.out);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
