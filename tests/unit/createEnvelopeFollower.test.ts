import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildEnvelopeFollowerScript,
  createEnvelopeFollowerImpl,
  createEnvelopeFollowerSchema,
} from "../../src/tools/layer2/createEnvelopeFollower.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Payload {
  parent_path: string;
  name: string;
  source_chop: string;
  channel: string;
  attack: number;
  release: number;
  threshold: number;
  mode: "gate" | "duck";
  targets: string[];
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: { executePythonScript: exec },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const s = exec.mock.calls[0]?.[0];
  if (typeof s !== "string") throw new Error("executePythonScript not called with a string");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** A representative success report the Python pass would emit. */
function happyReport(
  overrides: Partial<{
    mode: string;
    bound: string[];
    warnings: string[];
  }> = {},
) {
  return JSON.stringify({
    container: "/project1/envelope_follower",
    output_chop: "/project1/envelope_follower/out",
    select_chop: "/project1/envelope_follower/sel",
    lag_chop: "/project1/envelope_follower/lag",
    threshold_chop: "/project1/envelope_follower/gate_apply",
    mode: overrides.mode ?? "gate",
    attack: 0.01,
    release: 0.3,
    threshold: 0.2,
    channel: "bass",
    bound: overrides.bound ?? [],
    warnings: overrides.warnings ?? [],
  });
}

// ---------------------------------------------------------------------------
// buildEnvelopeFollowerScript — pure, no TD needed
// ---------------------------------------------------------------------------

describe("buildEnvelopeFollowerScript (pure payload)", () => {
  it("embeds all schema fields in the base64 payload", () => {
    const script = buildEnvelopeFollowerScript({
      parent_path: "/project1",
      name: "envelope_follower",
      source_chop: "/project1/audio/features",
      channel: "bass",
      attack: 0.01,
      release: 0.3,
      threshold: 0.2,
      mode: "gate",
      targets: [],
    });
    const payload = decodePayload(script);
    expect(payload.parent_path).toBe("/project1");
    expect(payload.name).toBe("envelope_follower");
    expect(payload.source_chop).toBe("/project1/audio/features");
    expect(payload.channel).toBe("bass");
    expect(payload.attack).toBe(0.01);
    expect(payload.release).toBe(0.3);
    expect(payload.threshold).toBe(0.2);
    expect(payload.mode).toBe("gate");
    expect(payload.targets).toEqual([]);
  });

  it("embeds targets list when provided", () => {
    const script = buildEnvelopeFollowerScript({
      parent_path: "/project1",
      name: "ef",
      source_chop: "/project1/onsets",
      channel: "kick",
      attack: 0.005,
      release: 0.4,
      threshold: 0.1,
      mode: "duck",
      targets: ["/project1/layer1.opacity", "/project1/gain1.gain"],
    });
    const payload = decodePayload(script);
    expect(payload.mode).toBe("duck");
    expect(payload.targets).toEqual(["/project1/layer1.opacity", "/project1/gain1.gain"]);
  });

  it("uses only base64 for the payload — no raw source_chop literal in the script outside the blob", () => {
    const tricky = "/project1/UNIQUEMARKER_xyzzy";
    const script = buildEnvelopeFollowerScript({
      parent_path: "/project1",
      name: "ef",
      source_chop: tricky,
      channel: "level",
      attack: 0.01,
      release: 0.3,
      threshold: 0.2,
      mode: "gate",
      targets: [],
    });
    // The tricky string must only appear inside the decoded blob, not raw in the Python template.
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1] ?? "";
    expect(b64.length).toBeGreaterThan(0);
    // Verify it arrived safely in the decoded payload.
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain(tricky);
    // The Python template (with the b64 blob replaced) must not contain the raw marker.
    const templateWithoutBlob = script.replace(b64, "REDACTED");
    expect(templateWithoutBlob).not.toContain("UNIQUEMARKER_xyzzy");
  });

  it("script imports json and base64 and prints json.dumps(report)", () => {
    const script = buildEnvelopeFollowerScript({
      parent_path: "/project1",
      name: "ef",
      source_chop: "/project1/audio",
      channel: "level",
      attack: 0.01,
      release: 0.3,
      threshold: 0.2,
      mode: "gate",
      targets: [],
    });
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
    // Select+Lag+gate and duck paths present in the template.
    expect(script).toContain("selectCHOP");
    expect(script).toContain("lagCHOP");
    expect(script).toContain("logicCHOP");
    expect(script).toContain("mathCHOP");
    expect(script).toContain("nullCHOP");
  });
});

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------

