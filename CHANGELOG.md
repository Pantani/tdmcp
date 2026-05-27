# Changelog

All notable changes to **tdmcp** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Follow-ups: finish the items deferred during the phased build (to be versioned alongside the next release).

### Added

- **`record_movie`** — record a TOP to a movie file (.mov/.mp4) or an image sequence via a
  Movie File Out TOP, with start/stop and an optional `seconds` auto-stop for capturing a
  fixed-length loop (CLI `movie`). Complements render_output's single frame.
- **`scaffold_show`** — create a starting skeleton for a live show (a master output Null + a
  tempo beat clock) so a set has a frame to build into (CLI `init`).
- **CLI `repl`** — an interactive mode that runs commands line-by-line (quotes preserved for
  JSON `--params`).

### Changed

- **`create_3d_scene` instancing** — an `instances` param scatters N copies of the geometry over
  a grid via GPU instancing, with the camera framed to fit (validated: a 3×3 sphere grid renders).
- **`search_operators` semantic mode** — opt-in `semantic: true` re-ranks keyword candidates by
  embedding similarity through the configured LLM endpoint (`TDMCP_LLM_BASE_URL`/`_MODEL`), falling
  back to keyword ranking when unavailable. The default stays pure keyword (zero-config); for best
  results point `TDMCP_LLM_MODEL` at a dedicated embedding model (e.g. `nomic-embed-text`).

## [0.8.0] - 2026-05-26

Robustness & export: render to disk, hunt bottlenecks, version patches, reuse recipes, more input.

### Added

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

[0.8.0]: https://github.com/Pantani/tdmcp/releases/tag/v0.8.0

## [0.7.0] - 2026-05-26

Intelligence: help the assistant discover, document, recreate, tune and critique work.

### Added

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

[0.7.0]: https://github.com/Pantani/tdmcp/releases/tag/v0.7.0

## [0.6.0] - 2026-05-26

Advanced creation: video, 3D, mixing, mapping, choreographed motion and simulations.

### Added

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

[0.6.0]: https://github.com/Pantani/tdmcp/releases/tag/v0.6.0

## [0.5.0] - 2026-05-26

Live performance: turn generated systems into instruments you can play on stage.

### Added

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

[0.5.0]: https://github.com/Pantani/tdmcp/releases/tag/v0.5.0

## [0.4.0] - 2026-05-26

Musical reactivity: turn audio and the beat into signals that drive visuals.

### Added

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

[0.4.0]: https://github.com/Pantani/tdmcp/releases/tag/v0.4.0

## [0.3.0] - 2026-05-26

Developer experience and a scriptable CLI: drive the whole toolset from a shell, stream
live events, and take undo points before risky edits.

### Added

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
