import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  type ConnectObsRecorderReport,
  connectObsRecorderImpl,
  connectObsRecorderSchema,
} from "../../src/tools/layer2/connectObsRecorder.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface ObsRecorderPayload {
  parent: string;
  name: string;
  obs_url: string;
  password?: string;
  scene_name: string | null;
  source_top_path: string | null;
  output_mode: "ndi" | "syphon_spout" | "none";
  recording_profile: "rehearsal" | "stream" | "archive";
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

function parseJsonFence(result: CallToolResult): ConnectObsRecorderReport {
  const match = /```json\n([\s\S]+?)\n```/.exec(textOf(result));
  if (!match?.[1]) throw new Error("no JSON fence in result");
  return JSON.parse(match[1]) as ConnectObsRecorderReport;
}

function decodePayload(script: string): ObsRecorderPayload {
  const encoded = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (encoded === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as ObsRecorderPayload;
}

function execOk(report: object) {
  return HttpResponse.json({
    ok: true,
    data: { result: null, stdout: JSON.stringify(report) },
  });
}

describe("connectObsRecorderImpl", () => {
  it("builds the OBS scaffold payload and redacts the password from success output", async () => {
    const password = randomUUID();
    let capturedScript = "";
    let capturedPayload: ObsRecorderPayload | undefined;
    let returnOutput: unknown;

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown; return_output?: unknown };
        returnOutput = body.return_output;
        if (typeof body.script === "string") {
          capturedScript = body.script;
          capturedPayload = decodePayload(body.script);
        }
        return execOk({
          kind: "obs_recorder",
          container_path: "/project1/obs_recorder",
          websocket_dat: "/project1/obs_recorder/obs_ws",
          callbacks_dat: "/project1/obs_recorder/obs_ws_callbacks",
          request_dats: [
            "/project1/obs_recorder/req_start_record",
            "/project1/obs_recorder/req_stop_record",
            "/project1/obs_recorder/req_set_scene",
          ],
          status_dat: "/project1/obs_recorder/status",
          setup_dat: "/project1/obs_recorder/setup",
          sender_top: "/project1/obs_recorder/ndi_out",
          sender_kind: "ndi",
          obs_url: "ws://10.0.0.2:4455",
          scene_name: "Main",
          output_mode: "ndi",
          recording_profile: "stream",
          active: true,
          auth_status: "password redacted",
          warnings: [],
          errors: [],
        } satisfies ConnectObsRecorderReport);
      }),
    );

    const args = connectObsRecorderSchema.parse({
      obs_url: "ws://10.0.0.2:4455",
      password,
      scene_name: "Main",
      source_top_path: "/project1/out1",
      output_mode: "ndi",
      recording_profile: "stream",
      active: true,
    });
    const result = await connectObsRecorderImpl(makeCtx(), args);

    expect(result.isError).toBeFalsy();
    expect(returnOutput).toBe(true);
    expect(capturedPayload).toBeDefined();
    expect(capturedPayload?.password).toBe(password);
    expect(capturedPayload?.obs_url).toBe("ws://10.0.0.2:4455");
    expect(capturedPayload?.scene_name).toBe("Main");
    expect(capturedPayload?.output_mode).toBe("ndi");
    expect(capturedPayload?.recording_profile).toBe("stream");
    expect(capturedPayload?.active).toBe(true);

    expect(capturedScript).toContain("websocketDAT");
    expect(capturedScript).toContain("tableDAT");
    expect(capturedScript).toContain("nodeX");
    expect(capturedScript).toContain("nodeY");
    expect(capturedScript).toContain("_place(");
    expect(capturedScript).not.toContain(password);

    const text = textOf(result);
    expect(text).toContain("Created OBS recorder scaffold");
    expect(text).toContain("ws://10.0.0.2:4455");
    expect(text).not.toContain(password);
    expect(JSON.stringify(parseJsonFence(result))).not.toContain(password);
    expect(parseJsonFence(result).auth_status).toBe("password redacted");
  });

  it("omits password from the payload when no password is passed", async () => {
    let capturedPayload: ObsRecorderPayload | undefined;

    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        const body = (await request.json()) as { script?: unknown };
        if (typeof body.script === "string") {
          capturedPayload = decodePayload(body.script);
        }
        return execOk({
          kind: "obs_recorder",
          container_path: "/project1/obs_no_auth",
          request_dats: ["/project1/obs_no_auth/req_start_record"],
          status_dat: "/project1/obs_no_auth/status",
          setup_dat: "/project1/obs_no_auth/setup",
          sender_top: "/project1/obs_no_auth/syphon_spout_out",
          sender_kind: "syphon_spout",
          obs_url: "ws://127.0.0.1:4455",
          scene_name: "Program",
          output_mode: "syphon_spout",
          recording_profile: "archive",
          active: false,
          auth_status: "none",
          warnings: [],
          errors: [],
        } satisfies ConnectObsRecorderReport);
      }),
    );

    const args = connectObsRecorderSchema.parse({
      name: "obs_no_auth",
      scene_name: "Program",
      source_top_path: "/project1/final",
      output_mode: "syphon_spout",
      recording_profile: "archive",
    });
    const result = await connectObsRecorderImpl(makeCtx(), args);

    expect(result.isError).toBeFalsy();
    expect(capturedPayload).toBeDefined();
    expect(capturedPayload && "password" in capturedPayload).toBe(false);
    expect(capturedPayload?.obs_url).toBe("ws://127.0.0.1:4455");
    expect(capturedPayload?.scene_name).toBe("Program");
    expect(capturedPayload?.output_mode).toBe("syphon_spout");
    expect(capturedPayload?.recording_profile).toBe("archive");
    expect(parseJsonFence(result).auth_status).toBe("none");
  });

  it("returns isError for fatal reports and redacts any secret without throwing", async () => {
    const password = randomUUID();

    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({
          kind: "obs_recorder",
          obs_url: "ws://127.0.0.1:4455",
          output_mode: "none",
          recording_profile: "rehearsal",
          active: false,
          auth_status: "password redacted",
          warnings: [`bridge warning included ${password}`],
          fatal: `OBS websocket auth failed for ${password}`,
        } satisfies ConnectObsRecorderReport),
      ),
    );

    const args = connectObsRecorderSchema.parse({ password, output_mode: "none" });
    const result = await connectObsRecorderImpl(makeCtx(), args);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("connect_obs_recorder failed");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(password);
    expect(JSON.stringify(parseJsonFence(result))).not.toContain(password);
  });
});
