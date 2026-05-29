"""Unit tests for the first-class connect/disconnect bridge module.

The module normally runs inside TouchDesigner. To exercise its pure wiring logic
off-TD we install a stub ``td`` module whose ``op`` resolves paths against a fake
operator graph built from ``FakeOp`` / ``FakeConnector`` objects that mimic TD's
connector model (``inputConnectors`` / ``outputConnectors``, ``connect()``,
``connections`` of upstream output connectors exposing ``.owner`` / ``.index``,
and contiguous input packing for multi-input ops).

Run from the repo root: ``python3 -m unittest discover -s td/tests``.
No third-party dependencies — stdlib only.
"""

import os
import sys
import types
import unittest

# --- Make the bridge package importable without TouchDesigner ------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
_MODULES = os.path.abspath(os.path.join(_HERE, "..", "modules"))
if _MODULES not in sys.path:
    sys.path.insert(0, _MODULES)

# connect_service does `import td` INSIDE each function and reads `td.op`, so a
# stub module with a swappable `op` callable is all it needs to import & run.
_td_stub = types.ModuleType("td")
_td_stub.op = lambda path: None
sys.modules.setdefault("td", _td_stub)
# Bind to whatever module actually occupies the `td` slot. Sibling bridge tests
# also `setdefault("td", ...)`, so under `unittest discover` the slot may hold a
# different stub than ours — `connect_service`'s in-function `import td` reads
# this shared module, so _OpPatch must swap `.op` on it (not on our local ref).
_TD = sys.modules["td"]

from mcp.services import connect_service as ce  # noqa: E402


# --- Fake TD connector graph ---------------------------------------------------
class FakeConnector:
    """A single input or output slot, mimicking TD's Connector."""

    def __init__(self, owner, index, is_input):
        self.owner = owner
        self.index = index
        self.isInput = is_input
        self.isOutput = not is_input
        # For an input connector: list of upstream OUTPUT connectors.
        self.connections = []

    def connect(self, other):
        """Wire this INPUT connector to an upstream output connector (or op)."""
        out_conn = other
        if isinstance(other, FakeOp):
            out_conn = other.outputConnectors[0]
        # Record both directions so disconnect / re-scan can see the wire.
        self.connections.append(out_conn)

    def disconnect(self, other=None):
        # Mirrors TD's Connector.disconnect(connector=None): with no arg, clear all
        # wires on this connector; with a connector arg on an INPUT, remove ONLY the
        # wire to that specific upstream output connector (the scoped form the
        # disconnect service now uses so it can't tear down a source's other wires).
        if self.isInput:
            if other is None:
                self.connections = []
            else:
                self.connections = [c for c in self.connections if c is not other]
        else:
            # Clearing an output wire: drop this output from every input listing it.
            for ic in self.owner._graph_inputs_listing(self):
                ic.connections = [c for c in ic.connections if c is not self]


class FakeOp:
    """A fake operator with input/output connectors and a parent path."""

    def __init__(self, path, num_in=1, num_out=1, parent_path=None):
        self.path = path
        self.name = path.rsplit("/", 1)[-1]
        self._parent_path = parent_path if parent_path is not None else path.rsplit("/", 1)[0]
        self.inputConnectors = [FakeConnector(self, i, True) for i in range(num_in)]
        self.outputConnectors = [FakeConnector(self, i, False) for i in range(num_out)]
        self._registry = None

    def parent(self):
        return FakeParent(self._parent_path)

    def _graph_inputs_listing(self, out_conn):
        # All input connectors across the whole registry (used by output.disconnect).
        if self._registry is None:
            return self.inputConnectors
        ics = []
        for node in self._registry.values():
            ics.extend(node.inputConnectors)
        return ics


class FakeParent:
    def __init__(self, path):
        self.path = path


class PackingConnector(FakeConnector):
    """An input connector for a multi-input op that PACKS contiguously.

    Mimics TD's compositeTOP: connecting always lands on the first free slot, and
    the owner re-indexes its connectors after every wiring change.
    """

    def connect(self, other):
        out_conn = other
        if isinstance(other, FakeOp):
            out_conn = other.outputConnectors[0]
        self.owner._pack_connect(out_conn)


