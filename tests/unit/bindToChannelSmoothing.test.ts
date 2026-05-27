import { describe, expect, it } from "vitest";
import { bindToChannelImpl, buildBindScript } from "../../src/tools/layer2/bindToChannel.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// Mirrors tests/unit/animateParameter.test.ts (the closest analog: a tool that creates a
// CHOP inside a single Python pass and binds a parameter to it by expression). The bind
// payload travels as base64, so we decode it to assert the impl's attack/release → lag1/lag2
// derivation, and we inspect the generated script for the Select+Lag smoothing machinery.

interface Payload {
  targets: string[];
  source_chop: string;
  channel: string;
  scale: number;
  offset: number;
  lag1: number;
  lag2: number;
  select_name: string;
  lag_name: string;
  smoothing_container: string | null;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

/**
 * Minimal ToolContext whose client captures the executed script instead of hitting TD, and
 * returns a representative report. When smoothing is requested the report mirrors what the
 * live Python pass would emit (the created Select/Lag paths + the lagged-channel expression).
 */
function fakeCtx(capture: (script: string) => void): ToolContext {
  return {
    client: {
      executePythonScript: async (script: string) => {
        capture(script);
        const p = decodePayload(script);
        const smoothed = p.lag1 > 0 || p.lag2 > 0;
        const cont = p.smoothing_container ?? "/p";
        const readPath = smoothed ? `${cont}/${p.lag_name}` : p.source_chop;
        let expr = `op('${readPath}')['${p.channel}']`;
        if (p.scale !== 1) expr = `(${expr}) * ${p.scale}`;
        if (p.offset !== 0) expr = `${expr} + ${p.offset}`;
        return {
          stdout: JSON.stringify({
            bound: p.targets,
            expression: expr,
            channel_present: true,
            smoothed,
            ...(smoothed
              ? {
                  smoothing_select: `${cont}/${p.select_name}`,
                  smoothing_lag: `${cont}/${p.lag_name}`,
                  attack: p.lag1,
                  release: p.lag2,
                }
              : {}),
            warnings: [],
          }),
        };
      },
    },
    logger: silentLogger,
  } as unknown as ToolContext;
}

describe("buildBindScript (smoothing machinery)", () => {
  it("emits the Select+Lag chain and binds to the lagged channel when smoothing is on", () => {
    const payload = {
      targets: ["/project1/sys/transform1.scale"],
      source_chop: "/project1/audio/features",
      channel: "bass",
      scale: 1,
      offset: 0,
      lag1: 0.02,
      lag2: 0.3,
      select_name: "bass_sel",
      lag_name: "bass_lag",
      smoothing_container: null,
    };
    const script = buildBindScript(payload);
    expect(decodePayload(script)).toEqual(payload);
    // A Select CHOP isolates the single source channel by absolute path...
    expect(script).toContain("_parent.create(selectCHOP");
    expect(script).toContain("_sel.par.chop = _src");
    expect(script).toContain("_sel.par.channames = _ch");
    // ...feeding a Lag CHOP whose lag1/lag2 are attack/release in seconds (KB-confirmed names).
    expect(script).toContain("_parent.create(lagCHOP");
    expect(script).toContain('_lag.par.lagunit = "seconds"');
    expect(script).toContain("_lag.par.lag1 = _lag1");
    expect(script).toContain("_lag.par.lag2 = _lag2");
    expect(script).toContain("_lag.inputConnectors[0].connect(_sel)");
    // The expression must read from the lagged null, not the raw source, when smoothing.
    expect(script).toContain("_read_op = _lag.path");
    // Still uses the standard expression-mode binding path.
    expect(script).toContain("_par.mode = _PM.EXPRESSION");
  });
});

describe("bindToChannelImpl (smoothing)", () => {
  it("derives lag1=attack and lag2=release and binds to the lagged channel", async () => {
    let script = "";
    const result = await bindToChannelImpl(
      fakeCtx((s) => {
        script = s;
      }),
      {
        targets: ["/project1/sys/transform1.scale"],
        source_chop: "/project1/audio/features",
        channel: "bass",
        scale: 1,
        offset: 0,
        attack: 0.02,
        release: 0.3,
      },
    );
    const p = decodePayload(script);
    expect(p.lag1).toBe(0.02); // attack → lag1 (rise)
    expect(p.lag2).toBe(0.3); // release → lag2 (fall)
    expect(p.select_name).toBe("bass_sel");
    expect(p.lag_name).toBe("bass_lag");
    expect(p.smoothing_container).toBeNull();

    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(result.isError).toBeFalsy();
    expect(text).toContain("with smoothing (attack 0.02s / release 0.3s");
    // Bound to the LAGGED channel, not the raw source.
    expect(text).toContain("/p/bass_lag");
    expect(text).not.toContain("op('/project1/audio/features')['bass']");
  });

  it("treats `smooth` as symmetric attack=release", async () => {
    let script = "";
    await bindToChannelImpl(
      fakeCtx((s) => {
        script = s;
      }),
      {
        targets: ["/project1/sys/blur1.size"],
        source_chop: "/project1/audio/features",
        channel: "level",
        scale: 1,
        offset: 0,
        attack: 0, // overridden by `smooth`
        release: 0,
        smooth: 0.15,
      },
    );
    const p = decodePayload(script);
    expect(p.lag1).toBe(0.15);
    expect(p.lag2).toBe(0.15);
  });

  it("`smooth` wins over explicit attack/release when both are given", async () => {
    let script = "";
    await bindToChannelImpl(
      fakeCtx((s) => {
        script = s;
      }),
      {
        targets: ["/project1/sys/blur1.size"],
        source_chop: "/project1/audio/features",
        channel: "level",
        scale: 1,
        offset: 0,
        attack: 0.5,
        release: 0.9,
        smooth: 0.1,
      },
    );
    const p = decodePayload(script);
    expect(p.lag1).toBe(0.1);
    expect(p.lag2).toBe(0.1);
  });

  it("passes a smoothing_container override through to the payload", async () => {
    let script = "";
    await bindToChannelImpl(
      fakeCtx((s) => {
        script = s;
      }),
      {
        targets: ["/project1/sys/transform1.scale"],
        source_chop: "/project1/audio/features",
        channel: "bass",
        scale: 1,
        offset: 0,
        attack: 0.05,
        release: 0.4,
        smoothing_container: "/project1/audio",
      },
    );
    const p = decodePayload(script);
    expect(p.smoothing_container).toBe("/project1/audio");
  });

  // The no-smoothing path must remain byte-for-byte the original raw-channel bind: lag1/lag2
  // both 0, no Select/Lag created, expression reads straight from the source CHOP.
  it("leaves the raw-channel bind unchanged when no smoothing is requested", async () => {
    let script = "";
    const result = await bindToChannelImpl(
      fakeCtx((s) => {
        script = s;
      }),
      {
        targets: ["/project1/sys/transform1.scale"],
        source_chop: "/project1/audio/features",
        channel: "bass",
        scale: 2,
        offset: 0.5,
      },
    );
    const p = decodePayload(script);
    expect(p.lag1).toBe(0);
    expect(p.lag2).toBe(0);
    expect(p.smoothing_container).toBeNull();

    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(result.isError).toBeFalsy();
    // No smoothing note; expression reads the raw source channel with scale+offset applied.
    expect(text).not.toContain("with smoothing");
    expect(text).toContain("op('/project1/audio/features')['bass']");
  });

  it("scale and offset still wrap the (lagged) expression when smoothing", async () => {
    const result = await bindToChannelImpl(
      fakeCtx(() => {}),
      {
        targets: ["/project1/sys/transform1.scale"],
        source_chop: "/project1/audio/features",
        channel: "bass",
        scale: 3,
        offset: 1,
        attack: 0.02,
        release: 0.25,
      },
    );
    // The report (incl. the final expression) rides in the JSON fence of the text block.
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    // (op(...)['bass']) * 3 + 1 — scale wraps in parens, offset adds after, on the lagged channel.
    expect(text).toContain("/p/bass_lag");
    expect(text).toContain("* 3");
    expect(text).toContain("+ 1");
  });
});
