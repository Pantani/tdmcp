"""Unit tests for the opt-in parameter-watch bridge module.

`watch_service` normally runs inside TouchDesigner (both the REST handler and the
Parameter Execute DAT import it). Off-TD we install a stub `td` module whose `op`
resolves paths to `FakeOp`s and whose `absTime.frame` is fixed, then exercise the
registry, par filters, coalescing guard, and the `param.changed` payload builder.

Run from the repo root: `python3 -m unittest discover -s td/tests`.
No third-party dependencies — stdlib only.
"""

import contextlib
import os
import sys
import types
import unittest

# --- Make the bridge package importable without TouchDesigner ------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

_td_stub = types.ModuleType("td")
_td_stub.op = lambda path: None
_abs = types.SimpleNamespace(frame=42)
_td_stub.absTime = _abs
sys.modules.setdefault("td", _td_stub)
_TD = sys.modules["td"]
_TD.absTime = _abs

from mcp.services import watch_service as ws  # noqa: E402


class FakePar:
    def __init__(self, owner, name, value=0.0):
        self.owner = owner
        self.name = name
        self.value = value

    def eval(self):
        return self.value


class FakeParGroup:
    def __init__(self, owner):
        self._owner = owner
        self._pars = {}

    def add(self, name, value=0.0):
        par = FakePar(self._owner, name, value)
        self._pars[name] = par
        return par

    def __getattr__(self, name):
        # Only real, added pars resolve; everything else is absent (None-like).
        pars = self.__dict__.get("_pars", {})
        if name in pars:
            return pars[name]
        raise AttributeError(name)


class FakeOp:
    def __init__(self, path):
        self.path = path
        self.par = FakeParGroup(self)

    def pars(self):
        return list(self.par._pars.values())

    def set(self, name, value):
        if name in self.par._pars:
            self.par._pars[name].value = value
        else:
            self.par.add(name, value)


class _OpPatch:
    """Context manager: point the shared `td.op` at a path->FakeOp graph."""

    def __init__(self, graph):
        self.graph = graph
        self._prev = None

    _MISSING = object()

    def __enter__(self):
        # Sibling bridge tests run under `discover` may have claimed the shared
        # `td` slot with a stub lacking `.op`, so tolerate its absence and restore
        # to whatever was there (including "not set").
        self._prev = getattr(_TD, "op", self._MISSING)
        _TD.op = lambda path: self.graph.get(path)
        _TD.absTime = _abs
        return self

    def __exit__(self, *exc):
        if self._prev is self._MISSING:
            with contextlib.suppress(AttributeError):
                delattr(_TD, "op")
        else:
            _TD.op = self._prev
        return False


