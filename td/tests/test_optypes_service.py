"""Unit tests for the creatable-optype enumeration bridge module (optypes_service).

Runs off-TD by populating the stub ``td`` module with fake family base classes
(TOP/CHOP/…) and lowercase optype subclasses, plus non-optype noise (a helper
class, an uppercase name, a non-class attribute) that the walk must exclude. The
service groups by ``issubclass`` against the family bases — the same truth flag it
uses on a live TD — so the fixture exercises the real classification path.

Run from the repo root: ``python3 -m unittest discover -s td/tests``. Stdlib only.
"""

import os
import sys
import types
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

_td_stub = types.ModuleType("td")
_td_stub.op = lambda path: None
sys.modules.setdefault("td", _td_stub)
_TD = sys.modules["td"]

from mcp.services import optypes_service as os_svc  # noqa: E402


_MISSING = object()


def _install_fake_td():
    """Populate the shared ``td`` stub with fake family bases + optypes.

    Returns ``{name: prior_value_or_sentinel}`` so the test can RESTORE the module
    to its exact prior state — sibling tests (e.g. test_services) install their own
    ``td.app``/``td.project`` at import, so a blind ``delattr`` would leak and break
    them; restoring the saved value keeps the shared ``td`` stub intact.
    """
    saved = {}

    class TOP:
        pass

    class CHOP:
        pass

    class COMP:
        pass

    class noiseTOP(TOP):  # noqa: N801 (mirror TD optype casing)
        pass

    class nullTOP(TOP):  # noqa: N801
        pass

    class analyzeCHOP(CHOP):  # noqa: N801
        pass

    class baseCOMP(COMP):  # noqa: N801
        pass

    class _Helper:  # non-optype: leading underscore skipped by name filter anyway
        pass

    class NotAnOp:  # uppercase leading char -> excluded
        pass

    fixtures = {
        "TOP": TOP,
        "CHOP": CHOP,
        "COMP": COMP,
        "noiseTOP": noiseTOP,
        "nullTOP": nullTOP,
        "analyzeCHOP": analyzeCHOP,
        "baseCOMP": baseCOMP,
        "helperThing": _Helper,  # lowercase class but subclasses no family base
        "NotAnOp": NotAnOp,
        "some_constant": 42,  # non-class attribute
        "app": types.SimpleNamespace(version="099", build="2025.32820"),
    }
    for name, value in fixtures.items():
        saved[name] = getattr(_TD, name, _MISSING)
        setattr(_TD, name, value)
    return saved


def _restore_td(saved):
    for name, prior in saved.items():
        if prior is _MISSING:
            if hasattr(_TD, name):
                delattr(_TD, name)
        else:
            setattr(_TD, name, prior)


class OpTypesServiceTest(unittest.TestCase):
    def setUp(self):
        self._saved = _install_fake_td()

    def tearDown(self):
        _restore_td(self._saved)

    def test_enumerates_creatable_optypes_by_family(self):
        report = os_svc.list_optypes()
        self.assertEqual(report["count"], 4)
        self.assertEqual(sorted(report["optypes"]), ["analyzeCHOP", "baseCOMP", "noiseTOP", "nullTOP"])
        self.assertEqual(report["families"]["TOP"], ["noiseTOP", "nullTOP"])
        self.assertEqual(report["families"]["CHOP"], ["analyzeCHOP"])
        self.assertEqual(report["families"]["COMP"], ["baseCOMP"])

    def test_excludes_non_optypes(self):
        report = os_svc.list_optypes()
        flat = report["optypes"]
        # Uppercase-leading class, non-family lowercase class, and non-class attrs excluded.
        self.assertNotIn("NotAnOp", flat)
        self.assertNotIn("helperThing", flat)
        self.assertNotIn("some_constant", flat)
        # Family base classes themselves are uppercase -> not enumerated as optypes.
        self.assertNotIn("TOP", flat)

    def test_reports_app_version_and_build(self):
        report = os_svc.list_optypes()
        self.assertEqual(report["td_version"], "099")
        self.assertEqual(report["build"], "2025.32820")

    def test_empty_families_are_omitted(self):
        report = os_svc.list_optypes()
        # No SOP/DAT/MAT/POP optypes in the fixture -> those families absent.
        self.assertNotIn("SOP", report["families"])
        self.assertNotIn("POP", report["families"])


if __name__ == "__main__":
    unittest.main()
