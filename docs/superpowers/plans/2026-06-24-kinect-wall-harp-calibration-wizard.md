# Kinect Wall Harp Calibration Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-projection calibration wizard for the Kinect wall harp so the performer can calibrate without chat-timed sampling.

**Architecture:** The existing `hand_tracker` will expose both mapped and raw Kinect coordinates. The existing `strings_visual` Script TOP will own the calibration state machine, draw target overlays, capture stable raw hand points, write calibration parameters on the parent COMP, and pause harp triggering during calibration.

**Tech Stack:** TypeScript tool generator, embedded TouchDesigner Python callbacks, Vitest/MSW unit tests, live TouchDesigner bridge on port `9980`.

---

## Task 1: Add Generator Contract

**Files:**
- Modify: `src/tools/layer1/createKinectWallHarp.ts`
- Modify: `tests/unit/createKinectWallHarp.test.ts`

- [ ] Add `calibration_hold_ms` to the Zod schema and payload interface with default `900`.
- [ ] Expose `Calibrationmode`, `Manualcapture`, `Resetcalibration`, and `Calibrationholdms` custom parameters.
- [ ] Assert the generated Python contains the calibration parameters and storage keys.

## Task 2: Preserve Raw Hand Coordinates

**Files:**
- Modify: `src/tools/layer1/createKinectWallHarp.ts`

- [ ] Extend `HAND_CHOP_CODE` hand tuples to include `raw_x`, `raw_y`, `cal_x`, and `cal_y`.
- [ ] Store those channels in `tdmcp_hands_latest`.
- [ ] Keep mapped `x/y` unchanged for the harp logic.

## Task 3: Add Visual Calibration Wizard

**Files:**
- Modify: `src/tools/layer1/createKinectWallHarp.ts`

- [ ] In `VISUAL_TOP_CODE`, pause harp/audio drive while `Calibrationmode` is enabled.
- [ ] Draw four projected targets and a progress bar.
- [ ] Auto-capture after the configured hold time when the raw hand point is stable.
- [ ] Capture immediately when `Manualcapture` is toggled.
- [ ] Reset state when `Resetcalibration` is toggled.
- [ ] Apply `Inputmirrorx`, `Inputleft`, `Inputright`, `Inputtop`, and `Inputbottom` from the four captured raw points.

## Task 4: Verify and Apply Live

**Files:**
- Modify: live TouchDesigner project `/project1/kinect_wall_harp`

- [ ] Run focused Vitest.
- [ ] Run Biome on touched source/test files.
- [ ] Run build.
- [ ] Rebuild/apply the harp in TouchDesigner with OSC Kinect mode and UMC202HD audio settings.
- [ ] Confirm `/api/network/project1/errors` is empty.
