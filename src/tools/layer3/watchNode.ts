import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, structuredResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const watchNodeSchema = z.object({
  path: z.string().describe("Full path of the operator to sample."),
  samples: z.number().int().min(1).max(240).default(3).describe("How many snapshots to collect."),
  interval_ms: z
    .number()
    .int()
    .min(16)
    .max(2000)
    .default(100)
    .describe("Delay between snapshots in milliseconds."),
  parameter_keys: z
    .array(z.string())
    .optional()
    .describe("Optional parameter-name allowlist. Omit to sample all readable parameters."),
  channel_keys: z
    .array(z.string())
    .optional()
    .describe(
      "Optional channel-name allowlist for CHOP-like operators. Omit to sample all channels.",
    ),
});
type WatchNodeArgs = z.infer<typeof watchNodeSchema>;

const sampleStateSchema = z.record(z.string(), z.unknown());
const watchSnapshotSchema = z.object({
  sample_index: z.number().int(),
  elapsed_ms: z.number(),
  path: z.string(),
  type: z.string(),
  family: z.string().optional(),
  state: sampleStateSchema,
  parameters: z.record(z.string(), z.unknown()),
  channels: z.record(z.string(), z.number()),
  warnings: z.array(z.string()),
});

export const watchNodeOutputSchema = z.object({
  path: z.string(),
  requested_samples: z.number().int(),
  collected_samples: z.number().int(),
  interval_ms: z.number().int(),
  window_ms: z.number(),
  warnings: z.array(z.string()),
  snapshots: z.array(watchSnapshotSchema),
});

interface WatchNodeProbeReport {
  path?: string;
  type?: string;
  family?: string;
  state?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  channels?: Record<string, number>;
  warnings?: string[];
  fatal?: string;
}

interface WatchNodeSnapshot {
  sample_index: number;
  elapsed_ms: number;
  path: string;
  type: string;
  family?: string;
  state: Record<string, unknown>;
  parameters: Record<string, unknown>;
  channels: Record<string, number>;
  warnings: string[];
}

const WATCH_NODE_SCRIPT = `
import json, base64, traceback
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
_param_keys = set(_p.get("parameter_keys") or [])
_channel_keys = set(_p.get("channel_keys") or [])
report = {
    "path": _p["path"],
    "type": "",
    "warnings": [],
    "state": {"errors": []},
    "parameters": {},
    "channels": {},
}

def _jsonable(_value):
    try:
        json.dumps(_value)
        return _value
    except Exception:
        return str(_value)

try:
    _o = op(_p["path"])
    if _o is None:
        report["fatal"] = "Operator not found: " + str(_p["path"])
    else:
        try:
            report["type"] = str(_o.type)
        except Exception as _e:
            report["warnings"].append("type unavailable: " + str(_e))
        try:
            report["family"] = str(_o.family)
        except Exception:
            pass

        for _attr, _key, _cast in (
            ("cookTime", "cook_time_ms", float),
            ("totalCooks", "cook_count", int),
            ("cookCount", "cook_count", int),
            ("cookAbsFrame", "last_cook_frame", int),
            ("numChans", "num_chans", int),
            ("numSamples", "num_samples", int),
            ("gpuMemory", "gpu_memory", int),
        ):
            if _key in report["state"]:
                continue
            try:
                _v = getattr(_o, _attr, None)
                if _v is not None:
                    report["state"][_key] = _cast(_v)
            except Exception:
                pass

        try:
            _w = getattr(_o, "width", None)
            _h = getattr(_o, "height", None)
            if _w is not None and _h is not None:
                report["state"]["resolution"] = [int(_w), int(_h)]
        except Exception:
            pass

        try:
            _errs = _o.errors(recurse=False)
            if _errs:
                for _e in _errs:
                    report["state"]["errors"].extend(str(_e).splitlines())
        except TypeError:
            try:
                _errs = _o.errors()
                if _errs:
                    for _e in _errs:
                        report["state"]["errors"].extend(str(_e).splitlines())
            except Exception as _e:
                report["warnings"].append("errors unavailable: " + str(_e))
        except Exception as _e:
            report["warnings"].append("errors unavailable: " + str(_e))

        try:
            for _par in _o.pars():
                try:
                    _name = str(_par.name)
                    if _param_keys and _name not in _param_keys:
                        continue
                    try:
                        _val = _par.eval()
                    except Exception:
                        _val = getattr(_par, "val", None)
                    report["parameters"][_name] = _jsonable(_val)
                except Exception as _e:
                    report["warnings"].append("parameter unavailable: " + str(_e))
        except Exception as _e:
            report["warnings"].append("parameters unavailable: " + str(_e))

        try:
            _chans = _o.chans()
            for _chan in _chans:
                try:
                    _name = str(_chan.name)
                    if _channel_keys and _name not in _channel_keys:
                        continue
                    _val = _chan.eval()
                    if _val is not None:
                        report["channels"][_name] = float(_val)
                except Exception as _e:
                    report["warnings"].append("channel unavailable: " + str(_e))
        except Exception as _e:
            report["warnings"].append("channels unavailable: " + str(_e))
except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]

print(json.dumps(report))
`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

