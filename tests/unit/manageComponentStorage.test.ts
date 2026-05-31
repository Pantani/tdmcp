import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildManageComponentStorageScript,
  manageComponentStorageImpl,
  manageComponentStorageSchema,
} from "../../src/tools/layer3/manageComponentStorage.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeTdServer } from "../helpers/tdMock.js";

// ---------------------------------------------------------------------------
// MSW server (kept for any future HTTP-based integration tests)
// ---------------------------------------------------------------------------
const server = makeTdServer();
beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return {
    client: { executePythonScript: exec },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function structuredOf(result: CallToolResult): unknown {
  return (result as { structuredContent?: unknown }).structuredContent;
}

function bridgeOk(data: unknown) {
  return vi.fn().mockResolvedValue({ stdout: JSON.stringify({ ok: true, data }) });
}

function bridgeErr(error: string) {
  return vi.fn().mockResolvedValue({ stdout: JSON.stringify({ ok: false, error }) });
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
describe("manageComponentStorageSchema", () => {
  it("accepts list action without key", () => {
    expect(() =>
      manageComponentStorageSchema.parse({ path: "/project1/base", action: "list" }),
    ).not.toThrow();
  });

  it("accepts set action with key and value", () => {
    expect(() =>
      manageComponentStorageSchema.parse({
        path: "/project1/base",
        action: "set",
        key: "theme",
        value: "dark",
      }),
    ).not.toThrow();
  });

  it("rejects missing path", () => {
    expect(() => manageComponentStorageSchema.parse({ action: "list" })).toThrow();
  });

  it("rejects invalid action", () => {
    expect(() => manageComponentStorageSchema.parse({ path: "/p", action: "clear" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildManageComponentStorageScript — payload round-trip
// ---------------------------------------------------------------------------
describe("buildManageComponentStorageScript", () => {
  it("embeds path and action in the base64 payload", () => {
    const script = buildManageComponentStorageScript({
      path: "/project1/myComp",
      action: "list",
    });
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
    if (!b64) throw new Error("no base64 payload found in script");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    expect(payload.path).toBe("/project1/myComp");
    expect(payload.action).toBe("list");
  });

  it("encodes key and value for set", () => {
    const script = buildManageComponentStorageScript({
      path: "/project1/c",
      action: "set",
      key: "brightness",
      value: 0.8,
    });
    const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
    if (!b64) throw new Error("no base64 payload found in script");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    expect(payload.key).toBe("brightness");
    expect(payload.value).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// manageComponentStorageImpl
// ---------------------------------------------------------------------------
describe("manageComponentStorageImpl", () => {
  it("list: returns all keys+values from bridge", async () => {
    const data = { brightness: 0.8, scene: "intro" };
    const ctx = fakeCtx(bridgeOk(data));
    const result = await manageComponentStorageImpl(ctx, {
      path: "/project1/base",
      action: "list",
    });
    expect(result.isError).toBeFalsy();
    const sc = structuredOf(result) as { data: unknown };
    expect(sc.data).toEqual(data);
  });

  it("get: returns existing key value", async () => {
    const ctx = fakeCtx(bridgeOk({ brightness: 0.8 }));
    const result = await manageComponentStorageImpl(ctx, {
      path: "/project1/base",
      action: "get",
      key: "brightness",
    });
    expect(result.isError).toBeFalsy();
    const sc = structuredOf(result) as { data: { brightness: number } };
    expect(sc.data.brightness).toBe(0.8);
  });

  it("get: missing key returns errorResult", async () => {
    const ctx = fakeCtx(bridgeErr("key not found: 'missing'"));
    const result = await manageComponentStorageImpl(ctx, {
      path: "/project1/base",
      action: "get",
      key: "missing",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("key not found");
  });

  it("set: echoes stored value back", async () => {
    const ctx = fakeCtx(bridgeOk({ theme: "dark" }));
    const result = await manageComponentStorageImpl(ctx, {
      path: "/project1/base",
      action: "set",
      key: "theme",
      value: "dark",
    });
    expect(result.isError).toBeFalsy();
    const sc = structuredOf(result) as { data: { theme: string } };
    expect(sc.data.theme).toBe("dark");
  });

  it("delete: returns null data", async () => {
    const ctx = fakeCtx(bridgeOk(null));
    const result = await manageComponentStorageImpl(ctx, {
      path: "/project1/base",
      action: "delete",
      key: "brightness",
    });
    expect(result.isError).toBeFalsy();
    const sc = structuredOf(result) as { data: null };
    expect(sc.data).toBeNull();
  });

  it("TD offline: returns errorResult with connection message", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const ctx = fakeCtx(exec);
    const result = await manageComponentStorageImpl(ctx, {
      path: "/project1/base",
      action: "list",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ECONNREFUSED");
  });

  it("get without key: TS validation returns errorResult", async () => {
    const exec = vi.fn();
    const ctx = fakeCtx(exec);
    const result = await manageComponentStorageImpl(ctx, {
      path: "/project1/base",
      action: "get",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("key is required for get");
    expect(exec).not.toHaveBeenCalled();
  });

  it("set without value: TS validation returns errorResult", async () => {
    const exec = vi.fn();
    const ctx = fakeCtx(exec);
    const result = await manageComponentStorageImpl(ctx, {
      path: "/project1/base",
      action: "set",
      key: "theme",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("value is required for set");
    expect(exec).not.toHaveBeenCalled();
  });

  it("set with non-JSON value: returns errorResult", async () => {
    const exec = vi.fn();
    const ctx = fakeCtx(exec);
    const circular: Record<string, unknown> = {};
    circular.self = circular; // circular ref — not JSON-serialisable
    const result = await manageComponentStorageImpl(ctx, {
      path: "/project1/base",
      action: "set",
      key: "bad",
      value: circular,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("JSON-serialisable");
    expect(exec).not.toHaveBeenCalled();
  });

  it("delete without key: TS validation returns errorResult", async () => {
    const exec = vi.fn();
    const ctx = fakeCtx(exec);
    const result = await manageComponentStorageImpl(ctx, {
      path: "/project1/base",
      action: "delete",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("key is required for delete");
    expect(exec).not.toHaveBeenCalled();
  });
});
