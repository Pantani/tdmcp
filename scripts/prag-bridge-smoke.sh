#!/usr/bin/env bash
#
# prag-bridge-smoke.sh — Slice C live-validation smoke for the Project RAG
# quarantine bridge on :9981.
#
# Prereq: a SEPARATE TouchDesigner instance running the tdmcp bridge bound to
# 127.0.0.1:9981 (NEVER 9980). See:
#   _workspace/campaign_project_rag/wave_C_live_validation_runbook.md
#
# Usage:
#   scripts/prag-bridge-smoke.sh /absolute/path/to/sample.toe
#
# Exits non-zero on the first failure so it is CI/manual-gate friendly.

set -euo pipefail

SAMPLE="${1:-}"
PORT="${TDMCP_PROJECT_RAG_BRIDGE_PORT:-9981}"
HOST="${TDMCP_TD_HOST:-127.0.0.1}"
TDMCP="${TDMCP_BIN:-npx tdmcp}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -n "$SAMPLE" ] || fail "missing argument: absolute path to a .toe/.tox"
case "$SAMPLE" in
  /*) : ;;
  *) fail "path must be ABSOLUTE: $SAMPLE" ;;
esac
[ -f "$SAMPLE" ] || fail "file not found: $SAMPLE"
case "$SAMPLE" in
  *.toe|*.tox) : ;;
  *) fail "path must be a .toe or .tox: $SAMPLE" ;;
esac

[ "$PORT" != "9980" ] || fail "refusing to use port 9980 (the live bridge). Use 9981."

echo "== 0. Probe quarantine bridge http://${HOST}:${PORT}/api/info =="
# The bridge router only serves paths under /api — a bare "/" returns an error,
# so probe /api/info for reachability.
curl -fsS "http://${HOST}:${PORT}/api/info" >/dev/null \
  || fail "quarantine bridge is OFFLINE at http://${HOST}:${PORT} — start the :9981 TD first"
echo "   bridge UP"

# Project RAG must be enabled for the CLI to do anything.
export TDMCP_RAG_ENABLED="${TDMCP_RAG_ENABLED:-1}"
export TDMCP_PROJECT_RAG_ENABLED="${TDMCP_PROJECT_RAG_ENABLED:-1}"
export TDMCP_PROJECT_RAG_BRIDGE_PORT="$PORT"

echo "== 1. analyze one artifact via POST /api/project/load + F3 analyzer =="
$TDMCP project-rag analyze "$SAMPLE" \
  || fail "analyze exited non-zero"
echo "   analyze OK — verify the printed envelope has node_count > 0 and an errors[] list (not 'bridge offline')"

echo "== 2. sync then run the quarantine analyzer over synced cards =="
$TDMCP project-rag sync --bridge \
  || fail "sync --bridge exited non-zero"
echo "   sync --bridge OK — verify cards flipped analysisStatus to 'analyzed' (not 'skipped'/offline)"

echo
echo "PASS: smoke completed. Capture the raw output above into"
echo "      _workspace/campaign_project_rag/wave_C_live_evidence.txt and fold the ledger."
