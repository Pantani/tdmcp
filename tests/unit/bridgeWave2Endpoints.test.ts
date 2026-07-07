import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { TdApiError, TdConnectionError, TdTimeoutError } from "../../src/td-client/types.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(timeoutMs = 2000): TouchDesignerClient {
  return new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs });
}

/** Force a timeout via a fetch that never resolves until aborted. */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });

// ---------------------------------------------------------------------------
// saveNode — POST /api/nodes/<path>/save (COMP -> .tox, TOP -> image)
// ---------------------------------------------------------------------------
describe("TouchDesignerClient.saveNode", () => {
  const SAVE_REPORT = {
    path: "/project1/render1",
    saved: "/tmp/frame.png",
    has_dimensions: true,
    width: 1920,
    height: 1080,
  };

  it("prefers POST /api/nodes/<path>/save and returns the validated shape", async () => {
    let saveHits = 0;
    let execCalls = 0;
    server.use(
      http.post(`${TD_BASE}/api/nodes/:seg/save`, async ({ request }) => {
        saveHits += 1;
        const body = (await request.json()) as { file: string; create_folders: boolean };
        expect(body.file).toBe("/tmp/frame.png");
        expect(body.create_folders).toBe(true);
        return HttpResponse.json({ ok: true, data: SAVE_REPORT });
      }),
      http.post(`${TD_BASE}/api/exec`, () => {
        execCalls += 1;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const result = await makeClient().saveNode("/project1/render1", "/tmp/frame.png");
    expect(saveHits).toBe(1);
    expect(execCalls).toBe(0);
    expect(result.saved).toBe("/tmp/frame.png");
    expect(result.has_dimensions).toBe(true);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
  });

  it("falls back to /api/exec when the endpoint is absent (404), same shape", async () => {
    // tdMock defaults the save route to 404. Stub /api/exec to print the report.
    let execCalls = 0;
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        execCalls += 1;
        const body = (await request.json()) as { script: string };
        scripts.push(body.script);
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: `${JSON.stringify({
              path: "/project1/base1",
              saved: "/tmp/base1.tox",
              has_dimensions: false,
            })}\n`,
          },
        });
      }),
    );

    const result = await makeClient().saveNode("/project1/base1", "/tmp/base1.tox");
    expect(execCalls).toBe(1);
    // The exec fallback runs op.save(...) with the requested file.
    expect(scripts[0]).toContain(".save(");
    expect(result.saved).toBe("/tmp/base1.tox");
    expect(result.has_dimensions).toBe(false);
  });

  it("surfaces a fatal from the exec fallback as TdApiError", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: `${JSON.stringify({ fatal: "save: node not found: /x" })}\n`,
          },
        }),
      ),
    );
    await expect(makeClient().saveNode("/x", "/tmp/x.png")).rejects.toBeInstanceOf(TdApiError);
  });

  it("raises TdApiError on a validation 400 from a current bridge (no exec fallback)", async () => {
    let execCalls = 0;
    server.use(
      http.post(`${TD_BASE}/api/nodes/:seg/save`, () =>
        HttpResponse.json(
          { ok: false, error: { message: "save: node not found." } },
          { status: 400 },
        ),
      ),
      http.post(`${TD_BASE}/api/exec`, () => {
        execCalls += 1;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await expect(makeClient().saveNode("/x", "/tmp/x.png")).rejects.toBeInstanceOf(TdApiError);
    expect(execCalls).toBe(0);
  });

  it("raises TdApiError on a 5xx from the endpoint", async () => {
    server.use(
      http.post(`${TD_BASE}/api/nodes/:seg/save`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );
    await expect(makeClient().saveNode("/x", "/tmp/x.png")).rejects.toBeInstanceOf(TdApiError);
  });

  it("raises TdTimeoutError when the endpoint hangs past the deadline", async () => {
    const client = new TouchDesignerClient({
      baseUrl: TD_BASE,
      timeoutMs: 40,
      fetchImpl: hangingFetch,
    });
    await expect(client.saveNode("/x", "/tmp/x.png")).rejects.toBeInstanceOf(TdTimeoutError);
  });

  it("raises TdConnectionError when the bridge is unreachable", async () => {
    server.use(http.post(`${TD_BASE}/api/nodes/:seg/save`, () => HttpResponse.error()));
    await expect(makeClient().saveNode("/x", "/tmp/x.png")).rejects.toBeInstanceOf(
      TdConnectionError,
    );
  });
});

// ---------------------------------------------------------------------------
// duplicateNode — POST /api/duplicate (preserves wires + params)
// ---------------------------------------------------------------------------
describe("TouchDesignerClient.duplicateNode", () => {
  it("prefers POST /api/duplicate and returns the validated shape", async () => {
    let dupHits = 0;
    let execCalls = 0;
    server.use(
      http.post(`${TD_BASE}/api/duplicate`, async ({ request }) => {
        dupHits += 1;
        const body = (await request.json()) as {
          source_path: string;
          name: string | null;
          parent_path: string | null;
        };
        expect(body.source_path).toBe("/project1/base1");
        expect(body.name).toBe("copy1");
        return HttpResponse.json({
          ok: true,
          data: { source: "/project1/base1", copy: "/project1/copy1", parent: "/project1" },
        });
      }),
      http.post(`${TD_BASE}/api/exec`, () => {
        execCalls += 1;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const result = await makeClient().duplicateNode("/project1/base1", "copy1");
    expect(dupHits).toBe(1);
    expect(execCalls).toBe(0);
    expect(result.copy).toBe("/project1/copy1");
    expect(result.parent).toBe("/project1");
  });

  it("falls back to /api/exec when the endpoint is absent (404), same shape", async () => {
    let execCalls = 0;
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        execCalls += 1;
        const body = (await request.json()) as { script: string };
        scripts.push(body.script);
        return HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: `${JSON.stringify({
              source: "/project1/base1",
              copy: "/project1/base2",
              parent: "/project1",
            })}\n`,
          },
        });
      }),
    );

    const result = await makeClient().duplicateNode("/project1/base1");
    expect(execCalls).toBe(1);
    expect(scripts[0]).toContain(".copy(");
    expect(result.copy).toBe("/project1/base2");
  });

  it("surfaces a fatal from the exec fallback as TdApiError", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({
          ok: true,
          data: {
            result: null,
            stdout: `${JSON.stringify({ fatal: "duplicate: source not found" })}\n`,
          },
        }),
      ),
    );
    await expect(makeClient().duplicateNode("/x")).rejects.toBeInstanceOf(TdApiError);
  });

  it("raises TdApiError on a 400 from a current bridge (no exec fallback)", async () => {
    let execCalls = 0;
    server.use(
      http.post(`${TD_BASE}/api/duplicate`, () =>
        HttpResponse.json({ ok: false, error: { message: "source not found" } }, { status: 400 }),
      ),
      http.post(`${TD_BASE}/api/exec`, () => {
        execCalls += 1;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );
    await expect(makeClient().duplicateNode("/x")).rejects.toBeInstanceOf(TdApiError);
    expect(execCalls).toBe(0);
  });

  it("raises TdTimeoutError when the endpoint hangs past the deadline", async () => {
    const client = new TouchDesignerClient({
      baseUrl: TD_BASE,
      timeoutMs: 40,
      fetchImpl: hangingFetch,
    });
    await expect(client.duplicateNode("/x")).rejects.toBeInstanceOf(TdTimeoutError);
  });

  it("raises TdConnectionError when the bridge is unreachable", async () => {
    server.use(http.post(`${TD_BASE}/api/duplicate`, () => HttpResponse.error()));
    await expect(makeClient().duplicateNode("/x")).rejects.toBeInstanceOf(TdConnectionError);
  });
});

