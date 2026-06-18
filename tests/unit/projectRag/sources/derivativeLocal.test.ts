import { afterEach, describe, expect, it, vi } from "vitest";
import { derivativeLocalSource } from "../../../../src/projectRag/sources/derivativeLocal.js";
import { SourceSkippedError } from "../../../../src/projectRag/sources/errors.js";
import type { SourceAdapterContext } from "../../../../src/projectRag/sources/types.js";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  homedir: vi.fn(),
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
  return {
    ...actual,
    homedir: mocks.homedir,
  };
});

const CTX: SourceAdapterContext = {};

/** Minimal Dirent-like factory for readdirSync({ withFileTypes: true }). */
function dirent(name: string, kind: "file" | "dir"): import("node:fs").Dirent {
  return {
    name,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
  } as unknown as import("node:fs").Dirent;
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.existsSync.mockReset();
  mocks.readdirSync.mockReset();
  mocks.homedir.mockReset();
});

describe("derivativeLocalSource", () => {
  it("emits one Derivative-EULA item per .tox/.toe under an explicit installRoot", async () => {
    const root = "/opt/td/Samples/Palette";
    mocks.readdirSync.mockImplementation((dir: string) => {
      if (dir === root) return [dirent("Audio", "dir"), dirent("Top.tox", "file")];
      if (dir === `${root}/Audio`) return [dirent("Spectrogram.tox", "file")];
      return [];
    });

    const items = await derivativeLocalSource({ installRoot: root }).fetchItems(50, CTX);

    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.license).toBe("Derivative-EULA");
      expect(item.licenseConfidence).toBe("declared");
      expect(item.binaryUrl).toBeUndefined();
      expect(item.sourceUrl).toBe("https://derivative.ca/UserGuide/Palette");
      expect(item.sourceUrl).not.toMatch(/\.tox|\.toe|download/i);
      expect(item.rightsNotes).toMatch(/not redistributable/i);
      expect(item.tags).toContain("derivative");
      expect(item.authors).toEqual(["Derivative"]);
      expect(item.sourceName.startsWith("derivative-local:")).toBe(true);
      expect(item.canonical).toBe(item.sourceName);
      expect(item.type).toBe("component");
    }
    expect(items.map((i) => i.sourceName).sort()).toEqual([
      "derivative-local:Audio/Spectrogram.tox",
      "derivative-local:Top.tox",
    ]);
    // installRoot bypasses OS discovery entirely.
    expect(mocks.existsSync).not.toHaveBeenCalled();
    expect(mocks.homedir).not.toHaveBeenCalled();
  });

  it("classifies .toe as a project and tags op-snippets trees", async () => {
    const root = "/opt/td/Samples/OP Snippets";
    mocks.readdirSync.mockImplementation((dir: string) =>
      dir === root ? [dirent("Demo.toe", "file")] : [],
    );

    const items = await derivativeLocalSource({ installRoot: root }).fetchItems(50, CTX);

    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("project");
    expect(items[0]?.sourceName).toBe("derivative-local:Demo.toe");
    expect(items[0]?.tags).toEqual(["derivative", "op-snippets"]);
  });

  it("throws SourceSkippedError when no install directory is found", async () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.homedir.mockReturnValue("/home/user");

    const adapter = derivativeLocalSource({});
    await expect(adapter.fetchItems(50, CTX)).rejects.toBeInstanceOf(SourceSkippedError);
    await expect(adapter.fetchItems(50, CTX)).rejects.toMatchObject({
      sourceName: "derivative-local",
      hint: expect.stringContaining("TDMCP_PROJECT_RAG_DERIVATIVE_ROOT"),
    });
    expect(mocks.readdirSync).not.toHaveBeenCalled();
  });

  it("respects the per-sync limit", async () => {
    const root = "/opt/td/Samples/Palette";
    mocks.readdirSync.mockImplementation((dir: string) =>
      dir === root
        ? [
            dirent("a.tox", "file"),
            dirent("b.tox", "file"),
            dirent("c.tox", "file"),
            dirent("d.toe", "file"),
            dirent("e.toe", "file"),
          ]
        : [],
    );

    const items = await derivativeLocalSource({ installRoot: root }).fetchItems(2, CTX);
    expect(items).toHaveLength(2);
  });

  it("tolerates an unreadable subdirectory and still returns readable assets", async () => {
    const root = "/opt/td/Samples/Palette";
    mocks.readdirSync.mockImplementation((dir: string) => {
      if (dir === root) return [dirent("Locked", "dir"), dirent("Ok.tox", "file")];
      if (dir === `${root}/Locked`) {
        const err = new Error("EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return [];
    });

    const items = await derivativeLocalSource({ installRoot: root }).fetchItems(50, CTX);
    expect(items).toHaveLength(1);
    expect(items[0]?.sourceName).toBe("derivative-local:Ok.tox");
  });
});
