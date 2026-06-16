# Changelog

All notable changes to **tdmcp** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Creative RAG local (opt-in, experimental)** — a local-only creative
  repertoire of open-licensed artworks, artists and techniques. New
  `tdmcp creative-rag {sync|index|search}` CLI subcommand and read-only
  `tdmcp://creative/cards/{id}` + `tdmcp://creative/search?q=...` MCP
  resources. Ingests three live museum sources (Art Institute of Chicago,
  The Met, Rijksmuseum) plus ten planned-source stubs, embeds locally via
  Ollama (`nomic-embed-text`), and persists a local JSONL index. Every
  result carries source URL, license and rights notes through a coded
  license policy. Off by default; enable with `TDMCP_RAG_ENABLED=1`
  (`TDMCP_RAG_DATA_DIR`, `TDMCP_RAG_OLLAMA_URL`, `TDMCP_RAG_EMBED_MODEL`,
  `TDMCP_RAG_LICENSE_ALLOWLIST`). Repertoire context only — no bridge, DMX,
  or Python exec. See [Creative RAG](docs/CREATIVE_RAG.md).
- New runtime dependency `yaml` (license-policy / source-config parsing).

## [0.9.0] - 2026-06-10

The **hype-scout Round 4 campaign** — the complete external trend-driven
backlog (`_workspace/hype-scout/HYPE_TOOL_BACKLOG.md`) shipped as a single
release. Five themed waves of work are consolidated here: force multipliers,
top-5 quick wins, POP combos, the generative-AI bridge wave (including the
`create_ai_mirror` capstone), and the optional VFX aesthetic tail.

**28 new tools**, all live-verified against TD 099 build 2025.32820 /
bridge 0.6.1.

### Added — Hermes AI party POC
- **`tdmcp-agent ai-party`** — dry-runs a Telegram/Hermes-style show-control
  message through the existing AI Show Director policy runtime without creating
  a TouchDesigner context or touching hardware.
- **`tdmcp-agent ai-party telegram-once`** — processes one Telegram Bot API
  long-poll batch (`getUpdates` with message/callback updates), maps messages to
  bounded `ShowIntent`s, and replies with `sendMessage` status plus inline
  approve/deny buttons for queued effects.
- **`aiPartyGateway` / `telegramShowGateway` automation modules** — deterministic
  Hermes fallback parsing, raw Hermes candidate validation, audience/operator
  ACLs, malformed-output blocking, approval queue handoff, and Telegram reply
  formatting for the AI-controlled-party POC.

### Added — Live Nervous System AI Party rehearsal POC

- **`src/automation/aiPartyLive/`** — local dashboard/backend for the AI Party
  rehearsal loop: operator text, optional Ollama parsing, deterministic fallback
  parsing, policy decisions, approval queue, JSONL audit log, WebSocket
  dashboard snapshots, panic-safe handling and TouchDesigner health/preview
  endpoints.
- **`npm run ai-party:dev` / `dry` / `td-build` / `test` / `telegram`** — run the
  local dashboard, deterministic rehearsal smoke, optional TD demo-network
  builder, focused POC test suite and allowlisted Telegram long-poll path.
- **Simulation-first hardware boundary** — physical effects stay simulated by
  default; the TD builder creates `sim_dmx_table` and `dmx_out_disabled`, not a
  venue-ready DMX output.

### Changed — Package distribution
- **npm package publishing** — `@dpantani/tdmcp` remains the public npm package
  identity for `0.9.0`, with explicit public scoped publishing. Runtime version
  detection also accepts the unscoped `tdmcp` name so local/dev metadata cannot
  fall back to `0.0.0`.

### Added — Force multipliers (D.0)
- **`create_external_io` outbound modes** — new `ndi_out` and
  `syphon_spout_out` modes (Layer 2). KB-confirmed stock TOPs
  (`ndioutTOP`, `syphonspoutoutTOP`). The universal "push a TOP out to
  StreamDiffusion / ComfyUI / MediaPipe-Spout-loopback" plumbing.
- **`dropExternalTox` helper** (`src/tools/util/dropExternalTox.ts`) —
  standardizes the dotsimulate TOX-drop pattern. Internal helper;
  consumed by every Wave-4 wrapper.
- **`build_pop_chain`** — Layer-2 builder for ordered POP chains over
  the 77-kind curated subset of TouchDesigner's new point-operator
  family. Safe-default params per POP type sourced from the knowledge
  base; fail-forward warnings; `extra_inputs` with special-cased par
  binding for the lookup family (`lookup_texture_pop` → `par.top`,
  `lookup_channel_pop` → `par.chop`).

### Added — Top-5 quick wins (D.1)
- **`create_pose_controlnet_driver`** (Layer 1) — OpenPose-color
  skeleton renderer over the existing `createPoseTracking` /
  `createPoseSkeleton` pose stack. ControlNet-ready RGB TOP; optional
  `output_mode: "syphon_spout" | "ndi"` routing through the FM-01
  outbound modes.
- **`create_ascii_render`** (Layer 1) — character-grid TOP, sibling of
  `create_dither` / `create_halftone`. Three color modes
  (`mono` / `source-color` / `two-color`), default phosphor-green;
  configurable charset and cell size.
- **`create_phrase_locked_cue_engine`** (Layer 1) — extension over
  `createSyncExternalClock`: quantizes cue triggers to the next
  musical phrase boundary (1/2/4/8/16/32/64 bars). Two quantize modes
  (`next` / `aligned`), FIFO queue, local Beat CHOP so it composes
  without a tight upstream binding.
- **`create_audio_glsl_uniforms`** (Layer 2 helper) — binds named audio
  CHOP channels to a target `glslTOP`'s `seq.vec` uniform slots via
  Python expressions. Reuses the `createGlslShader` seq.vec precedent.

### Added — POP combos (D.3)
- **`create_pop_particle_system`** (Layer 1) — 4-stage POP particle
  system (particle → feedback → lookup_texture force → field).
- **`create_pop_growth`** (Layer 1) — POP-native reaction-diffusion /
  growth presets, three modes (`dendritic` / `coral` / `lichen`).
- **`create_pop_lines_pointcloud`** (Layer 1) — plexus-style line web
  via `neighbor_pop` + downstream Script SOP line emission.
- **`create_depth_pop_field`** (Layer 1) — depth-driven POP scatter
  with explicit depth path or auto-spin `setup_segmentation` (MediaPipe).
- **`create_stipple_pointcloud`** (Layer 1) — density-from-luminance
  stipple via `lookup_texture_pop`; `bw_dots` / `colored_dots` /
  `random_jitter` modes.

### Added — Generative-AI bridge wave (D.2)
- **`drive_streamdiffusion`** — dotsimulate StreamDiffusionTD .tox
  wrapper via the `dropExternalTox` helper; FM-01 outbound binding;
  synthetic noiseTOP source fallback.
- **`setup_mediapipe_plugin`** — torinmb mediapipe-touchdesigner
  canonical .tox EXTENSION over the stock `setup_*_tracking` family.
- **`create_depth_from_2d`** — TDDepthAnything v2 wrapper; RGB-in →
  depth-TOP-out.
- **`create_gaussian_splat_scene`** — Anglerfish-graphics TDGS .tox
  wrapper (top trend of Round 4, 4-surface unanimous H).
- **`create_ai_mirror`** — **CAMPAIGN CAPSTONE** COMBO recipe: camera
  input → `drive_streamdiffusion` → output binding → control panel.
  Three source modes (synthetic/camera/existing_top), three output
  paths (internal/syphon/ndi). Graceful degradation when SD's .tox
  isn't installed: builds the full skeleton anyway and surfaces the
  SD friendly message as a warning.
- **`connect_comfyui`** — ComfyUI bridge (Layer 2). Two modes:
  `tox_drop` (olegchomp/TDComfyUI or JiSenHua/ComfyUI-TD .tox) and
  `webclient` (stock webclientDAT POST + workflow JSON).
- **`connect_daydream_cloud`** — Daydream Cloud-hosted StreamDiffusion
  (Layer 2). Skips the local GPU/CUDA gate. Env-only API key.
- **`create_llm_chain`** — LLM connector (Layer 2). Two modes
  (`tox_drop` dotsimulate LOPs or `webclient` OpenAI-compatible) and
  four providers (`openai` / `anthropic` / `ollama` / `custom`).
  All API keys are env-only — Node never touches the values.

### Added — VFX aesthetic tail (D.5)
- **`create_slit_scan`** (Layer 1) — time-slice slit-scan render via
  cacheTOP, sibling of `create_time_echo`.
- **`create_chrome_blobs`** (Layer 1) — liquid-chrome / metaball
  preset stack (noise → blur → threshold → glslTOP chrome env →
  composite).
- **`create_vintage_lens`** (Layer 1, extension over
  `applyPostProcessing`) — lens / CA / vignette preset.
- **`create_reaction_diffusion`** (Layer 1) — Gray-Scott RD wrapper
  over the shipped `recipes/reaction_diffusion.json`. Canonical
  `seq.vec` uniform binding pattern; LUT palette chain wrapped in
  fail-forward so the RD core ships even if rampTOP par naming varies.
- **`create_pixel_sort`** (Layer 1) — threshold pixel-sort glslTOP.
- **`create_volumetric_field`** (Layer 1) — 3D-texture feedback stack
  (multiple 2D slices via cacheTOP + glslTOP stack walker with
  Beer-Lambert alpha accumulation). Explicitly **not** a raymarcher.
  Six baked palettes.
- **`create_voxel_stack`** (Layer 1) — isometric voxel-stack render
  rig with `mergeCHOP` instance-channel combiner.
- **`create_facade_mapping`** (Layer 1) — multi-projector blend
  skeleton; per-projector brightness exposed.

### Improved — FM-02 hardening + bridge installer layout
- **TS-side `toxCandidatePrecheck` helper**
  (`src/tools/util/toxCandidatePrecheck.ts`) — when all candidate
  `.tox` paths are absolute AND none exist on disk, every wrapper
  short-circuits with a friendly error in milliseconds with **NO
  bridge call**. Closes the entire class of "TD hangs when the user
  doesn't have the .tox installed" bugs that surfaced during the
  AI-bridge wave's live QA. Project-relative candidate defaults were
  stripped from `drive_streamdiffusion`, `create_gaussian_splat_scene`,
  `connect_comfyui`, and `create_llm_chain` so the precheck always
  short-circuits when nothing is installed.
- **`dropExternalTox` fail-fast** — incomplete bridge reports
  (missing `found_path` / `container_path`) now return a friendly
  error instead of being silently coerced to `{ok: ...}` with empty
  paths.
- **Bridge installer node layout** (`td/modules/mcp/install.py`) —
  the installed bridge COMP's inner nodes (`callbacks`, `webserver`,
  `webserver_callbacks`, `events_hook`, `error_log`,
  `error_log_callbacks`) are now positioned in a fixed, legible
  arrangement instead of stacking at the origin.

### Fixed (rolled up across the campaign)
- `build_pop_chain` `extra_inputs` wiring no longer raises
  `IndexError` on `lookup_texture_pop` / `lookup_channel_pop`. These
  fixed-arity POPs take their secondary source via a par reference
  (`par.top` / `par.chop`), not an input connector.
- `build_pop_chain` payload script uses `.get()` defaults for
  `defaults_map` and `unverified_note` — direct low-level callers no
  longer crash with `KeyError`.
- `drive_streamdiffusion` synthetic source fallback: noiseTOP when
  `source_top_path` is absent (was a bare moviefileinTOP that
  prompted a macOS file-chooser modal → TD hang).
- `create_ai_mirror` graceful-degradation path when SD `.tox` is
  missing: build the full skeleton + control panel, surface the SD
  friendly error as a warning. Slider COMPs are now initialized from
  `args.strength` / `args.cfg` before `.expr` bindings are applied
  (was drifting from caller-specified values). Precheck-missing
  detector narrowed to `\bno_candidate_found\b` to avoid masking
  unrelated errors.
- `create_llm_chain` — Python escape: `"# prompt mirror\n"` /
  `"# response mirror\n"` were emitting real LF characters and
  unterminating the Python string literal; the escape is now
  double-backslashed. TD optype `datExecuteDAT` (camelCase) → the
  actual `datexecuteDAT`. webclientDAT par names corrected
  (`requestmethod` → `reqmethod`; dropped non-existent
  `asynchronous` / headers DAT par / request data DAT par writes —
  webclientDAT is async by default via its callbacks and body content
  goes through the body_builder textDAT).
- `create_stipple_pointcloud` geometryCOMP par names corrected
  against TD 099 (`pointcloudpop` → `instancepop`; `pointsize` →
  `instancesx/y/z` scale as the dot-size proxy).
- `create_pop_particle_system` — prepend a `point_generator_pop`
  seed before `particle_pop` to satisfy its required emitter input
  (clears the "Not enough sources" cook warning). Now also stops on
  `chainResult.isError` instead of silently continuing.
- `create_voxel_stack` optype casing: `topToCHOP` → `toptoCHOP`.
  Multiple `connect(*, nullCHOP)` calls replaced with a `mergeCHOP`
  combiner so all instance channels (tx / tz / ty / sy / colorTop)
  reach the instancing path together.