describe("createEnvelopeFollowerSchema defaults", () => {
  it("applies all documented defaults", () => {
    const parsed = createEnvelopeFollowerSchema.parse({
      source_chop: "/project1/audio",
      channel: "bass",
    });
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("envelope_follower");
    expect(parsed.attack).toBe(0.01);
    expect(parsed.release).toBe(0.3);
    expect(parsed.threshold).toBe(0.2);
    expect(parsed.mode).toBe("gate");
    expect(parsed.targets).toEqual([]);
  });

  it("coerces numeric strings for attack/release/threshold", () => {
    const parsed = createEnvelopeFollowerSchema.parse({
      source_chop: "/s",
      channel: "c",
      attack: "0.05",
      release: "0.5",
      threshold: "0.1",
    });
    expect(parsed.attack).toBe(0.05);
    expect(parsed.release).toBe(0.5);
    expect(parsed.threshold).toBe(0.1);
  });

  it("rejects threshold > 1", () => {
    expect(() =>
      createEnvelopeFollowerSchema.parse({
        source_chop: "/s",
        channel: "c",
        threshold: 1.5,
      }),
    ).toThrow();
  });

  it("rejects negative attack", () => {
    expect(() =>
      createEnvelopeFollowerSchema.parse({
        source_chop: "/s",
        channel: "c",
        attack: -0.1,
      }),
    ).toThrow();
  });

  it("rejects an invalid mode", () => {
    expect(() =>
      createEnvelopeFollowerSchema.parse({
        source_chop: "/s",
        channel: "c",
        mode: "compress",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Happy path — impl integration
// ---------------------------------------------------------------------------

describe("createEnvelopeFollowerImpl — happy path", () => {
  it("returns a non-error result with a summary line", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createEnvelopeFollowerImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "envelope_follower",
      source_chop: "/project1/audio/features",
      channel: "bass",
      attack: 0.01,
      release: 0.3,
      threshold: 0.2,
      mode: "gate",
      targets: [],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("gate envelope follower");
    expect(text).toContain("/project1/audio/features");
    expect(text).toContain("'bass'");
    expect(text).toContain("attack 0.01s");
    expect(text).toContain("release 0.3s");
    expect(text).toContain("threshold 0.2");
    expect(text).toContain("/project1/envelope_follower/out");
  });

  it("sends the correct payload (source_chop, channel, attack, release, threshold, mode, targets)", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createEnvelopeFollowerImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "ef",
      source_chop: "/project1/onsets/onsets",
      channel: "kick",
      attack: 0.005,
      release: 0.4,
      threshold: 0.05,
      mode: "gate",
      targets: [],
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.source_chop).toBe("/project1/onsets/onsets");
    expect(payload.channel).toBe("kick");
    expect(payload.attack).toBe(0.005);
    expect(payload.release).toBe(0.4);
    expect(payload.threshold).toBe(0.05);
    expect(payload.mode).toBe("gate");
    expect(payload.targets).toEqual([]);
  });

  it("sends duck mode and targets through the payload", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        mode: "duck",
        bound: ["/project1/layer1.opacity"],
      }),
    }));
    await createEnvelopeFollowerImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "sidechain",
      source_chop: "/project1/onsets/onsets",
      channel: "kick",
      attack: 0.001,
      release: 0.6,
      threshold: 0.1,
      mode: "duck",
      targets: ["/project1/layer1.opacity"],
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.mode).toBe("duck");
    expect(payload.targets).toContain("/project1/layer1.opacity");
  });

  it("reports bound count in summary when targets are bound", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        bound: ["/project1/layer1.opacity", "/project1/gain1.gain"],
      }),
    }));
    const result = await createEnvelopeFollowerImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "ef",
      source_chop: "/project1/audio",
      channel: "bass",
      attack: 0.01,
      release: 0.3,
      threshold: 0.2,
      mode: "gate",
      targets: ["/project1/layer1.opacity", "/project1/gain1.gain"],
    });
    const text = textOf(result);
    expect(text).toContain("bound 2 target(s)");
  });

  it("includes a warning count in the summary when warnings are present", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        warnings: [
          "logicCHOP par 'convert' not found; gate mask may not work (UNVERIFIED TD build).",
        ],
      }),
    }));
    const result = await createEnvelopeFollowerImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "ef",
      source_chop: "/project1/audio",
      channel: "bass",
      attack: 0.01,
      release: 0.3,
      threshold: 0.2,
      mode: "gate",
      targets: [],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("1 warning(s)");
  });
});

// ---------------------------------------------------------------------------
// Fatal — source not found
// ---------------------------------------------------------------------------

