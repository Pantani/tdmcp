import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildGetParameterMenuScript,
  getParameterMenuImpl,
  getParameterMenuSchema,
} from "../../src/tools/layer3/getParameterMenu.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// Shared MSW server (onUnhandledRequest:"error" so any unexpected call fails)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Payload decode helper (mirrors readParameterModes.test.ts pattern)
// ---------------------------------------------------------------------------
interface Payload {
  path: string;
  keys: string[] | null;
  menu_only: boolean;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

type MenuEntry = {
  name: string;
  label?: string;
  style?: string;
  current?: string;
  menuNames: string[];
  menuLabels: string[];
};
type StructuredOut = {
  path: string;
  type: string;
  name: string;
  parameters: MenuEntry[];
  stale_catalog_warning?: string;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
describe("getParameterMenuSchema", () => {
  it("defaults menu_only to true", () => {
    const parsed = getParameterMenuSchema.parse({ path: "/project1/blur1" });
    expect(parsed.menu_only).toBe(true);
  });

  it("accepts a call with just a path", () => {
    expect(() => getParameterMenuSchema.parse({ path: "/project1/blur1" })).not.toThrow();
  });

  it("rejects a non-string path", () => {
    expect(() => getParameterMenuSchema.parse({ path: 42 })).toThrow();
  });

  it("rejects a call with no path (required field)", () => {
    expect(() => getParameterMenuSchema.parse({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildGetParameterMenuScript — pure payload round-trip
// ---------------------------------------------------------------------------
describe("buildGetParameterMenuScript", () => {
  it("round-trips the payload intact through base64", () => {
    const payload = { path: "/project1/blur1", keys: null, menu_only: true };
    const script = buildGetParameterMenuScript(payload);
    expect(decodePayload(script)).toEqual(payload);
  });

  it("reads menuNames / menuLabels via getattr guards", () => {
    const script = buildGetParameterMenuScript({
      path: "/project1/blur1",
      keys: null,
      menu_only: true,
    });
    expect(script).toContain('getattr(par, "menuNames", [])');
    expect(script).toContain('getattr(par, "menuLabels", [])');
    expect(script).toContain('_entry["current"] = str(par.eval())');
  });
});

// ---------------------------------------------------------------------------
// Happy path — a Menu parameter with names/labels/current
// ---------------------------------------------------------------------------
function execReturning(report: unknown, capture?: (script: string) => void) {
  return http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
    const body = (await request.json()) as { script: string };
    capture?.(body.script);
    return HttpResponse.json({
      ok: true,
      data: { result: null, stdout: JSON.stringify(report) },
    });
  });
}

describe("getParameterMenuImpl — happy path", () => {
  it("returns menuNames/menuLabels/current and counts menu params", async () => {
    let capturedScript = "";
    server.use(
      execReturning(
        {
          path: "/project1/blur1",
          type: "blurTOP",
          name: "blur1",
          parameters: [
            {
              name: "filtertype",
              label: "Filter Type",
              style: "Menu",
              menuNames: ["gaussian", "box"],
              menuLabels: ["Gaussian", "Box"],
              current: "gaussian",
            },
          ],
          warnings: [],
        },
        (s) => {
          capturedScript = s;
        },
      ),
    );

    const result = await getParameterMenuImpl(makeCtx(), {
      path: "/project1/blur1",
      keys: undefined,
      menu_only: true,
    });

    expect(result.isError).toBeFalsy();

    const payload = decodePayload(capturedScript);
    expect(payload.path).toBe("/project1/blur1");
    expect(payload.keys).toBeNull();
    expect(payload.menu_only).toBe(true);

    const sc = result.structuredContent as StructuredOut;
    expect(sc.parameters).toHaveLength(1);
    expect(sc.parameters[0]?.name).toBe("filtertype");
    expect(sc.parameters[0]?.menuNames).toEqual(["gaussian", "box"]);
    expect(sc.parameters[0]?.menuLabels).toEqual(["Gaussian", "Box"]);
    expect(sc.parameters[0]?.current).toBe("gaussian");
    expect(sc.stale_catalog_warning).toBeUndefined();

    const textBlock = result.content[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain("1 menu parameter(s)");
    expect(textBlock.text).toContain("/project1/blur1");
    expect(textBlock.text).toContain("blurTOP");
  });

  it("returns an empty menu (dynamic menu not yet populated) without erroring", async () => {
    server.use(
      execReturning({
        path: "/project1/moviein1",
        type: "moviefileinTOP",
        name: "moviein1",
        parameters: [
          {
            name: "file",
            label: "File",
            style: "File",
            menuNames: [],
            menuLabels: [],
          },
        ],
        warnings: [],
      }),
    );

    const result = await getParameterMenuImpl(makeCtx(), {
      path: "/project1/moviein1",
      keys: undefined,
      menu_only: false,
    });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as StructuredOut;
    expect(sc.parameters).toHaveLength(1);
    expect(sc.parameters[0]?.menuNames).toEqual([]);
    expect(sc.parameters[0]?.current).toBeUndefined();
  });

  it("passes keys and menu_only through the payload", async () => {
    let capturedScript = "";
    server.use(
      execReturning(
        {
          path: "/project1/blur1",
          type: "blurTOP",
          name: "blur1",
          parameters: [],
          warnings: [],
        },
        (s) => {
          capturedScript = s;
        },
      ),
    );

    await getParameterMenuImpl(makeCtx(), {
      path: "/project1/blur1",
      keys: ["filtertype"],
      menu_only: false,
    });

    const payload = decodePayload(capturedScript);
    expect(payload.keys).toEqual(["filtertype"]);
    expect(payload.menu_only).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fatal — node not found → isError, no throw
// ---------------------------------------------------------------------------
describe("getParameterMenuImpl — fatal / error paths", () => {
  it("returns isError when the node is not found and does not throw", async () => {
    server.use(
      execReturning({
        path: "/project1/nope",
        type: "",
        name: "",
        parameters: [],
        warnings: [],
        fatal: "Node not found: /project1/nope",
      }),
    );

    const result = await getParameterMenuImpl(makeCtx(), {
      path: "/project1/nope",
      keys: undefined,
      menu_only: true,
    });

    expect(result.isError).toBe(true);
    const textBlock = result.content[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain("not found");
  });

  it("returns isError when the bridge is unreachable and never throws", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));

    const result = await getParameterMenuImpl(makeCtx(), {
      path: "/project1/blur1",
      keys: undefined,
      menu_only: true,
    });

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stale-catalog fallback — exec disabled → bundled KB + loud warning
// ---------------------------------------------------------------------------
describe("getParameterMenuImpl — stale-catalog fallback", () => {
  it("falls back to the bundled catalog with a stale warning when exec is disabled", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json(
          { ok: false, error: { message: "raw Python exec is disabled on this bridge" } },
          { status: 403 },
        ),
      ),
      http.get(`${TD_BASE}/api/nodes/:seg`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            path: "/project1/blur1",
            type: "blurTOP",
            name: "blur1",
            parameters: {},
            inputs: [],
            outputs: [],
          },
        }),
      ),
    );

    // Stub the KB so the fallback has a menu param to surface, independent of
    // the (known-degenerate) bundled operator data.
    const ctx = makeCtx();
    ctx.knowledge.getOperator = ((): unknown => ({
      name: "blurTOP",
      parameters: [
        {
          name: "filtertype",
          label: "Filter Type",
          menuItems: ["gaussian", "box"],
          menuLabels: ["Gaussian", "Box"],
        },
        { name: "size", label: "Size" },
      ],
    })) as typeof ctx.knowledge.getOperator;

    const result = await getParameterMenuImpl(ctx, {
      path: "/project1/blur1",
      keys: undefined,
      menu_only: true,
    });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as StructuredOut;
    expect(sc.stale_catalog_warning).toBeDefined();
    expect(sc.parameters).toHaveLength(1);
    expect(sc.parameters[0]?.name).toBe("filtertype");
    expect(sc.parameters[0]?.menuNames).toEqual(["gaussian", "box"]);
    expect(sc.warnings.some((w) => /stale/i.test(w))).toBe(true);

    const textBlock = result.content[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain("stale");
  });
});
