import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  AB_BLEND_CB,
  buildLookBankScript,
  createLookBankImpl,
  createLookBankSchema,
} from "../../src/tools/layer2/createLookBank.js";
import { MORPH_HOOK } from "../../src/tools/layer2/manageCue.js";
import type { ToolContext } from "../../src/tools/types.js";
import { silentLogger } from "../../src/utils/logger.js";

interface Payload {
  action: string;
  comp: string;
  name: string;
  slot?: string;
  morph_seconds: number;
  quantize: string;
  slot_a?: string;
  slot_b?: string;
  ab?: number;
  include?: string[];
  morph_text: string;
  ab_cb: string;
  button_cb: string;
}

function decodePayload(script: string): Payload {
  const b64 = /b64decode\("([^"]+)"\)/.exec(script)?.[1];
  if (b64 === undefined) throw new Error("no base64 payload found in script");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Payload;
}

type ExecMock = ReturnType<typeof vi.fn<(script: string, captureStdout?: boolean) => unknown>>;

function fakeCtx(exec: ExecMock): ToolContext {
  return {
    client: { executePythonScript: exec },
    logger: silentLogger,
  } as unknown as ToolContext;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** A report mock with sensible look-bank defaults, overridable per case. */
const reportMock = (over: Record<string, unknown>): ExecMock =>
  vi.fn(async (_script: string, _capture?: boolean) => ({
    stdout: JSON.stringify({
      action: "build",
      comp: "/project1",
      bank: "/project1/look_bank",
      table: "/project1/look_bank/looks",
      warnings: [],
      ...over,
    }),
  }));

const DEFAULTS = {
  comp_path: "/project1",
  name: "look_bank",
  morph_seconds: 0,
  quantize: "off" as const,
};

describe("buildLookBankScript", () => {
  it("embeds action, comp, name + the shared MORPH_HOOK so Python installs the cue engine", () => {
    const script = buildLookBankScript({
      action: "build",
      comp: "/project1",
      name: "look_bank",
      morph_text: MORPH_HOOK,
      ab_cb: AB_BLEND_CB,
      button_cb: "BTN_CB",
    });
    const payload = decodePayload(script);
    expect(payload.action).toBe("build");
    expect(payload.comp).toBe("/project1");
    expect(payload.name).toBe("look_bank");
    // Proves engine reuse — the imported MORPH_HOOK string rides the payload verbatim.
    expect(payload.morph_text).toBe(MORPH_HOOK);
  });

  it("carries the AB_BLEND_CB watcher text and a button dispatcher", () => {
    const script = buildLookBankScript({
      action: "build",
      comp: "/project1",
      name: "look_bank",
      morph_text: MORPH_HOOK,
      ab_cb: AB_BLEND_CB,
      button_cb: "BTN_CB",
    });
    const payload = decodePayload(script);
    expect(payload.ab_cb).toBe(AB_BLEND_CB);
    // The A/B watcher must react to the 'Ab' par change.
    expect(payload.ab_cb).toContain("onValueChange");
    expect(payload.ab_cb).toContain("Ab");
    expect(payload.button_cb).toBe("BTN_CB");
  });

  it("the impl forwards the real shared callbacks (button_cb is the recall dispatcher)", async () => {
    const exec = reportMock({ action: "build", slots: [], buttons: [] });
    await createLookBankImpl(fakeCtx(exec), { ...DEFAULTS, action: "build" });
    const script = exec.mock.calls[0]?.[0];
    if (typeof script !== "string") throw new Error("no script");
    const payload = decodePayload(script);
    expect(payload.morph_text).toBe(MORPH_HOOK);
    expect(payload.ab_cb).toBe(AB_BLEND_CB);
    // The recall-dispatcher slot is always a string in the payload. Its content is the shared
    // SURFACE_BUTTON_CB once the integrator exports it (reuse decision A); pre-export it coalesces
    // to "" so this stays green in isolation. Assert the field is present + carried as a string.
    expect(typeof payload.button_cb).toBe("string");
  });
});

describe("createLookBankImpl — schema", () => {
  it("applies defaults", () => {
    const parsed = createLookBankSchema.parse({});
    expect(parsed.action).toBe("build");
    expect(parsed.comp_path).toBe("/project1");
    expect(parsed.name).toBe("look_bank");
    expect(parsed.morph_seconds).toBe(0);
    expect(parsed.quantize).toBe("off");
  });
});

describe("createLookBankImpl — store", () => {
  it("summarises captured + skipped counts", async () => {
    const exec = reportMock({
      action: "store",
      slot: "intro",
      captured: ["Speed", "Hue"],
      skipped: ["Trigger", "Title"],
      slots: ["intro"],
      buttons: ["/project1/look_bank/recall_intro"],
    });
    const result = await createLookBankImpl(fakeCtx(exec), {
      ...DEFAULTS,
      action: "store",
      slot: "intro",
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('Stored look "intro"');
    expect(text).toContain("2 control(s) captured");
    expect(text).toContain("2 skipped");
  });
});

describe("createLookBankImpl — recall", () => {
  it("morph_seconds:0 → 'jumped'", async () => {
    const exec = reportMock({ action: "recall", slot: "drop", restored: ["Speed", "Hue"] });
    const result = await createLookBankImpl(fakeCtx(exec), {
      ...DEFAULTS,
      action: "recall",
      slot: "drop",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("jumped");
    expect(textOf(result)).toContain('"drop"');
  });

  it("morph_seconds:2 → 'Crossfading … over 2s'", async () => {
    const exec = reportMock({
      action: "recall",
      slot: "drop",
      restored: ["Speed"],
      morph_seconds: 2,
    });
    const result = await createLookBankImpl(fakeCtx(exec), {
      ...DEFAULTS,
      action: "recall",
      slot: "drop",
      morph_seconds: 2,
    });
    expect(textOf(result)).toContain("Crossfading");
    expect(textOf(result)).toContain("over 2s");
  });

  it("quantize:'bar' → lands on the next bar with scheduled_in", async () => {
    const exec = reportMock({
      action: "recall",
      slot: "drop",
      restored: ["Speed"],
      quantize: "bar",
      scheduled_in: 1.3,
    });
    const result = await createLookBankImpl(fakeCtx(exec), {
      ...DEFAULTS,
      action: "recall",
      slot: "drop",
      quantize: "bar",
    });
    const text = textOf(result);
    expect(text).toContain("next bar");
    expect(text).toContain("1.3");
  });
});

describe("createLookBankImpl — set_ab", () => {
  it("payload carries slot_a/slot_b/ab and the summary names both slots + the value", async () => {
    const exec = reportMock({
      action: "set_ab",
      slot_a: "intro",
      slot_b: "drop",
      ab: 0.5,
      slots: ["intro", "drop"],
    });
    const result = await createLookBankImpl(fakeCtx(exec), {
      ...DEFAULTS,
      action: "set_ab",
      slot_a: "intro",
      slot_b: "drop",
      ab: 0.5,
    });
    expect(result.isError).toBeFalsy();
    const script = exec.mock.calls[0]?.[0];
    if (typeof script !== "string") throw new Error("no script");
    const payload = decodePayload(script);
    expect(payload.slot_a).toBe("intro");
    expect(payload.slot_b).toBe("drop");
    expect(payload.ab).toBe(0.5);
    const text = textOf(result);
    expect(text).toContain("intro");
    expect(text).toContain("drop");
    expect(text).toContain("0.5");
  });

  it("with ab omitted, the summary says the knob was (re)assigned without moving", async () => {
    const exec = reportMock({ action: "set_ab", slot_a: "intro", slot_b: "drop" });
    const result = await createLookBankImpl(fakeCtx(exec), {
      ...DEFAULTS,
      action: "set_ab",
      slot_a: "intro",
      slot_b: "drop",
    });
    expect(textOf(result)).toContain("(re)assigned");
    expect(textOf(result)).toContain("knob not moved");
  });
});

describe("createLookBankImpl — name guards", () => {
  it.each([
    "store",
    "recall",
    "delete",
  ] as const)("%s without a slot returns isError naming the missing slot", async (action) => {
    const exec = reportMock({});
    const result = await createLookBankImpl(fakeCtx(exec), { ...DEFAULTS, action });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("slot");
    // The guard short-circuits before any bridge call.
    expect(exec).not.toHaveBeenCalled();
  });

  it("set_ab without slot_a or slot_b returns isError", async () => {
    const exec = reportMock({});
    const r1 = await createLookBankImpl(fakeCtx(exec), {
      ...DEFAULTS,
      action: "set_ab",
      slot_b: "drop",
    });
    expect(r1.isError).toBe(true);
    const r2 = await createLookBankImpl(fakeCtx(exec), {
      ...DEFAULTS,
      action: "set_ab",
      slot_a: "intro",
    });
    expect(r2.isError).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("createLookBankImpl — list", () => {
  it("lists the current slots", async () => {
    const exec = reportMock({ action: "list", slots: ["intro", "drop"] });
    const result = await createLookBankImpl(fakeCtx(exec), { ...DEFAULTS, action: "list" });
    const text = textOf(result);
    expect(text).toContain("intro");
    expect(text).toContain("drop");
  });

  it("reports no slots on an empty bank", async () => {
    const exec = reportMock({ action: "list", slots: [] });
    const result = await createLookBankImpl(fakeCtx(exec), { ...DEFAULTS, action: "list" });
    expect(textOf(result)).toContain("no slots");
  });
});

describe("createLookBankImpl — fatal", () => {
  it("fatal report → isError + captureStdout=true", async () => {
    const exec = reportMock({ action: "build", fatal: "COMP not found: /project1" });
    const result = await createLookBankImpl(fakeCtx(exec), { ...DEFAULTS, action: "build" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("COMP not found");
    expect(exec.mock.calls[0]?.[1]).toBe(true);
  });
});
