import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { editDatContentImpl, editDatContentSchema } from "../../src/tools/layer3/editDatContent.js";
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

/** Capture the /api/exec call and return the decoded payload from the base64 in the script. */
function captureExecPayload(): { payload: Record<string, unknown> | null } {
  const capture: { payload: Record<string, unknown> | null } = { payload: null };
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      const m = /b64decode\("([^"]+)"\)/.exec(body.script);
      if (m?.[1] !== undefined) {
        capture.payload = JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) as Record<
          string,
          unknown
        >;
      }
      // Default: happy report with 1 replacement
      const report = JSON.stringify({
        dat: "/project1/mydat1",
        occurrences: 1,
        replacements: 1,
        replace_all: false,
        warnings: [],
      });
      return HttpResponse.json({ ok: true, data: { result: null, stdout: report } });
    }),
  );
  return capture;
}

describe("edit_dat_content", () => {
  describe("schema validation", () => {
    it("rejects an empty old_string (min 1)", () => {
      expect(() =>
        editDatContentSchema.parse({ dat_path: "/x", old_string: "", new_string: "y" }),
      ).toThrow();
    });

    it("defaults replace_all to false", () => {
      const parsed = editDatContentSchema.parse({
        dat_path: "/project1/mydat1",
        old_string: "foo",
        new_string: "bar",
      });
      expect(parsed.replace_all).toBe(false);
    });
  });

  describe("raw Python disabled", () => {
    it("rejects DAT text mutation before the read or write request", async () => {
      const getDatText = vi.fn();
      const putDatText = vi.fn();
      const executePythonScript = vi.fn();
      const ctx = {
        allowRawPython: false,
        client: { getDatText, putDatText, executePythonScript },
        logger: silentLogger,
      } as unknown as ToolContext;

      const result = await editDatContentImpl(ctx, {
        dat_path: "/project1/callbacks",
        old_string: "pass",
        new_string: "system('unsafe')",
        replace_all: false,
      });

      expect(result.isError).toBe(true);
      const text = result.content.find((item) => item.type === "text");
      expect(text?.type === "text" ? text.text : "").toContain("raw Python is disabled");
      expect(getDatText).not.toHaveBeenCalled();
      expect(putDatText).not.toHaveBeenCalled();
      expect(executePythonScript).not.toHaveBeenCalled();
    });
  });

  describe("happy path — unique match", () => {
    it("carries dat_path, old_string, new_string, replace_all through the base64 payload", async () => {
      const captured = captureExecPayload();
      const result = await editDatContentImpl(makeCtx(), {
        dat_path: "/project1/mydat1",
        old_string: "hello world",
        new_string: "goodbye world",
        replace_all: false,
      });

      expect(result.isError).toBeFalsy();
      expect(captured.payload).toMatchObject({
        dat: "/project1/mydat1",
        old: "hello world",
        new: "goodbye world",
        replace_all: false,
      });
    });

    it("returns a friendly summary with replacement and occurrence counts", async () => {
      captureExecPayload();
      const result = await editDatContentImpl(makeCtx(), {
        dat_path: "/project1/mydat1",
        old_string: "hello world",
        new_string: "goodbye world",
        replace_all: false,
      });

      expect(result.isError).toBeFalsy();
      const text = result.content.find((c) => c.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      expect(text?.text).toContain("Replaced 1 occurrence(s)");
      expect(text?.text).toContain("/project1/mydat1");
      expect(text?.text).toContain("1 match(es) found");
    });
  });

  describe("happy path — replace_all", () => {
    it("carries replace_all:true in the payload and reports multiple replacements", async () => {
      const captured: { payload: Record<string, unknown> | null } = { payload: null };
      server.use(
        http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
          const body = (await request.json()) as { script: string };
          const m = /b64decode\("([^"]+)"\)/.exec(body.script);
          if (m?.[1] !== undefined) {
            captured.payload = JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) as Record<
              string,
              unknown
            >;
          }
          const report = JSON.stringify({
            dat: "/project1/mydat1",
            occurrences: 3,
            replacements: 3,
            replace_all: true,
            warnings: [],
          });
          return HttpResponse.json({ ok: true, data: { result: null, stdout: report } });
        }),
      );

      const result = await editDatContentImpl(makeCtx(), {
        dat_path: "/project1/mydat1",
        old_string: "foo",
        new_string: "bar",
        replace_all: true,
      });

      expect(result.isError).toBeFalsy();
      expect(captured.payload?.replace_all).toBe(true);
      const text = result.content.find((c) => c.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      expect(text?.text).toContain("Replaced 3 occurrence(s)");
      expect(text?.text).toContain("3 match(es) found");
    });
  });

  describe("bridge fatal — 0 matches", () => {
    it("returns isError:true and does not throw when old_string is not found", async () => {
      server.use(
        http.post(`${TD_BASE}/api/exec`, () => {
          const report = JSON.stringify({
            dat: "/project1/mydat1",
            occurrences: 0,
            replacements: 0,
            replace_all: false,
            warnings: [],
            fatal: "old_string not found in /project1/mydat1.",
          });
          return HttpResponse.json({ ok: true, data: { result: null, stdout: report } });
        }),
      );

      const result = await editDatContentImpl(makeCtx(), {
        dat_path: "/project1/mydat1",
        old_string: "nonexistent string",
        new_string: "replacement",
        replace_all: false,
      });

      expect(result.isError).toBe(true);
      const text = result.content.find((c) => c.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      expect(text?.text).toContain("not found");
    });
  });

  describe("bridge fatal — >1 matches without replace_all", () => {
    it("returns isError:true and does not throw when match is ambiguous", async () => {
      server.use(
        http.post(`${TD_BASE}/api/exec`, () => {
          const report = JSON.stringify({
            dat: "/project1/mydat1",
            occurrences: 4,
            replacements: 0,
            replace_all: false,
            warnings: [],
            fatal:
              "old_string matches 4 times in /project1/mydat1; pass replace_all:true to replace all, or add surrounding context for a unique match.",
          });
          return HttpResponse.json({ ok: true, data: { result: null, stdout: report } });
        }),
      );

      const result = await editDatContentImpl(makeCtx(), {
        dat_path: "/project1/mydat1",
        old_string: "foo",
        new_string: "bar",
        replace_all: false,
      });

      expect(result.isError).toBe(true);
      const text = result.content.find((c) => c.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      expect(text?.text).toContain("4 times");
      expect(text?.text).toContain("replace_all:true");
    });
  });

  describe("bridge fatal — DAT not found", () => {
    it("returns isError:true and does not throw when the DAT path is invalid", async () => {
      server.use(
        http.post(`${TD_BASE}/api/exec`, () => {
          const report = JSON.stringify({
            dat: "/project1/doesnotexist",
            occurrences: 0,
            replacements: 0,
            replace_all: false,
            warnings: [],
            fatal: "DAT not found: /project1/doesnotexist",
          });
          return HttpResponse.json({ ok: true, data: { result: null, stdout: report } });
        }),
      );

      const result = await editDatContentImpl(makeCtx(), {
        dat_path: "/project1/doesnotexist",
        old_string: "anything",
        new_string: "something",
        replace_all: false,
      });

      expect(result.isError).toBe(true);
      const text = result.content.find((c) => c.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      expect(text?.text).toContain("DAT not found");
    });
  });

  describe("bridge fatal — not a DAT", () => {
    it("returns isError:true when the path points to a non-DAT operator", async () => {
      server.use(
        http.post(`${TD_BASE}/api/exec`, () => {
          const report = JSON.stringify({
            dat: "/project1/noise1",
            occurrences: 0,
            replacements: 0,
            replace_all: false,
            warnings: [],
            fatal: "/project1/noise1 is not a DAT.",
          });
          return HttpResponse.json({ ok: true, data: { result: null, stdout: report } });
        }),
      );

      const result = await editDatContentImpl(makeCtx(), {
        dat_path: "/project1/noise1",
        old_string: "anything",
        new_string: "something",
        replace_all: false,
      });

      expect(result.isError).toBe(true);
      const text = result.content.find((c) => c.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      expect(text?.text).toContain("is not a DAT");
    });
  });

  describe("network failure", () => {
    it("returns isError:true and does not throw when the bridge is offline", async () => {
      server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));

      const result = await editDatContentImpl(makeCtx(), {
        dat_path: "/project1/mydat1",
        old_string: "hello",
        new_string: "world",
        replace_all: false,
      });

      expect(result.isError).toBe(true);
    });
  });

  describe("endpoint-first path (GET/PUT …/text)", () => {
    it("uses the atomic source-aware edit endpoint on a current bridge", async () => {
      let body: Record<string, unknown> | undefined;
      let legacyCalled = false;
      server.use(
        http.post(`${TD_BASE}/api/nodes/:seg/text/edit`, async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            ok: true,
            data: {
              path: "/project1/mydat1",
              dat: "/project1/mydat1",
              old_length: 11,
              new_length: 13,
              occurrences: 1,
              replacements: 1,
              replace_all: false,
              file_synced: true,
              source_path: "code/python/mydat1.py",
              warnings: [],
            },
          });
        }),
        http.get(`${TD_BASE}/api/nodes/:seg/text`, () => {
          legacyCalled = true;
          return HttpResponse.error();
        }),
        http.put(`${TD_BASE}/api/nodes/:seg/text`, () => {
          legacyCalled = true;
          return HttpResponse.error();
        }),
      );

      const result = await editDatContentImpl(makeCtx(), {
        dat_path: "/project1/mydat1",
        old_string: "hello",
        new_string: "goodbye",
        replace_all: false,
        source: "file",
      });

      expect(result.isError).toBeFalsy();
      expect(legacyCalled).toBe(false);
      expect(body).toEqual({
        old_string: "hello",
        new_string: "goodbye",
        replace_all: false,
        source: "file",
      });
      const text = result.content.find((item) => item.type === "text");
      expect(text?.type === "text" ? text.text : "").toContain("code/python/mydat1.py");
    });

    it("reads via the text endpoint, replaces in TS, PUTs back, and never calls exec", async () => {
      let putBody: { text?: string } | null = null;
      let execCalled = false;
      server.use(
        http.get(`${TD_BASE}/api/nodes/:seg/text`, () =>
          HttpResponse.json({
            ok: true,
            data: { path: "/project1/mydat1", text: "hello world", is_table: false },
          }),
        ),
        http.put(`${TD_BASE}/api/nodes/:seg/text`, async ({ request }) => {
          putBody = (await request.json()) as { text?: string };
          return HttpResponse.json({
            ok: true,
            data: { path: "/project1/mydat1", old_length: 11, new_length: 13 },
          });
        }),
        http.post(`${TD_BASE}/api/exec`, () => {
          execCalled = true;
          return HttpResponse.json({ ok: true, data: { result: null, stdout: "{}" } });
        }),
      );

      const result = await editDatContentImpl(makeCtx(), {
        dat_path: "/project1/mydat1",
        old_string: "hello",
        new_string: "goodbye",
        replace_all: false,
      });

      expect(result.isError).toBeFalsy();
      expect(execCalled).toBe(false);
      expect(putBody).not.toBeNull();
      expect((putBody as unknown as { text: string }).text).toBe("goodbye world");
    });

    it("on the endpoint path, 0 matches returns isError and does NOT PUT", async () => {
      let putCalled = false;
      server.use(
        http.get(`${TD_BASE}/api/nodes/:seg/text`, () =>
          HttpResponse.json({
            ok: true,
            data: { path: "/project1/mydat1", text: "nothing here", is_table: false },
          }),
        ),
        http.put(`${TD_BASE}/api/nodes/:seg/text`, () => {
          putCalled = true;
          return HttpResponse.json({
            ok: true,
            data: { path: "/project1/mydat1", old_length: 12, new_length: 12 },
          });
        }),
      );

      const result = await editDatContentImpl(makeCtx(), {
        dat_path: "/project1/mydat1",
        old_string: "absent",
        new_string: "x",
        replace_all: false,
      });

      expect(result.isError).toBe(true);
      expect(putCalled).toBe(false);
    });
  });
});
