import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createTouchoscLayoutImpl,
  createTouchoscLayoutSchema,
  type TouchoscLayoutReport,
} from "../../src/tools/layer2/createTouchoscLayout.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface TouchoscPayload {
  parent_path: string;
  name: string;
  receive_port: number;
  send_host: string;
  send_port: number;
  page_name: string;
  create_manifest_dat: boolean;
  controls: Array<{ label: string; address: string; type: string; target?: string }>;
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

function decodePayload(script: string): TouchoscPayload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as TouchoscPayload;
}

function execOk(report: TouchoscLayoutReport) {
  return HttpResponse.json({ ok: true, data: { result: null, stdout: JSON.stringify(report) } });
}

describe("create_touchosc_layout", () => {
  it("normalizes generated addresses and returns manifest/control map paths", async () => {
    let capturedScript = "";
    server.use(
      http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
        capturedScript = ((await request.json()) as { script: string }).script;
        return execOk({
          container: "/project1/touchosc_layout",
          osc_in: "/project1/touchosc_layout/osc_in",
          osc_out: "/project1/touchosc_layout/osc_out",
          manifest_dat: "/project1/touchosc_layout/touchosc_manifest",
          control_map: "/project1/touchosc_layout/control_map",
          controls: [
            { label: "Master Fader", address: "/tdmcp/master_fader", type: "fader" },
            { label: "XY Pad", address: "/xy/pad", type: "xy" },
          ],
          warnings: ["Generated a JSON manifest only."],
        });
      }),
    );

    const result = await createTouchoscLayoutImpl(
      makeCtx(),
      createTouchoscLayoutSchema.parse({
        controls: [
          { label: "Master Fader", target: "/project1/level1.opacity" },
          { label: "XY Pad", address: "xy/pad", type: "xy" },
        ],
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("2 control(s)");
    expect(capturedScript).toContain("touchosc_manifest");
    expect(capturedScript).toContain("feedback_stub");
    expect(capturedScript).toContain("nodeX");
    const payload = decodePayload(capturedScript);
    expect(payload.controls[0]?.address).toBe("/tdmcp/master_fader");
    expect(payload.controls[1]?.address).toBe("/xy/pad");
    expect(payload.controls[0]?.target).toBe("/project1/level1.opacity");
  });

  it("keeps target warnings non-fatal", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({
          container: "/project1/touchosc_layout",
          controls: [{ label: "Broken", address: "/broken", type: "fader" }],
          warnings: ["Target binding for /project1/missing.value is recorded in control_map"],
        }),
      ),
    );

    const result = await createTouchoscLayoutImpl(
      makeCtx(),
      createTouchoscLayoutSchema.parse({
        controls: [{ label: "Broken", target: "/project1/missing.value" }],
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Target binding");
  });

  it("returns isError for fatal reports and validates ports/control count", async () => {
    expect(() => createTouchoscLayoutSchema.parse({ receive_port: 0 })).toThrow();
    expect(() =>
      createTouchoscLayoutSchema.parse({
        controls: Array.from({ length: 65 }, (_, i) => ({ label: `C${i}` })),
      }),
    ).toThrow();

    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        execOk({ controls: [], warnings: [], fatal: "Parent COMP not found: /missing" }),
      ),
    );

    await expect(
      createTouchoscLayoutImpl(
        makeCtx(),
        createTouchoscLayoutSchema.parse({ parent_path: "/missing" }),
      ),
    ).resolves.toMatchObject({ isError: true });
  });
});
