import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { saveTdProjectImpl, saveTdProjectSchema } from "../../src/tools/layer3/saveTdProject.js";
import type { ToolContext } from "../../src/tools/types.js";

function makeCtx(client: object): ToolContext {
  return { client } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

describe("save_td_project", () => {
  it("applies the bounded timeout default", () => {
    expect(saveTdProjectSchema.parse({})).toEqual({ confirmation_timeout_ms: 30_000 });
    expect(() => saveTdProjectSchema.parse({ confirmation_timeout_ms: 4_999 })).toThrow();
    expect(() => saveTdProjectSchema.parse({ confirmation_timeout_ms: 120_001 })).toThrow();
  });

  it("calls the structured Save As method and reports verified success", async () => {
    const saveProject = vi.fn().mockResolvedValue({
      requested_path: "/shows/new.toe",
      final_path: "/shows/new.toe",
      saved: true,
      action_applied: true,
      verified_exists: true,
      decision: "Save",
      build: "2023.12000",
    });

    const result = await saveTdProjectImpl(makeCtx({ saveProject }), {
      path: "/shows/new.toe",
      confirmation_timeout_ms: 30_000,
    });

    expect(saveProject).toHaveBeenCalledWith({
      path: "/shows/new.toe",
      confirmation_timeout_ms: 30_000,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Saved TouchDesigner project to /shows/new.toe");
    expect(textOf(result)).toContain('"verified_exists": true');
  });

  it("reports fail-closed Keep as a non-mutating result", async () => {
    const result = await saveTdProjectImpl(
      makeCtx({
        saveProject: vi.fn().mockResolvedValue({
          requested_path: "/shows/existing.toe",
          final_path: null,
          saved: false,
          action_applied: false,
          verified_exists: true,
          decision: "Keep",
        }),
      }),
      { path: "/shows/existing.toe", confirmation_timeout_ms: 5_000 },
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("was not saved (Keep)");
    expect(textOf(result)).toContain('"action_applied": false');
  });

  it("rejects a claimed save whose filesystem postcondition is unverified", async () => {
    const result = await saveTdProjectImpl(
      makeCtx({
        saveProject: vi.fn().mockResolvedValue({
          requested_path: "/shows/new.toe",
          final_path: "/shows/new.toe",
          saved: true,
          action_applied: true,
          verified_exists: false,
          decision: "Save",
        }),
      }),
      { path: "/shows/new.toe", confirmation_timeout_ms: 30_000 },
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("did not confirm its complete postcondition");
    expect(textOf(result)).toContain('"verified_exists": false');
  });

  it("returns a friendly error when save fails", async () => {
    const result = await saveTdProjectImpl(
      makeCtx({ saveProject: vi.fn().mockRejectedValue(new Error("project.save failed")) }),
      { confirmation_timeout_ms: 30_000 },
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("project.save failed");
  });
});
