---
description: "Copy-paste prompts for building visuals with tdmcp, the TouchDesigner MCP server — feedback tunnels, audio-reactive, particles, generative art and more."
---

<script setup>
import { withBase } from "vitepress";
</script>

# Prompt cookbook

Copy these, change the words, and make them yours. They're grouped by what you
want to make. After any build, you can always say **"show me a preview"** and then
nudge it: *"warmer", "slower", "more contrast", "add a glitch".*

::: tip How to phrase it
Describe the **result and the feeling**, not the nodes. "A slow, hypnotic, deep-blue
tunnel" works better than naming operators. The AI picks the operators.
:::

## Recipe starters (v0.8.2)

Use these when you want a validated first-party recipe first, then a creative pass.
They are good workshop and rehearsal prompts because they start from schema-checked
networks instead of inventing topology from scratch.

> *"Apply `audio_reactive_basic`, use a test tone if the mic is unavailable, then
> bind the output color to the RMS level and show me the audio Null path."*

<video :src="withBase('/examples/recipe-audio-reactive-basic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A compact audio-in / spectrum / RMS chain with a stable Null CHOP and a TOP output
ready for `bind_to_channel` or manual expressions.*

> *"Apply `keyframe_animation_basic`, add five readable camera/object keyframes, and
> expose one Speed control so I can rehearse the move without touching the graph."*

<video :src="withBase('/examples/recipe-keyframe-animation-basic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The Animation COMP starter gives you declarative motion first: author channels in
TD's Animation Editor, then drive the rest of the look from the resulting CHOP.*

> *"Apply `pose_skeleton_standalone` with its built-in landmark table, render the
> joints as glowing dots and bones, then leave notes for swapping in a live pose
> source later."*

<video :src="withBase('/examples/recipe-pose-skeleton-standalone.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A no-camera pose renderer: static landmarks feed a Script SOP skeleton, useful for
testing a look before the MediaPipe or Kinect source exists.*

> *"Apply `particle_system_basic`, make the emitter drift upward like ash, and expose
> BirthRate, Lifetime and ForceY as the first controls I should perform."*

<video :src="withBase('/examples/recipe-particle-system-basic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A Particle SOP starter with camera, light, point-sprite material and a stable output
Null. Plain enough to teach, complete enough to tweak live.*

> *"Apply `feedback_network_basic`, tune the blur and decay into a high-contrast
> recursive tunnel, and keep the network minimal so I can learn the feedback loop."*

<video :src="withBase('/examples/recipe-feedback-network-basic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Noise seed, composite feedback, blur, level decay and Null output: the smallest
performable feedback network that still behaves like a real visual instrument.*

> *"Apply `glsl_shader_basic`, keep the inline plasma shader editable, and expose
> uTime, uScale, uColorA and uColorB so I can color-match the show."*

<video :src="withBase('/examples/recipe-glsl-shader-basic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A tiny GLSL TOP recipe for shader-first work. It lands as a valid network and keeps
the actual shader source close enough for teaching or fast remixing.*

> *"Apply `kinetic_text_audio_reactive`, write a giant one-word cue, then wire the
> brightness expression to the bass analyze channel after import."*

<video :src="withBase('/examples/recipe-kinetic-text-audio-reactive.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Text TOP plus transform / level chain beside a bass analyzer. The recipe keeps the
manual audio expression explicit instead of hiding it inside invalid schema data.*

> *"Apply `decks_layer_mixer`, make deck A and B clearly different colors, then add a
> Cross control and per-deck gain notes for the VJ operator."*

<video :src="withBase('/examples/recipe-decks-layer-mixer.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The first-party deck recipe is a small mixer skeleton: two sources, two gains,
one composite bus and a stable program output.*

> *"Apply `depth_displacement_post`, use the synthetic depth map to warp a ramp, then
> finish it with blur and level grade so it feels like a real post pass."*

<video :src="withBase('/examples/recipe-depth-displacement-post.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A zero-hardware depth/displace/post stack for rehearsing depth looks before a depth
camera or generated map is available.*

> *"Apply `kinetic_text_path_follow`, put the show title on a circular path, and tell
> me exactly which expressions I need to bind after import."*

<video :src="withBase('/examples/recipe-kinetic-text-path-follow.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A manual-wiring template for path-following type: deterministic sin/cos CHOPs drive
the motion while the recipe stays schema-valid.*

> *"Apply `optical_flow_particles`, route the camera motion into particle drift, and
> leave the output ready for a trails feedback pass."*

<video :src="withBase('/examples/recipe-optical-flow-particles.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Live video becomes an optical-flow field, then pushes particles. It is the
camera-reactive recipe to reach for when body motion should leave visible trails.*

> *"Apply `atemporal_bodytrack_glitch_timeline` to this vertical clip: start clean,
> let short green glitch moments interrupt like a camera bug, return to normal
> between filters, then use the red tracker as small points, lines and trails only
> -- no large circles."*

<video :src="withBase('/examples/atemporal-bodytrack-glitch.mp4')" autoplay loop muted playsinline style="width:100%;max-width:360px;border-radius:8px;display:block"></video>

*A reusable bug-timeline template: clean footage, atemporal green source jumps,
normal recovery beats, then a red body-track branch that reads like object tracking
instead of decorative circles. Keyframe `SceneMode` to perform the edit, then add
glitch ticks/noise only while a filtered branch is active.*

> *"Apply `mediapipe_face_overlay`, dim the webcam underneath, tint the landmark dots,
> and make the overlay easy to swap from demo landmarks to the live face adapter."*

<video :src="withBase('/examples/recipe-mediapipe-face-overlay.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A face-overlay recipe mirroring the newer face-tracking setup: webcam plate, face
landmark CHOP, instanced dots, render and composite.*

> *"Apply `scene_timeline_demo`, build three obvious scenes, then expose play, rate
> and fade controls so I can demonstrate cue timing in one minute."*

<video :src="withBase('/examples/recipe-scene-timeline-demo.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A timer-driven three-scene demo that teaches show-clock thinking without requiring
a full setlist runner.*

> *"Apply `scene_3d_basic`, put a sphere under a camera and light, then bind RotateY
> to a tempo ramp after import."*

<video :src="withBase('/examples/recipe-scene-3d-basic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The smallest 3D renderable scene: geometry, camera, light, Render TOP and Null. A
good base for material, instancing and audio-reactive exercises.*

> *"Apply `video_synth_oscillator`, make a Lissajous oscillator color synth, and keep
> uFreqX / uFreqY / uColor exposed for live tuning."*

<video :src="withBase('/examples/recipe-video-synth-oscillator.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A procedural video-synth starter, no footage required: one GLSL TOP draws a glowing
oscillator curve with show-safe controls.*

> *"Apply `kinetic_text_standalone`, make the word breathe with an LFO, and keep the
> post-import bindings documented so a beginner can finish it."*

<video :src="withBase('/examples/recipe-kinetic-text-standalone.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A text-only kinetic type recipe for lower-friction title cards, countdowns and
cue labels when audio reactivity is not needed yet.*

## Generative & abstract

> *"Create a feedback tunnel from noise with blur and displace, add bloom, and
> show me a preview."*

<video :src="withBase('/examples/feedback-tunnel.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A high-contrast feedback network (blur + displace + bloom), tuned as a showpiece
instead of a plain technical demo.*

> *"Make an evolving reaction-diffusion pattern in greens and blacks, slow and
> organic."*

<video :src="withBase('/examples/reaction-diffusion.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Reaction-diffusion style GPU patterning with sharper contrast and stage-friendly
color, not a flat lab simulation.*

> *"Build a flowing noise landscape in 3D with an orbiting camera."*

<video :src="withBase('/examples/noise-landscape.mp4')" autoplay loop muted playsinline style="width:100%;max-width:560px;border-radius:8px;display:block"></video>

*A noise-displaced 3D terrain.*

> *"Give me a Lorenz strange-attractor visual with glowing particles on black,
> thickened into a tube and evolving only while the timeline plays."*

<video :src="withBase('/examples/strange-attractor.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_strange_attractor` integrates Lorenz / Aizawa / Halvorsen ODEs into a
rolling Script CHOP buffer, renders the trail as SOP geometry and can tube-thicken
it for a real 3D orbit path.*

> *"Give me a 1970s analog video-synth look — soft interference patterns and
> rolling scanlines in electric teal and pink."*

<video :src="withBase('/examples/analog-video-synth.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Procedural lissajous / interference / scanline patterns animated over time with
frequency and color controls — a self-contained Rutt-Etra-style oscilloscope wash,
no footage needed.*

