# TouchDesigner Insane Tutorials Research for TDMCP

> Research drafted 2026-05-28 against TDMCP **v0.3.1** (102 tools). The repo's current release is **v0.4.0** (per CHANGELOG / `package.json`) — fifteen new generators/prompts (raymarch & particle-flock, point-cloud/PBR/cubemap-dome, tempo detection, LED/palette/cue/dashboard, generative audio, recipe/style prompts) — and body/pose tracking is also already on `main` (in-tree, not in the 0.4.0 CHANGELOG). Together these already deliver several items framed below as planned — see the correction note and the roadmap section.
> All links below were surfaced by live web search/fetch during the research pass; none are invented. Where a source's authorship or star count was uncertain, it is hedged.
>
> **Correction (2026-05-28):** two clarifications. **(1)** The "component packaging" gap (BL-01 `export_component`/`import_component`) was **already shipped** as the **`manage_component`** tool (`.tox` `save` + `loadTox`/live-linked load; it does *not* expose `saveExternalTox` — that is the future `make_portable_tox` gap). **(2)** a lot has since landed, so several items framed below as "planned/next" are already **done**. *Shipped in v0.4.0 (per CHANGELOG):* the SDF raymarch scene (`create_raymarch_scene`), boids (`create_particle_flock`), `create_point_cloud`, `create_pbr_scene`, `create_cubemap_dome`, `detect_tempo`, plus the LED/palette/cue/dashboard/data/generative-audio tools and `text_to_recipe`/`style_reference` prompts. *Also on `main` (in-tree, not in the 0.4.0 CHANGELOG):* body/pose tracking — `setup_body_tracking`, `create_pose_tracking`, `create_pose_skeleton`, `create_body_reactive`. The genuinely-remaining work — now targeted at **v0.5.0** — is `add_custom_parameters` + `scaffold_extension`, project analysis/auto-docs, Link/MIDI, and the Embody-mined agent-DX primitives. The roadmap section and BL-02 below reflect this; treat any remaining "v0.4.0/planned" phrasing elsewhere as that shifted target.

---

## Executive Summary

TDMCP is already a deep MCP server (119 tools — three layers covering full generation, audio/beat/motion reactivity, output/mapping and live control, plus a separate vault-sync group and AI-as-prompts). The research confirms that **node-CRUD MCPs are no longer a differentiator** — there are now at least three competitors:

- **`8beeeaaat/touchdesigner-mcp`** (~330★) — leading node-CRUD MCP over a WebServer DAT. **No `.tox`/component packaging.**
- **`dylanroscover/Embody`** (~111★) — the only competitor doing **network-as-JSON + git-diffable externalization + portable `.tox` export**.
- **`dotsimulate` LOPs** (commercial) — the real threat: **60+ LLM operators *inside* TouchDesigner**, including its own **"Claude Code" operator and an "MCP Server" operator**, voice agents, RAG and STT/TTS.

So TDMCP's winning move is **not** to re-implement diffusion or node CRUD, but to own the **unclaimed, high-value gaps** that fit its agent-side + knowledge-base + offline-safe identity:

1. **Reusable-component scaffolding** — custom-parameter pages + extension classes that make AI-built networks parameterized and savable. (`.tox` save/load itself **already ships as `manage_component`**; the only remaining packaging gap is a *dependency-collected portable bundle* (`make_portable_tox`) — note `saveExternalTox` only externalizes to a folder tree, not a single self-contained `.tox`.)
2. **Extension + custom-parameter scaffolding** — turn AI-built networks into *reusable, parameterized components*.
3. **Project analysis & education** (unused-op/dead-node detection, dependency graph, auto-README, screenshot-to-debug) — **no competitor emphasizes documentation/teaching**, and it aligns with TDMCP's KB.
4. **MediaPipe body/hand/face tracking template** — flagship reactive feature; the MIT plugin already exists, webcam-only (no sensor), and it serves the owner's VJ / camera-reactive use case.
5. **Ableton Link + MIDI-clock sync** — small upgrade to `sync_external_clock`, big VJ payoff (currently only tap-tempo).
6. **AI bridges that *drive* existing `.tox`es** (StreamDiffusion / ComfyUI / A1111) rather than reimplementing them.

The single biggest 2025–2026 community shift is **POPs** (the new GPU particle/point operator family) and **real-time AI diffusion** (StreamDiffusionTD + Daydream remote GPU). Both should be on the roadmap.

**Answering the success criteria up front:**
1. *Most valuable material* → the Top-15 selection below (MediaPipe plugin, Embody/tox API, StreamDiffusionTD, RayTK, GLSL particle capstone, POPs, Ableton Link, ComfyUI bridges…).
2. *New techniques* → tox save/loadTox/saveByteArray, extension scaffolding via `mod().Ext(me)`, TDJSON serialization, MediaPipe→WebSocket→CHOP, GPU Navier-Stokes, node-based SDF raymarching, compute-shader boids, real-time img2img.
3. *Real features* → the Implementation Backlog (BL-01…BL-22).
4. *Next version (v0.5.0; v0.4.0 shipped the 3D/sim/particle generators, and body tracking is on `main` in-tree — not in the 0.4.0 CHANGELOG)* → custom-param + extension scaffolding (the reusable-component complement to the already-shipped `manage_component`), project analysis + auto-README, Ableton Link/MIDI, screenshot-to-debug, and the Embody-mined agent-DX primitives.
5. *Examples/demos* → see Demo Ideas (body-tracking reactive, live AI-VJ, externalize-to-git, package-a-component, screenshot-to-debug).
6. *Becoming truly useful for artists with AI* → see Final Recommendations.

---

## Best Sources Found

The richest, most reusable sources (by signal density for TDMCP):

