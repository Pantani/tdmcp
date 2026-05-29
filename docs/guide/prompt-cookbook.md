---
description: "Copy-paste prompts for building visuals with tdmcp, the TouchDesigner MCP server — feedback tunnels, audio-reactive, particles, generative art and more."
---

# Prompt cookbook

Copy these, change the words, and make them yours. They're grouped by what you
want to make. After any build, you can always say **"show me a preview"** and then
nudge it: *"warmer", "slower", "more contrast", "add a glitch".*

::: tip How to phrase it
Describe the **result and the feeling**, not the nodes. "A slow, hypnotic, deep-blue
tunnel" works better than naming operators. The AI picks the operators.
:::

## Generative & abstract

> *"Create a feedback tunnel from noise with blur and displace, add bloom, and
> show me a preview."*

<video src="/examples/feedback-tunnel.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Real output from the prompt above — a feedback network (blur + displace),
captured live from TouchDesigner.*

> *"Make an evolving reaction-diffusion pattern in greens and blacks, slow and
> organic."*

<video src="/examples/reaction-diffusion.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Reaction-diffusion, simulated on the GPU.*

> *"Build a flowing noise landscape in 3D with an orbiting camera."*

<video src="/examples/noise-landscape.mp4" autoplay loop muted playsinline style="width:100%;max-width:560px;border-radius:8px;display:block"></video>

*A noise-displaced 3D terrain.*

> *"Give me a strange-attractor visual with glowing particles on black."*

<video src="/examples/strange-attractor.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A real de Jong strange attractor — orbit points glowing on black, with a Speed knob to evolve it. Captured live.*

> *"Give me a 1970s analog video-synth look — soft interference patterns and
> rolling scanlines in electric teal and pink."*

<video src="/examples/analog-video-synth.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Procedural lissajous / interference / scanline patterns animated over time with
frequency and color controls — a self-contained Rutt-Etra-style oscilloscope wash,
no footage needed.*

> *"Build a raymarched fractal tunnel I can fly through, glowing cyan on black,
> with a Speed knob."*

<video src="/examples/raymarched-tunnel.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A signed-distance-field scene rendered entirely in a GLSL TOP — an infinite tunnel
you fly through, with camera-Speed and color controls. No geometry nodes, all math.*

> *"Sculpt a soft, morphing metaball blob in 3D that slowly breathes, iridescent
> surface on a dark stage."*

<video src="/examples/shader-park-blobs.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A Shader Park-style SDF sculpt (blended spheres and noise) compiled to a GLSL TOP,
with morph-Speed and surface controls — organic, clay-like volumes that pulse and merge.*

> *"Pull me into an endless zooming feedback tunnel of my webcam, trailing and
> spinning, deep magenta."*

<video src="/examples/feedback-tunnel-infinite.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A dedicated infinite-zoom feedback loop (zoom + rotate + decay) seeded from any
source, with Zoom / Spin / Trail knobs — the classic "falling into the screen" tunnel.*

## Audio-reactive

> *"Make an audio spectrum analyzer with colored bars that react to my music."*

![An FFT audio spectrum drawn as colored bars by tdmcp](/examples/audio-spectrum.png)

*Live audio analyzed into a frequency spectrum (shown driven by a test signal —
point it at your mic or a track).*

> *"Create an audio-reactive particle galaxy driven by the beat, and preview it."*

> *"Build a radial spectrum that pulses on the bass, warm colors."*

