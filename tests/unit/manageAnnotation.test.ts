import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  manageAnnotationImpl,
  manageAnnotationSchema,
} from "../../src/tools/layer2/manageAnnotation.js";
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
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

interface AnnotationPayload {
  action: string;
  parent: string;
  text: string | null;
  name: string | null;
  node: string | null;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
}

/** Capture every /api/exec script, optionally returning a canned stdout. */
function captureExec(stdout = ""): { scripts: string[] } {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout } });
    }),
  );
  return { scripts };
}

/** Decode the base64 payload embedded in a captured script. */
function decodePayload(script: string): AnnotationPayload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no payload in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as AnnotationPayload;
}

describe("manage_annotation", () => {
  it("create: carries the box title + geometry into the payload and summarizes", async () => {
    const report = JSON.stringify({
      action: "create",
      created: "/project1/anno",
      pars_set: ["Text", "nodeX", "nodeY"],
      warnings: [],
    });
    const { scripts } = captureExec(report);
    const result = await manageAnnotationImpl(makeCtx(), {
      action: "create",
      parent_path: "/project1",
      text: "audio reactive chain",
      name: "notes",
      x: 100,
      y: 50,
      w: 400,
      h: 200,
    });
    expect(result.isError).toBeFalsy();

    const payload = decodePayload(scripts[0] ?? "");
    expect(payload.action).toBe("create");
    expect(payload.parent).toBe("/project1");
    expect(payload.text).toBe("audio reactive chain");
    expect(payload.name).toBe("notes");
    expect(payload).toMatchObject({ x: 100, y: 50, w: 400, h: 200 });

    // The script probes the Annotate COMP's title parameter rather than hardcoding it.
    expect(scripts[0]).toContain("annotateCOMP");
    expect(scripts[0]).toContain('("Text", "Title", "Header"');

    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("/project1/anno");
  });

  it("comment: carries node_path + text and reports the comment was set", async () => {
    const report = JSON.stringify({
      action: "comment",
      node: "/project1/noise1",
      comment: "base noise",
      commented: true,
      warnings: [],
    });
    const { scripts } = captureExec(report);
    const result = await manageAnnotationImpl(makeCtx(), {
      action: "comment",
      parent_path: "/project1",
      node_path: "/project1/noise1",
      text: "base noise",
    });
    expect(result.isError).toBeFalsy();

    const payload = decodePayload(scripts[0] ?? "");
    expect(payload.action).toBe("comment");
    expect(payload.node).toBe("/project1/noise1");
    expect(payload.text).toBe("base noise");
    // Comments are probed, not assumed.
    expect(scripts[0]).toContain('hasattr(_o, "comment")');
  });

  it("enclosed: carries the box node_path and asks for geometric enclosure", async () => {
    const report = JSON.stringify({
      action: "enclosed",
      box: "/project1/anno",
      enclosed: ["/project1/blur1", "/project1/noise1"],
      warnings: [],
    });
    const { scripts } = captureExec(report);
    const result = await manageAnnotationImpl(makeCtx(), {
      action: "enclosed",
      parent_path: "/project1",
      node_path: "/project1/anno",
    });
    expect(result.isError).toBeFalsy();

    const payload = decodePayload(scripts[0] ?? "");
    expect(payload.action).toBe("enclosed");
    expect(payload.node).toBe("/project1/anno");
    // Enclosure is geometric (node-rect center inside the box rect).
    expect(scripts[0]).toContain("nodeWidth");
    expect(scripts[0]).toContain("_center_in");

    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("encloses 2 op(s)");
  });

  it("returns isError (and does not throw) when the bridge reports fatal", async () => {
    const report = JSON.stringify({
      action: "create",
      warnings: [],
      fatal: "Parent COMP not found: /nope",
    });
    captureExec(report);
    const result = await manageAnnotationImpl(makeCtx(), {
      action: "create",
      parent_path: "/nope",
      text: "x",
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("Parent COMP not found");
  });

  it("pre-check: comment without node_path/text returns isError without hitting the bridge", async () => {
    const { scripts } = captureExec("{}");
    const result = await manageAnnotationImpl(makeCtx(), {
      action: "comment",
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
    // The bridge must not have been called.
    expect(scripts.length).toBe(0);
  });

  it("schema: rejects an unknown action and defaults parent_path", () => {
    expect(() => manageAnnotationSchema.parse({ action: "delete" })).toThrow();
    expect(manageAnnotationSchema.parse({ action: "list" }).parent_path).toBe("/project1");
  });
});
