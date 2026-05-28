import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInstallArgs, resolveReleaseZip } from "../../src/cli/installMediapipe.js";

describe("install-mediapipe CLI", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to ~/tdmcp-mediapipe and the latest version", () => {
    const opts = parseInstallArgs([]);
    expect(opts.version).toBe("latest");
    expect(opts.dir.endsWith("tdmcp-mediapipe")).toBe(true);
  });

  it("honours --dir and --version flags", () => {
    const opts = parseInstallArgs(["--dir", "/tmp/mp", "--version", "v0.5.2"]);
    expect(opts).toEqual({ dir: "/tmp/mp", version: "v0.5.2" });
  });

  it("resolves the release.zip asset URL for the latest release", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("/releases/latest");
        return {
          ok: true,
          json: async () => ({
            tag_name: "v0.5.2",
            assets: [
              { name: "release.zip", browser_download_url: "https://example.test/release.zip" },
            ],
          }),
        } as unknown as Response;
      }),
    );
    const { tag, url } = await resolveReleaseZip("latest");
    expect(tag).toBe("v0.5.2");
    expect(url).toBe("https://example.test/release.zip");
  });

  it("targets the tagged release endpoint for a pinned version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("/releases/tags/v0.5.2");
        return {
          ok: true,
          json: async () => ({
            tag_name: "v0.5.2",
            assets: [{ name: "release.zip", browser_download_url: "https://example.test/r.zip" }],
          }),
        } as unknown as Response;
      }),
    );
    expect((await resolveReleaseZip("v0.5.2")).url).toBe("https://example.test/r.zip");
  });

  it("throws a helpful error when the GitHub API call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response),
    );
    await expect(resolveReleaseZip("v9.9.9")).rejects.toThrow(/404/);
  });
});
