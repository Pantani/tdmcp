import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdApiError, TdConnectionError } from "../../src/td-client/types.js";
import {
  buildGetFlagsScript,
  getTdNodeFlagsImpl,
  getTdNodeFlagsSchema,
} from "../../src/tools/layer3/getTdNodeFlags.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Payload {
  path: string;
  recursive: boolean;
  only_problems: boolean;
  max_nodes: number;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

// By default getNode pretends the node_detail endpoint is absent (older bridge), so
// the impl falls back to the exec walk these tests drive. Pass overrides to exercise
// the REST-first path or an offline getNode.
function fakeCtx(
  exec: ReturnType<typeof vi.fn>,
  overrides?: Partial<{ getNode: unknown; getNodes: unknown }>,
): ToolContext {
  return {
    client: {
      executePythonScript: exec,
      getNode:
        overrides?.getNode ??
        vi.fn(async () => {
          throw new TdApiError("Unsupported GET /api/nodes/x", { status: 404 });
        }),
      getNodes: overrides?.getNodes ?? vi.fn(async () => ({ nodes: [] })),
    },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const s = exec.mock.calls[0]?.[0];
  if (typeof s !== "string") throw new Error("executePythonScript not called with a script");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------

describe("getTdNodeFlagsSchema", () => {
  it("defaults recursive/only_problems to false and max_nodes to 200", () => {
    const parsed = getTdNodeFlagsSchema.parse({ path: "/project1/noise1" });
    expect(parsed.recursive).toBe(false);
    expect(parsed.only_problems).toBe(false);
    expect(parsed.max_nodes).toBe(200);
  });

  it("rejects a call with no path (required field)", () => {
    expect(() => getTdNodeFlagsSchema.parse({})).toThrow();
  });

  it("rejects max_nodes out of the 1..500 range", () => {
    expect(() => getTdNodeFlagsSchema.parse({ path: "/p", max_nodes: 0 })).toThrow();
    expect(() => getTdNodeFlagsSchema.parse({ path: "/p", max_nodes: 501 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildGetFlagsScript — pure payload encoding
// ---------------------------------------------------------------------------

describe("buildGetFlagsScript", () => {
  it("embeds path, recursive, only_problems, and max_nodes in the payload", () => {
    const script = buildGetFlagsScript({
      path: "/project1/blur1",
      recursive: true,
      only_problems: true,
      max_nodes: 50,
    });
    const payload = decodePayload(script);
    expect(payload.path).toBe("/project1/blur1");
    expect(payload.recursive).toBe(true);
    expect(payload.only_problems).toBe(true);
    expect(payload.max_nodes).toBe(50);
  });

  it("round-trips a path with quotes and unicode without breaking Python", () => {
    const payload = {
      path: '/project1/my "node" ✦',
      recursive: false,
      only_problems: false,
      max_nodes: 200,
    };
    const script = buildGetFlagsScript(payload);
    expect(decodePayload(script)).toEqual(payload);
  });

  it("treats op.errors() as a string, not an iterable", () => {
    const script = buildGetFlagsScript({
      path: "/p",
      recursive: false,
      only_problems: false,
      max_nodes: 200,
    });
    // errors() returns a STRING — the script must wrap it, never iterate it.
    expect(script).toContain("_s = _o.errors(recurse=False)");
    expect(script).toContain("return [str(_s)]");
  });
});

// ---------------------------------------------------------------------------
// getTdNodeFlagsImpl — happy path (single node, flags + wiring)
// ---------------------------------------------------------------------------

describe("getTdNodeFlagsImpl — happy path", () => {
  it("maps a crafted report to structuredContent with flags and wire shape", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        path: "/project1/blur1",
        scanned: 1,
        nodes: [
          {
            path: "/project1/blur1",
            type: "blurTOP",
            name: "blur1",
            flags: {
              bypass: true,
              render: false,
              display: false,
              lock: false,
              allowCooking: true,
              cloneImmune: false,
            },
            wires_in: [{ in_index: 0, from: "/project1/noise1", out_index: 0 }],
            nodeX: 100,
            nodeY: 200,
            color: [0.67, 0.67, 0.67],
            errors: [],
            suspect_reason: "bypass on",
          },
        ],
        probe: { flags_present: ["allowCooking", "bypass"], errors_is_str: true },
        warnings: [],
      }),
    }));

    const result = await getTdNodeFlagsImpl(fakeCtx(exec), {
      path: "/project1/blur1",
      recursive: false,
      only_problems: false,
      max_nodes: 200,
    });

    expect(result.isError).toBeFalsy();

    // The payload sent to TD is correct.
    const payload = decodePayload(scriptArg(exec));
    expect(payload.path).toBe("/project1/blur1");
    expect(payload.recursive).toBe(false);
    expect(payload.only_problems).toBe(false);
    expect(payload.max_nodes).toBe(200);

    const sc = result.structuredContent as {
      path: string;
      scanned: number;
      nodes: Array<{
        path: string;
        flags: { bypass?: boolean };
        wires_in: Array<{ in_index: number | null; from: string; out_index: number }>;
        suspect_reason?: string;
      }>;
      warnings: string[];
    };
    expect(sc.path).toBe("/project1/blur1");
    expect(sc.scanned).toBe(1);
    expect(sc.nodes).toHaveLength(1);
    expect(sc.nodes[0]?.flags.bypass).toBe(true);
    expect(sc.nodes[0]?.wires_in[0]).toEqual({
      in_index: 0,
      from: "/project1/noise1",
      out_index: 0,
    });

    const summary = textOf(result);
    expect(summary).toContain("Inspected 1 node(s)");
    expect(summary).toContain("/project1/blur1");
  });

  it("surfaces suspect_reason and a suspect count when only_problems + bypass", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        path: "/project1/geo1",
        scanned: 3,
        nodes: [
          {
            path: "/project1/geo1/blur1",
            type: "blurTOP",
            name: "blur1",
            flags: { bypass: true, allowCooking: true },
            wires_in: [],
            errors: [],
            suspect_reason: "bypass on",
          },
        ],
        probe: null,
        warnings: [],
      }),
    }));

    const result = await getTdNodeFlagsImpl(fakeCtx(exec), {
      path: "/project1/geo1",
      recursive: true,
      only_problems: true,
      max_nodes: 200,
    });

    expect(result.isError).toBeFalsy();

    // only_problems + recursive travel in the payload.
    const payload = decodePayload(scriptArg(exec));
    expect(payload.recursive).toBe(true);
    expect(payload.only_problems).toBe(true);

    const sc = result.structuredContent as {
      nodes: Array<{ suspect_reason?: string }>;
    };
    expect(sc.nodes[0]?.suspect_reason).toBe("bypass on");

    const summary = textOf(result);
    expect(summary).toContain("(subtree)");
    expect(summary).toContain("1 suspect");
  });
});

