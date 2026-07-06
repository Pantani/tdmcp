---
description: "Glossary for tdmcp, the TouchDesigner MCP server — MCP, the bridge, operators, TOP/CHOP/SOP and other TouchDesigner terms in plain language."
---

# Glossary

Plain-language definitions for the words you'll hear. You don't need to memorize
these — the AI handles the technical side — but they help when reading previews or
talking to other artists.

## TouchDesigner basics

**TouchDesigner (TD)**
: The software you're building visuals in. It's "node-based": you connect little
boxes (operators) to build an effect.

**Operator (OP)**
: One box/node in TouchDesigner. Each does one job — make noise, blur an image,
read audio, etc. You wire them together.

**Network**
: A bunch of connected operators. Your whole visual is a network.

**Parameter**
: A setting on an operator — a number, a color, a toggle. The "knobs" you tweak.

**Cook**
: TouchDesigner's word for "compute this frame". A slow visual has expensive
*cook times*; optimizing means making cooking cheaper.

**Textport**
: TouchDesigner's built-in console (menu **Dialogs → Textport and DATs**). You
paste the one-line bridge installer there.

## Operator families

You'll see these short names in previews and explanations:

**TOP**
: Texture Operator — anything **image/video** (noise, blur, feedback, the picture
itself).

**CHOP**
: Channel Operator — **numbers/signals over time** (audio, animation, MIDI, an LFO).

**SOP**
: Surface Operator — **3D geometry** (shapes, meshes, particles).

**COMP**
: Component — a **container** that holds a whole network, and the panels/knobs you
perform with.

**DAT**
: Data Operator — **text and tables** (scripts, data, the bridge's callbacks).

**MAT**
: Material — how 3D surfaces are **shaded/lit**.

## Performance & live terms

**Feedback**
: Feeding a frame back into itself so it evolves — the basis of tunnels, trails and
many hypnotic looks.

**LFO**
: Low-Frequency Oscillator — a slow, automatic wave that moves a knob for you
(gentle pulsing, sweeping, breathing).

**Preset**
: A saved snapshot of your knob settings you can recall instantly.

**Cue**
: A named look you can jump or smoothly *morph* to during a performance.

**Tempo / BPM sync**
: Locking movement to a musical tempo so it pulses on the beat.

**GLSL / shader**
: Code that runs on the graphics card to draw an image pixel-by-pixel — used for
the fastest, most custom effects.

## Inputs & outputs

**OSC / MIDI**
: Common ways to control parameters from hardware or other apps (a fader, a pad, a
DAW).

**DMX / Art-Net**
: Protocols for controlling stage **lighting** and LED fixtures.

**NDI / Syphon / Spout**
: Ways to send your video **to other software** (e.g. OBS, Resolume) over the
network or locally.

**Projection mapping**
: Warping your visual so it lines up with a physical surface a projector points at.

## tdmcp terms

**MCP (Model Context Protocol)**
: The open standard that lets an AI assistant use external "tools". tdmcp is an
MCP *server*.

**The bridge**
: The small piece that runs **inside TouchDesigner** so the AI can actually create
and preview nodes. You switch it on once (see [Install](/guide/install)).

**Recipe**
: A pre-built, tested network you can ask for by name — see the
[Recipe gallery](/guide/recipes).

**Vault**
: An Obsidian folder of notes tdmcp can read and write —
recipes, setlists, moodboards, presets and a show diary.

**`.mcpb`**
: The single extension file (MCP Bundle) you install in Claude Desktop. The tdmcp
server is bundled inside it.

**`.tox`**
: A TouchDesigner component file you can drag into any project — including a
reusable copy of the bridge.
