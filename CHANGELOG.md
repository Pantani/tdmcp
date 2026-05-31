# Changelog

All notable changes to **tdmcp** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-05-31

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
  - **`create_vector_lines`** — image/video → animated line-art (contour shader) or
    Trace-SOP plotter geometry.
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

[0.7.0]: https://github.com/Pantani/tdmcp/compare/v0.6.1...v0.7.0
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
