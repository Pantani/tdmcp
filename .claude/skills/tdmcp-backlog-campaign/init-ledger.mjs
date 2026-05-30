#!/usr/bin/env node
// init-ledger.mjs — seed/reconcile the tdmcp backlog campaign ledger.
// IDEMPOTENT: if ledger.json exists, live per-feature progress
// (status/attempts/files/notes/last_updated) is preserved; only the static plan
// fields (surface/priority/effort/novelty/kind/wave/depends_on/probe_live/bundle)
// are refreshed from this seed, and any brand-new ids are appended as `pending`.
// Re-running after the backlog grows is safe. Run: node _workspace/build/init-ledger.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Self-locating: always write to <repo-root>/_workspace/build/ regardless of where
// this script lives (the tracked canonical copy is in the skill dir; the live ledger
// is gitignored scratch). The campaign always runs from the repo root.
const OUT = join(process.cwd(), "_workspace", "build");
mkdirSync(OUT, { recursive: true });
const LEDGER = join(OUT, "ledger.json");
const LEDGER_MD = join(OUT, "LEDGER.md");
const DATE = "2026-05-30"; // pass-in date (scripts cannot read the clock deterministically)

// status: pending | in_progress | built | integrated | qa_pass | qa_unverified | done | blocked | deferred
// kind:   bridge | tool | library | recipe | cli | ai | prompt
// bundle: features sharing one change/PR (built together by one agent)
const seed = [
  // ── td-depth (15) ──────────────────────────────────────────────────────────
  { id: "node_flags_in_detail",        surface: "td-depth", priority: "P0", effort: "S", novelty: "EXTENSION", kind: "bridge", wave: 1, bundle: "node_detail_fidelity", depends_on: [], probe_live: false },
  { id: "connector_order_in_detail",   surface: "td-depth", priority: "P1", effort: "S", novelty: "EXTENSION", kind: "bridge", wave: 1, bundle: "node_detail_fidelity", depends_on: [], probe_live: false },
  { id: "node_layout_in_detail",       surface: "td-depth", priority: "P2", effort: "S", novelty: "EXTENSION", kind: "bridge", wave: 1, bundle: "node_detail_fidelity", depends_on: [], probe_live: false },
  { id: "connect_disconnect_endpoint", surface: "td-depth", priority: "P0", effort: "M", novelty: "NEW",       kind: "bridge", wave: 1, bundle: "connect_endpoint",     depends_on: [], probe_live: true },
  { id: "param_modes_rest_endpoint",   surface: "td-depth", priority: "P0", effort: "M", novelty: "EXTENSION", kind: "bridge", wave: 1, bundle: "param_dat_endpoints",  depends_on: [], probe_live: true },
  { id: "dat_content_rest_endpoint",   surface: "td-depth", priority: "P1", effort: "S", novelty: "EXTENSION", kind: "bridge", wave: 1, bundle: "param_dat_endpoints",  depends_on: [], probe_live: true },
  { id: "error_dat_log_capture",       surface: "td-depth", priority: "P0", effort: "M", novelty: "EXTENSION", kind: "bridge", wave: 1, bundle: "error_logs_event",     depends_on: [], probe_live: true },
  { id: "error_appeared_event",        surface: "td-depth", priority: "P1", effort: "M", novelty: "NEW",       kind: "bridge", wave: 1, bundle: "error_logs_event",     depends_on: [], probe_live: true },
  { id: "info_chop_telemetry",         surface: "td-depth", priority: "P1", effort: "M", novelty: "EXTENSION", kind: "bridge", wave: 2, depends_on: [], probe_live: true },
  { id: "createable_truth_flag",       surface: "td-depth", priority: "P1", effort: "M", novelty: "NEW",       kind: "bridge", wave: 2, depends_on: [], probe_live: true },
  { id: "bridge_health_watchdog",      surface: "td-depth", priority: "P1", effort: "S", novelty: "NEW",       kind: "bridge", wave: 2, depends_on: [], probe_live: true },
  { id: "watch_node",                  surface: "td-depth", priority: "P2", effort: "S", novelty: "NEW",       kind: "bridge", wave: 2, depends_on: [], probe_live: false },
  { id: "param_change_event",          surface: "td-depth", priority: "P2", effort: "M", novelty: "NEW",       kind: "bridge", wave: 2, depends_on: [], probe_live: true },
  { id: "create_3d_scene_engine_comp", surface: "td-depth", priority: "P2", effort: "M", novelty: "NEW",       kind: "tool",   wave: 2, depends_on: [], probe_live: true },
  { id: "refresh_operator_kb",         surface: "td-depth", priority: "P2", effort: "L", novelty: "NEW",       kind: "bridge", wave: 2, depends_on: ["createable_truth_flag"], probe_live: true },

  // ── controls (13) ───────────────────────────────────────────────────────────
  { id: "create_modulators",   surface: "controls", priority: "P0", effort: "M", novelty: "NEW",       kind: "tool", wave: 1, depends_on: [], probe_live: true },
  { id: "create_look_bank",    surface: "controls", priority: "P0", effort: "M", novelty: "EXTENSION", kind: "tool", wave: 1, depends_on: [], probe_live: true },
  { id: "create_test_pattern", surface: "controls", priority: "P1", effort: "S", novelty: "NEW",       kind: "tool", wave: 3, depends_on: [], probe_live: false },
  { id: "create_text_crawl",   surface: "controls", priority: "P1", effort: "M", novelty: "NEW",       kind: "tool", wave: 3, depends_on: [], probe_live: false },
  { id: "create_band_router",  surface: "controls", priority: "P1", effort: "M", novelty: "EXTENSION", kind: "tool", wave: 3, depends_on: [], probe_live: true },
  { id: "create_decks_nchan",  surface: "controls", priority: "P1", effort: "M", novelty: "EXTENSION", kind: "tool", wave: 3, depends_on: [], probe_live: false },
  { id: "create_sidechain_pump", surface: "controls", priority: "P1", effort: "S", novelty: "EXTENSION", kind: "tool", wave: 3, depends_on: [], probe_live: true },
  { id: "create_xy_pad",       surface: "controls", priority: "P1", effort: "M", novelty: "EXTENSION", kind: "tool", wave: 3, depends_on: [], probe_live: true },
  { id: "create_time_echo",    surface: "controls", priority: "P1", effort: "M", novelty: "NEW",       kind: "tool", wave: 3, depends_on: [], probe_live: true },
  { id: "create_blob_reactive", surface: "controls", priority: "P2", effort: "M", novelty: "NEW",       kind: "tool", wave: 3, depends_on: [], probe_live: true },
  { id: "create_capture_loop", surface: "controls", priority: "P2", effort: "M", novelty: "EXTENSION", kind: "tool", wave: 3, depends_on: [], probe_live: true },
  { id: "create_vector_lines", surface: "controls", priority: "P2", effort: "L", novelty: "NEW",       kind: "tool", wave: 3, depends_on: [], probe_live: true },
  { id: "create_pop_geometry", surface: "controls", priority: "P2", effort: "L", novelty: "EXTENSION", kind: "tool", wave: 3, depends_on: [], probe_live: true },

  // ── library (15) ──────────────────────────────────────────────────────────────
  { id: "recipe_preview_thumbnail",   surface: "library", priority: "P0", effort: "S", novelty: "EXTENSION", kind: "library", wave: 1, bundle: "library_visibility", depends_on: [], probe_live: false },
  { id: "generate_library_index",     surface: "library", priority: "P1", effort: "S", novelty: "NEW",       kind: "library", wave: 1, bundle: "library_visibility", depends_on: [], probe_live: false },
  { id: "bundle_dependencies",        surface: "library", priority: "P1", effort: "M", novelty: "EXTENSION", kind: "library", wave: 4, depends_on: [], probe_live: true },
  { id: "publish_recipe_bundle",      surface: "library", priority: "P1", effort: "M", novelty: "NEW",       kind: "library", wave: 4, depends_on: [], probe_live: false },
  { id: "export_externalized_tree",   surface: "library", priority: "P1", effort: "S", novelty: "EXTENSION", kind: "library", wave: 4, depends_on: [], probe_live: true },
  { id: "diff_library_assets",        surface: "library", priority: "P1", effort: "M", novelty: "EXTENSION", kind: "library", wave: 4, depends_on: [], probe_live: false },
  { id: "version_library_asset",      surface: "library", priority: "P1", effort: "M", novelty: "EXTENSION", kind: "library", wave: 4, depends_on: [], probe_live: false },
  { id: "tag_and_search_library",     surface: "library", priority: "P1", effort: "M", novelty: "EXTENSION", kind: "library", wave: 4, depends_on: [], probe_live: false },
  { id: "project_documentation_site", surface: "library", priority: "P2", effort: "M", novelty: "EXTENSION", kind: "library", wave: 4, depends_on: [], probe_live: false },
  { id: "component_readme_in_package", surface: "library", priority: "P2", effort: "S", novelty: "EXTENSION", kind: "library", wave: 4, depends_on: [], probe_live: false },
  { id: "expand_recipe_library",      surface: "library", priority: "P2", effort: "M", novelty: "NEW",       kind: "recipe",  wave: 4, depends_on: [], probe_live: true },
  { id: "import_recipe_from_url",     surface: "library", priority: "P2", effort: "S", novelty: "NEW",       kind: "library", wave: 4, depends_on: [], probe_live: false },
  { id: "collect_project_assets",     surface: "library", priority: "P2", effort: "M", novelty: "NEW",       kind: "library", wave: 4, depends_on: [], probe_live: true },
  { id: "recipe_from_live_network",   surface: "library", priority: "P2", effort: "M", novelty: "EXTENSION", kind: "library", wave: 4, depends_on: ["node_flags_in_detail"], probe_live: true },
  { id: "export_palette_component",   surface: "library", priority: "P2", effort: "M", novelty: "NEW",       kind: "library", wave: 4, depends_on: [], probe_live: true },

  // ── cli (19) ──────────────────────────────────────────────────────────────────
  { id: "install_client_writers",     surface: "cli", priority: "P1", effort: "M", novelty: "ROADMAP", kind: "cli", wave: 5, depends_on: [], probe_live: true },
  { id: "doctor_fix_autoexec",        surface: "cli", priority: "P1", effort: "M", novelty: "ROADMAP", kind: "cli", wave: 5, depends_on: [], probe_live: false },
  { id: "watch_exec_hook",            surface: "cli", priority: "P1", effort: "M", novelty: "ROADMAP", kind: "cli", wave: 5, depends_on: [], probe_live: true },
  { id: "config_init_scaffolder",     surface: "cli", priority: "P1", effort: "S", novelty: "NEW",     kind: "cli", wave: 5, depends_on: [], probe_live: false },
  { id: "tdmcp_top_level_help",       surface: "cli", priority: "P1", effort: "S", novelty: "NEW",     kind: "cli", wave: 5, depends_on: [], probe_live: false },
  { id: "agent_command_index_resource", surface: "cli", priority: "P1", effort: "S", novelty: "NEW",   kind: "cli", wave: 5, depends_on: [], probe_live: false },
  { id: "install_bridge_verify",      surface: "cli", priority: "P1", effort: "S", novelty: "ROADMAP", kind: "cli", wave: 5, depends_on: [], probe_live: false },
  { id: "repl_history_and_completion", surface: "cli", priority: "P1", effort: "M", novelty: "ROADMAP", kind: "cli", wave: 5, depends_on: [], probe_live: false },
  { id: "preview_inline_and_watch",   surface: "cli", priority: "P1", effort: "M", novelty: "ROADMAP", kind: "cli", wave: 5, depends_on: [], probe_live: true },
  { id: "help_grouping_and_per_command_help", surface: "cli", priority: "P2", effort: "M", novelty: "NEW", kind: "cli", wave: 5, depends_on: [], probe_live: false },
  { id: "run_file_stdin_and_continue", surface: "cli", priority: "P2", effort: "S", novelty: "EXTENSION", kind: "cli", wave: 5, depends_on: [], probe_live: false },
  { id: "show_mode_oneliner",         surface: "cli", priority: "P2", effort: "M", novelty: "NEW",     kind: "cli", wave: 5, depends_on: [], probe_live: false },
  { id: "output_format_table_and_csv", surface: "cli", priority: "P2", effort: "S", novelty: "EXTENSION", kind: "cli", wave: 5, depends_on: [], probe_live: false },
  { id: "error_exit_code_taxonomy",   surface: "cli", priority: "P2", effort: "S", novelty: "NEW",     kind: "cli", wave: 5, depends_on: [], probe_live: false },
  { id: "no_color_flag_is_dead",      surface: "cli", priority: "P2", effort: "S", novelty: "NEW",     kind: "cli", wave: 5, depends_on: [], probe_live: false },
  { id: "watch_pretty_and_count",     surface: "cli", priority: "P2", effort: "S", novelty: "EXTENSION", kind: "cli", wave: 5, depends_on: [], probe_live: false },
  { id: "http_transport_oneflag_launch", surface: "cli", priority: "P2", effort: "S", novelty: "NEW",  kind: "cli", wave: 5, depends_on: [], probe_live: false },
  { id: "packages_cli_help_and_completion_parity", surface: "cli", priority: "P2", effort: "S", novelty: "EXTENSION", kind: "cli", wave: 5, depends_on: [], probe_live: false },
  { id: "profile_list_and_show",      surface: "cli", priority: "P2", effort: "S", novelty: "NEW",     kind: "cli", wave: 5, depends_on: [], probe_live: false },

  // ── ai (15) ─────────────────────────────────────────────────────────────────
  { id: "caption_top",                surface: "ai", priority: "P1", effort: "M", novelty: "ROADMAP",   kind: "tool",   wave: 6, depends_on: [], probe_live: true },
  { id: "prompt_catalog_autogen",     surface: "ai", priority: "P1", effort: "S", novelty: "NEW",       kind: "ai",     wave: 6, depends_on: [], probe_live: false },
  { id: "copilot_prompt_awareness",   surface: "ai", priority: "P1", effort: "S", novelty: "EXTENSION", kind: "ai",     wave: 6, depends_on: ["prompt_catalog_autogen"], probe_live: false },
  { id: "copilot_smarter_handoff",    surface: "ai", priority: "P1", effort: "S", novelty: "ROADMAP",   kind: "ai",     wave: 6, depends_on: [], probe_live: false },
  { id: "chat_cli_flags",             surface: "ai", priority: "P1", effort: "M", novelty: "ROADMAP",   kind: "cli",    wave: 6, depends_on: [], probe_live: false },
  { id: "copilot_session_persistence", surface: "ai", priority: "P1", effort: "M", novelty: "ROADMAP",  kind: "ai",     wave: 6, depends_on: [], probe_live: false },
  { id: "plan_visual_llm_grounded",   surface: "ai", priority: "P1", effort: "M", novelty: "EXTENSION", kind: "ai",     wave: 6, depends_on: [], probe_live: false },
  { id: "teach_touchdesigner",        surface: "ai", priority: "P1", effort: "S", novelty: "NEW",       kind: "prompt", wave: 6, depends_on: [], probe_live: false },
  { id: "design_brief",               surface: "ai", priority: "P1", effort: "S", novelty: "NEW",       kind: "prompt", wave: 6, depends_on: [], probe_live: false },
  { id: "repair_network",             surface: "ai", priority: "P2", effort: "M", novelty: "NEW",       kind: "tool",   wave: 6, depends_on: ["error_appeared_event", "dat_content_rest_endpoint"], probe_live: true },
  { id: "copilot_vision",             surface: "ai", priority: "P2", effort: "M", novelty: "EXTENSION", kind: "ai",     wave: 6, depends_on: [], probe_live: true },
  { id: "cookbook_resource",          surface: "ai", priority: "P2", effort: "S", novelty: "NEW",       kind: "ai",     wave: 6, depends_on: [], probe_live: false },
  { id: "llm_config_knobs",           surface: "ai", priority: "P2", effort: "S", novelty: "NEW",       kind: "cli",    wave: 6, depends_on: [], probe_live: false },
  { id: "recipe_resource_search",     surface: "ai", priority: "P2", effort: "S", novelty: "EXTENSION", kind: "ai",     wave: 6, depends_on: [], probe_live: false },
  { id: "narrate_set",                surface: "ai", priority: "P2", effort: "S", novelty: "NEW",       kind: "ai",     wave: 6, depends_on: [], probe_live: false },
];

