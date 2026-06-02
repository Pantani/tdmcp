import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFileSync } from "../../src/utils/atomicWrite.js";

describe("atomicWriteFileSync", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-write-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a string atomically to a fresh target", () => {
    const target = join(dir, "note.md");
    atomicWriteFileSync(target, "hello\n");
    expect(readFileSync(target, "utf8")).toBe("hello\n");
    expect(readdirSync(dir)).toEqual(["note.md"]);
  });

  it("creates missing parent directories", () => {
    const target = join(dir, "nested", "deep", "file.txt");
    atomicWriteFileSync(target, "ok");
    expect(readFileSync(target, "utf8")).toBe("ok");
  });

  it("overwrites an existing file in place", () => {
    const target = join(dir, "state.json");
    writeFileSync(target, "old-content");
    atomicWriteFileSync(target, "new-content");
    expect(readFileSync(target, "utf8")).toBe("new-content");
  });

  it("leaves the directory clean of stray .tmp files when mkdir fails", () => {
    // Force a failure path by asking to write *under* an existing file
    // (mkdirSync of `dirname(target)` will fail with ENOTDIR/EEXIST since the
    // parent path component is a regular file, not a directory).
    const collider = join(dir, "not-a-dir");
    writeFileSync(collider, "i am a file");
    const target = join(collider, "child.txt");

    expect(() => atomicWriteFileSync(target, "should-fail")).toThrow();
    // The colliding file is untouched.
    expect(readFileSync(collider, "utf8")).toBe("i am a file");
    // No stray *.tmp files left behind in the directory.
    expect(readdirSync(dir).filter((f) => f.includes(".tmp")).length).toBe(0);
  });

  it("writes binary buffers", () => {
    const target = join(dir, "blob.bin");
    const data = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    atomicWriteFileSync(target, data);
    expect(readFileSync(target)).toEqual(data);
  });

  it("does not leave the .tmp sibling visible after a successful write", () => {
    const target = join(dir, "clean.txt");
    atomicWriteFileSync(target, "ok");
    const stragglers = readdirSync(dir).filter((f) => f.startsWith("clean.txt.") && f !== "clean.txt");
    expect(stragglers).toEqual([]);
    expect(existsSync(target)).toBe(true);
  });
});
