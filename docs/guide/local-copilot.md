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

It deliberately **can't** build whole systems (no Layer-1 generators) and **can't
run raw Python**. When you want a full audio-reactive or generative network, click
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

npx -y @dpantani/tdmcp chat # opens http://127.0.0.1:4141 in your browser
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

Full list (including `TDMCP_LLM_API_KEY` and the chat port) is in
[environment variables](/reference/environment#local-copilot-tdmcp-chat).

## Turn on the bridge {#turn-on-the-bridge}

Like every client, the copilot needs the small bridge running *inside*
TouchDesigner. Open the **Textport** (**Dialogs → Textport and DATs**), paste this
one line, and press Enter:

```python
import urllib.request; exec(urllib.request.urlopen("https://github.com/Pantani/tdmcp/raw/main/td/bootstrap.py").read().decode())
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
