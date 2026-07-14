"""POST /api/top/write — push raw pixel bytes straight into a Script TOP.

No file on disk. The Node server hands the bridge a base64 pixel buffer plus its
geometry; the bridge stores the buffer on the target Script TOP and force-cooks
it, and the TOP's managed callbacks DAT copies it into the texture with
``scriptTOP.copyNumpyArray()``.

Contract verified against Derivative's official docs
(https://docs.derivative.ca/ScriptTOP_Class)::

    copyNumpyArray(numpyArray, is3D=False, isCube=False) -> None
    "Copies the contents of the numpyArary into the TOPs texture."
    "The data type must be uint8, uint16 or float32."
    "Must be shape(h, w, numComponents) for a 2D texture ...
     Where numComponents is 1, 2, 3, or 4."

Row order: TouchDesigner is bottom-left origin (see docs.derivative.ca/OpenCV:
"OpenCV's coordinate system has its origin at top/left, while TouchDesigner is
bottom/left based"), while a decoded PNG/JPEG buffer is top-left origin. So the
caller declares its ``origin`` and we flip the rows for ``top_left`` (the
default). The flip is explicit and reported — never silent.

NOT exec-gated: this is a typed endpoint and MUST keep working under
``TDMCP_BRIDGE_ALLOW_EXEC=0``. It is not a new arbitrary-code path — the only
caller-controlled data is a geometry tuple and an opaque pixel buffer. The
callbacks DAT text is the module constant below; no request field is ever
interpolated into it.

Size policy: an oversized frame is REFUSED with an actionable error. The bridge
never downscales and never truncates. Chunked/streamed uploads are explicitly out
of scope for this endpoint.

Pure functions; TD globals are reached via ``import td`` INSIDE the entry points
so the module imports cleanly off-TD (mirrors ``connect_service``/``save_service``).
"""

import base64
import os

# Bytes per sample for each dtype scriptTOP.copyNumpyArray accepts.
_DTYPE_ITEMSIZE = {"uint8": 1, "uint16": 2, "float32": 4}

_ORIGINS = ("top_left", "bottom_left")

# Max DECODED pixel bytes per request (override with TDMCP_TOP_WRITE_MAX_BYTES).
# 8 MiB is chosen so one 1080p RGBA uint8 frame (1920*1080*4 = 8,294,400 B) fits,
# while a 4K RGBA frame (33,177,600 B) is refused rather than silently downscaled.
DEFAULT_MAX_BYTES = 8 * 1024 * 1024

# Where the pending buffer lives on the target TOP. Op storage (not a module-level
# dict) so the SAME transport works on a current bridge and on the /api/exec
# fallback path an older bridge takes, and so a re-cook (resolution change, project
# re-cook) re-applies the pixels without a fresh POST.
STORAGE_KEY = "tdmcp_pixels"

_CALLBACKS_SUFFIX = "_tdmcp_write"

# The managed callbacks DAT. A thin shim: all the logic lives in `apply_payload`
# below so it is unit-testable off-TD. The bridge rewrites this DAT on every write,
# so a network created by the older exec fallback self-heals once the bridge is
# updated.
CALLBACKS_TEXT = '''# tdmcp bridge — Script TOP pixel writer (POST /api/top/write).
# Managed by the tdmcp bridge: it rewrites this DAT on every write. The pixel
# buffer lives in this TOP's storage; the service copies it into the texture.
def onSetupParameters(scriptOp):
    return


def onCook(scriptOp):
    from mcp.services import top_write_service

    top_write_service.apply_payload(scriptOp)
    return
'''

# TOP pixel-format menu value per dtype, so a 16-bit/float push is not quantized
# down to the Script TOP's default 8-bit fixed texture.
_PIXEL_FORMATS = {"uint16": "rgba16fixed", "float32": "rgba32float"}


def _max_bytes():
    raw = os.environ.get("TDMCP_TOP_WRITE_MAX_BYTES")
    if raw is None:
        return DEFAULT_MAX_BYTES
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_MAX_BYTES
    return value if value > 0 else DEFAULT_MAX_BYTES


def _positive_int(value, field):
    if isinstance(value, bool):  # bool is an int subclass; never a valid dimension
        raise ValueError("Field '%s' must be an integer (got %r)." % (field, value))
    try:
        out = int(value)
    except (TypeError, ValueError):
        raise ValueError("Field '%s' must be an integer (got %r)." % (field, value)) from None
    if out <= 0:
        raise ValueError("Field '%s' must be greater than 0 (got %d)." % (field, out))
    return out


def _resolve_format(pixel_format):
    fmt = str(pixel_format or "uint8").strip().lower()
    itemsize = _DTYPE_ITEMSIZE.get(fmt)
    if itemsize is None:
        raise ValueError(
            "Field 'format' must be one of %s — scriptTOP.copyNumpyArray accepts no other "
            "dtype; got %r." % (", ".join(sorted(_DTYPE_ITEMSIZE)), pixel_format)
        )
    return fmt, itemsize


