# Recipe gallery

Recipes are **pre-built, tested networks** you can ask for by name — a fast way to
get a known-good starting point you can then tweak. Just say:

> *"Apply the **performable feedback tunnel** recipe and show me a preview."*

The AI builds it, checks it, and previews it. From there, iterate in plain
language like any other visual.

## Built-in recipes

| Recipe | What it makes | Level |
| --- | --- | --- |
| **Feedback Tunnel** | A hypnotic tunnel that feeds a transformed, blurred frame back into itself over a noise seed. | Beginner |
| **Performable Feedback Tunnel** | The same tunnel, but with live knobs for decay, zoom, spin and blur — ready to perform, animate with an LFO, or snapshot as presets. | Intermediate |
| **Audio Spectrum Bars** | A classic spectrum analyzer: live audio drawn as colored frequency bars. | Beginner |
| **Reaction Diffusion** | A Gray-Scott reaction-diffusion simulation running on the GPU — organic, growing patterns. | Advanced |
| **Noise Landscape** | A 3D terrain displaced by noise, shaded and rendered with an orbiting camera. | Intermediate |
| **Particle Galaxy** | A swirling galaxy of particles from a sphere emitter, pushed by turbulence and gravity, glowing sprites. | Advanced |
| **Webcam Glitch** | Live webcam through edge detection, RGB split, a feedback loop and a glitch shader. | Intermediate |
| **Data Sonification** | Reads a data table into CHOPs and maps the values to both audio and a color ramp. | Intermediate |
| **Projection Mapping** | Corner-pin keystone correction and edge feathering, ready to send to a projector. | Advanced |
| **LED Strip Mapper** | Samples a visual down to one pixel per LED and streams colors out to an addressable LED strip. | Advanced |
| **Kinect Silhouette** | Uses a Kinect Azure depth feed to isolate a body silhouette and drive a glowing outline. *(Needs Kinect Azure hardware.)* | Advanced |

::: tip Browse them live
Ask *"list the available recipes"* and the AI will read them straight from the
installed version, including any custom recipes you've saved to your
[Obsidian vault](/reference/tools#obsidian-vault).
:::

## Hardware recipes

A few recipes need extra gear:

- **Kinect Silhouette** needs a **Kinect Azure** sensor.
- **LED Strip Mapper** needs an **addressable LED strip** on a serial connection.
- **Projection Mapping** assumes you have a **projector** to send the window to.

They'll still build without the hardware so you can see the structure, but the
live input/output won't do anything until the device is connected.

## Save your own

Made a look you love? Ask:

> *"Save this network as a reusable recipe."*

With an [Obsidian vault](/reference/tools#obsidian-vault) configured, it's stored
as a Markdown note and shows up next to the built-ins for next time.
