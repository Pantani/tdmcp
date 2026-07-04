import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdApiError } from "../../src/td-client/types.js";
import {
  buildSetExprScript,
  setParameterExpressionImpl,
  setParameterExpressionSchema,
} from "../../src/tools/layer3/setParameterExpression.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Payload {
  path: string;
  assignments: Array<{
    param: string;
    mode: string;
    expr?: string;
    value?: unknown;
  }>;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: {
      // Endpoint-first: simulate an older bridge (404 -> TdApiError) on the FIRST
      // per-param call so the impl falls back to the whole-batch exec path these
      // legacy tests assert against.
      setParameterMode: vi.fn(async () => {
        throw new TdApiError("not supported", { status: 404 });
      }),
      executePythonScript: exec,
    },
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

const happyReport = (over: Record<string, unknown> = {}) =>
  vi.fn(async () => ({
    stdout: JSON.stringify({
      path: "/project1/geo1",
      applied: [
        {
          param: "tx",
          mode: "expression",
          readback_mode: "EXPRESSION",
          readback_expr: "me.time.seconds",
        },
      ],
      warnings: [],
      probe: { has_mode: true, has_expr: true, has_bindExpr: true, ParMode_available: true },
      ...over,
    }),
  }));

// ---------------------------------------------------------------------------
// buildSetExprScript (pure, no IO)
// ---------------------------------------------------------------------------

describe("buildSetExprScript", () => {
  it("round-trips path and assignments through base64", () => {
    const payload = {
      path: "/project1/geo1",
      assignments: [{ param: "tx", mode: "expression", expr: "me.time.seconds" }],
    };
    const script = buildSetExprScript(payload);
    expect(decodePayload(script)).toEqual(payload);
  });

  it("flips par.mode via type(_par.mode) in the fallback (no bare ParMode NameError)", () => {
    const script = buildSetExprScript({ path: "/x", assignments: [] });
    // The exec fallback resolves the enum from the parameter itself, mirroring the
    // bridge's `type(par.mode)` fix — never the bare `ParMode.*` that NameError'd and
    // silently left the parameter in Constant mode.
    expect(script).toContain("type(_par.mode).EXPRESSION");
    expect(script).toContain("type(_par.mode).BIND");
    expect(script).toContain("type(_par.mode).CONSTANT");
    expect(script).not.toContain("ParMode.EXPRESSION");
  });

  it("captures stdout (second executePythonScript arg is true) via the bridge pattern", () => {
    // Verified structurally: the script uses `print(json.dumps(report))`
    const script = buildSetExprScript({ path: "/x", assignments: [] });
    expect(script).toContain("print(json.dumps(report))");
  });
});

// ---------------------------------------------------------------------------
// setParameterExpressionImpl
// ---------------------------------------------------------------------------