// ---------------------------------------------------------------------------
// getTdNodeFlagsImpl — fatal + offline paths (never throws)
// ---------------------------------------------------------------------------

describe("getTdNodeFlagsImpl — fatal & offline", () => {
  it("returns isError when the bridge reports fatal (node not found)", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        path: "/project1/nope",
        scanned: 0,
        nodes: [],
        warnings: [],
        fatal: "Node not found: /project1/nope",
      }),
    }));

    const result = await getTdNodeFlagsImpl(fakeCtx(exec), {
      path: "/project1/nope",
      recursive: false,
      only_problems: false,
      max_nodes: 200,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not found");
  });

  it("converts a thrown TdConnectionError into a friendly isError (TD offline)", async () => {
    // REST-first: getNode is hit first; offline -> TdConnectionError -> propagates
    // (not a missing endpoint) -> guardTd turns it into a friendly error.
    const offline = vi.fn(async () => {
      throw new TdConnectionError("Could not reach the TouchDesigner bridge on 127.0.0.1:9980.");
    });

    const result = await getTdNodeFlagsImpl(fakeCtx(offline, { getNode: offline }), {
      path: "/project1/blur1",
      recursive: false,
      only_problems: false,
      max_nodes: 200,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Could not reach the TouchDesigner bridge");
  });
});

