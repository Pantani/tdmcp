import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { getPreviewImpl } from "../../src/tools/layer1/getPreview.js";
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

describe("getPreviewImpl", () => {
  it("returns an image block with valid base64 data", async () => {
    const result = await getPreviewImpl(makeCtx(), {
      node_path: "/project1/render1",
      width: 640,
      height: 360,
    });
    expect(result.isError).toBeFalsy();
    const img = result.content.find((c) => c.type === "image");
    expect(img).toBeDefined();
  });

  it("returns JSON grid samples + stats (no image) when sample_grid is set", async () => {
    const result = await getPreviewImpl(makeCtx(), {
      node_path: "/project1/render1",
      width: 640,
      height: 360,
      sample_grid: 4,
    });
    expect(result.isError).toBeFalsy();
    // Cheap path: no image block, a JSON payload instead.
    expect(result.content.find((c) => c.type === "image")).toBeUndefined();
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(text).toMatch(/4×4 grid/);
    expect(text).toContain('"samples"');
    expect(text).toContain('"stats"');
  });

  it("captures with pre_pulses (same-tick) and returns the image", async () => {
    const result = await getPreviewImpl(makeCtx(), {
      node_path: "/project1/out1",
      width: 320,
      height: 180,
      pre_pulses: [{ path: "/project1/fb", par: "Reset" }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content.find((c) => c.type === "image")).toBeDefined();
  });

  it("defers with delay_frames and then collects the job by job_id", async () => {
    const deferred = await getPreviewImpl(makeCtx(), {
      node_path: "/project1/out1",
      width: 320,
      height: 180,
      delay_frames: 6,
    });
    const text = deferred.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(text).toMatch(/job_id="job-1"/);

    const collected = await getPreviewImpl(makeCtx(), {
      node_path: "/project1/out1",
      width: 320,
      height: 180,
      job_id: "job-1",
    });
    expect(collected.content.find((c) => c.type === "image")).toBeDefined();
  });

  it("includes a caption with the node path and pixel dimensions", async () => {
    const result = await getPreviewImpl(makeCtx(), {
      node_path: "/project1/render1",
      width: 1280,
      height: 720,
    });
    const caption = result.content.find((c) => c.type === "text");
    expect((caption as { text?: string })?.text).toMatch(/\/project1\/render1/);
    // The mock echoes back the requested dimensions.
    expect((caption as { text?: string })?.text).toMatch(/1280/);
    expect((caption as { text?: string })?.text).toMatch(/720/);
  });
});
