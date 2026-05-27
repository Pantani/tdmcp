import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { setupOutputImpl } from "../../src/tools/layer1/setupOutput.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

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

function captureCreateBodies(): CreatedNodeBody[] {
  const bodies: CreatedNodeBody[] = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as CreatedNodeBody;
      bodies.push(body);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
  );
  return bodies;
}

function captureExecScripts(): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

describe("setupOutputImpl", () => {
  it("creates a windowCOMP and sets winop/winw/winh via a Python exec for the window type", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    const result = await setupOutputImpl(makeCtx(), {
      source_path: "/project1/render1",
      output_type: "window",
      resolution: "1080p",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(bodies.find((b) => b.name === "window_out")?.type).toBe("windowCOMP");
    const script = scripts.find((s) => s.includes("winop"));
    expect(script).toBeDefined();
    expect(script).toContain("/project1/render1");
    // 1080p → 1920 × 1080.
    expect(script).toContain("1920");
    expect(script).toContain("1080");
  });

  it("creates a selectTOP referencing the source, then connects to the ndioutTOP for NDI", async () => {
    const bodies = captureCreateBodies();
    const result = await setupOutputImpl(makeCtx(), {
      source_path: "/project1/render1",
      output_type: "ndi",
      resolution: "1080p",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    // Select TOP bridges the cross-COMP source reference.
    const sel = bodies.find((b) => b.name === "ndi_src");
    expect(sel?.type).toBe("selectTOP");
    expect(bodies.find((b) => b.name === "ndi_out")?.type).toBe("ndioutTOP");
  });

  it("includes source_path and output_type in the JSON summary", async () => {
    captureCreateBodies();
    captureExecScripts();
    const result = await setupOutputImpl(makeCtx(), {
      source_path: "/project1/master",
      output_type: "window",
      resolution: "720p",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/master");
    expect(text).toContain("window");
  });
});