// Deferred (backlog "Deferred to v0.6.0+ / ROADMAP-only" — gated, tracked, NOT a build target).
const deferred = [
  ["create_gpu_fluid", "controls", "GPU NVIDIA Flow solver; won't validate on macOS dev box"],
  ["create_optical_flow_particles", "controls", "optical_flow_top unsupported on macOS"],
  ["create_sdf_text", "controls", "tracked signature generator (Phase 13)"],
  ["create_strange_attractor", "controls", "tracked signature generator (Phase 13)"],
  ["create_vertex_displacement_mat", "controls", "tracked signature generator (Phase 13)"],
  ["hand_face_mediapipe_modes", "controls", "needs live webcam + ML component"],
  ["create_pose_reactive", "controls", "needs live webcam + ML component"],
  ["manage_td_process", "td-depth", "multi-TD-instance lifecycle; OS/license-coupled"],
  ["switch_instance", "td-depth", "multi-TD-instance lifecycle; OS/license-coupled"],
  ["control_diffusion", "ai", "drive StreamDiffusion/ComfyUI tox; needs GPU/CUDA"],
  ["drive_streamdiffusion", "ai", "needs GPU/CUDA"],
  ["connect_comfyui", "ai", "needs GPU/CUDA"],
  ["recipe_template_marketplace", "library", "stays local-first per distribution model"],
];