class WatchRegistryTests(unittest.TestCase):
    def setUp(self):
        ws.clear()

    def test_register_resolves_and_lists(self):
        node = FakeOp("/project1/noise1")
        with _OpPatch({"noise1": node, "/project1/noise1": node}):
            out = ws.register("noise1")
        self.assertEqual(out["path"], "/project1/noise1")
        self.assertIsNone(out["pars"])  # watch-all
        self.assertTrue(out["watching"])
        listing = ws.list_watches()
        self.assertEqual(listing["count"], 1)
        self.assertEqual(listing["watches"][0]["path"], "/project1/noise1")

    def test_register_unknown_path_raises(self):
        with _OpPatch({}):
            with self.assertRaises(LookupError):
                ws.register("nope")

    def test_par_filter_and_merge(self):
        node = FakeOp("/project1/level1")
        with _OpPatch({"/project1/level1": node}):
            ws.register("/project1/level1", ["opacity"])
            out = ws.register("/project1/level1", ["level"])
        self.assertEqual(out["pars"], ["level", "opacity"])  # sorted union

    def test_empty_pars_list_means_watch_all(self):
        node = FakeOp("/project1/n")
        with _OpPatch({"/project1/n": node}):
            out = ws.register("/project1/n", [])
        self.assertIsNone(out["pars"])

    def test_unregister_specific_par_then_whole(self):
        node = FakeOp("/project1/level1")
        with _OpPatch({"/project1/level1": node}):
            ws.register("/project1/level1", ["opacity", "level"])
            partial = ws.unregister("/project1/level1", ["opacity"])
            self.assertEqual(partial["pars"], ["level"])
            self.assertTrue(partial["watching"])
            gone = ws.unregister("/project1/level1")
            self.assertFalse(gone["watching"])
        self.assertEqual(ws.list_watches()["count"], 0)

    def test_unregister_unknown_is_noop(self):
        with _OpPatch({}):
            out = ws.unregister("/project1/ghost")
        self.assertFalse(out["watching"])

    def test_unregister_after_op_deleted_removes_canonical_entry(self):
        # Regression: register() stores under the op's canonical node.path. If the op
        # is later DELETED, td.op(alias) returns None; unregister must still remove the
        # entry register() stored canonically (not miss it and leak a dead watch).
        node = FakeOp("/project1/level1")
        with _OpPatch({"level1": node, "/project1/level1": node}):
            ws.register("level1")  # canonicalized to /project1/level1
        self.assertEqual(ws.list_watches()["count"], 1)
        # Op is gone: td.op resolves nothing, only the original alias is known.
        with _OpPatch({}):
            out = ws.unregister("level1")
        self.assertFalse(out["watching"])
        self.assertEqual(ws.list_watches()["count"], 0)

    def test_is_watched_respects_filter(self):
        node = FakeOp("/project1/level1")
        with _OpPatch({"/project1/level1": node}):
            ws.register("/project1/level1", ["opacity"])
        self.assertTrue(ws.is_watched("/project1/level1", "opacity"))
        self.assertFalse(ws.is_watched("/project1/level1", "level"))
        self.assertFalse(ws.is_watched("/project1/other", "opacity"))


