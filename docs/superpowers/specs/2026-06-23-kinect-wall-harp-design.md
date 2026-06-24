# Kinect Wall Harp - Formal Prototype Spec

Date: 2026-06-23
Status: design approved, ready for implementation planning
Feature name: `kinect_wall_harp`
Target runtime: TouchDesigner 2025.32820 on macOS Apple Silicon

## Summary

Build a TouchDesigner prototype for a projected wall harp controlled by a Kinect v2
mounted above the projector. The Kinect and projector point at the same wall. The
projection displays eight vertical harp strings. A performer touches or approaches the
projected wall with either hand; each hand is tracked independently as a depth blob near
the wall plane. When a hand enters a string zone, the system triggers a short electronic
pluck synth note and animates the touched string with vibration and glow.

The approved first version prioritizes a reliable, playable wall-interaction prototype:

- Kinect v2 through the already validated FreenectTD `FreenectTOP` plugin.
- Two independent hand/blob tracks.
- Eight vertical projected strings.
- A safe electronic scale for improvisation.
- Sound generated inside TouchDesigner.
- Short pluck behavior on entry, not sustained notes.
- Depth-based wall-touch blob detection rather than skeleton tracking.

Skeleton tracking is explicitly out of scope for this version because the macOS
FreenectTD path exposes RGB, depth, IR, and point cloud buffers, but does not provide
body/skeleton joints.

## Physical Setup

- Kinect v2 is mounted above or near the projector.
- Kinect and projector both point toward the same wall.
- The projection shows the visible instrument surface.
- The performer touches, taps, or moves hands very close to the projected wall.
- The Kinect depth image is calibrated against the wall depth, then filtered for hands
  that enter a narrow depth band near the wall.

This is treated as a projected wall instrument, not as a free-air harp in the middle of
the room.

## Target TouchDesigner Network

Create one isolated Base COMP under `/project1`:

```text
/project1/kinect_wall_harp
```

The component owns the full prototype and should not modify unrelated nodes. It can reuse
or replace the earlier Kinect test network only if the operator explicitly requests that
later. The initial build should leave existing project nodes alone.

### Major Blocks

```text
kinect input
  FreenectTOP (Kinect v2)
        |
        +--> depth buffer via Render Select TOP
        |
        +--> optional RGB/IR debug previews

depth processing
  crop/fit -> wall depth threshold -> cleanup -> blob extraction
        |
        +--> hand_left / hand_right normalized positions

harp logic
  8 vertical zones
  per-hand zone state
  entry-edge detection
  per-string cooldown
        |
        +--> note trigger channels
        +--> string energy/envelope channels

audio
  8 electronic pluck voices
  scale-mapped frequencies
  summed stereo output

visual
  8 projected strings
  hit glow/vibration from string envelopes
  optional debug overlay for hand blobs and zones
```

## Tracking Design

### Input

Use `FreenectTOP` with:

- `Hardwareversion = Kinect v2`
- `Active = On`
- depth enabled

Depth is read through `Render Select TOP` buffer index `1`. The validated FreenectTD
mapping is:

- source TOP output: RGB, 1280x720
- buffer index `1`: depth, 512x424
- buffer index `2`: point cloud, 512x424
- buffer index `3`: IR, 512x424

### Wall-Touch Mask

The prototype creates a mask from the depth buffer where pixels are within a configurable
depth range around the wall-touch band.

Controls:

| Control | Purpose |
|---|---|
| `WallDepthCenter` | The depth value representing the wall or touch plane. |
| `TouchThickness` | Accepted band around the wall-touch plane. |
| `DepthPolarity` | Allows flipping whether hands are expected in front of or near the wall if needed. |
| `CropLeft`, `CropRight`, `CropTop`, `CropBottom` | Limits tracking to the projected wall area. |
| `Sensitivity` | Blob threshold / cleanup aggressiveness. |

The first implementation may use manual calibration sliders instead of automatic wall
calibration. A later version can add a `Calibrate Wall` pulse that samples the depth image
when the wall is empty.

### Two-Hand Blob Extraction

Extract up to two hand blobs from the wall-touch mask. The minimum viable approach is:

1. Build a cleaned binary mask from depth.
2. Reduce the mask to candidate hand regions.
3. Compute centroid and size for the two strongest candidates.
4. Sort candidates by X position into left and right hands.
5. Smooth positions to reduce jitter.

If TouchDesigner-native blob extraction operators are not reliable in the active build,
use a small Script TOP or Script CHOP helper inside the component to compute centroids from
the depth mask. This helper should output stable CHOP channels:

```text
left_present
left_x
left_y
right_present
right_x
right_y
```

Coordinates should be normalized to the calibrated projection region:

- `x = 0` at the left edge of the projected harp area.
- `x = 1` at the right edge.
- `y = 0` at the top edge and `y = 1` at the bottom edge, matching image-coordinate
  convention and making debug overlays easier to align with TOP output.

## Harp Logic

The harp divides the calibrated horizontal range into eight equal string zones. Each hand
can independently trigger a string.

### Entry Trigger

A note triggers when:

