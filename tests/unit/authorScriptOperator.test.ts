import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdConnectionError } from "../../src/td-client/types.js";
import {
  authorScriptOperatorImpl,
  authorScriptOperatorSchema,
  buildAuthorScript,
  buildCallbacksText,
  normalizeParName,
} from "../../src/tools/layer2/authorScriptOperator.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  op_path: string;
  callbacks_text: string;
  custom_params: Array<{ name: string; default?: number | string | boolean }>;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function fakeCtx(opts: {
  createNode?: ReturnType<typeof vi.fn>;
  exec?: ReturnType<typeof vi.fn>;
  operatorExists?: (t: string) => boolean;
}): { ctx: ToolContext; createNode: ReturnType<typeof vi.fn>; exec: ReturnType<typeof vi.fn> } {
  const createNode =
    opts.createNode ??
    vi.fn(async (input: { parent_path: string; type: string; name?: string }) => ({
      path: `${input.parent_path}/${input.name ?? "script1"}`,
      type: input.type,
      name: input.name ?? "script1",
    }));
  const exec =
    opts.exec ??
    vi.fn(async (_script: string, _capture?: boolean) => ({
      stdout: JSON.stringify({
        op_path: "/project1/script1",
        callbacks_path: "/project1/script1_callbacks",
        params_added: [],
        warnings: [],
      }),
    }));
  const ctx = {
    client: { createNode, executePythonScript: exec },
    knowledge: { operatorExists: opts.operatorExists ?? (() => true) },
    logger: silentLogger,
  } as unknown as ToolContext;
  return { ctx, createNode, exec };
}

describe("normalizeParName", () => {
  it("strips non-alnum, leading-caps it, and falls back to 'Par'", () => {
    expect(normalizeParName("gain")).toBe("Gain");
    expect(normalizeParName("blur amount!")).toBe("Blur_amount_");
    expect(normalizeParName("1value")).toBe("P1value");
    expect(normalizeParName("!!!")).toBe("P___");
  });
});

describe("buildCallbacksText", () => {
  it("uses the per-family default body when on_cook_body is omitted", () => {
    expect(buildCallbacksText("CHOP", undefined)).toContain("appendChan('chan1')");
    expect(buildCallbacksText("DAT", undefined)).toContain("appendRow(['name', 'value'])");
    expect(buildCallbacksText("SOP", undefined)).toContain("appendPoint()");
    expect(buildCallbacksText("TOP", undefined)).toContain("copyNumpyArray");
  });

  it("emits the correct # type: hint per family", () => {
    expect(buildCallbacksText("CHOP", undefined)).toContain("# type: (scriptCHOP) -> None");
    expect(buildCallbacksText("DAT", undefined)).toContain("# type: (scriptDAT) -> None");
    expect(buildCallbacksText("SOP", undefined)).toContain("# type: (scriptSOP) -> None");
    expect(buildCallbacksText("TOP", undefined)).toContain("# type: (scriptTOP) -> None");
  });

  it("injects a custom on_cook_body and drops the default stub line (CHOP)", () => {
    const text = buildCallbacksText("CHOP", '    scriptOp.appendChan("custom")');
    expect(text).toContain('scriptOp.appendChan("custom")');
    expect(text).not.toContain("appendChan('chan1')");
  });

  it("for TOP, a custom body replaces the default copyNumpyArray line", () => {
    const text = buildCallbacksText("TOP", "    scriptOp.copyNumpyArray(my_frame)");
    expect(text).toContain("my_frame");
    expect(text).not.toContain("numpy.zeros");
  });
});