const blank = {
  status: "pending", assignee: null, files: [], attempts: 0, notes: "", last_updated: DATE,
};

let prev = {};
if (existsSync(LEDGER)) {
  try {
    const old = JSON.parse(readFileSync(LEDGER, "utf8"));
    for (const f of old.features ?? []) prev[f.id] = f;
  } catch { /* corrupt → reseed */ }
}

const merge = (entry, extra = {}) => {
  const p = prev[entry.id];
  const base = { ...entry, ...extra };
  if (!p) return { ...base, ...blank };
  // preserve live progress; refresh static plan fields
  return {
    ...base,
    status: p.status ?? blank.status,
    assignee: p.assignee ?? null,
    files: p.files ?? [],
    attempts: p.attempts ?? 0,
    notes: p.notes ?? "",
    last_updated: p.last_updated ?? DATE,
  };
};

const features = [
  ...seed.map((e) => merge(e)),
  ...deferred.map(([id, surface, reason]) =>
    merge({ id, surface, priority: "deferred", effort: "?", novelty: "ROADMAP", kind: "tool", wave: 99, depends_on: [], probe_live: true },
          { status: prev[id]?.status === "done" ? "done" : "deferred", notes: reason })),
];

const ledger = {
  campaign: "tdmcp-backlog-2026-05-29",
  source_backlog: "_workspace/discovery/FEATURE_BACKLOG.md",
  target_release: "0.7.0",
  release_cadence: "single-final", // single-final | per-wave | ask
  td_bridge_at_start: "offline",
  created: prev.__created ?? DATE,
  updated: DATE,
  waves: {
    1: "Bridge robustness + live instruments + visible library (P0 + same-file siblings)",
    2: "td-depth depth & telemetry (createable truth, info-CHOP, health, watch, events)",
    3: "Artist controls (test-pattern, crawl, band-router, decks, sidechain, xy-pad, time-echo, blob, capture, vector, POP)",
    4: "Library & packaging (bundle, publish, externalize, diff, version, tag/search, docs, recipes)",
    5: "CLI & DX (install/doctor writers, watch-exec, config init, help, run, output, flags)",
    6: "AI & LLM (caption, prompt-catalog, copilot awareness/handoff/flags/persistence, teach, brief, repair)",
    99: "Deferred — GPU/macOS/hardware/multi-instance gated (tracked, not a build target)",
  },
  features,
};

writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);

// ── human-readable view ──────────────────────────────────────────────────────
const STATUS_ORDER = ["in_progress", "blocked", "qa_unverified", "integrated", "built", "pending", "qa_pass", "done", "deferred"];
const byStatus = {};
for (const f of features) (byStatus[f.status] ??= []).push(f);
const counts = Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, v.length]));
const buildTarget = features.filter((f) => f.priority !== "deferred");
const doneCount = buildTarget.filter((f) => ["done", "qa_pass", "qa_unverified"].includes(f.status)).length;

let md = `# tdmcp Backlog Campaign — Ledger\n\n`;
md += `_Source: \`${ledger.source_backlog}\` · target \`v${ledger.target_release}\` · cadence \`${ledger.release_cadence}\` · updated ${ledger.updated}_\n\n`;
md += `**Progress:** ${doneCount}/${buildTarget.length} build-target features complete · `;
md += Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(" · ") + `\n\n`;
md += `## Waves\n\n`;
for (const [n, title] of Object.entries(ledger.waves)) {
  const ws = features.filter((f) => String(f.wave) === n);
  if (!ws.length) continue;
  const wdone = ws.filter((f) => ["done", "qa_pass", "qa_unverified", "deferred"].includes(f.status)).length;
  md += `### Wave ${n} — ${title}  (${wdone}/${ws.length})\n\n`;
  md += `| Feature | surface | pri | eff | kind | status | bundle | probe | notes |\n|---|---|---|---|---|---|---|---|---|\n`;
  for (const f of ws) {
    md += `| \`${f.id}\` | ${f.surface} | ${f.priority} | ${f.effort} | ${f.kind} | **${f.status}** | ${f.bundle ?? ""} | ${f.probe_live ? "live" : ""} | ${f.notes ?? ""} |\n`;
  }
  md += `\n`;
}
writeFileSync(LEDGER_MD, md);

console.log(`Ledger ${existsSync(LEDGER) ? "reconciled" : "seeded"}: ${features.length} features (${buildTarget.length} build-target + ${features.length - buildTarget.length} deferred).`);
console.log(`Build-target complete: ${doneCount}/${buildTarget.length}. Status:`, counts);
