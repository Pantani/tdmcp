---
title: Roadmap
description: "What's shipped, what's experimental, and what's planned for tdmcp — the TouchDesigner MCP server — on the way to a stable 1.0."
---

# tdmcp Roadmap

tdmcp connects an AI assistant (Claude, Cursor, Codex…) to TouchDesigner so you
can build real visual systems from plain language — no node-wiring by hand. This
page is the honest, bird's-eye picture of **what already works, what's still
rough, and what's coming next** on the way to a stable 1.0.

**Where things stand today.** The current public cut is **v0.7.0**, tagged and
published on 2026-06-01, exposing **268 tools**. It folds the full BEYOND
campaign (Waves 1-5), the Ingest & Extend Waves 1-3, and the
`create_data_source_http_ws` hotfix into one release instead of skipping ahead to
later version labels. The package manifests, changelog, docs and generated Tools
reference all use **v0.7.0** as the release boundary.

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
5. **Ingest & extend** *(v0.7.0, with follow-up work planned for v0.8.x)* — pull in the
   wider TouchDesigner world (Shadertoy / ISF shaders, Ableton, the iconic VJ
   looks), then deepen AI/library publishing and operator DX. Waves 1-3 are in
   v0.7.0; the remaining work is the last Milestone-4 / deployment ergonomics
   plus the next v0.8.x planning.

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

### v0.7.0 — BEYOND campaign

The BEYOND work is documented in `CHANGELOG.md` and is part of the v0.7.0
release train.

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

### v0.7.0 — Smarter assistance, library publishing & operator DX

The Wave-3 backlog of the Ingest-extend campaign shipped in v0.7.0. Sub-batch A
delivered 3 pure-Node library/publishing tools, sub-batch B shipped 6 TD-required
AI/library tools, and sub-batch C closed the colour-finish polish while opening
the Milestone-4 operator-DX lane.

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
- ✅ **`tdmcp config init`** — safe starter `.env` config writer for every
  `TDMCP_*` variable, with `--force` and `--dry-run`.
- ✅ **`elicit_missing_args`** — verified shipped in v0.7.0 after the Wave-3C
  audit; schema-driven elicitation has offline / no-server fallbacks.

### v0.7.0 — Ingest & Extend

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

- **v0.7.0 experimental/gated tools** — `create_chroma_reactive`,
  `create_transient_reactive` and `create_energy_structure` are shipped as
  experimental; `create_two_way_surface` and `create_phone_gesture` remain
  `unverified_pending_hardware`; `caption_top`, `copilot_vision` and
  `repair_network` are offline-tested but still need live vision / rollback
  tuning.
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