describe("authorScriptOperatorImpl", () => {
  it.each([
    ["CHOP", "scriptCHOP", "appendChan('chan1')"],
    ["DAT", "scriptDAT", "appendRow(['name', 'value'])"],
    ["SOP", "scriptSOP", "appendPoint()"],
    ["TOP", "scriptTOP", "copyNumpyArray"],
  ] as const)("creates the right operator type for %s and embeds its stub", async (family, type, marker) => {
    const { ctx, createNode, exec } = fakeCtx({});
    const args = authorScriptOperatorSchema.parse({ family, parent_path: "/project1" });
    const result = await authorScriptOperatorImpl(ctx, args);
    expect(result.isError).toBeFalsy();
    expect(createNode).toHaveBeenCalledTimes(1);
    expect(createNode.mock.calls[0]?.[0]).toMatchObject({ parent_path: "/project1", type });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[1]).toBe(true);
    const script = exec.mock.calls[0]?.[0] as string;
    const payload = decodePayload(script);
    expect(payload.callbacks_text).toContain(marker);
  });

  it("payload encodes custom_params with appendFloat/Toggle/Str defaults", async () => {
    const { ctx, exec } = fakeCtx({});
    const args = authorScriptOperatorSchema.parse({
      family: "CHOP",
      custom_params: [
        { name: "Gain", default: 1.5 },
        { name: "Mode", default: "a" },
        { name: "On", default: true },
      ],
    });
    await authorScriptOperatorImpl(ctx, args);
    const script = exec.mock.calls[0]?.[0] as string;
    const payload = decodePayload(script);
    expect(payload.custom_params).toEqual([
      { name: "Gain", default: 1.5 },
      { name: "Mode", default: "a" },
      { name: "On", default: true },
    ]);
    // The Python body branches on the JS type — these append* calls must be present.
    expect(script).toContain("appendFloat");
    expect(script).toContain("appendStr");
    expect(script).toContain("appendToggle");
  });

  it("injects an on_cook_body and drops the default chan1 stub", async () => {
    const { ctx, exec } = fakeCtx({});
    const args = authorScriptOperatorSchema.parse({
      family: "CHOP",
      on_cook_body: '    scriptOp.appendChan("custom")',
    });
    await authorScriptOperatorImpl(ctx, args);
    const payload = decodePayload(exec.mock.calls[0]?.[0] as string);
    expect(payload.callbacks_text).toContain('scriptOp.appendChan("custom")');
    expect(payload.callbacks_text).not.toContain("appendChan('chan1')");
  });

  it("returns the callbacks_path from the parsed report on success", async () => {
    const { ctx } = fakeCtx({});
    const result = await authorScriptOperatorImpl(
      ctx,
      authorScriptOperatorSchema.parse({ family: "CHOP" }),
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("/project1/script1_callbacks");
  });

  it("surfaces a knowledge-base miss as a warning (parity with createTdNode)", async () => {
    const { ctx } = fakeCtx({ operatorExists: () => false });
    const result = await authorScriptOperatorImpl(
      ctx,
      authorScriptOperatorSchema.parse({ family: "TOP" }),
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("scriptTOP");
    expect(textOf(result)).toMatch(/not found in the knowledge base/);
  });

  it("never throws when the bridge is offline — and skips the exec call", async () => {
    const exec = vi.fn();
    const createNode = vi.fn(async () => {
      throw new TdConnectionError("connection refused");
    });
    const { ctx } = fakeCtx({ createNode, exec });
    const result = await authorScriptOperatorImpl(
      ctx,
      authorScriptOperatorSchema.parse({ family: "CHOP" }),
    );
    expect(result.isError).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns isError when the bridge report carries a fatal field", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        op_path: "/project1/script1",
        callbacks_path: "",
        params_added: [],
        warnings: [],
        fatal: "Script op not found: /project1/script1",
      }),
    }));
    const { ctx } = fakeCtx({ exec });
    const result = await authorScriptOperatorImpl(
      ctx,
      authorScriptOperatorSchema.parse({ family: "CHOP" }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Script op not found");
  });
});

describe("buildAuthorScript", () => {
  it("base64-roundtrips the payload and dispatches by Python type", () => {
    const script = buildAuthorScript({
      op_path: "/project1/script1",
      callbacks_text: "# stub",
      custom_params: [{ name: "Gain", default: 1 }],
    });
    expect(decodePayload(script).op_path).toBe("/project1/script1");
    expect(script).toContain("isinstance(_dflt, bool)");
    expect(script).toContain("isinstance(_dflt, (int, float))");
    expect(script).toContain("isinstance(_dflt, str)");
  });
});
