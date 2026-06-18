import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SourceSkippedError } from "../../../src/projectRag/sources/errors.js";
import {
  DEFAULT_GITHUB_REPOS,
  githubRepoSource,
  parseRepoListEnv,
  parseRepoSpec,
} from "../../../src/projectRag/sources/githubRepo.js";

const REPO = "torinmb/mediapipe-touchdesigner";
const META_URL = `https://api.github.com/repos/${REPO}`;
const LICENSE_URL = `${META_URL}/license`;
const README_URL = `${META_URL}/readme`;
const CONTENTS_URL = `${META_URL}/contents/`;

const META = {
  name: "mediapipe-touchdesigner",
  full_name: REPO,
  html_url: `https://github.com/${REPO}`,
  description: "MediaPipe wrappers for TouchDesigner",
  default_branch: "main",
  topics: ["touchdesigner", "mediapipe"],
  owner: { login: "torinmb" },
  pushed_at: "2026-06-01T00:00:00Z",
  fork: false,
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("parseRepoSpec", () => {
  it("parses owner/repo", () => {
    expect(parseRepoSpec("torinmb/mediapipe-touchdesigner")).toEqual({
      owner: "torinmb",
      repo: "mediapipe-touchdesigner",
    });
  });
  it("parses owner/repo@ref", () => {
    expect(parseRepoSpec("foo/bar@v1.2.3")).toEqual({ owner: "foo", repo: "bar", ref: "v1.2.3" });
  });
  it("rejects empty", () => {
    expect(() => parseRepoSpec("")).toThrow();
  });
  it("rejects missing slash", () => {
    expect(() => parseRepoSpec("foo")).toThrow();
  });
  it("rejects trailing slash", () => {
    expect(() => parseRepoSpec("foo/")).toThrow();
  });
});

describe("parseRepoListEnv", () => {
  it("returns the default seed when CSV is undefined", () => {
    expect(parseRepoListEnv(undefined).map((s) => `${s.owner}/${s.repo}`)).toEqual([
      ...DEFAULT_GITHUB_REPOS,
    ]);
  });
  it("splits CSV and trims entries", () => {
    const out = parseRepoListEnv("foo/bar , baz/qux@dev");
    expect(out).toEqual([
      { owner: "foo", repo: "bar" },
      { owner: "baz", repo: "qux", ref: "dev" },
    ]);
  });
});

describe("githubRepoSource.fetchItems", () => {
  function mountHappyPath() {
    server.use(
      http.get(META_URL, () => HttpResponse.json(META)),
      http.get(LICENSE_URL, () =>
        HttpResponse.json({ path: "LICENSE", license: { spdx_id: "MIT" } }),
      ),
      http.get(README_URL, () =>
        HttpResponse.text("# MediaPipe TouchDesigner\n\nReal-time MediaPipe inside TD."),
      ),
      http.get(CONTENTS_URL, () =>
        HttpResponse.json([
          {
            name: "MediaPipe.tox",
            path: "MediaPipe.tox",
            type: "file",
            size: 12345,
            download_url: `https://raw.githubusercontent.com/${REPO}/main/MediaPipe.tox`,
          },
          { name: "README.md", path: "README.md", type: "file", size: 200, download_url: null },
        ]),
      ),
    );
  }

  it("builds a RawProjectItem for the default seed with full metadata", async () => {
    mountHappyPath();
    const source = githubRepoSource(parseRepoListEnv(undefined));
    const items = await source.fetchItems(10, { fetchImpl: fetch });
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item === undefined) throw new Error("expected item");
    expect(item.sourceName).toBe(`github:${REPO}`);
    expect(item.canonical).toBe(`github:${REPO}`);
    expect(item.sourceUrl).toBe(`https://github.com/${REPO}`);
    expect(item.title).toBe(REPO);
    expect(item.license).toBe("MIT");
    expect(item.licenseConfidence).toBe("spdx-detected");
    expect(item.licenseFile).toBe("LICENSE");
    expect(item.type).toBe("component"); // .tox-only at top level
    expect(item.tags).toContain("touchdesigner");
    expect(item.tags).toContain("tox");
    expect(item.body).toContain("MediaPipe TouchDesigner");
    expect(item.files).toEqual(["MediaPipe.tox"]);
    expect(item.binaryUrl).toBe(`https://raw.githubusercontent.com/${REPO}/main/MediaPipe.tox`);
    expect(item.pathInRepo).toBe("MediaPipe.tox");
    expect(item.authors).toEqual(["torinmb"]);
    expect(item.commitOrVersion).toBe("main");
  });

  it("limit caps the number of repos processed", async () => {
    server.use(
      http.get(META_URL, () => HttpResponse.json(META)),
      http.get(LICENSE_URL, () =>
        HttpResponse.json({ path: "LICENSE", license: { spdx_id: "MIT" } }),
      ),
      http.get(README_URL, () => HttpResponse.text("# r")),
      http.get(CONTENTS_URL, () => HttpResponse.json([])),
    );
    const source = githubRepoSource([
      { owner: "torinmb", repo: "mediapipe-touchdesigner" },
      { owner: "foo", repo: "bar" },
    ]);
    const items = await source.fetchItems(1, { fetchImpl: fetch });
    expect(items).toHaveLength(1);
  });

  it("raises SourceSkippedError when configured with zero repos", async () => {
    const source = githubRepoSource([]);
    await expect(source.fetchItems(10, { fetchImpl: fetch })).rejects.toBeInstanceOf(
      SourceSkippedError,
    );
  });

  it("converts a rate-limit 403 on metadata into SourceSkippedError with token hint", async () => {
    server.use(
      http.get(META_URL, () =>
        HttpResponse.text("API rate limit exceeded for 1.2.3.4", { status: 403 }),
      ),
    );
    const source = githubRepoSource([{ owner: "torinmb", repo: "mediapipe-touchdesigner" }]);
    await expect(source.fetchItems(10, { fetchImpl: fetch })).rejects.toMatchObject({
      name: "ProjectRagSourceSkippedError",
      hint: expect.stringContaining("TDMCP_PROJECT_RAG_GH_TOKEN"),
    });
  });

  it("forwards ghToken as Authorization header to GitHub", async () => {
    const seen: string[] = [];
    server.use(
      http.get(META_URL, ({ request }) => {
        seen.push(request.headers.get("authorization") ?? "");
        return HttpResponse.json(META);
      }),
      http.get(LICENSE_URL, ({ request }) => {
        seen.push(request.headers.get("authorization") ?? "");
        return HttpResponse.json({ path: "LICENSE", license: { spdx_id: "MIT" } });
      }),
      http.get(README_URL, ({ request }) => {
        seen.push(request.headers.get("authorization") ?? "");
        return HttpResponse.text("# r");
      }),
      http.get(CONTENTS_URL, ({ request }) => {
        seen.push(request.headers.get("authorization") ?? "");
        return HttpResponse.json([]);
      }),
    );
    const source = githubRepoSource([{ owner: "torinmb", repo: "mediapipe-touchdesigner" }]);
    await source.fetchItems(10, { fetchImpl: fetch, ghToken: "ghp_xyz" });
    expect(seen.every((h) => h === "Bearer ghp_xyz")).toBe(true);
  });

  it("Unknown license (no SPDX) leaves binaryUrl present but type infers framework when no .tox/.toe", async () => {
    server.use(
      http.get(META_URL, () => HttpResponse.json(META)),
      http.get(LICENSE_URL, () =>
        HttpResponse.json({ path: "LICENSE", license: { spdx_id: null } }),
      ),
      http.get(README_URL, () => HttpResponse.text("# r")),
      http.get(CONTENTS_URL, () =>
        HttpResponse.json([{ name: "README.md", path: "README.md", type: "file" }]),
      ),
    );
    const source = githubRepoSource([{ owner: "torinmb", repo: "mediapipe-touchdesigner" }]);
    const items = await source.fetchItems(10, { fetchImpl: fetch });
    const item = items[0];
    if (item === undefined) throw new Error("expected item");
    expect(item.license).toBe("Unknown");
    expect(item.licenseConfidence).toBe("unknown");
    expect(item.binaryUrl).toBeUndefined();
    expect(item.type).toBe("framework");
  });
});
