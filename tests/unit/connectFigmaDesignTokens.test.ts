import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectFigmaDesignTokensImpl,
  connectFigmaDesignTokensSchema,
} from "../../src/tools/layer2/connectFigmaDesignTokens.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectFigmaDesignTokensImpl", () => {
  it("builds a Figma design token scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "figma_design_tokens",
          container_path: "/project1/figma_design_tokens",
          nodes: { token_map: "/project1/figma_design_tokens/token_map" },
          warnings: [],
        });
      }),
    );

    const args = connectFigmaDesignTokensSchema.parse({
      file_key: "abc123",
      token_format: "css_variables",
      token_count: 6,
      component_count: 2,
    });
    const result = await connectFigmaDesignTokensImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.file_key).toBe("abc123");
    expect(payload.nodes.find((node) => node.name === "figma_client")?.optype).toBe("webclientDAT");
    expect(payload.nodes.find((node) => node.name === "token_map")?.table?.join(" ")).toContain(
      "token_6",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Figma design token bridge");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "figma_design_tokens", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectFigmaDesignTokensImpl(
      makeCtx(),
      connectFigmaDesignTokensSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_figma_design_tokens failed");
  });

  it("rejects invalid token counts", () => {
    expect(() => connectFigmaDesignTokensSchema.parse({ token_count: 0 })).toThrow();
  });
});
