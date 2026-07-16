import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { TdApiError } from "../../src/td-client/types.js";
import {
  insertOperatorAtSelectionImpl,
  insertOperatorAtSelectionSchema,
  registerInsertOperatorAtSelection,
} from "../../src/tools/layer2/insertOperatorAtSelection.js";
import type { ToolContext } from "../../src/tools/types.js";

const input = {
  type: "levelTOP",
  name: "inserted",
  parameters: { gain: 0.5 },
  expected_context: {
    owner_path: "/project1/network",
    selected_path: "/project1/network/source",
    current_path: "/project1/network/source",
  },
  idempotency_key: "wave7-insert-key-0001",
};

const report = {
  status: "applied" as const,
  idempotency_key: input.idempotency_key,
  context: input.expected_context,
  node: {
    path: "/project1/network/inserted",
    type: "levelTOP",
    name: "inserted",
    nodeX: 380,
    nodeY: 0,
    viewer: false,
  },
  before: {
    edges: [
      {
        from_path: "/project1/network/source",
        out_index: 0,
        to_path: "/project1/network/target",
        in_index: 0,
      },
    ],
  },
  after: {
    edges: [
      {
        from_path: "/project1/network/source",
        out_index: 0,
        to_path: "/project1/network/inserted",
        in_index: 0,
      },
      {
        from_path: "/project1/network/inserted",
        out_index: 0,
        to_path: "/project1/network/target",
        in_index: 0,
      },
    ],
  },
  rollback: { attempted: false, succeeded: true },
  warnings: [],
};

function ctx(insertOperatorAtSelection: (request: unknown) => Promise<unknown>): ToolContext {
  return { client: { insertOperatorAtSelection } } as unknown as ToolContext;
}

function text(result: Awaited<ReturnType<typeof insertOperatorAtSelectionImpl>>) {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
}

describe("insert_operator_at_selection", () => {
  it("sends the exact CAS/idempotency request through only the structured client", async () => {
    const insertOperatorAtSelection = vi.fn(async () => report);
    const executePythonScript = vi.fn();
    const context = {
      client: { insertOperatorAtSelection, executePythonScript },
    } as unknown as ToolContext;

    const result = await insertOperatorAtSelectionImpl(context, input);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(report);
    expect(text(result)).toContain("one downstream edge was replaced");
    expect(insertOperatorAtSelection).toHaveBeenCalledOnce();
    expect(insertOperatorAtSelection).toHaveBeenCalledWith(input);
    expect(executePythonScript).not.toHaveBeenCalled();
  });

  it("reports replayed receipts honestly", async () => {
    const result = await insertOperatorAtSelectionImpl(
      ctx(async () => ({ ...report, status: "replayed" })),
      input,
    );

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Replayed levelTOP");
    expect(result.structuredContent).toEqual({ ...report, status: "replayed" });
  });

  it("does not claim success for malformed bridge readback", async () => {
    const result = await insertOperatorAtSelectionImpl(
      ctx(async () => ({ ...report, after: { edges: [{ from_path: "relative" }] } })),
      input,
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("invalid insertion receipt");
    expect(result.structuredContent).toEqual({
      status: "failed",
      error: { code: "INVALID_BRIDGE_RESPONSE" },
    });
  });

  it("surfaces typed route/auth failures without raw-exec fallback", async () => {
    const insertOperatorAtSelection = vi.fn(async () => {
      throw new TdApiError("Unauthorized", { status: 401, apiCode: "unauthorized" });
    });
    const result = await insertOperatorAtSelectionImpl(ctx(insertOperatorAtSelection), input);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      status: "failed",
      error: {
        code: "TD_API",
        api_code: "unauthorized",
        status: 401,
        ambiguous: false,
      },
    });
    expect(insertOperatorAtSelection).toHaveBeenCalledOnce();
  });

  it("enforces strict bounded schema and mandatory editor CAS", () => {
    expect(insertOperatorAtSelectionSchema.safeParse(input).success).toBe(true);
    expect(
      insertOperatorAtSelectionSchema.safeParse({ ...input, expected_context: undefined }).success,
    ).toBe(false);
    expect(
      insertOperatorAtSelectionSchema.safeParse({ ...input, idempotency_key: "short" }).success,
    ).toBe(false);
    expect(insertOperatorAtSelectionSchema.safeParse({ ...input, type: "bad type" }).success).toBe(
      false,
    );
    expect(insertOperatorAtSelectionSchema.safeParse({ ...input, extra: true }).success).toBe(
      false,
    );
    expect(
      insertOperatorAtSelectionSchema.safeParse({
        ...input,
        parameters: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`par${index}`, index]),
        ),
      }).success,
    ).toBe(false);
  });

  it("registers a non-destructive structured mutation with no placeOPs/raw-code promise", () => {
    const registerTool = vi.fn();
    registerInsertOperatorAtSelection(
      { registerTool } as unknown as McpServer,
      ctx(async () => report),
    );

    const [name, config] = registerTool.mock.calls[0] as [
      string,
      { annotations: Record<string, boolean>; description: string; outputSchema: unknown },
    ];
    expect(name).toBe("insert_operator_at_selection");
    expect(config.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(config.outputSchema).toBeDefined();
    expect(config.description).toContain("ALLOW_EXEC=0");
    expect(config.description).toContain("never invokes raw Python");
    expect(config.description).toContain("mouse-interactive placeOPs");
  });
});
