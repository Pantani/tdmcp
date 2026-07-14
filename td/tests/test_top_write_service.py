"""Unit tests for the numpy->TOP byte-push bridge module (top_write_service).

Runs off-TD by installing a stub ``td`` module whose ``op`` resolves paths against a
small dict of fake ops. ``FakeScriptTop`` mimics a Script TOP (it exposes
``copyNumpyArray``, ``store``/``fetch``, ``par``, ``cook``); ``FakeTop`` mimics a
plain TOP (no ``copyNumpyArray``), which the service must refuse.

``apply_payload`` is exercised against a recording fake ``numpy`` so the dtype/shape/
flip contract is asserted everywhere, plus a real-numpy test that is skipped when
numpy is not installed.

Run from the repo root: ``python3 -m unittest discover -s td/tests``. Stdlib only.
"""

import base64
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

from mcp.services import top_write_service as tws  # noqa: E402


class FakePar:
    """A settable TD parameter that records the last assigned value."""

    def __init__(self, value=""):
        self.val = value

    def eval(self):
        return self.val


class FakeParCollection:
    def __init__(self, callbacks=""):
        self.callbacks = FakePar(callbacks)
        self.outputresolution = None
        self.resolutionw = None
        self.resolutionh = None
        self.format = None


class FakeDat:
    def __init__(self, path, name):
        self.path = path
        self.name = name
        self.text = ""


class FakeParent:
    """A COMP that can look up and create children."""

    def __init__(self, path="/project1"):
        self.path = path
        self.children = {}
        self.created = []

    def op(self, name):
        return self.children.get(name)

    def create(self, optype, name):
        self.created.append((optype, name))
        path = "%s/%s" % (self.path, name)
        node = FakeDat(path, name) if optype == "textDAT" else FakeScriptTop(path, name, self)
        self.children[name] = node
        return node


class FakeScriptTop:
    def __init__(self, path, name, parent, callbacks=""):
        self.path = path
        self.name = name
        self.type = "scriptTOP"
        self.par = FakeParCollection(callbacks)
        self._parent = parent
        self._storage = {}
        self.cooks = 0
        self.copied = []

    def parent(self):
        return self._parent

    def store(self, key, value):
        self._storage[key] = value

    def fetch(self, key, default=None, search=True):
        return self._storage.get(key, default)

    def cook(self, force=False):
        self.cooks += 1

    def copyNumpyArray(self, arr, is3D=False, isCube=False):  # noqa: N803 (TD kwargs)
        self.copied.append(arr)


class FakePlainTop:
    """A TOP WITHOUT copyNumpyArray — not a valid pixel target."""

    def __init__(self, path):
        self.path = path
        self.type = "noiseTOP"


class _OpPatch:
    def __init__(self, graph):
        self.graph = graph

    def __enter__(self):
        self._prev = _TD.op
        _TD.op = lambda path: self.graph.get(path)
        return self

    def __exit__(self, *exc):
        _TD.op = self._prev


class _EnvPatch:
    def __init__(self, **env):
        self.env = env

    def __enter__(self):
        self._prev = {k: os.environ.get(k) for k in self.env}
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return self

    def __exit__(self, *exc):
        for k, v in self._prev.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _b64(nbytes, fill=b"\x01"):
    return base64.b64encode(fill * nbytes).decode("ascii")


