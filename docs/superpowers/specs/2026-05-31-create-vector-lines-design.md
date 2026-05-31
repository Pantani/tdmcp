# Create Vector Lines - Formal Feature Spec

Date: 2026-05-31
Status: design ready for implementation planning
Harness: `tdmcp-pipeline` / `td-feature-design`
Feature name: `create_vector_lines`

## Summary

Build a Layer 1 artist tool that captures a still frame from a camera, file, synthetic
source, or existing TOP, vectorizes the chosen image through a pulse-driven Trace SOP
pipeline, and composites the rendered vector layer back over the source image. Phase 1 is
explicitly not realtime: the user presses a `Vectorize` pulse, tdmcp freezes the current
prepared frame, generates editable SOP geometry, and leaves the vectors ready for later
animation, modulation, export, or mixing.

The selected direction is hybrid foreground-first:

- Default to a controllable foreground/object workflow, with threshold, blur, invert, and
  cleanup controls.
- Keep a `full_frame` mode so the same tool can produce dense abstract line-art from the
  whole camera image.
- Do not require MediaPipe, segmentation models, or live tracking in Phase 1.

Phase 2 can add animation over the captured vector geometry. Phase 3 can add throttled
realtime vectorization once the pulse workflow is proven and live-cook costs are measured.

## Layer + Target Path

- Layer: Layer 1 artist tool.
- Target file: `src/tools/layer1/createVectorLines.ts`.
- Tool name: `create_vector_lines`.
- CLI shorthand: `vector-lines` or `vectorize-lines`.
- Primary output: `out1` Null TOP, a source image with vector lines composited on top.
- Secondary outputs:
  - `vectors_out` Null TOP, the rendered vector layer on transparent/dark background.
  - `trace1` Trace SOP, the editable vector geometry.
  - `frozen_frame` Movie File In TOP, the pulse-captured source image used by Trace SOP.
  - `prep_out` Null TOP, the prepared monochrome/mask image used for capture.

## Input Schema

| Name | Type | Default | Notes |
|---|---|---:|---|
| `name` | string | `vector_lines` | Name for the system COMP. |
| `parent_path` | string | `/project1` | Parent COMP where the system is created. |
| `source` | enum | `synthetic` | `synthetic`, `camera`, `file`, or `existing_top`. Device capture is opt-in. |
| `existing_top_path` | string optional | none | Required only when `source="existing_top"`. Pulled through Select TOP. |
| `movie_file_path` | string optional | none | Used only when `source="file"`. |
| `camera_device` | string optional | none | Used only when `source="camera"`; omitted means TD default camera. |
| `mode` | enum | `hybrid_foreground` | `hybrid_foreground`, `foreground_mask`, or `full_frame`. |
| `analysis_resolution` | tuple number | `[640, 360]` | Resolution for prep/capture/trace. Keeps vectorization cost bounded. |
| `threshold` | number 0..1 | `0.45` | Brightness/mask cutoff for foreground and Trace SOP. |
| `pre_blur` | number >=0 | `2` | Blur before threshold/trace to remove camera noise. |
| `invert` | boolean | `false` | Invert the mask before tracing. |
| `remove_borders` | boolean | `true` | Trace SOP border cleanup (`delborder`). |
| `resample` | boolean | `true` | Trace SOP shape resampling (`doresample`). |
| `step_size` | number >0 | `4` | Trace SOP resample step / simplification control. |
| `smooth_shapes` | boolean | `true` | Trace SOP smoothing (`dosmooth`). |
| `fit_curves` | boolean | `false` | Trace SOP Bezier fit (`fitcurve`), probe live before making default true. |
| `line_color` | string | `#49dcb2` | Hex color for the vector material. |
| `line_width` | number >0 | `2` | Width for the line/wire material where supported. |
| `opacity` | number 0..1 | `0.9` | Vector overlay opacity. |
| `overlay_mode` | enum | `over` | `over`, `add`, `screen`, or `multiply`; maps to Composite TOP operand. |
| `show_source` | boolean | `true` | Whether final output includes the source image under the vectors. |
| `expose_controls` | boolean | `true` | Adds the control page and pulse button to the container. |

Device-sourced defaults intentionally favor `synthetic`. Like `create_live_source` and
`create_motion_reactive`, camera capture can trigger OS permission dialogs and should not
be the default build path.

## Network Topology

The tool creates one self-contained Base COMP.

