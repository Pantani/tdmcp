import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BridgeAnalyzeOptions,
  type MinimalBridgeClient,
  runBridgeAnalyze,
} from "../../../src/projectRag/extractors/bridgeAnalyze.js";
import { TdConnectionError } from "../../../src/td-client/types.js";

type MockClient = MinimalBridgeClient & {
  getInfo: ReturnType<typeof vi.fn>;
  loadProject: ReturnType<typeof vi.fn>;
  getTdNodeErrors: ReturnType<typeof vi.fn>;
  getPreview: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

function makeMockClient(overrides: Partial<MinimalBridgeClient> = {}): MockClient {
  const base = {
    getInfo: vi.fn().mockResolvedValue({ td_version: "2023.12000" }),
    loadProject: vi.fn().mockResolvedValue(undefined),
    getTdNodeErrors: vi.fn().mockResolvedValue({ errors: [] }),
    getPreview: vi.fn().mockResolvedValue({ base64: "iVBORw0KGgo=" }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return Object.assign(base, overrides) as MockClient;
}

let tempDir: string;
let artifactPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "tdmcp-prag-bridge-test-"));
  artifactPath = path.join(tempDir, "test.toe");
  writeFileSync(artifactPath, "x");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("runBridgeAnalyze", () => {
  it("rejects port 9980 (main TD)", async () => {
    const factory = vi.fn();
    const result = await runBridgeAnalyze({
      artifactPath,
      bridgePort: 9980,
      clientFactory: factory as BridgeAnalyzeOptions["clientFactory"],
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/9980/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects non-absolute artifactPath", async () => {
    const result = await runBridgeAnalyze({
      artifactPath: "relative/path.toe",
      clientFactory: () => makeMockClient(),
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/absolute/);
  });

  it("rejects non-existent artifact", async () => {
    const result = await runBridgeAnalyze({
      artifactPath: path.join(tempDir, "missing.toe"),
      clientFactory: () => makeMockClient(),
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/not found/);
  });

  it("returns skipped when bridge is offline (probe throws TdConnectionError)", async () => {
    const client = makeMockClient({
      getInfo: vi.fn().mockRejectedValue(new TdConnectionError("cannot reach")),
    });
    const result = await runBridgeAnalyze({
      artifactPath,
      clientFactory: () => client,
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/offline/);
  });

  it("returns skipped on fetch-failed (generic connection error)", async () => {
    const client = makeMockClient({
      getInfo: vi.fn().mockRejectedValue(new Error("fetch failed")),
    });
    const result = await runBridgeAnalyze({
      artifactPath,
      clientFactory: () => client,
    });
    expect(result.status).toBe("skipped");
  });

  it("happy path: returns ok with errorCount and previewPng", async () => {
    const client = makeMockClient({
      getTdNodeErrors: vi.fn().mockResolvedValue({
        errors: [{ message: "e1" }, { message: "e2" }],
      }),
      getPreview: vi.fn().mockResolvedValue({ base64: "PNG_DATA_HERE" }),
    });
    const result = await runBridgeAnalyze({
      artifactPath,
      clientFactory: () => client,
    });
    expect(result.status).toBe("ok");
    expect(result.errorCount).toBe(2);
    expect(result.previewPng).toBe("PNG_DATA_HERE");
    expect(client.disconnect).toHaveBeenCalled();
  });

  it("partial success: getTdNodeErrors throws but result still ok", async () => {
    const client = makeMockClient({
      getTdNodeErrors: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const result = await runBridgeAnalyze({
      artifactPath,
      clientFactory: () => client,
    });
    expect(result.status).toBe("ok");
    expect(result.errorCount).toBeUndefined();
  });

  it("whole-call timeout: failed with timeout error", async () => {
    const client = makeMockClient({
      getInfo: vi.fn().mockResolvedValue({ td_version: "x" }),
      // Hangs forever
      getTdNodeErrors: vi.fn(() => new Promise(() => {})),
    });
    const result = await runBridgeAnalyze({
      artifactPath,
      timeoutMs: 50,
      clientFactory: () => client,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/timeout/);
  });

  it("uses default port 9981 when bridgePort is unset", async () => {
    const factory: BridgeAnalyzeOptions["clientFactory"] = vi.fn(
      (_baseUrl: string, _token?: string, _timeoutMs?: number) => makeMockClient(),
    );
    await runBridgeAnalyze({
      artifactPath,
      clientFactory: factory,
    });
    const spy = factory as unknown as ReturnType<typeof vi.fn>;
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0] ?? [];
    expect(call[0]).toContain(":9981");
  });

  it("passes bridgeToken through to the factory", async () => {
    const factory: BridgeAnalyzeOptions["clientFactory"] = vi.fn(
      (_baseUrl: string, _token?: string, _timeoutMs?: number) => makeMockClient(),
    );
    await runBridgeAnalyze({
      artifactPath,
      bridgeToken: "secret-token",
      clientFactory: factory,
    });
    const spy = factory as unknown as ReturnType<typeof vi.fn>;
    const call = spy.mock.calls[0] ?? [];
    expect(call[1]).toBe("secret-token");
  });
});
