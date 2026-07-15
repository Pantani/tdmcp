import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectDiscordInteractionBusImpl,
  connectDiscordInteractionBusSchema,
} from "../../src/tools/layer2/connectDiscordInteractionBus.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";
import { decodePayload, execOk, makeCtx, textOf } from "./externalShowBridgeTestUtils.js";

const server = makeTdServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("connectDiscordInteractionBusImpl", () => {
  it("builds a Discord interaction bus scaffold payload", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        expect(body.return_output).toBe(true);
        capturedScript = String(body.script ?? "");
        return execOk({
          kind: "discord_interaction_bus",
          container_path: "/project1/discord_interaction_bus",
          nodes: { command_map: "/project1/discord_interaction_bus/command_map" },
          warnings: [],
        });
      }),
    );

    const args = connectDiscordInteractionBusSchema.parse({
      guild_label: "venue_guild",
      channel_label: "booth",
      command_count: 3,
      message_count: 5,
    });
    const result = await connectDiscordInteractionBusImpl(makeCtx(), args);
    const payload = decodePayload(capturedScript);

    expect(result.isError).toBeFalsy();
    expect(payload.metadata.channel_label).toBe("booth");
    expect(payload.nodes.find((node) => node.name === "discord_gateway_adapter")?.optype).toBe(
      "websocketDAT",
    );
    expect(payload.nodes.find((node) => node.name === "command_map")?.table?.join(" ")).toContain(
      "/show_3",
    );
    expect(capturedScript).toContain("nodeY");
    expect(textOf(result)).toContain("Created Discord interaction bus");
  });

  it("returns isError for fatal reports", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ kind: "discord_interaction_bus", warnings: [], fatal: "Parent COMP not found" }),
      ),
    );

    const result = await connectDiscordInteractionBusImpl(
      makeCtx(),
      connectDiscordInteractionBusSchema.parse({}),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connect_discord_interaction_bus failed");
  });

  it("rejects negative command counts", () => {
    expect(() => connectDiscordInteractionBusSchema.parse({ command_count: -1 })).toThrow();
  });
});
