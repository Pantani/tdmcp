---
description: "A reference for tdmcp's Layer-1 generators — what each one builds and when to reach for it, for every generator shown in the prompt cookbook."
---

# Layer-1 generators reference

The [prompt cookbook](/guide/prompt-cookbook) shows these generators *in action*
— grouped by what you want to make. This page is the companion **reference**: one
short "what it builds + when to reach for it" entry per generator, so you can pick
the right altitude when two tools look similar (the GPU particle field versus the
flock; the color grade versus the color wheels; kinetic text versus the crawl).

Layer-1 generators each build a whole, wired, previewable network in one call.
Most expose live controls and default to a self-contained synthetic source so they
preview with no camera, no audio device and no plugin. You rarely name them — the
AI picks them from your prompt — but knowing the vocabulary helps you steer.

Generators that belong to a dedicated arc (pose/hands, show transport,
front-of-house, MediaPipe) are listed below with a one-liner and a link to their
guide rather than re-described here.

## Generative & abstract

- **`create_strange_attractor`** — Integrates a chosen ODE system (Lorenz /
  Aizawa / Halvorsen) into a glowing, ever-drawing polyline. Reach for it when you
  want deterministic, mathematically organic line-flow. The CPU-geometry sibling
  of `create_growth_system` (L-systems) and `create_particle_flock` (boids).
- **`create_sdf_field`** — A programmable signed-distance-field raymarcher in a
  single GLSL TOP: a CSG tree of spheres / boxes / tori with smooth blending and
  live camera/step/color controls. Reach for it for clean procedural 3D forms with
  no geometry pipeline.
- **`create_generative_art`** — The catch-all evolving visual: picks a technique
  (reaction-diffusion, noise landscape, attractor, voronoi, fractal, custom GLSL)
  and exposes a Speed knob. Reach for it when you want "something generative and
  moving" without committing to a specific algorithm.
- **`create_jfa_voronoi`** — A Jump-Flooding Voronoi / stained-glass cell pattern
  in GLSL, with palette, seed-count, jitter and edge controls. Reach for it for
  crisp cellular tessellation looks.
- **`create_reaction_diffusion`** — A Gray-Scott reaction-diffusion GPU sim with
  live F / K / Da / Db sliders and coral/spots/stripes/mitosis LUT presets. Reach
  for it for organic, growing, biological patterning.
- **`create_simulation`** — Reaction-diffusion, slime, or fluid-style feedback
  trails with a Decay knob. Reach for it for drifting, advected, "alive" texture;
  step up to `create_generative_art` for more procedural techniques.
- **`create_volumetric_field`** — A stacked-slice fake-volumetric noise field
  (smoke / nebula / ember / ice / toxic / mono) accumulated Beer-Lambert style.
  Reach for it for atmospheric depth without a true raymarcher.
- **`create_voxel_stack`** — An isometric voxel-stack renderer driven by any TOP's
  luminance (Monument-Valley pastel ramps included). Reach for it for blocky,
  data-driven 3D relief.

## Particles & 3D

- **`create_gpu_particle_field`** — A high-count GPU point field (up to ~262k)
  simulated in feedback-TOP loops, optionally energised by audio or camera motion.
  Reach for it for dense particle drift well beyond the CPU emitter.
- **`create_particle_flock`** — The boids variant of the GPU field: separation /
  alignment / cohesion with live knobs. Reach for it for flocking behaviour rather
  than curl-noise/gravity drift.
- **`image_to_particles`** — Turns an image into a particle field where each
  particle's rest position and colour is its pixel; audio scatters and re-forms it
  — the "image dissolves into points on the drop" look.
- **`create_depth_displacement`** — Pushes a subdivided plane into true 3D relief
  by a depth/luminance map. Reach for it for a 2.5D landscape that shifts with the
  camera (use `create_depth_silhouette` for a flat 2D mask instead).
- **`create_depth_pop_field`** — A depth-driven GPU POP scatter field that samples
  a depth/mask TOP for displacement and emission; auto-spins a MediaPipe
  segmentation chain if you give it no depth source.
- **`create_depth_silhouette`** — Extracts a white-on-black body silhouette/mask
  from a depth or video source, optionally colour-filled. Reach for it for
  camera-reactive installations and masks.
