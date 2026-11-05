import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BuildRecord,
  type BuildRecordInput,
  createBuildRecorder,
  withToolCall,
} from "../../src/builds/buildLog.js";
import { buildToolContext } from "../../src/server/context.js";
import { finalize, NetworkBuilder } from "../../src/tools/layer2/orchestration.js";
import type { ToolContext } from "../../src/tools/types.js";
import { loadConfig } from "../../src/utils/config.js";
import { silentLogger } from "../../src/utils/logger.js";

const PNG_BASE64 = Buffer.from("fake-png").toString("base64");

function input(overrides: Partial<BuildRecordInput> = {}): BuildRecordInput {
  return {
    summary: "Built a thing",
    container: "/project1/thing",
    nodes: [{ name: "noise1", path: "/project1/thing/noise1", type: "noiseTOP" }],
    edges: [],
    warnings: [],
    errors: [],
    ...overrides,
  };
}

describe("build log", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tdmcp-build-log-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const records = (): BuildRecord[] =>
    readFileSync(join(dir, "builds.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as BuildRecord);

  const recorder = (maxRecords?: number) =>
    createBuildRecorder({
      dir,
      logger: silentLogger,
      ...(maxRecords !== undefined ? { maxRecords } : {}),
    });

  it("attributes a build to the tool call in scope", async () => {
    const log = recorder();
    await withToolCall({ tool: "create_thing", args: { speed: 2 } }, () =>
      log.record(
        input({
          output: "/project1/thing/out1",
          recipe: "thing",
          edges: [{ from: "/a", to: "/b" }],
        }),
      ),
    );

    const [record] = records();
    expect(record).toMatchObject({
      schemaVersion: 1,
      tool: "create_thing",
      args: { speed: 2 },
      container: "/project1/thing",
      output: "/project1/thing/out1",
      recipe: "thing",
      edges: [{ from: "/a", to: "/b" }],
    });
    expect(record?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("omits the tool outside a tool call", async () => {
    await recorder().record(input());
    const [record] = records();
    expect(record?.tool).toBeUndefined();
    expect(record?.args).toBeUndefined();
  });

  it("never writes secrets from arguments or node parameters", async () => {
    await withToolCall(
      {
        tool: "connect_thing",
        args: {
          api_key: "sk-live-secret",
          nested: { password: "hunter2" },
          url: "wss://user:pw-secret@example.com/feed",
          header: "Bearer tok-secret",
        },
      },
      () =>
        recorder().record(
          input({
            nodes: [{ name: "a", path: "/a", type: "webclientDAT", parameters: { token: "t0k" } }],
            warnings: ["Failed: https://bob:warn-secret@example.com"],
          }),
        ),
    );

    const raw = readFileSync(join(dir, "builds.jsonl"), "utf8");
    for (const secret of ["sk-live-secret", "hunter2", "pw-secret", "tok-secret", "t0k"]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).not.toContain("warn-secret");
  });

  it("bounds long values", async () => {
    await withToolCall({ tool: "t", args: { code: "x".repeat(50_000) } }, () =>
      recorder().record(input({ warnings: Array.from({ length: 200 }, (_, i) => `warning ${i}`) })),
    );
    const [record] = records();
    expect(String(record?.args?.code).length).toBeLessThan(2100);
    expect(record?.warnings).toHaveLength(50);
  });

  it("stores the preview beside the log, privately", async () => {
    await recorder().record(input({ preview: { base64: PNG_BASE64, mimeType: "image/png" } }));
    const [record] = records();
    expect(record?.preview).toBe(join("previews", `${record?.id}.png`));
    const file = join(dir, record?.preview ?? "");
    expect(readFileSync(file, "utf8")).toBe("fake-png");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "builds.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("skips an oversized preview but keeps the record", async () => {
    await recorder().record(
      input({ preview: { base64: "a".repeat(4_000_001), mimeType: "image/png" } }),
    );
    const [record] = records();
    expect(record?.preview).toBeUndefined();
    expect(existsSync(join(dir, "previews"))).toBe(false);
  });

  it("keeps the newest records and deletes the previews of pruned ones", async () => {
    const log = recorder(2);
    const preview = { base64: PNG_BASE64, mimeType: "image/png" };
    await log.record(input({ summary: "first", preview }));
    const first = records()[0];
    await log.record(input({ summary: "second", preview }));
    await log.record(input({ summary: "third", preview }));

    expect(records().map((r) => r.summary)).toEqual(["second", "third"]);
    expect(existsSync(join(dir, first?.preview ?? "missing"))).toBe(false);
    expect(existsSync(join(dir, records()[0]?.preview ?? "missing"))).toBe(true);
  });

  it("swallows write failures and reports them at debug level", async () => {
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "");
    const debug = vi.fn();
    const log = createBuildRecorder({
      dir: join(blocker, "builds"),
      logger: { ...silentLogger, debug },
    });
    await expect(log.record(input())).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalledWith("build log skipped", expect.anything());
  });

  it("recovers after a failed write", async () => {
    const debug = vi.fn();
    const log = createBuildRecorder({ dir, logger: { ...silentLogger, debug } });
    await log.record(
      withToolCall({ tool: "t", args: undefined }, () => input({ summary: "before" })),
    );
    await log.record(input({ summary: "after" }));
    expect(records().map((r) => r.summary)).toEqual(["before", "after"]);
    expect(debug).not.toHaveBeenCalled();
  });

  describe("config wiring", () => {
    it("is on by default", () => {
      const config = loadConfig({});
      expect(config.buildLog).toBe("on");
      expect(buildToolContext(config, { logger: silentLogger }).buildLog).toBeDefined();
    });

    it("is absent with TDMCP_BUILD_LOG=off", () => {
      const config = loadConfig({ TDMCP_BUILD_LOG: "off" });
      expect(buildToolContext(config, { logger: silentLogger }).buildLog).toBeUndefined();
    });

    it("rejects an invalid value", () => {
      expect(() => loadConfig({ TDMCP_BUILD_LOG: "maybe" })).toThrow();
    });

    it("reads the directory and retention from env", () => {
      const config = loadConfig({
        TDMCP_BUILD_LOG_DIR: "/tmp/somewhere",
        TDMCP_BUILD_LOG_MAX_RECORDS: "5",
      });
      expect(config.buildLogDir).toBe("/tmp/somewhere");
      expect(config.buildLogMaxRecords).toBe(5);
    });
  });

  describe("finalize", () => {
    function fakeContext(buildLog: ToolContext["buildLog"]): ToolContext {
      return {
        buildLog,
        logger: silentLogger,
        client: {
          createNode: vi.fn(async ({ parent_path, type, name }) => ({
            path: `${parent_path}/${name}`,
            name,
            type,
          })),
          updateNodeParameters: vi.fn(async () => ({})),
          setParameterMode: vi.fn(async () => ({})),
          executePythonScript: vi.fn(async () => ({ stdout: "" })),
          getNetworkErrors: vi.fn(async () => ({ errors: [] })),
          getNodeErrors: vi.fn(async () => ({ errors: [] })),
        },
      } as unknown as ToolContext;
    }

    it("records the nodes, requested parameters and wires it built", async () => {
      const log = recorder();
      const ctx = fakeContext(log);
      const builder = new NetworkBuilder(ctx, "/project1/sys");
      const noise = await builder.add("noiseTOP", "noise1", { amp: 0.5 });
      const out = await builder.add("nullTOP", "out1");
      await builder.connect(noise, out);
      await builder.setParams(noise, { period: 2 });
      await builder.setParamExpr(noise, "t4d", "absTime.seconds");

      const result = await finalize(ctx, {
        summary: "Built sys",
        builder,
        outputPath: out,
        capturePreviewImage: false,
      });

      expect(result.isError).toBeUndefined();
      const [record] = records();
      expect(record).toMatchObject({ summary: "Built sys", container: "/project1/sys" });
      expect(record?.output).toBe(out);
      expect(record?.nodes[0]).toMatchObject({
        type: "noiseTOP",
        parameters: { amp: 0.5, period: 2, t4d: { expr: "absTime.seconds" } },
      });
      expect(record?.nodes[1]?.parameters).toBeUndefined();
      expect(record?.edges).toEqual([{ from: noise, to: out }]);
    });

    it("does not change the tool result when the log fails or is off", async () => {
      const run = async (buildLog: ToolContext["buildLog"]) => {
        const ctx = fakeContext(buildLog);
        const builder = new NetworkBuilder(ctx, "/project1/sys");
        await builder.add("noiseTOP", "noise1");
        return finalize(ctx, { summary: "Built", builder, capturePreviewImage: false });
      };
      const blocked = join(dir, "blocked");
      writeFileSync(blocked, "");
      const broken = createBuildRecorder({ dir: join(blocked, "x"), logger: silentLogger });

      expect(await run(broken)).toEqual(await run(undefined));
    });
  });
});
