import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";

// ── Schema ────────────────────────────────────────────────────────────────────

const stateSchema = z.object({
  id: z.string(),
  weight: z.number().min(0),
  transitions: z.record(z.string(), z.number().min(0)),
});

export const createProbSequencerSchema = z.object({
  name: z.string().default("prob_seq").describe("Container COMP name."),
  parent_path: z.string().default("/project1").describe("Parent COMP path."),
  bpm: z
    .number()
    .min(20)
    .max(999)
    .default(120)
    .describe("Tempo written to Beat CHOP when no bpm_source is provided."),
  division: z
    .enum(["1/4", "1/8", "1/16"])
    .default("1/8")
    .describe("Beat subdivision (1/4→1, 1/8→2, 1/16→4 beats-per-measure)."),
  states: z
    .array(stateSchema)
    .min(2)
    .max(32)
    .describe(
      "Markov states. Each state has a unique id, a weight (initial distribution), and a transitions map (keys = state ids, values ≥ 0).",
    ),
  startState: z
    .string()
    .optional()
    .describe("Initial state id. If omitted, sampled from state weights."),
  bpm_source: z
    .string()
    .optional()
    .describe("Path to an existing Beat CHOP / tempo source. Omit to build a new one."),
  seed: z.number().int().optional().describe("If set, seeds Python random for reproducible runs."),
});

type CreateProbSequencerArgs = z.infer<typeof createProbSequencerSchema>;
type StateSpec = z.infer<typeof stateSchema>;

// ── Matrix normalisation ──────────────────────────────────────────────────────

/**
 * Exported for offline tests.
 * Returns the row-normalised transition matrix and the start index.
 * Zero rows collapse to a self-loop (row[i] = 1).
 */
export function normalizeMatrix(states: StateSpec[]): {
  matrix: number[][];
  weights: number[];
  stateIds: string[];
} {
  const stateIds = states.map((s) => s.id);
  const n = states.length;
  const matrix: number[][] = [];

  for (let i = 0; i < n; i++) {
    const state = states[i];
    if (!state) {
      matrix.push(new Array(n).fill(0));
      continue;
    }
    const row = stateIds.map((id) => {
      const v = state.transitions[id];
      return typeof v === "number" && v >= 0 ? v : 0;
    });
    const sum = row.reduce((a, b) => a + b, 0);
    if (sum === 0) {
      // Self-loop: only the current state has weight 1
      const selfRow = new Array(n).fill(0);
      selfRow[i] = 1;
      matrix.push(selfRow);
    } else {
      matrix.push(row.map((v) => v / sum));
    }
  }

  // Normalise weights for initial distribution
  const rawWeights = states.map((s) => s.weight);
  const wSum = rawWeights.reduce((a, b) => a + b, 0);
  const weights = wSum === 0 ? new Array(n).fill(1 / n) : rawWeights.map((w) => w / wSum);

  return { matrix, weights, stateIds };
}

// ── Python payload ────────────────────────────────────────────────────────────

const DISPATCH_CALLBACK = `def onValueChange(channel, sampleIndex, val, prev):
    if channel.name != 'count':
        return
    seq = me.parent()
    act_par = getattr(seq.par, 'Active', None)
    if act_par is not None and not act_par.eval():
        return
    last = seq.fetch('last_beat_index', -1)
    cur_count = int(val)
    if cur_count == last:
        return  # dedup re-cooks
    seq.store('last_beat_index', cur_count)
    matrix = seq.fetch('matrix')
    cur = int(seq.fetch('current_state', 0))
    row = matrix[cur]
    import random
    seed_val = seq.fetch('seed', None)
    if seed_val is not None:
        random.seed(int(seed_val) + cur_count)
    r = random.random()
    acc = 0.0
    nxt = cur
    for i, p in enumerate(row):
        acc += p
        if r <= acc:
            nxt = i
            break
    seq.store('current_state', nxt)
    sc = seq.op('state_chan')
    if sc is not None:
        sc.par.value0 = nxt
        sc.par.value1 = 1
        run("op('" + sc.path + "').par.value1 = 0", delayFrames=1)
`;

