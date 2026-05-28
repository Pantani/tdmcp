# tdmcp Roadmap — v0.3.0 → v1.0.0

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

> Phase numbers are historical build order, not release order — the **Version** column
> shows which release each phase ships in. Everything built so far (Phases 0–12) ships in 0.3.0.

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
| 13 | 0.5.0 ☐ | Components, agent-DX & reactivity | Reusable-component scaffolding, project analysis/auto-docs, token-cheap agent-DX, Link/MIDI — the gaps left after the 0.4.0 generators + the body-tracking tools already on `main` |

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

## Phase 1 — v0.3.0 · Musical reactivity ⭐ ☑ shipped

The heart of the live workflow. Beat events ride the phase-0 event producer.

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| `extract_audio_features` | Audio chain exposing level + bass/mid/treble band energies on a Null CHOP, with a Sensitivity knob; device/file/oscillator/existing source | M | ☑ |
| `create_tempo_sync` | Beat CHOP clock → `ramp`/`pulse`/`count`/`beat`/`bar`/`bpm`; emits a `beat` event over the WebSocket each beat (via a CHOP Execute DAT) | M | ☑ |
| `bind_to_channel` | The link: drive any parameter from a CHOP channel (audio feature / beat) by expression, with scale + offset | M | ☑ |
| Prompt "beat-reactive designer" | Guides the AI to wire audio features + beat into a visual's parameters | S | ☑ |

**Areas:** `src/tools/layer1/extractAudioFeatures.ts`,
`src/tools/layer1/createTempoSync.ts`, `src/tools/layer2/bindToChannel.ts`,
`src/prompts/beatReactiveDesigner.ts`, CLI commands `audio-features` /
`tempo-sync` / `bind`. Notes from the live probe: this build has **no Tempo
CHOP** (the Beat CHOP is the clock) and the bass/mid/treble split uses Audio
Filter → Analyze (RMS) rather than the spectrum. `bind_to_channel` was added as
the missing link that actually wires reactive signals into visuals.

---

## Phase 2 — v0.3.0 · Live performance ⭐ ☑ shipped

Turns generated systems into instruments. Builds on the preset/control-panel/external-I/O work.

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| `manage_cue` (scene system) | Store/recall/list/delete cues + a timed, eased **morph** crossfade between looks (Execute DAT engine) | L | ☑ |
| `create_macro` | One 0–1 knob → N parameters, each remapped into its own range with a curve | M | ☑ |
| `randomize_controls` | Randomize numeric controls within range, with an `amount` blend (nudge → full scramble) | S | ☑ |
| `create_control_surface` | Playable panel COMP: faders that drive params + buttons that recall/morph cues | M | ☑ |
| `create_phone_remote` | Mobile web panel served from a Web Server DAT — touch sliders, no app to install | M | ☑ |
| OSC/MIDI output | `osc_out` / `midi_out` in `create_external_io` for bidirectional feedback | S | ☑ |

**Areas:** new L2 tools (`manageCue`, `createMacro`, `randomizeControls`,
`createControlSurface`, `createPhoneRemote`), extended `createExternalIo`, CLI
commands `cue`/`macro`/`randomize`/`surface`/`remote`. Note: "MIDI learn" is
covered declaratively — wiggle a control, read the input CHOP with `get_td_nodes`,
then `bind_to_channel` — rather than an interactive capture mode.

---

## Phase 3 — v0.3.0 · Advanced creation (TouchDesigner) ☑ shipped

Heavy but mutually independent creation tools — each builds, verifies and previews a network.

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| `create_video_player` | Movie File In, or a playlist via a Switch TOP, with Play/Speed/Clip controls | M | ☑ |
| `create_layer_mixer` | A/B Cross TOP (Crossfade knob) or composite blend modes; sources via Select TOPs | M | ☑ |
| `create_3d_scene` | Geometry + Camera + Light + Render TOP (sphere/box/grid) with RotateY/Zoom | L | ☑ |
| `create_projection_mapping` | Corner Pin warp with draggable handles, output for setup_output | L | ☑ |
| `create_keyframe_animation` | Keyframed curve (time/value, easing) looping in sync — choreographed motion | M | ☑ |
| `create_simulation` | reaction_diffusion (recipe) + slime/fluid feedback flow fields, Decay knob | L | ☑ |

