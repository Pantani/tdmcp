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

Media on this page is reserved for the visual result or performable surface a
prompt creates. If a prompt produces a report, config, README or health check, it
stays text-only instead of showing a decorative command illustration.
Do not attach a clip until it has been captured from the TouchDesigner output that
the prompt produced through tdmcp.

## Recipe starters (validated first-party recipes)

Use these when you want a validated first-party recipe first, then a creative pass.
They are good workshop and rehearsal prompts because they start from schema-checked
networks instead of inventing topology from scratch.

> *"Apply `audio_reactive_basic`, use a test tone if the mic is unavailable, and
> show me the audio Null path driving the output color."*

<video :src="withBase('/examples/recipe-audio-reactive-basic.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A compact audio-in / spectrum / RMS chain with a stable Null CHOP. The TOP output
color is already bound to the RMS level via expressions, so the frame pulses with
the audio out of the box.*

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

The v0.13 recipe twins mirror newer orchestrator tools with schema-checked,
live-cook-validated networks. They stay text-only here until each video is captured
from the actual `out1` result after running the prompt through tdmcp.

> *"Apply `color_grade_basic` to a clean test ramp, make it feel like a late-night
> teal-and-amber grade, and expose Brightness, Gamma, Contrast, Saturation and Hue
> so I can swap in venue footage later."*

*A horizontal ramp feeds Level and HSV Adjust stages, ending in a stable `out1`.
The recipe exposes grading controls that can be rehearsed offline, then swapped to
a real source via Select TOP. It is the validated recipe twin of
`create_color_grade`, useful when you need a colorist chain before the real clip is
ready.*

> *"Apply `transition_dissolve`, make source A and B obviously different, and leave
> one Progress control so I can rehearse the crossfade before wiring real decks."*

*Two built-in sources blend through a Cross TOP with a single 0..1 Progress knob.
This is the smallest safe A/B transition rehearsal: enough to practice the fader,
then replace the test sources with real deck Select TOPs.*

> *"Apply `text_overlay_lower_third`, write a readable vocalist lower third over the
> demo background, and keep the text layer easy to replace with the program feed."*

*A Text TOP composites over a synthetic background and ends at `out1`. Text and
font parameters stay visible for live titling or later binding, so the overlay can
move from a demo lower third to real program output without changing the recipe
shape.*

> *"Apply `layer_stack_blend`, make three rehearsal layers with different colors and
> blend modes, and expose each opacity so I can practice a small live mix."*

*Noise, ramp and constant sources stack bottom-up through Level and Composite
stages. Per-layer opacity is exposed, making the recipe a readable miniature layer
desk before the show uses real inputs.*

> *"Apply `strobe_flash` with a moderate rehearsal rate, keep Rate and Duty visible,
> and warn me before I raise it into unsafe photosensitive territory."*

*A Constant TOP flashes through a Level TOP gated by an LFO expression. Rate and
Duty stay performable, and the safety note matters because this is a real flashing
output, not a decorative preview.*

> *"Apply `test_pattern_grid`, make an eight-division projector alignment grid, and
> label it clearly enough that the crew can identify the output from across the
> room."*

*A self-contained GLSL TOP draws a calibration grid ending at `out1`. Use it for
focus, mapping alignment and quick output checks before the artwork goes live.*

> *"Apply `datamosh_feedback_echo`, let the recursive smear build for a few frames,
> and expose Decay so I can ride the broken-codec trail live."*

*Animated noise feeds a bounded Feedback / Composite / Level loop. The recursive
look develops over several cooked frames, so ask for a delayed preview when you
capture the result.*

> *"Apply `chrome_blobs`, make the liquid metal move slowly on a dark studio
> background, and tell me which `uTime` binding I need after import for moving
> reflections."*

*Noise becomes softened metaballs and a GLSL chrome pass. The recipe is valid
offline, with a manual `uTime` binding note for animated reflections: a reproducible
Y2K logo-bumper look, not a one-off shader paste.*

> *"Apply `displacement_warp_noise`, use the animated noise modulator to make the
> ramp ripple like heat haze, and leave Amount and Speed ready for a real clip
> later."*

*A ramp source is UV-warped by drifting noise through a Displace TOP. It is a safe
offline rehearsal path for liquid warps over real footage, with the live controls
ready before the source arrives.*

> *"Apply `luma_keyer`, use the ramp as a visible luminance matte over a moving noise
> background, and expose Threshold and Softness so I can tune a real source later."*

*A ramp source, noise background, Level matte and Matte TOP make the key visible
without external footage. It is the luma-key rehearsal twin before a real camera or
movie source enters the chain.*

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

> *"Build me a rolling 3D landscape from noise — real hills I'm looking across,
> valleys in mossy green rising to pale peaks, a calm translucent lake cutting
> through it, and hazy distance fog melting the far hills into the sky. Let the
> terrain slowly drift so it never sits still, and give me a Height and Zoom knob."*

*`create_terrain` subdivides a Grid SOP and displaces it along Z by a live noise
heightmap in a GLSL vertex material — genuine 2.5D geometry, elevation-shaded from
mossy lowlands to pale peaks, with an optional translucent water plane and
camera-distance fog that dissolves the far hills into the sky. Height / Drift /
WaterLevel / Zoom stay live and a slow drift keeps it from ever sitting still.
Distinct from the flat `noise_landscape` recipe: real displaced terrain with a lake.*

> *"Fill the frame with pages of invisible handwriting — rows of an alphabet that
> doesn't exist, flowing left to right like real script with little ascenders and
> pen-lifts, drawn as clean calligraphic ink lines on a pale page."*

*`create_asemic_writing` lays out rows of glyphs in a Script SOP, each a short
noise-walked stroke chain with baseline flow, ascenders, descenders and the odd
pen-lift, tubed and rendered orthographically as line art. Nothing is traced:
convincing "writing" in a language that was never designed — a generative-art idiom
no other tool here covers.*

> *"Give me the classic Schotter look — a tidy grid of squares at the top that gets
> progressively more drunk toward the bottom, tumbling and scattering. Put the whole
> descent into chaos on one knob I can automate."*

*`controlled_disorder_grid` draws a rows×cols grid of quads in a single GLSL TOP
where one `disorder` knob morphs it from a perfect grid (0) into full tumbling chaos
(1) — per-cell position, rotation and scale jitter, each hashed from the cell index
so the scatter is stable and reproducible. Georg Nees' 1968 "Schotter" as one
automatable parameter, entirely procedural.*

## RayTK toolkit (node-graph SDF)

