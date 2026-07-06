import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  exportExternalizedTreeImpl,
  exportExternalizedTreeSchema,
  registerExportExternalizedTree,
} from "../../src/tools/library/exportExternalizedTree.js";
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

function decodePayload(script: string): Record<string, unknown> {
  const match = script.match(/b64decode\("([^"]+)"\)/);
  if (!match?.[1]) throw new Error(`No base64 payload in script: ${script.slice(0, 120)}`);
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as Record<string, unknown>;
}

function captureExec(report: unknown): { scripts: string[] } {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: JSON.stringify(report) } });
    }),
  );
  return { scripts };
}

describe("export_externalized_tree", () => {
  it("schema defaults recurse=true", () => {
    const parsed = exportExternalizedTreeSchema.parse({ comp_path: "/project1", out_dir: "/out" });
    expect(parsed.recurse).toBe(true);
  });

  it("passes comp_path, root_tox, and recurse in the payload", async () => {
    const cap = captureExec({
      root_tox: "/out/scene.tox",
      externalized: [{ node: "/project1/scene", tox: "/out/scene.tox" }],
      warnings: [],
    });
    await exportExternalizedTreeImpl(makeCtx(), {
      comp_path: "/project1/scene",
      out_dir: "/out",
      recurse: true,
    });
    expect(cap.scripts).toHaveLength(1);
    const payload = decodePayload(cap.scripts[0] ?? "");
    expect(payload.comp_path).toBe("/project1/scene");
    expect(payload.root_tox).toBe("/out/scene.tox");
    expect(payload.recurse).toBe(true);
  });

  it("returns the externalized node/tox list and count", async () => {
    captureExec({
      root_tox: "/out/scene.tox",
      externalized: [
        { node: "/project1/scene", tox: "/out/scene.tox" },
        { node: "/project1/scene/child", tox: "/out/scene/child.tox" },
      ],
      warnings: [],
    });
    const result = await exportExternalizedTreeImpl(makeCtx(), {
      comp_path: "/project1/scene",
      out_dir: "/out",
      recurse: true,
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      count: number;
      externalized: Array<{ node: string; tox: string }>;
      root_tox: string;
    };
    expect(structured.count).toBe(2);
    expect(structured.externalized[1]?.node).toBe("/project1/scene/child");
    expect(structured.root_tox).toBe("/out/scene.tox");
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Externalized 2 COMP(s)");
  });

  it("uses a custom name for the root .tox stem", async () => {
    const cap = captureExec({
      root_tox: "/out/myrig.tox",
      externalized: [{ node: "/project1", tox: "/out/myrig.tox" }],
      warnings: [],
    });
    await exportExternalizedTreeImpl(makeCtx(), {
      comp_path: "/project1",
      out_dir: "/out",
      name: "myrig",
      recurse: false,
    });
    const payload = decodePayload(cap.scripts[0] ?? "");
    expect(payload.root_tox).toBe("/out/myrig.tox");
    expect(payload.recurse).toBe(false);
  });

  it("returns an isError result (no throw) when the bridge reports fatal", async () => {
    captureExec({ externalized: [], warnings: [], fatal: "/project1/top1 is not a COMP" });
    const result = await exportExternalizedTreeImpl(makeCtx(), {
      comp_path: "/project1/top1",
      out_dir: "/out",
      recurse: true,
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("export_externalized_tree failed");
    expect(text).toContain("is not a COMP");
  });

  it("returns an isError result (no throw) when TouchDesigner is offline", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));
    const result = await exportExternalizedTreeImpl(makeCtx(), {
      comp_path: "/project1",
      out_dir: "/out",
      recurse: true,
    });
    expect(result.isError).toBe(true);
  });

  it("is registered as destructive", () => {
    const calls: Array<{ name: string; options: { annotations?: Record<string, boolean> } }> = [];
    const fakeServer = {
      registerTool(name: string, options: { annotations?: Record<string, boolean> }) {
        calls.push({ name, options });
      },
    };
    registerExportExternalizedTree(fakeServer as never, makeCtx());
    expect(calls[0]?.name).toBe("export_externalized_tree");
    expect(calls[0]?.options.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