class PackingOp(FakeOp):
    """Multi-input op whose inputs pack contiguous and renumber."""

    def __init__(self, path, num_in=3, num_out=1, parent_path=None):
        super().__init__(path, num_in=num_in, num_out=num_out, parent_path=parent_path)
        self.inputConnectors = [PackingConnector(self, i, True) for i in range(num_in)]

    def _wires(self):
        wires = []
        for ic in self.inputConnectors:
            wires.extend(ic.connections)
        return wires

    def _repack(self, wires):
        for i, ic in enumerate(self.inputConnectors):
            ic.index = i
            ic.connections = [wires[i]] if i < len(wires) else []

    def _pack_connect(self, out_conn):
        wires = self._wires()
        wires.append(out_conn)
        self._repack(wires)


def _registry(*ops):
    reg = {o.path: o for o in ops}
    for o in ops:
        o._registry = reg
    return reg


class _OpPatch:
    """Context manager that points the module's `td.op` at a fake registry."""

    def __init__(self, reg):
        self.reg = reg

    def __enter__(self):
        self._orig = getattr(_TD, "op", None)
        _TD.op = lambda path: self.reg.get(path)
        return self

    def __exit__(self, *exc):
        _TD.op = self._orig
        return False


class ConnectTests(unittest.TestCase):
    def test_happy_wire(self):
        src = FakeOp("/p/noise1", num_in=0, num_out=1)
        dst = FakeOp("/p/blur1", num_in=1, num_out=1)
        with _OpPatch(_registry(src, dst)):
            result = ce.connect("/p/noise1", "/p/blur1")
        self.assertEqual(result["source_path"], "/p/noise1")
        self.assertEqual(result["target_path"], "/p/blur1")
        self.assertEqual(result["requested_input"], 0)
        self.assertEqual(result["actual_input"], 0)
        self.assertEqual(result["source_output"], 0)
        self.assertTrue(result["connected"])
        # The wire actually exists on the fake graph.
        self.assertEqual(len(dst.inputConnectors[0].connections), 1)
        self.assertIs(dst.inputConnectors[0].connections[0], src.outputConnectors[0])

    def test_source_output_index_respected(self):
        src = FakeOp("/p/src1", num_in=0, num_out=2)
        dst = FakeOp("/p/dst1", num_in=2, num_out=1)
        with _OpPatch(_registry(src, dst)):
            result = ce.connect("/p/src1", "/p/dst1", source_output=1, target_input=1)
        self.assertEqual(result["source_output"], 1)
        self.assertEqual(result["actual_input"], 1)
        self.assertIs(dst.inputConnectors[1].connections[0], src.outputConnectors[1])

    def test_not_found_raises(self):
        dst = FakeOp("/p/blur1", num_in=1)
        with _OpPatch(_registry(dst)):
            with self.assertRaises(LookupError) as cm:
                ce.connect("/p/ghost", "/p/blur1")
        self.assertIn("source or target not found", str(cm.exception))

    def test_cross_container_rejected(self):
        src = FakeOp("/p/a/noise1", num_in=0, num_out=1, parent_path="/p/a")
        dst = FakeOp("/p/b/blur1", num_in=1, num_out=1, parent_path="/p/b")
        with _OpPatch(_registry(src, dst)):
            with self.assertRaises(ValueError) as cm:
                ce.connect("/p/a/noise1", "/p/b/blur1")
        self.assertIn("across containers", str(cm.exception))
        # No wire was made.
        self.assertEqual(len(dst.inputConnectors[0].connections), 0)

    def test_target_input_out_of_range(self):
        src = FakeOp("/p/noise1", num_in=0, num_out=1)
        dst = FakeOp("/p/blur1", num_in=1, num_out=1)
        with _OpPatch(_registry(src, dst)):
            with self.assertRaises(IndexError) as cm:
                ce.connect("/p/noise1", "/p/blur1", target_input=5)
        self.assertIn("target_input 5 out of range", str(cm.exception))

    def test_source_output_out_of_range(self):
        src = FakeOp("/p/noise1", num_in=0, num_out=1)
        dst = FakeOp("/p/blur1", num_in=1, num_out=1)
        with _OpPatch(_registry(src, dst)):
            with self.assertRaises(IndexError) as cm:
                ce.connect("/p/noise1", "/p/blur1", source_output=3)
        self.assertIn("source_output 3 out of range", str(cm.exception))

    def test_multi_input_packing_reports_actual_input(self):
        # A compositeTOP-style op: src1 wired into slot 0 already; requesting slot
        # 2 packs down to slot 1. The endpoint must report actual_input == 1.
        src1 = FakeOp("/p/src1", num_in=0, num_out=1)
        src2 = FakeOp("/p/src2", num_in=0, num_out=1)
        comp = PackingOp("/p/comp1", num_in=3, num_out=1)
        reg = _registry(src1, src2, comp)
        with _OpPatch(reg):
            first = ce.connect("/p/src1", "/p/comp1", target_input=0)
            self.assertEqual(first["actual_input"], 0)
            second = ce.connect("/p/src2", "/p/comp1", target_input=2)
        self.assertEqual(second["requested_input"], 2)
        self.assertEqual(second["actual_input"], 1)  # packed down from 2 -> 1