def _graph_with_script_top(callbacks=""):
    parent = FakeParent("/project1")
    top = FakeScriptTop("/project1/ai_tex", "ai_tex", parent, callbacks)
    parent.children["ai_tex"] = top
    return {"/project1": parent, "/project1/ai_tex": top}, parent, top


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------
class WriteHappyPathTest(unittest.TestCase):
    def test_writes_buffer_wires_callbacks_and_cooks(self):
        graph, parent, top = _graph_with_script_top()
        pixels = _b64(4 * 2 * 4)  # 4x2 RGBA uint8 = 32 bytes

        with _OpPatch(graph):
            report = tws.write("/project1/ai_tex", 4, 2, pixels)

        self.assertEqual(report["path"], "/project1/ai_tex")
        self.assertEqual((report["width"], report["height"], report["channels"]), (4, 2, 4))
        self.assertEqual(report["format"], "uint8")
        self.assertEqual(report["bytes"], 32)
        self.assertFalse(report["created"])
        self.assertTrue(report["cooked"])
        self.assertEqual(report["warnings"], [])

        # The buffer landed in the TOP's storage with the full geometry.
        payload = top._storage[tws.STORAGE_KEY]
        self.assertEqual(len(payload["data"]), 32)
        self.assertEqual(payload["dtype"], "uint8")
        self.assertEqual((payload["width"], payload["height"], payload["channels"]), (4, 2, 4))

        # Resolution followed the frame and the TOP was force-cooked once.
        self.assertEqual(top.par.outputresolution, "custom")
        self.assertEqual((top.par.resolutionw, top.par.resolutionh), (4, 2))
        self.assertEqual(top.cooks, 1)

        # The managed callbacks DAT was created, filled and wired.
        self.assertEqual(report["callbacks_path"], "/project1/ai_tex_tdmcp_write")
        dat = parent.op("ai_tex_tdmcp_write")
        self.assertIn("apply_payload", dat.text)
        self.assertEqual(top.par.callbacks.val, "ai_tex_tdmcp_write")

    def test_top_left_origin_flips_bottom_left_does_not(self):
        graph, _parent, top = _graph_with_script_top()
        with _OpPatch(graph):
            flipped = tws.write("/project1/ai_tex", 2, 2, _b64(16))
            straight = tws.write("/project1/ai_tex", 2, 2, _b64(16), origin="bottom_left")

        # Default origin is top_left (a decoded PNG); TD samples bottom-left-first.
        self.assertTrue(flipped["flip"])
        self.assertEqual(flipped["origin"], "top_left")
        self.assertFalse(straight["flip"])
        self.assertEqual(straight["origin"], "bottom_left")
        self.assertFalse(top._storage[tws.STORAGE_KEY]["flip"])

    def test_creates_the_script_top_when_absent(self):
        parent = FakeParent("/project1")
        with _OpPatch({"/project1": parent}):
            report = tws.write("/project1/fresh", 2, 2, _b64(16))

        self.assertTrue(report["created"])
        self.assertEqual(report["path"], "/project1/fresh")
        self.assertIn(("scriptTOP", "fresh"), parent.created)
        self.assertIn(("textDAT", "fresh_tdmcp_write"), parent.created)

    def test_float32_and_channel_counts_size_the_buffer(self):
        graph, _parent, _top = _graph_with_script_top()
        with _OpPatch(graph):
            # 3x2 x 3ch x float32 = 3*2*3*4 = 72 bytes
            report = tws.write(
                "/project1/ai_tex", 3, 2, _b64(72), channels=3, pixel_format="float32"
            )
        self.assertEqual(report["bytes"], 72)
        self.assertEqual(report["format"], "float32")
        self.assertEqual(report["channels"], 3)

    def test_a_float_push_widens_the_texture_format(self):
        graph, _parent, top = _graph_with_script_top()
        with _OpPatch(graph):
            tws.write("/project1/ai_tex", 3, 2, _b64(72), channels=3, pixel_format="float32")
        # Without this the 32-bit buffer is quantized to the default 8-bit fixed texture.
        self.assertEqual(top.par.format, tws._PIXEL_FORMATS["float32"])

    def test_a_uint8_push_leaves_the_texture_format_alone(self):
        graph, _parent, top = _graph_with_script_top()
        with _OpPatch(graph):
            tws.write("/project1/ai_tex", 2, 2, _b64(16))
        # uint8 already matches the Script TOP's default 8-bit fixed texture.
        self.assertIsNone(top.par.format)
        self.assertNotIn("uint8", tws._PIXEL_FORMATS)


