#!/usr/bin/env node
// reconcile.mjs — verify each ledger feature against the ACTUAL source tree and set
// statuses. IDEMPOTENT and re-runnable. Detection is multiline-safe (the repo writes
// `server.registerTool(\n  "name",` across lines) — the v1 single-line grep produced
// false "missing" verdicts, which is why this exists. Never clobbers a live build
// state (in_progress/built/integrated/blocked).
//
// Ground truth comes from three sources:
//   1. registered MCP tool names  (perl slurp over src/tools/**.ts)
//   2. CLI command keys           (src/cli/agent.ts COMMANDS table)
//   3. an explicit VERDICTS map   (for bridge/CLI/AI/prompt features whose presence
//      isn't a tool name — encodes the human+subagent capability verification)
// Run from repo root: node _workspace/build/reconcile.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const OUT = join(process.cwd(), "_workspace", "build");
const LEDGER = join(OUT, "ledger.json");
const REPORT = join(OUT, "RECONCILE.md");
const DATE = "2026-05-30";

const sh = (cmd) => { try { return execSync(cmd, { encoding: "utf8" }); } catch { return ""; } };

// (1) registered tool names — multiline-safe
const toolNames = new Set(
  sh(`perl -0777 -ne 'while(/registerTool\\(\\s*"([a-z0-9_]+)"/g){print "$1\\n"}' $(find src/tools -name '*.ts')`)
    .split("\n").map((s) => s.trim()).filter(Boolean),
);
// (2) CLI command keys
const cliKeys = new Set(
  sh(`grep -oE '^[[:space:]]*"?[a-z][a-z0-9 _-]*"?:[[:space:]]*r\\(' src/cli/agent.ts`)
    .split("\n").map((l) => l.replace(/:\s*r\($/, "").trim().replace(/"/g, "")).filter(Boolean),
);
// (3) registered prompt names — multiline-safe
const promptNames = new Set(
  sh(`perl -0777 -ne 'while(/registerPrompt\\(\\s*"([a-z0-9_]+)"/g){print "$1\\n"}' $(find src/prompts -name '*.ts')`)
    .split("\n").map((s) => s.trim()).filter(Boolean),
);

const tool = (n) => toolNames.has(n);

// VERDICT per id: ["done"|"gap"|"extgap", evidence].  extgap = base exists, EXTEND
// (do NOT create a duplicate). Features whose id IS a tool name are auto-checked;
// the rest are encoded here from capability verification (subagent + ground truth).
const D = (e) => ["done", e];
const G = (e) => ["gap", e];
const X = (e) => ["extgap", e];

const VERDICTS = {
  // ── td-depth: bridge ── (all shipped in the v0.6.0 wave; services/routes exist)
  node_flags_in_detail: D("node_detail returns flags (api_service.py _flags)"),
  connector_order_in_detail: D("node_detail returns wires_in / _indexed_inputs"),
  node_layout_in_detail: D("node_detail returns nodeX/Y/comment/color"),
  connect_disconnect_endpoint: D("/api/connect+/api/disconnect (connect_service.py)"),
  param_modes_rest_endpoint: D("param_text_service.read_param_modes/set_param_mode"),
  dat_content_rest_endpoint: D("param_text_service.get_dat_text/put_dat_text"),
  error_dat_log_capture: D("log_service.py + GET /api/logs (Error DAT)"),
  error_appeared_event: D("cook.error/error.cleared event present"),
  info_chop_telemetry: G("get_node_state_runtime has no Info-CHOP GPU/verts breakdown"),
  createable_truth_flag: G("no /api/optypes; no createable flag on operators"),
  bridge_health_watchdog: G("doctor is one-shot; no /api/health watchdog"),
  watch_node: G("no watch_node tool"),
  param_change_event: G("no param.changed stream (Parameter Execute DAT)"),
  create_3d_scene_engine_comp: G("create_3d_scene exists but no Engine COMP sub-cook wrapper"),
  refresh_operator_kb: G("no live KB-delta tool"),

  // ── controls ──
  create_modulators: D("tool registered"),
  create_look_bank: D("tool registered"),
  create_test_pattern: G("no calibration/test-pattern generator"),
  create_text_crawl: G("only single-string create_kinetic_text; no crawl/ticker/typewriter"),
  create_band_router: G("no EQ-band → multi-target router"),
  create_decks_nchan: X("create_decks exists — extend to N-channel + per-deck FX, don't duplicate"),
  create_sidechain_pump: G("create_envelope_follower exists but no one-call sidechain pump"),
  create_xy_pad: G("no 2D/XYZ control widget"),
  create_time_echo: G("no time-displacement/slit-scan tool"),
  create_blob_reactive: G("no blob/position tracking (vs aggregate motion)"),
  create_capture_loop: G("create_live_source+setup_output exist but no bidirectional bridge tool"),
  create_vector_lines: G("no trace_sop line-art tool"),
  create_pop_geometry: X("create_pop_field (experimental) exists — extend to POP geometry"),

  // ── library ──
  recipe_preview_thumbnail: D("recipeThumbnail.captureThumbnail wired into save tools"),
  generate_library_index: D("tool registered"),
  bundle_dependencies: X("make_portable_tox exists — extend to collect+rewrite file deps"),
  publish_recipe_bundle: D("export_recipe_bundle/import_recipe_bundle present"),
  export_externalized_tree: X("manage_component exists — add save_external recurse tree"),
  diff_library_assets: G("diff_snapshots is live-only; no offline saved-asset diff"),
  version_library_asset: X("save tools exist — add semver/changelog/retained-prior"),
  tag_and_search_library: D("save_component_to_vault tags[] + browse_vault_library filter"),
  project_documentation_site: G("generate_readme+document_network exist but no composed doc package"),
  component_readme_in_package: X("make_portable_tox exists — inject a params/IO README"),
  expand_recipe_library: G("no first-party recipes for raymarch/flock/gpu-particles/pbr/datamosh"),
  import_recipe_from_url: G("no URL/git-raw recipe import"),
  collect_project_assets: G("no project-wide asset-gather tool"),
  recipe_from_live_network: X("save_recipe_to_vault exists — add faithful serialize round-trip"),
  export_palette_component: G("create_palette is TD-node-only; no .tox export to Palette folder"),

  // ── cli ──  (capability-verified, not tool-name)
  install_client_writers: G("install-client prints only; no --write/deep-merge"),
  doctor_fix_autoexec: G("doctor --fix prints suggestions; doesn't execute repairs"),
  watch_exec_hook: G("no watch --on/--exec reactive hook"),
  config_init_scaffolder: G("no config init scaffolder"),
  tdmcp_top_level_help: G("no real top-level tdmcp --help"),
  agent_command_index_resource: G("no commands --json / tdmcp://commands"),
  install_bridge_verify: G("no install-bridge --verify/--wait/--port"),
  repl_history_and_completion: G("REPL has no persistent history / tab-completion"),
  preview_inline_and_watch: G("no preview --inline/--watch"),
  help_grouping_and_per_command_help: G("no grouped usage / help <command>"),
  run_file_stdin_and_continue: G("no run - (stdin) / --continue-on-error"),
  show_mode_oneliner: G("no tdmcp show <profile> pre-flight"),
  output_format_table_and_csv: G("no --output table/csv"),
  error_exit_code_taxonomy: G("ad-hoc exit codes; no taxonomy"),
  no_color_flag_is_dead: G("--no-color parsed but never applied"),
  watch_pretty_and_count: G("no watch --pretty/heartbeat"),
  http_transport_oneflag_launch: G("no serve --http one-flag"),
  packages_cli_help_and_completion_parity: G("manage_packages tool but no packages CLI subcommand"),
  profile_list_and_show: G("no config profiles list/show"),

  // ── ai ──
  caption_top: G("no caption_top tool"),
  prompt_catalog_autogen: G("tdmcp://prompts is hand-synced; no autogen from registry"),
  copilot_prompt_awareness: D("llm/agent.ts ensureSystem re-injects tier system prompt"),
  copilot_smarter_handoff: D("llm/handoff.ts buildHandoffPrompt"),
  chat_cli_flags: G("no chat --read-only/--creative/--prompt"),
  copilot_session_persistence: G("chat REPL doesn't persist transcript/tier to disk"),
  plan_visual_llm_grounded: X("plan_visual exists (keyword) — add optional LLM planner"),
  teach_touchdesigner: tool("teach_touchdesigner") || promptNames.has("teach_touchdesigner") ? D("present") : G("no KB-grounded tutor prompt (tdmcp://tutorials unused)"),
  design_brief: promptNames.has("design_brief") ? D("present") : G("no persistent aesthetic-direction prompt"),
  repair_network: G("no bounded autonomous repair tool"),
  copilot_vision: G("copilot has no image-part/vision path"),
  cookbook_resource: G("no tdmcp://cookbook resource"),
  llm_config_knobs: G("no TDMCP_LLM_TIER/_MAX_STEPS/_TEMPERATURE config keys"),
  recipe_resource_search: G("no keyword search over recipes resource"),
  narrate_set: G("no persisted narration during auto_vj_director"),
};

const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
const report = { done: [], extgap: [], gap: [], skipped: [] };

for (const f of ledger.features) {
  if (f.priority === "deferred") { report.skipped.push(f.id); continue; }
  if (["in_progress", "built", "integrated", "blocked"].includes(f.status)) { report.skipped.push(`${f.id} (${f.status})`); continue; }

  // auto-confirm: if the feature id is itself a registered tool, it's done
  let verdict, evidence;
  if (tool(f.id)) { verdict = "done"; evidence = `tool ${f.id} registered`; }
  else if (VERDICTS[f.id]) { [verdict, evidence] = VERDICTS[f.id]; }
  else { verdict = "gap"; evidence = "no reconcile rule — treat as gap"; }

  f.last_updated = DATE;
  if (verdict === "done") { f.status = "done"; f.notes = `shipped: ${evidence}`; report.done.push(f.id); }
  else if (verdict === "extgap") { f.status = "pending"; f.kind = "extension"; f.notes = `EXTEND (don't duplicate): ${evidence}`; report.extgap.push(`${f.id} — ${evidence}`); }
  else { f.status = "pending"; f.notes = `gap: ${evidence}`; report.gap.push(`${f.id} [w${f.wave}]`); }
}

ledger.updated = DATE;
ledger.tool_count_at_reconcile = toolNames.size;
writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);

const bt = ledger.features.filter((f) => f.priority !== "deferred");
let md = `# Reconciliation — backlog vs. source tree (${DATE})\n\n`;
md += `Multiline-safe detection over **${toolNames.size} registered tools** + ${cliKeys.size} CLI keys + ${promptNames.size} prompts.\n`;
md += `The backlog (2026-05-29) predates the v0.6.0 wave, which harvested every P0 — so Wave 1 is already shipped.\n\n`;
md += `**Build-target features: ${bt.length}** → ${report.done.length} already shipped (done) · ${report.extgap.length} EXTEND-in-place · ${report.gap.length} genuine new-build gaps · ${report.skipped.length} skipped.\n\n`;
md += `## ✅ Already shipped (${report.done.length}) — do NOT rebuild\n${report.done.map((x) => `- \`${x}\``).join("\n")}\n\n`;
md += `## ♻️ Extend in place (${report.extgap.length}) — base tool exists; single-writer extension, never a new duplicate tool\n${report.extgap.map((x) => `- ${x}`).join("\n")}\n\n`;
md += `## 🔨 Genuine new-build gaps (${report.gap.length})\n${report.gap.map((x) => `- \`${x}\``).join("\n")}\n\n`;
md += `## ⏭️ Deferred (${report.skipped.length})\n${report.skipped.map((x) => `- ${x}`).join("\n")}\n`;
writeFileSync(REPORT, md);

console.log(`tools=${toolNames.size} done=${report.done.length} extend=${report.extgap.length} gap=${report.gap.length} deferred=${report.skipped.length}`);
const byWave = {};
for (const f of bt) if (f.status === "pending") (byWave[f.wave] ??= []).push(f.id);
for (const w of Object.keys(byWave).sort()) console.log(`  wave ${w}: ${byWave[w].length} to build`);
