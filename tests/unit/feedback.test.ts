import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkErrors } from "../../src/feedback/errorChecker.js";
import { verifyNetwork } from "../../src/feedback/networkVerifier.js";
import { checkPerformance } from "../../src/feedback/performanceMonitor.js";
import { capturePreview } from "../../src/feedback/previewCapture.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function client() {
  return new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 });
}

describe("feedback engine", () => {
  it("checkErrors returns no errors for a clean network", async () => {
    const report = await checkErrors(client(), "/project1/viz");
    expect(report.hasErrors).toBe(false);
  });

  it("checkErrors surfaces reported errors", async () => {
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/errors`, () =>
        HttpResponse.json({
          ok: true,
          data: { errors: [{ path: "/project1/viz/glsl1", message: "shader compile error" }] },
        }),
      ),
    );
    const report = await checkErrors(client(), "/project1/viz");
    expect(report.hasErrors).toBe(true);
    expect(report.errors[0]?.message).toContain("compile");
  });

  it("checkPerformance warns when a node exceeds the frame budget", async () => {
    server.use(
      http.get(`${TD_BASE}/api/network/:seg/performance`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            nodes: [{ path: "/project1/viz/glsl1", cook_time_ms: 50 }],
            total_cook_time_ms: 50,
          },
        }),
      ),
    );
    const report = await checkPerformance(client(), "/project1/viz", 60);
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.frameBudgetMs).toBeCloseTo(16.67, 1);
  });

  it("capturePreview returns a base64 image with mime type", async () => {
    const preview = await capturePreview(client(), "/project1/viz/out1", 320, 180);
    expect(preview.mimeType).toBe("image/png");
    expect(preview.base64.length).toBeGreaterThan(10);
    expect(preview.width).toBe(320);
  });

  it("verifyNetwork reports node and connection counts", async () => {
    const report = await verifyNetwork(client(), "/project1/viz");
    expect(report.nodeCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(report.issues)).toBe(true);
  });
});
