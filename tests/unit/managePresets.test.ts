import { describe, expect, it, vi } from "vitest";
import { buildPresetsScript, managePresetsImpl } from "../../src/tools/layer2/managePresets.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  action: string;
  comp: string;
  name?: string | null;
  params: string[] | null;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

/** The script string passed to the first executePythonScript call. */
function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const script = exec.mock.calls[0]?.[0];
  if (typeof script !== "string")
    throw new Error("executePythonScript was not called with a script");
  return script;
}

describe("buildPresetsScript", () => {
  it("round-trips the payload and uses one storage key for all snapshots", () => {
    const payload = { action: "store", comp: "/p/sys", name: "A", params: null };
    const script = buildPresetsScript(payload);
    expect(decodePayload(script)).toEqual(payload);
    expect(script).toContain('KEY = "tdmcp_presets"');
    expect(script).toContain("_c.store(KEY, _store)");
    expect(script).toContain("customPars");
  });
});

describe("managePresetsImpl", () => {
  it("rejects store/recall/delete without a name and never touches TD", async () => {
    const exec = vi.fn();
    for (const action of ["store", "recall", "delete"] as const) {
      const result = await managePresetsImpl(fakeCtx(exec), { action, comp_path: "/p" });
      expect(result.isError).toBe(true);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("allows list without a name and forwards the action/params payload", async () => {
    const exec = vi.fn(async (script: string) => {
      void script;
      return {
        stdout: JSON.stringify({ action: "store", comp: "/p/sys", presets: ["A"], warnings: [] }),
      };
    });
    await managePresetsImpl(fakeCtx(exec), {
      action: "store",
      comp_path: "/p/sys",
      name: "A",
      params: ["Speed", "Size"],
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.action).toBe("store");
    expect(payload.name).toBe("A");
    expect(payload.params).toEqual(["Speed", "Size"]);
  });

  it("defaults params to null (capture all custom parameters)", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ action: "list", comp: "/p", presets: [], warnings: [] }),
    }));
    await managePresetsImpl(fakeCtx(exec), { action: "list", comp_path: "/p" });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.action).toBe("list");
    expect(payload.params).toBeNull();
  });
});
