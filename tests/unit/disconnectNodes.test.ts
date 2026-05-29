import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdApiError, TdConnectionError } from "../../src/td-client/types.js";
import {
  buildDisconnectScript,
  disconnectNodesImpl,
  disconnectNodesSchema,
} from "../../src/tools/layer3/disconnectNodes.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Payload {
  to_path: string;
  from_path: string | null;
  to_input: number | null;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: {
      // Endpoint-first: simulate an older bridge (404 -> TdApiError) so the impl
      // falls back to the exec path these legacy tests assert against.
      disconnectNodes: vi.fn(async () => {
        throw new TdApiError("not supported", { status: 404 });
      }),
      executePythonScript: exec,
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
// buildDisconnectScript — pure payload encoding
// ---------------------------------------------------------------------------

describe("buildDisconnectScript", () => {
  it("embeds to_path, from_path, and to_input in the payload", () => {
    const script = buildDisconnectScript({
      to_path: "/project1/blur1",
      from_path: "/project1/noise1",
      to_input: 0,
    });
    const payload = decodePayload(script);
    expect(payload.to_path).toBe("/project1/blur1");
    expect(payload.from_path).toBe("/project1/noise1");
    expect(payload.to_input).toBe(0);
  });

  it("passes null for optional fields when omitted", () => {
    const script = buildDisconnectScript({
      to_path: "/project1/blur1",
      from_path: null,
      to_input: null,
    });
    const payload = decodePayload(script);
    expect(payload.from_path).toBeNull();
    expect(payload.to_input).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// disconnectNodesImpl
// ---------------------------------------------------------------------------

describe("disconnectNodesImpl", () => {
  it("happy path: reports removed wire count and produces the right summary", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        to_path: "/project1/blur1",
        from_path: "/project1/noise1",
        to_input: 0,
        removed: [{ input: 0, from: "/project1/noise1" }],
        probe: { connector_attrs: ["connections", "disconnect", "owner"], has_disconnect: true },
        warnings: [],
      }),
    }));
    const result = await disconnectNodesImpl(fakeCtx(exec), {
      to_path: "/project1/blur1",
      from_path: "/project1/noise1",
      to_input: 0,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("Removed 1 wire(s) into /project1/blur1");
    expect(text).toContain("/project1/noise1");
    // Payload was formed correctly.
    const payload = decodePayload(scriptArg(exec));
    expect(payload.to_path).toBe("/project1/blur1");
    expect(payload.from_path).toBe("/project1/noise1");
    expect(payload.to_input).toBe(0);
  });

  it("all-inputs path: removes multiple wires and omits scope text", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        to_path: "/project1/composite1",
        from_path: null,
        to_input: null,
        removed: [
          { input: 0, from: "/project1/noise1" },
          { input: 1, from: "/project1/blur1" },
        ],
        probe: null,
        warnings: [],
      }),
    }));
    const result = await disconnectNodesImpl(fakeCtx(exec), {
      to_path: "/project1/composite1",
      from_path: undefined,
      to_input: undefined,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("Removed 2 wire(s) into /project1/composite1");
    const payload = decodePayload(scriptArg(exec));
    expect(payload.from_path).toBeNull();
    expect(payload.to_input).toBeNull();
  });

  it("returns isError when bridge reports fatal and does not throw", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        to_path: "/project1/ghost",
        from_path: null,
        to_input: null,
        removed: [],
        probe: null,
        warnings: [],
        fatal: "Node not found: /project1/ghost",
      }),
    }));
    const result = await disconnectNodesImpl(fakeCtx(exec), {
      to_path: "/project1/ghost",
      from_path: undefined,
      to_input: undefined,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Node not found");
  });

  it("returns isError on bridge/network failure without throwing", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await disconnectNodesImpl(fakeCtx(exec), {
      to_path: "/project1/blur1",
      from_path: undefined,
      to_input: undefined,
    });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// disconnectNodesImpl — endpoint-first path (the rewire)
// ---------------------------------------------------------------------------

describe("disconnectNodesImpl — endpoint-first", () => {
  it("uses the /api/disconnect endpoint when available and does NOT call exec", async () => {
    const disconnectNodes = vi.fn(async () => ({
      to_path: "/project1/blur1",
      from_path: "/project1/noise1",
      to_input: 0,
      removed: [{ input: 0, from: "/project1/noise1" }],
      warnings: [],
    }));
    const exec = vi.fn(async () => ({ stdout: "{}" }));
    const ctx = {
      client: { disconnectNodes, executePythonScript: exec },
      logger: silentLogger,
    } as unknown as ToolContext;

    const result = await disconnectNodesImpl(ctx, {
      to_path: "/project1/blur1",
      from_path: "/project1/noise1",
      to_input: 0,
    });

    expect(result.isError).toBeFalsy();
    expect(disconnectNodes).toHaveBeenCalledOnce();
    expect(exec).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("Removed 1 wire(s) into /project1/blur1");
  });

  it("propagates a connection error (not TdApiError) without falling back to exec", async () => {
    const disconnectNodes = vi.fn(async () => {
      throw new TdConnectionError("offline");
    });
    const exec = vi.fn(async () => ({ stdout: "{}" }));
    const ctx = {
      client: { disconnectNodes, executePythonScript: exec },
      logger: silentLogger,
    } as unknown as ToolContext;

    const result = await disconnectNodesImpl(ctx, { to_path: "/project1/blur1" });
    expect(result.isError).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("disconnectNodesSchema", () => {
  it("requires to_path", () => {
    expect(() => disconnectNodesSchema.parse({})).toThrow();
  });

  it("accepts minimal input with only to_path", () => {
    const parsed = disconnectNodesSchema.parse({ to_path: "/project1/blur1" });
    expect(parsed.to_path).toBe("/project1/blur1");
    expect(parsed.from_path).toBeUndefined();
    expect(parsed.to_input).toBeUndefined();
  });

  it("accepts all fields", () => {
    const parsed = disconnectNodesSchema.parse({
      to_path: "/project1/blur1",
      from_path: "/project1/noise1",
      to_input: 2,
    });
    expect(parsed.to_input).toBe(2);
    expect(parsed.from_path).toBe("/project1/noise1");
  });

  it("rejects negative to_input", () => {
    expect(() =>
      disconnectNodesSchema.parse({ to_path: "/project1/blur1", to_input: -1 }),
    ).toThrow();
  });

  it("rejects non-integer to_input", () => {
    expect(() =>
      disconnectNodesSchema.parse({ to_path: "/project1/blur1", to_input: 0.5 }),
    ).toThrow();
  });
});
