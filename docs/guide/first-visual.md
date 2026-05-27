---
description: "Make your first visual with tdmcp, the TouchDesigner MCP server — ask in plain language and watch the node network build, verify and preview itself."
---

# Your first visual

You've [installed tdmcp](/guide/install) and seen `bridge running` in
TouchDesigner's Textport. Now let's make something.

## 1. Ask for it

In your AI assistant, type a description of what you want. Try this:

> *"Create a feedback tunnel from noise with blur and displace, add bloom, and
> show me a preview."*

The AI will build the network in your TouchDesigner project, check it for errors,
and show you a thumbnail of the result. Switch to TouchDesigner and you'll see the
nodes appear, wired up and neatly arranged.

::: tip Confirm the bridge first
If it's your first prompt of the session, the AI may run a quick health check
(`get_td_info`) to make sure TouchDesigner is reachable. If it says it can't
reach TouchDesigner, see [Troubleshooting](/guide/troubleshooting).
:::

## 2. Iterate in plain language

You don't start over — you just say what to change:

- *"Make it warmer."*
- *"Add a feedback trail."*
- *"Slow the movement down."*
- *"More contrast, and push the blur."*
- *"Add a subtle glitch."*

Each request adjusts the existing network. Preview again whenever you want to see
where you are: *"show me a preview."*

## 3. Make it react to sound

> *"Make an audio-reactive particle galaxy that responds to my music, and show me
> a preview."*

::: warning macOS: microphone permission
The first time a visual listens to your microphone, macOS pops up a permission
dialog. **Click Allow** — until you do, TouchDesigner may appear frozen. If you'd
rather not use the mic while testing, ask for a *test tone* source instead. Full
details in [Troubleshooting](/guide/troubleshooting#macos-microphone-camera-permission).
:::

Many systems arrive **already playable** — they come with a little control panel
(a Feedback knob, a Sensitivity knob, particle Drag/Turbulence/Gravity, an
evolution Speed) you can grab and tweak live in TouchDesigner.

## 4. Show it full-screen

When you like it:

> *"Output it to a full-screen window on my second monitor."*

You can also ask to record it, send it over NDI/Syphon to other software, or map
it onto a projector. See the [prompt cookbook](/guide/prompt-cookbook) for more.

## 5. Save your look

- *"Save these control settings as a preset called 'opening'."*
- *"Save this whole network as a reusable recipe."*

## Where to go next

- [Prompt cookbook](/guide/prompt-cookbook) — ready-made prompts grouped by what
  you want to make.
- [Recipe gallery](/guide/recipes) — pre-built systems you can ask for by name.
- [Glossary](/guide/glossary) — plain-language definitions of the TouchDesigner
  words you'll hear.