RayTK ([t3kt/raytk](https://github.com/t3kt/raytk)) is the community raymarching /
signed-distance-field toolkit. These prompts build an **editable RayTK node graph**
(SDF primitives → combine → material → camera → renderer) from RayTK's real operator
(ROP) masters — the node-graph-native complement to the self-contained GLSL
`create_raymarch_scene` above. RayTK is an external package: the tools require it
**staged + loaded** first, and RayTK 0.46 needs **TouchDesigner 2025.30770+** (pin
`build-045` for 2023.x builds). The videos below were captured from a live
TouchDesigner 2025.32820 graph with RayTK 0.46 loaded; for a fresh local build,
anything you have not live-cooked yet should still be treated as
**UNVERIFIED-pending-td**. With the toolkit absent, the tools fail forward with a
"stage & load RayTK first" message instead of a false render.

> *"Check whether my TouchDesigner build can run the latest RayTK, then stage the
> toolkit so I can use its operators."*

```bash
tdmcp-agent manage_packages --params '{"action":"doctor","package_id":"raytk"}'
tdmcp-agent manage_packages --params '{"action":"install","package_id":"raytk","dry_run":false,"yes":true}'
```

*`manage_packages doctor raytk` reads the live TD build and reports the version gate
(`ok` on 2025.30770+, a `warning` naming the required build otherwise), then `install`
stages the `.tox` under `~/.tdmcp/packages`. It never runs third-party scripts — load
the staged `.tox` in TouchDesigner before building a scene.*

> *"Build me a real RayTK raymarch scene — a sphere unioned with a box, give it a
> material, and add a light — as a node graph I can keep editing."*

```bash
tdmcp-agent raytk-scene --params '{"sdf_primitive":"sphereSdf","union_with":"boxSdf","material":true,"add_camera":true,"add_light":true}'
```

<video :src="withBase('/examples/raytk-sphere-box-nodegraph.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_raytk_scene` copies RayTK's actual ROP masters (`sphereSdf`, `boxSdf`,
`simpleUnion`, `basicMat`, `pointLight`, `raymarchRender3D`) and wires the minimal
renderable chain, terminating in a Null TOP. Because these are live operators, you
can keep tweaking the network by hand afterward — unlike the monolithic GLSL path.
The renderer compiles its shader on a background thread, so the first preview may be
pre-compile; do a live cook-wait before trusting the frame.*

> *"Make a second RayTK node-graph study with a torus SDF unioned into a box-frame
> SDF, magenta material and a light, so I can inspect the ROP chain and keep
> editing the operators."*

```bash
tdmcp-agent raytk-scene --params '{"sdf_primitive":"torusSdf","union_with":"boxFrameSdf","material":true,"add_camera":true,"add_light":true}'
```

<video :src="withBase('/examples/raytk-torus-frame-nodegraph.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*This is still a RayTK graph, not a standalone shader: `torusSdf`, `boxFrameSdf`,
`simpleUnion`, `basicMat`, `lookAtCamera`, `pointLight` and `raymarchRender3D`
are copied from the loaded RayTK package, then the final TOP is captured after a
live cook-wait.*

> *"Add a smooth-union combine to my RayTK scene and pull the existing sphere into
> it, so I can start blending in more shapes."*

```bash
tdmcp-agent raytk-op --params '{"op_type":"simpleUnion","category":"combine","parent_path":"/project1/raytk_scene_sphereSdf","connect_from":"/project1/raytk_scene_sphereSdf/sdf_primary","input_index":0}'
```

*`create_raytk_op` instances any single RayTK ROP by name and wires an **existing**
op into one of the **new** op's 0-based typed inputs (source → new op) — here the
scene's sphere becomes `simpleUnion` input 0. The install-dependent master path is
probed live, never hardcoded, and repeated calls auto-place to the right of existing
siblings. (Cameras and lights are wired straight into the renderer by
`create_raytk_scene`'s `add_camera` / `add_light` flags — that direction is
new-op → renderer, not covered by this source → new-op wire.) Browse the full
operator taxonomy via the `tdmcp://raytk/operators` catalog resource.*

> *"Build a RayTK expression graph study: sphere plus box into a union, material,
> camera and light, laid out as editable ROP nodes so I can keep expanding the SDF
> tree by hand."*

```bash
tdmcp-agent raytk-expr-graph --params '{"preset":"sphere_union_box","add_material":true,"add_camera":true,"add_light":true}'
```

*`raytk_expr_graph_builder` is the larger graph-builder surface: it accepts presets
or explicit `nodes` / `edges`, copies every RayTK master live, wires typed connector
indices, places copied ROPs deterministically and exposes the selected renderer
through `out1`. Treat the first local render as `UNVERIFIED-raytk-render` until the
RayTK `.tox` is loaded and the shader has cooked in TouchDesigner.*

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

> *"Split my DJ feed into four clean bands, route sub to displacement, mid to
> color pulse and highs to spark density, then bind the same bands into my GLSL
> TOP as `uBass`, `uMid` and `uHigh` uniforms."*

*Use `create_band_router` when one audio input needs readable `band0..bandN`
control channels, then `create_audio_glsl_uniforms` when those channels should
drive shader uniforms directly. The result is not only "audio reactive"; it is a
named, inspectable modulation bus that a shader artist can tune without rewriting
the GLSL every time.*

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

> *"Render my body tracking as a clean OpenPose-style ControlNet feed: black
> background, colored limbs, confidence gate, and an NDI sender named
> controlnet_pose."*


*`create_pose_controlnet_driver` turns the same 33-landmark pose CHOP into an
OpenPose-COCO skeleton TOP with JointRadius, LimbThickness, ConfidenceGate and
Mirror controls. Keep it internal for local ComfyUI / StreamDiffusion routing, or
broadcast it through NDI / Syphon-Spout when another machine needs the pose feed.*

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

> *"Trace my silhouette live into a single clean outline — drop the fill and color,
> just the moving contour of my body drawn as a crisp vector line that follows me."*

*`create_blob_trace` runs source → mono → blur → threshold into a blob mask, then a
Trace SOP turns that silhouette into a single clean polyline rendered as a crisp
vector outline — no fill, no color, only the moving contour. It defaults to a
synthetic animated blob so it previews with no device; `source:"camera"` traces the
live webcam. The contour-trace complement to `create_vector_lines` (not a filtered
image); live use needs a webcam, and macOS may prompt for camera permission.*

> *"Make the mouse paint — a bright dot that smears a glowing trail across a decaying
> feedback field wherever I move the pointer, so I can finger-paint light during the
> show."*

*`create_pointer_reactive` feeds a Mouse In CHOP (u/v/velocity/button, with a
sensitivity gain) into a demo feedback field where a bright dot smears a glowing
trail across a decaying buffer under the pointer — an instantly playable performance
instrument, no hardware. The pointer channels are exposed for binding to anything
else. It is a single pointer; true multitouch needs a Panel COMP source, which the
tool reports as a warning.*

> *"Split the camera frame into a few invisible hotspots and tell me when someone
> moves inside each one — like tripwires I can wire to fire visuals when people walk
> into different parts of the space."*

*`create_interaction_zones` averages per-frame motion (mono → previous-frame
difference) inside each normalized rectangle you define, thresholds it with dwell
into a per-zone `zoneK_state` on/off trigger channel — invisible tripwires you wire
to fire visuals as people enter different parts of the room. It defaults to a
synthetic animated source so it cooks offline; real use points `source_path` at a
camera TOP. The interactive-installation building block.*

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

> *"Build a POP particle storm where 40,000 points are born from a seed cloud,
> dragged through a texture force field, and leave a bright feedback trail."*


*`create_pop_particle_system` builds the rendered POP instrument: point-generator
seed, particle POP, feedback POP, lookup-texture force branch, optional field
visualization and an output Render TOP. EmissionRate, Lifetime and FeedbackGain
stay exposed so the storm can be performed instead of baked.*

> *"Grow a coral-like POP organism: dense outward accretion, noise-biased motion,
> slow decay, and knobs for growth rate, threshold and feedback."*


*`create_pop_growth` is the organic POP preset: dendritic, coral and lichen modes
with GrowthRate, Decay, Threshold and FeedbackGain controls. Use it when the look
should feel like accretion, fungus, coral or branching fiber rather than plain
particles.*

> *"Make a slow-spinning plexus point cloud: 1,000 points, connect only nearby
> neighbors, fade lines by distance, and leave tiny point sprites on top."*


*`create_pop_lines_pointcloud` runs a Neighbor POP over an auto-generated or
external point cloud, emits deduplicated Script SOP line primitives, then renders
the web with MaxDistance, MaxNeighbors, MaxLines, Spin and PointSize controls.
This is the plexus look without hand-writing the neighbor loop.*

> *"Use my segmentation mask as a depth field and scatter 25,000 points around my
> body, colored by near/far depth and slowly spinning in 3D."*

<video :src="withBase('/examples/depth-pop-field-performer.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_depth_pop_field` accepts an existing depth/mask TOP or spins up
segmentation, then uses lookup-texture POPs, jitter and a displacement proxy to
turn the mask into a rendered spatial point field. DepthScale, PointSize and Spin
make the flat camera feed behave like a stage volume.*

> *"Load this .splat scan as a Gaussian Splat scene, bind it to my orbit camera,
> output 1080p, and expose the asset path and camera reference on the wrapper."*


*`create_gaussian_splat_scene` wraps TDGS.tox when it is installed, validates
`.ply` / `.splat` assets, binds an optional camera and promotes SplatAssetPath,
CameraRef and OutputRes controls. If TDGS is missing, it fails fast with install
guidance instead of hanging TouchDesigner.*

> *"Estimate depth from this 2D camera feed, keep the depth map cooking, then use
> it as the source for a relief/displacement visual."*


*`create_depth_from_2d` drops TDDepthAnything when available, wires a source TOP,
configures model/resolution and returns a live `depth_out` Null TOP with a frame
cooker. The result can feed `create_depth_pop_field`, displacement, silhouettes or
any other depth-aware chain without a depth camera.*

> *"Create a slow nebula volume: 24 stacked slices, purple-magenta palette, high
> density, low turbulence, and live knobs for density and color map."*

<video :src="withBase('/examples/volumetric-field-nebula.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_volumetric_field` fakes volume from animated 3D noise, optional
displacement, a Cache TOP slice stack and Beer-Lambert GLSL accumulation. Density,
Turbulence and ColorMap controls turn it into a haze, nebula, ember, ice, toxic or
mono atmosphere.*

> *"Turn this camera feed into an isometric voxel city: brightness drives tower
> height, source color paints each block, and I get HeightScale and RotateY
> controls."*


*`create_voxel_stack` samples a TOP into instance channels, merges position,
height, scale and color buses, then instances box geometry through an isometric or
perspective camera. It turns flat footage into a performable field of cubes rather
than a pixelated 2D filter.*

> *"Turn this portrait into a stippled point-cloud study: warm dots on black,
> luminance controls density, slight random jitter, and a slow camera orbit like a
> print dissolving into space."*

*`create_stipple_pointcloud` converts TOP luminance into POP density and renders
thousands of tiny points with DotSize, JitterAmount and CameraRotate controls. It
sits between printmaking and 3D particles: more tactile than a halftone, lighter
than a full fluid or particle sim.*

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

> *"Turn the camera into an AI mirror with an ethereal water prompt, show the raw
> camera in the control panel, and send the generated output over Syphon/Spout
> when it is ready."*


*`create_ai_mirror` wraps camera, synthetic or existing TOP input through
StreamDiffusionTD with Prompt, Negative Prompt, Strength and CFG controls plus an
optional camera preview. The output can stay internal or go to Syphon-Spout / NDI,
and a missing StreamDiffusion TOX becomes a friendly warning with the skeleton
still built.*

> *"Build my live ingest rack: a safe screen-grab source for rehearsal, a folder
> media bin of loops, and a chroma keyer that can swap between camera and test
> card before the show."*

*`create_live_source`, `create_media_bin` and `create_keyer` are the practical
video-input trio: one normalizes live feeds, one scans a folder into switchable
clips, and one composites keyed footage over a background. Camera, NDI,
Syphon/Spout and streams remain platform/permission gated, so the prompt should
ask for warnings and stable `out1` paths before wiring the show mix.*

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

> *"Turn the word LUMEN into solid, beveled 3D letters floating in the dark, lit like
> polished metal and slowly spinning — no rendered geometry, just the glyphs carved
> out of light."*

*`create_sdf_text` treats a Text TOP mask as an extruded SDF slab and raymarches it
in a single GLSL TOP, so the letters read as solid, beveled volumes lit like polished
metal, with adjustable depth and optional slow rotation. Fully volumetric 3D
typography from a plain string in one shader pass — no Text SOP extrude, no
font-mesh, no external SDF atlas.*

> *"Burn a running timecode into the top corner of my output, and give me a countdown
> mode that ticks down to zero for the intro before the set starts."*

*`add_timecode_overlay` composites a live-cooking HH:MM:SS:FF Text TOP over your
input in three modes — clock (time since project start), count_up (from zero) and
count_down (from `target_seconds`, clamped at 00:00:00:00 for the intro). FPS is
probed live, so it is a real burned-in timecode/countdown in the pixels, not just a
sync signal — indispensable for rehearsals and intro rolls.*

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


*`setup_tdableton` probes for the Palette component first, then falls back to a plain
OSC In bridge, so the same show patch can rehearse without a perfect studio setup.*

> *"Build a futuristic hand hologram: a transparent cyan cube with violet scanlines
> floating above my open palm. Start with the synthetic two-hand preview, expose
> Size, FloatHeight, Glow and PinchScale controls, and make an opposite-hand pinch
> grow the cube and brighten its glow."*

*`create_hand_hologram` builds the full visual and nests `create_hand_gesture_bus`
inside it. The bus stabilizes the palm anchor, keeps the active palm locked when
the control hand enters the frame, and publishes `pinch_power`, `light_gain` and
`audio_level` so the same tracking can later drive lasers, particles or audio.*

> *"Build a phone gesture controller on port 9982: multitouch X/Y controls for
> feedback and hue, tilt for camera roll, and shake as a panic-safe flash trigger.
> Give me the URL and the CHOP channel names before I bind anything."*

*`create_phone_gesture` serves a local phone page from TouchDesigner and publishes
touch, tilt, gyro and shake channels through a Script CHOP. iOS motion sensors need
an explicit browser permission tap and often HTTPS, so this belongs in rehearsal
as a control surface first, then in the show once the channel ranges are watched.*

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

> *"Build a Kinect wall harp rehearsal rig in synthetic mode: 16 musical zones
> across the wall, 128 subtle laser lines, amber pluck flashes, debug hand dots,
> and exposed calibration, audio decay and reverb controls so I can test the
> piece before the Kinect is connected."*

*`create_kinect_wall_harp` builds the wall instrument as a TD COMP: projected harp
lines, depth / mask / hands debug outputs, hand and pluck CHOP buses, plus an
internal sine/reverb audio chain. Use `source:"synthetic"` or keep
`fallback_to_synthetic:true` for rehearsal; add a cookbook video only after
capturing the real `output_top` from TouchDesigner.*

> *"Build a performance control layer for this look: four tempo-locked modulators
> named breathe, shimmer, wobble and random_hold, an XY pad for blur/hue, and a
> look bank with ambient, chorus and blackout-safe slots plus an A/B morph knob."*

*`create_modulators`, `create_xy_pad` and `create_look_bank` turn a generated patch
into an instrument: named CHOP modulation, direct two-axis control and stored looks
that can snap, quantize or morph. Use it once the visual works and the next problem
is making the controls repeatable under show pressure.*

> *"Follow the MIDI clock coming from my DJ software."*

> *"Set up two cues — 'intro' and 'drop' — that I can morph between."*

> *"Let me control the main knobs from my phone."*

> *"Map my MIDI controller's first fader to the Sensitivity knob."*

> *"Going live now — turn on perform mode so nothing hitches mid-show."*


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


*`tdmcp-agent show-director` is a policy surface, not an unsafe hardware trigger. It
validates structured show intents, returns allow / approval / block decisions, keeps
an approval queue and audit log, and marks every action plan as dry-run-only until a
human/operator path resolves it.*

> *"Before the band walks on, arm the predeclared Soundcraft scene `band_a_intro`
> through the AI Show Director. Put it in the approval queue, bind the catalog
> hash, and show the dry-run plan without contacting the mixer."*

*`arm_mixer_scene` is separate from `arm_effect`: only a predeclared catalog
`scene_id` can enter the approval queue, approval rechecks the current catalog hash,
and the dry-run adapter returns `hardware_changed:false`. The useful output is the
operator-reviewed plan and audit state, not a decorative mixer illustration.*

> *"Plan a 20-minute set across my three scenes in dry-run mode first — show me
> what the AI director will do before it touches anything."*


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


*`control_timeline_transport` now prefers the new `POST /api/transport` endpoint
for play / pause / seek / cue / rate and falls back to `executePythonScript` only
on older bridges. Transport jumps become a real REST call — fast enough to land on
a downbeat.*

> *"Lock the show to incoming OSC timecode, follow the timeline frame-for-frame, and
> jump to named cues if the timecode label says chorus or blackout."*


*`sync_timecode` wires MTC / LTC / OSC timecode into a normalized CHOP and can drive
the TD timeline. Pair it with `control_timeline_transport` for explicit play, pause,
seek, rate and cue commands.*

> *"Schedule the lobby installation: start the ocean scene every weekday at 09:00,
> switch to the dusk set at 18:00, and dry-run the schedule first."*


*`tdmcp-agent schedule` is the cron-lite companion for unattended installs. It uses
wall-clock scheduling with timezone handling, can dry-run, and can fire commands,
cues or setlists.*

> *"Record the next few MCP tool calls as a macro called soundcheck, then replay it
> on the second machine after the stage network comes online."*


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

> *"Queue my strobe and logo cues when I tap the button, but only fire them on the
> next 16-bar phrase boundary so the drop lands musically."*


*`create_phrase_locked_cue_engine` watches a pending-cue CHOP, queues pulses and
gates them against a local Beat CHOP phrase clock. The output Null CHOP emits the
musically quantized trigger, while PhraseLength, Active, Flush and QueueDepth give
the operator live control over the queue.*

> *"Build me a whole playable VJ deck in one go — two decks with a crossfader,
> on-screen faders for the crossfade and each deck's level, and map it all to my MIDI
> controller so I can mix hands-on right now."*

*`scaffold_vj_deck` composes a complete, playable rig in one call: an A/B deck mixer
with crossfader, an on-screen fader surface (crossfade + per-deck gain), and a
MIDI-In control surface whose channels are already bound to the same parameters. The
fastest path from nothing to a gig-ready mixer with MIDI already mapped — open it in
Perform mode and play.*

> *"Keep a running diary of my set — every time I make a big move, log it with a
> timestamp and the section name so I have a setlist and notes to read back
> afterward."*

*`narrate_set` appends timestamped lines (with optional section and cue) to a local
markdown session log at `~/.tdmcp/narration-<date>.md`; `mode:"recall"` reads the
last N lines back. The AI leaves a written setlist and diary of the whole performance
you can reread afterward — an append-only decision log, not a one-shot snapshot.
Pairs with the `auto_vj_director` prompt.*

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

*`create_dmx_fixture_pipeline` lays out fixture profiles, DMX slot padding and a
DMX Out CHOP for Art-Net or sACN. It should surface overlaps, over-512 warnings and
the exact channel names before anything goes live; fixture output is hardware, so
the cookbook keeps this as a verified routing/control report rather than a fake
lighting preview.*

> *"Create a starter `TDMCP_*` config file for this show laptop, but leave secrets
> commented out and refuse to overwrite the existing file unless I pass force."*


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

> *"Build an interactive projection mapping rig for a webcam and projector:
> motion wakes up cyan particles, magenta cards drift around the wall, and I can
> switch between final, camera, motion, blob and calibration views."*

<video :src="withBase('/examples/interactive-projection-motion-dots.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_interactive_projection_mapping` builds the rehearsal rig around a
camera/synthetic/existing TOP source, frame-difference motion field, blob-mask
branch, corner-pin projection output and a debug switch. Sensitivity, TrailDecay,
BlobThreshold and ProjectionBrightness stay exposed for calibration in the room.*

> *"Send my final TOP out as NDI named stage_program, keep it inactive until I
> approve, and also make a Syphon/Spout sender for the local capture machine."*

<video :src="withBase('/examples/external-io-ndi-syphon-return.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_external_io` now includes `ndi_out` and `syphon_spout_out` beside OSC,
MIDI, DMX, Art-Net and streaming modes. It connects the TOP source, sets the
sender/source names and leaves Active off unless the prompt explicitly asks to
start sending.*

> *"Build a three-projector facade mapping skeleton with horizontal edge blends,
> per-projector brightness, a preview canvas, and smoothstep blend curves."*

<video :src="withBase('/examples/facade-mapping-edge-blend.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_facade_mapping` fans a source TOP into 1-8 projector branches, crops each
slice with overlap, applies blend ramps / corner-pin branches, creates
per-projector Null outputs and exposes brightness plus blend-width/curve controls.
It is the setup skeleton before the real projector alignment pass.*

> *"Prepare hardware-free fulldome tests for this generated glitch feed: make a
> fisheye dome master with horizon Rotation and FOV controls, then build a true
> cube-map test scene so I can compare the higher-fidelity path."*

<video :src="withBase('/examples/dome-output-glitch.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

<video :src="withBase('/examples/cubemap-dome-master.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Use `create_dome_output` for a 2D equirectangular/panoramic source and
`create_cubemap_dome` when you have, or want to generate, a real cube-map source.
Both produce a square dome master, but final geometry, FOV and seam behavior must
be tuned against the actual dome or simulator, so the useful output is the mapped
TOP path plus controls, not a generic planetarium illustration.*

> *"Set up a couple of moving-head lights I can drive over DMX, and give me a 3D
> previz so I can see the beams sweep and change color on stage before I ever touch
> the real rig."*

*`create_fixture_control` builds two coupled halves from one prompt: a DMX-out chain
(Constant CHOPs → Merge → Null → DMX Out, one 8-channel movingHead8 block per
fixture) and a 3D previz where each fixture head projects a cone beam whose pan/tilt/
color track the DMX values. Sweep the beams and change color on stage before you
touch the rig — physical output needs a DMX interface, but the previz works offline.*

> *"Wire TouchDesigner to drive Synesthesia over OSC — set up the exact addresses it
> expects so my bass and energy analysis push straight into its scenes with no
> fiddling."*

*`create_synesthesia_unreal_osc` drops a named OSC-out preset that just works because
the addresses are pre-filled: synesthesia targets `/syn` on port 6448, unreal targets
`/unreal` on port 8000. A Constant CHOP carries one channel per control named to the
exact OSC address, wired into an OSC-Out CHOP at host:port — bind your analysis to the
source channels and it pushes straight into the other app's scenes, no manual typing.*

> *"Before doors, give me a pre-show report for `/project1/show`: bridge status,
> node errors, topology, performance budget and display readiness, then build a
> companion surface for the hero controls if the report is clean."*

*`show_preflight_report` stays read-only and returns PASS/UNVERIFIED/WARN/FAIL instead of a
visual. `create_companion_surface` then wraps a chosen COMP with generated controls,
fader/cue affordances and the same preflight context, so the operator gets a playable
surface plus the checks that explain whether it is safe to use.*

> *"Build the control room routing: one OSC matrix for Resolume and VDMX, a QLab
> cue bridge, ATEM cut/auto controls through Companion, and OBS scene/recording
> buttons, but keep every external app credential and live dispatch explicit."*

*`osc_router_matrix`, `resolume_vdmx_output_chain`, `qlab_osc_bridge`,
`atem_switcher_control` and `obs_stream_control` create the control lanes and notes.
They are scaffolds for real external software: validate host/port/auth against the
room before treating any button as live.*

> *"Set up clip playback and output handoff: a movie/audio transport with Play,
> Loop and Speed controls, a shader edit loop for last-minute GLSL fixes, and a
> ProRes review export preset when the look is approved."*

*`clip_audio_transport` builds the rehearsal-safe player, `edit_shader_live_loop`
edits a GLSL/Text DAT then immediately inspects errors and optional preview, and
`export_render_preset` wraps `record_movie` with named delivery presets for review,
HAP, ProRes and NotchLC-style handoff.*

> *"Prepare the venue calibration scaffolds: two projector lanes with corner-pin
> and level controls, plus a synthetic LiDAR floor tracker so I can rehearse zones
> before the real sensor arrives."*

*`projector_calibration_wizard` and `lidar_floor_tracker` intentionally separate
offline scaffolding from physical truth. The graph can be built and inspected now;
projector alignment and real sensor tracking remain `UNVERIFIED` until validated on
the actual outputs/hardware.*

> *"Import this Blender scene into a PBR render scaffold, and add a guarded Notch /
> TouchEngine bridge container beside it so I can test both asset and real-time
> engine paths in one rehearsal project."*

*`blender_scene_import` creates a TD-side PBR scaffold around a `.blend`-adjacent
asset path or fallback primitive. `notch_touchengine_bridge` adds the guarded Notch
TOP / Engine COMP placeholder and notes; license/runtime validation remains a live
operator step, not something the cookbook can fake.*

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


*The `POST /api/param_modes/batch` bridge path lets agents inspect expression,
bind, export and constant modes for many nodes in one round-trip. It replaces the
old N-way exec loop when you need to understand why a rig is reacting, stuck or
overridden.*

> *"This is running slow — find the bottleneck and optimize it."*

> *"Score this build on palette, motion, complexity, errors and performance, then
> suggest the smallest changes that would improve it."*


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


*`copilot_vision` sends a rendered TOP plus your question to the configured
multimodal LLM. It complements deterministic tools like `caption_top` and
`score_build` when you want an art-direction answer, not only measurements.*

> *"I know I want `create_audio_reactive`, but I only said 'microphone neon bars' —
> infer the missing required arguments from the schema and show me the proposed call."*


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


*`swap_operator` is the careful version of "replace this node": it snapshots wires
and parameters, recreates the operator type in place, reconnects what it can and
returns dropped parameters/failures explicitly.*

> *"Box up the audio chain with an annotation and label it, then list what's inside."*

> *"Try to repair this broken render chain — but if the error count goes up, roll
> back every change you made."*


*`repair_network` now snapshots `(par.path, par.mode)` and `(op.path, op.bypass,
op.display)` before each step. If `errors_after >= errors_before` and it isn't a
dry run, every applied step is reversed and the report carries a `rolled_back:
true` flag — a self-undoing repair pass, the safety net every artist wanted from
"AI, fix it".*

> *"Run an auto-repair loop on `/project1` — three passes max, stop if errors
> stop going down, and roll back any pass that makes things worse."*


*`auto_repair_loop` is the "fix everything" verb: it drives `repair_network` in
iterations, scores `errors_before`/`errors_after` per pass, halts on a no-progress
plateau, and inherits the same rollback safety. One call instead of a manual
repair/check/repeat loop.*

> *"Before touching this show patch, sample `/project1/out1` on an 8x8 grid and
> tell me if it is alive, roughly what colors are present, and whether a full
> screenshot is worth taking."*

*`get_preview` with `sample_grid` returns an RGBA sample grid plus per-channel
min/max/mean stats as JSON instead of encoding an image. Use it as the cheap
"is this TOP alive?" check before spending context on a full preview or critique.*

<video :src="withBase('/examples/cookbook-ops-sample-grid-source.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Captured from the live
`/project1/cookbook_ops_demo/sample_grid_halftone_source/out1` TOP that was
sampled with `sample_grid:8`. The clip shows the TouchDesigner output being
sampled; the actual tool response is the RGBA grid and stats JSON.*

> *"Pulse the reset on `/project1/trails/feedback1`, wait 12 frames, then collect
> the preview so I can see the burst after the feedback loop catches up."*

*`get_preview` now accepts `pre_pulses` and `delay_frames`: pulse one or more
parameters in the same frame, defer the capture, then collect it later by `job_id`.
This is for transient looks that are invisible if you snapshot one frame too early.*

<video :src="withBase('/examples/cookbook-ops-preview-burst.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Captured from the live `/project1/cookbook_ops_demo/preview_burst/out1` TOP after
pulsing `/project1/cookbook_ops_demo/preview_burst/feedback1` `reset` and delaying
12 frames through tdmcp. This clip is the TouchDesigner result, not an illustrative
prompt mockup.*

> *"Before setting the input device on `/project1/live_in/moviefilein1`, read its
> menu values and show me the exact machine names I can set without TouchDesigner
> silently choosing the first item."*

*`get_parameter_menu` live-fetches `menuNames`, `menuLabels` and the current menu
value from the running TouchDesigner build. Ask for it before setting Menu /
StrMenu parameters; if raw exec is disabled, the fallback is clearly marked as a
stale bundled catalog.*

> *"Read rows 500-560 of `/project1/show/state_table`, include the header and the
> first five rows, and tell me whether any cue state looks wrong."*

*`get_dat_content` reads Text and Table DATs in pages: `offset`, `limit`,
`include_header` and `preview_rows` keep a huge cue table from flooding the model.
The result includes row counts, truncation state and the exact row window read.*

> *"After you build the hero look, focus the Network Editor on the new output,
> control panel and final composite so I can inspect the exact nodes without
> hunting."*

*`focus_network_editor` is a UI-only follow move: it pans/zooms TouchDesigner's
Network Editor to frame the selected operators and changes nothing in the graph.
It is the handoff step after a generated build, not a visual effect.*

> *"Tidy `/project1/hero` recursively, but keep every shader DAT docked next to
> the node it belongs to."*

*`arrange_network` keeps the left-to-right data-flow cleanup, and `include_docked`
now moves docked GLSL / callback DATs by the same delta as their owner node. Use it
when generated networks are readable only if their helper DATs travel with them.*

> *"Disable `/project1/hero/old_grade` for rehearsal, but do not delete it — I want
> to re-enable it if the director misses that look."*

*`delete_td_node` with `mode:"bypass"` flips the operator bypass flag instead of
destroying the node. It is the reversible middle ground between leaving a broken
operator in the chain and permanently deleting show work.*

> *"Rebuild this small post chain from the saved spec with auto-layout on, so
> reruns do not leave nodes stacked and the wires read left-to-right."*

*`rebuild_network` with `auto_layout:true` computes positions from the spec's input
graph and overrides stale manual coordinates before creating the nodes. It is useful
for recipe/spec round-trips where a correct network still needs a readable TD
layout.*

> *"Pull the dominant colours out of my hero clip and use them to seed a matching
> colour grade for the rest of the show."*

<video :src="withBase('/examples/palette-extract-and-grade.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`extract_palette` samples the TOP's preview via `get_preview` and runs
deterministic k-means on the decoded RGB pixels, returning weighted hex swatches
that feed directly into `create_color_grade` lift / gamma / gain targets. The AI
brings the rest of the show into the same palette as your hero clip — no eyedropper.*

> *"Before I build, tell me which operators actually exist in the TouchDesigner I'm
> running right now — flag anything documented that this build can't create."*

*`check_operator_availability` reconciles the operator knowledge base against the
running TouchDesigner's ground-truth creatable-optype list, flagging anything
documented that this build can't create (and, optionally, live optypes not yet
documented). It catches "that node doesn't exist in my build" before a build fails,
and survives `TDMCP_BRIDGE_ALLOW_EXEC=0`.*

