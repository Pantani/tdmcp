import { describe, expect, it } from "vitest";
import { loadConfig, tdBaseUrl } from "../../src/utils/config.js";

describe("loadConfig", () => {
  it("falls back to defaults with empty env", () => {
    const config = loadConfig({});
    expect(config.tdHost).toBe("127.0.0.1");
    expect(config.tdPort).toBe(9980);
    expect(config.transport).toBe("stdio");
    expect(config.logLevel).toBe("info");
    expect(config.requestTimeoutMs).toBe(10000);
  });

  it("reads overrides and coerces numeric ports", () => {
    const config = loadConfig({
      TDMCP_TD_HOST: "10.0.0.5",
      TDMCP_TD_PORT: "8080",
      TDMCP_LOG_LEVEL: "debug",
    });
    expect(config.tdHost).toBe("10.0.0.5");
    expect(config.tdPort).toBe(8080);
    expect(config.logLevel).toBe("debug");
  });

  it("rejects an invalid transport", () => {
    expect(() => loadConfig({ TDMCP_TRANSPORT: "carrier-pigeon" })).toThrow();
  });

  it("builds the TD base URL", () => {
    expect(tdBaseUrl({ tdHost: "127.0.0.1", tdPort: 9980 })).toBe("http://127.0.0.1:9980");
  });
});