const PROB_SCRIPT = `
import json, base64, traceback
import td
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "comp": _p["parent"], "beat": "", "state_chan": "", "state_out": "",
    "dispatch": "", "controls": [], "warnings": [],
}
_parent = op(_p["parent"])
try:
    if _parent is None:
        report["fatal"] = "COMP not found: " + _p["parent"]
    elif not hasattr(_parent, "create"):
        report["fatal"] = _p["parent"] + " is not a COMP."
    else:
        _seq = _parent.op(_p["name"]) or _parent.create(td.containerCOMP, _p["name"])
        try:
            _seq.store("tdmcp_role", "prob_sequencer")
            _seq.store("matrix", _p["matrix"])
            _seq.store("state_ids", _p["state_ids"])
            _seq.store("current_state", _p["start_index"])
            _seq.store("last_beat_index", -1)
            if _p.get("seed") is not None:
                _seq.store("seed", _p["seed"])
        except Exception:
            pass
        report["comp"] = _seq.path

        # Beat CHOP
        _bpm_src = _p.get("bpm_source")
        _beat = None
        if _bpm_src:
            _beat = op(_bpm_src)
            if _beat is None:
                report["warnings"].append("bpm_source not found: " + str(_bpm_src) + "; creating a new Beat CHOP.")
        if _beat is None:
            _beat = _seq.op("beat") or _seq.create(td.beatCHOP, "beat")
            _div_map = {"1/4": (1, 1), "1/8": (2, 1), "1/16": (4, 1)}
            _bpm_par, _subdiv_par = _div_map.get(_p["division"], (2, 1))
            try:
                _beat.par.tempo = _p["bpm"]
                _beat.par.beatspermeasure = _bpm_par
                _beat.par.count = 1
            except Exception:
                pass
        report["beat"] = _beat.path

        # state_chan: constantCHOP with 'state' and 'trigger' channels
        _sc = _seq.op("state_chan") or _seq.create(td.constantCHOP, "state_chan")
        try:
            _sc.par.value0 = _p["start_index"]
            _sc.par.value1 = 0
            if hasattr(_sc.par, "name0"):
                _sc.par.name0 = "state"
            if hasattr(_sc.par, "name1"):
                _sc.par.name1 = "trigger"
        except Exception:
            pass
        report["state_chan"] = _sc.path

        # state_out: nullCHOP wired from state_chan
        _so = _seq.op("state_out") or _seq.create(td.nullCHOP, "state_out")
        try:
            _so.inputConnectors[0].connect(_sc)
        except Exception:
            report["warnings"].append("Could not wire state_chan -> state_out.")
        report["state_out"] = _so.path

        # CHOP Execute dispatch
        _disp = _seq.op("dispatch") or _seq.create(td.chopexecuteDAT, "dispatch")
        try:
            _disp.par.chop = _beat.path
            _disp.par.channel = "count"
            _disp.par.valuechange = True
            _disp.par.active = True
        except Exception:
            report["warnings"].append("Could not fully wire dispatch DAT.")
        _disp.text = _p["dispatch_text"]
        report["dispatch"] = _disp.path

        # Custom page ProbSeq
        _page = None
        for _pg in _seq.customPages:
            if _pg.name == "ProbSeq":
                _page = _pg; break
        if _page is None:
            _page = _seq.appendCustomPage("ProbSeq")
        if getattr(_seq.par, "Active", None) is None:
            _ap = _page.appendToggle("Active")[0]
            _ap.default = True; _ap.val = True
        report["controls"].append("Active")
        if getattr(_seq.par, "Bpm", None) is None:
            _bp = _page.appendFloat("Bpm")[0]
            _bp.normMin = 20; _bp.normMax = 999
            _bp.default = _p["bpm"]; _bp.val = _p["bpm"]
        report["controls"].append("Bpm")
        if getattr(_seq.par, "Division", None) is None:
            _dp = _page.appendMenu("Division")[0]
            _dp.menuNames = ["1/4", "1/8", "1/16"]
            _dp.menuLabels = ["1/4", "1/8", "1/16"]
            _dp.default = _p["division"]; _dp.val = _p["division"]
        report["controls"].append("Division")
        if getattr(_seq.par, "Reset", None) is None:
            _rp = _page.appendPulse("Reset")[0]
        report["controls"].append("Reset")

except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

interface ProbReport {
  comp: string;
  beat: string;
  state_chan: string;
  state_out: string;
  dispatch: string;
  controls: string[];
  warnings: string[];
  fatal?: string;
}

export function buildProbSequencerScript(payload: object): string {
  return buildPayloadScript(PROB_SCRIPT, payload);
}

// ── Division → Beat CHOP mapping ─────────────────────────────────────────────

const DIVISION_SUBDIV: Record<string, number> = {
  "1/4": 1,
  "1/8": 2,
  "1/16": 4,
};

// ── Impl ──────────────────────────────────────────────────────────────────────

export async function createProbSequencerImpl(ctx: ToolContext, args: CreateProbSequencerArgs) {
  const stateIds = args.states.map((s) => s.id);
  const idSet = new Set(stateIds);

  // Validate transition keys
  for (const state of args.states) {
    for (const key of Object.keys(state.transitions)) {
      if (!idSet.has(key)) {
        return errorResult(
          `State '${state.id}' references unknown state '${key}' in its transitions. All keys must match a state id.`,
        );
      }
    }
  }

  // Validate startState
  if (args.startState !== undefined && !idSet.has(args.startState)) {
    return errorResult(
      `startState '${args.startState}' does not match any state id. Valid ids: ${stateIds.join(", ")}.`,
    );
  }

  const { matrix, weights, stateIds: orderedIds } = normalizeMatrix(args.states);

  // Determine start index
  let startIndex = 0;
  if (args.startState !== undefined) {
    startIndex = orderedIds.indexOf(args.startState);
  } else {
    // Sample from weights
    const r = Math.random();
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i] ?? 0;
      if (r <= acc) {
        startIndex = i;
        break;
      }
    }
  }

  // Check for zero-row self-loops and warn
  const warnings: string[] = [];
  for (let i = 0; i < args.states.length; i++) {
    const state = args.states[i];
    if (!state) continue;
    const rowSum = Object.values(state.transitions).reduce((a, b) => a + b, 0);
    if (rowSum === 0) {
      warnings.push(`State '${state.id}' has all-zero transitions; collapsed to self-loop.`);
    }
  }

  const _subdiv = DIVISION_SUBDIV[args.division] ?? 2;

  return guardTd(
    async () => {
      const payload = {
        name: args.name,
        parent: args.parent_path,
        bpm: args.bpm,
        division: args.division,
        subdiv: _subdiv,
        state_ids: orderedIds,
        matrix,
        weights,
        start_index: startIndex,
        seed: args.seed ?? null,
        bpm_source: args.bpm_source ?? null,
        dispatch_text: DISPATCH_CALLBACK,
      };
      const script = buildProbSequencerScript(payload);
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<ProbReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`Could not build probabilistic sequencer: ${report.fatal}`, report);
      }
      const allWarnings = [...warnings, ...(report.warnings ?? [])];
      const summary =
        `Built probabilistic (Markov) sequencer ${report.comp}: ` +
        `${orderedIds.length} states, division=${args.division}, bpm=${args.bpm}. ` +
        `Outputs 'state' + 'trigger' channels on ${report.state_out}. ` +
        `NOTE: Beat CHOP only fires when TD timeline is playing (time.play=1).` +
        (allWarnings.length ? ` ${allWarnings.length} warning(s).` : "");
      return jsonResult(summary, { ...report, warnings: allWarnings });
    },
  );
}

// ── Registrar ─────────────────────────────────────────────────────────────────

export const registerCreateProbSequencer: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_prob_sequencer",
    {
      title: "Create probabilistic sequencer",
      description:
        "Build a Markov-chain step sequencer. On each beat boundary the COMP transitions from the current state to a next state sampled from the per-state weighted-transition table. Outputs two CHOP channels: 'state' (current state index) and 'trigger' (pulse on state change). Generative sibling of create_euclidean_sequencer and create_beat_grid_sequencer — great for evolving, probabilistic rhythms and generative state machines. NOTE: beat-callback timing requires a live TD session with time.play=1.",
      inputSchema: createProbSequencerSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createProbSequencerImpl(ctx, args),
  );
};