```text
source stage
  synthetic: noiseTOP/rampTOP test image
  camera:    videodeviceinTOP
  file:      moviefileinTOP
  existing:  selectTOP(existing_top_path)
        |
        v
fit_source (fitTOP, analysis_resolution)
        |
        +-------------------------------> source_display (nullTOP)
        |
        v
prep chain
  monochromeTOP -> blurTOP -> optional edgeTOP -> thresholdTOP -> optional levelTOP invert
        |
        v
prep_out (nullTOP)
        |
        |  Pulse "Vectorize"
        |  saves prep_out to snapshot PNG and reloads frozen_frame
        v
frozen_frame (moviefileinTOP)
        |
        v
trace1 (traceSOP, TOP Name points at frozen_frame)
        |
        v
optional simplify/smooth/transform SOP stages
        |
        v
vector_geo (geometryCOMP + wireframe/line material)
        |
        v
render_vectors (renderTOP with orthographic camera)
        |
        v
vectors_opacity (levelTOP)
        |
        +---- if show_source=true ---- compositeTOP over source_display ---- out1 (nullTOP)
        |
        +---- vectors_out (nullTOP)
```

### Operator Notes

- `Trace SOP` exists in the knowledge base and is the intended conversion point. The KB
  confirms parameters for threshold (`thresh`), border removal (`delborder`), resampling
  (`doresample`, `step`), smoothing (`dosmooth`, `corner`), curve fitting (`fitcurve`,
  `error`), polygon conversion (`convpoly`, `lod`), and hole filling (`hole`).
- The exact Trace SOP source parameter should be set defensively. The UI label is `TOP
  Name`; the implementation should probe likely parameter names in Python and warn rather
  than fail when a TD build differs.
- `Wireframe MAT` is the default render material for a plotter/contour look over Trace
  SOP faces. `Line MAT` is the live-probe fallback if the generated primitives render more
  cleanly as lines/curves.
- The vector render should use an orthographic camera and fixed 2D framing so the overlay
  aligns with the captured source. If exact framing is not reliable on the first pass,
  include `Scale`, `OffsetX`, and `OffsetY` controls as calibration knobs.

## Bridge / Python Approach

Use the existing Layer 1 orchestration pattern:

- `createSystemContainer(ctx, parent_path, name)` for the Base COMP.
- `NetworkBuilder.add`, `connect`, `setParams`, and `python` for node creation and
  fail-forward warnings.
- `finalize(ctx, { capturePreviewImage: true })` for layout, controls, error check, and
  preview.

The pulse callback needs a Python DAT inside the container, because the vectorization
event happens after the tool returns:

1. Add a custom parameter page on the system container:
   - `Vectorize` pulse.
   - prep controls: `Mode`, `Threshold`, `PreBlur`, `Invert`, `StepSize`,
     `SmoothShapes`, `FitCurves`, `RemoveBorders`.
   - look controls: `LineColor`, `LineWidth`, `Opacity`, `OverlayMode`, `ShowSource`.
   - optional calibration: `Scale`, `OffsetX`, `OffsetY`.
2. Add a DAT callback or Execute DAT that handles the pulse.
3. On pulse:
   - cook `prep_out`;
   - write `prep_out` to a PNG under a stable project-local folder such as
     `<project.folder>/tdmcp_snapshots/vector_lines/<container_name>_latest.png`;
   - point `frozen_frame.par.file` at that PNG and pulse reload if the par exists;
   - set Trace SOP params from current controls;
   - cook `trace1`, `render_vectors`, and `out1`;
   - write a status table/DAT with timestamp, snapshot path, warning text, and, if easy,
     point/primitive counts.

Use defensive Python helpers for parameter names, following nearby tools that probe
platform-dependent parameter names. A wrong parameter name should become a warning, not a
hard tool failure.

## UI Wireframe

```text
create_vector_lines COMP

[Input]
Source: synthetic | camera | file | existing_top
Mode:   hybrid_foreground | foreground_mask | full_frame

[Capture]
(Pulse) Vectorize
Status: Waiting / Captured / Trace warning / Trace failed

[Prep]
Threshold  [0.00 ---------------- 1.00]
PreBlur    [0 ---------------------- 32]
Invert     [toggle]
RemoveBorders [toggle]
StepSize   [1 ---------------------- 32]
SmoothShapes [toggle]
FitCurves    [toggle]

[Look]
LineColor  [rgb]
LineWidth  [0.25 ------------------- 12]
Opacity    [0.00 ---------------- 1.00]
OverlayMode: over | add | screen | multiply
ShowSource [toggle]

[Calibrate]
Scale   [0.1 --------------------- 4]
OffsetX [-1 ---------------------- 1]
OffsetY [-1 ---------------------- 1]
```

The first implementation can expose the core controls and leave `Status` as a Text DAT if
custom UI state is too expensive. The pulse button is non-negotiable for Phase 1.

## Phase Boundaries

