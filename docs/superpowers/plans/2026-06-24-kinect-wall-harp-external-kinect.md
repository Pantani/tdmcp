# Kinect Wall Harp External Kinect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Kinect v2 as the real wall-harp input by moving depth capture outside TouchDesigner and feeding normalized hand points back through OSC.

**Architecture:** The main TouchDesigner project remains crash-safe: `/project1/kinect_wall_harp` never activates FreenectTOP. A separate external Kinect process captures depth with `libfreenect2`, extracts two wall-touch blobs, and sends normalized OSC channels to a new `osc_kinect` input mode in the harp tool.

**Tech Stack:** TouchDesigner 2025.32820, tdmcp bridge `0.6.1`, TypeScript/Zod/Vitest, Homebrew, `libfreenect2`, OSC UDP on localhost.

---

### Task 1: External Kinect Runtime Probe

**Files:**
- Modify: `_workspace/kinect-wall-harp/08_external_kinect_runtime.md`

- [ ] **Step 1: Record current USB/runtime state**

Run:

```bash
rtk proxy sh -lc 'ioreg -p IOUSB -l -w0 | rg -i -A18 -B6 "Xbox NUI Sensor|idVendor\" = 1118|idProduct\" = 708"'
rtk proxy sh -lc 'command -v Protonect || true; command -v freenect2-glview || true; pkg-config --modversion libfreenect2 2>/dev/null || true'
rtk proxy sh -lc 'brew list --versions cmake pkg-config libusb 2>/dev/null || true'
```

Expected:

```text
Xbox NUI Sensor appears on USB 3.0.
Protonect/libfreenect2 may be missing before install/build.
cmake, pkg-config, and libusb are available or installable by Homebrew.
```

- [ ] **Step 2: Check Homebrew availability**

Run:

```bash
rtk proxy brew search libfreenect2
rtk proxy brew info libfreenect2 || true
```

Expected:

```text
Either Homebrew has a formula/cask we can install, or we build from OpenKinect source.
```

- [ ] **Step 3: Install or build libfreenect2 outside TouchDesigner**

Preferred if formula exists:

```bash
rtk proxy brew install libfreenect2
```

Fallback source build:

```bash
rtk proxy mkdir -p _workspace/kinect-wall-harp/external
rtk proxy git clone https://github.com/OpenKinect/libfreenect2.git _workspace/kinect-wall-harp/external/libfreenect2
rtk proxy cmake -S _workspace/kinect-wall-harp/external/libfreenect2 -B _workspace/kinect-wall-harp/external/libfreenect2/build -DENABLE_OPENGL=OFF -DENABLE_OPENCL=OFF -DENABLE_CUDA=OFF
rtk proxy cmake --build _workspace/kinect-wall-harp/external/libfreenect2/build --parallel 4
```

Expected:

```text
A Protonect or libfreenect2 test executable exists outside TouchDesigner.
```

- [ ] **Step 4: Run a short external Kinect open test**

Run the discovered test executable for a short window, for example:

```bash
rtk proxy timeout 10s _workspace/kinect-wall-harp/external/libfreenect2/build/bin/Protonect
```

Expected:

```text
The external process opens the Kinect or reports an actionable USB/firmware/backend error.
TouchDesigner remains open and bridge :9980 remains reachable.
```

### Task 2: Add OSC Kinect Mode To Harp Tool

**Files:**
- Modify: `src/tools/layer1/createKinectWallHarp.ts`
- Modify: `tests/unit/createKinectWallHarp.test.ts`

- [ ] **Step 1: Write failing schema/payload test**

Add a test case asserting:

```ts
const parsed = createKinectWallHarpSchema.parse({
  source: "osc_kinect",
  osc_port: 7400,
  fallback_to_synthetic: false,
});
expect(parsed.source).toBe("osc_kinect");
expect(parsed.osc_port).toBe(7400);
```

Expected before implementation:

```text
FAIL because source enum does not include osc_kinect and osc_port is not in the schema.
```

- [ ] **Step 2: Extend schema**

In `createKinectWallHarpSchema`, change:

```ts
source: z.enum(["freenect", "synthetic"])
```

to:

```ts
source: z.enum(["freenect", "synthetic", "osc_kinect"])
```

Add:

```ts
osc_port: z.coerce
  .number()
  .int()
  .min(1024)
  .max(65535)
  .default(7400)
  .describe("UDP port for OSC Kinect hand input when source='osc_kinect'."),
```

- [ ] **Step 3: Add TouchDesigner OSC input nodes**

In the Python payload builder, when `_mode == "osc_kinect"`, create:

