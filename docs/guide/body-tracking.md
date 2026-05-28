---
description: "Full-body and pose tracking in TouchDesigner with tdmcp — drive skeletons and body-reactive visuals from a webcam via MediaPipe, with a synthetic mode that needs no camera."
---

# Body & pose tracking

Track a person with nothing but a webcam and turn their movement into visuals — a
glowing skeleton, dots that follow the hands and feet, motion trails that smear
behind the body. tdmcp builds these from plain language, the same way it builds
everything else.

No Kinect, no depth camera, no Windows-only hardware: the tracking comes from
[MediaPipe](https://github.com/torinmb/mediapipe-touchdesigner), Google's free
pose model, which runs on macOS and Windows from an ordinary webcam.

::: tip You can try it before installing anything
Every body-tracking tool defaults to a **synthetic** source — a self-contained
animated figure — so the network builds and previews instantly with no camera and
no plugin. Use it to dial in the look, then switch the source to your webcam.
:::

## 1. Try it now (no camera, no plugin)

In your AI assistant:

> *"Build a pose skeleton and show me a preview."*

You'll get a stick figure — 33 landmarks (head, shoulders, elbows, wrists, hips,
knees, ankles) joined by glowing lines — moving on its own. Then iterate:

- *"Make the lines magenta and thicker."*
- *"Now give me body-reactive glowing dots instead."*
- *"Add motion trails."*

## 2. Install the MediaPipe plugin (for a real performer)

To track a real person, add the free, GPU-accelerated MediaPipe plugin — it needs
**no installation** and runs on Mac and PC:

1. Download the latest release from
   [torinmb/mediapipe-touchdesigner](https://github.com/torinmb/mediapipe-touchdesigner/releases).
2. Open `MediaPipe TouchDesigner.toe`, or drag the `.tox` component into your own
   project.
3. Pick your webcam and enable **Pose** tracking. The component outputs a CHOP of
   33 pose landmarks (channels `tx`/`ty`/`tz`, one sample per landmark).
4. Note the path of that landmarks CHOP — you'll point tdmcp at it.

::: warning macOS camera permission
The first time TouchDesigner reads your webcam, macOS pops a permission dialog.
**Click Allow** — until you do, TouchDesigner may look frozen. See
[Troubleshooting](/guide/troubleshooting#macos-microphone-camera-permission).
:::

## 3. Point the visuals at your body

Tell the assistant to use the plugin as the source:

> *"Build a pose skeleton from the MediaPipe plugin at
> `/project1/mediapipe1/select_pose` and show a preview."*

> *"Make body-reactive trails from my webcam pose."*

The assistant sets the tool's `source` to `mediapipe` and points
`mediapipe_chop_path` at the plugin's pose CHOP. Everything else — the skeleton,
the dots, the trails — works exactly as it did in synthetic mode.

## 4. What you can build

Three tools cover the pipeline; the AI picks them for you, but it helps to know
the vocabulary:

| Tool | What it makes |
| --- | --- |
| **create_pose_tracking** | The foundation. A clean pose signal (33 landmarks) plus ready-to-bind scalar channels like `r_wrist_y`, `hand_span`, `height`. Smoothing and Mirror built in. |
| **create_pose_skeleton** | The classic stick-figure skeleton rendered to a TOP — glowing lines connecting the landmarks. |
| **create_body_reactive** | Glowing marks that follow the body, in three styles: **points** (crisp dots), **glow** (bloomed dots), **trails** (motion smears). |

You can chain them: build `create_pose_tracking` once, then point both the
skeleton and the reactive visual at its output so they share one tracked body.

## 5. Bind your body to anything

`create_pose_tracking` also exposes a **keypoints** CHOP of plain scalar channels,
so you can drive *any* parameter with a body part:

- *"Make the blur amount follow my right hand height."*
- *"Map how wide my arms are open to the feedback feedback amount."*
- *"When I crouch, dim the lights."* (the `height` channel shrinks)

Bind a parameter to `op('…/pose_tracking/keypoints')['r_wrist_y']` (or
`hand_span`, `hips_x`, `height`, …) and it tracks your movement live.

## Ready-made recipes

Two browsable templates ship in the recipe gallery — ask *"list recipes"* or see
the [Recipe gallery](/guide/recipes):

- **Pose Skeleton (MediaPipe)** — the stick-figure skeleton from a live webcam.
- **MediaPipe Body Dots** — glowing dots tracking every joint.

Both expect the MediaPipe plugin; point their `posein` Select CHOP at its pose
landmarks CHOP.
