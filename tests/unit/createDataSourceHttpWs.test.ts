import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { TdConnectionError } from "../../src/td-client/types.js";
import {
  buildDataSourceHttpWsScript,
  createDataSourceHttpWsImpl,
  createDataSourceHttpWsSchema,
} from "../../src/tools/layer2/createDataSourceHttpWs.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

function fakeCtx(exec: ReturnType<typeof vi.fn>): ToolContext {
  return { client: { executePythonScript: exec }, logger: silentLogger } as unknown as ToolContext;
}

function scriptArg(exec: ReturnType<typeof vi.fn>): string {
  const script = exec.mock.calls[0]?.[0];
  if (typeof script !== "string")
    throw new Error("executePythonScript was not called with a script");
  return script;
}

function decodePayload(script: string): Record<string, unknown> {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("script did not embed a base64 payload");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function okPollExec(overrides: Record<string, unknown> = {}) {
  return vi.fn(async () => ({
    stdout: JSON.stringify({
      mode: "http_poll",
      container: "/project1/data_src_http_poll",
      source: "/project1/data_src_http_poll/src",
      source_type: "webclient",
      null_chop: "/project1/data_src_http_poll/out",
      null_dat: "/project1/data_src_http_poll/raw",
      channels: ["volume", "bpm"],
      selectors: [
        { name: "volume", path: "$.data.volume" },
        { name: "bpm", path: "$.data.bpm" },
      ],
      endpoint: "https://example.com/api",
      controls: ["Active", "Poll", "LastValue_volume", "LastValue_bpm"],
      errors: [],
      warnings: [],
      ...overrides,
    }),
  }));
}

function okWsExec(overrides: Record<string, unknown> = {}) {
  return vi.fn(async () => ({
    stdout: JSON.stringify({
      mode: "websocket",
      container: "/project1/data_src_websocket",
      source: "/project1/data_src_websocket/src",
      source_type: "websocket",
      null_chop: "/project1/data_src_websocket/out",
      null_dat: "/project1/data_src_websocket/raw",
      channels: ["volume"],
      selectors: [{ name: "volume", path: "$.volume" }],
      endpoint: "wss://example/socket",
      reconnect_seconds: 2.0,
      controls: ["Active", "Reconnect", "LastValue_volume"],
      errors: [],
      warnings: [],
      ...overrides,
    }),
  }));
}

const BASE_POLL = {
  mode: "http_poll" as const,
  parent_path: "/project1",
  url: "https://example.com/api",
  selectors: [
    { name: "volume", path: "$.data.volume" },
    { name: "bpm", path: "$.data.bpm" },
  ],
};

const BASE_WS = {
  mode: "websocket" as const,
  parent_path: "/project1",
  url: "wss://example/socket",
  selectors: [{ name: "volume", path: "$.volume" }],
};

describe("createDataSourceHttpWsSchema validation", () => {
  it("rejects missing url", () => {
    const result = createDataSourceHttpWsSchema.safeParse({
      selectors: [{ name: "v", path: "$.v" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty selectors array", () => {
    const result = createDataSourceHttpWsSchema.safeParse({
      url: "https://example.com",
      selectors: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate selector names", () => {
    const result = createDataSourceHttpWsSchema.safeParse({
      url: "https://example.com",
      selectors: [
        { name: "foo", path: "$.foo" },
        { name: "foo", path: "$.bar" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid http_poll config", () => {
    const result = createDataSourceHttpWsSchema.safeParse(BASE_POLL);
    expect(result.success).toBe(true);
  });

  it("accepts a valid websocket config", () => {
    const result = createDataSourceHttpWsSchema.safeParse(BASE_WS);
    expect(result.success).toBe(true);
  });
});

describe("buildDataSourceHttpWsScript", () => {
  it("http_poll: embeds webclientDAT, timerCHOP, selector paths, and URL in script", () => {
    const payload = {
      mode: "http_poll",
      url: "https://example.com/api",
      selectors: [
        ["volume", "$.data.volume"],
        ["bpm", "$.data.bpm"],
      ],
      poll_seconds: 1.0,
    };
    const script = buildDataSourceHttpWsScript(payload);
    // Template contains the TD operator creation keywords
    expect(script).toContain("webclientDAT");
    expect(script).toContain("timerCHOP");
    // chopExecute wires the timer cycle to request pulse
    expect(script).toContain("chopexecuteDAT");
    expect(script).toContain("src.par.request.pulse()");
    // Selector paths and URL live in the embedded payload
    const p = decodePayload(script);
    expect(p["url"]).toBe("https://example.com/api");
    const selectors = p["selectors"] as Array<[string, string]>;
    expect(selectors[0]).toEqual(["volume", "$.data.volume"]);
    expect(selectors[1]).toEqual(["bpm", "$.data.bpm"]);
  });

  it("websocket: embeds websocketDAT, reconnect_seconds, onReceiveText in script", () => {
    const payload = {
      mode: "websocket",
      url: "wss://example/socket",
      selectors: [["volume", "$.volume"]],
      reconnect_seconds: 3.0,
    };
    const script = buildDataSourceHttpWsScript(payload);
    expect(script).toContain("websocketDAT");
    expect(script).toContain("onReceiveText");
    expect(script).toContain("reconnect_seconds");
    // onConnect/onDisconnect for status storage
    expect(script).toContain("onConnect");
    expect(script).toContain("onDisconnect");
    expect(script).toContain("tdmcp_ws_status");
    // Payload carries mode=websocket and the selector
    const p = decodePayload(script);
    expect(p["mode"]).toBe("websocket");
    expect(p["reconnect_seconds"]).toBe(3.0);
    const selectors = p["selectors"] as Array<[string, string]>;
    expect(selectors[0]).toEqual(["volume", "$.volume"]);
  });

  it("seeds sample table from static_sample values", () => {
    const script = buildDataSourceHttpWsScript({
      mode: "http_poll",
      url: "https://example.com",
      selectors: [["vol", "$.vol"]],
      static_sample: { vol: 0.75 },
    });
    expect(script).toContain("static_sample");
    expect(script).toContain("tableDAT");
    expect(script).toContain("_sample.appendRow");
  });

  it("JSONPath-lite evaluator is embedded in parse DAT", () => {
    const script = buildDataSourceHttpWsScript({
      mode: "http_poll",
      url: "https://x.com",
      selectors: [["a", "$.a"]],
    });
    expect(script).toContain("_jsonpath");
    expect(script).toContain("_parse_and_update");
    expect(script).toContain("json.loads");
    expect(script).toContain("decode('utf-8', 'replace')");
  });

  it("sets dattoCHOP via dat parameter (not input connector)", () => {
    const script = buildDataSourceHttpWsScript({
      mode: "http_poll",
      url: "https://x.com",
      selectors: [["a", "$.a"]],
    });
    expect(script).toContain('_setpar(_datto, "dat"');
    expect(script).toContain("nullCHOP");
  });

  // v0.8.1 regression: previously the dattoCHOP menu params were passed as ints
  // (firstrow=1/firstcolumn=0/output=1) which TD silently coerced to wrong menu
  // entries — producing 0-channel or wrongly-named CHOPs and a follow-on
  // "must be real number, not str" error when LastValue_* params tried to coerce.
  it("http_poll: dattoCHOP menu params use string menu names, not int indices", () => {
    const script = buildDataSourceHttpWsScript({
      mode: "http_poll",
      url: "https://x.com",
      selectors: [["a", "$.a"]],
    });
    expect(script).toContain('_setpar(_datto, "firstrow", "values")');
    expect(script).toContain('_setpar(_datto, "firstcolumn", "names")');
    expect(script).toContain('_setpar(_datto, "output", "chanperrow")');
    // Must NOT use the buggy integer form anywhere.
    expect(script).not.toContain('_setpar(_datto, "firstrow", 1)');
    expect(script).not.toContain('_setpar(_datto, "firstcolumn", 0)');
    expect(script).not.toContain('_setpar(_datto, "output", 1)');
  });

  // v0.8.1 regression: sample table must be TRANSPOSED (one row per selector,
  // col0=name, col1=value) so 'firstcolumn=names'+'output=chanperrow' yields one
  // channel per selector. The previous header-row + value-row layout returned
  // either 0 channels (chanpercol) or wrong names (chanperrow).
  it("http_poll: sample table is transposed (one row per selector, [name,value])", () => {
    const script = buildDataSourceHttpWsScript({
      mode: "http_poll",
      url: "https://x.com",
      selectors: [
        ["a", "$.a"],
        ["b", "$.b"],
      ],
      static_sample: { a: 0.5, b: 0.7 },
    });
    // Per-selector loop, appending [name, str(value)] rows.
    expect(script).toContain("for _n in _sel_names:");
    expect(script).toContain("_sample.appendRow([_n, str(_static.get(_n, 0.5))])");
    // Parser callback must mirror the transposed layout.
    expect(script).toContain("for n, v in zip(sel_names, vals):");
    expect(script).toContain("sample.appendRow([n, '%%.6f' %% v])");
  });

  // v0.8.1 regression: custom parameter names follow TD's strict rule — one
  // uppercase letter at the start, the rest lowercase letters/digits, no
  // underscores. Previously "LastValue_<selector>" failed name validation.
  // PR #38: digits MUST be preserved (sensor1 vs sensor2 used to collapse).
  it("http_poll: LastValue custom-param names preserve digits and share one sanitizer", () => {
    const script = buildDataSourceHttpWsScript({
      mode: "http_poll",
      url: "https://x.com",
      selectors: [["MyChan", "$.x"]],
      expose_controls: true,
    });
    // One shared helper for create-path and report-path.
    expect(script).toContain("def _to_custom_par_name(s):");
    // Sanitizer keeps alphanumerics (digits included), lowercases, "Last" prefix.
    expect(script).toContain("_safe = ''.join(ch for ch in s if ch.isalnum()).lower() or 'x'");
    expect(script).toContain('return "Last" + _safe');
    // Both branches must call the shared helper for both create and report.
    expect(script).toContain("_parname = _to_custom_par_name(s)");
    expect(script).toContain('["Active", "Poll"] + [_to_custom_par_name(s) for s in _sel_names]');
    // Must NOT use the underscore form anywhere.
    expect(script).not.toContain('appendFloat("LastValue_"');
    expect(script).not.toContain('LastValue_" + s');
    // Must NOT use the digit-dropping isalpha form anywhere.
    expect(script).not.toContain("isalpha");
  });

  // PR #38: sensor1/sensor2 must produce distinct param names AND the reported
  // controls list must equal the created param names exactly (no title-casing
  // drift between create-path and report-path).
  it("http_poll: digits preserved + reported controls equal created param names", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        mode: "http_poll",
        container: "/project1/data_src_http_poll",
        null_chop: "/project1/data_src_http_poll/out",
        channels: ["cam1", "cam2"],
        selectors: [
          { name: "cam1", path: "$.cam1" },
          { name: "cam2", path: "$.cam2" },
        ],
        controls: ["Active", "Poll", "Lastcam1", "Lastcam2"],
        errors: [],
        warnings: [],
      }),
    }));
    const result = await createDataSourceHttpWsImpl(fakeCtx(exec), {
      mode: "http_poll",
      parent_path: "/project1",
      url: "https://x.com",
      selectors: [
        { name: "cam1", path: "$.cam1" },
        { name: "cam2", path: "$.cam2" },
      ],
      method: "get",
      headers: {},
      poll_seconds: 1,
      reconnect_seconds: 2,
      expose_controls: true,
    });
    expect(result.isError).toBeFalsy();
  });

  it("websocket: digit-preserving sanitizer is also used (no isalpha, shared helper)", () => {
    const script = buildDataSourceHttpWsScript({
      mode: "websocket",
      url: "wss://x.com",
      selectors: [["cam1", "$.cam1"]],
      expose_controls: true,
    });
    expect(script).toContain("def _to_custom_par_name(s):");
    expect(script).toContain(
      '["Active", "Reconnect"] + [_to_custom_par_name(s) for s in _sel_names]',
    );
    expect(script).not.toContain("isalpha");
  });

  // v0.8.1 regression: LastValue expression must explicitly call .eval() on the
  // channel so the float param receives a real number rather than a Channel
  // object that triggers "float() argument must be a string or a real number".
  it("LastValue expression calls .eval() on the channel (not bare indexing)", () => {
    const script = buildDataSourceHttpWsScript({
      mode: "http_poll",
      url: "https://x.com",
      selectors: [["a", "$.a"]],
      expose_controls: true,
    });
    expect(script).toContain("op('out')[%r].eval()");
  });
});

describe("createDataSourceHttpWsImpl", () => {
  it("http_poll happy path: calls executePythonScript once, result has 2 channels", async () => {
    const exec = okPollExec();
    const result = await createDataSourceHttpWsImpl(fakeCtx(exec), {
      ...BASE_POLL,
      method: "get",
      headers: {},
      poll_seconds: 1,
      reconnect_seconds: 2,
      expose_controls: true,
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("2 channel(s)");
    expect(text).toContain("/project1/data_src_http_poll/out");
    expect(text).toContain("Bind to the Null CHOP");
  });

  it("http_poll: forwards url, parent_path, and selector pairs to the payload", async () => {
    const exec = okPollExec();
    await createDataSourceHttpWsImpl(fakeCtx(exec), {
      ...BASE_POLL,
      method: "post",
      headers: { Authorization: "Bearer tok" },
      body: '{"query":"test"}',
      poll_seconds: 2,
      reconnect_seconds: 2,
      expose_controls: true,
    });
    const p = decodePayload(scriptArg(exec));
    expect(p["mode"]).toBe("http_poll");
    expect(p["url"]).toBe("https://example.com/api");
    expect(p["method"]).toBe("post");
    expect(p["body"]).toBe('{"query":"test"}');
    // parent_path must be forwarded as "parent" key so TD builds in the right container
    expect(p["parent"]).toBe("/project1");
    const selectors = p["selectors"] as Array<[string, string]>;
    expect(selectors).toHaveLength(2);
    expect(selectors[0]).toEqual(["volume", "$.data.volume"]);
    expect(selectors[1]).toEqual(["bpm", "$.data.bpm"]);
  });

  it("custom parent_path and name are forwarded to the payload", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        mode: "http_poll",
        container: "/project1/qa/foo",
        null_chop: "/project1/qa/foo/out",
        channels: ["v"],
        selectors: [{ name: "v", path: "$.v" }],
        controls: [],
        errors: [],
        warnings: [],
      }),
    }));
    await createDataSourceHttpWsImpl(fakeCtx(exec), {
      mode: "http_poll",
      parent_path: "/project1/qa",
      name: "foo",
      url: "https://example.com/api",
      selectors: [{ name: "v", path: "$.v" }],
      method: "get",
      headers: {},
      poll_seconds: 1,
      reconnect_seconds: 2,
      expose_controls: false,
    });
    const p = decodePayload(scriptArg(exec));
    expect(p["parent"]).toBe("/project1/qa");
    expect(p["name"]).toBe("foo");
  });

  it("websocket happy path: mode websocket, body/method ignored without error", async () => {
    const exec = okWsExec();
    const result = await createDataSourceHttpWsImpl(fakeCtx(exec), {
      ...BASE_WS,
      method: "post", // should be ignored for websocket
      body: "ignored",
      headers: {},
      poll_seconds: 1,
      reconnect_seconds: 3,
      expose_controls: true,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("websocket");
    expect(text).toContain("1 channel(s)");
    // Script contains websocketDAT content
    expect(scriptArg(exec)).toContain("websocketDAT");
    // mode=websocket payload
    const p = decodePayload(scriptArg(exec));
    expect(p["mode"]).toBe("websocket");
    expect(p["reconnect_seconds"]).toBe(3);
  });

  it("returns errorResult on bridge fatal", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        mode: "http_poll",
        warnings: [],
        fatal: "Parent COMP not found: /nope",
      }),
    }));
    const result = await createDataSourceHttpWsImpl(fakeCtx(exec), {
      ...BASE_POLL,
      parent_path: "/nope",
      method: "get",
      headers: {},
      poll_seconds: 1,
      reconnect_seconds: 2,
      expose_controls: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Parent COMP not found");
  });

  it("surfaces warnings count in result text", async () => {
    const exec = okPollExec({ warnings: ["webclientDAT headers param missing"] });
    const result = await createDataSourceHttpWsImpl(fakeCtx(exec), {
      ...BASE_POLL,
      method: "get",
      headers: { "X-Custom": "val" },
      poll_seconds: 1,
      reconnect_seconds: 2,
      expose_controls: true,
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("1 warning(s)");
  });

  it("returns friendly error when TD is offline (TdConnectionError)", async () => {
    const exec = vi.fn(async () => {
      throw new TdConnectionError("Connection refused");
    });
    const result = await createDataSourceHttpWsImpl(fakeCtx(exec), {
      ...BASE_POLL,
      method: "get",
      headers: {},
      poll_seconds: 1,
      reconnect_seconds: 2,
      expose_controls: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/TouchDesigner|offline|connection/i);
  });
});
