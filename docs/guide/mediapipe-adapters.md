---
description: "Wire MediaPipe face, hand, body and segmentation tracking into TouchDesigner with tdmcp — adapter tools that load the free torinmb plugin and hand you clean, canonical CHOPs and mattes."
---

# MediaPipe adapters

The body-tracking guide shows how to *use* a tracked body. This page is about the
layer underneath: the **adapter tools** that load the free
[torinmb/mediapipe-touchdesigner](https://github.com/torinmb/mediapipe-touchdesigner)
plugin, switch on the pipeline you want, find the engine's output, and hand you a
clean, canonical CHOP or matte you can wire into anything.

Reach for an adapter when you want face / hand / body / segmentation data as a
stable signal — landmarks in TD coordinates, a person matte, screen-space points
for UI — rather than a finished visual.

## Get the plugin

The plugin is MIT-licensed and runs on macOS and Windows from an ordinary
webcam. tdmcp's package manager can stage it for you:

```bash
npx --yes --package=@dpantani/tdmcp tdmcp install mediapipe-touchdesigner
```

This grabs the MIT release and extracts it under `~/.tdmcp/packages`; the
adapters resolve the staged path automatically (with legacy and manual fallbacks).
See [Body & pose tracking](/guide/body-tracking) for the camera-permission and
first-run details.

::: tip Timeline must be playing
The plugin's embedded browser only captures while the TD timeline plays. If the
data reads zero, press Play.
:::

## The adapters

Each adapter loads the engine (idempotent — it reuses an existing one), toggles
the pipeline you ask for, and builds a small wrapper COMP whose Script CHOP/TOP
reads the engine's JSON output and republishes it as a canonical signal. They
probe the engine's output names across plugin versions, so they keep working as
the plugin evolves.

| Adapter | Layer | What it wires up | Output |
| --- | --- | --- | --- |
| **`setup_body_tracking`** | 1 | Pose pipeline → a canonical pose CHOP; optionally builds a skeleton visual. | 33-landmark pose CHOP (`tx`/`ty`/`tz`/confidence), hip-centred |
| **`setup_face_tracking`** | 2 | Face-mesh pipeline → a canonical face CHOP. | 468 (or 478 with iris) landmark CHOP, nose-centred |
| **`setup_hand_tracking`** | 2 | Hand pipeline → a canonical hand CHOP, in world or image space. | `max_hands` × 21-landmark CHOP, with handedness and screen-space channels |
| **`setup_segmentation`** | 2 | Selfie-segmentation pipeline → a feathered mask TOP, optionally a pre-keyed RGBA. | mask TOP (+ optional `person_rgba` for drop-in compositing) |
| **`setup_mediapipe_plugin`** | 1 | Loads the engine **once** and toggles Face/Hand/Body/Segmentation together; discovers and exports each pipeline's output path. | the engine's discovered DAT/TOP paths |

> *"Set up hand tracking in world space for up to two hands."*
> *"Set up segmentation with a 12-px feather and publish a pre-keyed person
> matte."*

Use `setup_mediapipe_plugin` when you want several pipelines from one engine in a
single call; use the individual `setup_*` adapters when you want exactly one
modality and its canonical wrapper.

## From adapter to art

Adapters produce signals; the `create_*` tools consume them. Point a consumer's
source at the adapter's output CHOP/TOP and the rest of the network behaves
exactly as it does in synthetic mode:

- **Pose** → `create_pose_tracking`, `create_pose_skeleton`,
  `create_body_reactive` (see [Body & pose tracking](/guide/body-tracking)).
- **Hands** → `create_hand_gesture_bus` (publishes stable gesture channels) →
  `create_hand_hologram`, `create_hand_ableton_mapper`.
- **Segmentation** → feed the mask or `person_rgba` into any compositing chain.

## Ready-made recipes

Three browsable templates ship in the [recipe gallery](/guide/recipes) — say
*"list recipes"*:

- **Pose Skeleton (MediaPipe)** — the stick-figure skeleton from a live webcam.
- **MediaPipe Body Dots** — glowing dots tracking every joint.
- **MediaPipe Face Overlay** — a dot-cloud over live video from the face
  landmarks.

Each expects the plugin loaded; point its Select CHOP at the matching adapter's
output.

## See also

- [Body & pose tracking](/guide/body-tracking) — the consumer-side guide and the
  camera/first-run walkthrough.
- [Camera & motion reactive](/guide/prompt-cookbook#camera-motion-reactive) in the
  prompt cookbook.
