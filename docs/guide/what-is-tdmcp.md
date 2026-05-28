---
description: "tdmcp is the TouchDesigner MCP server — an AI assistant builds real TouchDesigner networks from your plain-language description, then checks and previews them."
---

# What is tdmcp?

**tdmcp lets you build visuals in [TouchDesigner](https://derivative.ca) just by
describing them to an AI assistant.** You type what you want in plain language;
the AI builds the actual network of nodes inside your project, checks it for
errors, and shows you a preview.

> *"Create a feedback tunnel from noise with blur and displace, then add bloom and
> output it to a window."*

…and the nodes appear, wired up, in your project — ready to tweak and perform.

You don't need to know how to code, and you don't need to know which TouchDesigner
operators to use. That's the AI's job. You stay in the role you care about:
**directing the look and the feel.**

## Who it's for

- **VJs and live performers** who want to spin up audio-reactive, generative or
  particle systems fast — already playable, with knobs to tweak live.
- **Visual artists and installation makers** who'd rather describe an idea than
  wire a hundred nodes by hand.
- **Anyone learning TouchDesigner** who wants a working, correct network to learn
  from and pull apart.

If you *are* a developer and want the internals, head to the
[developer reference](/reference/architecture).

## Why it works

Most "AI builds your project" tools guess. tdmcp doesn't, because it pairs two
things:

- **Real knowledge.** It carries a built-in reference of TouchDesigner's actual
  operators, so the AI uses real nodes instead of inventing ones that don't exist.
- **Real execution.** A small **bridge** runs inside TouchDesigner and actually
  creates, connects and previews nodes — so the AI can *see* its own work, catch
  mistakes, and fix them before handing it back to you. Every network it builds is
  tidied into a clean left-to-right layout instead of a tangle.

## What you'll need

- **[TouchDesigner](https://derivative.ca/download)** — the free non-commercial
  edition is fine.
- An AI assistant that supports it: **Claude Desktop** (easiest — no terminal),
  Claude Code, Codex, or Cursor. No paid API? tdmcp also ships a free
  [local copilot](/guide/local-copilot) that runs a model on your own machine.

## Next steps

1. [Install it (Claude Desktop)](/guide/install) — about 3 minutes, no terminal.
2. [Make your first visual](/guide/first-visual).
3. Keep a [prompt cookbook](/guide/prompt-cookbook) and the
   [recipe gallery](/guide/recipes) handy for ideas.

::: tip Português
Esta documentação também está disponível em português — [comece por aqui](/pt/).
:::
