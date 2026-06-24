import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface TechniquePack {
  techniques: Array<{
    id: string;
    code?: { snippet?: string };
  }>;
}

function techniqueSnippet(file: string, id: string): string {
  const pack = JSON.parse(
    readFileSync(new URL(`../../src/knowledge/data/techniques/${file}`, import.meta.url), "utf8"),
  ) as TechniquePack;
  const snippet = pack.techniques.find((technique) => technique.id === id)?.code?.snippet;
  if (!snippet) throw new Error(`Missing snippet ${file}:${id}`);
  return snippet;
}

describe("technique knowledge snippets", () => {
  it("labels the CUDA C++ TOP example as pseudocode when buffers are omitted", () => {
    const snippet = techniqueSnippet("gpu-compute.json", "cuda_dll_integration");

    expect(snippet.toLowerCase()).toContain("pseudocode");
  });

  it("keeps MediaPipe pose initialization and channel setup in one callback", () => {
    const snippet = techniqueSnippet("machine-learning.json", "mediapipe_pose");

    expect(snippet.match(/def onSetupParameters\(scriptOp\):/g)).toHaveLength(1);
    expect(snippet).toContain("scriptOp.appendChan");
    expect(snippet).toContain("[MediaPipe] Pose model initialized");
  });

  it("guards both body-tracking wrists and shoulders before comparing them", () => {
    const snippet = techniqueSnippet("machine-learning.json", "body_track_native");

    expect(snippet).toContain("'right_wrist'");
    expect(snippet).toContain("'right_shoulder'");
    expect(snippet).toContain("required.issubset(joints)");
  });

  it("waits for the background asyncio loop before scheduling fetch coroutines", () => {
    const snippet = techniqueSnippet("python-advanced.json", "asyncio_in_td");

    expect(snippet).toContain("threading.Event");
    expect(snippet).toContain("_bg_loop_ready.wait");
  });
});
