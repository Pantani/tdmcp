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

## Live performance & control

> *"Add knobs for feedback, zoom, spin and blur so I can perform this live."*

> *"Animate the spin knob with a slow LFO."*

> *"Make a tempo clock at 128 BPM and sync the movement to the beat."*

> *"Set up two cues — 'intro' and 'drop' — that I can morph between."*

> *"Let me control the main knobs from my phone."*

> *"Map my MIDI controller's first fader to the Sensitivity knob."*

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

> *"Explain what this network is doing, step by step."*

> *"This is running slow — find the bottleneck and optimize it."*

> *"Tidy up the layout so I can read it."*

## Working from your own notes (Obsidian vault)

If you keep an [Obsidian vault](/reference/tools#obsidian-vault) wired up:

> *"Build tonight's set from my 'Friday' setlist note."*

> *"Generate a visual from my 'deep ocean' moodboard."*

> *"Save this look as a recipe in my vault and log it to my show diary."*
