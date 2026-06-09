"""GET /api/logs — read the bridge Error DAT's structured cook errors/warnings.

Survives TDMCP_BRIDGE_ALLOW_EXEC=0 (it is a read endpoint, not exec). Reads the
bridge's Error DAT rows instead of char-iterating `op.errors()` (which returns a
STRING, not a list — the legacy walk's latent bug).

Error DAT columns (confirmed live): source | message | absframe | frame |
severity | type. We map columns BY HEADER NAME (row 0), not by fixed index, so a
future column reorder can't silently misalign the data (§7-R6). Falls back to
{available: False, ...} when the Error DAT is missing (older bridge) so the
client can use the legacy op-walk.

Pure module of top-level functions. `op` is bound from `td` at import time
(mirroring api_service.py) so the module imports cleanly off-TD and the test
harness can patch `op` per-test.
"""

import td

op = td.op

# Canonical column names we surface, in their confirmed live order. Used as a
# fallback when a header row is absent or unrecognized.
_EXPECTED_COLUMNS = ("source", "message", "absframe", "frame", "severity", "type")
_INT_COLUMNS = ("absframe", "frame")


def _cell(dat, row, col):
    """Read dat[row, col] as a plain string, tolerating Cell wrappers."""
    try:
        return str(dat[row, col])
    except Exception:  # noqa: BLE001
        return ""


def _header_map(dat):
    """Map column NAME -> column index from row 0.

    Falls back to the expected fixed order if a header cell is blank or the row
    is unreadable. Keying by name (not [0..5]) is cheap insurance against a
    column reorder (§7-R6).
    """
    mapping = {}
    num_cols = int(getattr(dat, "numCols", 0) or 0)
    for col in range(num_cols):
        name = _cell(dat, 0, col).strip().lower()
        if name:
            mapping[name] = col
    # If the header was missing/garbled, fall back to positional expectations so
    # we still return useful rows.
    if not mapping:
        for idx, name in enumerate(_EXPECTED_COLUMNS):
            if idx < num_cols:
                mapping[name] = idx
    return mapping


def _entry_from_row(dat, row, header):
    entry = {}
    for name, col in header.items():
        if name not in _EXPECTED_COLUMNS:
            continue
        raw = _cell(dat, row, col)
        if name in _INT_COLUMNS:
            try:
                entry[name] = int(raw)
            except Exception:  # noqa: BLE001
                pass  # leave it out rather than emit a bogus int
        else:
            entry[name] = raw
    return entry


def _matches_filters(entry, severity, scope_prefix):
    if severity in ("error", "warning"):
        if str(entry.get("severity", "")).strip().lower() != severity:
            return False
    if scope_prefix:
        src = str(entry.get("source", ""))
        if not (src == scope_prefix or src.startswith(scope_prefix + "/")):
            return False
    return True


def _capped_lines(lines, max_lines):
    try:
        cap = int(max_lines)
    except Exception:  # noqa: BLE001
        cap = 200
    if cap > 0 and len(lines) > cap:
        return lines[-cap:], "Truncated to %d of %d matching rows (newest kept)." % (
            cap,
            len(lines),
        )
    return lines, None


def get_logs(
    severity="all",
    max_lines=200,
    scope=None,
    error_dat_path="/project1/tdmcp_bridge/error_log",
):
    """Read the bridge Error DAT's rows.

    Returns {lines, count, error_dat, available, warnings}. `scope` filters by a
    `source` path prefix when provided (the Error DAT's own `fromop` already
    bounds capture; this is an extra client-side narrowing). Severity is one of
    all|error|warning. Newest rows are near the bottom, so we keep the LAST
    max_lines after filtering.
    """
    report = {
        "lines": [],
        "count": 0,
        "error_dat": error_dat_path,
        "available": True,
        "warnings": [],
    }
    dat = op(error_dat_path)  # noqa: F821 - TD global
    if dat is None:
        report["available"] = False
        report["warnings"].append(
            "Error DAT not found at %s; reinstall the bridge to enable structured "
            "logs (falling back to the op-walk)." % error_dat_path
        )
        return report

    num_rows = int(getattr(dat, "numRows", 0) or 0)
    if num_rows <= 1:
        # Header only (or empty) — no captured rows yet.
        return report

    header = _header_map(dat)
    want_sev = str(severity or "all").strip().lower()
    scope_prefix = str(scope).rstrip("/") if scope else None

    lines = []
    # Skip row 0 (header); iterate data rows in append order (newest near bottom).
    for row in range(1, num_rows):
        entry = _entry_from_row(dat, row, header)
        if not _matches_filters(entry, want_sev, scope_prefix):
            continue
        lines.append(entry)

    # Keep the newest N (rows are append-order, newest last).
    lines, warning = _capped_lines(lines, max_lines)
    if warning:
        report["warnings"].append(warning)

    report["lines"] = lines
    report["count"] = len(lines)
    return report