- `create_reaction_diffusion` — container_path is threaded through
  the overlay payload from `buildFromRecipe`'s actual container
  instead of being reconstructed from `args.name` (recipe-id-derived
  names differ from caller-supplied names). GLSL uniform binding now
  uses the canonical `seq.vec.numBlocks + setattr(g.par,
  'vec<i>name', ...)` pattern (mirrors `createGlslShader.ts`
  L115-117). rampTOP LUT key-par setting wrapped in fail-forward
  try/except.
- `create_slit_scan` — `_g.par.seq.vec.numBlocks` →
  `_g.seq.vec.numBlocks` (the `seq` property is on the operator, not
  via `par`).
- `create_facade_mapping` — missing `await` on `builder.add` in the
  `existing_top` source-mode branch.
- `create_depth_from_2d` — `executePythonScript` second argument is
  now `true` so the success-path bridge response carries stdout for
  `parsePythonReport`.
- `create_phrase_locked_cue_engine` — `parameterexecuteDAT
  "flush_exec"` is now bound to the container via `op:
  builder.containerPath` + `pars: "Flush"` so it actually receives
  the Flush parameter pulses.
- `create_pixel_sort` — Iterations control `type` corrected from
  `"float"` to `"int"` to match the schema.
- `drive_streamdiffusion` schema description corrected — the
  `source_top_path` is a filesystem video/image file path (used to
  set `moviefileinTOP.file`), not a TouchDesigner operator path.

### Verified
All 28 features were live-cooked against TD 099 build 2025.32820 /
bridge 0.6.1 at release time. Offline gates: typecheck + build +
biome + vitest (3946 pass) + validate:recipes (32) + test:bridge
(196).

### Added

- **AI-Controlled Party producer POC runner** — `tdmcp-agent ai-party-poc`
  runs the closed-rehearsal proof in dry-run/simulated mode: text/transcript
  fan-in, `ShowIntent` policy decisions, approval queue state, audit log,
  optional auto-approval into simulated effect events, and zero hardware plans.
  Fixtures live under `tests/fixtures/show-director/` and are pinned by
  `tests/unit/showDirectorFixtures.test.ts`.

## [0.8.3] - 2026-06-03

### Fixed
- **`create_histogram_scope`** — geometry now renders a proper distribution
  curve instead of a stray hairline at the far left. The `choptoSOP` was fed
  only a `ty` channel, so TD warned `Channel "tx"/"tz" not found` and
  collapsed every point to x=0. The build now synthesises `tx` (Pattern CHOP
  ramp -1..+1 over `bins` samples) and `tz` (Pattern CHOP constant 0) and
  merges them with the existing `ty` via a Merge CHOP. The shader also
  normalises counts by the total tap count so heights stay inside the
  orthographic camera's Y range.
- **`create_control_panel`** — an `rgb` control with exactly 3 `bind_to`
  targets now actually drives those parameters (each component → one target)
  instead of dropping the binding with a warning. Restores live
  `TraceColor` reactivity for `create_histogram_scope` and other scopes.
- **`setup_face_tracking` / `setup_hand_tracking` / `setup_segmentation`** —
  robust JSON DAT / mask TOP lookup. The torinmb mediapipe-touchdesigner
  engine has renamed its outputs across versions (e.g. `face` →
  `face_landmarks` → `face_landmark_results`); the tools now probe a
  priority-ordered candidate list and fall back to a regex scan so a future
  rename does not silently break setup.

### 2026-06-02 — Wave 12 (live-show resilience + LLM token budget + CLI ergonomics)

#### Added

- **`create_safety_blackout_chain` (Layer 1)** — single-toggle kill / dimmer chain for live shows: master `mathCHOP` (mult), pre-output `levelTOP` (opacity), and panic CHOP exposed as one control. ALLOW_EXEC=0 safe — composes via existing structured tools, no raw Python. CLI: `tdmcp-agent layer1 safety_blackout_chain`.
- **`create_setlist_runner` (Layer 1)** — declarative setlist sequencer wrapping `timerCHOP` + index switch + cue table for show-time scene advancement with hold/loop/jump controls. CLI: `tdmcp-agent layer1 setlist_runner`. (Live UNVERIFIED: Timer CHOP `cycle` writability.)
- **`create_show_failover` (Layer 1)** — A/B render-path failover with `lookupCHOP` health routing and automatic switch on cook errors; survives a single-source failure mid-show. CLI: `tdmcp-agent layer1 show_failover`. (Live UNVERIFIED: Lookup CHOP table format.)
- **`create_pose_reactive` (Layer 1)** — closes ROADMAP A.6: body-skeleton-driven reactive network (pose landmarks → analyze → modulation bus) usable with the MediaPipe TD plugin or any landmark CHOP source. CLI: `tdmcp-agent layer1 pose_reactive`.
- **`auto_repair_loop` (Layer 2)** — driver that scans `get_td_node_errors`, applies safe known-good fixes (param resets, reconnects), and reports a structured repair log. CLI: `tdmcp-agent layer2 auto_repair_loop`. (Live UNVERIFIED: Lookup CHOP table format used for routing.)
- **`compact_graph_digest` (Layer 3) + `tdmcp://digest/{path}` resource** — token-bounded structural digest of a TD subtree (families, fan-in/out, cook hotspots) usable by the basic-tier local-LLM copilot as a first-choice inspection tool. CLI: `tdmcp-agent digest <path>`. Now registered in `LLM_TOOLS` (basic tier). (Live UNVERIFIED: Info CHOP `total_cooks` channel name.)
- **`scaffold_recipe_from_network` (vault tool)** — inverse of `apply_recipe`: serialize an existing TD subtree into a `RecipeSchema`-valid JSON template (nodes, connections, exposed controls) and write it into the vault. CLI: `tdmcp-agent vault scaffold_recipe_from_network`.
- **`POST /api/param_modes/batch` bridge endpoint + `readParameterModesBatch` client** — typed batch read of parameter expression/bind/export modes for many nodes in one round-trip (Zod-validated envelope). Replaces N-way `exec`-loop pattern; falls back to exec on older bridges.
- **`tdmcp init` CLI** — `tdmcp init [--dry-run] [--yes] [--json]` first-run scaffold for artists: writes a sensible `tdmcp.config.json`, suggests a profile, and prints next-step doctor hints.
- **`tdmcp ask` CLI** — `tdmcp ask "<question>"` thin shell over the local-LLM copilot (basic-tier tool subset, including the new `compact_graph_digest`) for one-shot questions without launching a chat loop.

#### Changed

- **`create_audio_reactive` — opt-in transient gate + sidechain duck modulation bus.** New flags `transient_gate`, `transient_threshold`, `transient_hold_ms`, `sidechain_duck`, `duck_depth`, `duck_release_ms` add a `transient` `analyzeCHOP` (function=8), `transient_hold` / `duck_env` `filterCHOP`s, a `duck` `mathCHOP`, and merge into a `mod1` `nullCHOP` modulation bus that downstream tools can `bind_to_channel`. **Backward-compat:** all defaults preserve the prior byte-identical container; existing tests, recipes, and CLI callers omitting the new fields keep working (impl now re-parses `z.input<schema>` internally). When `expose_controls=true`, the four new knobs (Transient Threshold, Transient Hold (ms), Duck Depth, Duck Release (ms)) appear on the controls panel. (Live UNVERIFIED: transient detector operator type, Filter CHOP ramp-unit semantics.)
- **`set_perform_mode` — promoted to typed `POST /api/perform` REST endpoint** with Zod-validated `performMode` snapshot in the response. Exec fallback preserved for older bridges. (Live UNVERIFIED: `project.performMode` writability via the new endpoint.)

#### Internal

- **`familyOf(type)` lifted to `src/resources/familyOf.ts`** — shared helper now imported by both `sceneSummary.ts` and the new `graphDigest.ts` resource; removes a hand-duplicated copy and keeps family-classification logic single-sourced.

#### Notes

QA report `_workspace/04_qa_wave12.md` — all four PR gates green (typecheck, build, biome, vitest 3690 tests), recipes 31/31 valid, bridge tests 182 pass, cross-boundary coherence PASS. Four live-only items remain UNVERIFIED-pending-bridge (Lookup CHOP table format; Timer CHOP `cycle` writability; Info CHOP `total_cooks` channel name; `project.performMode` writability) — to be probed in a live TD session before the next tagged release.

## [0.8.2] - 2026-06-02

### Added

- **First-party recipe `audio_reactive_basic`** (8 nodes, 6 connections, 2
  exposed controls) — minimal audio-in → analyze pattern from
  `create_audio_reactive`: `audiodeviceinCHOP` fans out to an
  `audiospectrumCHOP` (outlength 256) and an `analyzeCHOP` RMS, with a
  `nullCHOP` for stable downstream `bind_to_channel` and a `choptoTOP` +
  `levelTOP` Sensitivity stage publishing the spectrum texture. A
  `constantTOP` placeholder is wired to `nullTOP` out and ready for the
  artist to bind its colorr expression to `op('level_null')['chan1']`.
  Offline-validated against `RecipeSchema`; live cook-check pending
  (UNVERIFIED).
- **First-party recipe `keyframe_animation_basic`** (5 nodes, 3 connections,
  2 exposed controls) — Animation COMP showcase paralleling
  `create_keyframe_animation`: `animationCOMP` (artist authors 2 channels
  `tx`/`ty` with 5 keys each in the Animation Editor) feeds a `speedCHOP`
  for global playback rate, wrapped by a `nullCHOP` for stable channel refs,
  with a `constantTOP` target ready for `op('anim_null')['tx']`-style
  expressions. Foundation for declarative camera/object motion. Manual-wire
  documented inline. Offline-validated against `RecipeSchema`; live
  cook-check pending (UNVERIFIED). Total: 31/31 recipes valid.
- **First-party recipe `pose_skeleton_standalone`** (8 nodes, 1 connection, 1
  exposed control) — placeholder skeleton renderer for `create_pose_skeleton`
  with a built-in Table DAT of 8 static landmarks (head/shoulders/hips/hands/
  feet) feeding a Script SOP that draws joints + bones through a `lineMAT`,
  rendered via `geometryCOMP` + `cameraCOMP` + `renderTOP`. Foundation for any
  custom pose source (Kinect, OSC, file playback) without depending on the
  torinmb MediaPipe plugin. Offline-validated against `RecipeSchema` via
  `npm run validate:recipes`; live cook-check pending (UNVERIFIED).
- **First-party recipe `particle_system_basic`** (8 nodes, 1 connection, 3
  exposed controls) — foundational `create_particle_system` template: an 8×8
  `gridSOP` emitter feeds a `particleSOP` with a constant force CHOP for
  gentle vertical drift, rendered through `pointspriteMAT` + `cameraCOMP` +
  `lightCOMP` + `renderTOP`. Live controls expose BirthRate, Lifetime, and
  ForceY. Offline-validated against `RecipeSchema`; live cook-check pending
  (UNVERIFIED). Total: 29/29 recipes valid.
- **First-party recipe `feedback_network_basic`** (6 nodes, 6 connections, 2
  exposed controls) — minimal recursive feedback pattern (noise seed →
  `compositeTOP` operand=maximum + `feedbackTOP` → `blurTOP` → `levelTOP`
  brightness1 decay → `nullTOP`), the standalone showcase of
  `create_feedback_network`. Offline-validated against `RecipeSchema` via
  `npm run validate:recipes`; live cook-check pending.
- **First-party recipe `glsl_shader_basic`** (2 nodes, 1 connection, 4 GLSL
  uniforms exposed as controls) — single `glslTOP` with inline plasma fragment
  shader mixing layered sines across a two-color gradient (`uTime`, `uScale`,
  `uColorA`, `uColorB`), the showcase of `create_glsl_shader`. `uTime` needs a
  one-line manual binding to `absTime.seconds * speed` after import (schema
  parameters take constants only). Offline-validated against `RecipeSchema`;
  live cook-check pending.
- **First-party recipe `kinetic_text_audio_reactive`** (7 nodes, 5
  connections) wiring `text` → `transform` → `level` → `out` alongside an
  audio band-split chain (`audioin` → `bass` → `analyze1`). Recipe delivers
  the nodes + connections offline-valid; the final audio→brightness binding
  is manual after import (set `level1.brightness1` to expression
  `op('analyze1')['chan1']*pulse_gain`), since `RecipeSchema` parameters
  only accept constant values. Offline-validated against `RecipeSchema` via
  `npm run validate:recipes`; live cook-check pending.
- **First-party recipe `decks_layer_mixer`** (6 nodes, 5 connections, 2
  exposed controls) — two decks with per-deck gain summed through a composite
  mixer, the schema pattern shared by `create_decks` + `create_layer_mixer`.
  Offline-validated; live cook-check pending.
- **First-party recipe `depth_displacement_post`** — synthetic depth map warps
  a ramp source through a Displace TOP, then a post stack (blur + level grade)
  finishes it; runs with zero hardware. Offline-validated; live cook-check
  pending.