> *"Keep an eye on this node's parameters and tell me whenever a value changes —
> whether I move it by hand or a script does — so I can see what's touching my patch
> live."*

*`watch_parameter_changes` subscribes to `param.changed` events for an operator's
parameters; every change broadcasts `{path, par, prev, value, frame}` to the client
as a logging notification, coalesced so a slider drag can't flood. Live "who touched
my parameter" telemetry; requires the TD event stream (`TDMCP_EVENTS`) enabled.*

## Reusable looks & show handoff

Use these when a look is working and you want to perform it again, teach it, take
it to another room or turn it into a physical output.

> *"Make this hero look tour-ready: expose Speed, Palette, Glow and Reset controls,
> add clear labels, save it as a portable `.tox`, and include a preview image so I
> can recognize it before I open TouchDesigner."*


*The packaging tools are useful when they serve the artist: a portable `.tox`,
visible controls, simple notes and a thumbnail of the actual output. The result is a
visual instrument you can drop into a show, not a developer handoff exercise.*

> *"Turn `/project1/hero_look` into a workshop starter: keep the visual network,
> capture the controls I should explain, and make it easy to apply in a blank
> project next week."*


*`scaffold_recipe_from_network` can turn a finished TD subtree into an apply-able
recipe. Framed for artists, the point is repeatable teaching and rehearsal: rebuild
the look from a clean project, then adjust the exposed controls in front of people.*

