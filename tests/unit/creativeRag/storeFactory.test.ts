/**
 * createIndexStore — backend selection + lancedb→jsonl fallback. Fully offline.
 *
 * The factory constructs `LanceIndexStore` WITHOUT a `moduleLoader`, so it always
 * uses the real optional dep. To drive the "dep available" vs "dep missing" branches
 * deterministically we `vi.mock` the `lanceIndexStore.js` module and control what
 * `existingFingerprints()` does: resolve (open succeeds → use Lance) or reject
 * (missing dep → warn + fall back to JSONL). Backend != "lancedb" never touches Lance.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const existingFingerprints = vi.fn<() => Promise<Set<string>>>();
const lanceCtor = vi.fn();

vi.mock("../../../src/creativeRag/lanceIndexStore.js", () => ({
  LanceIndexStore: class {
    constructor(opts: unknown) {
      lanceCtor(opts);
    }
    existingFingerprints = existingFingerprints;
  },
}));

import { JsonlIndexStore } from "../../../src/creativeRag/indexStore.js";
import { createIndexStore } from "../../../src/creativeRag/storeFactory.js";
import type { CreativeRagConfig } from "../../../src/creativeRag/types.js";

function makeConfig(overrides: Partial<CreativeRagConfig>): CreativeRagConfig {
  return {
    enabled: true,
    dataDir: "/tmp/nonexistent",
    ollamaUrl: "http://127.0.0.1:11434",
    embedModel: "nomic-embed-text",
    licenseAllowlist: ["CC0", "PublicDomain"],
    embedBatch: 64,
    backend: "jsonl",
    ...overrides,
  };
}

function makeLogger() {
  const warn = vi.fn();
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      child: vi.fn(),
    } as never,
    warn,
  };
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "store-factory-"));
  existingFingerprints.mockReset();
  lanceCtor.mockReset();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("createIndexStore", () => {
  it("defaults to the JSONL store and never touches Lance", async () => {
    const { logger, warn } = makeLogger();
    const store = await createIndexStore(makeConfig({ backend: "jsonl", dataDir }), logger);

    expect(store).toBeInstanceOf(JsonlIndexStore);
    expect(lanceCtor).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses JSONL for any non-lancedb backend value", async () => {
    const { logger } = makeLogger();
    // Force an unexpected backend value: the factory's guard is `!== "lancedb"`,
    // so anything else falls to JSONL without probing Lance.
    const store = await createIndexStore(
      makeConfig({ backend: "weird" as CreativeRagConfig["backend"], dataDir }),
      logger,
    );

    expect(store).toBeInstanceOf(JsonlIndexStore);
    expect(lanceCtor).not.toHaveBeenCalled();
  });

  it("returns the Lance store when the backend is requested and the dep loads", async () => {
    const { logger, warn } = makeLogger();
    existingFingerprints.mockResolvedValue(new Set());

    const store = await createIndexStore(makeConfig({ backend: "lancedb", dataDir }), logger);

    expect(store).not.toBeInstanceOf(JsonlIndexStore);
    // Eagerly probed the table to surface a missing dep here.
    expect(existingFingerprints).toHaveBeenCalledTimes(1);
    // Constructed with the data dir + fixed table name, no moduleLoader override.
    expect(lanceCtor).toHaveBeenCalledWith({ dir: dataDir, tableName: "creative_rag" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and falls back to JSONL when the lancedb dep is missing", async () => {
    const { logger, warn } = makeLogger();
    existingFingerprints.mockRejectedValue(
      new Error("LanceDB backend requires the optional dependency '@lancedb/lancedb'."),
    );

    const store = await createIndexStore(makeConfig({ backend: "lancedb", dataDir }), logger);

    expect(store).toBeInstanceOf(JsonlIndexStore);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, meta] = warn.mock.calls[0] as [string, { error: string }];
    expect(message).toContain("LanceDB backend unavailable");
    expect(message).toContain("TDMCP_RAG_BACKEND=jsonl");
    expect(meta.error).toContain("@lancedb/lancedb");
  });

  it("warns once per createIndexStore call (each fallback logs exactly one warning)", async () => {
    const { logger, warn } = makeLogger();
    existingFingerprints.mockRejectedValue(new Error("boom"));

    await createIndexStore(makeConfig({ backend: "lancedb", dataDir }), logger);
    await createIndexStore(makeConfig({ backend: "lancedb", dataDir }), logger);

    // No module-level warn-once latch: the factory logs one warning per fallback.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("stringifies a non-Error rejection in the warning metadata", async () => {
    const { logger, warn } = makeLogger();
    existingFingerprints.mockRejectedValue("plain string failure");

    const store = await createIndexStore(makeConfig({ backend: "lancedb", dataDir }), logger);

    expect(store).toBeInstanceOf(JsonlIndexStore);
    const [, meta] = warn.mock.calls[0] as [string, { error: string }];
    expect(meta.error).toBe("plain string failure");
  });
});
