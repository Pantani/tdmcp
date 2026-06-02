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

function videoGlitchFrame(t) {
  const buf = baseFrame();
  for (let y = 0; y < height; y++) {
    const tear =
      Math.sin(y * 0.19 + t * 18) * 18 +
      (rand(Math.floor(y / 9), Math.floor(t * 8), 2) > 0.78 ? 34 : 0);
    for (let x = 0; x < width; x++) {
      const src = proceduralClip(x + tear, y + Math.sin(t * 3) * 12, t, 0);
      const scan = y % 4 < 2 ? 0.82 : 0.55;
      const noise = rand(Math.floor(x / 4), Math.floor(y / 4), Math.floor(t * 16));
      const color = [
        clamp(src[0] * scan + noise * 42),
        clamp(src[1] * (scan * 0.92) + noise * 18),
        clamp(src[2] * (scan * 1.08) + noise * 58),
      ];
      set(buf, x, y, color, 0.9);
      if (x + 3 < width && Math.sin(y * 0.08 + t * 12) > 0.9)
        set(buf, x + 3, y, [255, 50, 142], 0.22);
      if (x - 3 >= 0 && Math.sin(y * 0.07 - t * 10) > 0.92)
        set(buf, x - 3, y, [42, 230, 255], 0.22);
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

function sopToSvgFrame(t) {
  const buf = baseFrame();
  const path = [];
  for (let i = 0; i < 80; i++) {
    const x = 38 + i * 3.6;
    const y = 136 + Math.sin(i * 0.28 + t * 2.5) * 48 + Math.sin(i * 0.71) * 12;
    path.push([x, y]);
  }
  for (let i = 0; i < path.length - 1; i++)
    line(buf, path[i][0], path[i][1], path[i + 1][0], path[i + 1][1], [68, 220, 255], 0.66);
  rect(buf, 316, 34, 128, 190, [244, 239, 224], 0.96);
  rect(buf, 328, 48, 104, 162, [255, 255, 255], 0.86);
  const p = Math.floor(((t * 0.5) % 1) * (path.length - 1));
  for (let i = 0; i < p; i++) {
    const x0 = 336 + (path[i][0] - 38) * 0.34;
    const y0 = 130 + (path[i][1] - 136) * 0.52;
    const x1 = 336 + (path[i + 1][0] - 38) * 0.34;
    const y1 = 130 + (path[i + 1][1] - 136) * 0.52;
    line(buf, x0, y0, x1, y1, [18, 24, 32], 0.92);
  }
  circle(
    buf,
    336 + (path[p][0] - 38) * 0.34,
    130 + (path[p][1] - 136) * 0.52,
    4,
    [255, 82, 126],
    0.95,
  );
  rect(buf, 92, 230, 120, 8, [57, 232, 190], 0.8);
  rect(buf, 332, 230, 88, 8, [255, 214, 86], 0.8);
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

function agentRunContinueFrame(t) {
  const buf = baseFrame();
  terminalPanel(buf, 32, 30, 416, 198);
  const scan = Math.floor((t * 6) % 5);
  for (let i = 0; i < 5; i++) {
    const y = 62 + i * 28;
    const done = scan > i;
    const failed = i === 2 && scan > i;
    rect(buf, 62, y, 220 - i * 18, 6, [255, 255, 255], done ? 0.3 : 0.18);
    rect(
      buf,
      314,
      y - 5,
      42,
      16,
      failed ? [255, 86, 134] : done ? [57, 232, 190] : [74, 88, 112],
      done ? 0.82 : 0.46,
    );
    if (i === 2 && scan <= i) rect(buf, 314, y - 5, 42, 16, [255, 214, 86], 0.42);
    if (done) circle(buf, 382, y + 2, 5, failed ? [255, 86, 134] : [57, 232, 190], 0.92);
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

function showDirectorPolicyFrame(t) {
  const buf = baseFrame();
  rect(buf, 30, 28, 420, 212, [14, 21, 34], 0.96);
  rect(buf, 50, 50, 112, 154, [20, 30, 46], 0.94);
  rect(buf, 184, 50, 112, 154, [20, 30, 46], 0.94);
  rect(buf, 318, 50, 112, 154, [20, 30, 46], 0.94);
  const phase = Math.floor((t * 1.45) % 3);
  const colors = [
    [57, 232, 190],
    [255, 214, 86],
    [255, 86, 134],
  ];
  for (let i = 0; i < 3; i++) {
    const x = 50 + i * 134;
    const active = i === phase;
    rect(buf, x + 18, 72, 66, 6, [255, 255, 255], active ? 0.42 : 0.22);
    rect(buf, x + 18, 94, 78, 5, colors[i], active ? 0.82 : 0.36);
    rect(buf, x + 18, 116, 52, 5, [255, 255, 255], active ? 0.3 : 0.14);
    if (i === 0) circle(buf, x + 56, 156, 18, colors[i], 0.3 + (active ? 0.24 : 0));
    if (i === 1) {
      rect(buf, x + 32, 142, 44, 24, colors[i], active ? 0.68 : 0.28);
      rect(buf, x + 40, 172, 28, 5, [255, 255, 255], 0.22);
    }
    if (i === 2) {
      line(buf, x + 34, 144, x + 78, 176, colors[i], active ? 0.8 : 0.35);
      line(buf, x + 78, 144, x + 34, 176, colors[i], active ? 0.8 : 0.35);
    }
    if (active) glow(buf, x + 56, 126, 58, colors[i], 0.28);
  }
  const p = smoothstep(0.08, 0.86, (t * 0.7) % 1);
  line(buf, 162, 126, 184, 126, [255, 255, 255], 0.18);
  line(buf, 296, 126, 318, 126, [255, 255, 255], 0.18);
  circle(buf, 72 + p * 336, 220, 5, colors[phase], 0.92);
  rect(buf, 76, 218, 328, 5, [255, 255, 255], 0.13);
  rect(buf, 76, 218, 328 * p, 5, colors[phase], 0.72);
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
  ["jfa-voronoi-stained-glass.mp4", jfaVoronoiFrame],
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
  ["show-director-policy-queue.mp4", showDirectorPolicyFrame],
  ["nchannel-decks-fx-send.mp4", nChannelDecksFrame],
  ["td-learning-resources.mp4", learningResourcesFrame],
  ["cli-completion-doctor-fix.mp4", cliCompletionDoctorFrame],
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
