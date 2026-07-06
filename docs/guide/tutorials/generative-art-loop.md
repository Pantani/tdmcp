---
description: "Build a self-evolving generative art loop in TouchDesigner with tdmcp — a reaction-diffusion system that never settles, with Speed and Palette controls, ready to leave running on a gallery screen."
---

<script setup>
import { withBase } from "vitepress";
</script>

# A generative art loop <Badge type="info" text="Intermediate" />

**Objective** — build a self-evolving visual that has no input and never repeats,
so you can leave it running full-screen on a screen or in a gallery.

**What you'll see** — an organic, breathing pattern that keeps growing, splitting
and shifting colour on its own. It looks alive and never freezes on a single frame.

<video :src="withBase('/examples/tutorial-generative-art-loop.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The Gray-Scott reaction-diffusion loop growing and splitting on its own, never settling on one frame.*

**Before you start**

- tdmcp [installed](/guide/install) and connected to your AI assistant.
- TouchDesigner open, with `bridge running` in the Textport.
- No mic or webcam needed — this visual makes itself.

## Steps

Type each prompt to your AI assistant, one at a time. Wait for each step to finish
before sending the next.

1. Ask for the base system:

   ```text
   Apply the reaction_diffusion recipe and show me a preview.
   ```

   The AI builds a Gray-Scott reaction-diffusion network — a GLSL simulation that
   feeds its last frame back into itself every frame. You'll see the nodes appear,
   wired and arranged, plus a thumbnail of the first frames.

2. Make it evolve slowly so it never settles:

   ```text
   Slow the simulation down so the pattern keeps evolving and never fully settles.
   ```

   The AI nudges the feed and kill rates so the pattern keeps spreading and
   splitting instead of locking into a still image.

3. Add colour movement:

   ```text
   Add slow colour cycling over the pattern so the palette drifts over time.
   ```

   A colour lookup is applied on top of the simulation and animated, so the whole
   piece slowly shifts hue as it runs.

4. Expose controls you can tweak live:

   ```text
   Expose a Speed control and a Palette control I can adjust while it runs.
   ```

   The AI adds two live controls: **Speed** (how fast the pattern evolves) and
   **Palette** (which colours it cycles through). You can move them any time.

5. Make it loop cleanly and preview:

   ```text
   Make it loop smoothly with no visible jump, then show me a preview.
   ```

   Because a reaction-diffusion loop evolves continuously, there is no hard seam —
   the AI confirms the output is stable and returns a fresh preview.

6. Get it running on a screen:

   ```text
   How do I leave this running full-screen on a second display?
   ```

   The AI explains how to open a Perform window and send it to your second monitor
   so the loop fills the screen with no interface visible.

## Expected result

A small network centred on a feedback loop with a GLSL simulation TOP, topped with
an animated colour lookup and a `null` output. In the preview, the pattern keeps
moving — growing, dividing, drifting in colour — and never stops on one frame. Your
**Speed** and **Palette** controls change the look instantly. Sent to a second
display in Perform mode, it fills the screen and can run unattended.

## If it goes wrong

- **The pattern dies out or freezes on a flat frame** — the feed and kill rates
  drifted too far. Ask: *"The reaction-diffusion pattern stopped evolving — nudge
  the parameters back so it keeps growing."*
- **It runs slow or stutters on a low-end GPU** — lower the resolution. Ask:
  *"Lower the simulation resolution so it runs smoothly on my GPU."* See
  [Troubleshooting](/guide/troubleshooting) for more on performance.
- **No preview appears** — the bridge may have dropped. Confirm `bridge running`
  in the Textport, then check [Troubleshooting](/guide/troubleshooting) and the
  [FAQ](/guide/faq).