> *"Build a raymarched fractal tunnel I can fly through, glowing cyan on black,
> with a Speed knob."*

<video :src="withBase('/examples/raymarched-tunnel.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A signed-distance-field scene rendered entirely in a GLSL TOP — an infinite tunnel
you fly through, with camera-Speed and color controls. No geometry nodes, all math.*

> *"Build a programmable SDF field from a sphere subtracting a box and a smooth
> torus union, cyan-to-magenta, with live CameraZ / StepCount / Rotate controls."*

<video :src="withBase('/examples/sdf-field-csg-raymarch.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_sdf_field` is the newer CSG raymarcher: compose sphere / box / torus
primitives with union, intersect, subtract and smooth blend, then perform the field
through exposed SDF controls instead of editing shader code mid-show.*

> *"Sculpt a soft, morphing metaball blob in 3D that slowly breathes, iridescent
> surface on a dark stage."*

<video :src="withBase('/examples/shader-park-blobs.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A Shader Park-style SDF sculpt (blended spheres and noise) compiled to a GLSL TOP,
with morph-Speed and surface controls — organic, clay-like volumes that pulse and merge.*

> *"Use these three moodboard images — foggy ocean, oxidized copper and cold
> cathedral light — and build a matching generative system with post-FX."*

<video :src="withBase('/examples/moodboard-to-system-dispatch.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`moodboard_to_system` reads 1–6 images, extracts palette / motion / generator
intent with the configured LLM (or deterministic fallback), then dispatches a
matching Layer-1 system plus post-processing.*

> *"Grow an organic branching system from a single stem, moss green on black, and
> let the growth rate react to the music."*

<video :src="withBase('/examples/growth-system-branching.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*An L-system / turtle-growth generator thickened into renderable SOP geometry, with
controls for generations, branch angle, step length and thickness — useful for vines,
roots, circuitry and living line-art.*

> *"Package the six canonical generative classics — feedback tunnel, spectrum bars,
> noise landscape, particle galaxy, reaction-diffusion and webcam glitch — as a
> portable recipe bundle I can import on another machine."*

<video :src="withBase('/examples/generative-classics-pack.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`generative_classics_pack` starts as a read-only contact sheet of available built-in
recipes, then can write an `import_recipe_bundle`-compatible JSON pack. It is the
quick "known-good classics" export for workshops, fresh installs and offline rigs.*

> *"Pull me into an endless zooming feedback tunnel of my webcam, trailing and
> spinning, deep magenta."*

<video :src="withBase('/examples/feedback-tunnel-infinite.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A dedicated infinite-zoom feedback loop (zoom + rotate + decay) seeded from any
source, with Zoom / Spin / Trail knobs — the classic "falling into the screen" tunnel.*

> *"Fill the frame with a real-time ink-and-dye fluid simulation, cyan and magenta,
> with audio splats on the kick but an auto-LFO when no mic is connected."*

<video :src="withBase('/examples/fluid-sim-ink.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_fluid_sim` builds the advection / pressure / vorticity / dye feedback stack
as GLSL TOPs, exposes viscosity / dissipation / splat controls, and can self-animate
before you plug in a live source.*

> *"Turn this poster image into thousands of particles that explode on the drop and
> then spring back into the original image."*

<video :src="withBase('/examples/image-particles-burst.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`image_to_particles` samples the source pixels as rest positions and colors, then
uses a GPU particle loop so the image can dissolve, scatter and re-form musically.*

> *"Sculpt a cathedral of fused spheres and torus rings in pure signed-distance
> field math, lit from inside with violet, and give me a Camera-Z knob to fly in."*

<video :src="withBase('/examples/sdf-csg-cathedral.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A single GLSL TOP raymarches a CSG tree (union / subtract / smooth-blend of sphere,
box and torus primitives) with live CameraZ, StepCount, Speed, ColorA / ColorB and
Background controls. A whole 3D architectural form built only out of math — no
meshes, no UVs, just one shader sculpting space.*

## Artist studies & installations

These prompts are for visual artists first: gallery loops, stage images, camera
studies, print-like transformations and installation pieces.

> *"Make a murmuration of 4,000 tiny agents that breathe like a flock, with
> Separation / Alignment / Cohesion knobs I can perform slowly."*

<video :src="withBase('/examples/particle-flock-murmuration.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_particle_flock` is the boids surface: a behavioral GPU system where the
image is not a particle effect pasted on top, but a moving crowd with its own social
rules. Good for flocking birds, fish schools, crowd fields and ambient gallery motion.*

> *"Build a curl-noise particle galaxy: hundreds of thousands of points orbiting in
> soft arms, slowly reacting to the room's motion."*

<video :src="withBase('/examples/gpu-particle-curl-galaxy.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_gpu_particle_field` is the high-count field for haze, stars, ash, plankton
and dust. Ask for `reactivity:"motion"` when a camera should energize the drift
without turning the piece into a literal webcam effect.*

> *"Turn the performer into a black cutout with a cyan/magenta rim, then use that
> mask to reveal a generative world behind them."*

<video :src="withBase('/examples/depth-silhouette-neon-mask.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_depth_silhouette` gives installation artists a clean matte: synthetic
source for rehearsal, camera/depth source on-site, blur/threshold/invert controls
for tuning the edge, and an output mask ready for compositing.*

> *"Track four bright blobs from the camera and let each one pull a different
> color field, like visitors moving lanterns through the projection."*

<video :src="withBase('/examples/blob-reactive-installation.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_blob_reactive` turns tracked light spots, hands or objects into channels
such as `blob0_x`, `blob0_y` and `blob0_size`. Use it for participatory installs
where bodies control the artwork without a controller in anyone's hand.*

> *"Rotoscope this source into flowing vector lines: freeze a frame, trace the
> contours, and keep a pulse button so I can capture a new drawing live."*

<video :src="withBase('/examples/vector-lines-rotoscope.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_vector_lines` is a bridge between video and drawing: prepare a mask, freeze
it, trace it through editable SOP geometry, then render or export it. Useful for
plotter studies, live rotoscope, laser-outline tests and print workflows.*

> *"Make a cellular-automata tapestry, blue and amber, with rules that feel like
> woven pixels growing across a wall."*

<video :src="withBase('/examples/cellular-automata-tapestry.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_generative_art` supports `cellular_automata` as a promptable study. It is
especially good when the artist wants a living textile, not a camera effect or a
music visual.*

> *"Fill the floor projection with slime-mold trails: luminous paths search,
> overlap, fade and leave a wet ink memory."*

<video :src="withBase('/examples/slime-trails-ink.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_simulation` with `type:"slime"` gives you decaying trails and search-like
motion. It sits between reaction-diffusion and fluid sim: less scientific diagram,
more living trace.*

> *"Generate a restrained harmony palette from one blue-green hue, build a gradient
> strip, and use it as the color source for the next visual."*

<video :src="withBase('/examples/palette-harmony-study.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_palette` is not only utility plumbing: it is an art-direction tool. Use
harmony rules to define a visual world first, then feed those swatches into grade,
particles, SDF color, typography or projection mapping.*

> *"Create flowing ribbon strokes from a vector field, like long-exposure ink
> calligraphy moving across black."*

<video :src="withBase('/examples/flow-field-ribbons.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_generative_art` with `flow_field` is the promptable version of line motion:
good for calligraphic traces, current maps, wind drawings and data-free motion
studies.*

> *"Make a sculptural relief from a source image: a side-lit surface that rises and
> falls like a gallery wall piece, not a flat video filter."*

<video :src="withBase('/examples/sculptural-relief-gallery.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_depth_displacement` turns brightness or depth into actual 2.5D form with
lighting and orbitable camera controls. Reach for it when the image should become
an object.*

## Audio-reactive

> *"Build a radial spectrum that blooms on the bass and throws chromatic sparks on
> the highs."*

