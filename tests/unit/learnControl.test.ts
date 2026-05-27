import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { buildLearnScript, learnControlImpl } from "../../src/tools/layer2/learnControl.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

interface Payload {
  mode: string;
  source_chop: string;
  target: string | null;
  scale: number;
  offset: number;
  parent_path: string;
  min_delta: number;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

/**
 * Replaces the /api/exec handler with one that captures the executed script and
 * returns a canned Python report — standing in for what TD computes from a mocked
 * input CHOP reading. The snapshot/diff/bind itself runs inside Python (which msw
 * can't execute), so we (a) assert the generated script carries the right machinery
 * and (b) drive the TS layer with the report TD would emit.
 */
function mockExec(report: object, capture?: (script: string) => void) {
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const script = ((await request.json()) as { script: string }).script;
      capture?.(script);
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(report) },
      });
    }),
  );
}

describe("buildLearnScript", () => {
  it("round-trips the payload through the embedded base64 blob", () => {
    const payload = {
      mode: "bind",
      source_chop: "/project1/midiin1",
      target: "/project1/sys/transform1.scale",
      scale: 2,
      offset: 0.5,
      parent_path: "/project1",
      min_delta: 0.05,
    };
    expect(decodePayload(buildLearnScript(payload))).toEqual(payload);
  });

  it("embeds the storage, diff and expression-bind machinery", () => {
    const script = buildLearnScript({
      mode: "bind",
      source_chop: "/project1/midiin1",
      target: "/project1/n.tx",
      scale: 1,
      offset: 0,
      parent_path: "/project1",
      min_delta: 0.05,
    });
    // State persists in the parent COMP's storage, namespaced by source path.
    expect(script).toContain('KEY = "tdmcp_learn"');
    expect(script).toContain("_store_op.store(KEY, _store)");
    expect(script).toContain("_store_op.fetch(KEY, {})");
    expect(script).toContain("_store[_src] = _now");
    // Diff = raw |new - old| normalized by the channel's own magnitude so ranges compare
    // fairly: norm = raw / max(|old|, |new|, EPS). EPS guards a channel resting at 0.
    expect(script).toContain("_raw = abs(_val - _old)");
    expect(script).toContain("_norm = _raw / max(abs(_old), abs(_val), _EPS)");
    expect(script).toContain("_EPS = 1e-6");
    // Ranking + pick are on the NORMALIZED delta (kv[2]), and both raw + norm are reported.
    expect(script).toContain("_deltas.sort(key=lambda kv: kv[2], reverse=True)");
    expect(script).toContain('{"channel": n, "delta": r, "norm": nm}');
    // Minimum-movement gate (jitter rejection) compares the top normalized delta to min_delta.
    expect(script).toContain('_min_norm = _p.get("min_delta")');
    expect(script).toContain("_deltas[0][2] < _min_norm");
    // Bind reuses the bind_to_channel expression mechanism (absolute path via repr,
    // expression mode derived from a live parameter).
    expect(script).toContain('_expr = "op(%s)[%s]" % (repr(_src), repr(_ch))');
    expect(script).toContain("_PM = type(_par.mode)");
    expect(script).toContain("_par.mode = _PM.EXPRESSION");
  });

  it("defaults min_delta to 0.05 when the caller omits it, and forwards an explicit value", async () => {
    // Default applied in the impl (schema field is .optional(), not .default()).
    let script = "";
    mockExec(
      {
        mode: "bind",
        source_chop: "/project1/midiin1",
        matched_channel: "ch1",
        matched_delta: 1,
        matched_norm: 1,
        min_delta: 0.05,
        bound: "/project1/n.tx",
        expression: "op('/project1/midiin1')['ch1']",
        ranking: [{ channel: "ch1", delta: 1, norm: 1 }],
        warnings: [],
      },
      (s) => {
        script = s;
      },
    );
    await learnControlImpl(makeCtx(), {
      mode: "bind",
      source_chop: "/project1/midiin1",
      target: "/project1/n.tx",
      scale: 1,
      offset: 0,
      parent_path: "/project1",
    });
    expect(decodePayload(script).min_delta).toBe(0.05);

    // An explicit value is forwarded verbatim.
    let script2 = "";
    mockExec(
      {
        mode: "bind",
        source_chop: "/project1/midiin1",
        matched_channel: "ch1",
        matched_delta: 1,
        matched_norm: 1,
        min_delta: 0.3,
        bound: "/project1/n.tx",
        expression: "op('/project1/midiin1')['ch1']",
        ranking: [{ channel: "ch1", delta: 1, norm: 1 }],
        warnings: [],
      },
      (s) => {
        script2 = s;
      },
    );
    await learnControlImpl(makeCtx(), {
      mode: "bind",
      source_chop: "/project1/midiin1",
      target: "/project1/n.tx",
      scale: 1,
      offset: 0,
      parent_path: "/project1",
      min_delta: 0.3,
    });
    expect(decodePayload(script2).min_delta).toBe(0.3);
  });
});