export function buildWatchNodeScript(payload: object): string {
  return buildPayloadScript(WATCH_NODE_SCRIPT, payload);
}

export async function watchNodeImpl(ctx: ToolContext, args: WatchNodeArgs) {
  const snapshots: WatchNodeSnapshot[] = [];
  const warnings: string[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < args.samples; i++) {
    try {
      const script = buildWatchNodeScript({
        path: args.path,
        parameter_keys: args.parameter_keys,
        channel_keys: args.channel_keys,
      });
      const exec = await ctx.client.executePythonScript(script, true);
      const report = parsePythonReport<WatchNodeProbeReport>(exec.stdout);

      if (report.fatal) {
        if (snapshots.length === 0) {
          return errorResult(`watch_node failed: ${report.fatal}`, report);
        }
        warnings.push(report.fatal);
        break;
      }

      const sampleWarnings = report.warnings ?? [];
      warnings.push(...sampleWarnings);
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      snapshots.push({
        sample_index: i,
        elapsed_ms: elapsedMs,
        path: report.path ?? args.path,
        type: report.type ?? "",
        family: report.family,
        state: report.state ?? {},
        parameters: report.parameters ?? {},
        channels: report.channels ?? {},
        warnings: sampleWarnings,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(
        `Only ${snapshots.length}/${args.samples} samples collected before bridge error: ${msg}`,
      );
      break;
    }

    if (i < args.samples - 1) {
      await sleep(args.interval_ms);
    }
  }

  if (snapshots.length === 0) {
    return errorResult("No samples collected — bridge may be offline.", {
      path: args.path,
      requested_samples: args.samples,
      interval_ms: args.interval_ms,
      warnings: unique(warnings),
    });
  }

  const data = {
    path: args.path,
    requested_samples: args.samples,
    collected_samples: snapshots.length,
    interval_ms: args.interval_ms,
    window_ms: snapshots.at(-1)?.elapsed_ms ?? 0,
    warnings: unique(warnings),
    snapshots,
  };

  const warningSuffix = data.warnings.length > 0 ? ` (${data.warnings.length} warning(s))` : "";
  return structuredResult(
    `Collected ${snapshots.length}/${args.samples} sample(s) for ${args.path}${warningSuffix}.`,
    data,
  );
}

export const registerWatchNode: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "watch_node",
    {
      title: "Watch node",
      description:
        "Read-only: sample one TouchDesigner operator over a short interval and return runtime state, readable parameter values, and CHOP channel values when available. Missing TD attributes/channels are reported as warnings instead of failing the watch. Returns {path, requested_samples, collected_samples, interval_ms, window_ms, warnings[], snapshots[]} where each snapshot has {sample_index, elapsed_ms, path, type, family, state, parameters, channels, warnings}.",
      inputSchema: watchNodeSchema.shape,
      outputSchema: watchNodeOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => watchNodeImpl(ctx, args),
  );
};
