# Changelog

All notable changes to **tdmcp** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-05-28

Use tdmcp from *inside* TouchDesigner: dotsimulate's LOPs "MCP Client" can now spawn this
server over stdio and drive the network, closing the loop **TD → tdmcp → bridge → TD**.
Ships a hardened launcher and an optional curated tool profile so an autonomous in-TD agent
gets a safe, non-destructive surface. Additive and backward-compatible — existing clients
are unaffected (the default profile is `full`).

### Added

- **`TDMCP_TOOL_PROFILE`** (`full` | `safe`, default `full`) — `safe` additionally hides the
  six destructive / raw-code tools (`execute_python_script`, `exec_node_method`,
  `delete_td_node`, `create_panic`, `manage_checkpoint`, `manage_component`), a strict
  superset of `TDMCP_RAW_PYTHON=off`. Use it to hand an autonomous in-TD agent a curated,
  non-destructive toolset.
- **`scripts/tdmcp-lops.mjs`** — a dependency-free launcher for dotsimulate's LOPs MCP
  Client. Point the LOPs `command` at it; it injects the hardened env
  (`TDMCP_RAW_PYTHON=off`, `TDMCP_TOOL_PROFILE=safe`) then execs `dist/index.js`, since
  LOPs' `servers_config.json` has no documented `env` field.
- **LOPs integration guide** (EN + PT) — setup, the hardened `servers_config.json` snippet,
  the TD → tdmcp → bridge → TD architecture, and an explicit callout that this does **not**
  replace the local `tdmcp chat` copilot. Plus reference docs for the new env var and the
  in-TD topology.

## [0.4.0] - 2026-05-27

Fifteen new tools and prompts, built as a coordinated parallel pipeline (design →
develop → QA → deploy) and live-validated against TouchDesigner 2025.32820:
live-performance control, signature 3D/GPU visuals, more creation primitives,
spatial output, data + audio I/O, and AI authoring prompts.

### Added

- **`create_cue_sequencer`** (CLI `cue-sequencer`) — a bar-quantized cue timeline: a Beat
  CHOP + CHOP Execute DAT advances through an ordered list of steps, recalling/morphing each
  step's cue on the beat. The deterministic, musically-timed counterpart to `create_autopilot`.
- **`create_stage_dashboard`** (CLI `dashboard`) — one unified web performance surface from a
  Web Server DAT: cue-launch buttons + master faders + a panic blackout + a live beat/VU
  readout. Trusted networks only (accepts writes without auth, like the bridge).
- **`create_raymarch_scene`** (CLI `raymarch`) — a self-contained GLSL TOP raymarcher: SDF
  scenes (sphere-field / menger fractal / tunnel) with camera, step-count and color controls —
  the volumetric complement to `create_shader_lib`.
- **`detect_tempo`** (CLI `detect-tempo`) — auto-BPM from audio onsets (no tapping): inter-onset
  intervals → median → BPM on a Null CHOP, optionally driving the global tempo. Complements
  `sync_external_clock`. Experimental — BPM lock needs live tuning.
- **`create_palette`** (CLI `palette`) — a color palette / gradient generator: harmony rules
  (complementary/triad/analogous/tetrad/monochrome) or sampled from a source TOP → a Ramp TOP +
  a swatch CHOP, ready for `create_color_grade` / `generate_from_moodboard` / `bind_to_channel`.
- **`create_pbr_scene`** (CLI `pbr-scene`) — a 3D scene with a PBR material
  (metallic/roughness/base color) + an environment light rig for image-based lighting, beyond
  `create_3d_scene`'s basic light.
- **`create_particle_flock`** (CLI `flock`) — boids-style GPU particle flocking
  (separation/alignment/cohesion in a feedback-TOP velocity loop) feeding TOP-instancing — a
  behavioral complement to `create_gpu_particle_field`.
- **`create_point_cloud`** (CLI `point-cloud`) — render a point cloud from a depth/luminance map
  or a synthetic source via texture-packed TOP-instancing, with depth-scale / point-size / spin.
