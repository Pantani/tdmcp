import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  focusNetworkEditorImpl,
  focusNetworkEditorSchema,
} from "../../src/tools/layer2/focusNetworkEditor.js";
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
    logger: silentLogger,
  } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("focusNetworkEditorImpl", () => {
  it("frames the given operators and reports the pane", async () => {
    const result = await focusNetworkEditorImpl(makeCtx(), {
      paths: ["/project1/noise1", "/project1/blur1"],
      animate: true,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Framed 2 operator(s)");
    expect(textOf(result)).toContain("pane1");
    expect(result.structuredContent).toMatchObject({
      focused: ["/project1/noise1", "/project1/blur1"],
    });
  });

  it("passes action-aware options while preserving legacy defaults", async () => {
    const focusEditor = vi.fn().mockResolvedValue({
      operation_id: "opaque_operation_id",
      status: "applied",
      focused: ["/project1/noise1"],
      pane: "pane2",
      animate: false,
      final: {
        owner: "/project1",
        current: "/project1/noise1",
        selected: ["/project1/noise1"],
        viewport: null,
      },
    });
    const ctx = { client: { focusEditor }, logger: silentLogger } as unknown as ToolContext;

    const result = await focusNetworkEditorImpl(ctx, {
      paths: ["/project1/noise1"],
      animate: false,
      action: "edit",
      framing: "none",
      enabled: true,
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Framed 1 operator(s)");
    expect(focusEditor).toHaveBeenCalledWith(["/project1/noise1"], false, {
      action: "edit",
      framing: "none",
      enabled: true,
    });
  });

  it("polls a scheduled next-frame follow to terminal readback", async () => {
    let polls = 0;
    server.use(
      http.post(`${TD_BASE}/api/editor/focus`, async () =>
        HttpResponse.json({
          ok: true,
          data: {
            operation_id: "scheduled_focus_operation",
            status: "scheduled",
            animate: true,
            requested_paths: ["/project1/noise1"],
            resolved_paths: ["/project1/noise1"],
            missing_paths: [],
            focused: [],
            pane: "pane1",
            warnings: [],
          },
        }),
      ),
      http.get(`${TD_BASE}/api/editor/focus/scheduled_focus_operation`, () => {
        polls += 1;
        return HttpResponse.json({
          ok: true,
          data: {
            operation_id: "scheduled_focus_operation",
            status: "applied",
            animate: true,
            requested_paths: ["/project1/noise1"],
            resolved_paths: ["/project1/noise1"],
            missing_paths: [],
            focused: ["/project1/noise1"],
            pane: "pane1",
            final: {
              owner: "/project1",
              current: "/project1/noise1",
              selected: ["/project1/noise1"],
              viewport: { x: 10, y: 20, zoom: 0.75 },
            },
            warnings: [],
          },
        });
      }),
    );

    const result = await focusNetworkEditorImpl(makeCtx(), {
      paths: ["/project1/noise1"],
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Framed 1 operator(s)");
    expect(polls).toBe(1);
  });

  it("reports fail-closed suppression without claiming framing", async () => {
    const focusEditor = vi.fn().mockResolvedValue({
      operation_id: "opaque_operation_id",
      status: "suppressed",
      suppression_reason: "perform_mode",
      focused: [],
      pane: null,
      animate: true,
    });
    const ctx = { client: { focusEditor }, logger: silentLogger } as unknown as ToolContext;

    const result = await focusNetworkEditorImpl(ctx, {
      paths: ["/project1/noise1"],
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("safely suppressed (perform_mode)");
    expect(textOf(result)).not.toContain("Framed");
  });

  it("marks terminal bridge failure as an MCP error", async () => {
    const focusEditor = vi.fn().mockResolvedValue({
      operation_id: "opaque_operation_id",
      status: "failed",
      focused: [],
      pane: null,
      animate: true,
      warnings: ["readback mismatch"],
    });
    const ctx = { client: { focusEditor }, logger: silentLogger } as unknown as ToolContext;

    const result = await focusNetworkEditorImpl(ctx, {
      paths: ["/project1/noise1"],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ended as failed");
    expect(textOf(result)).not.toContain("Framed");
  });

  it("bounds and validates absolute operator paths", () => {
    expect(focusNetworkEditorSchema.safeParse({ paths: ["relative/noise1"] }).success).toBe(false);
    expect(
      focusNetworkEditorSchema.safeParse({
        paths: Array.from({ length: 65 }, (_, index) => `/project1/node${index}`),
      }).success,
    ).toBe(false);
    expect(focusNetworkEditorSchema.parse({ paths: ["/project1/noise1"] })).toMatchObject({
      animate: true,
      action: "view",
      framing: "auto",
      enabled: true,
    });
  });

  it("returns a friendly error when TouchDesigner is offline", async () => {
    server.use(http.post(`${TD_BASE}/api/editor/focus`, () => HttpResponse.error()));
    const result = await focusNetworkEditorImpl(makeCtx(), {
      paths: ["/project1/noise1"],
      animate: false,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cannot reach TouchDesigner");
  });
});