describe("createEnvelopeFollowerImpl — fatal (source not found)", () => {
  it("returns isError:true and does not throw", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "",
        output_chop: "",
        select_chop: "",
        lag_chop: "",
        threshold_chop: "",
        mode: "gate",
        attack: 0.01,
        release: 0.3,
        threshold: 0.2,
        channel: "bass",
        bound: [],
        warnings: [],
        fatal: "Source CHOP not found: /project1/missing",
      }),
    }));
    // Direct await — must not throw; must return isError.
    const result = await createEnvelopeFollowerImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "ef",
      source_chop: "/project1/missing",
      channel: "bass",
      attack: 0.01,
      release: 0.3,
      threshold: 0.2,
      mode: "gate",
      targets: [],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Source CHOP not found");
  });
});

// ---------------------------------------------------------------------------
// Sidechain routing topology — verifies the duck chain actually wires the
// source CHOP into the envelope and binds the shaped output to the target par.
// Today's tests cover schema + build but not the wire topology, so a future
// refactor of the embedded Python could silently break sidechain routing.
// ---------------------------------------------------------------------------

describe("createEnvelopeFollowerImpl — sidechain routing topology", () => {
  it("wires the duck envelope from source_chop and binds the Null output to the target par", async () => {
    const sourceChop = "/project1/audio/features";
    const channel = "kick";
    const targetPath = "/project1/looks/main";
    const targetPar = "opacity";
    const target = `${targetPath}.${targetPar}`;

    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "/project1/sidechain",
        output_chop: "/project1/sidechain/out",
        select_chop: "/project1/sidechain/sel",
        lag_chop: "/project1/sidechain/lag",
        threshold_chop: "/project1/sidechain/duck_clamp",
        mode: "duck",
        attack: 0.005,
        release: 0.25,
        threshold: 0.1,
        channel,
        bound: [target],
        warnings: [],
      }),
    }));

    const result = await createEnvelopeFollowerImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "sidechain",
      source_chop: sourceChop,
      channel,
      attack: 0.005,
      release: 0.25,
      threshold: 0.1,
      mode: "duck",
      targets: [target],
    });
    expect(result.isError).toBeFalsy();

    const script = scriptArg(exec);
    const payload = decodePayload(script);

    // (a) Payload carries the real sidechain source/channel/target — these are
    // the inputs the Python uses to build the Select CHOP and the bind expr.
    expect(payload.source_chop).toBe(sourceChop);
    expect(payload.channel).toBe(channel);
    expect(payload.mode).toBe("duck");
    expect(payload.targets).toEqual([target]);

    // (b) Input wire topology — the Select CHOP reads the source by absolute
    // path (no cross-container wire), the Lag follows the Select, and the
    // duck invert follows the Lag. If any of these wires regress, sidechain
    // routing breaks even when the schema still passes.
    expect(script).toContain("_sel.par.chop = _src");
    expect(script).toContain('_sel.par.channames = _p["channel"]');
    expect(script).toContain("_lag.inputConnectors[0].connect(_sel)");
    expect(script).toContain('_cont.create(mathCHOP, "duck_invert")');
    expect(script).toContain("_inv.inputConnectors[0].connect(_lag)");
    expect(script).toContain('_cont.create(mathCHOP, "duck_clamp")');
    expect(script).toContain("_clamp.inputConnectors[0].connect(_inv)");
    // Null output handle hangs off the duck chain tail (_thr_out), not the raw lag.
    expect(script).toContain("_thr_out = _clamp");
    expect(script).toContain("_null.inputConnectors[0].connect(_thr_out)");

    // (c) Target binding — the duck output (Null) is bound to the target
    // parameter by expression `op('<output>')['<channel>']`, with par.mode set
    // to EXPRESSION. The script splits 'nodePath.parName' at the LAST dot, so
    // a target path with dots stays parsed correctly.
    expect(script).toContain('_dot = _t.rfind(".")');
    expect(script).toContain("_par = getattr(_n.par, _pn, None)");
    expect(script).toContain('_expr = "op(%s)[%s]" % (repr(_read_path), repr(_ch))');
    expect(script).toContain("_par.expr = _expr");
    expect(script).toContain("_par.mode = _PM.EXPRESSION");

    // And the structured report surfaces the bound target back to the caller.
    const text = textOf(result);
    expect(text).toContain(target);
    expect(text).toContain("/project1/sidechain/out");
  });
});

// ---------------------------------------------------------------------------
// TD offline — guardTd swallows the connection error
// ---------------------------------------------------------------------------

describe("createEnvelopeFollowerImpl — TD offline", () => {
  it("returns isError:true and does not throw when the bridge is unreachable", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    // guardTd must swallow the thrown error and return an isError result — no throw out of impl.
    const result = await createEnvelopeFollowerImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "ef",
      source_chop: "/project1/audio",
      channel: "bass",
      attack: 0.01,
      release: 0.3,
      threshold: 0.2,
      mode: "gate",
      targets: [],
    });
    expect(result.isError).toBe(true);
  });
});
