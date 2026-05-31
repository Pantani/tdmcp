import { z } from "zod";
import { friendlyTdError } from "../../td-client/types.js";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

export const inspectGpuAndDisplaysSchema = z.object({
  include: z
    .array(z.enum(["gpu", "monitors", "performMode"]))
    .nonempty()
    .optional()
    .describe("Subset of sections to read; omit for all three."),
});
type InspectGpuAndDisplaysArgs = z.infer<typeof inspectGpuAndDisplaysSchema>;

export const inspectGpuAndDisplaysOutputSchema = z.object({
  connected: z.boolean(),
  endpoint: z.string().optional(),
  reason: z.string().optional(),
  gpu: z
    .object({
      name: z.string().nullable().optional(),
      driver: z.string().nullable().optional(),
      memory: z.union([z.number(), z.string()]).nullable().optional(),
      error: z.string().optional(),
    })
    .optional(),
  monitors: z
    .union([
      z.array(
        z.object({
          index: z.number(),
          width: z.number().nullable().optional(),
          height: z.number().nullable().optional(),
          refreshRate: z.number().nullable().optional(),
          isPrimary: z.boolean().nullable().optional(),
          left: z.number().nullable().optional(),
          top: z.number().nullable().optional(),
        }),
      ),
      z.object({ error: z.string() }),
    ])
    .optional(),
  performMode: z.union([z.boolean(), z.object({ error: z.string() })]).optional(),
});

type GpuAndDisplaysReport = {
  gpu?: {
    name?: string | null;
    driver?: string | null;
    memory?: number | string | null;
    error?: string;
  };
  monitors?:
    | Array<{
        index: number;
        width?: number | null;
        height?: number | null;
        refreshRate?: number | null;
        isPrimary?: boolean | null;
        left?: number | null;
        top?: number | null;
      }>
    | { error: string };
  performMode?: boolean | { error: string };
};

const INSPECT_SCRIPT = `
import json, base64
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode())
_want = set(_p.get("include") or ["gpu", "monitors", "performMode"])
out = {}

if "gpu" in _want:
    try:
        _gpu = None
        try:
            import td as _td
            _gpu = getattr(_td, "gpu", None)
        except Exception:
            pass
        out["gpu"] = {
            "name": (getattr(_gpu, "name", None) if _gpu else None) or getattr(app, "gpuName", None),
            "driver": getattr(_gpu, "driver", None) if _gpu else None,
            "memory": getattr(_gpu, "memory", None) if _gpu else None,
        }
    except Exception as _e:
        out["gpu"] = {"error": str(_e)}

if "monitors" in _want:
    try:
        _mons = []
        for _i, _m in enumerate(app.monitors):
            _mons.append({
                "index": _i,
                "width": getattr(_m, "width", None),
                "height": getattr(_m, "height", None),
                "refreshRate": getattr(_m, "refreshRate", None),
                "isPrimary": getattr(_m, "isPrimary", None),
                "left": getattr(_m, "left", None),
                "top": getattr(_m, "top", None),
            })
        out["monitors"] = _mons
    except Exception as _e:
        out["monitors"] = {"error": str(_e)}

if "performMode" in _want:
    try:
        out["performMode"] = bool(project.performMode)
    except Exception as _e:
        out["performMode"] = {"error": str(_e)}

result = out
print(json.dumps(out))
`;

export function buildInspectGpuScript(args: InspectGpuAndDisplaysArgs): string {
  return buildPayloadScript(INSPECT_SCRIPT, { include: args.include ?? null });
}

export async function inspectGpuAndDisplaysImpl(ctx: ToolContext, args: InspectGpuAndDisplaysArgs) {
  try {
    const script = buildInspectGpuScript(args);
    const exec = await ctx.client.executePythonScript(script, true);
    const data = parsePythonReport<GpuAndDisplaysReport>(exec.stdout);
    return jsonResult("GPU and display info read.", { connected: true, ...data });
  } catch (err) {
    return jsonResult("TouchDesigner is not reachable.", {
      connected: false,
      endpoint: ctx.client.endpoint,
      reason: friendlyTdError(err),
    });
  }
}

export const registerInspectGpuAndDisplays: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "inspect_gpu_and_displays",
    {
      title: "Inspect GPU and displays",
      description:
        "Read-only: returns the host GPU info (name, driver, VRAM), attached monitor topology (resolution, refresh rate, primary flag, position), and whether the project is in Perform Mode. Use to plan output mapping, dome rigs, and multi-display shows without leaving the chat. Offline-safe — returns { connected: false, reason } when TD is unreachable.",
      inputSchema: inspectGpuAndDisplaysSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    (args) => inspectGpuAndDisplaysImpl(ctx, args),
  );
};
