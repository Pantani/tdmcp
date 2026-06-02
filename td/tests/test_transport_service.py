"""Unit tests for the timeline transport bridge module.

Mirrors ``test_connect_service.py``: install a stub ``td`` module whose
``project``/``me`` are tiny fakes, drive ``transport_service.control()`` off-TD,
and assert (a) the side-effect on the fake state and (b) the returned state dict.

Run from the repo root: ``python3 -m unittest discover -s td/tests``.
"""

import os
import sys
import types
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

# transport_service does ``import td`` INSIDE control(); reach the shared stub
# under sys.modules["td"] (sibling tests setdefault() it) and patch on it.
_td_stub = types.ModuleType("td")
sys.modules.setdefault("td", _td_stub)
_TD = sys.modules["td"]

from mcp.services import transport_service as ts  # noqa: E402


class _FakeTime:
    def __init__(self, frame=0):
        self.frame = frame


class _FakeMe:
    def __init__(self):
        self.time = _FakeTime()


class _FakeProject:
    def __init__(self):
        self.play = False
        self.rate = 1.0
        self.startFrame = 0
        self.endFrame = 600
        self.cookRate = 60.0
        self._cues = {"verse": 200}

    def cue(self, name):
        if name not in self._cues:
            raise RuntimeError("unknown cue %r" % name)
        # Real TD cue() snaps to a frame; mirror with a side-effect via the shared me.
        _TD.me.time.frame = self._cues[name]


class _TdPatch:
    """Swap ``td.project`` / ``td.me`` for a test's lifetime."""

    def __init__(self):
        self.project = _FakeProject()
        self.me = _FakeMe()

    def __enter__(self):
        self._saved = (getattr(_TD, "project", None), getattr(_TD, "me", None))
        _TD.project = self.project
        _TD.me = self.me
        return self

    def __exit__(self, *a):
        _TD.project, _TD.me = self._saved


class TransportTests(unittest.TestCase):
    def test_play_sets_project_play_and_returns_state(self):
        with _TdPatch() as p:
            state = ts.control("play")
        self.assertTrue(p.project.play)
        self.assertEqual(state["action"], "play")
        self.assertTrue(state["play"])
        self.assertEqual(state["startFrame"], 0)
        self.assertEqual(state["endFrame"], 600)
        self.assertEqual(state["fps"], 60.0)

    def test_pause_clears_project_play(self):
        with _TdPatch() as p:
            p.project.play = True
            state = ts.control("pause")
        self.assertFalse(p.project.play)
        self.assertFalse(state["play"])

    def test_seek_clamps_to_endFrame_and_updates_me_time_frame(self):
        with _TdPatch() as p:
            state = ts.control("seek", frame=9999)
        self.assertEqual(p.me.time.frame, 600)  # clamped
        self.assertEqual(state["frame"], 600)

    def test_seek_clamps_to_startFrame(self):
        with _TdPatch() as p:
            state = ts.control("seek", frame=-50)
        self.assertEqual(p.me.time.frame, 0)
        self.assertEqual(state["frame"], 0)

    def test_seek_without_frame_raises(self):
        with _TdPatch():
            with self.assertRaises(ValueError) as cm:
                ts.control("seek")
            self.assertIn("frame", str(cm.exception))

    def test_cue_jumps_to_known_cue(self):
        with _TdPatch() as p:
            state = ts.control("cue", cue_name="verse")
        self.assertEqual(p.me.time.frame, 200)
        self.assertEqual(state["frame"], 200)

    def test_cue_unknown_raises_valueerror(self):
        with _TdPatch():
            with self.assertRaises(ValueError) as cm:
                ts.control("cue", cue_name="nope")
            self.assertIn("nope", str(cm.exception))

    def test_cue_without_name_raises(self):
        with _TdPatch():
            with self.assertRaises(ValueError):
                ts.control("cue")

    def test_rate_sets_project_rate(self):
        with _TdPatch() as p:
            state = ts.control("rate", rate=0.5)
        self.assertEqual(p.project.rate, 0.5)
        self.assertEqual(state["rate"], 0.5)

    def test_rate_without_rate_raises(self):
        with _TdPatch():
            with self.assertRaises(ValueError):
                ts.control("rate")

    def test_unknown_action_raises(self):
        with _TdPatch():
            with self.assertRaises(ValueError):
                ts.control("teleport")


if __name__ == "__main__":
    unittest.main()
