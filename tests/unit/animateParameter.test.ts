import { describe, expect, it } from "vitest";
import {
  animateParameterImpl,
  buildAnimateScript,
} from "../../src/tools/layer2/animateParameter.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  wavetype: string;
  amp: number;
  offset: number;
  frequency: number;
  container: string | null;
  targets: string[];
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

/** Minimal ToolContext whose client captures the executed script instead of hitting TD. */
function fakeCtx(capture: (script: string) => void): ToolContext {
  return {
    client: {
      executePythonScript: async (script: string) => {
        capture(script);
        return {
          stdout: JSON.stringify({
            lfo: "/p/lfo_anim",
            container: "/p",
            channel: "chan1",
            frequency: 0.25,
            targets_bound: ["/p/n.tx"],
            warnings: [],
          }),
        };
      },
    },
    logger: silentLogger,
  } as unknown as ToolContext;
}

describe("buildAnimateScript", () => {
  it("round-trips the payload and emits the LFO + binding machinery", () => {
    const payload = {
      targets: ["/p/n.tx"],
      name: "lfo_anim",
      wavetype: "sin",
      frequency: 0.25,
      amp: 1,
      offset: 0,
      container: null,
    };
    const script = buildAnimateScript(payload);
    expect(decodePayload(script)).toEqual(payload);
    expect(script).toContain("_parent.create(lfoCHOP");
    expect(script).toContain("_lfo.par.wavetype");
    expect(script).toContain("_tp.mode = _PM.EXPRESSION");
  });
});

describe("animateParameterImpl", () => {
  it("derives amp/offset/frequency from min/max/period and maps the waveform", async () => {
    let script = "";
    await animateParameterImpl(
      fakeCtx((s) => (script = s)),
      {
        targets: ["/p/n.tx"],
        waveform: "triangle",
        min: -2,
        max: 2,
        period_seconds: 4,
        name: "lfo_anim",
      },
    );
    const p = decodePayload(script);
    expect(p.wavetype).toBe("tri"); // triangle → tri
    expect(p.amp).toBe(2); // (max - min) / 2
    expect(p.offset).toBe(0); // (max + min) / 2
    expect(p.frequency).toBe(0.25); // 1 / period
    expect(p.container).toBeNull();
  });

  it("maps an asymmetric range to the right center and amplitude", async () => {
    let script = "";
    await animateParameterImpl(
      fakeCtx((s) => (script = s)),
      {
        targets: ["/p/blur.size"],
        waveform: "sine",
        min: 0,
        max: 30,
        period_seconds: 2,
        container_path: "/project1/sys",
        name: "lfo_anim",
      },
    );
    const p = decodePayload(script);
    expect(p.amp).toBe(15);
    expect(p.offset).toBe(15);
    expect(p.frequency).toBe(0.5);
    expect(p.container).toBe("/project1/sys");
  });
});
