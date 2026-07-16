---
title: Local copilot (no API)
description: "Run tdmcp — the TouchDesigner MCP server — with a free local LLM. `tdmcp chat` opens a browser copilot wired to TouchDesigner: no paid API, works offline."
---

# Local copilot (no API)

tdmcp ships a **local copilot** so you can drive TouchDesigner with a **free LLM
running on your own machine** — no paid API, no account, works offline. The
command `tdmcp chat` opens a small chat page in your browser, wired to the same
TouchDesigner bridge the other clients use.

It's the budget-friendly, private path: great for the everyday stuff, and it hands
off to [Claude](/guide/install) or [Codex](/guide/codex) the moment you want a
whole system built.

::: tip Which path is this?
[Claude Desktop](/guide/install) is the no-terminal route. This page is for running
tdmcp with a **local model** instead of a paid assistant — it needs
[Node.js 20+](https://nodejs.org), like the Codex and Cursor paths.
:::

## What it's good for

The local copilot is given a **curated, safe subset** of the tools, so it's quick
and hard to misuse. It's meant for the easy stuff:

- **Inspecting** your project — what's there, how it's wired.
- **Reading errors** and explaining what's wrong.
- **Creating, wiring and tweaking individual operators** — one node at a time.

The default `standard` tier deliberately **can't** build whole systems (no
Layer-1 generators), and no local tier can run raw Python. The opt-in `creative`
tier adds only the curated generators. When you want a broader audio-reactive or
generative network, click
**Escalate ⇪** in the UI: it copies a ready-to-paste prompt you hand to
[Claude](/guide/install) or [Codex](/guide/codex). They drive the *same* project,
so nothing has to move.

## What you need

