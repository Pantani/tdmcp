---
name: td-hype-synthesize
description: "Consolidate the td-trend-scout reports under `_workspace/hype-scout/` into one prioritized HYPE_TOOL_BACKLOG.md — dedupe trends across surfaces, vet each candidate against the real tdmcp codebase (layer fit, operator coverage, bridge work), rank by Hype × Build-Ease, and emit a 'Ready for tdmcp-pipeline' top-5. Use when a td-hype-synthesizer agent is consolidating scouts at the end of the tdmcp-hype-scout harness."
---

# td-hype-synthesize — synthesis + feasibility vetting + ranking

This skill is loaded by the `td-hype-synthesizer` sub-agent. You produce exactly one file: `_workspace/hype-scout/HYPE_TOOL_BACKLOG.md`. You do not scout new trends.

## Procedure

### Step 1 — Inventory the scouts

List every `_workspace/hype-scout/01_scout_*.md` file:

```bash
ls _workspace/hype-scout/01_scout_*.md
```

Read each file end to end. Note:
- Which surfaces are present and which are missing (`SCOUT MISSING: <surface>`).
- Which files are tagged `PARTIAL-DUE-TO-NETWORK` — propagate that into the synthesis header.
- The total candidate count and per-surface tally.

### Step 2 — Build the master candidate table (in memory)

Collect every entry into a working table with columns:

| Field | Source |
|---|---|
| `id` | new sequential (S001…) |
| `name` | scout's tool name |
| `surfaces` | list — usually one, but grow during dedup |
| `summary` | merged "what artists are doing" + "why hyped" |
| `evidence` | union of all citations |
| `scout_hype` | the scout's call (H/M/L) — list if multiple scouts |
| `scout_build_ease` | scout's guess (S/M/L) |
| `scout_coverage` | NOT-COVERED / PARTIAL / COVERED |
| `proposed_layer` | scout's suggestion |
| `proposed_operators` | scout's suggestion |

### Step 3 — Dedupe across surfaces

Two entries collapse into one when they describe the **same TouchDesigner outcome**, even if the scouts framed them differently. Heuristics:

- Same suggested operators → merge.
- Same trend name (case-insensitive, allowing minor wording differences like "StreamDiffusion realtime" vs "Realtime StreamDiffusion bridge") → merge.
- Same "what artists are doing" core (one summary is a subset of another) → merge.

When merging:
- `surfaces` = union.
- `evidence` = union (dedupe by URL).
- `scout_hype` = if all scouts agreed, keep that. If they disagreed, take the **mode** but annotate inline (e.g. `M (showcase: H, tutorials: M)`).
- A trend that appeared in **3+ surfaces** gets a +1 step on Hype (capped at H). Multi-surface confirmation is itself a hype signal.

Do **not** delete dropped entries — keep them in a `## Merge log` appendix at the bottom so the merge is auditable.

### Step 4 — Vet feasibility against the real codebase

For each merged candidate, run targeted greps to lock the **layer, operator coverage, and effort estimate**. Quote what you find so the call is auditable.

| Check | Command |
|---|---|
| Layer 1/2/3 tool already exists? | `grep -rn "create_<name>" src/tools/` |
| Operator in KB? | `grep -irn "<operator-name>" src/knowledge/data/` |
| Recipe already covers it? | `ls recipes/ \| grep -i <keyword>` |
| Bridge endpoint exists? | `grep -rn "<endpoint>" src/td-client/touchDesignerClient.ts td/` |
| Roadmap already lists it? | `grep -in "<keyword>" docs/ROADMAP.md` |

Resolve each candidate to one of:

| Verdict | Meaning | Effort default |
|---|---|---|
| **NEW** (clean) | no existing tool, all operators in KB, no bridge work | S |
| **NEW** (operator gap) | operators exist but not yet wrapped in tdmcp | M |
| **NEW** (bridge needed) | needs a new bridge endpoint (e.g. a new device, persistent state) | L |
| **EXTENSION** | existing tool covers most of it; add a preset/param | S |
| **COVERED** | already shipped — surface as "add cookbook example" |  - |
| **ROADMAP** | already on `docs/ROADMAP.md` for a future phase | note phase |
| **FEASIBILITY-UNCERTAIN** | operator may or may not exist, KB ambiguous | flag for live probe |