**What you'll get:** an analysis chain (spectrum + level + beat) feeding a visual,
usually with a *Sensitivity* knob. See the
[microphone permission note](/guide/troubleshooting#macos-microphone-camera-permission)
on macOS, or ask for a **test tone** instead of the mic while experimenting.

> *"Build a 3D ball of spikes that stab outward on the bass and shimmer with the
> highs — preview it on a test beat."*

<video :src="withBase('/examples/audio-reactive-3d-spikes.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A rendered 3D geometry whose displacement, scale and rotation are wired to live
audio bands (bass / mid / treble) with a Sensitivity knob — a spiky, breathing solid
that dances to the track. Uses a synthetic source so it previews without mic permission.*

> *"Sidechain this layer to the kick so it ducks down and pumps back on every beat,
> like a compressor."*

*An attack/release envelope follower with gate/duck — sidechain a layer's opacity or
brightness to the kick so it pumps in time, going beyond a plain Lag smoothing. The
"sidechain pump" every electronic producer knows, applied to a visual.*

> *"Split this track into pitch-class color, transient flashes and a slow energy
> structure, then bind each stream to a different part of the look."*

<video :src="withBase('/examples/chroma-transient-energy.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Three newer music-analysis paths: `create_chroma_reactive` exposes 12 pitch-class
channels, `create_transient_reactive` separates percussion from sustain, and
`create_energy_structure` detects build / drop / breakdown edges with adaptive
thresholds.*

> *"Listen to this reference track, fingerprint its tempo / brightness / onset
> density / dynamics, and choose a matching visual system automatically."*

<video :src="withBase('/examples/audio-fingerprint-dispatch.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`audio_fingerprint_to_visual` samples audio, classifies the fingerprint, and
dispatches a tuned generator such as glitch, kaleidoscope, feedback, GPU particles
or audio-reactive geometry. Use `dry_run` first when you want to inspect the choice.*

### MIDI & instruments

> *"Make each note on my MIDI keyboard flash a different colored burst — and let me
> try it without plugging anything in."*

*Maps incoming MIDI notes to per-note reactive channels (a flash or burst per pitch),
with a built-in synthetic note source so it previews and you can rehearse the look
before the gear is connected.*

## Camera & motion reactive

The camera counterpart to audio reactivity — drive a visual from movement or
brightness in front of your webcam.

> *"Make a visual that reacts to movement in front of my webcam, and preview it."*

> *"Drive the feedback amount from how much motion the camera sees."*

> *"React to the room's brightness — bloom up when the lights come on."*

**What you'll get:** an analysis chain exposing *motion* and *brightness* channels
plus a *Sensitivity* knob. Like the mic, the live camera triggers the
[macOS permission popup](/guide/troubleshooting#macos-microphone-camera-permission)
— or ask for a **synthetic test source** to experiment without a camera.

> *"Analyze motion in this clip as optical flow, smooth it, and use the vector field
> to drive a liquid displacement warp — use the bundled Mosaic clip if my camera is
> not ready."*

<video :src="withBase('/examples/optical-flow-vector-field.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_optical_flow` builds a stock-TOP motion field from current vs previous
frames, with Sensitivity / Smoothing / Blur controls. It emits an RG-packed flow TOP
that can modulate displacement, particles or any TOP-driven motion chain.*

> *"Watch the motion in my camera and push 20,000 glowing particles around with it —
> paint trails wherever I move."*

<video :src="withBase('/examples/optical-flow-particles-trail.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The CPU optical-flow field (blur / mono / cache / composite-subtract / feedback) is
wired straight into a GPU particle field as displacement. The result paints visible
motion trails that follow body movement in real time — no CUDA, no extra hardware.*

### Body tracking (webcam, no extra hardware)

Full-body **pose tracking** from a plain webcam, via the free
[MediaPipe plugin](https://github.com/torinmb/mediapipe-touchdesigner) (install once
with `tdmcp install mediapipe-touchdesigner`).

> *"Set up body tracking from my webcam and show me the skeleton."*

> *"Make glowing ribbons track my wrists and shoulders, leaving long neon trails as
> I move — use a synthetic pose source for the preview if the camera is not ready."*

<video :src="withBase('/examples/pose-trails-skeleton.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

> *"Drive the visual's intensity from how much my body is moving."*

**What you'll get:** the MediaPipe engine loaded + an adapter that emits a 33-landmark
pose CHOP (tx/ty/tz/confidence), then a live skeleton, ribbon trail or
camera-reactive visual. Keep the TD timeline **playing** (the plugin captures through
an embedded browser that only runs while playing) and grant camera permission if
macOS asks. No webcam handy? Ask for a **synthetic** pose source to build and preview
the look offline.

### Face, hands & segmentation

> *"Set up MediaPipe face tracking, center the landmarks on the nose tip, and drive
> a glowing mask and eye highlights from the face CHOP."*

<video :src="withBase('/examples/face-tracking-landmarks.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`setup_face_tracking` loads the staged MediaPipe engine and emits a 468-landmark
CHOP (or 478 with iris), centered on the nose tip, ready for parameter binding or
data visualization.*

> *"Track both hands in world coordinates, detect open-palm / pinch gestures, and
> bind the right-hand height to the feedback amount."*

<video :src="withBase('/examples/hand-tracking-gestures.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`setup_hand_tracking` reuses the same MediaPipe engine and emits
`max_hands × 21` samples with tx / ty / tz / confidence / handedness channels.
Use `coordinate_space:'world'` when gesture depth matters.*

> *"Segment the performer from the webcam, feather the mask by 4 px, publish a
> clean alpha matte and a pre-keyed person RGBA TOP for compositing."*

<video :src="withBase('/examples/segmentation-alpha-matte.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`setup_segmentation` enables the MediaPipe selfie-segmentation path and publishes
a mask Null TOP plus optional `person_rgba` output, so body mattes can feed keyers,
silhouettes, particles or background replacement.*

> *"Track my face landmarks and stitch a glowing wireframe mask over my features,
> with a dim webcam underneath."*


*The MediaPipe ENGINE adapter publishes a 468-landmark CHOP (or 478 with iris) and
the recipe instances dots and lines on every landmark, composited over a
`levelTOP`-dimmed camera feed with Tint and Dim controls. Real face-mesh overlay,
zero plugin hunting.*

> *"Use my hand in the camera as an XY pad — pinch to confirm — and map it to the
> feedback Decay and Hue of the current visual."*


*The 21-landmark hand CHOP (world coords) feeds an XY pad whose X/Y come from the
index-finger tip; thumb-to-index distance gates a confirm event that latches the
current XY into target parameters. A hand-as-MIDI controller with pinch-to-commit.*

> *"Cut me out of my room with selfie segmentation and put me inside a slow
> raymarched nebula like I stepped through a portal."*


*The selfie-segmentation alpha mask plus a pre-keyed `person_rgba` TOP are
composited over a raymarch background, so the artist appears to stand inside the
generated scene with soft real-time matte edges — greenscreen without a greenscreen,
and the background is a procedural cosmos.*

## Particles & 3D

> *"Build a dense field of instanced 3D blocks that breathe with a noise wave and
> leave a neon depth trail as the camera orbits."*

<video :src="withBase('/examples/scene-3d.mp4')" autoplay loop muted playsinline style="width:100%;max-width:560px;border-radius:8px;display:block"></video>

*A denser instanced-geometry scene with depth, color variation and live motion, useful
as a base for audio, camera or timeline modulation.*

**What you'll get:** a particle or geometry system with live *Drag / Turbulence /
Gravity / Lifetime* knobs to shape the motion.

> *"Show a polished metallic sphere on a turntable with realistic studio lighting
> and soft reflections."*

<video :src="withBase('/examples/pbr-product-spin.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A physically-based 3D scene (PBR material + environment lighting + Render TOP) with
roughness/metalness and a spin knob — a believable studio render of a primitive, not
a flat-shaded toy.*

> *"Make a slowly-drifting point cloud of a sphere, tiny glowing points that twinkle,
> on deep black."*

<video :src="withBase('/examples/point-cloud-drift.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A point-cloud render of a sampled surface (sphere, grid or model) as thousands of GPU
points with size/jitter and drift controls — the LiDAR/scan look without a scanner or
PLY file.*

> *"Push my webcam image into 3D relief so bright areas pop toward the camera, lit
> from the side."*

<video :src="withBase('/examples/depth-displacement-relief.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A plane displaced into real 2.5D geometry by a depth/luminance map via a GLSL MAT
vertex stage, with depth-Amount and lighting — your image becomes a sculpted, side-lit
terrain you can light and orbit.*

> *"Render a 3D scene with ambient-occlusion shadows and use its depth to push another
> image into relief — and I don't own a depth camera."*

<video :src="withBase('/examples/multipass-depth-no-camera.mp4')" autoplay loop muted playsinline style="width:100%;max-width:560px;border-radius:8px;display:block"></video>

*A multi-pass 3D render (Render + SSAO pass) that also emits a synthetic depth output,
which then feeds depth-displacement or silhouette — contact-shadowed 3D plus a depth
map manufactured in software, no depth sensor required.*

> *"Add cinematic 3D post passes to this scene: SSAO contact shadows, a little SSR,
> shallow depth of field and motion blur on fast moves."*

<video :src="withBase('/examples/post-passes-3d-cinematic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:560px;border-radius:8px;display:block"></video>

*`post_passes_3d` is the dedicated 3D finishing chain for depth/normal/velocity-aware
looks; `apply_post_processing` redirects SSAO / SSR / DOF / motion-blur requests here
instead of pretending those passes work on a flat TOP.*

> *"Build a torus POP-style geometry rig with two subdivisions, animated noise
> displacement and live RotateY / NoiseAmount controls, ready to render."*

<video :src="withBase('/examples/pop-geometry-noise-rig.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_pop_geometry` wraps a procedural primitive → transform → optional subdivide
→ noise → material SOP chain in a complete render rig. Use it when you want an
editable geometry object, not just a shader pretending to be 3D.*

## Video & camera

> *"Pipe my webcam through edge detection, an RGB split and a feedback loop for a
> glitchy look."*

<video :src="withBase('/examples/video-glitch.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The glitch / VHS look — scanlines, RGB split and datamosh (shown on a synthetic
source rather than a live webcam).*

> *"Take my webcam and make it look like an old, degraded VHS tape."*

> *"Set up two video decks with a big crossfader so I can blend between two clips
> like a DJ."*

<video :src="withBase('/examples/dj-decks-crossfade.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A/B decks blended by a master crossfader (Cross TOP) with per-deck gain; each deck
pulls a source TOP or a built-in test source — the visual equivalent of a DJ mixer,
the core of any VJ rig.*

> *"Build a four-deck VJ mixer: camera, loops, generative layer and logo sting, each
> with gain and FX-send, plus a hard-cut selector for live transitions."*

<video :src="withBase('/examples/nchannel-decks-fx-send.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_decks` now has an N-channel mode: 2-8 decks, per-deck gain, per-deck FX
send, a continuous program mix and a transition-cut bus. Use the old A/B prompt for a
simple crossfader; use `decks[]` when the rig starts feeling like a real VJ mixer.*

> *"Put waveform, RGB parade and vectorscope next to this camera feed so I can tune
> the grade before the show opens."*

<video :src="withBase('/examples/video-scopes-monitor.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_video_scopes` builds a broadcast-style monitoring surface for a TOP source:
waveform, parade and vectorscope panels that make color / exposure problems visible
before they become projector problems.*

> *"Add a luminance histogram scope to this camera feed with 128 bins, log scale and
> a phosphor-green trace so I can see crushed blacks before the projector does."*

<video :src="withBase('/examples/histogram-scope-rgb.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_histogram_scope` turns a TOP into a previewable histogram panel using a
GLSL bin pass, TOP-to-CHOP normalisation and a rendered trace. It can run from a
test pattern, file, existing TOP or live device.*

> *"Put a broadcast-style RGB+luma histogram scope on the corner of my output so I
> can see if I'm crushing blacks."*


*A combined RGB + luma variant of `create_histogram_scope` — bars rendered through
Script SOP + Render TOP into a Null you can overlay on program output. The proper
engineer's video scope a colorist keeps on a second monitor.*

## Text & titles

> *"Build an alpha-safe lyric hit: flash the word 'DROP' huge on the beat, then
> make it vanish cleanly between hits over the running visual."*

<video :src="withBase('/examples/kinetic-lyrics-flash.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_kinetic_text` in `mode: "flash"` creates a Text TOP, LFO, alpha gate and
optional composite over an input TOP. The important bit for show visuals: the text
goes transparent between hits instead of flashing black.*

> *"Make a pulsing lower third for the vocalist: artist name, stage label and a
> small beat indicator, composited over the program feed."*

<video :src="withBase('/examples/kinetic-lower-third-pulse.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Use `create_text_overlay` for the title-safe layer, then swap to
`create_kinetic_text` in `mode: "pulse"` when the lower third should breathe with
the track rather than sit flat.*

> *"Create a setlist ticker along the bottom of the output: current section, next
> cue, stage side and artist note, looping forever."*

<video :src="withBase('/examples/text-crawl-setlist-ticker.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_text_crawl` with `mode: "crawl_horizontal"` is the ticker-tape layer for
running copy, countdowns, stage manager notes and installation status messages.*

> *"Roll the end credits upward over the final ambient scene, with a slow fade at
> the top and bottom of the frame."*

<video :src="withBase('/examples/text-roll-credits-stage.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The same `create_text_crawl` tool in `mode: "roll_vertical"` handles multi-line
credits, artist statements and gallery wall text. Use `\n` to keep each line
editable.*

> *"Reveal a short manifesto one character at a time before the installation opens:
> 'NO PREVIEW / NO PANIC / BUILD THE LIGHT / THEN PERFORM IT'."*

<video :src="withBase('/examples/typewriter-manifesto-reveal.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_text_crawl` also exposes `mode: "typewriter"` for character reveals. It is
marked experimental in the tool docs, so use it for rehearsal or generated docs and
verify the Text TOP expression on the target TouchDesigner build before a show.*

> *"Make my festival name as chunky extruded 3D chrome letters, slowly rotating with
> a spotlight."*

<video :src="withBase('/examples/3d-extruded-title.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_text_3d` builds Text SOP -> Extrude SOP -> material -> Camera/Light/Render
as a self-contained title scene, with live Spin and Depth controls.*

> *"Turn the word 'NOISE' into SOP geometry, add point noise, and render it like a
> warped text sculpture instead of a flat card."*

<video :src="withBase('/examples/pop-text-noise-sculpture.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_pop_geometry` with `primitive: "text"` and `text_string` makes text part of
the geometry pipeline. Add `noise_amount` when the title should feel like a living
object rather than a caption.*

> *"Generate a projector alignment pattern labelled OUTPUT 02 / LEFT so the crew can
> identify the physical surface from across the room."*

<video :src="withBase('/examples/projector-label-test-pattern.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_test_pattern` can draw calibration grids, crosshairs, output numbers and
labels. It belongs in Text & titles because these labels are the typography that
keeps an installation understandable during setup.*

> *"Map my MIDI pads to words: KICK, BASS, SNARE, VOX, CLAP and PAD should each
> flash as their note channel fires."*

<video :src="withBase('/examples/midi-note-type-hits.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Pair `create_midi_note_reactive` with `create_kinetic_text` when typography should
respond to individual note events instead of a global audio level.*

> *"Put the title 'DEEP FIELD' on a circular path and let the letters orbit around
> the center before the main scene begins."*

<video :src="withBase('/examples/path-title-orbit.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Apply the `kinetic_text_path_follow` recipe when the title needs to follow a path:
orbit bugs, circular show logos, moving labels around sculptures and wayfinding
loops.*

**What you'll get:** a performable typography kit: alpha-safe lyric hits, pulsing
lower thirds, ticker crawls, rolling credits, typewriter reveals, extruded 3D text,
noisy text geometry, projector labels, MIDI-triggered words and path-follow titles.

## Live performance & control

> *"Add knobs for feedback, zoom, spin and blur so I can perform this live."*

> *"Animate the spin knob with a slow LFO."*

> *"Make a tempo clock at 128 BPM and sync the movement to the beat."*

> *"Lock the tempo to Ableton Link so it follows whatever's on the network."*

> *"Bridge Ableton Live into TouchDesigner: clips, tracks, transport and device
> macros as named CHOP channels, with an OSC fallback if TDAbleton is not installed."*

<video :src="withBase('/examples/tdableton-bridge.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`setup_tdableton` probes for the Palette component first, then falls back to a plain
OSC In bridge, so the same show patch can rehearse without a perfect studio setup.*

> *"Turn my webcam hands into a four-channel Ableton Auto Filter controller through
> TDAbleton, without AbletonMCP. Use MediaPipe hand tracking, build a skeleton
> overlay with star joints, publish `mapper_send` so `map1` is left pinch, `map2`
> is right pinch, `map3` is left wrist roll and `map4` is right wrist roll, then
> diagnose the `TDA_Mapper` routing before I map the four slots in Ableton."*

*`create_hand_ableton_mapper` builds the TouchDesigner side of the performance
controller and `diagnose_tdableton_mapper` checks the mapper path, input CHOP,
`Reorder`, bypasses and ranges. The runtime path is TouchDesigner -> TDAbleton
`TDA_Mapper` -> Ableton mapped Auto Filter or rack macro parameters; AbletonMCP is
not required.*

> *"Follow the MIDI clock coming from my DJ software."*

> *"Set up two cues — 'intro' and 'drop' — that I can morph between."*

> *"Let me control the main knobs from my phone."*

> *"Map my MIDI controller's first fader to the Sensitivity knob."*

> *"Going live now — turn on perform mode so nothing hitches mid-show."*

<video :src="withBase('/examples/perform-mode-rest-toggle.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`set_perform_mode` now prefers the hardened `POST /api/perform` endpoint and
returns a typed snapshot showing whether the root store, UI perform mode and project
perform mode were actually set. It still falls back for older bridges, but the
show-time path is a real REST call.*

> *"Build me an Ableton-style grid of buttons so I can trigger my saved looks live
> with one tap each."*

*A grid of cue-trigger buttons (reusing the cue recall/morph engine) — tap a cell to
jump or morph to a stored scene, openable in Perform mode as a touch surface. An
Ableton Session-view clip grid for your visuals.*

> *"Make a 16-step beat grid that fires a strobe on the downbeats and an effect on
> the off-beats, locked to my tempo."*

*A bar/beat step grid that fires a parameter or cue per active step — the
deterministic, programmable counterpart to the auto-VJ. Toggle steps to compose a
repeating pattern locked to the clock, like a drum machine for visual events.*

> *"Build a probabilistic sequencer where calm usually drifts to shimmer, shimmer
> sometimes jumps to a glitch burst, and blackout only happens on rare drops."*

<video :src="withBase('/examples/prob-sequencer-markov.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A Markov step sequencer for show states: on each beat it samples the weighted
transition table, emits `state` and `trigger`, and drives cues or parameters without
repeating a fixed loop.*

> *"Build a three-scene timeline for a 128 BPM set: intro is a feedback tunnel,
> drop is an audio-reactive spike ball, breakdown is a cinematic color wash. Make
> it scrubbable and keep the setlist slot ids."*

<video :src="withBase('/examples/scene-timeline-arranger.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A show-master timeline: scenes become blocks on a Timer-CHOP playhead, cue recalls
land at scene boundaries, and downstream tools can keep setlist slot references
attached to each scene.*

> *"Scan this folder of loops and make a beat-quantized auto-montage that shuffles
> clips every bar with a half-second crossfade."*

<video :src="withBase('/examples/auto-montage-shuffle.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A self-running media-bin switcher: source clips/stills feed a Switch TOP, a
bar/beat/interval clock advances the index, and shuffle/random/weighted modes avoid
the same clip hanging around too long.*

> *"Create a Euclidean sequencer with 5 hits over 16 steps, and bind the hits to a
> strobe, a glitch burst and the preset-morph amount."*

<video :src="withBase('/examples/euclidean-strobe-pattern.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Bjorklund-style rhythm for visuals — sparse, musical pulses that can fire cue,
parameter or script callbacks instead of a plain metronome.*

> *"Blend between four stored looks with a single Morph knob, weighted so I can sit
> halfway between neon cyan and warm amber during the breakdown."*

<video :src="withBase('/examples/preset-morph-blend.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A true N-way preset blend: instead of snapping from one cue to another, saved
parameter states become weights in a morph table you can automate, MIDI-map or drive
from a scene timeline.*

> *"Record my filter cutoff sweep over four bars, then loop it as an automation
> lane so I can take my hands off during the drop."*

<video :src="withBase('/examples/automation-lane-loop.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_automation_lane` samples a target parameter into a bar-phased buffer, then
plays it back through a Lookup CHOP. Re-call the same lane in `record` or `loop` mode
to arm, capture and perform reusable knob moves.*

> *"Record my hand-controller CHOP for eight bars, loop the best take, and scrub it
> back as a reusable modulation source."*

<video :src="withBase('/examples/chop-recorder-replay.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_chop_recorder` turns any CHOP stream (OSC, MIDI, audio feature, pose or
custom control) into a capture / playback / loop surface, so a live gesture can become
part of the rig instead of disappearing after rehearsal.*