- **`create_data_source`** (CLI `data-source`) — ingest live external data (JSON/CSV over a Web
  Client DAT, OSC In, or Serial) onto a binding-ready Null CHOP, the input that feeds
  `create_data_visualization` / `bind_to_channel`.
- **`create_generative_audio`** (CLI `gen-audio`) — synthesize audio (oscillator / FM / noise)
  onto a Null CHOP, with optional opt-in audio-device output — generate sound, not just react.
- **`create_cubemap_dome`** (CLI `cubemap-dome`) — a true cube-map render (Render TOP in
  cube-map mode → GLSL fisheye/equirectangular remap) for planetarium domes / 360, the
  higher-fidelity follow-up to `create_dome_output`.
- **`create_led_mapper`** (CLI `led-mapper`) — pixel-map regions of a source TOP to an LED
  fixture layout (strip/grid; horizontal/vertical/serpentine) → per-pixel colors out as
  DMX/Art-Net, building on `create_external_io`'s `artnet_out`.
- **`scaffold_genre`** (CLI `genre`) — genre show scaffolds (techno / ambient / installation): a
  styled starting network with a genre-appropriate tempo, look and palette, beyond
  `scaffold_show`'s generic skeleton.
- **`text_to_recipe`** prompt — author a schema-valid recipe JSON (matching `RecipeSchema`) from
  a plain-language description, ready to save under `recipes/` and instantiate with `apply_recipe`.
- **`style_reference`** prompt — recreate a reference look (image or text description) by mapping
  it onto an ordered plan of concrete tdmcp tool calls + parameters.

[0.4.0]: https://github.com/Pantani/tdmcp/releases/tag/v0.4.0

## [0.3.1] - 2026-05-27

Packaging and docs for the Anthropic Connectors Directory submission (Desktop
Extension path). No runtime/tool behaviour changes.

### Changed

- The one-click Claude Desktop bundle is now built as **`.mcpb`** (MCP Bundle), the
  current Anthropic format — the build script already preferred the
  `@anthropic-ai/mcpb` packer, so this renames the output and the `build:dxt` →
  `build:mcpb` script. Legacy `.dxt` files still install in Claude Desktop.

### Added

- **Privacy policy** page (EN + PT) at `/privacy`, documenting that tdmcp runs
  entirely locally, collects no data, and has no telemetry — required for the
  Connectors Directory submission.

## [0.3.0] - 2026-05-27

Everything built on top of 0.2.0, in one release: a scriptable CLI and developer-experience
tooling, musical and beat reactivity, live-performance instruments (cues, macros, control
surfaces, phone remote), advanced creation (video, 3D, mixing, projection mapping, keyframes,
simulations, dimensional 3D / depth & spatial mapping), assistant intelligence (operator search,
documentation, AI prompts), and robustness & export (render to disk, performance hunting,
snapshots, recipes).

### Added

- **Phase 12 — Dimensional (3D, depth & spatial mapping):** five Layer-1 generators that take
  visuals off the flat plane, each built → verified → previewed live in TouchDesigner.
- **`create_3d_audio_reactive`** — a 3D scene that reacts to sound (CLI `audio3d`). `instanced_bars`
  renders a row of boxes/spheres whose **per-bar height** tracks the FFT spectrum (one CHOP sample
  per bar drives `instancesy` through a CHOP instance source) — a 3D spectrum bar-graph; `bass_pulse`
  swells a single primitive with RMS energy. The 3D counterpart to `create_audio_reactive`.
- **`create_dome_output`** — GLSL-remap a source TOP to **fisheye** or **equirectangular** for
  planetarium domes / 360 projection (CLI `dome`), the curved single-output complement to
  `create_multi_output`'s flat tiling.
- **`create_mesh_warp`** — map a source onto a **curved surface** via a deformable textured grid: a
  Point-SOP Z deform (bulge / wave / cylinder) of a `gridSOP` textured through a Constant MAT, beyond
  the flat corner-pin — for domes, columns, sculptures. Output ready for `setup_output` (CLI
  `mesh-warp`).
