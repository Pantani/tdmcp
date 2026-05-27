import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildSurfaceScript,
  createControlSurfaceImpl,
} from "../../src/tools/layer2/createControlSurface.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  comp: string;
  name: string;
  align: string;
  faders: Array<{ param: string; label?: string; min: number; max: number }>;
  cue_buttons: Array<{ cue: string; label?: string; morph_seconds: number }>;
  morph_hook: string;
  button_cb: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const okReport = (over: Record<string, unknown> = {}) =>
  vi.fn(async (_script: string, _capture?: boolean) => ({
    stdout: JSON.stringify({
      comp: "/project1",
      surface: "/project1/surface",
      faders: [],
      cue_buttons: [],
      warnings: [],
      ...over,
    }),
  }));

describe("buildSurfaceScript", () => {
  it("embeds comp, name, align, faders, and cue_buttons in the payload", () => {
    const script = buildSurfaceScript({
      comp: "/project1",
      name: "main",
      align: "horizlr",
      faders: [{ param: "/project1/noise1.period", min: 1, max: 8 }],
      cue_buttons: [{ cue: "drop", morph_seconds: 2 }],
      morph_hook: "HOOK",
      button_cb: "CB",
    });
    const payload = decodePayload(script);
    expect(payload.comp).toBe("/project1");
    expect(payload.name).toBe("main");
    expect(payload.align).toBe("horizlr");
    expect(payload.faders).toHaveLength(1);
    expect(payload.faders[0]).toMatchObject({ param: "/project1/noise1.period", min: 1, max: 8 });
    expect(payload.cue_buttons[0]).toMatchObject({ cue: "drop", morph_seconds: 2 });
  });

  it("includes morph_hook and button_cb strings so Python can install the callbacks", () => {
    const script = buildSurfaceScript({
      comp: "/project1",
      name: "s",
      align: "verttb",
      faders: [],
      cue_buttons: [{ cue: "intro", morph_seconds: 0 }],
      morph_hook: "MY_HOOK_CODE",
      button_cb: "MY_CB_CODE",
    });
    const payload = decodePayload(script);
    expect(payload.morph_hook).toBe("MY_HOOK_CODE");
    expect(payload.button_cb).toBe("MY_CB_CODE");
  });
});

describe("createControlSurfaceImpl", () => {
  it("returns an error result when report.fatal is set", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        comp: "/project1",
        faders: [],
        cue_buttons: [],
        warnings: [],
        fatal: "COMP not found: /project1",
      }),
    }));
    const result = await createControlSurfaceImpl(fakeCtx(exec), {
      comp_path: "/project1",
      name: "surface",
      align: "horizlr",
      faders: [],
      cue_buttons: [],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMP not found");
  });

  it("summarises the surface path, fader count, and cue button count", async () => {
    const exec = okReport({
      surface: "/project1/perf",
      faders: [{ slider: "/project1/perf/slider1", param: "/project1/noise1.period" }],
      cue_buttons: [
        { button: "/project1/perf/button1", cue: "drop", morph_seconds: 0 },
        { button: "/project1/perf/button2", cue: "build", morph_seconds: 1.5 },
      ],
    });
    const result = await createControlSurfaceImpl(fakeCtx(exec), {
      comp_path: "/project1",
      name: "perf",
      align: "horizlr",
      faders: [{ param: "/project1/noise1.period", min: 0, max: 8 }],
      cue_buttons: [
        { cue: "drop", morph_seconds: 0 },
        { cue: "build", morph_seconds: 1.5 },
      ],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // "Built control surface /project1/perf with 1 fader(s) and 2 cue button(s)."
    expect(text).toContain("/project1/perf");
    expect(text).toContain("1 fader(s)");
    expect(text).toContain("2 cue button(s)");
  });

  it("passes captureStdout=true to executePythonScript", async () => {
    const exec = okReport();
    await createControlSurfaceImpl(fakeCtx(exec), {
      comp_path: "/project1",
      name: "surface",
      align: "horizlr",
      faders: [],
      cue_buttons: [],
    });
    expect(exec.mock.calls[0]?.[1]).toBe(true);
  });
});
