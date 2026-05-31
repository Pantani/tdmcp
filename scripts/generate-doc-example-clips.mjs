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
  const progress = (t * 1.35) % 3.8;
  drawGrowthBranch(buf, width / 2, 246, -Math.PI / 2, 54, 6, progress);
  rect(buf, 92, 226, 296, 9, [24, 42, 32], 0.9);
  rect(buf, 92, 226, 296 * Math.min(1, progress / 3.8), 9, [122, 236, 150], 0.82);
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

const clips = [
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
