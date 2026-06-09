# Deep Doppelganger TouchDesigner Design

## Goal

Build a surprising live TouchDesigner project called `deep_doppelganger` that uses
the webcam as the visual input, depends on body/hand tracking for performance
control, and produces one clean video TOP output named `out_video`.

## Current Runtime

- TouchDesigner is running locally with the tdmcp bridge at
  `http://127.0.0.1:9980`.
- The verified bridge target is `NewProject.1.toe`.
- The bridge reports TD `099`, build `2025.32820`, Python `3.11.10`, and bridge
  `0.6.1`.
- A create/delete canary already proved that tdmcp can mutate the project.

## Concept

The performer is turned into a delayed, unstable double. The camera remains
recognizable enough for the audience to read the human body, but the tracked
body and hands drive a second presence: a ghost image, a spectral depth cloud,
an opening feedback tunnel, and a glitch layer that becomes more aggressive
when motion rises or tracking confidence falls.

## Approved Direction

Use the "Doppelganger Profundo" direction:

- Live camera as the source material.
- Pose and hands as the primary control signal.
- Optical flow as a secondary motion/failure signal.
- A single final video output ready for projector, perform window, recording, or
  downstream video output.

## Architecture

Create a top-level base COMP:

```text
/project1/deep_doppelganger
```

Inside it, use organized zones with no accidental overlap:

- `input_camera`: webcam capture, mirror/fit, and a stable `live_camera` TOP.
- `tracking`: body and hand channels, normalized into a `tracking_bus` CHOP.
- `motion_flow`: optical-flow or frame-difference analysis from the camera.
- `ghost_delay`: delayed and displaced copy of the live camera.
- `depth_cloud`: point-cloud or depth-relief interpretation of the camera.
- `feedback_tunnel`: feedback loop whose opening/decay responds to the hands.
- `flow_glitch`: displacement/glitch layer driven by flow and tracking loss.
- `layer_mixer`: final composite.
- `output`: final `out_video` TOP at `1920x1080`.
- `control_panel`: artist-facing custom parameters.

## Data Flow

```text
camera TOP
  -> live_camera
  -> tracking source and motion-flow source

pose/hands CHOPs
  -> tracking_bus
  -> control expressions for ghost, cloud, tunnel, glitch

optical-flow/frame-diff CHOP
  -> motion_energy
  -> flow_glitch and fallback instability

visual entities
  -> layer_mixer
  -> out_video
```

## Performance Controls

Expose these controls on `/project1/deep_doppelganger/control_panel` or the root
`deep_doppelganger` COMP:

- `Shock`: overall intensity.
- `GhostDelay`: delay amount and opacity of the double.
- `DepthScale`: point-cloud or relief depth.
- `TunnelOpen`: how much the feedback tunnel opens.
- `GlitchBite`: displacement/glitch strength.
- `TrackingPanic`: automatic instability amount when tracking confidence falls.
- `CameraOpacity`: original camera visibility in the final composite.
- `Blackout`: emergency output black.

## Tracking Contract

The piece should depend on tracking:

- Hand span and wrist height should visibly affect the tunnel and ghost.
- Body center should pull the ghost/point cloud.
- Tracking confidence should affect the stability of the image.

The system should still remain operable if tracking temporarily drops:

- Hold last good tracking values briefly.
- Raise `TrackingPanic`.
- Increase glitch/ghost instability instead of cutting to black.

## Failure Behavior

- If the tdmcp bridge is offline, stop and report the bridge status before
  editing.
- If MediaPipe is unavailable, build the camera and visual network with a
  synthetic/fallback tracking bus so the patch opens, but mark live tracking as
  unverified.
- If camera permission blocks the Video Device In TOP, keep the network intact
  and leave visible notes/warnings in the report.
- Never treat a successful app launch alone as proof; validate `/api/info` and a
  preview or node-health check.

## Validation

The project is ready only when:

- `/api/info` responds.
- Tracking nodes or fallback channels exist.
- `out_video` exists and is previewable.
- The network has no reported errors on the main container.
- Nodes are arranged in stable zones with no accidental overlap.
- A desktop visual check confirms the project structure is readable.

## Scope Boundaries

This design builds a live TouchDesigner project in the running TD session. It
does not add a new tdmcp MCP tool or release a new package version.

The implementation may create a small reusable script or command plan if that is
the clearest way to keep the live build repeatable.
