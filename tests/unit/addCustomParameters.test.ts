import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  addCustomParametersImpl,
  addCustomParametersSchema,
} from "../../src/tools/layer2/addCustomParameters.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

const report = (over: Record<string, unknown> = {}) => ({
  status: "applied",
  comp_path: "/project1/sys",
  results: [{ index: 0, action: "add", status: "applied" }],
  rollback: { attempted: false, succeeded: true },
  warnings: [],
  request_fingerprint: "a".repeat(64),
  undo_label: "MCP custom_parameter_lifecycle /project1/sys",
  ...over,
});

function fakeCtx(apply: ReturnType<typeof vi.fn>, exec = vi.fn()): ToolContext {
  return {
    client: {
      applyCustomParameterLifecycle: apply,
      executePythonScript: exec,
    },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

const legacyArgs = (over: Record<string, unknown> = {}) =>
  addCustomParametersSchema.parse({
    comp_path: "/project1/sys",
    params: [
      { name: "Speed", type: "Float", default: 0.5, min: 0, max: 2 },
      { name: "Blur", type: "Int", default: 4, min: 0, max: 64, clamp: true },
    ],
    ...over,
  });

describe("addCustomParametersImpl", () => {
  it("preserves the legacy page+params call and capitalizes its page", async () => {
    const apply = vi.fn(async () => report());
    const exec = vi.fn();
    const result = await addCustomParametersImpl(
      fakeCtx(apply, exec),
      legacyArgs({ page: "controls" }),
    );

    expect(result.isError).toBeFalsy();
    expect(apply).toHaveBeenCalledWith(
      "/project1/sys",
      expect.objectContaining({ page: "Controls", params: expect.any(Array) }),
    );
    expect(exec).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ status: "applied" });
    expect(textOf(result)).toContain("1 operation(s) applied");
  });

  it("sends a bounded lifecycle union in one structured request", async () => {
    const apply = vi.fn(async (_path: string, _body: unknown) =>
      report({ results: [{ action: "edit_parameter", status: "applied" }] }),
    );
    const args = addCustomParametersSchema.parse({
      comp_path: "/project1/sys",
      idempotency_key: "retry_token_123456",
      operations: [
        {
          action: "edit_parameter",
          name: "Gain",
          fields: { label: "Master gain", mode: "EXPRESSION", expression: "1 + 2" },
        },
        { action: "sort_page", page: "Custom", order: ["Gain", "Colorr"] },
      ],
    });

    await addCustomParametersImpl(fakeCtx(apply), args);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[1]).toEqual({
      operations: args.operations,
      idempotency_key: "retry_token_123456",
    });
  });

  it("returns HELD EXPORT as an MCP error with the structured typed code", async () => {
    const held = report({
      status: "held",
      results: [],
      error: {
        code: "unsupported_parameter_mode",
        message: "EXPORT is HELD until reversible export-source semantics are proved",
      },
    });
    const apply = vi.fn(async () => held);
    const args = addCustomParametersSchema.parse({
      comp_path: "/project1/sys",
      operations: [{ action: "edit_parameter", name: "Gain", fields: { mode: "EXPORT" } }],
    });

    const result = await addCustomParametersImpl(fakeCtx(apply), args);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("unsupported_parameter_mode");
    expect(result.structuredContent).toMatchObject({ status: "held" });
  });

  it("surfaces exact rollback and partial failure reports as errors", async () => {
    for (const status of ["rolled_back", "partial_failure"] as const) {
      const apply = vi.fn(async () =>
        report({
          status,
          results: [],
          rollback: { attempted: true, succeeded: status === "rolled_back" },
          error: {
            code: status === "rolled_back" ? "mutation_failed" : "rollback_failed",
            message: "boom",
          },
        }),
      );
      const result = await addCustomParametersImpl(fakeCtx(apply), legacyArgs());
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ status });
    }
  });

  it("turns bridge failures into an isError result without raw-exec fallback", async () => {
    const exec = vi.fn();
    const apply = vi.fn(async () => {
      throw new Error("connection refused");
    });

    const result = await addCustomParametersImpl(fakeCtx(apply, exec), legacyArgs());

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connection refused");
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("addCustomParametersSchema", () => {
  it("keeps legacy RGB/XYZ and accepts every live-proven richer style", () => {
    const styles = [
      "Float",
      "Int",
      "Toggle",
      "Menu",
      "Str",
      "Pulse",
      "Header",
      "OP",
      "TOP",
      "File",
      "Folder",
      "XYZW",
      "RGBA",
      "RGB",
      "XYZ",
    ];
    const params = styles.map((type, index) => ({
      name: `P${index}`,
      type,
      ...(type === "Menu" ? { menu_names: ["one"] } : {}),
    }));
    expect(addCustomParametersSchema.safeParse({ comp_path: "/c", params }).success).toBe(true);
  });

  it("defaults the legacy page and preserves vector defaults", () => {
    const parsed = addCustomParametersSchema.parse({
      comp_path: "/c",
      params: [
        { name: "Tint", type: "RGB", default: [1, 0, 0] },
        { name: "Position", type: "XYZ", default: [1, 2, 3] },
      ],
    });
    expect(parsed.page).toBe("Custom");
    expect(parsed.params?.[0]?.default).toEqual([1, 0, 0]);
  });

  it("requires exactly one of legacy params or operations", () => {
    expect(addCustomParametersSchema.safeParse({ comp_path: "/c" }).success).toBe(false);
    expect(
      addCustomParametersSchema.safeParse({
        comp_path: "/c",
        params: [{ name: "A", type: "Float" }],
        operations: [{ action: "delete_parameter", name: "A" }],
      }).success,
    ).toBe(false);
  });

  it("enforces Menu pairing, numeric bounds, and style-specific size", () => {
    expect(
      addCustomParametersSchema.safeParse({
        comp_path: "/c",
        params: [{ name: "Mode", type: "Menu" }],
      }).success,
    ).toBe(false);
    expect(
      addCustomParametersSchema.safeParse({
        comp_path: "/c",
        params: [{ name: "Mode", type: "Menu", menu_names: ["a", "b"], menu_labels: ["A"] }],
      }).success,
    ).toBe(false);
    expect(
      addCustomParametersSchema.safeParse({
        comp_path: "/c",
        params: [{ name: "Gain", type: "Float", min: 2, max: 1 }],
      }).success,
    ).toBe(false);
    expect(
      addCustomParametersSchema.safeParse({
        comp_path: "/c",
        params: [{ name: "Enabled", type: "Toggle", size: 2 }],
      }).success,
    ).toBe(false);
  });

  it("bounds definitions, menu options, operations, paths, and idempotency keys", () => {
    expect(
      addCustomParametersSchema.safeParse({
        comp_path: "relative",
        params: [{ name: "A", type: "Float" }],
      }).success,
    ).toBe(false);
    expect(
      addCustomParametersSchema.safeParse({
        comp_path: "/c",
        params: Array.from({ length: 65 }, (_, index) => ({ name: `P${index}`, type: "Float" })),
      }).success,
    ).toBe(false);
    expect(
      addCustomParametersSchema.safeParse({
        comp_path: "/c",
        params: [{ name: "A", type: "Float" }],
        idempotency_key: "short",
      }).success,
    ).toBe(false);
  });

  it("validates expression/bind requirements and all promoted lifecycle actions", () => {
    expect(
      addCustomParametersSchema.safeParse({
        comp_path: "/c",
        operations: [{ action: "edit_parameter", name: "Gain", fields: { mode: "EXPRESSION" } }],
      }).success,
    ).toBe(false);
    expect(
      addCustomParametersSchema.safeParse({
        comp_path: "/c",
        operations: [
          { action: "add", page: "Custom", params: [{ name: "Gain", type: "Float" }] },
          {
            action: "edit_parameter",
            name: "Gain",
            fields: { mode: "BIND", bind_expression: "me.par.Source" },
          },
          { action: "delete_parameter", name: "Old" },
          { action: "sort_page", page: "Custom", order: ["Gain"] },
          { action: "rename_page", page: "Custom", new_name: "Controls" },
          { action: "delete_page", page: "Obsolete" },
        ],
      }).success,
    ).toBe(true);
  });
});
