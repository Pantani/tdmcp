import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildBlobReactiveScript,
  createBlobReactiveImpl,
  createBlobReactiveSchema,
} from "../../src/tools/layer1/createBlobReactive.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PayloadTarget {
  blob: number;
  axis: "x" | "y" | "size";
  node_param: string;
  scale: number;
  offset: number;
}

interface Payload {
  parent_path: string;
  name: string;
  source: string;
  source_top: string;
  camera_index: number;
  threshold: number;
  max_blobs: number;
  targets: PayloadTarget[];
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: { executePythonScript: exec },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const s = exec.mock.calls[0]?.[0];
  if (typeof s !== "string") throw new Error("executePythonScript not called with a string");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** A representative success report the Python pass would emit. */
function happyReport(
  overrides: Partial<{
    tracker_type: string;
    channels: string[];
    bound: string[];
    warnings: string[];
  }> = {},
) {
  return JSON.stringify({
    container: "/project1/blob_reactive",
    blobs_chop: "/project1/blob_reactive/blobs",
    output_top: "/project1/blob_reactive/blobtrack",
    tracker_type: overrides.tracker_type ?? "blobtrackTOP",
    channels: overrides.channels ?? ["blob0_x", "blob0_y", "blob0_size"],
    bound: overrides.bound ?? [],
    warnings: overrides.warnings ?? [],
  });
}

// ---------------------------------------------------------------------------
// buildBlobReactiveScript — pure, no TD needed
// ---------------------------------------------------------------------------

describe("buildBlobReactiveScript (pure payload)", () => {
  it("embeds all schema fields in the base64 payload", () => {
    const script = buildBlobReactiveScript({
      parent_path: "/project1",
      name: "blob_reactive",
      source: "camera",
      source_top: "",
      camera_index: 0,
      threshold: 0.3,
      max_blobs: 5,
      targets: [],
    });
    const payload = decodePayload(script);
    expect(payload.parent_path).toBe("/project1");
    expect(payload.name).toBe("blob_reactive");
    expect(payload.source).toBe("camera");
    expect(payload.source_top).toBe("");
    expect(payload.camera_index).toBe(0);
    expect(payload.threshold).toBe(0.3);
    expect(payload.max_blobs).toBe(5);
    expect(payload.targets).toEqual([]);
  });

  it("embeds the targets list (blob/axis/node_param/scale/offset) when provided", () => {
    const script = buildBlobReactiveScript({
      parent_path: "/project1",
      name: "blobs",
      source: "top",
      source_top: "/project1/moviefilein1",
      camera_index: 1,
      threshold: 0.5,
      max_blobs: 3,
      targets: [
        { blob: 0, axis: "x", node_param: "/project1/transform1.tx", scale: 2, offset: -1 },
        { blob: 1, axis: "size", node_param: "/project1/circle1.radx", scale: 0.5, offset: 0 },
      ],
    });
    const payload = decodePayload(script);
    expect(payload.source).toBe("top");
    expect(payload.source_top).toBe("/project1/moviefilein1");
    expect(payload.camera_index).toBe(1);
    expect(payload.targets).toHaveLength(2);
    expect(payload.targets[0]).toEqual({
      blob: 0,
      axis: "x",
      node_param: "/project1/transform1.tx",
      scale: 2,
      offset: -1,
    });
    expect(payload.targets[1]?.axis).toBe("size");
  });

  it("keeps arbitrary source_top strings only inside the base64 blob (no raw interpolation)", () => {
    const tricky = "/project1/UNIQUEMARKER_xyzzy";
    const script = buildBlobReactiveScript({
      parent_path: "/project1",
      name: "blobs",
      source: "top",
      source_top: tricky,
      camera_index: 0,
      threshold: 0.3,
      max_blobs: 5,
      targets: [],
    });
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1] ?? "";
    expect(b64.length).toBeGreaterThan(0);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain(tricky);
    const templateWithoutBlob = script.replace(b64, "REDACTED");
    expect(templateWithoutBlob).not.toContain("UNIQUEMARKER_xyzzy");
  });

  it("script imports json/base64, prints the report, and references the expected operators", () => {
    const script = buildBlobReactiveScript({
      parent_path: "/project1",
      name: "blobs",
      source: "camera",
      source_top: "",
      camera_index: 0,
      threshold: 0.3,
      max_blobs: 5,
      targets: [],
    });
    expect(script).toContain("import json, base64");
    expect(script).toContain("print(json.dumps(report))");
    expect(script).toContain("videodeviceinTOP");
    expect(script).toContain("selectTOP");
    expect(script).toContain("monochromeTOP");
    expect(script).toContain("thresholdTOP");
    // Probe-live tracker optypes, both attempted.
    expect(script).toContain("blobtrackTOP");
    expect(script).toContain("blobtrackCHOP");
    expect(script).toContain("scriptCHOP");
    expect(script).toContain("nullCHOP");
  });
});

// ---------------------------------------------------------------------------
// Schema defaults & validation
// ---------------------------------------------------------------------------