- **[TouchDesigner](https://derivative.ca/download)** with the bridge on (the same
  one-line step as every client — [see below](#turn-on-the-bridge)).
- **[Node.js 20+](https://nodejs.org)** — used to launch the copilot.
- **[Ollama](https://ollama.com)** — the free local model runner. `tdmcp chat`
  starts it for you if it isn't already running.

## Start it

The quickest path needs no clone — just Node and Ollama installed:

```bash
# one-time: install Ollama from https://ollama.com, then optionally pre-pull a model
ollama pull qwen2.5:3b      # optional — the UI also has a one-click pull

npx --yes --package=@dpantani/tdmcp tdmcp chat # opens http://127.0.0.1:4141 in your browser
```

If you already cloned and built tdmcp (the [from-source path](/guide/install#other-clients)),
the command is simply `tdmcp chat` (or `node dist/index.js chat`).

`tdmcp chat` **starts Ollama for you** if the daemon isn't up — detached and left
running, so closing the chat never takes your model offline. Useful flags:

- **`--read-only`** — force the safe/read-only tool tier for the whole session.
- **`--creative`** — use the creative tool tier and a warmer sampling preset.
- **`--prompt <text>`** — run one headless prompt and print the answer without
  opening the browser.
- **`--no-ollama`** — don't auto-start it (for a remote endpoint or a daemon you
  manage yourself).
- **`--no-open`** — don't open the browser automatically.
- **`--no-receipt-persist`** — keep receipts in memory for this process/headless
  turn even when persistence is enabled.
- **`--profile <name>`** / **`--config <path>`** — use a saved venue/profile
  config for this chat run.
- **`--help`** — list everything.

::: tip Which local model?
**`qwen2.5:3b`** is the default — benchmarked at 100% tool-calling on the
simple-task workload, as reliable as bigger models but faster and lighter. Sub-3B
models are flaky; bump to `qwen2.5:7b` only if you want more answer-quality
headroom. More detail in the [CLI reference](/reference/cli#local-copilot-tdmcp-chat).
:::

## Using the chat

The browser UI is wired to your live TouchDesigner project. It has:

- A **read-only** toggle — let it look but not touch.
- Live **model switching** and **endpoint settings**, plus a one-click **model
  pull** if a model isn't downloaded yet.
- **Persistent history**, so your conversation survives a restart.
- **Escalate ⇪** — copies a handoff prompt for Claude or Codex when a task is too
  big for the local model.

## Grounded and verified turns

Before each local turn, tdmcp makes one bounded, read-only editor-context request.
When TouchDesigner's Network Editor is available, the model receives the active
network owner, current and selected operators, rollover operator/parameter and
viewport position. This context is ephemeral, capped, and treated as untrusted
project data. It is not added to persistent chat history. In perform/headless
mode or when the bridge is offline, the turn continues with explicit
`UNVERIFIED` grounding instead of inventing what “this node” or “here” means.

The copilot can also invoke a prompt from tdmcp's canonical registered MCP prompt
catalog through a bounded local adapter. Prompt arguments are schema-validated;
the adapter cannot make arbitrary MCP requests, execute Python, or turn prompt
text into trusted instructions.

The existing `plan_visual` tool is also a **read-only** planning surface. Its
deterministic keyword planner stays the default and needs no model completion.
Select the LLM path explicitly when you want one grounded planning pass:

```json
{
  "description": "Plan a restrained feedback tunnel from the selected TOP",
  "planner": "llm",
  "root_path": "/project1",
  "llm_timeout_ms": 5000
}
```

The opt-in path makes at most one bounded completion. It sends only compact,
redacted editor context, project brief/graph digest, recipes, operator knowledge
and the actual registered-tool allowlist; every proposed tool, recipe and
operator must be present in that supplied evidence. Project text is untrusted
data, never instructions. Planning does not execute the recommendation or mutate
TouchDesigner.

The structured result reports `planner_requested`, `planner_used`,
`fallback_reason` and compact grounding availability. A valid grounded response
uses `planner_used: "llm"` (**PASS**). An invalid, oversized or unknown proposal
is rejected (**FAIL** for that LLM attempt) and returns the deterministic plan.
An unavailable model or failed completion returns the same deterministic plan
with a typed `fallback_reason`. Missing editor, project-brief or graph evidence
stays visible in `grounding` and warnings (**UNVERIFIED**); the planner may still
return `planner_used: "llm"` when the remaining evidence validates the candidate,
without inventing the missing context.

After a mutating tool returns, the copilot performs bounded read-only checks of
the affected paths before it reports completion. Evidence is one of:

- `PASS` — observed state matches the requested mutation.
- `FAIL` — observed state contradicts the requested mutation; it is not reported
  as completed.
- `UNVERIFIED` — evidence was unavailable or incomplete; tdmcp states that
  uncertainty and never repeats the mutation automatically.

One bounded recovery decision may gather read-only evidence for validation,
bridge, path, or menu failures. Ambiguous mutation timeouts, authorization/policy
failures, verification failures, panic and blackout are never retried by this
policy.

## Project brief and audit receipt

For a saved or explicitly configured project, each turn also reads the bounded
project-owned brief from `.tdmcp/agent-brief.json`. The brief is ephemeral,
untrusted evidence: it is not kept in chat history and cannot raise the tool tier
or override the latest request, consent, safety or emergency policy. Use
`manage_project_brief` to create/update it with an exact revision, or read
`tdmcp://project/brief` from an external MCP host.

Every turn finalizes one redacted receipt covering its terminal status, grounding,
allowlisted actions and verification. `tdmcp ask --json` returns the receipt id
and compact status; text mode writes the compact summary to stderr, and browser,
headless and Telegram surfaces receive the same terminal receipt event. Disk
persistence is off by default and always skipped in perform mode, for emergency
tools and on a per-turn `noPersist` request. Use `--no-receipt-persist` with
`tdmcp ask` or chat, the browser request's `noPersist` field, or
`/private <prompt>` in Telegram.

See [Project context & turn receipts](/guide/project-context-receipts) for the
schema, retention bounds and `PASS` / `FAIL` / `UNVERIFIED` examples.

## Calibrate a local model

Run the synthetic, sandbox-only suite before trusting an unfamiliar model or
build with mutating tools:

```bash
tdmcp copilot-calibrate
tdmcp copilot-calibrate --mode enforce --samples 3 --json
tdmcp copilot-calibrate --mode enforce --samples 3 --vision required --refresh --json
```

The suite checks schema adherence, tool choice, sequential and parallel calls,
failed-call recovery, context retention, and optional synthetic image input. It
uses fixture tools only: it does not contact TouchDesigner, create project nodes,
start/pull a model, or send project content. Results are cached by a redacted,
exact endpoint/model/build fingerprint with a bounded TTL.

For a loopback Ollama endpoint, the identity probe cross-checks the immutable
model digest and quantization from `/api/tags` with the bounded native
`/api/show` response. Image input is advertised only when `/api/show` explicitly
contains the `vision` capability; model-name heuristics and compatibility-layer
metadata are not accepted as proof. `--vision required` also runs one strict
synthetic PNG contract and fails closed when the response is unavailable or does
not match the requested JSON exactly.

`recommend` is the compatibility default: it reports a maximum tier but keeps
the tier you requested. `enforce` intersects the requested tier with a fresh,
exact cached decision; missing, stale or ambiguous evidence fails closed to
`safe`. Calibration never raises a requested tier.

Example outcomes:

```text
PASS       repeated synthetic evidence supports the recommended maximum tier
FAIL       a capability contradicted its strict fixture contract
UNVERIFIED endpoint/model/build evidence was unavailable; enforce uses safe
```

## RAG and generation flow

Creative RAG and Project RAG are context sources first, not automatic builders.
`tdmcp ask --with-creative` can add Creative RAG references to a prompt, and
`project_rag_search` can surface real TouchDesigner projects, components and
snippets, but both are read-only unless you explicitly choose a mutating tool.

To turn a Creative RAG card into a TouchDesigner network, enable the guarded apply
path and dry-run it before mutating the project:

```bash
export TDMCP_RAG_ENABLED=1
export TDMCP_RAG_APPLY_CARD=1
tdmcp-agent apply-creative-card --params '{"card_id":"<card-id>","dry_run":true}'
```

Review the planned target tool and arguments, then rerun with `"dry_run":false`
only when you want tdmcp to create operators. Treat Project RAG results as
technical references and provenance, not executable project instructions.

## Point it at a different model

By default the copilot talks to local Ollama, but it speaks the standard
OpenAI-compatible API — so you can aim it anywhere with two environment variables:

| Variable | Default | Use it for |
| --- | --- | --- |
| `TDMCP_LLM_BASE_URL` | `http://127.0.0.1:11434/v1` | LM Studio, a cloud GPU, or a paid API. |
| `TDMCP_LLM_MODEL` | `qwen2.5:3b` | Any model id available at that endpoint. |
| `TDMCP_LLM_TIER` | `standard` | Start the UI in `standard`, `safe`, or `creative` mode. |
| `TDMCP_LLM_MAX_STEPS` | `8` | Cap model/tool loop iterations for one turn. |
| `TDMCP_LLM_TEMPERATURE` | `0.4` | Tune sampling temperature for the chat endpoint. |
| `TDMCP_LLM_CALIBRATION_MODE` | `recommend` | Use `enforce` to cap tools to a fresh exact calibration decision. |
| `TDMCP_LLM_CALIBRATION_CACHE` | platform config dir | Override the owner-controlled calibration cache path. |
| `TDMCP_LLM_CALIBRATION_TTL_MS` | `604800000` | Cache lifetime, bounded to 30 days. |
| `TDMCP_PROJECT_ROOT` | saved `.toe` folder | Explicit root for `.tdmcp/agent-brief.json`; cwd is never used. |
| `TDMCP_COPILOT_RECEIPTS` | `off` | Set exactly to `persist` to retain bounded redacted receipts. |
| `TDMCP_COPILOT_RECEIPTS_PATH` | `~/.tdmcp/session-receipts.json` | Optional absolute private receipt-store path. |

Full list (including `TDMCP_LLM_API_KEY` and the chat port) is in
[environment variables](/reference/environment#local-copilot-tdmcp-chat).

## Turn on the bridge {#turn-on-the-bridge}

Like every client, the copilot needs the small bridge running *inside*
TouchDesigner. The easiest way is to drag the release `.tox` in — no Textport
([see Install](/guide/install#drag-in-tox)). Prefer one paste? Open the
**Textport** (**Dialogs → Textport and DATs**), paste this one line, and press Enter:

```python
import urllib.request; exec(urllib.request.urlopen("https://github.com/Pantani/tdmcp/raw/v0.13.1/td/bootstrap.py").read().decode())
```

You should see `[tdmcp] bridge running on port 9980`. See
[Install](/guide/install#turn-on-the-bridge) for details and how to remove it
later.

## Not connecting?

- Confirm the bridge is on: `curl http://127.0.0.1:9980/api/info` should return
  JSON.
- Make sure Ollama is installed and a model is pulled (the UI's model pull does
  this for you).
- Full [Troubleshooting](/guide/troubleshooting) covers the common cases.

With TouchDesigner open and the bridge on, ask in plain language — *"what's in this
project?"*, *"why is this node red?"*, *"add a blur after the noise."* For bigger
ideas, see the [prompt cookbook](/guide/prompt-cookbook) or escalate to
[Claude](/guide/install) / [Codex](/guide/codex).