**What you'll get:** an analysis chain (spectrum + level + beat) feeding a visual,
usually with a *Sensitivity* knob. See the
[microphone permission note](/guide/troubleshooting#macos-microphone-camera-permission)
on macOS, or ask for a **test tone** instead of the mic while experimenting.

> *"Build a 3D ball of spikes that stab outward on the bass and shimmer with the
> highs — preview it on a test beat."*

<video src="/examples/audio-reactive-3d-spikes.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A rendered 3D geometry whose displacement, scale and rotation are wired to live
audio bands (bass / mid / treble) with a Sensitivity knob — a spiky, breathing solid
that dances to the track. Uses a synthetic source so it previews without mic permission.*

> *"Sidechain this layer to the kick so it ducks down and pumps back on every beat,
> like a compressor."*

*An attack/release envelope follower with gate/duck — sidechain a layer's opacity or
brightness to the kick so it pumps in time, going beyond a plain Lag smoothing. The
"sidechain pump" every electronic producer knows, applied to a visual.*

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

> *"Cut my body out as a clean silhouette I can fill with a moving texture — no
> depth camera, use my webcam."*

<video src="/examples/depth-silhouette-mask.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A silhouette/body matte extracted from a depth or video source (device-free by
default), output as a mask you can key a visual into — your shape becomes a window
onto another layer. Normally this implies a Kinect; here it works from a plain webcam.*

### Body tracking (webcam, no extra hardware)

Full-body **pose tracking** from a plain webcam, via the free
[MediaPipe plugin](https://github.com/torinmb/mediapipe-touchdesigner) (install once
with `tdmcp install mediapipe-touchdesigner`).

> *"Set up body tracking from my webcam and show me the skeleton."*

> *"Make glowing dots track my joints and leave motion trails as I move."* (the
> `body_tracking_reactive` recipe)

> *"Drive the visual's intensity from how much my body is moving."*

**What you'll get:** the MediaPipe engine loaded + an adapter that emits a 33-landmark
pose CHOP (tx/ty/tz/confidence), then a live skeleton or a camera-reactive visual. Keep
the TD timeline **playing** (the plugin captures through an embedded browser that only
runs while playing) and grant camera permission if macOS asks. No webcam handy? Ask for
a **synthetic** pose source to build and preview the look offline.

## Particles & 3D

> *"Create a particle system emitted from a sphere with turbulence and gravity,
> rendered as glowing sprites."*

![A particle system built by tdmcp — thousands of sprites bursting from a sphere](/examples/particle-galaxy.png)

*A particle galaxy (still frame — particle motion is too fine-grained to embed as
a light clip).*

> *"Make 10,000 particles that swirl like a galaxy."*

![10,000 GPU particles swirling like a galaxy on black](/examples/particles-swirl.png)

*A galaxy of points swirled by a vortex (still frame).*

> *"Build a 3D scene with instanced cubes reacting to a noise field."*

<video src="/examples/scene-3d.mp4" autoplay loop muted playsinline style="width:100%;max-width:560px;border-radius:8px;display:block"></video>

*Instanced 3D cubes, spinning.*

**What you'll get:** a particle or geometry system with live *Drag / Turbulence /
Gravity / Lifetime* knobs to shape the motion.

> *"Show a polished metallic sphere on a turntable with realistic studio lighting
> and soft reflections."*

<video src="/examples/pbr-product-spin.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A physically-based 3D scene (PBR material + environment lighting + Render TOP) with
roughness/metalness and a spin knob — a believable studio render of a primitive, not
a flat-shaded toy.*

> *"Make a slowly-drifting point cloud of a sphere, tiny glowing points that twinkle,
> on deep black."*

<video src="/examples/point-cloud-drift.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A point-cloud render of a sampled surface (sphere, grid or model) as thousands of GPU
points with size/jitter and drift controls — the LiDAR/scan look without a scanner or
PLY file.*

> *"Push my webcam image into 3D relief so bright areas pop toward the camera, lit
> from the side."*

<video src="/examples/depth-displacement-relief.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A plane displaced into real 2.5D geometry by a depth/luminance map via a GLSL MAT
vertex stage, with depth-Amount and lighting — your image becomes a sculpted, side-lit
terrain you can light and orbit.*

> *"Render a 3D scene with ambient-occlusion shadows and use its depth to push another
> image into relief — and I don't own a depth camera."*

<video src="/examples/multipass-depth-no-camera.mp4" autoplay loop muted playsinline style="width:100%;max-width:560px;border-radius:8px;display:block"></video>

*A multi-pass 3D render (Render + SSAO pass) that also emits a synthetic depth output,
which then feeds depth-displacement or silhouette — contact-shadowed 3D plus a depth
map manufactured in software, no depth sensor required.*

