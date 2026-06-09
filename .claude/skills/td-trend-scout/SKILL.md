---
name: td-trend-scout
description: "Scout ONE external surface of the TouchDesigner community for what's HYPED in 2025-2026 that could become a tdmcp tool. Use when a td-trend-scout sub-agent is assigned a surface (community-showcase, tutorials, generative-ai, hardware-interactive, or vfx-aesthetics) during the tdmcp-hype-scout harness — produces `_workspace/hype-scout/01_scout_<surface>.md` with cited trend candidates ranked by hype intensity, recency, and build-ease in tdmcp."
---

# td-trend-scout — single-surface hype scouting procedure

This skill is loaded by a `td-trend-scout` sub-agent. You receive **one surface** from the orchestrator and produce one file: `_workspace/hype-scout/01_scout_<surface>.md`. You do not synthesize across surfaces — that's `td-hype-synthesizer`'s job.

## Procedure

### Step 1 — Open your scratchpad (immediately)

Write the file header before any web work, so a network failure mid-run leaves usable partial output:

```bash
mkdir -p _workspace/hype-scout
```

Then `Write` the file with this header (replace `<surface>`):

```markdown
# Hype scout — <surface>

**Surface:** <surface>
**Scout window:** 2025-Q3 → 2026 (preferentially), with documented revivals of older trends allowed.
**Run:** <YYYY-MM-DD>

## Trend candidates
```

