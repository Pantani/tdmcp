import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createPoseSkeletonImpl,
  createPoseSkeletonSchema,
} from "../../src/tools/layer1/createPoseSkeleton.js";
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
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
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
      scripts.push(((await request.json()) as { script: string }).script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

function panelControls(
  scripts: string[],
): Array<{ name: string; type?: string; bind_to?: string[] }> {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  return (
    JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      controls: Array<{ name: string; type?: string; bind_to?: string[] }>;
    }
  ).controls;
}

function run(args: Partial<z.input<typeof createPoseSkeletonSchema>> = {}) {
  return createPoseSkeletonImpl(makeCtx(), createPoseSkeletonSchema.parse(args));
}

describe("create_pose_skeleton", () => {
  it("builds the render chain (Script SOP → Geo → Render → Null TOP) and captures a preview", async () => {
    const bodies = captureCreateBodies();
    const result = await run({ source: "synthetic", expose_controls: false });
    expect(result.isError).toBeFalsy();

    expect(bodies.find((b) => b.name === "posein")?.type).toBe("scriptCHOP");
    expect(bodies.find((b) => b.name === "geo")?.type).toBe("geometryCOMP");
    expect(bodies.find((b) => b.name === "skeleton")?.type).toBe("scriptSOP");
    expect(bodies.find((b) => b.name === "wire")?.type).toBe("lineMAT");
    expect(bodies.find((b) => b.name === "cam")?.type).toBe("cameraCOMP");
    expect(bodies.find((b) => b.name === "render")?.type).toBe("renderTOP");
    expect(bodies.find((b) => b.name === "out1")?.type).toBe("nullTOP");

    // Output is a TOP, so finalize captures a preview image.
    expect(result.content.some((c) => c.type === "image")).toBe(true);
    expect(textOf(result)).toContain("/project1/pose_skeleton/out1");
  });

  it("nests the skeleton SOP inside the Geometry COMP", async () => {
    const bodies = captureCreateBodies();
    await run({ source: "synthetic", expose_controls: false });
    const skeleton = bodies.find((b) => b.name === "skeleton");
    expect(skeleton?.parent_path).toMatch(/\/geo$/);
  });

  it("colours and sizes the bones through the Line MAT", async () => {
    const bodies = captureCreateBodies();
    await run({
      source: "synthetic",
      line_color: "#ff0000",
      line_width: 5,
      expose_controls: false,
    });
    const wire = bodies.find((b) => b.name === "wire");
    // Red → linenearcolorr ~1, others 0; width maps to widthnear.
    expect(wire?.parameters).toMatchObject({
      linenearcolorr: 1,
      linenearcolorg: 0,
      linenearcolorb: 0,
      widthnear: 5,
    });
  });

  it("installs a skeleton callback that draws bone polylines", async () => {
    const scripts = captureExecScripts();
    await run({ source: "synthetic", expose_controls: false });
    expect(scripts.some((s) => s.includes("appendPoly") && s.includes("BONES"))).toBe(true);
  });

  it("frames the figure with the camera distance and exposes live controls", async () => {
    const bodies = captureCreateBodies();
    const scripts = captureExecScripts();
    await run({ source: "synthetic", camera_distance: 5.5, expose_controls: true });
    expect(bodies.find((b) => b.name === "cam")?.parameters).toMatchObject({ tz: 5.5 });
    const controls = panelControls(scripts);
    const names = controls.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["LineWidth", "CamDistance", "LineColor"]));
    expect(controls.find((c) => c.name === "LineWidth")?.bind_to?.[0]).toMatch(/wire\.widthnear$/);
    expect(controls.find((c) => c.name === "CamDistance")?.bind_to?.[0]).toMatch(/cam\.tz$/);
  });

  it("references an existing pose CHOP via a Select CHOP for source='existing_chop'", async () => {
    const bodies = captureCreateBodies();
    await run({
      source: "existing_chop",
      existing_chop_path: "/project1/pose_tracking/pose",
      expose_controls: false,
    });
    const posein = bodies.find((b) => b.name === "posein");
    expect(posein?.type).toBe("selectCHOP");
    expect(posein?.parameters).toMatchObject({ chops: "/project1/pose_tracking/pose" });
  });
});