describe("learnControlImpl — snapshot", () => {
  it("records the channels and tells the artist to wiggle then bind", async () => {
    let script = "";
    mockExec(
      {
        mode: "snapshot",
        source_chop: "/project1/midiin1",
        channels: ["ch1", "ch2", "ch3"],
        channel_count: 3,
        warnings: [],
      },
      (s) => {
        script = s;
      },
    );
    const result = await learnControlImpl(makeCtx(), {
      mode: "snapshot",
      source_chop: "/project1/midiin1",
      scale: 1,
      offset: 0,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Snapshotted 3 channel(s) of /project1/midiin1");
    expect(text).toContain("mode:'bind'");
    // The snapshot pass carries no target.
    expect(decodePayload(script).target).toBeNull();
    expect(decodePayload(script).mode).toBe("snapshot");
  });
});

describe("learnControlImpl — bind", () => {
  it("reports the matched (most-moved) channel, its normalized delta, and the binding it made", async () => {
    // Mocked CHOP: ch2 moved the most since the snapshot → it should win. The report
    // carries both the raw delta and the normalized delta the pick was made on.
    mockExec({
      mode: "bind",
      source_chop: "/project1/midiin1",
      matched_channel: "ch2",
      matched_delta: 0.87,
      matched_norm: 0.92,
      min_delta: 0.05,
      bound: "/project1/sys/transform1.scale",
      expression: "(op('/project1/midiin1')['ch2']) * 2",
      ranking: [
        { channel: "ch2", delta: 0.87, norm: 0.92 },
        { channel: "ch1", delta: 0.02, norm: 0.04 },
        { channel: "ch3", delta: 0.0, norm: 0.0 },
      ],
      warnings: [],
    });
    const result = await learnControlImpl(makeCtx(), {
      mode: "bind",
      source_chop: "/project1/midiin1",
      target: "/project1/sys/transform1.scale",
      scale: 2,
      offset: 0,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Matched channel 'ch2'");
    expect(text).toContain("0.8700");
    // The normalized delta the ranking was based on is surfaced too.
    expect(text).toContain("0.9200 normalized");
    expect(text).toContain("/project1/sys/transform1.scale");
    expect(text).toContain("op('/project1/midiin1')['ch2']");
  });

  it("surfaces the scale/offset in the bind payload sent to TD", async () => {
    let script = "";
    mockExec(
      {
        mode: "bind",
        source_chop: "/project1/midiin1",
        matched_channel: "ch1",
        matched_delta: 1,
        bound: "/project1/n.tx",
        expression: "op('/project1/midiin1')['ch1'] + 0.25",
        ranking: [{ channel: "ch1", delta: 1 }],
        warnings: [],
      },
      (s) => {
        script = s;
      },
    );
    await learnControlImpl(makeCtx(), {
      mode: "bind",
      source_chop: "/project1/midiin1",
      target: "/project1/n.tx",
      scale: 3,
      offset: 0.25,
      parent_path: "/project1",
    });
    const p = decodePayload(script);
    expect(p.scale).toBe(3);
    expect(p.offset).toBe(0.25);
    expect(p.target).toBe("/project1/n.tx");
  });

  it("rejects bind without a target before touching TD", async () => {
    // No exec handler override: if the impl called TD this would hit the happy-path
    // exec mock (empty stdout) and fail to parse, so reaching the guard proves it
    // short-circuited.
    const result = await learnControlImpl(makeCtx(), {
      mode: "bind",
      source_chop: "/project1/midiin1",
      scale: 1,
      offset: 0,
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("target");
    expect(textOf(result)).toContain("bind");
  });

  it("returns an error result when TD reports no snapshot was recorded", async () => {
    mockExec({
      mode: "bind",
      source_chop: "/project1/midiin1",
      fatal: "No snapshot recorded for /project1/midiin1 yet — run mode 'snapshot' first.",
      warnings: [],
    });
    const result = await learnControlImpl(makeCtx(), {
      mode: "bind",
      source_chop: "/project1/midiin1",
      target: "/project1/n.tx",
      scale: 1,
      offset: 0,
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("run mode 'snapshot' first");
  });

  it("returns an error result when nothing moved since the snapshot", async () => {
    mockExec({
      mode: "bind",
      source_chop: "/project1/midiin1",
      fatal: "No channel changed since the snapshot — wiggle a control, then call bind again.",
      ranking: [{ channel: "ch1", delta: 0.0, norm: 0.0 }],
      min_delta: 0.05,
      warnings: [],
    });
    const result = await learnControlImpl(makeCtx(), {
      mode: "bind",
      source_chop: "/project1/midiin1",
      target: "/project1/n.tx",
      scale: 1,
      offset: 0,
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("wiggle a control");
  });

  it("rejects a sub-threshold (jitter) move instead of binding noise", async () => {
    // The top channel moved, but its NORMALIZED delta (0.01) is under the default
    // min_delta (0.05): TD declines to bind and tells the artist to wiggle harder.
    mockExec({
      mode: "bind",
      source_chop: "/project1/midiin1",
      fatal:
        "Top channel 'ch1' moved only 0.0100 (normalized; threshold 0.0500) — that's within jitter. Wiggle the control harder, or lower min_delta, then call bind again.",
      ranking: [
        { channel: "ch1", delta: 0.13, norm: 0.01 },
        { channel: "ch2", delta: 0.0, norm: 0.0 },
      ],
      min_delta: 0.05,
      warnings: [],
    });
    const result = await learnControlImpl(makeCtx(), {
      mode: "bind",
      source_chop: "/project1/midiin1",
      target: "/project1/n.tx",
      scale: 1,
      offset: 0,
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("within jitter");
    expect(text).toContain("Wiggle the control harder");
    // Nothing was bound.
    expect(text).not.toContain("bound /project1/n.tx");
  });

  it("passes warnings (e.g. an ambiguous near-tie match) through to the summary", async () => {
    mockExec({
      mode: "bind",
      source_chop: "/project1/midiin1",
      matched_channel: "ch1",
      matched_delta: 0.5,
      matched_norm: 0.5,
      min_delta: 0.05,
      bound: "/project1/n.tx",
      expression: "op('/project1/midiin1')['ch1']",
      ranking: [
        { channel: "ch1", delta: 0.5, norm: 0.5 },
        { channel: "ch2", delta: 0.49, norm: 0.49 },
      ],
      warnings: [
        "Top two channels moved by similar amounts ('ch1' vs 'ch2'); the match may be wrong — re-snapshot and wiggle only one control.",
      ],
    });
    const result = await learnControlImpl(makeCtx(), {
      mode: "bind",
      source_chop: "/project1/midiin1",
      target: "/project1/n.tx",
      scale: 1,
      offset: 0,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("1 warning(s)");
  });
});
