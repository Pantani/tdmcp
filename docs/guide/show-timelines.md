---
description: "Compose and automate a live show in TouchDesigner with tdmcp — timelines, setlists, beat-locked cue sequencing, and a master safety blackout, all from plain language."
---

# Show timelines & setlists

A single look is a moment; a *show* is the whole night. This arc is the
compose-and-automate layer: scaffold a show container, store and recall cues,
roll through a setlist on the wall clock, sequence cues to the beat, and keep a
master safety blackout one button away. You describe the order and the feeling;
tdmcp builds the timers, transitions and controls.

Reach for these tools when you're moving from *making visuals* to *running a
set* — a DJ night, a VJ slot, a theatre cue stack, an installation that has to
loop unattended.

## Start with a stage

`scaffold_show` creates the blank skeleton: a new container with a `master`
output Null (where your mix lands) and a `tempo` beat clock for reactivity — but
no scenes yet. It's the canvas you hang everything else on:

> *"Scaffold a show called `mainstage` and show me the container."*

From there you add looks, store them as cues, and wire the transport.

## Cues: store, recall, morph

`manage_cue` is the foundation of every cued workflow. It stores, recalls,
morphs, lists and deletes **cues** — snapshots of a COMP's custom parameters,
kept in the COMP's own storage. A morph can be eased and quantized to the beat
or bar:

> *"Store the current look as cue `drop`, then morph to it over 2 bars when I
> recall it."*

Almost everything below recalls from `manage_cue`: the sequencer, the timeline,
the clip launcher and the set navigator all read the same cue store.

## Timelines

- **`create_scene_timeline`** (Layer 2) builds a scrubbable, timer-driven
  playhead through an ordered list of scenes. Each scene points at a stored cue
  and morphs into the next on its boundary, in seconds or bars. The
  **Scene Timeline Demo** recipe shows it with three scenes and a crossfade.
- **`control_timeline_transport`** (Layer 3) is the atomic transport verb:
  play, pause, seek to a frame, jump to a named cue, or set the playback rate —
  the hook an operator or the local copilot uses to drive playback.

> *"Build a 3-scene timeline that crossfades intro → build → drop over 8 bars
> each, then play it."*

## Setlists

- **`create_setlist_runner`** (Layer 1) is a wall-clock setlist player: rows of
  (source TOP, duration, transition) auto-advance on a Timer CHOP with crossfade
  or hard cut, an optional HUD overlay, and live Play / Row / Skip / Prev / Loop
  controls. This is the "play these clips in this order, this long each" tool.
- **`compose_cue_list`** (Layer 1) turns a natural-language show description into
  a validated cue list. It uses the local LLM when configured, or a deterministic
  grammar parser otherwise, and can chain straight into the sequencer with
  `apply=true`.

With an [Obsidian vault](/reference/tools#obsidian-vault) configured, you can
also persist setlists as notes: **`import_setlist`** loads a setlist note and
builds each track's recipe into TD, and **`export_setlist_to_vault`** writes the
COMP's stored cues back out as a setlist note.

> *"Run a setlist: clip A for 30 s, clip B for 45 s, clip C for 60 s, crossfade
> 2 s between each, loop at the end, and show the HUD."*

## Beat-locked sequencing & cue composition

When the order should follow the music rather than the clock:

- **`create_cue_sequencer`** (Layer 2) plays ordered steps (each a cue plus a
  bar/beat count) quantized to the global tempo, with live Step / Active / Rate /
  Loop controls.
- **`create_phrase_locked_cue_engine`** (Layer 1) queues incoming cue pulses FIFO
  and fires them on the next phrase boundary (1/2/4/8/…/64 bars), so a hit
  triggered anywhere lands cleanly on the next phrase.
- **`create_set_navigator`** (Layer 1) is a hands-light, QLab-style stage
  navigator — step through an ordered list of scene/cue names with Index / Next /
  Prev / Go controls, recalling each via `manage_cue`.
- **`create_clip_launcher`** (Layer 2) lays cues out as a rows × cols button grid
  that recalls or morphs on tap.
- **`create_scheduler`** (Layer 2) fires named timers with segments — recall a
  cue, set a parameter, or run a script stub — at each segment boundary.

To lock all of this to an external transport, **`sync_external_clock`** (Layer 1)
wires MIDI, OSC, Ableton Link or a network tempo into a Beat CHOP, so the
sequencer, phrase-lock engine and quantized morphs all follow the incoming clock.

## Live safety

A show needs a kill switch that always works:

- **`create_safety_blackout_chain`** (Layer 1) protects the master output with a
  deterministic fade-to-black (configurable curve and time), an optional
  hard-cut emergency snap, an optional hotkey and external watchdog trigger, and
  a symmetric fade-in recovery. It is fully parameter-driven — no Python at cook
  time — so it stays safe even with `TDMCP_BRIDGE_ALLOW_EXEC=0`.
- **`create_panic`** (Layer 2) adds a per-source kill + freeze: a Blackout toggle
  that drives brightness to zero and a Freeze toggle that holds the last frame.

> *"Add a safety blackout on the master output with a 1.5 s ease-out fade and an
> armed emergency hard-cut on a hotkey."*

## How it fits together

`scaffold_show` gives you the master output and tempo clock. `manage_cue` stores
the looks. A **timeline** (`create_scene_timeline`) or **setlist**
(`create_setlist_runner`) drives the order; a **sequencer**
(`create_cue_sequencer` / `create_phrase_locked_cue_engine`) locks it to the
beat via `sync_external_clock`; and `create_safety_blackout_chain` sits last on
the master so the kill switch is always in reach.

## See also

- [Live performance & control](/guide/prompt-cookbook#live-performance-control)
  in the prompt cookbook for copy-paste prompts.
- [Front-of-house dashboard](/guide/dashboard-foh) to drive all of this from a
  phone or touchscreen.
- [Recipe gallery](/guide/recipes) for the Scene Timeline Demo and other
  ready-made starters.
