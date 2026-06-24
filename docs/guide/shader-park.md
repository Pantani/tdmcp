---
description: "Use Shader Park with tdmcp: compile Shader Park sculpture code into a TouchDesigner GLSL MAT network, download the official Shader Park .tox plugin, and build an Animus-inspired native audio visualizer."
---

# Shader Park and visualizer packs

tdmcp supports two practical paths for Shader Park:

| Path | Best for | How |
|------|----------|-----|
| tdmcp tool | AI-built scenes, repeatable scripts, previews | `create_shader_park` / `tdmcp-agent shaderpark` compiles code with `shader-park-core` and builds a GLSL MAT render network. |
| Official plugin | Hands-on Shader Park editing inside TouchDesigner | `npm run shader-park:tox` downloads the official `Shader_Park_TD.tox` from `shader-park-touchdesigner`. |

The `codygibb/animus-visualizer` repo is different: it is a Processing/Java
sketch, not an npm package or TouchDesigner component. tdmcp includes a native
recipe inspired by its audio-ring style, so you can build the idea without
installing Processing.

## Compile Shader Park code

`create_shader_park` uses the optional `shader-park-core` peer dependency. The
default hosted/package install does not include it because `shader-park-core@0.2.8`
publishes a broken `toMinimal` bin entry that makes pnpm emit install warnings.
For local Shader Park compilation, install it next to tdmcp first:

```bash
npm install shader-park-core
```

Ask your assistant:

> *"Create a Shader Park sculpture with `rotateY(time * 0.25); color(vec3(0.2, 0.8, 1.0)); sphere(0.45);`, expose the controls, and show me a preview."*

Or run it from the shell:

```bash
tdmcp-agent shaderpark --params '{
  "code": "let size = input(); rotateY(time * 0.2); sphere(size);",
  "uniform_values": { "size": 0.55 },
  "speed": 1,
  "scale": 1,
  "camera_z": 4
}'
```

The tool creates a new COMP with:

- a `shaderpark_code` Text DAT holding the original Shader Park source
- a compiled `shaderpark_pixel` Text DAT
- a `glslMAT` assigned to a renderable bounding box
- camera, light, Render TOP and `out1`
- live controls for Speed, Scale, Opacity, StepSize, CameraZ and any float
  `input()` uniforms, such as `Size`

Use `uniform_values` when your Shader Park code contains `input()` values. For
example, `let size = input(); sphere(size);` needs `{"size": 0.55}` or the
uniform starts at Shader Park's default value.

## Download the official `.tox`

Shader Park also ships a ready-made TouchDesigner plugin. Fetch it with:

```bash
npm run shader-park:tox
```

That downloads `Shader_Park_TD.tox` into:

```text
vendor/shader-park/Shader_Park_TD.tox
```

The file is intentionally ignored by git. Drop it into TouchDesigner when you
want the official plugin workflow: a Text DAT with Shader Park code connected to
the plugin. If your code uses `input()`, add a matching uniform inside the
plugin's GLSL MAT, following the upstream instructions.

## Animus-style rings

Build the native recipe:

```bash
tdmcp-agent recipe --params '{"id":"animus_rings_visualizer"}'
```

It uses a synthetic `audiooscillatorCHOP`, converts the channel to a TOP, and
draws pulsing radial rings in a GLSL TOP. Swap the oscillator for Audio Device In
or Audio File In when you want live music.

## Sources

- [shader-park-core](https://github.com/shader-park/shader-park-core)
- [shader-park-touchdesigner](https://github.com/shader-park/shader-park-touchdesigner)
- [animus-visualizer](https://github.com/codygibb/animus-visualizer)
