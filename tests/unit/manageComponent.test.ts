import { describe, expect, it, vi } from "vitest";
import {
  buildComponentScript,
  manageComponentImpl,
} from "../../src/tools/layer2/manageComponent.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  action: string;
  file_path: string;
  comp: string | null;
  parent: string;
  linked: boolean;
  name: string | null;
  create_folders: boolean;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const script = exec.mock.calls[0]?.[0];
  if (typeof script !== "string")
    throw new Error("executePythonScript was not called with a script");
  return script;
}

describe("buildComponentScript", () => {
  it("round-trips the payload and supports both copy and live-link loading", () => {
    const payload = {
      action: "load",
      file_path: "/tmp/widget.tox",
      comp: null,
      parent: "/project1",
      linked: true,
      name: null,
      create_folders: false,
    };
    const script = buildComponentScript(payload);
    expect(decodePayload(script)).toEqual(payload);
    expect(script).toContain("_parent.loadTox(_fp)"); // copy path
    expect(script).toContain("externaltox"); // live-linked path
    expect(script).not.toContain(".save(_fp");
  });
});

describe("manageComponentImpl", () => {
  it("rejects save without a comp_path and never touches TD", async () => {
    const exec = vi.fn();
    const result = await manageComponentImpl(fakeCtx(exec), {
      action: "save",
      file_path: "/tmp/w.tox",
      parent_path: "/project1",
      linked: false,
      create_folders: false,
    });
    expect(result.isError).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("forwards a linked load payload", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        action: "load",
        file_path: "/tmp/w.tox",
        loaded: "/project1/w",
        linked: true,
        children: [],
        warnings: [],
      }),
    }));
    await manageComponentImpl(fakeCtx(exec), {
      action: "load",
      file_path: "/tmp/w.tox",
      parent_path: "/project1/lib",
      linked: true,
      name: "myWidget",
      create_folders: false,
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.action).toBe("load");
    expect(payload.parent).toBe("/project1/lib");
    expect(payload.linked).toBe(true);
    expect(payload.name).toBe("myWidget");
  });

  it("saves only through the structured transactional export", async () => {
    const exec = vi.fn();
    const exportToxTransaction = vi.fn(async () => ({
      operation_id: "opaque_export_operation",
      status: "succeeded" as const,
      verdict: "PASS" as const,
      action_applied: true,
      phases: [],
      artifact: {
        path: "/tmp/w.tox",
        size_bytes: 42,
        sha256: "a".repeat(64),
      },
    }));
    const ctx = {
      client: { executePythonScript: exec, exportToxTransaction },
      logger: silentLogger,
    } as unknown as ToolContext;

    const result = await manageComponentImpl(ctx, {
      action: "save",
      comp_path: "/project1/w",
      file_path: "/tmp/w.tox",
      overwrite_policy: "ask",
    });

    expect(result.isError).toBeFalsy();
    expect(exec).not.toHaveBeenCalled();
    expect(exportToxTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        source_path: "/project1/w",
        target_path: "/tmp/w.tox",
        mode: "as_is",
        overwrite_policy: "ask",
      }),
    );
  });
});
