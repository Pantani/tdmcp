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

> *"Give me a strange-attractor visual with glowing particles on black."*

<video :src="withBase('/examples/strange-attractor.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*A real de Jong strange attractor — orbit points glowing on black, with a Speed knob to evolve it. Captured live.*

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

> *"Put waveform, RGB parade and vectorscope next to this camera feed so I can tune
> the grade before the show opens."*

<video :src="withBase('/examples/video-scopes-monitor.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*`create_video_scopes` builds a broadcast-style monitoring surface for a TOP source:
waveform, parade and vectorscope panels that make color / exposure problems visible
before they become projector problems.*

## Text & titles

> *"Flash the word 'DROP' big and centered, snapping to the beat and vanishing
> between hits."*

<video :src="withBase('/examples/kinetic-lyrics-flash.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Animated lyric typography that flashes, pulses or slides; the flash modulates alpha
so the text disappears over your visual instead of going to black, and it's
beat-syncable. Exposes the word, size and flash rate.*

> *"Make my festival name as chunky extruded 3D chrome letters, slowly rotating with
> a spotlight."*

<video :src="withBase('/examples/3d-extruded-title.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*Extruded 3D type (Text SOP → bevel/extrude → material + Render) with rotation and
lighting — real volumetric letters you can light and spin, not a flat text overlay.*

**What you'll get:** kinetic, performable text rather than a static caption: beat
flashes, alpha-safe lyric hits, extruded title geometry, lights, materials and
timeline-friendly controls.

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

> *"Lock the show to incoming OSC timecode, follow the timeline frame-for-frame, and
> jump to named cues if the timecode label says chorus or blackout."*

<video :src="withBase('/examples/timecode-sync-lock.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

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

*`tdmcp config init` prints or writes the complete `.env` surface the server reads,
with bridge/LLM secrets commented for manual entry. It is a small tool, but it makes
touring-machine setup repeatable instead of tribal knowledge.*

**What you'll get:** stage-prep tools for displays, GPU capability, DMX / Art-Net,
shared-memory IPC and multi-agent fanout. These are infrastructure surfaces, so the
useful output is usually a verified routing report rather than a pretty preview.

## Fixing & understanding

> *"Something looks broken — check the network for errors and fix them."*

> *"The output is black — look at it and tell me why."* (combines the preview,
> topology and node errors to diagnose)

> *"Explain what this network is doing, step by step."*

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

> *"Build a CHOP chain that smooths the bass, detects peaks, scales it to 0-1 and
> ends in a Null ready for bind_to_channel."*

> *"Build a SOP chain for a swept ribbon: line, noise deform, resample, sweep and
> null it so I can instance particles along it."*

> *"Author a Script CHOP called gate_logic with custom Threshold and Hold parameters
> and a ready-to-edit onCook stub."*

> *"Export this SOP outline to an SVG for the laser cutter, fit it to the viewBox,
> flip Y for print orientation and write the file beside the show assets."*

<video :src="withBase('/examples/sop-to-svg-plotter.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

**What you'll get:** structured Layer-2 authoring without raw Python ceremony:
`build_chop_chain`, `build_sop_geometry` and `author_script_operator` assemble typed
chains and stubs while keeping warnings localized to the failing stage.
`export_sop_to_svg` turns SOP primitives into a real print/plotter deliverable when
the output is a file, not a TOP.

> *"Stamp provenance on this .tox, checksum the pack, and generate a lineage graph
> for everything that remixes it."*

> *"Pack these four preset-morph slots into a vault JSON, make three variants, and
> write a component changelog trail before I sync the vault to git."*

> *"Save `/project1/hero_look` as a portable look `.tox`, tag it cinematic and
> export a tutorial companion with topology JSON and preview PNGs for teaching it."*

<video :src="withBase('/examples/look-tox-tutorial-pack.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

> *"Search my vault for components tagged `audio` and `tour-ready`, add `*favorite`
> to the keeper, then bump its minor version with a note about the new OSC controls."*

<video :src="withBase('/examples/library-tag-version-loop.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

**What you'll get:** library-trust tools around real files: provenance sidecars,
sha256 manifests, lineage graphs, curated packs, morph packs, variant packs, vault
merge/sync helpers, tag/search, SemVer history, look `.tox` exports, tutorial packs
and per-component changelogs. Good for touring rigs where "which version is on this
laptop?" matters.

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
