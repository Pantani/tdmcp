---
name: td-feature-survey
description: "Survey one surface of tdmcp (artist controls, library/packaging, CLI/DX, AI/LLM, or TouchDesigner depth) for candidate NEW features — inventory what exists, cross-check the roadmap, apply the gap-finding lenses, vet each idea, and emit a structured, novelty- and confidence-labelled candidate list to _workspace/discovery/. Use when a td-surveyor agent is scouting a surface during the feature-discovery harness."
---

# td-feature-survey — scout one surface for new features

You are surveying **one** assigned surface of tdmcp and returning a grounded, generous list of features it could gain. Breadth + grounding is the goal; the `td-synthesizer` prunes and ranks later. Work the surface methodically so you neither miss obvious gaps nor re-propose shipped tools.

## Procedure

### 1. Confirm the surface
Your assignment is one of `controls`, `library`, `cli`, `ai`, `td-depth`. Survey only that surface. If you spot a strong idea on another surface, drop it in a one-line "cross-surface" footnote — don't fully work it up (its owner will).

### 2. Inventory what already exists
Read your surface's source (map below) and list what ships today. You cannot propose something that already exists, so build the "exists" set first. For tools, the registry under `src/tools/` is authoritative; for CLI, `src/cli/agent.ts`; for prompts, `src/prompts/`; for operators, the KB.

### 3. Roadmap pass
Read `docs/ROADMAP.md`. Note every item on your surface that is shipped (☑), in progress (◐), or planned (☐ — Phase 13 / "deferred to v0.6.0+"). You will label candidates against this.

### 4. Gap-finding lenses
Run every candidate idea through these lenses — a good survey uses all of them, not just one:

| Lens | Question | Where it bites for tdmcp |
|---|---|---|
| **Competitor parity** | What do 8beeeaaat / Embody / dotsimulate LOPs have that we don't? | network-as-JSON round-trip, token-cheap reads, annotations, perform mode |
| **Untapped TD capability** | Which TD operators / Python APIs / bridge powers aren't wrapped yet? | operators absent from the create-able set; bridge endpoints (logs, process, events) |
| **Artist-workflow hole** | What's painful or missing in a *real live show*? | the VJ/live thesis — audio/beat/camera reactivity, recovery, hands-free, output |
| **DX / token cost** | What makes an agent slow, expensive, or error-prone here? | compact reads, batch ops, surgical edits, diagnostics |
| **AI leverage** | What could the model do that no prompt/tool exposes? | multimodal critique, repair loops, set planning, project explain |
| **Polish / robustness** | What breaks trust at the edges? | export fidelity, safety/panic, portable bundles, validation |

### 5. Surface map — where to look

- **controls** — *creation & performance only.* `src/tools/layer1/` (artist generators), `src/tools/layer2/` (building blocks: mixing, reactivity, live-control surfaces, animation). **Excludes** the vault/recipe/packaging concern (→ `library`). Lenses that bite hardest: artist-workflow, untapped-TD, competitor-parity.
- **library** — *reusable assets, packaging & sharing.* The Obsidian vault tools `src/tools/vault/`, the recipe library `recipes/` + `src/recipes/`, and the reusable-component/packaging tools (`manage_component` `.tox` save/load, `scaffold_extension`, `add_custom_parameters`). The home of the v0.5.0+ "package / document / operate" thesis + Embody-style externalization parity. Lenses: artist-workflow (reuse across shows), competitor-parity, DX. Gaps = library browse/save, portable bundles, templates, marketplace, project docs that live as assets.
- **cli** — `src/cli/agent.ts` (command map), `src/index.ts` (subcommands: `install-bridge`, `chat`/`llm-run`, `doctor`, `repl`, `watch`, `preview`), `package.json` scripts, the installer. Lenses: DX, artist-easy-install, polish.
- **ai** — `src/prompts/*` (every prompt), the local-LLM copilot in `src/index.ts` (`chat`/`llm-run`) + `TDMCP_LLM_*` in `src/utils/config.ts`, and the curated tool subset the copilot exposes. Lenses: AI-leverage, DX, competitor-parity.
- **td-depth** — *raw TD reach.* `src/tools/layer3/` (atomic CRUD + inspection + raw-python), the Python bridge `td/` (REST endpoints, events hook, exec), and the KB `src/knowledge/data` (resources `tdmcp://operators/…`). Covers unwrapped operators, parameter-mode/expression fidelity, and bridge powers (logs, process, perform mode) — but **not** the packaging/reuse layer (→ `library`). Use `search_operators` to find operators that exist in TD but aren't wrapped by any tool. Lenses: untapped-TD, DX, competitor-parity.

### 6. Novelty labelling (be honest)
Every candidate gets one label:
- **NEW** — not in the roadmap, not shipped. This is the headline value of the survey.
- **ROADMAP (Phase X)** — already planned; cite the phase. Still report it (it confirms priority), but never disguise it as a discovery.
- **EXTENSION (of `<tool>`)** — a concrete extension of a shipped tool/command/prompt.

### 7. Entry format
Write each candidate exactly like this so the synthesizer can parse it:

```
### <feature_name>
- **Delivers:** <one line — what it does>
- **Why:** <artist / user / DX value — the outcome>
- **Surface:** controls | library | cli | ai | td-depth
- **Layer/target:** <e.g. Layer 1 — src/tools/layer1/<name>.ts · or CLI `cmd` · or prompt · or bridge endpoint>
- **Effort:** S | M | L
- **Impact:** Low | Med | High
- **Confidence:** High | Med | Low  <!-- High = gap confirmed against your inventory AND every operator confirmed in the KB; Med = gap clear but an operator/API is unconfirmed; Low = plausible but unverified -->
- **Novelty:** NEW | ROADMAP (Phase X) | EXTENSION (of <tool>)
- **Depends on:** <shipped primitives / other candidates / none>
- **Probe-first risk:** <what must be validated live in TD before locking the API — or "none">
```

## Output

Write the file **incrementally** so a mid-run interruption (a dropped socket, a timeout) still leaves usable partial work: create `_workspace/discovery/01_survey_<surface>.md` early with its header, then append each entry as you confirm it — don't hold the whole survey in memory to write once at the end.

The finished file contains:
1. A one-line header naming the surface and what you inventoried.
2. The candidate entries, loosely grouped by the lens or theme they came from.
3. A closing **tally**: counts by novelty (NEW / ROADMAP / EXTENSION), by impact (High / Med / Low), and by **confidence** (High / Med / Low).
4. A short **cross-surface** footnote list, if any.

## Quality bar

- **Depth over count.** Aim ~8–15 **high-confidence** candidates, not a maximal list. Vet each before you write it: confirm the gap is real against your own inventory (it isn't already shipped) and confirm every operator in the KB. A tight set of well-vetted ideas the synthesizer can trust beats a long list it has to second-guess. Never pad to hit a number.
- **Set Confidence honestly.** High only when the gap is inventory-confirmed and every operator is KB-confirmed; drop to Med/Low (and flag `UNVERIFIED — probe live`) the moment an operator or API is unconfirmed. The synthesizer leads with High-confidence items, so this field carries weight.
- **Grounded, never padding.** Every entry maps to a real file/operator/command and a real user outcome. A thin surface with 6 honest ideas beats 18 with filler.
- **Cite operators.** Name no TD operator without the KB or `search_operators` backing it.
- **Effort is rough.** S ≤1 day · M 2–4 days · L ~1 week, matching the roadmap's legend.
