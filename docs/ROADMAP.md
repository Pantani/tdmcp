# tdmcp Roadmap — v0.2.0 → v1.0.0

A phased plan toward 1.0. Each phase ships as its own minor release with a
CHANGELOG entry and live validation in TouchDesigner. Phases are ordered by
**technical dependency + impact on live audiovisual / VJ workflows** (audio-,
camera- and beat-reactive performance).

> **Status legend:** ☐ planned · ◐ in progress · ☑ shipped
> **Effort legend:** **S** ≤1 day · **M** 2–4 days · **L** ~1 week

## Cross-cutting conventions

Every feature follows the existing patterns:

- New tool in `src/tools/layerN/<name>.ts` — Zod schema + `*Impl` + `register*`,
  registered in the layer's `index.ts`.
- Bridge work happens via a Python script built with `buildPayloadScript`
  (`__PAYLOAD_B64__`) executed through the bridge, parsed back with
  `parsePythonReport`. New REST endpoints / services only when streaming or
  performance demands it.
- CLI commands map 1:1 onto a tool handler in `src/cli/agent.ts`.
- Unit test in `tests/unit`; live-validate in TD (preview + post-cook error
  check) before marking shipped.
- CHANGELOG entry per release (Keep a Changelog + SemVer).

## Phase overview

| Phase | Version | Theme | Rationale |
|---|---|---|---|
| 0 | 0.3.0 ☑ | DX & CLI foundation | Multiplier — speeds up every later phase |
| 1 | 0.4.0 | Musical reactivity | Core workflow; depends on phase-0 event producer |
| 2 | 0.5.0 | Live performance | Makes systems playable; reuses presets + events |
| 3 | 0.6.0 | Advanced creation (TD) | Heavy, independent features → parallelizable |
| 4 | 0.7.0 | Intelligence (AI) | Layer that builds on everything already shipped |
| 5 | 0.8.0 | Robustness & export | Polish, automation, path to 1.0 |
| — | 1.0.0 | Consolidation | API stabilization, docs, test coverage |

---

## Phase 0 — v0.3.0 · DX & CLI foundation ☑ shipped

First because it has a multiplier effect: hot-reload kills the bridge-staleness
pain, and the event producer is a prerequisite for musical reactivity.

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| Bridge hot-reload | `reload_bridge` tool + `reload` CLI reimport `mcp.*` in place (logic already in `dev.py`) | S | ☑ |
| Bridge event producer | `timeline.frame` / `node.cook` / `project.saved` broadcast — already shipped in the bridge's `events_hook` Execute DAT | M | ☑ |
| CLI: expose L1/L2 | All generators + building blocks in `agent.ts` (`visual`, `audio-reactive`, `post-fx`, `preset`, `animate`, `io`, `checkpoint`, …) | M | ☑ |
| CLI `watch` | `runWatch` tails the bridge WebSocket as ndjson (`--include-high-frequency`) | S | ☑ |
| CLI `preview` | `preview <nodePath> -o file.png` writes the PNG to disk | S | ☑ |
| Checkpoint / restore | `manage_checkpoint` (store/restore/list/delete): params + topology, recreate deleted, prune created | M | ☑ |

**Areas:** `td/modules/mcp/dev.py` (already had reload), `src/cli/agent.ts`
(`runWatch`, preview, L1/L2 commands), `src/tools/layer3/reloadBridge.ts`,
`src/tools/layer2/manageCheckpoint.ts`. The bridge itself was unchanged — the
event producer and reload logic already shipped in 0.2.0, so no reinstall needed.

---

## Phase 1 — v0.4.0 · Musical reactivity ⭐

The heart of the live workflow. Beat events depend on the phase-0 event producer.

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| `create_tempo_sync` | Tempo clock (Ableton Link / Tempo CHOP) + per-beat/bar triggers | M | ☐ |
| `extract_audio_features` | BPM, energy, onset, bass/mid/treble split, envelope — as ready-to-bind channels | M | ☐ |
| Beat events on stream | Broadcast `beat`/`bar` (Beat CHOP + CHOP Execute) → consumable by CLI and AI | M | ☐ |
| Prompt "beat-reactive designer" | Guides the AI to build visuals that react to audio features | S | ☐ |

