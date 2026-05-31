import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildProbSequencerScript,
  createProbSequencerImpl,
  createProbSequencerSchema,
  normalizeMatrix,
} from "../../src/tools/layer1/createProbSequencer.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface Payload {
  name: string;
  parent: string;
  bpm: number;
  division: string;
  state_ids: string[];
  matrix: number[][];
  weights: number[];
  start_index: number;
  seed: number | null;
  bpm_source: string | null;
  dispatch_text: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const script = exec.mock.calls[0]?.[0];
  if (typeof script !== "string")
    throw new Error("executePythonScript was not called with a script");
  return script;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const TWO_STATES = [
  { id: "a", weight: 1, transitions: { a: 0.2, b: 0.8 } },
  { id: "b", weight: 1, transitions: { a: 0.5, b: 0.5 } },
];

const okReport = (over: Record<string, unknown> = {}) =>
  vi.fn(async (_script: string, _capture?: boolean) => ({
    stdout: JSON.stringify({
      comp: "/project1/prob_seq",
      beat: "/project1/prob_seq/beat",
      state_chan: "/project1/prob_seq/state_chan",
      state_out: "/project1/prob_seq/state_out",
      dispatch: "/project1/prob_seq/dispatch",
      controls: ["Active", "Bpm", "Division", "Reset"],
      warnings: [],
      ...over,
    }),
  }));

function run(args: Parameters<typeof createProbSequencerSchema.parse>[0]) {
  const exec = okReport();
  return {
    exec,
    promise: createProbSequencerImpl(fakeCtx(exec), createProbSequencerSchema.parse(args)),
  };
}

// ── normalizeMatrix ───────────────────────────────────────────────────────────

describe("normalizeMatrix", () => {
  it("normalises rows to sum 1.0", () => {
    const { matrix } = normalizeMatrix(TWO_STATES);
    for (const row of matrix) {
      const sum = row.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 10);
    }
  });

  it("zero-transition row collapses to self-loop", () => {
    const states = [
      { id: "a", weight: 1, transitions: { a: 0, b: 0 } },
      { id: "b", weight: 1, transitions: { a: 1, b: 0 } },
    ];
    const { matrix } = normalizeMatrix(states);
    // Row 0 (state a) should be [1, 0] — self-loop
    expect(matrix[0]).toEqual([1, 0]);
  });

  it("normalises weights for initial distribution", () => {
    const states = [
      { id: "a", weight: 3, transitions: { a: 1, b: 0 } },
      { id: "b", weight: 1, transitions: { a: 0, b: 1 } },
    ];
    const { weights } = normalizeMatrix(states);
    expect(weights[0]).toBeCloseTo(0.75, 10);
    expect(weights[1]).toBeCloseTo(0.25, 10);
  });

  it("all-zero weights → uniform distribution", () => {
    const states = [
      { id: "x", weight: 0, transitions: { x: 1, y: 0 } },
      { id: "y", weight: 0, transitions: { x: 0, y: 1 } },
    ];
    const { weights } = normalizeMatrix(states);
    expect(weights[0]).toBeCloseTo(0.5, 10);
    expect(weights[1]).toBeCloseTo(0.5, 10);
  });

  it("stateIds order matches input order", () => {
    const { stateIds } = normalizeMatrix(TWO_STATES);
    expect(stateIds).toEqual(["a", "b"]);
  });
});

// ── Schema validation ──────────────────────────────────────────────────────────

describe("createProbSequencer schema", () => {
  it("applies defaults (name prob_seq, bpm 120, division 1/8)", () => {
    const args = createProbSequencerSchema.parse({ states: TWO_STATES });
    expect(args.name).toBe("prob_seq");
    expect(args.parent_path).toBe("/project1");
    expect(args.bpm).toBe(120);
    expect(args.division).toBe("1/8");
  });

  it("rejects states.length < 2", () => {
    expect(() =>
      createProbSequencerSchema.parse({
        states: [{ id: "a", weight: 1, transitions: {} }],
      }),
    ).toThrow();
  });

  it("rejects bpm < 20", () => {
    expect(() => createProbSequencerSchema.parse({ states: TWO_STATES, bpm: 10 })).toThrow();
  });

  it("rejects unknown division value", () => {
    expect(() =>
      createProbSequencerSchema.parse({ states: TWO_STATES, division: "1/32" }),
    ).toThrow();
  });
});

// ── Input validation ──────────────────────────────────────────────────────────