1. The hand is present.
2. The hand is inside a string's active zone.
3. That hand was not already inside that string on the previous frame.
4. The string is not inside its cooldown window.

This avoids repeated retriggers while the hand remains on the line.

### Cooldown

Use a per-string cooldown, default around 120-180 ms. This keeps fast taps playable while
preventing accidental flams from tracking noise.

### Scale

Use a safe electronic/minor pentatonic style scale across eight strings. Proposed initial
notes:

```text
C3, Eb3, F3, G3, Bb3, C4, Eb4, F4
```

The exact root and octave can be exposed as implementation-time controls if the native TD
audio network supports it cleanly. The prototype should at least make the frequency table
easy to edit.

## Audio Design

Generate sound inside TouchDesigner.

Each string triggers a short electronic pluck voice:

- Oscillator: sine, triangle, or simple subtractive waveform.
- Envelope: fast attack, short decay, no long sustain.
- Tone: electronic, not acoustic harp.
- Mix: summed stereo output with master volume.

Controls:

| Control | Purpose |
|---|---|
| `MasterVolume` | Overall output gain. |
| `Decay` | Pluck length. |
| `Brightness` | Filter or harmonic intensity if available. |
| `CooldownMs` | Shared or per-string retrigger guard. |

The first build can prioritize reliable note triggers over a polished synth engine. A
more expressive synth can be layered after the tracking is proven.

## Visual Design

The projected output should be the primary user-facing view:

- Eight vertical strings distributed across the projection area.
- Idle strings use a cool cyan/blue glow.
- Touched strings flash warmer or brighter.
- Touched strings vibrate horizontally for a short time.
- Optional hand debug dots can be toggled on/off.
- Optional zone boundaries can be toggled on/off for calibration.

The final output TOP should be clearly named:

```text
/project1/kinect_wall_harp/out1
```

Debug outputs should be named predictably:

```text
depth_debug
mask_debug
hands_debug
audio_debug
```

## Calibration Controls

The component should expose a custom parameter page with at least:

```text
Tracking
  Active
  WallDepthCenter
  TouchThickness
  DepthPolarity
  Sensitivity
  Smoothing
  CropLeft
  CropRight
  CropTop
  CropBottom
  ShowDebug

Harp
  StringCount (fixed at 8 for v1, optionally hidden)
  CooldownMs
  HitThreshold

Audio
  MasterVolume
  Decay
  Brightness

Visual
  BaseColor
  HitColor
  Glow
  VibrationAmount
  VibrationDecay
```

Manual calibration is acceptable for v1. The operator should be able to tune the wall
depth and crop live while watching the debug overlay.

## Layout Requirements

All generated TouchDesigner operators must have explicit deterministic coordinates. The
network should be laid out by role:

- Kinect input and raw buffers on the left.
- Depth processing and hand tracking in the middle.
- Harp trigger logic and audio below or to the right.
- Visual output and final `out1` on the far right.
- Debug views grouped near their related processing stage.

No generated operators should be stacked at the same coordinates.

## Error Handling and Fallbacks

- If `FreenectTOP` is unavailable, create the component with a clear error/status DAT and
  a synthetic fallback mode so the visual/audio logic can still be tested.
- If the Kinect is connected but depth is not cooking, expose the raw FreenectTOP errors
  and keep the component from silently producing false triggers.
- If no hands are detected, output zero trigger channels and keep the visual idle state.
- If only one hand is detected, the detected hand still plays normally.
- If both hands overlap or merge into one blob, treat it as one blob until they separate.

## Verification Plan

Implementation is done only when these checks pass:

1. TouchDesigner bridge responds at `http://127.0.0.1:9980/api/info`.
2. `FreenectTOP` exists and cooks in `Kinect v2` mode.
3. Depth buffer can be selected and cooks without node errors.
4. `/project1/kinect_wall_harp` exists and has non-overlapping node coordinates.
5. Network error scan for `/project1/kinect_wall_harp` returns no errors.
6. Debug channels show left/right hand presence and normalized positions when hands touch
   the wall region.
7. Entering a string zone produces one trigger pulse, not continuous retriggering.
8. Two hands can trigger two different strings independently.
9. Audio output responds to string triggers.
10. Visual strings flash/vibrate on triggers.
11. Debug overlay can be turned off for the clean projected output.

Hardware-dependent checks should be reported separately from offline network checks. Do
not claim live hand tracking is verified unless it is tested against the real Kinect and
wall setup.

## Out of Scope for V1

- Skeleton/body joint tracking.
- MIDI or OSC output to external synths.
- Automatic projector-camera calibration.
- Multi-user tracking beyond two hand blobs.
- Complex gesture vocabulary.
- Saving a polished reusable `.tox` package.
- Production-ready audio synthesis.

## Open Implementation Notes

- Prefer built-in TOP/CHOP operators for thresholding, cleanup, and logic where practical.
- Use a Script CHOP/TOP only where native operators make two-hand centroid extraction
  unnecessarily brittle.
- Keep all generated scripts local to the component and small enough to inspect.
- Run any live Python through the existing tdmcp bridge only during construction and
  validation. Disable arbitrary exec again after live validation when possible.