**Areas:** new L1 tools, `events.py` + beat producer, `src/prompts/`. Real
operators: `ableton_link_chop`, `beat_chop`, `analyze_chop`,
`audio_spectrum_chop`, `audio_dynamics_chop` (all already in the KB).

---

## Phase 2 — v0.5.0 · Live performance ⭐

Turns generated systems into instruments. Extends `manage_presets` and the
existing external I/O.

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| Cue / scene system | Scene list with **timed crossfade / morph** between presets | L | ☐ |
| MIDI/OSC learn | Map a physical control by "move and capture" instead of declaring the channel | M | ☐ |
| Playable control surface | Performance panel (cue buttons, XY pad, crossfaders) | M | ☐ |
| Macro controls | One knob → N parameters with curves / ranges (one-to-many) | M | ☐ |
| Safe randomize | Button that randomizes params within defined ranges | S | ☐ |
| Phone remote | Web panel via WebServer DAT (reuses the bridge) | M | ☐ |
| MIDI/OSC output | Bidirectional feedback (extends `create_external_io`) | S | ☐ |

**Areas:** extends `managePresets`, `createControlPanel`, `createExternalIo`;
new `td/templates/` for the web panel.

---

## Phase 3 — v0.6.0 · Advanced creation (TouchDesigner)

Heavy but mutually independent features — good candidates for parallel agents.

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| Video playback / media pool | Movie File In, playlist, clip switcher | M | ☐ |
| Layer mixer (VJ) | A/B composition with blend modes + crossfade | M | ☐ |
| 3D scene / instancing / render | Camera + Light + Render TOP, geometry instancing | L | ☐ |
| Projection mapping | Corner-pin / mesh warp | L | ☐ |
| Keyframe animation | Animation COMP + curves/easing synced to the timeline | M | ☐ |
| GPU simulations | Fluid / flocking / reaction-diffusion as parameterized tools | L | ☐ |
| More recipes | Covering video, 3D, mapping, simulations | M | ☐ |

**Areas:** new L1/L2 tools; recipes in `recipes/*.json` + `validate-recipes`.

---

## Phase 4 — v0.7.0 · Intelligence (AI)

The intelligence layer on top of everything already built.

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| Visual reference → network | Send a still/video; the AI recreates the look in real nodes (multimodal) | L | ☐ |
| Natural-language tweaks | "darker / faster / more chaotic" → the right params on the existing patch | M | ☐ |
| Semantic KB search | Embeddings over the 629 operators (note: new dependency — weigh cost/benefit) | M | ☐ |
| Aesthetic critique / suggestion | AI evaluates the patch and proposes visual/perf improvements | M | ☐ |
| Patch doc / diagram | Expands `describe_project` into a readable network map | S | ☐ |
| Remaining prompts | "VJ set builder", "palette/mood", "fix shader compile error" | S | ☐ |

**Areas:** `src/prompts/`, `src/tools/layer1/describeProject.ts`, possible
embeddings module in `src/knowledge/`.

---

## Phase 5 — v0.8.0 · Robustness & export

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| CLI `render` / export | Frame / sequence / movie via CLI (render automation) | M | ☐ |
| Performance auto-optimize | Uses `get_td_performance` to drop res / disable cooking on expensive nodes | M | ☐ |
| Patch versioning / diff | Readable diffs between snapshots (extends `snapshot`) | M | ☐ |
| CLI `init` / `recipes` / REPL | `.toe` scaffold, apply recipes, interactive mode | M | ☐ |
| Gamepad / keyboard | Additional control source | S | ☐ |

---

## v1.0.0 — Consolidation

Tool-API stabilization, docs (README + per-feature), test coverage, expanded
recipe library, bridge hardening.