- **First-party recipe `kinetic_text_path_follow`** — manual-wiring template
  for kinetic text following a deterministic circular path driven by two sin/cos
  LFO CHOPs (placeholder for a future native path-follow extension).
  Offline-validated; live cook-check pending.
- **First-party recipe `optical_flow_particles`** — live video drives an
  optical-flow vector field that pushes a GPU particle system, producing
  motion-reactive trails. Offline-validated; live cook-check pending.
- **First-party recipe `mediapipe_face_overlay`** (11 nodes, 5 connections,
  5 exposed controls) — manual-wire template that mirrors what
  `setup_face_tracking` (v0.8.1) builds: a webcam background dimmed via
  `levelTOP`, a `selectCHOP` pointed at the MediaPipe face-adapter CHOP
  driving an instanced dot SOP through a `geometryCOMP` + `renderTOP`,
  composited over the camera with a final tint. Offline-validated against
  `RecipeSchema`; live cook-check pending.
- **First-party recipe `scene_timeline_demo`** (9 nodes, 6 connections, 4
  exposed controls) — declarative show-clock demo mirroring the
  `create_scene_timeline` Layer-1 orchestrator: a `timerCHOP` playhead +
  null + segments `tableDAT` driving three scenes (noise / radial ramp /
  violet hold) blended through chained `crossTOP`s with play/rate/fade
  knobs. Offline-validated; live cook-check pending. Recipe count: 15 → 22.
- **First-party recipe `scene_3d_basic`** (6 nodes, 1 connection, 3 exposed
  controls) — foundational `create_3d_scene` template: `geometryCOMP` holding
  a `sphereSOP` (render+display flagged) + `cameraCOMP` (tz=5) + `lightCOMP`
  + `renderTOP` → `nullTOP`. Starting-point for 3D visuals; bind RotateY to
  a tempo ramp or audio feature manually after import (`RecipeSchema`
  parameters take constants only). Offline-validated against `RecipeSchema`;
  live cook-check pending.
- **First-party recipe `video_synth_oscillator`** (2 nodes, 1 connection, 5
  GLSL uniforms) — procedural Lissajous oscillator color synth mirroring
  `create_video_synth` lissajous mode: a `glslTOP` (1280×720) drawing two
  sine oscillators as a glowing curve with `uTime` / `uScale` / `uFreqX` /
  `uFreqY` (vectors page) and `uColor` (colors page) uniforms exposed via
  `glsl_uniforms`. Bind `uTime` to `absTime.seconds * Speed` manually after
  import to animate. Offline-validated; live cook-check pending.
- **First-party recipe `kinetic_text_standalone`** (5 nodes, 3 connections,
  4 exposed controls) — text-only showcase of `create_kinetic_text` styles
  without audio binding: `textTOP` → `transformTOP` (scale pulse) →
  `levelTOP` (opacity fade) → `nullTOP`, with a sine `lfoCHOP` wired in as
  the breathing driver. Bind `sx`/`sy` and `opacity` to LFO expressions
  manually after import. Offline-validated; live cook-check pending. Recipe
  count: 22 → 25.
- **`repair_network` snapshot + rollback.** The repair loop now captures
  `(par.path, par.mode)` and `(op.path, op.bypass, op.display)` before each
  applied step. After the post-repair error recheck, if `errors_after >=
  errors_before` and the run is not a dry-run, the snapshot is restored in
  reverse order, applied steps are marked `reverted: true`, and the report
  carries a new `rolled_back: true` flag with a "rolled back" line in the
  summary text. Old reports without the flag remain compatible.
- **New bridge endpoint `POST /api/transport`** for timeline control
  (play / pause / seek / cue / rate). Lives in
  `td/modules/mcp/services/transport_service.py` with controller wiring in
  `td/modules/mcp/controllers/api_controller.py`. Not gated by
  `TDMCP_BRIDGE_ALLOW_EXEC` — works on a hardened bridge. Client-side
  envelope is `TransportStateSchema` in `src/td-client/validators.ts` and
  `client.controlTimelineTransport(...)` in
  `src/td-client/touchDesignerClient.ts`. Bridge Python tests: +13
  (`test_transport_service.py` covers play/pause/seek-clamp/cue
  known/cue absent/rate/error paths; `test_api_controller.py` adds
  dispatch + missing-action tests).

### Changed

- **Release workflow keeps npm manual by default.** Tag pushes still run the
  release gates, build/upload `tdmcp.mcpb`, and create the GitHub Release. npm
  publish now requires both `TDMCP_AUTO_NPM_PUBLISH=true` and `NPM_TOKEN`, so the
  normal 0.8.2 handoff can keep npm / mcp-publisher as manual follow-up steps.
- **`control_timeline_transport` now prefers the REST endpoint.**
  The tool now calls `client.controlTimelineTransport(...)` via
  `tryEndpoint`, falling back to `executePythonScript` only on endpoint
  miss. Output shape preserved; existing callers unaffected. Bridge
  promotion wave-2 (G4 / v1.0 Consolidation).
- **Coverage gate bumped: `functions: 77 → 80`** in `vitest.config.ts`.
  Wave-3 measured Fn 83.60% globally (margin > 3pp); other thresholds
  (statements 84 / branches 70 / lines 85) kept at current values
  pending coverage wave-4 on the CLI surface (`src/cli/agent.ts`,
  `src/cli/tui.ts`).
- **`snapshot_td_graph` prefers REST endpoint for parameter modes.** When
  `include_modes: true`, the tool now calls `client.readParameterModes` via
  the `tryEndpoint` REST-first / exec-fallback pattern instead of going
  through `executePythonScript` directly. The output shape is preserved
  (normalized via `normalizeParameterModes`), so existing callers are
  unaffected. Bridge promotion wave-1 (G4 / v1.0 Consolidation).

### Fixed

- **`detect_pitch` notes/threshold consistency:** the user-facing `notes`
  string now advertises the actual hard-coded `DEFAULT_THRESHOLD = 0.0005`
  instead of the stale `0.02`. The gate magnitude was already correct; this
  fixes the "near-zero default threshold" symptom from the v1.0 honesty pass
  by reconciling the docstring (not the constant).

### Tests

- **`tests/unit/detectPitch.test.ts`** — pinned that `gate.boundmin` and the
  exposed `Threshold` knob default share the same magnitude (`0.0005`), and
  pinned that the user-facing `notes` string matches that magnitude (the
  earlier `it.fails` marker is now a regular green `it(...)`, removed once
  the docstring was reconciled).
- **`tests/unit/createEnvelopeFollower.test.ts`** — added a sidechain
  routing topology assertion: in `mode: "duck"`, the generated Python script
  wires source → select → lag → invert → clamp → null, binds the configured
  target's parameter to the duck output via an `op(...)[...]` expression
  (using a robust `rfind('.')` split so paths with dots work), and sets the
  target parameter mode to `EXPRESSION`.
- **`tests/unit/vaultRoundTrip.test.ts`** (new) — proves the vault-codec
  round-trip (`recipeToMarkdown` ↔ `recipeFromMarkdown`) is deterministic
  and fixed-point under real filesystem `Vault.write` / `Vault.read`,
  preserves verbatim value-resolution parameters (e.g. `value: "noise1"`),
  and that `RecipeLibrary` reads back what we wrote.
- **`tests/unit/setlistRunner.test.ts`** — coverage wave-3 added 22 new
  tests (17 → 39) covering `resolveStart` warnings, `quantize=bar`
  forwarding, scene-recipe/preset info paths, beat mode without
  `beatSource`, prev/goto signals with valid + invalid targets, step
  preemption across stop/next/prev/goto, generic `TdError` (non-connection)
  and non-`Error` thrown values, manual mode `elapsed` path, empty setlist,
  `parseSetlistInput` `.markdown` / no-filename / malformed YAML branches,
  and `loadCanonicalSetlist` JSON failure.
- **`tests/unit/snapshotTdGraph.test.ts`** — added two assertions for the
  REST promotion: "prefers /api/nodes/:seg/params" (asserts exec was NOT
  called) and "falls back to /api/exec when the REST endpoint is missing"
  (asserts exec WAS called).

### Docs

- Added the **Tool API contract** reference page
  (`docs/reference/tool-contract.md`) documenting the invariants every MCP
  tool follows (naming, input schema, error handling, offline behaviour,
  result shape, deprecation) and that will be frozen at 1.0. Linked from the
  EN reference sidebar.
- **Roadmap honesty pass:**
  - Rewrote the *Experimental & needs validation* section into four honest
    buckets (live-music tuning, hardware round-trip pending, multimodal-LLM
    dependent, rollback tuning), split the signal-detection bullet, and
    declared `sync_external_clock` `mode='tap'` as stable.
  - Removed `repair_network` from the multimodal-LLM-gated bullet in *Out of
    scope* (its remaining hardening is offline rollback-regression testing).
  - Reconciled the *Planning archive*: parágrafos A.3 e A.6 now reflect that
    `packages_cli_help_and_completion_parity`, `no_color_flag_is_dead`,
    MediaPipe face/hand/segmentation and `create_strange_attractor` shipped
    in earlier releases; removed the duplicate Round-2 `param_changed_event`
    row; moved Round-3 hardware/GPU/cloud/multi-machine/paid-license rows
    (`create_machine_sync`, `create_depth_from_2d`, `create_sensor_input`,
    `create_laser_output`, `create_multitouch_surface`, `drive_diffusion_tox`,
    `create_lidar_reactive`, `create_volumetric_fire`, TouchEngine headless
    path) into *Out of scope* under explicit Round-3 bullets.
  - Expanded the *v1.0.0 — Consolidation* section with ready/blocked criteria
    per frente (tool API contract, docs & guides, coverage, recipes, bridge
    hardening).

## [0.8.1] - 2026-06-02

### Added

- **Persistent AI session profile is now part of the public MCP surface:**
  `load_session_profile` is registered with the rest of the tools, and
  `tdmcp://session/profile` is registered with the resources. Agents can now
  load the local taste/conventions/recent-work snapshot that the docs already
  referenced. Tool registry: 278 → 279.

### Fixed

- **Artist-owned writes and package state are atomic.** Vault note writes,
  vault binary writes and the package registry JSON now use a write-temp-then-
  rename helper that preserves existing file permissions and cleans up failed
  temp files. Package installs now extract into a sibling incoming directory and
  only replace the staged install after a successful extract, so transient
  download or extraction failures no longer destroy the previous working copy.
- **HTTP transport startup fails cleanly.** `tdmcp serve --http` now rejects
  `listen()` errors such as `EADDRINUSE` instead of surfacing them as unhandled
  process-crashing events; it also closes the event stream on listen failure and
  closes per-session MCP servers when an initialize request fails before session
  registration completes.
- **Bridge fallback policy is centralized.** New `tryEndpoint()` keeps the
  endpoint-first / exec-fallback behavior for older TouchDesigner bridges, while
  still surfacing validation errors, connection failures and unrelated throws
  unchanged. `read_parameter_modes`, `set_dat_content`, `edit_dat_content` and
  `disconnect_nodes` now share that tested helper.
- **Transient GET retries cover bridge 5xx API errors.** Read-only bridge
  requests now retry `TdApiError` responses with status >= 500, matching the
  existing transient retry policy without retrying side-effecting POSTs.

### Changed

- `KnowledgeBase.searchOperators` caches per-operator search haystacks, the
  cookbook resource caches successful EN/PT reads, and the server defers the
  synchronous warmup log so transports can begin accepting connections sooner.

## [0.8.0] - 2026-06-02

### Added

- **AI Show Director (dry-run policy layer):** an MCP-level policy wrapper that
  evaluates show-directing tool calls in dry-run mode before execution, returning
  the planned action + rationale so artists can preview an AI-driven set without
  the bridge touching the network. Backed by `tests/unit/showDirector.test.ts`.
- **Top-level CLI completion/package parity:** `tdmcp completion <bash|zsh|fish>` now
  prints a static completion snippet for the primary binary, including the
  package-manager shortcuts (`search`, `list`, `info`, `install`, `uninstall`,
  `doctor`, and `packages path`) and their common flags. `tdmcp --help` now also
  lists those package subcommands directly instead of hiding them behind one
  summary row, and `tdmcp packages --help` prints package-manager usage instead
  of failing parse.
- **Expanded `tdmcp-agent doctor --fix` repairs:** `doctor --fix` now creates a
  missing configured `TDMCP_VAULT_PATH`, scaffolds the default profile
  directory, writes a missing `TDMCP_BRIDGE_TOKEN` to `.env` with owner-only
  permissions, and can run `install-bridge --verify` behind a bounded repair
  hook while continuing to surface suggestions for checks that still need manual
  action.
- **Run-file flag propagation:** `tdmcp-agent run` now carries `--no-color`
  through to nested JSON/stdin command steps, and run-file steps can also set
  `"no_color": true`.
- **Bridge watch-build hot reload:** `tdmcp-agent watch-build` now treats edits
  under `td/` as bridge-runtime changes: after a passing typecheck/build it runs
  `python -m py_compile` on changed `.py` files and then calls `reload_bridge`.
  `--no-py-compile` and `--no-reload-bridge` keep the old build-only loop when
  needed.