# ---------------------------------------------------------------------------
# Payload cap — refuse, never downscale or truncate
# ---------------------------------------------------------------------------
class PayloadCapTest(unittest.TestCase):
    def test_1080p_rgba_fits_under_the_default_cap(self):
        # The reference frame: 1920*1080*4 = 8,294,400 B < 8 MiB.
        self.assertLessEqual(1920 * 1080 * 4, tws.DEFAULT_MAX_BYTES)

    def test_4k_rgba_is_refused_with_an_actionable_error(self):
        graph, _parent, _top = _graph_with_script_top()
        with _OpPatch(graph):
            with self.assertRaises(ValueError) as ctx:
                # Geometry alone is over the cap — rejected BEFORE any decode.
                tws.write("/project1/ai_tex", 3840, 2160, "AAAA")
        message = str(ctx.exception)
        self.assertIn("33177600", message.replace(",", ""))
        self.assertIn("cap", message)
        self.assertIn("TDMCP_TOP_WRITE_MAX_BYTES", message)
        self.assertIn("Movie File In TOP", message)

    def test_oversize_frame_never_reaches_the_top(self):
        graph, _parent, top = _graph_with_script_top()
        with _OpPatch(graph):
            with self.assertRaises(ValueError):
                tws.write("/project1/ai_tex", 3840, 2160, "AAAA")
        # Nothing stored, nothing cooked — no silent partial write.
        self.assertEqual(top._storage, {})
        self.assertEqual(top.cooks, 0)

    def test_cap_is_configurable_via_env(self):
        graph, _parent, _top = _graph_with_script_top()
        with _EnvPatch(TDMCP_TOP_WRITE_MAX_BYTES="16"), _OpPatch(graph):
            # 4x4 x 1ch x uint8 = 16 bytes, exactly at the lowered cap.
            report = tws.write("/project1/ai_tex", 4, 4, _b64(16), channels=1)
            self.assertEqual(report["max_bytes"], 16)
            # 8x4 x 1ch = 32 bytes, over it.
            with self.assertRaises(ValueError):
                tws.write("/project1/ai_tex", 8, 4, _b64(32), channels=1)

    def test_oversized_base64_string_is_bounded_before_decoding(self):
        graph, _parent, _top = _graph_with_script_top()
        # Geometry is small, but the wire string is far bigger than the cap allows.
        with _EnvPatch(TDMCP_TOP_WRITE_MAX_BYTES="16"), _OpPatch(graph):
            with self.assertRaises(ValueError) as ctx:
                tws.write("/project1/ai_tex", 2, 2, "A" * 4096, channels=1)
        self.assertIn("wire bound", str(ctx.exception))


# ---------------------------------------------------------------------------
# Bad geometry / bad buffer — loud, never padded or truncated
# ---------------------------------------------------------------------------
class BadGeometryTest(unittest.TestCase):
    def test_buffer_shorter_than_geometry_is_refused(self):
        graph, _parent, top = _graph_with_script_top()
        with _OpPatch(graph):
            with self.assertRaises(ValueError) as ctx:
                tws.write("/project1/ai_tex", 4, 4, _b64(32))  # needs 64
        self.assertIn("32 bytes", str(ctx.exception))
        self.assertIn("exactly 64", str(ctx.exception))
        self.assertIn("will not pad or truncate", str(ctx.exception))
        self.assertEqual(top._storage, {})

    def test_buffer_longer_than_geometry_is_refused(self):
        graph, _parent, _top = _graph_with_script_top()
        with _OpPatch(graph):
            with self.assertRaises(ValueError):
                tws.write("/project1/ai_tex", 2, 2, _b64(64))  # needs 16

    def test_zero_and_negative_dimensions_are_refused(self):
        graph, _parent, _top = _graph_with_script_top()
        with _OpPatch(graph):
            for w, h in ((0, 4), (4, 0), (-1, 4)):
                with self.assertRaises(ValueError):
                    tws.write("/project1/ai_tex", w, h, _b64(16))

    def test_channel_count_outside_1_to_4_is_refused(self):
        graph, _parent, _top = _graph_with_script_top()
        with _OpPatch(graph):
            with self.assertRaises(ValueError) as ctx:
                tws.write("/project1/ai_tex", 2, 2, _b64(20), channels=5)
        self.assertIn("1, 2, 3 or 4", str(ctx.exception))

    def test_unsupported_dtype_is_refused(self):
        graph, _parent, _top = _graph_with_script_top()
        with _OpPatch(graph):
            with self.assertRaises(ValueError) as ctx:
                tws.write("/project1/ai_tex", 2, 2, _b64(32), pixel_format="float64")
        # copyNumpyArray accepts only uint8/uint16/float32.
        self.assertIn("uint8", str(ctx.exception))

    def test_unknown_origin_is_refused(self):
        graph, _parent, _top = _graph_with_script_top()
        with _OpPatch(graph):
            with self.assertRaises(ValueError):
                tws.write("/project1/ai_tex", 2, 2, _b64(16), origin="middle")

    def test_invalid_base64_is_refused(self):
        graph, _parent, _top = _graph_with_script_top()
        with _OpPatch(graph):
            with self.assertRaises(ValueError) as ctx:
                tws.write("/project1/ai_tex", 2, 2, "not base64 !!!")
        self.assertIn("base64", str(ctx.exception))


