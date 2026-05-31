import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildSceneTimelineScript,
  createSceneTimelineImpl,
  createSceneTimelineSchema,
  resolveScenes,
  unitsToSeconds,
  validateSlotRefs,
} from "../../src/tools/layer2/createSceneTimeline.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  parent: string;
  name: string;
  target: string;
  loop: boolean;
  rate: number;
  autoplay: boolean;
  setlist_path: string | null;
  units: "seconds" | "bars";
  total_seconds: number;
  scenes: Array<{
    idx: number;
    name: string;
    cue: string;
    start_seconds: number;
    end_seconds: number;
    morph_in_seconds: number;
    setlist_slot: string | null;
  }>;
  morph_runner_text: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

const okReport = (over: Record<string, unknown> = {}) =>
  vi.fn(async (_script: string, _capture?: boolean) => ({
    stdout: JSON.stringify({
      comp: "/project1/scene_timeline",
      timer: "/project1/scene_timeline/timerCHOP",
      playhead: "/project1/scene_timeline/playhead",
      transport: "/project1/scene_timeline/transport",
      segments_dat: "/project1/scene_timeline/segments",
      morph_runner: "/project1/scene_timeline/morphRunner",
      total_seconds: 30,
      scene_count: 3,
      scenes: [],
      controls: ["Play", "Pause", "Stop", "Seek", "Rate", "Loop", "Active_Scene", "Time_Display"],
      warnings: [],
      ...over,
    }),
  }));

const baseScenes = [
  { name: "intro", cue: "intro_cue", start: 0, duration: 8 },
  { name: "build", cue: "build_cue", start: 8, duration: 12, morph_in_seconds: 2 },
  { name: "drop", cue: "drop_cue", start: 20, duration: 10, morph_in_seconds: 1 },
];

describe("createSceneTimelineSchema", () => {
  it("applies top-level defaults", () => {
    const args = createSceneTimelineSchema.parse({ scenes: [baseScenes[0]] });
    expect(args.target).toBe("/project1");
    expect(args.units).toBe("seconds");
    expect(args.loop).toBe(true);
    expect(args.rate).toBe(1);
    expect(args.autoplay).toBe(false);
    expect(args.name).toBe("scene_timeline");
    expect(args.parent_path).toBe("/project1");
  });

  it("applies per-scene morph_in_seconds default", () => {
    const args = createSceneTimelineSchema.parse({
      scenes: [{ name: "s", cue: "c", start: 0, duration: 4 }],
    });
    expect(args.scenes[0]?.morph_in_seconds).toBe(0);
  });

  it("requires at least one scene", () => {
    expect(() => createSceneTimelineSchema.parse({ scenes: [] })).toThrow();
  });

  it("rejects unknown units", () => {
    expect(() =>
      createSceneTimelineSchema.parse({ scenes: [baseScenes[0]], units: "frames" }),
    ).toThrow();
  });

  it("rejects non-positive duration", () => {
    expect(() =>
      createSceneTimelineSchema.parse({
        scenes: [{ name: "s", cue: "c", start: 0, duration: 0 }],
      }),
    ).toThrow();
  });
});

describe("unitsToSeconds", () => {
  it("seconds → 1.0", () => {
    expect(unitsToSeconds("seconds")).toBe(1);
  });

  it("bars → 2.0 at 120 BPM, 4 beats-per-bar", () => {
    expect(unitsToSeconds("bars")).toBe(2);
  });
});

describe("resolveScenes", () => {
  it("emits zero warnings for well-formed input", () => {
    const args = createSceneTimelineSchema.parse({ scenes: baseScenes });
    const { scenes, total_seconds, warnings } = resolveScenes(args);
    expect(warnings).toEqual([]);
    expect(scenes).toHaveLength(3);
    expect(total_seconds).toBe(30);
    expect(scenes[0]?.start_seconds).toBe(0);
    expect(scenes[2]?.end_seconds).toBe(30);
  });

  it("applies bars→seconds conversion (factor 2.0)", () => {
    const args = createSceneTimelineSchema.parse({
      scenes: [
        { name: "a", cue: "c", start: 0, duration: 4 },
        { name: "b", cue: "c", start: 4, duration: 8 },
      ],
      units: "bars",
    });
    const { scenes, total_seconds } = resolveScenes(args);
    expect(scenes[0]?.end_seconds).toBe(8); // 4 bars × 2 s/bar
    expect(scenes[1]?.start_seconds).toBe(8);
    expect(total_seconds).toBe(24); // (4+8) bars × 2
  });

  it("clamps morph_in_seconds that exceeds previous scene duration + emits a warning", () => {
    const args = createSceneTimelineSchema.parse({
      scenes: [
        { name: "a", cue: "c", start: 0, duration: 4 },
        { name: "b", cue: "c", start: 3, duration: 8, morph_in_seconds: 10 },
      ],
    });
    const { scenes, warnings } = resolveScenes(args);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/morph_in_seconds/);
    expect(scenes[1]?.morph_in_seconds).toBe(4);
  });

  it("sorts scenes by start so idx is deterministic", () => {
    const args = createSceneTimelineSchema.parse({
      scenes: [
        { name: "late", cue: "c", start: 10, duration: 4 },
        { name: "early", cue: "c", start: 0, duration: 4 },
      ],
    });
    const { scenes } = resolveScenes(args);
    expect(scenes[0]?.name).toBe("early");
    expect(scenes[0]?.idx).toBe(0);
    expect(scenes[1]?.name).toBe("late");
  });
});