- **MCP resource follow-through:** new offline resources expose
  `tdmcp://glsl-snippets`, `tdmcp://cheatsheets`, and
  `tdmcp://learning/touchdesigner` so agents can discover vetted shader
  snippets, common workflow reminders, and the `teach_touchdesigner` learning
  path without guessing IDs.
- **N-channel `create_decks`:** the legacy A/B mixer remains compatible, and a
  new `decks[]` mode builds 2-8 deck rigs with per-deck gain, per-deck FX-send
  branches into an additive bus/return, a running Cross TOP program mix, and a
  hard-cut Switch TOP blended back into program with `cut_mix`.
- **Portable component README:** `make_portable_tox` now writes a package
  `README.md` by default, documenting node inventory, custom parameters,
  inputs/outputs and external file references beside the `.tox` and
  `tdmcp-component.json`; pass `include_readme:false` for the old minimal
  package.
- **`publish_recipe_bundle`** *(library)* — writes a local, versioned recipe
  publish artifact: the recipe-bundle JSON, a `tdmcp-recipe-publish.json`
  manifest, and a `tdmcp-checksums.json` SHA-256 manifest. Tool registry:
  269 → 270.
- **`create_sdf_field`** *(Layer 1)* — programmable signed-distance-field
  raymarcher in a single GLSL TOP. CSG tree of sphere/box/torus primitives with
  union/intersect/subtract + smooth blend; exposes live
  CameraZ/Speed/StepCount/Intensity/Rotate/ColorA/ColorB/Background controls and
  previews the output. Closes a Roadmap Milestone-4 deferred generator.
- **`create_strange_attractor`** *(Layer 1)* — deterministic strange-attractor
  geometry pipeline. Script CHOP integrates a chosen ODE (Lorenz / Aizawa /
  Halvorsen) into a rolling ring buffer; Script SOP renders an open polyline,
  optional Tube SOP thickens it, then a Geometry COMP + Camera + Light + Render
  TOP. Time-dependent (paused timeline pauses the integrator). Closes a Roadmap
  Milestone-4 deferred generator.
- **`create_optical_flow`** *(Layer 1)* — CPU optical-flow vector-field
  generator built entirely from stock TOPs (blur, monochrome, cache,
  composite-subtract, optional edge cross-multiply, math, feedback+level). Emits
  an RG-packed flow TOP (R=dx, G=dy, centred at 0.5) usable as a drop-in
  modulator for `create_displacement_warp`, `create_gpu_particle_field` or any
  TOP-driven displacement chain. Defaults to TD's bundled Mosaic.mp4 clip so it
  builds standalone (avoids the macOS camera permission modal). Closes a
  Roadmap Milestone-4 deferred generator (no CUDA path required).
- **`create_histogram_scope`** *(Layer 1)* — luminance + optional per-channel
  RGB video histogram. GPU GLSL TOP bins → CHOP normalisation → `choptoSOP` →
  render TOP, output is a Null TOP ready for previews or `bind_to_channel`.
  Closes the Roadmap Milestone-2 histogram-scope panel as a focused tool.
- **`setup_face_tracking`** *(Layer 2)* — one-shot MediaPipe face-landmark
  tracking adapter on the in-tree tracking engine. Loads the MediaPipe ENGINE,
  starts the timeline and builds an adapter Script CHOP that emits a 468-sample
  (478 with iris) face-landmark CHOP (tx/ty/tz/confidence, centred on nose tip),
  ready for `bind_to_channel` and `create_data_visualization`.
- **`setup_hand_tracking`** *(Layer 2)* — one-shot MediaPipe hand-tracking
  adapter sharing the same engine as `setup_body_tracking`. Locates the engine's
  hand JSON DAT and converts it into a canonical `max_hands×21`-landmark CHOP
  (tx/ty/tz/confidence/handedness). Recommends `coordinate_space='world'` for
  gesture detection.
- **`setup_segmentation`** *(Layer 2)* — one-shot MediaPipe selfie-segmentation
  adapter on the in-tree engine. Reuses the staged `MediaPipe.tox`, enables
  selfie-segmentation, and publishes a clean alpha mask `Null TOP` (+ optional
  pre-keyed RGBA `person_rgba` Null TOP = camera × mask) ready for `create_keyer`,
  `create_depth_silhouette`, or any matte-consuming chain. Closes the
  Milestone-4 MediaPipe segmentation slot alongside face/hand tracking.
- **Pluggable `doctor --fix` test hooks** — `RunDoctorOptions` exposes override
  hooks (`envFilePath`, `envFileWrite`, `profileDirPath`, `profileDirRepair`,
  `runInstallBridge`) plus `checkBridgeToken`, so the safe repair paths above are
  covered without touching the real user environment.
- **`get_inline_preview`** *(Layer 3)* — one-shot inline inspection snapshot of
  any TOP: bounded thumbnail (default 256×256, capped at 1024) plus resolution /
  pixel-format / cook metadata and post-cook node errors, returned in a single
  structured payload so agents can verify a build without juggling
  `get_preview` + `get_td_node_errors`. Closes the Roadmap Milestone-4 inline
  preview pass. Tool registry: 277 → 278.
- **`create_stage_dashboard` v2 layout** — opt-in `layout:"v2"` adds a stereo
  VU pair, a BPM readout fed by an optional `tempo_channel` (e.g. a
  `detect_tempo` Null CHOP), an FPS / cook-time / frame overlay, a cue
  timeline strip driven by an optional `cue_times[]` array (pairs from
  `compose_cue_list`), and a sticky confirm-tap PANIC bar. The default
  `layout:"v1"` keeps the original dashboard byte-for-byte. Closes the Roadmap
  Milestone-4 front-of-house dashboard pass.
- **`generate_readme` component-doc polish** — adds `include_mermaid:true` to
  embed a Mermaid flowchart of the operator graph in the "Data flow" section,
  and a `max_nodes` cap (default 200) that truncates the Child inventory table
  with a one-line "_N more nodes not shown_" footer so large components produce
  scannable READMEs. Together with the existing `make_portable_tox` package
  README, this closes the Roadmap Milestone-3 "stronger component docs" item.

Tool registry: 270 → 278 (eight new tools above).

### Changed

- Prompt cookbook expanded with additional visual examples (EN + PT) covering
  tools shipped post-0.7.1, keeping `tdmcp://cookbook` aligned with the live
  registry.

### Security

- Reduced SafeSkill prompt-injection score by removing literal system option
  keys from public tool descriptions (no behavior change for callers).

## [0.7.1] - 2026-06-01

### Added

- **CLI/operator DX follow-through:** `tdmcp --help` now
  prints top-level usage without starting the MCP server; `tdmcp-agent run -`
  reads run-file JSON from stdin; `tdmcp-agent run --continue-on-error` executes
  the remaining steps and returns the first non-zero status at the end; and
  `tdmcp-agent config profiles` / `config profile <name>` list and inspect saved
  venue profiles with secrets redacted. The same lane now also exposes
  `tdmcp-agent commands --json`, the matching `tdmcp://commands` resource,
  grouped `tdmcp-agent --help`, focused `tdmcp-agent help <command>`, and
  `tdmcp install-bridge --verify` / `--wait` / `--port` bridge polling against
  `/api/info`.
- **MCP resources:** `tdmcp://prompts` is now generated from the real prompt
  registry (removing manual drift), `tdmcp://recipes/search/{query}` searches the
  recipe catalog, and `tdmcp://cookbook` plus `tdmcp://cookbook/{en|pt}` expose
  the prompt cookbook as an MCP resource. The npm package now includes the EN/PT
  cookbook Markdown needed by that resource.
- **Local copilot knobs:** `TDMCP_LLM_TIER`, `TDMCP_LLM_MAX_STEPS`, and
  `TDMCP_LLM_TEMPERATURE` configure the default chat tier, model/tool-loop step
  budget, and sampling temperature. The copilot system prompt now also includes
  the real registered prompt catalog from `tdmcp://prompts`, so it can guide users
  toward the right MCP prompt instead of relying on stale prompt names.
- **Runtime telemetry:** `get_node_state_runtime` accepts
  `include_info_chop:true` to fail-forward sample a temporary Info CHOP and
  return its numeric channels under `info_chop`.
- **`watch_node`** *(layer3, td-depth)* — read-only short-window sampling of one
  operator's runtime state, readable parameters, and CHOP channel values. Missing
  attributes/channels fail forward as warnings so the diagnostic loop stays useful
  across TD builds. Tool registry: 268 → 269.
- **Roadmap CLI/DX follow-through:** `tdmcp install-client --write --path <file>`
  now deep-merges and verifies explicit client config files (JSON for
  Claude/Cursor, TOML for Codex); `tdmcp serve --http [--port]` starts loopback
  Streamable HTTP without changing bare `tdmcp` stdio defaults;
  `tdmcp-agent --output table|csv` renders list results for shell use; the REPL
  has persistent history + Tab completion; and `tdmcp-agent watch` gained
  `--pretty`, event counts, `--heartbeat-ms`, and exec hooks (`--on <events>`,
  `--exec <cmd>`, `--debounce-ms <ms>`) for reactive local scripts.
- **Local copilot CLI flags:** `tdmcp chat --read-only` locks browser/API turns
  to the safe tool tier, `--creative` selects the creative tier with a warmer
  sampling preset, `--prompt <text>` runs a headless one-shot answer without
  opening the browser/server, and `--profile` / `--config` select saved configs
  for chat runs.
- **Bridge health watchdog:** the TouchDesigner bridge now serves
  `GET /api/health` with state/status, timestamp, uptime, heartbeat metadata,
  TouchDesigner info and fail-forward optional performance metrics
  (cook/frame/drop/GPU fields are `null` when the current TD build does not
  expose them).

### Fixed

- **Release/package warning cleanup:** the dependency override now keeps the
  nested `@bottobot/td-mcp`/Cheerio chain off the deprecated `whatwg-encoding`
  path, and `build:mcpb` strips dev-only overrides before the staged production
  install so the bundle build no longer emits the transient `mute-stream`
  `EBADENGINE` warning.

## [0.7.0] - 2026-06-01

### Added (Ingest-extend Wave 3 sub-batch A)

Three pure-Node library/publishing tools — no TouchDesigner bridge required.
Lands the first three Milestone-3 (M3 — Smarter assistance & library publishing)
features as a partial Wave 3; the remaining six Wave-3 features (TD-required)
follow in a separate session.

- **`tag_and_search_library`** — faceted browse + tag editing over the vault
  library (`<vault>/Recipes/*.md` + `<vault>/Components/*.md`). `op:"list"`
  enumerates every asset and its tags; `op:"search"` filters by free-text
  `query` and/or `tags_any` / `tags_all` set logic; `op:"tag"` edits one
  asset's frontmatter tags (union or replace, always preserving `'*'`-pinned
  user tags — same convention as `auto_tag_library_asset`). Pure vault I/O.
- **`version_library_asset`** — SemVer `patch`/`minor`/`major` bumps for a vault
  recipe or component note, recorded in a sidecar `<asset>.versions.json`
  (`asset_path` + `current` + `history` list with version/bump/note/timestamp)
  and reflected in the note's frontmatter `version`. Pass `read_only:true` to
  inspect without bumping. Pre-existing frontmatter versions are captured as the
  history root on the first bump.
- **`generative_classics_pack`** — the first canonical technique recipe pack:
  curated subset of 6 built-in recipes that recreate well-known generative looks
  (`feedback_tunnel`, `audio_spectrum_bars`, `noise_landscape`, `particle_galaxy`,
  `reaction_diffusion`, `webcam_glitch`). `list_only:true` (default) returns
  the technique cards + availability; `list_only:false` writes a portable
  `import_recipe_bundle`-compatible bundle JSON at `install_path` (default
  `recipes/generative_classics.pack.json`). Recipes pulled live from the recipe
  library so the pack always reflects the authoritative validated copies.

Tool registry: 257 → 260. Unit tests: 2935 → 2953 (+18 new assertions across the
three tools).

### Fixed (`create_data_source_http_ws` hotfix)

- **`create_data_source_http_ws`** no longer fails with
  `TypeError: must be real number, not str` after node creation. Three layered
  bugs (all live-validated against TD 099 build 2025.32820):
  - The `dattoCHOP` menu parameters (`firstrow`, `firstcolumn`, `output`) were
    set with integer indices (`1/0/1`), which TD silently coerced through the
    menu list — landing on `'names'/'ignored'/'chanperrow'`. The latter two are
    wrong for this layout, so the CHOP produced zero or wrongly-named channels.
    Now uses the explicit menu names (`'values'/'names'/'chanperrow'`).
  - The sample `tableDAT` was laid out as a header-row + value-row table, which
    `dattoCHOP` cannot turn into one channel-per-selector. It is now transposed
    (one row per selector: `[name, value]`), matching the corrected datto
    config. The parser callback (`_parse_and_update`) was updated to emit the
    same shape.
  - The live-readout custom parameters were named `LastValue_<selector>`, which
    TD rejects (custom-param names must be one uppercase letter followed by
    lowercase letters only, no underscores). They are now `Last<lowercase>`
    (e.g. `Lasturl`, `Lastn`), and the expression explicitly calls `.eval()` on
    the channel so the float parameter receives a real number instead of a
    `Channel` object.
