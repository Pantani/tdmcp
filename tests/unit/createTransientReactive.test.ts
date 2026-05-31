import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createTransientReactiveImpl,
  createTransientReactiveSchema,
} from "../../src/tools/layer1/createTransientReactive.js";
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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

interface CapturedExec {
  scripts: string[];
  payloads: Record<string, unknown>[];
}

function captureExec(report: object): CapturedExec {
  const cap: CapturedExec = { scripts: [], payloads: [] };
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      cap.scripts.push(body.script);
      const m = /b64decode\("([^"]+)"\)/.exec(body.script);
      if (m?.[1]) {
        cap.payloads.push(
          JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) as Record<string, unknown>,
        );
      }
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: JSON.stringify(report) },
      });
    }),
  );
  return cap;
}

const defaultReport = {
  compPath: "/proj1/myTR",
  outPath: "/proj1/myTR/out",
  channels: ["transient", "sustain"],
  warnings: [],
};

describe("create_transient_reactive", () => {
  it("returns structuredContent with compPath/outPath/channels", async () => {
    captureExec(defaultReport);
    const res = await createTransientReactiveImpl(makeCtx(), {
      name: "myTR",
      parent: "/proj1",
      audioSource: "",
      fastAttackMs: 1,
      fastReleaseMs: 20,
      slowAttackMs: 50,
      slowReleaseMs: 200,
      sensitivity: 1.0,
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as {
      compPath: string;
      outPath: string;
      channels: string[];
    };
    expect(sc.compPath).toBe("/proj1/myTR");
    expect(sc.outPath).toBe("/proj1/myTR/out");
    expect(sc.channels).toEqual(["transient", "sustain"]);
    expect(sc.channels.length).toBe(2);
    expect(textOf(res)).toContain("/proj1/myTR/out");
  });

  it("embeds the network topology (baseCOMP, analyzeCHOP+filterCHOP x2, scriptCHOP, nullCHOP, custom pars)", async () => {
    const cap = captureExec(defaultReport);
    await createTransientReactiveImpl(makeCtx(), {
      name: "tr1",
      parent: "/project1",
      audioSource: "",
      fastAttackMs: 2.5,
      fastReleaseMs: 20,
      slowAttackMs: 50,
      slowReleaseMs: 200,
      sensitivity: 1.0,
    });
    const script = cap.scripts[0] ?? "";
    expect(script).toContain("baseCOMP");
    // analyzeCHOP + filterCHOP appear twice each (fast + slow)
    expect(script.match(/analyzeCHOP/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(script.match(/filterCHOP/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(script).not.toContain("envelopeCHOP");
    expect(script).toContain("scriptCHOP");
    expect(script).toContain("nullCHOP");
    expect(script).toContain('"Sensitivity"');
    expect(script).toContain('"Fastattack"');
    expect(script).toContain('"Fastrelease"');
    expect(script).toContain('"Slowattack"');
    expect(script).toContain('"Slowrelease"');
    // filterCHOP exposes separate attack/release as tcompup/tcompdown (in seconds)
    expect(script).toContain("tcompup");
    expect(script).toContain("tcompdown");
    expect(script).not.toMatch(/"attack"/);
    expect(script).not.toMatch(/"release"/);
    // numeric override travels in the payload
    expect(cap.payloads[0]?.fastAttackMs).toBe(2.5);
  });

  it("uses a selectCHOP wired to audioSource when one is provided (not audioDeviceIn)", async () => {
    const cap = captureExec(defaultReport);
    await createTransientReactiveImpl(makeCtx(), {
      name: "tr1",
      parent: "/project1",
      audioSource: "/proj1/audio/bus_out",
      fastAttackMs: 1,
      fastReleaseMs: 20,
      slowAttackMs: 50,
      slowReleaseMs: 200,
      sensitivity: 1.0,
    });
    const script = cap.scripts[0] ?? "";
    expect(script).toContain("selectCHOP");
    expect(cap.payloads[0]?.audioSource).toBe("/proj1/audio/bus_out");
  });

  it("schema enforces defaults and rejects bad inputs", () => {
    const parsed = createTransientReactiveSchema.parse({ name: "ok" });
    expect(parsed.parent).toBe("/");
    expect(parsed.audioSource).toBe("");
    expect(parsed.fastAttackMs).toBe(1);
    expect(parsed.fastReleaseMs).toBe(20);
    expect(parsed.slowAttackMs).toBe(50);
    expect(parsed.slowReleaseMs).toBe(200);
    expect(parsed.sensitivity).toBe(1.0);

    expect(() => createTransientReactiveSchema.parse({ name: "ok", fastAttackMs: 0 })).toThrow();
    expect(() => createTransientReactiveSchema.parse({ name: "ok", sensitivity: -1 })).toThrow();
    expect(() => createTransientReactiveSchema.parse({ name: "1bad" })).toThrow();
  });

  it("surfaces a fatal report as isError", async () => {
    captureExec({
      compPath: "",
      outPath: "",
      channels: ["transient", "sustain"],
      warnings: [],
      fatal: "Parent COMP not found: /missing",
    });
    const res = await createTransientReactiveImpl(makeCtx(), {
      name: "tr1",
      parent: "/missing",
      audioSource: "",
      fastAttackMs: 1,
      fastReleaseMs: 20,
      slowAttackMs: 50,
      slowReleaseMs: 200,
      sensitivity: 1.0,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Parent COMP not found");
  });
});
