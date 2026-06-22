---
description: "The tdmcp:// MCP resources an AI client can read — operators, Python API, recipes, GLSL snippets, cheatsheets, learning paths, prompts, live scene digests and more."
---

# MCP resources

Beyond the tools it can *call*, tdmcp exposes a library of **resources** an AI
client can *read* — operator docs, shader snippets, recipes, cheatsheets, a
learning path, even a live snapshot of your running project. Resources are how
the assistant grounds itself in TouchDesigner facts and in tdmcp's own surface
before it builds, instead of guessing.

You rarely address these by hand; a capable client lists and reads them for you.
But knowing the families helps you ask better questions — *"check the operators
resource"*, *"read the GLSL snippet catalog first"* — and explains where the
assistant's knowledge comes from.

::: tip This is the artist-facing map
For the full per-resource reference (every URI template, every parameter), the
[Architecture](/reference/architecture) and
[Tools reference](/reference/tools) pages are the source of truth. This page is
the orientation.
:::

## Knowledge base (always on)

The committed operator knowledge base, exposed as readable resources:

| Family | URI | What it exposes |
| --- | --- | --- |
| Operators | `tdmcp://operators/{name}` | Operator catalog — read a category (TOP, CHOP, SOP, DAT, COMP, MAT, POP) to list, or an operator name for full docs. |
| Python API | `tdmcp://python-api/{class_name}` | TouchDesigner Python class reference — members and methods. |
| Patterns | `tdmcp://patterns/{pattern_name}` | Named operator-chain workflow patterns (recommended wiring). |
| GLSL patterns | `tdmcp://glsl/{pattern_name}` | Named shader techniques with ready-to-use fragment-shader snippets. |
| GLSL snippets | `tdmcp://glsl-snippets` | A vetted, license-clean catalog of embedded GLSL snippets the agent can assemble without guessing IDs. |
| Recipes | `tdmcp://recipes/{recipe_name}`, `tdmcp://recipes/search/{query}` | Pre-validated composite network templates, plus keyword search over built-in and vault recipes. |
| Tutorials | `tdmcp://tutorials/{tutorial_name}` | Long-form TD fundamentals and workflows. |

## Guidance & onboarding (always on)

Compact, KB-grounded guides that help the agent pick the right move:

| Family | URI | What it exposes |
| --- | --- | --- |
| Cheatsheets | `tdmcp://cheatsheets` | Compact reminders for common workflows (operator families, the debug loop, GLSL-TOP assembly, audio binding, vault library), with links to richer resources. |
| Learning path | `tdmcp://learning/touchdesigner` | A curated path pairing the `teach_touchdesigner` prompt with embedded operator and tutorial resources. |
| Cookbook | `tdmcp://cookbook`, `tdmcp://cookbook/{locale}` | The prompt cookbook as a resource, in English (`en`) or Portuguese (`pt`). |

## Surface discovery (always on)

So clients and the local copilot stay in sync with the real registry instead of
drifting:

| Family | URI | What it exposes |
| --- | --- | --- |
| Commands | `tdmcp://commands` | The CLI verbs, generated from the actual dispatcher (safe / mutating / unsafe). |
| Prompts | `tdmcp://prompts` | The MCP prompts tdmcp offers, generated from the prompt registry. |
| Session profile | `tdmcp://session/profile` | Your persistent cross-session profile — see [Session profile & corpus learning](/guide/session-profile). |

## Live project (needs the bridge)

When the [bridge](/guide/install#turn-on-the-bridge) is reachable, two resources
read your running project. They no-op without a TD client and cache briefly (5 s
hot, 1 s offline):

| Family | URI | What it exposes |
| --- | --- | --- |
| Scene summary | `tdmcp://scene/{view}` | A compact snapshot of the running project — `current` (topology + perf + errors), `operators` (full inventory), or `errors` (clustered list). |
| Graph digest | `tdmcp://digest/{path}` | A token-cheap (<500 token) structured digest of a subtree: header, family counts, the primary output's upstream chain, and top grouped errors. |

## Opt-in libraries (off by default)

Registered only when their feature flags are on — see
[Session profile & corpus learning](/guide/session-profile):

| Family | URI | Gate |
| --- | --- | --- |
| Creative RAG | `tdmcp://creative/cards/{id}`, `tdmcp://creative/search` | `TDMCP_RAG_ENABLED=1` |
| Project RAG | `tdmcp://project/cards/{id}`, `tdmcp://project/search`, `tdmcp://project/sources` | `TDMCP_RAG_ENABLED=1` and `TDMCP_PROJECT_RAG_ENABLED=1` |

Both are read-only and carry source URL, license and rights notes on every
result.

## See also

- [Architecture](/reference/architecture) for how resources are registered and
  served.
- [Session profile & corpus learning](/guide/session-profile) for the
  session-profile and RAG resources in depth.
