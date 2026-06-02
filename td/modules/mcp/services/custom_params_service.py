"""Custom-parameter readout — first-class endpoint for ``serialize_network`` and
``inspect_component``.

Reads the custom-parameter definitions (``op.customPars``) on a single node and
returns them as a uniform list so the Node-side tools collapse a defensive
exec-string walk into one structured REST call.

Pure functions; reach TD globals (``op``) via ``import td`` INSIDE the function
so the module imports cleanly off-TD (mirrors
``mcp/services/transport_service.py`` and ``system_service.py``).

NOT gated by ``TDMCP_BRIDGE_ALLOW_EXEC`` — read-only inspection, must survive
the hardened config the same way the other structured services do.

Output shape — every par is best-effort; per-par failures degrade into
``warnings`` rather than failing the whole readout:

    {
      "params": [
        {
          "name": "Resolution",
          "label": "Resolution",
          "page": "Custom",
          "style": "Int",
          "default": 1080,
          "value": 1080,
          "min": 0.0,
          "max": null,
          "options": null
        },
        ...
      ],
      "warnings": [str, ...]
    }

``params`` is always present (possibly empty). ``options`` is a list of menu
labels for Menu/StrMenu-style pars, ``null`` otherwise. ``min``/``max`` come
from the normalized par range (``normMin``/``normMax``); both may be ``null``
on builds where the attributes are absent.
"""


def _safe(getter, default=None):
    try:
        return getter()
    except Exception:  # noqa: BLE001
        return default


def _read_options(par):
    """Best-effort menu-options readout. Returns list[str] or None.

    Prefers ``menuLabels`` (human-readable) over ``menuNames`` (internal tokens).
    """
    try:
        labels = getattr(par, "menuLabels", None)
        if labels:
            return [str(label) for label in labels]
        names = getattr(par, "menuNames", None)
        if names:
            return [str(n) for n in names]
    except Exception:  # noqa: BLE001
        pass
    return None


def _read_par(par, warnings):
    """Capture one custom Par's metadata into a JSON-able dict.

    Every accessor is wrapped: TD parameter objects vary in what they expose by
    style/build, and one quirky par must not sink the whole node's readout.
    """
    entry = {
        "name": None,
        "label": None,
        "page": None,
        "style": None,
        "default": None,
        "value": None,
        "min": None,
        "max": None,
        "options": None,
    }
    name = _safe(lambda: par.name)
    if not name:
        warnings.append("Skipped a custom par with no readable name.")
        return None
    entry["name"] = name
    entry["label"] = _safe(lambda: par.label) or name
    page = _safe(lambda: par.page)
    if page is not None:
        entry["page"] = _safe(lambda: str(page.name))
    entry["style"] = _safe(lambda: str(par.style))
    try:
        entry["default"] = par.default
    except Exception as exc:  # noqa: BLE001
        warnings.append("Could not read default of %s: %s" % (name, exc))
    try:
        entry["value"] = par.eval()
    except Exception as exc:  # noqa: BLE001
        warnings.append("Could not eval %s: %s" % (name, exc))
    entry["min"] = _safe(lambda: par.normMin)
    entry["max"] = _safe(lambda: par.normMax)
    entry["options"] = _read_options(par)
    return entry


def get_custom_params(path):
    """Return ``{params, warnings}`` for the node at ``path``.

    Non-existent path → ``fatal`` field set (in-band, mirrors the other
    structured services). Node without ``customPars`` (non-COMP, or COMP with
    no custom panel) → empty list + a warning.
    """
    import td

    report = {"params": [], "warnings": []}

    try:
        node = td.op(path)
    except Exception as exc:  # noqa: BLE001
        report["fatal"] = "Could not resolve %s: %s" % (path, exc)
        return report
    if node is None:
        report["fatal"] = "Node not found: %s" % path
        return report

    custom = getattr(node, "customPars", None)
    if custom is None:
        report["warnings"].append("Node has no customPars attribute: %s" % path)
        return report

    try:
        iter(custom)
    except TypeError:
        report["warnings"].append("customPars not iterable on %s" % path)
        return report

    for par in custom:
        try:
            entry = _read_par(par, report["warnings"])
        except Exception as exc:  # noqa: BLE001
            report["warnings"].append("Failed reading a par on %s: %s" % (path, exc))
            continue
        if entry is not None:
            report["params"].append(entry)
    return report
