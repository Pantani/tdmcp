---
description: "Build a VJ set in TouchDesigner with tdmcp — two contrasting scenes on a crossfading layer mixer, a 128 BPM tempo clock, a cued timeline, and a live control panel you can perform front-of-house."
---

<script setup>
import { withBase } from "vitepress";
</script>

# A VJ set with a timeline

<Badge type="info" text="Intermediate" />

**Objective** — build two contrasting scenes, blend them on a crossfading layer
mixer, lock them to a 128 BPM clock, and cue them from a timeline you can trigger
live.

**What you'll see** — a calm scene and an energetic scene sharing one output. A
single Crossfade knob wipes from one to the other, a tempo clock keeps everything
on the beat, and a small control panel lets you fire the next cue by hand.

<video :src="withBase('/examples/tutorial-vj-set-timeline.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The crossfading layer mixer wiping between the calm and energetic scenes on one output.*

**Before you start**

- tdmcp [installed for Claude](/guide/install) or [for Codex](/guide/codex).
- TouchDesigner open with `bridge running` in the Textport (see the TouchDesigner
  bridge step in [Install](/guide/install)).
- No hardware needed — the scenes are generated, so this works with nothing plugged
  in. If you want to VJ real clips later, swap the sources afterwards.
- Skim [Show timelines & setlists](/guide/show-timelines) and the
  [Front-of-house dashboard](/guide/dashboard-foh) — this tutorial is the hands-on
  version of both.

## Steps

Type each prompt to your assistant, in order. Each one builds on the last.

1. Confirm TouchDesigner is connected before you build anything.

   ```text
   Check that TouchDesigner is connected and tell me the project name.
   ```

   The assistant reports the bridge status. If it says it can't reach TouchDesigner,
   fix that first — nothing downstream will work.

2. Make two scenes with opposite energy so the crossfade is obvious.

   ```text
   Build two contrasting scenes: a calm, slow one and an energetic, fast one.
   Give each its own output so I can blend between them.
   ```

   You get two independent looks, each ready to be mixed.

3. Put both scenes on one crossfader so a single knob wipes between them.

   ```text
   Apply the layer_mixer_crossfade recipe and point source A at the calm scene
   and source B at the energetic one, so 0 is calm and 1 is energetic.
   ```

   This lands the `layer_mixer_crossfade` recipe: one Cross TOP with a 0–1 knob,
   your two scenes wired in as A and B.

4. Add a tempo clock so the whole set stays on the beat.

   ```text
   Apply the tempo_sync_clock recipe and set the tempo to 128 BPM.
   ```

   The `tempo_sync_clock` recipe drops in a Beat CHOP and a `tempo` Null that
   exposes the bar phase, per-beat pulse and BPM for anything to lock onto.

5. Build the timeline that cues scene A, then scene B.

   ```text
   Apply the scene_timeline_demo recipe so I have a playhead and a segments table
   that moves from scene A to scene B, and line it up with my crossfader.
   ```

   The `scene_timeline_demo` recipe gives you a Timer CHOP playhead and a segments
   table (intro / drop / outro) as the show clock for your two scenes.

6. Expose the controls you'll actually touch during the set.

   ```text
   Give me a control panel with a Crossfade knob, a Tempo (BPM) field, and a
   "Next cue" button so I can trigger the timeline by hand.
   ```

   You get a small panel wiring the Crossfade knob, the tempo, and a cue trigger
   into live controls — no digging in the network mid-show.

7. Preview the result.

   ```text
   Show me a preview of the final output.
   ```

   The assistant captures the mixed output so you can confirm the crossfade wipes
   cleanly between your two scenes.

8. Get it ready for front-of-house.

   ```text
   How do I run this front-of-house — full-screen on my output display with the
   control panel in reach?
   ```

   Follow the assistant's steps to send the output to your projector/screen and
   keep the panel on your operator display. The
   [Front-of-house dashboard](/guide/dashboard-foh) guide covers this surface in
   depth.

## Expected result

A left-to-right network: two scenes → a Cross TOP → your output. Off to the side, a
`tempo` Null running at 128 BPM and a timeline playhead with a segments table. Your
control panel has three live controls — **Crossfade**, **Tempo (BPM)**, and **Next
cue**. Turning the Crossfade knob wipes from the calm scene to the energetic one;
the tempo clock keeps any beat-locked motion on time; the Next-cue button advances
the timeline from scene A to scene B.

## If it goes wrong

- **The Crossfade knob does nothing** — check source A and B are wired into the Cross
  TOP. Ask: *"Which two sources feed the crossfader, and are they connected?"* See
  [Troubleshooting](/guide/troubleshooting).
- **Cues don't fire when I press Next** — the playhead and the crossfader aren't
  linked yet. Ask the assistant to *"link the timeline playhead to the Crossfade
  control so a cue moves the fade."* More on cueing in
  [Show timelines & setlists](/guide/show-timelines).
- **The beat drifts or feels off-tempo** — confirm the tempo is set on the Beat CHOP,
  not just typed in a field: *"Set the project tempo to 128 BPM on the tempo clock."*
- **No preview appears** — this is almost always the bridge. Re-check the
  TouchDesigner bridge step in [Install](/guide/install) and the
  [FAQ](/guide/faq).
