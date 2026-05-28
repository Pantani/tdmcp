import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  addCustomParametersImpl,
  addCustomParametersSchema,
  buildAddCustomParametersScript,
} from "../../src/tools/layer2/addCustomParameters.js";
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

interface Payload {
  comp: string;
  page: string;
  params: Array<{
    name: string;
    type: string;
    label?: string;
    default?: unknown;
    min?: number;
    max?: number;
    clamp?: boolean;
    menu_names?: string[];
    menu_labels?: string[];
    size?: number;
  }>;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

function textOf(result: Awaited<ReturnType<typeof addCustomParametersImpl>>): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("buildAddCustomParametersScript", () => {
  it("round-trips the page name and params array in the base64 payload", () => {
    const payload = {
      comp: "/project1/myComp",
      page: "Knobs",
      params: [
        { name: "Blur", type: "Float", min: 0, max: 100, clamp: true },
        { name: "Mode", type: "Menu", menu_names: ["A", "B"], menu_labels: ["Alpha", "Beta"] },
        { name: "Position", type: "XYZ", default: [0, 0, 0] },
      ],
    };
    const script = buildAddCustomParametersScript(payload);
    const decoded = decodePayload(script);
    expect(decoded.comp).toBe("/project1/myComp");
    expect(decoded.page).toBe("Knobs");
    expect(decoded.params).toHaveLength(3);
    expect(decoded.params[0]?.name).toBe("Blur");
    expect(decoded.params[0]?.type).toBe("Float");
    expect(decoded.params[0]?.min).toBe(0);
    expect(decoded.params[0]?.max).toBe(100);
    expect(decoded.params[0]?.clamp).toBe(true);
    expect(decoded.params[1]?.menu_names).toEqual(["A", "B"]);
    expect(decoded.params[1]?.menu_labels).toEqual(["Alpha", "Beta"]);
    expect(decoded.params[2]?.type).toBe("XYZ");
  });
});

describe("addCustomParametersImpl — happy path", () => {
  it("captures the exec script with correct payload and returns a friendly summary", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        capturedScript = body.script;
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              comp: "/project1/myComp",
              page: "Custom",
              created: [
                { name: "Speed", type: "Float", pars: ["Speed"] },
                { name: "Color", type: "RGB", pars: ["Colorr", "Colorg", "Colorb"] },
                { name: "Enable", type: "Toggle", pars: ["Enable"] },
              ],
              skipped: [],
              warnings: [],
            }),
          },
        });
      }),
    );

    const result = await addCustomParametersImpl(makeCtx(), {
      comp_path: "/project1/myComp",
      page: "Custom",
      params: [
        { name: "Speed", type: "Float", min: 0, max: 10 },
        { name: "Color", type: "RGB", default: [1, 0.5, 0] },
        { name: "Enable", type: "Toggle", default: true },
      ],
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Added 3 parameter(s)");
    expect(text).toContain('"Custom"');
    expect(text).toContain("/project1/myComp");

    // Verify the payload the TS side sent to TD
    const payload = decodePayload(capturedScript);
    expect(payload.comp).toBe("/project1/myComp");
    expect(payload.page).toBe("Custom");
    expect(payload.params).toHaveLength(3);
    expect(payload.params[0]?.name).toBe("Speed");
    expect(payload.params[0]?.type).toBe("Float");
    expect(payload.params[1]?.type).toBe("RGB");
    expect(payload.params[2]?.type).toBe("Toggle");
  });

  it("reports skipped duplicates in the summary", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              comp: "/project1/myComp",
              page: "Custom",
              created: [{ name: "Speed", type: "Float", pars: ["Speed"] }],
              skipped: [{ name: "Enable", reason: "parameter already exists" }],
              warnings: [],
            }),
          },
        }),
      ),
    );

    const result = await addCustomParametersImpl(makeCtx(), {
      comp_path: "/project1/myComp",
      page: "Custom",
      params: [
        { name: "Speed", type: "Float" },
        { name: "Enable", type: "Toggle" },
      ],
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("1 skipped");
  });

  it("carries the XYZ type and size fields through in the payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        capturedScript = body.script;
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              comp: "/project1/c",
              page: "Vectors",
              created: [
                { name: "Pos", type: "XYZ", pars: ["Posx", "Posy", "Posz"] },
                { name: "Scale", type: "Float", pars: ["Scalex", "Scaley"] },
              ],
              skipped: [],
              warnings: [],
            }),
          },
        });
      }),
    );

    await addCustomParametersImpl(makeCtx(), {
      comp_path: "/project1/c",
      page: "Vectors",
      params: [
        { name: "Pos", type: "XYZ", default: [0, 0, 0] },
        { name: "Scale", type: "Float", size: 2 },
      ],
    });

    const payload = decodePayload(capturedScript);
    expect(payload.params[0]?.type).toBe("XYZ");
    expect(payload.params[1]?.size).toBe(2);
  });

  it("carries menu_names and menu_labels for Menu params", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script: string };
        capturedScript = body.script;
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              comp: "/project1/c",
              page: "Custom",
              created: [{ name: "Mode", type: "Menu", pars: ["Mode"] }],
              skipped: [],
              warnings: [],
            }),
          },
        });
      }),
    );

    await addCustomParametersImpl(makeCtx(), {
      comp_path: "/project1/c",
      page: "Custom",
      params: [
        {
          name: "Mode",
          type: "Menu",
          menu_names: ["opt1", "opt2"],
          menu_labels: ["Option 1", "Option 2"],
          default: "opt1",
        },
      ],
    });

    const payload = decodePayload(capturedScript);
    const menuParam = payload.params[0];
    expect(menuParam?.menu_names).toEqual(["opt1", "opt2"]);
    expect(menuParam?.menu_labels).toEqual(["Option 1", "Option 2"]);
  });
});