describe("buildSceneTimelineScript", () => {
  it("references the required TD optypes", () => {
    const script = buildSceneTimelineScript({
      parent: "/project1",
      name: "scene_timeline",
      target: "/project1",
      loop: true,
      rate: 1,
      autoplay: false,
      setlist_path: null,
      units: "seconds",
      total_seconds: 10,
      scenes: [],
      morph_runner_text: "",
    });
    expect(script).toContain("td.baseCOMP");
    expect(script).toContain("td.timerCHOP");
    expect(script).toContain("td.nullCHOP");
    expect(script).toContain("td.tableDAT");
    expect(script).toContain("td.chopExecuteDAT");
    expect(script).toContain("tdmcp_scenes");
    expect(script).toContain("Active_Scene");
  });
});

describe("createSceneTimelineImpl — payload", () => {
  it("sends a single executePythonScript call with the resolved scenes", async () => {
    const exec = okReport();
    await createSceneTimelineImpl(fakeCtx(exec), {
      target: "/project1/viz",
      scenes: baseScenes.map((s) => ({ ...s, morph_in_seconds: s.morph_in_seconds ?? 0 })),
      units: "seconds",
      loop: true,
      rate: 1,
      autoplay: false,
      name: "scene_timeline",
      parent_path: "/project1",
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[1]).toBe(true);
    const script = exec.mock.calls[0]?.[0] as string;
    const payload = decodePayload(script);
    expect(payload.target).toBe("/project1/viz");
    expect(payload.scenes).toHaveLength(3);
    expect(payload.scenes.map((s) => s.name)).toEqual(["intro", "build", "drop"]);
    expect(payload.scenes.map((s) => s.cue)).toEqual(["intro_cue", "build_cue", "drop_cue"]);
    expect(payload.total_seconds).toBe(30);
    // morph runner text travels in the payload
    expect(payload.morph_runner_text).toContain("def onValueChange");
  });

  it("substitutes __TARGET__ via target stored in the payload (round-trip)", async () => {
    const exec = okReport();
    await createSceneTimelineImpl(fakeCtx(exec), {
      target: "/project1/myviz",
      scenes: [{ name: "s", cue: "c", start: 0, duration: 4, morph_in_seconds: 0 }],
      units: "seconds",
      loop: true,
      rate: 1,
      autoplay: false,
      name: "scene_timeline",
      parent_path: "/project1",
    });
    const payload = decodePayload(exec.mock.calls[0]?.[0] as string);
    expect(payload.target).toBe("/project1/myviz");
  });

  it("units='bars' → segments table is in seconds (factor 2.0 at 120/4)", async () => {
    const exec = okReport();
    await createSceneTimelineImpl(fakeCtx(exec), {
      target: "/project1",
      scenes: [
        { name: "a", cue: "ca", start: 0, duration: 4, morph_in_seconds: 0 },
        { name: "b", cue: "cb", start: 4, duration: 4, morph_in_seconds: 0 },
      ],
      units: "bars",
      loop: true,
      rate: 1,
      autoplay: false,
      name: "scene_timeline",
      parent_path: "/project1",
    });
    const payload = decodePayload(exec.mock.calls[0]?.[0] as string);
    expect(payload.units).toBe("bars");
    expect(payload.scenes[0]?.end_seconds).toBe(8);
    expect(payload.total_seconds).toBe(16);
  });

  it("forwards setlist_path into the payload when present", async () => {
    const exec = okReport();
    await createSceneTimelineImpl(fakeCtx(exec), {
      target: "/project1",
      scenes: [{ name: "s", cue: "c", start: 0, duration: 4, morph_in_seconds: 0 }],
      units: "seconds",
      loop: true,
      rate: 1,
      autoplay: false,
      setlist_path: "/project1/setlist_dat",
      name: "scene_timeline",
      parent_path: "/project1",
    });
    const payload = decodePayload(exec.mock.calls[0]?.[0] as string);
    expect(payload.setlist_path).toBe("/project1/setlist_dat");
    // The script body persists setlist_path into comp.storage
    expect(exec.mock.calls[0]?.[0]).toContain('store("setlist_path"');
  });
});

describe("createSceneTimelineImpl — guards + result shape", () => {
  it("errors on duplicate scene names without calling the bridge", async () => {
    const exec = okReport();
    const result = await createSceneTimelineImpl(fakeCtx(exec), {
      target: "/project1",
      scenes: [
        { name: "dup", cue: "a", start: 0, duration: 4, morph_in_seconds: 0 },
        { name: "dup", cue: "b", start: 4, duration: 4, morph_in_seconds: 0 },
      ],
      units: "seconds",
      loop: true,
      rate: 1,
      autoplay: false,
      name: "scene_timeline",
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/unique/i);
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns ok summary with comp path + UNVERIFIED note", async () => {
    const exec = okReport();
    const result = await createSceneTimelineImpl(fakeCtx(exec), {
      target: "/project1",
      scenes: baseScenes.map((s) => ({ ...s, morph_in_seconds: s.morph_in_seconds ?? 0 })),
      units: "seconds",
      loop: true,
      rate: 1,
      autoplay: false,
      name: "scene_timeline",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/scene_timeline");
    expect(text).toContain("3 scene(s)");
    expect(text).toContain("UNVERIFIED");
  });

  it("morph clamp still returns ok and surfaces a warning in the summary", async () => {
    const exec = okReport();
    const result = await createSceneTimelineImpl(fakeCtx(exec), {
      target: "/project1",
      scenes: [
        { name: "a", cue: "c", start: 0, duration: 4, morph_in_seconds: 0 },
        { name: "b", cue: "c", start: 4, duration: 8, morph_in_seconds: 10 },
      ],
      units: "seconds",
      loop: true,
      rate: 1,
      autoplay: false,
      name: "scene_timeline",
      parent_path: "/project1",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/warning\(s\)/);
  });

  it("returns errorResult (not throw) when the bridge connection fails", async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error("bridge down"), { name: "TdConnectionError" });
    });
    const result = await createSceneTimelineImpl(fakeCtx(exec), {
      target: "/project1",
      scenes: [{ name: "s", cue: "c", start: 0, duration: 4, morph_in_seconds: 0 }],
      units: "seconds",
      loop: true,
      rate: 1,
      autoplay: false,
      name: "scene_timeline",
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
  });

  it("returns errorResult when report.fatal is set", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        comp: "/project1",
        timer: "",
        playhead: "",
        transport: "",
        segments_dat: "",
        morph_runner: "",
        total_seconds: 0,
        scene_count: 0,
        scenes: [],
        controls: [],
        warnings: [],
        fatal: "COMP not found: /project1",
      }),
    }));
    const result = await createSceneTimelineImpl(fakeCtx(exec), {
      target: "/project1",
      scenes: [{ name: "s", cue: "c", start: 0, duration: 4, morph_in_seconds: 0 }],
      units: "seconds",
      loop: true,
      rate: 1,
      autoplay: false,
      name: "scene_timeline",
      parent_path: "/project1",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMP not found");
  });
});

describe("validateSlotRefs (foundation setlist schema consumption)", () => {
  it("returns empty when all slot refs resolve against a scenes[] setlist", () => {
    const setlist = {
      version: 1,
      scenes: [
        { id: "intro", cue: "c" },
        { id: "drop", cue: "c" },
      ],
    };
    expect(validateSlotRefs(setlist, ["intro", "drop"])).toEqual([]);
  });

  it("returns the unknown slot ids", () => {
    const setlist = {
      version: 1,
      scenes: [{ id: "intro", cue: "c" }],
    };
    expect(validateSlotRefs(setlist, ["intro", "missing"])).toEqual(["missing"]);
  });

  it("returns [] on an invalid setlist (never throws)", () => {
    expect(validateSlotRefs({ nonsense: true }, ["a"])).toEqual([]);
  });
});