// ---------------------------------------------------------------------------
// getOpTypes — GET /api/optypes (ground-truth creatable list)
// ---------------------------------------------------------------------------
describe("TouchDesignerClient.getOpTypes", () => {
  const OPTYPES_REPORT = {
    optypes: ["baseCOMP", "noiseTOP", "nullTOP"],
    families: { COMP: ["baseCOMP"], TOP: ["noiseTOP", "nullTOP"] },
    count: 3,
    td_version: "099",
    build: "2025.32820",
  };

  it("prefers GET /api/optypes and returns the validated shape", async () => {
    let optypeHits = 0;
    let execCalls = 0;
    server.use(
      http.get(`${TD_BASE}/api/optypes`, () => {
        optypeHits += 1;
        return HttpResponse.json({ ok: true, data: OPTYPES_REPORT });
      }),
      http.post(`${TD_BASE}/api/exec`, () => {
        execCalls += 1;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const result = await makeClient().getOpTypes();
    expect(optypeHits).toBe(1);
    expect(execCalls).toBe(0);
    expect(result.count).toBe(3);
    expect(result.optypes).toContain("noiseTOP");
    expect(result.families.TOP).toEqual(["noiseTOP", "nullTOP"]);
    expect(result.build).toBe("2025.32820");
  });

  it("falls back to /api/exec when the endpoint is absent (404), same shape", async () => {
    let execCalls = 0;
    const scripts: string[] = [];
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        execCalls += 1;
        const body = (await request.json()) as { script: string };
        scripts.push(body.script);
        return HttpResponse.json({
          ok: true,
          data: { result: null, stdout: `${JSON.stringify(OPTYPES_REPORT)}\n` },
        });
      }),
    );

    const result = await makeClient().getOpTypes();
    expect(execCalls).toBe(1);
    // The exec fallback walks the td module for family-base subclasses.
    expect(scripts[0]).toContain("issubclass");
    expect(result.count).toBe(3);
    expect(result.optypes).toContain("baseCOMP");
  });

  it("raises TdApiError on a 5xx from the endpoint", async () => {
    server.use(
      http.get(`${TD_BASE}/api/optypes`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );
    await expect(makeClient().getOpTypes()).rejects.toBeInstanceOf(TdApiError);
  });

  it("raises TdTimeoutError when the endpoint hangs past the deadline", async () => {
    const client = new TouchDesignerClient({
      baseUrl: TD_BASE,
      timeoutMs: 40,
      fetchImpl: hangingFetch,
    });
    await expect(client.getOpTypes()).rejects.toBeInstanceOf(TdTimeoutError);
  });

  it("raises TdConnectionError when the bridge is unreachable", async () => {
    server.use(http.get(`${TD_BASE}/api/optypes`, () => HttpResponse.error()));
    await expect(makeClient().getOpTypes()).rejects.toBeInstanceOf(TdConnectionError);
  });
});