With v0.7.0 published, the next public roadmap is no longer about proving tdmcp
can run a whole show — that line is now installable.
The highest-value open work is to finish the last deployment, operator and AI
ergonomics. Version targets are a rough sequence, **not a promise** — order can
shift. The exhaustive, item-by-item backlog (with effort and impact) lives in
the [planning archive](#full-backlog).

### Milestone 2 — Ecosystem & colour polish · v0.8.x

*The ecosystem importers, signature looks, Ableton/HTTP ingestion, recorder,
colour scopes and colour wheels are now v0.7.0 features. The remaining lane is
polish around the parts that still need extra live tuning or unfinished panels.*

- **Colour-finish follow-through** — add the deferred histogram scope panel and
  decide whether curves belong in `create_color_wheels`, `apply_lut`, or a new
  focused grading tool.
- **Deeper reactivity tuning** — validate the chroma / percussive-vs-tonal /
  song-structure detectors against real music sources and graduate them from
  experimental when their defaults feel reliable.

### Milestone 3 — Smarter assistance & library publishing · v0.8.x

*The first AI/library publishing wave shipped in v0.7.0. The remaining work is
about making those primitives feel continuous across sessions and strong under a
real multimodal setup.*

- **Main progress after v0.7.0 (unreleased).** The prompt/resource plumbing now
  has three small v0.8.x pieces on `main`: `tdmcp://prompts` is generated from
  the actual prompt registry, `tdmcp://recipes/search/{query}` searches the
  recipe catalog, and `tdmcp://cookbook` / `tdmcp://cookbook/{en|pt}` expose the
  prompt cookbook to MCP clients. The local copilot now also reads that prompt
  catalog into its system prompt and can be tuned with `TDMCP_LLM_TIER`,
  `TDMCP_LLM_MAX_STEPS`, and `TDMCP_LLM_TEMPERATURE`.
- **AI deepening** — live-tune `caption_top`, `copilot_vision` and
  `repair_network`; add richer chat flags, transcript persistence and smarter
  handoff when the local copilot reaches its limits.
- **"Do it my way"** — turn `recall_similar_work`, `style_memory`,
  `learn_conventions` and `learn_from_my_corpus` into a persistent session
  profile the agent reads before every new build.
- **Trust & publish polish** — build on the shipped library/version/provenance
  tools with license-tier metadata, stronger component docs and export flows that
  are easy for artists to package repeatedly.

### Milestone 4 — Deeper authoring & operator DX · v0.8.x / v0.9.x

*Unwrap the last big TouchDesigner authoring surfaces and finish the operator /
install story.*

- **Main progress after v0.7.0 (unreleased).** The operator/DX lane now includes
  `tdmcp --help`, `tdmcp-agent run -`, `tdmcp-agent run --continue-on-error`,
  `tdmcp-agent config profiles`, `tdmcp-agent config profile <name>`,
  `tdmcp-agent commands --json`, `tdmcp://commands`, grouped agent help,
  `tdmcp-agent help <command>`, `tdmcp install-bridge --verify` / `--wait` /
  `--port`, opt-in `get_node_state_runtime include_info_chop:true` Info CHOP
  telemetry, and the read-only `watch_node` sampler.
- **Authoring** — tackle the GPU / optical-flow / SDF / strange-attractor
  deferred generators, plus MediaPipe face / hand / segmentation on the in-tree
  tracking engine.
- **Developer & live-operator DX** — finish the **easy-install** story with a
  client-config writer and a `doctor --fix` that performs safe repairs; then
  round out completion parity, inline preview and the next front-of-house
  dashboard pass.

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
P0 set, control instruments, library thumbnail/index work, and several later
rows shipped in v0.6.0 / v0.7.0; the tables below keep only the remaining open
or partial work.

#### A.1 · Artist controls & creative tools

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `create_decks` N-channel | 3–4 decks + transition cut + per-deck FX send | M | Med | High | P1 | EXTENSION | none |

#### A.2 · Library, packaging & distribution

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `bundle_dependencies` | Make `make_portable_tox` actually self-contained | M | High | Med | P1 | EXTENSION | file-par enum + path-rewrite |
| `publish_recipe_bundle` | Checksummed/versioned publish artifact | M | Med | High | P1 | NEW | none |
| `export_externalized_tree` | `save_external` → git-diffable `.tox` tree | S | Med | High | P1 | EXTENSION | tree shape on first run |
| `component_readme_in_package` | Auto-write a params/IO doc into the portable-tox package | S | Med | High | P2 | EXTENSION | none |
| `expand_recipe_library` | First-party recipes for the new generators | M | Med | High | P2 | NEW (content) | live cook-check each |
| `recipe_from_live_network` | Faithful round-trip recipe capture via `serialize_network` | M | Med | Med | P2 | EXTENSION | GLSL-uniform round-trip |

#### A.3 · CLI & developer DX

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| ✅ `install_client_writers` | `install-client --write` deep-merges + verifies the config | M | High | High | P1 | ROADMAP | implemented after v0.7.0; uses explicit `--path` / positional file path, preserving unrelated JSON keys |
| `doctor_fix_autoexec` | `doctor --fix` executes safe repairs | M | High | High | P1 | ROADMAP | none |
| ✅ `watch_exec_hook` | `watch --on beat --exec '<cmd>'` reactive engine | M | Med | High | P1 | ROADMAP | implemented after v0.7.0 with per-event `--debounce-ms` |
| ✅ `tdmcp_top_level_help` | Real `tdmcp --help` on the primary binary | S | Med | High | P1 | NEW | landed on main after v0.7.0 |
| ✅ `agent_command_index_resource` | `tdmcp-agent commands --json` + `tdmcp://commands` | S | Med | High | P1 | NEW | landed on main after v0.7.0 |
| ✅ `install_bridge_verify` | `install-bridge --verify`/`--wait`/`--port` polls the bridge | S | Med | High | P1 | ROADMAP | landed on main after v0.7.0 |
| ✅ `repl_history_and_completion` | Persistent history + Tab-completion in the REPL | M | Med | High | P1 | ROADMAP | implemented after v0.7.0; history stored under XDG state / `TDMCP_AGENT_HISTORY` |
| `preview_inline_and_watch` | `preview --inline` (iTerm/Kitty/sixel) + `--watch` | M | Med | Med | P1 | ROADMAP | terminal-protocol detect |
| ✅ `help_grouping_and_per_command_help` | Group `usage()` by theme + `help <command>` | M | Med | High | P2 | NEW | landed on main after v0.7.0 |
| ✅ `run_file_stdin_and_continue` | `run -` (stdin) + `--continue-on-error` | S | Med | High | P2 | EXTENSION | landed on main after v0.7.0 |
| `show_mode_oneliner` | `tdmcp show <profile>` — load+doctor+perform+pre-flight | M | Med | Med | P2 | NEW | abort semantics |
| ✅ `output_format_table_and_csv` | `--output table`/`csv` for list results | S | Low | High | P2 | EXTENSION | implemented after v0.7.0 |
| `error_exit_code_taxonomy` | Distinct exit codes (offline/TD-error/config) | S | Low | Med | P2 | NEW | error subclass survives |
| `no_color_flag_is_dead` | Honor parsed-but-dead `--no-color`/`NO_COLOR` | S | Low | High | P2 | NEW | none |
| ✅ `watch_pretty_and_count` | `watch --pretty` + heartbeat | S | Low | High | P2 | EXTENSION | implemented after v0.7.0 with event counts and `--heartbeat-ms` |
| ✅ `http_transport_oneflag_launch` | `tdmcp serve --http [--port]` | S | Low | High | P2 | NEW | implemented after v0.7.0; bare `tdmcp` still uses stdio |
| `packages_cli_help_and_completion_parity` | Fold `packages` tree into top-level help/completion | S | Low | High | P2 | EXTENSION | none |
| ✅ `profile_list_and_show` | `tdmcp-agent config profiles` lists saved venue profiles; `config profile <name>` shows a redacted effective profile | S | Low | Med | P2 | NEW | landed on main after v0.7.0 |

#### A.4 · AI & LLM integration

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| ✅ `copilot_prompt_awareness` | Feed `tdmcp://prompts` into the copilot BASE_PROMPT | S | Med | High | P1 | EXTENSION | landed on main after v0.7.0 |
| `copilot_smarter_handoff` | Auto-surface the Claude/Codex handoff on a dead-end | S | Med | High | P1 | ROADMAP | none |
| ✅ `chat_cli_flags` | `chat --read-only`/`--creative`/`--prompt` (headless) | M | Med | High | P1 | ROADMAP | implemented after v0.7.0; server accepts fixed read-only tier |
| `copilot_session_persistence` | Resume transcript + last model/tier | M | Med | High | P1 | ROADMAP | none |
| `plan_visual`→LLM-grounded | Upgrade `describe_project` to an optional LLM planner | M | Med | High | P1 | EXTENSION | none (keyword stays default) |
| ✅ `prompt_catalog_autogen` | Generate `tdmcp://prompts` from the registry | S | Med | High | P1 | NEW | landed on main after v0.7.0 |
| ✅ `cookbook_resource` | Expose the prompt-cookbook as `tdmcp://cookbook` / `tdmcp://cookbook/{en|pt}` | S | Med | Med | P2 | NEW | landed on main after v0.7.0 |
| ✅ `llm_config_knobs` | `TDMCP_LLM_TIER`/`_MAX_STEPS`/`_TEMPERATURE` keys | S | Low | High | P2 | NEW | landed on main after v0.7.0 |
| ✅ `recipe_resource_search` | Keyword search over recipes via `tdmcp://recipes/search/{query}` | S | Low | High | P2 | EXTENSION | landed on main after v0.7.0 |
| `narrate_set` | Persisted narration during `auto_vj_director` | S | Low | Med | P2 | NEW | none |

#### A.5 · TouchDesigner depth (bridge + operators)

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| ✅ `info_chop_telemetry` | Opt-in Info CHOP sampling in `get_node_state_runtime` (`include_info_chop:true`) | M | Med | High | P1 | EXTENSION | landed on main after v0.7.0; live channel names still vary by TD build |
| `createable_truth_flag` | `GET /api/optypes` ground truth → mark createable/deprecated | M | Med | Med | P1 | NEW | probe-live (enumeration) |
| ✅ `bridge_health_watchdog` | `GET /api/health` — cook-rate/dropped-frame/GPU + staleness | S | Med | Med | P1 | NEW | implemented after v0.7.0; missing realtime attrs degrade to null/warnings |
| ✅ `watch_node` | Sample one op's state/param/channel over an interval | S | Low | High | P2 | NEW | landed on main after v0.7.0; live channel names still vary by TD build |
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

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `bridge_watch_build` | Watch `td/` → auto-`reload_bridge` on save (+`py_compile` gate) | S | Med | High | P1 | NEW | partially covered by `tdmcp-agent watch-build`; auto-reload still open |

#### B.4 · AI & LLM integration

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `voice_copilot_chat` follow-through | Browser Web-Speech push-to-talk in the copilot page | S | Med | Med | P2 | NEW | CLI alias exists; STT/Web Speech wiring still needs probe |

#### B.5 · TouchDesigner depth (bridge + operators)

| Feature | Delivers | Effort | Impact | Conf | Priority | Novelty | Probe-first |
|---|---|---|---|---|---|---|---|
| `param_changed_event` | `param.changed` via a Parameter Execute DAT (Round 1 tracked, still open) | M | Low | Med | P2 | tracked | onValueChange freq/scope |

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
| Color-finish suite remainder | EX-47/46 | Curves + histogram panel beyond the shipped `apply_lut`, scopes and colour wheels | M | High | High | P0 | PARTIAL | alltd, aw-cre |
| MediaPipe face/hand/segmentation | EX-34 | Finger-gesture + face + selfie-segmentation on the in-tree engine | M | High | Med | P1 | ENH | aw-int (mediapipe-td, MIT) |
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
| `create_lidar_reactive` | EX-35 | 2D LiDAR → blob-cluster → touch coords → bind (installs) | M | High | Med | P2 | NEW | anya · RPLidar hardware |
| Kinetic-text path-follow / presets | EX-43 | Sentence-instancing path-follow + smoke-logo/ramp-text presets | M | Med | Med | P2 | EXTENSION | alltd, anya |
| `scaffold_vj_deck` | EX-44 | Compose decks + control-surface + MIDI-map into a VJ deck UI | M | Med | Med | P2 | EXTENSION | alltd (PATCHDECK pattern) |
| `create_pop_fluid` / `create_surface_flow` | EX-30 | POP-family GPU fluid + surface-flow (extends create_pop_field) | M–L | Med | Low | P2 | EXTENSION | alltd · probe POPs |
| `create_volumetric_fire` (NVIDIA Flow) | EX-31 | Volumetric fire/smoke/water emitter | M | Med | Low | P2 | NEW·gated | alltd · NVIDIA/Windows |
| `create_blob_trace` | EX-74/75 | Contour outline trace to complement the shipped `create_vector_lines` / SVG path | M | Med | Med | P2 | NEW | aw-cre, alltd |
| Fractal SDF presets + particles-in-SDF | EX-33 | Mandelbulb/menger presets + instanced particles in a raymarched SDF | M | Low-Med | Med | P2 | EXTENSION | alltd · GPU |
| `create_virtual_projection_set` / camera-match | EX-48 | Virtual room+projector cam previz; match cam to real projector | M | Med | Med | P2 | NEW | alltd |
| VR180 stereo dome mode | EX-49 | 180° stereo equirect render on dome/cubemap output | S | Low | Med | P2 | EXTENSION | alltd |

#### C.3 · TouchDesigner depth — bridge, operators, editing

| Feature | EX | Delivers | Eff | Impact | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| `create_raymarch_scene` → SDF expr-graph | EX-51 | Compose SDF primitives/booleans/domain-ops → one GLSL | L | Med-Hi | Med | P1 | ENH | aw-int, aw-cre (RayTK CC-BY) |
| `complete_python_at` | EX-52 | Valid op paths/params/channels from the live graph for the LLM | S–M | Med | Med | P2 | NEW | aw-int, aw-cre |
| `create_physics_constraints` (Bullet) | EX-32 | Hinges/springs/ragdoll/stacking rigid-body sims | L | Med | Low | P2 | NEW | aw-cre · probe-live |
| TouchEngine headless path | EX-53 | Run a `.tox` headlessly (zero-copy) beyond the shipped Engine COMP wrapper | M | Med | Low | P2 | GATED | aw-int, alltd · paid TD license |
| Cook-on-change optimizer mode | EX-54 | Cook only when input changes (null-cache gating) | S | Low | Med | P2 | EXTENSION | aw-cre (GPL idea-only) |

#### C.4 · Library, packaging & product

| Feature | EX | Delivers | Eff | Impact | Conf | Pri | Status | Source(s) |
|---|---|---|---|---|---|---|---|---|
| `tdmcp://glsl-snippets` catalog | EX-58 | Vetted, license-clean noise/SDF/color/blend GLSL the AI assembles from | M | Med | High | P1 | NEW | aw-cre · author own, not Lygia |
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
Round-3 `create_data_source` HTTP/WS folds into the v0.7.0 data-source fabric;
`create_fixture_control` builds on the shipped `create_dmx_fixture_pipeline`;
license-tier metadata hardens the v0.7.0 provenance work; and
`extract_palette` and `generative_classics_pack` are part of v0.7.0, relating to
the shipped `create_palette` / `generate_from_moodboard` lineage.
