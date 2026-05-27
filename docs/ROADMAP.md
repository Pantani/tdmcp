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
| 1 | 0.4.0 ☑ | Musical reactivity | Core workflow; depends on phase-0 event producer |
| 2 | 0.5.0 ☑ | Live performance | Makes systems playable; reuses presets + events |
| 3 | 0.6.0 ☑ | Advanced creation (TD) | Heavy, independent features → parallelizable |
| 4 | 0.7.0 ☑ | Intelligence (AI) | Layer that builds on everything already shipped |
| 5 | 0.8.0 ☑ | Robustness & export | Polish, automation, path to 1.0 |
| 6 | 0.9.0 ◐ | Obsidian vault | Markdown library + journal bridge: recipes, setlists, shaders, presets, docs |
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

## Phase 1 — v0.4.0 · Musical reactivity ⭐ ☑ shipped

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

## Phase 2 — v0.5.0 · Live performance ⭐ ☑ shipped

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

## Phase 3 — v0.6.0 · Advanced creation (TouchDesigner) ☑ shipped

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

## Phase 4 — v0.7.0 · Intelligence (AI) ☑ shipped

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

## Phase 5 — v0.8.0 · Robustness & export ☑ shipped

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

## Phase 6 — v0.9.0 · Obsidian vault integration ◐ in progress

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
