import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildClassSource,
  buildExtensionScript,
  scaffoldExtensionImpl,
  scaffoldExtensionSchema,
} from "../../src/tools/layer2/scaffoldExtension.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  comp: string;
  class_name: string;
  code: string;
  extension: string;
  promote: boolean;
  slot: number;
  methods: string[];
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

const okReport = (over: Record<string, unknown> = {}) =>
  vi.fn(async (_script: string, _capture?: boolean) => ({
    stdout: JSON.stringify({
      comp: "/project1/sys",
      dat: "/project1/sys/WidgetExt",
      extension: "op('./WidgetExt').module.WidgetExt(me)",
      promoted: true,
      methods: ["Reset"],
      warnings: [],
      ...over,
    }),
  }));

const args = (over: Record<string, unknown> = {}) =>
  scaffoldExtensionSchema.parse({
    comp_path: "/project1/sys",
    class_name: "WidgetExt",
    methods: ["Reset"],
    ...over,
  });

describe("buildClassSource", () => {
  it("emits a class with an ownerComp __init__ and a stub per method", () => {
    const src = buildClassSource("WidgetExt", ["Reset", "Tick"]);
    expect(src).toContain("class WidgetExt:");
    expect(src).toContain("def __init__(self, ownerComp):");
    expect(src).toContain("self.ownerComp = ownerComp");
    expect(src).toContain("    def Reset(self):");
    expect(src).toContain("    def Tick(self):");
    expect(src).toContain("        pass");
  });
});

describe("buildExtensionScript", () => {
  it("round-trips the payload and wires extension/promote/reinit on the COMP", () => {
    const script = buildExtensionScript({
      comp: "/project1/sys",
      class_name: "WidgetExt",
      code: buildClassSource("WidgetExt", []),
      extension: "op('./WidgetExt').module.WidgetExt(me)",
      promote: true,
      slot: 1,
      methods: [],
    });
    const payload = decodePayload(script);
    expect(payload.comp).toBe("/project1/sys");
    expect(payload.extension).toBe("op('./WidgetExt').module.WidgetExt(me)");
    // The script probes the build-specific extension parameter names and refreshes.
    // It must cover BOTH the current zero-based scheme (ext0object/ext0promote) and
    // the legacy one-based scheme (extension1/promoteextension1), or it silently
    // fails to wire the COMP on current builds.
    expect(script).toContain("ext%dobject");
    expect(script).toContain("ext%dpromote");
    expect(script).toContain("extension%d");
    expect(script).toContain("promoteextension%d");
    expect(script).toContain("reinitextensions");
    expect(script).toContain("_reinit.pulse()");
    expect(script).toContain("_comp.create(textDAT");
    expect(script).toContain('_dat.text = _p["code"]');
  });

  it("treats a non-Text-DAT name collision as fatal instead of overwriting it", () => {
    const script = buildExtensionScript({
      comp: "/c",
      class_name: "WidgetExt",
      code: "",
      extension: "",
      promote: true,
      slot: 1,
      methods: [],
    });
    // Identifies a Text DAT by OPType ("textDAT") with a .type ("text") fallback,
    // matching the bridge's op_type() convention; anything else is fatal.
    expect(script).toContain('"textDAT"');
    expect(script).toContain('_dat.type == "text"');
    expect(script).toContain("not a Text DAT");
  });
});

