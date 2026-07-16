import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runToxRoundtripGate,
  type ToxRoundtripClient,
  type ToxRoundtripGateArgs,
  type ToxRoundtripResult,
  toxRoundtripDeepSchema,
} from "../../src/tools/library/toxRoundtripGate.js";

const SECRET = "private-token-must-never-appear";
const SHA = "2c2ca7068438b9e7376f768e1c5807767bdf50e887860919a3fb8d4f6b049e3f";
const dirs: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "tdmcp-tox-roundtrip-"));
  dirs.push(dir);
  const path = join(dir, "widget.tox");
  writeFileSync(path, "TOX-ROUNDTRIP-FIXTURE", "utf8");
  return path;
}

function args(path: string, overrides: Partial<ToxRoundtripGateArgs> = {}): ToxRoundtripGateArgs {
  return {
    path,
    validation_mode: "deep_roundtrip",
    deep: {
      quarantine_host: "127.0.0.1",
      quarantine_port: 9981,
      timeout_ms: 1000,
      settle_frames: 2,
      max_nodes: 20,
      max_errors: 10,
      max_external_refs: 10,
      expected_contract: { schema_version: 1, max_cook_errors: 0 },
    },
    ...overrides,
  };
}

function result(
  status: ToxRoundtripResult["status"] = "succeeded",
  verdict: ToxRoundtripResult["verdict"] = "PASS",
): ToxRoundtripResult {
  const terminal = new Set(["succeeded", "failed", "cancelled", "expired"]).has(status);
  return {
    operation_id: "operation_id_000000000001",
    status,
    verdict,
    artifact: { path: "/tmp/widget.tox", size_bytes: 21, sha256: SHA },
    runtime: { frames_waited: terminal ? 2 : 0 },
    observed: {},
    checks: terminal
      ? [
          {
            name: "cleanup",
            verdict: "PASS",
            code: "verified",
            summary: "Scratch holder removed",
          },
        ]
      : [],
    cleanup: {
      attempted: terminal,
      removed: terminal,
      verified: terminal,
      scratch_path: "/project1/tdmcp_rt_operation",
    },
    error: null,
  };
}

function client(sequence: unknown[]): ToxRoundtripClient & {
  calls: string[];
  requests: unknown[];
} {
  const values = [...sequence];
  const calls: string[] = [];
  const requests: unknown[] = [];
  return {
    calls,
    requests,
    async getInfo() {
      calls.push("info");
      return { ok: true };
    },
    async startToxRoundtrip(request) {
      calls.push("start");
      requests.push(request);
      return values.shift() ?? result();
    },
    async getToxRoundtrip() {
      calls.push("get");
      return values.shift() ?? result();
    },
    async cancelToxRoundtrip(_operationId, reason) {
      calls.push(`cancel:${reason}`);
      return values.shift() ?? result("cancelled", "UNVERIFIED");
    },
  };
}

