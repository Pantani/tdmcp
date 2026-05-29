import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, silentLogger } from "../../src/utils/logger.js";

describe("createLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes enabled levels to stderr and suppresses lower levels", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger("warn");

    logger.info("hidden");
    logger.warn("visible", { node: "/project1/out1" });

    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(line).toContain("[tdmcp]");
    expect(line).toContain("WARN visible");
    expect(line).toContain('{"node":"/project1/out1"}');
    expect(line).not.toContain("hidden");
  });

  it("omits the metadata suffix for empty metadata objects", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger("debug");

    logger.debug("plain", {});

    const line = String(write.mock.calls[0]?.[0]);
    expect(line).toMatch(/DEBUG plain\n$/);
  });

  it("silentLogger discards every level", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    silentLogger.debug("debug");
    silentLogger.info("info");
    silentLogger.warn("warn");
    silentLogger.error("error");

    expect(write).not.toHaveBeenCalled();
  });
});