class DisconnectTests(unittest.TestCase):
    def _wired(self):
        src = FakeOp("/p/noise1", num_in=0, num_out=1)
        dst = FakeOp("/p/blur1", num_in=1, num_out=1)
        reg = _registry(src, dst)
        with _OpPatch(reg):
            ce.connect("/p/noise1", "/p/blur1")
        return src, dst, reg

    def test_disconnect_by_source(self):
        src, dst, reg = self._wired()
        # Add a second upstream so by-source filtering is meaningful.
        src2 = FakeOp("/p/ramp1", num_in=0, num_out=1)
        dst.inputConnectors[0].connections.append(src2.outputConnectors[0])
        reg[src2.path] = src2
        src2._registry = reg
        with _OpPatch(reg):
            result = ce.disconnect("/p/blur1", from_path="/p/noise1")
        self.assertEqual(result["to_path"], "/p/blur1")
        self.assertEqual(result["from_path"], "/p/noise1")
        self.assertEqual(len(result["removed"]), 1)
        self.assertEqual(result["removed"][0], {"input": 0, "from": "/p/noise1"})
        self.assertEqual(result["warnings"], [])
        # Only the noise1 wire was dropped; ramp1 remains.
        remaining = [c.owner.path for c in dst.inputConnectors[0].connections]
        self.assertEqual(remaining, ["/p/ramp1"])

    def test_disconnect_all_inputs(self):
        src, dst, reg = self._wired()
        with _OpPatch(reg):
            result = ce.disconnect("/p/blur1")
        self.assertEqual(len(result["removed"]), 1)
        self.assertIsNone(result["from_path"])
        self.assertIsNone(result["to_input"])
        self.assertEqual(len(dst.inputConnectors[0].connections), 0)

    def test_disconnect_scoped_by_input_index_skips_others(self):
        src1 = FakeOp("/p/src1", num_in=0, num_out=1)
        src2 = FakeOp("/p/src2", num_in=0, num_out=1)
        dst = FakeOp("/p/comp1", num_in=2, num_out=1)
        reg = _registry(src1, src2, dst)
        with _OpPatch(reg):
            ce.connect("/p/src1", "/p/comp1", target_input=0)
            ce.connect("/p/src2", "/p/comp1", target_input=1)
            result = ce.disconnect("/p/comp1", to_input=1)
        self.assertEqual(result["to_input"], 1)
        self.assertEqual(result["removed"], [{"input": 1, "from": "/p/src2"}])
        # Slot 0 (src1) untouched.
        self.assertEqual(len(dst.inputConnectors[0].connections), 1)
        self.assertEqual(len(dst.inputConnectors[1].connections), 0)

    def test_disconnect_node_not_found_raises(self):
        with _OpPatch(_registry()):
            with self.assertRaises(LookupError) as cm:
                ce.disconnect("/p/ghost")
        self.assertIn("node not found", str(cm.exception))

    def test_disconnect_no_matching_source_removes_nothing(self):
        src, dst, reg = self._wired()
        with _OpPatch(reg):
            result = ce.disconnect("/p/blur1", from_path="/p/somethingelse")
        self.assertEqual(result["removed"], [])
        self.assertEqual(result["warnings"], [])
        # Original wire intact.
        self.assertEqual(len(dst.inputConnectors[0].connections), 1)


if __name__ == "__main__":
    unittest.main()
