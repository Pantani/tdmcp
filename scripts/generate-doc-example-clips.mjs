#!/usr/bin/env node
/**
 * Generate small MP4 clips used by the prompt cookbook.
 *
 * These are lightweight documentation clips for features whose real output is a
 * timed system, UI surface, or shader/material workflow. Visual-generator demos
 * captured from a live TouchDesigner network should still use capture-example.mjs.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "docs/public/examples");
const width = 480;
const height = 270;
const fps = 20;
const frames = 56;

function clamp(value, min = 0, max = 255) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function mixColor(a, b, t) {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function hsv(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const n = i % 6;
  let out;
  if (n === 0) out = [v, t, p];
  else if (n === 1) out = [q, v, p];
  else if (n === 2) out = [p, v, t];
  else if (n === 3) out = [p, q, v];
  else if (n === 4) out = [t, p, v];
  else out = [v, p, q];
  return out.map((c) => c * 255);
}

function hash(x, y, seed = 0) {
  return (Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453123) % 1;
}

function set(buf, x, y, color, alpha = 1) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (Math.floor(y) * width + Math.floor(x)) * 3;
  buf[i] = clamp(buf[i] * (1 - alpha) + color[0] * alpha);
  buf[i + 1] = clamp(buf[i + 1] * (1 - alpha) + color[1] * alpha);
  buf[i + 2] = clamp(buf[i + 2] * (1 - alpha) + color[2] * alpha);
}

function rect(buf, x, y, w, h, color, alpha = 1) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.ceil(x + w));
  const y1 = Math.min(height, Math.ceil(y + h));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) set(buf, px, py, color, alpha);
  }
}

function circle(buf, cx, cy, radius, color, alpha = 1) {
  const r2 = radius * radius;
  const x0 = Math.floor(cx - radius);
  const y0 = Math.floor(cy - radius);
  const x1 = Math.ceil(cx + radius);
  const y1 = Math.ceil(cy + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 <= r2) {
        const edge = smoothstep(1, 0.78, Math.sqrt(d2) / radius);
        set(buf, x, y, color, alpha * edge);
      }
    }
  }
}

function glow(buf, cx, cy, radius, color, power = 1) {
  const x0 = Math.floor(cx - radius);
  const y0 = Math.floor(cy - radius);
  const x1 = Math.ceil(cx + radius);
  const y1 = Math.ceil(cy + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / radius;
      if (d <= 1) set(buf, x, y, color, (1 - d) ** 2 * power);
    }
  }
}

function line(buf, x0, y0, x1, y1, color, alpha = 1) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let i = 0; i <= steps; i++) {
    const t = i / Math.max(1, steps);
    set(buf, mix(x0, x1, t), mix(y0, y1, t), color, alpha);
  }
}

function backdrop(buf, top = [8, 12, 18], bottom = [3, 5, 10]) {
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    const c = mixColor(top, bottom, t);
    for (let x = 0; x < width; x++) set(buf, x, y, c);
  }
}

function proceduralClip(x, y, t, kind) {
  const u = (x / width - 0.5) * 2;
  const v = (y / height - 0.5) * 2;
  const r = Math.hypot(u, v);
  const a = Math.atan2(v, u);
  if (kind === 0) {
    const wave = Math.sin(22 * r - 8 * t + Math.sin(a * 6)) * 0.5 + 0.5;
    return mixColor([13, 22, 48], [44, 230, 255], wave * smoothstep(1.2, 0.1, r));
  }
  if (kind === 1) {
    const stripes = Math.sin((u + v) * 18 + t * 9) * 0.5 + 0.5;
    const pulse = Math.sin(t * 5 + r * 10) * 0.5 + 0.5;
    return mixColor([245, 60, 130], [255, 210, 68], stripes * 0.75 + pulse * 0.25);
  }
  const cells = Math.sin(a * 9 + t * 3) * Math.cos(r * 24 - t * 4);
  return mixColor([19, 190, 118], [118, 75, 255], cells * 0.5 + 0.5);
}

function baseFrame() {
  const buf = Buffer.alloc(width * height * 3);
  backdrop(buf);
  return buf;
}

function autoMontageFrame(t) {
  const buf = baseFrame();
  const phase = (t * 2.1) % 3;
  const current = Math.floor(phase);
  const next = (current + 1) % 3;
  const fade = smoothstep(0.62, 1, phase - current);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = mixColor(proceduralClip(x, y, t, current), proceduralClip(x, y, t, next), fade);
      set(buf, x, y, c, 0.96);
    }
  }
  rect(buf, 30, 212, 420, 32, [0, 0, 0], 0.38);
  for (let i = 0; i < 3; i++) {
    const x = 52 + i * 132;
    const active = i === current || (i === next && fade > 0.35);
    rect(buf, x, 220, 92, 12, active ? [255, 255, 255] : [120, 130, 150], active ? 0.85 : 0.35);
    rect(
      buf,
      x,
      234,
      92 * (i === current ? 1 - fade : i === next ? fade : 0.12),
      4,
      [55, 232, 190],
      0.85,
    );
  }
  return buf;
}

function euclideanFrame(t) {
  const buf = baseFrame();
  const step = Math.floor(t * 9) % 16;
  const hits = new Set([0, 3, 6, 10, 13]);
  const flash = hits.has(step) ? 1 - ((t * 9) % 1) : 0;
  glow(buf, width / 2, 96, 128 + flash * 60, [60, 245, 220], 0.35 + flash * 0.65);
  circle(buf, width / 2, 96, 62 + flash * 16, [255, 255, 255], 0.08 + flash * 0.18);
  for (let i = 0; i < 16; i++) {
    const x = 34 + i * 26;
    const active = hits.has(i);
    const now = i === step;
    const h = active ? 72 : 34;
    rect(buf, x, 185 - h, 16, h, active ? [250, 96, 142] : [74, 88, 112], active ? 0.74 : 0.38);
    rect(buf, x, 193, 16, 18, now ? [255, 236, 116] : [32, 40, 58], now ? 0.98 : 0.9);
    if (now) glow(buf, x + 8, 202, 30, [255, 236, 116], 0.9);
  }
  for (let i = 0; i < 5; i++) {
    const a = t * 2 + i * 1.256;
    circle(buf, width / 2 + Math.cos(a) * 92, 96 + Math.sin(a) * 42, 7, [255, 236, 116], 0.75);
  }
  return buf;
}

function presetMorphFrame(t) {
  const buf = baseFrame();
  const palettes = [
    [32, 221, 255],
    [255, 67, 135],
    [255, 214, 86],
    [94, 255, 164],
  ];
  const phase = (t * 1.35) % palettes.length;
  const a = Math.floor(phase);
  const b = (a + 1) % palettes.length;
  const blend = smoothstep(0, 1, phase - a);
  const main = mixColor(palettes[a], palettes[b], blend);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - width / 2, y - height / 2) / 190;
      const swirl = Math.sin(d * 21 - t * 7 + Math.atan2(y - height / 2, x - width / 2) * 4);
      set(buf, x, y, mixColor([8, 10, 18], main, (swirl * 0.5 + 0.5) * (1 - d)), 0.86);
    }
  }
  glow(buf, width / 2, height / 2, 130, main, 0.55);
  circle(buf, width / 2, height / 2, 58 + Math.sin(t * 8) * 8, [255, 255, 255], 0.12);
  palettes.forEach((color, i) => {
    const x = 38 + i * 104;
    rect(buf, x, 218, 76, 14, color, 0.84);
    rect(buf, x, 238, 76 * (i === a ? 1 - blend : i === b ? blend : 0.16), 5, [255, 255, 255], 0.9);
  });
  return buf;
}

function sceneTimelineFrame(t) {
  const buf = baseFrame();
  const playhead = (t % 1) * width;
  for (let y = 0; y < 190; y++) {
    for (let x = 0; x < width; x++) {
      const scene = x < width * 0.34 ? 0 : x < width * 0.68 ? 1 : 2;
      const c = proceduralClip(x, y, t + scene * 0.3, scene);
      const vignette = smoothstep(0.95, 0.1, Math.hypot(x / width - 0.5, y / 190 - 0.5));
      set(buf, x, y, c, 0.78 * vignette);
    }
  }
  rect(buf, 24, 204, 432, 38, [8, 12, 20], 0.92);
  const segments = [
    [24, 144, [48, 220, 255]],
    [168, 144, [255, 84, 145]],
    [312, 144, [255, 215, 86]],
  ];
  for (const [x, w, color] of segments) {
    rect(buf, x + 3, 211, w - 6, 24, color, 0.42);
    rect(buf, x + 3, 211, (w - 6) * 0.32, 24, color, 0.78);
  }
  line(buf, playhead, 20, playhead, 248, [255, 255, 255], 0.95);
  glow(buf, playhead, 212, 36, [255, 255, 255], 0.65);
  return buf;
}

function glslMaterialFrame(t) {
  const buf = baseFrame();
  const cx = width / 2;
  const cy = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x - cx) / 88;
      const v = (y - cy) / 88;
      const r2 = u * u + v * v;
      if (r2 <= 1) {
        const z = Math.sqrt(1 - r2);
        const light = clamp((u * -0.28 + v * -0.42 + z * 0.86) * 0.9 + 0.1, 0, 1);
        const fresnel = (1 - z) ** 2;
        const stripe = Math.sin((u * 1.9 + v * 2.6 + z * 2.4 + t * 1.8) * 8) * 0.5 + 0.5;
        const color = hsv((stripe * 0.18 + t * 0.08 + fresnel * 0.35) % 1, 0.64, light);
        set(buf, x, y, mixColor(color, [255, 255, 255], fresnel * 0.45), 0.98);
      } else {
        const star = hash(Math.floor(x / 3), Math.floor(y / 3), 12);
        if (star > 0.985) set(buf, x, y, [90, 140, 180], 0.5);
      }
    }
  }
  glow(buf, cx - 40, cy - 34, 62, [255, 255, 255], 0.16);
  rect(buf, 336, 36, 92, 18, [255, 255, 255], 0.18);
  rect(buf, 336, 62, 68 + Math.sin(t * 3) * 18, 8, [57, 232, 190], 0.75);
  rect(buf, 336, 78, 54 + Math.cos(t * 2.3) * 20, 8, [255, 92, 155], 0.75);
  return buf;
}

function dashboardFrame(t) {
  const buf = Buffer.alloc(width * height * 3);
  backdrop(buf, [7, 9, 14], [2, 3, 6]);
  rect(buf, 22, 20, 190, 124, [18, 24, 34], 0.95);
  for (let y = 26; y < 138; y++) {
    for (let x = 28; x < 206; x++) {
      set(buf, x, y, proceduralClip(x, y, t, 0), 0.72);
    }
  }
  for (let i = 0; i < 8; i++) {
    const x = 236 + (i % 4) * 48;
    const y = 28 + Math.floor(i / 4) * 44;
    const active = Math.floor(t * 2.5) % 8 === i;
    rect(buf, x, y, 36, 28, active ? [57, 232, 190] : [35, 44, 62], active ? 0.9 : 0.85);
    if (active) glow(buf, x + 18, y + 14, 22, [57, 232, 190], 0.8);
  }
  for (let i = 0; i < 4; i++) {
    const x = 246 + i * 44;
    rect(buf, x, 130, 10, 86, [32, 38, 50], 1);
    rect(buf, x, 130 + 86 * (0.18 + i * 0.08), 10, 86 * (0.72 - i * 0.07), [255, 214, 86], 0.85);
  }
  const panicPulse = smoothstep(0.75, 1, Math.sin(t * 5) * 0.5 + 0.5);
  rect(buf, 38, 174, 152, 50, mixColor([100, 24, 32], [255, 34, 72], panicPulse), 0.9);
  glow(buf, 114, 199, 44 + panicPulse * 24, [255, 34, 72], 0.45);
  rect(buf, 374, 28, 56, 188, [16, 20, 28], 0.92);
  for (let i = 0; i < 14; i++) {
    const y = 42 + i * 12;
    rect(buf, 386, y, 30 + Math.sin(t * 8 + i) * 12, 5, [57, 232, 190], 0.76);
  }
  return buf;
}

const clips = [
  ["auto-montage-shuffle.mp4", autoMontageFrame],
  ["euclidean-strobe-pattern.mp4", euclideanFrame],
  ["preset-morph-blend.mp4", presetMorphFrame],
  ["scene-timeline-arranger.mp4", sceneTimelineFrame],
  ["glsl-material-iridescent.mp4", glslMaterialFrame],
  ["live-dashboard-panic.mp4", dashboardFrame],
];

function writePpm(file, buf) {
  writeFileSync(file, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), buf]));
}

function encode(name, renderer) {
  const temp = mkdtempSync(join(tmpdir(), "tdmcp-doc-clips-"));
  const out = join(outDir, name);
  mkdirSync(dirname(out), { recursive: true });
  for (let frame = 0; frame < frames; frame++) {
    writePpm(join(temp, `frame_${String(frame + 1).padStart(3, "0")}.ppm`), renderer(frame / fps));
  }
  const result = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-framerate",
      String(fps),
      "-i",
      join(temp, "frame_%03d.ppm"),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "24",
      "-movflags",
      "+faststart",
      out,
      "-loglevel",
      "error",
    ],
    { stdio: "inherit" },
  );
  rmSync(temp, { recursive: true, force: true });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed while writing ${name}`);
  }
  console.log(`wrote ${out}`);
}

for (const [name, renderer] of clips) {
  encode(name, renderer);
}
