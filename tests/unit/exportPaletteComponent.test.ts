import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  exportPaletteComponentImpl,
  exportPaletteComponentSchema,
} from "../../src/tools/library/exportPaletteComponent.js";
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

let lastScript = "";

// Mirror the bridge envelope the default tdMock uses: { ok, data: { result, stdout } }.
function captureExec(report: unknown) {
  return http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
    const body = (await request.json()) as { script: string };
    lastScript = body.script;
    return HttpResponse.json({
      ok: true,
      data: { result: null, stdout: `${JSON.stringify(report)}\n` },
    });
  });
}

function decodePayload(script: string): Record<string, unknown> {
  const m = script.match(/b64decode\("([^"]+)"\)/);
  if (!m?.[1]) throw new Error("no payload in script");
  return JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
}

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.map((c) => c.text ?? "").join("\n");
}

describe("export_palette_component", () => {
  it("defaults category to tdmcp and palette_dir to empty", () => {
    const parsed = exportPaletteComponentSchema.parse({ comp_path: "/project1/base1" });
    expect(parsed.category).toBe("tdmcp");
    expect(parsed.palette_dir).toBe("");
    expect(parsed.name).toBeUndefined();
  });

  it("saves the tox into the palette and reports the saved path + payload", async () => {
    server.use(
      captureExec({
        saved: "/home/me/palette/tdmcp/foo.tox",
        palette_root: "/home/me/palette",
        resolver_used: "app.userPaletteFolder",
        category: "tdmcp",
        name: "foo",
        size: 1234,
        warnings: [],
        fatal: null,
      }),
    );
    const res = await exportPaletteComponentImpl(makeCtx(), {
      comp_path: "/project1/base1",
      name: "foo",
      category: "tdmcp",
      palette_dir: "",
    });
    expect(res.isError).toBeFalsy();

    const payload = decodePayload(lastScript);
    expect(payload.comp_path).toBe("/project1/base1");
    expect(payload.name).toBe("foo");
    expect(payload.category).toBe("tdmcp");
    expect(payload.palette_dir).toBe("");

    const text = textOf(res);
    expect(text).toContain("/home/me/palette/tdmcp/foo.tox");
    expect(text).toContain("app.userPaletteFolder");
  });

  it("derives the file stem from comp_path when name is omitted", async () => {
    server.use(
      captureExec({
        saved: "/home/me/palette/tdmcp/base1.tox",
        palette_root: "/home/me/palette",
        resolver_used: "app.userPaletteFolder",
        category: "tdmcp",
        name: "base1",
        size: 99,
        warnings: ["app.preferencesFolder failed: nope"],
        fatal: null,
      }),
    );
    const res = await exportPaletteComponentImpl(makeCtx(), {
      comp_path: "/project1/base1",
      category: "tdmcp",
      palette_dir: "",
    });
    expect(res.isError).toBeFalsy();
    const payload = decodePayload(lastScript);
    expect(payload.name).toBe("base1");
    expect(textOf(res)).toContain("1 warning(s)");
  });

  it("forwards an explicit palette_dir in the payload", async () => {
    server.use(
      captureExec({
        saved: "/custom/pal/lib/bar.tox",
        palette_root: "/custom/pal",
        resolver_used: "palette_dir",
        category: "lib",
        name: "bar",
        size: 42,
        warnings: [],
        fatal: null,
      }),
    );
    const res = await exportPaletteComponentImpl(makeCtx(), {
      comp_path: "/project1/bar",
      name: "bar",
      category: "lib",
      palette_dir: "/custom/pal",
    });
    expect(res.isError).toBeFalsy();
    const payload = decodePayload(lastScript);
    expect(payload.palette_dir).toBe("/custom/pal");
    expect(payload.category).toBe("lib");
  });

  it("returns an error when the bridge reports fatal (never throws)", async () => {
    server.use(
      captureExec({
        saved: null,
        palette_root: null,
        resolver_used: null,
        warnings: [],
        fatal: "COMP not found: /nope",
      }),
    );
    const res = await exportPaletteComponentImpl(makeCtx(), {
      comp_path: "/nope",
      name: "",
      category: "tdmcp",
      palette_dir: "",
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("COMP not found");
  });

  it("returns an error when the bridge is offline (never throws)", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));
    const res = await exportPaletteComponentImpl(makeCtx(), {
      comp_path: "/project1/base1",
      name: "",
      category: "tdmcp",
      palette_dir: "",
    });
    expect(res.isError).toBe(true);
  });
});