def _check_cap(width, height, channels, fmt, expected):
    cap = _max_bytes()
    if expected <= cap:
        return
    raise ValueError(
        "Payload too large: %dx%d x %d channels x %s = %d bytes, over the %d-byte cap. "
        "The bridge refuses it rather than downscaling or truncating your image. Chunked "
        "uploads are out of scope for /api/top/write — push a smaller frame, raise "
        "TDMCP_TOP_WRITE_MAX_BYTES in TouchDesigner's environment, or deliver the image as "
        "a file through a Movie File In TOP."
        % (width, height, channels, fmt, expected, cap)
    )


def _validate_geometry(width, height, channels, pixel_format):
    """Return ``(w, h, channels, format, expected_bytes)`` or raise ValueError."""
    w = _positive_int(width, "width")
    h = _positive_int(height, "height")
    c = _positive_int(channels, "channels")
    if c > 4:
        raise ValueError(
            "Field 'channels' must be 1, 2, 3 or 4 — scriptTOP.copyNumpyArray takes "
            "shape (h, w, numComponents) with numComponents 1-4; got %d." % c
        )
    fmt, itemsize = _resolve_format(pixel_format)
    expected = w * h * c * itemsize
    _check_cap(w, h, c, fmt, expected)
    return w, h, c, fmt, expected


def _validate_origin(origin):
    key = str(origin or "top_left").strip().lower()
    if key not in _ORIGINS:
        raise ValueError(
            "Field 'origin' must be one of %s; got %r." % (", ".join(_ORIGINS), origin)
        )
    return key


