import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { controlTimelineTransportImpl } from "../../src/tools/layer3/controlTimelineTransport.js";
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
    logger: silentLogger,
  } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Returns a mock timeline state stdout for parsePythonReport. */
function makeStdout(action: string): string {
  return JSON.stringify({
    action,
    play: action === "play",
    frame: 142,
    rate: 1.0,
    startFrame: 0,
    endFrame: 600,
    fps: 60,
  });
}

function mockExec(action: string) {
  server.use(
    http.post(`${TD_BASE}/api/exec`, () =>
      HttpResponse.json({ ok: true, data: { result: null, stdout: makeStdout(action) } }),
    ),
  );
}

describe("controlTimelineTransportImpl", () => {
  describe("cross-field validation — no bridge call made", () => {
    it("seek without frame → friendly error", async () => {
      const result = await controlTimelineTransportImpl(makeCtx(), { action: "seek" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("frame");
    });

    it("cue without cueName → friendly error", async () => {
      const result = await controlTimelineTransportImpl(makeCtx(), { action: "cue" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("cueName");
    });

    it("rate without rate → friendly error", async () => {
      const result = await controlTimelineTransportImpl(makeCtx(), { action: "rate" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("rate");
    });
  });

  describe("payload encoding — each verb includes the right fields", () => {
    for (const [action, extra] of [
      ["play", {}],
      ["pause", {}],
      ["seek", { frame: 120 }],
      ["cue", { cueName: "verse" }],
      ["rate", { rate: 0.5 }],
    ] as const) {
      it(`${action} encodes action in payload`, async () => {
        let capturedScript = "";
        server.use(
          http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
            const body = (await request.json()) as { script?: string };
            capturedScript = body.script ?? "";
            return HttpResponse.json({
              ok: true,
              data: { result: null, stdout: makeStdout(action) },
            });
          }),
        );

        await controlTimelineTransportImpl(makeCtx(), { action, ...extra } as Parameters<
          typeof controlTimelineTransportImpl
        >[1]);

        // Decode the __PAYLOAD_B64__ from the script
        const match = capturedScript.match(/_payload_b64 = "([^"]+)"/);
        expect(match).not.toBeNull();
        const payload = JSON.parse(
          Buffer.from(match?.[1] ?? "", "base64").toString("utf-8"),
        ) as Record<string, unknown>;
        expect(payload.action).toBe(action);

        if (action === "seek") expect(payload.frame).toBe(120);
        if (action === "cue") expect(payload.cueName).toBe("verse");
        if (action === "rate") expect(payload.rate).toBe(0.5);
      });
    }
  });

  describe("script source contains expected branch token", () => {
    it("play script contains `project.play = True`", async () => {
      let capturedScript = "";
      server.use(
        http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
          capturedScript = ((await request.json()) as { script?: string }).script ?? "";
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: makeStdout("play") },
          });
        }),
      );
      await controlTimelineTransportImpl(makeCtx(), { action: "play" });
      expect(capturedScript).toContain("project.play = True");
    });

    it("pause script contains `project.play = False`", async () => {
      let capturedScript = "";
      server.use(
        http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
          capturedScript = ((await request.json()) as { script?: string }).script ?? "";
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: makeStdout("pause") },
          });
        }),
      );
      await controlTimelineTransportImpl(makeCtx(), { action: "pause" });
      expect(capturedScript).toContain("project.play = False");
    });

    it("seek script contains `me.time.frame =`", async () => {
      let capturedScript = "";
      server.use(
        http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
          capturedScript = ((await request.json()) as { script?: string }).script ?? "";
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: makeStdout("seek") },
          });
        }),
      );
      await controlTimelineTransportImpl(makeCtx(), { action: "seek", frame: 120 });
      expect(capturedScript).toContain("me.time.frame =");
    });

    it("cue script contains `project.cue(`", async () => {
      let capturedScript = "";
      server.use(
        http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
          capturedScript = ((await request.json()) as { script?: string }).script ?? "";
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: makeStdout("cue") },
          });
        }),
      );
      await controlTimelineTransportImpl(makeCtx(), { action: "cue", cueName: "verse" });
      expect(capturedScript).toContain("project.cue(");
    });

    it("rate script contains `project.rate =`", async () => {
      let capturedScript = "";
      server.use(
        http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
          capturedScript = ((await request.json()) as { script?: string }).script ?? "";
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: makeStdout("rate") },
          });
        }),
      );
      await controlTimelineTransportImpl(makeCtx(), { action: "rate", rate: 0.5 });
      expect(capturedScript).toContain("project.rate =");
    });
  });

  describe("happy path — structured result echoes timeline state", () => {
    it("play returns structuredContent with all fields + message includes frame/rate/fps", async () => {
      mockExec("play");
      const result = await controlTimelineTransportImpl(makeCtx(), { action: "play" });
      expect(result.isError).toBeFalsy();
      const msg = textOf(result);
      expect(msg).toContain("142"); // frame
      expect(msg).toContain("1.00x"); // rate
      expect(msg).toContain("60"); // fps
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("play");
      expect(sc.play).toBe(true);
      expect(sc.frame).toBe(142);
      expect(sc.rate).toBe(1.0);
      expect(sc.startFrame).toBe(0);
      expect(sc.endFrame).toBe(600);
      expect(sc.fps).toBe(60);
    });
  });

  describe("REST endpoint /api/transport — first-class, survives ALLOW_EXEC=0", () => {
    it("prefers POST /api/transport and does NOT call /api/exec when available", async () => {
      let execCalled = false;
      let transportCalled = false;
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post(`${TD_BASE}/api/transport`, async ({ request }) => {
          transportCalled = true;
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            ok: true,
            data: {
              action: "seek",
              play: false,
              frame: 120,
              rate: 1.0,
              startFrame: 0,
              endFrame: 600,
              fps: 60,
            },
          });
        }),
        http.post(`${TD_BASE}/api/exec`, () => {
          execCalled = true;
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: makeStdout("seek") },
          });
        }),
      );

      const result = await controlTimelineTransportImpl(makeCtx(), {
        action: "seek",
        frame: 120,
      });

      expect(result.isError).toBeFalsy();
      expect(transportCalled).toBe(true);
      expect(execCalled).toBe(false);
      expect(capturedBody).not.toBeNull();
      const body = capturedBody as unknown as Record<string, unknown>;
      expect(body.action).toBe("seek");
      expect(body.frame).toBe(120);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("seek");
      expect(sc.frame).toBe(120);
    });

    it("does NOT fall back to /api/exec when /api/transport returns 400 (bad request)", async () => {
      let execCalled = false;
      server.use(
        http.post(`${TD_BASE}/api/transport`, () =>
          HttpResponse.json({ ok: false, error: "bad request" }, { status: 400 }),
        ),
        http.post(`${TD_BASE}/api/exec`, () => {
          execCalled = true;
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: makeStdout("play") },
          });
        }),
      );

      const result = await controlTimelineTransportImpl(makeCtx(), { action: "play" });

      expect(execCalled).toBe(false);
      expect(result.isError).toBe(true);
    });

    it("falls back to /api/exec when /api/transport returns 404 (older bridge)", async () => {
      // tdMock's default 404 for /api/transport is already in place; just mock exec.
      let execCalled = false;
      server.use(
        http.post(`${TD_BASE}/api/exec`, () => {
          execCalled = true;
          return HttpResponse.json({
            ok: true,
            data: { result: null, stdout: makeStdout("play") },
          });
        }),
      );

      const result = await controlTimelineTransportImpl(makeCtx(), { action: "play" });

      expect(result.isError).toBeFalsy();
      expect(execCalled).toBe(true);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.action).toBe("play");
    });
  });

  describe("bridge offline → friendly error", () => {
    it("returns isError when bridge is unreachable", async () => {
      server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));
      const result = await controlTimelineTransportImpl(makeCtx(), { action: "play" });
      expect(result.isError).toBe(true);
    });
  });
});
