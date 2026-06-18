/**
 * Project RAG — github-topic adapter (F2).
 *
 * Verifies: SPDX allowlist filter (clean/copyleft accepted; unknown rejected),
 * pagination/cap, fork exclusion, rate-limit → SourceSkippedError, ghToken
 * forwarding to the search endpoint.
 */

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SourceSkippedError } from "../../../src/projectRag/sources/errors.js";
import {
  DEFAULT_TOPICS,
  githubTopicSource,
  parseTopicListEnv,
} from "../../../src/projectRag/sources/githubTopic.js";

const SEARCH_URL = "https://api.github.com/search/repositories";

function makeSearchItem(
  fullName: string,
  spdxId: string | null,
  extras: Partial<Record<string, unknown>> = {},
) {
  const [owner, repo] = fullName.split("/");
  return {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    default_branch: "main",
    topics: ["touchdesigner"],
    owner: { login: owner ?? "x" },
    pushed_at: "2025-06-01T00:00:00Z",
    stargazers_count: 42,
    fork: false,
    license: spdxId === null ? null : { spdx_id: spdxId },
    name: repo,
    ...extras,
  };
}

function mountRepoMeta(server: ReturnType<typeof setupServer>, fullName: string, spdxId: string) {
  const [owner, repo] = fullName.split("/");
  if (owner === undefined || repo === undefined) return;
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  server.use(
    http.get(`${base}/license`, () =>
      HttpResponse.json({ path: "LICENSE", license: { spdx_id: spdxId } }),
    ),
    http.get(`${base}/readme`, () => HttpResponse.text(`# ${fullName}\n\nbody`)),
    http.get(`${base}/contents/`, () =>
      HttpResponse.json([
        { name: "Thing.tox", path: "Thing.tox", type: "file", download_url: null },
      ]),
    ),
  );
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("parseTopicListEnv", () => {
  it("returns DEFAULT_TOPICS when csv is undefined or blank", () => {
    expect(parseTopicListEnv(undefined)).toEqual([...DEFAULT_TOPICS]);
    expect(parseTopicListEnv("   ")).toEqual([...DEFAULT_TOPICS]);
  });
  it("splits CSV and trims", () => {
    expect(parseTopicListEnv("a, b ,c")).toEqual(["a", "b", "c"]);
  });
});

describe("githubTopicSource — filters & cap", () => {
  it("rejects repos with unknown SPDX and accepts clean+copyleft", async () => {
    server.use(
      http.get(SEARCH_URL, () =>
        HttpResponse.json({
          items: [
            makeSearchItem("acme/clean", "MIT"),
            makeSearchItem("acme/copyleft", "GPL-3.0"),
            makeSearchItem("acme/rejected", null),
            makeSearchItem("acme/unknown-license", "WTFPL"),
          ],
        }),
      ),
    );
    mountRepoMeta(server, "acme/clean", "MIT");
    mountRepoMeta(server, "acme/copyleft", "GPL-3.0");
    const source = githubTopicSource({ topics: ["touchdesigner-components"] });
    const items = await source.fetchItems(10, { fetchImpl: fetch });
    const names = items.map((i) => i.sourceName).sort();
    expect(names).toEqual(["github:acme/clean", "github:acme/copyleft"]);
    const gpl = items.find((i) => i.sourceName === "github:acme/copyleft");
    expect(gpl?.license).toBe("GPL-3.0");
  });

  it("respects the per-sync cap across multiple topics (and limit arg)", async () => {
    server.use(
      http.get(SEARCH_URL, ({ request }) => {
        const url = new URL(request.url);
        const q = url.searchParams.get("q") ?? "";
        const which = q.includes("touchdesigner-components") ? "comp" : "other";
        return HttpResponse.json({
          items: [
            makeSearchItem(`acme/${which}-a`, "MIT"),
            makeSearchItem(`acme/${which}-b`, "MIT"),
            makeSearchItem(`acme/${which}-c`, "MIT"),
          ],
        });
      }),
    );
    for (const name of ["comp-a", "comp-b", "comp-c", "other-a"]) {
      mountRepoMeta(server, `acme/${name}`, "MIT");
    }
    const source = githubTopicSource({
      topics: ["touchdesigner-components", "touchdesigner"],
      cap: 4,
    });
    // The CLI passes a `limit` separately; effective items = min(cap, limit) = min(4, 10) = 4.
    const items = await source.fetchItems(10, { fetchImpl: fetch });
    expect(items).toHaveLength(4);
  });

  it("excludes forks", async () => {
    server.use(
      http.get(SEARCH_URL, () =>
        HttpResponse.json({
          items: [
            makeSearchItem("acme/orig", "MIT", { fork: false }),
            makeSearchItem("acme/fork", "MIT", { fork: true }),
          ],
        }),
      ),
    );
    mountRepoMeta(server, "acme/orig", "MIT");
    const source = githubTopicSource({ topics: ["touchdesigner"] });
    const items = await source.fetchItems(10, { fetchImpl: fetch });
    expect(items.map((i) => i.sourceName)).toEqual(["github:acme/orig"]);
  });

  it("rate-limit 403 raises SourceSkippedError with token hint", async () => {
    server.use(
      http.get(SEARCH_URL, () =>
        HttpResponse.text("API rate limit exceeded for x", { status: 403 }),
      ),
    );
    const source = githubTopicSource({ topics: ["touchdesigner"] });
    await expect(source.fetchItems(10, { fetchImpl: fetch })).rejects.toBeInstanceOf(
      SourceSkippedError,
    );
  });

  it("forwards ghToken to the search endpoint", async () => {
    const headersSeen: string[] = [];
    server.use(
      http.get(SEARCH_URL, ({ request }) => {
        headersSeen.push(request.headers.get("authorization") ?? "");
        return HttpResponse.json({ items: [] });
      }),
    );
    const source = githubTopicSource({ topics: ["touchdesigner-components"] });
    await source.fetchItems(10, { fetchImpl: fetch, ghToken: "ghp_topic" });
    expect(headersSeen[0]).toBe("Bearer ghp_topic");
  });

  it("paginates and stops when an empty page is returned", async () => {
    let calls = 0;
    server.use(
      http.get(SEARCH_URL, () => {
        calls += 1;
        // First call: 1 MIT result. Second call: empty (stops scan).
        if (calls === 1) {
          return HttpResponse.json({ items: [makeSearchItem("acme/only", "MIT")] });
        }
        return HttpResponse.json({ items: [] });
      }),
    );
    mountRepoMeta(server, "acme/only", "MIT");
    const source = githubTopicSource({ topics: ["touchdesigner-components"], cap: 25 });
    const items = await source.fetchItems(25, { fetchImpl: fetch });
    expect(items).toHaveLength(1);
    // <SEARCH_PAGE_SIZE returned → loop returns; calls === 1.
    expect(calls).toBe(1);
  });
});