## Video & camera

> *"Pipe my webcam through edge detection, an RGB split and a feedback loop for a
> glitchy look."*

<video src="/examples/video-glitch.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The glitch / VHS look — scanlines, RGB split and datamosh (shown on a synthetic
source rather than a live webcam).*

> *"Play this video file on a loop with speed control."* (give it the path)

<video src="/examples/video-player.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A movie file loaded into a player with live Play / Speed controls
([Big Buck Bunny](https://peach.blender.org), CC-BY).*

> *"Take my webcam and make it look like an old, degraded VHS tape."*

> *"Set up two video decks with a big crossfader so I can blend between two clips
> like a DJ."*

<video src="/examples/dj-decks-crossfade.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A/B decks blended by a master crossfader (Cross TOP) with per-deck gain; each deck
pulls a source TOP or a built-in test source — the visual equivalent of a DJ mixer,
the core of any VJ rig.*

## Text & titles

> *"Add the title 'OPENING SET' centered over this visual in white."*

![The title OPENING SET in white, centered over a visual](/examples/text-title.png)

> *"Put the song name in the bottom-left corner in hot pink."*

![A song name in hot pink in the lower-left corner of a visual](/examples/text-songname.png)

> *"Make a transparent lower-third text layer I can composite later."*

![A lower-third title bar over a visual](/examples/text-lowerthird.png)

*Shown over a visual; the real layer is transparent, ready to composite.*

**What you'll get:** a styled text layer (font size, color, alignment) composited
over your visual or on its own transparent background — ready to send to output.
Great for lyrics, titles, song names and credits.

> *"Flash the word 'DROP' big and centered, snapping to the beat and vanishing
> between hits."*

<video src="/examples/kinetic-lyrics-flash.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Animated lyric typography that flashes, pulses or slides; the flash modulates alpha
so the text disappears over your visual instead of going to black, and it's
beat-syncable. Exposes the word, size and flash rate.*

> *"Make my festival name as chunky extruded 3D chrome letters, slowly rotating with
> a spotlight."*

<video src="/examples/3d-extruded-title.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Extruded 3D type (Text SOP → bevel/extrude → material + Render) with rotation and
lighting — real volumetric letters you can light and spin, not a flat text overlay.*

## Live performance & control

> *"Add knobs for feedback, zoom, spin and blur so I can perform this live."*

> *"Animate the spin knob with a slow LFO."*

> *"Make a tempo clock at 128 BPM and sync the movement to the beat."*

> *"Lock the tempo to Ableton Link so it follows whatever's on the network."*

> *"Follow the MIDI clock coming from my DJ software."*

> *"Set up two cues — 'intro' and 'drop' — that I can morph between."*

> *"Let me control the main knobs from my phone."*

> *"Map my MIDI controller's first fader to the Sensitivity knob."*

> *"Going live now — turn on perform mode so nothing hitches mid-show."*

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

## Output & mapping

> *"Output the final visual to a full-screen window on my second monitor."*

> *"Send this out over NDI so I can use it in OBS."*

> *"Corner-pin this onto a projector and let me drag the corners."*

<video src="/examples/projection-mapping.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A source warped through a corner-pin keystone — drag the four corners to line it
up with a wall, screen or object.*

> *"Record the output to a movie file for 30 seconds."*

## Fixing & understanding

> *"Something looks broken — check the network for errors and fix them."*

> *"The output is black — look at it and tell me why."* (combines the preview,
> topology and node errors to diagnose)

> *"Explain what this network is doing, step by step."*

> *"This is running slow — find the bottleneck and optimize it."*

> *"Audit this project — what's unused, what file paths are broken, which COMPs are
> orphaned?"*

> *"Tidy up the layout so I can read it."*

> *"Box up the audio chain with an annotation and label it, then list what's inside."*

## Reusable components & documentation

Turn a working network into something you can reuse, share and hand to another agent.

> *"Add Speed, Color and a Glow toggle as custom parameters on this component."*

> *"Give this COMP a Python extension class with `play` and `reset` methods."*

> *"Write a README for this project — what it does, its controls and inputs."*

> *"Drop a project CLAUDE.md so the next session knows the conventions."*

> *"Save this look as a reusable .tox component."* (`manage_component`)

**What you'll get:** declarative custom-parameter pages, scriptable extensions, a
generated Markdown README (with a preview thumbnail), or a project-local agent guide —
the *packaging* side of tdmcp that complements the generators above.

## Signature effects & looks

> *"Fold my webcam into a slowly-rotating six-fold kaleidoscope, deep jewel tones,
> and show me a preview."*

<video src="/examples/kaleidoscope-webcam.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A live polar-fold GLSL mirror turns any source into a symmetric mandala; exposes
Segments and a rotation/Speed knob. Pointed at the webcam it makes the room bloom
into kaleidoscopic petals.*

> *"Make my video look like a corrupted file that smears and melts on every hard
> cut — heavy datamosh."*

<video src="/examples/datamosh-pixel-melt.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A feedback-driven pixel-displacement smear that bleeds motion vectors across frames,
with Amount/Decay controls — the classic "broken codec" bloom-and-melt look on a
default test source (swap in your clip).*

> *"Turn this into warm, amber-tinted halftone dots like a vintage newspaper print,
> and preview it."*

<video src="/examples/halftone-amber-print.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A GLSL halftone screen converts the image into a grid of ink dots whose size tracks
brightness; exposes Dot scale / Angle / tint. Amber tint plus paper-white background
gives a retro-print feel.*

> *"Warp this footage with a flowing liquid distortion that ripples like heat haze
> over the whole frame."*

<video src="/examples/displacement-warp-liquid.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Drives a Displace TOP from an animated noise field so the source ripples and flows,
with Amount/Speed controls — that premium "liquid morph" / heat-haze warp over any clip.*

> *"Give this a moody teal-and-orange cinematic grade — crush the blacks a touch and
> lift the highlights."*

<video src="/examples/cinematic-color-grade.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A lift/gamma/gain + saturation/hue grade (with optional LUT) on any source, exposing
the wheels as knobs — the Hollywood teal/orange look as a finishing layer, the thing
people buy plugins for.*

> *"When I move this slider, glitch-cut from the first clip to the second with a burst
> of digital noise."*

<video src="/examples/transition-glitch-cut.mp4" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*An A→B transition over a single 0–1 Progress knob with selectable styles (dissolve /
luma_wipe / slide / zoom / glitch_cut) — drag the fader to wipe between two sources
mid-show.*

## Mixing & layering

> *"Stack four layers with blend modes and opacity, each with mute and solo, so I can
> mix a look on the fly."*

*An N-layer compositor with per-layer blend mode + opacity + mute/solo and a generated
control strip — a Photoshop / After-Effects-style layer stack you can perform, a mixing
desk for visuals.*

## Data-driven visuals

Reactivity beyond sound — drive visuals from a live web feed, a spreadsheet or a table.

> *"Pull the live BTC price from a web API and drive the visual's color and speed from
> how fast it's moving."*

*One tool pulls a live JSON/web feed into CHOP channels; a second maps those channels
onto a visual's parameters with per-mapping range remap — the data counterpart to audio
reactivity. Your visuals react to a live internet data feed (price, weather, anything).*

> *"Turn this spreadsheet of monthly sales into animated 3D bars that grow in, with
> value labels."*

*A data-driven visualization network (bars or graph from a table) with a Scale knob and
animated entrance — a real-time, performable infographic rather than a static chart.*

> *"Clone this little card design once per row of my table, each labeled with that
> row's name."*

*A Replicator COMP that clones a template COMP per Table-DAT row, parameterizing each
clone from its row — data-driven instancing of whole sub-networks, not just geometry,
the way motion designers fake "100 of these."*

## Working from your own notes (Obsidian vault)

If you keep an [Obsidian vault](/reference/tools#obsidian-vault) wired up:

> *"Build tonight's set from my 'Friday' setlist note."*

> *"Generate a visual from my 'deep ocean' moodboard."*

> *"Save this look as a recipe in my vault and log it to my show diary."*