Append each candidate as you confirm it (don't batch). If your run is cut off, the orchestrator can resume from this file.

### Step 2 — Map your surface

Use the surface map below to know **where** to look. Don't search everywhere — go deep on the channels that matter for your surface.

#### `community-showcase` — what artists are shipping

- TD Forum showcase: `https://forum.derivative.ca/c/community-showcase/`
- Instagram: search `#touchdesigner`, `#touchdesignerart`, `#touchdesignerartist`, `#touchdesigner099`
- Vimeo: `TouchDesigner` tag, `derivative` group
- Behance: `TouchDesigner` projects, filter by Recent
- x.com / Twitter: `from:elekktronaut OR from:dotsimulate OR from:paketa12` etc., `#touchdesigner`
- Are.na: TD channels (`touchdesigner`, `td-sketches`)

Look for: recurring techniques across multiple posts in the last ~6 months; *what they're making*, not who made it.

#### `tutorials` — what is being taught

- YouTube channels (search their last 6-12 months of uploads):
  - elekktronaut (Bileam Tschepe) — high-end tutorials, often front-runs trends
  - Paketa12 — practical effects
  - The Interactive & Immersive HQ — pro patterns, installations
  - dotsimulate — AI bridges (StreamDiffusion, ComfyUI)
  - Crystal Jow — generative + audioreactive
  - Matthew Ragan — fundamentals + recent advanced work
  - Acid Boi, Yeyou Studio, Noones Lab
- Skillshare / Domestika TD course catalog — what's selling
- Recent blog posts: `derivative.ca/wiki`, Medium TD tag

Look for: techniques covered by 3+ channels in 6 months = a hot front-running trend.

#### `generative-ai` — TD ↔ AI crossover

- dotsimulate's TouchDiffusion / StreamDiffusion TOX (search recent demos)
- ComfyUI-in-TD bridges (Spout/NDI/OSC, "comfyui touchdesigner")
- Realtime ML in TD: depth (MiDaS, Depth Anything), pose (MediaPipe, BlazePose), style transfer, segmentation
- ControlNet rigs driven from TD
- Audio-to-video AI (Stable Audio + TD, etc.)
- LCM / Lightning models real-time
- Forum threads on AI integration (`forum.derivative.ca` — Components & Tools, Beginners)

#### `hardware-interactive` — physical inputs

- LiDAR: Livox HAP/Tele, Ouster OS-1, iPhone LiDAR via Record3D / WebSocket
- Depth cameras: RealSense D4xx/L515, Kinect Azure (and post-Azure alternatives)
- Hand tracking: Leap Motion 2 / Ultraleap, MediaPipe Hands via NDI/Spout
- Body pose: MediaPipe BlazePose, OpenPose, BlazePose-via-NDI
- Audio interfaces / Ableton Link / MIDI: trending mappings, TouchOSC profiles, Stream Deck workflows
- Sensors: capacitive (Bare Conductive), IR, ToF, eye tracking (Tobii)
- Recent installation case studies in showcases

#### `vfx-aesthetics` — visual languages

For each candidate aesthetic, look across showcase + Instagram for recurrence:
- ferrofluid / metaballs / liquid metal / chrome
- raymarched volumetrics, SDF scenes
- particle systems with feedback loops, slit-scan
- datamosh / glitch revival, pixel-sort
- kinetic typography, type-as-form
- scan-line / CRT / VHS aesthetic
- retro-cyber, Y2K revival
- point-cloud / 3D-scan / photogrammetry aesthetic
- generative gradients, brutalist-data dashboards
- low-bit / dithered / Bayer
- voronoi / cellular / organic growth
- liquid-metal / chrome
- isometric pixel / voxel

### Step 3 — For each candidate trend, do the vet pass

Before writing an entry, check three things:

1. **Recency & evidence.** Do I have ≥2 citations from 2025-2026 (or documented revival posts)? URLs that resolve, not just memory. If not, drop or downgrade.
2. **Tool shape in tdmcp.** Can I name the layer + the TD operators or bridge endpoint? Use grep against the repo to confirm operators exist in the KB:

   ```bash
   grep -irn "realsense\|kinect\|pointCloud" src/knowledge/data/ | head
   grep -irn "create_.*audio\|create_.*particle" src/tools/ | head
   grep -irn "<keyword>" src/tools/ src/knowledge/data/ docs/ROADMAP.md
   ```

3. **tdmcp coverage.** Search `src/tools/` and `recipes/` for existing equivalents:
   - NOT-COVERED: nothing close — clean new tool.
   - PARTIAL: related tool exists but doesn't fully cover the trend (e.g. `create_audio_reactive` covers audio→visual, but not "Ableton-Link locked phrase morph").
   - COVERED: it already exists — note the existing tool name; consider as `EXTENSION` if the trend adds a preset/parameter.

### Step 4 — Write the entry

Append to your scratchpad in this exact format:

```markdown
### <N>. <Short trend name>

- **What artists are doing:** 1-3 sentences, concrete.
- **Why it's hyped:** 1 sentence about *why now*.
- **Evidence:**
  - <URL> — <1-line description of what's there>
  - <URL> — <1-line>
  - (optional) <URL> — <1-line>
- **Hype intensity:** High / Medium / Low
- **Recency tag:** e.g. `Q4-2025`, `2026`, `2024-revival`
- **Suggested tdmcp tool:** `create_<name>` — Layer <1|2|3> — touches operators `<a, b, c>` (cite KB path or note `UNVERIFIED — probe live`).
- **Build-ease guess:** S / M / L (S=hours, M=day, L=multi-day or new bridge endpoint)
- **tdmcp coverage:** NOT-COVERED / PARTIAL — existing `<tool>` / COVERED — existing `<tool>`
- **Cross-surface footnote:** (optional) e.g. "also appears in `tutorials`"
```

### Step 5 — Tally and close

End the file with a one-line tally:

```markdown
---
**Tally:** N candidates — Hype H/M/L: `<x/y/z>` — Coverage NOT/PART/COV: `<x/y/z>` — Build S/M/L: `<x/y/z>`
```

If the file is tagged `PARTIAL-DUE-TO-NETWORK`, say so at the top.

## Hype lenses (use multiple, not just one)

When you scan a surface, run each candidate through at least 2 of these lenses to confirm it's really trending:

| Lens | Question |
|---|---|
| **Recurrence** | Is this technique appearing in 3+ recent posts/videos by different creators? |
| **Front-runner** | Is a respected tutorial channel (elekktronaut, dotsimulate) teaching it now? |
| **Cross-tool** | Is it bridging TD with another hot tool (ComfyUI, Ableton, Notch, Unreal)? |
| **Hardware unlock** | Is it riding a new hardware capability (LiDAR cheap now, iPhone depth, M-series GPU)? |
| **Aesthetic moment** | Is this visual language showing up across genres (clubs, brand work, art installations)? |
| **AI moment** | Is this trend riding the real-time ML wave (StreamDiffusion, Depth Anything, etc.)? |

Single-lens trends are usually weak signal — note them but score Hype: Low. Multi-lens trends (e.g. front-runner + cross-tool + AI moment) are strong signal — score Hype: High.

## Citation rules (non-negotiable)

- **Real URLs only.** Do not paraphrase from memory.
- **At least 2 citations per entry.** If you can only find 1, lower confidence and mark `EVIDENCE-WEAK`.
- **Mix sources.** Two posts from the same Instagram account are weaker than one Instagram + one YouTube.
- **Date when possible.** Quote upload/post dates in the 1-line description (`"Sept 2025 tutorial"`).

## Working tools

- `WebSearch` to find recent posts/videos/threads on your surface.
- `WebFetch` to verify a URL is live and pull a 1-line summary.
- `Bash` (grep/find) + `Read` to check tdmcp coverage (`src/tools/`, `src/knowledge/data/`, `docs/ROADMAP.md`, `recipes/`).
- `Write` (incremental append via `Edit` after the initial header `Write`).

If `WebSearch`/`WebFetch` aren't available, do what you can with cached knowledge but tag the file `PARTIAL-DUE-TO-NETWORK` at the top and lower every entry's confidence by one notch.

## What not to do

- Don't scout outside your assigned surface (write cross-surface footnotes instead).
- Don't pad to a count — 6 high-confidence entries beat 15 weak ones.
- Don't claim hype without citations. "Everyone is doing X" without 2 URLs is not an entry.
- Don't invent operators. Cite the KB (`src/knowledge/data/`) or mark `UNVERIFIED — probe live`.
- Don't synthesize. You scout one surface; the synthesizer dedupes across them.

## Re-invocation

If `_workspace/hype-scout/01_scout_<surface>.md` already exists:

1. Read it first.
2. Apply only the requested change — refresh citations, deepen a category, re-check coverage against an updated tree.
3. Preserve existing numbering where it doesn't conflict.