> *"At bar 32 fire the drop cue, at bar 64 start the auto-montage, and at the end of
> the track freeze the output until I clear it."*

**What you'll get:** a scheduler primitive built around named timers/segments. Use it
for small timed callbacks, or put `create_scene_timeline` above it when you want a
scrubbable song-mode arranger.

> *"Build a phone dashboard with cue buttons for intro/drop/break, two master
> faders, a live VU strip, and big Blackout / Freeze buttons for panic recovery."*

<video :src="withBase('/examples/live-dashboard-panic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A single live-performance cockpit served from TouchDesigner: cue launch, faders,
readout and panic controls in one phone/laptop page. Keep it on a trusted network.*

> *"Upgrade the stage dashboard to layout v2: stereo VU, BPM from
> `/project1/tempo_null`, cue timeline markers from my setlist and a sticky
> confirm-tap PANIC bar."*

<video :src="withBase('/examples/stage-dashboard-v2.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_stage_dashboard` with `layout:"v2"` keeps the original dashboard path
compatible while adding front-of-house readouts: stereo VU, BPM, FPS / cook overlay,
cue timeline strip and a safer two-step panic surface.*

> *"Dry-run the AI show director: allow a pre-approved band intro cue, queue a
> three-second fog request for operator approval, and block a blackout request."*