```python
_osc = _create(_cont, ["oscinCHOP"], "osc_kinect_in", -220, -20, "OSC Kinect input")
_set_par(_osc, ["port"], int(_p["osc_port"]), False)
_set_par(_osc, ["active"], True, False)
_osc_select = _create(_cont, ["selectCHOP"], "osc_kinect_select", 20, -20, "OSC hand channels")
_connect(_osc, _osc_select)
```

The `hand_tracker` callback receives `osc_path`.

- [ ] **Step 4: Teach `HAND_CHOP_CODE` to read OSC channels**

Add an OSC branch in `onCook`:

```python
elif mode == "osc_kinect":
    src = op(CFG.get("osc_path", ""))
    left = _read_osc_hand(src, "left")
    right = _read_osc_hand(src, "right")
```

Implement `_read_osc_hand(src, prefix)` so it accepts both slash-derived and
underscore channel names:

```python
present = _read_chop_any(src, [prefix + "_present", prefix + ":present", prefix + "/present"], 0.0)
x = _read_chop_any(src, [prefix + "_x", prefix + ":x", prefix + "/x"], 0.0)
y = _read_chop_any(src, [prefix + "_y", prefix + ":y", prefix + "/y"], 0.0)
size = _read_chop_any(src, [prefix + "_size", prefix + ":size", prefix + "/size"], 0.0)
return (present, x, y, size)
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
rtk proxy npm test -- tests/unit/createKinectWallHarp.test.ts
rtk proxy npx --yes @biomejs/biome@2.4.15 check src/tools/layer1/createKinectWallHarp.ts tests/unit/createKinectWallHarp.test.ts
rtk proxy npm run build
```

Expected:

```text
Focused tests pass, Biome reports no fixes, TypeScript build passes.
```

### Task 3: External OSC Bridge Script

**Files:**
- Create: `scripts/kinect-wall-harp-bridge.mjs`
- Modify: `package.json` only if adding a script entry is needed.

- [ ] **Step 1: Create a dry-run OSC sender first**

Create a Node script that accepts:

```text
--host 127.0.0.1
--port 7400
--source synthetic|libfreenect2
```

For `--source synthetic`, emit the eight OSC addresses from the spec at 30 Hz.

- [ ] **Step 2: Verify TouchDesigner receives synthetic OSC**

Run:

```bash
rtk proxy node scripts/kinect-wall-harp-bridge.mjs --source synthetic --port 7400
```

Expected:

```text
TouchDesigner osc_kinect mode sees moving left/right points without Kinect capture.
```

- [ ] **Step 3: Add libfreenect2 source only after external runtime probe passes**

If `Protonect` works, add a libfreenect2-backed mode or a small helper executable
wrapper that emits normalized left/right blobs. Keep this separate from the TD
bridge process.

### Task 4: Live TouchDesigner Rebuild And QA

**Files:**
- Modify: `_workspace/kinect-wall-harp/08_external_kinect_runtime.md`

- [ ] **Step 1: Rebuild harp in OSC Kinect mode**

Run:

```bash
rtk proxy node dist/cli/agent.js nodes delete --td-port 9980 --params '{"path":"/project1/kinect_wall_harp"}'
rtk proxy node dist/cli/agent.js kinect-wall-harp --td-port 9980 --params '{"name":"kinect_wall_harp","source":"osc_kinect","fallback_to_synthetic":false,"osc_port":7400,"show_debug":true,"string_count":8,"master_volume":0.25,"audio_device":"UMC202HD 192k"}'
```

Expected:

```text
The harp reports mode osc_kinect, creates osc_kinect_in, and keeps FreenectTOP inactive.
```

- [ ] **Step 2: Validate live TD health**

Run:

```bash
rtk proxy node dist/cli/agent.js nodes errors --td-port 9980 --params '{"path":"/project1","recursive":true}'
rtk proxy node dist/cli/agent.js preview /project1/kinect_wall_harp/out1 --td-port 9980 -o /tmp/kinect_wall_harp_osc_kinect.png
```

Expected:

```text
No recursive errors; preview renders eight strings.
```

- [ ] **Step 3: Validate audio path**

Run a TD Python diagnostic that triggers one pluck and confirms `audio_debug`
has `left/right` samples. Expected:

```text
audio_debug contains left/right with nonzero max_abs.
```

- [ ] **Step 4: Record final PASS/BLOCKED state**

Update `_workspace/kinect-wall-harp/08_external_kinect_runtime.md` with:

```text
USB: PASS/FAIL
libfreenect2 external open: PASS/FAIL/BLOCKED
OSC input mode: PASS/FAIL
TD errors: PASS/FAIL
Audio UMC202: PASS/FAIL
Real Kinect hand tracking: PASS/FAIL/BLOCKED
```