- **`create_depth_displacement`** — push a plane into real 3D relief by a **depth / luminance map**
  (camera / movie / synthetic) through a GLSL MAT vertex stage — true 2.5D geometry, with an
  Execute-DAT keep-alive for still sources (CLI `depth-displace`). Distinct from
  `create_depth_silhouette` (a flat mask).
- **`create_gpu_particle_field`** — a high-count **GPU particle field** (side², up to 512²≈262k):
  position/velocity **feedback-TOP** loops (curl-noise / gravity) feed **TOP-instancing**, flowing as
  curl-noise streams well beyond the CPU `create_particle_system` (CLI `gpu-particles`). Optional
  reactivity energises the field live — `audio` from mic/line RMS, `motion` from camera
  frame-difference energy — both bound to the velocity shader's `uReact` uniform.

- **Local LLM copilot (`tdmcp chat`, alias `tdmcp llm-run`)** — a browser chat UI driven by a
  local LLM (Ollama by default; any OpenAI-compatible endpoint via `TDMCP_LLM_BASE_URL`) for
  **simple tasks**, wired to the same bridge. Given a curated, **safe** tool subset (Layer-3
  inspect/CRUD + a few Layer-2; no Layer-1 system generators, no raw Python), with token streaming,
  cancel, a **read-only** tier, live model/endpoint switching, a one-click model **pull**, an
  **Escalate** handoff that copies a paste-ready prompt for Claude/Codex (same bridge, no state to
  move), and persistent history. **Auto-starts Ollama** when the local daemon isn't running
  (detached, left running so quitting the chat never takes the model offline); opt out with
  `--no-ollama`. Default model **`qwen2.5:3b`** — benchmarked 100% tool-calling on the simple-task
  workload, faster and lighter than 7B/14B (sub-3B is flaky; `llama3.1:8b` weaker at tool use).
- **`record_movie`** — record a TOP to a movie file (.mov/.mp4) via a Movie File Out TOP, with
  start/stop and an optional `seconds` auto-stop for capturing a fixed-length loop; stop also
  removes the recorder node it added so nothing lingers (CLI `movie`). Complements render_output —
  use render_output per frame for individual numbered stills.
- **`scaffold_show`** — create a starting skeleton for a live show (a master output Null + a
  tempo beat clock) so a set has a frame to build into (CLI `init`).
- **CLI `repl`** — an interactive mode that runs commands line-by-line (quotes preserved for
  JSON `--params`).
