---
name: tdmcp-docs-interactive
description: Restructure and enrich the tdmcp documentation site for artists — categorized/collapsible sidebar (EN+PT), interactive goal-based guide home, new step-by-step tutorials, copy-prompt/level-badge components. Use whenever the user asks to make the docs more interactive, easier to navigate, better organized, add categories/subcategories, add tutorials, improve docs UX/IA, or for follow-ups: re-run, continue, fix QA findings, add one more tutorial, re-organize a section, or update the docs structure. NOT for syncing docs with a release (tdmcp-docs-roadmap-update) or cookbook entries (tdmcp-cookbook-examples).
---

# tdmcp-docs-interactive — orchestrator

Pipeline (sub-agents, no TeamCreate in this environment): **architect → (builder ∥ tutorial writers) → QA → fix loop**. Data flows through `_workspace/docs-interactive/` files.

## Phase 0: context check
- `_workspace/docs-interactive/` missing → initial run (full pipeline).
- Exists + user asks partial change ("add one tutorial", "fix QA items") → rerun only the relevant agent(s); every agent knows to revise, not restart.
- Exists + user gives a new direction → move it to `_workspace/docs-interactive_prev/` and run fresh.

## Phase 1: IA design
Spawn `docs-ia-architect` (model opus). Input: the user's complaint/goals + any prior proposal from conversation. Output: `01_ia_spec.md`. Review the spec briefly; if it invents nonexistent tools/pages without NEW markers, send it back once.

## Phase 2: build (parallel)
In ONE message spawn:
- `docs-interactive-builder` (opus) — implements sidebar/home/components from the spec; creates stubs for tutorial pages so the build never breaks.
- one `docs-tutorial-writer` (opus) **per tutorial** in spec §3 — each owns only its EN+PT page pair.
File ownership prevents conflicts: builder never writes tutorial prose; writers never touch config/theme.

## Phase 3: QA
Spawn `docs-roadmap-qa` (opus): `npm run docs:build` gate, EN/PT structural parity, dead links, sidebar↔file existence cross-check, generated `reference/tools.md` untouched. QA writes findings to `_workspace/docs-interactive/04_qa_report.md`.

## Phase 4: fix loop + wrap-up
- QA FAIL → route each finding to its owner agent (builder vs writer), rerun QA once. Second FAIL → report remaining issues to the user, do not loosen gates.
- PASS → summarize: structure changes, new pages, components, build status. Do NOT commit/tag unless the user asked; follow repo release policy (no premature tags).

## Error handling
One retry per agent; on second failure continue without that slice and state the gap explicitly. Conflicting spec vs. reality (page missing, tool renamed) → prefer reality, note the deviation in the report.

## Test scenarios
- Normal: "deixe os docs mais interativos com categorias e tutoriais" → full pipeline, docs:build green, sidebar grouped in EN+PT, ≥3 tutorials in both locales.
- Error: a tutorial writer references a nonexistent tool → QA flags it, writer revises against the cookbook, second QA passes.
