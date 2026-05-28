---
description: "Turn a tdmcp-built TouchDesigner network into a reusable, parameterized, scriptable .tox component — add custom-parameter knobs, scaffold a Python extension class, and save it as a .tox you can drop into any project."
---

# Reusable components

A network you built with tdmcp is great for one show — but to reuse it across
projects you want three things: **knobs** to tune it, **behavior** you can call by
name, and a single **`.tox` file** you can drop anywhere. Three tools cover the
full story:

| Step | Tool | What it does |
|------|------|--------------|
| Build | (any generator) | Make the network — e.g. a feedback tunnel. |
| Knobs | `add_custom_parameters` | Append a custom-parameter page (sliders, toggles, menus, pulses, RGB/XYZ). |
| Behavior | `scaffold_extension` | Give the COMP a Python extension class with methods you can call. |
| Package | `manage_component` | Save the COMP as a reusable `.tox` (or load one back, live-linked). |

You can drive every step in plain language. Here's the whole arc.

## 1. Build the network

> *"Create a feedback tunnel from noise with blur and displace, wrap it in a
> container, and show me a preview."*

Say the container landed at `/project1/tunnel`. Everything below tunes **that
COMP** so it becomes a self-contained, reusable widget.

## 2. Add knobs (`add_custom_parameters`)

> *"On `/project1/tunnel`, add a 'Controls' page with a Feedback knob (0–1,
> default 0.9), a Zoom knob (0.5–2), a Spin knob (−180 to 180) and a Reset
> pulse."*

This appends a custom-parameter page so the component exposes a clean control
surface instead of forcing the next user to dig into the internal nodes. An
existing parameter is **skipped with a warning**, never overwritten, so re-running
it to add one more knob is safe.

::: tip Bind the knobs to the work
The knobs are just inputs until you point them at something. Ask to
*"bind the Feedback knob to the feedback level's brightness"* (that's
[`create_control_panel`](/reference/tools) / `create_macro` under the hood), or
read them from the extension class you'll add next.
:::

## 3. Add behavior (`scaffold_extension`)

Knobs hold values; an **extension class** gives the component real methods:

> *"Scaffold an extension class `TunnelExt` on `/project1/tunnel` with methods
> `Reset` and `Randomize`, and promote it."*

That creates a Text DAT inside the COMP holding:

```python
class TunnelExt:
    def __init__(self, ownerComp):
        self.ownerComp = ownerComp

    def Reset(self):
        pass

    def Randomize(self):
        pass
```

…wires it into the COMP's extension slot and **promotes** it, so the methods are
callable straight off the component — `op('/project1/tunnel').Reset()`. Fill in
the stubs (ask the AI, or edit the DAT) and the component now *does* things, not
just *holds* values.

::: tip Promoted = callable by name
Promoted members (capitalized, like `Reset`) are reachable directly on the COMP.
The extension parameter names live on the COMP's built-in **Extensions** page;
tdmcp probes for them so it keeps working across TouchDesigner builds.
:::

## 4. Save it as a `.tox` (`manage_component`)

> *"Save `/project1/tunnel` as `/Users/me/td-components/tunnel.tox`."*

Now you have a single file that carries the network, its knobs and its extension
class. Drop it into any project:

> *"Load `/Users/me/td-components/tunnel.tox` into `/project1` as a live-linked instance."*

A live-linked instance (`externaltox`) re-reads the file whenever it changes, so
fixing the component once updates every show that uses it.

## The same thing from the shell

Every step has a `tdmcp-agent` command, so you can package a component in a script:

```bash
# 2. knobs
tdmcp-agent add-params --params '{
  "comp_path": "/project1/tunnel",
  "page": "Controls",
  "params": [
    { "name": "Feedback", "type": "Float", "default": 0.9, "min": 0, "max": 1 },
    { "name": "Reset", "type": "Pulse" }
  ]
}'

# 3. behavior
tdmcp-agent scaffold-ext --params '{
  "comp_path": "/project1/tunnel",
  "class_name": "TunnelExt",
  "methods": ["Reset", "Randomize"]
}'

# 4. package
tdmcp-agent component --params '{
  "action": "save",
  "comp_path": "/project1/tunnel",
  "file_path": "/Users/me/td-components/tunnel.tox"
}'
```

## Where to go next

- [Prompt cookbook](/guide/prompt-cookbook) — ready-made prompts for building the
  network you'll turn into a component.
- [Tools reference](/reference/tools) — the full input schema for
  `add_custom_parameters`, `scaffold_extension` and `manage_component`.