### Phase 1 - Pulse Vectorization

Ship `create_vector_lines` with pulse capture, Trace SOP vector geometry, rendered overlay,
and controls above. No realtime loop. No external segmentation dependency.

### Phase 2 - Animate Captured Vectors

Add one or more optional animation tools or extensions:

- point jitter / turbulence over the Trace SOP output;
- audio or `create_modulators` bindings for line width, opacity, transform, and color;
- morph between two captured snapshots;
- SVG/plotter export candidate if the Trace SOP output is stable enough.

### Phase 3 - Throttled Realtime

Add a separate mode that re-vectorizes on a timer or every N frames, never every frame by
default. This phase needs live TD performance measurements before design is locked.

## Probe-First Risks

| Risk | Why it matters | Probe |
|---|---|---|
| Trace SOP source parameter | KB label is `TOP Name`; exact programmatic par name needs live confirmation. | Probe likely names and inspect par list in TD. |
| Trace cook cost | Dense camera frames can create too many primitives. | Measure at 320p, 480p, 720p with point/primitive counts. |
| Overlay alignment | SOP coordinate space may not line up with TOP pixel space automatically. | Live validate orthographic camera framing and add calibration controls. |
| Material choice | Trace may output faces, polygons, or curves depending on params. | Compare Wireframe MAT vs Line MAT on the same capture. |
| Camera permission | Video Device In TOP can prompt/hang until the OS permission modal is answered. | Keep `synthetic` default; document camera opt-in. |
| Snapshot writing | Project folders can be read-only or unset in unsaved projects. | Fall back to a temp path and report the chosen path. |

## Test Plan

### Unit / Offline

Add `tests/unit/createVectorLines.test.ts` using the existing mocked TD client / msw
pattern.

Assert:

- `create_vector_lines` registers with a Zod schema and annotations
  `{ readOnlyHint: false, destructiveHint: false, openWorldHint: true }`.
- Default invocation creates a Base COMP, synthetic source, Fit TOP, monochrome/blur/mask
  prep chain, Movie File In TOP for `frozen_frame`, Trace SOP, geometry/render/composite
  chain, and `out1` Null TOP.
- `source="existing_top"` uses Select TOP and does not create camera/file input nodes.
- `source="camera"` creates `videodeviceinTOP` but is never the default.
- Args map to intended parameters: `threshold`, `pre_blur`, `step_size`,
  `remove_borders`, `smooth_shapes`, `opacity`, and `overlay_mode`.
- Returned JSON includes `container`, `source_path`, `prep_path`, `snapshot_path`,
  `trace_sop`, `vectors_output`, `output_path`, `controls`, and `warnings`.
- The pulse callback DAT contains the expected high-level actions: save `prep_out`,
  reload `frozen_frame`, set Trace SOP params, cook trace/render/output, update status.

### Live / Manual

Run after implementation with a reachable TD bridge:

1. Build with synthetic source and press `Vectorize`. Confirm `out1` previews line-art
   overlay and `trace1` contains geometry.
2. Build with `existing_top_path` from a known image/movie TOP. Confirm pulse captures
   the current prepared frame, not a continuously changing feed.
3. Toggle `full_frame` vs `foreground_mask` / `hybrid_foreground` and confirm density
   changes as expected.
4. Adjust threshold, blur, step size, line width, and opacity, then re-pulse and confirm
   visible changes.
5. Try camera source only with user permission available; confirm no crash if the camera
   produces no image.
6. Capture `get_td_node_errors` and a preview after each live probe.

## Integration Notes

Builder creates only:

- `src/tools/layer1/createVectorLines.ts`
- `tests/unit/createVectorLines.test.ts`

Integrator edits shared files:

- `src/tools/layer1/index.ts` to export/register the tool.
- `src/cli/agent.ts` to add a `vector-lines` or `vectorize-lines` shorthand command.
- `CHANGELOG.md` and generated docs only after implementation is accepted.

Docs:

- `docs/reference/tools.md` is generated; do not hand-edit.
- Add a short guide/example only after live validation, because screenshots and exact Trace
  controls should be based on the verified TD build.

## Acceptance Criteria

- A non-realtime pulse workflow exists and is the only automatic vectorization path in
  Phase 1.
- The tool can build and preview without a camera.
- The user can vectorize an existing TOP or camera frame into editable SOP geometry.
- The final output composites vector lines over the source and exposes a stable output TOP.
- The implementation reports warnings for unverified Trace/camera/snapshot details instead
  of throwing.
- Unit tests pass, typecheck passes, and live validation is either PASS or explicitly
  marked `UNVERIFIED-pending` if the TD bridge is unavailable.