<video :src="withBase('/examples/show-director-policy-queue.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp-agent show-director` is a policy surface, not an unsafe hardware trigger. It
validates structured show intents, returns allow / approval / block decisions, keeps
an approval queue and audit log, and marks every action plan as dry-run-only until a
human/operator path resolves it.*

> *"Plan a 20-minute set across my three scenes in dry-run mode first — show me
> what the AI director will do before it touches anything."*

<video :src="withBase('/examples/show-director-policy-queue.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_autopilot` runs each show-directing call through the policy layer in
dry-run mode and returns the planned action + rationale (which scene, which
transition, when) so the artist can preview an autonomous set before it touches
the bridge. Approve, edit or reject before the show runs.*

> *"Give me a front-of-house dashboard with stereo VU meters, live BPM from my
> tempo detector, FPS overlay, the next-cue strip, and a sticky PANIC bar."*

<video :src="withBase('/examples/stage-dashboard-v2.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The `layout:"v2"` build of `create_stage_dashboard` adds a stereo VU pair, a BPM
readout fed by a `detect_tempo` Null CHOP, an FPS / cook-time / frame overlay, a
cue-timeline strip from a `compose_cue_list` pair array, and a confirm-tap PANIC
bar — without breaking the v1 dashboard byte-for-byte.*

> *"Jump my timeline to the chorus cue, set playback rate to 1.25, and start
> playing — through the fast REST path, not a Python exec."*

<video :src="withBase('/examples/transport-rest-cue.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`control_timeline_transport` now prefers the new `POST /api/transport` endpoint
for play / pause / seek / cue / rate and falls back to `executePythonScript` only
on older bridges. Transport jumps become a real REST call — fast enough to land on
a downbeat.*

> *"Lock the show to incoming OSC timecode, follow the timeline frame-for-frame, and
> jump to named cues if the timecode label says chorus or blackout."*

<video :src="withBase('/examples/timecode-sync-lock.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`sync_timecode` wires MTC / LTC / OSC timecode into a normalized CHOP and can drive
the TD timeline. Pair it with `control_timeline_transport` for explicit play, pause,
seek, rate and cue commands.*

> *"Schedule the lobby installation: start the ocean scene every weekday at 09:00,
> switch to the dusk set at 18:00, and dry-run the schedule first."*

<video :src="withBase('/examples/schedule-lobby-install.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp-agent schedule` is the cron-lite companion for unattended installs. It uses
wall-clock scheduling with timezone handling, can dry-run, and can fire commands,
cues or setlists.*

> *"Record the next few MCP tool calls as a macro called soundcheck, then replay it
> on the second machine after the stage network comes online."*

<video :src="withBase('/examples/macro-recorder-soundcheck.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Use `macro_recorder` to capture a portable JSON macro and `run_macro_script` to
replay it later. The CLI side can also fan out a command to multiple remote agents
when several TD machines need the same setup.*

> *"Add a kill/dimmer safety chain to the master output with a 2-second fade and
> a panic Emergency button I can hit from a phone."*

