import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectBriefContent } from "../../src/llm/projectBrief.js";
import {
  manageProjectBriefImpl,
  manageProjectBriefSchema,
  registerManageProjectBrief,
} from "../../src/tools/ai/manageProjectBrief.js";
import type { ToolContext } from "../../src/tools/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.TDMCP_PROJECT_ROOT;
  vi.restoreAllMocks();
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tdmcp-manage-brief-")));
  roots.push(root);
  return root;
}

function content(direction = "Build a quiet monochrome system."): ProjectBriefContent {
  return {
    creative_direction: direction,
    constraints: [],
    named_outputs: [],
    safety_rules: [],
  };
}

function ctx(getEditorContext = vi.fn().mockRejectedValue(new Error("offline"))): ToolContext {
  return { client: { getEditorContext } } as unknown as ToolContext;
}

function structured(result: CallToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

describe("manage_project_brief schema", () => {
  it("defaults to read and enforces strict action-specific inputs", () => {
    expect(manageProjectBriefSchema.parse({})).toEqual({ action: "read" });
    expect(() => manageProjectBriefSchema.parse({ action: "read", brief: content() })).toThrow();
    expect(() =>
      manageProjectBriefSchema.parse({ action: "replace", expected_revision: "absent" }),
    ).toThrow();
    expect(() =>
      manageProjectBriefSchema.parse({
        action: "replace",
        expected_revision: "bad",
        brief: content(),
      }),
    ).toThrow();
    expect(() => manageProjectBriefSchema.parse({ project_root: "relative" })).toThrow();
  });
});

describe("manage_project_brief implementation", () => {
  it("creates, reads, and exact-revision replaces with structured results", async () => {
    const root = tempRoot();
    const create = await manageProjectBriefImpl(ctx(), {
      action: "replace",
      project_root: root,
      expected_revision: "absent",
      brief: content(),
    });
    expect(create.isError).not.toBe(true);
    expect(structured(create)).toMatchObject({ status: "available", project_root: root });
    const revision = structured(create).revision as `sha256:${string}`;

    const read = await manageProjectBriefImpl(ctx(), { action: "read", project_root: root });
    expect(structured(read)).toMatchObject({ status: "available", revision });
    const update = await manageProjectBriefImpl(ctx(), {
      action: "replace",
      project_root: root,
      expected_revision: revision,
      brief: content("Updated direction."),
    });
    expect(structured(update)).toMatchObject({
      status: "available",
      brief: { creative_direction: "Updated direction." },
    });
  });

  it("returns typed missing/not-configured/invalid/conflict states without brief leakage", async () => {
    const root = tempRoot();
    const missing = await manageProjectBriefImpl(ctx(), { action: "read", project_root: root });
    expect(structured(missing)).toMatchObject({
      status: "missing",
      brief_path: join(root, ".tdmcp", "agent-brief.json"),
    });

    const offline = vi.fn().mockRejectedValue(new Error("offline secret body"));
    const notConfigured = await manageProjectBriefImpl(ctx(offline), { action: "read" });
    expect(structured(notConfigured)).toMatchObject({ status: "not_configured" });
    expect(structured(notConfigured)).not.toHaveProperty("brief");
    expect(offline).toHaveBeenCalledOnce();

    const conflict = await manageProjectBriefImpl(ctx(), {
      action: "replace",
      project_root: root,
      expected_revision: `sha256:${"0".repeat(64)}`,
      brief: content(),
    });
    expect(conflict.isError).toBe(true);
    expect(structured(conflict)).toMatchObject({ status: "conflict", revision: null });
    expect(structured(conflict)).not.toHaveProperty("brief");

    const invalid = await manageProjectBriefImpl(ctx(), {
      action: "replace",
      project_root: root,
      expected_revision: "absent",
      brief: content("authorization: Bearer abcdefghijklmnop"),
    });
    expect(invalid.isError).toBe(true);
    expect(structured(invalid)).toMatchObject({ status: "invalid" });
    expect(structured(invalid)).not.toHaveProperty("brief");
  });

  it("honors env before one saved-project discovery and never retries", async () => {
    const envRoot = tempRoot();
    const editorRoot = tempRoot();
    const getEditorContext = vi.fn().mockResolvedValue({ project: { folder: editorRoot } });
    process.env.TDMCP_PROJECT_ROOT = envRoot;
    const fromEnv = await manageProjectBriefImpl(ctx(getEditorContext), { action: "read" });
    expect(structured(fromEnv)).toMatchObject({ status: "missing", project_root: envRoot });
    expect(getEditorContext).not.toHaveBeenCalled();

    delete process.env.TDMCP_PROJECT_ROOT;
    const fromEditor = await manageProjectBriefImpl(ctx(getEditorContext), { action: "read" });
    expect(structured(fromEditor)).toMatchObject({ status: "missing", project_root: editorRoot });
    expect(getEditorContext).toHaveBeenCalledOnce();
    expect(getEditorContext).toHaveBeenCalledWith({ timeoutMs: 1_000, retry: false });
  });

  it("honors the effective project root loaded into ToolContext", async () => {
    const configured = tempRoot();
    const getEditorContext = vi.fn().mockRejectedValue(new Error("must not probe"));
    const result = await manageProjectBriefImpl(
      { ...ctx(getEditorContext), projectRoot: configured },
      { action: "read" },
    );
    expect(structured(result)).toMatchObject({ status: "missing", project_root: configured });
    expect(getEditorContext).not.toHaveBeenCalled();
  });

  it("registers one local non-destructive structured tool", () => {
    const calls: Array<{ name: string; options: Record<string, unknown> }> = [];
    const server = {
      registerTool(name: string, options: Record<string, unknown>) {
        calls.push({ name, options });
      },
    };
    registerManageProjectBrief(server as never, ctx());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "manage_project_brief",
      options: {
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
    });
  });
});
