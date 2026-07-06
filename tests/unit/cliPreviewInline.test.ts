import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runPreviewInline } from "../../src/cli/previewInline.js";
import { ExitCode } from "../../src/cli/exitCodes.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const B64 = Buffer.from("PNGPAYLOAD").toString("base64");

function client() {
  return new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 });
}

/** Mocks the perform-mode exec probe (false) + a preview capture. */
function mockPreview(base64 = B64): void {
  server.use(
    http.post(`${TD_BASE}/api/exec`, () =>
      HttpResponse.json({ ok: true, data: { result: null, stdout: JSON.stringify({ perform: false }) } }),
    ),
    http.get(`${TD_BASE}/api/preview/:seg`, ({ params }) =>
      HttpResponse.json({
        ok: true,
        data: { path: `/project1/${String(params.seg)}`, width: 128, height: 128, format: "png", base64 },
      }),
    ),
  );
}

describe("runPreviewInline", () => {
  it("renders once and exits 0 (ascii fallback in a plain terminal)", async () => {
    mockPreview();
    let out = "";
    const r = await runPreviewInline(
      client(),
      {
        nodePath: "/project1/out1",
        width: 128,
        height: 128,
        watch: false,
        intervalMs: 1000,
        env: { TERM: "xterm-256color" },
      },
      (chunk) => {
        out += chunk;
      },
    );
    expect(r.code).toBe(ExitCode.Ok);
    expect(out).toContain("/project1/out1");
    expect(out).toContain("inline preview"); // ascii fallback line
  });

  it("emits the iTerm2 sequence when TERM_PROGRAM is iTerm", async () => {
    mockPreview();
    let out = "";
    await runPreviewInline(
      client(),
      {
        nodePath: "/project1/out1",
        width: 128,
        height: 128,
        watch: false,
        intervalMs: 1000,
        env: { TERM_PROGRAM: "iTerm.app" },
      },
      (chunk) => {
        out += chunk;
      },
    );
    expect(out).toContain("]1337;File=inline=1;");
    expect(out).toContain(B64);
  });

  it("returns TD-offline (3) when the bridge is unreachable", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()),
      http.get(`${TD_BASE}/api/preview/:seg`, () => HttpResponse.error()),
    );
    const r = await runPreviewInline(client(), {
      nodePath: "/project1/out1",
      width: 128,
      height: 128,
      watch: false,
      intervalMs: 1000,
      env: {},
    });
    expect(r.code).toBe(ExitCode.TdOffline);
    expect(r.stderr).toContain("Cannot reach TouchDesigner");
  });

  it("watch mode re-renders maxFrames times then exits 0", async () => {
    mockPreview();
    let frames = 0;
    const r = await runPreviewInline(
      client(),
      {
        nodePath: "/project1/out1",
        width: 128,
        height: 128,
        watch: true,
        intervalMs: 1, // tiny so the test is fast
        maxFrames: 3,
        env: {},
      },
      () => {
        frames += 1;
      },
    );
    expect(r.code).toBe(ExitCode.Ok);
    expect(frames).toBe(3);
  });
});