<video :src="withBase('/examples/safety-blackout-chain.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_safety_blackout_chain` wraps your program TOP with a Level/dim pass driven
by a `safety_dim` Null CHOP (0 = lit, 1 = fully black), a Speed-controlled 2-second
fade, and an exposed `Panic` toggle. Bind `safety_dim` to a phone fader with
`bind_to_channel`, or wire a hardware "dead-man" button to flip Panic. Works fully
offline and is safe to install on a `TDMCP_BRIDGE_ALLOW_EXEC=0` bridge.*

> *"Build a timed setlist that cycles through three scenes — intro 30s, drop 60s,
> outro 45s — with 2-second crossfades and a HUD showing now/next/remaining."*

<video :src="withBase('/examples/setlist-runner-hud.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_setlist_runner` lays down a Timer CHOP with one segment per scene plus a
crossfader bus and a Text TOP HUD reading now/next/remaining seconds. The
`param_engine` Parameter Execute DAT watches Play/Row/Skip/Prev so you can override
the schedule live — pause on a scene, skip ahead, or rewind without rewriting the
timer.*

> *"Wrap my NDI input in a watchdog that auto-switches to a pre-rendered MP4 if
> the camera drops, with a 250ms crossfade and a sticky-recover toggle."*

<video :src="withBase('/examples/show-failover-watchdog.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_show_failover` runs an Info CHOP on the live source and watches the
`total_cooks` delta — when it stops climbing the watchdog routes a Switch TOP to
the backup MoviefileIn over a 250ms crossfade. The `sticky_recover` toggle stops it
ping-ponging back the instant NDI flickers, so the show doesn't strobe on a flaky
camera.*

> *"Bind my body pose to the visual: when I raise my right hand the kaleidoscope
> rotates, and when I open my arms the bloom intensity doubles."*

<video :src="withBase('/examples/pose-reactive-bindings.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Chain `setup_body_tracking` (MediaPipe pose source) into `create_pose_reactive` to
get named CHOP channels per joint plus derived gestures (`right_hand_up`,
`arms_open`, `lean_left`). Map those to your kaleidoscope rotation and bloom level
parameters — the pose becomes a controller surface, no MIDI required.*

> *"Build my reactive but use the new transient gate so claps fire a strobe, and
> duck the bloom on every kick like a sidechain compressor."*

<video :src="withBase('/examples/audio-reactive-gate-duck.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_audio_reactive` now takes `transient_gate:true` (+ `transient_threshold`,
`transient_hold_ms`) and `sidechain_duck:true` (+ `duck_depth`, `duck_release_ms`)
to add gate and duck modulation channels into the same network. Defaults stay off,
so existing reactive containers are byte-identical — opt in only when you want the
new buses.*

## Output & mapping

> *"Output the final visual to a full-screen window on my second monitor."*

> *"Send this out over NDI so I can use it in OBS."*

> *"Corner-pin this onto a projector and let me drag the corners."*

<video :src="withBase('/examples/projection-mapping.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A source warped through a corner-pin keystone — drag the four corners to line it
up with a wall, screen or object.*

> *"Record the output to a movie file for 30 seconds."*

> *"Inspect the GPU and connected displays, then tell me which output plan is safe
> for this projector rig."*

> *"Bridge this TOP over shared memory to the Unreal machine, and receive a CHOP
> control stream back from the lighting process."*

> *"Build a DMX fixture pipeline for eight RGBW bars over Art-Net universe 1, with
> dimmer, color and strobe channels exposed."*

> *"Create a starter `TDMCP_*` config file for this show laptop, but leave secrets
> commented out and refuse to overwrite the existing file unless I pass force."*

<video :src="withBase('/examples/config-init-env-scan.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`tdmcp-agent config init` prints or writes the complete `.env` surface the server reads,
with bridge/LLM secrets commented for manual entry. It is a small tool, but it makes
touring-machine setup repeatable instead of tribal knowledge.*

> *"Set up a two-projector rehearsal for the AI-Controlled Party — one wall for the
> main visual, one for the lyrics — and synchronise them on the same cue list."*

<video :src="withBase('/examples/ai-party-two-projector-rehearsal.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_multi_output` wires two `outTOP`s to two physical displays via
`setup_output`, sharing a single `compose_cue_list` clock so the lyric overlay
flips in lockstep with scene changes. Mirrors the two-wall ensaio rig the
AI-Controlled Party uses for offline rehearsals.*

**What you'll get:** stage-prep tools for displays, GPU capability, DMX / Art-Net,
shared-memory IPC and multi-agent fanout. These are infrastructure surfaces, so the
useful output is usually a verified routing report rather than a pretty preview.

## Fixing & understanding

> *"Something looks broken — check the network for errors and fix them."*

> *"The output is black — look at it and tell me why."* (combines the preview,
> topology and node errors to diagnose)

> *"Take an inline preview of `/project1/out1`: give me a 256 px thumbnail, cook
> metadata, changed parameters and any parent errors in one structured answer."*

<video :src="withBase('/examples/inline-preview-snapshot.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`get_inline_preview` is the compact inspection pass for agents: one call returns
a bounded thumbnail, resolution / pixel-format / cook stats, changed parameters
and a parent error sweep without juggling separate preview and error tools.*

> *"Explain what this network is doing, step by step."*

> *"Read parameter modes for every important node under `/project1/hero` in one
> batch, then tell me which parameters are expressions, binds or exported channels."*

<video :src="withBase('/examples/param-modes-batch-inspector.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The `POST /api/param_modes/batch` bridge path lets agents inspect expression,
bind, export and constant modes for many nodes in one round-trip. It replaces the
old N-way exec loop when you need to understand why a rig is reacting, stuck or
overridden.*

> *"This is running slow — find the bottleneck and optimize it."*

> *"Score this build on palette, motion, complexity, errors and performance, then
> suggest the smallest changes that would improve it."*

<video :src="withBase('/examples/score-enhance-loop.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`score_build` is read-only and returns a 0–100 rubric with deterministic
suggestions. `enhance_build` can preview or apply a small allowlisted improvement
loop, then rescore so you can see whether the intervention helped.*

> *"Extract the five dominant colors from `/project1/look/out1` and use them as
> swatches for the next palette and grade."*

<video :src="withBase('/examples/palette-extraction-swatches.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`extract_palette` captures a TOP preview and runs deterministic k-means on the
pixels. It is read-only, so it is safe to use for critique loops, palette hand-offs
and "make the next look match this one" prompts.*

> *"Ask the vision copilot what dominates this TOP, whether the subject is readable
> from the back of the room, and which one change would improve it."*

<video :src="withBase('/examples/copilot-vision-critique.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`copilot_vision` sends a rendered TOP plus your question to the configured
multimodal LLM. It complements deterministic tools like `caption_top` and
`score_build` when you want an art-direction answer, not only measurements.*

> *"I know I want `create_audio_reactive`, but I only said 'microphone neon bars' —
> infer the missing required arguments from the schema and show me the proposed call."*

<video :src="withBase('/examples/missing-args-elicit.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`elicit_missing_args` uses the registered tool schema plus chat context to propose
only the missing fields. It is read-only and useful for agents that should ask fewer
manual follow-up questions without inventing unsupported parameters.*

> *"Profile cook cost for 60 frames and rank the nodes most likely to cause a frame
> drop."*

> *"Audit this project — what's unused, what file paths are broken, which COMPs are
> orphaned?"*

> *"Tidy up the layout so I can read it."*

> *"Swap this `noiseTOP` into a `rampTOP`, keep the name and wires, preserve any
> matching parameters, and report what could not be carried across."*

<video :src="withBase('/examples/swap-operator-rewire.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`swap_operator` is the careful version of "replace this node": it snapshots wires
and parameters, recreates the operator type in place, reconnects what it can and
returns dropped parameters/failures explicitly.*

> *"Box up the audio chain with an annotation and label it, then list what's inside."*

> *"Try to repair this broken render chain — but if the error count goes up, roll
> back every change you made."*