describe("addCustomParametersImpl — fatal branch", () => {
  it("returns isError:true when report.fatal is set, and does not throw", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              comp: "/x",
              page: "Custom",
              created: [],
              skipped: [],
              warnings: [],
              fatal: "COMP not found: /x",
            }),
          },
        }),
      ),
    );

    const result = await addCustomParametersImpl(makeCtx(), {
      comp_path: "/x",
      page: "Custom",
      params: [{ name: "Speed", type: "Float" }],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMP not found: /x");
  });

  it("returns isError:true when TD is unreachable (network error), and does not throw", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));

    const result = await addCustomParametersImpl(makeCtx(), {
      comp_path: "/project1/myComp",
      page: "Custom",
      params: [{ name: "Speed", type: "Float" }],
    });

    expect(result.isError).toBe(true);
  });
});

describe("addCustomParametersSchema — bad input", () => {
  it("rejects an empty params array (min 1)", () => {
    expect(() =>
      addCustomParametersSchema.parse({
        comp_path: "/project1/myComp",
        page: "Custom",
        params: [],
      }),
    ).toThrow();
  });

  it("rejects an unknown type enum value", () => {
    expect(() =>
      addCustomParametersSchema.parse({
        comp_path: "/project1/myComp",
        page: "Custom",
        params: [{ name: "X", type: "Slider" }],
      }),
    ).toThrow();
  });

  it("rejects a missing comp_path", () => {
    expect(() =>
      addCustomParametersSchema.parse({
        page: "Custom",
        params: [{ name: "X", type: "Float" }],
      }),
    ).toThrow();
  });

  it("accepts all valid enum types without throwing", () => {
    const types = ["Float", "Int", "Toggle", "Menu", "Str", "Pulse", "RGB", "XYZ"] as const;
    for (const type of types) {
      expect(() =>
        addCustomParametersSchema.parse({
          comp_path: "/project1/c",
          // Menu requires options; every other type is valid bare.
          params: [{ name: "Test", type, ...(type === "Menu" ? { menu_names: ["a", "b"] } : {}) }],
        }),
      ).not.toThrow();
    }
  });

  it("rejects a Menu parameter with no menu_names", () => {
    expect(() =>
      addCustomParametersSchema.parse({
        comp_path: "/project1/c",
        params: [{ name: "Mode", type: "Menu" }],
      }),
    ).toThrow();
  });

  it("rejects menu_labels whose length differs from menu_names", () => {
    expect(() =>
      addCustomParametersSchema.parse({
        comp_path: "/project1/c",
        params: [{ name: "Mode", type: "Menu", menu_names: ["a", "b"], menu_labels: ["one"] }],
      }),
    ).toThrow();
  });

  it("uses 'Custom' as the default page name when omitted", () => {
    const parsed = addCustomParametersSchema.parse({
      comp_path: "/project1/c",
      params: [{ name: "X", type: "Float" }],
    });
    expect(parsed.page).toBe("Custom");
  });
});
