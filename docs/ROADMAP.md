---
title: Roadmap
description: "What's shipped, what's experimental, and what's planned for tdmcp — the TouchDesigner MCP server — on the way to a stable 1.0."
---

# tdmcp Roadmap

tdmcp connects an AI assistant (Claude, Cursor, Codex…) to TouchDesigner so you
can build real visual systems from plain language — no node-wiring by hand. This
page is the honest, bird's-eye picture of **what already works, what's still
rough, and what's coming next** on the way to a stable 1.0.

**Where things stand today.** The npm `latest` package is **v0.9.0**; the latest
GitHub Release/tag is still **v0.8.3** as of June 12, 2026. v0.9.0 is the
hype-scout Round 4 campaign release: force multipliers, POP combos, the
generative-AI bridge wave and the VFX aesthetic tail. It also includes the
Hermes/Telegram AI Party policy wrapper and the local Live Nervous System
rehearsal POC. The v0.8.3 GitHub release remains the last tagged release object:
a live-show resilience + LLM token budget + CLI-ergonomics wave that brought the
tool surface from 279 → **286** and added two bridge REST endpoints plus
`tdmcp init` / `tdmcp ask`; see [Wave 12 — v0.8.3](#wave-12-v0-8-3) below.
The CHANGELOG blocks list every entry; the always-current tool list is the
[Tools reference](/reference/tools). 1.0 is **not** the next minor — the v0.9.x
line is the active feature/consolidation line, and v1.0 will land only once the
consolidation gates below are all green.

The project has grown through five arcs:

1. **Generate** — one-line tools that build a whole wired network (audio-reactive,
   generative, feedback, 3D, particles, shaders).
2. **Perform** — turn those networks into playable instruments (cues, macros,
   control surfaces, a phone remote, beat sync, a hands-free auto-VJ).
3. **Package & operate** — reusable components, project analysis, token-cheap
   editing primitives, and a structured bridge that keeps working in a
   locked-down venue.
4. **Compose & automate** *(v0.7.0)* — run a whole
   arranged show over time, with timelines, setlists, schedulers, cue composition
   and live-safety controls.
5. **Ingest & extend** *(v0.7.x through v0.8.x)* — pull
   in the wider TouchDesigner world (Shadertoy / ISF shaders, Ableton, the
   iconic VJ looks), then deepen AI/library publishing and operator DX. Waves
   1-3 are in v0.7.0; v0.7.1 ships the first CLI/copilot/resource/bridge
   follow-through; v0.8.1 closes the current generator, MediaPipe, session
   profile, dashboard, inline-preview and resilience queue.

> **How to read this page**
>
> - ✅ **Shipped** — in a released version you can install today.
> - 🧪 **Experimental** — shipped and usable, but needs live tuning or specific
>   hardware to shine (flagged so you know what to expect).
> - ⬜ **Planned** — designed and prioritized, not yet built.
>
> The dated, line-by-line record of every change is the
> **CHANGELOG** (`CHANGELOG.md` in the repository root); the
> always-current, complete tool list is the [Tools reference](/reference/tools).
> This page is the overview. Curious about the long tail of ideas? The full,
> unfiltered brainstorm is preserved in the [planning archive](#full-backlog) at
> the end.

---

## ✅ Current Release Line

### Unreleased — MediaPipe hands -> TDAbleton mapper + AI Party rehearsal POC

Source-tree work after v0.8.3 adds a focused live-control path for the Ableton
session we validated manually:

- **`create_hand_ableton_mapper` (Layer 2).** Builds the TouchDesigner side of a
  MediaPipe-hands performance controller for TDAbleton: `map1` left pinch,
  `map2` right pinch, `map3` left wrist roll, `map4` right wrist roll, plus a
  `mapper_send` CHOP and skeleton overlay with star joints.
- **`diagnose_tdableton_mapper` (Layer 2).** Checks the real `TDA_Mapper` target,
  input CHOP, `Reorder`, bypass states, `Min/Max` ranges and missing `map1..map4`
  channels, with optional TD-side repair. AbletonMCP is not required for this
  runtime path.
- **Live Nervous System / AI Party local rehearsal POC.** The repo now includes
  `src/automation/aiPartyLive/` and `npm run ai-party:{dev,dry,td-build,test,telegram}`:
  a local dashboard/backend, approval queue, JSONL audit log, optional Ollama
  parser, optional Telegram long polling and optional TouchDesigner preview
  network. It remains simulation-first; real venue hardware still needs a
  separate adapter, fixture map, emergency-stop path and venue validation.
- 🧪 **Creative RAG (opt-in, experimental).** A local-only creative
  repertoire of open-licensed artworks/artists/techniques: `tdmcp creative-rag
  {sync|index|search}` plus read-only `tdmcp://creative/cards/{id}` and
  `tdmcp://creative/search` MCP resources. Off by default (`TDMCP_RAG_ENABLED=0`);
  **seven live sources** — four keyless museum APIs (Art Institute of Chicago,
  The Met, Rijksmuseum, Cleveland Museum of Art) plus ✅ **Smithsonian Open
  Access** (key-gated), ✅ **Wikimedia Commons** (keyless), and 🧪 **Europeana**
  (key-gated, field map UNVERIFIED until a real keyed sync) — in-memory cosine
  over a local JSONL index, embeddings via local Ollama. **Repertório, não
  policy** — no bridge, DMX, or Python exec. Shipped follow-ups: ✅ embedding
  batching (`TDMCP_RAG_EMBED_BATCH`), ✅ content-type-aware binary extensions,
  ✅ versioned/migration-tolerant index lines, and 🧪 an experimental
  `TDMCP_RAG_BACKEND=lancedb` vector store (optional `@lancedb/lancedb` dep,
  falls back to JSONL when absent). Remaining stub sources: Harvard, Cooper
  Hewitt, Internet Archive, WikiArt, portfolios, Shadertoy. See
  [Creative RAG](./CREATIVE_RAG).

### Wave 12 — v0.8.3 (live-show resilience + LLM token budget + CLI ergonomics) {#wave-12-v0-8-3}

Shipped as **v0.8.3** on top of v0.8.2. Tool surface grows
from 279 → **286**. Live-validated on TD 099 build 2025.32820 unless flagged
UNVERIFIED in CHANGELOG. Tagged `v0.8.3`; npm publish happens out-of-band via the
release workflow when `NPM_TOKEN` is set.

- **Live-show resilience (Layer 1).** `create_safety_blackout_chain` (panic
  blackout + fade-back recovery), `create_setlist_runner` (timed multi-track
  set with stage overrides), `create_show_failover` (watchdog + auto-failover
  between two render paths), and `create_pose_reactive` (MediaPipe pose →
  reactive particle / displacement) — the last one **closes ROADMAP A.6**
  (`create_pose_reactive` is no longer deferred).
- **Auto-repair loop (Layer 2).** `auto_repair_loop` runs `repair_network`
  on a cadence until errors clear or a budget hits.
- **LLM token budget (Layer 3 + resource).** `compact_graph_digest` emits a
  compact JSON digest of any subgraph; the matching MCP resource
  `tdmcp://digest/{path}` is registered in the `LLM_TOOLS` basic tier so a
  local copilot can hydrate context without re-running heavy inspection tools.
- **Vault.** `scaffold_recipe_from_network` exports a working subgraph as a
  draft recipe in the vault.
- **Two new first-class bridge REST endpoints** that survive
  `TDMCP_BRIDGE_ALLOW_EXEC=0`, continuing the G4 endpoint sweep:
  `POST /api/perform` (promotes `set_perform_mode` off exec) and
  `POST /api/param_modes/batch` (with new client `readParameterModesBatch`).
  Both tools keep their exec fallback.
- **CLI ergonomics.** `tdmcp init` — one-shot onboarding that stages the
  bridge, writes a client config (Claude / Cursor / Codex), seeds a profile
  and an optional bridge token, all with `--dry-run` + `--json`. `tdmcp ask`
  — non-interactive copilot turn: pass a prompt, get one answer back (with
  optional `--json` envelope, tool-call counts, `--read-only` / `--creative`
  tier and `--timeout` cap). See [CLI reference](/reference/cli).
- **`create_audio_reactive` extension.** Opt-in `transient_gate` +
  `sidechain_duck` modulation bus (4 new flags); defaults preserve the
  byte-identical container so existing prompts keep working.
- **Fixes since 0.8.2.** `create_histogram_scope` distribution curve
  (Pattern CHOP tx/tz synthesis); `create_control_panel` rgb 3-target
  binding; resilient MediaPipe DAT/mask lookup across `setup_face_tracking`
  / `setup_hand_tracking` / `setup_segmentation`.

### v0.8.2 — Stabilization patch: REST bridge expansion, recipe library, coverage push

v0.8.2 is the public tag for the 0.8 stabilization line. Same tool surface as
v0.8.1 (279 tools) — this release **does not add new tools**, it stabilizes the
existing surface ahead of v1.0:

- **Four new bridge REST endpoints** that survive `TDMCP_BRIDGE_ALLOW_EXEC=0`:
  `POST /api/transport` (timeline play/pause/seek/cue/rate),
  `GET /api/system` (gpu + monitors + performMode),
  `GET /api/projects/<path>/analysis` (project analysis port of the previously
  embedded Python script), and
  `GET /api/nodes/<path>/custom_params` (custom-par readout for COMPs).
- **Seven tools promoted REST-first** with `tryEndpoint(REST, exec-fallback)`:
  `snapshot_td_graph`, `control_timeline_transport`,
  `inspect_gpu_and_displays`, `analyze_project`, plus the custom-params slice of
  `serialize_network` and `inspect_component`, and a snapshot+rollback flow on
  `repair_network` (steps revert if `errors_after >= errors_before`).
- **`bridge_watch_build` shipped**: `tdmcp-agent watch-build` gates changed
  bridge Python with `py_compile` and reloads the running bridge automatically
  unless disabled.
- **Recipe library expansion**: +16 first-party recipes (15 → 31) covering the
  v0.7–v0.8 generators (kinetic text, decks, 3D scene, depth+displace,
  optical-flow particles, MediaPipe face overlay, scene timeline, GLSL plasma,
  pose skeleton standalone, particle system basic, feedback network basic,
  audio reactive basic, keyframe animation basic, video synth oscillator).
- **Tool API contract** reference page published at `/reference/tool-contract`
  documenting the v1.0 invariants (naming, schema, error handling, offline
  behaviour, result shape, deprecation).
- **Coverage gates raised**: `functions: 80 → 82` in `vitest.config.ts`;
  global Br now at 72%+. New test suites for `src/index.ts`, `src/cli/agent.ts`
  (wave-5 + wave-9), `src/cli/tui.ts`, `src/cli/doctor.ts`, `src/llm/server.ts`,
  `src/llm/client.ts`, `src/packages/cli.ts`, plus targeted regressions for
  `detect_pitch`, `repair_network` rollback, `create_envelope_follower` ducking
  topology, and a vault round-trip determinism suite. Three pre-existing flaky
  fs-heavy tests (`provenanceStamp`, `styleMemory`, `vaultRepoSync`) hardened.
- **Roadmap honesty pass**: Experimental / Out-of-scope / Planning archive
  reconciled (no shipped item lingering as backlog; gated items split into
  hardware / GPU / multimodal-LLM / paid-license buckets).
- **Bug fixes**: `detect_pitch` `notes` string now advertises the actual
  `DEFAULT_THRESHOLD = 0.0005` (was the stale `0.02`); `repair_network` no
  longer leaks `_snapshot` between invocations; `kinetic_text_audio_reactive`
  recipe now uses `audiofilterCHOP` (`audiobandeqCHOP` does not expose
  `loband`/`hiband`).

### v0.8.1 — v0.8 feature line, session profile and resilience patch

v0.8.1 is the public tag for the 0.8 release line. It includes the v0.8.0
npm-published feature expansion plus the post-merge resilience patch and the
missing public registration for `load_session_profile` /
`tdmcp://session/profile`. The generated Tools reference exposes **279 tools**:
the new AI-session tool, the generator and MediaPipe tools listed below,
dashboard-v2, N-channel `create_decks`, portable-tox README, Mermaid
`generate_readme`, the new MCP resources, and the AI Show Director.

- **Persistent AI session profile.** `load_session_profile` loads or initialises
  a local session snapshot (style, similar prior work, learned conventions and
  corpus notes), and `tdmcp://session/profile` exposes that snapshot as a JSON
  resource so an agent can hydrate context without re-running heavier vault
  tools every turn.
- **Release-resilience patch.** Vault writes, package state writes and staged
  package installs are atomic; HTTP transport listen failures reject cleanly and
  close event streams; failed Streamable HTTP initialization closes the per-
  session server; bridge GET retries now include transient 5xx API errors; and
  the layer-3 endpoint-first / exec-fallback policy is centralized in
  `tryEndpoint`.
- **Top-level package-manager discoverability.** `tdmcp --help` now expands the
  package-manager tree (`search`, `list`, `info`, `install`, `uninstall`,
  `doctor`, `packages path`) instead of hiding it behind one summary row, and
  `tdmcp packages --help` / `tdmcp completion <bash|zsh|fish>` include those
  package commands and common package flags.
- **Expanded `doctor --fix` repairs.** `tdmcp-agent doctor --fix` creates a
  missing configured `TDMCP_VAULT_PATH`, scaffolds the default profile directory,
  writes a missing bridge token to `.env` without printing the secret, can run
  `install-bridge --verify` behind a bounded repair hook, attempts a macOS
  Textport auto-install when the bridge still needs the manual `install.run()`
  step, and still prints suggestions for checks that need manual action.
- **Script-compatible run files.** `tdmcp-agent run` now forwards global
  `--no-color` into nested JSON/stdin steps, and individual run-file steps can
  set `"no_color": true`.
- **Bridge watch-build hot reload.** `tdmcp-agent watch-build` now treats saved
  changes under `td/` as runtime bridge edits: after typecheck/build pass, it
  runs `python -m py_compile` on changed `.py` files and calls `reload_bridge`.
  `--no-py-compile` and `--no-reload-bridge` provide opt-outs for build-only
  loops.
- **Offline MCP resource follow-through.** `tdmcp://glsl-snippets` exposes the
  vetted in-repo GLSL snippet catalog, `tdmcp://cheatsheets` adds compact
  workflow reminders with resource refs, and `tdmcp://learning/touchdesigner`
  pairs the existing `teach_touchdesigner` prompt with a curated KB-backed
  learning path.
- **N-channel `create_decks`.** `create_decks` now keeps the legacy A/B
  crossfader path intact while adding an explicit `decks[]` mode for 2-8 decks:
  per-deck source/gain chains, per-deck FX-send branches into an additive bus,
  an additive FX return into the master, a running Cross TOP program mix, and a
  hard-cut Switch TOP blended back into program with `cut_mix`.
- **Portable component docs.** `make_portable_tox` now writes a package
  `README.md` by default, documenting node inventory, custom parameters,
  inputs/outputs and external file references beside the `.tox` and manifest.
  `include_readme:false` keeps the old lean package shape.
- **Versioned recipe-bundle publishing.** New `publish_recipe_bundle` writes a
  local publish artifact folder: the recipe bundle JSON, a
  `tdmcp-recipe-publish.json` manifest with release version/recipe IDs, and a
  `tdmcp-checksums.json` SHA-256 manifest for repeatable handoff or later CI
  upload.
- **Deferred GPU-style generators (CPU/GLSL paths).** Four roadmap Milestone 2/4
  generators now ship as stock-TD networks — no CUDA, no external models:
  - `create_sdf_field` builds a programmable signed-distance-field raymarcher
    (CSG tree of sphere/box/torus with union/intersect/subtract + smooth blend)
    inside a single GLSL TOP, with live camera/step-count/intensity/colour
    controls.
  - `create_strange_attractor` runs a Script-CHOP-integrated ODE (Lorenz /
    Aizawa / Halvorsen) into a Script-SOP polyline + optional tube + Geometry /
    Camera / Light / Render pipeline for deterministic CPU geometry.
  - `create_optical_flow` builds a CPU optical-flow vector field from a video
    source out of stock TOPs (blur, monochrome, cache, composite subtract,
    optional edge, math, feedback+level), producing an RG-packed flow TOP usable
    as a drop-in modulator for displacement / particle chains.
  - `create_histogram_scope` adds the Milestone-2 histogram panel as a focused
    tool: GPU GLSL TOP bins → CHOP normalisation → `choptoSOP` → render TOP,
    luminance + optional per-channel RGB.
- **MediaPipe face + hand + segmentation (camera-only).** Three new one-shot
  adapters on the in-tree tracking engine:
  - `setup_face_tracking` loads the MediaPipe ENGINE and builds an adapter
    Script CHOP that emits a 468-sample (478 with iris) face-landmark CHOP
    (tx/ty/tz/confidence, centred on nose tip), ready for `bind_to_channel`
    and `create_data_visualization`.
  - `setup_hand_tracking` reuses the same engine and emits a canonical
    `max_hands×21`-landmark CHOP (tx/ty/tz/confidence/handedness),
    `coordinate_space='world'` recommended for gesture detection, ready for
    `bind_to_channel` or `create_pose_skeleton`.
  - `setup_segmentation` reuses the same engine, enables selfie-segmentation
    and publishes a clean alpha-mask Null TOP (+ optional pre-keyed
    `person_rgba` Null TOP), ready for `create_keyer`, `create_depth_silhouette`
    or any matte-consuming chain.
- **Inline preview pass (`get_inline_preview`).** New Layer-3 inspection tool
  returns a bounded TOP thumbnail (default 256×256, capped at 1024) together
  with resolution, pixel format, cook metadata and post-cook node errors in a
  single structured payload, so agents can verify a build without juggling
  `get_preview` + `get_td_node_errors`. **Closes the Milestone-4 inline preview
  pass.**
- **Front-of-house dashboard v2 (`create_stage_dashboard layout:"v2"`).**
  Opt-in dashboard layout adds a stereo VU pair, a BPM readout fed by an
  optional `tempo_channel` (e.g. a `detect_tempo` Null CHOP), an FPS / cook-time
  / frame overlay, a cue timeline strip driven by an optional `cue_times[]`
  array (pairs from `compose_cue_list`), and a sticky confirm-tap PANIC bar.
  `layout:"v1"` remains the default and is byte-for-byte unchanged.
  **Closes the Milestone-4 front-of-house dashboard pass.**
- **Stronger component READMEs (`generate_readme`).** New `include_mermaid:true`
  embeds a Mermaid flowchart of the operator graph in the "Data flow" section,
  and a `max_nodes` cap (default 200) truncates the Child inventory table with a
  one-line "_N more nodes not shown_" footer so large components produce
  scannable READMEs. Together with the existing `make_portable_tox` package
  README (license/manifest metadata + inventory), this **closes the Milestone-3
  trust & publish polish item**.

### v0.7.1 — Operator DX, local copilot & bridge-health patch

v0.7.1 is a patch release on top of v0.7.0. It keeps the public story focused on
operator reliability rather than introducing a new campaign label: the same
BEYOND / Ingest & Extend release line, now with a cleaner CLI, richer local
copilot context, more MCP resources, and a small read-only runtime diagnostic.

- **CLI/operator DX.** `tdmcp --help` prints usage without starting the MCP
  server; `tdmcp-agent run -` reads run files from stdin; `--continue-on-error`
  finishes a batch and returns the first failure; saved venue profiles can be
  listed/inspected with secrets redacted; `tdmcp-agent commands --json` and
  `tdmcp://commands` expose the command catalog; grouped help and
  `tdmcp-agent help <command>` make the CLI easier to scan.
- **Install, transport and watch ergonomics.** `tdmcp install-client --write`
  deep-merges and verifies Claude/Cursor/Codex config files; the bridge
  installer now has `--verify`, `--wait` and `--port` polling against
  `/api/info`; `tdmcp serve --http [--port]` starts loopback Streamable HTTP
  without changing the default stdio behavior; list commands can render
  table/CSV; the REPL has persistent history and Tab completion; and
  `tdmcp-agent watch` adds pretty output, event counts, heartbeats and debounced
  exec hooks.
- **Local copilot and resources.** `tdmcp://prompts` is generated from the real
  prompt registry, `tdmcp://recipes/search/{query}` searches recipes, and
  `tdmcp://cookbook` / `tdmcp://cookbook/{en|pt}` expose the prompt cookbook to
  MCP clients. The local copilot reads that prompt catalog, accepts
  `--read-only`, `--creative`, `--prompt`, `--profile` and `--config`, and can be
  tuned with `TDMCP_LLM_TIER`, `TDMCP_LLM_MAX_STEPS` and
  `TDMCP_LLM_TEMPERATURE`.
- **Bridge/runtime diagnostics.** `get_node_state_runtime` can opt into temporary
  Info CHOP sampling with `include_info_chop:true`; the bridge now serves
  `GET /api/health`; and **`watch_node`** adds a read-only short-window sampler
  for one operator's state, parameters and CHOP channels. Tool registry:
  **268 → 269**.
- **Packaging hygiene.** The release/bundle path no longer emits the deprecated
  `whatwg-encoding` chain or the staged production-install `mute-stream`
  `EBADENGINE` warning fixed after v0.7.0.

### v0.7.0 — BEYOND, Ingest & Extend, and operator DX foundation

v0.7.0 was one consolidated release train. It shipped the BEYOND campaign, the
Ingest & Extend waves, the Wave-3 smarter-assistance/library-publishing work, and
the `create_data_source_http_ws` hotfix documented in `CHANGELOG.md`.

#### BEYOND campaign

- **Wave 1 / v0.7.0 manifest — live-show foundation + all P0.** Shared
  setlist/scene schema, memory-note schema, server-sampling LLM fallback,
  `setlist_runner`, `create_scene_timeline`, `create_auto_montage`,
  `create_euclidean_sequencer`, `create_preset_morph`, `create_scheduler`,
  `create_glsl_material`, `auto_tag_library_asset`, `recall_similar_work`,
  `style_memory`, `lint_recipe_library`, plus `tdmcp panic` and
  `tdmcp dashboard`.
- **Wave 1.5 / folded into v0.7.0.** `import_setlist` and
  `export_setlist_to_vault` now share `SetlistSchema`; `scaffold_vault` seeds
  `Memory/README.md` and `Memory/style.md`; `save_recipe_to_vault` and
  `save_component_to_vault` can opt into deterministic auto-tagging.
- **Wave 2 — show automation + musical reactivity.** `compose_cue_list`,
  `create_prob_sequencer`, `create_automation_lane`, `scene_scheduler`,
  `create_chroma_reactive`, `create_transient_reactive`,
  `create_energy_structure`, `create_two_way_surface` and
  `create_phone_gesture`. The last two remain hardware-gated; the three
  musical-reactivity tools are experimental.
- **Wave 3 — library provenance + AI dispatch + scene resource.**
  `provenance_stamp`, `checksum_and_verify_pack`, `library_lineage_graph`,
  `morph_pack`, `learn_conventions`, `moodboard_to_system`,
  `audio_fingerprint_to_visual`, `score_build`, and the live
  `tdmcp://scene/{view}` resource.
- **Wave 4 — TD-depth authoring + DX accelerators.** `create_engine_comp`,
  `create_dmx_fixture_pipeline`, `scaffold_tool_generator`,
  `extend_data_source_fabric`, `build_chop_chain`, `author_script_operator`,
  `profile_cook_cost`, `control_timeline_transport`,
  `inspect_gpu_and_displays`, `macro_recorder`, `tdmcp-agent watch-build` and
  `tdmcp-agent soundcheck-monitor`.
- **Wave 5 — final BEYOND tail.** `curated_collection_pack`,
  `component_changelog_trail`, `merge_vaults`, `vault_repo_sync`,
  `variant_pack`, `learn_from_my_corpus`, `create_shared_memory_bridge`,
  `build_sop_geometry`, `sync_timecode`, `manage_component_storage`,
  `enhance_build`, `create_growth_system`, `run_macro_script`,
  `tdmcp-agent log-tail`, `record-fixtures`, `fanout`, `controller-bridge`,
  and `voice` / `llm-voice`.

#### Smarter assistance, library publishing & operator DX

The Wave-3 backlog of the Ingest & Extend campaign shipped in v0.7.0. Sub-batch A
delivered 3 pure-Node library/publishing tools, sub-batch B shipped 6 TD-required
AI/library tools, and sub-batch C closed the colour-finish polish while opening
the Milestone-4 operator DX lane.

Sub-batch A — pure-Node library/publishing:
- ✅ **`tag_and_search_library`** — faceted browse + tag editing over the vault
  library (Recipes/ + Components/ markdown notes). `op:list`/`op:search`/`op:tag`,
  preserves `'*'`-pinned user tags.
- ✅ **`version_library_asset`** — SemVer patch/minor/major bumps for a vault
  asset, recorded in a sidecar `<asset>.versions.json` and written back to the
  note's frontmatter `version`.
- ✅ **First canonical recipe pack — `generative_classics_pack`** — curated
  6-technique pack that emits an `import_recipe_bundle`-compatible bundle JSON.

Sub-batch B — TD-required (live-validated against TD 099 build 2025.32820):
- ✅ **`extract_palette`** — K-color palette from a TOP via deterministic
  k-means on its preview PNG.
- ✅ **`export_sop_to_svg`** — SOP polylines → SVG (pen-plotter / laser / print).
- ✅ **`swap_operator`** — change an op's TYPE in place, preserving wires +
  matching parameters (fail-forward).
- ✅ **`export_look_tox`** — save a COMP as a portable `.tox` into the vault
  with a Markdown sidecar for `browse_vault_library` / `tag_and_search_library`.
- ✅ **`tutorial_companion_pack`** — scaffold a teaching companion (lesson
  markdown + topology + previews + a `network_snapshot.json` documentary snapshot,
  explicitly not a RecipeSchema-installable recipe) into the vault.
- 🧪 **`copilot_vision`** — multimodal LLM query over a TOP preview.
  Live-tuning UNVERIFIED — no multimodal LLM endpoint configured in this
  session; mechanism (preview capture + `ctx.llm.complete()` contract) is
  covered by tests.

Sub-batch C — colour finish + authoring/DX:
- ✅ **`create_color_wheels`** — lift / gamma / gain RGB tints plus master
  offset and saturation controls.
- ✅ **`create_pop_geometry`** — POP-family-style procedural geometry rig:
  primitive → transform → subdivide → noise → material SOP chain, rendered
  through a Geometry COMP + Render TOP.
- ✅ **`tdmcp-agent config init`** — safe starter `.env` config writer for every
  `TDMCP_*` variable, with `--force` and `--dry-run`.
- ✅ **`elicit_missing_args`** — verified shipped in v0.7.0 after the Wave-3C
  audit; schema-driven elicitation has offline / no-server fallbacks.

#### Ingest & Extend

The Ingest & Extend campaign is folded into this release line. Waves 1-2 grew the
tool registry from 243 → 257, and Wave 3 completed the v0.7.0 release at 268
tools. The follow-up hotfix fixed the previously fatal HTTP-poll path before the
public v0.7.0 cut.

- **Wave 1 / v0.7.0 — ecosystem on-ramp + signature looks.**
  Shared `foundation_glsl_top_mapping` (preamble injection, ISF INPUTS →
  custom-page mapping) plus the importers and signature looks it unlocks:
  `import_shadertoy`, `import_isf_shader`, `create_fluid_sim`,
  `image_to_particles`, `create_dither`, `create_jfa_voronoi`.
- **Wave 2 / v0.7.0 — external inputs + color-finish + rehearsal (✅ included in v0.7.0).**
  `apply_lut` (OCIO / image-lookup / .cube fallback), `create_video_scopes`
  (waveform / RGB parade / vectorscope — histogram deferred, TD 099 lacks
  `histogramCHOP`), `setup_tdableton` (Palette probe + OSC synthetic fallback),
  `create_chop_recorder`, `create_flow_abstraction` (ETF→FDoG painterly),
  `create_npr_filter` (Kuwahara oil/pencil/watercolor — also three new
  `apply_post_processing` mode keys), and `post_passes_3d` (SSAO / SSR / DOF /
  motion-blur for 3D scenes — `apply_post_processing` now redirects 3D-only mode
  callers here with a friendly error).
- **`create_data_source_http_ws` hotfix** *(✅ fixed before v0.7.0).*
  The HTTP-poll path no longer raises `TypeError: must be real number, not str`;
  the dattoCHOP menu settings, selector table shape and live-readout custom
  parameters were corrected and live-validated against TD 099 build 2025.32820.

## ✅ Published releases

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

These are usable in the latest public release, but they carry an honest caveat —
they need live tuning, specific hardware, or a final on-hardware check before
they're considered solid.

- **Live-music tuning** (offline-built, defaults need real music to graduate):
  `create_chroma_reactive`, `create_transient_reactive`,
  `create_energy_structure`. Schemas, network topology and unit tests are
  green; only the perceptual defaults remain experimental.
- **Hardware round-trip pending** (builder is offline-tested, only the live
  device exchange is unverified): `create_two_way_surface` (MIDI/OSC guards),
  `create_phone_gesture` (smartphone sensors).
- **Multimodal-LLM dependent**: `caption_top`, `copilot_vision`. Tool schema
  and prompt assembly are unit-tested; output quality is gated on a stable
  multimodal endpoint — see *Out of scope* below.
- **Rollback tuning** (offline-improvable): `repair_network` ships with offline
  unit tests; the snapshot/restore loop will get a dedicated regression test
  before it leaves experimental.
- **Obsidian vault tools** — fully unit-tested, but their live round-trip inside a
  running TouchDesigner hasn't been exercised end-to-end yet. The pure
  serialization↔deserialization round-trip is offline-improvable and queued.
- **Signal-detection tools**:
  - `detect_pitch` — known issue: default threshold can read near-zero on
    quiet inputs. A regression test pinning the default behaviour is queued;
    until then, pass an explicit `threshold` for reliable readings.
  - `detect_tempo` — BPM lock validated against synthetic clicks; live music
    tuning still required.
  - `create_envelope_follower` — sidechain routing topology is unit-tested;
    perceptual gate/duck timings need a real source.
- **`learn_control`** — interactive MIDI/OSC "learn"; schema/modes are
  offline-tested, the input-event stream depends on live hardware.
- **`create_pop_field`** — a first generator for TouchDesigner's GPU **POP**
  family, which is itself experimental upstream in this build; the render path
  is held pending live validation.
- **MIDI hardware tools** — `create_midi_note_reactive` and `create_midi_map`
  preview fine from a synthetic note source, but the real device paths need a
  controller to confirm.
- **External-clock sync** — `sync_external_clock` `mode='tap'` is stable
  (offline-tested, default). Modes `ableton_link` and `midi_clock` are
  hardware-gated; a manual-BPM fallback keeps the tool usable when no clock
  source is present.
- **v0.6.x bridge-routing regression check** — the seven v0.6.0 features were
  each validated live in TouchDesigner, but the full bridge reinstall plus live
  HTTP routing round-trip remains a recurring smoke check after bridge or
  installer changes.

---

## ⬜ Planned — the road to 1.0 {#planned}

With v0.8.1 published, the deferred SDF, strange-attractor, optical-flow and
histogram-scope generators; MediaPipe face / hand / segmentation adapters; the
persistent `load_session_profile` (+ `tdmcp://session/profile` resource);
additional `doctor --fix` repairs; the new `get_inline_preview` inspection tool;
the front-of-house dashboard v2 layout; and the stronger `generate_readme` /
`make_portable_tox` component-doc pass are all in the current release line.
The pre-Round-4 Planned list was empty (all v0.8.x queued items shipped); the
**2026-06-09 hype-scout** ([Round 4](#appendix-d-round4)) reopened it with a
trend-driven set of buildable wins. The remaining work toward a tagged 1.0
splits in two: **consolidation** (API stability, coverage, recipes, bridge
hardening, docs, one-click install) tracked in
[v1.0.0 — Consolidation](#v100-consolidation), **plus the small Round-4
quick-win wave** (force multipliers + the top-5 hand-to-pipeline items) listed
under Milestone 3 just below. Only items that still need a future code change
(not a hardware/service blocker) belong in this Planned section.
Hardware-, live-music-, multimodal-LLM- and GPU/CUDA-gated items have been
moved to **Out of scope (for now)** below. Version targets are a rough
sequence, **not a promise**. One additional design-stage slice is tracked here:
a Soundcraft Ui24R / mixer-aware expansion of AI-Controlled Party. It belongs in
Planned because it needs future code changes, but it is **not shipped** and
**not a live hardware claim**. The exhaustive, item-by-item backlog lives in the
[planning archive](#full-backlog).

### Creative RAG follow-ups (post-#76) {#planned-creative-rag}

The Creative RAG MVP (#75) and the post-MVP robustness wave (#76 — embedding
batching, `indexVersion` migration, Content-Type binary extension, Smithsonian
+ Wikimedia Commons + Europeana sources, optional `TDMCP_RAG_BACKEND=lancedb`)
are **Shipped** above. The remaining follow-ups are tracked here:

- **[P2 product]** `SourceSkippedError` — distinguish "no key" from "empty
  source" so a misconfigured key-gated source never tombstones real cards.
- **[P2 product]** Configurable multilingual embedding model (e.g. `bge-m3`)
  with a CI smoke that swaps the model.
- **[P2 product]** `canonicalizeGuid` regression test pinning the rule that
  source URLs / ids never embed an API key (the lesson from the Europeana
  `wskey` strip).
- **[P3 integration]** Optional RAG context injection in `tdmcp ask` (flag-
  gated; must not change tool tiers or confirmation gates).
- **[P3 integration]** MCP prompt `creative-inspiration` returning a curated
  mood-board payload (search + a handful of `tdmcp://creative/cards/*` URIs).
- **[P3 integration]** Opt-in MCP tool `apply_creative_card` that routes a
  card's `tdmcpAffordances` to the right Layer 1/2 tool — closes the
  inspiration → execution loop without expanding the default tool surface.
- **[P3 ops]** `tdmcp doctor` coverage for RAG: Ollama reachable, embedding
  model pulled, `TDMCP_RAG_DATA_DIR` writable; surfaced in `--json` output.
- **[P3 ops]** Mandatory probe-live step for every new source PR (lesson from
  the Europeana key-leak and Rijksmuseum shape drift — mock-only tests missed
  both).

### Milestone 3 — Round-4 quick-win wave · v0.8.x / v0.9.x {#milestone-3}

Pulled forward from [Round 4](#appendix-d-round4) — every item is S-effort,
sits on existing scaffolding, and ships before the AI-bridge wave so the
force multipliers are in place when those wrappers land.

**Force multipliers (do these first — D.0):**

- ✅ **FM-01 — `create_external_io` outbound modes** (`ndi_out`,
  `syphon_spout_out`) (shipped v0.9.0). Two KB-confirmed stock TOPs, additive
  to the existing `_TYPEMAP` literal. Unlocks every TD↔AI bridge below.
- ✅ **FM-02 — `dropExternalTox` helper** (shipped v0.9.0) for the canonical
  dotsimulate TOX-drop pattern (discover paths → drop into `baseCOMP` →
  validate custom pars → OSC-bind). Removes copy-paste between
  StreamDiffusion / ComfyUI / DepthAnything / LOPs / TDGS / MediaPipe
  wrappers.
- ✅ **FM-03 — Layer-2 `build_pop_chain`** generic POP chain builder over
  `NetworkBuilder` (shipped v0.9.0). Unblocks the 5 POP-combo Layer-1 tools.

**Top-5 ready-for-pipeline (D.1):**

- ✅ `create_pose_controlnet_driver` — OpenPose-color render TOP over the
  existing pose stack; no external TOX (Hype × Ease = 9). (shipped v0.9.1)
- ✅ `create_ascii_render` — character-grid TOP alongside `create_dither` /
  `create_halftone` (Hype × Ease = 9). (shipped v0.9.1)
- ✅ `create_phrase_locked_cue_engine` — extension to `createSyncExternalClock`
  that quantizes cues to Ableton bars/phrases. (shipped v0.9.1)
- ✅ `create_audio_glsl_uniforms` — Layer-2 helper that binds audio CHOPs as
  uniforms on `glslTOP`. (shipped v0.9.1)
- ⬜ `create_external_io` outbound — itself FM-01 above.

### Milestone 4 — Generative-AI bridge wave (gated on FM-01 + FM-02) · v0.9.x

The trend-dominant cluster from [Round 4 D.2](#appendix-d-round4) — wrappers
around components users install themselves; never bundled. All entries
*remain* GPU/CUDA-gated for the *bundled* path; this wave ships only the
**drive-installed-tox** and **cloud** deltas.

- ⬜ `setup_mediapipe_plugin` (torinmb canonical) — extension over the
  shipped face/hand/segmentation setup.
- ⬜ `drive_streamdiffusion` (dotsimulate TOX wrapper).
- ⬜ `create_depth_from_2d` (TDDepthAnything v2 wrapper; reopens the
  Round-3 EX placeholder).
- ⬜ `connect_comfyui` (olegchomp/TDComfyUI or JiSenHua/ComfyUI-TD).
- ⬜ `connect_daydream_cloud` (cloud path that skips the local GPU gate).
- ⬜ `create_gaussian_splat_scene` (TDGS / POPs Gaussian-Splat v2026) —
  the top trend in the scout, four-surface unanimous H.
- ⬜ `create_llm_chain` (dotsimulate LOPs).
- ⬜ `create_ai_mirror` combo recipe (depends on the bridge above + FM-01).

### Milestone 5 — AI Show Director mixer scene arming · v0.8.x / v0.9.x

Design status: `_workspace/ai-party-mixer/05_synthesis_design.md` and
`docs/superpowers/specs/2026-06-04-ai-party-ui24r-scene-arming-design.md`
define the first safe slice.

| Item | Delivers | Status | Gate |
| --- | --- | --- | --- |
| `arm_mixer_scene` contract | A new Show Director intent for operator-approved Soundcraft Ui24R show/snapshot/cue arming, separate from blocked `mixer_gain`, `pa_mute` and `audio_routing` effects. | ⬜ Planned | Must remain dry-run and approval-gated; valid targets come only from a trusted scene catalog. |
| Mixer scene catalog / manifest | Venue-side allowlist with stable scene IDs, Ui24R show/snapshot/cue refs, policy hash/checksum, allowed setlist sections, rollback target and safety notes. | ⬜ Planned | Any scene that may hide gain, PA mute, routing, patching, channel-strip, mute-group or phantom-power changes stays operator-only/manual. |
| Dry-run mixer adapter | Adapter interface and dry-run backend that consumes approved mixer-scene plans and returns `hardware_changed:false`. | ⬜ Planned | No Soundcraft, Companion, Node or TouchDesigner hardware client may be constructed in this slice. |
| Companion live backend spike | Bitfocus Companion backend for one bench-validated Ui24R scene mapped to one preconfigured button. | ⬜ Planned | Isolated bench validation required; `sent`/`acknowledged`/`confirmed` must be separate audit states. |
| Direct Node bridge research | Protocol proof for show/snapshot/cue recall against the target Ui24R firmware. | ⬜ Planned | No raw commands; no gain/mute/routing/channel operations; fixture tests before any live backend. |

### What's left for 1.0

With both the round-2 BEYOND backlog and the round-3 ingest-and-extend pass
fully landed in the v0.8 release line, **and Milestones 3-4 above shipped on
the v0.9 line**, the remaining work to 1.0 is **consolidation**. The measurable
gates live in [v1.0.0 — Consolidation](#v100-consolidation) below; every open
item should map to one of those gates rather than to a new entry here. The Ui24R
mixer-scene work remains a bounded AI Show Director extension and must ship
behind dry-run, manifest and bench-validation gates before any live adapter is
considered.

### Later / deferred

The P2 long tail (the full list is in the [planning archive](#full-backlog),
including the Round-4 D.5 aesthetic tools and the Round-4 D.4 hardware items
that move to "Out of scope") — plus everything already moved to **Out of
scope** just below.

---

## Out of scope (for now)

Being honest about the edges. These need hardware, a live music source, a
multimodal LLM endpoint, a specific GPU/OS, a paid license, or cut against
tdmcp's local-first design — so they're parked until they can be validated
properly:

- **Multimodal-LLM-gated:** live-tuning `caption_top` and `copilot_vision`
  (vision-capable transcripts, smarter copilot handoff) is parked until
  there's a stable multimodal LLM endpoint to validate the prompts/output
  against. (`repair_network` is **not** multimodal-gated — its remaining
  hardening is offline rollback-regression testing, tracked in the
  Experimental section above.)
- **Live-music-gated reactivity validation:** graduating the chroma /
  percussive-vs-tonal / song-structure detectors out of experimental requires
  validating defaults against real music sources in a live setting.
- **GPU / CUDA-bound:** real-time AI generation (StreamDiffusion / ComfyUI /
  DepthAnything) is kept only as a way to *drive an already-installed* component
  or as a cloud option — never bundled. GPU fluid simulation and any
  optical-flow particle path that depends on CUDA can't be validated on the
  current macOS dev machine and remain parked (the new stock-TOP
  `create_optical_flow` ships in main).
- **Hardware-bound:** depth cameras (Kinect / Azure / RealSense), SMPTE/LTC
  timecode genlock, and laser (ILDA) output. Where possible we prefer the lighter,
  camera-only paths (MediaPipe face/hand/body, stock-TOP optical flow).
- **Mixer/PA live control beyond scene arming:** autonomous PA control, mixer
  gain, PA mute, routing, patching, phantom power, mute groups and channel-strip
  edits remain out of scope for the AI path. The planned Ui24R work is limited
  to operator-approved show/snapshot/cue arming with a manifest and dry-run
  first.
- **Multi-machine / multi-instance:** managing several TouchDesigner processes and
  cross-machine genlock — parked until there's hardware to test against.
- **Paid TouchDesigner license:** the Engine COMP / TouchEngine headless path.
- **A hosted marketplace:** sharing stays **local-first** — TouchDesigner's
  Palette plus an Obsidian vault — matching tdmcp's no-server, runs-on-your-machine
  design.
- **Round-3 hardware add-ons:** Arduino/serial sensor input
  (`create_sensor_input`), TUIO/multitouch surfaces
  (`create_multitouch_surface`), and 2D LiDAR (`create_lidar_reactive`) —
  parked alongside the existing hardware-bound list until the hardware is on
  hand to validate.
- **Round-3 GPU/CUDA add-ons:** `create_depth_from_2d` (DepthAnything),
  `create_volumetric_fire` (NVIDIA Flow), and `drive_diffusion_tox` (cloud or
  drive-installed-tox only) — same gating as the existing GPU/CUDA bullet.
- **Round-3 multi-machine:** `create_machine_sync` (Touch In/Out genlock across
  machines) — same gating as the existing multi-machine bullet.
- **Round-3 paid-license:** the TouchEngine headless path beyond the shipped
  Engine COMP wrapper — same gating as the existing paid-license bullet.
- **Round-4 hardware add-ons:** iPhone TrueDepth/LiDAR via Record3D
  (`create_iphone_depth_source`, S012), Orbbec Femto Bolt
  (`create_femto_depth_silhouette`, S018, the post-Azure-Kinect successor),
  ZED 2i / OAK-D POE outdoor capture (`create_outdoor_depth_capture`, S038),
  2D LiDAR floor tracker (`create_lidar_floor_tracker`, S021), Nuitrack
  skeleton (`create_nuitrack_skeleton`, S023), ESP32 sensor bridge
  (`create_esp32_sensor_bridge`, S019) and capacitive pad grid
  (`create_capacitive_pad_grid`, S024) — same gating as the existing
  hardware-bound bullet. We prefer the light camera-only paths (MediaPipe,
  optical flow) until hardware is on hand to validate.
- **Round-4 GPU/CUDA add-ons:** `drive_streamdiffusion` (S001),
  `create_depth_from_2d` (S003), `connect_comfyui` (S004),
  `create_ai_mirror` combo (S017), `create_rd_diffusion_hybrid` (S048) and
  `create_sam_segmentation` (S046) — kept only as **drive-installed-tox** or
  **cloud** wrappers, never bundled. `connect_daydream_cloud` (S043) is the
  cloud delta and exits this gate.
- **Round-4 paid-license:** `connect_unreal_engine` (S014) — same gating as
  the existing TouchEngine bullet.

## v1.0.0 — Consolidation {#v100-consolidation}

With the feature surface settled on the v0.8 line (**286 tools** on HEAD after
Wave 12; 279 at the v0.8.2 tag), the road to 1.0 is
a set of **measurable consolidation gates**, not a new feature wave. Each gate
below states the current posture and what "done" looks like, using the same
legend as the rest of the page (✅ shipped / 🧪 in progress / ⬜ planned).

### G1 — Tool API stability · 🧪

The contract for a "tdmcp tool" is the `ToolContext` shape
(`src/tools/types.ts`) plus each tool's Zod `inputSchema`. Stability gate:

- ⬜ One full minor release cycle (one tagged minor) with **no breaking change**
  to `ToolContext` or to any existing tool's `inputSchema` (additive optional
  fields are allowed; renames / removals / required-field additions are not).
- ⬜ An `API_STABILITY.md` note pinning the v1.0 contract and the deprecation
  policy (one-minor warn, next-minor remove).

### G2 — Test coverage · 🧪

Coverage is tracked by `npm run test:coverage` + the
`npm run coverage:harness` ranking; the project's coverage harness already
gates per-wave work but isn't yet a CI gate at the suite level.

- ⬜ Promote the coverage harness to a CI gate: enforce **lines and branches
  ≥ current baseline + 5 pp**, with no regression allowed on any file that
  already exceeds the target.
- ⬜ Bridge tests (`npm run test:bridge`) and recipe validation
  (`npm run validate:recipes`) stay green alongside the four PR gates.

### G3 — Recipe library depth · ⬜

The repo ships **31 validated recipes** under `recipes/`, all gated by
`RecipeSchema` and `npm run validate:recipes`.

- ⬜ Add at least **10 net-new** first-party recipes covering the v0.7–v0.8
  generator wave (SDF, strange-attractor, optical-flow, MediaPipe adapters,
  decks, dashboard-v2 layouts), each live-validated end-to-end.
- ⬜ One recipe per Layer-1 orchestrator so every "one-line build" tool has a
  reproducible JSON twin.

### G4 — Bridge hardening · 🧪

The bridge already exposes first-class REST endpoints for the work that used
to round-trip through `/api/exec`: nodes CRUD, connect / disconnect, param
modes, DAT text, network errors / topology / performance, batch, preview, and
structured logs (see `src/td-client/touchDesignerClient.ts`). What's left:

- ⬜ Reduce remaining `executePythonScript` reliance: ~129 tool files still
  call the exec path (often as a fallback). Each one that has a typed REST
  equivalent should prefer the endpoint and only fall back when the bridge is
  on an older protocol — tracked under the `tryEndpoint`/exec-fallback pattern
  established in v0.8.1.
- ⬜ Keep `/api/exec` working when `TDMCP_BRIDGE_ALLOW_EXEC=0` is the venue
  policy: every Layer-1/Layer-2 tool must build with exec disabled (CI smoke).
- ✅ Resilience patch — atomic writes, clean HTTP listen failure, event-stream
  close — landed in v0.8.1.

### G5 — Docs completeness · 🧪

The Tools reference (`docs/reference/tools.md`) is auto-generated from the live
registry on every docs build. Guide pages (`docs/guide/*.md`) currently cover
install, first visual, body tracking, components, recipes, shader-park,
local-copilot, LOPs integration, AI-controlled party, prompt cookbook, FAQ,
troubleshooting and glossary.

- ⬜ Add per-arc guides for the v0.7/v0.8 work that doesn't yet have one:
  show timelines & setlists, dashboard-v2 / front-of-house, session profile
  & corpus learning, MediaPipe adapters, MCP resources (glsl-snippets /
  cheatsheets / learning).
- ⬜ Every Layer-1 generator referenced in the cookbook has a one-paragraph
  "what it builds + when to reach for it" entry in the relevant guide.
- ✅ EN + PT parity for the prompt cookbook.

### G6 — One-click install & Connectors Directory · 🧪

The `.mcpb` (formerly `.dxt`) Claude Desktop bundle is built by
`npm run build:mcpb` and ships on every GitHub release; install docs cover the
one-click path.

- ✅ `.mcpb` bundle produced on tag.
- ✅ npm package publishing stays manual by default; CI auto-publish requires
  both `TDMCP_AUTO_NPM_PUBLISH=true` and `NPM_TOKEN`.
- ⬜ Anthropic Connectors Directory submission accepted (the submission harness
  — `tdmcp-submission` skill — drives prep and re-prep).
- ⬜ Glama / awesome-touchdesigner listings cross-linked from `README.md`.

> **Tool API contract reference.** The v1.0 invariants are documented in
> [`docs/reference/tool-contract.md`](./reference/tool-contract.md) (naming,
> input schema, error handling, offline behaviour, result shape, deprecation).
> G1's `API_STABILITY.md` pin will fold this page into the formal contract.

---

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
> Delivered rows are no longer repeated in these archive tables; shipped work
> lives in the release sections above. Rows remain here only when work is still
> open, partially delivered, experimental enough to need follow-through, or
> `gated` by GPU / hardware / CUDA / license constraints.

These passes are labelled in the order they happened (Round 0 → Round 4).
Round 4 (2026-06-09) is the first **trend-driven** pass — produced by the
`tdmcp-hype-scout` harness — and reopens the Planned list that Round 3 had
fully drained into v0.7/v0.8.

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
P0 set, control instruments, library thumbnail/index work, and several later
rows shipped in v0.6.0 / v0.7.x; the tables below keep only the remaining open
or partial work.

#### A.1 · Artist controls & creative tools

The only remaining Round-1 A.1 row targeted by this PR,
`create_decks` N-channel, shipped in the v0.8.1 release line above.

#### A.2 · Library, packaging & distribution

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `bundle_dependencies` | Make `make_portable_tox` actually self-contained | M | High | Med | P1 | EXTENSION | file-par enum + path-rewrite |
| `export_externalized_tree` | `save_external` → git-diffable `.tox` tree | S | Med | High | P1 | EXTENSION | tree shape on first run |
| `expand_recipe_library` | First-party recipes for the new generators | M | Med | High | P2 | NEW (content) | live cook-check each |
| `recipe_from_live_network` | Faithful round-trip recipe capture via `serialize_network` | M | Med | Med | P2 | EXTENSION | GLSL-uniform round-trip |

#### A.3 · CLI & developer DX

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `preview_inline_and_watch` | `preview --inline` (iTerm/Kitty/sixel) + `--watch` | M | Med | Med | P1 | ROADMAP | terminal-protocol detect |
| `show_mode_oneliner` | `tdmcp show <profile>` — load+doctor+perform+pre-flight | M | Med | Med | P2 | NEW | abort semantics |
| `error_exit_code_taxonomy` | Distinct exit codes (offline/TD-error/config) | S | Low | Med | P2 | NEW | error subclass survives |

`doctor_fix_autoexec`, `packages_cli_help_and_completion_parity` and
`no_color_flag_is_dead` shipped in v0.8.1 (vault/profile/token repairs +
`install-bridge --verify` + bounded macOS Textport automation; top-level CLI
completion / package parity; `tdmcp-agent run` `--no-color` propagation) and
are no longer tracked as open backlog.
`bridge_watch_build` **shipped in v0.8.2**: `tdmcp-agent watch-build` now gates
changed bridge Python with `py_compile` and reloads the running bridge
automatically unless disabled (`--no-py-compile` / `--no-reload-bridge` opt out).

#### A.4 · AI & LLM integration

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `copilot_smarter_handoff` | Auto-surface the Claude/Codex handoff on a dead-end | S | Med | High | P1 | ROADMAP | none |
| `copilot_session_persistence` | Resume transcript + last model/tier | M | Med | High | P1 | ROADMAP | none |
| `plan_visual`→LLM-grounded | Upgrade `describe_project` to an optional LLM planner | M | Med | High | P1 | EXTENSION | none (keyword stays default) |
| `narrate_set` | Persisted narration during `auto_vj_director` | S | Low | Med | P2 | NEW | none |

<a id="a5-touchdesigner-depth-bridge--operators"></a>

#### A.5 · TouchDesigner depth (bridge + operators)

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `createable_truth_flag` | `GET /api/optypes` ground truth → mark createable/deprecated | M | Med | Med | P1 | NEW | probe-live (enumeration) |
| `param_change_event` | Opt-in `param.changed` via a Parameter Execute DAT | M | Low | Med | P2 | NEW | onValueChange freq/scope |
| `refresh_operator_kb` | Live-derived KB delta vs the static import | L | Low | Med | P2 | NEW | enumeration (depends on createable) |

#### A.6 · Deferred (Round 1 — still gated / post-v0.7.x candidates)

Still open / partial after the v0.6.x–v0.8.x releases: `create_sdf_text`,
`create_vertex_displacement_mat`. ✅ `create_pose_reactive` **shipped in
Wave 12 / v0.8.3**, closing A.6's pose-reactive item. The earlier
deferrals (`create_gpu_fluid`, `create_optical_flow_particles`,
`control_diffusion` / `drive_streamdiffusion` / `connect_comfyui`,
`manage_td_process` / `switch_instance`, recipe/template marketplace) now live
in [Out of scope](#out-of-scope-for-now); hand / face / segmentation MediaPipe
modes shipped in v0.8.1; `create_strange_attractor` shipped earlier.

### Round 2 — "beyond the backlog" — 2026-05-30

**63 distinct candidates** (6 P0 · 35 P1 · 22 P2; 58 NEW · 5 EXTENSION · 0 ROADMAP),
every one deliberately beyond Round 1 and beyond what v0.6.0 shipped. The
BEYOND campaign shipped most of this round in v0.7.0, so the tables below keep
only the remaining open or partial follow-through.

#### B.1 · Artist controls & creative tools

All Round-2 artist-control rows shipped in v0.7.0 or are tracked in
[Experimental & needs validation](#experimental--needs-validation), so no open
table rows remain here.

#### B.2 · Library, packaging & distribution

The Round-2 library/provenance rows shipped in v0.7.0; open publishing polish now
lives under Milestone 3 above.

> `semantic_library_search` (raised here) was **merged into ai `recall_similar_work`** — same
> intent-retrieval capability; retrieval is owned by the AI surface.

#### B.3 · CLI & developer DX

`bridge_watch_build` shipped in v0.8.2 and is no longer tracked as open
backlog (see Round 1 A.3 above for the released wording).

#### B.4 · AI & LLM integration

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `voice_copilot_chat` follow-through | Browser Web-Speech push-to-talk in the copilot page | S | Med | Med | P2 | NEW | CLI alias exists; STT/Web Speech wiring still needs probe |

#### B.5 · TouchDesigner depth (bridge + operators)

`param_changed_event` is tracked once in
[Round 1 A.5](#a5-touchdesigner-depth-bridge--operators) as
`param_change_event`; no separate Round-2 entry.

#### B.6 · Cross-cutting (Round 2)

Value that spans surfaces (kept once above under its best-fit surface;
relationships explicit here). Most of these relationships are now real v0.7.0
architecture rather than speculative planning:

- **Time-based show automation** — `create_scheduler` (td-depth primitive) →
  `create_scene_timeline` (controls) ∥ `setlist_runner` (cli) ∥
  `compose_cue_list` (ai); all share **one** setlist/scene schema.
- **Run AI tools via the connected model** + a structured/image method on the LLM
  client — now used by `compose_cue_list`, `score_build`,
  `moodboard_to_system`, Round-1's `caption_top` and the new
  `copilot_vision` preview path.
- **"Do it my way" cluster** — `recall_similar_work` ⇄ `style_memory` ⇄
  `learn_from_my_corpus` ⇄ `learn_conventions` over one `Memory/` vault note
  schema.
- **Morph at two altitudes** — `create_preset_morph` (live instrument) ⇄
  `morph_pack` / `variant_pack` (saved assets).
- **Engine pipeline** — `create_engine_comp` (process) ⇄ a future "compile for
  Engine" bake on `make_portable_tox`.
- **Library keystone** — `auto_tag_library_asset` feeds
  `library_lineage_graph`, `recall_similar_work` and `lint_recipe_library`.

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
| `create_fixture_control` + 3D previz | EX-45 | Moving-head pan/tilt/dimmer/gobo via DMX + 3D rig preview | M | High | Med | P1 | NEW (builds planned DMX pipeline) | alltd, GeoPix, aw-cre |
| `create_detection_reactive` (YOLO) | EX-05 | Object/person presence/count → params (ONNX/WS, no CUDA) | M | Med | Med | P1 | NEW | aw-int (TDYolo, MIT) |
| `create_geo_visualization` (OSM) | EX-12 | GeoJSON/OSM → project lat-long → instance a city | L | Med | Med | P2 | NEW | alltd · ODbL attribution |
| Marketplace catalog index seed | EX-13 | Index public .tox catalogs (link-only) into `local_marketplace_index` | S | Low-Med | Med | P2 | EXTENSION | aw-int, aw-cre, alltd |
| Synesthesia/Unreal-OSC presets | EX-14 | Named OSC-out presets for Synesthesia / Unreal | S | Low-Med | Med | P2 | EXTENSION | alltd |

> Round-3 hardware / GPU / cloud / multi-machine-gated rows
> (`create_machine_sync`, `create_depth_from_2d`, `create_sensor_input`,
> `create_laser_output`, `create_multitouch_surface`, `drive_diffusion_tox`)
> now live in [Out of scope](#out-of-scope-for-now).

#### C.2 · Controls — effects, generators, reactivity, performance, mapping

| Feature | EX | Delivers | Eff | Impact | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| Color-finish suite remainder | EX-47/46 | Curves panel beyond the shipped `apply_lut`, scopes, colour wheels, and `create_histogram_scope` (v0.8.1) | M | High | High | P0 | PARTIAL | alltd, aw-cre |
| `create_interaction_zones` + optical-flow trigger | EX-36 | Camera/pose enter/exit/dwell zones fire cues (no depth-cam) | M | Med-Hi | High | P1 | NEW | alltd |
| `controlled_disorder_grid` | EX-27 | Grid of quads/lines with a tunable order↔chaos `disorder` knob | M | Med-Hi | High | P1 | NEW | anya, aw-cre · name generically |
| `create_terrain` | EX-29 | Heightmap landscape + PBR splat + water + volumetric fog | L | Med | Med | P1 | NEW | aw-int, aw-cre (Terrain-Tools MIT) |
| `create_l_system` + `create_asemic_writing` | EX-28 | Lindenmayer branching geometry + procedural glyph strokes | M–L | Med | Med | P1 | NEW | aw-cre, anya |
| `create_clip_sequencer` + `create_audio_transport` | EX-40 | Cached clip seq (trim/reverse/beat-advance) + audio-file master transport | M | High | Med | P1 | NEW/EXT | alltd |
| musical-bands + spectrogram heatmap | EX-38 | FFT→named musical bands (per-band attack/release) + heatmap trail | S–M | Med | High | P1 | NEW/ENH | aw-cre, alltd |
| `create_pointer_reactive` | EX-37 | Mouse/multitouch position as a first-class creative seed/force | S–M | Med | High | P1 | NEW | anya, alltd |
| `create_plexus` | EX-20 | Points + lines between near neighbours (constellation/network) | M | Med | Med | P1 | NEW | aw-cre |
| `create_pixel_sort` | EX-21 | Threshold pixel-sort via feedback translation | S–M | Med | High | P2 | NEW | alltd |
| `add_timecode_overlay` | EX-42 | HH:MM:SS:FF / countdown overlay | S | Low-Med | High | P2 | NEW | aw-cre (GPL idea-only) |
| `create_step_repeat` | EX-23 | Brick/grid tiling with gap/jitter/rotation | S | Low | High | P2 | NEW | aw-cre (GPL idea-only) |
| Lens/CA/vignette finishing pass | EX-24 | Barrel distortion + chromatic aberration + vignette | S | Low-Med | Med | P2 | ENH (check glitch overlap) | alltd, aw-cre |
| Feedback/displace preset library | EX-25 | Pixel-drip, mirror/trail/decay, video-displaces-video presets | S | Low | Med | P2 | EXTENSION | alltd |
| Kinetic-text path-follow / presets | EX-43 | Sentence-instancing path-follow + smoke-logo/ramp-text presets | M | Med | Med | P2 | EXTENSION | alltd, anya |
| `scaffold_vj_deck` | EX-44 | Compose decks + control-surface + MIDI-map into a VJ deck UI | M | Med | Med | P2 | EXTENSION | alltd (PATCHDECK pattern) |
| `create_pop_fluid` / `create_surface_flow` | EX-30 | POP-family GPU fluid + surface-flow (extends create_pop_field) | M–L | Med | Low | P2 | EXTENSION | alltd · probe POPs |
| `create_blob_trace` | EX-74/75 | Contour outline trace to complement the shipped `create_vector_lines` / SVG path | M | Med | Med | P2 | NEW | aw-cre, alltd |
| Fractal SDF presets + particles-in-SDF | EX-33 | Mandelbulb/menger presets + instanced particles in a raymarched SDF | M | Low-Med | Med | P2 | EXTENSION | alltd · GPU |
| `create_virtual_projection_set` / camera-match | EX-48 | Virtual room+projector cam previz; match cam to real projector | M | Med | Med | P2 | NEW | alltd |
| VR180 stereo dome mode | EX-49 | 180° stereo equirect render on dome/cubemap output | S | Low | Med | P2 | EXTENSION | alltd |

> Removed from this table since v0.8.x: `MediaPipe face/hand/segmentation`
> (shipped v0.8.1 as `setup_face_tracking`, `setup_hand_tracking`,
> `setup_segmentation`); `create_lidar_reactive` and `create_volumetric_fire`
> moved to [Out of scope](#out-of-scope-for-now).

#### C.3 · TouchDesigner depth — bridge, operators, editing

| Feature | EX | Delivers | Eff | Impact | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| `create_raymarch_scene` → SDF expr-graph | EX-51 | Compose SDF primitives/booleans/domain-ops → one GLSL | L | Med-Hi | Med | P1 | ENH | aw-int, aw-cre (RayTK CC-BY) |
| `complete_python_at` | EX-52 | Valid op paths/params/channels from the live graph for the LLM | S–M | Med | Med | P2 | NEW | aw-int, aw-cre |
| `create_physics_constraints` (Bullet) | EX-32 | Hinges/springs/ragdoll/stacking rigid-body sims | L | Med | Low | P2 | NEW | aw-cre · probe-live |
| Cook-on-change optimizer mode | EX-54 | Cook only when input changes (null-cache gating) | S | Low | Med | P2 | EXTENSION | aw-cre (GPL idea-only) |

> `TouchEngine headless path` (EX-53) moved to
> [Out of scope (paid-license)](#out-of-scope-for-now).

#### C.4 · Library, packaging & product

| Feature | EX | Delivers | Eff | Impact | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| License-tier + provenance/funnel metadata | EX-59 | Revenue-tiered license templates + price/tier fields in the index | S | Med | High | P1 | EXTENSION (planned provenance) | anya |
| `vendor_python_lib` | EX-60 | Vendor pip libs into Text DATs → self-contained `.toe` | M | Med | Med | P2 | NEW | alltd |
| Own starter recipe pack + cover art | EX-61 | First-party curated recipe pack (the "free pack" funnel) | M | Med | Med | P2 | EXTENSION (content) | alltd, anya · author own |

#### C.5 · CLI & DX

| Feature | EX | Delivers | Eff | Impact | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| `auto_ui` from custom params | EX-63 | Auto-generate a control panel from a COMP's custom params | M | Med | High | P1 | NEW | alltd |
| Codec export presets + offline render | EX-41 | HAP/NotchLC/ProRes presets + non-realtime no-frame-drop render | S–M | Med | High | P2 | EXTENSION | alltd |
| `scaffold_state_machine` | EX-64 | FSM show-flow + extension-driven structure skeleton | M | Med | Med | P2 | NEW | alltd |
| `edit_shader` hot-reload | EX-65 | Edit-DAT → re-cook → errors+preview round-trip aggregator | S | Low-Med | Med | P2 | NEW | aw-cre (ShaderBuilder MIT) |
| `genuary_daily` scaffold | EX-66 | Dated daily-sketch folder + variant capture + auto-gallery | S | Low | High | P2 | NEW | anya |

#### C.6 · AI & LLM

| Feature | EX | Delivers | Eff | Impact | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| "generative-classic" + "one-source-five-ways" prompts | EX-68 | Steer a build toward a generative-art lineage; emit N labeled variants | S | Med | Med | P2 | NEW | anya |

`tdmcp://glsl-snippets`, `tdmcp://cheatsheets`, and the
`teach_touchdesigner` learning resource are implemented on main after v0.7.1 and
are no longer tracked as open backlog.

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
Round-3 `create_data_source` HTTP/WS folds into the v0.7.0 data-source fabric;
`create_fixture_control` builds on the shipped `create_dmx_fixture_pipeline`;
license-tier metadata hardens the v0.7.0 provenance work; and
`extract_palette` and `generative_classics_pack` are part of v0.7.0, relating to
the shipped `create_palette` / `generate_from_moodboard` lineage.

### Round 4 — hype trend scouting — 2026-06-09 {#appendix-d-round4}

> **Round 4 campaign complete: 5 waves, 28 features, v0.9.0 → v0.12.0.**

**60 raw candidates → 38 deduped** from five external surfaces
(`community-showcase`, `tutorials`, `generative-ai`, `hardware-interactive`,
`vfx-aesthetics`) scouted in parallel by the `tdmcp-hype-scout` harness
(`.claude/skills/tdmcp-hype-scout/`). Each entry was evidence-cited (≥2 URLs
from 2025-2026) and feasibility-vetted against `src/tools/`, `src/knowledge/data/`,
`recipes/`, `docs/ROADMAP.md`, and `src/td-client/`. Distribution after dedup:
**~16 H · ~22 M · 0 L hype** (heavy cross-surface confirmation of the AI-bridge
and POPs clusters). Profile used: default `Hype × Build-Ease` (max 9, min 1).
The curated per-surface tables (D.1–D.5 below) are the publishable summary;
the raw scout outputs and the full per-candidate vet notes / merge log live
under `_workspace/hype-scout/` locally (gitignored, like every prior round's
raw output). Source codes:
`comm` = community-showcase · `tut` = tutorials · `ai` = generative-ai ·
`hw` = hardware-interactive · `vfx` = vfx-aesthetics.

The new field versus the inward Rounds 0–2 and Round 3's static community pull:
**what TD artists are SHIPPING right now in 2025-2026** — finished work +
front-running tutorials, with a build-ease vet that prioritizes "the parts
already exist; we're missing the preset/binding" wins.

> **Distinct from Round 3.** Round 3 was an *ecosystem ingestion* pass over
> static catalogs (alltd, awesome-touchdesigner, anya). Round 4 is a *trend*
> pass over what's happening *now* — recent Patreon drops, new Daydream / LOPs /
> POPs releases, the StreamDiffusion v0.2.6 / DepthAnything v2 / SAM 2 / TDGS
> waves. Many tools recur because they're genuinely hyped across both ecosystem
> and trend angles; cross-referenced inline.

#### D.0 · Force multipliers (build first)

Foundational work that unlocks 3+ entries below. **All are S-effort** and sit on
existing scaffolding — these are the cheapest accelerators in the backlog.

| FM | Delivers | Eff | Unlocks | Status |
|----|----------|-----|---------|--------|
| **FM-01** | Outbound `ndi_out` / `syphon_spout_out` modes on `createExternalIo` — the universal "push a TOP out to StreamDiffusion / ComfyUI / MediaPipe-Spout-loopback / TouchEngine" plumbing. KB confirms both stock TOPs (`syphon_spout_out_top.json`, `ndi_out_top.json`). | S | S001, S004, S007, S014, S017 | ✅ shipped v0.9.0 |
| **FM-02** | `dropExternalTox` helper for the canonical dotsimulate TOX-drop pattern (discover candidate paths → drop into `baseCOMP` → validate expected custom pars → OSC-bind). | S | S001, S003, S004, S005, S008, S016, S028 | ✅ shipped v0.9.0 |
| **FM-03** | Layer-2 `build_pop_chain` — generic ordered POP chain wired by `NetworkBuilder`, with safe-default params per POP type. Unblocks 5 POP-combo Layer-1 tools without copy-pasting topology code. | M | S002, S006, S009, S010, S035 | ✅ shipped v0.9.0 |

#### D.1 · Ready for `tdmcp-pipeline` — the top-5 high-confidence picks

| Rank | id | Tool | Layer | Hype | Eff | Coverage | Status | Source(s) |
|------|----|------|-------|------|-----|----------|--------|-----------|
| 1 | S007 | `create_pose_controlnet_driver` — OpenPose-color render TOP fed by the existing pose stack; one preset, no TOX dependency | 1 | H | S | NEW (composes existing) | ✅ shipped v0.9.1 | ai, tut |
| 2 | S025 | `create_ascii_render` — character-grid render TOP suite alongside `create_dither` / `create_halftone` | 1 | H | S | NEW | ✅ shipped v0.9.1 | vfx, tut |
| 3 | S020 | `create_phrase_locked_cue_engine` — cues quantized to Ableton bars/phrases over `createSyncExternalClock` | 1 | M | S | EXTENSION | ✅ shipped v0.9.1 | hw, tut |
| 4 | S013 | `create_audio_glsl_uniforms` — bind audio CHOPs as uniforms on a `glslTOP` (ingredients exist) | 2 | M | S | PARTIAL | ✅ shipped v0.9.1 | tut |
| 5 | S015 | `create_external_io` outbound (FM-01 itself) | 2 | M | S | EXTENSION | ai, comm |

All 5 score H×S=9 or M×S=6, sit on existing tdmcp scaffolding, and need no new
bridge endpoint. The AI bridges (StreamDiffusion / ComfyUI / DepthAnything
wrappers) outrank these on raw hype but are M-effort behind FM-01 + FM-02, so
they belong below.

#### D.2 · Generative-AI bridges — the highest-hype cluster (depends on FM-01 + FM-02)

| Feature | id | Delivers | Eff | Imp | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| `drive_streamdiffusion` | S001 | dotsimulate StreamDiffusionTD wrapper — discover the TOX, drop inside `baseCOMP`, expose t-index / prompt / strength as custom pars, OSC-bind | M | High | High | P1 | ✅ shipped v0.11.0 | ai, tut, comm, vfx |
| `create_depth_from_2d` | S003 | TDDepthAnything v2 wrapper — RGB-in → depth-TOP-out preset for 2D-to-3D parallax / depth-keyed silhouette | M | High | High | P1 | ✅ shipped v0.11.0 | ai, comm |
| `connect_comfyui` | S004 | ComfyUI bridge via olegchomp/TDComfyUI or JiSenHua/ComfyUI-TD — graph load + queue prompt + Spout pull-back | M | High | High | P1 | ✅ shipped v0.11.0 | ai, tut |
| `create_gaussian_splat_scene` | S016 | TDGS wrapper (Anglerfish-graphics 6 Apr 2025; POPs Gaussian-Splat v2026) — load `.ply`, instance, camera-control. **Top trend** (4-surface unanimous H) | M | High | High | P1 | ✅ shipped v0.11.0 | ai, comm, tut, vfx |
| `setup_mediapipe_plugin` | S028 | torinmb/mediapipe-touchdesigner canonical setup — face/hand/body/segmentation all from one Spout-loopback path | S | High | High | P1 | ✅ shipped v0.11.0 | ai, tut |
| `create_llm_chain` | S008 | dotsimulate LOPs wrapper — chain OpenAI / Anthropic / Ollama nodes with prompt-templates and structured outputs | M | High | Med | P1 | ✅ shipped v0.11.0 | ai, tut |
| `create_voice_prompt_pipeline` | S005 | STT-Whisper LOP → prompt → SD/SDXL update — push-to-talk live prompt morph | M | Med | Med | P2 | NEW | ai, tut |
| `create_ai_mirror` | S017 | Combo recipe: camera-in + StreamDiffusion + control-surface mapped — the showcase form everyone is shipping | L | High | Med | P2 | ✅ shipped v0.11.0 | ai, comm, tut |
| `connect_daydream_cloud` | S043 | dotsimulate × Daydream hosted StreamDiffusion — cloud path that skips the GPU gate | S | High | Med | P1 | ✅ shipped v0.11.0 | ai |
| `create_sam_segmentation` | S046 | SAM 2 / FastSAM masks via ONNX → matte/alpha channel | L | Med | Med | P2 | PARTIAL — depends ONNX | ai, tut |
| `create_prompt_morph` | S044 | IP-Adapter slot bank — morph between N saved prompts on a control surface | S | Med | Med | P2 | PARTIAL — depends S001 | ai |
| `create_rd_diffusion_hybrid` | S048 | Feed `create_reaction_diffusion` into StreamDiffusion image2image | M | Med | Med | P2 | PARTIAL — depends S001 + S033 | comm, ai |
| `create_voice_character` | S047 | ElevenLabs TTS → lip-synced MediaPipe face | M | Med | Med | P2 | NEW | ai |

> **Gating note.** The realtime AI bridges (S001 / S003 / S004 / S017 / S048)
> continue to count against **GPU/CUDA-bound** in
> [Out of scope](#out-of-scope-for-now) for the *bundled* path. The Round-4
> entries here are the **drive-installed-tox** + **cloud** delta — wrappers
> around components the user installs themselves; never bundled.

#### D.3 · POPs combos — the new generative cluster (depends on FM-03)

| Feature | id | Delivers | Eff | Imp | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| `create_pop_particle_system` | S002 | Multi-POP combo: `particle_pop` + `feedback_pop` + `lookup_texture_pop` + `field_pop` — the dominant new particle look | M | High | High | P1 | ✅ shipped v0.10.0 | comm, tut, vfx |
| `create_pop_growth` | S006 | POP organic growth + RD-on-POPs — feedback-loop branching forms | M | High | Med | P1 | ✅ shipped v0.10.0 | comm, vfx |
| `create_pop_lines_pointcloud` | S009 | Point cloud → POP lines with proximity threshold (constellation/plexus-style) | M | High | High | P1 | ✅ shipped v0.10.0 | comm, vfx |
| `create_depth_pop_field` | S010 | ZED/Orbbec/OAK-D depth → POP scatter/instance with depth as the force field | M | High | Med | P1 | ✅ shipped v0.10.0 | comm, hw |
| `create_stipple_pointcloud` | S035 | Stipple/dot rendering of a point cloud via POPs | M | Med | Med | P2 | ✅ shipped v0.10.0 | vfx |

#### D.4 · Hardware & interaction (mostly Out-of-scope; tracked here for visibility)

| Feature | id | Delivers | Eff | Imp | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| `create_iphone_depth_source` | S012 | iPhone TrueDepth/LiDAR via Record3D WebSocket — phone-as-depth-camera path that sidesteps RealSense/Azure | M | High | Med | P1 | NEW — see Out of scope (hardware light path) | comm, hw |
| `create_femto_depth_silhouette` | S018 | Orbbec Femto Bolt — Azure-Kinect successor since MS EOL'd Azure | S | High | Med | P1 | EXTENSION — see Out of scope (hardware) | hw |
| `create_esp32_sensor_bridge` | S019 | ESP32 + canonical Arduino sketch → TD UDP/OSC ingest with a tdmcp subnet preset | M | High | Med | P1 | PARTIAL — see Out of scope (hardware) | hw |
| `create_nuitrack_skeleton` | S023 | Nuitrack skeleton tracking presets (post-Kinect-SDK) | S | Med | Med | P2 | EXTENSION — see Out of scope (hardware) | hw |
| `create_streamdeck_cue_surface` | S022 | Stream Deck cue button preset on the existing OSC/MIDI surface infra | M | Med | Med | P2 | EXTENSION | hw |
| `create_capacitive_pad_grid` | S024 | ESP32 + conductive paint pads → TD with a known N×M layout helper | M | Med | Med | P2 | NEW — see Out of scope (hardware) | hw |
| `create_outdoor_depth_capture` | S038 | ZED 2i / OAK-D POE outdoor-rated depth capture preset | M | Med | Med | P2 | NEW — see Out of scope (hardware) | hw |
| `create_lidar_floor_tracker` | S021 | Hokuyo URG-04LX-UG01 2D-LiDAR floor zone tracker | L | Med | Med | P2 | PARTIAL — already in Out of scope (Round-3) | hw |
| `create_touchosc_layout` | S039 | Generate a TouchOSC layout file from a TD COMP's custom pars | L | Med | Med | P2 | PARTIAL | hw |

#### D.5 · Aesthetic / VFX tools (mostly buildable today; many overlap Round 3)

| Feature | id | Delivers | Eff | Imp | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| `create_ascii_render` | S025 | Character-grid TOP — top-5 (D.1) | S | Med | High | P1 | NEW | vfx, tut |
| `create_slit_scan` | S026 | Time-slice slit-scan render next to the shipped `create_time_echo` | S | Med | Med | P2 | ✅ shipped v0.12.0 | vfx |
| `create_chrome_blobs` | S029 | Liquid-chrome / metaball preset stack | S | Med | Med | P2 | ✅ shipped v0.12.0 | vfx, comm |
| `create_vintage_lens` | S030 | Lens/CA/vignette preset on `applyPostProcessing` (Round-3 EX-24) | S | Med | Med | P2 | ✅ shipped v0.12.0 | vfx |
| `create_pixel_sort` | S031 | Threshold-pixel-sort (Round-3 EX-21) | M | Med | Med | P2 | ✅ shipped v0.12.0 | vfx |
| `create_volumetric_field` | S032 | Raymarch density field preset | M | Med | Med | P2 | ✅ shipped v0.12.0 | vfx |
| `create_reaction_diffusion` | S033 | Gray-Scott RD (recipe exists; wrap as a tool) | S | Med | High | P2 | ✅ shipped v0.12.0 | vfx, tut |
| `create_generative_architecture` | S034 | PBR + hand-canvas architectural sketch preset (Round-3 EX-27 family) | M | Med | Med | P2 | PARTIAL — overlaps Round-3 | vfx, comm |
| `create_voxel_stack` | S036 | Isometric voxel stack render preset | M | Med | Med | P2 | ✅ shipped v0.12.0 | vfx |
| `create_fulldome_output` | S037 | B-Dome simulator + 180° equirect output (overlaps Round-3 EX-49) | M | Med | Med | P2 | PARTIAL — overlaps Round-3 | vfx, comm |
| `create_facade_mapping` | S040 | Multi-projector blend + Kantan/CamSchnappr workflow | M | Med | Med | P2 | ✅ shipped v0.12.0 (PARTIAL — calibration deferred) | comm |
| `create_fixture_choreograph` / `create_data_choreograph` | S041 | Solar/Astrum-style data-driven fixture choreography (Round-3 EX-45 family) | L | Med | Med | P2 | PARTIAL — overlaps Round-3 | comm |

#### D.6 · Reconciled cross-references

- **Gating preserved.** Realtime AI generation (S001 / S003 / S004), Hokuyo /
  ZED 2i / OAK-D / Orbbec / iPhone-LiDAR depth (S010 / S012 / S018 / S021 /
  S038), ESP32 / capacitive sensors (S019 / S024), Nuitrack (S023), and the
  Unreal/TouchEngine path (S014) continue to live under
  [Out of scope](#out-of-scope-for-now). They appear in Round 4 because the
  *drive-installed-tox*, *cloud*, or *light-camera-only* variants are now in
  active community use — but they remain gated for bundling and live-validation.
- **Round-3 overlaps.** S025 ↔ EX-71/72 (cookbook ASCII mention); S026 ↔
  shipped `create_time_echo`; S029 ↔ EX-25 feedback presets; S030 ↔ EX-24;
  S031 ↔ EX-21; S033 ↔ existing reaction-diffusion recipe; S037 ↔ EX-49;
  S041 ↔ EX-45. Where Round 3 and Round 4 disagree on priority, the Round-4
  vet (with citations from finished 2025-2026 work) wins for build sequencing.
- **Out — already shipped.** MediaPipe face/hand/body/segmentation (S028 base
  layer) shipped in v0.8.1 as `setup_face_tracking`, `setup_hand_tracking`,
  `setup_segmentation` — the Round-4 entry is an EXTENSION (canonical-plugin
  setup), not a duplicate.
- **Out — duplicate.** `import_blender_clipboard` (S045) is the same scope as
  `Blend2TD` (Round-3 reconciled-out, low priority); leave the Round-3 stance.
