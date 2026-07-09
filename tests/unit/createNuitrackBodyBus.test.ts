import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildNuitrackBodyBusScript,
  createNuitrackBodyBusImpl,
  createNuitrackBodyBusSchema,
  type NuitrackBodyBusReport,
} from "../../src/tools/layer1/createNuitrackBodyBus.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface NuitrackPayload {
  parent_path: string;
  name: string;
  source: "osc" | "websocket" | "tcp_json" | "sample";
  listen_port: number;
  server_url: string;
  joint_set: "upper_body" | "full_body" | "hands";
  max_bodies: number;
  channel_prefix: string;
  active: boolean;
}

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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

function decodePayload(script: string): NuitrackPayload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as NuitrackPayload;
}

function execOk(report: NuitrackBodyBusReport) {
  return HttpResponse.json({ ok: true, data: { result: null, stdout: JSON.stringify(report) } });
}

describe("create_nuitrack_body_bus", () => {
  it("round-trips transport and channel settings through the base64 payload", () => {
    const payload: NuitrackPayload = {
      parent_path: "/project1",
      name: "nt",
      source: "websocket",
      listen_port: 7010,
      server_url: "ws://nuitrack.local:8767",
      joint_set: "hands",
      max_bodies: 3,
      channel_prefix: "skel",
      active: true,
    };
    expect(decodePayload(buildNuitrackBodyBusScript(payload))).toEqual(payload);
  });

  it("returns the body_bus output and setup warnings on OSC success", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        capturedScript = ((await request.json()) as { script: string }).script;
        return execOk({
          container_path: "/project1/nuitrack_body_bus",
          source: "osc",
          joint_set: "full_body",
          receiver: "/project1/nuitrack_body_bus/nuitrack_osc",
          raw_skeleton: "/project1/nuitrack_body_bus/raw_skeleton",
          body_bus: "/project1/nuitrack_body_bus/body_bus",
          status_dat: "/project1/nuitrack_body_bus/status",
          setup_dat: "/project1/nuitrack_body_bus/setup_notes",
          channels: ["body0_head_x", "body0_head_y"],
          warnings: ["Live Nuitrack SDK not validated."],
        });
      }),
    );

    const result = await createNuitrackBodyBusImpl(
      makeCtx(),
      createNuitrackBodyBusSchema.parse({ listen_port: 7010, active: true }),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("/project1/nuitrack_body_bus/body_bus");
    expect(textOf(result)).toContain("Live Nuitrack SDK not validated");
    expect(capturedScript).toContain("nodeX");
    expect(capturedScript).toContain("websocketDAT");
    expect(decodePayload(capturedScript).listen_port).toBe(7010);
  });

  it("returns isError for fatal reports without throwing", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ warnings: [], fatal: "Parent COMP not found: /missing" }),
      ),
    );

    await expect(
      createNuitrackBodyBusImpl(
        makeCtx(),
        createNuitrackBodyBusSchema.parse({ parent_path: "/missing" }),
      ),
    ).resolves.toMatchObject({ isError: true });
  });

  it("rejects invalid body and port counts at the schema boundary", () => {
    expect(() => createNuitrackBodyBusSchema.parse({ max_bodies: 9 })).toThrow();
    expect(() => createNuitrackBodyBusSchema.parse({ listen_port: 0 })).toThrow();
  });
});
