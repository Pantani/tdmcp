---
name: tdmcp-backlog-campaign
description: "Drive the ENTIRE tdmcp feature backlog (_workspace/discovery/FEATURE_BACKLOG.md) to completion across many dependency-ordered waves and many sessions — idempotently (a durable ledger; never redo or duplicate finished work) and resiliently (1 retry → skip → resume; TD-offline never blocks). Use whenever the user wants to implement ALL / the whole / the entire backlog, run the build campaign, do it in waves, or with resilience/idempotency; and for every follow-up: continue / resume / re-run the campaign, run the next wave, what's left / where is the campaign, fix a blocked feature, or cut the final release. This is the SUPERVISOR above tdmcp-pipeline/tdmcp-feature-lead: it owns the ledger + wave plan and dispatches each wave through them. For a single feature or one small batch, use tdmcp-pipeline instead."
---

# tdmcp-backlog-campaign — whole-backlog build supervisor

Take the entire prioritized backlog from list to shipped, wave by wave, surviving
interruption. One wave is `tdmcp-feature-lead`'s job; the **campaign** — 77+
features across sessions — is this skill's. The two things that make a long build
work are the two things this skill is about: **idempotency** (the ledger) and
**resilience** (fail forward, resume). Spawn the `tdmcp-campaign-lead` agent to run
it, or act as it yourself.

## Execution mode: hybrid (campaign over the existing harness)

| Layer | Mode | Tooling |
|---|---|---|
| Campaign (waves, ledger, resume, release) | supervisor | this skill + `tdmcp-campaign-lead` |
| Isolated tool builds (new files only) | sub-agent fan-out, parallel | `tdmcp-tool-builder` (×N, single message) |
| Bridge slices (shared `td/`+client+validators) | sub-agent, **sequential** | `tdmcp-bridge-engineer` (one at a time) |
| Integrate · QA · release | single writer / small team | `td-integrator` · `td-qa` · `td-releaser` |

Why hybrid: new-file builders are conflict-free → parallel; bridge slices share
files → serialize; integration/QA/release is a tight fix-and-verify loop → single
writer or a small team. This is the proven `tdmcp-pipeline` shape, wrapped in a
ledger-driven campaign loop so it spans the whole backlog and many sessions.

## Phase 0 — context check (ALWAYS first; this is what makes it resumable)

1. Is there a `_workspace/build/ledger.json`?
   - **Yes →** resume. Run `node _workspace/build/init-ledger.mjs` (merge-aware —
     refreshes the plan from the backlog, **preserves every live status**). Then
     **reconcile with disk** (below). Pick up at the first incomplete wave.
   - **No →** seed it: ensure `_workspace/discovery/FEATURE_BACKLOG.md` exists in
     this checkout (copy from the main checkout if you are in a worktree —
     `_workspace/` is gitignored, so each checkout has its own), then run the
     generator.
2. **Reconcile (self-heal drift).** For each feature the ledger calls
   `built`/`integrated`/`done`, confirm its files exist and are wired; if not,
   downgrade its status so it rebuilds. For each `pending` feature, grep for an
   existing tool/endpoint of that name — if it already ships, mark it `done` (or
   switch it to extend-mode). The ledger must match reality before you build.
