import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  createCompanionSurfaceImpl,
  createCompanionSurfaceSchema,
} from "../../src/tools/layer2/createCompanionSurface.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function decodePayload(script: string) {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (!b64) throw new Error("no embedded payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    comp: string;
    controls?: Array<{ name: string; bind_to?: string[] }>;
    faders?: Array<{ param: string; label: string; min: number; max: number }>;
    cue_buttons?: Array<{ cue: string; morph_seconds: number }>;
  };
}

function makeCtx() {
  const exec = vi.fn(async (script: string) => {
    if (script.includes("appendCustomPage")) {
      return {
        stdout: JSON.stringify({
          comp: "/project1/noise1",
          page: "Companion",
          created: [
            { control: "amplitude", name: "Amplitude", type: "float", pars: ["Amplitude"] },
          ],
          bound: [{ control: "Amplitude", target: "/project1/noise1.amplitude" }],
          warnings: [],
        }),
      };
    }
    return {
      stdout: JSON.stringify({
        comp: "/project1/noise1",
        surface: "/project1/noise1/companion_surface",
        faders: [{ slider: "/project1/noise1/companion_surface/slider1", param: "x" }],
        cue_buttons: [{ button: "/project1/noise1/companion_surface/button1", cue: "drop" }],
        warnings: [],
      }),
    };
  });
  const ctx = {
    client: {
      getNode: vi.fn(async () => ({
        path: "/project1/noise1",
        type: "noiseTOP",
        name: "noise1",
        parameters: { amplitude: 0.5, seed: 2, label: "main" },
      })),
      executePythonScript: exec,
      getInfo: vi.fn(async () => ({ td_version: "2025.32820", bridge_version: "0.13.0" })),
      getNetworkErrors: vi.fn(async () => ({ errors: [] })),
      getNetworkTopology: vi.fn(async () => ({
        nodes: [{ path: "/project1/noise1" }],
        connections: [],
      })),
      getNetworkPerformance: vi.fn(async () => ({ nodes: [], total_cook_time_ms: 0 })),
    },
    logger: silentLogger,
  } as unknown as ToolContext;
  return { ctx, exec };
}

describe("create_companion_surface", () => {
  it("builds auto UI, a playable fader/cue surface, and a preflight summary", async () => {
    const { ctx, exec } = makeCtx();
    const result = await createCompanionSurfaceImpl(
      ctx,
      createCompanionSurfaceSchema.parse({
        source_path: "/project1/noise1",
        parameters: ["amplitude"],
        cue_buttons: [{ cue: "drop", morph_seconds: 1 }],
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Created companion surface");
    expect(textOf(result)).toContain("preflight PASS");
    expect(result.content[0]?.type).toBe("text");

    const panelPayload = decodePayload(exec.mock.calls[0]?.[0] as string);
    expect(panelPayload.comp).toBe("/project1/noise1");
    expect(panelPayload.controls?.[0]).toMatchObject({
      name: "amplitude",
      bind_to: ["/project1/noise1.amplitude"],
    });

    const surfacePayload = decodePayload(exec.mock.calls[1]?.[0] as string);
    expect(surfacePayload.faders?.[0]).toMatchObject({
      param: "/project1/noise1.Amplitude",
      label: "amplitude",
    });
    expect(surfacePayload.cue_buttons?.[0]).toMatchObject({ cue: "drop", morph_seconds: 1 });
  });

  it("can skip the read-only preflight check", async () => {
    const { ctx } = makeCtx();
    const result = await createCompanionSurfaceImpl(
      ctx,
      createCompanionSurfaceSchema.parse({
        source_path: "/project1/noise1",
        parameters: ["amplitude"],
        include_preflight: false,
      }),
    );
    expect(result.isError).toBeFalsy();
    expect((ctx.client.getInfo as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("can build only the bound auto UI without a playable fader surface", async () => {
    const { ctx, exec } = makeCtx();
    const result = await createCompanionSurfaceImpl(
      ctx,
      createCompanionSurfaceSchema.parse({
        source_path: "/project1/noise1",
        parameters: ["amplitude"],
        include_faders: false,
        include_preflight: false,
      }),
    );

    expect(textOf(result)).toContain("1 auto UI control(s), 0 fader(s).");
    expect(result.isError).toBeFalsy();
    expect(exec).toHaveBeenCalledTimes(1);
    expect((ctx.client.getInfo as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("can build unbound controls when bind is disabled", async () => {
    const { ctx, exec } = makeCtx();
    const result = await createCompanionSurfaceImpl(
      ctx,
      createCompanionSurfaceSchema.parse({
        source_path: "/project1/noise1",
        parameters: ["amplitude"],
        bind: false,
        include_preflight: false,
      }),
    );

    expect(result.isError).toBeFalsy();
    const panelPayload = decodePayload(exec.mock.calls[0]?.[0] as string);
    expect(panelPayload.controls?.[0]).toMatchObject({ name: "amplitude" });
    expect(panelPayload.controls?.[0]?.bind_to).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("returns the auto UI context when the playable surface build fails", async () => {
    const { ctx, exec } = makeCtx();
    exec
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          comp: "/project1/noise1",
          page: "Companion",
          created: [
            { control: "amplitude", name: "Amplitude", type: "float", pars: ["Amplitude"] },
          ],
          bound: [{ control: "Amplitude", target: "/project1/noise1.amplitude" }],
          warnings: [],
        }),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          comp: "/project1/noise1",
          surface: "",
          faders: [],
          cue_buttons: [],
          warnings: [],
          fatal: "panel create failed",
        }),
      });

    const result = await createCompanionSurfaceImpl(
      ctx,
      createCompanionSurfaceSchema.parse({
        source_path: "/project1/noise1",
        parameters: ["amplitude"],
      }),
    );

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("control surface build failed");
    expect(text).toContain("panel create failed");
    expect(text).toContain('"auto_ui"');
  });

  it("returns an error before mutating when no primitive parameters are eligible", async () => {
    const { ctx, exec } = makeCtx();
    (ctx.client.getNode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      path: "/project1/blob",
      type: "baseCOMP",
      name: "blob",
      parameters: { tuple: [1, 2] },
    });
    const result = await createCompanionSurfaceImpl(
      ctx,
      createCompanionSurfaceSchema.parse({ source_path: "/project1/blob" }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No eligible");
    expect(exec).not.toHaveBeenCalled();
  });

  it("formats TouchDesigner lookup failures as tool errors", async () => {
    const { ctx, exec } = makeCtx();
    (ctx.client.getNode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("TD bridge unavailable"),
    );

    const result = await createCompanionSurfaceImpl(
      ctx,
      createCompanionSurfaceSchema.parse({ source_path: "/project1/noise1" }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TD bridge unavailable");
    expect(exec).not.toHaveBeenCalled();
  });
});
