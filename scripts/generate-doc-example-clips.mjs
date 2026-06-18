#!/usr/bin/env node
/**
 * Generate small MP4 clips used by the prompt cookbook.
 *
 * These are lightweight documentation clips for the prompt cookbook. Cookbook
 * media should read as the visual result an artist would get from the prompt,
 * not as an explanatory diagram of the command that produced it. Visual-generator
 * demos captured from a live TouchDesigner network should still use
 * capture-example.mjs.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

function rand(x, y, seed = 0) {
  const h = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453123;
  return h - Math.floor(h);
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

function ellipseRing(buf, cx, cy, rx, ry, thickness, color, alpha = 1) {
  const x0 = Math.floor(cx - rx - thickness * rx);
  const y0 = Math.floor(cy - ry - thickness * ry);
  const x1 = Math.ceil(cx + rx + thickness * rx);
  const y1 = Math.ceil(cy + ry + thickness * ry);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
      if (d <= thickness) set(buf, x, y, color, alpha * smoothstep(thickness, 0, d));
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

const pixelFont = {
  " ": ["000", "000", "000", "000", "000", "000", "000"],
  "!": ["010", "010", "010", "010", "010", "000", "010"],
  "'": ["010", "010", "000", "000", "000", "000", "000"],
  "-": ["000", "000", "000", "111", "000", "000", "000"],
  ".": ["000", "000", "000", "000", "000", "000", "010"],
  "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  5: ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  6: ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  9: ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  ":": ["000", "010", "000", "000", "010", "000", "000"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10011", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

function pixelTextWidth(text, scale = 4, tracking = 1) {
  const chars = String(text).toUpperCase().split("");
  return chars.reduce((sum, char, index) => {
    const rows = pixelFont[char] ?? pixelFont["?"];
    return sum + rows[0].length * scale + (index < chars.length - 1 ? scale + tracking : 0);
  }, 0);
}

function alignedPixelTextX(text, x, scale, tracking, align) {
  const width = pixelTextWidth(text, scale, tracking);
  const offsets = { center: width / 2, right: width };
  return x - (offsets[align] ?? 0);
}

function pixelJitterOffset(row, col, px, y, jitter, seed) {
  if (!jitter) return [0, 0];
  return [
    (rand(col, row, seed + px * 0.01) - 0.5) * jitter,
    (rand(row, col, seed + y * 0.01) - 0.5) * jitter,
  ];
}

function drawPixelGlyph(buf, rows, px, y, options) {
  const { scale, color, alpha, jitter, seed } = options;
  for (let row = 0; row < rows.length; row++) {
    for (let col = 0; col < rows[row].length; col++) {
      if (rows[row][col] !== "1") continue;
      const [dx, dy] = pixelJitterOffset(row, col, px, y, jitter, seed);
      rect(buf, px + col * scale + dx, y + row * scale + dy, scale, scale, color, alpha);
    }
  }
}

function pixelTextOptions(options = {}) {
  return {
    align: options.align ?? "left",
    alpha: options.alpha ?? 1,
    color: options.color ?? [255, 255, 255],
    jitter: options.jitter ?? 0,
    scale: options.scale ?? 4,
    seed: options.seed ?? 0,
    tracking: options.tracking ?? 1,
  };
}

function drawPixelText(buf, text, x, y, options = {}) {
  const config = pixelTextOptions(options);
  const chars = String(text).toUpperCase().split("");
  let px = alignedPixelTextX(text, x, config.scale, config.tracking, config.align);
  for (const char of chars) {
    const rows = pixelFont[char] ?? pixelFont["?"];
    drawPixelGlyph(buf, rows, px, y, config);
    px += rows[0].length * config.scale + config.scale + config.tracking;
  }
}

function polygon(buf, points, color, alpha = 1) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersects) inside = !inside;
      }
      if (inside) set(buf, x, y, color, alpha);
    }
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

function probSequencerFrame(t) {
  const buf = baseFrame();
  const states = [
    { x: 126, y: 78, color: [57, 232, 190] },
    { x: 246, y: 66, color: [255, 214, 86] },
    { x: 346, y: 136, color: [255, 84, 145] },
    { x: 172, y: 164, color: [116, 102, 255] },
  ];
  const sequence = [0, 1, 2, 1, 3, 0, 2, 2, 1, 3, 0, 1];
  const phase = t * 4.8;
  const step = Math.floor(phase) % sequence.length;
  const nextStep = (step + 1) % sequence.length;
  const active = sequence[step];
  const next = sequence[nextStep];
  const beat = phase % 1;
  for (const [from, to, weight] of [
    [0, 1, 0.72],
    [1, 2, 0.54],
    [1, 3, 0.34],
    [2, 1, 0.62],
    [3, 0, 0.82],
    [0, 2, 0.28],
  ]) {
    line(
      buf,
      states[from].x,
      states[from].y,
      states[to].x,
      states[to].y,
      [72, 84, 112],
      0.2 + weight * 0.34,
    );
  }
  line(
    buf,
    states[active].x,
    states[active].y,
    states[next].x,
    states[next].y,
    [255, 255, 255],
    0.35 + beat * 0.56,
  );
  states.forEach((state, i) => {
    const isActive = i === active;
    const radius = isActive ? 27 + (1 - beat) * 11 : 21;
    glow(buf, state.x, state.y, radius * 2.2, state.color, isActive ? 0.88 : 0.28);
    circle(buf, state.x, state.y, radius, state.color, isActive ? 0.9 : 0.58);
    circle(buf, state.x, state.y, radius * 0.48, [255, 255, 255], isActive ? 0.26 : 0.08);
  });
  rect(buf, 34, 218, 412, 21, [9, 14, 24], 0.9);
  sequence.forEach((state, i) => {
    const x = 44 + i * 32;
    rect(buf, x, 225, 20, 7, states[state].color, i === step ? 0.96 : 0.45);
    if (i === step) glow(buf, x + 10, 228, 28, states[state].color, 0.75);
  });
  return buf;
}

function automationLaneFrame(t) {
  const buf = baseFrame();
  rect(buf, 34, 34, 412, 152, [12, 18, 30], 0.96);
  for (let i = 0; i <= 8; i++) {
    const x = 54 + i * 46;
    line(buf, x, 46, x, 174, [38, 48, 68], 0.48);
  }
  for (let i = 0; i <= 4; i++) {
    const y = 54 + i * 28;
    line(buf, 54, y, 424, y, [38, 48, 68], 0.4);
  }
  const points = [];
  for (let i = 0; i <= 130; i++) {
    const u = i / 130;
    const yValue =
      0.52 + Math.sin(u * Math.PI * 4.2 + 0.8) * 0.27 + Math.sin(u * Math.PI * 11) * 0.08;
    points.push([54 + u * 370, 164 - clamp(yValue, 0.05, 0.95) * 108]);
  }
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    line(buf, x0, y0, x1, y1, [57, 232, 190], 0.86);
  }
  const play = (t * 0.58) % 1;
  const playX = 54 + play * 370;
  const idx = Math.floor(play * (points.length - 1));
  const [, playY] = points[idx];
  line(buf, playX, 38, playX, 188, [255, 255, 255], 0.92);
  glow(buf, playX, playY, 42, [255, 214, 86], 0.8);
  circle(buf, playX, playY, 9, [255, 214, 86], 0.95);
  rect(buf, 70, 210, 340, 20, [22, 28, 40], 1);
  rect(buf, 70, 210, 340 * play, 20, [57, 232, 190], 0.78);
  rect(buf, 70, 238, 92, 10, [255, 84, 145], 0.75 + Math.sin(t * 8) * 0.12);
  return buf;
}

function chromaTransientEnergyFrame(t) {
  const buf = baseFrame();
  const cx = 138;
  const cy = 120;
  const pulse = Math.max(0, Math.sin(t * 10)) ** 5;
  for (let i = 0; i < 12; i++) {
    const a = -Math.PI / 2 + (i / 12) * Math.PI * 2;
    const amp = 0.35 + 0.45 * (Math.sin(t * 2.2 + i * 0.9) * 0.5 + 0.5);
    const r0 = 42;
    const r1 = 58 + amp * 48;
    const color = hsv(i / 12, 0.7, 1);
    line(
      buf,
      cx + Math.cos(a) * r0,
      cy + Math.sin(a) * r0,
      cx + Math.cos(a) * r1,
      cy + Math.sin(a) * r1,
      color,
      0.78,
    );
    circle(buf, cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, 4, color, 0.84);
  }
  circle(buf, cx, cy, 38 + pulse * 8, [255, 255, 255], 0.08 + pulse * 0.18);
  for (let i = 0; i < 46; i++) {
    const x = 250 + i * 4;
    const transient = Math.max(0, Math.sin(t * 8 + i * 0.46)) ** 8;
    const sustain = 0.34 + Math.sin(t * 1.6 + i * 0.18) * 0.18;
    rect(buf, x, 198 - transient * 88, 2, transient * 88, [255, 84, 145], 0.9);
    rect(buf, x, 198 - sustain * 88, 2, sustain * 88, [57, 232, 190], 0.68);
  }
  const energy = 0.38 + Math.sin(t * 1.7 - 0.4) * 0.26 + pulse * 0.24;
  rect(buf, 256, 54, 150, 28, [38, 48, 68], 0.85);
  rect(
    buf,
    256,
    54,
    150 * clamp(energy, 0, 1),
    28,
    energy > 0.72 ? [255, 84, 145] : [255, 214, 86],
    0.9,
  );
  rect(buf, 256, 92, 96, 12, [57, 232, 190], energy > 0.56 ? 0.82 : 0.28);
  rect(buf, 360, 92, 46, 12, [255, 84, 145], energy > 0.74 ? 0.88 : 0.22);
  return buf;
}

function moodboardFrame(t) {
  const buf = baseFrame();
  const moods = [
    [
      [18, 44, 72],
      [48, 210, 224],
      [248, 194, 82],
    ],
    [
      [58, 22, 78],
      [255, 74, 142],
      [108, 102, 255],
    ],
    [
      [10, 28, 24],
      [68, 210, 130],
      [238, 224, 162],
    ],
  ];
  moods.forEach((palette, i) => {
    const y = 34 + i * 68;
    rect(buf, 30, y, 112, 48, palette[0], 0.98);
    for (let x = 0; x < 112; x++) {
      for (let yy = 0; yy < 48; yy++) {
        const c = mixColor(
          palette[1],
          palette[2],
          (Math.sin(x * 0.08 + yy * 0.13 + t * 2 + i) + 1) / 2,
        );
        set(buf, 30 + x, y + yy, c, 0.45);
      }
    }
    rect(buf, 158, y + 8, 54, 6, palette[1], 0.85);
    rect(buf, 158, y + 22, 80, 6, palette[2], 0.72);
    rect(buf, 158, y + 36, 40 + Math.sin(t * 3 + i) * 18, 6, [255, 255, 255], 0.36);
  });
  for (let y = 20; y < 244; y++) {
    for (let x = 264; x < 450; x++) {
      const u = (x - 264) / 186;
      const v = (y - 20) / 224;
      const rings = Math.sin(Math.hypot(u - 0.5, v - 0.52) * 32 - t * 6);
      const fold = Math.sin(Math.atan2(v - 0.5, u - 0.5) * 5 + t * 1.8);
      const color = mixColor([24, 220, 218], [255, 92, 144], rings * 0.35 + fold * 0.22 + 0.5);
      set(buf, x, y, color, 0.82);
    }
  }
  line(buf, 220, 58, 262, 82, [255, 255, 255], 0.5);
  line(buf, 220, 126, 262, 132, [255, 255, 255], 0.5);
  line(buf, 220, 194, 262, 180, [255, 255, 255], 0.5);
  rect(buf, 286, 218, 124, 9, [255, 214, 86], 0.74 + Math.sin(t * 4) * 0.14);
  return buf;
}

function audioFingerprintFrame(t) {
  const buf = baseFrame();
  rect(buf, 28, 42, 186, 146, [10, 16, 28], 0.94);
  for (let i = 0; i < 150; i++) {
    const x = 46 + i;
    const y = 116 + Math.sin(i * 0.19 + t * 8) * (20 + Math.sin(i * 0.07) * 14);
    line(buf, x, 116, x, y, [57, 232, 190], 0.58);
  }
  const features = [0.72, 0.48 + Math.sin(t * 2) * 0.16, 0.82, 0.36 + Math.cos(t * 1.6) * 0.12];
  features.forEach((value, i) => {
    rect(buf, 240 + i * 38, 170 - value * 96, 20, value * 96, [255, 214, 86], 0.78);
    rect(buf, 240 + i * 38, 180, 20, 7, [255, 255, 255], 0.22);
  });
  for (let y = 48; y < 190; y++) {
    for (let x = 396; x < 452; x++) {
      const u = (x - 424) / 52;
      const v = (y - 119) / 72;
      const r = Math.hypot(u, v);
      const c = proceduralClip(x + Math.sin(t * 4) * 12, y, t * 1.2, features[2] > 0.7 ? 1 : 0);
      set(buf, x, y, c, smoothstep(1.2, 0.12, r));
    }
  }
  line(buf, 216, 116, 232, 116, [255, 255, 255], 0.45);
  line(buf, 360, 116, 392, 116, [255, 255, 255], 0.45);
  glow(buf, 424, 119, 64 + Math.sin(t * 8) * 10, [255, 84, 145], 0.36);
  return buf;
}

function drawGrowthBranch(buf, x, y, angle, length, depth, progress) {
  if (depth <= 0 || progress <= 0) return;
  const visible = clamp(progress, 0, 1);
  const x2 = x + Math.cos(angle) * length * visible;
  const y2 = y + Math.sin(angle) * length * visible;
  line(buf, x, y, x2, y2, [122, 236, 150], 0.32 + depth * 0.08);
  glow(buf, x2, y2, 18, [57, 232, 190], 0.08 + depth * 0.03);
  if (progress < 1) return;
  drawGrowthBranch(
    buf,
    x + Math.cos(angle) * length,
    y + Math.sin(angle) * length,
    angle - 0.48,
    length * 0.72,
    depth - 1,
    progress - 0.72,
  );
  drawGrowthBranch(
    buf,
    x + Math.cos(angle) * length,
    y + Math.sin(angle) * length,
    angle + 0.42,
    length * 0.68,
    depth - 1,
    progress - 1.04,
  );
  if (depth % 2 === 0) {
    drawGrowthBranch(
      buf,
      x + Math.cos(angle) * length,
      y + Math.sin(angle) * length,
      angle + 0.05,
      length * 0.58,
      depth - 1,
      progress - 1.3,
    );
  }
}

function growthSystemFrame(t) {
  const buf = baseFrame();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const grain = hash(Math.floor(x / 6), Math.floor(y / 6), 21);
      if (grain > 0.92) set(buf, x, y, [28, 55, 44], 0.42);
    }
  }
  const progress = 1.2 + (Math.sin(t * 1.25) * 0.5 + 0.5) * 2.7;
  drawGrowthBranch(buf, width / 2, 252, -Math.PI / 2, 66, 7, progress);
  rect(buf, 92, 226, 296, 9, [24, 42, 32], 0.9);
  rect(buf, 92, 226, 296 * Math.min(1, progress / 3.9), 9, [122, 236, 150], 0.82);
  return buf;
}

function scoreEnhanceFrame(t) {
  const buf = baseFrame();
  const lift = smoothstep(0.12, 0.86, (t * 0.42) % 1);
  const scores = [
    [0.42, 0.58 + lift * 0.22],
    [0.52, 0.62 + lift * 0.18],
    [0.36, 0.48 + lift * 0.3],
    [0.78, 0.8],
    [0.64, 0.68],
  ];
  rect(buf, 32, 32, 180, 188, [14, 18, 28], 0.94);
  rect(buf, 268, 32, 180, 188, [14, 18, 28], 0.94);
  scores.forEach(([before, after], i) => {
    const y = 58 + i * 30;
    rect(buf, 58, y, 118, 9, [42, 50, 68], 0.85);
    rect(buf, 58, y, 118 * before, 9, [255, 84, 145], 0.72);
    rect(buf, 294, y, 118, 9, [42, 50, 68], 0.85);
    rect(buf, 294, y, 118 * after, 9, i < 3 ? [57, 232, 190] : [255, 214, 86], 0.82);
  });
  for (let i = 0; i < 5; i++) {
    const y = 72 + i * 24;
    line(buf, 214, y, 266, y + Math.sin(t * 3 + i) * 8, [255, 255, 255], 0.18 + lift * 0.4);
  }
  const beforeScore = 52;
  const afterScore = Math.round(62 + lift * 21);
  rect(buf, 88, 184, 70, 18, [255, 84, 145], 0.72);
  rect(buf, 322, 184, 70 + (afterScore - beforeScore) * 1.5, 18, [57, 232, 190], 0.82);
  glow(buf, 374, 192, 38 + lift * 22, [57, 232, 190], 0.42);
  return buf;
}

function timecodeSyncFrame(t) {
  const buf = baseFrame();
  rect(buf, 34, 42, 412, 58, [12, 16, 26], 0.95);
  const frame = Math.floor(t * 24 * 8) % 192;
  for (let i = 0; i < 24; i++) {
    const x = 48 + i * 16;
    const major = i % 4 === 0;
    rect(buf, x, 54, major ? 4 : 2, major ? 34 : 20, [120, 140, 160], major ? 0.58 : 0.34);
  }
  const playX = 48 + (frame % 24) * 16;
  line(buf, playX, 44, playX, 104, [255, 255, 255], 0.95);
  glow(buf, playX, 74, 32, [255, 255, 255], 0.56);
  for (let i = 0; i < 4; i++) {
    const y = 130 + i * 25;
    const locked = (frame + i * 11) % 48 < 34;
    rect(buf, 96, y, 288, 12, [36, 46, 64], 0.9);
    rect(
      buf,
      96,
      y,
      288 * ((frame / 48 + i * 0.18) % 1 || 0.01),
      12,
      locked ? [57, 232, 190] : [255, 84, 145],
      0.78,
    );
    circle(buf, 68, y + 6, 8, locked ? [57, 232, 190] : [255, 84, 145], 0.86);
  }
  rect(buf, 160, 232, 160, 10, [57, 232, 190], 0.72 + Math.sin(t * 6) * 0.12);
  return buf;
}

function feedbackTunnelFrame(t) {
  const buf = baseFrame();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x / width - 0.5) * 2;
      const v = (y / height - 0.5) * 2;
      const r = Math.hypot(u, v);
      const a = Math.atan2(v, u);
      const tunnel = Math.sin(34 / (r + 0.09) + a * 6 + t * 8);
      const ribs = Math.sin(a * 18 + t * 3 + r * 9);
      const pulse = smoothstep(1.18, 0.08, r);
      const c = mixColor(
        [4, 6, 14],
        mixColor([23, 229, 255], [255, 54, 150], ribs * 0.5 + 0.5),
        pulse,
      );
      set(buf, x, y, c, (tunnel * 0.5 + 0.5) * 0.9);
    }
  }
  glow(buf, width / 2, height / 2, 92 + Math.sin(t * 6) * 18, [255, 255, 255], 0.22);
  circle(buf, width / 2, height / 2, 18 + Math.sin(t * 7) * 4, [2, 4, 12], 0.9);
  return buf;
}

function reactionDiffusionFrame(t) {
  const buf = baseFrame();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / 42;
      const v = y / 42;
      const cell =
        Math.sin(u * 2.4 + Math.sin(v * 1.7 + t * 1.9) * 1.8) +
        Math.sin(v * 2.9 - t * 1.3) +
        Math.sin((u + v) * 1.35 + t * 2.1);
      const edge = smoothstep(0.1, 0.9, Math.abs(cell));
      const color = mixColor([4, 12, 8], [104, 255, 182], edge);
      set(buf, x, y, mixColor(color, [8, 245, 255], smoothstep(1.25, 2.4, cell) * 0.65), 0.94);
    }
  }
  glow(buf, width * 0.32, height * 0.48, 120, [72, 255, 184], 0.18);
  glow(buf, width * 0.72, height * 0.4, 96, [255, 214, 86], 0.12);
  return buf;
}

function noiseLandscapeFrame(t) {
  const buf = Buffer.alloc(width * height * 3);
  backdrop(buf, [6, 12, 24], [2, 3, 8]);
  const horizon = 76;
  glow(buf, width * 0.64, horizon + 8, 110, [255, 92, 145], 0.18);
  for (let row = 0; row < 30; row++) {
    const z = row / 29;
    const yBase = horizon + z * z * 168;
    let prev;
    for (let col = -4; col <= 52; col++) {
      const x = col * 10 - z * 86 + 60;
      const wave =
        Math.sin(col * 0.46 + t * 2.1) * (8 + z * 24) +
        Math.sin(col * 0.19 + row * 0.7 - t * 1.3) * (5 + z * 16);
      const p = [x, yBase + wave];
      if (prev) {
        line(
          buf,
          prev[0],
          prev[1],
          p[0],
          p[1],
          mixColor([57, 232, 190], [255, 84, 145], z),
          0.24 + z * 0.32,
        );
      }
      prev = p;
    }
  }
  for (let col = 0; col < 28; col++) {
    let prev;
    for (let row = 0; row < 30; row++) {
      const z = row / 29;
      const x = col * 18 - z * 96 + 16;
      const y = horizon + z * z * 168 + Math.sin(col * 0.7 + row * 0.35 + t) * (4 + z * 18);
      if (prev) line(buf, prev[0], prev[1], x, y, [54, 72, 104], 0.18 + z * 0.18);
      prev = [x, y];
    }
  }
  return buf;
}

function audioSpikesFrame(t) {
  const buf = baseFrame();
  const cx = width / 2;
  const cy = height / 2;
  const bass = Math.max(0, Math.sin(t * 9.2)) ** 4;
  const treble = Math.max(0, Math.sin(t * 21.7 + 0.8)) ** 6;
  glow(buf, cx, cy, 132 + bass * 50, [45, 220, 255], 0.22 + bass * 0.35);
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2 + t * 0.4;
    const amp = 52 + Math.sin(i * 1.7 + t * 5) * 14 + bass * 34 + treble * (i % 3 === 0 ? 24 : 0);
    const x0 = cx + Math.cos(a) * 34;
    const y0 = cy + Math.sin(a) * 34;
    const x1 = cx + Math.cos(a) * amp;
    const y1 = cy + Math.sin(a) * amp;
    const color = mixColor([55, 232, 190], [255, 84, 145], (Math.sin(i * 0.21 + t * 2) + 1) / 2);
    line(buf, x0, y0, x1, y1, color, 0.54 + bass * 0.28);
    if (i % 6 === 0) glow(buf, x1, y1, 16 + bass * 14, color, 0.38);
  }
  circle(buf, cx, cy, 42 + bass * 8, [255, 255, 255], 0.12 + bass * 0.16);
  rect(buf, 74, 224, 332, 9, [22, 28, 44], 0.95);
  rect(buf, 74, 224, 332 * (0.42 + bass * 0.48), 9, [255, 214, 86], 0.85);
  return buf;
}

function feedbackTunnelInfiniteFrame(t) {
  const buf = baseFrame();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x / width - 0.5) * 2;
      const v = (y / height - 0.5) * 2;
      const r = Math.hypot(u, v);
      const a = Math.atan2(v, u);
      const zoom = Math.sin(Math.log(r + 0.03) * 18 - t * 8 + a * 3);
      const spin = Math.sin(a * 8 + r * 20 + t * 4);
      const cam = proceduralClip(x + Math.sin(t * 2) * 20, y + Math.cos(t * 1.4) * 12, t, 1);
      set(
        buf,
        x,
        y,
        mixColor(cam, [12, 4, 22], r * 0.6),
        smoothstep(1.3, 0.1, r) * (0.48 + zoom * 0.32),
      );
      if (spin > 0.82) set(buf, x, y, [255, 42, 152], 0.55);
    }
  }
  circle(buf, width / 2, height / 2, 22, [3, 4, 9], 0.82);
  glow(buf, width / 2, height / 2, 118, [255, 42, 152], 0.32);
  return buf;
}

function projectPoint(x, y, z, rot, scale = 58) {
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  const xr = x * cr - z * sr;
  const zr = x * sr + z * cr + 4.2;
  const s = scale / zr;
  return [width / 2 + xr * s, height / 2 + y * s, s];
}

function scene3dFrame(t) {
  const buf = baseFrame();
  const rot = t * 1.4;
  glow(buf, width / 2, height / 2, 170, [44, 200, 255], 0.13);
  const pts = [];
  for (let xi = -4; xi <= 4; xi++) {
    for (let yi = -2; yi <= 2; yi++) {
      for (let zi = -4; zi <= 4; zi++) {
        const wave = Math.sin(xi * 0.8 + zi * 0.9 + t * 4) * 0.34;
        pts.push({
          p: projectPoint(xi * 0.42, yi * 0.38 + wave, zi * 0.42, rot),
          phase: xi + zi + yi,
        });
      }
    }
  }
  pts.sort((a, b) => a.p[2] - b.p[2]);
  for (const { p, phase } of pts) {
    const color = mixColor([55, 232, 190], [255, 84, 145], (Math.sin(phase + t * 3) + 1) / 2);
    glow(buf, p[0], p[1], 13 * p[2], color, 0.12);
    rect(buf, p[0] - 3.5 * p[2], p[1] - 3.5 * p[2], 7 * p[2], 7 * p[2], color, 0.85);
  }
  return buf;
}

function pbrProductFrame(t) {
  const buf = Buffer.alloc(width * height * 3);
  backdrop(buf, [18, 25, 34], [4, 7, 13]);
  const cx = width / 2;
  const cy = height / 2 + 8;
  polygon(
    buf,
    [
      [94, 228],
      [386, 228],
      [340, 160],
      [138, 160],
    ],
    [12, 16, 22],
    0.94,
  );
  glow(buf, cx - 56, cy - 38, 124, [255, 255, 255], 0.16);
  for (let y = cy - 82; y <= cy + 82; y++) {
    for (let x = cx - 82; x <= cx + 82; x++) {
      const u = (x - cx) / 82;
      const v = (y - cy) / 82;
      const r2 = u * u + v * v;
      if (r2 <= 1) {
        const z = Math.sqrt(1 - r2);
        const spin = Math.sin((u * Math.cos(t) + z * Math.sin(t)) * 8);
        const light = clamp(u * -0.28 + v * -0.35 + z * 0.98, 0, 1);
        const base = mixColor([32, 48, 64], [184, 214, 238], light);
        set(buf, x, y, mixColor(base, [255, 180, 90], smoothstep(0.5, 1, spin) * 0.34), 0.98);
        if (u < -0.42 && v < -0.38) set(buf, x, y, [255, 255, 255], 0.38);
      }
    }
  }
  glow(buf, cx + 60, cy + 44, 58, [40, 120, 255], 0.2);
  rect(buf, 346, 42, 68 + Math.sin(t * 2.4) * 22, 8, [255, 214, 86], 0.78);
  rect(buf, 346, 58, 52 + Math.cos(t * 2.1) * 18, 8, [57, 232, 190], 0.75);
  return buf;
}

function multipassDepthFrame(t) {
  const buf = baseFrame();
  const panels = [
    [18, 30, 138, 206],
    [172, 30, 138, 206],
    [326, 30, 138, 206],
  ];
  panels.forEach(([x, y, w, h]) => {
    rect(buf, x, y, w, h, [10, 14, 22], 0.95);
  });
  for (let i = 0; i < 3; i++) {
    const [px, py, pw, ph] = panels[i];
    for (let y = py + 8; y < py + ph - 8; y++) {
      for (let x = px + 8; x < px + pw - 8; x++) {
        const u = (x - px) / pw;
        const v = (y - py) / ph;
        const depth = smoothstep(0.95, 0.1, Math.hypot(u - 0.5, v - 0.54));
        if (i === 0) set(buf, x, y, mixColor([5, 12, 26], [116, 192, 255], depth), 0.86);
        if (i === 1) set(buf, x, y, [depth * 255, depth * 255, depth * 255], 0.92);
        if (i === 2) set(buf, x, y, mixColor([2, 4, 10], [255, 230, 190], depth ** 0.7), 0.9);
      }
    }
    const cx = px + pw / 2 + Math.sin(t * 1.5 + i) * 8;
    const cy = py + 112;
    glow(buf, cx, cy, 58, i === 2 ? [255, 180, 85] : [80, 180, 255], 0.24);
    circle(buf, cx, cy, 32, i === 1 ? [220, 220, 220] : [255, 255, 255], i === 1 ? 0.36 : 0.13);
  }
  return buf;
}

function shaderParkBlobsFrame(t) {
  const buf = baseFrame();
  const centers = [
    [0.43 + Math.sin(t * 1.8) * 0.12, 0.48 + Math.cos(t * 1.2) * 0.09, 0.22],
    [0.57 + Math.cos(t * 1.4) * 0.1, 0.5 + Math.sin(t * 1.7) * 0.1, 0.2],
    [0.5 + Math.sin(t * 1.1 + 2) * 0.08, 0.39 + Math.cos(t * 1.6) * 0.08, 0.18],
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      let field = 0;
      for (const [cx, cy, r] of centers) {
        field += (r * r) / (((u - cx) * 1.35) ** 2 + (v - cy) ** 2 + 0.008);
      }
      const shell = smoothstep(1.55, 1.95, field) - smoothstep(2.55, 3.2, field);
      const body = smoothstep(1.72, 2.6, field);
      const color = mixColor(
        [40, 180, 255],
        [255, 128, 210],
        Math.sin(field * 1.8 + t * 2) * 0.5 + 0.5,
      );
      set(buf, x, y, color, body * 0.88);
      if (shell > 0.02) set(buf, x, y, [255, 255, 255], shell * 0.45);
    }
  }
  glow(buf, width / 2, height / 2, 128, [130, 80, 255], 0.26);
  return buf;
}

function projectionMappingFrame(t) {
  const buf = baseFrame();
  const quad = [
    [102 + Math.sin(t) * 6, 62],
    [394 + Math.cos(t * 0.9) * 8, 82],
    [354 + Math.sin(t * 1.2) * 10, 230],
    [74 + Math.cos(t * 0.8) * 7, 208],
  ];
  polygon(buf, quad, [25, 35, 52], 0.96);
  for (let i = 0; i < 18; i++) {
    const u = i / 17;
    line(
      buf,
      mix(quad[0][0], quad[3][0], u),
      mix(quad[0][1], quad[3][1], u),
      mix(quad[1][0], quad[2][0], u),
      mix(quad[1][1], quad[2][1], u),
      [72, 92, 120],
      0.3,
    );
  }
  for (let i = 0; i < 7; i++) {
    const a = t * 2 + i;
    const cx = mix(quad[0][0], quad[2][0], 0.5) + Math.cos(a) * 84;
    const cy = mix(quad[0][1], quad[2][1], 0.5) + Math.sin(a * 1.4) * 48;
    glow(buf, cx, cy, 70, i % 2 ? [255, 84, 145] : [57, 232, 190], 0.38);
  }
  for (const p of quad) circle(buf, p[0], p[1], 7, [255, 214, 86], 0.92);
  return buf;
}

function transitionGlitchFrame(t) {
  const buf = baseFrame();
  const progress = (Math.sin(t * 1.6) + 1) / 2;
  for (let y = 0; y < height; y++) {
    const offset = Math.sin(y * 0.13 + t * 12) * 34 * smoothstep(0.22, 0.8, progress);
    for (let x = 0; x < width; x++) {
      const wipe = x / width < progress + Math.sin(y * 0.09 + t * 8) * 0.08;
      const src = wipe
        ? proceduralClip(x + offset, y, t, 1)
        : proceduralClip(x - offset, y, t + 0.2, 0);
      set(buf, x, y, src, 0.92);
      if (rand(Math.floor(x / 9), Math.floor(y / 7), Math.floor(t * 9)) > 0.975) {
        set(buf, x, y, [255, 255, 255], 0.8);
      }
    }
  }
  rect(buf, 68, 226, 344, 9, [7, 10, 18], 0.92);
  rect(buf, 68, 226, 344 * progress, 9, [255, 214, 86], 0.84);
  return buf;
}

function videoGlitchTear(y, t) {
  const randomTear = rand(Math.floor(y / 9), Math.floor(t * 8), 2) > 0.78 ? 34 : 0;
  return Math.sin(y * 0.19 + t * 18) * 18 + randomTear;
}

function videoScanIntensity(y) {
  return y % 4 < 2 ? 0.82 : 0.55;
}

function videoGlitchColor(x, y, t, tear) {
  const src = proceduralClip(x + tear, y + Math.sin(t * 3) * 12, t, 0);
  const scan = videoScanIntensity(y);
  const noise = rand(Math.floor(x / 4), Math.floor(y / 4), Math.floor(t * 16));
  return [
    clamp(src[0] * scan + noise * 42),
    clamp(src[1] * (scan * 0.92) + noise * 18),
    clamp(src[2] * (scan * 1.08) + noise * 58),
  ];
}

function drawVideoGlitchGhosts(buf, x, y, t) {
  if (x + 3 < width && Math.sin(y * 0.08 + t * 12) > 0.9) set(buf, x + 3, y, [255, 50, 142], 0.22);
  if (x - 3 >= 0 && Math.sin(y * 0.07 - t * 10) > 0.92) set(buf, x - 3, y, [42, 230, 255], 0.22);
}

function videoGlitchFrame(t) {
  const buf = baseFrame();
  for (let y = 0; y < height; y++) {
    const tear = videoGlitchTear(y, t);
    for (let x = 0; x < width; x++) {
      set(buf, x, y, videoGlitchColor(x, y, t, tear), 0.9);
      drawVideoGlitchGhosts(buf, x, y, t);
    }
  }
  for (let i = 0; i < 8; i++) {
    const y = (rand(i, Math.floor(t * 7), 4) * height) | 0;
    rect(buf, 0, y, width, 4 + rand(i, y, 9) * 12, i % 2 ? [255, 84, 145] : [57, 232, 190], 0.18);
  }
  return buf;
}

function poseTrailsFrame(t) {
  const buf = baseFrame();
  const centerX = width / 2 + Math.sin(t * 1.5) * 34;
  const centerY = 82 + Math.sin(t * 1.1) * 8;
  const shoulders = 54 + Math.sin(t * 1.8) * 8;
  const hips = 36 + Math.cos(t * 1.3) * 5;
  const pose = {
    head: [centerX + Math.sin(t * 2) * 5, centerY - 72],
    chest: [centerX, centerY - 30],
    pelvis: [centerX + Math.sin(t * 1.2) * 8, centerY + 34],
    lShoulder: [centerX - shoulders, centerY - 36],
    rShoulder: [centerX + shoulders, centerY - 36],
    lElbow: [centerX - 82 + Math.sin(t * 3.1) * 28, centerY + 4 + Math.cos(t * 2.2) * 20],
    rElbow: [centerX + 82 + Math.cos(t * 2.7) * 26, centerY - 4 + Math.sin(t * 2.4) * 20],
    lWrist: [centerX - 112 + Math.sin(t * 4) * 44, centerY + 44 + Math.cos(t * 2.5) * 34],
    rWrist: [centerX + 112 + Math.cos(t * 3.6) * 44, centerY + 38 + Math.sin(t * 2.8) * 34],
    lHip: [centerX - hips, centerY + 42],
    rHip: [centerX + hips, centerY + 42],
    lKnee: [centerX - 54 + Math.sin(t * 1.9) * 14, centerY + 102],
    rKnee: [centerX + 54 + Math.cos(t * 1.7) * 14, centerY + 102],
    lAnkle: [centerX - 76 + Math.sin(t * 2.2) * 10, centerY + 164],
    rAnkle: [centerX + 76 + Math.cos(t * 2.1) * 10, centerY + 164],
  };
  const links = [
    ["head", "chest"],
    ["lShoulder", "rShoulder"],
    ["chest", "pelvis"],
    ["lShoulder", "lElbow"],
    ["lElbow", "lWrist"],
    ["rShoulder", "rElbow"],
    ["rElbow", "rWrist"],
    ["pelvis", "lHip"],
    ["pelvis", "rHip"],
    ["lHip", "lKnee"],
    ["lKnee", "lAnkle"],
    ["rHip", "rKnee"],
    ["rKnee", "rAnkle"],
  ];
  for (let trail = 12; trail >= 0; trail--) {
    const tt = t - trail * 0.045;
    const alpha = (1 - trail / 13) ** 1.6;
    const left = [centerX - 112 + Math.sin(tt * 4) * 44, centerY + 44 + Math.cos(tt * 2.5) * 34];
    const right = [centerX + 112 + Math.cos(tt * 3.6) * 44, centerY + 38 + Math.sin(tt * 2.8) * 34];
    glow(buf, left[0], left[1], 28 + alpha * 20, [57, 232, 190], alpha * 0.24);
    glow(buf, right[0], right[1], 28 + alpha * 20, [255, 84, 145], alpha * 0.24);
    if (trail < 12) {
      line(
        buf,
        left[0],
        left[1],
        centerX - 112 + Math.sin((tt - 0.045) * 4) * 44,
        centerY + 44 + Math.cos((tt - 0.045) * 2.5) * 34,
        [57, 232, 190],
        alpha * 0.62,
      );
      line(
        buf,
        right[0],
        right[1],
        centerX + 112 + Math.cos((tt - 0.045) * 3.6) * 44,
        centerY + 38 + Math.sin((tt - 0.045) * 2.8) * 34,
        [255, 84, 145],
        alpha * 0.62,
      );
    }
  }
  for (const [a, b] of links) {
    line(buf, pose[a][0], pose[a][1], pose[b][0], pose[b][1], [198, 232, 255], 0.42);
  }
  Object.entries(pose).forEach(([name, point], index) => {
    const accent = name.includes("Wrist")
      ? [255, 214, 86]
      : index % 2
        ? [57, 232, 190]
        : [255, 84, 145];
    glow(
      buf,
      point[0],
      point[1],
      name.includes("Wrist") ? 24 : 14,
      accent,
      name.includes("Wrist") ? 0.54 : 0.24,
    );
    circle(buf, point[0], point[1], name === "head" ? 9 : 5, accent, 0.88);
  });
  for (let i = 0; i < 18; i++) {
    const x = 42 + i * 22;
    const barH = Math.max(6, Math.sin(t * 5 + i * 0.6) * 26 + 30);
    rect(buf, x, 238 - barH, 12, barH, i % 3 ? [57, 232, 190] : [255, 84, 145], 0.4);
  }
  return buf;
}

function shadertoyImportFrame(t) {
  const buf = baseFrame();
  rect(buf, 24, 28, 164, 214, [9, 12, 18], 0.96);
  for (let i = 0; i < 14; i++) {
    const y = 46 + i * 12;
    const len = 44 + rand(i, 0, 3) * 86;
    rect(buf, 42, y, len, 4, i % 3 === 0 ? [255, 84, 145] : [72, 92, 120], 0.75);
  }
  line(buf, 196, 135, 246, 135, [255, 255, 255], 0.35);
  for (let y = 20; y < 250; y++) {
    for (let x = 254; x < 456; x++) {
      const u = (x - 355) / 92;
      const v = (y - 135) / 92;
      const r = Math.hypot(u, v);
      const a = Math.atan2(v, u);
      const nebula = Math.sin(18 * r - t * 5 + Math.sin(a * 5)) + Math.cos(a * 7 + t * 2);
      set(
        buf,
        x,
        y,
        mixColor(
          [8, 9, 24],
          [62, 236, 255],
          smoothstep(-0.4, 1.8, nebula) * smoothstep(1.3, 0.1, r),
        ),
        0.9,
      );
      if (Math.abs(Math.sin(1 / (r + 0.08) + t * 2)) > 0.94) set(buf, x, y, [255, 84, 145], 0.38);
    }
  }
  glow(buf, 356, 136, 108, [62, 236, 255], 0.18);
  return buf;
}

function isfImportFrame(t) {
  const buf = baseFrame();
  for (let y = 18; y < 252; y++) {
    for (let x = 20; x < 334; x++) {
      const plasma =
        Math.sin(x * 0.045 + t * 2) + Math.sin(y * 0.057 - t * 1.7) + Math.sin((x + y) * 0.025);
      set(buf, x, y, hsv((plasma * 0.08 + t * 0.05 + 0.62) % 1, 0.72, 0.92), 0.82);
    }
  }
  rect(buf, 352, 28, 92, 204, [10, 14, 22], 0.92);
  for (let i = 0; i < 6; i++) {
    const y = 50 + i * 28;
    rect(buf, 370, y, 54, 5, i % 2 ? [255, 84, 145] : [57, 232, 190], 0.82);
    circle(buf, 370 + 54 * ((Math.sin(t * 2 + i) + 1) / 2), y + 2, 6, [255, 255, 255], 0.72);
  }
  return buf;
}

function fluidSimFrame(t) {
  const buf = baseFrame();
  const splats = [
    [0.38 + Math.sin(t * 1.7) * 0.18, 0.52 + Math.cos(t * 1.2) * 0.12, [36, 225, 255]],
    [0.62 + Math.cos(t * 1.4) * 0.16, 0.46 + Math.sin(t * 1.5) * 0.14, [255, 76, 142]],
    [0.5 + Math.sin(t * 1.1 + 3) * 0.12, 0.42, [255, 214, 86]],
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      let color = [5, 7, 14];
      let alpha = 0;
      splats.forEach(([cx, cy, c], i) => {
        const dx = u - cx;
        const dy = v - cy;
        const swirl = Math.sin(Math.atan2(dy, dx) * 4 + Math.hypot(dx, dy) * 34 - t * (4 + i));
        const plume = smoothstep(0.56, 0.02, Math.hypot(dx, dy) + swirl * 0.026);
        color = mixColor(color, c, plume * 0.72);
        alpha = Math.max(alpha, plume);
      });
      const smoke = rand(Math.floor((u + t * 0.04) * 80), Math.floor((v - t * 0.02) * 80), 9);
      set(buf, x, y, mixColor(color, [255, 255, 255], smoke * alpha * 0.12), 0.96);
    }
  }
  glow(buf, width * 0.5, height * 0.5, 140, [60, 220, 255], 0.16);
  return buf;
}

function imageParticlesFrame(t) {
  const buf = baseFrame();
  const scatter = Math.max(0, Math.sin(t * 4.2)) ** 3;
  for (let i = 0; i < 2400; i++) {
    const a = i * 2.399963;
    const r = Math.sqrt(i / 2400);
    const sx = Math.cos(a) * r;
    const sy = Math.sin(a) * r * 0.72;
    const shape =
      Math.abs(sx) < 0.72 && sy > -0.54 && sy < 0.54
        ? 1
        : smoothstep(0.88, 0.12, Math.hypot(sx, sy));
    if (shape <= 0.02) continue;
    const burst = scatter * (26 + rand(i, 2, 8) * 118);
    const px = width / 2 + sx * 128 + Math.cos(a + t * 2) * burst;
    const py = height / 2 + sy * 108 + Math.sin(a * 1.7 - t * 3) * burst;
    const color = mixColor([57, 232, 190], [255, 84, 145], rand(i, 0, 4));
    set(buf, px, py, color, 0.72);
    if (i % 43 === 0) glow(buf, px, py, 10, color, 0.2);
  }
  rect(buf, 92, 228, 296, 8, [22, 28, 44], 0.9);
  rect(buf, 92, 228, 296 * scatter, 8, [255, 214, 86], 0.82);
  return buf;
}

function ditherFrame(t) {
  const buf = baseFrame();
  const bayer = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  const palette = [
    [15, 56, 15],
    [48, 98, 48],
    [139, 172, 15],
    [155, 188, 15],
  ];
  for (let by = 0; by < height; by += 4) {
    for (let bx = 0; bx < width; bx += 4) {
      const u = bx / width;
      const v = by / height;
      const shade =
        0.45 +
        0.38 * Math.sin(u * 8 + t * 2) * Math.cos(v * 9 - t * 1.3) +
        0.3 * smoothstep(0.72, 0.1, Math.hypot(u - 0.52, v - 0.5));
      const threshold = bayer[(by / 4) % 4][(bx / 4) % 4] / 16;
      const idx = clamp(Math.floor((shade + threshold * 0.24) * 4), 0, 3);
      rect(buf, bx, by, 4, 4, palette[idx], 0.98);
    }
  }
  for (let i = 0; i < 18; i++) {
    const y = 42 + i * 9;
    line(buf, 58, y, 414, y + Math.sin(t * 2 + i) * 4, [15, 56, 15], 0.24);
  }
  return buf;
}

function halftoneAmberPrintFrame(t) {
  const buf = Buffer.alloc(width * height * 3);
  backdrop(buf, [28, 18, 8], [9, 6, 4]);
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      const u = (x / width - 0.5) * 2;
      const v = (y / height - 0.5) * 2;
      const wave = Math.sin(u * 8 + t * 3.2) + Math.cos(v * 7 - t * 2.6) + Math.sin((u + v) * 5);
      const poster = smoothstep(-0.65, 1.4, wave + 1.1 - Math.hypot(u * 0.9, v * 1.2));
      const radius = 1.2 + poster * 4.8;
      const color = mixColor([62, 32, 10], [255, 176, 54], poster);
      circle(buf, x + 4, y + 4, radius, color, 0.84);
    }
  }
  glow(buf, 244 + Math.sin(t * 1.3) * 28, 122, 120, [255, 126, 30], 0.12);
  for (let i = 0; i < 5; i++) {
    const y = 52 + i * 30;
    rect(buf, 346, y, 58 + Math.sin(t * 2 + i) * 18, 5, [255, 214, 86], 0.42);
    rect(buf, 346, y + 11, 36 + i * 10, 4, [255, 255, 255], 0.14);
  }
  rect(buf, 42, 218, 126, 8, [255, 176, 54], 0.72);
  rect(buf, 188, 218, 74 + Math.sin(t * 2.1) * 24, 8, [255, 84, 36], 0.54);
  return buf;
}

function jfaVoronoiFrame(t) {
  const buf = baseFrame();
  const seeds = [];
  for (let i = 0; i < 24; i++) {
    seeds.push([
      (rand(i, 2, 1) * width + Math.sin(t * 1.2 + i) * 22 + width) % width,
      (rand(i, 4, 2) * height + Math.cos(t * 1.4 + i * 0.7) * 18 + height) % height,
      hsv((i / 24 + 0.58) % 1, 0.55, 0.95),
    ]);
  }
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let best = Infinity;
      let color = [0, 0, 0];
      for (const [sx, sy, sc] of seeds) {
        const d = (x - sx) ** 2 + (y - sy) ** 2;
        if (d < best) {
          best = d;
          color = sc;
        }
      }
      const edge = smoothstep(110, 0, best % 260);
      rect(buf, x, y, 2, 2, mixColor(color, [8, 10, 18], edge * 0.7), 0.96);
      if (edge > 0.72) rect(buf, x, y, 2, 2, [255, 240, 210], 0.32);
    }
  }
  return buf;
}

function pointCloudDriftFrame(t) {
  const buf = Buffer.alloc(width * height * 3);
  backdrop(buf, [5, 9, 16], [1, 3, 8]);
  const cx = width / 2;
  const cy = height / 2 + 8;
  glow(buf, cx, cy, 160, [57, 232, 190], 0.08);
  for (let i = 0; i < 1150; i++) {
    const a = rand(i, 2, 3) * Math.PI * 2;
    const z = rand(i, 7, 4) * 2 - 1;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const spin = a + t * (0.45 + rand(i, 4, 8) * 0.45);
    const noise = Math.sin(i * 0.17 + t * 3.1) * 9;
    const x = cx + Math.cos(spin) * (r * 138 + noise) + z * 22;
    const y = cy + Math.sin(spin) * (r * 58 + noise * 0.28) + z * 42;
    const depth = (z + 1) / 2;
    const color = mixColor([75, 115, 255], [57, 232, 190], depth);
    if (i % 9 === 0) {
      line(buf, x - Math.cos(spin) * 6, y - Math.sin(spin) * 3, x, y, color, 0.12 + depth * 0.08);
    }
    circle(buf, x, y, 0.8 + depth * 1.7, color, 0.28 + depth * 0.46);
  }
  rect(buf, 54, 222, 118, 7, [57, 232, 190], 0.62);
  rect(buf, 198, 222, 108 + Math.sin(t * 1.8) * 22, 7, [75, 115, 255], 0.52);
  rect(buf, 330, 222, 64, 7, [255, 214, 86], 0.44);
  return buf;
}

function strangeAttractorFrame(t) {
  const buf = Buffer.alloc(width * height * 3);
  backdrop(buf, [2, 3, 8], [0, 0, 3]);
  let x = 0.01;
  let y = 0.01;
  const a = 1.4 + Math.sin(t * 0.55) * 0.08;
  const b = -2.3 + Math.cos(t * 0.44) * 0.08;
  const c = 2.4 + Math.sin(t * 0.37) * 0.06;
  const d = -2.1 + Math.cos(t * 0.49) * 0.08;
  glow(buf, 240, 132, 174, [118, 75, 255], 0.18);
  for (let i = 0; i < 62_000; i++) {
    const nx = Math.sin(a * y) - Math.cos(b * x);
    const ny = Math.sin(c * x) - Math.cos(d * y);
    x = nx;
    y = ny;
    if (i < 80) continue;
    const px = 240 + x * 66;
    const py = 134 + y * 44;
    const color = hsv((0.58 + i / 98_000 + t * 0.025) % 1, 0.82, 1);
    set(buf, px, py, color, 0.045);
    if (i % 37 === 0) circle(buf, px, py, 1.1, color, 0.13);
  }
  for (let i = 0; i < 18; i++) {
    circle(
      buf,
      54 + i * 22,
      232 + Math.sin(t * 2 + i) * 5,
      2.5,
      hsv(0.61 + i * 0.012, 0.86, 0.96),
      0.68,
    );
  }
  rect(buf, 72, 244, 116, 5, [118, 75, 255], 0.54);
  rect(buf, 214, 244, 86 + Math.sin(t * 1.4) * 24, 5, [57, 232, 190], 0.52);
  return buf;
}

function videoScopesFrame(t) {
  const buf = baseFrame();
  rect(buf, 24, 26, 184, 116, [10, 14, 22], 0.96);
  for (let y = 32; y < 136; y++) {
    for (let x = 30; x < 202; x++) {
      set(buf, x, y, proceduralClip(x, y, t, 2), 0.86);
    }
  }
  rect(buf, 236, 26, 206, 54, [6, 10, 18], 0.94);
  rect(buf, 236, 98, 206, 54, [6, 10, 18], 0.94);
  rect(buf, 236, 170, 206, 72, [6, 10, 18], 0.94);
  for (let i = 0; i < 180; i++) {
    const x = 250 + i;
    const wave = 52 + Math.sin(i * 0.08 + t * 3) * 18 + Math.sin(i * 0.22) * 9;
    set(buf, x, wave, [57, 232, 190], 0.86);
    rect(buf, x, 130 - Math.abs(Math.sin(i * 0.04 + t + 0.2)) * 28, 2, 2, [255, 84, 145], 0.64);
    const a = (i / 180) * Math.PI * 2;
    set(
      buf,
      338 + Math.cos(a) * (32 + Math.sin(t * 2 + i) * 8),
      206 + Math.sin(a) * 24,
      [255, 214, 86],
      0.72,
    );
  }
  return buf;
}

function chopRecorderFrame(t) {
  const buf = baseFrame();
  rect(buf, 32, 34, 416, 156, [10, 14, 22], 0.96);
  for (let i = 0; i <= 8; i++) line(buf, 54 + i * 46, 46, 54 + i * 46, 176, [42, 50, 68], 0.42);
  const phase = (t * 0.55) % 1;
  let prev;
  for (let i = 0; i <= 220; i++) {
    const u = i / 220;
    const y = 110 - Math.sin(u * Math.PI * 6 + t * 4) * 42 - Math.sin(u * Math.PI * 17) * 10;
    const p = [56 + u * 368, y];
    if (prev)
      line(buf, prev[0], prev[1], p[0], p[1], u < phase ? [255, 84, 145] : [57, 232, 190], 0.86);
    prev = p;
  }
  const x = 56 + phase * 368;
  line(buf, x, 38, x, 186, [255, 255, 255], 0.9);
  glow(buf, x, 110, 42, [255, 84, 145], 0.5);
  rect(buf, 84, 220, 312, 10, [22, 28, 44], 0.92);
  rect(buf, 84, 220, 312 * phase, 10, [57, 232, 190], 0.8);
  return buf;
}

function tdabletonFrame(t) {
  const buf = baseFrame();
  rect(buf, 30, 24, 208, 212, [13, 17, 24], 0.96);
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const active = (Math.floor(t * 3) + r * 2 + c) % 7 === 0;
      const color = active ? [57, 232, 190] : c % 2 ? [48, 58, 78] : [34, 42, 60];
      rect(buf, 48 + c * 34, 44 + r * 30, 24, 20, color, active ? 0.92 : 0.78);
      if (active) glow(buf, 60 + c * 34, 54 + r * 30, 22, [57, 232, 190], 0.7);
    }
  }
  rect(buf, 270, 36, 150, 184, [8, 12, 20], 0.94);
  for (let i = 0; i < 8; i++) {
    const h = 32 + Math.sin(t * 3 + i * 0.8) * 28 + (i % 3) * 8;
    rect(buf, 288 + i * 16, 198 - h, 10, h, i % 2 ? [255, 84, 145] : [255, 214, 86], 0.78);
  }
  line(buf, 238, 130, 270, 130, [255, 255, 255], 0.42);
  return buf;
}

function lutFilmGradeFrame(t) {
  const buf = baseFrame();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = proceduralClip(x, y, t, 2);
      const graded = mixColor(
        [base[0] * 0.65, base[1] * 0.9, base[2] * 1.08],
        [255, 142, 72],
        0.24,
      );
      set(buf, x, y, x < width / 2 ? base : graded, 0.92);
    }
  }
  line(buf, width / 2, 0, width / 2, height, [255, 255, 255], 0.92);
  rect(buf, 72, 218, 132, 8, [160, 180, 210], 0.65);
  rect(buf, 276, 218, 132, 8, [255, 168, 78], 0.86);
  return buf;
}

function flowAbstractionFrame(t) {
  const buf = Buffer.alloc(width * height * 3);
  backdrop(buf, [232, 228, 205], [178, 190, 180]);
  for (let i = 0; i < 520; i++) {
    let x = rand(i, 1, 0) * width;
    let y = rand(i, 2, 0) * height;
    const color = i % 4 === 0 ? [20, 30, 34] : [46, 72, 82];
    for (let s = 0; s < 12; s++) {
      const a = Math.sin(x * 0.018 + y * 0.026 + t * 1.5) * Math.PI;
      const nx = x + Math.cos(a) * 7;
      const ny = y + Math.sin(a) * 5;
      line(buf, x, y, nx, ny, color, 0.18);
      x = nx;
      y = ny;
    }
  }
  glow(buf, 250 + Math.sin(t) * 18, 130, 96, [255, 214, 86], 0.08);
  return buf;
}

function nprFilterFrame(t) {
  const buf = baseFrame();
  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      const u = x / width;
      const v = y / height;
      const shade = Math.sin(u * 12 + t * 1.4) * Math.cos(v * 10 - t * 1.1);
      const color = mixColor([28, 50, 62], [238, 190, 118], smoothstep(-0.8, 0.9, shade));
      rect(buf, x, y, 4, 4, color, 0.9);
    }
  }
  for (let i = 0; i < 42; i++) {
    const y = 42 + i * 4;
    line(
      buf,
      70 + Math.sin(i) * 12,
      y,
      410 + Math.cos(i * 0.8) * 16,
      y + Math.sin(t * 2 + i) * 7,
      [5, 8, 12],
      0.12,
    );
  }
  return buf;
}

function postPasses3dFrame(t) {
  const buf = Buffer.alloc(width * height * 3);
  backdrop(buf, [12, 16, 26], [2, 4, 8]);
  polygon(
    buf,
    [
      [74, 222],
      [404, 224],
      [334, 144],
      [138, 144],
    ],
    [8, 11, 17],
    0.95,
  );
  const orbs = [
    [170 + Math.sin(t) * 18, 138, 34, [255, 94, 122]],
    [248, 116 + Math.cos(t * 1.3) * 12, 46, [78, 210, 255]],
    [326 + Math.cos(t * 1.1) * 12, 148, 28, [255, 214, 86]],
  ];
  for (const [cx, cy, r, c] of orbs) {
    glow(buf, cx, cy, r * 2.2, c, 0.28);
    circle(buf, cx, cy, r, mixColor(c, [255, 255, 255], 0.2), 0.76);
    circle(buf, cx - r * 0.32, cy - r * 0.28, r * 0.18, [255, 255, 255], 0.35);
  }
  for (let i = 0; i < 9; i++) {
    const x = 72 + i * 42;
    line(buf, x, 226, x + 24, 160 + Math.sin(t * 2 + i) * 12, [255, 255, 255], 0.08);
  }
  rect(buf, 348, 34, 68, 8, [57, 232, 190], 0.76);
  rect(buf, 348, 50, 92, 8, [255, 84, 145], 0.56);
  rect(buf, 348, 66, 48 + Math.sin(t * 3) * 20, 8, [255, 214, 86], 0.76);
  return buf;
}

function colorWheelsFrame(t) {
  const buf = baseFrame();
  for (let x = 22; x < 458; x++) {
    const u = (x - 22) / 436;
    const source = mixColor([24, 32, 46], [226, 214, 180], u);
    const grade = mixColor(source, [34, 190, 210], smoothstep(0.05, 0.62, u) * 0.28);
    const warm = mixColor(grade, [255, 150, 72], smoothstep(0.52, 1, u) * 0.32);
    rect(buf, x, 36, 1, 70, source, 0.96);
    rect(buf, x, 112, 1, 70, warm, 0.96);
  }
  for (let i = 0; i < 3; i++) {
    const cx = 118 + i * 122;
    const cy = 220;
    const spin = t * 0.8 + i * 2.1;
    glow(buf, cx, cy, 50, [60, 210, 230], 0.22);
    for (let j = 0; j < 48; j++) {
      const a = (j / 48) * Math.PI * 2;
      const color = hsv((a / (Math.PI * 2) + i * 0.1 + t * 0.04) % 1, 0.78, 0.95);
      line(buf, cx, cy, cx + Math.cos(a) * 34, cy + Math.sin(a) * 34, color, 0.35);
    }
    circle(buf, cx, cy, 35, [8, 12, 18], 0.18);
    circle(buf, cx + Math.cos(spin) * 18, cy + Math.sin(spin) * 18, 6, [255, 255, 255], 0.9);
  }
  rect(buf, 76, 18, 94, 6, [57, 232, 190], 0.85);
  rect(buf, 190, 18, 118, 6, [255, 143, 94], 0.72);
  rect(buf, 328, 18, 72, 6, [130, 160, 255], 0.74);
  return buf;
}

function popGeometryFrame(t) {
  const buf = baseFrame();
  const cx = width / 2;
  const cy = 128;
  const points = [];
  for (let i = 0; i < 34; i++) {
    const a = (i / 34) * Math.PI * 2 + t * 0.9;
    const warp = Math.sin(i * 0.7 + t * 2.4) * 16;
    points.push([cx + Math.cos(a) * (104 + warp), cy + Math.sin(a) * (42 + warp * 0.18)]);
  }
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    line(buf, x0, y0, x1, y1, [70, 220, 245], 0.8);
    line(buf, x0, y0, cx, cy, [255, 255, 255], 0.08);
    circle(buf, x0, y0, 3.5, [255, 219, 90], 0.7);
  }
  glow(buf, cx, cy, 142, [60, 220, 245], 0.18);
  rect(buf, 44, 208, 392, 8, [26, 36, 56], 0.95);
  rect(buf, 44, 208, 100 + Math.sin(t * 2) * 32, 8, [57, 232, 190], 0.92);
  rect(buf, 44, 230, 392, 8, [26, 36, 56], 0.95);
  rect(buf, 44, 230, 225 + Math.cos(t * 1.4) * 38, 8, [255, 87, 142], 0.82);
  rect(buf, 44, 252, 392, 8, [26, 36, 56], 0.95);
  rect(buf, 44, 252, 304 + Math.sin(t * 1.8) * 50, 8, [255, 218, 92], 0.82);
  return buf;
}

function extractPaletteFrame(t) {
  const buf = baseFrame();
  for (let y = 34; y < 220; y++) {
    for (let x = 26; x < 284; x++) {
      const c = proceduralClip(x - 26, y - 34, t, 2);
      const vignette = 1 - Math.hypot((x - 155) / 160, (y - 126) / 120) * 0.28;
      set(
        buf,
        x,
        y,
        c.map((v) => v * vignette),
        0.92,
      );
    }
  }
  const swatches = [
    [24, 188, 126],
    [68, 84, 232],
    [255, 197, 72],
    [235, 72, 128],
    [18, 26, 42],
  ];
  swatches.forEach((color, i) => {
    const reveal = smoothstep(i * 0.18, i * 0.18 + 0.24, (t * 0.62) % 1);
    const y = 42 + i * 35;
    glow(buf, 340, y + 13, 36, color, 0.14 * reveal);
    rect(buf, 322, y, 60 * reveal, 26, color, 0.9);
    rect(buf, 388, y + 6, 54 * reveal, 5, [255, 255, 255], 0.35);
    rect(buf, 388, y + 17, 36 * reveal, 4, [255, 255, 255], 0.18);
  });
  const scanX = 26 + ((t * 82) % 258);
  rect(buf, scanX, 34, 2, 186, [255, 255, 255], 0.65);
  return buf;
}

function paletteExtractAndGradeFrame(t) {
  const buf = baseFrame();
  const swatches = [
    [24, 188, 126],
    [68, 84, 232],
    [255, 197, 72],
    [235, 72, 128],
    [18, 26, 42],
  ];
  for (let y = 30; y < 198; y++) {
    for (let x = 28; x < 214; x++) {
      const source = proceduralClip(x - 28, y - 30, t, 2);
      const pulse = Math.sin((x + y) * 0.035 + t * 3.8) * 0.5 + 0.5;
      const lit = mixColor(source, swatches[Math.floor(pulse * 4.99)], 0.18);
      set(buf, x, y, lit, 0.95);
    }
  }
  for (let y = 30; y < 198; y++) {
    for (let x = 286; x < 452; x++) {
      const source = proceduralClip(x - 286, y - 30, t + 0.18, 2);
      const shadows = mixColor(
        [source[0] * 0.58, source[1] * 0.68, source[2] * 0.95],
        swatches[4],
        0.34,
      );
      const mids = mixColor(shadows, swatches[0], 0.22);
      const highlights = mixColor(
        mids,
        swatches[2],
        smoothstep(0.52, 0.96, (source[0] + source[1]) / 510) * 0.38,
      );
      set(buf, x, y, highlights, 0.94);
    }
  }
  rect(buf, 28, 30, 186, 168, [255, 255, 255], 0.06);
  rect(buf, 286, 30, 166, 168, [255, 255, 255], 0.06);
  const scanX = 28 + ((t * 92) % 186);
  rect(buf, scanX, 30, 2, 168, [255, 255, 255], 0.72);
  for (let i = 0; i < swatches.length; i++) {
    const reveal = smoothstep(i * 0.12, i * 0.12 + 0.22, (t * 0.58) % 1);
    rect(buf, 226, 54 + i * 27, 40 * reveal, 18, swatches[i], 0.92);
    rect(buf, 226 + 48 * reveal, 60 + i * 27, 34 * reveal, 4, [255, 255, 255], 0.24);
    line(buf, 226 + 40 * reveal, 63 + i * 27, 286, 64 + i * 20, swatches[i], 0.24 * reveal);
  }
  rect(buf, 314, 214, 104, 8, [24, 188, 126], 0.72);
  rect(buf, 314, 230, 74, 6, [235, 72, 128], 0.58);
  rect(buf, 314, 244, 128, 6, [255, 197, 72], 0.46);
  return buf;
}

function sopToSvgFrame(t) {
  const buf = Buffer.alloc(width * height * 3);
  rect(buf, 0, 0, width, height, [238, 234, 220], 1);
  for (let x = 36; x <= 444; x += 24) line(buf, x, 24, x, 246, [200, 194, 178], 0.25);
  for (let y = 30; y <= 246; y += 24) line(buf, 30, y, 450, y, [200, 194, 178], 0.25);
  rect(buf, 30, 24, 420, 222, [255, 255, 255], 0.22);

  const paths = [];
  for (let band = 0; band < 7; band++) {
    const pts = [];
    for (let i = 0; i < 120; i++) {
      const u = i / 119;
      const x = 46 + u * 388;
      const y =
        136 +
        Math.sin(u * Math.PI * (2.5 + band * 0.28) + band * 0.74 + t * 1.4) * (22 + band * 3) +
        Math.sin(u * Math.PI * 8 - t * 1.1) * 7 +
        (band - 3) * 12;
      pts.push([x, y]);
    }
    paths.push(pts);
  }

  const reveal = (t * 0.45) % 1;
  paths.forEach((pts, pathIndex) => {
    const color = mixColor([18, 24, 32], [38, 94, 126], pathIndex / Math.max(1, paths.length - 1));
    const limit = Math.max(
      2,
      Math.floor(pts.length * smoothstep(0, 1, reveal + pathIndex * 0.055)),
    );
    for (let i = 0; i < limit - 1; i++)
      line(buf, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], color, 0.82);
  });

  const activePath = paths[Math.floor((t * 2) % paths.length)];
  const penIndex = Math.min(activePath.length - 1, Math.floor(reveal * activePath.length));
  const [penX, penY] = activePath[penIndex];
  circle(buf, penX, penY, 5, [255, 82, 126], 0.92);
  line(buf, penX + 4, penY - 10, penX + 18, penY - 34, [28, 32, 40], 0.75);
  circle(buf, penX + 18, penY - 34, 6, [28, 32, 40], 0.88);
  return buf;
}

function swapOperatorFrame(t) {
  const buf = baseFrame();
  const nodes = [
    [56, 102, 84, 48, [65, 198, 235]],
    [
      198,
      94,
      96,
      64,
      mixColor([255, 88, 132], [255, 208, 80], smoothstep(0.18, 0.86, (t * 0.5) % 1)),
    ],
    [350, 102, 84, 48, [88, 230, 164]],
  ];
  for (let i = 0; i < 3; i++) {
    const [x, y, w, h, c] = nodes[i];
    glow(buf, x + w / 2, y + h / 2, 50, c, 0.2);
    rect(buf, x, y, w, h, [9, 13, 21], 0.96);
    rect(buf, x + 8, y + 10, w - 16, 8, c, 0.82);
    rect(buf, x + 8, y + 26, w - 26, 5, [255, 255, 255], 0.25);
    rect(buf, x + 8, y + 36, w - 38, 5, [255, 255, 255], 0.16);
  }
  line(buf, 140, 126, 198, 126, [255, 255, 255], 0.75);
  line(buf, 294, 126, 350, 126, [255, 255, 255], 0.75);
  const sweep = 198 + smoothstep(0.12, 0.78, (t * 0.65) % 1) * 96;
  rect(buf, sweep - 3, 90, 6, 72, [255, 255, 255], 0.62);
  for (let i = 0; i < 7; i++) {
    const x = 74 + i * 48;
    rect(buf, x, 205, 32, 8, [42, 54, 76], 0.86);
    rect(buf, x, 221, 32, 8, i % 2 === 0 ? [57, 232, 190] : [255, 214, 86], 0.76);
  }
  return buf;
}

function copilotVisionFrame(t) {
  const buf = baseFrame();
  for (let y = 38; y < 220; y++) {
    for (let x = 34; x < 245; x++) {
      set(buf, x, y, proceduralClip(x, y, t, 0), 0.94);
    }
  }
  const scanY = 42 + ((t * 72) % 174);
  rect(buf, 34, scanY, 211, 2, [255, 255, 255], 0.62);
  rect(buf, 280, 44, 156, 24, [22, 30, 46], 0.94);
  rect(buf, 292, 54, 94 + Math.sin(t * 2) * 24, 5, [57, 232, 190], 0.8);
  for (let i = 0; i < 5; i++) {
    const y = 88 + i * 26;
    rect(buf, 280, y, 156, 18, [18, 24, 36], 0.92);
    rect(
      buf,
      292,
      y + 6,
      56 + Math.sin(t * 1.5 + i) * 22,
      5,
      i % 2 ? [255, 214, 86] : [255, 86, 134],
      0.72,
    );
    rect(buf, 362, y + 6, 46 + Math.cos(t * 1.3 + i) * 12, 5, [255, 255, 255], 0.22);
  }
  glow(buf, 140, 126, 120, [80, 210, 255], 0.14);
  return buf;
}

function lookToxTutorialFrame(t) {
  const buf = baseFrame();
  rect(buf, 38, 64, 120, 86, [16, 24, 36], 0.96);
  for (let i = 0; i < 5; i++) {
    rect(
      buf,
      52 + (i % 2) * 48,
      80 + Math.floor(i / 2) * 22,
      36,
      12,
      i % 2 ? [255, 214, 86] : [57, 232, 190],
      0.72,
    );
  }
  const progress = smoothstep(0.1, 0.88, (t * 0.55) % 1);
  line(buf, 158, 108, 246, 108, [255, 255, 255], 0.32 + progress * 0.45);
  circle(buf, 158 + progress * 88, 108, 5, [255, 86, 134], 0.9);
  rect(buf, 246, 72, 68, 76, [235, 241, 244], 0.9);
  rect(buf, 258, 88, 44, 8, [18, 24, 34], 0.5);
  rect(buf, 258, 106, 34, 8, [57, 232, 190], 0.66);
  rect(buf, 258, 124, 46, 8, [255, 214, 86], 0.66);
  rect(buf, 352, 48, 90, 154, [18, 26, 40], 0.94);
  for (let i = 0; i < 4; i++) {
    const y = 64 + i * 32;
    rect(buf, 366, y, 48, 10, [255, 255, 255], 0.24);
    rect(buf, 366, y + 16, 60, 8, i % 2 ? [255, 86, 134] : [57, 232, 190], 0.58);
  }
  return buf;
}

function libraryTagVersionFrame(t) {
  const buf = baseFrame();
  for (let i = 0; i < 5; i++) {
    const y = 36 + i * 40;
    rect(buf, 36, y, 186, 28, [18, 26, 40], 0.95);
    rect(buf, 50, y + 8, 74, 5, [255, 255, 255], 0.24);
    rect(
      buf,
      136,
      y + 8,
      24 + ((i + 1) % 3) * 16,
      5,
      i % 2 ? [57, 232, 190] : [255, 214, 86],
      0.72,
    );
    if ((t * 2 + i) % 5 < 1.2) rect(buf, 198, y + 6, 12, 12, [255, 86, 134], 0.85);
  }
  rect(buf, 270, 46, 142, 150, [15, 22, 34], 0.96);
  for (let i = 0; i < 4; i++) {
    const x = 294 + i * 28;
    circle(buf, x, 92 + i * 22, 8, [57, 232, 190], 0.78);
    if (i > 0) line(buf, x - 28, 70 + i * 22, x, 92 + i * 22, [255, 255, 255], 0.28);
    rect(buf, x + 14, 88 + i * 22, 42, 5, [255, 255, 255], 0.26);
  }
  rect(buf, 292, 218, 104 + Math.sin(t * 2) * 22, 8, [255, 214, 86], 0.78);
  return buf;
}

function generativeClassicsPackFrame(t) {
  const buf = baseFrame();
  for (let i = 0; i < 6; i++) {
    const x0 = 34 + (i % 3) * 138;
    const y0 = 34 + Math.floor(i / 3) * 84;
    for (let y = y0; y < y0 + 62; y++) {
      for (let x = x0; x < x0 + 112; x++) {
        set(buf, x, y, proceduralClip(x - x0, y - y0, t + i * 0.7, i % 3), 0.92);
      }
    }
    rect(buf, x0, y0 + 68, 72, 5, [255, 255, 255], 0.24);
    rect(buf, x0, y0 + 76, 42 + i * 7, 5, i % 2 ? [255, 214, 86] : [57, 232, 190], 0.7);
  }
  rect(buf, 134, 224, 212, 18, [18, 26, 40], 0.94);
  rect(buf, 150, 231, 82 + Math.sin(t * 2) * 20, 5, [255, 255, 255], 0.3);
  rect(buf, 254, 231, 54, 5, [255, 86, 134], 0.72);
  return buf;
}

function dataSourceHotfixFrame(t) {
  const buf = baseFrame();
  rect(buf, 38, 46, 110, 46, [18, 26, 40], 0.95);
  rect(buf, 332, 46, 110, 46, [18, 26, 40], 0.95);
  const pulse = smoothstep(0.1, 0.4, (t * 1.3) % 1) * (1 - smoothstep(0.55, 0.95, (t * 1.3) % 1));
  line(buf, 148, 68, 332, 68, [255, 255, 255], 0.32);
  circle(buf, 148 + pulse * 184, 68, 5, [57, 232, 190], 0.95);
  rect(buf, 186, 116, 108, 96, [12, 18, 28], 0.96);
  for (let i = 0; i < 5; i++) {
    const value = 22 + Math.sin(t * 2.4 + i * 0.8) * 16 + i * 8;
    rect(buf, 206 + i * 14, 190 - value, 9, value, [57, 232, 190], 0.74);
    rect(buf, 206 + i * 14, 196, 9, 6, [255, 214, 86], 0.72);
  }
  rect(buf, 58, 58, 58, 5, [255, 255, 255], 0.28);
  rect(buf, 352, 58, 48, 5, [255, 255, 255], 0.28);
  rect(buf, 218, 126, 44, 5, [255, 86, 134], 0.72);
  return buf;
}

function elicitMissingArgsFrame(t) {
  const buf = baseFrame();
  rect(buf, 52, 36, 376, 198, [14, 21, 34], 0.96);
  const fill = smoothstep(0.12, 0.82, (t * 0.55) % 1);
  for (let i = 0; i < 5; i++) {
    const y = 62 + i * 32;
    rect(buf, 74, y, 92, 8, [255, 255, 255], 0.22);
    rect(buf, 190, y - 5, 178, 18, [28, 38, 58], 0.88);
    const local = smoothstep(i * 0.15, i * 0.15 + 0.24, fill);
    rect(buf, 202, y + 1, (70 + i * 18) * local, 5, i % 2 ? [255, 214, 86] : [57, 232, 190], 0.86);
    if (local > 0.8) circle(buf, 388, y + 4, 6, [88, 230, 164], 0.86);
  }
  rect(buf, 96, 210, 74, 7, [255, 86, 134], 0.72);
  rect(buf, 190, 210, 156 * fill, 7, [57, 232, 190], 0.82);
  return buf;
}

function configInitFrame(t) {
  const buf = baseFrame();
  rect(buf, 74, 28, 332, 214, [235, 241, 244], 0.94);
  for (let i = 0; i < 9; i++) {
    const y = 52 + i * 19;
    const enabled = i !== 2 && i !== 7;
    rect(buf, 96, y, enabled ? 72 : 48, 5, enabled ? [18, 24, 34] : [120, 128, 140], 0.52);
    rect(
      buf,
      184,
      y,
      144 - (i % 3) * 18,
      5,
      i % 2 ? [57, 160, 190] : [196, 92, 122],
      enabled ? 0.7 : 0.22,
    );
    if (!enabled) rect(buf, 84, y - 1, 6, 6, [120, 128, 140], 0.75);
  }
  const cursor = 58 + Math.floor((t * 8) % 9) * 19;
  rect(buf, 84, cursor - 5, 312, 15, [255, 214, 86], 0.18);
  rect(buf, 118, 216, 112, 8, [57, 232, 190], 0.72);
  rect(buf, 248, 216, 70, 8, [255, 86, 134], 0.62);
  return buf;
}

function terminalPanel(buf, x, y, w, h, accent = [57, 232, 190]) {
  rect(buf, x, y, w, h, [12, 18, 30], 0.96);
  rect(buf, x, y, w, 18, [28, 38, 58], 0.92);
  circle(buf, x + 12, y + 9, 3, [255, 86, 134], 0.92);
  circle(buf, x + 24, y + 9, 3, [255, 214, 86], 0.92);
  circle(buf, x + 36, y + 9, 3, accent, 0.92);
}

function agentStatusColor(done, failed) {
  if (failed) return [255, 86, 134];
  return done ? [57, 232, 190] : [74, 88, 112];
}

function drawAgentRunRow(buf, index, scan) {
  const y = 62 + index * 28;
  const done = scan > index;
  const failed = index === 2 && done;
  rect(buf, 62, y, 220 - index * 18, 6, [255, 255, 255], done ? 0.3 : 0.18);
  rect(buf, 314, y - 5, 42, 16, agentStatusColor(done, failed), done ? 0.82 : 0.46);
  if (index === 2 && !done) rect(buf, 314, y - 5, 42, 16, [255, 214, 86], 0.42);
  if (done) circle(buf, 382, y + 2, 5, agentStatusColor(done, failed), 0.92);
}

function agentRunContinueFrame(t) {
  const buf = baseFrame();
  terminalPanel(buf, 32, 30, 416, 198);
  const scan = Math.floor((t * 6) % 5);
  for (let i = 0; i < 5; i++) {
    drawAgentRunRow(buf, i, scan);
  }
  const p = smoothstep(0.08, 0.82, (t * 0.55) % 1);
  rect(buf, 62, 212, 260, 8, [255, 255, 255], 0.14);
  rect(buf, 62, 212, 260 * p, 8, [57, 232, 190], 0.8);
  rect(buf, 338, 206, 80, 20, [255, 214, 86], 0.22 + 0.2 * Math.sin(t * 5));
  return buf;
}

function commandCatalogFrame(t) {
  const buf = baseFrame();
  terminalPanel(buf, 26, 28, 190, 214, [255, 214, 86]);
  rect(buf, 246, 28, 206, 214, [15, 22, 34], 0.96);
  const active = Math.floor((t * 2.2) % 6);
  for (let i = 0; i < 7; i++) {
    const y = 62 + i * 22;
    rect(buf, 48, y, 78 + (i % 3) * 18, 5, [255, 255, 255], i === active ? 0.5 : 0.22);
    rect(
      buf,
      148,
      y - 4,
      36,
      13,
      i % 3 === 0 ? [255, 86, 134] : [57, 232, 190],
      i === active ? 0.82 : 0.38,
    );
    if (i === active) rect(buf, 38, y - 8, 168, 20, [255, 255, 255], 0.08);
  }
  for (let i = 0; i < 6; i++) {
    const y = 58 + i * 25;
    rect(buf, 270, y, 120 - (i % 3) * 16, 6, [255, 255, 255], 0.28);
    rect(buf, 270, y + 12, 52 + i * 12, 5, i % 2 ? [255, 214, 86] : [57, 232, 190], 0.62);
  }
  rect(buf, 278, 214, 62, 8, [255, 86, 134], 0.72);
  rect(buf, 354, 214, 44, 8, [57, 232, 190], 0.72);
  return buf;
}

function configProfilesFrame(t) {
  const buf = baseFrame();
  const selected = Math.floor((t * 1.8) % 3);
  for (let i = 0; i < 3; i++) {
    const x = 42 + i * 132;
    const on = i === selected;
    rect(buf, x, 46, 102, 164, on ? [28, 42, 62] : [16, 24, 38], on ? 0.98 : 0.9);
    rect(buf, x + 14, 66, 54, 6, [255, 255, 255], on ? 0.42 : 0.22);
    rect(buf, x + 14, 88, 70, 5, [57, 232, 190], on ? 0.76 : 0.34);
    rect(buf, x + 14, 106, 58, 5, [255, 214, 86], on ? 0.7 : 0.3);
    for (let j = 0; j < 6; j++) circle(buf, x + 18 + j * 10, 132, 2.6, [190, 198, 210], 0.6);
    rect(buf, x + 14, 158, 70, 14, [255, 86, 134], on ? 0.52 : 0.18);
    if (on) glow(buf, x + 51, 128, 60, [57, 232, 190], 0.32);
  }
  rect(buf, 152, 224, 176, 8, [255, 255, 255], 0.16);
  rect(buf, 152, 224, 58 + selected * 58, 8, [57, 232, 190], 0.7);
  return buf;
}

function clientConfigMergeFrame(t) {
  const buf = baseFrame();
  const p = smoothstep(0.1, 0.78, (t * 0.65) % 1);
  rect(buf, 34, 42, 132, 168, [236, 240, 245], 0.92);
  rect(buf, 314, 42, 132, 168, [236, 240, 245], 0.92);
  for (let i = 0; i < 7; i++) {
    const y = 66 + i * 18;
    rect(buf, 54, y, 62 + (i % 2) * 24, 5, [18, 24, 34], 0.38);
    rect(buf, 334, y, 62 + (i % 3) * 18, 5, [18, 24, 34], 0.38);
    if (i > 3) rect(buf, 334, y + 9, 54, 4, [57, 160, 190], 0.62);
  }
  line(buf, 166, 126, 314, 126, [255, 255, 255], 0.28);
  circle(buf, 166 + 148 * p, 126, 6, [255, 214, 86], 0.92);
  rect(buf, 204, 98, 72, 56, [15, 22, 34], 0.96);
  rect(buf, 218, 114, 42, 5, [57, 232, 190], 0.74);
  rect(buf, 218, 132, 28, 5, [255, 86, 134], 0.62);
  if (p > 0.85) circle(buf, 416, 190, 10, [57, 232, 190], 0.9);
  return buf;
}

function bridgeInstallVerifyFrame(t) {
  const buf = baseFrame();
  terminalPanel(buf, 32, 34, 152, 186, [255, 214, 86]);
  rect(buf, 250, 34, 166, 186, [16, 24, 38], 0.96);
  const p = smoothstep(0.1, 0.9, (t * 0.72) % 1);
  for (let i = 0; i < 5; i++) {
    rect(buf, 56, 70 + i * 26, 84 - i * 7, 5, [255, 255, 255], 0.24);
  }
  line(buf, 184, 126, 250, 126, [255, 255, 255], 0.24);
  circle(buf, 184 + 66 * p, 126, 5, [57, 232, 190], 0.94);
  rect(buf, 276, 64, 114, 34, [32, 48, 72], 0.92);
  rect(buf, 276, 118, 114, 34, [32, 48, 72], 0.92);
  rect(buf, 276, 172, 114, 22, [57, 232, 190], p > 0.7 ? 0.72 : 0.25);
  for (let i = 0; i < 3; i++) circle(buf, 294 + i * 36, 82, 6, [255, 214, 86], 0.68);
  if (p > 0.72) glow(buf, 334, 183, 48, [57, 232, 190], 0.45);
  return buf;
}

function streamableHttpLoopbackFrame(t) {
  const buf = baseFrame();
  const cx = 240;
  const cy = 134;
  circle(buf, cx, cy, 58, [22, 32, 50], 0.98);
  circle(buf, cx, cy, 28, [57, 232, 190], 0.28 + 0.18 * Math.sin(t * 4));
  for (let i = 0; i < 5; i++) {
    const a = t * 0.7 + (i / 5) * Math.PI * 2;
    const x = cx + Math.cos(a) * 148;
    const y = cy + Math.sin(a) * 82;
    line(buf, cx, cy, x, y, [255, 255, 255], 0.14);
    rect(buf, x - 34, y - 16, 68, 32, [18, 26, 40], 0.95);
    rect(buf, x - 22, y - 4, 44, 5, i % 2 ? [255, 214, 86] : [57, 232, 190], 0.72);
  }
  const p = (t * 1.4) % 1;
  circle(
    buf,
    cx + Math.cos(p * Math.PI * 2) * 78,
    cy + Math.sin(p * Math.PI * 2) * 44,
    4,
    [255, 86, 134],
    0.92,
  );
  return buf;
}

function agentWatchHooksFrame(t) {
  const buf = baseFrame();
  rect(buf, 34, 42, 412, 164, [14, 21, 34], 0.96);
  const cursor = Math.floor((t * 9) % 12);
  for (let i = 0; i < 12; i++) {
    const x = 58 + i * 31;
    const hit = i % 4 === 0 || i === 7;
    const now = i === cursor;
    rect(buf, x, 82, 16, hit ? 72 : 38, hit ? [57, 232, 190] : [74, 88, 112], hit ? 0.7 : 0.36);
    if (now) {
      rect(buf, x - 5, 62, 26, 120, [255, 214, 86], 0.16);
      circle(buf, x + 8, 70, 7, [255, 214, 86], 0.92);
    }
  }
  rect(buf, 86, 220, 102, 8, [255, 255, 255], 0.16);
  rect(buf, 210, 220, 72, 8, [255, 86, 134], 0.62);
  rect(buf, 306, 220, 88, 8, [57, 232, 190], 0.7);
  return buf;
}

function copilotTierSwitchFrame(t) {
  const buf = baseFrame();
  rect(buf, 40, 28, 400, 214, [16, 24, 38], 0.96);
  const safe = Math.sin(t * 1.8) > 0;
  rect(buf, 64, 54, 120, 26, safe ? [57, 232, 190] : [38, 48, 66], safe ? 0.76 : 0.62);
  rect(buf, 202, 54, 120, 26, safe ? [38, 48, 66] : [255, 86, 134], safe ? 0.62 : 0.76);
  for (let i = 0; i < 4; i++) {
    const y = 104 + i * 28;
    rect(buf, 68, y, 150 + (i % 2) * 42, 14, [28, 38, 58], 0.94);
    rect(buf, 82, y + 5, 64 + i * 18, 4, [255, 255, 255], 0.26);
    if (i % 2 === 1) rect(buf, 258, y, 94, 14, safe ? [57, 232, 190] : [255, 214, 86], 0.48);
  }
  rect(buf, 68, 214, 252, 9, [255, 255, 255], 0.14);
  rect(buf, 68, 214, 92 + (safe ? 20 : 120), 9, safe ? [57, 232, 190] : [255, 86, 134], 0.74);
  return buf;
}

function mcpResourceCatalogFrame(t) {
  const buf = baseFrame();
  circle(buf, 240, 136, 24, [57, 232, 190], 0.36);
  const names = [
    [72, 58, [57, 232, 190]],
    [300, 56, [255, 214, 86]],
    [58, 176, [255, 86, 134]],
    [306, 174, [118, 75, 255]],
  ];
  for (let i = 0; i < names.length; i++) {
    const [x, y, color] = names[i];
    const pulse = smoothstep(0, 0.4, (t * 0.55 + i * 0.18) % 1);
    rect(buf, x, y, 124, 48, [16, 24, 38], 0.96);
    rect(buf, x + 16, y + 14, 68, 5, [255, 255, 255], 0.28);
    rect(buf, x + 16, y + 28, 86, 5, color, 0.7);
    line(buf, x + 62, y + 24, 240, 136, [255, 255, 255], 0.12 + pulse * 0.15);
    circle(buf, mix(x + 62, 240, pulse), mix(y + 24, 136, pulse), 4, color, 0.86);
  }
  return buf;
}

function watchNodeTelemetryFrame(t) {
  const buf = baseFrame();
  rect(buf, 38, 46, 148, 154, [16, 24, 38], 0.96);
  rect(buf, 66, 74, 92, 62, [28, 42, 62], 0.95);
  circle(buf, 112, 105, 22, [57, 232, 190], 0.24 + 0.16 * Math.sin(t * 5));
  rect(buf, 74, 160, 76, 7, [255, 255, 255], 0.22);
  rect(buf, 238, 44, 190, 158, [12, 18, 30], 0.96);
  for (let i = 0; i < 8; i++) {
    const x = 262 + i * 18;
    const h = 24 + Math.sin(t * 3 + i * 0.7) * 14 + i * 2;
    rect(buf, x, 166 - h, 10, h, i % 3 === 0 ? [255, 214, 86] : [57, 232, 190], 0.72);
  }
  for (let i = 0; i < 4; i++) {
    const y = 62 + i * 22;
    rect(buf, 352, y, 42, 5, [255, 255, 255], 0.22);
    rect(buf, 352, y + 10, 24 + i * 12, 5, [255, 86, 134], 0.5);
  }
  line(buf, 186, 122, 238, 122, [255, 255, 255], 0.2);
  circle(buf, 186 + ((t * 45) % 52), 122, 4, [255, 214, 86], 0.9);
  return buf;
}

function bridgeHealthWatchdogFrame(t) {
  const buf = baseFrame();
  rect(buf, 34, 32, 412, 208, [14, 21, 34], 0.96);
  const beat = smoothstep(0, 0.22, (t * 1.4) % 1) * (1 - smoothstep(0.28, 0.76, (t * 1.4) % 1));
  circle(buf, 102, 88, 24 + beat * 12, [57, 232, 190], 0.42 + beat * 0.42);
  for (let i = 0; i < 4; i++) {
    const x = 176 + (i % 2) * 116;
    const y = 58 + Math.floor(i / 2) * 72;
    rect(buf, x, y, 86, 46, [28, 38, 58], 0.94);
    rect(buf, x + 14, y + 14, 42, 5, [255, 255, 255], 0.24);
    rect(
      buf,
      x + 14,
      y + 28,
      44 + Math.sin(t * 2 + i) * 14,
      5,
      i === 3 ? [255, 214, 86] : [57, 232, 190],
      0.66,
    );
  }
  for (let i = 0; i < 12; i++) {
    const x = 70 + i * 26;
    const y = 202 + Math.sin(t * 4 + i * 0.8) * 10;
    line(buf, x, 202, x + 18, y, [255, 255, 255], 0.22);
    circle(buf, x + 18, y, 2.5, [255, 86, 134], 0.6);
  }
  return buf;
}

function sdfFieldFrame(t) {
  const buf = baseFrame();
  const colorA = [48, 218, 255];
  const colorB = [255, 70, 140];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x / width - 0.5) * 2;
      const v = (y / height - 0.5) * 2;
      const ca = Math.cos(t * 0.9);
      const sa = Math.sin(t * 0.9);
      const rx = u * ca - v * sa;
      const ry = u * sa + v * ca;
      const sphere = Math.hypot(rx + 0.22 * Math.sin(t * 1.5), ry) - 0.52;
      const box = Math.max(Math.abs(rx - 0.32) - 0.28, Math.abs(ry + 0.08) - 0.2);
      const torus = Math.abs(Math.hypot(rx + 0.18, ry - 0.04) - 0.48) - 0.055;
      const field = Math.min(sphere, Math.min(Math.max(box, -sphere + 0.14), torus));
      const edge = 1 - smoothstep(0.0, 0.065, Math.abs(field));
      const inside = 1 - smoothstep(-0.24, 0.02, field);
      const shade = smoothstep(1.25, 0.05, Math.hypot(u, v));
      const color = mixColor(colorA, colorB, smoothstep(-0.32, 0.32, rx + ry * 0.5));
      set(buf, x, y, mixColor([5, 7, 12], color, Math.max(edge, inside * 0.35) * shade), 0.9);
      if (edge > 0.02) set(buf, x, y, [255, 255, 255], edge * 0.18);
    }
  }
  glow(buf, 240, 136, 132, colorA, 0.25);
  rect(buf, 42, 218, 88, 6, colorA, 0.7);
  rect(buf, 150, 218, 116, 6, colorB, 0.62);
  rect(buf, 286, 218, 70 + Math.sin(t * 2.2) * 16, 6, [255, 214, 86], 0.66);
  return buf;
}

function opticalFlowFrame(t) {
  const buf = baseFrame();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      const bands = Math.sin((u * 5 + v * 3 + t * 1.4) * Math.PI * 2) * 0.5 + 0.5;
      const sweep = Math.sin((u - t * 0.22) * 18) * Math.cos((v + t * 0.15) * 16);
      const color = mixColor([13, 21, 36], [78, 210, 255], bands * 0.45 + sweep * 0.25 + 0.2);
      set(buf, x, y, color, 0.86);
    }
  }
  rect(buf, 24, 24, 432, 222, [0, 0, 0], 0.18);
  for (let gy = 0; gy < 9; gy++) {
    for (let gx = 0; gx < 15; gx++) {
      const x = 50 + gx * 29;
      const y = 48 + gy * 22;
      const a = Math.sin(gx * 0.7 + t * 2.2) + Math.cos(gy * 0.9 - t * 1.4);
      const mag = 7 + 8 * (Math.sin(t * 2.4 + gx * 0.5 + gy * 0.4) * 0.5 + 0.5);
      const x1 = x + Math.cos(a) * mag;
      const y1 = y + Math.sin(a) * mag;
      const color = gx % 3 === 0 ? [255, 86, 134] : [57, 232, 190];
      line(buf, x, y, x1, y1, color, 0.55);
      circle(buf, x1, y1, 2.2, [255, 255, 255], 0.62);
    }
  }
  rect(buf, 52, 224, 120, 7, [255, 255, 255], 0.16);
  rect(buf, 52, 224, 84 + Math.sin(t * 2) * 28, 7, [57, 232, 190], 0.72);
  rect(buf, 196, 224, 96, 7, [255, 86, 134], 0.58);
  return buf;
}

function sdfCsgCathedralFrame(t) {
  const buf = baseFrame();
  const violet = [176, 70, 255];
  const deep = [8, 2, 16];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x / width - 0.5) * 2.2;
      const v = (y / height - 0.48) * 2.2;
      const z = 0.8 + Math.sin(t * 1.2) * 0.22;
      const arch = Math.abs(Math.hypot(u * 1.6, v + 0.2) - (0.5 + z * 0.18)) - 0.035;
      const dome = Math.hypot(u, v + 0.48) - 0.34;
      const nave = Math.max(Math.abs(u) - 0.28, Math.abs(v - 0.08) - 0.7);
      const sideA = Math.hypot(u - 0.42, v + 0.06) - 0.26;
      const sideB = Math.hypot(u + 0.42, v + 0.06) - 0.26;
      const ring = Math.abs(Math.hypot(u * 1.3, v - 0.04) - 0.68) - 0.026;
      const field = Math.min(
        Math.min(dome, Math.min(sideA, sideB)),
        Math.min(Math.max(nave, -dome + 0.1), Math.min(arch, ring)),
      );
      const edge = 1 - smoothstep(0.0, 0.045, Math.abs(field));
      const inside = 1 - smoothstep(-0.2, 0.02, field);
      const lamp = smoothstep(1.35, 0.06, Math.hypot(u * 0.85, v + 0.02));
      const ribs = (Math.sin((u * 14 + Math.sin(v * 4 + t)) * Math.PI) * 0.5 + 0.5) * edge;
      const shade = Math.max(edge * 0.8, inside * 0.24) * lamp;
      const color = mixColor(deep, mixColor(violet, [255, 160, 255], ribs * 0.42), shade);
      set(buf, x, y, color, 0.96);
      if (edge > 0.2) set(buf, x, y, [255, 230, 255], edge * 0.2);
    }
  }
  glow(buf, 240, 126, 180, violet, 0.24);
  for (let i = 0; i < 5; i++) {
    const p = i / 4;
    const y = 92 + i * 22 + Math.sin(t * 1.4 + i) * 2;
    ellipseRing(
      buf,
      240,
      y,
      122 - p * 34,
      28 - p * 4,
      0.028,
      i % 2 ? [255, 115, 220] : violet,
      0.38,
    );
  }
  rect(buf, 54, 222, 146, 7, [95, 45, 180], 0.64);
  rect(buf, 54, 222, 66 + (Math.sin(t * 1.4) * 0.5 + 0.5) * 70, 7, [220, 122, 255], 0.86);
  rect(buf, 272, 222, 112, 7, [36, 20, 72], 0.74);
  rect(buf, 272, 222, 78 + Math.sin(t * 1.8) * 18, 7, [255, 214, 86], 0.72);
  return buf;
}

function opticalFlowParticlesTrailFrame(t) {
  const buf = baseFrame();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      const camera = Math.sin((u * 3.2 + v * 2.4 + t * 0.9) * Math.PI * 2) * 0.5 + 0.5;
      set(buf, x, y, mixColor([6, 10, 18], [22, 34, 54], camera * 0.45), 0.94);
    }
  }
  const bodyX = 238 + Math.sin(t * 1.6) * 54;
  const bodyY = 120 + Math.cos(t * 1.2) * 14;
  glow(buf, bodyX, bodyY, 82, [57, 232, 190], 0.18);
  circle(buf, bodyX, bodyY - 38, 18, [255, 255, 255], 0.1);
  polygon(
    buf,
    [
      [bodyX - 48, bodyY - 10],
      [bodyX + 46, bodyY - 8],
      [bodyX + 34, bodyY + 64],
      [bodyX - 34, bodyY + 64],
    ],
    [255, 255, 255],
    0.07,
  );
  for (let i = 0; i < 760; i++) {
    let x = rand(i, 4, 1) * width;
    let y = rand(i, 9, 2) * height;
    const trail = 8 + Math.floor(rand(i, 6, 3) * 8);
    const color = i % 5 === 0 ? [255, 86, 134] : i % 3 === 0 ? [255, 214, 86] : [57, 232, 190];
    for (let s = 0; s < trail; s++) {
      const dx = bodyX - x;
      const dy = bodyY - y;
      const pull = Math.exp(-(dx * dx + dy * dy) / 26000);
      const a = Math.sin(x * 0.018 + y * 0.024 + t * 3.4) * Math.PI + pull * Math.atan2(dy, dx);
      const nx = x + Math.cos(a) * (2.8 + pull * 9);
      const ny = y + Math.sin(a) * (2.2 + pull * 7);
      line(buf, x, y, nx, ny, color, 0.08 + pull * 0.18);
      x = nx;
      y = ny;
    }
    if (i % 4 === 0) circle(buf, x, y, 1.5, color, 0.48);
  }
  for (let gy = 0; gy < 7; gy++) {
    for (let gx = 0; gx < 11; gx++) {
      const x = 54 + gx * 40;
      const y = 44 + gy * 28;
      const a = Math.sin(gx * 0.7 + t * 2.6) + Math.cos(gy * 0.8 - t * 1.8);
      line(buf, x, y, x + Math.cos(a) * 10, y + Math.sin(a) * 7, [255, 255, 255], 0.16);
    }
  }
  rect(buf, 48, 224, 112, 7, [57, 232, 190], 0.72);
  rect(buf, 186, 224, 90 + Math.sin(t * 2) * 24, 7, [255, 86, 134], 0.56);
  rect(buf, 318, 224, 96, 7, [255, 214, 86], 0.48);
  return buf;
}

function histogramScopeFrame(t) {
  const buf = baseFrame();
  rect(buf, 28, 36, 170, 170, [15, 22, 34], 0.96);
  for (let y = 0; y < 118; y++) {
    for (let x = 0; x < 134; x++) {
      const u = x / 134;
      const v = y / 118;
      const pulse = Math.sin((u * 2.6 + t * 0.7) * Math.PI * 2) * 0.5 + 0.5;
      set(buf, 45 + x, 54 + y, mixColor([18, 28, 48], [255, 210, 86], pulse * v), 0.92);
    }
  }
  rect(buf, 230, 36, 200, 170, [8, 13, 22], 0.97);
  const colors = [
    [255, 86, 134],
    [57, 232, 190],
    [95, 150, 255],
  ];
  for (let channel = 0; channel < 3; channel++) {
    for (let i = 0; i < 32; i++) {
      const h =
        18 +
        88 *
          (Math.sin(i * 0.28 + t * (1.2 + channel * 0.2) + channel * 1.3) * 0.5 + 0.5) *
          Math.exp(-((i - 16 - channel * 2) ** 2) / 220);
      rect(buf, 246 + i * 5, 184 - h, 3, h, colors[channel], 0.36 + channel * 0.1);
    }
  }
  rect(buf, 244, 190, 164, 1, [255, 255, 255], 0.26);
  rect(buf, 60, 222, 88, 6, [57, 232, 190], 0.64);
  rect(buf, 244, 222, 128, 6, [255, 214, 86], 0.64);
  return buf;
}

function faceTrackingFrame(t) {
  const buf = baseFrame();
  rect(buf, 32, 28, 416, 214, [13, 20, 33], 0.96);
  const cx = 240 + Math.sin(t * 1.3) * 12;
  const cy = 128 + Math.cos(t * 1.1) * 5;
  glow(buf, cx, cy, 124, [57, 232, 190], 0.18);
  circle(buf, cx, cy, 80, [255, 180, 132], 0.15);
  for (let i = 0; i < 92; i++) {
    const a = (i / 92) * Math.PI * 2;
    const wobble = 1 + Math.sin(a * 5 + t * 2) * 0.05;
    const x = cx + Math.cos(a) * 70 * wobble;
    const y = cy + Math.sin(a) * 88 * wobble;
    circle(buf, x, y, 1.5, [57, 232, 190], 0.72);
  }
  for (let i = 0; i < 18; i++) {
    const a = (i / 17) * Math.PI;
    circle(buf, cx - 31 + Math.cos(a) * 18, cy - 18 + Math.sin(a) * 7, 1.8, [255, 214, 86], 0.82);
    circle(buf, cx + 31 + Math.cos(a) * 18, cy - 18 + Math.sin(a) * 7, 1.8, [255, 214, 86], 0.82);
    circle(buf, cx - 18 + Math.cos(a) * 20, cy + 34 + Math.sin(a) * 8, 1.8, [255, 86, 134], 0.78);
  }
  rect(buf, 68, 216, 108, 6, [255, 255, 255], 0.14);
  rect(buf, 68, 216, 84, 6, [57, 232, 190], 0.7);
  rect(buf, 298, 216, 86, 6, [255, 86, 134], 0.58);
  return buf;
}

function drawHand(buf, cx, cy, scale, phase, color) {
  const wrist = [cx, cy + 54 * scale];
  const palm = [cx, cy + 18 * scale];
  line(buf, wrist[0], wrist[1], palm[0], palm[1], color, 0.55);
  for (let finger = 0; finger < 5; finger++) {
    const spread = (finger - 2) * 0.34;
    let px = palm[0] + Math.sin(spread) * 22 * scale;
    let py = palm[1] - Math.cos(spread) * 10 * scale;
    circle(buf, px, py, 3 * scale, color, 0.8);
    const curl = Math.sin(phase + finger * 0.8) * 0.22;
    for (let joint = 1; joint <= 4; joint++) {
      const a = -Math.PI / 2 + spread + curl * joint;
      const len = (16 - joint * 1.8) * scale;
      const nx = px + Math.cos(a) * len;
      const ny = py + Math.sin(a) * len;
      line(buf, px, py, nx, ny, color, 0.62);
      circle(buf, nx, ny, 2.4 * scale, [255, 255, 255], 0.65);
      px = nx;
      py = ny;
    }
  }
}

function handTrackingFrame(t) {
  const buf = baseFrame();
  rect(buf, 34, 30, 410, 210, [13, 20, 33], 0.96);
  drawHand(buf, 152, 142 + Math.sin(t * 1.5) * 5, 1.05, t * 2.2, [57, 232, 190]);
  drawHand(buf, 318, 136 + Math.cos(t * 1.4) * 7, 0.92, t * 2.7 + 1.8, [255, 86, 134]);
  for (let i = 0; i < 10; i++) {
    const x = 92 + i * 30;
    const h = 16 + Math.sin(t * 3 + i * 0.6) * 10 + i * 2;
    rect(buf, x, 222 - h, 14, h, i % 2 ? [255, 214, 86] : [57, 232, 190], 0.58);
  }
  return buf;
}

function drawPersonSilhouette(buf, cx, cy, scale, color, alpha) {
  circle(buf, cx, cy - 48 * scale, 22 * scale, color, alpha);
  polygon(
    buf,
    [
      [cx - 52 * scale, cy - 18 * scale],
      [cx + 52 * scale, cy - 18 * scale],
      [cx + 38 * scale, cy + 62 * scale],
      [cx - 38 * scale, cy + 62 * scale],
    ],
    color,
    alpha,
  );
  circle(buf, cx - 38 * scale, cy + 4 * scale, 16 * scale, color, alpha);
  circle(buf, cx + 38 * scale, cy + 4 * scale, 16 * scale, color, alpha);
}

function segmentationMatteFrame(t) {
  const buf = baseFrame();
  const panels = [
    [30, [48, 112, 210]],
    [186, [235, 238, 244]],
    [342, [57, 232, 190]],
  ];
  for (const [x, color] of panels) {
    rect(buf, x, 42, 118, 170, [15, 22, 34], 0.95);
    for (let y = 0; y < 150; y++) {
      rect(buf, x + 10, 52 + y, 98, 1, mixColor([10, 18, 30], color, y / 150), 0.42);
    }
  }
  drawPersonSilhouette(buf, 89 + Math.sin(t * 1.2) * 4, 135, 0.9, [255, 185, 120], 0.42);
  drawPersonSilhouette(buf, 245, 135, 0.9, [255, 255, 255], 0.82);
  drawPersonSilhouette(buf, 401, 135, 0.9, [57, 232, 190], 0.72);
  rect(buf, 206, 222, 84, 6, [255, 255, 255], 0.72);
  rect(buf, 360, 222, 86, 6, [57, 232, 190], 0.72);
  return buf;
}

function inlinePreviewFrame(t) {
  const buf = baseFrame();
  rect(buf, 34, 32, 170, 188, [14, 21, 34], 0.97);
  for (let y = 0; y < 112; y++) {
    for (let x = 0; x < 128; x++) {
      const c = proceduralClip(x, y, t, 2);
      set(buf, 55 + x, 54 + y, c, 0.86);
    }
  }
  rect(buf, 230, 32, 214, 188, [12, 18, 30], 0.96);
  for (let i = 0; i < 6; i++) {
    const y = 58 + i * 25;
    rect(buf, 254, y, 76 + (i % 3) * 28, 6, [255, 255, 255], 0.24);
    rect(
      buf,
      254,
      y + 12,
      42 + Math.sin(t * 2 + i) * 12,
      5,
      i === 4 ? [255, 86, 134] : [57, 232, 190],
      0.62,
    );
  }
  circle(buf, 176, 184, 9, [57, 232, 190], 0.82);
  rect(buf, 54, 190, 96, 6, [255, 255, 255], 0.18);
  rect(buf, 54, 190, 68, 6, [57, 232, 190], 0.7);
  rect(buf, 260, 196, 90, 8, [255, 214, 86], 0.46 + 0.16 * Math.sin(t * 4));
  return buf;
}

function stageDashboardV2Frame(t) {
  const buf = baseFrame();
  rect(buf, 28, 24, 424, 222, [13, 19, 31], 0.98);
  rect(buf, 48, 44, 120, 74, [22, 32, 50], 0.96);
  for (let i = 0; i < 8; i++) {
    const h = 12 + (Math.sin(t * 4 + i * 0.8) * 0.5 + 0.5) * 44;
    rect(buf, 62 + i * 12, 104 - h, 7, h, i % 2 ? [255, 214, 86] : [57, 232, 190], 0.72);
  }
  circle(buf, 238, 80, 34, [57, 232, 190], 0.22);
  circle(buf, 238, 80, 18 + Math.sin(t * 2.8) * 3, [255, 255, 255], 0.11);
  rect(buf, 298, 48, 112, 30, [28, 42, 62], 0.94);
  rect(buf, 298, 88, 112, 30, [28, 42, 62], 0.94);
  rect(buf, 54, 144, 356, 18, [255, 255, 255], 0.12);
  const play = (t * 0.38) % 1;
  for (let i = 0; i < 5; i++) {
    rect(buf, 58 + i * 70, 148, 50, 10, i % 2 ? [255, 86, 134] : [57, 232, 190], 0.48);
  }
  circle(buf, 58 + 356 * play, 153, 7, [255, 214, 86], 0.94);
  rect(buf, 52, 192, 92, 26, [255, 86, 134], 0.62 + 0.12 * Math.sin(t * 5));
  rect(buf, 168, 192, 92, 26, [57, 232, 190], 0.62);
  rect(buf, 284, 192, 132, 26, [255, 214, 86], 0.42);
  return buf;
}

function sessionProfileFrame(t) {
  const buf = baseFrame();
  circle(buf, 240, 134, 34, [57, 232, 190], 0.28 + 0.12 * Math.sin(t * 3));
  const cards = [
    [58, 50, [57, 232, 190]],
    [306, 48, [255, 86, 134]],
    [62, 176, [255, 214, 86]],
    [306, 176, [118, 75, 255]],
  ];
  for (let i = 0; i < cards.length; i++) {
    const [x, y, color] = cards[i];
    const p = smoothstep(0.02, 0.62, (t * 0.45 + i * 0.19) % 1);
    rect(buf, x, y, 112, 48, [16, 24, 38], 0.96);
    rect(buf, x + 14, y + 13, 58, 5, [255, 255, 255], 0.25);
    rect(buf, x + 14, y + 28, 74, 5, color, 0.66);
    line(buf, x + 56, y + 24, 240, 134, [255, 255, 255], 0.1 + p * 0.15);
    circle(buf, mix(x + 56, 240, p), mix(y + 24, 134, p), 4, color, 0.88);
  }
  rect(buf, 204, 128, 72, 7, [255, 255, 255], 0.22);
  rect(buf, 212, 146, 56, 6, [57, 232, 190], 0.72);
  return buf;
}

function recipeBundlePublishFrame(t) {
  const buf = baseFrame();
  rect(buf, 34, 40, 120, 176, [16, 24, 38], 0.96);
  for (let i = 0; i < 4; i++) {
    rect(buf, 54, 62 + i * 34, 76, 20, [28, 42, 62], 0.95);
    rect(buf, 64, 70 + i * 34, 44 + i * 8, 4, [255, 255, 255], 0.22);
    rect(buf, 64, 78 + i * 34, 34, 4, i % 2 ? [255, 86, 134] : [57, 232, 190], 0.66);
  }
  const p = smoothstep(0.08, 0.8, (t * 0.62) % 1);
  line(buf, 154, 128, 236, 128, [255, 255, 255], 0.18);
  circle(buf, 154 + 82 * p, 128, 5, [255, 214, 86], 0.9);
  rect(buf, 236, 42, 172, 174, [238, 242, 247], 0.92);
  for (let i = 0; i < 7; i++) {
    rect(buf, 258, 66 + i * 20, 90 + (i % 3) * 18, 5, [16, 24, 38], 0.3);
  }
  rect(buf, 258, 176, 80, 8, [57, 232, 190], 0.68);
  rect(buf, 258, 194, 108, 6, [255, 86, 134], 0.48);
  if (p > 0.78) circle(buf, 386, 192, 9, [57, 232, 190], 0.8);
  return buf;
}

function readmeMermaidFrame(t) {
  const buf = baseFrame();
  rect(buf, 34, 34, 150, 180, [14, 21, 34], 0.96);
  const nodes = [
    [72, 72],
    [126, 112],
    [72, 154],
    [132, 182],
  ];
  for (let i = 0; i < nodes.length - 1; i++)
    line(buf, nodes[i][0], nodes[i][1], nodes[i + 1][0], nodes[i + 1][1], [255, 255, 255], 0.18);
  for (let i = 0; i < nodes.length; i++) {
    const [x, y] = nodes[i];
    circle(buf, x, y, 12, i % 2 ? [255, 86, 134] : [57, 232, 190], 0.62);
  }
  rect(buf, 230, 34, 186, 180, [238, 242, 247], 0.94);
  for (let i = 0; i < 8; i++) {
    rect(buf, 254, 58 + i * 18, 86 + (i % 4) * 18, 5, [16, 24, 38], 0.32);
    if (i === 4) rect(buf, 254, 58 + i * 18, 104, 5, [57, 160, 190], 0.62);
  }
  const scan = (t * 0.6) % 1;
  line(buf, 184, 124, 230, 124, [255, 255, 255], 0.16);
  circle(buf, 184 + 46 * scan, 124, 4, [255, 214, 86], 0.9);
  rect(buf, 254, 190, 74, 7, [255, 214, 86], 0.46);
  return buf;
}

function watchBuildHotReloadFrame(t) {
  const buf = baseFrame();
  terminalPanel(buf, 30, 34, 164, 184, [255, 214, 86]);
  rect(buf, 234, 34, 178, 184, [16, 24, 38], 0.96);
  const step = Math.floor((t * 4.2) % 5);
  for (let i = 0; i < 5; i++) {
    const y = 62 + i * 30;
    rect(buf, 56, y, 72 + (i % 2) * 22, 5, [255, 255, 255], 0.22 + (i === step ? 0.22 : 0));
    circle(
      buf,
      264,
      y + 2,
      7,
      i < step ? [57, 232, 190] : i === step ? [255, 214, 86] : [74, 88, 112],
      0.78,
    );
    rect(buf, 286, y - 2, 76 + (i % 3) * 16, 5, [255, 255, 255], i <= step ? 0.3 : 0.14);
  }
  if (step >= 3) glow(buf, 354, 184, 54, [57, 232, 190], 0.3);
  rect(buf, 282, 194, 76, 8, step >= 4 ? [57, 232, 190] : [255, 86, 134], 0.58);
  return buf;
}

const showDirectorColors = [
  [57, 232, 190],
  [255, 214, 86],
  [255, 86, 134],
];

function showDirectorCardX(index) {
  return 50 + index * 134;
}

function drawShowDirectorGlyphCircle(buf, x, color, active) {
  circle(buf, x + 56, 156, 18, color, 0.3 + (active ? 0.24 : 0));
}

function drawShowDirectorGlyphBlock(buf, x, color, active) {
  rect(buf, x + 32, 142, 44, 24, color, active ? 0.68 : 0.28);
  rect(buf, x + 40, 172, 28, 5, [255, 255, 255], 0.22);
}

function drawShowDirectorGlyphCross(buf, x, color, active) {
  line(buf, x + 34, 144, x + 78, 176, color, active ? 0.8 : 0.35);
  line(buf, x + 78, 144, x + 34, 176, color, active ? 0.8 : 0.35);
}

const showDirectorGlyphs = [
  drawShowDirectorGlyphCircle,
  drawShowDirectorGlyphBlock,
  drawShowDirectorGlyphCross,
];

function drawShowDirectorCard(buf, index, phase) {
  const x = showDirectorCardX(index);
  const active = index === phase;
  const color = showDirectorColors[index];
  rect(buf, x + 18, 72, 66, 6, [255, 255, 255], active ? 0.42 : 0.22);
  rect(buf, x + 18, 94, 78, 5, color, active ? 0.82 : 0.36);
  rect(buf, x + 18, 116, 52, 5, [255, 255, 255], active ? 0.3 : 0.14);
  showDirectorGlyphs[index](buf, x, color, active);
  if (active) glow(buf, x + 56, 126, 58, color, 0.28);
}

function drawShowDirectorProgress(buf, p, color) {
  line(buf, 162, 126, 184, 126, [255, 255, 255], 0.18);
  line(buf, 296, 126, 318, 126, [255, 255, 255], 0.18);
  circle(buf, 72 + p * 336, 220, 5, color, 0.92);
  rect(buf, 76, 218, 328, 5, [255, 255, 255], 0.13);
  rect(buf, 76, 218, 328 * p, 5, color, 0.72);
}

function showDirectorPolicyFrame(t) {
  const buf = baseFrame();
  rect(buf, 30, 28, 420, 212, [14, 21, 34], 0.96);
  rect(buf, 50, 50, 112, 154, [20, 30, 46], 0.94);
  rect(buf, 184, 50, 112, 154, [20, 30, 46], 0.94);
  rect(buf, 318, 50, 112, 154, [20, 30, 46], 0.94);
  const phase = Math.floor((t * 1.45) % 3);
  for (let i = 0; i < 3; i++) {
    drawShowDirectorCard(buf, i, phase);
  }
  const p = smoothstep(0.08, 0.86, (t * 0.7) % 1);
  drawShowDirectorProgress(buf, p, showDirectorColors[phase]);
  return buf;
}

function nChannelDecksFrame(t) {
  const buf = baseFrame();
  const cut = Math.floor((t * 1.8) % 4);
  for (let i = 0; i < 4; i++) {
    const x = 36 + i * 104;
    const active = i === cut;
    rect(buf, x, 38, 82, 128, [18, 26, 40], 0.95);
    for (let y = 0; y < 64; y++) {
      const yy = 58 + y;
      const c = hsv((i * 0.18 + y * 0.004 + t * 0.05) % 1, 0.72, active ? 0.9 : 0.55);
      rect(buf, x + 12, yy, 58, 1, c, 0.72);
    }
    rect(buf, x + 14, 184, 10, -46 - Math.sin(t * 3 + i) * 16, [57, 232, 190], 0.7);
    rect(buf, x + 36, 184, 10, -28 - Math.cos(t * 2.4 + i) * 14, [255, 214, 86], 0.64);
    rect(buf, x + 58, 184, 10, -18 - Math.sin(t * 4 + i) * 9, [255, 86, 134], 0.58);
    if (active) {
      rect(buf, x - 4, 34, 90, 136, [255, 255, 255], 0.08);
      glow(buf, x + 41, 98, 58, [255, 214, 86], 0.26);
    }
  }
  const cross = Math.sin(t * 1.7) * 0.5 + 0.5;
  rect(buf, 72, 214, 336, 7, [255, 255, 255], 0.14);
  rect(buf, 72, 214, 336 * cross, 7, [57, 232, 190], 0.76);
  circle(buf, 72 + 336 * cross, 217, 9, [255, 255, 255], 0.78);
  rect(buf, 184, 236, 112, 7, [255, 86, 134], 0.54 + 0.18 * Math.sin(t * 5));
  return buf;
}

function nChanDecksFxBusFrame(t) {
  const buf = baseFrame();
  const colors = [
    [57, 232, 190],
    [255, 214, 86],
    [255, 86, 134],
    [118, 75, 255],
  ];
  const cut = Math.floor((t * 1.55) % 4);
  for (let i = 0; i < 4; i++) {
    const x = 24 + i * 82;
    const active = i === cut;
    rect(buf, x, 28, 68, 134, [14, 21, 34], 0.97);
    rect(buf, x + 8, 38, 52, 44, [24, 34, 52], 0.96);
    for (let y = 0; y < 35; y++) {
      const c = hsv((i * 0.18 + y * 0.006 + t * 0.05) % 1, 0.68, active ? 0.96 : 0.58);
      rect(buf, x + 12, 42 + y, 44, 1, c, 0.78);
    }
    rect(buf, x + 12, 98, 8, -28 - Math.sin(t * 3 + i) * 12, colors[i], 0.72);
    rect(buf, x + 30, 126, 8, -16 - Math.cos(t * 2.2 + i) * 10, [255, 255, 255], 0.28);
    rect(buf, x + 48, 126, 8, -22 - Math.sin(t * 2.8 + i) * 11, colors[i], 0.54);
    rect(buf, x + 12, 146, 44, 5, [255, 255, 255], 0.12);
    rect(buf, x + 12, 146, (22 + Math.sin(t * 2 + i) * 12) * (0.8 + i * 0.08), 5, colors[i], 0.68);
    line(buf, x + 56, 148, 372, 76 + i * 24, colors[i], 0.16 + (active ? 0.12 : 0));
    if (active) {
      rect(buf, x - 3, 25, 74, 140, [255, 255, 255], 0.08);
      glow(buf, x + 34, 62, 44, colors[i], 0.28);
    }
  }
  rect(buf, 352, 48, 92, 110, [16, 24, 38], 0.97);
  for (let i = 0; i < 4; i++) {
    const y = 68 + i * 20;
    rect(buf, 372, y, 48 + Math.sin(t * 2.4 + i) * 16, 5, colors[i], 0.54);
    circle(buf, 364, y + 2, 4, colors[i], 0.82);
  }
  glow(buf, 400, 112, 58, [255, 86, 134], 0.16);
  rect(buf, 52, 204, 250, 8, [255, 255, 255], 0.12);
  const cross = Math.sin(t * 1.2) * 0.5 + 0.5;
  rect(buf, 52, 204, 250 * cross, 8, [57, 232, 190], 0.78);
  circle(buf, 52 + 250 * cross, 208, 8, [255, 255, 255], 0.82);
  rect(buf, 322, 198, 94, 22, colors[cut], 0.52 + 0.22 * Math.sin(t * 4));
  rect(buf, 328, 224, 82, 6, [255, 255, 255], 0.18);
  rect(buf, 328, 224, 82 * (0.3 + 0.7 * cross), 6, colors[cut], 0.72);
  return buf;
}

function learningResourcesFrame(t) {
  const buf = baseFrame();
  const cx = 240;
  const cy = 134;
  circle(buf, cx, cy, 32, [57, 232, 190], 0.28 + 0.14 * Math.sin(t * 4));
  const items = [
    [76, 54, [57, 232, 190]],
    [286, 44, [255, 214, 86]],
    [56, 174, [255, 86, 134]],
    [308, 178, [118, 75, 255]],
    [194, 34, [88, 230, 164]],
  ];
  for (let i = 0; i < items.length; i++) {
    const [x, y, color] = items[i];
    const pulse = smoothstep(0.02, 0.45, (t * 0.48 + i * 0.17) % 1);
    rect(buf, x, y, 112, 44, [16, 24, 38], 0.95);
    rect(buf, x + 14, y + 12, 58, 5, [255, 255, 255], 0.25);
    rect(buf, x + 14, y + 26, 74, 5, color, 0.68);
    line(buf, x + 56, y + 22, cx, cy, [255, 255, 255], 0.1 + pulse * 0.16);
    circle(buf, mix(x + 56, cx, pulse), mix(y + 22, cy, pulse), 4, color, 0.86);
  }
  rect(buf, 198, 128, 84, 8, [255, 255, 255], 0.22);
  rect(buf, 208, 146, 64, 6, [57, 232, 190], 0.72);
  return buf;
}

function cliCompletionDoctorFrame(t) {
  const buf = baseFrame();
  terminalPanel(buf, 30, 34, 194, 188, [255, 214, 86]);
  terminalPanel(buf, 256, 34, 194, 188, [57, 232, 190]);
  const cursor = Math.floor((t * 6) % 6);
  for (let i = 0; i < 6; i++) {
    const y = 70 + i * 22;
    rect(buf, 54, y, 88 + (i % 2) * 24, 5, [255, 255, 255], cursor === i ? 0.48 : 0.22);
    rect(
      buf,
      158,
      y - 4,
      34,
      13,
      i % 2 ? [57, 232, 190] : [255, 214, 86],
      cursor === i ? 0.78 : 0.34,
    );
  }
  const repaired = Math.sin(t * 1.4) > -0.25;
  for (let i = 0; i < 4; i++) {
    const y = 76 + i * 30;
    rect(buf, 280, y, 74 + i * 14, 6, [255, 255, 255], 0.24);
    circle(buf, 404, y + 2, 6, i === 2 && !repaired ? [255, 86, 134] : [57, 232, 190], 0.86);
  }
  if (repaired) {
    rect(buf, 296, 184, 86, 10, [57, 232, 190], 0.72);
    glow(buf, 404, 138, 42, [57, 232, 190], 0.24);
  } else {
    rect(buf, 296, 184, 66, 10, [255, 86, 134], 0.62);
  }
  return buf;
}

function miniNode(buf, x, y, color, active = false) {
  rect(buf, x, y, 44, 24, [16, 24, 38], 0.96);
  rect(buf, x + 8, y + 8, 20, 4, [255, 255, 255], active ? 0.42 : 0.2);
  rect(buf, x + 8, y + 16, 28, 4, color, active ? 0.82 : 0.42);
  if (active) glow(buf, x + 22, y + 12, 34, color, 0.22);
}

function _drawRecipeShell(buf, t, accent) {
  rect(buf, 22, 24, 436, 220, [12, 18, 30], 0.96);
  rect(buf, 42, 42, 118, 176, [238, 242, 247], 0.92);
  for (let i = 0; i < 8; i++) {
    const y = 62 + i * 17;
    rect(buf, 58, y, 62 + ((i * 19) % 38), 4, [16, 24, 38], 0.34);
    if (i === 2 || i === 5) rect(buf, 58, y, 72, 4, accent, 0.62);
  }
  rect(buf, 56, 190, 70, 8, accent, 0.6 + 0.14 * Math.sin(t * 4));
  const nodes = [
    [190, 58],
    [276, 58],
    [190, 124],
    [276, 124],
    [234, 188],
  ];
  const active = Math.floor((t * 2.2) % nodes.length);
  for (let i = 0; i < nodes.length - 1; i++)
    line(
      buf,
      nodes[i][0] + 44,
      nodes[i][1] + 12,
      nodes[i + 1][0],
      nodes[i + 1][1] + 12,
      [255, 255, 255],
      0.14,
    );
  for (let i = 0; i < nodes.length; i++)
    miniNode(buf, nodes[i][0], nodes[i][1], accent, i === active);
}

function drawAudioRecipePreview(buf, t, accent) {
  for (let i = 0; i < 18; i++) {
    const h = 18 + Math.abs(Math.sin(t * 5 + i * 0.72)) * 72;
    rect(buf, 342 + i * 4, 172 - h, 3, h, hsv(i / 18, 0.72, 0.95), 0.82);
  }
  glow(buf, 382, 112, 58, accent, 0.22);
}

function drawKeyframeRecipePreview(buf, t, accent) {
  const pts = [
    [348, 150],
    [366, 86],
    [396, 114],
    [418, 74],
  ];
  for (let i = 0; i < pts.length - 1; i++)
    line(buf, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], accent, 0.75);
  const p = (t * 0.5) % 1;
  const seg = Math.min(pts.length - 2, Math.floor(p * (pts.length - 1)));
  const local = p * (pts.length - 1) - seg;
  circle(
    buf,
    mix(pts[seg][0], pts[seg + 1][0], local),
    mix(pts[seg][1], pts[seg + 1][1], local),
    7,
    [255, 255, 255],
    0.86,
  );
}

function drawPoseRecipePreview(buf, t, accent) {
  const cx = 382 + Math.sin(t * 2) * 7;
  const cy = 104;
  const joints = [
    [cx, cy - 34],
    [cx, cy - 8],
    [cx - 22, cy + 10],
    [cx + 22, cy + 10],
    [cx - 18, cy + 52],
    [cx + 18, cy + 52],
  ];
  [
    [0, 1],
    [1, 2],
    [1, 3],
    [2, 4],
    [3, 5],
  ].forEach(([a, b]) => {
    line(buf, joints[a][0], joints[a][1], joints[b][0], joints[b][1], accent, 0.82);
  });
  joints.forEach(([x, y]) => {
    circle(buf, x, y, 5, [255, 255, 255], 0.7);
  });
}

function drawParticlesRecipePreview(buf, t) {
  for (let i = 0; i < 70; i++) {
    const a = i * 2.399 + t * 1.7;
    const r = 8 + i * 0.76;
    circle(
      buf,
      382 + Math.cos(a) * r,
      118 + Math.sin(a) * r * 0.62,
      2,
      hsv(i / 70 + t * 0.04, 0.72, 0.94),
      0.72,
    );
  }
}

function drawFeedbackRecipePreview(buf, t, accent) {
  for (let i = 0; i < 9; i++) {
    const r = 62 - i * 6 + ((t * 18) % 6);
    circle(buf, 382, 118, r, i % 2 ? accent : [255, 255, 255], 0.07 + i * 0.012);
  }
}

function drawShaderRecipePreview(buf, t, accent) {
  for (let y = 62; y < 174; y++) {
    for (let x = 342; x < 422; x += 2) {
      const u = (x - 342) / 80;
      const v = (y - 62) / 112;
      const wave = Math.sin(u * 14 + t * 4) + Math.sin(v * 15 - t * 3);
      set(buf, x, y, mixColor([10, 12, 22], accent, 0.45 + 0.35 * wave), 0.65);
      set(buf, x + 1, y, mixColor([10, 12, 22], [255, 86, 134], 0.35 + 0.25 * Math.sin(wave)), 0.5);
    }
  }
}

function drawTextRecipePreview(buf, t, accent) {
  const p = Math.sin(t * 3) * 0.5 + 0.5;
  rect(buf, 352, 88, 60, 18, accent, 0.52 + p * 0.28);
  rect(buf, 344, 120, 76, 8, [255, 255, 255], 0.18);
  circle(buf, 382 + Math.cos(t * 2.2) * 30, 132 + Math.sin(t * 2.2) * 20, 5, [255, 214, 86], 0.86);
  circle(buf, 382, 132, 34, accent, 0.05);
}

function drawDecksRecipePreview(buf, t, accent) {
  for (let i = 0; i < 3; i++) {
    const x = 344 + i * 26;
    rect(buf, x, 78, 20, 72, hsv(i * 0.18 + t * 0.06, 0.72, 0.86), 0.64);
    rect(buf, x + 4, 158, 12, 5, [255, 255, 255], 0.26);
  }
  rect(buf, 348, 168, 68, 5, [255, 255, 255], 0.16);
  circle(buf, 348 + 68 * (Math.sin(t * 2) * 0.5 + 0.5), 170, 7, accent, 0.86);
}

function drawDepthRecipePreview(buf, t) {
  for (let y = 64; y < 174; y += 3) {
    const bend = Math.sin(y * 0.08 + t * 4) * 10;
    line(buf, 346 + bend, y, 420 - bend, y + Math.sin(t + y) * 3, hsv(y / 180, 0.58, 0.82), 0.66);
  }
}

function drawOpticalRecipePreview(buf, t, accent) {
  for (let i = 0; i < 38; i++) {
    const x = 346 + (i % 7) * 12;
    const y = 70 + Math.floor(i / 7) * 18;
    const dx = Math.cos(i + t * 4) * 8;
    const dy = Math.sin(i * 0.7 + t * 4) * 5;
    line(buf, x, y, x + dx, y + dy, accent, 0.66);
    circle(buf, x + dx, y + dy, 2, [255, 255, 255], 0.7);
  }
}

function drawFaceRecipePreview(buf, accent) {
  circle(buf, 382, 116, 42, [255, 255, 255], 0.08);
  for (let i = 0; i < 42; i++) {
    const a = (i / 42) * Math.PI * 2;
    const x = 382 + Math.cos(a) * (24 + 10 * Math.sin(i));
    const y = 116 + Math.sin(a) * 38;
    circle(buf, x, y, 2, accent, 0.76);
  }
  line(buf, 362, 111, 402, 111, accent, 0.45);
  line(buf, 370, 140, 394, 140, [255, 86, 134], 0.5);
}

function drawTimelineRecipePreview(buf, t, accent) {
  const active = Math.floor((t * 1.6) % 3);
  for (let i = 0; i < 3; i++) {
    rect(
      buf,
      348 + i * 23,
      88,
      19,
      66,
      i === active ? accent : [255, 255, 255],
      i === active ? 0.72 : 0.16,
    );
  }
  const p = (t * 0.5) % 1;
  line(buf, 348 + p * 66, 74, 348 + p * 66, 168, [255, 214, 86], 0.86);
}

function drawScene3dRecipePreview(buf, t, accent) {
  const rot = t * 1.3;
  const pts = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ].map(([x, y, z]) => projectPoint(x, y, z, rot, 28));
  pts.forEach(([x, y]) => {
    circle(buf, x + 142, y - 16, 3, accent, 0.8);
  });
  [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ].forEach(([a, b]) => {
    line(buf, pts[a][0] + 142, pts[a][1] - 16, pts[b][0] + 142, pts[b][1] - 16, accent, 0.58);
  });
}

const recipePreviewRenderers = {
  audio: drawAudioRecipePreview,
  decks: drawDecksRecipePreview,
  depth: drawDepthRecipePreview,
  face: drawFaceRecipePreview,
  feedback: drawFeedbackRecipePreview,
  glsl: drawShaderRecipePreview,
  keyframe: drawKeyframeRecipePreview,
  optical: drawOpticalRecipePreview,
  particles: drawParticlesRecipePreview,
  pose: drawPoseRecipePreview,
  scene3d: drawScene3dRecipePreview,
  synth: drawShaderRecipePreview,
  text: drawTextRecipePreview,
  textPath: drawTextRecipePreview,
  timeline: drawTimelineRecipePreview,
};

function _drawRecipePreview(buf, kind, t, accent) {
  rect(buf, 334, 56, 94, 126, [4, 7, 14], 0.92);
  recipePreviewRenderers[kind]?.(buf, t, accent);
}

function recipeStarterFrame(kind, _accent = [57, 232, 190]) {
  const outputRenderers = {
    audio: chromaTransientEnergyFrame,
    decks: nChannelDecksFrame,
    depth: multipassDepthFrame,
    face: faceTrackingFrame,
    feedback: feedbackTunnelFrame,
    glsl: isfImportFrame,
    keyframe: pbrProductFrame,
    optical: opticalFlowParticlesTrailFrame,
    particles: particleFlockMurmurationFrame,
    pose: poseTrailsFrame,
    scene3d: scene3dFrame,
    synth: feedbackTunnelInfiniteFrame,
    text: typewriterManifestoFrame,
    textPath: pathTitleOrbitFrame,
    timeline: sceneTimelineFrame,
  };
  const renderer = outputRenderers[kind];
  if (!renderer) throw new Error(`Unknown recipe starter preview kind: ${kind}`);
  return renderer;
}

function transportRestCueFrame(t) {
  const buf = baseFrame();
  terminalPanel(buf, 30, 42, 174, 168, [57, 232, 190]);
  rect(buf, 246, 42, 188, 168, [16, 24, 38], 0.95);
  const p = (t * 0.52) % 1;
  rect(buf, 268, 76, 138, 14, [57, 232, 190], 0.38);
  rect(buf, 268, 112, 138, 14, [255, 214, 86], 0.26);
  rect(buf, 268, 148, 138, 14, [255, 86, 134], 0.22);
  line(buf, 268 + p * 138, 60, 268 + p * 138, 178, [255, 255, 255], 0.9);
  circle(buf, 268 + p * 138, 60, 7, [255, 214, 86], 0.86);
  for (let i = 0; i < 5; i++)
    rect(buf, 58, 74 + i * 22, 74 + (i % 2) * 28, 5, [255, 255, 255], 0.2 + (i === 2 ? 0.24 : 0));
  rect(buf, 70, 184, 70, 8, [57, 232, 190], 0.68);
  return buf;
}

function scheduleInstallFrame(t) {
  const buf = baseFrame();
  rect(buf, 34, 32, 178, 190, [238, 242, 247], 0.93);
  for (let i = 0; i < 5; i++) rect(buf, 58, 66 + i * 28, 116, 5, [16, 24, 38], 0.3);
  const row = Math.floor((t * 1.8) % 5);
  rect(buf, 48, 56 + row * 28, 146, 20, [57, 232, 190], 0.22);
  rect(buf, 252, 48, 166, 138, [16, 24, 38], 0.94);
  circle(buf, 336, 112, 44, [255, 214, 86], 0.12);
  const hand = t * Math.PI * 2;
  line(buf, 336, 112, 336 + Math.cos(hand) * 32, 112 + Math.sin(hand) * 32, [255, 214, 86], 0.9);
  line(
    buf,
    336,
    112,
    336 + Math.cos(hand * 0.15) * 22,
    112 + Math.sin(hand * 0.15) * 22,
    [255, 255, 255],
    0.65,
  );
  rect(buf, 278, 202, 112, 8, [57, 232, 190], 0.58);
  return buf;
}

function macroRecorderFrame(t) {
  const buf = baseFrame();
  terminalPanel(buf, 28, 38, 148, 184, [255, 86, 134]);
  rect(buf, 220, 38, 232, 184, [16, 24, 38], 0.95);
  const step = Math.floor((t * 3) % 6);
  for (let i = 0; i < 6; i++) {
    const y = 66 + i * 24;
    rect(buf, 248, y, 104 + (i % 3) * 20, 5, [255, 255, 255], 0.18 + (i <= step ? 0.18 : 0));
    circle(buf, 400, y + 2, 5, i <= step ? [57, 232, 190] : [74, 88, 112], 0.85);
  }
  const pulse = Math.sin(t * 9) * 0.5 + 0.5;
  circle(buf, 102, 78, 14, [255, 86, 134], 0.45 + pulse * 0.24);
  rect(buf, 74, 152, 58, 8, [255, 214, 86], 0.62);
  return buf;
}

function twoProjectorFrame(t) {
  const buf = baseFrame();
  rect(buf, 34, 50, 176, 110, [16, 24, 38], 0.96);
  rect(buf, 270, 50, 176, 110, [16, 24, 38], 0.96);
  for (let i = 0; i < 28; i++) {
    circle(
      buf,
      122 + Math.cos(i + t) * 58,
      105 + Math.sin(i * 1.7 + t) * 38,
      2,
      hsv(i / 28 + t * 0.04, 0.7, 0.95),
      0.72,
    );
    rect(
      buf,
      304 + (i % 7) * 17,
      80 + Math.floor(i / 7) * 18,
      12,
      4,
      [255, 255, 255],
      0.18 + (i % 5 === 0 ? 0.28 : 0),
    );
  }
  const p = (t * 0.45) % 1;
  rect(buf, 86, 202, 308, 7, [255, 255, 255], 0.14);
  rect(buf, 86, 202, 308 * p, 7, [57, 232, 190], 0.72);
  line(buf, 210, 105, 270, 105, [255, 214, 86], 0.28 + 0.18 * Math.sin(t * 5));
  return buf;
}

function repairRollbackFrame(t) {
  const buf = baseFrame();
  rect(buf, 42, 44, 178, 166, [16, 24, 38], 0.96);
  rect(buf, 262, 44, 176, 166, [16, 24, 38], 0.96);
  const bad = Math.sin(t * 2.2) > 0.1;
  for (let i = 0; i < 5; i++) {
    miniNode(
      buf,
      68 + (i % 2) * 76,
      68 + Math.floor(i / 2) * 46,
      i === 3 && bad ? [255, 86, 134] : [57, 232, 190],
      i === 3,
    );
    miniNode(buf, 288 + (i % 2) * 76, 68 + Math.floor(i / 2) * 46, [57, 232, 190], i < 3);
  }
  if (bad) {
    line(buf, 226, 128, 256, 128, [255, 86, 134], 0.82);
    line(buf, 256, 128, 244, 118, [255, 86, 134], 0.82);
    line(buf, 256, 128, 244, 138, [255, 86, 134], 0.82);
  } else {
    line(buf, 226, 128, 256, 128, [57, 232, 190], 0.82);
  }
  rect(buf, 174, 226, 132, 8, bad ? [255, 86, 134] : [57, 232, 190], 0.7);
  return buf;
}

function portableToxReadmeFrame(t) {
  const buf = baseFrame();
  rect(buf, 46, 48, 142, 150, [16, 24, 38], 0.96);
  rect(buf, 86, 88, 62, 50, [57, 232, 190], 0.34 + 0.12 * Math.sin(t * 4));
  rect(buf, 242, 42, 164, 176, [238, 242, 247], 0.94);
  for (let i = 0; i < 9; i++) rect(buf, 264, 66 + i * 16, 70 + (i % 4) * 16, 4, [16, 24, 38], 0.3);
  rect(buf, 270, 190, 84, 8, [255, 214, 86], 0.58);
  const p = (t * 0.6) % 1;
  line(buf, 188, 122, 242, 122, [255, 255, 255], 0.2);
  circle(buf, 188 + 54 * p, 122, 5, [255, 214, 86], 0.88);
  return buf;
}

function layerStackFrame(t) {
  const buf = baseFrame();
  for (let i = 0; i < 5; i++) {
    const x = 116 + i * 32;
    const y = 72 + i * 20;
    rect(buf, x, y, 172, 58, hsv(0.08 + i * 0.12 + t * 0.03, 0.7, 0.82), 0.22 + i * 0.08);
    rect(buf, x + 14, y + 12, 78, 5, [255, 255, 255], 0.22);
    circle(
      buf,
      x + 140,
      y + 20,
      8,
      i === Math.floor((t * 1.7) % 5) ? [255, 214, 86] : [74, 88, 112],
      0.8,
    );
  }
  rect(buf, 78, 214, 324, 6, [255, 255, 255], 0.14);
  circle(buf, 78 + 324 * (Math.sin(t * 2) * 0.5 + 0.5), 217, 8, [57, 232, 190], 0.85);
  return buf;
}

function dataFeedFrame(t) {
  const buf = baseFrame();
  terminalPanel(buf, 30, 42, 172, 168, [57, 232, 190]);
  rect(buf, 248, 48, 178, 140, [16, 24, 38], 0.94);
  let lastX = 262;
  let lastY = 140;
  for (let i = 1; i < 48; i++) {
    const x = 262 + i * 3;
    const y = 118 + Math.sin(i * 0.35 + t * 5) * 34 + Math.sin(i * 0.91) * 12;
    line(buf, lastX, lastY, x, y, [57, 232, 190], 0.7);
    lastX = x;
    lastY = y;
  }
  rect(buf, 280, 206, 84, 8, [255, 214, 86], 0.56 + 0.16 * Math.sin(t * 6));
  return buf;
}

function tableBarsFrame(t) {
  const buf = baseFrame();
  rect(buf, 44, 44, 152, 166, [238, 242, 247], 0.92);
  for (let i = 0; i < 6; i++) {
    rect(buf, 62, 70 + i * 20, 42, 4, [16, 24, 38], 0.28);
    rect(buf, 124, 70 + i * 20, 44, 4, [16, 24, 38], 0.22);
  }
  const baseY = 196;
  for (let i = 0; i < 7; i++) {
    const h = 28 + Math.abs(Math.sin(t * 2 + i)) * 88;
    const x = 246 + i * 24;
    rect(buf, x, baseY - h, 16, h, hsv(i / 7, 0.62, 0.9), 0.72);
    rect(buf, x - 2, baseY + 4, 20, 4, [255, 255, 255], 0.18);
  }
  return buf;
}

function replicatorCardsFrame(t) {
  const buf = baseFrame();
  rect(buf, 42, 44, 112, 170, [238, 242, 247], 0.92);
  for (let i = 0; i < 5; i++) rect(buf, 62, 70 + i * 24, 62 + (i % 2) * 16, 5, [16, 24, 38], 0.28);
  for (let i = 0; i < 6; i++) {
    const x = 214 + (i % 3) * 70;
    const y = 62 + Math.floor(i / 3) * 76 + Math.sin(t * 2 + i) * 3;
    rect(buf, x, y, 54, 52, [16, 24, 38], 0.94);
    circle(buf, x + 27, y + 21, 11, hsv(i / 6 + t * 0.04, 0.62, 0.92), 0.72);
    rect(buf, x + 12, y + 40, 30, 4, [255, 255, 255], 0.22);
  }
  return buf;
}

function inlinePreviewThumbnailFrame(t) {
  const buf = baseFrame();
  rect(buf, 34, 38, 198, 178, [16, 24, 38], 0.95);
  for (let y = 60; y < 182; y++) {
    for (let x = 56; x < 210; x += 2) {
      const u = (x - 56) / 154;
      const v = (y - 60) / 122;
      const c = hsv(
        0.55 + 0.16 * Math.sin(u * 8 + t * 3),
        0.66,
        0.25 + 0.65 * smoothstep(0.72, 0.08, Math.hypot(u - 0.5, v - 0.5)),
      );
      set(buf, x, y, c, 0.86);
      set(buf, x + 1, y, c, 0.86);
    }
  }
  rect(buf, 268, 50, 154, 154, [238, 242, 247], 0.92);
  for (let i = 0; i < 7; i++) rect(buf, 292, 76 + i * 18, 70 + (i % 3) * 18, 5, [16, 24, 38], 0.3);
  const scan = (t * 0.8) % 1;
  line(buf, 56, 60 + scan * 122, 210, 60 + scan * 122, [255, 255, 255], 0.38);
  rect(buf, 292, 182, 82, 8, [57, 232, 190], 0.66);
  return buf;
}

function safetyBlackoutFrame(t) {
  const buf = baseFrame();
  for (let y = 42; y < 198; y++) {
    for (let x = 40; x < 268; x++) {
      const u = (x - 40) / 228;
      const v = (y - 42) / 156;
      const c = mixColor([30, 210, 255], [255, 76, 126], Math.sin(u * 8 + t * 3) * 0.5 + 0.5);
      set(buf, x, y, c, 0.7 * smoothstep(0.8, 0.1, Math.abs(v - 0.5)));
    }
  }
  const blackout = smoothstep(0.12, 0.45, Math.sin(t * 2.2) * 0.5 + 0.5);
  rect(buf, 40, 42, 228, 156, [0, 0, 0], blackout * 0.86);
  rect(buf, 300, 52, 118, 148, [16, 24, 38], 0.96);
  const dim = blackout;
  rect(buf, 332, 76, 54, 84, [255, 255, 255], 0.14);
  rect(buf, 332, 76 + 84 * dim, 54, 84 * (1 - dim), [57, 232, 190], 0.78);
  circle(buf, 360, 184, 15, dim > 0.65 ? [255, 86, 134] : [74, 88, 112], 0.86);
  glow(buf, 360, 184, 30, dim > 0.65 ? [255, 86, 134] : [57, 232, 190], 0.25);
  return buf;
}

function setlistRunnerFrame(t) {
  const buf = baseFrame();
  rect(buf, 38, 42, 404, 44, [16, 24, 38], 0.96);
  rect(buf, 38, 112, 404, 78, [16, 24, 38], 0.92);
  const durations = [0.28, 0.44, 0.28];
  const colors = [
    [57, 232, 190],
    [255, 86, 134],
    [255, 214, 86],
  ];
  let x = 54;
  const p = (t * 0.34) % 1;
  let acc = 0;
  for (let i = 0; i < 3; i++) {
    const w = durations[i] * 348;
    const active = p >= acc && p < acc + durations[i];
    rect(buf, x, 58, w - 8, 12, colors[i], active ? 0.88 : 0.34);
    rect(buf, x, 122, w - 8, 50, colors[i], active ? 0.42 : 0.18);
    x += w;
    acc += durations[i];
  }
  const playX = 54 + p * 348;
  line(buf, playX, 50, playX, 178, [255, 255, 255], 0.86);
  circle(buf, playX, 50, 6, [255, 255, 255], 0.86);
  rect(buf, 82, 212, 68, 7, [57, 232, 190], 0.72);
  rect(buf, 206, 212, 58, 7, [255, 214, 86], 0.62);
  rect(buf, 318, 212, 42, 7, [255, 86, 134], 0.62);
  return buf;
}

function showFailoverFrame(t) {
  const buf = baseFrame();
  const trip = Math.sin(t * 2.4) > 0.08;
  rect(buf, 34, 52, 150, 106, [16, 24, 38], 0.95);
  rect(buf, 296, 52, 150, 106, [16, 24, 38], 0.95);
  for (let i = 0; i < 30; i++) {
    circle(
      buf,
      62 + (i % 6) * 18,
      76 + Math.floor(i / 6) * 15,
      2,
      [57, 232, 190],
      trip ? 0.15 : 0.76,
    );
    rect(
      buf,
      322 + (i % 5) * 20,
      78 + Math.floor(i / 5) * 12,
      12,
      5,
      [255, 214, 86],
      trip ? 0.7 : 0.22,
    );
  }
  rect(buf, 214, 84, 52, 42, [238, 242, 247], 0.9);
  line(buf, 184, 105, 214, 105, trip ? [255, 86, 134] : [57, 232, 190], 0.82);
  line(buf, 266, 105, 296, 105, trip ? [255, 214, 86] : [74, 88, 112], 0.82);
  const idx = trip ? 1 : 0;
  rect(buf, 226, 96 + idx * 16, 28, 7, trip ? [255, 214, 86] : [57, 232, 190], 0.9);
  rect(buf, 88, 206, 304, 7, [255, 255, 255], 0.14);
  rect(buf, 88, 206, 304 * (trip ? 0.84 : 0.22), 7, trip ? [255, 86, 134] : [57, 232, 190], 0.68);
  return buf;
}

function poseReactiveBindingsFrame(t) {
  const buf = baseFrame();
  const cx = 128;
  const cy = 128;
  const handLift = Math.sin(t * 2.6) * 0.5 + 0.5;
  const pts = {
    head: [cx, cy - 58],
    lShoulder: [cx - 36, cy - 24],
    rShoulder: [cx + 36, cy - 24],
    lHand: [cx - 72, cy - 12 - handLift * 38],
    rHand: [cx + 72, cy - 12 - handLift * 68],
    hip: [cx, cy + 34],
    lFoot: [cx - 34, cy + 82],
    rFoot: [cx + 34, cy + 82],
  };
  [
    ["head", "lShoulder"],
    ["head", "rShoulder"],
    ["lShoulder", "lHand"],
    ["rShoulder", "rHand"],
    ["lShoulder", "hip"],
    ["rShoulder", "hip"],
    ["hip", "lFoot"],
    ["hip", "rFoot"],
  ].forEach(([a, b]) => {
    line(buf, pts[a][0], pts[a][1], pts[b][0], pts[b][1], [57, 232, 190], 0.6);
  });
  Object.values(pts).forEach(([x, y]) => {
    circle(buf, x, y, 6, [255, 255, 255], 0.75);
  });
  rect(buf, 270, 52, 150, 148, [16, 24, 38], 0.95);
  for (let i = 0; i < 4; i++) {
    const v = i === 0 ? handLift : Math.sin(t * 2 + i) * 0.5 + 0.5;
    rect(buf, 296, 78 + i * 26, 90, 5, [255, 255, 255], 0.16);
    rect(buf, 296, 78 + i * 26, 90 * v, 5, i === 0 ? [255, 214, 86] : [57, 232, 190], 0.76);
  }
  glow(buf, 350, 178, 38 + handLift * 16, [255, 86, 134], 0.25 + handLift * 0.24);
  return buf;
}

function audioGateDuckFrame(t) {
  const buf = baseFrame();
  rect(buf, 38, 46, 190, 160, [16, 24, 38], 0.95);
  let lastX = 56;
  let lastY = 126;
  for (let i = 1; i < 122; i++) {
    const x = 56 + i * 1.28;
    const kick = Math.max(0, Math.sin((t * 3 + i / 22) * Math.PI * 2));
    const y = 126 + Math.sin(i * 0.35 + t * 9) * 22 - kick ** 10 * 54;
    line(buf, lastX, lastY, x, y, [57, 232, 190], 0.68);
    lastX = x;
    lastY = y;
  }
  rect(buf, 270, 46, 158, 160, [16, 24, 38], 0.95);
  const phase = (t * 3) % 1;
  const transient = phase < 0.12 ? 1 - phase / 0.12 : 0;
  const duck = smoothstep(0.8, 0.05, phase);
  rect(buf, 300, 72, 20, 94, [255, 255, 255], 0.12);
  rect(buf, 300, 166 - transient * 94, 20, transient * 94, [255, 214, 86], 0.85);
  rect(buf, 354, 72, 20, 94, [255, 255, 255], 0.12);
  rect(buf, 354, 72, 20, 94 * duck, [255, 86, 134], 0.72);
  glow(buf, 146, 118, 58, [255, 214, 86], transient * 0.34);
  return buf;
}

function autoRepairLoopFrame(t) {
  const buf = baseFrame();
  const pass = Math.floor((t * 1.6) % 4);
  for (let col = 0; col < 3; col++) {
    rect(buf, 48 + col * 132, 46, 94, 154, [16, 24, 38], 0.95);
    for (let i = 0; i < 4; i++) {
      const fixed = i < pass - col + 2;
      miniNode(buf, 70 + col * 132, 70 + i * 29, fixed ? [57, 232, 190] : [255, 86, 134], !fixed);
    }
  }
  for (let col = 0; col < 2; col++) {
    line(buf, 142 + col * 132, 120, 180 + col * 132, 120, [255, 214, 86], 0.68);
    circle(buf, 176 + col * 132, 120, 4, [255, 214, 86], 0.86);
  }
  rect(buf, 138, 224, 204, 8, pass > 2 ? [57, 232, 190] : [255, 214, 86], 0.72);
  return buf;
}

function onboardingInitAskFrame(t) {
  const buf = baseFrame();
  terminalPanel(buf, 28, 40, 188, 174, [57, 232, 190]);
  rect(buf, 258, 46, 168, 160, [238, 242, 247], 0.92);
  const step = Math.floor((t * 2.1) % 5);
  for (let i = 0; i < 5; i++) {
    rect(
      buf,
      58,
      72 + i * 23,
      72 + (i % 2) * 36,
      5,
      [255, 255, 255],
      0.16 + (i <= step ? 0.18 : 0),
    );
    circle(buf, 184, 74 + i * 23, 5, i <= step ? [57, 232, 190] : [74, 88, 112], 0.82);
  }
  for (let i = 0; i < 7; i++) rect(buf, 282, 70 + i * 18, 84 + (i % 3) * 16, 4, [16, 24, 38], 0.28);
  rect(buf, 286, 184, 92, 8, [255, 214, 86], 0.62 + 0.12 * Math.sin(t * 5));
  return buf;
}

function compactGraphDigestFrame(t) {
  const buf = baseFrame();
  const nodes = [
    [86, 84],
    [154, 64],
    [154, 128],
    [224, 98],
    [294, 66],
    [294, 140],
  ];
  const edges = [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 3],
    [3, 4],
    [3, 5],
  ];
  edges.forEach(([a, b]) => {
    line(buf, nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1], [255, 255, 255], 0.18);
  });
  nodes.forEach(([x, y], i) => {
    miniNode(buf, x - 22, y - 13, i === 3 ? [255, 214, 86] : [57, 232, 190], false);
  });
  rect(buf, 336, 44, 94, 162, [238, 242, 247], 0.92);
  const limit = 7 - Math.floor((Math.sin(t * 2.4) * 0.5 + 0.5) * 3);
  for (let i = 0; i < limit; i++)
    rect(buf, 354, 68 + i * 18, 54 + (i % 3) * 12, 4, [16, 24, 38], 0.3);
  rect(buf, 354, 184, 48, 7, [57, 232, 190], 0.66);
  return buf;
}

function scaffoldRecipeFromNetworkFrame(t) {
  const buf = baseFrame();
  const left = [
    [78, 82],
    [142, 82],
    [110, 134],
    [174, 134],
  ];
  left.forEach(([x, y], i) => {
    miniNode(buf, x, y, i === 2 ? [255, 214, 86] : [57, 232, 190], false);
  });
  line(buf, 124, 95, 142, 95, [255, 255, 255], 0.22);
  line(buf, 110, 108, 110, 134, [255, 255, 255], 0.22);
  line(buf, 156, 108, 174, 134, [255, 255, 255], 0.22);
  const p = (t * 0.8) % 1;
  line(buf, 226, 126, 272, 126, [255, 214, 86], 0.48);
  circle(buf, 226 + 46 * p, 126, 5, [255, 214, 86], 0.9);
  rect(buf, 286, 46, 134, 166, [238, 242, 247], 0.92);
  for (let i = 0; i < 9; i++) rect(buf, 308, 70 + i * 15, 50 + (i % 4) * 12, 4, [16, 24, 38], 0.3);
  rect(buf, 310, 184, 72, 8, [57, 232, 190], 0.62);
  return buf;
}

function paramModesBatchFrame(t) {
  const buf = baseFrame();
  rect(buf, 42, 42, 396, 170, [238, 242, 247], 0.92);
  const rows = 5;
  const scan = Math.floor((t * 2.6) % rows);
  for (let i = 0; i < rows; i++) {
    const y = 68 + i * 25;
    rect(buf, 66, y, 320, 1, [16, 24, 38], 0.12);
    rect(buf, 72, y + 7, 74, 4, [16, 24, 38], 0.28);
    rect(buf, 184, y + 7, 42, 4, i === scan ? [255, 214, 86] : [57, 232, 190], 0.62);
    rect(buf, 264, y + 7, 46, 4, i % 2 ? [255, 86, 134] : [57, 232, 190], 0.48);
    circle(buf, 392, y + 9, 5, i <= scan ? [57, 232, 190] : [74, 88, 112], 0.8);
  }
  rect(buf, 134, 226, 212, 8, [57, 232, 190], 0.7);
  return buf;
}

function performRestToggleFrame(t) {
  const buf = baseFrame();
  terminalPanel(buf, 32, 48, 158, 156, [255, 214, 86]);
  rect(buf, 246, 62, 178, 112, [16, 24, 38], 0.95);
  const on = Math.sin(t * 2.1) > -0.1;
  rect(buf, 288, 102, 92, 32, on ? [57, 232, 190] : [74, 88, 112], 0.5);
  circle(buf, on ? 362 : 306, 118, 16, [255, 255, 255], 0.82);
  glow(buf, on ? 362 : 306, 118, 38, on ? [57, 232, 190] : [255, 86, 134], 0.24);
  for (let i = 0; i < 4; i++)
    rect(buf, 62, 78 + i * 24, 76 + i * 12, 5, [255, 255, 255], 0.16 + (i < 3 ? 0.14 : 0));
  rect(buf, 284, 194, 88, 8, on ? [57, 232, 190] : [255, 86, 134], 0.66);
  return buf;
}

function particleFlockMurmurationFrame(t) {
  const buf = baseFrame();
  const centerX = width / 2;
  const centerY = height / 2;
  for (let i = 0; i < 180; i++) {
    const a = i * 2.399 + t * (0.55 + (i % 7) * 0.018);
    const r = 18 + (i % 41) * 2.65 + Math.sin(t * 2.2 + i) * 10;
    const x = centerX + Math.cos(a) * r * 1.18;
    const y = centerY + Math.sin(a * 1.7) * r * 0.46 + Math.sin(i * 0.11 + t * 3) * 12;
    const head = a + Math.PI / 2;
    line(
      buf,
      x - Math.cos(head) * 5,
      y - Math.sin(head) * 5,
      x + Math.cos(head) * 5,
      y + Math.sin(head) * 5,
      [57, 232, 190],
      0.42,
    );
    circle(buf, x, y, 1.7, i % 9 === 0 ? [255, 214, 86] : [238, 242, 247], 0.55);
  }
  glow(buf, centerX, centerY, 120, [57, 232, 190], 0.18);
  rect(buf, 132, 220, 216, 7, [255, 255, 255], 0.12);
  rect(buf, 132, 220, 216 * (Math.sin(t * 1.7) * 0.5 + 0.5), 7, [255, 214, 86], 0.64);
  return buf;
}

function gpuParticleCurlGalaxyFrame(t) {
  const buf = baseFrame();
  for (let i = 0; i < 260; i++) {
    const seed = rand(i, 3);
    const arm = i % 4;
    const radius = 12 + seed * 170;
    const angle = arm * Math.PI * 0.5 + radius * 0.035 + t * (0.8 + seed * 0.5);
    const wobble = Math.sin(t * 2.3 + i * 0.37) * 9;
    const x = width / 2 + Math.cos(angle) * (radius + wobble);
    const y = height / 2 + Math.sin(angle) * (radius * 0.5 + wobble * 0.3);
    const color = hsv(0.54 + seed * 0.18, 0.72, 0.62 + seed * 0.36);
    circle(buf, x, y, 1.2 + seed * 1.8, color, 0.52);
  }
  glow(buf, width / 2, height / 2, 62, [255, 86, 134], 0.28);
  ellipseRing(buf, width / 2, height / 2, 150, 70, 0.02, [255, 214, 86], 0.28);
  return buf;
}

function depthSilhouetteMaskFrame(t) {
  const buf = baseFrame();
  for (let y = 40; y < 220; y++) {
    for (let x = 42; x < 438; x += 2) {
      const wave = Math.sin((x + y) * 0.03 + t * 4) * 0.5 + 0.5;
      const c = mixColor([20, 34, 68], [146, 66, 255], wave);
      set(buf, x, y, c, 0.58);
      set(buf, x + 1, y, c, 0.58);
    }
  }
  const sway = Math.sin(t * 2) * 9;
  circle(buf, 240 + sway, 80, 26, [8, 10, 18], 0.96);
  ellipseRing(buf, 240 + sway, 84, 32, 36, 0.11, [57, 232, 190], 0.58);
  polygon(
    buf,
    [
      [200 + sway, 110],
      [280 + sway, 110],
      [310 + sway, 210],
      [170 + sway, 210],
    ],
    [5, 6, 10],
    0.96,
  );
  ellipseRing(buf, 240 + sway, 158, 70, 66, 0.055, [255, 86, 134], 0.74);
  rect(buf, 78, 226, 324, 7, [57, 232, 190], 0.58);
  return buf;
}

function blobReactiveInstallationFrame(t) {
  const buf = baseFrame();
  rect(buf, 36, 42, 248, 166, [16, 24, 38], 0.94);
  rect(buf, 318, 42, 112, 166, [238, 242, 247], 0.9);
  for (let i = 0; i < 4; i++) {
    const x = 86 + i * 48 + Math.sin(t * 2.1 + i) * 26;
    const y = 104 + Math.cos(t * 1.6 + i * 1.3) * 42;
    const r = 13 + Math.sin(t * 2.4 + i) * 5;
    glow(buf, x, y, r * 2.4, hsv(0.48 + i * 0.12, 0.72, 0.9), 0.36);
    circle(buf, x, y, r, hsv(0.48 + i * 0.12, 0.72, 0.95), 0.64);
    ellipseRing(buf, x, y, r + 7, r + 7, 0.09, [255, 255, 255], 0.38);
    rect(buf, 342, 72 + i * 28, 58 * ((x - 48) / 230), 5, hsv(0.48 + i * 0.12, 0.72, 0.72), 0.7);
  }
  rect(buf, 140, 226, 200, 7, [255, 214, 86], 0.56 + Math.sin(t * 5) * 0.12);
  return buf;
}

function vectorLinesRotoscopeFrame(t) {
  const buf = baseFrame();
  rect(buf, 34, 42, 176, 168, [238, 242, 247], 0.86);
  rect(buf, 270, 42, 176, 168, [16, 24, 38], 0.95);
  for (let i = 0; i < 18; i++) {
    const y = 68 + i * 7;
    const wave = Math.sin(t * 2 + i * 0.5) * 12;
    line(buf, 64, y, 180 + wave, y + Math.sin(i) * 12, [16, 24, 38], 0.22);
    line(buf, 294, y, 414 + wave, y + Math.sin(i) * 12, [57, 232, 190], 0.58);
  }
  circle(buf, 118, 120, 34, [255, 214, 86], 0.18);
  ellipseRing(buf, 358, 120, 45, 58, 0.05, [255, 214, 86], 0.72);
  const p = (t * 0.7) % 1;
  line(buf, 210, 126, 270, 126, [255, 255, 255], 0.22);
  circle(buf, 210 + p * 60, 126, 5, [255, 86, 134], 0.85);
  return buf;
}

function cellularAutomataTapestryFrame(t) {
  const buf = baseFrame();
  const cell = 10;
  for (let y = 0; y < height / cell; y++) {
    for (let x = 0; x < width / cell; x++) {
      const v =
        Math.sin(x * 0.8 + t * 2.1) +
        Math.cos(y * 0.72 - t * 2.7) +
        Math.sin((x + y) * 0.38 + t * 3.4);
      const on = v > 0.62 || (v > 0.25 && (x + y + Math.floor(t * 3)) % 3 === 0);
      const c = on ? hsv(0.58 + ((x + y) % 7) * 0.025, 0.65, 0.86) : [10, 14, 24];
      rect(buf, x * cell + 1, y * cell + 1, cell - 2, cell - 2, c, on ? 0.74 : 0.72);
    }
  }
  rect(buf, 72, 224, 336, 7, [255, 255, 255], 0.12);
  rect(buf, 72, 224, 336 * ((Math.sin(t * 1.3) + 1) / 2), 7, [57, 232, 190], 0.66);
  return buf;
}

function slimeTrailsInkFrame(t) {
  const buf = baseFrame();
  for (let i = 0; i < 14; i++) {
    let x = 64 + i * 28;
    let y = 130 + Math.sin(i) * 35;
    for (let j = 0; j < 42; j++) {
      const a = Math.sin(j * 0.25 + i + t * 1.8) + Math.cos(x * 0.02 + t);
      const nx = x + Math.cos(a) * 6.5;
      const ny = y + Math.sin(a * 1.2) * 5.4;
      line(buf, x, y, nx, ny, i % 2 ? [57, 232, 190] : [255, 86, 134], 0.2 + j / 220);
      if (j % 9 === 0) glow(buf, nx, ny, 18, [255, 214, 86], 0.08);
      x = nx;
      y = ny;
    }
  }
  rect(buf, 102, 224, 276, 7, [57, 232, 190], 0.54);
  return buf;
}

function paletteHarmonyStudyFrame(t) {
  const buf = baseFrame();
  const hues = [0.55, 0.62, 0.76, 0.08, 0.14];
  for (let i = 0; i < hues.length; i++) {
    const c = hsv(hues[i] + Math.sin(t * 0.8) * 0.02, 0.58 + i * 0.05, 0.9);
    rect(buf, 46 + i * 78, 44, 58, 150, c, 0.78);
    circle(
      buf,
      75 + i * 78,
      132 + Math.sin(t * 2 + i) * 28,
      20,
      mixColor(c, [255, 255, 255], 0.26),
      0.72,
    );
  }
  for (let x = 62; x < 418; x++) {
    const u = (x - 62) / 356;
    const c = hsv(0.55 + u * 0.62 + t * 0.025, 0.62, 0.88);
    rect(buf, x, 218, 1, 9, c, 0.86);
  }
  return buf;
}

function flowFieldRibbonsFrame(t) {
  const buf = baseFrame();
  for (let i = 0; i < 18; i++) {
    let x = 36;
    let y = 46 + i * 10;
    const color = hsv(0.46 + i * 0.018, 0.72, 0.92);
    for (let j = 0; j < 70; j++) {
      const a = Math.sin(x * 0.026 + t * 1.7) + Math.cos(y * 0.034 - t * 1.1);
      const nx = x + 6;
      const ny = y + Math.sin(a + j * 0.08) * 5.8;
      line(buf, x, y, nx, ny, color, 0.46);
      x = nx;
      y = ny;
    }
  }
  glow(buf, 250, 130, 104, [57, 232, 190], 0.15);
  return buf;
}

function sculpturalReliefGalleryFrame(t) {
  const buf = baseFrame();
  const originX = 92;
  const originY = 176;
  for (let row = 0; row < 16; row++) {
    let prev;
    for (let col = 0; col < 28; col++) {
      const z = Math.sin(col * 0.42 + t * 2) * 16 + Math.cos(row * 0.55 - t * 1.3) * 13;
      const x = originX + col * 10 + row * 5;
      const y = originY - row * 7 - z;
      const color = mixColor([42, 210, 230], [255, 214, 86], (z + 30) / 60);
      circle(buf, x, y, 2.1, color, 0.68);
      if (prev) line(buf, prev[0], prev[1], x, y, color, 0.26);
      prev = [x, y];
    }
  }
  rect(buf, 62, 214, 360, 8, [255, 255, 255], 0.1);
  rect(buf, 62, 214, 360 * (Math.sin(t * 1.4) * 0.5 + 0.5), 8, [255, 86, 134], 0.58);
  return buf;
}

function kineticLyricsFlashFrame(t) {
  const buf = baseFrame();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x - width / 2) / width;
      const v = (y - height / 2) / height;
      const wave = Math.sin(Math.hypot(u, v) * 36 - t * 8) + Math.sin(u * 42 + t * 5);
      set(buf, x, y, mixColor([6, 8, 16], [40, 26, 78], wave * 0.22 + 0.5), 0.75);
    }
  }
  const beat = (t * 2.8) % 1;
  const flash = smoothstep(0.46, 0, beat);
  glow(buf, 240, 126, 120 + flash * 52, [255, 86, 134], 0.28 + flash * 0.58);
  for (let i = 0; i < 7; i++) {
    const y = 50 + i * 26 + Math.sin(t * 4 + i) * 5;
    line(buf, 30, y, 450, y + Math.sin(t + i) * 9, i % 2 ? [57, 232, 190] : [255, 214, 86], 0.08);
  }
  if (flash > 0.04) {
    const shear = Math.sin(t * 24) * 8 * flash;
    drawPixelText(buf, "DROP", 246 + shear, 91 + 9, {
      scale: 13,
      color: [0, 0, 0],
      alpha: 0.72 * flash,
      align: "center",
    });
    drawPixelText(buf, "DROP", 238 - flash * 5, 88, {
      scale: 13,
      color: [57, 232, 190],
      alpha: 0.5 * flash,
      align: "center",
    });
    drawPixelText(buf, "DROP", 244 + flash * 5, 88, {
      scale: 13,
      color: [255, 86, 134],
      alpha: 0.5 * flash,
      align: "center",
    });
    drawPixelText(buf, "DROP", 240, 88, {
      scale: 13,
      color: [255, 255, 255],
      alpha: 0.95 * flash,
      align: "center",
    });
  }
  rect(buf, 84, 220, 312, 6, [255, 255, 255], 0.12);
  rect(buf, 84, 220, 312 * beat, 6, [255, 214, 86], 0.72);
  drawPixelText(buf, "ALPHA GATE", 240, 234, {
    scale: 2,
    color: [164, 176, 205],
    alpha: 0.72,
    align: "center",
  });
  return buf;
}

function kineticLowerThirdPulseFrame(t) {
  const buf = baseFrame();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      set(buf, x, y, proceduralClip(x, y, t * 0.8, 0), 0.74);
    }
  }
  const pulse = Math.sin(t * 4.4) * 0.5 + 0.5;
  rect(buf, 0, 184, width, 58, [2, 3, 8], 0.72);
  rect(buf, 42, 194, 164 + pulse * 36, 4, [57, 232, 190], 0.72);
  rect(buf, 42, 204, 278, 26, [8, 10, 18], 0.72);
  drawPixelText(buf, "LUNA SOL", 52, 207, { scale: 4, color: [255, 255, 255], alpha: 0.92 });
  drawPixelText(buf, "LIVE / HALL B", 52, 236, { scale: 2, color: [255, 214, 86], alpha: 0.82 });
  circle(buf, 400, 214, 10 + pulse * 6, [255, 86, 134], 0.38 + pulse * 0.3);
  drawPixelText(buf, "NEXT", 372, 235, { scale: 2, color: [164, 176, 205], alpha: 0.82 });
  return buf;
}

function textCrawlTickerFrame(t) {
  const buf = baseFrame();
  for (let x = 0; x < width; x += 18) {
    line(buf, x, 36, x + Math.sin(t * 2 + x) * 16, 176, [57, 232, 190], 0.08);
  }
  rect(buf, 26, 42, 428, 118, [12, 18, 30], 0.74);
  for (let i = 0; i < 11; i++) {
    const h = 18 + Math.sin(t * 4 + i * 0.8) * 18 + i * 4;
    rect(buf, 54 + i * 34, 142 - h, 18, h, hsv(0.46 + i * 0.035, 0.72, 0.82), 0.46);
  }
  const message = "SET 01  DROP IN 08  /  ARTIST LUNA SOL  /  STAGE LEFT  /  ";
  const cycle = pixelTextWidth(message, 3, 1);
  let x = width - ((t * 92) % cycle);
  rect(buf, 0, 202, width, 40, [0, 0, 0], 0.86);
  rect(buf, 0, 202, width, 3, [255, 86, 134], 0.78);
  while (x < width + cycle) {
    drawPixelText(buf, message, x, 215, { scale: 3, color: [255, 255, 255], alpha: 0.9 });
    x += cycle;
  }
  return buf;
}

function textRollCreditsStageFrame(t) {
  const buf = baseFrame();
  for (let i = 0; i < 6; i++) {
    ellipseRing(
      buf,
      240,
      136,
      56 + i * 28 + ((t * 18) % 28),
      26 + i * 13,
      0.025,
      [57, 232, 190],
      0.12,
    );
  }
  rect(buf, 116, 34, 248, 202, [4, 6, 12], 0.72);
  drawPixelText(buf, "CREDITS", 240, 48, {
    scale: 4,
    color: [255, 214, 86],
    alpha: 0.82,
    align: "center",
  });
  const lines = ["VISUALS", "LUNA SOL", "LIGHT", "MAYA RIO", "SOUND", "NOITE", "THANK YOU"];
  const startY = 244 - ((t * 72) % 172);
  for (let i = 0; i < lines.length; i++) {
    const y = startY + i * 30;
    const fade = smoothstep(32, 70, y) * smoothstep(232, 186, y);
    drawPixelText(buf, lines[i], 240, y, {
      scale: i % 2 ? 3 : 2,
      color: i % 2 ? [255, 255, 255] : [164, 176, 205],
      alpha: 0.82 * fade,
      align: "center",
    });
  }
  return buf;
}

function typewriterManifestoFrame(t) {
  const buf = baseFrame();
  rect(buf, 34, 40, 412, 176, [236, 239, 232], 0.92);
  rect(buf, 46, 52, 388, 152, [6, 8, 14], 0.92);
  const lines = ["NO PREVIEW", "NO PANIC", "BUILD THE LIGHT", "THEN PERFORM IT"];
  const full = lines.join("\n");
  const reveal = Math.floor(Math.min(full.length, (t / (frames / fps)) * (full.length + 8)));
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const visible = lines[i].slice(0, Math.max(0, reveal - count));
    count += lines[i].length + 1;
    drawPixelText(buf, visible, 64, 72 + i * 28, {
      scale: 3,
      color: i === 2 ? [255, 214, 86] : [255, 255, 255],
      alpha: 0.9,
    });
  }
  const cursorLine = Math.min(
    lines.length - 1,
    Math.floor((reveal / Math.max(1, full.length)) * lines.length),
  );
  const cursorText = lines[cursorLine].slice(
    0,
    Math.max(0, reveal - lines.slice(0, cursorLine).join("\n").length - cursorLine),
  );
  const cursorX = 64 + pixelTextWidth(cursorText, 3, 1) + 6;
  rect(
    buf,
    cursorX,
    72 + cursorLine * 28,
    8,
    20,
    [57, 232, 190],
    Math.sin(t * 12) > 0 ? 0.85 : 0.18,
  );
  rect(buf, 68, 228, 344 * (reveal / full.length), 5, [255, 86, 134], 0.72);
  return buf;
}

function extrudedTitleFrame(t) {
  const buf = baseFrame();
  for (let y = 0; y < height; y++) {
    const horizon = y / height;
    for (let x = 0; x < width; x++) {
      const c = mixColor([4, 6, 12], [24, 30, 46], horizon);
      set(buf, x, y, c, 0.9);
    }
  }
  for (let i = 0; i < 12; i++) {
    const yy = 186 + i * 8;
    line(buf, 44 + i * 10, yy, 436 - i * 10, yy, [57, 232, 190], 0.08);
  }
  glow(buf, 160 + Math.sin(t * 1.4) * 80, 78, 118, [255, 214, 86], 0.18);
  const sway = Math.sin(t * 1.2) * 8;
  for (let i = 11; i >= 0; i--) {
    drawPixelText(buf, "LUNA", 244 + i * 2 + sway, 88 + i * 2, {
      scale: 11,
      color: mixColor([32, 36, 54], [57, 232, 190], i / 11),
      alpha: 0.5,
      align: "center",
    });
  }
  drawPixelText(buf, "LUNA", 240 + sway, 84, {
    scale: 11,
    color: [246, 248, 255],
    alpha: 0.92,
    align: "center",
  });
  drawPixelText(buf, "TEXT SOP / EXTRUDE", 240, 224, {
    scale: 2,
    color: [164, 176, 205],
    alpha: 0.72,
    align: "center",
  });
  return buf;
}

function popTextNoiseSculptureFrame(t) {
  const buf = baseFrame();
  for (let i = 0; i < 28; i++) {
    const y = 48 + i * 6;
    line(buf, 42, y, 438, y + Math.sin(t * 2 + i * 0.4) * 18, [57, 232, 190], 0.1);
  }
  for (let i = 0; i < 8; i++) {
    drawPixelText(buf, "NOISE", 240 + Math.sin(t * 2 + i) * 9, 86 + i * 5, {
      scale: 9,
      color: hsv(0.52 + i * 0.025, 0.58, 0.9),
      alpha: 0.2 + i * 0.045,
      align: "center",
      jitter: 2 + i * 0.3,
      seed: i + t,
    });
  }
  drawPixelText(buf, "TEXT SOP + NOISE", 240, 226, {
    scale: 2,
    color: [255, 214, 86],
    alpha: 0.78,
    align: "center",
  });
  return buf;
}

function projectorLabelPatternFrame(t) {
  const buf = baseFrame();
  rect(buf, 22, 22, 436, 226, [2, 4, 8], 0.94);
  for (let x = 42; x <= 438; x += 36) line(buf, x, 32, x, 238, [57, 232, 190], 0.16);
  for (let y = 42; y <= 228; y += 28) line(buf, 32, y, 448, y, [57, 232, 190], 0.16);
  line(buf, 240, 30, 240, 240, [255, 86, 134], 0.7);
  line(buf, 30, 135, 450, 135, [255, 86, 134], 0.7);
  for (let r = 24; r < 130; r += 24)
    ellipseRing(buf, 240, 135, r, r * 0.56, 0.018, [255, 255, 255], 0.22);
  drawPixelText(buf, "OUTPUT 02", 240, 76, {
    scale: 6,
    color: [255, 255, 255],
    alpha: 0.92,
    align: "center",
  });
  drawPixelText(buf, "LEFT", 240, 160, {
    scale: 8,
    color: [255, 214, 86],
    alpha: 0.9,
    align: "center",
  });
  circle(buf, 420, 54, 8 + Math.sin(t * 5) * 2, [57, 232, 190], 0.68);
  return buf;
}

function midiNoteTypeHitsFrame(t) {
  const buf = baseFrame();
  const labels = ["KICK", "BASS", "SNARE", "VOX", "CLAP", "PAD"];
  const active = Math.floor(t * 5) % labels.length;
  for (let i = 0; i < labels.length; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 58 + col * 124;
    const y = 50 + row * 76;
    const on = i === active;
    rect(buf, x, y, 96, 48, on ? [255, 86, 134] : [16, 24, 38], on ? 0.7 : 0.82);
    if (on) glow(buf, x + 48, y + 24, 54, [255, 86, 134], 0.38);
    drawPixelText(buf, labels[i], x + 48, y + 16, {
      scale: 3,
      color: on ? [255, 255, 255] : [164, 176, 205],
      alpha: 0.88,
      align: "center",
    });
  }
  rect(buf, 48, 210, 384, 7, [255, 255, 255], 0.12);
  rect(buf, 48, 210, 384 * ((t * 5) % 1), 7, [255, 214, 86], 0.78);
  drawPixelText(buf, labels[active], 240, 224, {
    scale: 4,
    color: [255, 255, 255],
    alpha: 0.92,
    align: "center",
  });
  return buf;
}

function pathTitleOrbitFrame(t) {
  const buf = baseFrame();
  glow(buf, 240, 132, 118, [57, 232, 190], 0.16);
  ellipseRing(buf, 240, 132, 118, 72, 0.025, [57, 232, 190], 0.45);
  ellipseRing(buf, 240, 132, 72, 42, 0.03, [255, 86, 134], 0.25);
  const text = "DEEP FIELD ";
  for (let i = 0; i < text.length; i++) {
    const a = t * 1.5 + i * ((Math.PI * 2) / text.length);
    const x = 240 + Math.cos(a) * 116;
    const y = 132 + Math.sin(a) * 70;
    drawPixelText(buf, text[i], x, y, {
      scale: 3,
      color: i % 2 ? [255, 214, 86] : [255, 255, 255],
      alpha: 0.82,
      align: "center",
    });
  }
  drawPixelText(buf, "ORBIT", 240, 112, {
    scale: 7,
    color: [255, 255, 255],
    alpha: 0.9,
    align: "center",
  });
  drawPixelText(buf, "PATH FOLLOW", 240, 178, {
    scale: 2,
    color: [164, 176, 205],
    alpha: 0.72,
    align: "center",
  });
  return buf;
}

function creativeRagKandinskyRemixFrame(t) {
  const buf = baseFrame();
  const red = [224, 32, 32];
  const blue = [0, 56, 184];
  const yellow = [255, 204, 24];
  const white = [244, 246, 240];
  const black = [2, 4, 9];
  const gradedShadow = [7, 11, 20];
  const gradedMid = [16, 23, 36];

  rect(buf, 0, 0, width, height, black, 0.96);

  const rot = 0.16 * Math.sin(t * 0.7);
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x - width / 2;
      const sy = y - height / 2;
      const u = (sx * cr - sy * sr) / 52;
      const v = (sx * sr + sy * cr) / 52;
      const angle = Math.atan2(sy, sx);
      const radius = Math.hypot(sx / 230, sy / 126);
      const gridX = Math.abs(u - Math.round(u));
      const gridY = Math.abs(v - Math.round(v));
      const grid = gridX < 0.02 || gridY < 0.024;
      const checker = (Math.floor(u + t * 0.32) + Math.floor(v - t * 0.18)) % 2;
      const wedge = Math.floor((angle + Math.PI + t * 0.45) / (Math.PI / 5));
      const band = Math.floor((u * 1.1 - v * 0.72 + t * 0.85) * 2.2);
      const index = Math.abs(wedge + band + checker) % 6;
      const palette = [gradedShadow, blue, red, gradedMid, yellow, black];
      const vignette = smoothstep(1.3, 0.35, radius);
      const color = grid ? white : mixColor(palette[index], black, 0.1 + 0.34 * radius);
      set(buf, x, y, color, grid ? 0.2 : 0.38 + vignette * 0.42);
    }
  }

  const sweep = (t * 0.42) % 1;
  const planeShift = Math.sin(t * 1.4) * 16;
  polygon(
    buf,
    [
      [18, 44 + planeShift * 0.35],
      [176 + planeShift, 18],
      [226 + planeShift * 0.4, 122],
      [72, 154],
    ],
    red,
    0.88,
  );
  polygon(
    buf,
    [
      [320 - planeShift * 0.4, 18],
      [462, 56],
      [432, 190 + planeShift * 0.25],
      [256 - planeShift, 154],
    ],
    blue,
    0.84,
  );
  polygon(
    buf,
    [
      [176, 174 - planeShift * 0.2],
      [292, 126 + planeShift * 0.3],
      [388, 246],
      [116, 248],
    ],
    yellow,
    0.82,
  );

  const centerX = 236 + Math.sin(t * 1.2) * 22;
  const centerY = 130 + Math.cos(t * 1.1) * 10;
  for (let i = 0; i < 5; i++) {
    const r = 24 + i * 17 + Math.sin(t * 2.1 + i) * 2.5;
    ellipseRing(buf, centerX, centerY, r * 1.05, r * 0.72, 0.025, i % 2 ? white : black, 0.74);
  }
  circle(buf, centerX - 56, centerY - 24, 22 + Math.sin(t * 2.4) * 4, yellow, 0.86);
  circle(buf, centerX + 78, centerY + 34, 18 + Math.cos(t * 2.0) * 3, red, 0.78);
  circle(buf, centerX + 16, centerY - 48, 10, white, 0.88);

  for (let i = 0; i < 10; i++) {
    const x = 42 + i * 44 + Math.sin(t * 1.5 + i) * 5;
    const y = 38 + ((i * 37) % 186);
    const color = i % 3 === 0 ? red : i % 3 === 1 ? yellow : blue;
    line(buf, x - 28, y + 42, x + 46, y - 34, black, 0.82);
    line(buf, x - 26, y + 40, x + 48, y - 36, color, 0.5);
  }

  for (let i = 0; i < 7; i++) {
    const y = 34 + i * 32 + Math.sin(t * 1.3 + i) * 2;
    line(buf, 24, y, 456, y + Math.sin(i + t) * 8, white, i % 2 ? 0.14 : 0.08);
  }
  for (let i = 0; i < 5; i++) {
    const x = 44 + i * 88 + Math.sin(t * 1.1 + i) * 4;
    line(buf, x, 22, x + Math.sin(t + i) * 14, 246, white, 0.1);
  }

  const lfoX = 26 + 428 * sweep;
  rect(buf, lfoX, 18, 4, 234, white, 0.16);
  glow(buf, lfoX, 134, 38, white, 0.08);
  rect(buf, 18, 18, 444, 234, [0, 0, 0], 0.08);
  line(buf, 18, 18, 462, 18, white, 0.28);
  line(buf, 18, 252, 462, 252, white, 0.22);
  line(buf, 18, 18, 18, 252, white, 0.18);
  line(buf, 462, 18, 462, 252, white, 0.18);
  return buf;
}

const clips = [
  ["feedback-tunnel.mp4", feedbackTunnelFrame],
  ["reaction-diffusion.mp4", reactionDiffusionFrame],
  ["noise-landscape.mp4", noiseLandscapeFrame],
  ["audio-reactive-3d-spikes.mp4", audioSpikesFrame],
  ["feedback-tunnel-infinite.mp4", feedbackTunnelInfiniteFrame],
  ["scene-3d.mp4", scene3dFrame],
  ["pbr-product-spin.mp4", pbrProductFrame],
  ["multipass-depth-no-camera.mp4", multipassDepthFrame],
  ["shader-park-blobs.mp4", shaderParkBlobsFrame],
  ["projection-mapping.mp4", projectionMappingFrame],
  ["transition-glitch-cut.mp4", transitionGlitchFrame],
  ["video-glitch.mp4", videoGlitchFrame],
  ["pose-trails-skeleton.mp4", poseTrailsFrame],
  ["auto-montage-shuffle.mp4", autoMontageFrame],
  ["euclidean-strobe-pattern.mp4", euclideanFrame],
  ["preset-morph-blend.mp4", presetMorphFrame],
  ["scene-timeline-arranger.mp4", sceneTimelineFrame],
  ["glsl-material-iridescent.mp4", glslMaterialFrame],
  ["live-dashboard-panic.mp4", dashboardFrame],
  ["prob-sequencer-markov.mp4", probSequencerFrame],
  ["automation-lane-loop.mp4", automationLaneFrame],
  ["chroma-transient-energy.mp4", chromaTransientEnergyFrame],
  ["moodboard-to-system-dispatch.mp4", moodboardFrame],
  ["audio-fingerprint-dispatch.mp4", audioFingerprintFrame],
  ["growth-system-branching.mp4", growthSystemFrame],
  ["score-enhance-loop.mp4", scoreEnhanceFrame],
  ["timecode-sync-lock.mp4", timecodeSyncFrame],
  ["import-shadertoy-nebula.mp4", shadertoyImportFrame],
  ["import-isf-plasma-controls.mp4", isfImportFrame],
  ["fluid-sim-ink.mp4", fluidSimFrame],
  ["image-particles-burst.mp4", imageParticlesFrame],
  ["dither-gameboy-poster.mp4", ditherFrame],
  ["halftone-amber-print.mp4", halftoneAmberPrintFrame],
  ["jfa-voronoi-stained-glass.mp4", jfaVoronoiFrame],
  ["point-cloud-drift.mp4", pointCloudDriftFrame],
  ["strange-attractor.mp4", strangeAttractorFrame],
  ["video-scopes-monitor.mp4", videoScopesFrame],
  ["chop-recorder-replay.mp4", chopRecorderFrame],
  ["tdableton-bridge.mp4", tdabletonFrame],
  ["lut-film-grade.mp4", lutFilmGradeFrame],
  ["flow-abstraction-ink-lines.mp4", flowAbstractionFrame],
  ["npr-kuwahara-paint.mp4", nprFilterFrame],
  ["post-passes-3d-cinematic.mp4", postPasses3dFrame],
  ["color-wheels-lift-gamma-gain.mp4", colorWheelsFrame],
  ["pop-geometry-noise-rig.mp4", popGeometryFrame],
  ["palette-extraction-swatches.mp4", extractPaletteFrame],
  ["palette-extract-and-grade.mp4", paletteExtractAndGradeFrame],
  ["kinetic-lyrics-flash.mp4", kineticLyricsFlashFrame],
  ["kinetic-lower-third-pulse.mp4", kineticLowerThirdPulseFrame],
  ["text-crawl-setlist-ticker.mp4", textCrawlTickerFrame],
  ["text-roll-credits-stage.mp4", textRollCreditsStageFrame],
  ["typewriter-manifesto-reveal.mp4", typewriterManifestoFrame],
  ["3d-extruded-title.mp4", extrudedTitleFrame],
  ["pop-text-noise-sculpture.mp4", popTextNoiseSculptureFrame],
  ["projector-label-test-pattern.mp4", projectorLabelPatternFrame],
  ["midi-note-type-hits.mp4", midiNoteTypeHitsFrame],
  ["path-title-orbit.mp4", pathTitleOrbitFrame],
  ["sop-to-svg-plotter.mp4", sopToSvgFrame],
  ["swap-operator-rewire.mp4", swapOperatorFrame],
  ["copilot-vision-critique.mp4", copilotVisionFrame],
  ["look-tox-tutorial-pack.mp4", lookToxTutorialFrame],
  ["library-tag-version-loop.mp4", libraryTagVersionFrame],
  ["generative-classics-pack.mp4", generativeClassicsPackFrame],
  ["data-source-http-ws-hotfix.mp4", dataSourceHotfixFrame],
  ["missing-args-elicit.mp4", elicitMissingArgsFrame],
  ["config-init-env-scan.mp4", configInitFrame],
  ["agent-run-continue.mp4", agentRunContinueFrame],
  ["command-catalog-discovery.mp4", commandCatalogFrame],
  ["config-profiles-redacted.mp4", configProfilesFrame],
  ["client-config-merge.mp4", clientConfigMergeFrame],
  ["bridge-install-verify.mp4", bridgeInstallVerifyFrame],
  ["streamable-http-loopback.mp4", streamableHttpLoopbackFrame],
  ["agent-watch-hooks.mp4", agentWatchHooksFrame],
  ["copilot-tier-switch.mp4", copilotTierSwitchFrame],
  ["mcp-resource-catalog.mp4", mcpResourceCatalogFrame],
  ["watch-node-telemetry.mp4", watchNodeTelemetryFrame],
  ["bridge-health-watchdog.mp4", bridgeHealthWatchdogFrame],
  ["sdf-field-csg-raymarch.mp4", sdfFieldFrame],
  ["sdf-csg-cathedral.mp4", sdfCsgCathedralFrame],
  ["optical-flow-vector-field.mp4", opticalFlowFrame],
  ["optical-flow-particles-trail.mp4", opticalFlowParticlesTrailFrame],
  ["histogram-scope-rgb.mp4", histogramScopeFrame],
  ["face-tracking-landmarks.mp4", faceTrackingFrame],
  ["hand-tracking-gestures.mp4", handTrackingFrame],
  ["segmentation-alpha-matte.mp4", segmentationMatteFrame],
  ["inline-preview-snapshot.mp4", inlinePreviewFrame],
  ["stage-dashboard-v2.mp4", stageDashboardV2Frame],
  ["session-profile-memory.mp4", sessionProfileFrame],
  ["recipe-bundle-publish-manifest.mp4", recipeBundlePublishFrame],
  ["readme-mermaid-docs.mp4", readmeMermaidFrame],
  ["watch-build-hot-reload.mp4", watchBuildHotReloadFrame],
  ["show-director-policy-queue.mp4", showDirectorPolicyFrame],
  ["nchannel-decks-fx-send.mp4", nChannelDecksFrame],
  ["nchan-decks-fx-bus.mp4", nChanDecksFxBusFrame],
  ["td-learning-resources.mp4", learningResourcesFrame],
  ["cli-completion-doctor-fix.mp4", cliCompletionDoctorFrame],
  ["recipe-audio-reactive-basic.mp4", recipeStarterFrame("audio", [57, 232, 190])],
  ["recipe-keyframe-animation-basic.mp4", recipeStarterFrame("keyframe", [255, 214, 86])],
  ["recipe-pose-skeleton-standalone.mp4", recipeStarterFrame("pose", [118, 75, 255])],
  ["recipe-particle-system-basic.mp4", recipeStarterFrame("particles", [255, 86, 134])],
  ["recipe-feedback-network-basic.mp4", recipeStarterFrame("feedback", [57, 232, 190])],
  ["recipe-glsl-shader-basic.mp4", recipeStarterFrame("glsl", [255, 86, 134])],
  ["recipe-kinetic-text-audio-reactive.mp4", recipeStarterFrame("audio", [255, 214, 86])],
  ["recipe-decks-layer-mixer.mp4", recipeStarterFrame("decks", [57, 232, 190])],
  ["recipe-depth-displacement-post.mp4", recipeStarterFrame("depth", [118, 75, 255])],
  ["recipe-kinetic-text-path-follow.mp4", recipeStarterFrame("textPath", [255, 214, 86])],
  ["recipe-optical-flow-particles.mp4", recipeStarterFrame("optical", [57, 232, 190])],
  ["recipe-mediapipe-face-overlay.mp4", recipeStarterFrame("face", [255, 86, 134])],
  ["recipe-scene-timeline-demo.mp4", recipeStarterFrame("timeline", [255, 214, 86])],
  ["recipe-scene-3d-basic.mp4", recipeStarterFrame("scene3d", [57, 232, 190])],
  ["recipe-video-synth-oscillator.mp4", recipeStarterFrame("synth", [118, 75, 255])],
  ["recipe-kinetic-text-standalone.mp4", recipeStarterFrame("text", [255, 86, 134])],
  ["transport-rest-cue.mp4", transportRestCueFrame],
  ["schedule-lobby-install.mp4", scheduleInstallFrame],
  ["macro-recorder-soundcheck.mp4", macroRecorderFrame],
  ["ai-party-two-projector-rehearsal.mp4", twoProjectorFrame],
  ["repair-network-rollback.mp4", repairRollbackFrame],
  ["portable-tox-readme-package.mp4", portableToxReadmeFrame],
  ["layer-stack-mute-solo.mp4", layerStackFrame],
  ["live-data-btc-feed.mp4", dataFeedFrame],
  ["table-3d-bars.mp4", tableBarsFrame],
  ["replicator-table-cards.mp4", replicatorCardsFrame],
  ["inline-preview-thumbnail.mp4", inlinePreviewThumbnailFrame],
  ["safety-blackout-chain.mp4", safetyBlackoutFrame],
  ["setlist-runner-hud.mp4", setlistRunnerFrame],
  ["show-failover-watchdog.mp4", showFailoverFrame],
  ["pose-reactive-bindings.mp4", poseReactiveBindingsFrame],
  ["audio-reactive-gate-duck.mp4", audioGateDuckFrame],
  ["auto-repair-loop-passes.mp4", autoRepairLoopFrame],
  ["tdmcp-init-ask-onboarding.mp4", onboardingInitAskFrame],
  ["compact-graph-digest-budget.mp4", compactGraphDigestFrame],
  ["scaffold-recipe-from-network.mp4", scaffoldRecipeFromNetworkFrame],
  ["param-modes-batch-inspector.mp4", paramModesBatchFrame],
  ["perform-mode-rest-toggle.mp4", performRestToggleFrame],
  ["particle-flock-murmuration.mp4", particleFlockMurmurationFrame],
  ["gpu-particle-curl-galaxy.mp4", gpuParticleCurlGalaxyFrame],
  ["depth-silhouette-neon-mask.mp4", depthSilhouetteMaskFrame],
  ["blob-reactive-installation.mp4", blobReactiveInstallationFrame],
  ["vector-lines-rotoscope.mp4", vectorLinesRotoscopeFrame],
  ["cellular-automata-tapestry.mp4", cellularAutomataTapestryFrame],
  ["slime-trails-ink.mp4", slimeTrailsInkFrame],
  ["palette-harmony-study.mp4", paletteHarmonyStudyFrame],
  ["flow-field-ribbons.mp4", flowFieldRibbonsFrame],
  ["sculptural-relief-gallery.mp4", sculpturalReliefGalleryFrame],
  ["creative-rag-kandinsky-remix.mp4", creativeRagKandinskyRemixFrame],
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

const requestedClipNames = new Set(process.argv.slice(2).map((name) => basename(name)));
const knownClipNames = new Set(clips.map(([name]) => name));
const unknownClipNames = [...requestedClipNames].filter((name) => !knownClipNames.has(name));
if (unknownClipNames.length > 0) {
  throw new Error(`Unknown clip(s): ${unknownClipNames.join(", ")}`);
}

const selectedClips =
  requestedClipNames.size === 0 ? clips : clips.filter(([name]) => requestedClipNames.has(name));

for (const [name, renderer] of selectedClips) {
  encode(name, renderer);
}
