import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  atemSwitcherControlImpl,
  atemSwitcherControlSchema,
} from "../../src/tools/layer2/atemSwitcherControl.js";
import { qlabOscBridgeImpl, qlabOscBridgeSchema } from "../../src/tools/layer2/qlabOscBridge.js";
import {
  resolumeVdmxOutputChainImpl,
  resolumeVdmxOutputChainSchema,
} from "../../src/tools/layer2/resolumeVdmxOutputChain.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

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

function decodePayload(script: string) {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (!b64) throw new Error("no embedded payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    name: string;
    routes: Array<{ address: string; channel: string; target_channels: Record<string, string> }>;
    targets: Array<{ name: string; host: string; port: number; prefix: string; active: boolean }>;
  };
}

function capturePayloads() {
  const payloads: ReturnType<typeof decodePayload>[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      const payload = decodePayload(body.script);
      payloads.push(payload);
      return HttpResponse.json({
        ok: true,
        data: {
          result: null,
          stdout: JSON.stringify({
            container: `/project1/${payload.name}`,
            routes: payload.routes,
            targets: payload.targets.map((target) => ({
              name: target.name,
              host: target.host,
              port: target.port,
              source: `/project1/${payload.name}/controls_${target.name}`,
              osc_out: `/project1/${payload.name}/osc_${target.name}`,
              addresses: payload.routes.map((route) => `/${route.target_channels[target.name]}`),
            })),
            warnings: [],
          }),
        },
      });
    }),
  );
  return payloads;
}

describe("external OSC presets", () => {
  it("builds QLab transport routes plus cue-specific starts", async () => {
    const payloads = capturePayloads();
    const result = await qlabOscBridgeImpl(
      makeCtx(),
      qlabOscBridgeSchema.parse({ cue_numbers: ["1", "2.5"], active: true }),
    );
    expect(result.isError).toBeFalsy();
    const payload = payloads[0];
    expect(payload?.targets[0]).toMatchObject({ name: "qlab", port: 53000, active: true });
    expect(payload?.routes.map((route) => route.address)).toEqual(
      expect.arrayContaining(["/go", "/stop", "/panic", "/cue/1/start", "/cue/2.5/start"]),
    );
  });

  it("builds ATEM cut/auto/FTB and program/preview routes through an OSC relay", async () => {
    const payloads = capturePayloads();
    const result = await atemSwitcherControlImpl(
      makeCtx(),
      atemSwitcherControlSchema.parse({ inputs: 2, host: "10.0.0.20" }),
    );
    expect(result.isError).toBeFalsy();
    const payload = payloads[0];
    expect(payload?.targets[0]).toMatchObject({ name: "atem", host: "10.0.0.20", port: 3333 });
    expect(payload?.routes.map((route) => route.address)).toEqual(
      expect.arrayContaining([
        "/atem/cut",
        "/atem/auto",
        "/atem/ftb",
        "/atem/program/1",
        "/atem/preview/2",
      ]),
    );
  });

  it("builds both Resolume and VDMX targets with target-specific prefixes", async () => {
    const payloads = capturePayloads();
    const result = await resolumeVdmxOutputChainImpl(
      makeCtx(),
      resolumeVdmxOutputChainSchema.parse({ target: "both" }),
    );
    expect(result.isError).toBeFalsy();
    const payload = payloads[0];
    expect(payload?.targets.map((target) => target.name)).toEqual(["resolume", "vdmx"]);
    expect(payload?.targets.map((target) => target.port)).toEqual([7000, 8000]);
    expect(payload?.routes[0]?.target_channels).toMatchObject({
      resolume: "composition/layer/1/opacity",
      vdmx: "tdmcp/layer/1/opacity",
    });
  });

  it("rejects unsafe preset inputs at schema boundaries", () => {
    expect(() => qlabOscBridgeSchema.parse({ port: 0 })).toThrow();
    expect(() => atemSwitcherControlSchema.parse({ inputs: 32 })).toThrow();
    expect(() => resolumeVdmxOutputChainSchema.parse({ target: "obs" })).toThrow();
  });
});
