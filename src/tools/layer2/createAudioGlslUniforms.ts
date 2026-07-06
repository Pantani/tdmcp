import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const BindingSchema = z.object({
  chan: z.string().min(1).describe("Channel name in source_chop_path (e.g. 'low', 'mid', 'rms')."),
  uniform: z
    .string()
    .min(1)
    .describe(
      "Uniform name as declared in the GLSL shader (e.g. 'uBass'). Written to vec<slot>name.",
    ),
  component: z
    .enum(["x", "y", "z", "w"])
    .default("x")
    .describe(
      "Which component of the vec slot the channel drives. Use multiple entries with the same slot to fill yzw.",
    ),
  slot: z
    .number()
    .int()
    .min(0)
    .max(19)
    .optional()
    .describe(
      "seq.vec slot index (0..19). If omitted, slots are assigned by uniform name — entries sharing a uniform reuse a slot; new uniforms claim the next free index starting at 0.",
    ),
});

export const createAudioGlslUniformsSchema = z.object({
  target_glsl_path: z
    .string()
    .describe("Path to an existing glslTOP whose seq.vec slots will be bound."),
  source_chop_path: z
    .string()
    .describe(
      "Path to the CHOP whose channels are read (must contain every `chan` listed in bindings).",
    ),
  bindings: z
    .array(BindingSchema)
    .min(1)
    .max(80)
    .describe(
      "Channel → uniform/component map. Multiple entries can target the same slot (different components) to build a multi-component uniform.",
    ),
  expand_capacity: z
    .boolean()
    .default(true)
    .describe(
      "If true, grow g.seq.vec.numBlocks to fit the highest slot index. If false, an out-of-range slot is a hard error.",
    ),
});

type CreateAudioGlslUniformsArgs = z.infer<typeof createAudioGlslUniformsSchema>;

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

interface SlotBound {
  slot: number;
  uniform: string;
  component: "x" | "y" | "z" | "w";
  expression: string;
}

interface AudioGlslUniformsReport {
  target_glsl_top: string;
  source_chop: string;
  slots_bound: SlotBound[];
  warnings: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Python payload template
// ---------------------------------------------------------------------------

const PYTHON_TEMPLATE = `
import json, base64
PAYLOAD = json.loads(base64.b64decode("__PAYLOAD_B64__").decode())

try:
    from td import ParMode as _PM
except Exception:
    _PM = None

REPORT = {}
try:
    g = op(PAYLOAD["target"])
    c = op(PAYLOAD["source"])
    assert g is not None and g.OPType == "glslTOP", "target_glsl_path not a glslTOP: " + str(PAYLOAD["target"])
    assert c is not None and c.family == "CHOP", "source_chop_path not a CHOP: " + str(PAYLOAD["source"])

    chans = {ch.name for ch in c.chans("*")}
    warnings = []

    # Auto-assign slots per unique uniform (explicit slots in payload["bindings"] already set)
    auto = {}
    next_slot = [0]
    taken = set(b["slot"] for b in PAYLOAD["bindings"] if b.get("slot") is not None)
    for b in PAYLOAD["bindings"]:
        if b.get("slot") is None:
            if b["uniform"] not in auto:
                while next_slot[0] in taken:
                    next_slot[0] += 1
                auto[b["uniform"]] = next_slot[0]
                taken.add(next_slot[0])
                next_slot[0] += 1
            b["slot"] = auto[b["uniform"]]

    # Per-slot uniform-name conflict check
    by_slot = {}
    for b in PAYLOAD["bindings"]:
        prev = by_slot.get(b["slot"])
        if prev is None:
            by_slot[b["slot"]] = b["uniform"]
        elif prev != b["uniform"]:
            raise ValueError("slot " + str(b["slot"]) + " already bound to uniform " + repr(prev) + ", can't also bind " + repr(b["uniform"]))

    max_slot = max(b["slot"] for b in PAYLOAD["bindings"])
    if max_slot >= g.seq.vec.numBlocks:
        if PAYLOAD["expand"]:
            g.seq.vec.numBlocks = max_slot + 1
        else:
            raise IndexError("slot " + str(max_slot) + " exceeds numBlocks=" + str(g.seq.vec.numBlocks))

    slots_bound = []
    for b in PAYLOAD["bindings"]:
        i = b["slot"]
        if b["chan"] not in chans:
            warnings.append("channel " + repr(b["chan"]) + " not in " + c.path + "; uniform will read 0")
        setattr(g.par, "vec%dname" % i, b["uniform"])
        p = getattr(g.par, "vec%dvalue%s" % (i, b["component"]))
        expr = "op(" + repr(c.path) + ")[" + repr(b["chan"]) + "]"
        p.expr = expr
        if _PM is not None:
            p.mode = _PM.EXPRESSION
        slots_bound.append({"slot": i, "uniform": b["uniform"], "component": b["component"], "expression": expr})

    REPORT["target_glsl_top"] = g.path
    REPORT["source_chop"] = c.path
    REPORT["slots_bound"] = slots_bound
    REPORT["warnings"] = warnings
except Exception as _e:
    REPORT["error"] = str(_e)

result = json.dumps(REPORT)
print(result)
`.trim();

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function createAudioGlslUniformsImpl(
  ctx: ToolContext,
  args: CreateAudioGlslUniformsArgs,
): Promise<CallToolResult> {
  const payload = {
    target: args.target_glsl_path,
    source: args.source_chop_path,
    bindings: args.bindings.map((b) => ({
      chan: b.chan,
      uniform: b.uniform,
      component: b.component,
      slot: b.slot ?? null,
    })),
    expand: args.expand_capacity,
  };

  const script = buildPayloadScript(PYTHON_TEMPLATE, payload);

  return guardTd(
    async () => {
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<AudioGlslUniformsReport>(exec.stdout);
    },
    (report) => {
      if (report.error) {
        return errorResult(`create_audio_glsl_uniforms failed: ${report.error}`);
      }
      const n = report.slots_bound.length;
      return jsonResult(`Bound ${n} uniform slot(s) on ${report.target_glsl_top}.`, report);
    },
  );
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreateAudioGlslUniforms: ToolRegistrar = (server, ctx) =>
  server.registerTool(
    "create_audio_glsl_uniforms",
    {
      title: "Bind audio CHOP channels to GLSL TOP uniform slots",
      description:
        "Writes CHOP-reference expressions onto the seq.vec uniform slots of an existing glslTOP, so named channels (low/mid/high/rms etc.) drive shader uniforms every cook. Creates no operators — pure parameter binding. Idempotent and composable with create_glsl_shader.",
      inputSchema: createAudioGlslUniformsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createAudioGlslUniformsImpl(ctx, args),
  );