> *"Make me a one-page map of this patch: final-output thumbnail, the three controls
> I should touch live, and a simple left-to-right diagram of how signal becomes
> image."*


*Generated patch notes are only useful here when they read like a studio map: what
the look is, which controls matter, what feeds the output and what the current
preview looks like.*

> *"Save this look with three variants — slow ambient, high-energy chorus and
> blackout-safe — then tag the favorite so I can find it fast during the next
> rehearsal."*


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

> *"Package this component so I can move it to the venue laptop with nothing missing —
> copy every movie, font and LUT it uses next to it and repoint everything, then save
> it as one portable folder."*

*`bundle_dependencies` recursively scans a COMP for external refs, copies every movie,
font and LUT into `<out_dir>/assets/`, rewrites the live parameters to the relative
copies, and saves a `.tox` plus manifest — a movable, no-broken-links folder for the
venue laptop. True collect + relink + save in one step (unlike `make_portable_tox`,
which leaves assets behind); pass `rewrite_refs:false` to copy without touching the
live network.*

> *"Save this component as a version-controllable tree so my project shows real
> per-node diffs in git instead of one opaque binary blob."*

*`export_externalized_tree` uses `COMP.saveExternalTox` to write the component — and,
with recurse, every descendant COMP — as its own `.tox` on disk with `externaltox`
repointed, so git shows real per-node diffs instead of one opaque binary blob. It
turns a TD project into something version control can actually diff.*

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