describe("createBlobReactiveSchema defaults", () => {
  it("applies all documented defaults", () => {
    const parsed = createBlobReactiveSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("blob_reactive");
    expect(parsed.source).toBe("camera");
    expect(parsed.source_top).toBe("");
    expect(parsed.camera_index).toBe(0);
    expect(parsed.threshold).toBe(0.3);
    expect(parsed.max_blobs).toBe(5);
    expect(parsed.targets).toEqual([]);
  });

  it("coerces numeric strings for camera_index/threshold/max_blobs", () => {
    const parsed = createBlobReactiveSchema.parse({
      camera_index: "2",
      threshold: "0.6",
      max_blobs: "8",
    });
    expect(parsed.camera_index).toBe(2);
    expect(parsed.threshold).toBe(0.6);
    expect(parsed.max_blobs).toBe(8);
  });

  it("applies per-target scale/offset defaults and coerces numeric strings", () => {
    const parsed = createBlobReactiveSchema.parse({
      targets: [{ blob: "1", axis: "y", node_param: "/n.p" }],
    });
    expect(parsed.targets[0]?.blob).toBe(1);
    expect(parsed.targets[0]?.scale).toBe(1);
    expect(parsed.targets[0]?.offset).toBe(0);
  });

  it("rejects threshold > 1", () => {
    expect(() => createBlobReactiveSchema.parse({ threshold: 1.5 })).toThrow();
  });

  it("rejects max_blobs < 1", () => {
    expect(() => createBlobReactiveSchema.parse({ max_blobs: 0 })).toThrow();
  });

  it("rejects an invalid target axis", () => {
    expect(() =>
      createBlobReactiveSchema.parse({
        targets: [{ blob: 0, axis: "z", node_param: "/n.p" }],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Happy path — impl integration
// ---------------------------------------------------------------------------

describe("createBlobReactiveImpl — happy path", () => {
  it("returns a non-error result with a summary line", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    const result = await createBlobReactiveImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "blob_reactive",
      source: "camera",
      source_top: "",
      camera_index: 0,
      threshold: 0.3,
      max_blobs: 5,
      targets: [],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("blob-reactive chain");
    expect(text).toContain("tracker blobtrackTOP");
    expect(text).toContain("/project1/blob_reactive/blobs");
    expect(text).toContain("blob0_x");
  });

  it("sends the source_top, camera_index, threshold and max_blobs through the payload", async () => {
    const exec = vi.fn(async () => ({ stdout: happyReport() }));
    await createBlobReactiveImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "blobs",
      source: "top",
      source_top: "/project1/feed",
      camera_index: 1,
      threshold: 0.45,
      max_blobs: 4,
      targets: [],
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.source).toBe("top");
    expect(payload.source_top).toBe("/project1/feed");
    expect(payload.camera_index).toBe(1);
    expect(payload.threshold).toBe(0.45);
    expect(payload.max_blobs).toBe(4);
  });

  it("forwards target bindings through the payload and reports bound count", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({ bound: ["/project1/transform1.tx"] }),
    }));
    const result = await createBlobReactiveImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "blobs",
      source: "camera",
      source_top: "",
      camera_index: 0,
      threshold: 0.3,
      max_blobs: 5,
      targets: [
        { blob: 0, axis: "x", node_param: "/project1/transform1.tx", scale: 2, offset: -1 },
      ],
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.targets[0]?.node_param).toBe("/project1/transform1.tx");
    expect(payload.targets[0]?.scale).toBe(2);
    expect(textOf(result)).toContain("bound 1 target(s)");
  });

  it("notes when no blob tracker is available and surfaces warnings", async () => {
    const exec = vi.fn(async () => ({
      stdout: happyReport({
        tracker_type: "",
        channels: [],
        warnings: [
          "No Blob Track operator available on this TD build (tried blobtrackTOP/blobtrackCHOP).",
        ],
      }),
    }));
    const result = await createBlobReactiveImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "blob_reactive",
      source: "camera",
      source_top: "",
      camera_index: 0,
      threshold: 0.3,
      max_blobs: 5,
      targets: [],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("no blob tracker (palette op unavailable)");
    expect(text).toContain("1 warning(s)");
  });
});

// ---------------------------------------------------------------------------
// Fatal — parent not found
// ---------------------------------------------------------------------------

describe("createBlobReactiveImpl — fatal (parent not found)", () => {
  it("returns isError:true and does not throw", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        container: "",
        blobs_chop: "",
        output_top: "",
        tracker_type: "",
        channels: [],
        bound: [],
        warnings: [],
        fatal: "Parent COMP not found: /nope",
      }),
    }));
    const result = await createBlobReactiveImpl(fakeCtx(exec), {
      parent_path: "/nope",
      name: "blob_reactive",
      source: "camera",
      source_top: "",
      camera_index: 0,
      threshold: 0.3,
      max_blobs: 5,
      targets: [],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });
});

// ---------------------------------------------------------------------------
// TD offline — guardTd swallows the connection error
// ---------------------------------------------------------------------------

describe("createBlobReactiveImpl — TD offline", () => {
  it("returns isError:true and does not throw when the bridge is unreachable", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await createBlobReactiveImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "blob_reactive",
      source: "camera",
      source_top: "",
      camera_index: 0,
      threshold: 0.3,
      max_blobs: 5,
      targets: [],
    });
    expect(result.isError).toBe(true);
  });
});
