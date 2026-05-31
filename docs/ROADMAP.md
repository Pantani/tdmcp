---
title: Roadmap
description: "What's shipped, what's experimental, and what's planned for tdmcp — the TouchDesigner MCP server — on the way to a stable 1.0."
---

# tdmcp Roadmap

tdmcp connects an AI assistant (Claude, Cursor, Codex…) to TouchDesigner so you
can build real visual systems from plain language — no node-wiring by hand. This
page is the honest, bird's-eye picture of **what already works, what's still
rough, and what's coming next** on the way to a stable 1.0.

**Where things stand today.** The current release is **v0.6.1** — on
[npm](https://www.npmjs.com/package/@dpantani/tdmcp) and
[GitHub](https://github.com/Pantani/tdmcp) — exposing **179 tools**. The project
has grown through four arcs:

1. **Generate** — one-line tools that build a whole wired network (audio-reactive,
   generative, feedback, 3D, particles, shaders).
2. **Perform** — turn those networks into playable instruments (cues, macros,
   control surfaces, a phone remote, beat sync, a hands-free auto-VJ).
3. **Package & operate** — reusable components, project analysis, token-cheap
   editing primitives, and a structured bridge that keeps working in a
   locked-down venue.
4. **Compose & ingest** *(next)* — run a whole arranged show over time, and pull
   in the wider TouchDesigner world (Shadertoy / ISF shaders, Ableton, the iconic
   VJ looks).

<<<<<<< HEAD
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

> Phase numbers are historical build order, not release order — the **Version** column
> shows which release each phase ships in. Everything built so far (Phases 0–12) ships in 0.3.0.
> **Current release: 0.6.1** (npm + GitHub). Phases 13 → 0.5.0 · 14–15 → 0.5.0 · 16 → 0.6.0 · 17 is the open forward plan.

| Phase | Version | Theme | Rationale |
|---|---|---|---|
| 0 | 0.3.0 ☑ | DX & CLI foundation | Multiplier — speeds up every later phase |
| 1 | 0.3.0 ☑ | Musical reactivity | Core workflow; depends on phase-0 event producer |
| 2 | 0.3.0 ☑ | Live performance | Makes systems playable; reuses presets + events |
| 3 | 0.3.0 ☑ | Advanced creation (TD) | Heavy, independent features → parallelizable |
| 4 | 0.3.0 ☑ | Intelligence (AI) | Layer that builds on everything already shipped |
| 5 | 0.3.0 ☑ | Robustness & export | Polish, automation, path to 1.0 |
| 6 | 0.3.0 ◐ | Obsidian vault | Markdown library + journal bridge: recipes, setlists, shaders, presets, docs |
| — | 1.0.0 | Consolidation | API stabilization, docs, test coverage |
| 7 | 0.3.0 ☑ | Stage I/O & sensor reactivity | Send video out, fan across projectors, react to the camera, follow an external clock, run hands-free |
| 8–11 | 0.3.0 ◐ | Effects, reactivity, control & AI | Parallel waves — signature effects, deeper reactivity, creation, live control/AI/DX (detailed below) |
| 12 | 0.3.0 ☑ | Dimensional: 3D, depth & spatial mapping | Take visuals off the flat plane — react in 3D, sculpt with depth, map onto real surfaces |
| 13 | 0.5.0 ☑ | Components, agent-DX & reactivity | Reusable-component scaffolding, project analysis/auto-docs, token-cheap agent-DX, Link/MIDI — integrated for 0.5.0, with hardware/live validation called out below |
| 14–15 | 0.5.0 ☑ | Live mixing, parameter fidelity & creative direction | Post-discovery wave: transitions/layer-stack/keyer/media-bin, one-shot reactivity, signature effects, network round-trip, 11 AI prompts |
| 16 | 0.6.0 ☑ | TouchDesigner-depth & library fidelity | 7 P0s from discovery round-1: bridge read/write fidelity (flags/wiring/structured endpoints + `cook.error`), `create_modulators` + `create_look_bank` instruments, library contact-sheet — 179 tools |
| 17 | 0.7.0+ ◐ | Composition, automation & intelligence | In progress via the backlog-campaign harness (Wave 3 artist controls + Wave 4 library/packaging shipped + live-validated). Discovery rounds 2–3: time-based show automation, beat-locked montage, pattern generation, own-work memory, MCP sampling — **plus the external community-sources round** (Shadertoy/ISF import, missing iconic looks, color-finish, artist-publishing) |
=======
> **How to read this page**
>
> - ✅ **Shipped** — in a released version you can install today.
> - 🧪 **Experimental** — shipped and usable, but needs live tuning or specific
>   hardware to shine (flagged so you know what to expect).
> - ⬜ **Planned** — designed and prioritized, not yet built.
>
> The dated, line-by-line record of every change is the
> [CHANGELOG](https://github.com/Pantani/tdmcp/blob/main/CHANGELOG.md); the
> always-current, complete tool list is the [Tools reference](/reference/tools).
> This page is the overview. Curious about the long tail of ideas? The full,
> unfiltered brainstorm is preserved in the [planning archive](#full-backlog) at
> the end.
>>>>>>> origin/main

---

## ✅ Shipped

### v0.6.x — TouchDesigner depth & library fidelity

*A sharper, safer bridge plus two performance instruments.* Reads now report the
operator flags that explain the classic "why is it black?" (bypass / render /
display / lock), and the core editing operations — connect, parameter modes, DAT
text, logs — moved to **structured endpoints that keep working even with
raw-Python execution turned off**, the security-conscious venue setup.

- **`create_modulators`** — a tempo-locked bank of LFOs (sine / saw / noise) on
  one output; bind it to any parameter to make a network breathe in time.
- **`create_look_bank`** — capture, store and recall named "looks," with an
  instant snap or a quantized A↔B morph.
- **`generate_library_index`** + preview thumbnails — a Markdown contact-sheet of
  your saved recipes and components.
- **`get_td_node_flags`**, structured connect / disconnect / parameter / text /
  logs endpoints, and edge-triggered cook-error events for fast live recovery.

### v0.5.0 — Reusable components, agent-DX & live mixing

*The shift from generating visuals to packaging, documenting and cheaply
operating them.* Build a network → add knobs → script it → save it as a reusable
`.tox`.

- **Components:** `add_custom_parameters`, `scaffold_extension`, `analyze_project`,
  `generate_readme`.
- **Token-cheap editing:** `edit_dat_content`, `set_dat_content`,
  `batch_operations`, `manage_annotation`, a compact whole-network read, and
  `serialize_network` / `rebuild_network` (a diffable JSON round-trip).
- **Live mixing & content:** `create_transition`, `create_live_source`,
  `create_layer_stack`, `create_media_bin`, `create_keyer`, plus signature effects
  (`create_datamosh`, `create_displacement_warp`, `create_halftone`,
  `create_feedback_tunnel`, `create_text_3d`) and five new `apply_post_processing`
  effects.
- **One-shot reactivity:** `bind_audio_reactive`, `create_data_reactive`.
- **Library & packaging:** portable `.tox` bundles, checksummed recipe bundles,
  asset validation, and a local marketplace index.
- **11 new AI prompts** (fix a dead signal, recover a show mid-set, hands-free AI
  VJ, color story, setlist planner…) and a `tdmcp://prompts` catalog.
- **Use tdmcp from inside TouchDesigner** via dotsimulate's LOPs MCP Client.

### v0.4.0 — Signature 3D / GPU visuals & more creation

Fifteen tools, live-validated in TouchDesigner: `create_raymarch_scene`,
`create_particle_flock`, `create_point_cloud`, `create_pbr_scene`,
`create_cubemap_dome`, `detect_tempo`, `create_palette`, `create_led_mapper`,
`create_cue_sequencer`, `create_stage_dashboard`, `create_generative_audio`,
`scaffold_genre`, plus the `text_to_recipe` and `style_reference` prompts.
**Body & pose tracking** (MediaPipe) also landed around this time.

### v0.3.0 — The big release: reactivity, performance, 3D & AI

The largest single release — a scriptable CLI, musical reactivity, live-performance
instruments, advanced creation, a dimensional 3D/depth layer, assistant
intelligence, and robustness/export.

- **Musical reactivity:** `extract_audio_features`, `create_tempo_sync`,
  `bind_to_channel` (the link that actually wires a signal into a visual),
  `create_spectrum`, `detect_onsets`, `create_waveform`.
- **Live performance:** `manage_cue` (scenes + eased morph), `create_macro`,
  `randomize_controls`, `create_control_surface`, `create_phone_remote`,
  `create_autopilot` (beat-driven auto-VJ), `create_panic`, `create_clip_launcher`.
- **Stage I/O & sensors:** `create_motion_reactive` (the camera counterpart to
  audio), `create_multi_output` (multi-projector with soft edge-blending),
  `create_text_overlay`, `sync_external_clock`.
- **Advanced creation:** `create_3d_scene`, `create_video_player`,
  `create_layer_mixer`, `create_projection_mapping`, `create_keyframe_animation`,
  `create_simulation`, the signature effects (`create_strobe`,
  `create_kaleidoscope`, `create_glitch`, `create_kinetic_text`),
  `create_color_grade`, `create_shader_lib`, `create_video_synth`, `import_model`.
- **Dimensional (3D / depth / mapping):** `create_3d_audio_reactive`,
  `create_dome_output`, `create_mesh_warp`, `create_depth_displacement`,
  `create_gpu_particle_field`.
- **Intelligence:** `search_operators` over a 629-operator knowledge base,
  `document_network`, and AI prompts (recreate a reference image, plain-language
  tweaks, aesthetic critique, build a VJ set, fix a shader).
- **Robustness & export:** `render_output`, `record_movie`, `optimize_performance`,
  `diff_snapshots`, `manage_checkpoint`, a recipe library, `reload_bridge`, a full
  CLI, and a `doctor` diagnostic.
- **Obsidian vault integration** — bridge a folder of Markdown notes to
  TouchDesigner: recipes, setlists, shaders, presets and a dated show diary.
  *(See the caveat below — currently offline-tested.)*
- **Local LLM copilot** (`tdmcp chat`) — a browser chat driven by a local model
  (Ollama) for simple tasks, with no API key required.

### v0.3.1 — Easy install & privacy

The one-click Claude Desktop bundle (now `.mcpb`, the current Anthropic format)
and a privacy policy: tdmcp runs **entirely on your machine**, collects nothing,
and has no telemetry.

### v0.2.0 — Live control

The first step from static renders to playable instruments:
`create_control_panel`, `animate_parameter`, `manage_presets`,
`create_external_io` (OSC/MIDI in, DMX/Art-Net out, NDI/Syphon-Spout in) and
`manage_component` (save / load `.tox`). From here on, every generator arrives
with knobs.

---

## 🧪 Experimental & needs validation

These ship today and are usable, but they carry an honest caveat — they need live
tuning, specific hardware, or a final on-hardware check before they're considered
solid.

- **Obsidian vault tools** — fully unit-tested, but their live round-trip inside a
  running TouchDesigner hasn't been exercised end-to-end yet.
- **Signal-detection tools** — `detect_pitch` (reads near-zero with the default
  threshold), `detect_tempo` (BPM lock needs live tuning) and
  `create_envelope_follower` (sidechain gate/duck) all need a real source to dial
  in.
- **`learn_control`** — interactive MIDI/OSC "learn"; depends on live input state.
- **`create_pop_field`** — a first generator for TouchDesigner's GPU **POP**
  family, which is itself experimental in this build; the render path is held
  pending live validation.
- **MIDI hardware tools** — `create_midi_note_reactive` and `create_midi_map`
  preview fine from a synthetic note source, but the real device paths need a
  controller to confirm.
- **External-clock sync** — `sync_external_clock`'s tap-tempo is solid; its
  Ableton Link and MIDI-clock modes need hardware to validate (with a manual-BPM
  fallback when no source is present).
- **v0.6.0 live re-check** — the seven v0.6.0 features were each validated live in
  TouchDesigner; a full end-to-end re-check of the new HTTP routing after a bridge
  reinstall is the last pending step (acceptable per release policy).

---

## ⬜ Planned — the road to 1.0 {#planned}

With the tool set mature (~179 tools), the highest-value work has moved **up a
level** — from *making* a single visual to *running a whole show* and *connecting
to the wider TouchDesigner world*. The next steps are grouped into **four
milestones, ordered by dependency and live-show impact**. Within a milestone the
tools are largely independent and build in parallel; a few share a foundation that
comes first. Version targets are a rough sequence, **not a promise** — order can
shift. The exhaustive, item-by-item backlog (with effort and impact) lives in the
[planning archive](#full-backlog).

### Foundations first

Three pieces each unlock a whole cluster, so they're worth building *before* the
features that depend on them:

- **One shared setlist / scene schema** (plus a Timer-CHOP scheduler primitive) —
  unlocks the entire show-automation stack in Milestone 1.
- **Running LLM-backed tools through the connected agent's own model** (instead of
  a local Ollama setup) — unlocks the whole AI family in Milestone 3.
- **`auto_tag_library_asset`** — makes the library searchable by default and feeds
  search, lineage and linting across the library track.

### Milestone 1 — Run a whole show · ~v0.7.0

*The single biggest gap: tdmcp can build and trigger scenes, but nothing yet drives
an arranged set across time. Close that, plus the live-safety basics.*

- **Show automation** — build the shared scene schema first, then in parallel:
  **`setlist_runner`** (headless show driver), **`create_scene_timeline`** (in-TD
  bar-timed arranger), and **`scene_scheduler`** (wall-clock, for unattended
  installations). **`compose_cue_list`** (words → a fireable cue sequence) starts
  here and gets smarter in Milestone 3.
- **Content for the auto-VJ** *(independent → parallel)* — **`create_auto_montage`**
  (beat-quantized cutting across sources — what the hands-free AI-VJ director has
  nothing to drive today), **`create_euclidean_sequencer`** (algorithmic rhythm),
  **`create_preset_morph`** (a true N-way mood blend).
- **Ship-it-now safety win** — **`tdmcp panic` / `blackout`**, a one-word verb you
  can type under pressure.
- **Library keystone** — **`auto_tag_library_asset`** (one of the foundations
  above).

### Milestone 2 — Plug into the ecosystem & the iconic looks · ~v0.8.0

*A wide, mostly independent content wave — ideal to build side by side.*

- **Ecosystem importers** *(share the GLSL-TOP mapping layer → build together)* —
  **`import_shadertoy`** (the largest shader corpus on earth, translated on demand)
  and **`import_isf_shader`** (the cross-VJ ISF standard, with an auto-generated
  control panel).
- **External inputs** — **`setup_tdableton`** (react to the whole Ableton set, not
  just the Link clock) and **HTTP / WebSocket data sources** for web APIs and local
  AI image servers.
- **The signature looks** *(all independent → parallel)* — **`create_fluid_sim`**
  (real 2D ink/dye/smoke), **`image_to_particles`**, **`create_dither`** (1-bit
  retro), **`create_jfa_voronoi`** (stained-glass), **`create_npr_filter`**
  (oil/pencil), **`create_flow_abstraction`** (painterly), and a **color-finish
  suite** (LUTs + color wheels/curves + video scopes).
- **Rehearsal & deeper reactivity** — **`create_chop_recorder`** (record / loop /
  replay any reactive signal), plus chroma / percussive-vs-tonal / song-structure
  reactivity as it's tuned.

### Milestone 3 — Smarter assistance & a library you can trust · ~v0.9.0

*Gated on two foundations above (connected-model access + auto-tagging). Build the
connected-model bridge first, then the rest in parallel.*

- **AI tools** — **`caption_top`** ("is it alive? why is it black?"),
  **`score_build`** (a build scorecard), a **moodboard → full-system** pipeline, and
  the `compose_cue_list` deepening carried from Milestone 1.
- **"Do it my way"** — **`recall_similar_work`** (RAG over your own vault) and
  **personal style memory** that persists across sessions.
- **Trust & publish** — **`lint_recipe_library`** (catch a bad operator before the
  venue), **provenance + checksums** (safe USB / venue handoff),
  **`export_look_tox`** ("your look in a box"), **`export_sop_to_svg`** for
  plotters/lasers, and a pack of canonical generative-art *technique* recipes.

### Milestone 4 — Deeper authoring & operator DX · ~v0.10.0

*Unwrap the last big TouchDesigner authoring surfaces and finish the operator /
install story.*

- **Authoring** — **`create_glsl_material`** (3D surface shading),
  **`build_chop_chain`** (composable CHOP DSP), **`control_timeline_transport`**
  (play / seek + the "paused timeline looks dead" self-diagnosis),
  **`swap_operator`** (change a type, keep the wires), and **MediaPipe face / hand /
  segmentation** on the in-tree tracking engine.
- **Developer & live-operator DX** — finish the **easy-install** story (a
  client-config writer + a `doctor --fix` that performs safe repairs),
  **`live_dashboard_tui`** (front-of-house HUD, even over SSH),
  **`create_test_pattern`** (projector calibration), and a
  **`tutorial_companion_pack`** for teaching or selling a build.

### Later / deferred

The P2 long tail (the full list is in the [planning archive](#full-backlog)) plus
anything that needs hardware, a specific GPU/OS, a paid license, or a hosted
server — see **Out of scope** just below.

---

## Out of scope (for now)

Being honest about the edges. These need hardware, a specific GPU/OS, a paid
license, or cut against tdmcp's local-first design — so they're parked until they
can be validated properly:

- **GPU / CUDA-bound:** real-time AI generation (StreamDiffusion / ComfyUI /
  DepthAnything) is kept only as a way to *drive an already-installed* component
  or as a cloud option — never bundled. GPU fluid and optical-flow particles can't
  be validated on the current macOS dev machine.
- **Hardware-bound:** depth cameras (Kinect / Azure / RealSense), SMPTE/LTC
  timecode genlock, and laser (ILDA) output. Where possible we prefer the lighter,
  camera-only paths (MediaPipe, optical flow).
- **Multi-machine / multi-instance:** managing several TouchDesigner processes and
  cross-machine genlock — parked until there's hardware to test against.
- **Paid TouchDesigner license:** the Engine COMP / TouchEngine headless path.
- **A hosted marketplace:** sharing stays **local-first** — TouchDesigner's
  Palette plus an Obsidian vault — matching tdmcp's no-server, runs-on-your-machine
  design.

## v1.0.0 — Consolidation

Before 1.0: stabilize the tool API, round out the docs and per-feature guides,
raise test coverage, expand the recipe library, and harden the bridge.

---

<<<<<<< HEAD
## Phase 7 — v0.3.0 · Stage I/O & sensor reactivity ☑ shipped

Features resume after the 1.0 stabilization milestone. The completed phases make
a system *play*; this phase makes it survive a real venue: get the signal **out**
to the rig, spread it across **multiple projectors**, react to the **camera** (not
just audio), lock to the **DJ's clock**, and keep running **hands-free**. It stays
clear of the parallel tracks — nothing here touches the Obsidian vault (markdown
knowledge) or the local-LLM copilot (`tdmcp chat`).

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| Video **output** | ~~`ndi_out` / `syphon_out` / `spout_out`~~ — **already shipped**: `setup_output` covers `ndi` / `syphon_spout` / `window` / `record` / `touch_out`. (A `video_device_out` for SDI/capture-card hardware is the only gap; deferred as niche.) | — | ☑ |
| `create_motion_reactive` (L1) | Camera/video-in → frame-to-frame **motion** energy + **brightness** on a Null CHOP, with a Sensitivity knob — the **camera** counterpart to `extract_audio_features`, ready for `bind_to_channel`. A Cache TOP holds the previous frame, a Difference + Analyze reduce it, and an Execute DAT keeps the chain live. (Optical flow is unsupported on macOS, so direction isn't exposed.) | L | ☑ |
| `sync_external_clock` (L1) | Drive the project's **global tempo** (`op('/').time.tempo`) from a Bpm knob + a Tap pulse (beat-match the DJ by ear), so every Beat CHOP — `create_tempo_sync`, `create_autopilot` — follows. Complements `create_tempo_sync` (validated live). A dedicated **MIDI-clock / Ableton-Link** sync is a noted follow-up (needs hardware to validate) | M | ☑ |
| `create_multi_output` (L1) | Fan a master TOP across N projectors/displays — a cropped horizontal/vertical slice per output (resized to full projector res, ended on a Null), with optional borderless Window COMPs offset across the desktop. An `overlap` adds **edge-blending**: tiles widen into their neighbours and a GLSL feather fades the shared seams for soft-edge projector blending. Builds on `setup_output` (validated live, feather included) | L | ☑ |
| `create_text_overlay` (L1) | A styled **Text TOP** (font size / hex color / h+v alignment) composited 'over' a source through a Composite TOP, or standalone on a transparent background — lyrics, titles, credits. Distinct from the vault's `bind_vault_text` (which data-syncs a Text *DAT* to a note); this is a finished visual layer (validated live) | M | ☑ |
| `create_autopilot` (L1) | A beat-driven **auto-VJ**: a Beat CHOP + CHOP Execute DAT that every N beats randomizes a target COMP's controls (by `amount`) or cycles its stored cues, for hands-free improvisation, with live Active/Beats/Amount knobs (reuses the tempo clock + `randomize_controls` + `manage_cue`). A live runtime engine, unlike the vault's static `import_setlist` build (validated live) | M | ☑ |

**Why these, why now:** they reuse primitives already shipped — `create_external_io`
gains output kinds, `create_motion_reactive` mirrors `extract_audio_features` and
plugs into `bind_to_channel`, `sync_external_clock` feeds the existing Beat CHOP,
`create_autopilot` orchestrates `manage_cue`/`randomize_controls` on the beat event.
No new bridge endpoints expected (Execute-DAT + `buildPayloadScript` patterns suffice).

**Probe-first risks (validate live before committing to the API):**

- **Syphon/Spout/NDI out** are platform- and license-dependent operators — confirm
  the TOP types exist in this build (`syphonspoutoutTOP`, `ndioutTOP`, `videodeviceoutTOP`)
  before shaping the schema; gate per-OS like the existing input kinds.
- **External MIDI clock → tempo**: verify whether tempo can be driven from a MIDI
  Beat/clock signal in this build, or whether tap-tempo (timed pulses → BPM) is the
  reliable path. (Earlier probing already established there is **no Tempo CHOP** — the
  Beat CHOP is the clock — so this likely drives the Beat CHOP's BPM via a small
  Execute/CHOP-Execute DAT.)
- **Camera capture** can hang TD on a macOS permission modal (known gotcha) — default
  `create_motion_reactive` to a movie/file or synthetic source for zero-permission
  testing, exactly as `extract_audio_features` offers an oscillator source.

**Candidate CLI:** `io --params '{"kind":"ndi_out",…}'` (existing command, new kind),
`motion-reactive`, `clock-sync`, `multi-output`, `text`, `autopilot`.

---

## Phases 8–11 — v0.3.0 · Effects, reactivity, control & AI ◐ integrated (live-validation pending)

Built as parallel waves (one subagent per feature — new files + offline `msw` unit tests only, no
registry edits — then integrated single-writer) alongside Phase 7. Each ships as a new tool + CLI
command + unit tests, all green offline (104 unit tests). **Live TD validation + per-feature tuning
is the remaining step** (each build flagged its own ⚠ live-tuning unknown), following the
repo's parallel feature-build workflow.

### Phase 8 — Signature VJ effects ⭐
| Feature | Delivers | CLI | Status |
|---|---|---|---|
| `create_strobe` | Beat-syncable strobe/flash (square LFO → brightness expression) | `strobe` | ◐ |
| `create_kaleidoscope` | N-fold radial mirror (self-contained GLSL polar-fold) | `kaleidoscope` | ◐ |
| `create_glitch` | RGB-shift (GLSL) + noise displacement, non-device default | `glitch` | ◐ |
| `create_kinetic_text` | Animated / beat-flashed lyric typography (flash/pulse/slide) | `kinetictext` | ◐ |

### Phase 9 — Deeper musical reactivity ⭐
| Feature | Delivers | CLI | Status |
|---|---|---|---|
| `create_spectrum` | N-band FFT (Audio Spectrum CHOP → resample → per-band Null) | `spectrum` | ◐ |
| `detect_onsets` | kick/snare/hat transients (RMS → moving baseline → threshold) + `onset` events | `onsets` | ◐ |
| `create_waveform` | Time-domain oscilloscope (trail → CHOP-to-TOP) | `waveform` | ◐ |

### Phase 10 — Creation & content
| Feature | Delivers | CLI | Status |
|---|---|---|---|
| `create_color_grade` | Lift/gamma/gain + saturation/hue + optional LUT | `colorgrade` | ◐ |
| `import_model` | 3D model file → Geo/Camera/Light/Render (primitive fallback) | `model` | ◐ |
| `create_shader_lib` | Curated GLSL pack (tunnel/raymarch/fractal/metaballs/plasma) | `shaderlib` | ◐ |
| `create_video_synth` | Analog-synth lissajous/interference/scanline patterns | `videosynth` | ◐ |
| `create_depth_silhouette` | Silhouette/body mask from depth/video (device-free default) | `silhouette` | ◐ |

### Phase 11 — Live control, AI & DX
| Feature | Delivers | CLI | Status |
|---|---|---|---|
| `create_panic` | Instant Blackout + Freeze safety control | `panic` | ◐ |
| `create_clip_launcher` | Ableton-style cue-trigger button grid (reuses `manage_cue`) | `launcher` | ◐ |
| `text_to_shader` / `audio_to_show` / `auto_fix` | AI prompts: author GLSL, plan a set, repair loop | — | ◐ |
| `tdmcp doctor` | Environment diagnostic (bridge / LLM / vault / config) | `doctor` | ◐ |

### Wave 6 — refinements + the deferred tracks ◐ integrated (two experimental)

| Feature | Delivers | CLI | Status |
|---|---|---|---|
| `create_waveform` refine | Real scope LINE (CHOP-to-SOP → Geo → ortho Render TOP); ⚠ vertical deflection (SOP `P(1)` attribute mapping) needs live tuning | `waveform` | ◐ |
| `create_kinetic_text` refine | Flash modulates alpha (text vanishes, not black) | `kinetictext` | ☑ |
| `create_external_io` outputs | `rtmp_out` (Video Stream Out) + `artnet_out` (DMX Out CHOP → Art-Net/sACN) | `io` | ◐ |
| `bind_to_channel` smoothing | attack/release/smooth Lag-CHOP envelope follow | `bind` | ◐ |
| `manage_cue` quantize | recall/morph snapped to the next beat/bar | `cue` | ◐ |
| `create_decks` | A/B decks + master crossfader + per-deck gain | `decks` | ◐ |
| `detect_pitch` | FFT-argmax monophonic pitch (Hz/note) — **experimental**: reads 0 with the default threshold, needs live tuning | `pitch` | ◐ |
| `learn_control` | MIDI/OSC snapshot→diff→bind — **experimental** (live-stateful) | `learn` | ◐ |

**Still deferred:** dedicated MIDI-clock / Ableton-Link tempo sync (needs hardware); full live
tuning of `detect_pitch` (threshold/argmax) and `learn_control` (noise-reject diff); and
`create_waveform`'s amplitude→Y deflection (the SOP attribute-scope detail).

---

## Phase 12 — v0.3.0 · Dimensional: 3D, depth & spatial mapping ☑ shipped

Takes visuals **off the flat plane**: react in 3D, sculpt with depth, and map onto real-world
surfaces — the terrain of installations and dimensional VJ work. Today 3D is only basic
(`create_3d_scene`, `import_model`) and mapping is flat (`projection_mapping` corner-pin,
`create_multi_output` tiling). This phase builds on mechanisms already validated live this cycle —
GPU **instancing** (`create_3d_scene`), **GLSL TOP** masks (the `create_multi_output` edge-blend),
and per-point attribute displacement (`pscale`). It stays clear of the parallel waves (8–11) and the
vault track — nothing here overlaps their 2D effects / audio / creation tools (`import_model` loads
a model; `create_depth_silhouette` makes a flat mask — both distinct from the 3D geometry below).

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| `create_3d_audio_reactive` (L1) | A 3D scene that reacts to sound: `instanced_bars` — a row of boxes/spheres whose **per-bar height** tracks the FFT (one CHOP sample per bar drives `instancesy`), a 3D spectrum bar-graph — or `bass_pulse`, a single primitive that swells with RMS energy. The 3D counterpart to `create_audio_reactive` | M | ☑ |
| `create_dome_output` (L1) | GLSL-remap a source to **fisheye / equirectangular** for planetarium domes / 360 — the curved single-output complement to `create_multi_output`'s flat tiling | M | ☑ |
| `create_mesh_warp` (L1) | Map a source onto a **curved surface** via a deformable textured grid — a Point-SOP Z deform (bulge / wave / cylinder) of a `gridSOP`, textured through a Constant MAT, beyond the flat corner-pin. Output for `setup_output` | L | ☑ |
| `create_depth_displacement` (L1) | Push a plane into 3D by a **depth / luminance map** (camera / video / synthetic) via a **GLSL MAT** vertex stage — real 2.5D relief geometry. Distinct from `create_depth_silhouette` (a flat mask). Includes the cold-cook keep-alive | M | ☑ |
| `create_gpu_particle_field` (L1) | A high-count **GPU particle field** (side² up to 512²) — position/velocity **feedback-TOP** loops (curl-noise / gravity) feeding **TOP-instancing**, flowing as curl-noise streams. Beyond the CPU `create_particle_system` | L | ☑ |

**Live-validation findings** (built create → verify → preview against TouchDesigner 2025.32820; each `*Impl` exercised end-to-end through the agent CLI against the live bridge):

- `create_3d_audio_reactive`: per-bar height needs a **CHOP instance source** (channels `tx`/`sy`), not an `instancesy` expression — a per-instance expression evaluates only once. The merge needs `align="start"` or the bins rotate. `bass_pulse` uses Analyze CHOP `function="rmspower"` (not `"rms"`, which silently falls back to a ~0 average).
- `create_dome_output`: GLSL fisheye/equirect remap of an existing (ideally equirectangular) source renders a valid dome master; a true cube-map render is the higher-fidelity follow-up.
- `create_mesh_warp`: the Point SOP's `tz` is a per-point expression (`me.inputPoint`) — no `dopos` toggle exists. Camera tilted off head-on so the curvature reads in preview; `constantMAT.colormap` textures the grid.
- `create_depth_displacement`: GLSL MAT par names are `vdat`/`pdat`/`sampler0top`/`sampler0name` + the `vec` uniform sequence; named samplers must be **declared** in the shader (`uniform sampler2D sHeight;`) and `P` is `vec3`.
- `create_gpu_particle_field`: TOP-instancing maps texel `r`/`g`/`b` → XYZ and derives the count from the texture (validated), but applies translate **only** — particle size must live on the dot SOP's radius, not per-instance scale. Audio/motion reactivity is wired end-to-end: an RMS (audio) or frame-difference (motion) analysis drives the velocity shader's `uReact` uniform by expression, energising the field with the signal (validated by forcing the uniform).

**Areas:** new L1 tools `create3dAudioReactive`, `createDomeOutput`, `createMeshWarp`,
`createDepthDisplacement`, `createGpuParticleField` (each `*Impl` + `register*` + msw unit test),
registered in `src/tools/layer1/index.ts`; CLI commands `audio3d` / `dome` / `mesh-warp` /
`depth-displace` / `gpu-particles` in `src/cli/agent.ts`. Built one-subagent-per-feature
(new files + offline tests only), then single-writer wiring + live tuning. The tool registry is now
119 tools (56 Layer 1).

**Stretch / hardware- or model-blocked (won't ship unvalidated):** depth-camera input
(Kinect / RealSense / Azure) in `create_external_io`; pose / body tracking (MediaPipe / ML) →
skeleton-driven visuals; real-time AI generation (StreamDiffusion). All need a sensor, an ML
component, or GPU+models to validate live.

**macOS note:** the five core features are pure-GPU render / GLSL / file-or-camera sourced, so each
is testable on the dev machine (unlike optical flow or depth sensors, which this build/OS can't
validate).

---

## Phase 13 — v0.5.0 · Components, agent-DX & reactivity ☑ shipped

> **Released in v0.5.0** (2026-05-29). The per-row ◐ below is the historical integration
> state at build time; the release shipped these tools (any remaining live-validation
> caveats are called out inline).

**v0.4.0 shipped 2026-05-27** — fifteen new tools/prompts (raymarch & particle-flock generators,
point-cloud/PBR/cubemap-dome, tempo detection, LED/palette/cue/dashboard, generative audio, and
recipe/style prompts). Body/pose tracking (`setup_body_tracking`, `create_pose_tracking`,
`create_pose_skeleton`, `create_body_reactive`) is also already on `main` (in-tree, **not** in the
0.4.0 CHANGELOG). Phase 13 is integrated for **v0.5.0**: the thesis shifts from *generating* visuals (0.4.x already covers that,
175 tools) to **packaging, documenting and cheaply operating** them. tdmcp already ships `.tox`
save/load (`manage_component`); v0.5.0 completes the *reusable-component* story (custom parameters +
extensions) and adds the analysis + agent-DX gaps no competing TD-MCP owns.
Benchmarked against the two leaders: **`8beeeaaat/touchdesigner-mcp`** (~330★,
node-CRUD only, no component packaging) and **`dylanroscover/Embody`** (~111★, the only one with
network-as-JSON + git-diffable externalization). dotsimulate **LOPs** is orthogonal (a 60+-operator
agent runtime *inside* TD, incl. its own MCP Server + "Claude Code" operators), so TDMCP stays
**agent-side** and, for AI generation, *drives* existing `.tox`es rather than reimplementing them.
Sourced from `research/touchdesigner-insane-tutorials-2026-05.md` (BL-01…BL-22) + a focused
Embody/dotsimulate deep-dive.

**Priority:** **P0** = component reusability (custom params + extensions) + Link/MIDI · **P1** =
project intelligence + the token-cheap agent-DX primitives · **P2** = self-documentation niceties +
perform mode. Table is ordered by priority. (3D/sim/particle generators shipped in 0.4.0; body
tracking is on `main` in-tree, not in the 0.4.0 CHANGELOG.)

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| ~~`export_component` / `import_component`~~ — **already shipped** | `.tox` `save` / `loadTox` / live-linked `externaltox` already exist as **`manage_component`** (BL-01 was a false gap). Remaining gap: a self-contained, dependency-collected portable bundle — note `saveExternalTox` only externalizes to a folder tree, not a single portable `.tox` (→ v0.6.0 `make_portable_tox`) | — | ☑ |
| `scaffold_extension` | Extension DAT stub + Extension Object + Promote flag + re-init — make a COMP scriptable (BL-03) | M | ◐ |
| `add_custom_parameters` | Declarative custom-parameter pages (`appendCustomPage`/`appendFloat…`), TDJSON in/out — expose knobs (BL-03) | M | ◐ |
| `sync_external_clock` + Link/MIDI | Add `ableton_link` + `midi_clock` modes alongside tap-tempo — lock to the DJ's clock (BL-08); Link/MIDI device paths still need live hardware validation | S | ◐ ⚠ |
| Body tracking ✅ on `main` (in-tree) | `setup_body_tracking` / `create_pose_tracking` / `create_pose_skeleton` / `create_body_reactive` (+ recipes `mediapipe_body_dots`, `pose_skeleton_mediapipe`) are in-tree on `main` (not in the 0.4.0 CHANGELOG). Remaining (incremental): hand/face modes, more reactive templates, live webcam validation (BL-02) | — | ☑ |
| `analyze_project` | Unused/dead ops, broken file deps, orphan COMPs, dependency graph via `findChildren`/connectors (BL-04) | M | ◐ |
| `generate_readme` | Markdown project doc: params table (TDJSON), I/O, child inventory, deps, preview thumbnail (BL-04) | M | ◐ |
| `analyze_screenshot` | Prompt+tool: `get_preview` image + topology + `get_td_node_errors` → explain/diagnose ("why is it black?") (BL-09) | M | ◐ |
| `edit_dat_content` | Surgical `old_string`/`new_string` DAT edit (unique-match + opt-in `replace_all`) — token-cheap edits *(Embody-mined)* | S | ◐ |
| `set_dat_content` (anti-wipe) | Safe whole-DAT write with a `confirm_wipe` guardrail (refuses silent clears) *(Embody-mined)* | S | ◐ |
| `batch_operations` | Many create/connect/set-param in one bridge round-trip, fail-forward with per-item warnings — expose the Layer-1 builder as a primitive *(Embody-mined)* | M | ◐ |
| `snapshot_td_graph` compact mode | Token-optimized TDN-style read (type-default hoisting, expr/bind shorthand, inline short arrays) — Embody's `read_tdn` is ~20–90× cheaper than op-walks *(Embody-mined)* | M | ◐ |
| `manage_annotation` + enclosed ops | Agents add network boxes/comments + query ops enclosed by a box → self-documenting networks *(Embody-mined)* | S | ◐ |
| `write_agent_guide` | Emit a project-local `CLAUDE.md`/`AGENTS.md` seeded with TDMCP operator conventions + render-coordinate rules *(Embody-mined)* | S | ◐ |
| `set_perform_mode` | Advisory live-show flag; built-in guard suppresses preview captures, and future tools can opt in before expensive work — VJ-critical *(Embody-mined)* | M | ◐ |

**Body tracking — on `main` (in-tree; not in the 0.4.0 CHANGELOG):** `setup_body_tracking`, `create_pose_tracking`,
`create_pose_skeleton`, `create_body_reactive` are registered in `src/tools/layer1/`, with recipes
`mediapipe_body_dots` and `pose_skeleton_mediapipe`. Remaining Phase-13 work on this track is
incremental: hand/face modes, more reactive templates, and live webcam validation
(create→verify→preview + post-cook error check).

**Areas:** new L2/L3 tools (`scaffoldExtension`, `addCustomParameters` — the reusable-component
complement to the existing `manageComponent`; `analyzeProject`, `generateReadme`, `editDatContent`, `setDatContent`,
`batchOperations`, `manageAnnotation`, `writeAgentGuide`), extended `syncExternalClock`
(Link/MIDI), extended `snapshotTdGraph` (compact mode), `analyze_screenshot` as a prompt+tool,
plus 1:1 CLI commands. Bridge work uses the existing `buildPayloadScript`/`parsePythonReport`
pattern — the TD Python API is fully documented (tox: `COMP.save`/`saveExternalTox`/`loadTox`/
`saveByteArray`; extensions: `mod('X').X(me)` + Promote; params: `appendCustomPage`; analysis:
`findChildren`/`inputConnectors`/`outputConnectors`; serialization: TDJSON). No new REST endpoints
expected. Reuse the vault's path-traversal-safe IO for all `.tox`/file writes.

**Deferred to v0.6.0+:** `control_diffusion` / `drive_streamdiffusion` + `connect_comfyui` (drive an
*installed* StreamDiffusionTD/ComfyUI `.tox`; need GPU/CUDA to live-validate — probe-first),
`serialize_network` / `rebuild_network` + `make_portable_tox` (git-diffable JSON round-trip),
TD process lifecycle + multi-instance routing (`manage_td_process` / `switch_instance`),
`run_bridge_tests`, `get_bridge_logs`, `register_custom_tool` (artist-defined tools, LOPs' Tool-DAT
idea agent-side), `caption_top`, depth-camera input (Kinect Azure / RealSense, hardware-gated),
`create_pose_reactive`, and the remaining advanced generators. Note 0.4.0 already shipped
`create_raymarch_scene` (SDF), `create_particle_flock` (boids) and `create_point_cloud`; still open: `create_gpu_fluid`, `create_optical_flow_particles`,
`create_vertex_displacement_mat`, `create_strange_attractor`, `create_pop_field`, `create_sdf_text`.
The recipe/template
**marketplace** stays v0.6.0+ (local-first via TD Palette + Obsidian vault, per the project's
local-first distribution model).

---

## Phases 14–15 — v0.5.0 · Live mixing, parameter fidelity & creative direction ☑ shipped

> **Released in v0.5.0** (2026-05-29); several items were hardened and validated live in
> **v0.6.0**. The per-row ◐ below is the historical build-time state (TD was offline during
> the build); the release shipped these tools.

The post-discovery feature wave (sourced from `_workspace/discovery/FEATURE_BACKLOG.md`, reconciled
against the Phase-13 merge so already-shipped items were treated as validation/hardening rather than
rebuilt). Built as parallel
one-tool-per-agent waves with a single-writer integrator. **TouchDesigner was offline during the
build**, so all new tools/prompts are offline-gated (typecheck + build + Biome + vitest + recipes +
bridge tests) with live create→cook→preview validation **UNVERIFIED-pending** — each TD-touching tool
ships a `probe` block that surfaces the real TD API on first live run, and is fail-forward.

| Feature | Delivers | CLI | Status |
|---|---|---|---|
| `create_transition` | A→B dissolve/luma_wipe/slide/zoom/glitch_cut over a Progress knob (subsumes `transition_designer`) | `transition` | ◐ |
| `create_live_source` | Input layer: screen-grab/NDI/Syphon-Spout/camera/stream → previewed Null | `live-source` | ◐ |
| `create_layer_stack` | N-layer compositor: per-layer blend+opacity+mute/solo + control strip | `layer-stack` | ◐ |
| `create_media_bin` | Folder-fed clip bin (Movie File In + Switch) + Index/Next/Prev/crossfade | `media-bin` | ◐ |
| `create_keyer` | Chroma/luma/rgb key + matte composite | `keyer` | ◐ |
| `bind_audio_reactive` | One-shot: auto-map a COMP's knobs to audio bands + master Reactivity | `react-audio` | ◐ |
| `create_data_reactive` | Map live data-source channels onto params (range-remapped) | `react-data` | ◐ |
| `create_envelope_follower` | Attack/release + gate/duck sidechain (experimental) | `envelope` | ◐ |
| `create_datamosh` / `create_displacement_warp` / `create_halftone` / `create_feedback_tunnel` / `create_text_3d` | Signature effects + 3D type | `datamosh`/`warp`/`halftone`/`feedback-tunnel`/`text-3d` | ◐ |
| `apply_post_processing` +5 | Chainable `halftone`/`dither`/`crt`/`mirror`/`vhs` GLSL effects | `post-fx` | ◐ |
| `create_set_navigator` / `create_beat_grid_sequencer` | QLab cue-list navigator + deterministic step grid | `set-nav`/`beat-grid` | ◐ |
| `read_parameter_modes` / `set_parameter_expression` / `disconnect_nodes` | Parameter mode/expr read+write; remove a wire | `params-modes`/`set-expr`/`disconnect` | ◐ |
| `serialize_network` / `rebuild_network` | COMP subtree ↔ diffable JSON round-trip (pulled forward from v0.6.0+) | `serialize`/`rebuild` | ◐ |
| `inspect_op_extensions_storage` / `get_node_state_runtime` / `get_bridge_logs` | Component introspection + runtime telemetry + cook logs | `inspect-comp`/`node-state`/`logs` | ◐ |
| `create_replicator` / `multipass_3d_depth` | Data-driven cloning + SSAO/synthetic-depth 3D pass | `replicator`/`multipass-3d` | ◐ |
| `create_pop_field` | First GPU POP-family generator (**experimental** — render path held pending live validation) | `pop-field` | ◐ ⚠ |
| `create_midi_note_reactive` / `create_midi_map` | MIDI notes → reactivity (synthetic previews); controller presets (**hardware-gated** — held pending gear) | `midi-notes`/`midi-map` | ◐ ⚠ |
| Vault: `save_component_to_vault` / `browse_vault_library` / `capture_to_vault` / `export_setlist_to_vault` | Component packaging, library browse, gallery capture, setlist round-trip | (MCP-only) | ◐ |
| 11 AI prompts | `fix_reactivity`, `recover_show`, `auto_vj_director`, `color_story`, `setlist_planner`, `lyric_show`, `genre_visual_language`, `visual_ab_compare`, `motion_critique`, `match_reference_loop`, `explain_param` | (prompts) | ◐ |
| `tdmcp://prompts` resource | Prompt catalog for prompt-blind clients (local copilot) | (resource) | ◐ |

**Held pending validation (⚠ — ship only with the experimental / hardware-gated caveat until they cook clean live):**
`create_pop_field` (POPs experimental + render path uncertain), and the device paths of
`create_midi_note_reactive` / `create_midi_map` (need real MIDI gear; the synthetic note source is
validatable offline).

**CLI / config / copilot DX — shipped in the follow-on pass (◐, offline-gated):**
`config_file_and_profiles` + per-call `--profile/--config/--td-host/--td-port/--timeout` flags + a
`config` command (`--write-env`); `doctor` Tools check + `--fix` (suggested commands) + `--output
json` + `-q/--quiet`; CLI `-V/--version`, did-you-mean, `--params -`/`--params-file`, `-q/--quiet`,
`watch --filter/--exclude`; copilot `search_operators`+`list_recipes` in every tier + an opt-in
`creative` generator tier; `get_td_info` bridge-staleness warning; `video_device_out`.

**Still deferred to v0.6.0+ (not built):** `install-client` per-OS config writers + `install-bridge
--verify` (need real per-client testing); `doctor --fix` auto-execution (start Ollama / pull / recopy
bridge); `watch --exec`, `preview --inline/--watch`, shell-completion generator, repl
history+completion, `chat --prompt`/`--read-only`; copilot conversation persistence / smarter handoff
/ voice; `model_import_fbx_usd`; `dmx_fixture_pipeline` (hardware), `gpu_fluid` /
`optical_flow_particles` (GPU/macOS), `richer_event_stream`, `run_bridge_tests`, and the recipe
marketplace. _(Several of these shipped in 0.6.0 — see Phase 16; the rest carry into Phase 17.)_

---

## Phase 16 — v0.6.0 · TouchDesigner-depth & library fidelity ☑ shipped {#phase-16}

**v0.6.0 shipped 2026-05-29** (GitHub `.mcpb` asset; npm caught up in **0.6.1**, 2026-05-30). The
first wave drawn from the 2026-05-29 discovery backlog (`_workspace/discovery/FEATURE_BACKLOG.md`):
**seven P0 features** that sharpen the bridge's read/write fidelity, promote the well-defined
raw-Python operations to **structured REST endpoints** that survive `TDMCP_BRIDGE_ALLOW_EXEC=0`
(the security-conscious venue config), and add two performance instruments plus a library
contact-sheet. The tool registry is now **179 tools**.

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| `get_td_node_flags` + `node_detail` fidelity | Flags (bypass/render/display/lock/allowCooking/clone), index-aware `wires_in`, and position/comment/color in one read — fixes the #1 "why is it black?" blind spot. Same fields extended into `serialize_network` (back-compatibly) | S | ☑ |
| Structured bridge endpoints | `POST /api/connect` + `/disconnect`, `GET …/params?modes=true` + `PATCH …/params/<p>/mode`, `GET`/`PUT …/text`, and `GET /api/logs` (backed by an in-bridge **Error DAT**) — connect/param-mode/DAT-text/logs now survive exec-off; `connect_nodes`/`disconnect_nodes`/`read_parameter_modes`/`set_parameter_expression`/`edit_dat_content`/`set_dat_content`/`get_bridge_logs` rewired **endpoint-first with exec-fallback** | M | ☑ |
| `cook.error` / `error.cleared` events | Edge-triggered cook-error events off the bridge frame hook (vs the old frame%120 poll) — the live-recovery signal | M | ☑ |
| `create_modulators` | BPM-synced multi-LFO bank (sine/saw/noise, master Rate/Depth) on one Null — bind `mod_out` to any parameter to make a network breathe in time | M | ☑ |
| `create_look_bank` | Snapshot + A↔B-morph instrument: capture (morph-safe), store and recall named looks with an instant snap or a quantized timed morph, plus a live A↔B blend knob | M | ☑ |
| `generate_library_index` + preview thumbnails | Markdown contact-sheet of the vault; `save_recipe_to_vault` / `save_component_to_vault` capture a sibling `<stem>.png` (capture **never throws**) | S | ☑ |
| Parameter-mode fix | `set_parameter_expression` now actually flips into Expression/Bind mode (a latent `ParMode` `NameError` had silently dropped the mode change) — verified live | S | ☑ |

**Live validation:** all seven passed QA — four PR gates green (1614 tests, 15/15 recipes, 86 bridge
tests) and each feature's bridge logic validated live in TD; the live HTTP round-trip through the new
dispatcher is pending an end-to-end re-check after a bridge reinstall (acceptable per release policy).

**v0.6.1 (2026-05-30) — release hygiene:** npm catch-up (0.6.0 was GitHub-only — the workflow skips
`npm publish` without `NPM_TOKEN`), tool count corrected to **179**, the `set_parameter_expression`
exec-fallback mode-flip fix for older bridges, a structured-endpoint regression suite, and PT cookbook
parity.

**Security (Unreleased / PR #26):** `rebuild_network` no longer `eval()`s the operator-type string
(resolves by name off `td`, guarded by `isidentifier()`); the bridge adds a loopback `Host`-header
check (closes a DNS-rebinding gap); and package downloads are GitHub-pinned, HTTPS-only and
size-capped (SSRF/oversize hardening). Plus `.safeskillignore` to focus the SafeSkill scanner.

---

## Phase 17 — v0.7.0 → v1.0.0 · Composition, automation & intelligence ◐ in progress

The forward wave is sourced from **four discovery passes**, all preserved in full in the
[Appendix](#full-backlog) (the source files live under the gitignored `_workspace/`, so they are
reproduced here to stay in version control):

- **Round-0** (2026-05-28, `discovery_20260528/` — 78 items) — the discovery that **fed v0.5.0
  (Phases 13–15)**; almost entirely shipped, open remainder carried into round-1.
- **Round-1** (2026-05-29, `discovery/FEATURE_BACKLOG.md` — 77 items) — its 7 P0s shipped in 0.6.0.
- **Round-2 "beyond the backlog"** (2026-05-30, `discovery_beyond_20260530/` — **63 net-new** items).
- **Round-3 external** (2026-05-30, `discovery_external/` — alltd.org + awesome-touchdesigner + artist
  Anya Maryina, **75 deduped ideas**) — the community-sources pass.

With the primitive set now mature (~179 tools), the durable value has moved **up a level** — from
*generating* visuals to **composing, automating and intelligently operating** a show (rounds 1–2), and
to **ingesting the wider TouchDesigner ecosystem** (round-3: Shadertoy/ISF import, the missing iconic
looks, color-finish, an artist-publishing layer). Ordered by the `live-show` weighting profile;
`probe-live` items validate in TD before the schema locks.

The round-2 backlog is being executed as a **staged wave campaign**
(`_workspace/campaign_beyond_20260530/`, gitignored): **wave 1 → v0.7.0** (live-show foundation + all
P0), then v0.8.0 (show automation + musical reactivity), v0.9.0 (intelligence + library trust), v0.10.0
(TD-depth authoring + DX accelerators), v0.11.0 (P2 tail) — each with a go/no-go checkpoint. The round-3
external items slot into the same wave structure once chosen.

### P0 — the live-thesis core (round-2)

| Feature | Surface | Delivers | Effort |
|---|---|---|---|
| `setlist_runner` | cli | Headless show driver: advance scenes by duration / beat-count / manual, firing the shipped cue + morph — **the one thing that runs an arranged set over time** | M |
| `create_auto_montage` | controls | Beat-quantized content cutting across N source TOPs (cut/dissolve/wipe, per-source weight) — the **#1 auto-VJ gap**; the instrument `auto_vj_director` has nothing to drive | M |
| `create_euclidean_sequencer` | controls | Bjorklund algorithmic-rhythm generation (K/N hits, rotation, per-step probability) — pattern *generation*, not the replay `create_beat_grid_sequencer` does | M |
| `create_preset_morph` | controls | True **N-way** weighted parameter-space blend ("live between four moods") — vs the shipped two-slot `create_look_bank` | M |
| `auto_tag_library_asset` | library | Derive tags / operator-family / difficulty / description from the captured `nodes[].type` via the KB — makes the whole library searchable **by default** (the keystone read) | M |
| `panic_blackout_hotkey` | cli | Instant top-level `tdmcp panic` / `blackout` (+ `--restore` / `--hold`), idempotent re-fire — a safety verb you can type under pressure | S |

### P1 — automation, intelligence & authoring (round-2 headliners + top still-open round-1)

| Feature | Surface | Delivers | Effort |
|---|---|---|---|
| `server_sampling_assist` | ai | Adopt MCP `sampling` so every LLM-backed tool runs through the **connected agent's model** with zero local-Ollama setup — also unblocks round-1 `caption_top` / `copilot_vision` (needs a structured/image method on `src/llm/client.ts`) | M |
| `recall_similar_work` + `style_memory` | ai | RAG over the artist's **own** vault + a persistent cross-session aesthetic profile — "do it the way I did last time" (the dotsimulate-RAG parity gap) | M |
| `create_scene_timeline` | controls | Bar-timed song-mode arranger (scene list on a Timer playhead, beat-synced crossfades) — the in-TD sibling of `setlist_runner` | M |
| `compose_cue_list` | ai | Natural language → a built, fireable cue sequence — "drive the show with words" | M |
| `live_dashboard_tui` | cli | Always-on operator HUD (FPS / drops / GPU / rolling errors / beat) over SSH at front-of-house | M |
| `scene_scheduler` | cli | Wall-clock cron-lite (`at` / `every` → command/cue/setlist) for unattended installations | M |
| `lint_recipe_library` | library | CI-grade recipe linter (operator-existence via KB + reference integrity + id-collision) — today's validation is a schema-only parse, so a bad operator type ships green and dies in TD | M |
| `create_glsl_material` + `build_chop_chain` | td-depth | Author a GLSL **MAT** (3D surface shading) and composable CHOP-DSP chains feeding any `bind_to_channel` — two unwrapped authoring surfaces | M |
| `control_timeline_transport` | td-depth | Transport read/write (play/pause/seek/rate) over `me.time` — and self-diagnoses the paused-timeline "why is it dead?" false alarm | S |
| `caption_top` | ai | _(round-1)_ Preview → plain-text description (vision endpoint + histogram fallback) — the headless "is it alive?" primitive | M |
| `install_client_writers` + `doctor_fix_autoexec` | cli | _(round-1)_ `install-client --write` deep-merges the client MCP config; `doctor --fix` *executes* safe repairs — finishes the artist-easy install story | M |
| `create_test_pattern` ✅ 0.7.0 | controls | _(round-1)_ Projector calibration/alignment generator (grid / bars / sweep / per-output #) — every show starts here | S |

### P0/P1 — external round (round-3, community sources, 2026-05-30)

Mined from **alltd.org**, **awesome-touchdesigner** and artist **Anya Maryina** (full list in
[Appendix C](#appendix-c-round3)). Reconciliation thesis: tdmcp is a strong *generator* but an *island* —
the new high-leverage field is **ecosystem ingestion** + **the missing iconic VJ looks** + an
**artist-publishing layer**. Licensing discipline is carried per item (GPL/CC-BY repos = technique-only,
Lygia not bundled, Anya never cloned; gated AI/depth kept only as drive-installed-tox / cloud / docs deltas).

| Feature | Surface | Delivers | Effort |
|---|---|---|---|
| `import_shadertoy` | integrations | Paste a Shadertoy URL/code → wired GLSL TOP (map `iTime`/`iResolution`/`iChannel`) — the largest shader corpus on earth becomes tdmcp's catalog (translate-on-demand, never store source) | M |
| `import_isf_shader` | integrations | Parse the **ISF** cross-VJ shader standard → GLSL TOP + auto custom-param page — instant access to existing VDMX/Resolume shader libraries | M |
| `create_fluid_sim` | controls | Own-GLSL 2D Navier-Stokes (ink/dye/smoke advection) — the iconic VJ fluid look tdmcp lacks (**4 sources**) | M–L |
| `image_to_particles` | controls | Any image/logo/mesh → controllable particle cloud (+ a source mode on `create_gpu_particle_field`) | M |
| Color-finish suite | controls | `apply_lut` (.cube/OCIO) + color wheels/curves on `create_color_grade` + `create_video_scopes` (waveform/vectorscope/histogram) — grade a show to spec | M |
| `setup_tdableton` | integrations | React to the Ableton *set* (clips/tracks/devices/transport over OSC), not just the Link clock — ship a synthetic-OSC fallback | M |
| `export_look_tox` | library | Extract a look into a standalone parameterized `.tox` ("your look in a box") — the artist-publishing primitive | S–M |
| `create_chop_recorder` | controls | Record/replay/loop any reactive signal (audio/pose/MIDI/OSC) — rehearse a whole show offline | M |
| `create_machine_sync` | integrations | Genlock + CHOP/DAT/TOP link across machines (Sync + Touch In/Out) — projector-wall / LED-volume output | M · probe ≥2 machines |
| MediaPipe face/hand/segmentation | controls | Finger-gesture + face + live subject-mask on the engine **already in-tree** for pose | M |
| `tutorial_companion_pack` | cli | One command → a shareable/sellable teaching bundle (.tox + annotated walkthrough + README + preview) | M |
| `swap_operator` | td-depth | Replace an op's type while keeping its wires/params — non-destructive AI iteration | S–M |
| `create_fixture_control` | controls | Moving-head pan/tilt/dimmer/gobo + 3D rig previz — **hardens the planned `create_dmx_fixture_pipeline`** | M |
| Signature-look cluster | controls | `create_dither` (1-bit retro) · `create_jfa_voronoi` (stained-glass) · `create_npr_filter` (oil/pencil) · `create_flow_abstraction` (painterly camera) | S–M ea |
| `create_data_source` HTTP/WS | integrations | HTTP-request + WebSocket modes → local AI image servers + REST/WS web APIs (folds into the planned MQTT/WebSocket fabric) | M |
| `create_interaction_zones` | controls | Camera/pose enter/exit/dwell zones fire cues — interactive installs **without** a depth-cam | M |
| `generative_classics` pack | library | Recipes recreating canonical generative-art *techniques* (controlled-disorder grid, L-system, asemic, Truchet, 10-PRINT) — credit lineage, never a named/estate artist | M |
| `export_sop_to_svg` | library | TD generative geometry → plotter/laser/print SVG (no external dependency) | M |

**Pipeline-ready 10** (dev-box-validatable, no hardware/Ableton gate): `import_shadertoy`,
`import_isf_shader`, `create_fluid_sim`, `image_to_particles`, `apply_lut` + color-wheels/curves,
`create_video_scopes`, `create_dither`, `create_jfa_voronoi`, `swap_operator`, `export_look_tox`.
**Recommended deepening:** alltd.org returned HTTP 403 to direct fetch, so its items are summary-level —
re-fetch alltd-only P1s (`create_machine_sync`, `clip_sequencer`, `auto_ui`, `create_fixture_control`) via
a browser before the schema locks; cross-corroborated items (fluid, color-finish, fixtures, laser, palette)
are already safe.

### Cross-cutting prerequisites & themes

- **Time-based show-automation stack** — build on **one shared setlist/scene schema** (also shared
  with the vault `import_setlist`/`export_setlist_to_vault`): `create_scheduler` (td-depth Timer-CHOP
  primitive) → `create_scene_timeline` (controls, in-TD) ∥ `setlist_runner` (cli, headless) ∥
  `compose_cue_list` (ai, NL authoring). The single biggest unbuilt live-thesis lever.
- **`server_sampling_assist` + a structured/image method on `src/llm/client.ts`** — the shared
  prerequisite for `compose_cue_list`, `score_build`, `moodboard_to_system`, `reference_to_plan` and
  round-1's `caption_top`/`copilot_vision`; the one platform move that unblocks the whole AI-tool family.
- **The "do it my way" cluster** — `recall_similar_work` ⇄ `style_memory` ⇄ `learn_from_my_corpus`
  ⇄ `learn_conventions` over one `Memory/` vault note schema (ai owns the intelligence, library owns
  the folder convention).
- **Library trust foundation** — `provenance_stamp` (author/license/origin) + `checksum_and_verify_pack`
  (SHA-256 verify-on-install), both S, for USB/venue handoff.

### Still deferred (GPU / macOS / hardware / multi-instance-gated)

`create_gpu_fluid`, `create_optical_flow_particles` (GPU/macOS), `create_sdf_text`,
`create_strange_attractor`, `create_vertex_displacement_mat` (signature generators), hand/face
MediaPipe modes + `create_pose_reactive` (need a live webcam + ML), `manage_td_process` /
`switch_instance` (multi-TD lifecycle), StreamDiffusion / ComfyUI drivers (GPU/CUDA),
`sync_timecode` hardware genlock, and the recipe/template **marketplace** (stays local-first via
TD Palette + Obsidian vault, per the project's distribution model).

> **Scope note.** The P0/P1 tables above are the **curated forward plan**. The **complete backlog** —
> every candidate from all four discovery passes (round-0 → round-3) with impact / confidence / novelty /
> probe / source flags — is preserved in full in the [Appendix](#full-backlog) below. The source files live
> under the **gitignored `_workspace/`**, so they are reproduced here to stay in version control. Pick
> items and hand them to the `tdmcp-pipeline` build harness.

---

## Appendix — Full discovery backlog {#full-backlog}

Reproduced from the four discovery runs (round-0 2026-05-28 → round-3 2026-05-30) so the complete
catalog survives in git (`_workspace/` is gitignored — the source files would otherwise be lost).
**Legend:** Priority **P0/P1/P2** · Effort **S** ≤1 day / **M** 2–4 days / **L** ~1 week ·
Impact/Conf High/Med/Low · Novelty **NEW** / **EXTENSION** / **ROADMAP** · Status **✅ v0.5.0** /
**✅ 0.6.0** = shipped since that run · **✅ 0.7.0** = shipped in the Phase-17 backlog-campaign waves
(artist controls + library/packaging, live-validated in TD) · **◐ 0.7.0** = built + integrated, live
validation pending · `gated` = GPU/hardware/CUDA/license-deferred. Round-3 rows carry
a **Source** (the external repo/site/artist) instead of a probe column, since attribution is the point of
an external round; `probe-live` notes are inline where they apply.

### 0 · Round-0 — 2026-05-28 (harvested into v0.5.0)

Source: `_workspace/discovery_20260528/FEATURE_BACKLOG.md`. **78 distinct features** (93 raw; controls
23 · CLI 22 · AI 26 · td-depth 22) — the discovery that **fed v0.5.0 (Phases 13–15)**. Almost the entire
backlog shipped (round-1 below confirms "Phases 13–15 / v0.5.0 harvested almost the entire 2026-05-28
backlog"), so its open remainder is carried transitively into round-1; recorded here for a complete git
lineage rather than reproduced row-by-row. Its **Top-12 recommended-next — all ✅ shipped in v0.5.0/0.6.0:**
`batch_operations`, `bind_audio_reactive`, `create_transition`, `fix_reactivity` (prompt),
`create_live_source`, `read_parameter_modes`, `recover_show` (prompt), `create_layer_stack`,
`auto_vj_director` (prompt), `snapshot_td_graph` compact mode, `create_media_bin`, `set_perform_mode`.
Just-missed tier (`create_keyer`, `edit_dat_content`/`set_dat_content`, `config_file_and_profiles`,
`set_parameter_expression`, `create_datamosh`/`create_displacement_warp`) also shipped; only
`wrap_pop_family` (90 unreached GPU POP operators, L) remains open — tracked as round-1 `create_pop_geometry`
and round-3 `create_pop_fluid`.

### A · Round-1 backlog — 2026-05-29

Source: `_workspace/discovery/FEATURE_BACKLOG.md`. **77 candidates** (7 P0 · 38 P1 · 32 P2; 36 NEW ·
31 EXTENSION · 10 ROADMAP). The 7 P0s + the two control instruments + the library thumbnail/index
work shipped in **v0.6.0** (marked ✅).
=======
## Planning archive — the full idea backlog {#full-backlog}

> **What this is.** Everything below is the raw, unfiltered output of several
> brainstorming passes over the project — a *catalog of ideas to choose from*, not
> a list of promises. Most of it will never ship as written; it's kept here in the
> open for transparency and so the project's thinking stays on the record. The
> curated, prioritized plan is the [Planned](#planned) section above — **that's**
> what's actually being built. Skim this only if you're curious about the long
> tail.
>
> **Legend:** Priority **P0 / P1 / P2** · Effort **S** ≤1 day / **M** 2–4 days /
> **L** ~1 week · Impact & Confidence High / Med / Low · Novelty **NEW** /
> **EXTENSION** (extends an existing tool) / **ROADMAP** (already on the plan).
> A ✅ marks an idea that has since shipped. `gated` = deferred for
> GPU / hardware / CUDA / license reasons.

These four passes are labelled in the order they happened (Round 0 → Round 3).

### Round 0 — 2026-05-28 (harvested into v0.5.0)

**78 distinct features** (93 raw; controls 23 · CLI 22 · AI 26 · TD-depth 22) — the
discovery that **fed v0.5.0 (Phases 13–15)**. Almost the entire backlog shipped
(Round 1 below confirms "Phases 13–15 / v0.5.0 harvested almost the entire
2026-05-28 backlog"), so its open remainder is carried transitively into Round 1;
it's recorded here for a complete lineage rather than reproduced row-by-row. Its
**Top-12 recommended-next — all ✅ shipped in v0.5.0 / 0.6.0:** `batch_operations`,
`bind_audio_reactive`, `create_transition`, `fix_reactivity` (prompt),
`create_live_source`, `read_parameter_modes`, `recover_show` (prompt),
`create_layer_stack`, `auto_vj_director` (prompt), `snapshot_td_graph` compact
mode, `create_media_bin`, `set_perform_mode`. The just-missed tier
(`create_keyer`, `edit_dat_content` / `set_dat_content`, config files + profiles,
`set_parameter_expression`, `create_datamosh` / `create_displacement_warp`) also
shipped; only `wrap_pop_family` (90 unreached GPU POP operators, L) remains open —
tracked as Round-1 `create_pop_geometry` and Round-3 `create_pop_fluid`.

### Round 1 — 2026-05-29

**77 candidates** (7 P0 · 38 P1 · 32 P2; 36 NEW · 31 EXTENSION · 10 ROADMAP). The
7 P0s plus the two control instruments and the library thumbnail/index work shipped
in **v0.6.0** (marked ✅).
>>>>>>> origin/main

#### A.1 · Artist controls & creative tools

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `create_modulators` ✅ 0.6.0 | BPM-synced multi-LFO modulation bank `bind_to_channel` can target | M | High | High | P0 | NEW | phase-lock + paused-timeline |
| `create_look_bank` ✅ 0.6.0 | Snapshot-slot + A↔B morph instrument | M | High | Med | P0 | EXTENSION | animatable-par filter |
| `create_test_pattern` ✅ 0.7.0 | Projector calibration generator (grid/bars/sweep/per-output #) | S | Med | High | P1 | NEW | none |
| `create_text_crawl` ✅ 0.7.0 | Multi-line crawl/ticker/typewriter text | M | Med | High | P1 | NEW | typewriter substring expr |
| `create_band_router` ✅ 0.7.0 | Musician-friendly EQ-band → multi-target routing | M | Med | High | P1 | EXTENSION | Analyze `rmspower` not `rms` |
| `create_decks` N-channel | 3–4 decks + transition cut + per-deck FX send | M | Med | High | P1 | EXTENSION | none |
| `create_sidechain_pump` ✅ 0.7.0 | One-call "pump the rig on the kick" | S | Med | Med | P1 | EXTENSION | gate threshold tuning |
| `create_xy_pad` ✅ 0.7.0 | 2D/XYZ control widget on panel + phone remote | M | Med | Med | P1 | EXTENSION | `appendXY` + phone 2D-drag |
| `create_time_echo` ✅ 0.7.0 | Per-pixel time-displacement / slit-scan trails | M | Med | Med | P1 | NEW | buffer fill + displace par names |
| `create_blob_reactive` ◐ 0.7.0 | Camera object/hand position tracking (vs aggregate motion) | M | Med | Med | P2 | NEW | camera permission hang + tune |
| `create_capture_loop` ✅ 0.7.0 | Bidirectional Spout/Syphon/NDI bridge (in+out, one tool) | M | Med | Med | P2 | EXTENSION | platform-gated; no feedback-storm |
| `create_vector_lines` ✅ 0.7.0 | Image → animated line-art / contour / plotter look | L | Med | Med | P2 | NEW | trace cook cost on live video |
| `create_pop_geometry` | POP-family generative GPU geometry | L | Med | Low | P2 | EXTENSION | probe-live (render path) |

#### A.2 · Library, packaging & distribution

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `recipe_preview_thumbnail` ✅ 0.6.0 | Capture a preview PNG into every saved recipe/component note | S | High | High | P0 | EXTENSION | none |
| `generate_library_index` ✅ 0.6.0 | One Markdown contact-sheet index of the vault | S | Med | High | P1 | NEW | none |
| `bundle_dependencies` | Make `make_portable_tox` actually self-contained | M | High | Med | P1 | EXTENSION | file-par enum + path-rewrite |
| `publish_recipe_bundle` | Checksummed/versioned publish artifact | M | Med | High | P1 | NEW | none |
| `export_externalized_tree` | `save_external` → git-diffable `.tox` tree | S | Med | High | P1 | EXTENSION | tree shape on first run |
| `diff_library_assets` ✅ 0.7.0 | Offline diff of two saved recipes/specs | M | Med | High | P1 | EXTENSION | none |
| `version_library_asset` | Semver + changelog + retained-prior on save tools | M | Med | High | P1 | EXTENSION | none |
| `tag_and_search_library` | Faceted browse over recipe metadata | M | Med | High | P1 | EXTENSION | none |
| `project_documentation_site` ✅ 0.7.0 | Compose readme + Mermaid + thumbnails into a handoff doc | M | Med | High | P2 | EXTENSION | none |
| `component_readme_in_package` | Auto-write a params/IO doc into the portable-tox package | S | Med | High | P2 | EXTENSION | none |
| `expand_recipe_library` | First-party recipes for the new generators | M | Med | High | P2 | NEW (content) | live cook-check each |
| `import_recipe_from_url` ✅ 0.7.0 | Fetch + validate + import a recipe pack from a URL | S | Med | Med | P2 | NEW | path-escape guards; size cap |
| `collect_project_assets` ✅ 0.7.0 | Project-wide "gather everything" staging folder + manifest | M | Med | Med | P2 | NEW | file-par enum; size cap |
| `recipe_from_live_network` | Faithful round-trip recipe capture via `serialize_network` | M | Med | Med | P2 | EXTENSION | GLSL-uniform round-trip |
| `export_palette_component` ✅ 0.7.0 | Export `.tox` into TD's native Palette folder | M | Med | Low | P2 | NEW | probe-live (Palette layout) |

#### A.3 · CLI & developer DX

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `install_client_writers` | `install-client --write` deep-merges + verifies the config | M | High | High | P1 | ROADMAP | per-client config paths |
| `doctor_fix_autoexec` | `doctor --fix` executes safe repairs | M | High | High | P1 | ROADMAP | none |
| `watch_exec_hook` | `watch --on beat --exec '<cmd>'` reactive engine | M | Med | High | P1 | ROADMAP | event-storm debounce |
| `config_init_scaffolder` | `tdmcp config init` writes a commented `tdmcp.json` | S | Med | High | P1 | NEW | don't clobber (refuse/`--force`) |
| `tdmcp_top_level_help` | Real `tdmcp --help` on the primary binary | S | Med | High | P1 | NEW | never intercept empty argv |
| `agent_command_index_resource` | `tdmcp-agent commands --json` + `tdmcp://commands` | S | Med | High | P1 | NEW | none |
| `install_bridge_verify` | `install-bridge --verify`/`--wait`/`--port` polls the bridge | S | Med | High | P1 | ROADMAP | none |
| `repl_history_and_completion` | Persistent history + Tab-completion in the REPL | M | Med | High | P1 | ROADMAP | none |
| `preview_inline_and_watch` | `preview --inline` (iTerm/Kitty/sixel) + `--watch` | M | Med | Med | P1 | ROADMAP | terminal-protocol detect |
| `help_grouping_and_per_command_help` | Group `usage()` by theme + `help <command>` | M | Med | High | P2 | NEW | none |
| `run_file_stdin_and_continue` | `run -` (stdin) + `--continue-on-error` | S | Med | High | P2 | EXTENSION | none |
| `show_mode_oneliner` | `tdmcp show <profile>` — load+doctor+perform+pre-flight | M | Med | Med | P2 | NEW | abort semantics |
| `output_format_table_and_csv` | `--output table`/`csv` for list results | S | Low | High | P2 | EXTENSION | none |
| `error_exit_code_taxonomy` | Distinct exit codes (offline/TD-error/config) | S | Low | Med | P2 | NEW | error subclass survives |
| `no_color_flag_is_dead` | Honor parsed-but-dead `--no-color`/`NO_COLOR` | S | Low | High | P2 | NEW | none |
| `watch_pretty_and_count` | `watch --pretty` + heartbeat | S | Low | High | P2 | EXTENSION | none |
| `http_transport_oneflag_launch` | `tdmcp serve --http [--port]` | S | Low | High | P2 | NEW | keep bare `tdmcp`=stdio |
| `packages_cli_help_and_completion_parity` | Fold `packages` tree into top-level help/completion | S | Low | High | P2 | EXTENSION | none |
| `profile_list_and_show` | `tdmcp config profiles` lists saved venue profiles | S | Low | Med | P2 | NEW | small refactor |

#### A.4 · AI & LLM integration

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `caption_top` ◐ 0.7.0 | Preview → plain-text description (vision + histogram fallback) | M | High | Med | P1 | ROADMAP | probe-live (vision model) |
| `copilot_prompt_awareness` | Feed `tdmcp://prompts` into the copilot BASE_PROMPT | S | Med | High | P1 | EXTENSION | none |
| `copilot_smarter_handoff` | Auto-surface the Claude/Codex handoff on a dead-end | S | Med | High | P1 | ROADMAP | none |
| `chat_cli_flags` | `chat --read-only`/`--creative`/`--prompt` (headless) | M | Med | High | P1 | ROADMAP | chat server accepts fixed tier |
| `copilot_session_persistence` | Resume transcript + last model/tier | M | Med | High | P1 | ROADMAP | none |
| `plan_visual`→LLM-grounded | Upgrade `describe_project` to an optional LLM planner | M | Med | High | P1 | EXTENSION | none (keyword stays default) |
| `prompt_catalog_autogen` | Generate `tdmcp://prompts` from the registry | S | Med | High | P1 | NEW | none |
| `teach_touchdesigner` ✅ 0.7.0 | KB-grounded concept-tutor prompt | S | Med | High | P1 | NEW | none |
| `design_brief` ✅ 0.7.0 | Persistent session aesthetic direction | S | Med | High | P1 | NEW | none |
| `repair_network` ◐ 0.7.0 | Bounded autonomous repair tool | M | Med | Med | P2 | NEW | probe-live (bound+rollback) |
| `copilot_vision` | Image-aware local copilot | M | Med | Med | P2 | EXTENSION | probe-live (image blocks) |
| `cookbook_resource` | Expose the prompt-cookbook as `tdmcp://cookbook` | S | Med | Med | P2 | NEW | machine-readable source |
| `llm_config_knobs` | `TDMCP_LLM_TIER`/`_MAX_STEPS`/`_TEMPERATURE` keys | S | Low | High | P2 | NEW | none |
| `recipe_resource_search` | Keyword search over recipes | S | Low | High | P2 | EXTENSION | none |
| `narrate_set` | Persisted narration during `auto_vj_director` | S | Low | Med | P2 | NEW | none |

#### A.5 · TouchDesigner depth (bridge + operators)

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `node_flags_in_detail` ✅ 0.6.0 | bypass/render/display/clone/lock/allowCooking on the core read | S | High | High | P0 | EXTENSION | none |
| `connect_disconnect_endpoint` ✅ 0.6.0 | `POST /api/connect` + `/disconnect` | M | High | High | P0 | NEW | connector/disconnect semantics |
| `param_modes_rest_endpoint` ✅ 0.6.0 | Param-mode read+write as endpoints | M | High | High | P0 | EXTENSION | `ParMode`/`.expr` attr names |
| `error_dat_log_capture` ✅ 0.6.0 | Error DAT + `GET /api/logs` | M | High | High | P0 | EXTENSION | Error DAT column layout |
| `connector_order_in_detail` ✅ 0.6.0 | Index-aware wiring in the core read | S | Med | High | P1 | EXTENSION | none |
| `dat_content_rest_endpoint` ✅ 0.6.0 | `GET/PUT …/text` for DAT editing without exec | S | Med | High | P1 | EXTENSION | table-cell vs raw-text |
| `info_chop_telemetry` | Info-CHOP/DAT path in `get_node_state_runtime` | M | Med | High | P1 | EXTENSION | channel names per family |
| `createable_truth_flag` | `GET /api/optypes` ground truth → mark createable/deprecated | M | Med | Med | P1 | NEW | probe-live (enumeration) |
| `error_appeared_event` ✅ 0.6.0 | Edge-triggered `cook.error`/`error.cleared` | M | Med | Med | P1 | NEW | error-set diff + backpressure |
| `bridge_health_watchdog` | `GET /api/health` — cook-rate/dropped-frame/GPU + staleness | S | Med | Med | P1 | NEW | realtime attr names |
| `create_3d_scene_engine_comp` | Wrap the Engine COMP (sub-cook process) | M | Med | Med | P2 | NEW | probe-live (compiled tox) |
| `node_layout_in_detail` ✅ 0.6.0 | `nodeX/Y/comment/color` on the read | S | Low | High | P2 | EXTENSION | none |
| `watch_node` | Sample one op's state/param/channel over an interval | S | Low | High | P2 | NEW | none |
| `param_change_event` | Opt-in `param.changed` via a Parameter Execute DAT | M | Low | Med | P2 | NEW | onValueChange freq/scope |
| `refresh_operator_kb` | Live-derived KB delta vs the static import | L | Low | Med | P2 | NEW | enumeration (depends on createable) |

#### A.6 · Deferred (Round 1 — v0.6.0+ / gated)

`create_gpu_fluid`, `create_optical_flow_particles` (GPU/macOS), `create_sdf_text`,
`create_strange_attractor`, `create_vertex_displacement_mat`, hand/face MediaPipe
modes, `create_pose_reactive`, `manage_td_process` / `switch_instance`,
`control_diffusion` / `drive_streamdiffusion` / `connect_comfyui`, and the
recipe/template marketplace (local-first).

### Round 2 — "beyond the backlog" — 2026-05-30

**63 distinct candidates** (6 P0 · 35 P1 · 22 P2; 58 NEW · 5 EXTENSION · 0 ROADMAP),
every one deliberately beyond Round 1 and beyond what v0.6.0 shipped.

#### B.1 · Artist controls & creative tools

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `create_auto_montage` | Beat-quantized content switcher across N source TOPs | M | High | High | P0 | NEW | next-index once/boundary; Select-TOP wires |
| `create_euclidean_sequencer` | Bank of Bjorklund Euclidean rhythm generators | M | High | High | P0 | NEW | per-step prob + phase-lock; paused-timeline |
| `create_preset_morph` | True N-way weighted parameter-space blend | M | High | High | P0 | NEW | interpolate-vs-blend; exclude menu pars |
| `create_scene_timeline` | Bar-timed song-mode arranger (Timer playhead + crossfades) | M | High | High | P1 | NEW | segment callback; tempo re-time; paused |
| `create_prob_sequencer` | Probabilistic / Markov step engine + drunk-walk lane | M | Med | High | P1 | NEW | Markov state survives beats; fire once/step |
| `create_two_way_surface` | Closed-loop control surface (osc/midi state back out) | M | Med | High | P1 | EXTENSION | value-change guard vs oscillation |
| `create_chroma_reactive` | 12-bin chroma / key / major-minor reactivity | M | Med | Med | P1 | NEW | FFT-bin→pitch-class fold; experimental |
| `create_transient_reactive` | Percussive-vs-tonal split (drums→snappy, pads→swells) | M | Med | Med | P1 | NEW | two distinct streams; experimental |
| `create_energy_structure` | Song-structure tracker (build/drop/breakdown + energy) | M | Med | Med | P1 | NEW | adaptive thresholds; experimental |
| `create_automation_lane` | Looping/recorded parameter-automation lane | M | Med | Med | P1 | NEW | record cadence vs loop-phase quantize |
| `create_phone_gesture` | Phone IMU (tilt/gyro/shake) + multitouch → CHOPs | M | Med | Med | P1 | EXTENSION | iOS sensor permission / HTTPS |
| `create_growth_system` | Differential-growth / space-colonization line-art | L | Med | Low | P2 | NEW | probe-live (iterative render path) |

#### B.2 · Library, packaging & distribution

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `auto_tag_library_asset` | Derive tags/op-family/difficulty/description from captured `nodes[].type` | M | High | High | P0 | NEW (extends save) | none |
| `lint_recipe_library` | CI-grade linter: operator-existence + reference integrity + id-collision | M | High | High | P1 | NEW | KB-unknown types are warnings |
| `morph_pack` | Capture an N-preset blend-space as a saved/shareable asset | M | High | Med | P1 | NEW | probe-live the live rebuild |
| `provenance_stamp` | author/license(SPDX)/created/version/`derived_from` on assets | S | Med | High | P1 | NEW | none |
| `checksum_and_verify_pack` | SHA-256 manifest + verify-on-install | S | Med | High | P1 | NEW | none |
| `library_lineage_graph` | Cross-asset family tree (Mermaid + JSON, offline) | M | Med | High | P1 | NEW | none |
| `curated_collection_pack` | Named, ordered "awesome-list" collection → README/bundle | M | Med | High | P2 | NEW | none |
| `merge_vaults` | Conflict-aware two-vault merge (dry-run) | M | Med | High | P2 | NEW | mandatory dry-run |
| `component_changelog_trail` | Append-only CHANGELOG in a package + param-delta | M | Med | Med | P2 | NEW | live param-read degrades |
| `vault_repo_sync` | Round-trippable vault ⇄ git repo | M | Med | Med | P2 | NEW | git shell-out optional; never auto-commit |
| `variant_pack` | Seeded, thumbnailed pack of N parameter variants | M | Med | Med | P2 | NEW | range covers target pars; seed reproducible |
| `learn_from_my_corpus` | Personal-style index (op combos, ranges, palettes) → profile | L | Med | Med | P2 | NEW | offline (recipe/serialized) |

> `semantic_library_search` (raised here) was **merged into ai `recall_similar_work`** — same
> intent-retrieval capability; retrieval is owned by the AI surface.

#### B.3 · CLI & developer DX

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `setlist_runner` | Headless show driver: advance scenes by duration/beat/manual | M | High | High | P0 | NEW | beat-event fidelity; wall-clock fallback |
| `panic_blackout_hotkey` | Instant top-level `tdmcp panic`/`blackout` (+`--restore`/`--hold`) | S | High | High | P0 | NEW (wraps `create_panic`) | idempotent re-fire |
| `live_dashboard_tui` | Always-on operator HUD (FPS/drops/GPU/errors/beat) over SSH | M | High | High | P1 | NEW | refresh adds no cook load |
| `scene_scheduler` | Wall-clock cron-lite (`at`/`every` → command/cue/setlist) | M | Med | High | P1 | NEW | DST/timezone for `at HH:MM` |
| `bridge_watch_build` | Watch `td/` → auto-`reload_bridge` on save (+`py_compile` gate) | S | Med | High | P1 | NEW | debounce "save all" |
| `scaffold_tool_generator` | `scaffold tool <name> --layer N` emits the 3-file boilerplate | S | Med | High | P1 | NEW | none |
| `profile_cook_cost` | Ranked most-expensive operators + frame-budget bar | S | Med | High | P1 | NEW | confirm `get_td_performance` per-op |
| `macro_recorder` | `record start/stop` captures mutating CLI commands into a `run` file | M | Med | High | P1 | NEW | record across invocations |
| `soundcheck_monitor` | Live meter of the audio-reactive chain at line-check | M | Med | Med | P1 | NEW | probe-live band-energy path |
| `log_tail_filtered` | `logs --follow [--level] [--grep]` | S | Med | Med | P2 | NEW | probe-live incremental `since`/cursor |
| `fixture_recorder` | Capture a real bridge response → a frozen msw fixture | M | Med | Med | P2 | NEW | probe-live pre-validation capture |
| `remote_and_fanout` | `fanout <hostsfile> <cmd>` across several bridges | M | Med | Med | P2 | NEW | failure policy |
| `controller_to_cli_bridge` | OSC/MIDI input → CLI tool-call | L | Med | Low | P2 | NEW | probe-live (OSC-first; no zero-dep MIDI) |

#### B.4 · AI & LLM integration

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `recall_similar_work` | RAG over the user's own vault (merges `semantic_library_search`) | M | High | High | P1 | NEW | none (offline keyword/tag) |
| `style_memory` | Persistent accrued aesthetic profile read every session | M | High | High | P1 | NEW | none (frontmatter IO) |
| `scene_summary_resource` | `tdmcp://scene` — live token-cheap project digest as a resource | S | Med | High | P1 | NEW | none |
| `prompt_eval_harness` | Offline vitest gate for the 28 prompts | S | Med | High | P1 | NEW | none |
| `moodboard_to_system` | LLM-grounded multi-tool moodboard pipeline | M | Med | High | P1 | EXTENSION | none (keyword fallback) |
| `compose_cue_list` | Natural-language → a built, fireable cue sequence | M | High | Med | P1 | NEW | probe-live cue→trigger; `client.ts` parse |
| `score_build` | Scorecard tool (palette/motion/complexity/errors/perf 0–10) | M | Med | Med | P1 | NEW | probe-live no-LLM card |
| `learn_conventions` | Infer naming/layout/color from the live project | M | Med | Med | P1 | NEW | probe-live (`node_detail` flags/pos/color) |
| `audio_fingerprint_to_visual` | Audio reference → matched reactive build | M | Med | Med | P1 | NEW | probe-live (real clip; tune) |
| `elicit_missing_args` | MCP elicitation — ask the client for a missing field | M | Med | Med | P2 | NEW | probe-live SDK + client support |
| `enhance_build` | Goal-directed "make it better" loop (score→change→re-score) | L | Med | Med | P2 | NEW | probe-live bound + rollback |
| `run_macro_script` | NL/DSL imperative script → fail-forward `batch_operations` | L | Med | Med | P2 | NEW | probe-live allow-list verbs |
| `voice_copilot_chat` | Browser Web-Speech push-to-talk in the copilot page | S | Med | Med | P2 | NEW | probe-live `SpeechRecognition` (Chromium) |

#### B.5 · TouchDesigner depth (bridge + operators)

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `create_engine_comp` | General Engine-COMP wrapper (compiled `.tox` in a separate process) | M | High | Med | P1 | NEW | probe-live (baked tox; cross-process IO) |
| `create_glsl_material` | Author a GLSL MAT (vertex+pixel+compute) on geometry | M | Med | High | P1 | NEW | low (`create_depth_displacement` maps it) |
| `build_chop_chain` | Composable CHOP-DSP pipeline → Null | M | Med | High | P1 | NEW | low (Lookup input + Analyze enum) |
| `control_timeline_transport` | Transport read/write over `me.time` + paused self-diagnose | S | Med | High | P1 | NEW | none significant (keep off exec gate) |
| `extend_data_source_fabric` | Add MQTT/WebSocket/Web-Server-DAT to `create_data_source` | M | Med | High | P1 | EXTENSION | none significant (MQTT topic parse) |
| `author_script_operator` | Extend Python authoring to Script CHOP/SOP/TOP | M | Med | High | P1 | EXTENSION | low (per-family `onCook`) |
| `create_dmx_fixture_pipeline` | Fixture-aware DMX/Art-Net (named pan/tilt/dimmer/gobo via Map DAT) | M | Med | Med | P1 | NEW | probe-live DMX Map DAT layout |
| `inspect_gpu_and_displays` | System/GPU pool + monitor topology read | S | Med | Med | P1 | NEW | probe-live SysInfo/monitors attrs |
| `create_shared_memory_bridge` | Shared-Memory In/Out TOP/CHOP — lowest-latency local link | M | Med | Med | P2 | NEW | probe-live shared-name/size handshake |
| `create_scheduler` | Atomic Timer-CHOP scheduler primitive (named timers, callbacks) | M | Med | Med | P2 | NEW | probe-live Timer units + callbacks |
| `build_sop_geometry` | Procedural SOP modelling (noise/copy/sweep/extrude → Null) | L | Med | Med | P2 | NEW | probe-live chains cook within budget |
| `sync_timecode` | SMPTE/LTC timecode lock (Timecode CHOP) | M | Low | Med | P2 | NEW | probe-live (audio-LTC decode first) |
| `manage_component_storage` | Write a COMP's storage dict + `opShortcut`/`parentShortcut` | M | Low | High | P2 | NEW | none significant (JSON-serialize) |
| `param_changed_event` | `param.changed` via a Parameter Execute DAT (Round 1 tracked, still open) | M | Low | Med | P2 | tracked | onValueChange freq/scope |

#### B.6 · Cross-cutting (Round 2)

Value that spans surfaces (kept once above under its best-fit surface; relationships explicit here):

- **Time-based show automation** — `create_scheduler` (td-depth primitive) → `create_scene_timeline`
  (controls) ∥ `setlist_runner` (cli) ∥ `compose_cue_list` (ai); share **one** setlist/scene schema.
- **Run AI tools via the connected model** + a structured/image method on the LLM client — the shared
  prerequisite for `compose_cue_list`, `score_build`, `moodboard_to_system`, `reference_to_plan` and
  Round-1's `caption_top`/`copilot_vision`; the platform move that runs them via the connected model.
- **"Do it my way" cluster** — `recall_similar_work` ⇄ `style_memory` ⇄ `learn_from_my_corpus`
  ⇄ `learn_conventions` over one `Memory/` vault note schema.
- **Morph at two altitudes** — `create_preset_morph` (live instrument) ⇄ `morph_pack` (saved asset).
- **Engine pipeline** — `create_engine_comp` (process) ⇄ a "compile for Engine" bake on `make_portable_tox`.
- **Library keystone** — `auto_tag_library_asset` feeds `library_lineage_graph`, `recall_similar_work` and `lint_recipe_library`.

### Round 3 — external / community sources — 2026-05-30 {#appendix-c-round3}

**157 raw records → ~62 deduped candidates** (75 `EX` rows including sub-merges)
from four community sources — [alltd.org](https://www.alltd.org),
[awesome-touchdesigner](https://github.com/monkeymonk/awesome-touchdesigner)
(surveyed by two agents, creative ∥ integrations), and artist
[Anya Maryina](https://anyamaryina.gumroad.com) (studied for technique and
packaging only, never asset-copied). Distribution **6 P0 · ~30 P1 · ~39 P2**. The
new field versus the inward Rounds 0–2: **ecosystem ingestion**, **the missing
iconic looks**, and an **artist-publishing layer**. **Source codes:**
`aw-cre`/`aw-int` = the two awesome-touchdesigner agents · `alltd` · `anya`.

> ⚠️ **alltd.org returned HTTP 403** to direct fetch — its rows are
> search-summary-level; re-fetch alltd-only items via a browser before speccing.
> **Licensing discipline:** GPL-3.0 (TD-Flow-ABS, TDComponents, TDNeuron) + CC-BY
> (RayTK) = technique/idea only, no code copied; **Lygia not bundled**; Anya never
> cloned (highest attention: `generative_classics` recreates *techniques*, credits
> lineage, and never copies a named/estate artist). `gated` =
> drive-installed-tox / cloud / docs-delta only.

#### C.1 · Integrations & protocols

| Feature | EX | Delivers | Eff | Impact | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| `import_shadertoy` | EX-01 | Paste a Shadertoy URL/code → wired GLSL TOP (map iTime/iResolution/iMouse/iChannel) | M | High | High | P0 | NEW | aw-cre, aw-int (ShaderToyTD) |
| `import_isf_shader` | EX-02 | Parse ISF JSON header → GLSL TOP + auto custom-param page | M | High | High | P0 | NEW | aw-int, aw-cre (isf-touchdesigner, MIT) |
| `setup_tdableton` | EX-03 | Ableton clips/tracks/devices/transport over OSC → named CHOPs | M | High | High | P0 | NEW | aw-int (TDAbleton docs), alltd |
| `create_data_source` HTTP/WS | EX-04 | HTTP-request + WebSocket data modes (AI servers + web APIs) | M | Med-Hi | High | P1 | EXTENSION (planned MQTT/WS) | aw-int |
| `create_fixture_control` + 3D previz | EX-45 | Moving-head pan/tilt/dimmer/gobo via DMX + 3D rig preview | M | High | Med | P1 | NEW (builds planned DMX pipeline) | alltd, GeoPix, aw-cre |
| `create_machine_sync` | EX-08 | Sync + Touch In/Out genlock + CHOP/DAT/TOP across machines | M | High | Med | P1 | NEW | alltd · probe ≥2 machines |
| `create_detection_reactive` (YOLO) | EX-05 | Object/person presence/count → params (ONNX/WS, no CUDA) | M | Med | Med | P1 | NEW | aw-int (TDYolo, MIT) |
| `create_depth_from_2d` (DepthAnything) | EX-06 | Monocular depth from any TOP → feeds depth/displace/point-cloud | M | High | Med | P1 | NEW·gated | aw-int, alltd · NVIDIA/CUDA |
| `create_sensor_input` (Arduino/serial) | EX-10 | Serial parse + lag/filter/clamp/remap + calibration presets | M | Med | Med | P2 | EXTENSION | alltd · hardware |
| `create_laser_output` (ILDA) | EX-09 | Laser CHOP → Lasercube/Etherdream/Helios | M | Med | Low | P2 | NEW | aw-int, aw-cre, alltd · hardware |
| `create_multitouch_surface` / TUIO | EX-11 | Multi Touch In DAT + TUIO tangibles → CHOPs | M | Med | Med | P2 | NEW | alltd · touchscreen |
| `create_geo_visualization` (OSM) | EX-12 | GeoJSON/OSM → project lat-long → instance a city | L | Med | Med | P2 | NEW | alltd · ODbL attribution |
| `drive_diffusion_tox` / cloud-SD | EX-07 | Drive an installed ComfyUI/A1111/SD tox; cloud mode = no local GPU | M | Med | Med | P2 | NEW·gated | aw-int, alltd · NVIDIA or paid cloud |
| Marketplace catalog index seed | EX-13 | Index public .tox catalogs (link-only) into `local_marketplace_index` | S | Low-Med | Med | P2 | EXTENSION | aw-int, aw-cre, alltd |
| Synesthesia/Unreal-OSC presets | EX-14 | Named OSC-out presets for Synesthesia / Unreal | S | Low-Med | Med | P2 | EXTENSION | alltd |

#### C.2 · Controls — effects, generators, reactivity, performance, mapping

| Feature | EX | Delivers | Eff | Impact | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| `create_fluid_sim` | EX-15 | Own-GLSL 2D Navier-Stokes ink/dye/smoke (advection/vorticity/buoyancy) | M–L | High | High | P0 | NEW | aw-int (touchFluid MIT), aw-cre, alltd |
| `image_to_particles` / `mesh_to_particles` | EX-26 | Any image/logo/mesh → controllable particle cloud (+ source mode on gpu_particle_field) | M | High | High | P0 | NEW | anya, aw-cre |
| Color-finish suite | EX-47/46 | `apply_lut` (.cube/OCIO) + color wheels/curves + `create_video_scopes` | M | High | High | P0 | NEW/ENH | alltd, aw-cre |
| `create_chop_recorder` / `record_osc` | EX-39 | Record/replay/loop any reactive signal (audio/pose/MIDI/OSC) | M | High | High | P1 | NEW | aw-cre (GPL idea-only), alltd |
| `create_flow_abstraction` | EX-16 | Painterly/comic coherent-line filter on live camera | M | Med-Hi | High | P1 | NEW | aw-int, aw-cre (GPL idea-only) |
| MediaPipe face/hand/segmentation | EX-34 | Finger-gesture + face + selfie-segmentation on the in-tree engine | M | High | Med | P1 | ENH | aw-int (mediapipe-td, MIT) |
| `create_interaction_zones` + optical-flow trigger | EX-36 | Camera/pose enter/exit/dwell zones fire cues (no depth-cam) | M | Med-Hi | High | P1 | NEW | alltd |
| `create_dither` | EX-18 | Ordered 1-bit/retro dither (Bayer, gameboy, low-palette) | S–M | Med | High | P1 | NEW | aw-cre |
| `create_jfa_voronoi` | EX-19 | Jump-flood Voronoi → mosaic/stained-glass | M | Med | High | P1 | NEW | aw-int, aw-cre (TD_Voronoi MIT) |
| `create_npr_filter` (Kuwahara) | EX-17 | Oil-paint / pencil / watercolor non-photoreal filters | M | Med | High | P1 | NEW | aw-cre (chungbwc) |
| `controlled_disorder_grid` | EX-27 | Grid of quads/lines with a tunable order↔chaos `disorder` knob | M | Med-Hi | High | P1 | NEW | anya, aw-cre · name generically |
| `create_terrain` | EX-29 | Heightmap landscape + PBR splat + water + volumetric fog | L | Med | Med | P1 | NEW | aw-int, aw-cre (Terrain-Tools MIT) |
| `create_l_system` + `create_asemic_writing` | EX-28 | Lindenmayer branching geometry + procedural glyph strokes | M–L | Med | Med | P1 | NEW | aw-cre, anya |
| `create_clip_sequencer` + `create_audio_transport` | EX-40 | Cached clip seq (trim/reverse/beat-advance) + audio-file master transport | M | High | Med | P1 | NEW/EXT | alltd |
| `extract_palette` (cross-ai) | EX-67 | k-means N-color extraction from any image → palette/grade/instances | S–M | Med | High | P1 | NEW/ENH | alltd, aw-cre, anya |
| musical-bands + spectrogram heatmap | EX-38 | FFT→named musical bands (per-band attack/release) + heatmap trail | S–M | Med | High | P1 | NEW/ENH | aw-cre, alltd |
| `create_pointer_reactive` | EX-37 | Mouse/multitouch position as a first-class creative seed/force | S–M | Med | High | P1 | NEW | anya, alltd |
| `create_plexus` | EX-20 | Points + lines between near neighbours (constellation/network) | M | Med | Med | P1 | NEW | aw-cre |
| `create_pixel_sort` | EX-21 | Threshold pixel-sort via feedback translation | S–M | Med | High | P2 | NEW | alltd |
| `add_timecode_overlay` | EX-42 | HH:MM:SS:FF / countdown overlay | S | Low-Med | High | P2 | NEW | aw-cre (GPL idea-only) |
| `create_step_repeat` | EX-23 | Brick/grid tiling with gap/jitter/rotation | S | Low | High | P2 | NEW | aw-cre (GPL idea-only) |
| Lens/CA/vignette finishing pass | EX-24 | Barrel distortion + chromatic aberration + vignette | S | Low-Med | Med | P2 | ENH (check glitch overlap) | alltd, aw-cre |
| Feedback/displace preset library | EX-25 | Pixel-drip, mirror/trail/decay, video-displaces-video presets | S | Low | Med | P2 | EXTENSION | alltd |
| `create_lidar_reactive` | EX-35 | 2D LiDAR → blob-cluster → touch coords → bind (installs) | M | High | Med | P2 | NEW | anya · RPLidar hardware |
| Kinetic-text path-follow / presets | EX-43 | Sentence-instancing path-follow + smoke-logo/ramp-text presets | M | Med | Med | P2 | EXTENSION | alltd, anya |
| `scaffold_vj_deck` | EX-44 | Compose decks + control-surface + MIDI-map into a VJ deck UI | M | Med | Med | P2 | EXTENSION | alltd (PATCHDECK pattern) |
| `create_pop_fluid` / `create_surface_flow` | EX-30 | POP-family GPU fluid + surface-flow (extends create_pop_field) | M–L | Med | Low | P2 | EXTENSION | alltd · probe POPs |
| `create_volumetric_fire` (NVIDIA Flow) | EX-31 | Volumetric fire/smoke/water emitter | M | Med | Low | P2 | NEW·gated | alltd · NVIDIA/Windows |
| `create_blob_trace` / `create_vector_lines` | EX-74/75 | Contour outline trace + image→line-art/plotter look (pairs w/ SVG export) | M | Med | Med | P2 | NEW | aw-cre, alltd |
| Fractal SDF presets + particles-in-SDF | EX-33 | Mandelbulb/menger presets + instanced particles in a raymarched SDF | M | Low-Med | Med | P2 | EXTENSION | alltd · GPU |
| `create_virtual_projection_set` / camera-match | EX-48 | Virtual room+projector cam previz; match cam to real projector | M | Med | Med | P2 | NEW | alltd |
| VR180 stereo dome mode | EX-49 | 180° stereo equirect render on dome/cubemap output | S | Low | Med | P2 | EXTENSION | alltd |

#### C.3 · TouchDesigner depth — bridge, operators, editing

| Feature | EX | Delivers | Eff | Impact | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| 3D post passes (SSAO/SSR/DOF/motion-blur) | EX-22 | Screen-space AO/reflections/DOF/motion-blur on `apply_post_processing` | M | Med-Hi | High | P1 | ENH | aw-int, aw-cre (PostEffects MIT) |
| `swap_operator` | EX-50 | Replace an op's type while preserving wires + params | S–M | Med | High | P1 | NEW | aw-int (FunctionStore MIT) |
| `create_raymarch_scene` → SDF expr-graph | EX-51 | Compose SDF primitives/booleans/domain-ops → one GLSL | L | Med-Hi | Med | P1 | ENH | aw-int, aw-cre (RayTK CC-BY) |
| `complete_python_at` | EX-52 | Valid op paths/params/channels from the live graph for the LLM | S–M | Med | Med | P2 | NEW | aw-int, aw-cre |
| `create_physics_constraints` (Bullet) | EX-32 | Hinges/springs/ragdoll/stacking rigid-body sims | L | Med | Low | P2 | NEW | aw-cre · probe-live |
| `create_engine_comp` / TouchEngine headless | EX-53 | Run a `.tox` headlessly (zero-copy) — builds planned engine-COMP | M | Med | Low | P2 | EXTENSION·gated | aw-int, alltd · paid TD license |
| Cook-on-change optimizer mode | EX-54 | Cook only when input changes (null-cache gating) | S | Low | Med | P2 | EXTENSION | aw-cre (GPL idea-only) |

#### C.4 · Library, packaging & product

| Feature | EX | Delivers | Eff | Impact | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| `export_look_tox` | EX-56 | Extract a look into a standalone parameterized `.tox` | S–M | High | High | P1 | NEW | anya |
| `export_sop_to_svg` | EX-55 | SOP geometry → SVG paths (plotter/laser/print; no dep) | M | Med | High | P1 | NEW | aw-int, aw-cre (MIT) |
| `generative_classics` recipe pack | EX-57 | Recipes recreating canonical generative-art *techniques* | M | Med-Hi | High | P1 | NEW | anya, aw-cre · credit lineage |
| `tdmcp://glsl-snippets` catalog | EX-58 | Vetted, license-clean noise/SDF/color/blend GLSL the AI assembles from | M | Med | High | P1 | NEW | aw-cre · author own, not Lygia |
| License-tier + provenance/funnel metadata | EX-59 | Revenue-tiered license templates + price/tier fields in the index | S | Med | High | P1 | EXTENSION (planned provenance) | anya |
| `vendor_python_lib` | EX-60 | Vendor pip libs into Text DATs → self-contained `.toe` | M | Med | Med | P2 | NEW | alltd |
| Own starter recipe pack + cover art | EX-61 | First-party curated recipe pack (the "free pack" funnel) | M | Med | Med | P2 | EXTENSION (content) | alltd, anya · author own |

#### C.5 · CLI & DX

| Feature | EX | Delivers | Eff | Impact | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| `tutorial_companion_pack` | EX-62 | One command → teaching/selling bundle (.tox + walkthrough + README + preview) | M | High | High | P1 | NEW | anya |
| `auto_ui` from custom params | EX-63 | Auto-generate a control panel from a COMP's custom params | M | Med | High | P1 | NEW | alltd |
| Codec export presets + offline render | EX-41 | HAP/NotchLC/ProRes presets + non-realtime no-frame-drop render | S–M | Med | High | P2 | EXTENSION | alltd |
| `scaffold_state_machine` | EX-64 | FSM show-flow + extension-driven structure skeleton | M | Med | Med | P2 | NEW | alltd |
| `edit_shader` hot-reload | EX-65 | Edit-DAT → re-cook → errors+preview round-trip aggregator | S | Low-Med | Med | P2 | NEW | aw-cre (ShaderBuilder MIT) |
| `genuary_daily` scaffold | EX-66 | Dated daily-sketch folder + variant capture + auto-gallery | S | Low | High | P2 | NEW | anya |

#### C.6 · AI & LLM

| Feature | EX | Delivers | Eff | Impact | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| `extract_palette` | EX-67 | (see C.2) image → constrained palette for grade/instances | S–M | Med | High | P1 | NEW/ENH | alltd, aw-cre, anya |
| "generative-classic" + "one-source-five-ways" prompts | EX-68 | Steer a build toward a generative-art lineage; emit N labeled variants | S | Med | Med | P2 | NEW | anya |
| KB enrichment + `tdmcp://cheatsheets` | EX-69 | Common-ops/Python/SOP cheat sheets → KB + resource | M | Med | Med | P2 | NEW | aw-int |
| `teach_touchdesigner` tutor + learning resource | EX-70 | KB-grounded concept tutor + curated learning-path resource | S | Med | Med | P2 | NEW | aw-int |

#### C.7 · Docs / examples

| Feature | EX | Delivers | Eff | Impact | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| Cookbook: famous-tutorial mirrors | EX-71 | Recreate iconic tutorials with tdmcp tools (dither/plexus/point-cloud/blob/video→particles) | S ea | Med | High | P1 | docs | aw-cre, alltd, aw-int |
| Cookbook: everyday-object→generative + beginner psychedelia | EX-72 | Rebuild a real-world pattern procedurally; beginner audio-reactive stack | S | Med | High | P2 | NEW docs | anya |
| Docs: "tdmcp as a source for Resolume/VDMX/Disguise" | EX-73 | Document the downstream NDI/Spout/Syphon chain into other VJ apps | S | Med | High | P2 | exists-complete + docs | aw-int, alltd |

#### C.8 · Reconciled out (already shipped / planned / gated / ignore)

Recorded for honesty: **exists-complete** — Shader Park (`create_shader_park`), the
full VJ-mixer stack (decks + layer-mixer + output + record), and Spout/NDI/Syphon
capture (`create_live_source`). **gated/planned** — optical-flow particles, the
Unreal/TouchEngine bridge (paid), StreamDiffusion/ComfyUI/DepthAnything bundling
(kept only as drive-installed-tox / cloud deltas), and Kinect/Azure depth-cams
(kept as the lighter optical-flow/MediaPipe path). **ignore** — TDNeuron / TF
Style-Transfer (GPL/Windows/legacy-heavy) and Cables.gl (not TD). Cross-cutting:
Round-3 `create_data_source` HTTP/WS folds into Round-2's planned MQTT/WebSocket
fabric; `create_fixture_control` builds Round-2's `create_dmx_fixture_pipeline`;
license-tier metadata hardens Round-2's `provenance_stamp`; and
`extract_palette` / `generative_classics` relate to the shipped `create_palette` /
`generate_from_moodboard`.
