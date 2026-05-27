import { describe, expect, it, vi } from "vitest";
import { createPhoneRemoteImpl } from "../../src/tools/layer2/createPhoneRemote.js";
import { manageCueImpl } from "../../src/tools/layer2/manageCue.js";
import { managePresetsImpl } from "../../src/tools/layer2/managePresets.js";
import { errorResult } from "../../src/tools/result.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

/** A context whose bridge call returns a fixed Python report on stdout. */
function ctxReturning(report: object): ToolContext {
  const exec = vi.fn(async () => ({ stdout: JSON.stringify(report) }));
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function textOf(result: { content: Array<{ type: string }> }): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// Regression: a `report.fatal` means nothing happened (COMP not found, not a COMP,
// …). These tools used to report it via jsonResult with no isError flag, so the
// tdmcp-agent CLI exited 0 and MCP clients saw a false success. They must set isError.
describe("hard failures (report.fatal) surface as isError, not a false success", () => {
  it("manage_cue on a missing COMP is an error", async () => {
    const ctx = ctxReturning({
      action: "list",
      comp: "/nope",
      fatal: "COMP not found: /nope",
      warnings: [],
    });
    const result = await manageCueImpl(ctx, { action: "list", comp_path: "/nope", duration: 2 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMP not found");
  });

  it("manage_presets on a missing COMP is an error", async () => {
    const ctx = ctxReturning({
      action: "list",
      comp: "/nope",
      fatal: "COMP not found: /nope",
      warnings: [],
    });
    const result = await managePresetsImpl(ctx, { action: "list", comp_path: "/nope" });
    expect(result.isError).toBe(true);
  });

  it("create_phone_remote on a non-COMP is an error", async () => {
    const ctx = ctxReturning({ comp: "/x", fatal: "/x is not a COMP.", warnings: [] });
    const result = await createPhoneRemoteImpl(ctx, { comp_path: "/x", port: 9981 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not a COMP");
  });
});

describe("errorResult", () => {
  it("sets isError and appends the structured payload when data is given", () => {
    const r = errorResult("boom", { a: 1 });
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("boom");
    expect(text).toContain('"a": 1');
  });

  it("omits the JSON fence when no data is given", () => {
    const r = errorResult("boom");
    expect((r.content[0] as { type: "text"; text: string }).text).toBe("boom");
  });
});