describe("createProbSequencerImpl — validation errors", () => {
  it("returns isError when transitions reference unknown state id", async () => {
    const exec = okReport();
    const result = await createProbSequencerImpl(fakeCtx(exec), {
      name: "prob_seq",
      parent_path: "/project1",
      bpm: 120,
      division: "1/8",
      states: [
        { id: "a", weight: 1, transitions: { a: 0.5, UNKNOWN: 0.5 } },
        { id: "b", weight: 1, transitions: { a: 1 } },
      ],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("UNKNOWN");
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns isError when startState is not a known state id", async () => {
    const exec = okReport();
    const result = await createProbSequencerImpl(fakeCtx(exec), {
      name: "prob_seq",
      parent_path: "/project1",
      bpm: 120,
      division: "1/8",
      states: TWO_STATES,
      startState: "z",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("startState");
    expect(exec).not.toHaveBeenCalled();
  });
});

// ── Script shape ──────────────────────────────────────────────────────────────

describe("buildProbSequencerScript — node types", () => {
  const script = buildProbSequencerScript({
    name: "prob_seq",
    parent: "/project1",
    bpm: 120,
    division: "1/8",
    subdiv: 2,
    state_ids: ["a", "b"],
    matrix: [
      [0.2, 0.8],
      [0.5, 0.5],
    ],
    weights: [0.5, 0.5],
    start_index: 0,
    seed: null,
    bpm_source: null,
    dispatch_text: "DISPATCH",
  });

  it("references td.beatCHOP", () => {
    expect(script).toContain("td.beatCHOP");
  });

  it("references td.constantCHOP for state channels", () => {
    expect(script).toContain("td.constantCHOP");
  });

  it("references td.nullCHOP for state_out", () => {
    expect(script).toContain("td.nullCHOP");
  });

  it("references td.chopexecuteDAT for dispatch", () => {
    expect(script).toContain("td.chopexecuteDAT");
  });
});

describe("createProbSequencerImpl — script assertions", () => {
  it("embeds last_beat_index dedup in dispatch text", async () => {
    const { exec, promise } = run({ states: TWO_STATES });
    await promise;
    const payload = decodePayload(scriptArg(exec));
    expect(payload.dispatch_text).toContain("last_beat_index");
  });

  it("embeds store('current_state') in dispatch text", async () => {
    const { exec, promise } = run({ states: TWO_STATES });
    await promise;
    const payload = decodePayload(scriptArg(exec));
    expect(payload.dispatch_text).toContain("current_state");
  });

  it("embeds normalised matrix in payload", async () => {
    const { exec, promise } = run({ states: TWO_STATES });
    await promise;
    const payload = decodePayload(scriptArg(exec));
    expect(payload.matrix).toBeDefined();
    expect(Array.isArray(payload.matrix)).toBe(true);
    // Each row sums to 1
    for (const row of payload.matrix) {
      const sum = (row as number[]).reduce((a: number, b: number) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 10);
    }
  });

  it("embeds state_ids in payload", async () => {
    const { exec, promise } = run({ states: TWO_STATES });
    await promise;
    const payload = decodePayload(scriptArg(exec));
    expect(payload.state_ids).toEqual(["a", "b"]);
  });

  it("passes captureStdout=true to executePythonScript", async () => {
    const { exec, promise } = run({ states: TWO_STATES });
    await promise;
    expect(exec.mock.calls[0]?.[1]).toBe(true);
  });
});

// ── Seed propagation ──────────────────────────────────────────────────────────

describe("createProbSequencerImpl — seed propagation", () => {
  it("embeds seed in payload when provided", async () => {
    const { exec, promise } = run({ states: TWO_STATES, seed: 42 });
    await promise;
    const payload = decodePayload(scriptArg(exec));
    expect(payload.seed).toBe(42);
  });

  it("embeds null seed when not provided", async () => {
    const { exec, promise } = run({ states: TWO_STATES });
    await promise;
    const payload = decodePayload(scriptArg(exec));
    expect(payload.seed).toBeNull();
  });

  it("dispatch_text mentions random.seed when seed is set", async () => {
    const { exec, promise } = run({ states: TWO_STATES, seed: 7 });
    await promise;
    const payload = decodePayload(scriptArg(exec));
    expect(payload.dispatch_text).toContain("random.seed");
  });
});

// ── Result shape ──────────────────────────────────────────────────────────────

describe("createProbSequencerImpl — result shape", () => {
  it("summarises comp path + state count + division on success", async () => {
    const exec = okReport();
    const result = await createProbSequencerImpl(
      fakeCtx(exec),
      createProbSequencerSchema.parse({ states: TWO_STATES }),
    );
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/prob_seq");
    expect(text).toContain("2 states");
    expect(text).toContain("1/8");
  });

  it("includes warning count when warnings present", async () => {
    const exec = okReport({ warnings: ["bpm_source not found"] });
    const result = await createProbSequencerImpl(
      fakeCtx(exec),
      createProbSequencerSchema.parse({ states: TWO_STATES }),
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/1 warning\(s\)/);
  });

  it("returns isError when report.fatal is set", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        comp: "/project1",
        beat: "",
        state_chan: "",
        state_out: "",
        dispatch: "",
        controls: [],
        warnings: [],
        fatal: "COMP not found: /project1/missing",
      }),
    }));
    const result = await createProbSequencerImpl(
      fakeCtx(exec),
      createProbSequencerSchema.parse({ states: TWO_STATES }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMP not found");
  });

  it("self-loop warning from TS pre-check included in final warnings", async () => {
    const states = [
      { id: "a", weight: 1, transitions: { a: 0, b: 0 } }, // zero-row → self-loop warning
      { id: "b", weight: 1, transitions: { a: 1, b: 0 } },
    ];
    const exec = okReport();
    const result = await createProbSequencerImpl(
      fakeCtx(exec),
      createProbSequencerSchema.parse({ states }),
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/1 warning\(s\)/);
  });
});
