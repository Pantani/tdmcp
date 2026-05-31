import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/knowledge/index.js";
import { RecipeLibrary } from "../../src/recipes/loader.js";
import { TouchDesignerClient } from "../../src/td-client/touchDesignerClient.js";
import {
  audioFingerprintToVisualImpl,
  audioFingerprintToVisualSchema,
  buildSampleScript,
  classify,
  type Fingerprint,
} from "../../src/tools/layer1/audioFingerprintToVisual.js";
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
    allowRawPython: true,
  };
}

/** Mocks /api/exec to return one scripted SamplerReport JSON, then "" for follow-ups. */
function mockSampler(report: Record<string, unknown>) {
  let calls = 0;
  server.use(
    http.post(`${TD_BASE}/api/exec`, () => {
      calls += 1;
      if (calls === 1) {
        return HttpResponse.json({
          ok: true,
          data: { result: null, stdout: JSON.stringify(report) },
        });
      }
      return HttpResponse.json({ ok: true, data: { result: null, stdout: "" } });
    }),
  );
}

const defaults = {
  audio_source: "synthetic" as const,
  sample_sec: 4,
  parent_path: "/project1",
  dry_run: false,
  force_family: "auto" as const,
  expose_controls: true,
};

describe("audio_fingerprint_to_visual: classifier", () => {
  const opts = { forceFamily: "auto" as const, parentPath: "/project1", exposeControls: true };
  const cases: Array<{ name: string; fp: Fingerprint; expectFamily: string }> = [
    {
      name: "fast techno → strobe_glitch",
      fp: {
        tempo_bpm: 140,
        spectral_centroid_hz: 4000,
        onset_density_per_sec: 5,
        dynamic_range_db: 12,
      },
      expectFamily: "strobe_glitch",
    },
    {
      name: "beat-heavy → particle",
      fp: {
        tempo_bpm: 110,
        spectral_centroid_hz: 1500,
        onset_density_per_sec: 3,
        dynamic_range_db: 6,
      },
      expectFamily: "particle",
    },
    {
      name: "bright → kaleido",
      fp: {
        tempo_bpm: 95,
        spectral_centroid_hz: 3500,
        onset_density_per_sec: 1.5,
        dynamic_range_db: 5,
      },
      expectFamily: "kaleido",
    },
    {
      name: "mid-tempo drone → tunnel",
      fp: {
        tempo_bpm: 80,
        spectral_centroid_hz: 800,
        onset_density_per_sec: 0.8,
        dynamic_range_db: 4,
      },
      expectFamily: "tunnel",
    },
    {
      name: "sparse dark → ambient",
      fp: {
        tempo_bpm: 0,
        spectral_centroid_hz: 400,
        onset_density_per_sec: 0.2,
        dynamic_range_db: 3,
      },
      expectFamily: "ambient",
    },
    {
      name: "fallthrough → spectrum",
      fp: {
        tempo_bpm: 40,
        spectral_centroid_hz: 2000,
        onset_density_per_sec: 1.2,
        dynamic_range_db: 5,
      },
      expectFamily: "spectrum",
    },
  ];
  for (const { name, fp, expectFamily } of cases) {
    it(name, () => {
      const decision = classify(fp, opts);
      expect(decision.family).toBe(expectFamily);
      expect(decision.generator_args.parent_path).toBe("/project1");
    });
  }

  it("kaleido segments scale with centroid", () => {
    const d = classify(
      {
        tempo_bpm: 95,
        spectral_centroid_hz: 5000,
        onset_density_per_sec: 1,
        dynamic_range_db: 5,
      },
      opts,
    );
    expect(d.family).toBe("kaleido");
    expect(d.generator_args.segments).toBe(10);
  });

  it("force_family overrides the heuristic but params still come from fingerprint", () => {
    const d = classify(
      {
        tempo_bpm: 140,
        spectral_centroid_hz: 4000,
        onset_density_per_sec: 5,
        dynamic_range_db: 12,
      },
      { forceFamily: "ambient", parentPath: "/project1", exposeControls: false },
    );
    expect(d.family).toBe("ambient");
    expect(d.generator_args.expose_controls).toBe(false);
  });
});

describe("audio_fingerprint_to_visual: bridge payload", () => {
  it("buildSampleScript base64-embeds the payload", () => {
    const script = buildSampleScript({
      parent_path: "/project1",
      audio_source: "synthetic",
      sample_sec: 4,
    });
    const m = script.match(/b64decode\("([^"]+)"\)/);
    expect(m?.[1]).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(m?.[1] ?? "", "base64").toString("utf8"));
    expect(decoded.parent_path).toBe("/project1");
    expect(decoded.sample_sec).toBe(4);
  });
});

describe("audio_fingerprint_to_visual: handler", () => {
  it("dry_run returns the decision without dispatching a generator", async () => {
    mockSampler({
      fingerprint: {
        tempo_bpm: 140,
        spectral_centroid_hz: 4000,
        onset_density_per_sec: 5,
        dynamic_range_db: 12,
      },
      warnings: [],
    });
    const result = await audioFingerprintToVisualImpl(makeCtx(), {
      ...defaults,
      dry_run: true,
    });
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("fast techno");
    expect(text).toContain("create_glitch");
    expect(text).toContain("dry_run");
  });

  it("paused timeline returns a friendly error and does not throw", async () => {
    mockSampler({ timeline_paused: true, warnings: [] });
    const result = await audioFingerprintToVisualImpl(makeCtx(), defaults);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain("paused");
  });

  it("fatal from the sampler surfaces as isError without throwing", async () => {
    mockSampler({ fatal: "Parent COMP not found: /nope", warnings: [] });
    const result = await audioFingerprintToVisualImpl(makeCtx(), {
      ...defaults,
      parent_path: "/nope",
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not found");
  });

  it("dispatches the chosen generator on the happy path", async () => {
    mockSampler({
      fingerprint: {
        tempo_bpm: 80,
        spectral_centroid_hz: 800,
        onset_density_per_sec: 0.8,
        dynamic_range_db: 4,
      },
      warnings: [],
    });
    // Count node creations — any successful dispatch means the sibling impl ran and
    // started building. dry_run=false + force_family="tunnel" pins the dispatch target.
    let nodeCreations = 0;
    server.use(
      http.post(`${TD_BASE}/api/nodes`, async ({ request }) => {
        nodeCreations += 1;
        const body = (await request.json()) as { parent_path: string; type: string; name?: string };
        const name = body.name ?? `${body.type.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}1`;
        return HttpResponse.json({
          ok: true,
          data: { path: `${body.parent_path}/${name}`, type: body.type, name },
        });
      }),
    );
    const result = await audioFingerprintToVisualImpl(makeCtx(), {
      ...defaults,
      force_family: "tunnel",
    });
    expect(result.isError).toBeUndefined();
    expect(nodeCreations).toBeGreaterThan(0);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("create_feedback_tunnel");
  });
});

describe("audio_fingerprint_to_visual: schema", () => {
  it("applies default values", () => {
    const parsed = audioFingerprintToVisualSchema.parse({});
    expect(parsed.audio_source).toBe("synthetic");
    expect(parsed.sample_sec).toBe(4);
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.dry_run).toBe(false);
    expect(parsed.force_family).toBe("auto");
    expect(parsed.expose_controls).toBe(true);
  });

  it("rejects sample_sec out of range", () => {
    expect(() => audioFingerprintToVisualSchema.parse({ sample_sec: 0 })).toThrow();
    expect(() => audioFingerprintToVisualSchema.parse({ sample_sec: 999 })).toThrow();
  });
});
