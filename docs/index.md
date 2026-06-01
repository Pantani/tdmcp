---
layout: home
title: tdmcp — TouchDesigner MCP server
titleTemplate: false
description: "The TouchDesigner MCP server. Connect Claude, Cursor, or Codex to TouchDesigner and build real visual systems from plain language — it uses real operators and previews its own work."

hero:
  name: tdmcp
  text: The TouchDesigner MCP server
  tagline: Stop wiring nodes by hand. Describe a visual to Claude, Cursor or Codex and it builds a real, playable network inside TouchDesigner — audio-reactive, generative, particle and 3D systems with live controls — checking and previewing its own work.
  actions:
    - theme: brand
      text: I'm an artist — start here
      link: /guide/what-is-tdmcp
    - theme: alt
      text: Developer reference
      link: /reference/architecture
    - theme: alt
      text: 🇧🇷 Ler em português
      link: /pt/

features:
  - title: Describe it, don't wire it
    details: "\"Create a feedback tunnel from noise with blur and displace, then add bloom and output it to a window\" — and the nodes appear, wired up, in your project."
  - title: Real operators, not guesses
    details: An embedded reference of 629 operators, 68 Python classes, workflow patterns and GLSL techniques means the AI uses real TouchDesigner operators instead of inventing them.
  - title: Sees and fixes its own work
    details: A bridge inside TouchDesigner creates, connects, inspects and previews nodes in a create → verify → preview loop, and auto-arranges every network into a readable layout.
  - title: Built for live performance
    details: Audio-reactive, generative and particle systems arrive playable — with control panels, presets, cues, tempo sync, MIDI/OSC/DMX I/O and a phone remote.
  - title: Works offline-friendly
    details: A local LLM copilot (tdmcp chat) handles simple tasks without a paid API, and the server stays usable even when TouchDesigner is closed.
  - title: 269 tools, three layers
    details: From one-line artist generators down to atomic node CRUD, library packaging, vault workflows and Python escape hatches — see the full, always-current Tools reference.
---

## Two ways in

**🎛️ I make visuals.** You don't need to code. Start with [What is tdmcp?](/guide/what-is-tdmcp),
do the [one-click install](/guide/install), then [make your first visual](/guide/first-visual).
Prefer Portuguese? [Comece por aqui »](/pt/)

**🛠️ I'm a developer.** Jump to the [architecture overview](/reference/architecture), the
auto-generated [tools reference](/reference/tools), or wire it into your client and read the
[bridge & REST API](/reference/bridge-api).