<video :src="withBase('/examples/repair-network-rollback.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`repair_network` now snapshots `(par.path, par.mode)` and `(op.path, op.bypass,
op.display)` before each step. If `errors_after >= errors_before` and it isn't a
dry run, every applied step is reversed and the report carries a `rolled_back:
true` flag — a self-undoing repair pass, the safety net every artist wanted from
"AI, fix it".*

> *"Run an auto-repair loop on `/project1` — three passes max, stop if errors
> stop going down, and roll back any pass that makes things worse."*

<video :src="withBase('/examples/auto-repair-loop-passes.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`auto_repair_loop` is the "fix everything" verb: it drives `repair_network` in
iterations, scores `errors_before`/`errors_after` per pass, halts on a no-progress
plateau, and inherits the same rollback safety. One call instead of a manual
repair/check/repeat loop.*

> *"Pull the dominant colours out of my hero clip and use them to seed a matching
> colour grade for the rest of the show."*

<video :src="withBase('/examples/palette-extract-and-grade.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`extract_palette` samples the TOP's preview via `get_preview` and runs
deterministic k-means on the decoded RGB pixels, returning weighted hex swatches
that feed directly into `create_color_grade` lift / gamma / gain targets. The AI
brings the rest of the show into the same palette as your hero clip — no eyedropper.*

## Reusable looks & show handoff

Use these when a look is working and you want to perform it again, teach it, take
it to another room or turn it into a physical output.

> *"Make this hero look tour-ready: expose Speed, Palette, Glow and Reset controls,
> add clear labels, save it as a portable `.tox`, and include a preview image so I
> can recognize it before I open TouchDesigner."*

<video :src="withBase('/examples/portable-tox-readme-package.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The packaging tools are useful when they serve the artist: a portable `.tox`,
visible controls, simple notes and a thumbnail of the actual output. The result is a
visual instrument you can drop into a show, not a developer handoff exercise.*

> *"Turn `/project1/hero_look` into a workshop starter: keep the visual network,
> capture the controls I should explain, and make it easy to apply in a blank
> project next week."*

<video :src="withBase('/examples/scaffold-recipe-from-network.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`scaffold_recipe_from_network` can turn a finished TD subtree into an apply-able
recipe. Framed for artists, the point is repeatable teaching and rehearsal: rebuild
the look from a clean project, then adjust the exposed controls in front of people.*

> *"Make me a one-page map of this patch: final-output thumbnail, the three controls
> I should touch live, and a simple left-to-right diagram of how signal becomes
> image."*

<video :src="withBase('/examples/readme-mermaid-docs.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Generated patch notes are only useful here when they read like a studio map: what
the look is, which controls matter, what feeds the output and what the current
preview looks like.*

> *"Save this look with three variants — slow ambient, high-energy chorus and
> blackout-safe — then tag the favorite so I can find it fast during the next
> rehearsal."*

<video :src="withBase('/examples/library-tag-version-loop.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Vault tagging, variants and version notes help artists keep a live library sane:
the question becomes "which look do I trust for this cue?", not "which file did I
export last month?"*

> *"Build a bass smoothing control chain named `bass_energy`, `bass_peak` and
> `bass_gate`, then show me where to bind brightness, blur and pulse on the
> current visual."*

<video :src="withBase('/examples/audio-reactive-gate-duck.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Layer-2 chain builders are artist-facing when they produce clean modulation
sources with readable names. You get stable channels to perform with, while the
underlying CHOP details stay editable when you want to learn them.*

> *"Export this generative line sculpture as SVG polylines for my AxiDraw, matching
> the preview scale and orientation so the plot feels like the screen version."*

<video :src="withBase('/examples/sop-to-svg-plotter.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`export_sop_to_svg` reads SOP primitives and writes plotter-ready vectors. It is
the bridge from live generative motion to pen plotters, lasers and print.*

## Shader & material authoring

> *"Create a GLSL material for this sphere: iridescent oil-slick bands, a soft rim
> light and a `uTime` uniform I can drive from the timeline."*

<video :src="withBase('/examples/glsl-material-iridescent.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_glsl_material` scaffolds the GLSL MAT plus companion Text DATs, wires the
pixel/vertex shader sources, and warns about TouchDesigner GLSL footguns such as
missing `fragColor`, F1/F2 preamble collisions and undeclared `uTime`.*

> *"Import this Shadertoy sketch, wire the iChannels with placeholders if needed,
> expose Speed and Mouse controls, and preview the translated GLSL TOP."*

<video :src="withBase('/examples/import-shadertoy-nebula.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`import_shadertoy` maps `iTime`, `iResolution`, `iMouse` and `iChannelN` into
TouchDesigner-friendly uniforms / TOP inputs. Paste `raw_source` when you want the
whole import to stay offline.*

> *"Import this ISF shader, generate a clean custom-parameter page from its INPUTS,
> and keep the GLSL editable in TouchDesigner."*

<video :src="withBase('/examples/import-isf-plasma-controls.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`import_isf_shader` parses the ISF JSON header and turns float / color / bool /
event / long inputs into TouchDesigner controls, so shader-library sketches become
performable networks instead of pasted code blobs.*

> *"Turn this GLSL TOP sketch into a material on the 3D logo, expose Color, Speed
> and Fresnel, then render a preview."*

**What you'll get:** a shader-authoring pass that keeps the code editable in DATs
while making the important uniforms performable as TouchDesigner controls.

## Signature effects & looks

> *"Fold my webcam into a slowly-rotating six-fold kaleidoscope, deep jewel tones,
> and show me a preview."*

<video :src="withBase('/examples/kaleidoscope-webcam.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A live polar-fold GLSL mirror turns any source into a symmetric mandala; exposes
Segments and a rotation/Speed knob. Pointed at the webcam it makes the room bloom
into kaleidoscopic petals.*

> *"Make my video look like a corrupted file that smears and melts on every hard
> cut — heavy datamosh."*

<video :src="withBase('/examples/datamosh-pixel-melt.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A feedback-driven pixel-displacement smear that bleeds motion vectors across frames,
with Amount/Decay controls — the classic "broken codec" bloom-and-melt look on a
default test source (swap in your clip).*

> *"Turn this into warm, amber-tinted halftone dots like a vintage newspaper print,
> and preview it."*

<video :src="withBase('/examples/halftone-amber-print.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A GLSL halftone screen converts the image into a grid of ink dots whose size tracks
brightness; exposes Dot scale / Angle / tint. Amber tint plus paper-white background
gives a retro-print feel.*

> *"Make this source look like a Game Boy fever dream: 4-color ordered dither,
> crunchy pixels, animated threshold and live Mix control."*

<video :src="withBase('/examples/dither-gameboy-poster.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_dither` builds ordered Bayer / checker / noise / error-diffusion dither
with mono, duotone or RGB quantization. It is a look, not just a utility filter.*

> *"Generate a stained-glass Voronoi field with animated seeds, thick dark lead
> lines and palette controls for Color A / Color B."*

<video :src="withBase('/examples/jfa-voronoi-stained-glass.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_jfa_voronoi` uses a Jump-Flooding pass chain (seed init, halving passes,
color pass) to make animated mosaic / stained-glass cells with live seed and edge
controls.*

> *"Warp this footage with a flowing liquid distortion that ripples like heat haze
> over the whole frame."*

<video :src="withBase('/examples/displacement-warp-liquid.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Drives a Displace TOP from an animated noise field so the source ripples and flows,
with Amount/Speed controls — that premium "liquid morph" / heat-haze warp over any clip.*

> *"Turn this live camera feed into flowing ink lines, like a music-video frame
> drawn with edge tangent flow and animated charcoal."*

<video :src="withBase('/examples/flow-abstraction-ink-lines.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_flow_abstraction` builds the ETF / FDoG painterly path: coherent line flow
instead of simple Sobel edges, useful for comic, ink and etched-camera looks.*

> *"Give this shot a Kuwahara oil-paint filter, then let me switch between oil,
> pencil and watercolor modes during the set."*

<video :src="withBase('/examples/npr-kuwahara-paint.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_npr_filter` exposes the non-photoreal look as a controllable component;
`apply_post_processing` also understands `npr_oil`, `npr_pencil` and
`npr_watercolor` for quick one-off chains.*

> *"Give this a moody teal-and-orange cinematic grade — crush the blacks a touch and
> lift the highlights."*

<video :src="withBase('/examples/cinematic-color-grade.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A lift/gamma/gain + saturation/hue grade (with optional LUT) on any source, exposing
the wheels as knobs — the Hollywood teal/orange look as a finishing layer, the thing
people buy plugins for.*

> *"Give this camera a proper three-wheel grade: cool shadows, warm highlights, a
> small black offset and live Lift/Gamma/Gain channel controls."*

<video :src="withBase('/examples/color-wheels-lift-gamma-gain.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_color_wheels` builds the classic colorist surface: three tinted Level TOPs
for shadows/midtones/highlights, master black offset and saturation. Use it when
simple color-grade sliders are not expressive enough.*

> *"Apply this .cube LUT to the camera feed, show me a before/after split, and fall
> back to GLSL if OCIO is not available."*

