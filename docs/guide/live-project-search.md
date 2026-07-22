---
description: "Bounded, compact search across live TouchDesigner operators and parameters without transferring the whole network or enabling raw Python."
---

# Live project search

<FeatureAvailability status="source-only" locale="en" />

tdmcp can search the running TouchDesigner project at the bridge instead of
downloading a recursive topology and filtering it in the MCP process. The two
read-only tools are authenticated structured routes and continue working with
`TDMCP_BRIDGE_ALLOW_EXEC=0`.

## Find operators

`find_td_nodes` keeps its established `parent_path`, `pattern`, `type`,
`recursive`, `path_only`, and `limit` inputs. Current bridges execute the search
with `GET /api/nodes/search` and return compact `{ path, name, type, family }`
hits. You can also provide:

- `name_glob` and `path_glob` for anchored, case-insensitive `*` globs;
- `type_match: "partial" | "exact"` and an operator `family`;
- `max_depth`, `node_scan_limit`, and `time_limit_ms`.

The default recursive depth is bounded at 32, results at 50, returned results at
200 maximum, scanned operators at 5,000 by default/10,000 maximum, and bridge
work at 500 ms by default/2,000 ms maximum. Results are globally ordered by
absolute UTF-8 path before the result limit is applied.

Ordinary calls remain source-compatible. The safety migration is that
`limit > 200`, overlength filters, and trees beyond the depth/scan budget now
reject or report an incomplete scan instead of producing an unbounded payload.
The tool can use the previous structured topology route only when an older
bridge genuinely lacks `/api/nodes/search`; it never requires `/api/exec`.

## Find live parameters

`find_td_parameters` searches point-in-time parameter state with
`POST /api/params/search`. Filters stay in the request body and may combine:

- node name/path/pattern, exact or partial operator type, and family;
- `parameter_glob`, evaluated `value_glob`, or `expression_glob`;
- mode: `CONSTANT`, `EXPRESSION`, `EXPORT`, `BIND`, or `UNKNOWN`;
- `non_default_only`, based on TouchDesigner's `Par.isDefault`.

The default depth is 3, returned-result limit 100, node scan limit 1,000,
parameter scan limit 25,000, and time budget 1,000 ms. Hard maxima are 32, 200,
10,000, 100,000, and 2,500 ms respectively. Hits are ordered by operator path,
then parameter name.

Likely credentials are redacted when a name resembles a password, secret,
token, API key, authorization value, bearer, credential, or private key, or
when TouchDesigner marks the parameter as a password. They return
`"[REDACTED]"`; sensitive values and expressions cannot satisfy content filters,
so a query cannot be used as a value-guessing oracle. One unreadable parameter
is skipped and counted without exposing exception text or failing the full scan.

This tool requires the current structured bridge. An older bridge returns typed
update/reinstall guidance; there is deliberately no raw-Python or full-parameter-
dump fallback.

## Read completion metadata

Do not claim “all matches” from `matched` alone. Check:

- `truncated`: more matches existed in the scanned portion than were returned;
- `scan_truncated`: node, parameter, or time work stopped early;
- `count_complete`: false whenever the total is only a lower bound;
- `stop_reason`: `completed`, `node_scan_limit`, `parameter_scan_limit`, or
  `time_limit`.

## Honest result examples

**PASS — bounded search completed**

```json
{
  "matched": 1,
  "returned": 1,
  "truncated": false,
  "scan_truncated": false,
  "count_complete": true,
  "stop_reason": "completed"
}
```

**FAIL — invalid safety bound**

```json
{
  "ok": false,
  "error": {
    "code": "invalid_input",
    "message": "limit must be between 1 and 200."
  }
}
```

**UNVERIFIED — a different TD build**

```json
{
  "status": "UNVERIFIED",
  "reason": "Parameter mode/readback behavior has not been probed on this TouchDesigner build."
}
```

The implementation was live-validated on TD 099 build 2025.32820 through an
authenticated bridge on a disposable project: auth rejection, exec-disabled
operation, depth, type/family, value/expression/mode/non-default filters,
redaction, unreadable parameters, deterministic ordering, limits, typed invalid
inputs, and no undo-stack change all passed. Treat other builds honestly until
they receive the same probe.