# ---------------------------------------------------------------------------
# Target resolution
# ---------------------------------------------------------------------------
class TargetResolutionTest(unittest.TestCase):
    def test_missing_node_without_create_raises_lookup(self):
        with _OpPatch({"/project1": FakeParent("/project1")}):
            with self.assertRaises(LookupError):
                tws.write("/project1/nope", 2, 2, _b64(16), create=False)

    def test_missing_parent_raises_lookup(self):
        with _OpPatch({}):
            with self.assertRaises(LookupError):
                tws.write("/project1/x", 2, 2, _b64(16))

    def test_non_script_top_target_is_refused(self):
        with _OpPatch({"/project1/noise1": FakePlainTop("/project1/noise1")}):
            with self.assertRaises(ValueError) as ctx:
                tws.write("/project1/noise1", 2, 2, _b64(16))
        self.assertIn("copyNumpyArray", str(ctx.exception))
        self.assertIn("noiseTOP", str(ctx.exception))

    def test_relative_path_is_refused(self):
        with _OpPatch({}):
            with self.assertRaises(ValueError):
                tws.write("ai_tex", 2, 2, _b64(16))

    def test_artist_owned_callbacks_dat_is_never_clobbered(self):
        graph, parent, top = _graph_with_script_top(callbacks="my_own_callbacks")
        with _OpPatch(graph):
            report = tws.write("/project1/ai_tex", 2, 2, _b64(16))

        # We left the artist's DAT alone and said so, instead of overwriting their code.
        self.assertEqual(top.par.callbacks.val, "my_own_callbacks")
        self.assertEqual(report["callbacks_path"], "my_own_callbacks")
        self.assertIsNone(parent.op("ai_tex_tdmcp_write"))
        self.assertTrue(any("left untouched" in w for w in report["warnings"]))
        # ...but the pixels were still stored, so a correct DAT would pick them up.
        self.assertIn(tws.STORAGE_KEY, top._storage)


# ---------------------------------------------------------------------------
# apply_payload — the onCook side (dtype / shape / flip contract)
# ---------------------------------------------------------------------------
class _FakeArray:
    """Records the reshape/flip chain a real numpy array would go through."""

    def __init__(self, buf, dtype, shape=None, flipped=False):
        self.buf = buf
        self.dtype = dtype
        self.shape = shape
        self.flipped = flipped

    def reshape(self, shape):
        return _FakeArray(self.buf, self.dtype, shape, self.flipped)

    def __getitem__(self, key):
        # Only the `arr[::-1]` row flip is expected.
        assert key == slice(None, None, -1), key
        return _FakeArray(self.buf, self.dtype, self.shape, True)


class _FakeNumpy(types.ModuleType):
    def __init__(self):
        super().__init__("numpy")
        self.calls = []

    def frombuffer(self, buf, dtype):
        self.calls.append(("frombuffer", dtype))
        return _FakeArray(buf, dtype)

    def ascontiguousarray(self, arr):
        self.calls.append(("ascontiguousarray", arr.shape))
        return arr


class _NumpyPatch:
    def __enter__(self):
        self._prev = sys.modules.get("numpy")
        self.fake = _FakeNumpy()
        sys.modules["numpy"] = self.fake
        return self.fake

    def __exit__(self, *exc):
        if self._prev is None:
            sys.modules.pop("numpy", None)
        else:
            sys.modules["numpy"] = self._prev


