---
description: "How to build reliable tdmcp projects for rooms, projectors, sensors and external hardware without confusing a demo with a validated installation."
---

# Physical installations

Hardware installations fail differently from pure visuals. A network can build
cleanly, the preview can look right, and the room can still be wrong because the
sensor sees the wall from another angle, the projector is outside the camera
frame, the audio interface is running at a different rate, or a device plugin
crashes TouchDesigner during startup.

The Kinect wall harp turned those failure modes into a reusable tdmcp pattern:
build the artwork, the diagnostics and the hardware boundary as separate pieces.

## The reliable shape

Use this order for projectors, depth cameras, MIDI/OSC devices and room sensors:

1. **Build a synthetic-safe version first.** The component should render, expose
   controls and generate plausible test input with no hardware attached.
2. **Add a diagnostic view before calibration.** Show what the device actually
   sees: RGB/depth/IR frames, crop boxes, valid-sample ratios and candidate
   blobs. Do not start by tuning the final artwork.
3. **Keep crash-prone hardware outside the main `.toe`.** If a plugin or SDK can
   take TouchDesigner down, run it in a helper process and send normalized OSC,
   MIDI, UDP, WebSocket or file output back into TD.
4. **Calibrate on the projected surface.** Put the wizard or target pattern on
   the same projector output the performer will use. Chat-timed calibration is
   too fragile for room setup.
5. **Separate live claims from offline gates.** Typecheck, tests and synthetic
   previews prove the tool shape. A live room pass proves the actual sensor,
   projector, audio device and performer distance.

## What the Kinect harp taught us

- **Depth cameras are not magic touch screens.** The Kinect detects depth
  discontinuities near a wall plane; it does not understand projected lines or
  colours as touch targets. The software maps tracked blobs into the projected
  coordinate system.
- **Projection and sensor coordinate spaces must be explicit.** A hand touching
  the right side of the wall can trigger the left side if crop, mirror or Y-axis
  conventions are guessed.
- **Debug markers can mislead.** Synthetic fallback hands are useful in rehearsal,
  but debug overlays must clearly switch off when live tracking is absent.
- **Audio problems are often routing/runtime problems, not volume.** A noisy,
  glitch-like synth can come from sample-rate mismatch, clipping inside a voice
  bank, too many overlapping triggers, or the wrong output device.
- **Restarting a helper is part of the feature.** A stalled depth stream should
  restart its helper or mark tracking offline; it should not silently freeze the
  bridge. For the Kinect wall harp bridge, use `--status-json <path>` when an
  operator or generated TD component needs a machine-readable health surface.
  Generated `create_kinect_wall_harp` projects read the same file into the
  `bridge_status` DAT and expose numeric channels through `bridge_status_chop`.
- **Projector crops should come from RGB plus registered depth.** When a Kinect
  and projector see the same wall, run the projection calibration pattern and
  external environment diagnostic first. The diagnostic writes
  `/tmp/kinect_environment_diagnostic.json`; pass it to
  `scripts/kinect-wall-harp-bridge.mjs --projection-calibration-json ...` so the
  bridge uses `registered_projection_bbox` as its depth crop. The OSC contract
  preserves both crop/projector-space hand points (`x/y`) and full registered
  depth coordinates (`raw_x/raw_y`) so TD components can reuse the wall-harp
  `Input*` calibration controls for final alignment.

## Current tools to use

- **`create_kinect_wall_harp`** builds the projected string instrument with
  synthetic fallback, OSC Kinect input mode, calibration controls and internal
  synth.
- **`scripts/create-kinect-projection-calibration-pattern-td.py`** projects the
  high-contrast room target, and **`scripts/kinect-environment-diagnostic.cpp`**
  reads Kinect RGB/depth/IR plus libfreenect2 registration to produce the
  projection crop JSON used by the OSC bridge.
- **`create_test_pattern`** gives the room a visible alignment target before
  projection mapping or calibration.
- **`create_interactive_projection_mapping`** is the rehearsal rig for camera or
  synthetic motion driving a projector output.
- **`create_live_source`** builds camera, NDI, Syphon/Spout, screen-grab or
  network-video inputs and now exposes `source_status` plus
  `source_status_chop` so the generated project can tell whether the source op
  is missing, waiting, failed or running.
- **`create_depth_silhouette`** and **`create_blob_reactive`** are lighter sensor
  tools when the artwork needs masks or tracked blobs instead of a full custom
  instrument. `create_depth_silhouette` also exposes `source_status` and
  `source_status_chop` for its selected synthetic, file or live depth source.
- **`create_external_io`** is the standard route for OSC, MIDI, DMX, NDI and
  Syphon/Spout I/O.
- **`diagnose_hardware_environment`** is the first generic room preflight: it
  checks bridge reachability, display/projector count and generated
  `source_status` / `bridge_status` DATs before calibration.
- **`watch_node`**, **`get_node_state_runtime`** and
  **`inspect_gpu_and_displays`** help verify that the running TD project is
  cooking and routed to the intended display.

## Backlog from the Kinect project

The wall harp points to a small reusable installation toolkit:

| Candidate | What it would add | Why it matters |
|---|---|---|
| `diagnose_hardware_environment` extensions | Add RGB/depth frame metrics and audio-device checks to the shipped bridge/display/status-DAT preflight. | Artists need to know whether the room is wrong before tuning an artwork. |
| `create_projection_calibration_wizard` | Refine the existing automatic registered-bbox crop into projected point-pair/ChArUco calibration with stored homography output. | Automatic crop is now the default first pass; precise projector pose still needs a richer calibration model. |
| `run_external_sensor_bridge` | A reusable helper supervisor for sensor processes, with stale-data detection, restart policy and normalized OSC/WebSocket/status JSON output. | Crash isolation and restart behavior should not be reimplemented per device. |
| `external_sensor_status_surface` | Shared builder primitive for generated DAT/CHOP health surfaces from external helper status JSON or local TouchDesigner operator status. | Every physical sensor tool should expose the same health shape to panels, overlays and logic. |
| `diagnose_audio_device` | Output-device, sample-rate, clipping and voice-count checks for TD audio chains. | Glitchy audio is common in interactive instruments and needs a first-class checklist. |
| `organize_generated_project` | Move, label and prune generated COMPs under `/project1` while preserving useful diagnostics. | Live iteration leaves debris; cleanup should be safe and explain what remains. |

Treat these as next slices, not shipped capabilities. Each one needs its own
offline test shape and, where hardware is involved, a live validation note.

## Room checklist

Before calling a physical installation "done":

- the final output is on the intended projector or display;
- the diagnostic view shows live frames or live channels from the real device;
- synthetic fallback is visibly different from live tracking;
- crop, mirror and Y-axis conventions are verified with at least left/right and
  top/bottom touches;
- audio routes to the intended interface and stays below clipping;
- helper processes recover from stalls or fail with a visible status;
- the final component can still render when hardware is unplugged.

## See also

- [Prompt cookbook](/guide/prompt-cookbook#output-mapping)
- [Layer-1 generators](/guide/generators#installations-studies)
- [Troubleshooting](/guide/troubleshooting)
- [Bridge & REST API](/reference/bridge-api)