3. Read the user's intent and branch: continue (next wave) · re-run wave N · fix
   feature X · status only (report, don't build) · release.

## The ledger (idempotency) — `_workspace/build/ledger.json`

Source of truth. Per feature: `id, surface, priority, effort, novelty, kind, wave,
bundle?, depends_on[], probe_live, status, assignee, files[], attempts, notes,
last_updated`. Status lifecycle:

```
pending → in_progress → built → integrated → (qa_pass | qa_unverified) → done
                              ↘ blocked (after 1 retry)        deferred (gated)
```

**Rules that enforce idempotency**
- Never start a feature that is `done`/`deferred`. Never start one whose
  `depends_on` are not yet `done`/`qa_unverified`.
- Before building, **grep the codebase** — ~31 backlog items are `EXTENSION` and a
  few already ship. Extend the existing file (single-writer), don't create a
  duplicate tool.
- Write the ledger back after **every** state change (in_progress on dispatch,
  built/blocked on report, integrated on wire, qa_* on QA). A crash mid-wave loses
  at most one feature's step.
- Regenerate `LEDGER.md` (the human view) whenever you write `ledger.json` — the
  generator does both.

## Wave plan

Waves are dependency-ordered; nothing in a later wave is blocked by an unbuilt
earlier tool. **Bundles** (features sharing one file/change) are built together by
one agent.

1. **Bridge robustness + live instruments + visible library** (the 7 P0 + same-file
   siblings): `node_detail_fidelity` (flags+connector-order+layout), `connect_endpoint`,
   `param_dat_endpoints` (param-modes+DAT-text), `error_logs_event` (Error DAT + cook.error),
   `create_modulators`, `create_look_bank`, `library_visibility` (thumbnail+index).
2. **td-depth depth & telemetry:** createable-truth, info-CHOP telemetry, health
   watchdog, watch_node, param/error events, engine-COMP, KB refresh (← createable).
3. **Artist controls:** test-pattern, text-crawl, band-router, decks(N), sidechain,
   xy-pad, time-echo, blob, capture-loop, vector-lines, POP-geometry.
4. **Library & packaging:** bundle-deps, publish-bundle, externalize-tree, diff,
   version, tag/search, doc-site, component-readme, recipe-expansion, url-import,
   collect-assets, recipe-from-live (← node_detail), palette-export.
5. **CLI & DX:** install-client/doctor writers, watch-exec, config-init, top-help,
   command-index, bridge-verify, REPL, preview-inline, help/run/output/flags polish.
6. **AI & LLM:** caption_top, prompt-catalog-autogen → copilot-awareness, handoff,
   chat-flags, session-persistence, llm-grounded plan, teach, design-brief, repair
   (← error event + DAT endpoint), vision, cookbook, knobs, search, narrate.

(Deferred wave 99 = GPU/macOS/hardware/multi-instance-gated; tracked, never built
here.) The authoritative per-feature wave/bundle/deps live in `ledger.json`.

## Phase 1..N — run a wave

1. Mark the wave's features `in_progress`; write the ledger.
2. **Split by kind.** `kind: bridge` (or any tool rewiring off `/api/exec`, or
   editing `td/`/`touchDesignerClient.ts`/`validators.ts`) → bridge slice. Else →
   isolated tool/cli/ai/library/recipe build.
3. **Dispatch isolated builds in parallel:** spawn `tdmcp-tool-builder` ×N in a
   **single message**, `model: "opus"`. Brief each cold (see "Briefing"). They
   create ONLY their two files.
4. **Dispatch bridge slices sequentially:** one `tdmcp-bridge-engineer` at a time,
   `model: "opus"`, each a full vertical slice (endpoint + client + validator +
   tool rewire + exec-fallback + offline tests). Never two at once.
5. **Integrate (single writer)** as reports land: read the agent's *actual files*,
   then wire imports + layer `index.ts` + a 1:1 CLI verb in `src/cli/agent.ts`
   (prompts → `src/prompts/index.ts`). Mark `integrated`.
6. **Gate** after each integration: `npm run typecheck` · `npm run build` ·
   `./node_modules/.bin/biome check .` (NOT `npm run lint` — RTK breaks it) · `npm
   test` · `npm run validate:recipes` (if recipes) · `npm run test:bridge` (if
   `td/` changed). Fix forward.
7. **Incremental QA** with `td-qa` per feature. If `get_td_info` shows TD up →
   live-validate (preview + **post-cook `get_td_node_errors`**) → `qa_pass`. If TD
   offline → offline gates only → `qa_unverified` (record what is unverified).
8. **Accumulate** per cadence (below): append to `CHANGELOG.md`, flip ROADMAP,
   write `_workspace/build/NN_wave<n>_report.md`, update the ledger, commit + push
   the wave branch.

## Briefing a builder (it walked in cold)

Give it, in the spawn prompt: tool name + file path + layer; the **full Zod
schema** (every field/type/default/describe); the **exact bridge calls** (Python
API methods; par/method names to *probe* not hardcode); the closest **reference
file** to copy; the fail-forward/warning rules; the **test to mirror**; "load the
`tdmcp-tool-builder` skill first"; and "create ONLY your two files; report the CLI
key + index entry to wire." For a bridge slice, point at `tdmcp-bridge-endpoint`
and name the endpoint + the tool(s) to rewire + the exec-fallback requirement.

## Resilience

| Situation | Strategy |
|---|---|
| Builder/bridge/QA fails | One retry with the precise failure fed back. Still failing → `blocked` + reason in the ledger; **continue the wave**. |
| Build breaks on integrate | Bisect, wire the rest, send the offender a precise fix; never block the wave for one tool. |
| Bridge offline | Build offline-gated; mark probe-dependent items `qa_unverified` (UNVERIFIED-live); hold them for a live pass before the final release; never fail the campaign for a missing TD. |
| Probe finding conflicts (par name varies by build) | Record both with source in `notes`; pick the KB default; flag UNVERIFIED-live. |
| Session ends mid-wave | Ledger already has per-feature state → next run resumes from the first incomplete feature. |
| A feature turns out already shipped | Mark `done` with a note; don't rebuild. |

Hard git rails (even autonomous): branch off, never force-push, never `--no-verify`,
never tag a tree with failing gates.

## Release (cadence-driven — `ledger.release_cadence`)

- `single-final` (default): accumulate every wave under the target version's
  *Unreleased* CHANGELOG section; **do not tag** per wave. After the last build wave,
  do a **live-probe pass** of all `qa_unverified` items (when TD is up), then hand to
  `td-releaser`: bump version across all manifests, finalize CHANGELOG, commit, tag,
  push. Gate on QA = PASS for everything shipping; hold FAILs to a follow-up.
- `per-wave`: `td-releaser` cuts a themed minor at each wave boundary.
- `ask`: stop at each wave boundary and ask release-or-continue.

## Reporting (every run, last line)

Counts by status (done/qa_unverified/blocked/pending), the current wave, and the
single most useful next action ("run: continue the campaign" / "TD is offline — N
items await a live-probe pass" / "blocked: X — needs Y").

## Test scenarios

**Normal (fresh):** no ledger → seed (77+13) → Wave 1: 3 tool-builders in parallel +
4 bridge slices sequential → integrate + gate green → TD offline so QA marks the 4
bridge bundles `qa_unverified`, the 3 builds `qa_pass` (offline) → CHANGELOG under
Unreleased, ledger updated, wave branch pushed, no tag → report: "11/77 done-ish,
Wave 2 next, 4 await live probe."

**Resume:** ledger shows Wave 1 done, Wave 3's `create_decks_nchan` `blocked`
(2 attempts) → "continue" → reconcile, skip done, start Wave 2; leave the blocked
item flagged for a targeted re-run.

**Error:** a bridge slice can't be made green in 2 attempts → `blocked` + reason;
the other Wave-1 features still integrate, QA, and ship; the report names the gap
and the exact next action to unblock it.