class PollTests(unittest.TestCase):
    """Poll-based change detection (the onFrameEnd mechanism)."""

    def setUp(self):
        ws.clear()

    def _register(self, node, pars=None):
        with _OpPatch({node.path: node}):
            ws.register(node.path, pars)

    def _poll(self, graph, now_s, frame=7):
        return ws.poll(op_resolver=lambda p: graph.get(p), frame=frame, now_s=now_s)

    def test_first_poll_seeds_no_change(self):
        node = FakeOp("/project1/level1")
        node.par.add("opacity", 1.0)
        self._register(node, ["opacity"])
        graph = {node.path: node}
        # First poll only seeds the snapshot -> no spurious event.
        self.assertEqual(self._poll(graph, 1000.0), [])

    def test_detects_a_change(self):
        node = FakeOp("/project1/level1")
        node.par.add("opacity", 1.0)
        self._register(node, ["opacity"])
        graph = {node.path: node}
        self._poll(graph, 1000.0)  # seed
        node.set("opacity", 0.5)
        out = self._poll(graph, 1000.100)
        self.assertEqual(
            out,
            [{"path": "/project1/level1", "par": "opacity", "prev": 1.0, "value": 0.5, "frame": 7}],
        )

    def test_only_watched_pars_emit(self):
        node = FakeOp("/project1/level1")
        node.par.add("opacity", 1.0)
        node.par.add("level", 0.0)
        self._register(node, ["opacity"])  # level is NOT watched
        graph = {node.path: node}
        self._poll(graph, 1000.0)
        node.set("opacity", 0.2)
        node.set("level", 0.9)
        out = self._poll(graph, 1000.100)
        self.assertEqual([p["par"] for p in out], ["opacity"])

    def test_watch_all_emits_any_par(self):
        node = FakeOp("/project1/slider")
        node.par.add("value0", 0.0)
        self._register(node, None)  # watch-all
        graph = {node.path: node}
        self._poll(graph, 1000.0)
        node.set("value0", 0.4)
        out = self._poll(graph, 1000.100)
        self.assertEqual([p["par"] for p in out], ["value0"])

    def test_coalesces_rapid_changes(self):
        node = FakeOp("/project1/slider")
        node.par.add("value0", 0.0)
        self._register(node, None)
        graph = {node.path: node}
        self._poll(graph, 1000.0)  # seed
        node.set("value0", 0.1)
        self.assertEqual(len(self._poll(graph, 1000.0)), 1)  # first change emits
        node.set("value0", 0.2)
        # 10 ms later (< 50 ms window) -> coalesced away
        self.assertEqual(self._poll(graph, 1000.010), [])
        node.set("value0", 0.9)
        # 60 ms after the first emit -> window elapsed, emits the resting value
        later = self._poll(graph, 1000.060)
        self.assertEqual(len(later), 1)
        self.assertEqual(later[0]["value"], 0.9)

    def test_burst_then_settle_emits_final_resting_value(self):
        # Regression: a burst that settles at a new value WITHIN the coalesce
        # window and then STOPS must still eventually emit the settled value. The
        # snapshot must only advance on delivery, else the coalesced final change
        # is silently lost and subscribers keep the stale value.
        node = FakeOp("/project1/slider")
        node.par.add("value0", 0.0)
        self._register(node, None)
        graph = {node.path: node}
        self._poll(graph, 1000.0)  # seed 0.0
        node.set("value0", 0.1)
        first = self._poll(graph, 1000.0)  # first change emits 0.0 -> 0.1
        self.assertEqual([p["value"] for p in first], [0.1])
        node.set("value0", 0.2)
        # settles at 0.2 within the 50 ms window -> coalesced away for now...
        self.assertEqual(self._poll(graph, 1000.010), [])
        # ...and then the value STOPS changing. A poll after the window must still
        # deliver the settled 0.2 (prev is the last EMITTED 0.1, not the dropped
        # intermediate), so subscribers converge on 0.2.
        settled = self._poll(graph, 1000.060)
        self.assertEqual(len(settled), 1)
        self.assertEqual(settled[0]["value"], 0.2)
        self.assertEqual(settled[0]["prev"], 0.1)
        # Once delivered, a further poll at rest is quiet (snapshot advanced to 0.2).
        self.assertEqual(self._poll(graph, 1000.200), [])

    def test_unregistered_op_is_skipped(self):
        node = FakeOp("/project1/level1")
        node.par.add("opacity", 1.0)
        self._register(node, ["opacity"])
        # Poll with a graph that no longer resolves the path -> skipped, no raise.
        self.assertEqual(ws.poll(op_resolver=lambda _p: None, frame=1, now_s=1000.0), [])

    def test_partial_unregister_clears_removed_par_snapshot(self):
        # Regression: unregistering only SOME par names must purge the removed names'
        # stale snapshot/emit state. Otherwise a later re-watch of a removed par would
        # diff against the old snapshot (not _UNSET) and either emit a spurious change
        # or, on an unchanged value, stay seeded on stale state.
        node = FakeOp("/project1/level1")
        node.par.add("opacity", 1.0)
        node.par.add("level", 0.0)
        self._register(node, ["opacity", "level"])
        graph = {node.path: node}
        self._poll(graph, 1000.0)  # seed both snapshots
        # Remove only 'opacity'; 'level' stays watched with its snapshot intact.
        ws.unregister("/project1/level1", ["opacity"])
        # Re-watch 'opacity' at its CURRENT value: because its snapshot was cleared,
        # the next poll only re-seeds it (first sight) -> no spurious change event.
        with _OpPatch({node.path: node}):
            ws.register("/project1/level1", ["opacity"])
        self.assertEqual(self._poll(graph, 1000.100), [])
        # A real change afterwards still emits normally.
        node.set("opacity", 0.5)
        out = self._poll(graph, 1000.300)
        self.assertEqual([(p["par"], p["prev"], p["value"]) for p in out], [("opacity", 1.0, 0.5)])

    def test_non_scalar_value_is_stringified(self):
        class Weird:
            def __str__(self):
                return "weird-value"

        node = FakeOp("/project1/n")
        node.par.add("file", "a.mov")
        self._register(node, ["file"])
        graph = {node.path: node}
        self._poll(graph, 1000.0)  # seed
        node.set("file", Weird())
        out = self._poll(graph, 1000.100)
        self.assertEqual(out[0]["value"], "weird-value")
        self.assertEqual(out[0]["prev"], "a.mov")


if __name__ == "__main__":
    unittest.main()
