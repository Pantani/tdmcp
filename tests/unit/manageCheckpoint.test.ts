import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildCheckpointScript,
  manageCheckpointImpl,
} from "../../src/tools/layer2/manageCheckpoint.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  action: string;
  comp: string;
  name?: string;
  prune_created: boolean;
  recreate_deleted: boolean;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const s = exec.mock.calls[0]?.[0];
  if (typeof s !== "string") throw new Error("executePythonScript not called with a string");
  return s;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("buildCheckpointScript", () => {
  it("embeds action, comp, name, and restore flags in the payload", () => {
    const script = buildCheckpointScript({
      action: "store",
      comp: "/project1",
      name: "before_edit",
      prune_created: true,
      recreate_deleted: false,
    });
    const payload = decodePayload(script);
    expect(payload.action).toBe("store");
    expect(payload.comp).toBe("/project1");
    expect(payload.name).toBe("before_edit");
    expect(payload.prune_created).toBe(true);
    expect(payload.recreate_deleted).toBe(false);
  });
});

describe("manageCheckpointImpl", () => {
  it("rejects store/restore/delete with no name before touching TD", async () => {
    const exec = vi.fn();
    for (const action of ["store", "restore", "delete"] as const) {
      const result = await manageCheckpointImpl(fakeCtx(exec), {
        action,
        comp_path: "/project1",
        name: undefined,
        prune_created: true,
        recreate_deleted: true,
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(action);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("allows list without a name and reports checkpoint names", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        action: "list",
        comp: "/project1",
        checkpoints: ["take1", "take2"],
        warnings: [],
      }),
    }));
    const result = await manageCheckpointImpl(fakeCtx(exec), {
      action: "list",
      comp_path: "/project1",
      name: undefined,
      prune_created: true,
      recreate_deleted: true,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("take1");
    expect(text).toContain("take2");
  });

  it("summarises node and connection counts for the store action", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        action: "store",
        comp: "/project1",
        name: "before_edit",
        nodes: 7,
        connections: 3,
        warnings: [],
      }),
    }));
    const result = await manageCheckpointImpl(fakeCtx(exec), {
      action: "store",
      comp_path: "/project1",
      name: "before_edit",
      prune_created: true,
      recreate_deleted: true,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // 'Stored checkpoint "before_edit" on /project1: 7 node(s), 3 connection(s).'
    expect(text).toContain("before_edit");
    expect(text).toContain("7 node(s)");
    expect(text).toContain("3 connection(s)");
    // Payload must carry the correct action and name
    const payload = decodePayload(scriptArg(exec));
    expect(payload.action).toBe("store");
    expect(payload.name).toBe("before_edit");
  });

  it("summarises restored params, recreated nodes, and pruned nodes for the restore action", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        action: "restore",
        comp: "/project1",
        name: "before_edit",
        restored_params: 14,
        recreated: ["noise1", "blur1"],
        rewired: 1,
        pruned: ["extra1"],
        warnings: [],
      }),
    }));
    const result = await manageCheckpointImpl(fakeCtx(exec), {
      action: "restore",
      comp_path: "/project1",
      name: "before_edit",
      prune_created: true,
      recreate_deleted: true,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    // 'Restored checkpoint "before_edit" on /project1: 14 parameter(s) restored, 2 node(s) recreated, 1 wire(s) reconnected, 1 node(s) pruned.'
    expect(text).toContain("14 parameter(s) restored");
    expect(text).toContain("2 node(s) recreated");
    expect(text).toContain("1 node(s) pruned");
  });

  it("returns an error result when report.fatal is set", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        action: "restore",
        comp: "/project1",
        warnings: [],
        fatal: "Checkpoint not found: 'before_edit' (available: none)",
      }),
    }));
    const result = await manageCheckpointImpl(fakeCtx(exec), {
      action: "restore",
      comp_path: "/project1",
      name: "before_edit",
      prune_created: true,
      recreate_deleted: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Checkpoint not found");
  });
});
