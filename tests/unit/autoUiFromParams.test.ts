import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  autoUiFromParamsImpl,
  inferControlsFromNode,
} from "../../src/tools/layer2/autoUiFromParams.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function decodePanelPayload(exec: ReturnType<typeof vi.fn>) {
  const script = exec.mock.calls[0]?.[0];
  if (typeof script !== "string") throw new Error("executePythonScript not called");
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (!b64) throw new Error("no embedded payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    comp: string;
    page: string;
    controls: Array<{ name: string; type: string; bind_to?: string[] }>;
  };
}

describe("inferControlsFromNode", () => {
  it("maps primitive node parameters to control specs", () => {
    const result = inferControlsFromNode(
      {
        path: "/project1/noise1",
        type: "noiseTOP",
        name: "noise1",
        parameters: {
          amplitude: 0.5,
          seed: 2,
          active: true,
          label: "main",
          tuple: [1, 2],
        },
      },
      { exclude: [], max_controls: 8, bind: true },
    );
    expect(result.controls.map((control) => [control.name, control.type])).toEqual([
      ["amplitude", "float"],
      ["seed", "int"],
      ["label", "string"],
    ]);
    expect(result.controls[0]?.bind_to).toEqual(["/project1/noise1.amplitude"]);
    expect(result.skipped).toContain("active");
    expect(result.skipped).toContain("tuple");
  });

  it("matches user exclusions case-insensitively", () => {
    const result = inferControlsFromNode(
      {
        path: "/project1/noise1",
        type: "noiseTOP",
        name: "noise1",
        parameters: {
          amplitude: 0.5,
          seed: 2,
        },
      },
      { exclude: ["Amplitude"], max_controls: 8, bind: true },
    );
    expect(result.controls.map((control) => control.name)).toEqual(["seed"]);
    expect(result.skipped).toContain("amplitude");
  });
});

describe("autoUiFromParamsImpl", () => {
  it("reads a node and delegates the inferred controls to create_control_panel", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        comp: "/project1/ui",
        page: "Auto UI",
        created: [
          {
            control: "amplitude",
            name: "Amplitude",
            type: "float",
            pars: ["Amplitude"],
            value: 0.5,
          },
        ],
        bound: [{ control: "Amplitude", target: "/project1/noise1.amplitude" }],
        warnings: [],
      }),
    }));
    const ctx = {
      client: {
        getNode: vi.fn(async () => ({
          path: "/project1/noise1",
          type: "noiseTOP",
          name: "noise1",
          parameters: { amplitude: 0.5, seed: 1 },
        })),
        executePythonScript: exec,
      },
      logger: silentLogger,
    } as unknown as ToolContext;

    const result = await autoUiFromParamsImpl(ctx, {
      source_path: "/project1/noise1",
      comp_path: "/project1/ui",
      page: "Auto UI",
      parameters: ["amplitude"],
      exclude: [],
      max_controls: 12,
      bind: true,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Generated 1 auto UI");
    const payload = decodePanelPayload(exec);
    expect(payload.comp).toBe("/project1/ui");
    expect(payload.controls).toMatchObject([
      { name: "amplitude", type: "float", bind_to: ["/project1/noise1.amplitude"] },
    ]);
  });

  it("returns an error when no eligible parameters are found", async () => {
    const ctx = {
      client: {
        getNode: vi.fn(async () => ({
          path: "/project1/noise1",
          type: "noiseTOP",
          name: "noise1",
          parameters: { tuple: [1, 2] },
        })),
      },
      logger: silentLogger,
    } as unknown as ToolContext;
    const result = await autoUiFromParamsImpl(ctx, {
      source_path: "/project1/noise1",
      page: "Auto UI",
      exclude: [],
      max_controls: 12,
      bind: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No eligible");
  });

  it("returns a friendly error when TouchDesigner node lookup throws", async () => {
    const ctx = {
      client: {
        getNode: vi.fn(async () => {
          throw new Error("network down");
        }),
      },
      logger: silentLogger,
    } as unknown as ToolContext;
    const result = await autoUiFromParamsImpl(ctx, {
      source_path: "/project1/missing",
      page: "Auto UI",
      exclude: [],
      max_controls: 12,
      bind: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("auto_ui_from_params failed");
    expect(textOf(result)).toContain("/project1/missing");
  });
});
