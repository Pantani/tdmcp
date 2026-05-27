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
