import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  connectCompanionSurfaceImpl,
  connectCompanionSurfaceSchema,
} from "../../src/tools/layer2/connectCompanionSurface.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

interface CompanionPayload {
  parent: string;
  name: string;
  listen_port: number;
  feedback_host: string;
  feedback_port: number;
  create_mapping_dat: boolean;
  buttons: Array<{
    label: string;
    address: string;
    target?: string;
    mode: "pulse" | "toggle" | "value";
    feedback_channel?: string;
  }>;
}

function makeCtx(): ToolContext {
  return {
    client: new TouchDesignerClient({ baseUrl: TD_BASE, timeoutMs: 2000 }),
    knowledge: new KnowledgeBase(),
    recipes: new RecipeLibrary(),
    logger: silentLogger,
  };
}

function decodePayload(script: string): CompanionPayload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

function captureWithReport(report: unknown): { scripts: string[]; returnOutputs: boolean[] } {
  const scripts: string[] = [];
  const returnOutputs: boolean[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string; return_output?: boolean };
      scripts.push(body.script);
      returnOutputs.push(Boolean(body.return_output));
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: `bridge log\n${JSON.stringify(report)}\n` },
      });
    }),
  );
  return { scripts, returnOutputs };
}

describe("connect_companion_surface", () => {
  it("sends a normalized multi-button payload to the bridge and summarizes success", async () => {
    const capture = captureWithReport({
      parent: "/project1",
      container: "/project1/companion_surface",
      osc_in: "/project1/companion_surface/osc_in",
      osc_out: "/project1/companion_surface/osc_feedback",
      mapping_dat: "/project1/companion_surface/button_mappings",
      feedback_source: "/project1/companion_surface/feedback_controls",
      buttons: [
        {
          label: "Blackout",
          address: "/show/blackout",
          mode: "pulse",
          select: "/project1/companion_surface/button_01_select",
          null: "/project1/companion_surface/button_01",
          target: "/project1/level1.opacity",
          bound: true,
          feedback_channel: "show/blackout_led",
        },
        {
          label: "Next Cue",
          address: "/button/next_cue",
          mode: "toggle",
          select: "/project1/companion_surface/button_02_select",
          null: "/project1/companion_surface/button_02",
          target: "/project1/switch1.index",
          bound: true,
        },
      ],
      warnings: [],
    });

    const args = connectCompanionSurfaceSchema.parse({
      buttons: [
        {
          label: "Blackout",
          address: "/show/blackout",
          target: "/project1/level1.opacity",
          feedback_channel: "show/blackout_led",
        },
        {
          label: "Next Cue",
          target: "/project1/switch1.index",
          mode: "toggle",
        },
      ],
    });
    const result = await connectCompanionSurfaceImpl(makeCtx(), args);

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Built companion surface /project1/companion_surface");
    expect(textOf(result)).toContain("2 button(s)");
    expect(capture.returnOutputs).toEqual([true]);
    expect(capture.scripts).toHaveLength(1);

    const script = capture.scripts[0] ?? "";
    expect(script).toContain("nodeX");
    expect(script).toContain("nodeY");
    expect(script).toContain("feedback_stub");
    expect(script).toContain("result = report");

    const payload = decodePayload(script);
    expect(payload).toMatchObject({
      parent: "/project1",
      name: "companion_surface",
      listen_port: 9000,
      feedback_host: "127.0.0.1",
      feedback_port: 9001,
      create_mapping_dat: true,
    });
    expect(payload.buttons).toHaveLength(2);
    expect(payload.buttons[0]).toMatchObject({
      label: "Blackout",
      address: "/show/blackout",
      target: "/project1/level1.opacity",
      mode: "pulse",
      feedback_channel: "show/blackout_led",
    });
    expect(payload.buttons[1]).toMatchObject({
      label: "Next Cue",
      address: "/button/next_cue",
      target: "/project1/switch1.index",
      mode: "toggle",
    });
  });

  it("returns warnings for invalid target reports without marking the call as an error", async () => {
    captureWithReport({
      parent: "/project1",
      container: "/project1/companion_surface",
      osc_in: "/project1/companion_surface/osc_in",
      osc_out: "/project1/companion_surface/osc_feedback",
      buttons: [
        {
          label: "Broken",
          address: "/button/broken",
          mode: "value",
          select: "/project1/companion_surface/button_01_select",
          null: "/project1/companion_surface/button_01",
          target: "/project1/missing.value",
          bound: false,
        },
      ],
      warnings: ["Target node not found: /project1/missing"],
    });

    const result = await connectCompanionSurfaceImpl(
      makeCtx(),
      connectCompanionSurfaceSchema.parse({
        buttons: [{ label: "Broken", target: "/project1/missing.value", mode: "value" }],
      }),
    );

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("1 button(s)");
    expect(text).toContain("1 warning(s)");
    expect(text).toContain("Target node not found: /project1/missing");
  });

  it("normalizes edge-case OSC addresses before sending the bridge payload", async () => {
    const capture = captureWithReport({
      parent: "/project1",
      container: "/project1/osc_panel",
      osc_in: "/project1/osc_panel/osc_in",
      osc_out: "/project1/osc_panel/osc_feedback",
      buttons: [],
      warnings: [],
    });

    const result = await connectCompanionSurfaceImpl(
      makeCtx(),
      connectCompanionSurfaceSchema.parse({
        name: "osc_panel",
        listen_port: 9100,
        feedback_host: "192.0.2.50",
        feedback_port: 9101,
        create_mapping_dat: false,
        buttons: [
          { label: "Go Cue", address: "show/go" },
          { label: "Blank Address", address: "   " },
          { label: "!!!" },
        ],
      }),
    );

    expect(result.isError).toBeFalsy();
    const payload = decodePayload(capture.scripts[0] ?? "");
    expect(payload).toMatchObject({
      name: "osc_panel",
      listen_port: 9100,
      feedback_host: "192.0.2.50",
      feedback_port: 9101,
      create_mapping_dat: false,
    });
    expect(payload.buttons.map((button) => button.address)).toEqual([
      "/show/go",
      "/button",
      "/button/button",
    ]);
  });

  it("returns isError for a fatal parent-missing report", async () => {
    captureWithReport({
      parent: "/missing",
      buttons: [],
      warnings: [],
      fatal: "Parent COMP not found: /missing",
    });

    const result = await connectCompanionSurfaceImpl(
      makeCtx(),
      connectCompanionSurfaceSchema.parse({ parent_path: "/missing" }),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found: /missing");
  });

  it("does not throw when the bridge request fails", async () => {
    server.use(http.post(`${TD_BASE}/api/exec`, () => HttpResponse.error()));

    await expect(
      connectCompanionSurfaceImpl(
        makeCtx(),
        connectCompanionSurfaceSchema.parse({ buttons: [{ label: "Go" }] }),
      ),
    ).resolves.toMatchObject({ isError: true });
  });
});