- **`create_depth_from_2d`** — Wraps the community TDDepthAnything v2 TOX to turn
  any 2D image/video into a depth map (NVIDIA GPU only). Feed its output into the
  depth tools above. Requires the user-installed TOX.
- **`create_gaussian_splat_scene`** — Drops the community TDGS TOX and loads a
  `.ply`/`.splat` Gaussian-Splat asset with camera binding. Requires the
  user-installed TOX.

## Audio-reactive

- **`create_audio_reactive`** — The all-in-one: an audio analysis chain plus a
  spectrum visual (bars / radial / particle / feedback / LED grid). Reach for it
  when you want a finished audio-driven visual in one call.
- **`create_transient_reactive`** — Splits audio into normalized `transient`
  (percussion) and `sustain` (tonal floor) channels for `bind_to_channel`. Reach
  for it to drive different visuals from hits versus pads.
- **`create_chroma_reactive`** *(experimental)* — A 12-channel pitch-class chroma
  vector for harmonic/key-aware binding.
- **`create_energy_structure`** *(experimental)* — A self-calibrating song-structure
  detector emitting energy, state (breakdown/build/drop) and edge pulses. Reach for
  it to trigger scene changes off the arrangement, not just the beat.
- **`create_midi_note_reactive`** — A MIDI-note → per-note velocity/trigger chain
  with bindable `note0…noteN` channels. Reach for it to drive visuals per key.
- **`audio_fingerprint_to_visual`** — Samples a few seconds of audio, fingerprints
  it, and auto-picks and dispatches a matching generator. Reach for it as a
  one-shot "match the music" starter.

## Camera & motion reactive

- **`create_optical_flow`** — A cheap CPU motion-energy field (bright = motion)
  built from stock TOPs, a drop-in for displacement/particle chains. Not a true
  dense-flow solver — reach for it for fast, no-CUDA motion texture.
- **`create_blob_reactive`** — Tracks the *positions* of multiple blobs/hands in a
  camera and exposes `blob0_x`, `blob0_y`, `blob0_size`, … for binding. The
  per-object counterpart to single-value motion reactivity.
- **`create_vector_lines`** — A pulse-driven image-to-vector-lines system (Trace
  SOP) for clean line-art overlays. Intentionally non-realtime: you press
  Vectorize to update.

Body-pose reactivity lives in its own arc — see
[Body & pose tracking](/guide/body-tracking):

- **`create_pose_reactive`** — Derives scalar reactive channels (hand height, arm
  openness, elbow angle, velocity) from a tracked pose for `bind_to_channel`.
- **`create_pose_controlnet_driver`** — Renders a canonical OpenPose stick figure
  TOP from a pose CHOP, ready to send to a ControlNet / Stable-Diffusion node.

## Video & camera, scopes

- **`create_video_scopes`** — A broadcast monitor (waveform / RGB parade /
  vectorscope / histogram). See [Front-of-house dashboard](/guide/dashboard-foh).
- **`create_waveform`** — A time-domain audio oscilloscope. See
  [Front-of-house dashboard](/guide/dashboard-foh).
- **`create_histogram_scope`** — A standalone luminance (and per-channel RGB)
  histogram scope for any TOP, ready for preview or `bind_to_channel`.

## Text & titles

- **`create_text_overlay`** — Composites styled text over a visual (or on
  transparency) — a finished title/lyric/credits layer ready for `setup_output`.
- **`create_kinetic_text`** — A single word/line that flashes, pulses or slides,
  the signature live-VJ lyric-flash. Reach for it for animated typography; bind the
  LFO to a beat CHOP to lock flashes to tempo.
- **`create_text_crawl`** — Multi-line scrolling ticker / vertical credits roll /
  typewriter reveal. Reach for it for multi-line copy and continuous scrolling
  (use `create_kinetic_text` for a single animated string).
- **`create_text_3d`** — Extruded 3D glyphs with optional spin — title cards and
  3D text drops. Use `create_kinetic_text` instead for flat 2D animated text.

## Signature effects & looks

- **`create_slit_scan`** — The "time-as-space" slit-scan look: each output row
  samples a different past frame from a Cache ring buffer.
