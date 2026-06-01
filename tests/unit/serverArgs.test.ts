import { describe, expect, it } from "vitest";
import { parseServeArgs, renderServeHelp } from "../../src/cli/serverArgs.js";

describe("tdmcp serve args", () => {
  it("maps --http and --port into config overrides", () => {
    const parsed = parseServeArgs(["--http", "--port", "4949"], {});

    expect(parsed.error).toBeUndefined();
    expect(parsed.showHelp).toBe(false);
    expect(parsed.loadOptions).toMatchObject({
      useFiles: true,
      overrides: {
        transport: "http",
        httpPort: "4949",
      },
    });
  });

  it("keeps the environment profile when no explicit profile is passed", () => {
    const parsed = parseServeArgs(["--http"], { TDMCP_PROFILE: "studio" });

    expect(parsed.loadOptions?.profile).toBe("studio");
  });

  it("renders serve-specific help", () => {
    const parsed = parseServeArgs(["--help"], {});

    expect(parsed.showHelp).toBe(true);
    expect(renderServeHelp()).toContain("tdmcp serve");
    expect(renderServeHelp()).toContain("--http");
  });

  it("rejects unexpected positional arguments", () => {
    const parsed = parseServeArgs(["surprise"], {});

    expect(parsed.error).toContain("surprise");
  });
});
