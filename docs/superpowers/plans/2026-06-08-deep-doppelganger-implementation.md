# Deep Doppelganger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the live `deep_doppelganger` TouchDesigner project in the running TD session.

**Architecture:** Use existing tdmcp-agent builders for MediaPipe tracking and major visual systems, then run one controlled TD Python integration pass to create the final compositor, controls, and `out_video`. Keep the project arranged in clear zones and validate through the live bridge.

**Tech Stack:** TouchDesigner 2025.32820, tdmcp bridge 0.6.1, tdmcp-agent, MediaPipe TouchDesigner package, TD Python via `exec python`.

---

### Task 1: Runtime Preflight

**Files:**
- Read: `docs/superpowers/specs/2026-06-08-deep-doppelganger-design.md`
- Live TD: `/project1`

- [ ] **Step 1: Confirm bridge health**

Run:

```bash
rtk node dist/cli/agent.js info --output json --no-color
```

Expected: `connected: true`, endpoint `http://127.0.0.1:9980`, `bridge_stale: false`.

- [ ] **Step 2: Confirm MediaPipe package path**

Run:

```bash
rtk proxy sh -lc 'find "$HOME/.tdmcp/packages" "$HOME/tdmcp-packages" -maxdepth 5 -iname "MediaPipe.tox" 2>/dev/null | head -20'
```

Expected: at least `/Users/pantani/.tdmcp/packages/installed/mediapipe-touchdesigner/release/toxes/MediaPipe.tox`.

### Task 2: Build Tracking Sources

**Files:**
- Live TD: `/project1/MediaPipe`, `/project1/mp_hand_adapter`, body tracking outputs

- [ ] **Step 1: Build body tracking**

Run:

```bash
rtk node dist/cli/agent.js body-tracking --params '{"parent_path":"/project1","build_skeleton":true}' --output json --no-color
```

Expected: MediaPipe engine is loaded, a body tracking adapter/skeleton is created, and the output includes the created paths.

- [ ] **Step 2: Build hand tracking**

Run:

```bash
rtk node dist/cli/agent.js hand-tracking --params '{"parent_path":"/project1","max_hands":2,"coordinate_space":"world","adapter_name":"mp_hand_adapter"}' --output json --no-color
```

Expected: hand landmark CHOP output exists and can be read by the integration pass.

### Task 3: Build Visual Entities

**Files:**
- Live TD: `/project1/deep_doppelganger`

- [ ] **Step 1: Create the root container**

Run:

```bash
rtk node dist/cli/agent.js container --params '{"parent_path":"/project1","name":"deep_doppelganger"}' --output json --no-color
```

Expected: `/project1/deep_doppelganger` exists.

- [ ] **Step 2: Build optical flow from the camera**

Run:

```bash
rtk node dist/cli/agent.js optical-flow --params '{"name":"motion_flow","parent_path":"/project1/deep_doppelganger","source":"/project1/MediaPipe/video","resolution":[960,540],"sensitivity":5.5,"smoothing":0.72,"blur":2,"direction_from":"edges"}' --output json --no-color
```

Expected: a motion-flow container exists and returns an output TOP path.

- [ ] **Step 3: Build spectral point cloud**

Run:

```bash
rtk node dist/cli/agent.js point-cloud --params '{"source":"existing","existing":"/project1/MediaPipe/video","resolution":192,"depth_scale":1.65,"point_size":0.018,"rotate":8,"expose_controls":true,"parent_path":"/project1/deep_doppelganger"}' --output json --no-color
```

Expected: a point-cloud container exists and returns an output TOP path.

- [ ] **Step 4: Build feedback tunnel from the camera**

Run:

```bash
rtk node dist/cli/agent.js feedback-tunnel --params '{"name":"feedback_tunnel","parent_path":"/project1/deep_doppelganger","source":"/project1/MediaPipe/video","zoom":1.035,"rotate":1.6,"hue_shift":0.012,"decay":0.93,"resolution":[1280,720]}' --output json --no-color
```

Expected: a feedback tunnel container exists and returns an output TOP path.

### Task 4: Integrate Final Composite And Controls

**Files:**
- Create: `_workspace/deep_doppelganger/integrate_deep_doppelganger.py`
- Live TD: `/project1/deep_doppelganger/out_video`

- [ ] **Step 1: Create the integration script**

Write `_workspace/deep_doppelganger/integrate_deep_doppelganger.py` with TD Python that:

- Creates or reuses `/project1/deep_doppelganger`.
- Creates select TOPs for camera, motion flow, point cloud, and feedback tunnel.
- Builds `ghost_delay`, `flow_glitch`, `layer_mixer`, and `out_video`.
- Adds custom controls: `Shock`, `Ghostdelay`, `Depthscale`, `Tunnelopen`, `Glitchbite`, `Trackingpanic`, `Cameraopacity`, `Blackout`.
- Arranges nodes in non-overlapping zones.
- Prints a JSON report with `out_video`, created nodes, warnings, and missing sources.

- [ ] **Step 2: Execute the integration script**

Run:

```bash
rtk node dist/cli/agent.js exec python --allow-unsafe --params-file _workspace/deep_doppelganger/integrate_payload.json --output json --no-color
```

Expected: `/project1/deep_doppelganger/out_video` exists at `1280x720` in this
Non-Commercial TD session and the report says `ok: true`.

### Task 5: Output And Validation

**Files:**
- Live TD: `/project1/deep_doppelganger/out_video`

- [ ] **Step 1: Create output window**

Run:

```bash
rtk node dist/cli/agent.js output --params '{"source_path":"/project1/deep_doppelganger/out_video","output_type":"window","resolution":"720p","parent_path":"/project1/deep_doppelganger"}' --output json --no-color
```

Expected: a Window COMP/output wrapper exists.

- [ ] **Step 2: Arrange the network**

Run:

```bash
rtk node dist/cli/agent.js arrange --params '{"path":"/project1/deep_doppelganger","recursive":true}' --output json --no-color
```

Expected: nodes are laid out in readable zones.

- [ ] **Step 3: Validate errors**

Run:

```bash
rtk node dist/cli/agent.js nodes errors --params '{"path":"/project1/deep_doppelganger","recursive":true}' --output json --no-color
```

Expected: no fatal errors on the final output path. Camera or MediaPipe permission warnings are reported honestly if present.

- [ ] **Step 4: Capture preview**

Run:

```bash
rtk node dist/cli/agent.js preview /project1/deep_doppelganger/out_video --out _workspace/deep_doppelganger/out_video.png --no-color
```

Expected: `_workspace/deep_doppelganger/out_video.png` is written and is not blank.

Note: on a licensed TouchDesigner system, the same graph can be promoted to
`1920x1080`; the validated local target is `1280x720` because TouchDesigner
Non-Commercial caps TOP output resolution.

### Self-Review

- Spec coverage: bridge, tracking, visual entities, final output, fallback behavior, and layout validation are covered.
- Red-flag scan: no vague implementation steps are used; every command is concrete.
- Type consistency: command names and parameter names match schemas inspected from the local tdmcp-agent command catalog.