def _decode_pixels(pixels_b64, expected_bytes):
    """Base64-decode the buffer and assert it EXACTLY matches the declared geometry."""
    if not isinstance(pixels_b64, str) or not pixels_b64:
        raise ValueError("Field 'pixels_b64' must be a base64-encoded pixel buffer.")
    # Bound the wire string BEFORE decoding, so an oversized payload is never decoded
    # into a pixel buffer (base64 is 4 chars per 3 bytes, plus padding). Note what this
    # does NOT do: the JSON body has already been received and json.loads-ed by
    # api_controller.handle() before any route runs, and the bridge has no pre-parse
    # body-size limit. This cap governs the DECODE, not the reception.
    limit = 4 * ((_max_bytes() + 2) // 3) + 8
    if len(pixels_b64) > limit:
        raise ValueError(
            "Field 'pixels_b64' is %d base64 characters, over the %d-character wire bound "
            "implied by the %d-byte payload cap." % (len(pixels_b64), limit, _max_bytes())
        )
    try:
        data = base64.b64decode(pixels_b64, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("Field 'pixels_b64' is not valid base64: %s" % exc) from exc
    if len(data) != expected_bytes:
        raise ValueError(
            "Pixel buffer is %d bytes but the declared geometry needs exactly %d. The "
            "bridge will not pad or truncate — fix the geometry or the buffer."
            % (len(data), expected_bytes)
        )
    return data


def _split_path(path):
    clean = str(path or "").strip()
    if not clean.startswith("/") or clean == "/":
        raise ValueError("Field 'path' must be an absolute operator path; got %r." % path)
    parent, _, name = clean.rpartition("/")
    if not name:
        raise ValueError("Field 'path' must end in an operator name; got %r." % path)
    return (parent or "/"), name


def _require_script_top(node, path):
    # Capability check, not a type-name check: copyNumpyArray is what makes a TOP a
    # valid pixel target, and it is the Script TOP's defining method.
    if not hasattr(node, "copyNumpyArray"):
        raise ValueError(
            "top/write: %s is a %s, which cannot receive pixels — the target must be a "
            "Script TOP (the only operator exposing copyNumpyArray). Choose another path "
            "or delete that node."
            % (path, getattr(node, "type", "?"))
        )


def _resolve_target(op, path, create):
    """Return ``(script_top, created)``; create the Script TOP when asked and absent."""
    node = op(path)
    if node is not None:
        _require_script_top(node, path)
        return node, False
    if not create:
        raise LookupError(
            "top/write: node not found: %s (pass create=true to have the bridge make the "
            "Script TOP)." % path
        )
    parent_path, name = _split_path(path)
    parent = op(parent_path)
    if parent is None:
        raise LookupError("top/write: parent not found: %s" % parent_path)
    return parent.create("scriptTOP", name), True


def _upsert_callbacks_dat(node, name):
    parent = node.parent()
    dat = parent.op(name)
    if dat is None:
        dat = parent.create("textDAT", name)
    dat.text = CALLBACKS_TEXT
    return dat


def _ensure_callbacks(node, warnings):
    """(Re)write the managed callbacks DAT and point the Script TOP at it.

    Never clobbers an artist's own callbacks DAT: when ``callbacks`` already names a
    DAT the bridge does not manage, it is left alone and the caller is warned.
    """
    par = getattr(node.par, "callbacks", None)
    if par is None:
        warnings.append(
            "Script TOP %s exposes no 'callbacks' parameter on this TD build; the pixel "
            "buffer was stored but nothing will copy it into the texture." % node.path
        )
        return None
    managed = node.name + _CALLBACKS_SUFFIX
    current = str(par.eval() or "").strip()
    if current and current != managed:
        warnings.append(
            "Script TOP %s already uses callbacks DAT %r, which tdmcp does not manage — "
            "left untouched. Its onCook must call "
            "mcp.services.top_write_service.apply_payload(scriptOp) for the pushed pixels "
            "to appear." % (node.path, current)
        )
        return current
    dat = _upsert_callbacks_dat(node, managed)
    par.val = managed
    return dat.path


def _apply_resolution(node, width, height, warnings):
    """Match the Script TOP's output resolution to the pushed frame (fail-forward)."""
    try:
        node.par.outputresolution = "custom"
        node.par.resolutionw = width
        node.par.resolutionh = height
    except Exception as exc:  # noqa: BLE001
        warnings.append(
            "Could not set %s resolution to %dx%d: %s" % (node.path, width, height, exc)
        )


def _apply_pixel_format(node, fmt, warnings):
    """Widen the texture format for a 16-bit/float push (fail-forward)."""
    value = _PIXEL_FORMATS.get(fmt)
    if value is None:
        return  # uint8: the Script TOP's default 8-bit fixed texture already matches
    try:
        node.par.format = value
    except Exception as exc:  # noqa: BLE001
        warnings.append(
            "Could not set %s pixel format to %r for a %s buffer: %s. The texture may be "
            "quantized to 8-bit." % (node.path, value, fmt, exc)
        )


def _cook(node, warnings):
    try:
        node.cook(force=True)
        return True
    except Exception as exc:  # noqa: BLE001
        warnings.append("Could not force-cook %s: %s" % (node.path, exc))
        return False


def write(
    path,
    width,
    height,
    pixels_b64,
    channels=4,
    pixel_format="uint8",
    origin="top_left",
    create=True,
):
    """Push a raw pixel buffer into the Script TOP at ``path``.

    Validation is strict and loud: bad geometry, an unsupported dtype, a buffer whose
    length disagrees with the geometry, or a frame over the cap all raise ValueError
    (-> HTTP 400). Nothing is ever padded, truncated or downscaled.

    Wiring problems (resolution/format parameters, an artist-owned callbacks DAT, a
    failed force-cook) are fail-forward: collected as ``warnings`` so a partial write
    still reports what happened.
    """
    import td

    op = td.op

    w, h, c, fmt, expected = _validate_geometry(width, height, channels, pixel_format)
    origin_key = _validate_origin(origin)
    data = _decode_pixels(pixels_b64, expected)

    node, created = _resolve_target(op, path, bool(create))
    warnings = []

    payload = {
        "data": data,
        "dtype": fmt,
        "width": w,
        "height": h,
        "channels": c,
        # TD samples textures bottom-left-first; a decoded image buffer is top-left-first.
        "flip": origin_key == "top_left",
    }
    node.store(STORAGE_KEY, payload)

    _apply_resolution(node, w, h, warnings)
    _apply_pixel_format(node, fmt, warnings)
    callbacks_path = _ensure_callbacks(node, warnings)
    cooked = _cook(node, warnings)

    return {
        "path": node.path,
        "width": w,
        "height": h,
        "channels": c,
        "format": fmt,
        "bytes": len(data),
        "origin": origin_key,
        "flip": payload["flip"],
        "created": created,
        "callbacks_path": callbacks_path,
        "storage_key": STORAGE_KEY,
        "cooked": cooked,
        "max_bytes": _max_bytes(),
        "warnings": warnings,
    }


def apply_payload(script_op):
    """Copy the stored pixel buffer into ``script_op``'s texture. Called from onCook.

    Returns True when pixels were copied, False when the TOP has no pending buffer (a
    freshly created Script TOP cooks once before the first write lands, and an artist
    may leave the DAT in place after clearing storage).

    ``search=False`` keeps the lookup on THIS operator — the default parent search
    would let a sibling TOP inherit a parent COMP's unrelated ``tdmcp_pixels`` entry.
    """
    payload = script_op.fetch(STORAGE_KEY, None, search=False)
    if not payload:
        return False

    import numpy

    arr = numpy.frombuffer(payload["data"], dtype=payload["dtype"])
    arr = arr.reshape((payload["height"], payload["width"], payload["channels"]))
    if payload.get("flip"):
        arr = arr[::-1]
    script_op.copyNumpyArray(numpy.ascontiguousarray(arr))
    return True
