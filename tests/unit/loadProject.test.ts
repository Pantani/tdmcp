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

const ARTIFACT = "/tmp/quarantine/project.toe";

const ENDPOINT_REPORT = {
  root_path: "/project1",
  node_count: 7,
  errors: [{ path: "/project1/glsl1", message: "compile failed", level: "error" }],
  preview_b64: "iVBORw0KGgoEND=",
};

describe("TouchDesignerClient.loadProject", () => {
  it("prefers POST /api/project/load and returns the validated shape", async () => {
    let loadHits = 0;
    let execCalls = 0;
    server.use(
      http.post(`${TD_BASE}/api/project/load`, async ({ request }) => {
        loadHits += 1;
        const body = (await request.json()) as { path: string; timeout_ms: number | null };
        expect(body.path).toBe(ARTIFACT);
        return HttpResponse.json({ ok: true, data: ENDPOINT_REPORT });
      }),
      http.post(`${TD_BASE}/api/exec`, () => {
        execCalls += 1;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    const result = await makeClient().loadProject(ARTIFACT, 5000);
    expect(loadHits).toBe(1);
    expect(execCalls).toBe(0);
    expect(result.root_path).toBe("/project1");
    expect(result.node_count).toBe(7);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("compile failed");
    expect(result.preview_b64).toBe("iVBORw0KGgoEND=");
  });

  it("falls back to /api/exec when the endpoint is absent (404), same shape", async () => {
    // tdMock defaults POST /api/project/load to 404. Stub /api/exec to print the report.
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
            stdout: `${JSON.stringify({ root_path: "/project1", node_count: 3, errors: [] })}\n`,
          },
        });
      }),
    );

    const result = await makeClient().loadProject(ARTIFACT);
    expect(execCalls).toBe(1);
    // The exec fallback runs project.load (.toe) / loadTox (.tox) + a findChildren walk.
    expect(scripts[0]).toContain("project.load");
    expect(scripts[0]).toContain("loadTox");
    expect(scripts[0]).toContain("findChildren");
    expect(result.root_path).toBe("/project1");
    expect(result.node_count).toBe(3);
    expect(result.errors).toEqual([]);
    expect(result.preview_b64).toBeUndefined();
  });

  it("raises TdApiError on a validation 400 from a current bridge (no exec fallback)", async () => {
    let execCalls = 0;
    server.use(
      http.post(`${TD_BASE}/api/project/load`, () =>
        HttpResponse.json(
          { ok: false, error: { message: "File not found: /tmp/quarantine/project.toe." } },
          { status: 400 },
        ),
      ),
      http.post(`${TD_BASE}/api/exec`, () => {
        execCalls += 1;
        return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
      }),
    );

    await expect(makeClient().loadProject(ARTIFACT)).rejects.toBeInstanceOf(TdApiError);
    // A real validation 400 must NOT silently re-run via exec.
    expect(execCalls).toBe(0);
  });

  it("raises TdApiError on a 5xx from the endpoint", async () => {
    server.use(
      http.post(`${TD_BASE}/api/project/load`, () =>
        HttpResponse.json({ ok: false, error: { message: "boom" } }, { status: 500 }),
      ),
    );
    await expect(makeClient().loadProject(ARTIFACT)).rejects.toBeInstanceOf(TdApiError);
  });

  it("raises TdTimeoutError when the endpoint hangs past the deadline", async () => {
    server.use(
      http.post(
        `${TD_BASE}/api/project/load`,
        () => new Promise(() => {}), // never resolves
      ),
    );
    await expect(makeClient(40).loadProject(ARTIFACT)).rejects.toBeInstanceOf(TdTimeoutError);
  });

  it("raises TdConnectionError when the bridge is unreachable", async () => {
    server.use(http.post(`${TD_BASE}/api/project/load`, () => HttpResponse.error()));
    await expect(makeClient().loadProject(ARTIFACT)).rejects.toBeInstanceOf(TdConnectionError);
  });
});