function dependencies(fake: ToxRoundtripClient, bridgeToken = SECRET) {
  return {
    bridgeToken,
    clientFactory: vi.fn((baseUrl: string, token: string) => {
      expect(baseUrl).toBe("http://127.0.0.1:9981");
      expect(token).toBe(SECRET);
      return fake;
    }),
    sleep: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runToxRoundtripGate", () => {
  it("keeps the bearer outside the public deep schema", () => {
    expect(
      toxRoundtripDeepSchema.safeParse({
        quarantine_port: 9981,
        bearer_token: SECRET,
      }).success,
    ).toBe(false);
    expect(JSON.stringify(toxRoundtripDeepSchema._def)).not.toContain(SECRET);
  });

  it("passes private auth only to the dedicated 9981 client and returns no secret", async () => {
    const path = fixture();
    const fake = client([result()]);
    const deps = dependencies(fake);

    const report = await runToxRoundtripGate(args(path), deps);

    expect(report.roundtrip.verdict).toBe("PASS");
    expect(deps.clientFactory).toHaveBeenCalledTimes(1);
    expect(fake.calls).toEqual(["info", "start"]);
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(JSON.stringify(fake.requests)).not.toContain(SECRET);
  });

  it("rejects port 9980 and invalid tox paths before creating a client", async () => {
    const path = fixture();
    const factory = vi.fn(() => client([]));
    const badPort = await runToxRoundtripGate(
      args(path, { deep: { quarantine_port: 9980 } as never }),
      { bridgeToken: SECRET, clientFactory: factory },
    );
    const relative = await runToxRoundtripGate(args("widget.tox"), {
      bridgeToken: SECRET,
      clientFactory: factory,
    });
    const link = join(path, "..", "linked.tox");
    symlinkSync(path, link);
    const linked = await runToxRoundtripGate(args(link), {
      bridgeToken: SECRET,
      clientFactory: factory,
    });

    expect(badPort.roundtrip.verdict).toBe("FAIL");
    expect(relative.roundtrip.error?.code).toBe("invalid_tox_artifact");
    expect(linked.roundtrip.error?.code).toBe("invalid_tox_artifact");
    expect(factory).not.toHaveBeenCalled();
  });

  it("fails closed when private auth config is absent without exposing it", async () => {
    const report = await runToxRoundtripGate(args(fixture()), {
      bridgeToken: "",
      clientFactory: vi.fn(() => client([])),
    });

    expect(report.roundtrip.error?.code).toBe("bridge_auth_missing");
    expect(report.roundtrip.verdict).toBe("FAIL");
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("reports an offline quarantine as UNVERIFIED and auth rejection as FAIL", async () => {
    const path = fixture();
    const offline = client([]);
    offline.getInfo = async () => {
      throw new Error(`ECONNREFUSED ${SECRET}`);
    };
    const unauthorized = client([]);
    unauthorized.getInfo = async () => {
      throw new Error(`401 unauthorized token=${SECRET}`);
    };

    const offlineReport = await runToxRoundtripGate(args(path), dependencies(offline));
    const authReport = await runToxRoundtripGate(args(path), dependencies(unauthorized));

    expect(offlineReport.roundtrip.verdict).toBe("UNVERIFIED");
    expect(authReport.roundtrip.verdict).toBe("FAIL");
    expect(JSON.stringify([offlineReport, authReport])).not.toContain(SECRET);
  });

  it("polls bounded job state to terminal verified cleanup", async () => {
    const fake = client([
      result("queued", "UNVERIFIED"),
      result("settling", "UNVERIFIED"),
      result(),
    ]);
    const deps = dependencies(fake);

    const report = await runToxRoundtripGate(args(fixture()), deps);

    expect(report.roundtrip.status).toBe("succeeded");
    expect(fake.calls).toEqual(["info", "start", "get", "get"]);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it("cancels on abort and returns the bridge terminal cleanup result", async () => {
    const fake = client([result("queued", "UNVERIFIED"), result("cancelled", "UNVERIFIED")]);
    const controller = new AbortController();
    controller.abort();
    const deps = { ...dependencies(fake), signal: controller.signal };

    const report = await runToxRoundtripGate(args(fixture()), deps);

    expect(report.roundtrip.status).toBe("cancelled");
    expect(fake.calls).toContain("cancel:client_cancelled");
  });

  it("does not accept succeeded state without verified cleanup", async () => {
    const unsafe = result();
    unsafe.cleanup = { attempted: true, removed: false, verified: false };
    const report = await runToxRoundtripGate(args(fixture()), dependencies(client([unsafe])));

    expect(report.roundtrip.verdict).toBe("FAIL");
    expect(report.roundtrip.error?.code).toBe("cleanup_unverified");
  });

  it("never throws or reflects secrets from malformed bridge responses", async () => {
    const fake = client([{ invalid: `response ${SECRET}` }]);

    const report = await runToxRoundtripGate(args(fixture()), dependencies(fake));

    expect(report.roundtrip.verdict).toBe("FAIL");
    expect(report.roundtrip.error?.code).toBe("roundtrip_failed");
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("rejects a conflicting manifest contract before TD I/O", async () => {
    const path = fixture();
    const manifest = join(path, "..", "tdmcp-component.json");
    writeFileSync(
      manifest,
      JSON.stringify({ roundtrip_contract: { schema_version: 1, node_count: 99 } }),
      "utf8",
    );
    const factory = vi.fn(() => client([]));

    const report = await runToxRoundtripGate(args(path, { manifest_path: manifest }), {
      bridgeToken: SECRET,
      clientFactory: factory,
    });

    expect(report.roundtrip.error?.code).toBe("contract_conflict");
    expect(factory).not.toHaveBeenCalled();
  });
});
