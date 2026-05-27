import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import { createAutopilotImpl } from "../../src/tools/layer1/createAutopilot.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer, TD_BASE } from "../helpers/tdMock.js";

interface CreatedNodeBody {
  parent_path: string;
  type: string;
  name?: string;
  parameters?: Record<string, unknown>;
}

interface PanelControl {
  name: string;
  type?: string;
  default?: unknown;
  bind_to?: string[];
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
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function captureCreateBodies(): CreatedNodeBody[] {
  const bodies: CreatedNodeBody[] = [];
  server.use(
    http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
      const body = (await request.json()) as CreatedNodeBody;
      bodies.push(body);
      const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
      return HttpResponse.json({
        ok: true,
        data: { path: `${body.parent_path}/${name}`, type: body.type, name },
      });
    }),
  );
  return bodies;
}

function captureExecScripts(): string[] {
  const scripts: string[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
  return scripts;
}

function panelControls(scripts: string[]): PanelControl[] {
  const panel = scripts.find((s) => s.includes("appendCustomPage"));
  const b64 = /b64decode\("([^"]+)"\)/.exec(panel ?? "")?.[1];
  if (b64 === undefined) return [];
  const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
    controls: PanelControl[];
  };
  return payload.controls;
}

describe("create_autopilot", () => {
  it("builds a Beat CHOP + CHOP Execute engine watching the cumulative beat count (no image)", async () => {
    const bodies = captureCreateBodies();
    const result = await createAutopilotImpl(makeCtx(), {
      comp_path: "/project1/viz",
      mode: "randomize",
      beats: 4,
      amount: 0.5,
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();

    const beat = bodies.find((b) => b.name === "beat");
    expect(beat?.type).toBe("beatCHOP");
    expect(beat?.parameters).toMatchObject({ count: 1, beat: 1 });

    const engine = bodies.find((b) => b.name === "engine");
    expect(engine?.type).toBe("chopexecuteDAT");
    // Fires once per beat off the cumulative `count` channel.
    expect(engine?.parameters).toMatchObject({ channel: "count", valuechange: 1, active: 1 });
    expect(String(engine?.parameters?.chop)).toMatch(/\/beat$/);

    // The engine is a CHOP driver — no visual output to preview.
    expect(result.content.some((c) => c.type === "image")).toBe(false);
  });

  it("bakes the target COMP path and randomize mode into the engine callback", async () => {
    const scripts = captureExecScripts();
    await createAutopilotImpl(makeCtx(), {
      comp_path: "/project1/viz",
      mode: "randomize",
      beats: 4,
      amount: 0.5,
      parent_path: "/project1",
    });
    const engineText = scripts.find((s) => s.includes("def onValueChange"));
    expect(engineText).toBeDefined();
    // Placeholders are fully substituted (none left in the deployed callback).
    expect(engineText).not.toContain("__COMP__");
    expect(engineText).not.toContain("__MODE__");
    expect(engineText).toContain("/project1/viz");
    // randomize mode nudges the target's numeric custom params toward random.
    expect(engineText).toContain("customPars");
    expect(engineText).toContain("random.uniform");
  });

  it("drives stored cues (not randomization) in cue mode", async () => {
    const scripts = captureExecScripts();
    const result = await createAutopilotImpl(makeCtx(), {
      comp_path: "/project1/panel",
      mode: "cue",
      beats: 8,
      amount: 0.5,
      parent_path: "/project1",
    });
    const engineText = scripts.find((s) => s.includes("def onValueChange"));
    expect(engineText).toContain("'cue'");
    expect(engineText).toContain("tdmcp_cues");
    // Cue mode needs cues stored on the target first — the summary says so.
    expect(textOf(result)).toContain("manage_cue");
  });

  it("exposes live Active / Beats / Amount knobs seeded from the args", async () => {
    const scripts = captureExecScripts();
    await createAutopilotImpl(makeCtx(), {
      comp_path: "/project1/viz",
      mode: "randomize",
      beats: 8,
      amount: 0.3,
      parent_path: "/project1",
    });
    const controls = panelControls(scripts);
    expect(controls.map((c) => c.name)).toEqual(["Active", "Beats", "Amount"]);
    expect(controls.find((c) => c.name === "Beats")?.default).toBe(8);
    expect(controls.find((c) => c.name === "Amount")?.default).toBe(0.3);
  });
});
