# Kinect Environment Diagnostic - Design

Date: 2026-06-24
Status: approved for standalone implementation
Target runtime: TouchDesigner 2025.32820 on macOS with external libfreenect2

## Goal

Create a separate TouchDesigner diagnostic screen at:

```text
/project1/kinect_environment_diagnostic
```

The screen helps verify what the Kinect sees before the harp calibration step. It
must not depend on FreenectTOP because that path has already crashed
TouchDesigner on this machine. It uses an external libfreenect2 process instead.

## Research Summary

- libfreenect2 exposes Kinect v2 color, IR, depth, and color/depth registration.
- Microsoft RoomAlive calibrates Kinect/projector setups by requiring both the
  Kinect color and depth cameras to observe a good portion of the projection.
- TouchDesigner's KinectCalibration component uses projected checkerboard point
  pairs: 2D projector points plus 3D points from the Kinect point cloud.
- Projected checkerboard approaches can extract corners in RGB and pair them
  with depth samples, but full projector calibration requires careful point order
  and usually multiple poses.
- ChArUco boards are a stronger future option than plain checkerboards because
  they keep subpixel checkerboard accuracy while tolerating partial occlusion.
- Gray-code/structured-light approaches can produce dense projector-camera
  correspondences, but they are heavier than needed for the first diagnostic.

## First Implementable Slice

Build a live environment diagnostic, not a full automatic projector calibration.

The external helper opens the Kinect and captures:

- RGB color frame;
- depth frame;
- IR frame;
- per-pixel empty-wall depth background;
- foreground/candidate statistics using the same depth-band idea as the harp.

It writes a low-rate raw RGBA diagnostic image and JSON status file:

```text
/tmp/kinect_environment_diagnostic.rgba
/tmp/kinect_environment_diagnostic.json
```

TouchDesigner reads the raw RGBA image in a Script TOP and displays it full
screen. A status DAT records frame counters, valid depth ratio, RGB/depth/IR
dimensions, calibration state, and candidate counts.

## Visual Layout

The diagnostic image is a 1280x720 four-panel view:

```text
+----------------------+----------------------+
| RGB camera           | Depth heatmap         |
|                      |                      |
+----------------------+----------------------+
| IR intensity         | Foreground/mask view  |
|                      |                      |
+----------------------+----------------------+
```

Panel borders and status blocks are drawn into the image so the operator can see
whether each stream is alive even if the status DAT is not open.

## Calibration Use

This screen answers:

- Is the projector inside the Kinect RGB field of view?
- Does the Kinect see the wall as a stable depth surface?
- Are RGB/depth/IR frames alive at the same time?
- Is the selected wall-touch depth band too strict or too noisy?
- Does crop need to move left/right/up/down before harping?

It does not yet solve the full projector-camera matrix. The next slice can add a
projected ChArUco/checkerboard mode that collects point pairs and estimates a
homography or projector pose.

## Projection Pattern Slice

The second slice adds:

```text
/project1/kinect_projection_calibration_pattern
```

This COMP projects a full-screen high-contrast checker/grid pattern with large
corner fiducials. The external diagnostic helper analyzes the RGB camera frame
and reports:

- whether a bright projection area is visible;
- the normalized RGB-camera bounding box of that projected area;
- detected red, green, blue, yellow, and cyan marker centroids when visible;
- the existing depth/IR/background statistics.

For the current room, the projection bounding box is the primary calibration
signal. Marker colors can be partially desaturated by the wall/projector/camera
pipeline, so marker detections are diagnostic hints rather than the source of
truth for this slice.

## Registered Projection Slice

The implemented next slice uses `libfreenect2::Registration` to map the RGB
projection into the Kinect depth frame. This avoids applying a 1920x1080 RGB
bbox directly to 512x424 depth data.

The helper reports:

- `registered_projection_present`
- `registered_projection_bright_ratio`
- `registered_projection_bbox`
- `projection_depth_samples`
- `foreground_samples_in_projection`
- `candidate_samples_in_projection`
- `candidate_projection_x`
- `candidate_projection_y`

The bottom-right diagnostic panel tints the registered projection area green and
draws a green box over the depth-space projection region. Candidate touch pixels
inside that region are rendered green; candidates outside the projection remain
amber. The harp should use this registered bbox for its first automatic crop
proposal.

## Runtime Boundary

Only one process can open the Kinect at a time. While the environment diagnostic
helper is running, the harp's external Kinect sender is stopped. The harp COMP is
left intact and can be resumed by restarting its sender.

## References

- OpenKinect libfreenect2 API reference: color, IR, depth, and registration.
- Microsoft RoomAlive Toolkit ProCamCalibration README: Kinect/projector setup
  expectations and projector configuration cautions.
- TouchDesigner forum Kinect2 Projector Calibration component: checkerboard
  point-pair workflow with color camera and point cloud lookup.
- Bingyao Huang Kinect/projector calibration writeup: projected checkerboard
  corners paired with Kinect depth/color captures.
- OpenCV ChArUco documentation: robust board detection, corner interpolation,
  and solvePnP pose estimation.
- Gray-code structured-light project: heavier dense correspondence approach for
  future calibration refinement.