- Live-validated against TD 099 (build 2025.32820) with two selectors over
  `httpbin.org/get`: the tool now returns 2 channels, 0 warnings, 0 node errors,
  and 4 working controls (`Active`, `Poll`, `Lasturl`, `Lastn`). The full unit
  test count goes from 2923 → 2935 (+12 tests, 4 new regression assertions on
  this tool).

### Added (Ingest-extend Wave 3 sub-batch B)

Six TD-required Wave-3 features (mix of Layer-3 and vault tools), closing out the
Wave-3 backlog ahead of the v0.7.0 cut. All gates pass (typecheck, build, biome,
2971 vitest tests, 15/15 recipes, 106 bridge tests). Live-validated against TD
099 build 2025.32820 (project `laser_dedo.1.toe`).

- **`extract_palette`** *(layer3, ai)* — sample dominant colors from a TOP by
  capturing its preview PNG and running deterministic k-means on the decoded
  RGB pixels. Returns `{hex_colors[], swatches[{hex,rgb,weight}]}` sorted by
  dominance. Read-only; mechanism identical to `caption_top`. Live-validated
  via `get_preview` round-trip against a `constantTOP`.
- **`export_sop_to_svg`** *(layer3, library)* — read a SOP's primitives via the
  bridge and emit an SVG document of polylines (each prim → one `<polyline>`),
  auto-fit viewBox, configurable stroke/fill/scale/flip_y, optional `output_path`
  to disk. Pen-plotter / laser / print deliverable. Live-validated by extracting
  40-point polyline from a probe `circleSOP` (Poly-iteration path).
- **`swap_operator`** *(layer3, td-depth)* — change an op's TYPE in place,
  preserving name, position, input + output wires, and any parameters that exist
  on the new type. Fail-forward per-wire / per-param. Live-validated: swapped a
  `noiseTOP` → `rampTOP` while keeping 19 parameters and a downstream `nullTOP`
  wire (0 post-cook errors).
- **`copilot_vision`** *(layer3, ai)* — route a vision query to the configured
  multimodal LLM with a TOP rendered as an inline image. Uses
  `ctx.llm.complete()` with a `MultimodalMessage` (text + image part); falls back
  with a friendly error pointing at `TDMCP_LLM_*` when no LLM backend is wired.
  Live-tuning UNVERIFIED — no multimodal LLM endpoint configured in this
  session; mechanism (preview capture + LLM contract) is covered by tests.
- **`export_look_tox`** *(vault, library)* — save a COMP as a portable `.tox`
  inside `<vault>/<folder>/<slug>.tox` with a sibling Markdown sidecar
  (id/type=look + name + tags + assets + created + source_path). The artist-
  publishing primitive for shareable looks. Vault-gated. Live-validated via a
  probe `baseCOMP.save()` (238-byte tox written).
- **`tutorial_companion_pack`** *(vault, cli)* — scaffold a teaching companion
  for a build: snapshot the COMP's topology, capture previews of its output TOPs,
  write `tutorial.md` + `topology.json` + `network_snapshot.json` (a documentary
  snapshot — explicitly NOT a RecipeSchema-installable recipe) + `previews/*.png` into
  `<vault>/<folder>/<slug>/`. Composes existing read-only bridge calls; outputs
  are an editable starting point for an artist. Vault-gated.

### Added (Ingest-extend Wave 3 sub-batch C)

Closes out Milestone 3's colour-finish polish (Part 2) and opens Milestone 4
(deeper authoring / operator DX) with three new tools + one CLI subcommand. All
gates pass (typecheck, build, biome, 2987 vitest tests, 15/15 recipes, 106
bridge tests). Two TD-required tools live-validated against TD 099 build
2025.32820 (project `laser_dedo.1.toe`) under isolated probe containers — zero
node errors after the cook, networks cleaned up.

- **`create_color_wheels`** *(layer1, M3 colour-finish)* — classic lift / gamma
  / gain colour-grading wheels. Three tinted Level TOPs run in series (shadows
  via a gamma-biased Level, midtones via a neutral Level, highlights via a
  brightness-biased Level), each multiplying R/G/B channels (`redmult1` /
  `greenmult1` / `bluemult1`). A master Level TOP applies a global black-level
  offset, then an HSV Adjust TOP applies master saturation. Builds a new
  `baseCOMP` under `parent_path`; with `source_path` the upstream TOP is pulled
  in via a Select TOP, without one a Ramp TOP is graded so the chain previews
  standalone. Exposes nine per-channel float controls — LiftR/LiftG/LiftB,
  GammaR/GammaG/GammaB, GainR/GainG/GainB — each bound to the corresponding
  Level TOP `redmult1` / `greenmult1` / `bluemult1` parameter on its tier, plus
  master Offset (black-level) and Saturation knobs.
- **`create_pop_geometry`** *(layer1, M4 authoring)* — Procedural Op Pattern
  geometry generator: build a SOP chain inside a Geometry COMP — primitive
  (`box` / `sphere` / `tube` / `torus` / `grid` / `line` / `text`) → Transform
  SOP (translate / rotate / scale) → optional Subdivide SOP → optional per-point
  Noise SOP displacement → Material SOP (Constant MAT) → Null SOP — then render
  through a Camera + Light + Render TOP to a Null TOP. Mirrors the
  `build_sop_geometry` declarative chain pattern but wraps it in a full
  Layer-1 render rig. Exposes RotateY, NoiseAmount and NoisePeriod controls.
- **`tdmcp config init`** *(cli, M4 DX)* — new CLI subcommand: writes a starter
  `.env`-style config file with every `TDMCP_*` env var the server reads, sane
  defaults, and a one-line comment per setting. Default target is
  `~/.tdmcp/config.env`; pass a positional path to override. Secrets
  (`TDMCP_BRIDGE_TOKEN`, `TDMCP_LLM_API_KEY`) are emitted commented-out for
  manual setting. Refuses to clobber existing files unless `--force`;
  `--dry-run` prints the body without touching the filesystem. Pure Node, no
  TD bridge required.
- **`elicit_missing_args`** *(layer3, M3 — verified shipped)* — already shipped
  in this branch (10 unit tests across LLM-elicit / offline / schema-feedback /
  long-context truncation / unknown-tool / no-server paths). Audited as part of
  this sub-batch; no changes needed — flipped to ✅ on the roadmap.

Tool registry: 266 → 268. Unit tests: 2971 → 2987 (+16 new assertions).

### Added (Ingest-extend Waves 1-2)

**Ingest-extend Wave 1 — Ecosystem on-ramp + signature looks** (campaign
`ingest_extend_20260531`, Arc 5 "Ingest & extend" / ROADMAP Milestone 2, folded
into the v0.7.0 line). One shared foundation module plus six new Layer-1 tools open
tdmcp to the wider GLSL ecosystem (Shadertoy + ISF) and add four signature looks
(fluid sim, image-to-particles, dither, JFA voronoi).

### Added (Ingest-extend Wave 1)

- **`apply_glsl_top_mapping`** (foundation, new `src/tools/foundation/` directory)
  — shared GLSL-TOP translation layer: preamble injection, `out fragColor`,
  `iTime`→`absTime.seconds`/uniform, `iResolution`/`iMouse`/`iChannelN`→TOP
  inputs + uniform CHOP, ISF `INPUTS`→custom-page mapping. Pure Node/TS, no TD.
  Consumed by both importers below so they share one mapping contract.
- **`import_shadertoy`** — paste a Shadertoy URL or `mainImage` source and get a
  translated, wired, previewable GLSL TOP. Translate-on-demand only (never
  stored/redistributed); offline-safe via `raw_source`.
- **`import_isf_shader`** — parse ISF (`.fs`) JSON header + translate to a
  glslTOP with an auto-generated `add_custom_parameters` page (INPUTS →
  float/color/bool/event/long). Own parser, no bundled `.tox`.
- **`create_fluid_sim`** — GPU 2D Navier-Stokes ink/dye/smoke simulation
  (advection → divergence → pressure-Jacobi → gradient-subtract → vorticity)
  with audio/motion/pointer force binding and Viscosity/Vorticity/Dissipation
  knobs.
- **`image_to_particles`** — turn an image/video into a particle reconstruction
  that springs toward rest, with audio-driven scatter; Reorder TOP → CHOP →
  TOP-instancing.
- **`create_dither`** — 1-bit/N-bit Bayer ordered dither + error-diffusion
  effect (palette size, gameboy preset). Own GLSL.
- **`create_jfa_voronoi`** — Jump-Flood-Algorithm Voronoi / stained-glass
  generator, multipass GLSL, with three palette modes.

**Ingest-extend Wave 2 — Color pipeline + show automation + stylization +
3D post** (campaign `ingest_extend_20260531`, Arc 5 "Ingest & extend" / ROADMAP
Milestone 2). Eight new tools (3 Layer-1, 4 Layer-2, 1 quarantined Layer-2) plus
new mode keys on `apply_post_processing` extend tdmcp into color management,
performance instrumentation, Live integration, painterly stylization, and 3D
post-processing. Seven tools are live-validated in TD 099; one ships flagged
**experimental** with a tracked known issue.

### Added (Ingest-extend Wave 2)

- **`create_video_scopes`** *(Layer 1)* — broadcast-style video monitor with
  waveform / RGB parade / vectorscope panels (histogram deferred — TD 099 lacks
  `histogramCHOP`).
- **`create_chop_recorder`** *(Layer 1)* — capture-and-playback for any CHOP
  source; record a take, scrub or loop it back as a CHOP feed.
- **`setup_tdableton`** *(Layer 1)* — Ableton Live bridge: probes for the
  TDAbleton Palette component first, falls back to a plain OSC In bridge so it
  works without the Palette installed.
- **`apply_lut`** *(Layer 2)* — apply a LUT to any TOP via OCIO when available,
  image-based lookup for `.png`/`.cube` previews, or a parsed-`.cube` GLSL
  fallback. Color-management pipeline foundation.
- **`create_flow_abstraction`** *(Layer 2)* — ETF→FDoG painterly flow effect
  (edge tangent flow + flow-based difference-of-Gaussians, Kyprianidis style).
- **`create_npr_filter`** *(Layer 2)* — Kuwahara non-photorealistic filter with
  oil / pencil / watercolor variants; also exposes three new mode keys
  (`npr_oil`, `npr_pencil`, `npr_watercolor`) on
  `apply_post_processing`.
- **`post_passes_3d`** *(Layer 2)* — SSAO / SSR / depth-of-field / motion-blur
  3D post-passes for `create_3d_scene` / `create_pbr_scene` outputs.
  `apply_post_processing` now emits friendly redirect errors when invoked with
  3D-only mode keys, pointing callers to `post_passes_3d`.

### Known issues (Ingest-extend Wave 2)

- **`create_data_source_http_ws`** *(Layer 2, experimental)* — HTTP-poll +
  WebSocket data source. The `http_poll` path raises
  `TypeError: must be real number, not str` after node creation; the network
  still builds but the tool surfaces `status: "fatal"`. Tool is registered and
  discoverable. Fixed before the v0.7.0 public cut.

**Wave 2 — Show automation + musical reactivity** (campaign `beyond_20260530`).
Eight new Layer-1 tools and one CLI verb turn the v0.7.0 live-show foundation
into a smarter, more musical conductor. Tool registry is now **213** (was 205).
Three reactivity tools ship marked `[experimental]`; two control surfaces are
gated `unverified_pending_hardware` (live phone + motorized-controller probes
required before they leave that flag).

### Added (Wave 2)

- **`compose_cue_list`** — natural language → fireable cue sequence. Uses the
  local LLM when configured, with a grammar fallback so it works offline.
- **`create_prob_sequencer`** — Markov-chain step sequencer with beat-pointer
  deduplication; drives recipe / scene / cue triggers from a probability matrix.
- **`create_two_way_surface`** *(unverified_pending_hardware)* — closed-loop
  OSC/MIDI feedback to motorized faders and lit pads, so the controller mirrors
  the live parameter state.
- **`create_automation_lane`** — record + loop a parameter sweep on a bar phase
  using `beatCHOP`; turns any knob move into a reusable automation clip.
- **`create_chroma_reactive`** *(experimental)* — FFT into 12 pitch-class
  channels, for key-aware and harmony-aware reactivity.
- **`create_transient_reactive`** *(experimental)* — `analyzeCHOP` RMS plus
  `filterCHOP` lag to split a signal into a transient and a sustain channel.
- **`create_energy_structure`** *(experimental)* — adaptive energy envelope
  with build / drop / breakdown edge detection, for song-structure-aware shows.
- **`create_phone_gesture`** *(unverified_pending_hardware)* — IMU + multitouch
  from a phone over a Web Server DAT, exposed as CHOP channels.
