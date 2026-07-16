import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdApiError } from "../../src/td-client/types.js";
import {
  pulseTdParameterImpl,
  pulseTdParameterSchema,
} from "../../src/tools/layer3/pulseTdParameter.js";
import type { ToolContext } from "../../src/tools/types.js";

function makeCtx(client: object): ToolContext {
  return { client } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

describe("pulse_td_parameter", () => {
  it("validates required operator and parameter names", () => {
    expect(
      pulseTdParameterSchema.parse({ path: "/project1/movie1", parameter: "cuepulse" }),
    ).toEqual({ path: "/project1/movie1", parameter: "cuepulse" });
    expect(() => pulseTdParameterSchema.parse({ path: "", parameter: "cuepulse" })).toThrow();
    expect(() =>
      pulseTdParameterSchema.parse({ path: "/project1/movie1", parameter: "" }),
    ).toThrow();
  });

  it("calls the structured pulse method and confirms the exact Pulse", async () => {
    const pulseParameter = vi.fn().mockResolvedValue({
      path: "/project1/movie1",
      parameter: "cuepulse",
      style: "Pulse",
      pulsed: true,
    });

    const result = await pulseTdParameterImpl(makeCtx({ pulseParameter }), {
      path: "/project1/movie1",
      parameter: "cuepulse",
    });

    expect(pulseParameter).toHaveBeenCalledWith("/project1/movie1", "cuepulse");
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Pulsed /project1/movie1.par.cuepulse (Pulse)");
  });

  it("does not report success when the bridge cannot confirm the pulse", async () => {
    const result = await pulseTdParameterImpl(
      makeCtx({
        pulseParameter: vi.fn().mockResolvedValue({
          path: "/project1/movie1",
          parameter: "cuepulse",
          style: "Pulse",
          pulsed: false,
        }),
      }),
      { path: "/project1/movie1", parameter: "cuepulse" },
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("did not confirm");
  });

  it("surfaces typed bridge validation failures", async () => {
    const result = await pulseTdParameterImpl(
      makeCtx({
        pulseParameter: vi.fn().mockRejectedValue(
          new TdApiError("speed is Float style", {
            status: 400,
            apiCode: "invalid_parameter_type",
          }),
        ),
      }),
      { path: "/project1/movie1", parameter: "speed" },
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("[invalid_parameter_type]");
  });
});
