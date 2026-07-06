---
description: "Turn a webcam into an interactive installation with tdmcp — movement in front of the camera drives glowing particle trails you can perform and project."
level: intermediate
---

<script setup>
import { withBase } from "vitepress";
</script>

# A camera-interactive installation <Badge type="info" text="Intermediate" />

**Objective** — build a webcam installation where a viewer's movement spawns glowing
particle trails, ready to project onto a wall.

**What you'll see** — a dark, moody field of particles that light up and trail
wherever motion happens in front of the camera. Stand still and it calms; move and
the room paints itself.

<video :src="withBase('/examples/tutorial-camera-interactive-installation.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The optical-flow particle field driven by a moving test clip — with your webcam, the
particles churn wherever people move. Captured live from the recipe's own output.*

**Before you start**

- [tdmcp installed](/guide/install) for your AI client.
- The [TouchDesigner bridge step](/guide/install) done, and `bridge running` in
  TouchDesigner's Textport.
- A webcam. No webcam handy? Every prompt below can use a **synthetic test source**
  instead, so you can build and rehearse the whole look offline.

::: tip No Kinect required
This uses a plain webcam and optical flow (motion detection). For depth cameras and
full-body pose, see [MediaPipe adapters](/guide/mediapipe-adapters) and
[Physical installations](/guide/physical-installations).
:::

## Steps

Copy each prompt into your AI client, one at a time. Wait for each to finish before
sending the next.

1. Confirm TouchDesigner is connected and see your webcam:

   ```text
   Check TouchDesigner is connected, then show me my webcam source. If no camera is available, use a synthetic test source instead.
   ```

   → The AI confirms the bridge is live and brings up a camera (or test) image.

2. Build the motion-reactive base from the recipe:

   ```text
   Apply the optical_flow_particles recipe, driven by my webcam. Use the bundled test clip if my camera is not ready.
   ```

   → You get a network that reads motion from the camera as an optical-flow field
   feeding a particle render.

3. Make the particles follow movement:

   ```text
   Make the particles spawn and drift where movement happens, so motion in front of the camera paints the particles.
   ```

   → The flow field now pushes the particles — moving in front of the camera stirs
   them.

4. Set the installation mood:

   ```text
   Add trails to the particles and give it a dark, moody palette — deep blues and violet on near-black.
   ```

   → Particles leave glowing trails and the scene reads as a gallery piece, not a
   technical demo.

5. Expose the two controls you'll actually perform:

   ```text
   Expose a Flow-sensitivity control and a Trail-length control so I can tune how reactive and how smeary it is.
   ```

   → Two live knobs appear. Flow-sensitivity sets how easily motion triggers
   particles; Trail-length sets how long the trails linger.

6. Preview and take it fullscreen for the installation:

   ```text
   Show me a preview. Then tell me how to send this output fullscreen to my projector or second display for the installation.
   ```

   → You see the result, plus steps to route the output to a projector.

## Expected result

A left-to-right network: **camera → optical-flow field → particle render → output**,
with a preview showing dark particles that ignite into glowing trails wherever
someone moves. Flow-sensitivity and Trail-length are exposed as live knobs. Sending
the output fullscreen turns any wall into the piece.

## If it goes wrong

- **Webcam not found / black image** → ask for a synthetic test source, then swap
  the camera back in later. On macOS, grant camera access — see the
  [camera permission note](/guide/troubleshooting#macos-microphone-camera-permission).
- **Too noisy — particles fire constantly** → lower Flow-sensitivity, or say *"only
  react to bigger movements."*
- **Nothing reacts** → raise Flow-sensitivity, and make sure there's enough light and
  actual movement in frame.
- **Projector / fullscreen setup** → see
  [Physical installations](/guide/physical-installations) for reliable projector,
  calibration and room-sensor workflows.
- **Still stuck?** → [Troubleshooting](/guide/troubleshooting) and the
  [FAQ](/guide/faq).
