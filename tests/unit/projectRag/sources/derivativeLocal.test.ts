import { beforeEach, describe, expect, it, vi } from "vitest";
import { derivativeLocalSource } from "../../../../src/projectRag/sources/derivativeLocal.js";
import { SourceSkippedError } from "../../../../src/projectRag/sources/errors.js";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(),
  readdirSync: vi.fn<(path: string, opts?: unknown) => unknown>(),
  homedir: vi.fn<() => string>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: mocks.existsSync,
    readdirSync: mocks.readdirSync,
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: mocks.homedir };
});

function makeDirent(
  name: string,
  isDir: boolean,
): { name: string; isDirectory: () => boolean; isFile: () => boolean } {
  return { name, isDirectory: () => isDir, isFile: () => !isDir };
}

describe("derivativeLocalSource", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("(a) installRoot provided, assets found", () => {
    it("returns items with correct license, provenance, and tags", async () => {
      const root = "/custom/td/Samples/Palette";

      mocks.existsSync.mockReturnValue(true);
      mocks.readdirSync.mockImplementation((dir: unknown) => {
        const d = String(dir);
        if (d === root) {
          return [makeDirent("Button.tox", false), makeDirent("sub", true)];
        }
        if (d.endsWith("/sub") || d.endsWith("\\sub")) {
          return [makeDirent("Slider.tox", false)];
        }
        return [];
      });

      const adapter = derivativeLocalSource({ installRoot: root });
      const items = await adapter.fetchItems(100, {});

      expect(items).toHaveLength(2);

      for (const item of items) {
        expect(item.license).toBe("Derivative-EULA");
        expect(item.licenseConfidence).toBe("declared");
        expect(item.binaryUrl).toBeUndefined();
        expect(item.sourceName).toMatch(/^derivative-local:/);
        expect(item.sourceUrl).toBe("https://derivative.ca/UserGuide/Palette");
        expect(item.rightsNotes).toMatch(/EULA/);
        expect(item.authors).toEqual(["Derivative"]);
      }

      const button = items.find((i) => i.title === "Button.tox");
      expect(button).toBeDefined();
      expect(button?.type).toBe("component");
      expect(button?.tags).toContain("derivative");
      expect(button?.tags).toContain("palette");
    });
  });

  describe("(b) no install found anywhere → SourceSkippedError", () => {
    it("rejects with SourceSkippedError when no path exists", async () => {
      mocks.existsSync.mockReturnValue(false);
      mocks.homedir.mockReturnValue("/home/test");

      const adapter = derivativeLocalSource();

      await expect(adapter.fetchItems(100, {})).rejects.toThrow(SourceSkippedError);

      await adapter.fetchItems(100, {}).catch((err: unknown) => {
        expect(err).toBeInstanceOf(SourceSkippedError);
        const skipped = err as SourceSkippedError;
        expect(skipped.sourceName).toBe("derivative-local");
        expect(skipped.hint.length).toBeGreaterThan(0);
        expect(skipped.hint).toMatch(/TDMCP_PROJECT_RAG_DERIVATIVE_ROOT/);
      });
    });
  });

  describe("(c) installRoot override honored over OS defaults", () => {
    it("uses installRoot without touching homedir", async () => {
      const override = "/custom/td";

      // existsSync: true ONLY for the explicit override
      mocks.existsSync.mockImplementation((p: unknown) => String(p) === override);
      mocks.homedir.mockReturnValue("/home/test");

      mocks.readdirSync.mockImplementation((dir: unknown) => {
        const d = String(dir);
        if (d === override) return [makeDirent("Demo.toe", false)];
        return [];
      });

      const adapter = derivativeLocalSource({ installRoot: override });
      const items = await adapter.fetchItems(100, {});

      expect(items).toHaveLength(1);
      expect(items[0]?.type).toBe("project");
      expect(items[0]?.sourceName).toBe("derivative-local:Demo.toe");

      // homedir must NOT be called for path discovery when installRoot is set
      expect(mocks.homedir).not.toHaveBeenCalled();
    });
  });

  describe("(d) limit is respected", () => {
    it("returns at most `limit` items", async () => {
      const root = "/td/Samples";
      mocks.existsSync.mockReturnValue(true);
      mocks.readdirSync.mockImplementation((dir: unknown) => {
        const d = String(dir);
        if (d === root) {
          return Array.from({ length: 5 }, (_, i) => makeDirent(`Op${i}.tox`, false));
        }
        return [];
      });

      const adapter = derivativeLocalSource({ installRoot: root });
      const items = await adapter.fetchItems(2, {});
      expect(items).toHaveLength(2);
    });
  });

  describe("(e) unreadable subdirectory does not throw", () => {
    it("resolves with partial results when one subdir throws EPERM", async () => {
      const root = "/td/Samples";
      mocks.existsSync.mockReturnValue(true);

      mocks.readdirSync.mockImplementation((dir: unknown) => {
        const d = String(dir);
        if (d === root) {
          return [makeDirent("Good.tox", false), makeDirent("locked", true)];
        }
        if (d.endsWith("/locked") || d.endsWith("\\locked")) {
          const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
          throw err;
        }
        return [];
      });

      const adapter = derivativeLocalSource({ installRoot: root });
      const items = await adapter.fetchItems(100, {});
      // "Good.tox" is readable; "locked" throws but is silently skipped
      expect(items).toHaveLength(1);
      expect(items[0]?.title).toBe("Good.tox");
    });
  });
});