describe("setParameterExpressionImpl", () => {
  it("happy path — sends the right payload and returns a friendly summary", async () => {
    const exec = happyReport();
    const result = await setParameterExpressionImpl(fakeCtx(exec), {
      path: "/project1/geo1",
      assignments: [{ param: "tx", mode: "expression", expr: "me.time.seconds" }],
    });
    expect(result.isError).toBeFalsy();
    // Payload check
    const payload = decodePayload(scriptArg(exec));
    expect(payload.path).toBe("/project1/geo1");
    expect(payload.assignments[0]?.param).toBe("tx");
    expect(payload.assignments[0]?.mode).toBe("expression");
    expect(payload.assignments[0]?.expr).toBe("me.time.seconds");
    // Summary check
    const text = textOf(result);
    expect(text).toContain("Set 1 parameter(s)");
    expect(text).toContain("/project1/geo1");
  });

  it("happy path — bind mode sends bindExpr correctly", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        path: "/project1/geo1",
        applied: [{ param: "ty", mode: "bind", readback_mode: "BIND", readback_expr: "" }],
        warnings: [],
      }),
    }));
    const result = await setParameterExpressionImpl(fakeCtx(exec), {
      path: "/project1/geo1",
      assignments: [{ param: "ty", mode: "bind", expr: 'op("ctrl").par.Height' }],
    });
    expect(result.isError).toBeFalsy();
    const payload = decodePayload(scriptArg(exec));
    expect(payload.assignments[0]?.mode).toBe("bind");
    expect(payload.assignments[0]?.expr).toBe('op("ctrl").par.Height');
  });

  it("happy path — constant mode sends value correctly", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        path: "/project1/geo1",
        applied: [{ param: "tz", mode: "constant", readback_mode: "CONSTANT", readback_expr: "" }],
        warnings: [],
      }),
    }));
    const result = await setParameterExpressionImpl(fakeCtx(exec), {
      path: "/project1/geo1",
      assignments: [{ param: "tz", mode: "constant", value: 3.14 }],
    });
    expect(result.isError).toBeFalsy();
    const payload = decodePayload(scriptArg(exec));
    expect(payload.assignments[0]?.mode).toBe("constant");
    expect(payload.assignments[0]?.value).toBe(3.14);
  });

  it("summary includes warning count when warnings are present", async () => {
    const exec = happyReport({
      warnings: ["param 'tz': expr required for mode 'expression'"],
    });
    const result = await setParameterExpressionImpl(fakeCtx(exec), {
      path: "/project1/geo1",
      assignments: [{ param: "tx", mode: "expression", expr: "me.time.seconds" }],
    });
    const text = textOf(result);
    expect(text).toContain("1 warning(s)");
  });

  it("bridge fatal — returns isError:true and never throws", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        path: "/project1/missing",
        applied: [],
        warnings: [],
        fatal: "Node not found: /project1/missing",
      }),
    }));
    const result = await setParameterExpressionImpl(fakeCtx(exec), {
      path: "/project1/missing",
      assignments: [{ param: "tx", mode: "expression", expr: "0" }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Node not found");
  });

  it("network failure — returns isError:true and never throws", async () => {
    const exec = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const result = await setParameterExpressionImpl(fakeCtx(exec), {
      path: "/project1/geo1",
      assignments: [{ param: "tx", mode: "expression", expr: "0" }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connection refused");
  });

  it("reset — payload carries mode:'reset' and the script has a reset() branch", async () => {
    const exec = happyReport({
      applied: [{ param: "tx", mode: "reset", readback_mode: "CONSTANT", readback_expr: "" }],
    });
    const result = await setParameterExpressionImpl(fakeCtx(exec), {
      path: "/project1/geo1",
      assignments: [{ param: "tx", mode: "reset" }],
    });
    expect(result.isError).toBeFalsy();
    const script = scriptArg(exec);
    expect(script).toContain('getattr(_par, "reset"');
    const payload = decodePayload(script);
    expect(payload.assignments[0]?.mode).toBe("reset");
    expect(textOf(result)).toContain("Set 1 parameter(s)");
  });

  it("unbind — freezes eval() as a constant; report shows Constant readback", async () => {
    const exec = happyReport({
      applied: [{ param: "tx", mode: "unbind", readback_mode: "CONSTANT", readback_expr: "" }],
    });
    const result = await setParameterExpressionImpl(fakeCtx(exec), {
      path: "/project1/geo1",
      assignments: [{ param: "tx", mode: "unbind" }],
    });
    expect(result.isError).toBeFalsy();
    const script = scriptArg(exec);
    expect(script).toContain("_par.eval()");
    const payload = decodePayload(script);
    expect(payload.assignments[0]?.mode).toBe("unbind");
    expect(textOf(result)).toContain("Set 1 parameter(s)");
  });

  it("captures stdout — passes `true` as the second arg to executePythonScript", async () => {
    const exec = happyReport();
    await setParameterExpressionImpl(fakeCtx(exec), {
      path: "/project1/geo1",
      assignments: [{ param: "tx", mode: "expression", expr: "0" }],
    });
    const call = exec.mock.calls[0] as unknown[] | undefined;
    expect(call?.[1]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("setParameterExpressionSchema", () => {
  it("defaults mode to 'expression' when omitted", () => {
    const parsed = setParameterExpressionSchema.parse({
      path: "/x",
      assignments: [{ param: "tx", expr: "me.time.seconds" }],
    });
    expect(parsed.assignments[0]?.mode).toBe("expression");
  });

  it("rejects an empty assignments array", () => {
    expect(setParameterExpressionSchema.safeParse({ path: "/x", assignments: [] }).success).toBe(
      false,
    );
  });

  it("rejects a missing path", () => {
    expect(
      setParameterExpressionSchema.safeParse({
        assignments: [{ param: "tx", mode: "expression", expr: "0" }],
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown mode", () => {
    expect(
      setParameterExpressionSchema.safeParse({
        path: "/x",
        assignments: [{ param: "tx", mode: "dance" }],
      }).success,
    ).toBe(false);
  });

  it("accepts all five valid modes", () => {
    for (const mode of ["expression", "bind", "constant", "reset", "unbind"] as const) {
      expect(
        setParameterExpressionSchema.safeParse({
          path: "/x",
          assignments: [{ param: "tx", mode }],
        }).success,
      ).toBe(true);
    }
  });

  it("rejects a bogus mode:'clear'", () => {
    expect(
      setParameterExpressionSchema.safeParse({
        path: "/x",
        assignments: [{ param: "tx", mode: "clear" }],
      }).success,
    ).toBe(false);
  });

  it("accepts a boolean value for constant mode", () => {
    const parsed = setParameterExpressionSchema.safeParse({
      path: "/x",
      assignments: [{ param: "active", mode: "constant", value: true }],
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Endpoint-first path (per-param PATCH …/params/<p>/mode) — the rewire + ParMode fix
// ---------------------------------------------------------------------------
describe("setParameterExpressionImpl — endpoint-first", () => {
  it("loops setParameterMode once per assignment, aggregates applied[], and never calls exec", async () => {
    const setParameterMode = vi.fn(async (_path: string, param: string, mode: string) => ({
      path: "/project1/geo1",
      param,
      mode,
      readback_mode: mode.toUpperCase(),
      readback_expr: mode === "expression" ? "me.time.seconds" : "",
    }));
    const exec = vi.fn(async () => ({ stdout: "{}" }));
    const ctx = {
      client: { setParameterMode, executePythonScript: exec },
      logger: silentLogger,
    } as unknown as ToolContext;

    const result = await setParameterExpressionImpl(ctx, {
      path: "/project1/geo1",
      assignments: [
        { param: "tx", mode: "expression", expr: "me.time.seconds" },
        { param: "ty", mode: "constant", value: 1 },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(setParameterMode).toHaveBeenCalledTimes(2);
    expect(exec).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("Set 2 parameter(s)");
  });

  it("reset/unbind route straight to exec, never calling the per-param endpoint", async () => {
    const setParameterMode = vi.fn(async () => {
      throw new Error("endpoint should not be called for reset/unbind");
    });
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        path: "/project1/geo1",
        applied: [
          { param: "tx", mode: "reset", readback_mode: "CONSTANT", readback_expr: "" },
          { param: "ty", mode: "constant", readback_mode: "CONSTANT", readback_expr: "" },
        ],
        warnings: [],
      }),
    }));
    const ctx = {
      client: { setParameterMode, executePythonScript: exec },
      logger: silentLogger,
    } as unknown as ToolContext;

    const result = await setParameterExpressionImpl(ctx, {
      path: "/project1/geo1",
      assignments: [
        { param: "tx", mode: "reset" },
        { param: "ty", mode: "constant", value: 1 },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(setParameterMode).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledOnce();
    // The decoded payload carries the reset assignment.
    const payload = decodePayload(scriptArg(exec));
    expect(payload.assignments[0]?.mode).toBe("reset");
    expect(payload.assignments[1]?.mode).toBe("constant");
    expect(textOf(result)).toContain("Set 2 parameter(s)");
  });

  it("falls back to the whole-batch exec when the FIRST endpoint call hits TdApiError", async () => {
    const setParameterMode = vi.fn(async () => {
      throw new TdApiError("not supported", { status: 404 });
    });
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        path: "/project1/geo1",
        applied: [
          { param: "tx", mode: "expression", readback_mode: "EXPRESSION", readback_expr: "x" },
        ],
        warnings: [],
      }),
    }));
    const ctx = {
      client: { setParameterMode, executePythonScript: exec },
      logger: silentLogger,
    } as unknown as ToolContext;

    const result = await setParameterExpressionImpl(ctx, {
      path: "/project1/geo1",
      assignments: [{ param: "tx", mode: "expression", expr: "x" }],
    });

    expect(result.isError).toBeFalsy();
    expect(exec).toHaveBeenCalledOnce();
  });
});