- **docs.derivative.ca** — the authoritative API for everything we'd automate: [COMP Class](https://docs.derivative.ca/COMP_Class) (`save` / `saveExternalTox` / `loadTox` / `saveByteArray`), [Extensions](https://docs.derivative.ca/Extensions), [Custom Parameters](https://docs.derivative.ca/Custom_Parameters), [Page Class](https://docs.derivative.ca/Page_Class), [TDJSON](https://docs.derivative.ca/TDJSON), [Working with OPs in Python](https://docs.derivative.ca/Working_with_OPs_in_Python), [Optimize](https://docs.derivative.ca/Optimize), [Ableton Link CHOP](https://docs.derivative.ca/Ableton_Link_CHOP), [Kinect Azure TOP](https://docs.derivative.ca/Kinect_Azure_TOP), [RealSense TOP](https://docs.derivative.ca/RealSense_TOP), [NDI In TOP](https://docs.derivative.ca/NDI_In_TOP), [Palette](https://docs.derivative.ca/Palette).
- **derivative.ca/community-post** — the deepest free advanced tutorials (raymarching series, POPs, MediaPipe, point clouds, depth-cam).
- **learn.derivative.ca** — the [official 100/200 curriculum](https://learn.derivative.ca/courses/100-fundamentals/): a model structure for "explain a network to a beginner."
- **interactiveimmersive.io** (The Interactive & Immersive HQ) — production/deployment, optimization, network-navigation conventions, MQTT, LiDAR.
- **thenodeinstitute.org** — structured advanced courses (GLSL compute, DMX/Art-Net/LED, Python network generation).
- **github.com** — the competitor MCPs + the tox-externalization tooling + the MediaPipe/diffusion/raymarch components (see Repositories).

---

## Top Creators / Channels

| Creator | Channel / Site (verified) | Focus | Why notable |
|---|---|---|---|
| Bileam Tschepe (elekktronaut) | [YouTube](https://www.youtube.com/@elekktronaut/videos) · [site](https://www.elekktronaut.com/) | Audio-reactive, generative, organic feedback | The most influential TD educator; feedback systems, POPs, audio-reactivity |
| Interactive & Immersive HQ (Elburz Sorkhabi + Matthew Ragan) | [site](https://interactiveimmersive.io/) · [Pro](https://pro.interactiveimmersive.io/) | Pro/production training | Advanced Python, GLSL compute particles, installation-scale systems |
| Matthew Ragan | [teaching](https://matthewragan.com/teaching-resources/touchdesigner/) · [GitHub](https://github.com/raganmd) | GLSL, Python, system architecture | Deep GLSL + open-source learning repos; foundational reference |
| Paketa12 (Aurelian Ionus) | [YouTube](https://www.youtube.com/user/paketa12) · [alltd](https://alltd.org/uploader/paketa12/) | GLSL / SDF visual programming | Signed-distance fields, recursive displacement, raw GLSL in TOPs |
| Darien Brito | [site](https://darienbrito.com/) · [Patreon](https://www.patreon.com/cw/darienbrito) | Generative art, procedural geometry | Cellular automata 1D→3D, boolean geometry, GLSL; exhibited internationally |
| Function Store (Daniel Molnar) | [YouTube](https://www.youtube.com/channel/UCCHZDHCp1JbFDdpsOYIYwjA) · [GitHub](https://github.com/function-store/FunctionStore_tools) | Workflow tools + visuals | OpTemplates: place ops/chains/full render nets in one click |
| Vincent Houzé | [site](https://vincenthouze.com/) · [GitHub](https://github.com/vinz9) | Real-time fluids, particle installations | Custom particle systems, interactive fluid installations |
| Torin Blankensmith | [YouTube](https://www.youtube.com/c/TorinBlankensmith) · [GitHub](https://github.com/torinmb) | Creative tech, AI plugins, MR | Built MediaPipe, ChatGPT, Whisper, ElevenLabs plugins for TD |
| DotSimulate (Lyell Hintz) | [StreamDiffusionTD](https://dotsimulate.com/docs/streamdiffusiontd) · [LOPs](https://docs.dotsimulate.com/getting-started/) | Real-time AI diffusion + LLM ops | StreamDiffusionTD + LOPs (60+ LLM operators incl. MCP Server) |
| The NODE Institute | [courses](https://thenodeinstitute.org/courses/) | Structured advanced courses (Berlin) | Advanced GLSL/compute, DMX/Art-Net, Python network generation |
| Noto the Talking Ball (Kohui) | [YouTube](https://www.youtube.com/channel/UCSEsok1iU9ewEebdMAJmMVw) | Fast generative + audio-reactive | High-density technique tutorials (3D textures, instancing, feedback) |
| Acrylicode | [YouTube](https://www.youtube.com/channel/UC6kz8lb80gitsmjx0gnZC8Q) | Beginner→intermediate crash courses | Structured entry-point playlists |
| Markus Heckmann (Derivative TD) | [alltd profile](https://alltd.org/uploader/markusheckmann/) | Generative AV performance | Derivative Technical Director; live visual instruments |
| Derivative (official) | [YouTube](https://www.youtube.com/channel/UCbgFCfj0vp-nNGQ4hT5uEAg) | Official tutorials + Summit talks | POPs intros, Summit recordings |

---

## Top Tutorials / Videos / Projects

Grouped by theme. Level: ◦ advanced · ★ insane.

**Generative / GLSL / simulation**
1. ★ [Raymarching in TouchDesigner series (5h)](https://derivative.ca/community-post/tutorial/raymarching-touchdesigner-tutorial-series) — Derivative — SDF raymarch: lighting, reflections, env-map, gyroids, fractals.
2. ◦ [Interactive particles + raymarched SDF geometry](https://derivative.ca/community-post/tutorial/interactive-particles-raymarching-sdf-geometry/63516) — instanced particles colliding with an SDF field.
3. ★ [RayTK Fractal Column](https://derivative.ca/community-post/tutorial/raytk-fractal-column-tutorial/68316) — t3kt — node-based SDF assembly (no hand-written GLSL).
4. ★ [GPU Fluid Simulation (Stam/Navier-Stokes)](https://xiaojiangbrian.com/gpu-water-simulation/) — Brian Jiang — advection/divergence/Jacobi-pressure as shader passes.
5. ◦ [2D fluid simulation on the GPU (forum thread)](https://forum.derivative.ca/t/2d-fluid-simulation-on-the-gpu/8307) — GLSL Eulerian solver.
6. ★ [Boids Flocking](https://www.youtube.com/watch?v=f2yOYmOgZEA) — compute-shader binning for O(n) neighbor search, instanced agents.
7. ◦ [GLSL vertex displacement](https://www.youtube.com/watch?v=CTmwFyetIvE) — texture-driven displacement + normal recompute in a GLSL MAT.
8. ◦ [Butterfly effect — Lorenz attractor](https://alltd.org/butterfly-effect-lorenz-attractor-touchdesigner-tutorial/) — AllTD — strange-attractor integration.
9. ★ [Strange Attractor GLSL POP](https://www.youtube.com/watch?v=Ty3u7qfPj2E) — attractors via the new GLSL POP.
10. ◦ [SDFs 101 (4h course)](https://pro.interactiveimmersive.io/courses/sdfs-101-in-touchdesigner/) — M. Ragan — 2D SDF gen, boolean ops, contours.
11. ◦ [Advanced GLSL course](https://thenodeinstitute.org/courses/ss25-td-advanced-glsl-in-touchdesigner/) — NODE Institute — compute shaders, instancing, sims.
12. ◦ [Recursive Displace II](https://alltd.org/uploader/paketa12/) — Paketa12 — recursive GLSL displacement feedback.

**Particles / point clouds / POPs**
13. ★ [GLSL Particle Simulation capstone](https://pro.interactiveimmersive.io/courses/glsl-particle-simulation-in-touchdesigner-capstone/) — I&I HQ — compute-shader particles, curl-noise, 100k+.
14. ◦ [Point Clouds in TouchDesigner](https://derivative.ca/community-post/tutorial/point-clouds-touchdesigner/62036) — SOP→pointcloud→TOP particle system.
15. ◦ [Point Cloud Particles in TOPs](https://derivative.ca/community-post/tutorial/point-cloud-particles-touchdesigner-tops/70450) — I&I HQ.
16. ◦ [Interactive Particles w/ Optical Flow + ParticlesGPU](https://derivative.ca/community-post/tutorial/interactive-particles-optical-flow-and-particlesgpu-2022/66824) — webcam optical-flow advection.
17. ◦ [POPs Instance Field](https://derivative.ca/community-post/tutorial/touchdesigner-pops-instance-field/71904) — millions of attribute-driven points (new GPU POP family).
18. ◦ [Wavy Particle Systems using POPs](https://derivative.ca/community-post/tutorial/wavy-particle-systems-touchdesigner-using-pops/73315) — Particle POP + Math Mix POP.
19. ◦ [Introduction to POPs — Paris 2025 example files](https://derivative.ca/community-post/asset/introduction-pops-example-files-touchdesigner-summer-event-paris-2025/72388).
20. ◦ [Text particles with POPs](https://www.patreon.com/posts/text-particles-1-132679932) — POPs + 3D textures + GEO instancing *(authorship not independently confirmed)*.

**AI / diffusion / voice**
21. ◦ [Becoming — AI generation w/ StreamDiffusion + Daydream](https://www.youtube.com/watch?v=oxPaZFRve9w) — body-tracking-driven real-time diffusion, remote GPU.
22. ◦ [Body-Tracking + StreamDiffusion](https://www.youtube.com/watch?v=xFAaDeRJGcc) — pose → real-time diffusion pipeline.
23. ◦ [ElevenLabs + Whisper + ChatGPT + MediaPipe voice character](https://derivative.ca/community-post/tutorial/text-speech-elevenlabs-plugin-touchdesigner-whisper-chatgpt-and-mediapipe) — Torin Blankensmith — full conversational AI avatar loop.
24. ◦ [Custom ChatGPT + Whisper plugins](https://derivative.ca/community-post/tutorial/custom-chatgpt-and-whisperspeech-text-plugins-touchdesigner/67446) — Torin Blankensmith.

**Hardware / CV / mapping**
25. ◦ [Face, Hand, Pose tracking w/ MediaPipe GPU plugin](https://derivative.ca/community-post/tutorial/face-hand-pose-tracking-more-touchdesigner-mediapipe-gpu-plugin/68278) — Torin Blankensmith.
26. ◦ [Hand Tracking Master Class w/ MediaPipe](https://derivative.ca/community-post/tutorial/hand-tracking-master-class-touchdesigner-mediapipe/71352).
27. ◦ [Motion Tracking w/ MediaPipe](https://derivative.ca/community-post/tutorial/motion-tracking-touchdesigner-mediapipe/71580).
28. ◦ [Kinect Azure Point Cloud (Tutorial 068)](https://derivative.ca/community-post/tutorial/kinect-azure-point-cloud-touchdesigner-tutorial/65619) — Elburz / IIHQ.
29. ◦ [Custom Depth Map from Kinect & RealSense Point Clouds](https://derivative.ca/community-post/tutorial/custom-depth-map-kinect-realsense-point-clouds-touchdesigner/65975).
30. ◦ [Advanced Kinect Rendering (instancing, PBR, depth, shadows)](https://www.youtube.com/watch?v=QAxOMOLP4lo) *(channel not independently confirmed)*.
31. ◦ [DMX/Art-Net & LED Mapping course](https://thenodeinstitute.org/courses/ss23-td-08-dmx-artnet-and-led-mapping/) — NODE Institute.
32. ◦ [Pixelmapping + DMX tutorial](https://jmarsico.github.io/rsma2018/tutorials/td_dmx/) — J. Marsico.
33. ◦ [Setting Up Your First MQTT Server](https://interactiveimmersive.io/blog/controlling-touchdesigner/setting-up-your-first-mqtt-server-for-immersive-system-communication/) — IIHQ.
34. ◦ [Receiving WebSocket Messages (Part 5)](https://derivative.ca/community-post/tutorial/part-5-receiving-websocket-messages-touchdesigner-control-td-website-vice) — bidirectional WebSocket ↔ web UI.
35. ◦ [Apple LiDAR + TouchDesigner](https://interactiveimmersive.io/blog/touchdesigner-3d/3d-scanning-with-apples-lidar/) — iPhone LiDAR → point cloud.
36. ◦ [Arduino → TouchDesigner guide](https://stevezafeiriou.com/arduino-to-touchdesigner/) — Serial DAT / Firmata.
37. ◦ [Projection Mapping w/ KantanMapper](https://interactiveimmersive.io/blog/touchdesigner-operators-tricks/projection-mapping-basics-with-kantan-mapper-in-touchdesigner/) — IIHQ.
38. ◦ [3D Projection Mapping w/ Photogrammetry (CamSchnappr)](https://alltd.org/3d-projection-mapping-tutorial-with-photogrammetry-and-touchdesigner/).
39. ◦ [Kinect Skeleton Basics](https://alltd.org/kinect-skeleton-basics-touchdesigner-tutorial/) — AllTD.
40. ◦ [Advanced Audio Reactivity course](https://thenodeinstitute.org/courses/ss23-td-14-advanced-audio-reactivity/) — NODE Institute.

**Education / analysis**
41. ◦ [Official TouchDesigner Curriculum (100/200)](https://learn.derivative.ca/courses/100-fundamentals/).
42. ◦ [Troubleshooting & Debugging TD Projects](https://interactiveimmersive.io/blog/touchdesigner-resources/troubleshooting-debugging-touchdesigner-projects/) — IIHQ.
43. ◦ [Optimizing in TouchDesigner](https://interactiveimmersive.io/blog/deployment/optimizing-in-touchdesigner/) — IIHQ.
44. ◦ [Network Navigation conventions](https://interactiveimmersive.io/touchdesigner-network-navigation/) — IIHQ.

---

## Top GitHub Repositories / Code Resources

| Repo | URL | What it is | Relevance to TDMCP |
|---|---|---|---|
| **Embody** (dylanroscover) | [github](https://github.com/dylanroscover/Embody) | MCP server (~111★). TDN = network-as-JSON (diffable); git-diffable externalization; **portable `.tox` export**; per-project TD pinning | **Closest competitor + clearest roadmap** for the tox/JSON gap |
| **8beeeaaat/touchdesigner-mcp** | [github](https://github.com/8beeeaaat/touchdesigner-mcp) | MCP server (~330★) over WebServer DAT; node CRUD + exec | Leading prior-art; confirmed **no tox/component packaging** |
| **bottobot/touchdesigner-mcp-server** | [github](https://github.com/bottobot/touchdesigner-mcp-server) | Docs-only MCP: 629 operators + 69 Python classes | TDMCP's own KB upstream (`import:bottobot`) |
| **raganmd/touchdesigner-save-external** | [github](https://github.com/raganmd/touchdesigner-save-external) | Externalize-on-save; folder-per-COMP; auto re-init extensions | Reference design for externalization + auto-reload loop |
| **JohnENoonan/touch-tox-exporter** | [github](https://github.com/JohnENoonan/touch-tox-exporter) | Exports fully self-contained `.tox` (collects deps) | Pattern for "ship a portable component" |
| **worksofar/TD-Network-Exporter** | [github](https://github.com/worksofar/TD-Network-Exporter) | Network ↔ JSON round-trip (early-stage) | Exactly the serialize/rebuild round-trip TDMCP could own |
| **dylanroscover/jsonifier** | [github](https://github.com/dylanroscover/jsonifier) | Auto save/load custom pars to external JSON | Parameter-state serialization (presets/diff) via TDJSON |
| **function-store/FunctionStore_tools** | [github](https://github.com/function-store/FunctionStore_tools) | (~277★) OpTemplates: place ops/chains/full nets one-click | OpTemplates ≈ TDMCP recipes; validates save/apply-template |
| **DBraun/TouchDesigner_Shared** | [github](https://github.com/DBraun/TouchDesigner_Shared) | (~987★) large library of toxes/utilities | Mineable corpus for recipes + KB enrichment |
| **torinmb/mediapipe-touchdesigner** | [github](https://github.com/torinmb/mediapipe-touchdesigner) | (~2.3k★, MIT) GPU MediaPipe plugin: face/hand/pose/segmentation, webcam-only, data via local WebSocket→JSON→CHOP | **Flagship reactive input**; no sensor; actively maintained |
| **LucieMrc/MediaPipe_TD_EN** | [github](https://github.com/LucieMrc/MediaPipe_TD_EN) | Recipes on top of torinmb plugin; 3 mapping styles (direct/instancing/Replicator), 2D + 3D | Ready-made template logic for body-reactive visuals |
| **MauiJerry/Pose2Art** | [github](https://github.com/MauiJerry/Pose2Art) | Edge device runs MediaPipe → 33 landmarks as ~69 OSC msgs → TD/Unity | Pure-**OSC** body-tracking path (fits existing OSC support) |
| **olegchomp/TouchDiffusion** | [github](https://github.com/olegchomp/TouchDiffusion) | (~289★) real-time SD via StreamDiffusion + TensorRT | Drive-existing-`.tox` target for live AI |
| **olegchomp/TDComfyUI** | [github](https://github.com/olegchomp/TDComfyUI) | TD interface to ComfyUI API (load workflow, params, callbacks) | Proven ComfyUI-bridge pattern |
| **JiSenHua/ComfyUI-TD** | [github](https://github.com/JiSenHua/ComfyUI-TD) | ComfyUI→TD node, WebSocket streaming of images/video/point-clouds | Bidirectional ComfyUI bridge |
| **olegchomp/TDDiffusionAPI** | [github](https://github.com/olegchomp/TDDiffusionAPI) | TD interface to AUTOMATIC1111 API; drag-`.tox` easy install | Lowest-friction "live AI feed" on-ramp |
| **AllenEdgarPoe/MirrorX** | [github](https://github.com/AllenEdgarPoe/MirrorX-Real-time-SD-TD-SDXLora) | Real-time webcam img2img, SDXL-Turbo + LoRA, ~0.2–0.5s/frame | Reference for live img2img tuning |
| **t3kt/raytk** | [github](https://github.com/t3kt/raytk) | (~343★) node-based raymarching SDF toolkit | Advanced programmatic-component generation example |
| **ancillarymagnet/touchfluids** | [github](https://github.com/ancillarymagnet/touchfluids) | (~98★) Navier-Stokes fluid in TD + GLSL | Reference solver for a `create_gpu_fluid` tool |
| **exsstas/Raymarching-in-TD** | [github](https://github.com/exsstas/Raymarching-in-TD) | (~88★) raymarch templates + shadows/AO + video tuts | Recipe source for SDF scenes |
| **raganmd/BOS-in-TouchDesigner** | [github](https://github.com/raganmd/BOS-in-TouchDesigner) | (~192★) Book of Shaders ported to TD | Drop-in pixel-shader corpus for shader lib |
| **interactiveimmersivehq/Introduction-to-touchdesigner** | [github](https://github.com/interactiveimmersivehq/Introduction-to-touchdesigner) | (~550★) GLSL 2D/3D, GPU particles, Shadertoy import | Teaching corpus |
| **terezbe/td-websocket-V2** | [github](https://github.com/terezbe/td-websocket-V2) | TD + Node WebSocket server + web UI, two-way control | Bidirectional web-control pattern |
| **satoruhiga/claude-touchdesigner** | [github](https://github.com/satoruhiga/claude-touchdesigner) | MCP plugin: Claude ↔ TD via a TOX-hosted MCP server; skill packs | Competitor + validation of the approach |

*Reference-only (not TD patches):* [merrypranxter/strange_attractors](https://github.com/merrypranxter/strange_attractors) (WebGL GPGPU attractors — algorithm reference); [yukia3e/TD_Realsense_D435_Sample](https://github.com/yukia3e/TD_Realsense_D435_Sample); [virtualarchitectures/TouchDesigner_OSC_Controller](https://github.com/virtualarchitectures/TouchDesigner_OSC_Controller).

---

## Key Techniques Learned

These are the concrete, transferable techniques the research surfaced — each is the seed of a TDMCP capability.

**A. Component & project automation (Python API).** The full `.tox` lifecycle is scriptable: `COMP.save(filepath)`, `COMP.saveExternalTox(recurse)`, `COMP.saveByteArray()` ("same data as a .tox file"), `COMP.loadTox(filepath, unwired, pattern)`, `COMP.reload()`. Reusable components are built with **extensions** (`mod('MyExt').MyExt(me)` + Promote flag) and **custom parameters** (`appendCustomPage('Name')` → `appendFloat/Int/Menu/Pulse/...`). **TDJSON** serializes params/pages/networks to JSON and rebuilds them (`opToJSONOp`, `addParametersFromJSONOp`). Traversal for analysis: `findChildren()`, `op.inputConnectors`/`outputConnectors`, `parent(n)`.

**B. Body / hand / face tracking without a sensor.** The MIT `mediapipe-touchdesigner` plugin runs MediaPipe on the **GPU from a plain webcam** and pushes landmarks over a **local WebSocket → JSON → CHOP** (up to ~5 faces/bodies). Pure-OSC alternative (Pose2Art) sends 33 landmarks as ~69 OSC messages — directly compatible with TDMCP's existing OSC support.

**C. Real-time AI img2img as a hosted `.tox`.** StreamDiffusionTD / TouchDiffusion / ComfyUI bridges / TDDiffusionAPI all expose **prompt / strength / seed / ControlNet** parameters and stream a TOP in/out. The pattern that wins is *driving an existing `.tox`*, optionally over a remote GPU (Daydream), not reimplementing diffusion.

**D. GPU simulation primitives.** Navier-Stokes fluid = multi-pass fragment shaders (advect → divergence → Jacobi pressure → curl/vorticity → gradient subtract) ping-ponged in feedback TOPs. Compute-shader **boids** use spatial binning for O(n) neighbor search. **Strange attractors** = per-point ODE step over millions of feedback-TOP points (clean via the new GLSL POP).

**E. Node-based / multi-pass raymarching.** SDF scenes from primitives + boolean ops (union/subtract/smooth-min) + domain repetition + fractal folding, with soft shadows, AO and env-map reflections — assembled as a *network* (RayTK) rather than one monolithic shader.

**F. Point clouds & depth.** XYZ packed into a TOP's RGB, processed with Point Transform TOP, then PBR-instanced. Sources: Kinect Azure TOP/CHOP (incl. skeleton), RealSense TOP, iPhone LiDAR (Record3D/PolyCam `.ply`), or `.ply` files.

**G. Tempo & show-control protocols.** Ableton Link CHOP exposes tempo/beat/phase; MIDI-clock can drive the Beat CHOP; MQTT Client DAT for IoT pub/sub; bidirectional WebSocket DAT for web UIs; NDI In TOP for network video; Art-Net/sACN for DMX fixture control.

**H. Optimization & documentation heuristics.** Perf Monitor + Probe + Hog CHOP isolate CPU-vs-GPU bottlenecks; replacing Python with CHOP/DAT networks is the canonical fix. Network-navigation conventions (naming, no crisscross wires, left→right flow) are lintable.

---

## Feature Opportunities for TDMCP

The research maps cleanly onto **six opportunity clusters**, ranked by *fit × differentiation × effort*:

1. **Component packaging & version control** — `.tox` save/load already ships as `manage_component`; the open gaps are (a) a dependency-collected, self-contained portable bundle (`make_portable_tox`) — distinct from `COMP.saveExternalTox`, which only externalizes to a folder tree — and (b) network↔JSON + parameter-state serialization (git-diffable, Embody-style).
2. **Reusability scaffolding** — extension stubs, custom-parameter pages, "package this subnet as a component." Turns one-shot AI builds into a library.
3. **Project intelligence / education** (no competitor) — unused-op & dead-node detection, dependency graph, auto-README, screenshot-to-debug, performance advisor.
4. **Sensor & body reactivity** — MediaPipe body/hand/face template, depth-camera input, OSC body-tracking path. Serves the VJ / camera-reactive use case.
5. **Show-control protocols** — Ableton Link + MIDI clock, DMX fixture patcher, MQTT bridge, bidirectional WebSocket API, NDI input.
6. **AI generation bridges** — drive StreamDiffusion / ComfyUI / A1111 `.tox`es; LLM-in-TD scaffold; voice-control pipeline; prompt→image.

Plus an **advanced-generators** track (GPU fluid, SDF raymarch scenes, boids, optical-flow particles, vertex-displacement MAT, strange attractors, SDF text, POPs templates) that deepens TDMCP's existing visual catalog.

---

## Top 15 Selection (most valuable for TDMCP)

Selected for *potential to become a real feature × AI/automation fit × artist value × technical viability × differentiation × demo-ability*.

| # | Source | What it teaches | TDMCP implementation | New tools | Difficulty | Impact |
|---|---|---|---|---|---|---|
| 1 | [COMP Class API](https://docs.derivative.ca/COMP_Class) + [Embody](https://github.com/dylanroscover/Embody) | tox `save`/`loadTox`/`saveByteArray`/`saveExternalTox` | `.tox` save/load **already ships as `manage_component`**; open gap = portable bundle + network↔JSON | `make_portable_tox`, `serialize_network` (v0.6.0) | M | ★★★☆☆ |
| 2 | [torinmb/mediapipe-touchdesigner](https://github.com/torinmb/mediapipe-touchdesigner) | GPU MediaPipe → WebSocket → CHOP, webcam-only | ✅ **On `main`** (in-tree; not in the 0.4.0 CHANGELOG): `setup_body_tracking`/`create_pose_tracking`/`create_pose_skeleton`/`create_body_reactive`; remaining = hand/face modes + recipes | (in-tree) | — | ★★★★★ |
| 3 | [Extensions](https://docs.derivative.ca/Extensions) + [Custom Parameters](https://docs.derivative.ca/Custom_Parameters) + [TDJSON](https://docs.derivative.ca/TDJSON) | `mod().Ext(me)`, `appendCustomPage`, JSON par specs | Scaffold reusable parameterized components | `scaffold_extension`, `add_custom_parameters` | M | ★★★★☆ |
| 4 | [Working with OPs in Python](https://docs.derivative.ca/Working_with_OPs_in_Python) | `findChildren`, connectors, `op()` deps | Unused-op/dead-node + dependency analysis | `analyze_project` | M | ★★★★☆ |
| 5 | [Optimize guide](https://docs.derivative.ca/Optimize) + [IIHQ optimizing](https://interactiveimmersive.io/blog/deployment/optimizing-in-touchdesigner/) | Perf Monitor/Probe/Hog heuristics | Auto-README + performance advisor | `generate_readme`, extend `optimize_performance` | M | ★★★★☆ |
| 6 | [StreamDiffusionTD](https://dotsimulate.com/docs/streamdiffusiontd) / [TouchDiffusion](https://github.com/olegchomp/TouchDiffusion) | Real-time img2img as a `.tox` | Detect & drive an existing diffusion `.tox` | `control_diffusion` | M | ★★★★★ |
| 7 | [TDComfyUI](https://github.com/olegchomp/TDComfyUI) / [ComfyUI-TD](https://github.com/JiSenHua/ComfyUI-TD) | Drive ComfyUI API workflows over WebSocket | ComfyUI bridge driven by natural language | `connect_comfyui` | L | ★★★★☆ |
| 8 | [Ableton Link CHOP](https://docs.derivative.ca/Ableton_Link_CHOP) | tempo/beat/phase sync | Add Link + MIDI-clock modes to clock sync | extend `sync_external_clock` | S | ★★★★☆ |
| 9 | `get_preview` + [Troubleshooting](https://interactiveimmersive.io/blog/touchdesigner-resources/troubleshooting-debugging-touchdesigner-projects/) | Vision-based debugging | Feed preview image to a model to explain/fix | `analyze_screenshot` (prompt+tool) | M | ★★★★☆ |
| 10 | [RayTK](https://github.com/t3kt/raytk) + [Raymarching series](https://derivative.ca/community-post/tutorial/raymarching-touchdesigner-tutorial-series) | Node-based SDF raymarch scenes | SDF scene builder (primitive/bool/repeat) — extends shipped `create_raymarch_scene` | `create_sdf_scene` | XL | ★★★★☆ |
| 11 | [GPU Fluid](https://xiaojiangbrian.com/gpu-water-simulation/) + [touchfluids](https://github.com/ancillarymagnet/touchfluids) | Multi-pass Navier-Stokes | True GPU fluid generator | `create_gpu_fluid` | L | ★★★☆☆ |
| 12 | [Kinect Azure](https://docs.derivative.ca/Kinect_Azure_TOP) / [RealSense](https://docs.derivative.ca/RealSense_TOP) | Depth → point cloud + skeleton | Depth-camera input (hardware-gated) | `create_depth_camera_input` | M | ★★★☆☆ |
| 13 | [POPs Instance Field](https://derivative.ca/community-post/tutorial/touchdesigner-pops-instance-field/71904) | New GPU point/particle family | POPs-based particle/instancing templates | `create_pop_field` | M | ★★★★☆ |
| 14 | [FunctionStore_tools](https://github.com/function-store/FunctionStore_tools) | OpTemplates one-click build | Save/apply user templates → recipe marketplace | `save_template`, marketplace index | L | ★★★★☆ |
| 15 | [ElevenLabs+Whisper+ChatGPT+MediaPipe](https://derivative.ca/community-post/tutorial/text-speech-elevenlabs-plugin-touchdesigner-whisper-chatgpt-and-mediapipe) | Voice → LLM → TTS → avatar | Voice-control pipeline (STT → tool calls) | `voice_control` recipe | L | ★★★☆☆ |

---

## Recommended MCP Tools

New tools (none duplicate the existing 119). Grouped; `*` = highest priority for v0.5.0.

**Component & serialization**
- ✅ **Already ships as `manage_component`** — `.tox` `save` + `loadTox` (+ live-linked `externaltox`) load. Do **not** rebuild as `export_component`/`import_component`. (Neither `COMP.saveExternalTox` folder-tree externalization nor a dependency-collected self-contained bundle is in `manage_component` yet — the latter is the future `make_portable_tox` gap.)
- `make_portable_tox` — collect external asset deps into one self-contained `.tox`.
- `serialize_network` / `rebuild_network` — subnet ↔ portable JSON (operators, params, wires, positions) for git-diffable round-trips.

**Reusability scaffolding**
- `scaffold_extension`* — create the extension DAT stub, set Extension Object + Promote, re-init.
- `add_custom_parameters`* — declaratively build custom-parameter pages (accept/emit TDJSON).

**Project intelligence**
- `analyze_project`* — unused/dead operators, broken file deps, orphan COMPs, dependency graph.
- `generate_readme`* — Markdown project doc: params table, I/O, child inventory, deps, preview thumbnail.
- `analyze_screenshot`* — vision model reads `get_preview`/`render_output` image to explain/diagnose.

**Sensor & reactivity**
- ✅ **On `main` (in-tree; not in the 0.4.0 CHANGELOG)** as `setup_body_tracking` / `create_pose_tracking` / `create_pose_skeleton` / `create_body_reactive` — MediaPipe (webcam) → named joint channels. Remaining: hand/face modes + more recipes.
- `create_pose_reactive` — map joints to instancing/kinetic geometry (builds on `create_motion_reactive`).
- `create_depth_camera_input` — Kinect Azure / RealSense color+depth point cloud (+ optional skeleton).
- `create_ndi_input` — NDI In TOP source wrapper (pairs with existing NDI out).

**Show control**
- extend `sync_external_clock`* — add `ableton_link` and `midi_clock` modes.
- `create_dmx_fixtures` — fixture-profile patcher over Art-Net/sACN (beyond raw channels).
- `create_mqtt_bridge` — MQTT Client DAT pub/sub ↔ CHOP/DAT.
- `create_websocket_api` — bidirectional WebSocket + WebServer DAT scaffold for two-way web control.

**AI generation**
- `control_diffusion`* — detect a StreamDiffusionTD/TouchDiffusion `.tox`, expose prompt/strength/seed/ControlNet.
- `connect_comfyui` — drive a saved ComfyUI API workflow over WebSocket; pull result to a TOP.
- `text_to_image` — call DALL·E/Gemini/etc., land output as a TOP source.

**Advanced generators**
- `create_gpu_fluid`, `create_optical_flow_particles`, `create_vertex_displacement_mat`, `create_strange_attractor`, `create_sdf_text`, `create_pop_field`. (SDF raymarch and boids already shipped in 0.4.0 as `create_raymarch_scene` / `create_particle_flock`.)

**Library / marketplace**
- `save_template` + a community recipe **marketplace index** (installable into TD Palette / vault).

---

## Recommended Recipes and Templates

New recipe JSONs (validated by `validate:recipes`). Existing recipes already include `audio_spectrum_bars`, `data_sonification`, `feedback_tunnel`, `kinect_silhouette`, `led_strip_mapper`, `noise_landscape`, `particle_galaxy`, `performable_feedback_tunnel`, `projection_mapping`, `reaction_diffusion`, `webcam_glitch`.

- **`body_tracking_reactive`** — MediaPipe webcam → joints → instanced geometry / particle forces (LucieMrc patterns).
- **`reusable_component`** — Base COMP pre-wired with extension stub + custom-parameter page + output Select TOP (the "package me as a `.tox`" starter).
- **`depth_camera_pointcloud`** — Kinect/RealSense → Point Transform → PBR instancing with shadows.
- **`live_ai_feed`** — webcam → TDDiffusionAPI/StreamDiffusion `.tox` → feedback/color-grade (lowest-friction live AI).
- **`comfyui_workflow`** — TD params → ComfyUI API → result TOP → composite.
- **`dmx_lighting_show`** — fixture profiles + cue-linked DMX over Art-Net/sACN.
- **`sdf_raymarch_starter`** — primitive + boolean + lighting/AO scene (RayTK/exsstas patterns).
- **`gpu_fluid_dye`** — Navier-Stokes fluid with dye injection bound to audio/motion.
- **`pops_instance_field`** — attribute-driven millions-of-points POP showcase.
- **`voice_control`** — Whisper STT DAT → command parser → bound parameters.
- **`interactive_installation`** — Arduino/ultrasonic or MediaPipe-proximity → reactive scene.

---

## AI + TouchDesigner Opportunities

The decisive strategic finding: **dotsimulate LOPs already ships an "MCP Server" operator and a "Claude Code" operator inside TouchDesigner**, plus 60+ LLM/voice/RAG operators. TDMCP should therefore **not** try to be "LLM operators inside TD." Its edge is the **agent-side** server + the 629-operator knowledge base + offline-safe tooling + the component/analysis gaps.

For the AI-generation surface, the right posture is **orchestration, not reimplementation**:
- **Drive existing diffusion `.tox`es** (StreamDiffusionTD, TouchDiffusion, ComfyUI bridges, TDDiffusionAPI) — TDMCP detects the component, exposes its params, and wires it into a reactive chain.
- **Prompt→visuals** stays as TDMCP's strength (it already has `image_to_visual`, `text_to_shader`); extend with `text_to_image` (cloud image API → TOP) and `connect_comfyui` for full workflow control.
- **Voice control** (Whisper → command parse → TDMCP tool calls) is a natural agent-side feature and a strong demo.
- **Screenshot-to-debug** is genuinely novel for TD (no competitor does TD-specific vision analysis) and reuses `get_preview`.

This keeps TDMCP **complementary** to LOPs/StreamDiffusion rather than competing head-on with a commercial product.

---

## Live Performance / VJ Opportunities

Aligned with the owner's beat/audio/camera-reactive performance use case:
- **Body-tracking as a performance input** (on `main`, in-tree — not in the 0.4.0 CHANGELOG: `setup_body_tracking` / `create_pose_*` / `create_body_reactive`; next: a `create_pose_reactive` skeleton→visuals layer) — the dancer/VJ becomes the controller, webcam-only.
- **Ableton Link / MIDI-clock sync** — lock the whole show to the DJ's clock without tap-tempo guesswork.
- **DMX fixture patcher** — drive moving heads / LED from cues, extending the existing `artnet_out`.
- **Live AI-VJ** — audio-reactive feed → StreamDiffusion → feedback, with beat-synced prompt swaps (pairs with `create_autopilot`/`manage_cue`).
- **NDI input** + bidirectional WebSocket control — phone-as-camera and phone-as-controller in one rig (complements `create_phone_remote`).
- **POPs instance fields** — million-point GPU spectacle reactive to audio bands.

---

## Documentation and Education Opportunities

No competitor emphasizes teaching — this is a clean differentiator and fits the KB.
- **`generate_readme`** — auto-document an AI- or human-built project (params, I/O, child inventory, deps, preview).
- **`analyze_project`** — surface unused operators, broken file paths, orphan COMPs (cleanup before shipping).
- **`analyze_screenshot`** — "why is my network black?" → vision model + topology + errors → concrete fix.
- **Dependency graph** — extend `document_network`'s Mermaid with cross-network reference edges.
- **Tutorial-to-template** — parse tutorial steps/transcript into a validated recipe JSON.
- **Beginner explainer prompt** — narrate a selected region of a network in plain language, modeled on the official curriculum's "summary + example" structure.

---

## Roadmap Proposal

> **Version note (updated 2026-05-28):** **v0.4.0 shipped 2026-05-27.** The original draft targeted "v0.4.0 next"; since that release landed via a large parallel build, the plan below is **shifted up one** — the next release is **v0.5.0**. These remain feature waves around the existing ROADMAP's v1.0.0 consolidation milestone; the high-value, low-risk ones (component scaffolding, analysis, Link/MIDI) are worth pulling forward.

### Already landed — ✅ (v0.4.0 + current `main`)
**Shipped in v0.4.0 (2026-05-27, per CHANGELOG):** `create_raymarch_scene` (SDF), `create_particle_flock` (boids), `create_point_cloud`, `create_pbr_scene`, `create_cubemap_dome`, `detect_tempo`, `create_led_mapper`, `create_palette`, `create_cue_sequencer`, `create_data_source`, `create_stage_dashboard`, `create_generative_audio`, `scaffold_genre`, prompts `text_to_recipe`/`style_reference`. **Also on `main` (in-tree, not in the 0.4.0 CHANGELOG):** body/pose tracking — `setup_body_tracking`, `create_pose_tracking`, `create_pose_skeleton`, `create_body_reactive` (+ recipes `mediapipe_body_dots`/`pose_skeleton_mediapipe`). So **BL-02 (body tracking)** and several "advanced-generator" items below are **done**.

### v0.5.0 — "Components & agent-DX" (next, realistic, differentiated)
The theme is **turn AI builds into reusable, documented components + make the agent loop cheaper** — all validatable on the dev Mac, no exotic hardware.
- ✅ `.tox` save/load (BL-01) already ships as `manage_component`; the portable-bundle gap (`make_portable_tox`) is later.
- **P0** `scaffold_extension` + `add_custom_parameters` (BL-03) — reusability; the component work that complements `manage_component`.
- **P0** extend `sync_external_clock` with Ableton Link + MIDI clock (BL-08) — small, high VJ impact.
- **P1** `analyze_project` + `generate_readme` (BL-04) — the education differentiator.
- **P1** `analyze_screenshot` (BL-09) — novel vision-based debugging.
- **P1** Embody-mined agent-DX primitives: `edit_dat_content`, `set_dat_content` (anti-wipe), `batch_operations`, `snapshot_td_graph` compact mode.
- **P2** `manage_annotation`, `write_agent_guide`, `set_perform_mode`.
- Docs: new guide pages, recipe entries; CHANGELOG; live validation per the create→verify→preview loop.

### v0.6.0 — "Bridges & Automation"
- **P1** `control_diffusion` (BL-06) — drive an existing StreamDiffusion/TouchDiffusion `.tox`.
- **P1** `connect_comfyui` (BL-07) — drive ComfyUI API workflows.
- **P1** `serialize_network` / `rebuild_network` (BL-10) + `make_portable_tox` — git-diffable JSON round-trip + portable bundle.
- **P1** `create_depth_camera_input` (BL-12) + `create_pose_reactive` — depth/skeleton (hardware-gated, probe-first).
- **P2** `create_ndi_input`, `create_mqtt_bridge`, `create_websocket_api`, `create_dmx_fixtures`.
- **P2** remaining advanced generators: `create_gpu_fluid`, `create_pop_field`, `create_optical_flow_particles`, `create_vertex_displacement_mat`, `create_strange_attractor`, `create_sdf_text` (note `create_raymarch_scene` (SDF), `create_particle_flock` (boids) and `create_point_cloud` already shipped in 0.4.0).

### v0.7.0+ — "Intelligence & Marketplace" (ambitious)
- **P2** `voice_control` pipeline (Whisper → tool calls) + `text_to_image`.
- **P2** **Recipe/template marketplace** — `save_template` + a shared, versioned index installable into TD Palette / vault (distribution stays local-first, consistent with TDMCP's model).
- **P2** **Tutorial-to-template** — parse a tutorial into a validated recipe JSON.
- **P3** LLM-in-TD operator scaffold + live AI-VJ orchestration demos.

---

## Implementation Backlog

Format per item: **motivation · user story · technical design · MCP API · tools/work · usage · risks · tests · docs · priority · effort.** Detailed for the v0.5.0 set; condensed thereafter.

### BL-01 — `.tox` export/import ✅ ALREADY SHIPPED as `manage_component`
- **Status:** **superseded — do not build.** `.tox` `save` (via `COMP.save`) + `loadTox` (+ live-linked `externaltox` load) already exist in `src/tools/layer2/manageComponent.ts` (the `manage_component` tool, actions `save`/`load`, with `create_folders`/`linked`/`name`). This was a false gap — the generic tool name hid it from the gap scan. Note: `manage_component` does **not** expose `COMP.saveExternalTox` (folder-tree externalization); a dependency-collected, self-contained portable bundle is the separate future `make_portable_tox` gap (BL-11).
- **Remaining gap → v0.6.0:** a portable/externalized **bundle** that collects external asset deps into one self-contained `.tox` (see `make_portable_tox`, BL-11). The reusable-component work that *complements* `manage_component` — exposing knobs + a Python class so a saved `.tox` is actually reusable — is **BL-03** (`add_custom_parameters` + `scaffold_extension`), the real v0.5.0 P0.

### BL-02 — body/pose tracking ✅ ALREADY SHIPPED (in-tree on `main`; not in the 0.4.0 CHANGELOG)
- **Status:** **shipped — do not rebuild.** Body/pose tracking ships as `setup_body_tracking`, `create_pose_tracking`, `create_pose_skeleton`, `create_body_reactive` (in `src/tools/layer1/`, with `poseSource.ts`), plus recipes `mediapipe_body_dots` and `pose_skeleton_mediapipe` and a `docs/guide/body-tracking.md` guide (EN+PT). There is **no** `createBodyTracking.ts` — the original single-tool proposal here was superseded by that multi-tool design. The MediaPipe→WebSocket→CHOP approach (webcam-only, MIT plugin) is what landed.
- **Remaining (incremental, v0.5.0):** dedicated **hand/face** modes if not already covered; more reactive **recipes/templates** (skeleton → instancing / particle forces); a pure-**OSC** path (Pose2Art) as a sensor-free alternative; and **live webcam validation** (create→verify→preview + post-cook error check — mind the macOS camera-permission hang, so default to a synthetic source for zero-permission tests).

### BL-03 — `scaffold_extension` + `add_custom_parameters` (P0, M)
- **Motivation:** without parameters + extensions, AI builds aren't real reusable components. This is the half that's *missing* — it complements the already-shipped `manage_component` (BL-01) so a saved `.tox` is actually reusable.
- **User story:** *"'Expose Speed and Color as knobs and give this a Python class' → a parameterized component."*
- **Technical design:** L3 tools. `add_custom_parameters` drives `comp.appendCustomPage(name)` then `appendFloat/Int/Menu/Pulse/...` from a spec; accepts/emits TDJSON so par layouts are declarative. `scaffold_extension` creates a Text DAT with `class XxxExt: def __init__(self, ownerComp)`, sets `comp.par.extension/extObject = "mod('XxxExt').XxxExt(me)"`, sets Promote, re-inits.
- **MCP API:** `add_custom_parameters({ nodePath, page, params:[{name,type,default,min?,max?,menu?}] })`; `scaffold_extension({ nodePath, className, methods?[] }) → { datPath }`.
- **Tools/work:** `src/tools/layer3/addCustomParameters.ts`, `scaffoldExtension.ts`; CLI `add-params` / `scaffold-ext`.
- **Risks:** capitalized-name requirement for par/page names; re-init timing; name collisions.
- **Tests:** msw unit (spec→script); live validate (params appear, extension method callable via `exec_node_method`).
- **Docs:** `docs/guide/components.md` (the components guide).

### BL-04 — `analyze_project` + `generate_readme` (P1, M)
- **Motivation:** education/cleanup differentiator; no competitor does this.
- **User story:** *"'What's unused here and write me a README' → a cleanup list + a Markdown doc."*
- **Technical design:** L3 tools. Traverse with `findChildren(recurse=True)`; flag operators with no `outputConnectors` consumers and not viewer/exported/UI as **unused**; resolve file-path parameters and flag missing files; build a dependency map from `op()`/Select-TOP references and CHOP exports. `generate_readme` composes the topology counts (reusing `document_network`), the custom-params table (TDJSON), I/O, external deps, and a `get_preview` thumbnail into Markdown.
- **MCP API:** `analyze_project({ rootPath, checks?:['unused','deps','orphans'] }) → report`; `generate_readme({ rootPath, includeThumbnail? }) → markdown`.
- **Risks:** false positives on "unused" (viewer-active / exported / referenced-by-expression nodes) — be conservative and explain each flag.
- **Tests:** msw unit on a synthetic topology fixture; live validate on a real built project.
- **Docs:** `docs/guide/analyze-and-document.md`.

### BL-06 — `control_diffusion` (P1, M, v0.6.0)
- **Motivation:** real-time AI is the hottest frontier; orchestrate, don't reimplement.
- **Design:** detect a StreamDiffusionTD/TouchDiffusion `.tox` in the project (by family/par signature), expose `prompt`/`strength`/`seed`/`controlnet` as settable params, and wire a source TOP in + diffused TOP out into a reactive chain. Hard-gate behind presence of the component; never bundle diffusion weights.
- **API:** `control_diffusion({ componentPath?, source, prompt?, strength?, seed? }) → { outTop, params }`.
- **Risks:** GPU/CUDA/model availability — **cannot fully live-validate on dev Mac**; probe-first; document hardware reqs. Don't reimplement diffusion.
- **Tests:** msw unit (param wiring); live validation deferred to a CUDA box (documented).

### BL-07 — `connect_comfyui` (P1, L, v0.6.0)
- **Design:** drive a saved ComfyUI **API-format** workflow over WebSocket (TDComfyUI/ComfyUI-TD pattern); map natural-language params to graph inputs; return image to a TOP via callback. **API:** `connect_comfyui({ workflowPath, inputs, host? }) → { outTop }`. **Risks:** external ComfyUI server; workflow-format drift.

### BL-08 — Ableton Link + MIDI clock (P0, S, v0.5.0)
- **Design:** extend `sync_external_clock` with `mode: 'tap' | 'ableton_link' | 'midi_clock'`. Link uses the Ableton Link CHOP (tempo/beat/phase) to drive `op('/').time.tempo`; MIDI clock derives BPM from clock pulses. **Risks:** Link/MIDI hardware needed to fully validate — probe-first, keep tap as default. Low effort, high VJ payoff.

### BL-09 — `analyze_screenshot` (P1, M, v0.5.0)
- **Design:** an MCP **prompt + tool** that pulls `get_preview`/`render_output`, attaches topology + `get_td_node_errors`, and asks the model to explain or diagnose ("why is it black?"). Novel for TD; reuses existing capabilities. **Risks:** multimodal availability; keep it a prompt where possible.

### Condensed (v0.5.0 / v0.6.0+)
- **BL-10 `serialize_network`/`rebuild_network`** (L) — subnet↔JSON via TDJSON + connector walk; enables git diffing (Embody-style).
- **BL-11 `make_portable_tox`** (L) — collect external deps into a self-contained `.tox` (touch-tox-exporter pattern).
- **BL-12 `create_depth_camera_input`** (M) — Kinect Azure / RealSense TOP + optional skeleton CHOP; hardware-gated.
- **BL-13 `create_pose_reactive`** (L) — joints → instancing/kinetic geometry on top of BL-02.
- **BL-14 `create_mqtt_bridge`** (S) · **BL-15 `create_websocket_api`** (M) · **BL-16 `create_ndi_input`** (S) · **BL-17 `create_dmx_fixtures`** (L).
- **BL-18 `create_gpu_fluid`** (L) · **BL-19 `create_pop_field`** (M) · **BL-20 `create_sdf_scene`** (XL, node-based — extends shipped `create_raymarch_scene`) · plus `create_optical_flow_particles`, `create_vertex_displacement_mat`, `create_strange_attractor`, `create_sdf_text`. (boids shipped as `create_particle_flock`.)
- **BL-21 `save_template` + marketplace index** (XL) — versioned community recipe index → TD Palette/vault.
- **BL-22 `voice_control` recipe + `text_to_image`** (L) — Whisper→tool calls; cloud image API→TOP.

---

## Testing Plan

Every feature follows TDMCP's existing two-tier pattern:
- **Offline unit (vitest + msw):** each `*Impl` tested against a mocked bridge — assert the generated Python payload / node plan, params, and error handling (`errorResult`, never throws). This is the CI gate and works with no TouchDesigner.
- **Live validation (create→verify→preview):** build in TD 2025.x, run `get_td_node_errors` **after cook** (not just create output — per the live-testing preference), capture `get_preview`. Mark "shipped" only after live validation.
- **Bridge changes:** `python3 -m py_compile` on changed `td/` files + `python3 -m unittest discover -s td/tests`. Remember the bridge can be stale in a running TD — `reload_bridge` / restart before concluding.
- **Recipes:** `npm run validate:recipes` for every new recipe JSON.
- **Hardware/AI features (BL-06/07/12, Link/MIDI):** probe-first — confirm the operator/`.tox`/sensor exists in the build before shaping the schema; ship a **synthetic/offline fallback** and gate live tests behind hardware. Document what couldn't be validated on the dev Mac (GPU diffusion, depth cameras, Link/MIDI hardware), matching the ROADMAP's "won't ship unvalidated" stance.
- **The four PR gates** stay green: `npm run typecheck`, `npm run build`, `npm run lint` (`biome check .`), `npm test`.

## Documentation Plan

- **New guide pages:** `components.md` (custom params + extension scaffolding + `manage_component` save/load), `body-tracking.md` (artist-friendly), `analyze-and-document.md`, `ai-bridges.md` (driving StreamDiffusion/ComfyUI), `show-control.md` (Link/MIDI/DMX/MQTT/NDI). Note the repo convention: PT translations under `docs/pt/` cover the artist guide plus selected reference pages (`reference/architecture`, `reference/environment`) and `privacy.md` — not every reference page is translated, so match the existing `docs/pt/` coverage rather than assuming reference/legal stay English-only.
- **Auto-generated:** `docs/reference/tools.md` regenerates from the registry on every docs build — never hand-edit.
- **Recipes:** add entries to `docs/guide/recipes.md` for each new recipe JSON.
- **README + prompt cookbook:** add the new "package a component", "track my body", "drive ComfyUI", "document my project" prompts.
- **Troubleshooting additions:** macOS camera-permission hang (body tracking), external-tox folder layout, GPU/CUDA requirements for diffusion, Ableton Link/MIDI hardware setup, WebSocket port conflicts.
- **Architecture:** note any new bridge endpoints (most features use the Execute-DAT + `buildPayloadScript` pattern and need none).

## Demo Ideas (GIF/video, README-ready)

1. **"Package this as a component"** — Claude builds a feedback system → `add_custom_parameters` + `scaffold_extension` → `manage_component` save → drop the `.tox` into a fresh project → it works, with knobs. (Best differentiator demo.)
2. **"Be the controller"** — webcam body tracking → particles follow hands, beat-synced. (Flagship reactive demo, webcam-only.)
3. **"Document my project"** — `analyze_project` flags 3 unused nodes + `generate_readme` writes a Markdown doc with a thumbnail.
4. **"Why is it black?"** — `analyze_screenshot` reads a broken preview and names the fix.
5. **"Live AI-VJ"** — audio-reactive feed → StreamDiffusion `.tox` → feedback, prompt swaps on the drop (v0.5.0; needs a CUDA box).
6. **"Lock to the DJ"** — Ableton Link sync drives the whole show's tempo.

## Risks and Open Questions

- **Competitive overlap with dotsimulate LOPs** (ships an in-TD MCP Server + "Claude Code" operator). *Resolution:* stay agent-side; differentiate on KB + component reusability (params/extensions on top of the shipped `manage_component`) + analysis/education; treat AI generation as orchestration of existing `.tox`es.
- **Hardware/GPU validation gaps:** diffusion (CUDA), depth cameras, Ableton Link/MIDI clock can't be fully validated on the dev Mac — probe-first, synthetic fallbacks, document clearly (do not ship unvalidated APIs).
- **Third-party dependencies:** the MediaPipe plugin (MIT) and diffusion `.tox`es are external — decide vendor vs. install-step; pin versions; surface license. Keep setup dead-simple for the artist audience.
- **Path & security:** tox save/load must reuse the path-traversal-safe IO; never write outside allowed roots; password params handled carefully. The bridge already runs arbitrary Python — these tools don't widen that surface but should respect `allowRawPython`/token gating.
- **POPs are an experimental, version-gated operator family** (~2025.30060) — probe for availability; provide a non-POP fallback.
- **Marketplace distribution** is local-first (no hosted publish flow) — likely realized via the TD Palette + the Obsidian vault + an awesome-list/npm index rather than a hosted service. *Open question:* index format + trust/curation model.
- **Open question:** should TDMCP eventually ship its *own* in-TD MCP/agent operator (like LOPs/satoruhiga) or stay purely agent-side? This is an architecture fork worth an explicit decision.
- **Scope vs. v1.0.0 consolidation:** the existing ROADMAP reserves v1.0.0 for stabilization. Pulling BL-03/04/08 into v0.5.0 is justified by differentiation (BL-01 and BL-02 already shipped — `manage_component` and body tracking), but the advanced-generator wave should not delay 1.0.

## Final Recommendations

1. **Ship the component story first (v0.5.0).** `.tox` save/load already ships as `manage_component`; the missing, differentiated piece is the reusability scaffolding — `add_custom_parameters` + `scaffold_extension` — that makes a saved `.tox` actually reusable (knobs + a Python class). Fully documented, low-risk, and it unlocks a recipe/marketplace future.
2. **Make body tracking the flagship reactive feature.** Webcam-only, MIT plugin, serves the owner's VJ use case, and demos beautifully — the best "wow" with the least hardware.
3. **Own documentation & analysis.** `analyze_project`, `generate_readme`, `analyze_screenshot` are a clean, uncontested differentiator that leverages the 629-op KB and the teaching audience.
4. **Treat AI generation as orchestration, not reimplementation.** Drive StreamDiffusion/ComfyUI/A1111 `.tox`es; don't compete with diffusion engines or LOPs head-on.
5. **Add Ableton Link/MIDI clock now** — tiny effort, real VJ payoff, completes `sync_external_clock`.
6. **Keep the two-tier test discipline and probe-first posture** for every hardware/AI feature, and keep the artist-easy-install bar high.

This makes TDMCP *the* AI-native way to **build, package, document, and perform** TouchDesigner — a layer the competitors aren't occupying.

---

## Appendix — Competitor Deep-Dive (Embody + dotsimulate)

Focused follow-up (2026-05-28) on the two competitors the team flagged, to mine net-new features for v0.4.0. Facts from the GitHub API, the Embody README/docs, and docs.dotsimulate.com. *Could not confirm:* per-operator parameter detail for some dotsimulate LOPs (only the operator index loaded), and StreamDiffusionTD param specifics beyond the quoted feature list.

### Embody (`dylanroscover/Embody`) — v5.0.x, ~48 MCP tools, MIT

An architectural twin (MCP server + Python bridge) but **embedded inside TD as a `.tox`** (server on `localhost:9870`), with a thesis of **externalization + version control** via its **TDN** format (network-as-JSON). What it has that TDMCP doesn't:

| Embody capability | TDMCP? | Net-new TDMCP feature | Effort |
|---|---|---|---|
| Core CRUD, exec_python, class/help, errors, perf, `capture_top` | Yes | — | — |
| `create_extension`, `export/import_network` (TDN), portable `.tox` export | Partial — basic `.tox` save/load ships as `manage_component`; no scaffolding/TDN/portable-bundle | → BL-03 (extension) / BL-10 (TDN) / BL-11 (portable bundle) | — |
| **`read_tdn`** — token-efficient compact graph read ("~20–90× fewer tokens than op-walks") | No | Compact mode on `snapshot_td_graph` (type-default hoisting, `=`/`~` expr/bind shorthand, inline arrays) | M |
| **`edit_dat_content`** — surgical `old_string`/`new_string` DAT edit | No | `edit_dat_content` tool (unique-match + opt-in replace_all) | S |
| **`set_dat_content`** with `confirm_wipe` guardrail | Partial (via exec) | `set_dat_content` with baked-in anti-wipe guardrail | S |
| **`batch_operations`** — many ops per MCP request | No (internal only) | Expose the fail-forward Layer-1 builder as a primitive tool | M |
| **TD lifecycle**: `launch_td`/`restart_td`/`get_td_status`/`switch_instance` + multi-instance registry | No | `manage_td_process` + instance routing (target several TD sessions) | L |
| **Auto-restore** externalized ops from disk on open (files = source of truth) | No | "project-as-files" orchestration recipe/demo | L |
| Per-project **TD build pinning** (`.embody/project.json`) | No | Record TD build in project metadata + mismatch warning | M |
| **`run_tests`** via MCP (53 suites) | No | `run_bridge_tests` — trigger TD-side checks, return pass/fail | M |
| First-class **annotations** + `get_enclosed_ops` | Partial | `manage_annotation` + enclosed-op query (self-doc) | S |
| Auto-generates a project **`CLAUDE.md`** with TD patterns | No | `write_agent_guide` (emit `CLAUDE.md`/`AGENTS.md`) | S |
| **Perform Mode** (suspends MCP/externalization compute live) | No | `set_perform_mode` (VJ-critical) | M |
| `get_logs` ring buffer via MCP | Partial (push stream) | `get_bridge_logs` (pull last-N on demand) | S |

### dotsimulate — LOPs (~70 operators) + StreamDiffusionTD

LOPs are **operators living inside TD** (a full agent runtime as COMPs). TDMCP is **agent-side**, so the angle is "agent-side equivalent" or "orchestration wrapper that drives the installed `.tox`", never reimplement.

| LOPs / SDTD capability | TDMCP? | Agent-side angle | Effort |
|---|---|---|---|
| Agent / Voice Agent / Swarm / Scheduler; **Claude Code** + **MCP Server/Client** LOPs | TDMCP *is* the external agent/server | mostly out of scope; optional `drive_lop_agent` wrapper | M |
| **Tool DAT / Tool Registry** (define custom agent tools as DATs) | Partial (fixed tool set) | `register_custom_tool` — artist exposes a Python snippet/DAT as a runtime agent tool | L |
| STT / TTS / VAD voice pipelines | No | `voice_io` orchestration recipe (TD audio ↔ external STT/TTS) | M |
| Search RAG / Graph memory / source crawlers | Partial (629-op KB + vault) | RAG/graph memory over the artist's own exported TDN/snapshots | L |
| Florence / OCR vision, captioning | No | `caption_top` (vision model describes a captured TOP) | M |
| Gemini Image / Lyria / fal.ai generative media | As prompts | `text_to_image` / `connect_fal` wrappers (→ TOP) | M |
| ComfyUI LOP | known gap | → `connect_comfyui` | L |
| **StreamDiffusionTD**: SDXL-Turbo img2img, Multi-ControlNet, StreamV2V, IP-Adapter FaceID, TensorRT, **Daydream cloud GPU** | No (known `control_diffusion` gap) | `drive_streamdiffusion` — set prompt/strength/seed, toggle ControlNets, switch local-TRT vs. Daydream; `realtime_diffusion_loop` recipe | L |
| CLI installer verify/diagnose/repair | Partial (`tdmcp doctor` ◐) | sharpen existing `doctor` | S |

### Net-new shortlist folded into v0.5.0 (Phase 13)
`edit_dat_content` (S), `set_dat_content`+guardrail (S), `batch_operations` (M), compact-graph read (M), `manage_annotation`+enclosed ops (S), `write_agent_guide` (S), `set_perform_mode` (M). Pushed to v0.5.0+: `manage_td_process`/multi-instance (L), `run_bridge_tests` (M), `get_bridge_logs` (S), `register_custom_tool` (L), `caption_top` (M), and the sharpened `drive_streamdiffusion`/`connect_comfyui` orchestration framing.

**Takeaway:** Embody's externalization thesis overlaps TDMCP's known serialize gap, but its **token-efficiency** (`read_tdn`) and **agent-DX primitives** (surgical DAT edit, batch, lifecycle, multi-instance, perform-mode) are concrete, low-effort wins genuinely absent today. dotsimulate is largely orthogonal; its real pull is sharpening the diffusion/ComfyUI gaps into explicit "drive the installed `.tox`" tools.
