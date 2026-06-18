import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AWESOME_README_URL,
  AWESOME_SOURCE_NAME,
  type DiscoveryItem,
  fetchAwesomeListDiscovery,
} from "../../../../src/projectRag/sources/awesomeList.js";
import { SourceSkippedError } from "../../../../src/projectRag/sources/errors.js";
import { resolveProjectSources } from "../../../../src/projectRag/sources/index.js";

const FIXTURE = `# Awesome TouchDesigner

## Components

- [Mediapipe TD](https://github.com/torinmb/mediapipe-touchdesigner) - hand/face tracking
- [TDAbleton](https://github.com/Ableton/TDAbleton): Ableton Live bridge
- [Local thing](./relative/path.md) - relative link should be skipped
- [Email me](mailto:foo@bar.com) - mailto should be skipped
- [Insecure](http://example.com) - plain http should be skipped

## Binaries

- [Prebuilt tox](https://example.com/pack.tox) - binary, dropped
- [Release zip](https://github.com/foo/bar/releases/download/v1/asset.zip) - dropped
- [Clean repo](https://github.com/foo/clean) — keep me

### Tutorials

- [Intro video](https://youtube.com/watch?v=abc) some prose
`;

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function mockReadme(body: string): void {
  server.use(http.get(AWESOME_README_URL, () => HttpResponse.text(body)));
}

describe("fetchAwesomeListDiscovery", () => {
  it("parses items with full provenance + suggest-only license stamps", async () => {
    mockReadme(FIXTURE);
    const items = await fetchAwesomeListDiscovery();

    const mediapipe = items.find((i) => i.title === "Mediapipe TD");
    expect(mediapipe).toBeDefined();
    const item = mediapipe as DiscoveryItem;
    expect(item.url).toBe("https://github.com/torinmb/mediapipe-touchdesigner");
    expect(item.description).toBe("hand/face tracking");
    expect(item.provenance.sourceName).toBe("awesome-touchdesigner");
    expect(item.provenance.sourceUrl).toBe(AWESOME_README_URL);
    expect(item.provenance.discoveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(item.license).toBe("Unknown");
    expect(item.licenseConfidence).toBe("unknown");
    expect(item.suggestOnly).toBe(true);
    for (const i of items) {
      expect(i.license).toBe("Unknown");
      expect(i.licenseConfidence).toBe("unknown");
      expect(i.suggestOnly).toBe(true);
    }
  });

  it("tracks the current ## / ### heading as section", async () => {
    mockReadme(FIXTURE);
    const items = await fetchAwesomeListDiscovery();

    expect(items.find((i) => i.title === "Mediapipe TD")?.section).toBe("Components");
    expect(items.find((i) => i.title === "Clean repo")?.section).toBe("Binaries");
    expect(items.find((i) => i.title === "Intro video")?.section).toBe("Tutorials");
  });

  it("drops binary and non-https URLs (suggest-only / no-binary)", async () => {
    mockReadme(FIXTURE);
    const items = await fetchAwesomeListDiscovery();

    const urls = items.map((i) => i.url);
    expect(urls).toContain("https://github.com/foo/clean");
    expect(urls).not.toContain("https://example.com/pack.tox");
    expect(urls.some((u) => u.includes("/releases/download/"))).toBe(false);
    expect(urls.some((u) => u.startsWith("http://"))).toBe(false);
    expect(urls.some((u) => u.startsWith("mailto:"))).toBe(false);
    expect(urls.some((u) => u.startsWith("./"))).toBe(false);
    for (const u of urls) {
      expect(u).not.toMatch(/\.(tox|toe|zip|7z)$/);
      expect(u).not.toContain("/releases/download/");
    }
  });

  it("rejects with SourceSkippedError on a non-2xx response", async () => {
    server.use(http.get(AWESOME_README_URL, () => new HttpResponse(null, { status: 500 })));
    await expect(fetchAwesomeListDiscovery()).rejects.toBeInstanceOf(SourceSkippedError);
    await expect(fetchAwesomeListDiscovery()).rejects.toMatchObject({
      sourceName: AWESOME_SOURCE_NAME,
    });
  });

  it("respects the cap", async () => {
    mockReadme(FIXTURE);
    const items = await fetchAwesomeListDiscovery({ cap: 2 });
    expect(items).toHaveLength(2);
  });
});

describe("registry guard", () => {
  it("never enters the live sync source registry", () => {
    expect(resolveProjectSources().every((s) => s.name !== AWESOME_SOURCE_NAME)).toBe(true);
  });
});
