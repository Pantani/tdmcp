import { afterEach, describe, expect, it, vi } from "vitest";
import { isRepoSlug, parseInstallArgs, resolveAsset } from "../../src/cli/install.js";

function release(assets: Array<{ name: string; browser_download_url: string }>, tag = "v1.0.0") {
  return {
    ok: true,
    json: async () => ({ tag_name: tag, zipball_url: `https://zip/${tag}`, assets }),
  } as unknown as Response;
}

describe("tdmcp install <owner/repo>", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses the repo slug and flags in any order", () => {
    expect(parseInstallArgs(["torinmb/mediapipe-touchdesigner"])).toMatchObject({
      repo: "torinmb/mediapipe-touchdesigner",
      version: "latest",
    });
    expect(
      parseInstallArgs(["--version", "v0.5.2", "owner/repo", "--asset", "mac", "--dir", "/tmp/x"]),
    ).toEqual({ repo: "owner/repo", version: "v0.5.2", asset: "mac", dir: "/tmp/x" });
    // Trailing .git / slashes are stripped.
    expect(parseInstallArgs(["owner/repo.git/"]).repo).toBe("owner/repo");
  });

  it("validates the slug shape", () => {
    expect(isRepoSlug("torinmb/mediapipe-touchdesigner")).toBe(true);
    expect(isRepoSlug("not-a-slug")).toBe(false);
    expect(isRepoSlug("a/b/c")).toBe(false);
  });

  it("picks the sole asset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("/releases/latest");
        return release([{ name: "release.zip", browser_download_url: "https://d/release.zip" }]);
      }),
    );
    expect(await resolveAsset("o/r", "latest")).toMatchObject({
      url: "https://d/release.zip",
      kind: "zip",
    });
  });

  it("prefers a .zip when several assets exist, and honours --asset", async () => {
    const assets = [
      { name: "notes.txt", browser_download_url: "https://d/notes.txt" },
      { name: "plugin-mac.zip", browser_download_url: "https://d/mac.zip" },
      { name: "plugin-win.zip", browser_download_url: "https://d/win.zip" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => release(assets)),
    );
    // default heuristic → first .zip
    expect((await resolveAsset("o/r", "latest")).kind).toBe("zip");
    // --asset filter narrows it
    expect((await resolveAsset("o/r", "latest", "win")).url).toBe("https://d/win.zip");
  });

  it("errors with the asset list when --asset matches nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => release([{ name: "a.zip", browser_download_url: "https://d/a.zip" }])),
    );
    await expect(resolveAsset("o/r", "latest", "nope")).rejects.toThrow(
      /No release asset matching/,
    );
  });

  it("falls back to the source zipball when a release has no assets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => release([], "v2")),
    );
    const r = await resolveAsset("o/r", "latest");
    expect(r.url).toBe("https://zip/v2");
    expect(r.kind).toBe("zip");
  });

  it("targets the tagged endpoint and surfaces API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("/releases/tags/v9");
        return { ok: false, status: 404 } as unknown as Response;
      }),
    );
    await expect(resolveAsset("o/r", "v9")).rejects.toThrow(/404/);
  });
});