<video :src="withBase('/examples/lut-film-grade.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`apply_lut` chooses the best available route: OCIO when present, image lookup for
preview LUTs, or a parsed `.cube` GLSL fallback when the machine is bare.*

> *"When I move this slider, glitch-cut from the first clip to the second with a burst
> of digital noise."*

<video :src="withBase('/examples/transition-glitch-cut.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*An A→B transition over a single 0–1 Progress knob with selectable styles (dissolve /
luma_wipe / slide / zoom / glitch_cut) — drag the fader to wipe between two sources
mid-show.*

## Mixing & layering

> *"Stack four layers with blend modes and opacity, each with mute and solo, so I can
> mix a look on the fly."*

<video :src="withBase('/examples/layer-stack-mute-solo.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*An N-layer compositor with per-layer blend mode + opacity + mute/solo and a generated
control strip — a Photoshop / After-Effects-style layer stack you can perform, a mixing
desk for visuals.*

> *"Build me a four-deck rig with per-deck FX sends into a shared return bus and a
> hard-cut switch I can blend back in."*

<video :src="withBase('/examples/nchan-decks-fx-bus.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_decks` in `decks[]` mode builds 2–8 deck rigs with per-deck gain,
per-deck FX-send branches into an additive bus/return, a running Cross TOP program
mix, and a Switch TOP hard-cut blended back into program through `cut_mix`. A
proper four-deck VJ console with sends, returns and a hard-cut on a slider.*

## Data-driven visuals

Reactivity beyond sound — drive visuals from a live web feed, a spreadsheet or a table.

> *"Pull the live BTC price from a web API and drive the visual's color and speed from
> how fast it's moving."*

<video :src="withBase('/examples/live-data-btc-feed.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*One tool pulls a live JSON/web feed into CHOP channels; a second maps those channels
onto a visual's parameters with per-mapping range remap — the data counterpart to audio
reactivity. Your visuals react to a live internet data feed (price, weather, anything).*

> *"Prototype a WebSocket-driven visual dashboard from this event stream, but run it
> in dry-run / experimental mode first and report any bridge errors before wiring it
> into the show."*

<video :src="withBase('/examples/data-source-http-ws-hotfix.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_data_source_http_ws` is the HTTP/WebSocket bridge for turning JSON selectors
into CHOP channels. The v0.7.0 public cut includes the HTTP-poll hotfix, so prompts
can ask for status, selectors, channel names and warnings as part of the build
report.*

> *"Turn this spreadsheet of monthly sales into animated 3D bars that grow in, with
> value labels."*

<video :src="withBase('/examples/table-3d-bars.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A data-driven visualization network (bars or graph from a table) with a Scale knob and
animated entrance — a real-time, performable infographic rather than a static chart.*

> *"Clone this little card design once per row of my table, each labeled with that
> row's name."*

<video :src="withBase('/examples/replicator-table-cards.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A Replicator COMP that clones a template COMP per Table-DAT row, parameterizing each
clone from its row — data-driven instancing of whole sub-networks, not just geometry,
the way motion designers fake "100 of these."*

## Rehearsal checks & artist feedback

Use these when you want tdmcp to test the work like an artist would: can I see it,
can I perform it, does it react, and is it safe to keep rehearsing?

> *"Before rehearsal, open my main output, take a quick preview snapshot, and tell
> me if it is black, low-res, frozen or showing errors."*

<video :src="withBase('/examples/inline-preview-thumbnail.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`get_inline_preview` turns "is it alive?" into one check: thumbnail, resolution,
pixel format, cook metadata and recent errors. The answer should be visual and
plain-language first.*

> *"Watch the bass analyze CHOP for five seconds and tell me the real min/max so I
> can set the visual range before the DJ arrives."*

<video :src="withBase('/examples/watch-node-telemetry.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`watch_node` is useful when it reads a signal the way a performer needs it: actual
range, spikes, quiet moments and whether the channel is stable enough to bind to a
look.*

> *"Check the `club` venue profile without showing secrets: is TouchDesigner
> reachable, is the bridge on the expected port, and what should I fix before
> doors?"*

<video :src="withBase('/examples/config-profiles-redacted.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Venue/profile checks belong in the cookbook only when they answer a show question:
which room am I set up for, is the live bridge reachable, and what concrete action
keeps rehearsal moving?*

> *"Read the compact map of `/project1/hero` and explain the visible controls in
> plain language: what changes color, motion, intensity and reset?"*

<video :src="withBase('/examples/compact-graph-digest-budget.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`compact_graph_digest` summarizes a network without drowning the artist in nodes:
counts, wires and key parameters become a short map of what the look can do.*

> *"During soundcheck, listen for beat and onset events for ten seconds and tell me
> whether the cue stream is steady enough to drive cuts; do not trigger anything on
> stage."*

<video :src="withBase('/examples/agent-watch-hooks.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Bridge event watching can stay read-only: use it to prove that tempo, beat or
gesture events are arriving before you map them to visible changes.*

> *"Teach me enough TouchDesigner to safely tweak this patch: show the operator path
> I should open, the one parameter to try first, and a fallback if it breaks."*

<video :src="withBase('/examples/td-learning-resources.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Learning resources and cheatsheets are artist-facing when they reduce fear in the
patch: one operator, one safe parameter, one way back.*

> *"Look at the current output and critique it like a motion designer: palette,
> contrast, rhythm, legibility and one concrete next tweak."*

<video :src="withBase('/examples/copilot-vision-critique.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The local copilot should close the loop from generated network to visible result:
describe what is on screen, name the weakest artistic choice, then propose a small
change the artist can approve.*

## Creative library (Creative RAG)

The creative repertoire is an opt-in local index of open-licensed reference
artworks. The CLI is `tdmcp creative-rag <sync|index|search>`; both
`tdmcp://creative/cards/{id}` and `tdmcp://creative/search{?q,k,license,type,tags}`
are read-only MCP resources. RAG supplies source artworks, palettes, motion
language and tool affordances; the actual TouchDesigner build still happens through
normal tdmcp tools.

> *"Use Creative RAG to find the CC0 Cleveland card `The Biglin Brothers Turning
> the Stake`. Use the painting itself as source material: stretch the waterline
> into horizontal motion trails, edge-detect the oars and bodies, and turn it into
> a rowing-motion visual with a cool stage grade."*

<video :src="withBase('/examples/creative-rag-rowing-motion-remix.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A RAG artwork becomes input material, not a result row: the card's CC0 image is
remixed into a new kinetic trails piece using the painting's water, oar rhythm and
silhouette structure as the visual score.*

> *"Search Creative RAG for the CC0 portrait card `Nathaniel Hurd`. Build a new
> live mask look from it: pull a warm palette from the portrait, pixelize the face
> into block cells, add edge outlines, and make a subtle double-exposure drift for
> a performance backdrop."*

<video :src="withBase('/examples/creative-rag-portrait-mask-remix.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The retrieved portrait drives the look: color, lighting and face structure become
a new mask/mosaic system that could be recreated with `create_palette`,
`create_pixel_sort` and post-processing passes.*

> *"Open the Creative RAG `Composition` card for Wassily Kandinsky. Use its
> hard-edged geometry, primary triad palette and `create_generative_art` /
> `create_color_grade` affordances to build a fresh geometric TD system, not a
> copy of the painting."*

<video :src="withBase('/examples/creative-rag-kandinsky-remix.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The card hands over palette and visual language; the result is a new procedural
composition with animated grid, circles and color planes, keeping the original as
repertoire context rather than something the RAG executes directly.*

## Working from your own notes (Obsidian vault)

If you keep an [Obsidian vault](/reference/tools#obsidian-vault) wired up:

> *"Build tonight's set from my 'Friday' setlist note."*

> *"Generate a visual from my 'deep ocean' moodboard."*

> *"Save this look as a recipe in my vault, run auto-tagging, and log it to my show
> diary."*

> *"Remember that my show style avoids flat rainbow gradients, prefers cold fog,
> amber edge lights and slow camera drift, then use that memory for the next look."*

> *"Find previous work in my vault similar to 'submerged cathedral, blue haze,
> slow strobes' and use the closest one as a starting point."*

> *"Lint my recipe library before the show and tell me which notes have missing
> assets, duplicate ids or unknown operators."*

**What you'll get:** a local, git-friendly show library. `scaffold_vault` creates the
starter folders, including `Memory/style.md`; save tools can opt into deterministic
auto-tags; `recall_similar_work` searches your own past looks; and
`lint_recipe_library` catches bad notes before they reach the projector.
