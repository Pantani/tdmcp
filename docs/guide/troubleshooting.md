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

Both the `.dxt` download and the one-line bridge installer need to reach the
internet (GitHub).

- **Reconnect to the internet** and try again.
- **Download link 404s?** A release may not be published yet — ask whoever shared
  tdmcp for the `tdmcp.dxt` file directly and
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

## Still stuck?

Open an issue at [github.com/Pantani/tdmcp/issues](https://github.com/Pantani/tdmcp/issues).
Developers: the [reference docs](/reference/architecture) cover deeper diagnostics.
