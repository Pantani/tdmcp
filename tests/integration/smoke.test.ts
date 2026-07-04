import { describe, expect, it } from "vitest";
import { assertSmoke, runSmoke } from "../../scripts/smoke.js";

describe("integration: offline smoke harness", () => {
  it("boots the server, speaks MCP, and degrades gracefully with no TouchDesigner", async () => {
    const report = await runSmoke();
    expect(report.tools).toBeGreaterThanOrEqual(31);
    expect(report.hasGetTdInfo).toBe(true);
    expect(report.infoDegradesGracefully).toBe(true);
    expect(() => assertSmoke(report)).not.toThrow();
  });
});