- **`create_motion_reactive`** — a camera/video analysis chain that exposes ready-to-bind reactive
  channels (overall brightness + frame-to-frame motion energy) on a Null CHOP, with a Sensitivity
  knob (CLI `motion-reactive`). The camera counterpart to extract_audio_features: bind a parameter
  to `op('…/motion_reactive/features')['motion']` and it reacts to movement. Source can be the live
  camera, a movie file, a synthetic pattern (for testing without a camera), or an existing TOP. A
  small Execute DAT keeps the analysis cooking so the signals stay live before anything is bound.
  (Optical flow is unsupported on macOS, so flow direction isn't exposed.) First of the Phase 7
  "stage I/O & sensor reactivity" tools.
- **`create_text_overlay`** — composite styled text (font size, hex color, h/v alignment) over a
  visual through a Text TOP + Composite TOP, or on its own transparent background, output as a Null
  (CLI `text`). For lyrics, titles, song names or credits — distinct from the vault's
  `bind_vault_text` (a data-sync of a Text DAT); this is a finished visual layer.
- **`create_autopilot`** — a beat-driven auto-VJ: a Beat CHOP + CHOP Execute DAT that, every N
  beats, either randomizes a target COMP's numeric controls (a hands-free drift set by Amount) or
  cycles through its stored cues, so a set keeps evolving on its own (CLI `autopilot`). Live
  Active / Beats / Amount knobs pause or retune it on stage. Reuses the tempo clock,
  randomize_controls and manage_cue mechanisms (validated live: controls drift each beat, Active
  pauses).
- **`create_multi_output`** — fan a master TOP across N projectors/displays: each output is a
  cropped horizontal or vertical slice resized to full projector resolution and ended on a Null,
  ready for setup_output; with `as_windows`, each tile also gets a borderless Window COMP offset
  across the desktop onto its own display (CLI `multi-output`). An `overlap` adds **edge-blending** —
  tiles widen into their neighbours and a GLSL feather fades the shared seams so physically-
  overlapping projectors blend smoothly. The multi-projector counterpart to setup_output's single
  window (validated live: a ramp split into seamless halves, and the feather fading interior seams
  to transparent while leaving the canvas edges full).
- **`sync_external_clock`** — lock the project tempo to a live source so beat-synced visuals follow
  the music: a Bpm knob writes the global tempo (`op('/').time.tempo`) and a Tap pulse beat-matches
  by ear (averaging taps into a BPM), driving every Beat CHOP downstream — `create_tempo_sync` and
  `create_autopilot` follow (CLI `clock-sync`). Validated live: the knob drives the global tempo
  (128→174) and taps are recorded. (Dedicated MIDI-clock / Ableton-Link sync is a planned
  follow-up.)
- **Signature VJ effects** — `create_strobe` (beat-syncable strobe/flash, square LFO → brightness;
  CLI `strobe`), `create_kaleidoscope` (N-fold radial mirror via a GLSL polar-fold; CLI
  `kaleidoscope`), `create_glitch` (RGB-shift + noise displacement, non-device default source; CLI
  `glitch`), `create_kinetic_text` (animated / beat-flashed lyric typography; CLI `kinetictext`).
- **Deeper musical reactivity** — `create_spectrum` (N-band FFT via an Audio Spectrum CHOP → a
  per-band Null for binding; CLI `spectrum`), `detect_onsets` (kick/snare/hat transient detection
  built from primitives — band RMS → moving baseline → threshold — with an optional `onset`
  WebSocket event; CLI `onsets`), `create_waveform` (time-domain oscilloscope; CLI `waveform`). The
  frequency / transient / time-domain complements to `extract_audio_features`.
- **Creation** — `create_color_grade` (lift/gamma/gain + saturation/hue + optional LUT; CLI
  `colorgrade`), `import_model` (3D model file → Geo/Camera/Light/Render, primitive fallback; CLI
  `model`), `create_shader_lib` (curated GLSL pack: tunnel/raymarch/fractal/metaballs/plasma; CLI
  `shaderlib`), `create_video_synth` (analog-synth lissajous/interference/scanline patterns; CLI
  `videosynth`), `create_depth_silhouette` (silhouette / body mask from a depth or video source,
  device-free default; CLI `silhouette`).
- **Live-performance ergonomics** — `create_panic` (instant Blackout + Freeze safety control; CLI
  `panic`), `create_clip_launcher` (Ableton-style grid of cue-trigger buttons, reusing manage_cue's
  recall/morph engine; CLI `launcher`).
- **AI prompts** — `text_to_shader` (author + validate a GLSL TOP from a description),
  `audio_to_show` (plan a full reactive set from a track), `auto_fix` (a detect → diagnose → fix →
  re-check repair loop).
- **CLI `doctor`** — a one-shot environment diagnostic (TD bridge, local LLM copilot, vault, config)
  with a plain-language pass/warn/fail report; the exit code reflects critical checks only.
- **Oscilloscope waveform + flash-to-transparent text** — `create_waveform` now renders a real scope
  LINE (CHOP-to-SOP → Geometry → orthographic Render TOP) instead of a brightness strip;
  `create_kinetic_text`'s flash modulates ALPHA so the text vanishes between flashes (over a
  background) instead of going black.
- **`create_external_io` output kinds** — `rtmp_out` (stream a TOP over RTMP via a Video Stream Out
  TOP — NVIDIA/Windows) and `artnet_out` (send a CHOP out as Art-Net/sACN via a DMX Out CHOP, for
  LED pixel-mapping & stage fixtures).
