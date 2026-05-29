"""First-class connect/disconnect — survives TDMCP_BRIDGE_ALLOW_EXEC=0.

Pure functions; reach TD globals via ``import td`` INSIDE each function so the
module imports cleanly off-TD (mirrors ``mcp/services/api_service.py``). Raise
``ValueError``/``LookupError``/``IndexError`` on hard failure; the router turns
them into the standard 400 ``{ok:false,error:{message}}`` envelope.

Connector model (probed live on TD 2025.32820):
  - ``op.inputConnectors`` / ``op.outputConnectors`` are indexed lists of
    ``Connector`` objects; an unwired ``noiseTOP`` still exposes its slots.
  - ``inputConnector.connect(outputConnector | op)`` makes the wire.
  - ``inputConnector.connections`` lists the upstream OUTPUT connectors; each
    exposes ``.owner`` (the source op) and ``.index`` (the source output index).
  - Multi-input TOPs PACK their inputs contiguously: wiring into a non-trailing
    slot, or removing a middle wire, renumbers the rest. So ``connect`` reports
    the ``actual_input`` it lands on (re-scanned after the wire), and
    ``disconnect`` prefers by-source-path filtering over a fixed index.

This module is intentionally flat and self-contained: the integrator drops it in
as ``mcp/services/connect_service.py`` unchanged.
"""


def _resolve(op, path):
    node = op(path)
    if node is None:
        raise LookupError(path)
    return node


def _same_parent(src, dst):
    src_parent = src.parent()
    dst_parent = dst.parent()
    if src_parent is None or dst_parent is None:
        return False
    return src_parent.path == dst_parent.path


def _src_owner(connection):
    """The source op behind an upstream output connector.

    ``.owner`` is the probed attribute; ``.op`` is a harmless legacy fallback.
    """
    owner = getattr(connection, "owner", None)
    if owner is not None:
        return owner
    return getattr(connection, "op", None)


def connect(source_path, target_path, source_output=0, target_input=0):
    """Wire ``source.outputConnectors[source_output]`` ->
    ``target.inputConnectors[target_input]``.

    Returns the §3.2 dict including the live ``actual_input`` slot (which may
    differ from ``requested_input`` because multi-input TOPs pack). Raises on
    not-found / cross-container / connector-index-out-of-range.
    """
    import td

    op = td.op

    source_output = int(source_output)
    target_input = int(target_input)

    src = op(source_path)
    dst = op(target_path)
    if src is None or dst is None:
        raise LookupError(
            "connect: source or target not found (%s -> %s)" % (source_path, target_path)
        )

    # TD wires only connect operators sharing a parent. A cross-container connect
    # silently no-ops (no exception, no wire), so reject it with an actionable msg.
    if not _same_parent(src, dst):
        raise ValueError(
            "connect: cannot wire across containers (%s -> %s); use a Select/In OP"
            % (source_path, target_path)
        )

    in_connectors = dst.inputConnectors
    out_connectors = src.outputConnectors
    if target_input < 0 or target_input >= len(in_connectors):
        raise IndexError(
            "connect: target_input %d out of range (%d input connectors on %s)"
            % (target_input, len(in_connectors), target_path)
        )
    if source_output < 0 or source_output >= len(out_connectors):
        raise IndexError(
            "connect: source_output %d out of range (%d output connectors on %s)"
            % (source_output, len(out_connectors), source_path)
        )

    out_conn = out_connectors[source_output]
    in_connectors[target_input].connect(out_conn)

    # Re-scan: multi-input TOPs pack contiguously, so the wire may have landed on
    # a slot other than the one requested. Report what TD actually did.
    actual_input = target_input
    for ic in dst.inputConnectors:
        landed = False
        for oc in ic.connections:
            owner = _src_owner(oc)
            if owner is not None and owner.path == src.path and oc.index == source_output:
                actual_input = ic.index
                landed = True
                break
        if landed:
            break

    return {
        "source_path": src.path,
        "target_path": dst.path,
        "requested_input": target_input,
        "actual_input": actual_input,
        "source_output": source_output,
        "connected": True,
    }


def disconnect(to_path, from_path=None, to_input=None):
    """Remove input wire(s) into ``to_path``.

    ``from_path`` ``None`` removes every wire into ``to_path`` (scoped by
    ``to_input`` if given). Fail-forward: per-wire problems are collected as
    ``warnings`` rather than raised; only a missing ``to_path`` is fatal.
    Returns the §3.2 dict ``{to_path, from_path, to_input, removed, warnings}``.
    """
    import td

    op = td.op

    if to_input is not None:
        to_input = int(to_input)

    to = op(to_path)
    if to is None:
        raise LookupError("disconnect: node not found: %s" % to_path)

    removed = []
    warnings = []

    for connector in to.inputConnectors:
        index = connector.index
        if to_input is not None and index != to_input:
            continue
        try:
            connections = list(connector.connections)
        except Exception as exc:  # noqa: BLE001
            warnings.append("inputConnectors[%d].connections error: %s" % (index, exc))
            continue
        for connection in connections:
            src_op = _src_owner(connection)
            if src_op is None:
                warnings.append("Could not resolve upstream op for inputConnectors[%d]" % index)
                continue
            if from_path is not None and src_op.path != from_path:
                continue
            # Prefer the single-wire connection.disconnect(); fall back to clearing
            # the whole input slot.
            disconnected = False
            try:
                connection.disconnect()
                disconnected = True
            except Exception as exc1:  # noqa: BLE001
                try:
                    connector.disconnect()
                    disconnected = True
                except Exception as exc2:  # noqa: BLE001
                    warnings.append(
                        "disconnect failed for inputConnectors[%d] from %s: "
                        "connection.disconnect -> %s; connector.disconnect -> %s"
                        % (index, src_op.path, exc1, exc2)
                    )
            if disconnected:
                removed.append({"input": index, "from": src_op.path})

    return {
        "to_path": to.path,
        "from_path": from_path,
        "to_input": to_input,
        "removed": removed,
        "warnings": warnings,
    }