describe("scaffoldExtensionImpl", () => {
  it("sanitizes the class name and builds a matching mod(...) extension expression", async () => {
    const exec = okReport();
    await scaffoldExtensionImpl(fakeCtx(exec), args({ class_name: "myWidget" }));
    const payload = decodePayload(scriptArg(exec));
    expect(payload.class_name).toBe("MyWidget");
    expect(payload.extension).toBe("op('./MyWidget').module.MyWidget(me)");
    expect(payload.code).toContain("class MyWidget:");
    expect(exec.mock.calls[0]?.[1]).toBe(true);
  });

  it("sanitizes, dedupes and keeps method stubs in the class source", async () => {
    const exec = okReport({ methods: ["doThing", "dothing", "m123bad"] });
    await scaffoldExtensionImpl(
      fakeCtx(exec),
      args({ methods: ["doThing", "do thing", "123bad", "doThing"] }),
    );
    const payload = decodePayload(scriptArg(exec));
    expect(payload.methods).toEqual(["doThing", "dothing", "m123bad"]);
    expect(payload.code).toContain("def doThing(self):");
    expect(payload.code).toContain("def m123bad(self):");
  });

  it("rejects an unusable class name without touching TD", async () => {
    const exec = vi.fn();
    const result = await scaffoldExtensionImpl(fakeCtx(exec), args({ class_name: "!!!" }));
    expect(result.isError).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("escapes a Python-keyword class name so the source stays valid", async () => {
    const exec = okReport();
    await scaffoldExtensionImpl(fakeCtx(exec), args({ class_name: "None" }));
    const payload = decodePayload(scriptArg(exec));
    expect(payload.class_name).toBe("None_");
    expect(payload.code).toContain("class None_:");
    expect(payload.extension).toBe("op('./None_').module.None_(me)");
  });

  it("escapes Python-keyword method names (class/def/return → class_/def_/return_)", async () => {
    const exec = okReport();
    await scaffoldExtensionImpl(fakeCtx(exec), args({ methods: ["class", "def", "return"] }));
    const payload = decodePayload(scriptArg(exec));
    expect(payload.methods).toEqual(["class_", "def_", "return_"]);
    expect(payload.code).toContain("def class_(self):");
    expect(payload.code).toContain("def return_(self):");
  });

  it("drops dunder method names so they can't override the generated constructor", async () => {
    const exec = okReport();
    await scaffoldExtensionImpl(fakeCtx(exec), args({ methods: ["__init__", "doThing"] }));
    const payload = decodePayload(scriptArg(exec));
    expect(payload.methods).toEqual(["doThing"]);
    // Exactly one __init__ (the generated constructor) — no `def __init__(self): pass` stub.
    expect(payload.code).toContain("def __init__(self, ownerComp):");
    expect(payload.code).not.toContain("def __init__(self):");
    expect((payload.code.match(/def __init__/g) ?? []).length).toBe(1);
  });

  it("summarizes the class, promotion and method count on success", async () => {
    const result = await scaffoldExtensionImpl(fakeCtx(okReport()), args());
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("WidgetExt");
    expect(text).toContain("promoted");
    expect(text).toContain("1 method stub(s)");
  });

  it("surfaces a build-difference probe note as a warning, not a failure", async () => {
    const exec = okReport({
      warnings: ["Used 'ext1' for the extension slot (this build differs from 'extension1')."],
    });
    const result = await scaffoldExtensionImpl(fakeCtx(exec), args());
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/1 warning\(s\)/);
  });

  it("returns an error result (not a throw) when report.fatal is set", async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        comp: "/project1/sys",
        methods: [],
        warnings: [],
        fatal: "/project1/sys is not a COMP, so it cannot hold an extension.",
      }),
    }));
    const result = await scaffoldExtensionImpl(fakeCtx(exec), args());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("is not a COMP");
  });

  it("never throws when the bridge call fails — it returns an isError result", async () => {
    const exec = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const result = await scaffoldExtensionImpl(fakeCtx(exec), args());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("connection refused");
  });
});

describe("scaffoldExtensionSchema (input validation)", () => {
  it("rejects a missing comp_path", () => {
    expect(scaffoldExtensionSchema.safeParse({ class_name: "WidgetExt" }).success).toBe(false);
  });

  it("defaults promote=true and slot=1", () => {
    const parsed = scaffoldExtensionSchema.parse({ comp_path: "/c", class_name: "WidgetExt" });
    expect(parsed.promote).toBe(true);
    expect(parsed.slot).toBe(1);
  });

  it("rejects a slot outside 1–8", () => {
    expect(
      scaffoldExtensionSchema.safeParse({ comp_path: "/c", class_name: "W", slot: 99 }).success,
    ).toBe(false);
  });
});
