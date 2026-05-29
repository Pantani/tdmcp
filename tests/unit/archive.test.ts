import { afterEach, describe, expect, it, vi } from "vitest";

describe("archive extraction diagnostics", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("reports a clear action when unzip is unavailable", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => {
        throw Object.assign(new Error("spawnSync unzip ENOENT"), { code: "ENOENT" });
      }),
    }));

    try {
      const { assertZipToolAvailable } = await import("../../src/packages/archive.js");
      expect(() => assertZipToolAvailable()).toThrow(/Required zip tool 'unzip'.*Install unzip/);
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
  });
});