class ApplyPayloadTest(unittest.TestCase):
    def test_no_pending_buffer_is_a_no_op(self):
        top = FakeScriptTop("/project1/ai_tex", "ai_tex", FakeParent())
        with _NumpyPatch():
            self.assertFalse(tws.apply_payload(top))
        self.assertEqual(top.copied, [])

    def test_copies_with_the_documented_dtype_and_hwc_shape(self):
        parent = FakeParent()
        top = FakeScriptTop("/project1/ai_tex", "ai_tex", parent)
        top.store(
            tws.STORAGE_KEY,
            {"data": b"\x00" * 24, "dtype": "uint8", "width": 2, "height": 3, "channels": 4,
             "flip": False},
        )
        with _NumpyPatch():
            self.assertTrue(tws.apply_payload(top))

        arr = top.copied[0]
        self.assertEqual(arr.dtype, "uint8")
        # copyNumpyArray requires shape (h, w, numComponents) — height FIRST.
        self.assertEqual(arr.shape, (3, 2, 4))
        self.assertFalse(arr.flipped)

    def test_flip_reverses_the_rows_for_a_top_left_buffer(self):
        top = FakeScriptTop("/project1/ai_tex", "ai_tex", FakeParent())
        top.store(
            tws.STORAGE_KEY,
            {"data": b"\x00" * 16, "dtype": "uint8", "width": 2, "height": 2, "channels": 4,
             "flip": True},
        )
        with _NumpyPatch():
            tws.apply_payload(top)
        self.assertTrue(top.copied[0].flipped)

    def test_fetch_does_not_search_parent_storage(self):
        # A parent COMP's unrelated `tdmcp_pixels` entry must not bleed into a TOP.
        seen = {}
        top = FakeScriptTop("/project1/ai_tex", "ai_tex", FakeParent())

        def fetch(key, default=None, search=True):
            seen["search"] = search
            return default

        top.fetch = fetch
        with _NumpyPatch():
            self.assertFalse(tws.apply_payload(top))
        self.assertFalse(seen["search"])


class ApplyPayloadRealNumpyTest(unittest.TestCase):
    """End-to-end shape/dtype check against the real numpy, when it is installed."""

    def test_real_numpy_roundtrip(self):
        try:
            import numpy
        except ImportError:  # pragma: no cover - numpy is not in the offline CI image
            self.skipTest("numpy is not installed")

        top = FakeScriptTop("/project1/ai_tex", "ai_tex", FakeParent())
        # Two rows of 2 RGBA pixels: row0 all 1s, row1 all 2s.
        data = bytes([1] * 8 + [2] * 8)
        top.store(
            tws.STORAGE_KEY,
            {"data": data, "dtype": "uint8", "width": 2, "height": 2, "channels": 4,
             "flip": True},
        )
        self.assertTrue(tws.apply_payload(top))

        arr = top.copied[0]
        self.assertEqual(arr.shape, (2, 2, 4))
        self.assertEqual(arr.dtype, numpy.uint8)
        # flip=True reversed the rows, so the former row1 (2s) is now row0.
        self.assertTrue((arr[0] == 2).all())
        self.assertTrue((arr[1] == 1).all())


# ---------------------------------------------------------------------------
# Exec-fallback parity — the older-bridge path must do what the endpoint does
# ---------------------------------------------------------------------------
class ExecFallbackParityTest(unittest.TestCase):
    """Lock the pixel-format map against the TS exec-fallback script.

    The fallback in ``src/td-client/touchDesignerClient.ts`` re-implements this
    service's write for an older bridge that has no ``/api/top/write`` route. It once
    set the resolution but NOT the pixel format, so a uint16/float32 push was silently
    quantized to 8-bit on that path only. The two maps must agree — in particular after
    the UNVERIFIED-live probe (L8) replaces these guessed menu names with the real ones.
    """

    _CLIENT_TS = os.path.abspath(
        os.path.join(_HERE, "..", "..", "src", "td-client", "touchDesignerClient.ts")
    )

    def _exec_script(self):
        with open(self._CLIENT_TS, "r", encoding="utf-8") as handle:
            source = handle.read()
        marker = "const TOP_WRITE_EXEC_SCRIPT = `"
        start = source.index(marker) + len(marker)
        return source[start : source.index("`;", start)]

    def test_the_fallback_script_mirrors_every_pixel_format(self):
        script = self._exec_script()
        for dtype, menu_value in tws._PIXEL_FORMATS.items():
            # Both halves of the mapping must survive into the fallback, or that path
            # quantizes the push with no warning.
            self.assertIn('"%s": "%s"' % (dtype, menu_value), script)
        self.assertIn("par.format", script)

    def test_the_fallback_script_takes_caller_data_only_as_base64(self):
        script = self._exec_script()
        # Injection safety: no JS interpolation point. Caller data enters exclusively
        # through these two base64 substitutions.
        self.assertNotIn("${", script)
        self.assertIn("__META_B64__", script)
        self.assertIn("__PIXELS_B64__", script)


if __name__ == "__main__":
    unittest.main()
