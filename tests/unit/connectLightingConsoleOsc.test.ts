import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectLightingConsoleOscImpl,
  connectLightingConsoleOscSchema,
} from "../../src/tools/layer2/connectLightingConsoleOsc.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectLightingConsoleOscImpl", () => {
  it("builds a safety-gated lighting-console OSC payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown };
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "lighting_console_osc",
          container_path: "/project1/lighting_console_osc",
          nodes: { policy_gate: "/project1/lighting_console_osc/policy_gate" },
          warnings: [],
        });
      }),
    );

    const args = connectLightingConsoleOscSchema.parse({
      console_family: "grandma3",
      console_host: "10.0.0.50",
      cue_count: 3,
      executor_count: 2,
      safety_mode: "approval_required",
      active: true,
    });
    const result = await connectLightingConsoleOscImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("lighting_console_osc");
    expect(payload.metadata.console_family).toBe("grandma3");
    expect(payload.metadata.safety_mode).toBe("approval_required");
    expect(payload.nodes.map((node) => node.name)).toContain("policy_gate");
    expect(payload.warnings.join(" ")).toContain("does not send direct DMX");
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created lighting-console OSC scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "lighting_console_osc", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectLightingConsoleOscImpl(
      makeCtx(),
      connectLightingConsoleOscSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_lighting_console_osc failed");
  });

  it("rejects unknown console families", () => {
    expect(() => connectLightingConsoleOscSchema.parse({ console_family: "unknown" })).toThrow();
  });
});