**Areas:** new L1 tools (`createLayerMixer`, `createVideoPlayer`, `create3dScene`,
`createProjectionMapping`, `createKeyframeAnimation`, `createSimulation`), CLI
commands `mixer`/`video`/`scene3d`/`mapping`/`keyframe`/`simulation`. Note:
"more recipes" is folded into these generators (they are the creation primitives);
`create_simulation` reuses the existing `reaction_diffusion` recipe, and
`create_generative_art` already covers cellular-automata / flow-field / attractor
techniques.

---

## Phase 4 — v0.3.0 · Intelligence (AI) ☑ shipped

The intelligence layer on top of everything already built.

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| Visual reference → network | `image_to_visual` prompt — recreate a reference image's look in real nodes (multimodal) | L | ☑ |
| Natural-language tweaks | `tweak_visual` prompt — "darker/faster/more chaotic" → the right params | M | ☑ |
| Operator KB search | `search_operators` — relevance-ranked keyword search over the 629 operators (no embedding dependency) | M | ☑ |
| Aesthetic critique | `critique_visual` prompt — evaluates preview/topology/perf, proposes concrete fixes | M | ☑ |
| Patch doc / diagram | `document_network` — counts by family/type + a Mermaid flowchart of the real network | S | ☑ |
| Remaining prompts | `vj_set_builder` and `fix_shader` | S | ☑ |

**Areas:** `src/tools/layer3/searchOperators.ts` & `documentNetwork.ts`,
`src/prompts/` (image_to_visual, tweak_visual, critique_visual, vj_set_builder,
fix_shader), CLI commands `operators` / `document`. Note: "semantic" search is
relevance-ranked keyword matching over the KB rather than a heavyweight embedding
index; multimodal / natural-language / critique ship as prompts (the model already
sees images and the patch) instead of bespoke tools.

---

## Phase 5 — v0.3.0 · Robustness & export ☑ shipped

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| `render_output` | Save a TOP to disk at full resolution (PNG/JPG/EXR/TIFF) — export a finished frame | M | ☑ |
| `optimize_performance` | Rank cook-time bottlenecks with suggestions; apply:true lowers flagged TOPs' resolution | M | ☑ |
| `diff_snapshots` | Readable diff between two snapshots — nodes/connections/params added, removed, changed | M | ☑ |
| `list_recipes` / `apply_recipe` | Browse and instantiate the recipe library from a tool/CLI | M | ☑ |
| Keyboard / gamepad / mouse input | `keyboard_in` / `gamepad_in` / `mouse_in` in `create_external_io` | S | ☑ |

**Areas:** new L3 tools (`renderOutput`, `optimizePerformance`, `diffSnapshots`),
L1 (`listRecipes`, `applyRecipe`), extended `createExternalIo`, CLI commands
`render`/`optimize`/`diff`/`recipes`/`recipe`. Follow-ups (Unreleased) finished the
items deferred during the build: `record_movie` (movie/sequence beyond a single
frame), a show scaffold (`scaffold_show` / CLI `init`), an interactive CLI `repl`,
GPU instancing in `create_3d_scene`, and an opt-in `semantic` re-rank for
`search_operators` via the LLM endpoint (keyword stays the zero-config default).

---

## Phase 6 — v0.3.0 · Obsidian vault integration ◐ integrated (live-validation pending)

Bridges an Obsidian vault (a folder of markdown notes) and TouchDesigner, gated on
`TDMCP_VAULT_PATH`. The vault layer is `src/vault/`; tools live in `src/tools/vault/`.

| Feature | Delivers | Effort | Status |
|---|---|---|---|
| Vault infra | `src/vault/` (path-traversal-safe IO + frontmatter), `TDMCP_VAULT_PATH`, `ToolContext.vault` | S | ☑ |
| Recipes ↔ vault | `RecipeLibrary` merges `<vault>/Recipes/*.md`; `save_recipe_to_vault` captures a live network | M | ☑ |
| `apply_shader_from_vault` | Build a GLSL TOP from a fenced-`glsl` note | S | ☑ |
| `sync_presets_vault` | Export/import `manage_presets` snapshots as markdown | S | ☑ |
| `export_network_to_vault` | Mermaid + `[[wikilink]]` patch-map note | S | ☑ |
| `log_performance` | Dated show diary with snapshot + thumbnail | S | ☑ |
| `import_setlist` | Build a show from a setlist note's `tracks` | M | ☑ |
| `bind_vault_text` | Text DAT live-synced to a vault note | S | ☑ |
| `generate_from_moodboard` | Seed `create_generative_art` from a palette/mood note | S | ☑ |
| `scaffold_vault` | Write a starter vault layout with worked examples | S | ☑ |