- **`bind_to_channel` smoothing** — optional `attack`/`release` (or `smooth`) seconds insert a Lag
  CHOP between the channel and the parameter, so reactivity follows a clean envelope instead of
  flickering on the raw signal.
- **`manage_cue` beat-quantized recall** — an optional `quantize` ("off"/"beat"/"bar") defers a
  recall/morph to the next musical boundary so scene changes snap to the beat.
- **`create_decks`** — DJ-style A/B decks blended by a master crossfader (Cross TOP) with per-deck
  gain; each deck pulls a source TOP or a built-in test source (CLI `decks`).
- **`detect_pitch`** (experimental) — monophonic pitch (Hz / MIDI note) from the FFT's dominant bin
  on a Null CHOP, for melody-reactive parameters (CLI `pitch`).
- **`learn_control`** (experimental) — interactive MIDI/OSC "learn": snapshot an input CHOP, then
  bind the control the artist just moved (CLI `learn`).

- **`render_output`** — save a TOP to an image file at its native, full resolution
  (PNG/JPG/EXR/TIFF), for exporting finished frames — unlike get_preview's small inline thumbnail.
- **`optimize_performance`** — scan a network for cook-time bottlenecks and report the slowest
  nodes with a concrete suggestion each; with apply:true, lower the flagged TOPs' resolution to
  reclaim GPU time.
- **`diff_snapshots`** — compare two snapshot_td_graph snapshots and return a readable diff:
  nodes added/removed, connection changes, and per-node parameter changes (before/after) — for
  versioning a patch or seeing exactly what an edit changed. Pure, offline analysis.
- **`list_recipes` / `apply_recipe`** — browse the built-in recipe library and instantiate a
  recipe by id in one call.
- **Keyboard / gamepad / mouse input** in `create_external_io` (`keyboard_in`, `gamepad_in`,
  `mouse_in`) — more control sources to bind to parameters.
- **CLI commands** `render`, `optimize`, `diff`, `recipes` and `recipe`.

- **`search_operators`** — keyword search over the embedded 629-operator knowledge base, ranked
  by relevance and fully offline, so the assistant can find the right operator ('what sends DMX?')
  instead of guessing a type. (Relevance ranking over names/descriptions/keywords — no embedding
  dependency.)
- **`document_network`** — read an existing network and return a readable map: counts by operator
  family/type plus a Mermaid flowchart of the data flow, for explaining or handing off a patch.
