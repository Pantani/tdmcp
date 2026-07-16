import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePackageStorage } from "../../src/packages/scopes.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tdmcp-package-scope-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("resolvePackageStorage", () => {
  it("resolves deterministic user and project roots", () => {
    const home = tempRoot();
    const project = tempRoot();

    expect(resolvePackageStorage({ homeDir: home })).toEqual({
      scope: "user",
      root: join(home, ".tdmcp", "packages"),
      source: "user-default",
    });
    expect(resolvePackageStorage({ scope: "project", projectDir: project })).toEqual({
      scope: "project",
      root: join(project, ".tdmcp", "packages"),
      source: "project",
      projectDir: project,
    });
  });

  it("preserves the legacy root override for user scope", () => {
    const root = tempRoot();
    expect(resolvePackageStorage({ rootOverride: root })).toMatchObject({
      scope: "user",
      root,
      source: "override",
    });
  });

  it("rejects ambiguous project inputs and missing projects", () => {
    const root = tempRoot();
    const child = join(root, "child");
    mkdirSync(child);
    expect(() => resolvePackageStorage({ scope: "project" })).toThrow("explicit project");
    expect(() =>
      resolvePackageStorage({ scope: "project", projectDir: root, rootOverride: root }),
    ).toThrow("cannot be combined");
    expect(() => resolvePackageStorage({ projectDir: root })).toThrow("only valid with project");
    expect(() =>
      resolvePackageStorage({ scope: "project", projectDir: join(root, "missing") }),
    ).toThrow("does not exist");
    expect(() => resolvePackageStorage({ scope: "project", projectDir: "..", cwd: child })).toThrow(
      "parent traversal",
    );
  });

  it("rejects file and symlink project roots", () => {
    const root = tempRoot();
    const file = join(root, "file");
    const link = join(root, "link");
    writeFileSync(file, "x");
    symlinkSync(root, link);

    expect(() => resolvePackageStorage({ scope: "project", projectDir: file })).toThrow(
      "must be a directory",
    );
    expect(() => resolvePackageStorage({ scope: "project", projectDir: link })).toThrow(
      "symbolic link",
    );
  });

  it("rejects an existing symlink inside the project-owned root", () => {
    const project = tempRoot();
    const elsewhere = tempRoot();
    mkdirSync(join(project, ".tdmcp"));
    symlinkSync(elsewhere, join(project, ".tdmcp", "packages"));

    expect(() => resolvePackageStorage({ scope: "project", projectDir: project })).toThrow(
      "symbolic link",
    );
  });
});
