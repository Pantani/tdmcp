---
description: "Turn a webcam into an interactive installation with tdmcp — movement in front of the camera drives glowing particle trails you can perform and project."
level: intermediate
---

# A camera-interactive installation <Badge type="info" text="Intermediate" />

**Objective** — build a webcam installation where a viewer's movement spawns glowing
particle trails, ready to project onto a wall.

**What you'll see** — a dark, moody field of particles that light up and trail
wherever motion happens in front of the camera. Stand still and it calms; move and
the room paints itself.

::: tip Live result
This one is best seen live — the look depends entirely on real movement in front of
your camera, so a canned clip wouldn't represent what you'll build. Follow the steps
with your own webcam (or the synthetic test source) and use **"show me a preview"** at
any point to see your result.
:::

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

   → You get a network with two branches: an optical-flow field reading motion from
   the camera, and a particle render. The recipe leaves them **unconnected on
   purpose** — wiring the flow into the particles is the next step.

3. Wire the flow into the particles so they follow movement:

   ```text
   Wire the optical flow output (flow_out) into the particle simulation, so particles spawn and drift where movement happens and motion in front of the camera paints them.
   ```

   → The flow field now pushes the particles — moving in front of the camera stirs
   them. Until this step, the particles move on their own, independent of the
   camera.

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
