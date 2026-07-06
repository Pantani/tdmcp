---
description: "Build your first audio-reactive visual with tdmcp — from silence to a spectrum-driven scene that reacts to your mic, with one live Sensitivity control you can perform."
level: beginner
---

<script setup>
import { withBase } from "vitepress";
</script>

# Your first audio-reactive visual <Badge type="tip" text="Beginner" />

**Objective** — build a visual that reacts to sound coming into your mic, with one
live control you can perform, entirely by asking in plain language.

**What you'll see** — a glowing spectrum that rises and falls with the music, plus a
placeholder frame whose brightness pulses to the beat. Turn one knob and the whole
scene gets more or less sensitive.

<video :src="withBase('/examples/tutorial-audio-reactive-visual.mp4')" autoplay loop muted playsinline style="width:100%;max-width:480px;border-radius:8px;display:block"></video>

*The reactive output frame pulsing in colour and brightness with the sound (captured with a test tone).*

**Before you start**

- [tdmcp installed](/guide/install) for your AI assistant (Claude or Codex).
- TouchDesigner open, with `bridge running` in the Textport. See
  [Install for Claude](/guide/install) if you don't.
- A microphone. No mic? No problem — a step below uses a test tone instead.

## Steps

Type each prompt to your AI assistant, one at a time. Wait for it to finish before
sending the next.

1. Check TouchDesigner is connected.

   ```text
   Check that TouchDesigner is connected and tell me what version I'm on.
   ```

   The assistant runs a quick health check (`get_td_info`). You should get back a
   version and "connected". If not, see [If it goes wrong](#if-it-goes-wrong).

2. Build the audio-reactive starter.

   ```text
   Apply the audio_reactive_basic recipe. If my mic isn't available, use a test tone
   instead so I can still see it react.
   ```

   This drops in a validated network: an audio input feeds a spectrum analyzer and an
   RMS level, and leaves a placeholder frame ready to react.

3. Make the picture react to the sound.

   ```text
   Bind the placeholder frame's brightness to the RMS level so it pulses with the music.
   ```

   The assistant wires the audio level (the `level_null` channel) into the frame's
   color using `bind_to_channel`. Play some music or speak — the frame should pulse.

4. Add a spectrum bar visual.

   ```text
   Add an audio_spectrum_bars visual next to it, driven by the same audio, so I can
   see the frequencies as colored bars.
   ```

   You get the classic analyzer look: a row of glowing cyan-to-magenta bars rising and
   falling with the music.

5. Expose one control you can perform.

   ```text
   Expose a single Sensitivity control I can turn live to make the whole scene react
   more or less strongly.
   ```

   The recipe's built-in **Sensitivity** control (range 0–4) becomes a live slider.
   Turn it up and quiet sounds pop; turn it down to calm it.

6. See it.

   ```text
   Auto-arrange everything and show me a preview of the output.
   ```

   The assistant lays the network out left-to-right, checks for errors, and returns a
   thumbnail of the result.

## Expected result

In TouchDesigner you'll see a tidy left-to-right chain: audio in → spectrum + RMS
level → a spectrum-bars visual and a pulsing placeholder frame → a final output. The
preview shows glowing bars and a frame that breathes with the sound, and dragging the
**Sensitivity** slider visibly changes how hard everything reacts.

## If it goes wrong

- **Nothing reacts / it's silent** — your mic may be muted or unavailable. Ask:
  *"Switch the audio source to a test tone."* Then confirm your OS lets TouchDesigner
  use the microphone. More in [Troubleshooting](/guide/troubleshooting).
- **No preview appears / "can't reach TouchDesigner"** — the bridge isn't running.
  Check the Textport for `bridge running` and re-run step 1. See
  [Troubleshooting](/guide/troubleshooting).
- **It reacts too weakly or too strongly** — turn the **Sensitivity** control from
  step 5, or ask *"Raise the Sensitivity default."*
- **Still stuck?** — the [FAQ](/guide/faq) covers the most common first-run questions.
