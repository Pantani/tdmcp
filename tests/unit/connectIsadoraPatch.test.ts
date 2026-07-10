import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectIsadoraPatchImpl,
  connectIsadoraPatchSchema,
} from "../../src/tools/layer2/connectIsadoraPatch.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectIsadoraPatchImpl", () => {
  it("normalizes namespace and builds an Isadora OSC bridge payload", async () => {
    let capturedScript = "";

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown };
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "isadora_patch",
          container_path: "/project1/isadora_patch",
          nodes: { actor_map: "/project1/isadora_patch/actor_map" },
          warnings: [],
        });
      }),
    );

    const args = connectIsadoraPatchSchema.parse({
      isadora_host: "10.0.0.91",
      namespace: "show/isadora/",
      scene_count: 2,
      actor_count: 3,
      watcher_count: 2,
      active: true,
    });
    const result = await connectIsadoraPatchImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.kind).toBe("isadora_patch");
    expect(payload.metadata.namespace).toBe("/show/isadora");
    expect(payload.nodes.find((node) => node.name === "actor_map")?.table?.join(" ")).toContain(
      "/show/isadora/actor/3/value",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Isadora patch scaffold");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "isadora_patch", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectIsadoraPatchImpl(makeCtx(), connectIsadoraPatchSchema.parse({}));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_isadora_patch failed");
  });

  it("rejects invalid actor counts", () => {
    expect(() => connectIsadoraPatchSchema.parse({ actor_count: 0 })).toThrow();
  });
});
