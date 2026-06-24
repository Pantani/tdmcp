# Kinect Wall Harp - External Kinect Input Design

Date: 2026-06-24
Status: approved for implementation
Feature name: `kinect_wall_harp_external_kinect`
Target runtime: TouchDesigner 2025.32820 on macOS Apple Silicon

## Summary

Keep Kinect v2 as the real performer input, but do not activate FreenectTOP in
the main TouchDesigner project. Prior live validation showed that FreenectTD can
crash TouchDesigner during Kinect v2 init/cook. The safer architecture is to run
Kinect depth capture in a separate process, extract up to two wall-touch blobs,
and send normalized hand channels into TouchDesigner over OSC.

The existing `/project1/kinect_wall_harp` component remains the visual/audio
instrument. This wave adds a real-Kinect input path that can replace the current
synthetic hands without putting the main `.toe` at risk.

## Architecture

```text
Kinect v2 USB 3.0
  -> external libfreenect2 process
  -> depth threshold + two blob centroids
  -> OSC UDP on localhost
  -> TouchDesigner osc_kinect input CHOP
  -> kinect_wall_harp hand_tracker
  -> harp_logic
  -> strings_visual + pluck_synth + UMC202 audio_out
```

## Current Evidence

- macOS detects the Kinect as `Xbox NUI Sensor`, Microsoft `1118:708`, USB 3.0
  link at 5 Gbps, serial `032559434547`.
- The current machine has `cmake`, `pkg-config`, and Homebrew `libusb`.
- `libfreenect2`, `Protonect`, and Python freenect bindings are not currently
  installed on PATH.
- FreenectTD exists as a TouchDesigner plugin, but crash logs implicate
  FreenectTOP/libfreenect2 paths, so it must remain disabled in the main project.

## Scope

In scope:

- Build or install `libfreenect2` outside TouchDesigner.
- Verify Kinect depth capture with `Protonect` or an equivalent test executable.
- Add an OSC Kinect mode to the harp tool.
- Create a local bridge process/script that publishes normalized hand channels.
- Rebuild the live harp in TouchDesigner with `source="osc_kinect"`.
- Validate that TD receives live channels and stays crash-free.

Out of scope:

- Re-enabling FreenectTOP in the main `.toe`.
- Skeleton/body tracking.
- Production-grade calibration UI.
- External synth/MIDI output.

## OSC Contract

The external bridge sends these localhost OSC addresses:

```text
/kinect/left/present   0|1
/kinect/left/x         0..1
/kinect/left/y         0..1
/kinect/left/size      0..1
/kinect/right/present  0|1
/kinect/right/x        0..1
/kinect/right/y        0..1
/kinect/right/size     0..1
```

TouchDesigner maps these to the same hand storage shape used by the current
harp:

```text
left_present, left_x, left_y, left_size
right_present, right_x, right_y, right_size
```

## Safety Rules

- Do not activate FreenectTOP in `/project1/kinect_wall_harp`.
- If the external Kinect process crashes, TouchDesigner should continue running.
- If OSC packets are absent, the harp should either show no hands or use an
  explicit fallback mode, never silently claim real Kinect tracking.
- Keep UMC202 audio routing unchanged.

## Verification

PASS requires:

- Kinect USB visible on macOS.
- External Kinect test can open the device without crashing TouchDesigner.
- TouchDesigner bridge stays reachable at `:9980`.
- `/project1/kinect_wall_harp` has no recursive errors.
- OSC mode produces live `left_*` / `right_*` hand channels.
- Preview output renders and audio debug still produces stereo samples.

If `libfreenect2` cannot be built or cannot open the device, mark Kinect input
BLOCKED with exact build/runtime logs, leaving the existing synthetic harp intact.
