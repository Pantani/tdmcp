import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  buildTouchengineNotchScript,
  type ConnectTouchengineNotchReport,
  connectTouchengineNotchImpl,
  connectTouchengineNotchSchema,
} from "../../src/tools/layer2/connectTouchengineNotch.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface TouchenginePayload {
  parent_path: string;
  name: string;
  mode: "touchengine" | "notch_top" | "ndi_fallback" | "syphon_spout_fallback";
  tox_or_block_path: string | null;
  input_top_path: string | null;
  output_name: string;
  control_channels: string[];
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

function decodePayload(script: string): TouchenginePayload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as TouchenginePayload;
}

function execOk(report: ConnectTouchengineNotchReport) {
  return HttpResponse.json({ ok: true, data: { result: null, stdout: JSON.stringify(report) } });
}

describe("connect_touchengine_notch", () => {
  it("round-trips TouchEngine payload values", () => {
    const payload: TouchenginePayload = {
      parent_path: "/project1",
      name: "te",
      mode: "touchengine",
      tox_or_block_path: "/blocks/show.toe",
      input_top_path: "/project1/out1",
      output_name: "beauty",
      control_channels: ["intensity", "speed"],
      active: true,
    };
    expect(decodePayload(buildTouchengineNotchScript(payload))).toEqual(payload);
  });

  it("returns the output TOP and licensing warning for TouchEngine mode", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        capturedScript = ((await request.json()) as { script: string }).script;
        return execOk({
          container_path: "/project1/touchengine_notch",
          mode: "touchengine",
          host_op: "/project1/touchengine_notch/touchengine_host",
          output_top: "/project1/touchengine_notch/notch_out",
          controls_in: "/project1/touchengine_notch/controls_in",
          status_dat: "/project1/touchengine_notch/status",
          setup_dat: "/project1/touchengine_notch/setup_notes",
          warnings: ["TouchEngine mode requires installed TouchEngine runtime/licensing."],
        });
      }),
    );

    const result = await connectTouchengineNotchImpl(
      makeCtx(),
      connectTouchengineNotchSchema.parse({
        tox_or_block_path: "/blocks/show.tox",
        input_top_path: "/project1/final",
        control_channels: ["gain"],
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("TouchEngine mode");
    expect(textOf(result)).toContain("notch_out");
    expect(capturedScript).toContain("engineCOMP");
    expect(capturedScript).toContain("notchTOP");
    expect(capturedScript).toContain("nodeX");
    expect(decodePayload(capturedScript).control_channels).toEqual(["gain"]);
  });

  it("supports fallback mode and fatal parent errors", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({
          container_path: "/project1/touchengine_notch",
          mode: "ndi_fallback",
          output_top: "/project1/touchengine_notch/notch_out",
          warnings: ["Using NDI fallback instead of direct TouchEngine/Notch host."],
        }),
      ),
    );

    const fallback = await connectTouchengineNotchImpl(
      makeCtx(),
      connectTouchengineNotchSchema.parse({ mode: "ndi_fallback" }),
    );
    expect(fallback.isError).toBeFalsy();
    expect(textOf(fallback)).toContain("ndi_fallback");

    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ warnings: [], fatal: "Parent COMP not found: /missing" }),
      ),
    );

    await expect(
      connectTouchengineNotchImpl(
        makeCtx(),
        connectTouchengineNotchSchema.parse({ parent_path: "/missing" }),
      ),
    ).resolves.toMatchObject({ isError: true });
  });
});