- **`scene_scheduler`** — new CLI verb `tdmcp-agent schedule <file>`: cron-lite,
  DST-faithful wall-clock driver for unattended installations.

**Wave 3 — Library provenance + AI dispatch + scene resource** (campaign
`beyond_20260530`). Eight new tools (across library, vault, Layer-1, Layer-3)
plus one new MCP resource and a strengthened prompt-eval harness. Tool registry
is now **221** (was 213); resources gain a live scene-summary view.

### Added (Wave 3)

- **`provenance_stamp`** — write a `.provenance.json` sidecar (sha256, source
  COMP path, toolchain versions, git metadata, author, tags) next to any saved
  artifact. Offline, no TD bridge.
- **`checksum_and_verify_pack`** — compute (writes `tdmcp-checksums.json`) or
  verify SHA-256 manifests for tdmcp artifacts (.tox, recipes, bundles).
- **`library_lineage_graph`** — scan the vault library, extract lineage
  frontmatter (parent_recipe, source_assets, remix_of, forked_from), and emit a
  graph as JSON / Mermaid / Graphviz DOT.
- **`morph_pack`** — pack a `create_preset_morph` container's slots to a
  sha256-verified vault JSON; unpack to (re)hydrate the container.
- **`learn_conventions`** — read-only sweep of a live TD subtree to extract
  naming/colour/topology/parameter conventions into the vault Memory notes.
- **`moodboard_to_system`** — ingest 1–6 moodboard images and dispatch a
  matching generative system (palette + motion + generator pick via local LLM,
  deterministic fallback otherwise).
- **`audio_fingerprint_to_visual`** — sample audio, compute a 4-feature
  fingerprint (tempo / centroid / onset density / dynamic range), and dispatch
  the matching Layer-1 generator tuned to the fingerprint.
- **`score_build`** — read-only 0–100 rubric scoring of a built network
  (palette / motion / complexity / errors / perf) with deterministic improvement
  suggestions, optional LLM critique.
- **resource `tdmcp://scene/{view}`** — live MCP resource exposing scene
  topology, operators, and errors views; `ResourceContext` now carries the TD
  client.
- New offline `prompt_eval_harness` test that catches description-quality,
  rendering, and token-budget regressions across every registered prompt.

### Changed (Wave 3)

- `fix_shader` prompt description expanded past the 50-char quality threshold
  so the harness can enforce it without a whitelist.

**Wave 4 — TD-depth authoring + DX accelerators** (campaign `beyond_20260530`).
Ten new MCP tools (across Layer 1/2/3 plus a new `cli` tool group) and two
long-running CLI streamers, bringing the registry to **231** tools.

### Added (Wave 4)

- **`create_engine_comp`** — build a load-balanced Engine COMP cluster that
  offloads a sub-network to worker processes for parallel cooking.
- **`create_dmx_fixture_pipeline`** — build a DMX / Art-Net fixture pipeline
  (parameter channels → patch matrix → Art-Net Out) for lighting integration.
- **`scaffold_tool_generator`** — scaffold a new tdmcp tool file + msw unit
  test from an inline spec; accelerates wave authoring.
- **`extend_data_source_fabric`** — extend `create_data_source` with new feed
  adapters (websocket / sse / mqtt / file-tail / process).
- **`build_chop_chain`** — assemble a typed CHOP-processing chain from a recipe
  of stages, with per-stage parameter validation.
- **`author_script_operator`** — author a Script CHOP/TOP/SOP/DAT with validated
  callbacks + parameters; eliminates raw-Python ceremony.
- **`profile_cook_cost`** — read-only profiler that samples per-node cook cost
  across N frames and ranks hot spots.
- **`control_timeline_transport`** — drive TD timeline transport (play/pause/
  seek/rate/range) as a structured tool instead of raw exec.
- **`inspect_gpu_and_displays`** — offline-friendly host GPU + display inventory
  for stage prep + capability sniffing.
- **`macro_recorder`** — start/stop/list/load tool-call macros to portable JSON
  via a process-wide `wrapHandler` hook installed at server boot. Replay ships
  in wave 5 as `run_macro_script`.
- **`tdmcp-agent watch-build`** — long-running dev-loop CLI (chokidar-based)
  that re-runs `tsc --noEmit` + `tsup` on debounced changes under `src/` and
  `td/`.
- **`tdmcp-agent soundcheck-monitor`** — long-running audio-features poller
  that emits rolling-window RMS/peak/silence alert events (ndjson on stdout).
- Adds `chokidar ^4.0.3` as a devDependency for the watch-build streamer.

**Wave 5 — Final P2 tail: library trust + CLI/remote ergonomics + AI copilot polish + TD-depth long-tail** (campaign `beyond_20260530`). Thirteen new MCP tools (Layer 1/2/3, library, vault, cli group) plus six long-running CLI streamers/dispatchers, bringing the registry to **245** tools. Closes out the BEYOND backlog.

### Added (Wave 5)

