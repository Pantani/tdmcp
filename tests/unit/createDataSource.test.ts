import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildDataSourceScript,
  createDataSourceImpl,
} from "../../src/tools/layer2/createDataSource.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  kind: string;
  parent: string;
  name: string | null;
  url: string | null;
  port: number | null;
  device: string | null;
  baud: number | null;
  fields: string[];
  poll_seconds: number;
  expose_controls: boolean;
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

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function okExec(report: Record<string, unknown> = {}) {
  return vi.fn(async () => ({
    stdout: JSON.stringify({
      kind: "json",
      container: "/project1/data_source_json",
      source: "/project1/data_source_json/src",
      source_type: "webclient",
      null_chop: "/project1/data_source_json/out",
      null_dat: "/project1/data_source_json/raw",
      channels: ["value"],
      fields: ["value"],
      controls: ["Active", "Poll"],
      warnings: [],
      ...report,
    }),
  }));
}

// Defaults present on every call so callers in the tests can omit them.
const BASE = { baud: 9600, fields: ["value"], poll_seconds: 1, expose_controls: true };

describe("buildDataSourceScript", () => {
  it("round-trips the payload and emits the json/csv sample-table machinery", () => {
    const payload = {
      kind: "json",
      parent: "/project1",
      name: null,
      url: null,
      port: null,
      device: null,
      baud: null,
      fields: ["bass", "mid"],
      poll_seconds: 1,
      expose_controls: true,
    };
    const script = buildDataSourceScript(payload);
    expect(decodePayload(script)).toEqual(payload);
    // The offline-cook contract: a sample table seeded from fields → DAT-to-CHOP → Null CHOP.
    expect(script).toContain("_c.create(tableDAT");
    expect(script).toContain("_sample.appendRow(_fields)");
    expect(script).toContain("_c.create(dattoCHOP");
    expect(script).toContain('_c.create(nullCHOP, "out")');
    // Raw text is exposed on a Null DAT.
    expect(script).toContain('_c.create(nullDAT, "raw")');
    // The Web Client DAT is the live json/csv source.
    expect(script).toContain("_c.create(webclientDAT");
    // Channels are read from the Null CHOP so the report carries the field names.
    expect(script).toContain("_null_chop.chans()");
  });

  it("applies poll_seconds: a refresh Execute DAT re-pulses the Web Client request on an interval", () => {
    const script = buildDataSourceScript({ kind: "json", expose_controls: true });
    // The Web Client DAT has no interval param, so an Execute DAT re-pulses request on a cadence.
    expect(script).toContain('_c.create(executeDAT, "refresh")');
    expect(script).toContain("onFrameStart");
    expect(script).toContain("src.par.request.pulse()");
    // When controls are exposed the interval comes from the live Poll knob (so it retunes live).
    expect(script).toContain("op(%r).par.Poll");
  });

  it("creates REAL Active + Poll controls on json/csv (not just a label list)", () => {
    const script = buildDataSourceScript({ kind: "json", expose_controls: true });
    // A custom page with appended Active toggle + Poll float, bound to the source.
    expect(script).toContain('_pg.appendToggle("Active")');
    expect(script).toContain('_pg.appendFloat("Poll")');
    // Active drives the Web Client DAT's enable via an expression (not a clobbering value bind).
    expect(script).toContain('_src.par.active.expr = "op(%r).par.Active"');
    expect(script).toContain("EXPRESSION");
  });

  it("still installs the refresh poller, choosing interval by expose_controls", () => {
    // The refresh Execute DAT is always created; its interval comes from the live Poll knob when
    // controls are exposed, else the literal poll_seconds (the ternary keys off expose_controls).
    const script = buildDataSourceScript({ kind: "json", expose_controls: false });
    expect(script).toContain('_c.create(executeDAT, "refresh")');
    expect(script).toContain('("op(%r).par.Poll" % _c.path) if _p.get("expose_controls") else');
  });

  it("keeps the refresh poller active=1 unconditionally (callback no-ops while there is no URL)", () => {
    // Gating active on the URL meant a later-set URL never started polling. The poller is now
    // always active; its onFrameStart callback early-returns while src.par.url is empty, so it is a
    // harmless no-op when built without a URL but starts the moment one is set.
    const script = buildDataSourceScript({ kind: "json", expose_controls: true });
    expect(script).toContain("_refresh.par.active = 1");
    expect(script).not.toContain('_refresh.par.active = 1 if _p.get("url") else 0');
    // The callback guards on the URL so the always-on poller no-ops cleanly with no endpoint.
    expect(script).toContain("not src.par.url.eval()");
  });

  it("creates a real Active control for osc/serial sources too", () => {
    const osc = buildDataSourceScript({ kind: "osc", expose_controls: true });
    expect(osc).toContain("_expose_active(_src");
    // The shared helper appends a real Active toggle and expression-binds the source enable.
    expect(osc).toContain('_pg.appendToggle("Active")');
    expect(osc).toContain('"op(%r).par.Active"');
  });

  it("includes the osc and serial source operators", () => {
    const script = buildDataSourceScript({ kind: "osc" });
    expect(script).toContain("_c.create(oscinDAT");
    expect(script).toContain("_c.create(oscinCHOP");
    expect(script).toContain("_c.create(serialDAT");
  });
});

