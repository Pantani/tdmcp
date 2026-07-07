import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  createFixtureControlImpl,
  createFixtureControlSchema,
} from "../../src/tools/layer1/createFixtureControl.js";
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

// Capture the exec script(s) and decode the base64 payload of the fixture-control pass.
function captureExecPayloads(reportStdout?: string): { scripts: string[]; payloads: unknown[] } {
  const scripts: string[] = [];
  const payloads: unknown[] = [];
  server.use(
    http.post(`${TD_BASE}/api/exec`, async ({ request }) => {
      const body = (await request.json()) as { script: string };
      scripts.push(body.script);
      const m = body.script.match(/b64decode\("([^"]+)"\)/);
      if (m?.[1]) {
        payloads.push(JSON.parse(Buffer.from(m[1], "base64").toString("utf8")));
      }
      return HttpResponse.json({
        ok: true,
        data: { result: null, stdout: reportStdout ?? "" },
      });
    }),
  );
  return { scripts, payloads };
}

const okReport = JSON.stringify({
  container: "/project1/fixture_rig",
  fixtures: [
    {
      id: "mh1",
      constant: "/project1/fixture_rig/mh1",
      geo: "/project1/fixture_rig/head_mh1",
      beam: "/project1/fixture_rig/head_mh1/beam",
      startChannel: 1,
    },
  ],
  merge: "/project1/fixture_rig/merge",
  out: "/project1/fixture_rig/rig_out",
  dmx: "/project1/fixture_rig/dmx",
  render: "/project1/fixture_rig/previz",
  universe: 1,
  totalChannels: 8,
  controls: [],
  errors: [],
  warnings: [],
});

const DEFAULT_ARGS = {
  name: "fixture_rig",
  parent_path: "/project1",
  host: null,
  universe: 1,
  net: "artnet" as const,
  fps: 40,
  pan_range: 540,
  tilt_range: 270,
  beam_length: 8,
  beam_angle: 12,
  fixtures: [{ id: "mh1", startChannel: 1, x: 0, y: 3, z: 0 }],
};

describe("create_fixture_control", () => {
  it("sends a payload with fixtures, movingHead8 channels, and previz ranges", async () => {
    const { scripts, payloads } = captureExecPayloads(okReport);
    const result = await createFixtureControlImpl(makeCtx(), {
      ...DEFAULT_ARGS,
      fixtures: [{ id: "mh1", startChannel: 1, x: 2, y: 4, z: -1 }],
    });
    expect(result.isError).toBeFalsy();

    const payload = payloads[0] as {
      channels: string[];
      defaults: number[];
      pan_range: number;
      tilt_range: number;
      beam_length: number;
      fixtures: Array<{ id: string; startChannel: number; x: number; y: number; z: number }>;
    };
    expect(payload.channels).toContain("pan");
    expect(payload.channels).toContain("tilt");
    expect(payload.channels).toContain("gobo");
    expect(payload.defaults).toHaveLength(8);
    expect(payload.pan_range).toBe(540);
    expect(payload.tilt_range).toBe(270);
    expect(payload.beam_length).toBe(8);
    expect(payload.fixtures[0]).toMatchObject({ id: "mh1", startChannel: 1, x: 2, y: 4, z: -1 });

    // The script drives geo rx/ry by expression from the pan/tilt channels + builds a render.
    expect(scripts[0]).toContain("geometryCOMP");
    expect(scripts[0]).toContain("renderTOP");
    expect(scripts[0]).toContain("dmxoutCHOP");

    const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
    expect(text?.text).toContain("previz");
  });

  it("applies schema defaults", () => {
    const parsed = createFixtureControlSchema.parse({
      fixtures: [{ id: "mh1", startChannel: 1 }],
    });
    expect(parsed.name).toBe("fixture_rig");
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.universe).toBe(1);
    expect(parsed.net).toBe("artnet");
    expect(parsed.pan_range).toBe(540);
    expect(parsed.tilt_range).toBe(270);
    expect(parsed.beam_angle).toBe(12);
    // Per-fixture position defaults.
    expect(parsed.fixtures[0]).toMatchObject({ x: 0, y: 3, z: 0 });
  });

  it("rejects bad input at the schema boundary", () => {
    expect(() => createFixtureControlSchema.parse({ fixtures: [] })).toThrow();
    expect(() =>
      createFixtureControlSchema.parse({
        fixtures: [
          { id: "mh1", startChannel: 1 },
          { id: "mh1", startChannel: 9 },
        ],
      }),
    ).toThrow(); // duplicate id
    expect(() =>
      createFixtureControlSchema.parse({ fixtures: [{ id: "1bad", startChannel: 1 }] }),
    ).toThrow(); // invalid TD name
    expect(() =>
      createFixtureControlSchema.parse({ fixtures: [{ id: "mh1", startChannel: 999 }] }),
    ).toThrow(); // out of DMX range
  });

  it("returns isError (never throws) when the bridge reports fatal", async () => {
    captureExecPayloads(JSON.stringify({ fatal: "Parent COMP not found: /nope", warnings: [] }));
    const result = await createFixtureControlImpl(makeCtx(), {
      ...DEFAULT_ARGS,
      parent_path: "/nope",
    });
    expect(result.isError).toBe(true);
  });

  it("returns isError when the bridge is offline (no throw)", async () => {
    server.use(
      http.post(`${TD_BASE}/api/exec`, () =>
        HttpResponse.json({ ok: false, error: "TouchDesigner is offline" }, { status: 502 }),
      ),
    );
    const result = await createFixtureControlImpl(makeCtx(), { ...DEFAULT_ARGS });
    expect(result.isError).toBe(true);
  });
});
