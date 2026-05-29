import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildReplicatorScript,
  createReplicatorImpl,
  createReplicatorSchema,
} from "../../src/tools/layer2/createReplicator.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  parent_path: string;
  name: string;
  template_path: string | null;
  table_path: string | null;
  rows: number;
  callback_stub: boolean;
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

const okExec = (over: Record<string, unknown> = {}) =>
  vi.fn(async (_script: string, _capture?: boolean) => ({
    stdout: JSON.stringify({
      replicator: "/project1/replicator1",
      template: "/project1/replicator1_template",
      table: "/project1/replicator1_table",
      callbacks: "/project1/replicator1_callbacks",
      clones_estimated: 3,
      probe: { set: { table_par: "template", master_par: "master" }, missing: [] },
      warnings: [],
      ...over,
    }),
  }));

describe("buildReplicatorScript", () => {
  it("round-trips the payload and embeds the probe-first par candidates", () => {
    const payload = {
      parent_path: "/project1",
      name: "menu",
      template_path: "/project1/cell",
      table_path: "/project1/items",
      rows: 0,
      callback_stub: true,
    };
    const script = buildReplicatorScript(payload);
    expect(decodePayload(script)).toEqual(payload);
    // Operator types come straight from the knowledge base, not invented.
    expect(script).toContain("replicatorCOMP");
    expect(script).toContain("tableDAT");
    expect(script).toContain("containerCOMP");
    // Probe-first: candidate par names are tried, not hardcoded to one.
    expect(script).toContain('["template", "table", "dat"]');
    expect(script).toContain('["master", "clone", "templateop"]');
    expect(script).toContain('"bytable"');
    expect(script).toContain("recreateall");
    expect(script).toContain("par_attrs");
    // Callback DAT stub.
    expect(script).toContain("onReplicate");
  });

  it("carries explicit template_path and table_path into the payload", () => {
    const script = buildReplicatorScript({
      parent_path: "/project1/decks",
      name: "deck",
      template_path: "/project1/deckTemplate",
      table_path: "/project1/tracks",
      rows: 8,
      callback_stub: false,
    });
    const payload = decodePayload(script);
    expect(payload.template_path).toBe("/project1/deckTemplate");
    expect(payload.table_path).toBe("/project1/tracks");
    expect(payload.rows).toBe(8);
    expect(payload.callback_stub).toBe(false);
  });
});

describe("createReplicatorSchema defaults", () => {
  it("defaults callback_stub to true and rows to 0", () => {
    const parsed = createReplicatorSchema.parse({});
    expect(parsed.parent_path).toBe("/project1");
    expect(parsed.name).toBe("replicator1");
    expect(parsed.rows).toBe(0);
    expect(parsed.callback_stub).toBe(true);
    expect(parsed.template_path).toBeUndefined();
    expect(parsed.table_path).toBeUndefined();
  });

  it("rejects rows out of range", () => {
    expect(() => createReplicatorSchema.parse({ rows: 999 })).toThrow();
    expect(() => createReplicatorSchema.parse({ rows: -1 })).toThrow();
  });
});

describe("createReplicatorImpl", () => {
  it("sends the args as a base64 payload with captureStdout=true", async () => {
    const exec = okExec();
    await createReplicatorImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "replicator1",
      template_path: undefined,
      table_path: undefined,
      rows: 0,
      callback_stub: true,
    });
    const payload = decodePayload(scriptArg(exec));
    expect(payload.parent_path).toBe("/project1");
    expect(payload.name).toBe("replicator1");
    // optional fields become null in the payload, never undefined.
    expect(payload.template_path).toBeNull();
    expect(payload.table_path).toBeNull();
    // The second argument to executePythonScript must be true (captureStdout).
    expect(exec.mock.calls[0]?.[1]).toBe(true);
  });

  it("summarises the replicator, template, table, clone estimate, and probe", async () => {
    const exec = okExec();
    const result = await createReplicatorImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "replicator1",
      template_path: undefined,
      table_path: undefined,
      rows: 0,
      callback_stub: true,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("/project1/replicator1");
    expect(text).toContain("/project1/replicator1_template");
    expect(text).toContain("/project1/replicator1_table");
    expect(text).toContain("~3 clone(s)");
    expect(text).toContain("table_par=template");
  });

  it("includes the warning count when the bridge collected warnings", async () => {
    const exec = okExec({
      warnings: ["No matching parameter for: master_par — see probe.par_attrs."],
      probe: { set: { table_par: "template" }, missing: ["master_par"] },
    });
    const result = await createReplicatorImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "replicator1",
      template_path: undefined,
      table_path: undefined,
      rows: 0,
      callback_stub: true,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/1 warning\(s\)/);
  });

  it("returns an error result when report.fatal is set and never throws", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        probe: { set: {}, missing: [] },
        warnings: [],
        fatal: "Parent COMP not found: /nope",
      }),
    }));
    const result = await createReplicatorImpl(fakeCtx(exec), {
      parent_path: "/nope",
      name: "replicator1",
      template_path: undefined,
      table_path: undefined,
      rows: 0,
      callback_stub: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });

  it("never throws when the bridge connection fails", async () => {
    const exec = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const result = await createReplicatorImpl(fakeCtx(exec), {
      parent_path: "/project1",
      name: "replicator1",
      template_path: undefined,
      table_path: undefined,
      rows: 0,
      callback_stub: true,
    });
    expect(result.isError).toBe(true);
  });
});