describe("createDataSourceImpl", () => {
  it("defaults to json, forwards fields, and seeds a sample (url stays optional)", async () => {
    const exec = okExec();
    await createDataSourceImpl(fakeCtx(exec), {
      kind: "json",
      parent_path: "/project1",
      ...BASE,
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.kind).toBe("json");
    expect(p.url).toBeNull();
    expect(p.fields).toEqual(["value"]);
    // The seeding code path is present so the network cooks with no endpoint.
    expect(scriptArg(exec)).toContain("_sample.appendRow");
  });

  it("propagates custom fields as the channel-name contract", async () => {
    const exec = okExec();
    await createDataSourceImpl(fakeCtx(exec), {
      kind: "csv",
      parent_path: "/project1",
      url: "https://example.com/data.csv",
      ...BASE,
      fields: ["temp", "humidity", "pressure"],
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.kind).toBe("csv");
    expect(p.url).toBe("https://example.com/data.csv");
    expect(p.fields).toEqual(["temp", "humidity", "pressure"]);
  });

  it("defaults the OSC port to 7000 and leaves url/device null", async () => {
    const exec = okExec({ kind: "osc", controls: ["Active"] });
    await createDataSourceImpl(fakeCtx(exec), {
      kind: "osc",
      parent_path: "/project1",
      ...BASE,
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.kind).toBe("osc");
    expect(p.port).toBe(7000);
    expect(p.url).toBeNull();
    expect(p.device).toBeNull();
  });

  it("forwards serial device and baud and leaves port null", async () => {
    const exec = okExec({ kind: "serial", controls: ["Active"] });
    await createDataSourceImpl(fakeCtx(exec), {
      kind: "serial",
      parent_path: "/project1",
      device: "/dev/tty.usbserial",
      ...BASE,
      baud: 115200,
    });
    const p = decodePayload(scriptArg(exec));
    expect(p.kind).toBe("serial");
    expect(p.device).toBe("/dev/tty.usbserial");
    expect(p.baud).toBe(115200);
    expect(p.port).toBeNull();
  });

  it("summarizes the Null CHOP, channel count, and binding hint on success", async () => {
    const exec = okExec({ channels: ["bass", "mid", "high"] });
    const result = await createDataSourceImpl(fakeCtx(exec), {
      kind: "json",
      parent_path: "/project1",
      ...BASE,
      fields: ["bass", "mid", "high"],
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("3 channel(s)");
    expect(text).toContain("/project1/data_source_json/out");
    expect(text).toContain("Bind to the Null CHOP");
  });

  it("returns an isError result when the bridge reports a fatal", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        kind: "json",
        warnings: [],
        fatal: "Parent COMP not found: /nope",
      }),
    }));
    const result = await createDataSourceImpl(fakeCtx(exec), {
      kind: "json",
      parent_path: "/nope",
      ...BASE,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });
});