- **`create_pixel_sort`** — Kim-Asendorf-style luminance-thresholded pixel-sort
  streaks, with luma/hue/saturation sort keys.
- **`create_ascii_render`** — Turns any TOP into a character-grid ASCII render
  (phosphor-green CRT default).
- **`create_dither`** — Retro ordered-Bayer / error-diffusion dithering to a 2/4/16
  colour palette (Game-Boy duotone default).
- **`create_chrome_blobs`** — A liquid-chrome / Y2K metaball generator with metal
  tints and animated specular highlights.
- **`create_kaleidoscope`** — Folds a source into N mirrored wedges with live
  Segments / Rotation / Zoom / Center.

## Colour & finishing

- **`create_color_grade`** — A lift/gamma/gain + HSV + optional LUT finishing
  stage — the "make the final output look graded" tool.
- **`create_color_wheels`** — Three-way (shadows/mids/highlights) colour wheels
  with per-channel lift/gamma/gain. Reach for it when `create_color_grade` is too
  coarse.
- **`apply_post_processing`** — Chains several distinct effects (bloom, glitch,
  rgb_split, vignette, …) in series over a source. Reach for it to stack effects;
  use a dedicated single-effect tool when you want its own exposed controls.
- **`enhance_build`** — Scores a build and asks the LLM for allowlisted tool calls
  to raise the weakest sub-scores (optionally auto-applying them).

## Shaders & imports

- **`import_isf_shader`** — Imports an ISF (`.fs`) shader as a GLSL TOP with
  auto-generated controls (raw source, file, or URL).
- **`import_shadertoy`** — Builds a GLSL TOP from a Shadertoy URL / ID / pasted
  source, wiring iChannels and exposing Speed/Mouse.

## Installations & studies

- **`moodboard_to_system`** — Ingests 1–6 moodboard images and builds a matching
  generative system (palette + motion + generator pick) via the vision LLM or a
  deterministic grammar.
- **`create_facade_mapping`** — A multi-projector architectural facade rig
  (per-projector crop / corner-pin / edge-blend), shipped as a calibration
  skeleton. See [Output & mapping](/guide/prompt-cookbook#output-mapping).
- **`create_test_pattern`** — A projector calibration/alignment source (grid,
  crosshair, colour bars, ramp, circle-grid) with optional per-projector ID
  overlay.

## Performance & automation

These build engines and lanes rather than visuals — see
[Show timelines & setlists](/guide/show-timelines) for the full transport arc:

- **`create_autopilot`** — A beat-driven auto-VJ that, every N beats, randomizes a
  target's controls or cycles its stored cues.
- **`create_automation_lane`** — Records a live parameter sweep into a ring buffer
  over N bars, then loops it back on a bar-phase clock.
- **`create_chop_recorder`** — Captures a source CHOP over a window and plays the
  take back (persisted across reloads), ready for `bind_to_channel`.
- **`compose_cue_list`**, **`create_setlist_runner`**,
  **`create_phrase_locked_cue_engine`**, **`create_safety_blackout_chain`** —
  covered in [Show timelines & setlists](/guide/show-timelines).

## Body, hands & MediaPipe

Covered in their own guides:

- **`create_pose_tracking`**, **`create_pose_skeleton`**, **`create_body_reactive`**,
  **`create_hand_hologram`** — see [Body & pose tracking](/guide/body-tracking).
- **`setup_body_tracking`** and the face/hand/segmentation adapters — see
  [MediaPipe adapters](/guide/mediapipe-adapters).

## Output & mapping

- **`setup_output`** — Routes a finished TOP to a window, NDI, Syphon/Spout,
  recording or Touch Out — usually the last step.
- **`create_multi_output`** — Fans a master TOP across N projectors with optional
  edge-blend feathering. See [Output & mapping](/guide/prompt-cookbook#output-mapping).

## See also

- [Prompt cookbook](/guide/prompt-cookbook) — these generators in worked,
  copy-paste prompts.
- [Recipe gallery](/guide/recipes) — validated first-party starters for several of
  them.
- [Tools reference](/reference/tools) — the full, generated, per-tool reference
  with every parameter.
