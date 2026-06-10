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

To track a real person you need the free, GPU-accelerated MediaPipe plugin
(Mac + PC). tdmcp can fetch it for you — in a terminal:

```bash
npx @dpantani/tdmcp install mediapipe-touchdesigner
```

`tdmcp install <lib>` stages manifest-listed community libraries safely; here it grabs
the MIT-licensed
[torinmb/mediapipe-touchdesigner](https://github.com/torinmb/mediapipe-touchdesigner)
and extracts it under `~/.tdmcp/packages`.

Then, with TouchDesigner open, ask the assistant:

> *"set up body tracking"*

The **setup_body_tracking** tool loads the plugin into your project, finds its
pose-landmarks CHOP, and wires up `create_pose_tracking` plus a live skeleton —
all you do is pick your webcam on the new `mediapipe_pose` component and enable
**Pose**.

Prefer to do it by hand? Open `MediaPipe TouchDesigner.toe` (or drag a `.tox` from
the staged package under `~/.tdmcp/packages`) into your project, enable
**Pose**, then point a tool's `mediapipe_chop_path` at the plugin's pose-landmarks
CHOP (33 samples, channels `tx`/`ty`/`tz`).

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

## 6. Use hands as Ableton filter controls

Hands can also become a four-channel Ableton controller when you use TDAbleton.
The `create_hand_ableton_mapper` tool builds the TouchDesigner side: MediaPipe
hands in, a skeleton overlay with star joints, and a `mapper_send` CHOP for
TDAbleton. AbletonMCP is not required for this recipe.

Default mapping:

| Mapper slot | Gesture |
| --- | --- |
| `map1` | Left-hand thumb/index distance |
| `map2` | Right-hand thumb/index distance |
| `map3` | Left wrist roll |
| `map4` | Right wrist roll |

On the TDAbleton `TDA_Mapper`, point the input CHOP to
`/project1/hand_ableton_mapper/mapper_send`, set `Reorder` to
`map1 map2 map3 map4`, keep `Bypass1..4` off, and map the four slots manually to
Auto Filter frequency, resonance, drive, or rack macros inside Ableton.

If TouchDesigner values move but Ableton does not, run
`diagnose_tdableton_mapper`. It checks the real mapper path, input CHOP, `Reorder`,
bypass states, `Min/Max` ranges, and missing `map1..map4` channels. This catches
the common stale-target problem where a mapper looks healthy but points at the
wrong track or device.

## Ready-made recipes

Two browsable templates ship in the recipe gallery — ask *"list recipes"* or see
the [Recipe gallery](/guide/recipes):

- **Pose Skeleton (MediaPipe)** — the stick-figure skeleton from a live webcam.
- **MediaPipe Body Dots** — glowing dots tracking every joint.

Both expect the MediaPipe plugin; point their `posein` Select CHOP at its pose
landmarks CHOP.
