# Wave 3: network template gap review

Status: `quarantined-no-new-feature`

Date: 2026-06-24

## Decision

Do not implement a Bottobot-style `get_network_template` tool as a new tdmcp
feature in this campaign.

The Bottobot tool is a static catalog of five text templates:

- `video-player`
- `generative-art`
- `audio-reactive`
- `data-visualization`
- `live-performance`

Each template contains operators, port-level connections, parameter notes,
optional Python snippets, and setup tips. It does not validate operator names
against the imported knowledge base, does not emit `RecipeSchema`, and does not
apply or verify a network in TouchDesigner.

tdmcp already covers the same user intent with stronger local surfaces:

| Bottobot template | tdmcp coverage |
| --- | --- |
| `video-player` | `suggest_operator_chain`, `validate_operator_chain`, `draft_recipe_from_operator_chain`, and video/media recipes or Layer 1 generators as applicable |
| `generative-art` | `create_feedback_tunnel`, `create_feedback_network`, `create_generative_art`, `feedback_tunnel`, `performable_feedback_tunnel`, `noise_landscape`, `reaction_diffusion` |
| `audio-reactive` | `create_audio_reactive`, `create_3d_audio_reactive`, `extract_audio_features`, `bind_audio_reactive`, `audio_reactive_basic`, `audio_spectrum_bars` |
| `data-visualization` | `create_data_visualization`, `create_data_source`, `data_sonification`, operator-chain draft/validation |
| `live-performance` | `create_stage_dashboard`, `create_panic`, cue/preset tools, scene timeline recipes, AI Party safety flows |

## Evidence

- Bottobot source: `/tmp/bottobot-touchdesigner-mcp-server-20260624/tools/get_network_template.js`.
- Installed Bottobot package source:
  `node_modules/@bottobot/td-mcp/tools/get_network_template.js`.
- Bottobot `handler()` only resolves a name/alias and renders Markdown text.
- Bottobot data source is the in-module hard-coded `TEMPLATES` object, not the
  imported `patterns.json`/operator/tutorial knowledge data.
- Current tdmcp built-in recipes are validated by `RecipeSchema` at load time in
  `src/recipes/loader.ts`.
- Current tdmcp docs already describe recipes as validated network templates in
  `docs/reference/tools.md`.
- Current tdmcp tool surface includes read-only chain suggestion, chain
  validation, `RecipeSchema` draft generation from operator chains, and
  tutorial-to-recipe drafting.

## Quarantine Criteria

Reopen only if a future source provides one of these non-duplicative assets:

- A materially new network topology not covered by first-party recipes/builders.
- A structured template dataset that can be converted into validated
  `RecipeSchema` with RED tests.
- Live-verified Python callback snippets that are safer or more complete than
  existing tdmcp builders.

Until then, adding `get_network_template` would create a parallel, less verified
catalog and increase command-surface ambiguity.

Optional future extension: add docs-only aliases/cards that map Bottobot-style
template names (`video-player`, `generative-art`, `audio-reactive`,
`data-visualization`, `live-performance`) to existing tdmcp tools and recipes.
That should remain documentation unless backed by new validated template assets.

Live TouchDesigner validation: `UNVERIFIED-pending-td`.