> *"Give me a material that makes any mesh ripple and bulge on the GPU — push every
> vertex along its normal with drifting 3D noise so a plain sphere turns into a
> churning, molten blob I can drop onto my own geometry."*

*`create_vertex_displacement_mat` builds a GLSL MAT whose vertex stage pushes every
vertex along its normal by drifting 3D noise (or a sampled TOP's luminance), assigned
to your target Geometry COMP — real GPU mesh deformation that turns a plain sphere
into a churning, molten blob. With no target it builds a demo sphere so the material
previews standalone. Distinct from the 2D pixel warps (`create_displacement_warp` /
`create_depth_displacement`): this deforms actual geometry you can attach to your own
meshes.*

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

> *"Render my camera as glowing phosphor ASCII, source-colored in the bright areas,
> with a Mix knob so I can fade back to the original."*

<video :src="withBase('/examples/ascii-phosphor-camera.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_ascii_render` downsamples a source into cells, builds a Text TOP glyph
atlas and renders a GLSL character grid. Mono, source-color and two-color modes
cover terminal phosphor, posterized camera and duotone stage looks.*

> *"Make a vertical slit-scan of the dancer: each row should be a different moment
> in time, 120 frames deep, flowing upward like time ribbons."*


*`create_slit_scan` records the source into a Cache TOP ring buffer and samples it
in GLSL so each row or column pulls from a different past frame. The Depth control
sets how much time is stretched across the output.*

> *"Give this generated glitch feed a time echo: recursive ghost trails in echo
> mode for the verse, then a time-displace melt driven by a vertical ramp for the
> breakdown."*

<video :src="withBase('/examples/time-echo-glitch.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_time_echo` is the broader time-effects container: `echo` for recursive
feedback trails, `slit_scan` for row/column time slices and `time_displace` for
per-pixel frame offsets driven by a ramp or noise TOP. Ask for fixed resolution and
warnings because cache/time-machine operator names vary across TD builds.*

> *"Generate liquid chrome blobs on a black studio background, blue-tinted metal,
> slow movement, and a Speed control for the Y2K logo moment."*

<video :src="withBase('/examples/chrome-blobs-y2k.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_chrome_blobs` turns animated noise into blurred, thresholded metaballs and
shades them with a GLSL fake environment-map chrome pass. Metal tints and
background presets make it useful as a logo bumper, not just a texture test.*

> *"Create a Gray-Scott reaction-diffusion look with coral colors, maze-like
> spots, and live Feed/Kill/Diffusion controls for slow biological morphing."*

<video :src="withBase('/examples/reaction-diffusion-coral-maze.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_reaction_diffusion` starts from the shipped Gray-Scott recipe, patches the
GLSL uniforms for Feed/Kill/Diffusion A/B, optionally applies a LUT ramp, and
exposes the chemical parameters as performance controls.*

> *"Pixel-sort this live feed into vertical rain streaks: sort by luminance above
> the threshold, descending, 96 iterations, with Mix at 0.8."*


*`create_pixel_sort` uses an odd-even GLSL sorting loop with Feedback TOP, Switch
TOP and threshold mask. Axis, SortBy, Direction, Threshold, Iterations and Mix stay
live so the Asendorf smear can be tuned instead of pasted once.*

> *"Take my clip and shatter it into a 5×5 video wall of itself, each tile slightly
> offset and jittered so it breathes like a kaleidoscopic contact sheet."*

*`create_step_repeat` tiles a source TOP into a rows×cols grid with adjustable gap and
per-cell position jitter, shattering any clip into a breathing video wall of itself —
a kaleidoscopic contact sheet. It defaults to a synthetic Noise source so it previews
standalone; point `source_path` at any TOP to multiply a live clip. A staple VJ look
in one call.*

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

> *"Build an offline Ollama LLM chain inside TouchDesigner: prompt DAT in, response
> DAT out, Send button exposed, and JSON mode ready for cue notes."*

<video :src="withBase('/examples/llm-chain-stage-notes.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_llm_chain` creates a stock webclientDAT-based LLM wrapper for Ollama,
OpenAI, Anthropic or a custom OpenAI-compatible endpoint. Prompt and Response DATs,
a status channel and provider/model/temperature/max-token controls stay inside TD,
while API keys are read from environment variables and never surfaced through Node.*

> *"Take this GeoJSON of a neighborhood and raise it into a little 3D city — extrude
> each building footprint up by its height field, lay the streets out as ribbons, and
> frame it with a camera so it looks like a model I can light."*

*`create_geo_visualization` parses a GeoJSON FeatureCollection (Point/Line/Polygon),
builds the geometry in a Script SOP, extrudes each building footprint by its `height`
property and lays streets out as ribbons, then wraps the lot in a Geometry COMP under
a camera+light Render TOP — real map data raised into a lit 3D massing model you can
light like a maquette. Needs a GeoJSON payload; extrusion uses each feature's
`height`/`default_height`.*

> *"Make my visuals react to how many people the camera sees — pull object counts and
> positions from my detector and expose them as channels I can map to intensity and
> spawn rate."*

*`create_detection_reactive` subscribes to an external object detector over WebSocket
(JSON `{count, objects:[{x,y,w,h,score}]}`) or scaffolds a CPU ONNX Script CHOP,
exposing detection count and positions as CHOP channels you can map to intensity,
spawn rate or anything else — object detection steering visuals with no CUDA. Needs
an external detector process (websocket) or an ONNX model you supply.*

## Rehearsal checks & artist feedback

Use these when you want tdmcp to test the work like an artist would: can I see it,
can I perform it, does it react, and is it safe to keep rehearsing?

> *"Before rehearsal, open my main output, take a quick preview snapshot, and tell
> me if it is black, low-res, frozen or showing errors."*


*`get_inline_preview` turns "is it alive?" into one check: thumbnail, resolution,
pixel format, cook metadata and recent errors. The answer should be visual and
plain-language first.*

> *"Watch the bass analyze CHOP for five seconds and tell me the real min/max so I
> can set the visual range before the DJ arrives."*


*`watch_node` is useful when it reads a signal the way a performer needs it: actual
range, spikes, quiet moments and whether the channel is stable enough to bind to a
look.*

> *"Check the `club` venue profile without showing secrets: is TouchDesigner
> reachable, is the bridge on the expected port, and what should I fix before
> doors?"*


*Venue/profile checks belong in the cookbook only when they answer a show question:
which room am I set up for, is the live bridge reachable, and what concrete action
keeps rehearsal moving?*

> *"Read the compact map of `/project1/hero` and explain the visible controls in
> plain language: what changes color, motion, intensity and reset?"*


*`compact_graph_digest` summarizes a network without drowning the artist in nodes:
counts, wires and key parameters become a short map of what the look can do.*

> *"During soundcheck, listen for beat and onset events for ten seconds and tell me
> whether the cue stream is steady enough to drive cuts; do not trigger anything on
> stage."*


*Bridge event watching can stay read-only: use it to prove that tempo, beat or
gesture events are arriving before you map them to visible changes.*

> *"Teach me enough TouchDesigner to safely tweak this patch: show the operator path
> I should open, the one parameter to try first, and a fallback if it breaks."*


*Learning resources and cheatsheets are artist-facing when they reduce fear in the
patch: one operator, one safe parameter, one way back.*

> *"Look at the current output and critique it like a motion designer: palette,
> contrast, rhythm, legibility and one concrete next tweak."*


*The local copilot should close the loop from generated network to visible result:
describe what is on screen, name the weakest artistic choice, then propose a small
change the artist can approve.*

## Offline TD knowledge & recipe drafting

Use these when you want the agent to read embedded TouchDesigner knowledge before it
creates nodes. The tools in this section are read-only and work without a live TD
bridge; any live cook or projector check stays **UNVERIFIED-pending-td** until you
run the draft against a connected TouchDesigner instance.

> *"Before choosing the blur stage, search embedded TOP operators in
> TouchDesigner 2023 with parameter search turned on. Show me which operators
> expose edge, radius or feedback-related controls, and do not create nodes yet."*

```bash
tdmcp-agent operators \
  --params '{"query":"edge radius feedback blur","category":"TOP","version":"2023","parameter_search":true,"limit":8}'
```

*Expanded `search_operators` can filter by category, TouchDesigner version and
parameter metadata before the agent mutates a project. Use it when the question is
"which operator actually exposes the control I need?", not just "what is this op
called?".*

> *"I am migrating a 2022 feedback patch to 2024 and want a camera-safe trails
> chain. Plan the TD version migration first, then suggest a TOP chain and
> validate it before drafting a recipe."*

```bash
tdmcp-agent versions migration-plan \
  --params '{"from_version":"2022","to_version":"2024","query":"TOP feedback camera trails"}'
tdmcp-agent operators suggest-chain \
  --params '{"goal":"camera-safe feedback trails","family":"TOP","max_steps":5}'
tdmcp-agent operators validate-chain \
  --params '{"chain":["Video Device In TOP","Feedback TOP","Transform TOP","Level TOP","Null TOP"],"family":"TOP"}'
tdmcp-agent recipes draft-chain \
  --params '{"chain":["Video Device In TOP","Feedback TOP","Transform TOP","Level TOP","Null TOP"],"id":"camera_feedback_trails_draft","tags":["draft","feedback","migration"]}'
```

*This is a version-aware preflight: release notes and compatibility records shape
the chain suggestion, `validate_operator_chain` checks the operator adjacency, and
the recipe draft remains offline until a later `apply_recipe` + live TD cook pass.*

> *"Open the embedded GLSL technique pack, inspect a reaction-diffusion technique
> with setup notes and code, then draft a schema-valid recipe from it in
> non-strict mode. Leave applying it for a live TD pass later."*

```bash
tdmcp-agent techniques get \
  --params '{"category":"glsl","technique_id":"reaction_diffusion_gs","include_code":true,"include_setup":true}'
tdmcp-agent techniques draft-recipe \
  --params '{"category":"glsl","technique_id":"reaction_diffusion_gs","id":"reaction_diffusion_gs_technique_draft","strict":false}'
```

*`get_technique_detail` and `draft_recipe_from_technique` turn embedded
TouchDesigner technique packs into `RecipeSchema` candidates without claiming that
the network has cooked. Preserve warnings and next-tool hints, then verify the
draft against TouchDesigner before it becomes a show recipe.*

> *"Find the embedded tutorial for writing a GLSL TOP, try a conservative tutorial
> draft in non-strict triage mode, and show me why it is or is not safe before
> applying anything."*

```bash
tdmcp-agent tutorials get \
  --params '{"name":"write_a_glsl_top","include_content":true}'
tdmcp-agent tutorials draft-recipe \
  --params '{"name":"write_a_glsl_top","strict":false,"max_steps":5}'
```

*`get_tutorial` retrieves the structured tutorial text and code blocks; the
`draft_recipe_from_tutorial` tool validates the extracted chain with documented
connection checks. For the bundled `write_a_glsl_top` tutorial, this is expected
to stay non-draftable because the prose/TOC chain includes undocumented adjacent
links such as `GLSL TOP -> GLSL Multi TOP`; the report should include
`undocumented_connection`, omit `apply_recipe`, and leave the TD graph untouched.*

> *"Before creating a feedback post chain, compare the operator docs for Blur TOP
> and Level TOP, validate `Noise TOP -> Blur TOP -> Level TOP -> Null TOP`, then
> draft a recipe from that chain without touching the project."*

```bash
tdmcp-agent operators compare-docs \
  --params '{"operator_a":"Blur TOP","operator_b":"Level TOP"}'
tdmcp-agent operators validate-chain \
  --params '{"chain":["Noise TOP","Blur TOP","Level TOP","Null TOP"],"family":"TOP"}'
tdmcp-agent recipes draft-chain \
  --params '{"chain":["Noise TOP","Blur TOP","Level TOP","Null TOP"],"id":"feedback_post_draft","tags":["draft","feedback"]}'
```

*This is the safe "read, compare, validate, draft" loop: the agent can explain the
operator tradeoffs and hand you a schema-valid recipe draft while the actual
TouchDesigner graph remains unchanged.*

> *"Search embedded tutorials for CHOP workflows, copy one tutorial id from the
> results, try `draft_recipe_from_tutorial` in non-strict mode, and if it is not
> draftable, explain why. Use any extracted operators as input to
> `validate_operator_chain`, and only draft a recipe when the cleaned chain has no
> errors. Treat `apply_recipe` as a later handoff, not part of this run."*

```bash
tdmcp-agent tutorials get \
  --params '{"query":"CHOP","include_content":true,"limit":3}'
tdmcp-agent tutorials draft-recipe \
  --params '{"name":"anatomy_of_a_chop","strict":false,"max_steps":5}'
```

*This is the useful failure mode: a tutorial can still teach the agent what to
inspect or validate even when it cannot become a safe recipe automatically.
`draft_recipe_from_tutorial` takes a tutorial id or exact display name, not a
free-text search query, so substitute the id you chose from the previous result.*

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

### Search and license filters

The creative repertoire is an opt-in local index of open-licensed reference
artworks. The CLI is `tdmcp creative-rag <sync|index|search>`; both
`tdmcp://creative/cards/{id}` and `tdmcp://creative/search{?q,k,license,type,tags}`
are read-only MCP resources. The default license allowlist (`TDMCP_RAG_LICENSE_ALLOWLIST`,
default `CC0,PublicDomain`) only gates **binary downloads** at `sync` time —
`search` still surfaces every card in the index, so pass `--license` explicitly
when you need a hard guarantee on what you reuse.

> *"Search the creative library for kinetic monochrome references — high motion,
> black and white, geometric. Restrict to CC0 + public domain so I can reuse
> anything that comes back."*

```bash
tdmcp creative-rag search "kinetic monochrome geometric" \
  --license CC0,PublicDomain --k 5 --json
```

```json
[
  {
    "id": "a1b2c3d4...",
    "score": 0.78,
    "title": "Composition with Black Lines",
    "sourceUrl": "https://www.artic.edu/...",
    "license": "PublicDomain",
    "type": "artwork",
    "tags": ["geometric", "monochrome", "motion-study"]
  },
  {
    "id": "e5f6a7b8...",
    "score": 0.74,
    "title": "Rhythm of a Russian Dance",
    "sourceUrl": "https://www.rijksmuseum.nl/...",
    "license": "CC0",
    "type": "artwork",
    "tags": ["kinetic", "dance", "geometry"]
  }
]
```

*Use `--json` when you need ids for the next step. The human table is intentionally
shorter and prints score, title, type/license and source URL; the structured payload
adds `id`, `tags` and other card fields for agents or scripts.*

> *"Show me only CC0-licensed architectural artworks from the creative
> library."*

```bash
tdmcp creative-rag search "architecture facade" \
  --license CC0 --type artwork --tags architecture --k 5 --json
```

```json
[
  {
    "id": "3f4d5e6a...",
    "score": 0.81,
    "title": "Facade Study, Rietveld Schroder House",
    "sourceUrl": "https://www.rijksmuseum.nl/...",
    "license": "CC0",
    "type": "artwork",
    "tags": ["architecture", "de-stijl", "geometric"]
  },
  {
    "id": "c7d8e9f0...",
    "score": 0.77,
    "title": "Steel Frame, Construction Series",
    "sourceUrl": "https://www.clevelandart.org/...",
    "license": "CC0",
    "type": "artwork",
    "tags": ["architecture", "structure", "grid"]
  }
]
```

*`--license CC0` narrows beyond the default allowlist (drops PublicDomain) so
the result is strictly CC0. `--type` accepts the CLI enum
(`project|artist|artwork|technique|cue_reference`); use `--tags` (CSV) for finer
filters like `architecture`, `geometric`, `sculpture`. All filters stack.*

> *"Open card `3f4d5e6a…` from the creative library and summarize the artist's
> intent so I can build a TD scene from it."*

The MCP client fetches `tdmcp://creative/cards/3f4d5e6a…` (where `id =
sha256(sourceUrl)`) and gets back the full card as JSON:

```json
{
  "id": "3f4d5e6a...",
  "schemaVersion": 1,
  "type": "artwork",
  "title": "Facade Study, Rietveld Schroder House",
  "sourceUrl": "https://www.rijksmuseum.nl/...",
  "sourceName": "rijksmuseum",
  "license": "CC0",
  "body": "Frontal study of a De Stijl facade with rigid planes and window-grid rhythm.",
  "tags": ["architecture", "de-stijl", "geometric", "primary-colors"],
  "palette": ["#E63946", "#F1FAEE", "#1D3557", "#FFD166"],
  "visualLanguage": "rigid orthogonal grid, flat planes",
  "tdmcpAffordances": ["create_glsl_shader", "create_grid_layout"],
  "contentHash": "sha256:..."
}
```

*The real card shape is flat: `body`, `palette` and `visualLanguage` are top-level
optional fields, `type` must be one of the Creative RAG enum values, and
`tdmcpAffordances` is a `string[]` of suggested tool names (see
`src/creativeRag/schema.ts`). Read the card, distill the artist's intent in prose,
then hand the affordances + palette to whichever Layer 1 tool fits — for example,
"use this palette and grid `visualLanguage` to build a kinetic monochrome GLSL
scene". The cookbook stops here; the actual build is whichever Layer 1 tool the
affordances point at.*

## Project library (Project RAG)

The **project repertoire** is the developer-side cousin of Creative RAG: an
opt-in local index of open-licensed TouchDesigner *projects, components and
snippets* — `.toe`/`.tox` files and shader excerpts pulled from curated GitHub
sources — so the agent can ground an effect in **real working code** before
writing any new node. The CLI is `tdmcp project-rag <sync|index|search>`;
`tdmcp://project/cards/{id}`, `tdmcp://project/search{?q,k,license,type,operator,tags}`
and the new `tdmcp://project/sources` are read-only MCP resources. The
`project_rag_context` MCP prompt and the `project_rag_search` copilot tool
expose the same index to LLM clients — both are gated by
`TDMCP_RAG_ENABLED=1 && TDMCP_PROJECT_RAG_ENABLED=1`.

### When to use Project RAG vs Creative RAG

Two RAGs, two questions. Creative RAG answers *"what should this look like?"*
— it surfaces artworks, palettes and visual language. Project RAG answers
*"how is this actually built in TD?"* — it surfaces working `.toe`/`.tox`
networks and operator wiring you can read or adapt. Mixing them is the point.

> *"I want to build a hand-tracking feedback piece. First run the
> `project_rag_context` prompt with `query: 'hand tracking mediapipe feedback'`
> so I can see how real TD projects wire it; then pick the most permissive
> one and adapt the operator chain into a new network."*

```text
tdmcp://project/search?q=hand+tracking+mediapipe+feedback&k=5
→
0.823  MediaPipe Hand Pose Demo [project] — MIT — tdmcp://project/cards/abc123…
0.781  Real-time Hand Tracker [project] — CC-BY-4.0 — tdmcp://project/cards/def456…
0.704  Feedback Optical Flow Hands [snippet] — Apache-2.0 — tdmcp://project/cards/789abc…
```

*The prompt returns titles, licenses and `tdmcp://project/cards/{id}` URIs —
not opaque embeddings. Inspect each card via `read_resource` to see the full
operator list and the path to the binary you can open in TD. Use Creative
RAG for **palette/mood**; use Project RAG for **the TD wiring that makes it
move**.*

### Finding real examples before coding an effect

When the model wants to *generate* a new effect, the safest first step is
**search before synthesis** — find what already exists, in code, under a
license you can reuse.

> *"I'm about to build an audio-reactive trails network. Before you create any
> ops, run `tdmcp project-rag search 'audio reactive trails feedback'
> --license CC0,MIT,Apache-2.0 --k 5` and quote the top three cards
> (title + license + URI). Open the most permissive one via
> `tdmcp://project/cards/{id}` and tell me which operators it uses. Then we
> decide whether to copy, adapt, or build fresh."*

```bash
tdmcp project-rag search "audio reactive trails feedback" \
  --license CC0,MIT,Apache-2.0 --k 5
```

*The CLI mirrors `tdmcp creative-rag search` — same flag layout, same
license-gated reuse story. The difference is that the cards here point to
runnable TD networks instead of static artworks, and `--operator AudioSpectrumCHOP`
narrows further to cards that actually wire a given op. When sparse results
come back on the creative side, the CLI also prints a stderr tip suggesting
`tdmcp project-rag search "<q>"` as a cross-link, so the agent can pivot
between the two libraries without losing the query.*

> *"Tonight I need a quick fog-organism look. List configured Project RAG
> sources first via `tdmcp://project/sources` — I want to know which are
> ready vs planned before searching, so I don't chase cards that aren't
> indexed yet."*

```json
[
  { "name": "github-repo", "displayName": "GitHub seed repos", "status": "ready" },
  { "name": "github-topic", "displayName": "GitHub topic scanner", "status": "ready" },
  { "name": "matthewragan", "displayName": "Matthew Ragan", "status": "planned" }
]
```

*`tdmcp://project/sources` is the honest map of what's indexed locally. A
`status: "planned"` source means the adapter exists but isn't wired into your
current sync — useful context when search results look thinner than you
expected. Pair it with the `project_rag_context` prompt to let the agent
reason about coverage before it commits to a build path.*

### Opting into the Interactive & Immersive HQ manual (non-commercial)

A whole TouchDesigner manual is available as searchable `tutorial` cards — but
it ships **off by default** because its license is **CC-BY-NC-SA-4.0**
(non-commercial, share-alike, attribution required). Turn it on only for
personal/learning use:

```bash
export TDMCP_PROJECT_RAG_IIHQ=1
tdmcp project-rag sync --source iihq
tdmcp project-rag search "optimize a slow CHOP network" --type tutorial --k 3
```

> *"Enable the IIHQ tutorial source and find chapters that explain GLSL TOPs.
> Quote each card's license and remind me of the reuse terms before I copy
> anything into a commercial show."*

*Every IIHQ card is hard-stamped `CC-BY-NC-SA · non-commercial` and carries
rights notes telling you to attribute **The Interactive & Immersive HQ**, keep
it non-commercial, and share alike. Only the manual's **text** is indexed — no
`.tox`/`.toe`/example binaries are ever downloaded (the license policy denies
CC-BY-NC-SA binaries outright). If you're building for a paid gig, treat these
cards as background reading, not as assets to ship.*

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