**Areas:** `src/vault/{index,frontmatter}.ts`, `src/recipes/markdown.ts`,
`src/tools/vault/*`, `TDMCP_VAULT_PATH` in `src/utils/config.ts`. Offline-tested
(vitest); live TD validation pending. Depends on `gray-matter` for frontmatter.

---

## v1.0.0 — Consolidation

Tool-API stabilization, docs (README + per-feature), test coverage, expanded
recipe library, bridge hardening.

---

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
is the remaining step** (each build flagged its own ⚠ live-tuning unknown). See
[[parallel-feature-build-workflow]].

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

## Phase 13 — v0.5.0 · Components, agent-DX & reactivity ☐ planned

**v0.4.0 shipped 2026-05-27** — fifteen new tools/prompts (raymarch & particle-flock generators,
point-cloud/PBR/cubemap-dome, tempo detection, LED/palette/cue/dashboard, generative audio, and
recipe/style prompts). Body/pose tracking (`setup_body_tracking`, `create_pose_tracking`,
`create_pose_skeleton`, `create_body_reactive`) is also already on `main` (in-tree, **not** in the
0.4.0 CHANGELOG). Phase 13 is the **next** wave (v0.5.0): the thesis shifts from *generating* visuals (0.4.x already covers that,
100+ tools) to **packaging, documenting and cheaply operating** them. tdmcp already ships `.tox`
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
| `scaffold_extension` | Extension DAT stub + Extension Object + Promote flag + re-init — make a COMP scriptable (BL-03) | M | ☐ |
| `add_custom_parameters` | Declarative custom-parameter pages (`appendCustomPage`/`appendFloat…`), TDJSON in/out — expose knobs (BL-03) | M | ☐ |
| `sync_external_clock` + Link/MIDI | Add `ableton_link` + `midi_clock` modes alongside tap-tempo — lock to the DJ's clock (BL-08) | S | ☐ |
| Body tracking ✅ on `main` (in-tree) | `setup_body_tracking` / `create_pose_tracking` / `create_pose_skeleton` / `create_body_reactive` (+ recipes `mediapipe_body_dots`, `pose_skeleton_mediapipe`) are in-tree on `main` (not in the 0.4.0 CHANGELOG). Remaining (incremental): hand/face modes, more reactive templates, live webcam validation (BL-02) | — | ☑ |
| `analyze_project` | Unused/dead ops, broken file deps, orphan COMPs, dependency graph via `findChildren`/connectors (BL-04) | M | ☐ |
| `generate_readme` | Markdown project doc: params table (TDJSON), I/O, child inventory, deps, preview thumbnail (BL-04) | M | ☐ |
| `analyze_screenshot` | Prompt+tool: `get_preview` image + topology + `get_td_node_errors` → explain/diagnose ("why is it black?") (BL-09) | M | ☐ |
| `edit_dat_content` | Surgical `old_string`/`new_string` DAT edit (unique-match + opt-in `replace_all`) — token-cheap edits *(Embody-mined)* | S | ☐ |
| `set_dat_content` (anti-wipe) | Safe whole-DAT write with a `confirm_wipe` guardrail (refuses silent clears) *(Embody-mined)* | S | ☐ |
| `batch_operations` | Many create/connect/set-param in one bridge round-trip, fail-forward with per-item warnings — expose the Layer-1 builder as a primitive *(Embody-mined)* | M | ☐ |
| `snapshot_td_graph` compact mode | Token-optimized TDN-style read (type-default hoisting, expr/bind shorthand, inline short arrays) — Embody's `read_tdn` is ~20–90× cheaper than op-walks *(Embody-mined)* | M | ☐ |
| `manage_annotation` + enclosed ops | Agents add network boxes/comments + query ops enclosed by a box → self-documenting networks *(Embody-mined)* | S | ☐ |
| `write_agent_guide` | Emit a project-local `CLAUDE.md`/`AGENTS.md` seeded with TDMCP operator conventions + render-coordinate rules *(Embody-mined)* | S | ☐ |
| `set_perform_mode` | Bridge suspends nonessential MCP/externalization compute during a live show — VJ-critical *(Embody-mined)* | M | ☐ |

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
