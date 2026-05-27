/**
 * Capture an animated GIF of a TouchDesigner TOP for the docs site.
 *
 * Authoring tool (NOT part of the build): needs a live TouchDesigner with the
 * tdmcp bridge running, plus `ffmpeg` on PATH. It steps the timeline frame by
 * frame over the bridge (so paused/background projects still animate), grabs each
 * frame from the preview endpoint, and assembles an optimized, looping GIF.
 *
 *   node scripts/capture-example.mjs --node /project1/feedback_system/out1 \
 *     --out docs/public/examples/feedback-tunnel.gif --frames 40 --step 2 --size 480 --fps 16
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const node = arg("node");
const out = arg("out");
if (!node || !out) {
  console.error("Usage: --node <TOP path> --out <gif path> [--frames 40] [--step 2] [--size 480 | --width W --height H] [--fps 16] [--host 127.0.0.1:9980]");
  process.exit(1);
}
const frames = Number(arg("frames", "40"));
const step = Number(arg("step", "2"));
const width = Number(arg("width", arg("size", "480")));
const height = Number(arg("height", arg("size", String(width))));
const fps = Number(arg("fps", "16"));
const host = arg("host", "127.0.0.1:9980");
const base = `http://${host}`;

async function exec(script) {
  await fetch(`${base}/api/exec`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ script, return_output: false }),
  });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-frames-"));
  const enc = encodeURIComponent(node);
  let captured = 0;
  for (let i = 1; i <= frames; i++) {
    await exec(`tl=op("/").time; tl.frame = tl.frame + ${step}`);
    const r = await fetch(`${base}/api/preview/${enc}?width=${width}&height=${height}`);
    const j = await r.json();
    if (!j.ok) throw new Error(`preview failed for ${node}: ${JSON.stringify(j.error ?? j)}`);
    writeFileSync(join(dir, `f_${String(i).padStart(3, "0")}.png`), Buffer.from(j.data.base64, "base64"));
    captured++;
  }
  console.log(`captured ${captured} frames from ${node}`);

  mkdirSync(dirname(out), { recursive: true });
  const seq = join(dir, "f_%03d.png");
  if (out.endsWith(".mp4")) {
    // h264 + yuv420p + even dimensions for broad browser support; faststart for
    // streaming. Far smaller than GIF for detailed/animated visuals (use a looping
    // muted <video> to embed). crf 24 keeps files light.
    execFileSync("ffmpeg", [
      "-y", "-framerate", String(fps), "-i", seq,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart",
      out, "-loglevel", "error",
    ]);
  } else {
    const pal = join(dir, "palette.png");
    execFileSync("ffmpeg", ["-y", "-framerate", String(fps), "-i", seq, "-vf", "palettegen=stats_mode=diff", pal, "-loglevel", "error"]);
    execFileSync("ffmpeg", ["-y", "-framerate", String(fps), "-i", seq, "-i", pal, "-lavfi", "paletteuse=dither=bayer:bayer_scale=3", "-loop", "0", out, "-loglevel", "error"]);
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
