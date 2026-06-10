---
description: "Fix common tdmcp setup issues — connect the TouchDesigner MCP server and the bridge, and get your AI client talking to TouchDesigner."
---

# Troubleshooting

Most problems are one of a handful of things. Find what you're seeing below.

## "TouchDesigner isn't reachable"

The AI can't find the bridge. Check, in order:

1. **Is TouchDesigner open?** It needs to be running.
2. **Did you turn on the bridge?** In TouchDesigner's Textport you should have seen
   `[tdmcp] bridge running on port 9980`. If not, redo
   [step 3 of the install](/guide/install#turn-on-the-bridge).
3. **Quick test:** open a terminal and run
   `curl http://127.0.0.1:9980/api/info` — it should return some JSON. If it does,
   the bridge is fine and the issue is on the AI-client side (next item).

## The AI doesn't list any tdmcp tools

The client didn't load the server.

- **Restart your AI client** after installing/enabling the extension. This is the
  most common fix — the tools only appear after a restart.
- On Claude Desktop, confirm the "TouchDesigner (tdmcp)" extension is **enabled**
  in **Settings → Extensions**.

## The local copilot says "LLM offline"

`tdmcp chat` talks to a local LLM (Ollama by default). If the header shows
**LLM offline** or messages fail with *fetch failed*:

1. **Restart `tdmcp chat`** (Ctrl-C, run it again). It **auto-starts Ollama** for
   you — so a fresh launch brings the daemon back up if it had stopped.
2. **Is Ollama installed?** It must be on your PATH — get it at
   [ollama.com](https://ollama.com). (Homebrew's Ollama isn't a persistent daemon
   and can stop between sessions; `tdmcp chat` starting it for you covers that.)
3. **Model not pulled?** If the status says *model not pulled*, click **Pull** in
   the UI or run `ollama pull qwen2.5:3b`.
4. **Started with `--no-ollama`?** Then start the daemon yourself: `ollama serve`.
5. **Using a remote / cloud endpoint?** Check `TDMCP_LLM_BASE_URL` and
   `TDMCP_LLM_API_KEY` in your [environment](/reference/environment).

## macOS microphone & camera permission {#macos-microphone-camera-permission}

The **first time** a visual uses your microphone (audio-reactive) or camera
(webcam), macOS shows a permission dialog.

- **Click Allow.** Until you respond, TouchDesigner can look **frozen** (it's
  waiting on the popup, sometimes with high CPU). That's expected — it isn't a
  crash.
- If you accidentally clicked **Deny**, fix it in
  **System Settings → Privacy & Security → Microphone** (or **Camera**), enable
  TouchDesigner, and restart it.
- **Don't want the popup while testing?** Ask for a **test tone** source instead of
  the microphone: *"use a test oscillator instead of the mic."*

## The download / Textport line shows a network error

Both the `.mcpb` download and the one-line bridge installer need to reach the
internet (GitHub).

- **Reconnect to the internet** and try again.
- **Download link 404s?** A release may not be published yet — ask whoever shared
  tdmcp for the `tdmcp.mcpb` file directly and
  [install from the file](/guide/install#install-from-file).

## "Port 9980 is already taken"

Something else is using that port. Use a different one in **both** places:

- In TouchDesigner: `from mcp import install; install.run(port=9981)`
- In your AI client's settings: set the TouchDesigner **port** to `9981` (or the
  `TDMCP_TD_PORT` [environment variable](/reference/environment)).

## A visual built, but looks off

The audio / particle / 3D builders and the more exotic recipes use best-effort
parameter names and may need a nudge. Just say what's wrong:

- *"The particles aren't moving — check it for errors and fix them."*
- *"Explain what this network does so I can see what's missing."*

## It runs slowly

> *"This is running slow — find the bottleneck and lower the resolution where it
> won't hurt."*

The AI can measure cook times and optimize the heaviest parts.

## TDAbleton Mapper is not moving Ableton

For the MediaPipe hands to Auto Filter flow, AbletonMCP is not part of the runtime
path. The path is TouchDesigner MediaPipe hands -> TDAbleton `TDA_Mapper` ->
Ableton mapped parameter.

Check, in order:

1. TouchDesigner is playing; MediaPipe capture does not update while the timeline
   is paused.
2. The hand adapter CHOP has non-zero `confidence` and `handedness`.
3. `/project1/hand_ableton_mapper/mapper_send` has moving `map1`, `map2`, `map3`,
   and `map4` channels.
4. Left hand moves `map1`/`map3`; right hand moves `map2`/`map4`.
5. The active `TDA_Mapper` path is the real track/device target, not a stale
   mapper from another track.
6. `Oscinputchop` points at `mapper_send`, `Reorder` is `map1 map2 map3 map4`,
   `Bypass1..4` are off, and `Min/Max1..4` are `0..1`.
7. The four TDAbleton mapper slots are manually mapped to Auto Filter or rack macro
   parameters in Ableton.

Run `diagnose_tdableton_mapper` to inspect the mapper state from TouchDesigner and
use `repair:true` only when you want tdmcp to restore the input CHOP, reorder,
bypass, and range parameters.

## Still stuck?

Open an issue at [github.com/Pantani/tdmcp/issues](https://github.com/Pantani/tdmcp/issues).
Developers: the [reference docs](/reference/architecture) cover deeper diagnostics.
