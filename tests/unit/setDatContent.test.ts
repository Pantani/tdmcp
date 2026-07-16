import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { TdApiError } from "../../src/td-client/types.js";
import {
  buildSetDatContentScript,
  setDatContentImpl,
  setDatContentSchema,
} from "../../src/tools/layer3/setDatContent.js";
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

// Helpers for the vi.fn()-based tests (no MSW needed — guard fires before bridge)
interface Payload {
  dat: string;
  text: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: {
      // Endpoint-first: simulate an older bridge (404 -> TdApiError) so the impl
      // falls back to the exec path these legacy tests assert against.
      putDatText: vi.fn(async () => {
        throw new TdApiError("not supported", { status: 404 });
      }),
      executePythonScript: exec,
    },
    logger: silentLogger,
  } as unknown as ToolContext;
}

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------
describe("setDatContentSchema", () => {
  it("defaults confirm_wipe to false", () => {
    const parsed = setDatContentSchema.parse({ dat_path: "/x", text: "hello" });
    expect(parsed.confirm_wipe).toBe(false);
  });

  it("accepts confirm_wipe:true explicitly", () => {
    const parsed = setDatContentSchema.parse({ dat_path: "/x", text: "", confirm_wipe: true });
    expect(parsed.confirm_wipe).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Anti-wipe guardrail (pure TS, no bridge involved)
// ---------------------------------------------------------------------------
describe("anti-wipe guardrail", () => {
  it("returns isError for empty text when confirm_wipe is false and never calls the bridge", async () => {
    const exec = vi.fn();
    const result = await setDatContentImpl(fakeCtx(exec), {
      dat_path: "/project1/mydat",
      text: "",
      confirm_wipe: false,
    });
    expect(result.isError).toBe(true);
    const text = result.content[0];
    expect(text?.type).toBe("text");
    expect((text as { type: "text"; text: string }).text).toContain("confirm_wipe");
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns isError for whitespace-only text when confirm_wipe is false", async () => {
    const exec = vi.fn();
    const result = await setDatContentImpl(fakeCtx(exec), {
      dat_path: "/project1/mydat",
      text: "   \n\t  ",
      confirm_wipe: false,
    });
    expect(result.isError).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("allows empty text when confirm_wipe is true (reaches the bridge)", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        dat: "/project1/mydat",
        old_length: 42,
        new_length: 0,
        wiped: true,
        warnings: [],
      }),
    }));
    const result = await setDatContentImpl(fakeCtx(exec), {
      dat_path: "/project1/mydat",
      text: "",
      confirm_wipe: true,
    });
    expect(result.isError).toBeFalsy();
    expect(exec).toHaveBeenCalledOnce();
  });
});

describe("raw Python disabled", () => {
  it("rejects DAT text mutation before any bridge request", async () => {
    const putDatText = vi.fn();
    const executePythonScript = vi.fn();
    const ctx = {
      allowRawPython: false,
      client: { putDatText, executePythonScript },
      logger: silentLogger,
    } as unknown as ToolContext;

    const result = await setDatContentImpl(ctx, {
      dat_path: "/project1/callbacks",
      text: "def onFrameStart(frame): pass",
      confirm_wipe: false,
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: "text"; text: string }).text).toContain(
      "raw Python is disabled",
    );
    expect(putDatText).not.toHaveBeenCalled();
    expect(executePythonScript).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Happy path — payload round-trip and friendly summary
// ---------------------------------------------------------------------------
describe("setDatContentImpl (MSW bridge)", () => {
  it("carries dat_path and text through the payload and emits a friendly summary", async () => {
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
              dat: "/project1/mytext1",
              old_length: 10,
              new_length: 30,
              wiped: false,
              warnings: [],
            }),
          },
        });
      }),
    );

    const result = await setDatContentImpl(makeCtx(), {
      dat_path: "/project1/mytext1",
      text: "print('hello from TD')\n",
      confirm_wipe: false,
    });

    expect(result.isError).toBeFalsy();

    // Decode the embedded payload to assert what was sent to TD
    const payload = decodePayload(capturedScript);
    expect(payload.dat).toBe("/project1/mytext1");
    expect(payload.text).toBe("print('hello from TD')\n");

    // The friendly summary shows new_length, dat path, and old_length
    const textBlock = result.content[0];
    expect(textBlock?.type).toBe("text");
    const summary = (textBlock as { type: "text"; text: string }).text;
    expect(summary).toContain("30 char(s)");
    expect(summary).toContain("/project1/mytext1");
    expect(summary).toContain("was 10");
    expect(summary).not.toContain(", wiped");
  });

  it("appends ', wiped' to the summary when the DAT was intentionally cleared", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              dat: "/project1/mytext1",
              old_length: 55,
              new_length: 0,
              wiped: true,
              warnings: [],
            }),
          },
        }),
      ),
    );

    const result = await setDatContentImpl(makeCtx(), {
      dat_path: "/project1/mytext1",
      text: "",
      confirm_wipe: true,
    });

    expect(result.isError).toBeFalsy();
    const textBlock = result.content[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain(", wiped");
  });
});

// ---------------------------------------------------------------------------
// Fatal bridge error — isError, no throw
// ---------------------------------------------------------------------------
describe("fatal bridge error", () => {
  it("returns isError when bridge reports the path is not a DAT and does not throw", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              dat: "/project1/noise1",
              old_length: 0,
              new_length: 0,
              wiped: false,
              warnings: [],
              fatal: "/project1/noise1 is not a DAT.",
            }),
          },
        }),
      ),
    );

    const result = await setDatContentImpl(makeCtx(), {
      dat_path: "/project1/noise1",
      text: "some code",
      confirm_wipe: false,
    });

    expect(result.isError).toBe(true);
    const textBlock = result.content[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain("not a DAT");
  });

  it("returns isError when the DAT path is not found and does not throw", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: JSON.stringify({
              dat: "/project1/nope",
              old_length: 0,
              new_length: 0,
              wiped: false,
              warnings: [],
              fatal: "DAT not found: /project1/nope",
            }),
          },
        }),
      ),
    );

    const result = await setDatContentImpl(makeCtx(), {
      dat_path: "/project1/nope",
      text: "hello",
      confirm_wipe: false,
    });

    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildSetDatContentScript (unit — no bridge)
// ---------------------------------------------------------------------------
describe("buildSetDatContentScript", () => {
  it("round-trips the payload intact through base64", () => {
    const payload = { dat: "/project1/td", text: 'print("it works")\n' };
    const script = buildSetDatContentScript(payload);
    expect(decodePayload(script)).toEqual(payload);
  });

  it("handles strings with quotes, newlines, and unicode without breaking Python", () => {
    const payload = { dat: "/p/d", text: 'x = "hello"\n# üñícode\n' };
    const script = buildSetDatContentScript(payload);
    expect(decodePayload(script)).toEqual(payload);
  });
});