- **`curated_collection_pack`** — bundle a curated set of vault/library assets into a verifiable, checksummed pack with provenance metadata.
- **`component_changelog_trail`** — write/read a per-component changelog trail across versions; offline, scoped to a vault folder.
- **`merge_vaults`** — safely merge two Obsidian vaults with conflict detection (sha256), `--dry-run` planning, and a Markdown audit log.
- **`vault_repo_sync`** — sync a vault directory to a git remote (clone / pull / push) with auth guard rails.
- **`variant_pack`** — generate a variant pack from a base vault asset (parametric mutations + manifest).
- **`learn_from_my_corpus`** — mine the vault corpus to surface style/usage conventions and emit a structured learnings report.
- **`create_shared_memory_bridge`** — wire a SharedMem In/Out bridge between TD processes (textures + CHOPs) for low-latency IPC.
- **`build_sop_geometry`** — assemble a typed SOP geometry chain from a recipe of stages, with per-stage param validation (mirrors `build_chop_chain`).
- **`sync_timecode`** — lock the show clock to external LTC / MTC / OSC / MIDI timecode and optionally drive the TD timeline.
- **`manage_component_storage`** — structured read/write of COMP `storage` slots (get / set / delete / list) replacing raw exec.
- **`enhance_build`** — apply targeted improvements to an existing built network and rescore via `score_build`, reporting before/after deltas.
- **`create_growth_system`** *(Layer 1)* — build an organic growth/branching system (L-system flavour) with audio-modulated growth rate.
- **`run_macro_script`** *(cli group)* — replay a recorded macro script of tool calls (closes the loop on Wave-4's `macro_recorder`).
- **`tdmcp-agent log-tail`** — long-running, filterable tail of the bridge log stream with regex include/exclude.
- **`tdmcp-agent record-fixtures`** — record live bridge HTTP traffic to a replayable msw fixture (adds `fetchImpl` plumbing on `buildToolContext`).
- **`tdmcp-agent fanout`** — fan a single CLI invocation out to N remote tdmcp agents and aggregate results.
- **`tdmcp-agent controller-bridge`** — bridge a MIDI/OSC control surface to CLI commands for hands-on driving.
- **`tdmcp-agent voice`** / **`llm-voice`** — voice-driven copilot chat loop (push-to-talk → STT → tool dispatch).

### Changed (Wave 5)

- `buildToolContext` accepts an optional `fetchImpl` override (forwarded to the TouchDesigner client) so the fixture-recorder CLI can wrap bridge calls.

### Changed (BEYOND Wave 1.5 deferred items)

**Wave 1.5 — deferred items from v0.7.0**. Folds in the three follow-ups that
were called out as deferred during the v0.7.0 integration pass: wiring the
existing setlist tools onto the shared setlist schema, seeding the new Memory/
folder during `scaffold_vault`, and exposing the auto-tag heuristic on the save
tools as an opt-in.

### Changed

- `import_setlist` / `export_setlist_to_vault` now consume the shared
  `SetlistSchema` from `src/automation/setlistSchema.ts` (introduced in 0.7.0).
  Both still accept the legacy `tracks[]` shape; `import_setlist` additionally
  accepts the new `scenes[]` shape (`{id, title, cue, recipe, preset, steps,
  …}`), so a setlist authored for `setlist_runner` / `compose_cue_list` can be
  pre-staged with one tool call. `export_setlist_to_vault` now validates the
  frontmatter it writes against `SetlistSchema` before persisting, guaranteeing
  round-trip with `import_setlist`.
- `scaffold_vault` now also seeds `Memory/README.md` and `Memory/style.md`
  (empty `StyleMemorySchema`) so the Memory layer added in 0.7.0 has a
  ready-to-merge home in fresh vaults.

### Added

- `save_recipe_to_vault` and `save_component_to_vault` learn an opt-in
  `auto_tag?: boolean` (default `false`). When `true`, the deterministic
  `auto_tag_library_asset` heuristic runs against the captured network and the
  suggested tags are union-merged (dedup, case-insensitive) into the note's
  frontmatter alongside any caller-supplied `tags`. Default behaviour is
  unchanged.

### Added (BEYOND Wave 1 — live-show foundation + all P0)

**Live-show foundation + all P0** — campaign `beyond_20260530` Wave 1.
Ships the shared show-automation foundations (setlist/scene schema, memory-note
schema, server-sampling-backed LLM fallback) and 13 P0 consumer features across
artist controls, library/vault, and the CLI. Live-validated in TD 099.

### Added

- **Show-automation foundations.**
  - **`src/automation/setlistSchema.ts`** — shared Zod setlist/scenes/steps
    schema with `parseSetlist` and normalizers, the single source of truth reused
    by `setlist_runner`, `create_scene_timeline`, and future vault setlist tools.
  - **`src/vault/memoryNote.ts`** — shared `MemoryNoteSchema` and
    `StyleMemorySchema` plus readers/writers/mergers consumed by
    `recall_similar_work`, `style_memory`, and `auto_tag_library_asset`.
  - **MCP-server-sampling LLM fallback** (`src/llm/samplingClient.ts` +
    `src/llm/resolve.ts`) — wired into `ctx.llm` so the local-copilot tier can ask
    the connected client to sample when no local model is configured.
- **Six new artist Layer-2 tools.**
  - **`create_scheduler`** — Timer-CHOP-backed event scheduler primitive driving
    bar/beat/wall-clock callbacks.
  - **`create_auto_montage`** — beat/bar-synced media-bin sequencer with
    sequential / random / shuffle / weighted modes.
  - **`create_euclidean_sequencer`** — Bjorklund pattern generator driving
    step-callbacks for algorithmic rhythm.
  - **`create_preset_morph`** — multi-preset weighted parameter blend with a
    lookup table and Script-CHOP runner.
  - **`create_scene_timeline`** — scrubbable show-master timeline above
    `cue_sequencer` / `scheduler` for arranged sets.
  - **`create_glsl_material`** — `glslMAT` scaffolder with the F1/F2 preamble,
    `uTime`, `fragColor`, and a lint-warnings pass for common GLSL pitfalls.
- **Four new library / vault tools.**
  - **`auto_tag_library_asset`** — auto-suggest tags for a vault asset by KB
    operator overlap (offline).
  - **`recall_similar_work`** — rank past memory notes by similarity to a new
    visual goal (Jaccard + tag + operator overlap, offline).
  - **`style_memory`** — show / read / update `Memory/style.md`
    (palettes / banned / favourites).
  - **`lint_recipe_library`** — Layer-3 tool plus a `scripts/lint-recipes.ts`
    runner for offline validation of the recipe library.
- **Three new CLI verbs.**
  - **`tdmcp setlist run <file>`** — headless setlist driver synced to a Beat CHOP.
  - **`tdmcp panic [on|off|toggle|freeze|unfreeze|clear|status]`** — one-word
    blackout / freeze with auto-detect of existing Blackout / Freeze nodes.
  - **`tdmcp dashboard`** — live TUI of performance, errors, and events
    (no new dependencies).

### Deferred (to Wave 1.5)

- Migrating `importSetlist` / `exportSetlistToVault` to consume the new
  `src/automation/setlistSchema.ts` (still uses the legacy inline `tracks[]`
  schemas).
- Extending `scaffold_vault` to seed the `Memory/` folder.
- An opt-in `auto_tag?: boolean` on `save_recipe_to_vault` and
  `save_component_to_vault`.

### Security

- **`rebuild_network` no longer `eval()`s the operator-type string.** The bridge
  script ran `eval(_type)` on a caller/LLM-controlled `nodes[].type`, an ungated
  arbitrary-Python path inside the TouchDesigner process reachable from an
  ordinary tool call. It now resolves the type by name off the `td` module
  (`getattr(td, _type)` guarded by `isidentifier()`), the same safe pattern
  `manage_checkpoint` already uses. Unknown types still fail-forward as warnings.
- **TD bridge adds a loopback `Host`-header check.** `_check_host` complements the
  existing `Origin` guard to close a DNS-rebinding gap (the Web Server DAT binds
  all interfaces), mirroring the Node HTTP transport's `allowedHosts`. It is active
  only in the default token-less config; authenticated remote use via
  `TDMCP_BRIDGE_TOKEN` is unaffected, and a missing `Host` is allowed.
- **Package downloads are pinned to GitHub and size-capped.** `downloadToFile`
  validates every hop (including redirects) against a GitHub host allowlist,
  requires HTTPS, and enforces a maximum response size — hardening against SSRF and
  oversized/runaway payloads.

### Added

- **Five new library/packaging tools** (campaign Wave 4 — library surface), all live-validated in TD 099: diff_library_assets, import_recipe_from_url, export_palette_component, collect_project_assets, project_documentation_site.
- **Four new AI/LLM features** (campaign Wave 6): caption_top, repair_network (tools; qa_unverified — offline unit-tested); teach_touchdesigner, design_brief (prompts; qa_pass).
- **Nine new artist-control tools** (campaign Wave 3 — artist-controls surface of
  the discovery backlog). Eight were live-validated in TouchDesigner 099 (create →
  cook → zero post-cook errors); `create_blob_reactive` is built + unit-tested but
  still awaits a live-camera validation pass (noted on its entry below):
  - **`create_test_pattern`** — projector calibration source (grid / crosshair /
    color-bars / ramp / circle-grid) with a per-output number overlay; baked-GLSL,
    no probe risk.
  - **`create_text_crawl`** — multi-line crawl / ticker / typewriter text
    (vs single-string `create_kinetic_text`).
  - **`create_band_router`** — split audio into N EQ bands (`audiofilter` +
    `analyze rmspower`) and route each band level to its own target(s); output
    channels `band0…bandN`.
  - **`create_sidechain_pump`** — one-call "pump the whole rig on the kick": a
    Limit-CHOP-clamped ducking envelope bound to many targets with a single depth knob.
  - **`create_xy_pad`** — a draggable 2D XY gesture pad (Panel CHOP) driving target
    parameters by expression, with an optional Z slider.
  - **`create_time_echo`** — per-pixel time effect on a source TOP: echo trails
    (feedback + Level-TOP decay), slit-scan and time-displace (`timeMachineTOP`).
  - **`create_capture_loop`** — bidirectional Spout/Syphon/NDI bridge (receive +
    publish in one container), anti-feedback by design.
  - **`create_vector_lines`** — image/video → pulse-captured Trace-SOP vector
    geometry composited back over the source.
  - **`create_blob_reactive`** — camera/TOP blob-position tracking (`blobtrackTOP`)
    bound to parameters (blob-channel layout pending a live-camera validation pass).
- **`.safeskillignore`** so the SafeSkill scanner skips generated knowledge-base
  data, build output and binary media (the source of the substring false
  positives) and focuses on the actual server code.

## [0.6.1] - 2026-05-30

Release-hygiene and documentation patch that makes 0.6.x consistent across npm, the
GitHub Release and the tag. **0.6.0 shipped to GitHub only** (the `.mcpb` asset) and
never reached npm, because the release workflow skips `npm publish` when `NPM_TOKEN`
is unset; 0.6.1 is the npm catch-up and folds in the fixes and docs that landed on
`main` after the 0.6.0 tag was cut. No tool API changes.

### Fixed

- **`set_parameter_expression` exec-fallback no longer drops the mode flip.** The
  endpoint path already flipped `par.mode` via `type(par.mode)`, but the legacy
  whole-batch exec fallback (used only against a pre-0.6.0 bridge) still assigned the
  bare `ParMode.EXPRESSION` / `.BIND` / `.CONSTANT`, which `NameError`'d and silently
  left the parameter in Constant mode. The fallback now resolves the enum the same
  way (`type(_par.mode).EXPRESSION`), so expression/bind/constant flips also land on
  older bridges.

### Added

- **Controller-level regression test for the structured REST routes.** A new
  `StructuredEndpointTests` proves `POST /api/connect`, `POST /api/disconnect`,
  `GET /api/logs`, `GET …/params?modes=true`, `PATCH …/params/<p>/mode` and `GET` /
  `PUT …/text` dispatch to their services **and survive `TDMCP_BRIDGE_ALLOW_EXEC=0`** —
  previously asserted only by code inspection.

### Changed

- **`docs/reference/bridge-api.md`** now lists the seven structured endpoints added in
  0.6.0 and documents that they are not behind the exec gate.
- **Advertised tool count corrected to 179** in the README and docs home page (0.6.0
  added four tools; the hand-written copy still said 175 — the generated tools
  reference was already correct).
- **PT prompt cookbook** gains the "Componentes reutilizáveis & documentação" section
  that previously existed only in the English guide.
- **Release workflow** writes a prominent job-summary banner when `npm publish` is
  skipped (missing `NPM_TOKEN`) or succeeds, so a GitHub-only release can't pass
  unnoticed again.

## [0.6.0] - 2026-05-29

TouchDesigner-depth and library wave. Seven P0 features sharpen the bridge's read/write
fidelity and add two performance instruments plus a library contact-sheet. The bridge gains
**structured REST endpoints** for the operations that previously rode the raw-Python escape
hatch — connect/disconnect, parameter modes + expression/bind, DAT text, and a logs feed backed
by an in-bridge Error DAT — and the affected tools were rewired **endpoint-first with an
exec-fallback**, so they keep working against an older bridge while routing through the fast,
exec-gate-free path on a current one. This also fixes a silent parameter-mode bug that left
`set_parameter_expression` writing the expression text without ever flipping the parameter into
Expression/Bind mode.

### Added

- **`get_td_node_flags`** (CLI `nodes flags`) — read an operator's flags
  (bypass / render / display / lock / allowCooking / clone), index-aware input wiring
  (`wires_in`), and position / comment / color in one call. Supports recursive sweeps with
  `max_nodes`, an `only_problems` filter, and a per-node `suspect_reason` (e.g. "bypass on").
  `node_detail` / `NodeDetailSchema` / `serialize_network` were extended with the same
  flags / wiring / comment / color fields (back-compatibly).
- **`create_modulators`** (CLI `modulators`) — a BPM-synced multi-LFO bank: tempo-locked
  sine / saw / noise modulators on one Null with named output channels, a master Rate/Depth,
  and a paused-timeline warning. Bind `mod_out` to any parameter to make a network breathe in
  time with the music.
- **`create_look_bank`** (CLI `look-bank`) — a snapshot + A↔B-morph instrument: capture the
  current look (morph-safe — pulse and string parameters are skipped), store named looks, and
  recall them with an instant snap or a quantized, timed morph, plus a live A↔B blend knob.
- **`generate_library_index`** (CLI `library-index`) — render a Markdown contact-sheet of a
  vault's saved recipes and components, embedding each asset's preview thumbnail
  (`![[stem.png]]`, or _(no preview)_ when none was captured).
- **Recipe / component preview thumbnails** — `save_recipe_to_vault` and
  `save_component_to_vault` accept `preview_top` / `thumbnail` and capture a sibling `<stem>.png`
  next to the saved note, embedding it after the frontmatter. Thumbnail capture **never throws**:
  a capture failure leaves the note intact and unembedded.
- **New bridge REST endpoints** (no exec gate — they survive `TDMCP_BRIDGE_ALLOW_EXEC=0`):
  `POST /api/connect` + `POST /api/disconnect` (index-aware multi-input packing and
  disconnect-by-source); `GET …/params?modes=true`, `PATCH …/params/<p>/mode` and
  `GET`/`PUT …/text` (parameter modes, expression/bind, and DAT text); and `GET /api/logs`
  backed by a new in-bridge **Error DAT** (scoped to the artist's `/project1` network,
  header-name column mapping) with edge-triggered `cook.error` / `error.cleared` events.

### Changed

- **`connect_nodes`**, **`disconnect_nodes`**, **`read_parameter_modes`**,
  **`set_parameter_expression`**, **`edit_dat_content`**, **`set_dat_content`** and
  **`get_bridge_logs`** now call their dedicated REST endpoint first and **fall back to the
  raw-Python path only when that endpoint is missing on an older bridge** — a current bridge's
  validation errors surface instead of silently retrying via exec, and connection/timeout
  errors still propagate — so they work against both current and older bridges. `connect_nodes` now reports the actual
  packed input slot; `edit_dat_content` refuses to write when the replacement target matches
  zero or more than one location.

### Fixed

- **Silent parameter-mode bug in `set_parameter_expression`** — setting an expression or bind
  previously wrote the expression text but never switched the parameter out of Constant mode
  (a latent `ParMode` `NameError` meant the mode change was silently dropped). The new
  `PATCH …/params/<p>/mode` endpoint resolves the enum via `type(par.mode)` and the parameter
  now actually flips to Expression / Bind (verified live).

### Live validation

All seven features passed QA: the four PR gates were green (1614 tests, 15/15 recipes,
86 bridge tests) and each feature's bridge logic was validated live in TouchDesigner
(connect/disconnect packing, the parameter-mode flip, the Error DAT scope + header mapping,
the modulator and look-bank networks cooking with zero errors). The following were validated by
static check + live-mechanism only and are **pending an end-to-end re-check after the owner
reinstalls the bridge and restarts the server** (acceptable per release policy):

- MCP tool calls for all seven features routed through the **new HTTP dispatcher**
  (the relocated bridge logic itself was validated live; the live routing through the
  controller was not).
- `TDMCP_BRIDGE_ALLOW_EXEC=0` survival of the five new structured routes (static-passed:
  no exec gate on any of them).
- Edge-triggered `cook.error` / `error.cleared` events from the bridge's frame hook.
- The save-tool thumbnail end-to-end (sibling PNG written + embedded) against a live vault,
  and `generate_library_index` rendering the contact-sheet from real assets.
- The live client→bridge round-trip shape for the seven rewired tools (the Zod schemas were
  diffed statically against the bridge dicts produced live; the live HTTP round-trip is pending).

## [0.5.0] - 2026-05-29

Phase 13 plus the dotsimulate LOPs integration. The focus shifts from *generating* visuals to
**packaging, documenting and cheaply operating** them: reusable components (build → parameterize →
script → package), project intelligence, token-cheap agent-DX primitives, and external-clock
locking. It also adds a way to drive tdmcp from *inside* TouchDesigner via dotsimulate's LOPs
"MCP Client" plus an optional curated tool profile for autonomous in-TD agents — additive and
backward-compatible (the default profile is `full`). Every new tool was built → integrated →
validated with automated coverage; live TD validation is called out where hardware or an open TD
session is still required.

### Added

- **`add_custom_parameters`** (CLI `add-params`) — append a custom-parameter page
  (Float/Int sliders, Toggle, Menu, Str, Pulse, RGB, XYZ) to any COMP so a generated
  network becomes a tunable, reusable component. Sets defaults, slider ranges
  (`normMin`/`normMax`) and optional hard clamps; a parameter that already exists is
  **skipped with a warning**, never overwritten, so re-running to add one more knob is safe.
- **`scaffold_extension`** (CLI `scaffold-ext`) — give a COMP a Python **extension
  class**: a Text DAT holding the class (with optional method stubs), wired into an
  extension slot, optionally **promoted** (members callable directly on the COMP), and
  reinitialized. The extension parameter names vary by TouchDesigner build, so the tool
  **probes** for them (noting any difference as a warning) instead of hardcoding. With
  `add_custom_parameters` (knobs) and `manage_component` (save as `.tox`), this completes
  the build → parameterize → script → package story — see the new
  [Reusable components](https://pantani.github.io/tdmcp/guide/components) guide.
- **`analyze_project`** (CLI `analyze`) — find likely-dead operators, broken
  external-file dependencies, and orphan COMPs, plus a dependency map (op()/Select
  refs + CHOP exports). Conservative, with a reason per flag. Complements
  `describe_project`.
- **`generate_readme`** (CLI `readme`) — a Markdown project document: family/type
  counts, a custom-parameter table, inputs/outputs, child inventory, external-file
  deps, and an optional preview thumbnail.
- **`edit_dat_content`** (CLI `dat-edit`) — surgical old/new string replace in a
  Text/Table DAT, requiring a unique match unless `replace_all` is set.
- **`set_dat_content`** (CLI `dat-set`) — overwrite a DAT's whole text, with a
  `confirm_wipe` anti-wipe guard that refuses silent clears.
- **`batch_operations`** (CLI `batch`) — run many create/connect/setParam ops in one
  fail-forward call (per-item warnings; not transactional), reusing the Layer-1
  network builder. Distinct from `set_parameters_batch` (params only).
- **`manage_annotation`** (CLI `annotate`) — create titled Annotate-COMP boxes, set
  per-op comments, list a network's annotations, and list the ops a box geometrically
  encloses — self-documenting networks.
- **`write_agent_guide`** (CLI `agent-guide`) — emit a project-local
  `CLAUDE.md`/`AGENTS.md` seeded with tdmcp operator conventions + TD render-coordinate
  rules.
- **`set_perform_mode`** (CLI `perform-mode`) — toggle a perform-mode flag (stored on
  the TD root + `ui.performMode`) so tools can skip nonessential compute during a
  live show. The built-in guard currently suppresses preview captures; other tools
  can opt in by reading `tdmcp_perform_mode`.
- **TD-depth foundation:** `read_parameter_modes` (CLI `nodes modes`) reads constant /
  expression / bind / export state for a node's parameters, and `set_parameter_expression`
  (CLI `nodes expr`) switches a single parameter into expression mode with rollback on
  failure. `snapshot_td_graph compact` now preserves reactive parameter state when possible.
- **Live controls / VJ tools:** `bind_audio_reactive` (CLI `bind-audio`),
  `create_transition` (`transition`), `create_live_source` (`live-source`),
  `create_layer_stack` (`layer-stack`), `create_media_bin` (`media-bin`),
  `create_keyer` (`keyer`), `create_datamosh` (`datamosh`), and
  `create_displacement_warp` (`displace-warp`).
- **CLI/DX:** JSON config files and named profiles (`TDMCP_CONFIG_FILE`,
  `TDMCP_PROFILE`), `tdmcp install-client`, `tdmcp-agent run <file>`,
  `--params-file`, `--params -`, `--td-host`, `--td-port`, `--timeout`, shell
  completion, `--version`, `--quiet`, `--no-color`, and advisory `doctor --fix`.
- **AI prompt/copilot surface:** new prompts for `fix_reactivity`, `recover_show`,
  `auto_vj_director`, `color_story`, `lyric_show`, `setlist_planner`,
  `visual_ab_compare`, `motion_critique`, and `explain_param`; a prompt catalog
  resource at `tdmcp://prompts`; and a `creative` copilot tier.
- **Library / packaging tools:** `browse_library`, `inspect_component_manifest`,
  `make_portable_tox`, `export_recipe_bundle`, `import_recipe_bundle`,
  `validate_library_asset`, `scaffold_recipe_template`, `attach_docs_as_assets`,
  `local_marketplace_index`, `component_link_health`, `refresh_asset_previews`, and
  `install_library_package`.
- **Body-tracking CLI + recipe:** 1:1 CLI commands for the MediaPipe body-tracking
  tools that shipped in 0.4.0 (`body-tracking`, `pose-track`, `skeleton`,
  `body-reactive`), plus a new recipe **`body_tracking_reactive`** — 33 MediaPipe
  landmark dots with a feedback motion trail. Re-validated live against the engine.
- **`analyze_screenshot`** prompt — captures a node's preview + topology + node errors
  and diagnoses what it shows or why it looks wrong ("why is it black?").
- **Feature-build harness** (`.claude/`): a `tdmcp-tool-builder` skill +
  `tdmcp-feature-lead` / `tdmcp-tool-builder` agents that build tool batches as
  parallel one-tool-per-agent waves with a single-writer integrator.
- **`scripts/tdmcp-lops.mjs`** — a dependency-free launcher for dotsimulate's LOPs MCP
  Client. Point the LOPs `command` at it; it injects the hardened env
  (`TDMCP_RAW_PYTHON=off`, `TDMCP_TOOL_PROFILE=safe`) then execs `dist/index.js`, since
  LOPs' `servers_config.json` has no documented `env` field.
- **LOPs integration guide** (EN + PT) — setup, the hardened `servers_config.json` snippet,
  the TD → tdmcp → bridge → TD architecture, and an explicit callout that this does **not**
  replace the local `tdmcp chat` copilot. Plus reference docs for the new env var and the
  in-TD topology.

#### Phases 14–15 — live mixing, parameter fidelity, network round-trip & creative direction

The post-discovery feature wave: built as parallel one-tool-per-agent waves with a single-writer
integrator, all offline-gated (typecheck + build + Biome + vitest + recipes + bridge tests).
**TouchDesigner was offline during the build, so every new tool/prompt is shipped with offline
unit coverage and its live create→cook→preview validation marked UNVERIFIED-pending** — each
TD-touching tool carries a `probe` block (and `extra.unverified`) that surfaces the real TD
API on its first live run, and is fail-forward (per-item warnings, never throws).

- **Live mixing & external content** — `create_transition` (CLI `transition`): A→B transitions
  over a 0–1 Progress knob (dissolve / luma_wipe / slide / zoom / glitch_cut; folds in the planned
  `transition_designer` prompt). `create_live_source` (`live-source`): an input layer
  (screen-grab / NDI / Syphon-Spout / camera / video stream) → a previewed Null — default
  screen-grab is zero-permission (camera is opt-in; can hang TD on a macOS modal).
  `create_layer_stack` (`layer-stack`): an N-layer compositor with per-layer blend + opacity +
  mute/solo and a generated control strip. `create_media_bin` (`media-bin`): a folder-fed clip bin
  (Movie File In + Switch) with Index/Next/Prev + crossfade-on-switch. `create_keyer` (`keyer`):
  chroma/luma/rgb key + matte composite over a background.
- **One-shot reactivity** — `bind_audio_reactive` (`react-audio`): auto-maps a COMP's numeric knobs
  to audio bands (brightness↔level, scale↔bass, hue↔treble) and wires them in one call, with a
  master Reactivity knob. `create_data_reactive` (`react-data`): the data counterpart, mapping live
  `create_data_source` channels onto params with per-mapping range remap.
  `create_envelope_follower` (`envelope`, **experimental**): attack/release + gate/duck (sidechain a
  layer to the kick), beyond `bind_to_channel`'s plain Lag.
- **Signature effects** — `create_datamosh` (`datamosh`), `create_displacement_warp` (`warp`),
  `create_halftone` (`halftone`), `create_feedback_tunnel` (`feedback-tunnel`), and `create_text_3d`
  (`text-3d`, extruded 3D type). Plus **`apply_post_processing` gains five chainable GLSL effects**:
  `halftone`, `dither`, `crt`, `mirror`, `vhs`.
- **Sequencing & set navigation** — `create_set_navigator` (`set-nav`): a QLab-style cue-list
  navigator (Index/Next/Prev/Go, GO-on-beat). `create_beat_grid_sequencer` (`beat-grid`): a
  bar/beat step grid firing a param or cue per active step (the deterministic counterpart to
  `create_autopilot`'s drift and `create_cue_sequencer`'s linear list).
- **Parameter fidelity & wiring** — `read_parameter_modes` (`params-modes`): reports each
  parameter's mode (constant/expression/export/bind) + raw expr/bind/export, not just the value —
  the precondition for any faithful serialize/diff. `set_parameter_expression` (`set-expr`): set a
  parameter to an expression/bind/constant without the raw-Python escape hatch.
  `disconnect_nodes` (`disconnect`): remove input wire(s) — the inverse of `connect_nodes`.
- **Network round-trip & introspection** — `serialize_network` (`serialize`) + `rebuild_network`
  (`rebuild`): a COMP subtree ↔ a diffable JSON spec (params with modes/exprs + wires), reconstructed
  via the batch builder. `inspect_op_extensions_storage` (`inspect-comp`): read back a COMP's
  storage, promoted extension members, and custom-parameter definitions (the read side of the
  reusable-component loop). `get_node_state_runtime` (`node-state`): per-operator runtime telemetry
  (cook time/count, resolution, channels, GPU memory). `get_bridge_logs` (`logs`): recent cook
  errors/warnings (+ best-effort textport) for less-blind debugging.
- **Data-driven & dimensional** — `create_replicator` (`replicator`): clone a template COMP per
  Table-DAT row. `multipass_3d_depth` (`multipass-3d`): a 3D scene with a Render + SSAO pass and a
  synthetic Depth output that feeds `create_depth_displacement`/`create_depth_silhouette` without a
  depth camera. `create_pop_field` (`pop-field`, **experimental — POPs are experimental in this
  build**): a first Layer-1 generator for TD's GPU POP family; held for live render-path validation.
- **MIDI (hardware-gated)** — `create_midi_note_reactive` (`midi-notes`): MIDI notes → per-note
  reactive channels, with a **synthetic source** that previews without gear (the device path is held
  pending hardware). `create_midi_map` (`midi-map`): one-call controller presets (APC Mini /
  Launchpad / MIDI Mix / nanoKONTROL) — CC/note maps are best-effort and held pending hardware.
- **Vault library** — `save_component_to_vault` (save a built COMP as a `.tox` + a referencing
  note), `browse_vault_library` (list recipes/shaders/presets/components/setlists),
  `capture_to_vault` (still captures into a dated gallery look-book note), and
  `export_setlist_to_vault` (serialize live cues/tempo back to an `import_setlist`-compatible note —
  closing the round-trip). MCP-only (no CLI), gated on `TDMCP_VAULT_PATH`.
- **AI prompts (11 new)** — live operation: `fix_reactivity` (diagnose a wired-but-dead signal),
  `recover_show` (fast mid-show panic recovery), `auto_vj_director` (hands-free AI VJ over the event
  stream). Creative direction: `color_story`, `setlist_planner`, `lyric_show`,
  `genre_visual_language`. Critique & matching: `visual_ab_compare`, `motion_critique`,
  `match_reference_loop`. Education: `explain_param` (grounded in the 629-operator KB).
- **`tdmcp://prompts` resource** — a catalog of every MCP prompt (name + one-line purpose) so a
  model — including the local copilot, which can't see MCP prompts — can discover the creative
  recipes available.

#### CLI, config & copilot DX (post-discovery follow-on)

- **Config files + named profiles** — `loadConfig` optionally reads a `tdmcp.json` / `.tdmcprc` /
  `~/.config/tdmcp/config.json` with named `profiles`, so an artist can save per-venue setups and
  switch with `--profile club` instead of editing their shell rc. Precedence: defaults < file base <
  file profile < env < CLI flags. The stdio server honors it too (`TDMCP_PROFILE`); env still wins,
  so existing setups are unchanged, and a malformed file warns rather than crashing.
- **Per-call CLI overrides** — global `--profile` / `--config` / `--td-host` / `--td-port` /
  `--timeout` on any `tdmcp-agent` command, plus a `config` command that prints the effective
  resolved config (secrets redacted) or, with `--write-env`, a paste-ready export block.
- **`doctor` upgrades** — a new **Tools** check (surfaces `TDMCP_RAW_PYTHON` / `TDMCP_TOOL_PROFILE`
  lockouts so a missing tool has a named cause); `--fix` appends a "Suggested fixes" section
  (a remediation command per non-passing check); `--output json` + `-q/--quiet` make it
  scriptable/CI-friendly; honors the global config flags.
- **CLI ergonomics** — `-V/--version`; a "did you mean" suggestion on an unknown command;
  `--params -` (stdin) and `--params-file <path>` to complete the Unix-filter story; `-q/--quiet`
  to silence the stderr summary; and `watch --filter`/`--exclude <csv>` to select event types.
- **Local copilot tier** — `search_operators` + `list_recipes` added to every tier (read-only KB
  browse), and a new **opt-in `creative` tier** (a `creative` checkbox) that adds a curated set of
  safe Layer-1 generators (`create_generative_art` / `create_feedback_network` /
  `create_audio_reactive`) so the local model can build a whole look offline. Off by default —
  small-model generator-call accuracy is unbenchmarked.

### Changed

- **`apply_post_processing`** gains five chainable inline-GLSL effects: `halftone`, `dither`,
  `crt`, `mirror`, `vhs`.
- **`create_external_io`** gains a `video_device_out` kind (SDI / capture-card via a Video Device
  Out TOP; device par probed defensively) — hardware-gated, build-only verification.
- **`get_td_info`** now warns when the **running** Python bridge is older than this build
  (comparing to the shipped bridge version), pointing at `reload_bridge` — catching the recurring
  "edited td/ but it didn't take effect" gotcha.
- **`sync_external_clock`** gains a `mode` (`tap` | `ableton_link` | `midi_clock`):
  Ableton Link locks to a Link session via an Ableton Link CHOP; MIDI clock derives
  BPM from 24-PPQN timing. `tap` stays the default. Link/MIDI are hardware-gated
  (manual Bpm fallback when no source is present).
- **`snapshot_td_graph`** gains a `compact` mode — hoists per-type default parameters
  and delta-encodes each node for token-cheap whole-COMP reads.
- **`TDMCP_TOOL_PROFILE`** (`full` | `safe`, default `full`) — `safe` additionally hides the
  destructive / raw-code tools, including DAT overwrite/edit, component/package writes and
  preview-asset writes, as a strict superset of `TDMCP_RAW_PYTHON=off`. Use it to hand an
  autonomous in-TD agent a curated, non-destructive toolset.

[0.8.3]: https://github.com/Pantani/tdmcp/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/Pantani/tdmcp/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/Pantani/tdmcp/compare/fa7d33c2a8093d85cbad6226f62f28714a0af8fb...v0.8.1
[0.8.0]: https://github.com/Pantani/tdmcp/compare/v0.7.1...fa7d33c2a8093d85cbad6226f62f28714a0af8fb
[0.7.1]: https://github.com/Pantani/tdmcp/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Pantani/tdmcp/compare/v0.6.1...v0.7.0
[Unreleased]: https://github.com/Pantani/tdmcp/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/Pantani/tdmcp/compare/v0.8.3...v0.9.0
[0.6.1]: https://github.com/Pantani/tdmcp/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Pantani/tdmcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Pantani/tdmcp/compare/v0.4.0...v0.5.0

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
