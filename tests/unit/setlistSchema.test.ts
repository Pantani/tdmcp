import { describe, expect, it } from "vitest";
import {
  type CanonicalScene,
  normalize,
  parseSetlist,
} from "../../src/automation/setlistSchema.js";

describe("setlistSchema — legacy tracks round-trip", () => {
  it("normalizes bare-string tracks to recipe scenes with non-empty ids", () => {
    const out = normalize({ tracks: ["a", "b"] });
    expect(out.scenes.length).toBe(2);
    expect(out.scenes[0]?.recipe).toBe("a");
    expect(out.scenes[0]?.source).toBe("track");
    expect(out.scenes[0]?.morph_seconds).toBe(0);
    for (const s of out.scenes) expect(s.id.length).toBeGreaterThan(0);
  });

  it("preserves track object fields (title/recipe/bpm/notes)", () => {
    const out = normalize({
      tracks: [{ title: "T", recipe: "r", bpm: 120, notes: "n" }],
    });
    const s = out.scenes[0];
    expect(s?.title).toBe("T");
    expect(s?.recipe).toBe("r");
    expect(s?.bpm).toBe(120);
    expect(s?.notes).toBe("n");
    expect(s?.source).toBe("track");
  });

  it("preserves preset-only track (no recipe)", () => {
    const out = normalize({ tracks: [{ title: "x", preset: "p" }] });
    const s = out.scenes[0];
    expect(s?.preset).toBe("p");
    expect(s?.recipe).toBeUndefined();
    expect(s?.source).toBe("track");
  });

  it("parity with the import_setlist fixture", () => {
    const out = normalize({
      tracks: [
        "vault_demo",
        "feedback_tunnel",
        { title: "ghost", recipe: "does_not_exist" },
        { title: "manual", preset: "p1" },
      ],
    });
    expect(out.scenes.length).toBe(4);
    expect(out.scenes.map((s) => s.recipe)).toEqual([
      "vault_demo",
      "feedback_tunnel",
      "does_not_exist",
      undefined,
    ]);
    expect(out.scenes[3]?.preset).toBe("p1");
  });
});

describe("setlistSchema — new scenes", () => {
  it("preserves scene cue/hold_beats/morph_seconds", () => {
    const out = normalize({
      scenes: [{ cue: "intro", hold_beats: 16, morph_seconds: 2 }],
    });
    const s = out.scenes[0];
    expect(s?.cue).toBe("intro");
    expect(s?.hold_beats).toBe(16);
    expect(s?.morph_seconds).toBe(2);
    expect(s?.source).toBe("scene");
  });

  it("normalizes scene steps with morph_seconds default", () => {
    const out = normalize({
      scenes: [{ steps: [{ cue: "a", hold_beats: 4 }, { cue: "b" }] }],
    });
    const s = out.scenes[0];
    expect(s?.steps?.length).toBe(2);
    expect(s?.steps?.[0]?.hold_beats).toBe(4);
    expect(s?.steps?.[1]?.morph_seconds).toBe(0);
  });

  it("accepts bars-driven scene with no hold_*", () => {
    const out = normalize({ scenes: [{ title: "X", bars: 8 }] });
    const s = out.scenes[0];
    expect(s?.bars).toBe(8);
    expect(s?.hold_seconds).toBeUndefined();
    expect(s?.hold_beats).toBeUndefined();
  });

  it("accepts marker scene (no firing fields)", () => {
    const out = normalize({ scenes: [{ title: "BLACKOUT" }] });
    expect(out.scenes.length).toBe(1);
    expect(out.scenes[0]?.cue).toBeUndefined();
    expect(out.scenes[0]?.recipe).toBeUndefined();
  });
});

describe("setlistSchema — mixed + edges", () => {
  it("concatenates tracks-first then scenes", () => {
    const out = normalize({
      title: "Show",
      bpm: 128,
      tracks: ["a"],
      scenes: [{ cue: "c" }],
    });
    expect(out.scenes.length).toBe(2);
    expect(out.scenes[0]?.source).toBe("track");
    expect(out.scenes[1]?.source).toBe("scene");
    expect(out.bpm).toBe(128);
  });

  it("folds tempo→bpm; bpm wins when both set", () => {
    const a = normalize({ tempo: 90, scenes: [{ cue: "c" }] });
    expect(a.bpm).toBe(90);
    expect(a.tempo).toBe(90);
    const b = normalize({ bpm: 100, tempo: 90, scenes: [{ cue: "c" }] });
    expect(b.bpm).toBe(100);
    expect(b.tempo).toBe(100);
  });

  it("routes a bare string array to tracks", () => {
    const out = normalize(["a", "b"]);
    expect(out.scenes.length).toBe(2);
    expect(out.scenes[0]?.source).toBe("track");
    expect(out.scenes[0]?.recipe).toBe("a");
  });

  it("routes a bare scene-object array to scenes", () => {
    const out = normalize([{ cue: "c" }]);
    expect(out.scenes.length).toBe(1);
    expect(out.scenes[0]?.source).toBe("scene");
    expect(out.scenes[0]?.cue).toBe("c");
  });

  it("de-duplicates derived ids", () => {
    const out = normalize({ tracks: [{ title: "A" }, { title: "A" }] });
    expect(out.scenes.map((s) => s.id)).toEqual(["a", "a-2"]);
  });

  it("passes unknown top-level keys to meta; promotes hand-added cue on a track", () => {
    const out = normalize({
      source_comp: "/x",
      tracks: [{ title: "t", cue: "c" }],
    });
    expect(out.meta.source_comp).toBe("/x");
    expect(out.scenes[0]?.cue).toBe("c");
  });
});

describe("setlistSchema — failure paths", () => {
  it("rejects an object with neither tracks nor scenes", () => {
    const r = parseSetlist({ title: "empty" });
    expect(r.success).toBe(false);
  });

  it("rejects a scene with empty steps[]", () => {
    const r = parseSetlist({ scenes: [{ steps: [] }] });
    expect(r.success).toBe(false);
  });
});

describe("setlistSchema — type-level check", () => {
  it("CanonicalScene type is usable by consumers", () => {
    const _check: CanonicalScene = {
      id: "x",
      source: "scene",
      morph_seconds: 0,
      meta: {},
    };
    expect(_check.id).toBe("x");
  });
});
