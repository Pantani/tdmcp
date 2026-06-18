import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SourceSkippedError } from "../../../../src/projectRag/sources/errors.js";
import {
  IIHQ_AUTHOR,
  IIHQ_DEFAULT_REF,
  IIHQ_REPO,
  IIHQ_SOURCE_NAME,
  interactiveImmersiveSource,
  isIngestibleMdPath,
} from "../../../../src/projectRag/sources/interactiveImmersive.js";

const TREES_URL = `https://api.github.com/repos/${IIHQ_REPO}/git/trees/${IIHQ_DEFAULT_REF}`;
const RAW_BASE = `https://raw.githubusercontent.com/${IIHQ_REPO}/${IIHQ_DEFAULT_REF}`;

function treeFixture(paths: string[]): { tree: { path: string; type: string }[] } {
  return { tree: paths.map((path) => ({ path, type: "blob" })) };
}

const FULL_TREE = treeFixture([
  "Basics/1-1-Signal-Flow-and-Wiring.md",
  "CHOPs/2-1-Intro.md",
  "img/diagram.png",
  "TouchDesigner Example Files/demo.tox",
  "README.md",
  "SUMMARY.md",
]);

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function mockTrees(body: object | undefined, status = 200): void {
  server.use(
    http.get(TREES_URL, () =>
      status === 200 ? HttpResponse.json(body ?? {}) : new HttpResponse(null, { status }),
    ),
  );
}

function mockRaw(suffix: string, body: string, status = 200): void {
  server.use(
    http.get(`${RAW_BASE}/${suffix}`, () =>
      status === 200 ? HttpResponse.text(body) : new HttpResponse(null, { status }),
    ),
  );
}

describe("interactiveImmersiveSource.fetchItems", () => {
  it("happy path — mints tutorial items with CC-BY-NC-SA + attribution, no binaries", async () => {
    mockTrees(FULL_TREE);
    mockRaw("Basics/1-1-Signal-Flow-and-Wiring.md", "# Signal Flow and Wiring\n\nBody text.");
    mockRaw("CHOPs/2-1-Intro.md", "# CHOP Intro\n\nMore body.");

    const items = await interactiveImmersiveSource().fetchItems(50, {});

    expect(items).toHaveLength(2);
    const basics = items.find((i) => i.pathInRepo === "Basics/1-1-Signal-Flow-and-Wiring.md");
    expect(basics).toBeDefined();
    if (basics === undefined) throw new Error("missing");

    expect(basics.type).toBe("tutorial");
    expect(basics.license).toBe("CC-BY-NC-SA");
    expect(basics.licenseConfidence).toBe("declared");
    expect(basics.authors).toContain(IIHQ_AUTHOR);
    expect(basics.rightsNotes).toMatch(/Non-commercial/i);
    expect(basics.rightsNotes).toMatch(/share-alike/i);
    expect(basics.rightsNotes).toMatch(/attribute/i);
    expect(basics.tags).toEqual(expect.arrayContaining(["tutorial", "iihq", "basics"]));
    expect(basics.body).toBeTruthy();
    expect(basics.binaryUrl).toBeUndefined();
    expect(basics.files).toBeUndefined();
    expect(basics.title).toBe("Signal Flow and Wiring");
    expect(basics.sourceUrl).toBe(
      `https://github.com/${IIHQ_REPO}/blob/${IIHQ_DEFAULT_REF}/Basics/1-1-Signal-Flow-and-Wiring.md`,
    );
    expect(basics.canonical).toBe(basics.sourceUrl);
    expect(basics.sourceName).toBe("iihq:Basics/1-1-Signal-Flow-and-Wiring.md");

    const chops = items.find((i) => i.pathInRepo === "CHOPs/2-1-Intro.md");
    expect(chops?.tags).toContain("chops");
  });

  it("trees non-2xx (500) → SourceSkippedError with the source name", async () => {
    mockTrees(undefined, 500);
    const adapter = interactiveImmersiveSource();
    await expect(adapter.fetchItems(50, {})).rejects.toBeInstanceOf(SourceSkippedError);
    mockTrees(undefined, 500);
    await expect(adapter.fetchItems(50, {})).rejects.toMatchObject({
      sourceName: IIHQ_SOURCE_NAME,
    });
  });

  it("one raw fetch fails — skips the failing file, keeps the rest", async () => {
    mockTrees(treeFixture(["Basics/a.md", "CHOPs/b.md"]));
    mockRaw("Basics/a.md", "# A\n\nok", 500);
    mockRaw("CHOPs/b.md", "# B\n\nok");

    const items = await interactiveImmersiveSource().fetchItems(50, {});
    expect(items).toHaveLength(1);
    expect(items[0]?.pathInRepo).toBe("CHOPs/b.md");
  });

  it("respects the limit deterministically by path sort", async () => {
    mockTrees(treeFixture(["TOPs/c.md", "Basics/a.md", "CHOPs/b.md"]));
    mockRaw("Basics/a.md", "# A");
    mockRaw("CHOPs/b.md", "# B");

    const items = await interactiveImmersiveSource().fetchItems(2, {});
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.pathInRepo)).toEqual(["Basics/a.md", "CHOPs/b.md"]);
  });
});

describe("isIngestibleMdPath", () => {
  it("rejects excluded paths and accepts chapter markdown", () => {
    expect(isIngestibleMdPath("img/x.png")).toBe(false);
    expect(isIngestibleMdPath("TouchDesigner Example Files/y.tox")).toBe(false);
    expect(isIngestibleMdPath("README.md")).toBe(false);
    expect(isIngestibleMdPath("SUMMARY.md")).toBe(false);
    expect(isIngestibleMdPath("Basics/notes.txt")).toBe(false);
    expect(isIngestibleMdPath("Basics/1-1-Signal-Flow-and-Wiring.md")).toBe(true);
    expect(isIngestibleMdPath("User_Interface/foo.md")).toBe(true);
  });
});
