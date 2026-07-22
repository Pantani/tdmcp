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
surface instead of forcing the next user to dig into the internal nodes. The
operation is transactional: exact existing definitions are `unchanged`, a
conflicting definition fails before replacement, and any later failure restores
the complete custom-page snapshot. The same tool can edit/delete parameters,
sort or rename a page, and delete a page. Built-in parameters are protected.

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

Saving now uses a deferred verified transaction: a unique same-directory
temporary is written, hashed/read back, then atomically promoted. Existing files
are refused by default; use `overwrite_policy: "ask"` for a target-bound native
**Overwrite / Keep** decision. `make_portable_tox` uses the same primitive in
portable mode and always restores temporary DAT/external-TOX state in `finally`.
Portable mode is enabled automatically only on the live-proven 2025.32820 build;
other builds require an explicit, separately validated bridge opt-in.

### Trust the portable package

`make_portable_tox` records a versioned `.provenance.json` sidecar by default.
It binds the final `.tox` SHA-256 to the canonical package manifest, the source
COMP identity, the TD/tdmcp build and the Git commit/dirty bit. Sensitive project
content, tokens, environment values, diffs and repository roots are excluded.
The default `provenance_policy:"record"` keeps artist exports practical. Use
`"require_clean"`, optionally with `expected_git_commit`, when producing a
release candidate; a dirty, unavailable or mismatched repository is rejected
before the bridge starts an export.

For load-independent validation, call `validate_library_asset` with
`validation_mode:"deep_roundtrip"` and an explicit quarantine bridge port other
than the artist port `9980`. The authenticated structured route loads the
artifact into a unique scratch holder, compares the declared component
contract, waits for delayed cook errors and cleans the holder in `finally`.
Results are `PASS`, `FAIL` or `UNVERIFIED`; an offline quarantine bridge is never
treated as proof.

Opt into an installed exact-build help package with `help_snapshot`, for example:

```json
{
  "python_apis": ["COMP"],
  "max_operator_types": 32,
  "max_sections_per_page": 2,
  "max_chars_per_section": 3000,
  "max_total_bytes": 262144,
  "quarantine_port": 9981
}
```

The snapshot inventories bounded operator types plus only the Python APIs named
in the request, reads installed OfflineHelp without web fallback, writes a
deterministic `docs/td-help` index/README and reruns the quarantine round-trip.
Missing pages, build mismatch or caps produce `UNVERIFIED`. A later
`attach_docs_as_assets` call can refresh the help snapshot and keeps an existing
provenance record in sync with the promoted manifest.

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
