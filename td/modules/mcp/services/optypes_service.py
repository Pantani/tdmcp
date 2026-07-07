"""Ground-truth creatable-operator list — survives TDMCP_BRIDGE_ALLOW_EXEC=0.

``GET /api/optypes`` enumerates every operator type the RUNNING TouchDesigner can
create, straight from the live ``td`` module — the authoritative source, unlike
the static knowledge base (which can drift from the installed build/plugins).

An optype is creatable iff it is a lowercase ``td`` attribute that is a *subclass*
of one of the family base classes (TOP/CHOP/SOP/DAT/COMP/MAT/POP). ``issubclass``
against the real base classes is the truth flag; a name-suffix heuristic would
mis-tag helper classes. Probed live on TD 2025.32820: 682 optypes across 7
families.

Pure function; reach TD globals via ``import td`` INSIDE the function so the module
imports cleanly off-TD (mirrors ``mcp/services/api_service.py``).
"""

import inspect

_FAMILY_BASES = ("TOP", "CHOP", "SOP", "DAT", "COMP", "MAT", "POP")


def _family_of(obj, bases):
    """Return the family name whose base class ``obj`` subclasses, or None."""
    for family in _FAMILY_BASES:
        base = bases.get(family)
        if base is None:
            continue
        try:
            if issubclass(obj, base):
                return family
        except Exception:  # noqa: BLE001
            continue
    return None


def _app_info(app):
    info = {}
    for key, attr in (("td_version", "version"), ("build", "build")):
        try:
            value = getattr(app, attr, None)
            if value is not None:
                info[key] = str(value)
        except Exception:  # noqa: BLE001
            continue
    return info


def list_optypes():
    """Enumerate creatable optypes grouped by family.

    Returns ``{optypes, families, count, td_version?, build?}`` where ``optypes``
    is the flat sorted list and ``families`` maps each family to its sorted list.
    """
    import td

    bases = {family: getattr(td, family, None) for family in _FAMILY_BASES}
    families = {family: [] for family in _FAMILY_BASES}

    for name in dir(td):
        if not name or not name[0].islower():
            continue
        obj = getattr(td, name, None)
        if not inspect.isclass(obj):
            continue
        family = _family_of(obj, bases)
        if family is not None:
            families[family].append(name)

    families = {family: sorted(members) for family, members in families.items() if members}
    optypes = sorted(name for members in families.values() for name in members)

    report = {"optypes": optypes, "families": families, "count": len(optypes)}
    report.update(_app_info(getattr(td, "app", None)))
    return report
