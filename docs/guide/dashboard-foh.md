---
description: "Build a front-of-house control surface for your TouchDesigner show with tdmcp — a web cockpit, a touchscreen panel, a phone remote, and live video/audio scopes."
---

# Front-of-house dashboard

Once the show is built, you need to *run* it — from the booth, from a phone in
the crowd, from a touchscreen at the lip of the stage. This arc is the
front-of-house (FOH) layer: control surfaces and monitors that sit on top of the
network and give an operator cue buttons, faders, a panic switch and a view of
what the signal is actually doing.

Reach for these when the build is done and you're thinking about the
performance: who taps what, on which screen, with how many seconds of warning.

## The web cockpit: `create_stage_dashboard`

`create_stage_dashboard` (Layer 2) is the primary FOH tool — a unified
web-based cockpit served by a Web Server DAT inside TouchDesigner and reachable
from any browser or phone on the network. It gives you cue-launch buttons,
master faders, a VU meter, a beat indicator and a PANIC safety control
(Blackout / Freeze).

It has two layouts, selected with `layout`:

- **`v1`** — the original cockpit.
- **`v2`** (the "dashboard-v2" pass) — adds a stereo VU meter, a BPM display, a
  cue timeline strip (driven by `cue_times` and a `tempo_channel`), an
  FPS/cook-time overlay, and a sticky confirm-tap PANIC bar so you can't blackout
  the room by mistake.

> *"Build a v2 stage dashboard for `/project1/mainstage` with my four scene cues,
> a master fader, and the BPM display, on port 9982."*

Because it runs entirely inside TD, there's no separate app to install — open the
URL it prints and you're driving the show.

## Compact surfaces

When you don't want a browser:

- **`create_control_surface`** (Layer 2) builds a playable Container COMP of
  vertical faders and cue buttons, meant to be opened in Perform/Panel mode on a
  touchscreen or second monitor. Faders drive parameters live; buttons recall or
  morph to named cues (from `manage_cue`) with optional crossfade.
- **`create_phone_remote`** (Layer 2) serves a mobile-optimized single-page web
  remote that auto-discovers a COMP's numeric custom parameters and renders them
  as range sliders — the quickest way to put a few live knobs in your pocket.
- **`create_control_panel`** (Layer 2) is the generic building block: a custom
  parameter page (sliders, toggles, menus, RGB swatches, pulse buttons) bound by
  expression to drive node parameters. Many Layer-1 tools call it internally to
  expose their own controls.

> *"Put a touchscreen control surface on my master mix: four scene cue buttons
> and faders for blur, feedback and master brightness."*

## Watch the signal: scopes & meters

FOH is also about *seeing* what's going out:

- **`create_video_scopes`** (Layer 1) builds a broadcast-style monitor with up to
  four panels — waveform (luma), RGB parade, vectorscope and histogram —
  composited into one TOP. Default source is a synthetic test pattern, so it
  builds with no camera permission; opt into `device` for the live camera.
- **`create_waveform`** (Layer 1) is the time-domain audio oscilloscope — the raw
  signal scrolling left to right — and feeds the dashboard's audio readouts.

> *"Add a 2×2 video scope monitor on the master output so I can check levels
> before doors."*

## Safety lives here too

The dashboard's PANIC control and the show's
[`create_safety_blackout_chain`](/guide/show-timelines#live-safety) are two
ends of the same idea: a kill switch the operator can always reach. Wire the
blackout into the master output, surface its toggle on the dashboard, and the
booth has a guaranteed way to cut to black.

## How it fits together

Build the show ([Show timelines & setlists](/guide/show-timelines)), then put a
surface on it: `create_stage_dashboard` for the networked web cockpit,
`create_control_surface` for a wired touchscreen, `create_phone_remote` for a
pocket of sliders. Add `create_video_scopes` / `create_waveform` to monitor the
signal, and keep the panic path one tap away.

## See also

- [Live performance & control](/guide/prompt-cookbook#live-performance-control)
  and [Output & mapping](/guide/prompt-cookbook#output-mapping) in the prompt
  cookbook.
- [Show timelines & setlists](/guide/show-timelines) for the cues and transport
  the dashboard drives.