Adjust the build-ease score according to the verdict (overwrite scout's guess if vetting disagrees, but log the change).

### Step 5 — Rank with an explicit weighting profile

**Default profile (state it at the top of the output):**

```
score = HYPE_WEIGHT[hype] × BUILD_EASE_WEIGHT[ease]
HYPE_WEIGHT       = { L: 1, M: 2, H: 3 }
BUILD_EASE_WEIGHT = { L: 1, M: 2, S: 3 }
```

So the maximum is H × S = 9, the minimum is L × L = 1. Sort descending. Tie-break by: (1) cross-surface count desc, (2) NEW > EXTENSION > COVERED, (3) Hype desc, (4) name asc.

**Alternative profiles** the user can request (offer them at the end of the file in a "Re-rank knobs" section):

- **Hype-only:** rank by hype, ignore effort.
- **Quick-wins:** filter `ease == S`, then rank by hype.
- **Strategic:** rank L items above S items (long-term bets first).
- **Conservative:** drop everything `FEASIBILITY-UNCERTAIN`.

### Step 6 — Identify force multipliers

A **force multiplier** is one piece of foundational work (a new bridge endpoint, a new operator wrapper, a new prompt) that unlocks 3+ ranked tools. Surface these at the very top of the output, **above** the ranked list, with the dependents listed by id. They often beat any individual tool on ROI.

Example: "Wrap `realsense2TOP` as a Layer 3 tool with depth/color/IR streams + a small Layer 2 helper" might unlock S013 (LiDAR particle scatter), S017 (hand-gesture pointer), S021 (depth-keyed silhouette). Flag as **Force multiplier FM-01**.

### Step 7 — Write the output file

`_workspace/hype-scout/HYPE_TOOL_BACKLOG.md` — this exact structure:

```markdown
# Hype tool backlog — tdmcp

**Run:** <YYYY-MM-DD>
**Scout coverage:** <surfaces present> (missing: <none|list>)
**Profile used:** default — Hype × Build-Ease (state weights inline)
**Notes:** any `PARTIAL-DUE-TO-NETWORK` flags, any `SCOUT MISSING` gaps.

---

## Force multipliers

> Foundational work that unlocks 3+ ranked tools.

### FM-01 — <one-line summary>
- **Why:** <hype trends it unlocks>
- **What to build:** <layer + scope>
- **Unlocks:** S###, S###, S###
- **Effort:** S / M / L

(...repeat for FM-02 etc., or "None this run.")

---

## Ready for tdmcp-pipeline (top 5)

> Highest-confidence, lowest-friction picks. Hand straight to `tdmcp-pipeline`.

| # | id | Tool | Layer | Hype | Ease | Coverage | Surfaces |
|---|----|------|-------|------|------|----------|----------|
| 1 | S### | `create_<name>` | 1 | H | S | NEW | community-showcase + tutorials |
| 2 | ... |  |  |  |  |  |  |

For each, link to the detailed entry below.

---

## Ranked backlog

| Rank | id | Tool | Layer | Hype | Ease | Coverage | Score |
|------|----|------|-------|------|------|----------|-------|
| 1 | S001 | ... | 1 | H | S | NEW | 9 |
| 2 | ... |  |  |  |  |  |  |

---

## Per-surface breakdowns

### community-showcase
| id | Tool | Hype | Ease | Coverage |
|----|------|------|------|----------|
| ... |  |  |  |  |

### tutorials
...

### generative-ai
...

### hardware-interactive
...

### vfx-aesthetics
...

---

## Candidate details

### S001 — <Tool name>
- **Summary:** <merged what+why>
- **Surfaces:** community-showcase, tutorials
- **Evidence:** (union of all scout citations, one per line)
  - <URL> — <desc>
- **Hype:** H (showcase: H, tutorials: H)
- **Build-ease:** S — vetted
- **Coverage:** NEW (clean) / NEW (operator gap) / EXTENSION — existing `<tool>` / COVERED — existing `<tool>` / ROADMAP — phase X.Y / FEASIBILITY-UNCERTAIN — probe live
- **Layer:** 1 / 2 / 3 / bridge-endpoint
- **Suggested operators:** `<a>, <b>, <c>` (KB confirmed) | (UNVERIFIED — probe live)
- **Tool sketch:** 1-3 sentences, what the tool does end-to-end.
- **Force-multiplier link:** FM-0X (if any)
- **Vet notes:** what grep found / didn't find. Quote paths.

(...all candidates...)

---

## Re-rank knobs

Available alternative profiles (re-invoke synth with the chosen one):
- `--profile=hype-only`
- `--profile=quick-wins`
- `--profile=strategic`
- `--profile=conservative`

---

## Merge log

| New id | Merged from | Reason |
|--------|-------------|--------|
| S001 | scout-community-showcase #3, scout-tutorials #7 | same outcome, same operators |

---

## Follow-up suggestions (not scouted)

> Gaps you noticed during synthesis but were not in any scout. Surface only — do not score; mark for re-scout next run.

- ...
```

## Working principles

- **Quote the grep.** "I checked `grep -rn 'streamdiffusion' src/tools/` — no matches" is auditable; "this is not covered" is not.
- **No silent overwrites.** If your vetting changes a scout's hype or build-ease score, log it in the entry's `Vet notes:`.
- **Tight top-5.** If you can't confidently pick 5, pick 3. Don't dilute.
- **Honest gaps.** A missing scout file is not a synthesis failure; just note it in the header and move on.

## What not to do

- Don't scout new trends. Work only from existing scout files. Surface gaps you noticed under "Follow-up suggestions" without scoring them.
- Don't drop or hide disagreement between scouts. Annotate it.
- Don't pad the ranked list with weak entries to look comprehensive.
- Don't recommend tools that contradict `docs/ROADMAP.md` without flagging the contradiction.

## Re-invocation

If `HYPE_TOOL_BACKLOG.md` already exists:

1. Read it first.
2. Apply only the requested change — re-rank under a new profile, re-vet a single candidate, refresh the top-5, add a new section — preserve numbering and the merge log.
3. Bump the `Run:` date and add a short `## Changes this run` section near the top describing what changed.