// ---------------------------------------------------------------------------
// getTdNodeFlagsImpl — REST-first path (structured node_detail, exec-gate-free)
// ---------------------------------------------------------------------------

describe("getTdNodeFlagsImpl — REST node_detail path", () => {
  it("serves flags via the node_detail endpoint without exec (survives ALLOW_EXEC=0)", async () => {
    const exec = vi.fn(); // must NOT be called when the endpoint serves flags
    const getNode = vi.fn(async () => ({
      path: "/project1/blur1",
      type: "blurTOP",
      name: "blur1",
      parameters: {},
      flags: { bypass: true, allowCooking: true },
      wires_in: [{ in_index: 0, from: "/project1/noise1", out_index: 0 }],
      nodeX: 10,
      nodeY: 20,
      color: [0.5, 0.5, 0.5],
      comment: "muted for the drop",
      errors: [],
    }));

    const result = await getTdNodeFlagsImpl(fakeCtx(exec, { getNode }), {
      path: "/project1/blur1",
      recursive: false,
      only_problems: false,
      max_nodes: 200,
    });

    expect(result.isError).toBeFalsy();
    expect(getNode).toHaveBeenCalledOnce();
    expect(exec).not.toHaveBeenCalled(); // exec-gate-free path

    const sc = result.structuredContent as {
      scanned: number;
      nodes: Array<{
        flags: { bypass?: boolean };
        wires_in: Array<{ in_index: number | null; from: string; out_index: number }>;
        comment?: string;
        suspect_reason?: string;
      }>;
      probe?: { endpoint?: string };
    };
    expect(sc.scanned).toBe(1);
    expect(sc.nodes[0]?.flags.bypass).toBe(true);
    expect(sc.nodes[0]?.suspect_reason).toBe("bypass on");
    expect(sc.nodes[0]?.comment).toBe("muted for the drop");
    expect(sc.nodes[0]?.wires_in[0]).toEqual({
      in_index: 0,
      from: "/project1/noise1",
      out_index: 0,
    });
    expect(sc.probe?.endpoint).toBe("node_detail");
  });

  it("recursive: lists children and reads each via node_detail, applying only_problems", async () => {
    const exec = vi.fn();
    const detailByPath: Record<string, unknown> = {
      "/project1/geo1": {
        path: "/project1/geo1",
        type: "geometryCOMP",
        name: "geo1",
        parameters: {},
        flags: { allowCooking: true },
        wires_in: [],
        errors: [],
      },
      "/project1/geo1/blur1": {
        path: "/project1/geo1/blur1",
        type: "blurTOP",
        name: "blur1",
        parameters: {},
        flags: { bypass: true, allowCooking: true },
        wires_in: [],
        errors: [],
      },
    };
    const getNode = vi.fn(async (path: string) => detailByPath[path]);
    const getNodes = vi.fn(async () => ({
      nodes: [{ path: "/project1/geo1/blur1", type: "blurTOP", name: "blur1" }],
    }));

    const result = await getTdNodeFlagsImpl(fakeCtx(exec, { getNode, getNodes }), {
      path: "/project1/geo1",
      recursive: true,
      only_problems: true,
      max_nodes: 200,
    });

    expect(result.isError).toBeFalsy();
    expect(exec).not.toHaveBeenCalled();
    const sc = result.structuredContent as {
      scanned: number;
      nodes: Array<{ path: string; suspect_reason?: string }>;
    };
    // Both nodes scanned (root + 1 child), but only the bypassed child is reported.
    expect(sc.scanned).toBe(2);
    expect(sc.nodes).toHaveLength(1);
    expect(sc.nodes[0]?.path).toBe("/project1/geo1/blur1");
    expect(sc.nodes[0]?.suspect_reason).toBe("bypass on");
  });
});