- **AI prompts**: `image_to_visual` (recreate a reference image's look in real nodes — multimodal),
  `tweak_visual` (plain-language adjustments → the right parameters), `critique_visual` (aesthetic +
  performance critique with concrete fixes), `vj_set_builder` (assemble a full reactive set), and
  `fix_shader` (diagnose a GLSL TOP compile error against TD's conventions).
- **CLI commands** `operators` and `document`.

- **`create_layer_mixer`** — a VJ layer mixer: 'crossfade' makes an A/B Cross TOP with a
  Crossfade knob, or composite inputs with a blend mode (add/difference/hardlight/glow/…).
  Sources come in via Select TOPs so they can live anywhere.
- **`create_video_player`** — a Movie File In player, or a playlist of clips through a Switch
  TOP, with live Play / Speed (and Clip) controls.
- **`create_3d_scene`** — a renderable 3D scene (Geometry + Camera + Light + Render TOP) for a
  sphere/box/grid, with RotateY (spin) and Zoom knobs.
- **`create_projection_mapping`** — wrap a source in a Corner Pin warp; drag the four handles
  to fit a physical surface, output ready for setup_output.
- **`create_keyframe_animation`** — animate parameters along a keyframed curve (time/value keys,
  linear or smooth easing), looping and synced to the timeline — choreographed motion beyond
  the animate_parameter LFO.
- **`create_simulation`** — GPU simulations: 'reaction_diffusion' (Gray-Scott, via the recipe)
  plus 'slime' and 'fluid' feedback flow-field looks, with a Decay knob.
- **CLI commands** `mixer`, `video`, `scene3d`, `mapping`, `keyframe` and `simulation`.

- **`manage_cue`** — a scene system: store / recall / list / delete named cues (snapshots of a
  COMP's custom parameters) and, crucially, **`morph`** to a cue — a timed, eased crossfade of
  every numeric control from the current look to the cue (via a small Execute DAT), so you can
  glide between looks instead of hard-cutting.
- **`create_macro`** — one macro knob (0–1) that drives many parameters at once, each remapped
  into its own [min,max] with an optional response curve — sweep a whole look from one fader.
- **`randomize_controls`** — randomize a COMP's numeric controls within their ranges, with an
  `amount` that blends toward random (a gentle nudge or a full scramble) — instant variations
  for improvisation. Non-numeric controls are left untouched.
- **`create_control_surface`** — build a playable panel (a Container COMP of widgets): vertical
  faders that drive parameters and buttons that recall or morph to cues. Open it in Perform mode
  for a touchable stage surface.
- **`create_phone_remote`** — serve a mobile web panel from a Web Server DAT: open a URL on your
  phone and every numeric control becomes a touch slider, no app to install. (Trusted networks
  only — it accepts writes without auth, like the bridge.)
- **OSC / MIDI output** in `create_external_io` (`osc_out`, `midi_out`) — send a CHOP's channels
  back out for bidirectional feedback to lighting desks, other apps or hardware.
- **CLI commands** `cue`, `macro`, `randomize`, `surface` and `remote` for the above.

- **`extract_audio_features`** — build an audio-analysis chain that exposes ready-to-bind
  reactive channels (overall level plus bass/mid/treble band energies) on a Null CHOP, with
  a Sensitivity knob. Source can be the live device (mic/line), an audio file, a synthetic
  oscillator (for testing without device permission), or an existing CHOP.
- **`create_tempo_sync`** — a Beat CHOP clock driven by TouchDesigner's global tempo,
  exposing beat-synced channels (`ramp`, `pulse`, `count`, `beat`, `bar`, `bpm`). With
  `emit_events` on, a CHOP Execute DAT broadcasts a **`beat` event** over the bridge
  WebSocket on every beat, so `tdmcp-agent watch` and the AI can react to the pulse live.
- **`bind_to_channel`** — the link that makes a visual react: drive any node parameter from
  a CHOP channel (an audio feature or a beat channel) by expression, with a scale and offset.
  Wires `extract_audio_features` / `create_tempo_sync` into a visual system.
- **`beat_reactive_designer` prompt** — guides the assistant through building the reactive
  chain and mapping audio features / the beat onto a visual system's parameters.
- **CLI commands** `audio-features`, `tempo-sync` and `bind` for the above.

- **`reload_bridge`** — hot-reload the bridge's Python inside the running TouchDesigner so
  edits under `td/` take effect without reopening the project (also `tdmcp-agent reload`).
- **`manage_checkpoint`** — store / restore / list / delete a full snapshot of a
  sub-network (an "undo point"). A checkpoint captures every node's constant parameters,
  the wiring and node positions; restoring reapplies parameters, recreates nodes deleted
  since (with their wiring) and prunes nodes created since. Complements `manage_presets`
  (which captures custom-parameter looks for performance) by snapshotting the whole network.
- **CLI `preview`** — capture a TOP straight to a PNG file (`-o/--out`).
- **CLI `watch`** — stream TouchDesigner bridge events (`node.created`, `node.cook`,
  `timeline.frame`, …) as ndjson until interrupted; `--include-high-frequency` opts into
  the per-frame events.
- **CLI: full Layer-1/Layer-2 coverage** — the agent now exposes the high-level generators
  and building blocks, not just Layer-3 CRUD: `visual`, `feedback`, `generative`,
  `particles`, `audio-reactive`, `dataviz`, `post-fx`, `output`, `plan`, plus `animate`,
  `arrange`, `connect`, `container`, `control-panel`, `io`, `glsl`, `chain`, `script`,
  `duplicate`, `component`, `preset`, `params` and `checkpoint`. Whole systems can now be
  scripted from a shell.
- **Obsidian vault integration** — bridge a folder of Markdown notes (set `TDMCP_VAULT_PATH`) and
  TouchDesigner, with path-traversal-safe IO and frontmatter parsing: `scaffold_vault` (a starter
  vault layout with worked examples), `save_recipe_to_vault` (capture a live network as a recipe
  note, merged into the recipe library), `apply_shader_from_vault` (build a GLSL TOP from a
  fenced-`glsl` note), `sync_presets_vault` (presets ↔ Markdown), `export_network_to_vault` (a
  Mermaid + `[[wikilink]]` patch map), `log_performance` (a dated show diary with snapshot +
  thumbnail), `import_setlist` (build a show from a setlist note's `tracks`), `bind_vault_text` (a
  Text DAT live-synced to a note) and `generate_from_moodboard` (seed `create_generative_art` from
  a palette/mood note).

### Changed

- **`create_3d_scene` instancing** — an `instances` param scatters N copies of the geometry over
  a grid via GPU instancing, with the camera framed to fit. `scale_variation` (0–1) gives each
  copy a random size via a per-point `pscale` attribute, and `spin` (deg/sec) rotates each copy
  over time through an `instancery` expression (validated live: a 3×3 grid renders with varied
  scale + spin).
- **`search_operators` semantic mode** — opt-in `semantic: true` re-ranks keyword candidates by
  embedding similarity through the configured LLM endpoint (`TDMCP_LLM_BASE_URL`/`_MODEL`), falling
  back to keyword ranking when unavailable. Candidate embeddings are cached in-memory (keyed by
  model, LRU-bounded), so within a session repeat searches only embed the new query, not the whole
  candidate pool. The default stays pure keyword (zero-config); for best results point
  `TDMCP_LLM_MODEL` at a dedicated embedding model (e.g. `nomic-embed-text`).

[0.3.0]: https://github.com/Pantani/tdmcp/releases/tag/v0.3.0

## [0.2.0] - 2026-05-26

Live control: generated systems are now playable instruments, not just static renders.

### Added

- **`create_control_panel`** — append custom parameters (sliders, toggles, menus, RGB,
  pulse) to a COMP and bind them to node parameters, so a generated system gets real knobs.
- **`animate_parameter`** — drive one or more parameters over time with an LFO
  (sine/triangle/ramp/square/pulse/random) between a min and max — movement without manual
  keyframing.
- **`manage_presets`** — store / recall / list / delete named snapshots of a COMP's
  parameter values, saved in the COMP's storage so they persist with the project.
- **`create_external_io`** — bridge to the outside world: OSC input and MIDI input mapped
  straight to parameters (control surfaces), DMX/Art-Net output for lighting, and
  NDI / Syphon-Spout video input.
- **`manage_component`** — save any COMP as a reusable `.tox` file and load it back, as an
  independent copy or a live-linked instance.
- **Auto-exposed control panels** on the artist generators: `create_feedback_network`
  (Feedback), `create_particle_system` (Drag/Turbulence/Gravity/Lifetime),
  `create_generative_art` (Speed), `create_audio_reactive` (Sensitivity) and
  `create_data_visualization` (Scale). Every generator now arrives playable. Pass
  `expose_controls: false` to opt out.
- **Recipe `controls`** field — recipes can declare a control panel (bind targets use recipe
  node names; they are resolved to real paths on build), plus a new
  **`performable_feedback_tunnel`** recipe that ships with Feedback/Zoom/Spin/Blur knobs.
- **Recursive `get_td_performance`** — measures cook time across the whole sub-network
  (including nested generated containers), returns the slowest nodes first, and is recursive
  by default.

### Fixed

- `create_feedback_network`'s `feedback_gain` was a silent no-op (it set a non-existent
  `gain` parameter on a Level TOP); it now sets `brightness1`, so the loop actually decays.

[0.2.0]: https://github.com/Pantani/tdmcp/releases/tag/v0.2.0
