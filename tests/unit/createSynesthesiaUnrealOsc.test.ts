import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createSynesthesiaUnrealOscImpl,
  createSynesthesiaUnrealOscSchema,
  OSC_PRESETS,
} from "../../src/tools/layer2/createSynesthesiaUnrealOsc.js";
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

function captureExec(reportStdout?: string): { scripts: string[]; payloads: unknown[] } {
  const scripts: string[] = [];
  const payloads: unknown[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      const m = body.script.match(/b64decode\("([^"]+)"\)/);
      if (m?.[1]) payloads.push(JSON.parse(Buffer.from(m[1], "base64").toString("utf8")));
      return HttpResponse.json({ ok: true, data: { result: null, stdout: reportStdout ?? "" } });
    }),
  );
  return { scripts, payloads };
}

function okReport(preset: string, prefix: string, port: number, controls: string[]): string {
  return JSON.stringify({
    container: "/project1/osc_send",
    source: "/project1/osc_send/controls",
    osc_out: "/project1/osc_send/osc",
    preset,
    prefix,
    host: "127.0.0.1",
    port,
    addresses: controls.map((c) => `/${prefix}/${c}`),
    controls,
    errors: [],
    warnings: [],
  });
}

describe("create_synesthesia_unreal_osc", () => {
  it("uses the synesthesia preset prefix, port, and default controls", async () => {
    const { scripts, payloads } = captureExec(
      okReport("synesthesia", "syn", 6448, [...OSC_PRESETS.synesthesia.controls]),
    );
    const result = await createSynesthesiaUnrealOscImpl(makeCtx(), {
      name: "osc_send",
      parent_path: "/project1",
      preset: "synesthesia",
      host: "127.0.0.1",
      port: null,
      controls: null,
      prefix: null,
      active: false,
    });
    expect(result.isError).toBeFalsy();

    const payload = payloads[0] as {
      preset: string;
      prefix: string;
      port: number;
      controls: string[];
    };
    expect(payload.preset).toBe("synesthesia");
    expect(payload.prefix).toBe("syn");
    expect(payload.port).toBe(6448);
    expect(payload.controls).toContain("Bass");
    expect(scripts[0]).toContain("oscoutCHOP");
    expect(scripts[0]).toContain("constantCHOP");

    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("synesthesia");
    expect(text?.text).toContain("/syn/");
  });

  it("uses the unreal preset defaults", async () => {
    const { payloads } = captureExec(
      okReport("unreal", "unreal", 8000, [...OSC_PRESETS.unreal.controls]),
    );
    const result = await createSynesthesiaUnrealOscImpl(makeCtx(), {
      name: "osc_send",
      parent_path: "/project1",
      preset: "unreal",
      host: "127.0.0.1",
      port: null,
      controls: null,
      prefix: null,
      active: false,
    });
    expect(result.isError).toBeFalsy();
    const payload = payloads[0] as { prefix: string; port: number };
    expect(payload.prefix).toBe("unreal");
    expect(payload.port).toBe(8000);
  });

  it("honors explicit port, prefix, and controls overrides", async () => {
    const { payloads } = captureExec(okReport("synesthesia", "vibe", 9000, ["Kick", "Snare"]));
    const result = await createSynesthesiaUnrealOscImpl(makeCtx(), {
      name: "osc_send",
      parent_path: "/project1",
      preset: "synesthesia",
      host: "10.0.0.5",
      port: 9000,
      controls: ["Kick", "Snare"],
      prefix: "vibe",
      active: true,
    });
    expect(result.isError).toBeFalsy();
    const payload = payloads[0] as {
      port: number;
      prefix: string;
      controls: string[];
      host: string;
      active: boolean;
    };
    expect(payload.port).toBe(9000);
    expect(payload.prefix).toBe("vibe");
    expect(payload.controls).toEqual(["Kick", "Snare"]);
    expect(payload.host).toBe("10.0.0.5");
    expect(payload.active).toBe(true);
  });

  it("applies schema defaults", () => {
    const parsed = createSynesthesiaUnrealOscSchema.parse({});
    expect(parsed.name).toBe("osc_send");
    expect(parsed.preset).toBe("synesthesia");
    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.port).toBeNull();
    expect(parsed.controls).toBeNull();
    expect(parsed.active).toBe(false);
  });

  it("rejects bad input at the schema boundary", () => {
    expect(() => createSynesthesiaUnrealOscSchema.parse({ preset: "resolume" })).toThrow();
    expect(() => createSynesthesiaUnrealOscSchema.parse({ port: 0 })).toThrow();
    expect(() => createSynesthesiaUnrealOscSchema.parse({ prefix: "bad/prefix" })).toThrow();
    expect(() => createSynesthesiaUnrealOscSchema.parse({ controls: ["1bad"] })).toThrow();
  });

  it("returns isError (never throws) on bridge fatal", async () => {
    captureExec(JSON.stringify({ fatal: "Parent COMP not found: /nope", warnings: [] }));
    const result = await createSynesthesiaUnrealOscImpl(makeCtx(), {
      name: "osc_send",
      parent_path: "/nope",
      preset: "synesthesia",
      host: "127.0.0.1",
      port: null,
      controls: null,
      prefix: null,
      active: false,
    });
    expect(result.isError).toBe(true);
  });

  it("returns isError when the bridge is offline", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({ ok: false, error: "offline" }, { status: 502 }),
      ),
    );
    const result = await createSynesthesiaUnrealOscImpl(makeCtx(), {
      name: "osc_send",
      parent_path: "/project1",
      preset: "synesthesia",
      host: "127.0.0.1",
      port: null,
      controls: null,
      prefix: null,
      active: false,
    });
    expect(result.isError).toBe(true);
  });
});
