import { describe, expect, it } from "vitest";
import {
  type ApiSurface,
  compareSchemas,
  compareSurfaces,
  type JsonSchema,
  resolveAcknowledgements,
  type ToolSnapshot,
} from "../../scripts/api-surface/diff.js";

const obj = (
  properties: Record<string, JsonSchema>,
  required: string[] = [],
  extra: JsonSchema = {},
): JsonSchema => ({ type: "object", properties, required, ...extra });
const str: JsonSchema = { type: "string" };
const num: JsonSchema = { type: "number" };
const int: JsonSchema = { type: "integer" };

const kinds = (oldSchema: JsonSchema, newSchema: JsonSchema) =>
  compareSchemas(oldSchema, newSchema).map((finding) => finding.kind);

describe("compareSchemas: breaking changes", () => {
  const breaks: Array<[string, JsonSchema, JsonSchema, string]> = [
    ["field removed", obj({ a: str, b: str }), obj({ a: str }), "field-removed"],
    ["field renamed", obj({ a: str }, ["a"]), obj({ z: str }, ["z"]), "field-removed"],
    ["new required field", obj({ a: str }), obj({ a: str, b: str }, ["b"]), "new-required-field"],
    [
      "optional became required",
      obj({ a: str }),
      obj({ a: str }, ["a"]),
      "optional-became-required",
    ],
    [
      "enum value removed",
      obj({ a: { type: "string", enum: ["x", "y"] } }),
      obj({ a: { type: "string", enum: ["x"] } }),
      "enum-values-removed",
    ],
    ["string to enum", obj({ a: str }), obj({ a: { enum: ["x"] } }), "tightened-to-enum"],
    ["string to const", obj({ a: str }), obj({ a: { const: "x" } }), "tightened-to-enum"],
    ["type changed", obj({ a: str }), obj({ a: num }), "type-changed"],
    ["number to integer", obj({ a: num }), obj({ a: int }), "type-changed"],
    [
      "maximum lowered",
      obj({ a: { type: "number", maximum: 10 } }),
      obj({ a: { type: "number", maximum: 5 } }),
      "bound-tightened:maximum",
    ],
    [
      "maximum added",
      obj({ a: num }),
      obj({ a: { ...num, maximum: 5 } }),
      "bound-tightened:maximum",
    ],
    [
      "inclusive minimum became exclusive",
      obj({ a: { type: "number", minimum: 0 } }),
      obj({ a: { type: "number", exclusiveMinimum: 0 } }),
      "bound-tightened:minimum",
    ],
    [
      "minLength added",
      obj({ a: str }),
      obj({ a: { type: "string", minLength: 1 } }),
      "bound-tightened:minLength",
    ],
    [
      "maxItems added",
      obj({ a: { type: "array", items: str } }),
      obj({ a: { type: "array", items: str, maxItems: 64 } }),
      "bound-tightened:maxItems",
    ],
    [
      "pattern added",
      obj({ a: str }),
      obj({ a: { type: "string", pattern: "^x" } }),
      "constraint-changed:pattern",
    ],
    [
      "format added",
      obj({ a: str }),
      obj({ a: { type: "string", format: "email" } }),
      "constraint-changed:format",
    ],
    ["union variant removed", obj({ a: { anyOf: [str, num] } }), obj({ a: str }), "type-changed"],
    [
      "bound inside a union variant",
      obj({ a: { anyOf: [num, str] } }),
      obj({ a: { anyOf: [num, { type: "string", maxLength: 3 }] } }),
      "bound-tightened:maxLength",
    ],
    [
      "nested field removed",
      obj({ o: obj({ x: str }) }),
      obj({ o: { type: "object", properties: {} } }),
      "field-removed",
    ],
    [
      "nested new required field",
      obj({ o: obj({ x: str }) }),
      obj({ o: obj({ x: str, y: str }, ["y"]) }),
      "new-required-field",
    ],
    [
      "array item type",
      obj({ a: { type: "array", items: str } }),
      obj({ a: { type: "array", items: num } }),
      "type-changed",
    ],
    [
      "items constrained on an untyped array",
      obj({ a: { type: "array" } }),
      obj({ a: { type: "array", items: str } }),
      "tightened-from-any",
    ],
    ["any to string", obj({ a: {} }), obj({ a: str }), "tightened-from-any"],
    [
      "record closed",
      obj({ a: { type: "object", additionalProperties: {} } }),
      obj({ a: { type: "object", properties: {}, additionalProperties: false } }),
      "object-became-strict",
    ],
    [
      "object became strict",
      obj({ o: obj({ x: str }) }),
      obj({ o: obj({ x: str }, [], { additionalProperties: false }) }),
      "object-became-strict",
    ],
    [
      "record keys constrained",
      obj({ a: { type: "object", additionalProperties: str } }),
      obj({ a: { type: "object", additionalProperties: str, propertyNames: { enum: ["x"] } } }),
      "tightened-to-enum",
    ],
    [
      "tuple arity changed",
      obj({ a: { type: "array", prefixItems: [str, str] } }),
      obj({ a: { type: "array", prefixItems: [str] } }),
      "tuple-arity-changed",
    ],
    [
      "a real format is not treated as a pattern label",
      obj({ a: { type: "string", pattern: "^x" } }),
      obj({ a: { type: "string", pattern: "^x", format: "email" } }),
      "constraint-changed:format",
    ],
    [
      "tuple lost a trailing element",
      obj({ a: { type: "array", prefixItems: [str, str], minItems: 1, maxItems: 2 } }),
      obj({ a: { type: "array", prefixItems: [str], minItems: 1, maxItems: 1 } }),
      "tuple-arity-changed",
    ],
    [
      "unknown constraint fails closed",
      obj({ a: str }),
      obj({ a: { ...str, allOf: [{ pattern: "^x" }, { pattern: "y$" }] } }),
      "unsupported-keyword:allOf",
    ],
  ];

  it.each(breaks)("flags %s", (_name, oldSchema, newSchema, kind) => {
    expect(kinds(oldSchema, newSchema)).toContain(kind);
  });
});

describe("compareSchemas: compatible changes", () => {
  const compatible: Array<[string, JsonSchema, JsonSchema]> = [
    ["identical", obj({ a: str }, ["a"]), obj({ a: str }, ["a"])],
    ["optional field added", obj({ a: str }), obj({ a: str, b: str })],
    ["defaulted field added", obj({ a: str }), obj({ a: str, b: { ...num, default: 1 } })],
    ["required became optional", obj({ a: str }, ["a"]), obj({ a: str })],
    [
      "enum grew",
      obj({ a: { type: "string", enum: ["x"] } }),
      obj({ a: { type: "string", enum: ["x", "y"] } }),
    ],
    ["widened to a union", obj({ a: str }), obj({ a: { anyOf: [str, num] } })],
    ["became nullable", obj({ a: str }), obj({ a: { anyOf: [str, { type: "null" }] } })],
    [
      "maximum raised",
      obj({ a: { type: "number", maximum: 5 } }),
      obj({ a: { type: "number", maximum: 10 } }),
    ],
    ["bound dropped", obj({ a: { ...str, maxLength: 3 } }), obj({ a: str })],
    ["integer to number", obj({ a: int }), obj({ a: num })],
    ["constraint to any", obj({ a: str }), obj({ a: {} })],
    [
      "equivalent integer bound spelling",
      obj({ a: { type: "integer", exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER } }),
      obj({ a: { type: "integer", minimum: 1 } }),
    ],
    [
      "exclusive minimum became inclusive",
      obj({ a: { type: "number", exclusiveMinimum: 0 } }),
      obj({ a: { type: "number", minimum: 0 } }),
    ],
    [
      "strict object loosened",
      obj({ o: obj({ x: str }, [], { additionalProperties: false }) }),
      obj({ o: obj({ x: str }) }),
    ],
    [
      "fixed-length tuple whose length is now spelled out",
      obj({ a: { type: "array", prefixItems: [num, num] } }),
      obj({ a: { type: "array", prefixItems: [num, num], minItems: 2, maxItems: 2 } }),
    ],
    [
      "closed tuple spelled with items: false",
      obj({ a: { type: "array", prefixItems: [num, num] } }),
      obj({
        a: { type: "array", prefixItems: [num, num], items: false, minItems: 2, maxItems: 2 },
      }),
    ],
    [
      "closed tuple gained a rest element",
      obj({ a: { type: "array", prefixItems: [num], items: false } }),
      obj({ a: { type: "array", prefixItems: [num], items: num, minItems: 1 } }),
    ],
    [
      "pattern check newly labelled with a format",
      obj({ a: { type: "string", pattern: "^/.*" } }),
      obj({ a: { type: "string", pattern: "^/.*", format: "starts_with" } }),
    ],
    [
      "documentation only",
      obj({ a: { ...str, description: "old" } }),
      obj({ a: { ...str, description: "new", title: "A", examples: ["x"] } }),
    ],
    [
      "field moved into a record that still accepts it",
      obj({ o: obj({ x: str }) }),
      obj({ o: { type: "object", additionalProperties: str } }),
    ],
    [
      "unknown constraint unchanged",
      obj({ a: { ...str, allOf: [{ pattern: "^x" }] } }),
      obj({ a: { ...str, allOf: [{ pattern: "^x" }] } }),
    ],
    ["a field named like a keyword", obj({ description: str }), obj({ description: str })],
  ];

  it.each(compatible)("accepts %s", (_name, oldSchema, newSchema) => {
    expect(compareSchemas(oldSchema, newSchema)).toEqual([]);
  });

  it("terminates on recursive schemas", () => {
    const recursive: JsonSchema = {
      $ref: "#/$defs/node",
      $defs: { node: obj({ next: { $ref: "#/$defs/node" } }) },
    };
    expect(compareSchemas(recursive, recursive)).toEqual([]);
  });

  it("reports the path of a nested break", () => {
    const [finding] = compareSchemas(
      obj({ params: { type: "array", items: obj({ name: str }) } }),
      obj({ params: { type: "array", items: obj({ name: { ...str, maxLength: 8 } }) } }),
    );
    expect(finding).toMatchObject({
      path: ".params[].name",
      kind: "bound-tightened:maxLength",
      now: 8,
    });
  });
});

function tool(schema: JsonSchema, overrides: Partial<ToolSnapshot> = {}): ToolSnapshot {
  return { schema, checks: {}, deprecated: false, ...overrides };
}

function surface(
  tools: Record<string, ToolSnapshot>,
  fields: ApiSurface["toolContext"]["fields"] = {},
  heritage: string[] = [],
): ApiSurface {
  return { tools, toolContext: { heritage, fields } };
}

const breakKinds = (base: ApiSurface, current: ApiSurface) =>
  compareSurfaces(base, current).breaks.map((item) => item.kind);

describe("compareSurfaces: tools", () => {
  it("allows a new tool and notes it", () => {
    const { breaks, notices } = compareSurfaces(
      surface({ a: tool(obj({})) }),
      surface({ a: tool(obj({})), b: tool(obj({ x: str }, ["x"])) }),
    );
    expect(breaks).toEqual([]);
    expect(notices).toContain("tool added: b");
  });

  it("breaks when a tool that was never deprecated disappears", () => {
    expect(breakKinds(surface({ a: tool(obj({})) }), surface({}))).toEqual(["tool-removed"]);
  });

  describe("removing a deprecated tool", () => {
    const base = surface({ old: tool(obj({}), { deprecated: true }) });

    it("is only a note on the way to the next minor", () => {
      const result = compareSurfaces(base, surface({}), {
        baselineVersion: "0.14.0",
        packageVersion: "0.14.0",
      });
      expect(result.breaks).toEqual([]);
      expect(result.notices.join()).toContain("deprecated tool removed: old");
    });

    it("is allowed in a later minor", () => {
      const { breaks } = compareSurfaces(base, surface({}), {
        baselineVersion: "0.14.3",
        packageVersion: "0.15.0",
      });
      expect(breaks).toEqual([]);
    });

    it("breaks in a patch of the minor that warned", () => {
      const { breaks } = compareSurfaces(base, surface({}), {
        baselineVersion: "0.14.0",
        packageVersion: "0.14.1",
      });
      expect(breaks.map((item) => item.kind)).toEqual(["deprecated-tool-removed-too-early"]);
    });
  });

  it("notes a changed default without failing", () => {
    const { breaks, notices } = compareSurfaces(
      surface({ a: tool(obj({ n: { ...num, default: 1 } })) }),
      surface({ a: tool(obj({ n: { ...num, default: 2 } })) }),
    );
    expect(breaks).toEqual([]);
    expect(notices).toEqual(["default changed: a.n 1 -> 2"]);
  });

  describe("refinements JSON Schema cannot show", () => {
    const schema = obj({ a: str });

    it("breaks when an existing field gains one", () => {
      expect(
        breakKinds(
          surface({ t: tool(schema) }),
          surface({ t: tool(schema, { checks: { ".a": ["refine:(v) => v !== 'x'"] } }) }),
        ),
      ).toEqual(["refinement-added"]);
    });

    it("breaks when one is rewritten", () => {
      expect(
        breakKinds(
          surface({ t: tool(schema, { checks: { ".a": ["refine:(v) => v.length < 9"] } }) }),
          surface({ t: tool(schema, { checks: { ".a": ["refine:(v) => v.length < 3"] } }) }),
        ),
      ).toEqual(["refinement-added"]);
    });

    it("flags a changed transform separately", () => {
      expect(
        breakKinds(
          surface({ t: tool(schema) }),
          surface({ t: tool(schema, { checks: { ".a": ["transform:(v) => v.trim()"] } }) }),
        ),
      ).toEqual(["transform-changed"]);
    });

    it("allows removing one", () => {
      expect(
        breakKinds(
          surface({ t: tool(schema, { checks: { ".a": ["refine:(v) => v"] } }) }),
          surface({ t: tool(schema) }),
        ),
      ).toEqual([]);
    });

    it("allows one on a brand-new field", () => {
      expect(
        breakKinds(
          surface({ t: tool(obj({ a: str })) }),
          surface({
            t: tool(obj({ a: str, b: str }), { checks: { ".b": ["refine:(v) => v"] } }),
          }),
        ),
      ).toEqual([]);
    });

    it("allows one nested under a brand-new field", () => {
      expect(
        breakKinds(
          surface({ t: tool(obj({ a: str })) }),
          surface({
            t: tool(obj({ a: str, b: { type: "array", items: obj({ c: str }) } }), {
              checks: { ".b[].c": ["refine:(v) => v"] },
            }),
          }),
        ),
      ).toEqual([]);
    });

    it("breaks for a field inside an existing union member", () => {
      const union = obj({ op: { anyOf: [obj({ a: str }), obj({ b: str })] } });
      expect(
        breakKinds(
          surface({ t: tool(union) }),
          surface({ t: tool(union, { checks: { ".op|*.b": ["refine:(v) => v"] } }) }),
        ),
      ).toEqual(["refinement-added"]);
    });
  });
});

describe("compareSurfaces: ToolContext", () => {
  const required = { optional: false, type: "Logger" };
  const optional = { optional: true, type: "Vault" };

  it("allows a new optional field and notes it", () => {
    const { breaks, notices } = compareSurfaces(
      surface({}, { logger: required }),
      surface({}, { logger: required, vault: optional }),
    );
    expect(breaks).toEqual([]);
    expect(notices).toEqual(["ToolContext optional field added: vault"]);
  });

  it.each([
    ["removed", { logger: required }, {}, "field-removed"],
    ["required added", {}, { logger: required }, "required-field-added"],
    [
      "type changed",
      { logger: required },
      { logger: { optional: false, type: "OtherLogger" } },
      "type-changed",
    ],
    [
      "optional became required",
      { vault: optional },
      { vault: { optional: false, type: "Vault" } },
      "optional-became-required",
    ],
    [
      "required became optional",
      { logger: required },
      { logger: { optional: true, type: "Logger" } },
      "required-became-optional",
    ],
  ])("breaks when a field is %s", (_name, before, after, kind) => {
    const { breaks } = compareSurfaces(surface({}, before), surface({}, after));
    expect(breaks.map((item) => item.kind)).toEqual([kind]);
    expect(breaks[0]?.scope).toBe("context");
  });

  it("breaks when the interface gains a base type", () => {
    expect(breakKinds(surface({}), surface({}, {}, ["extends Base"]))).toEqual([
      "heritage-changed",
    ]);
  });
});

describe("acknowledgements", () => {
  const base = surface({ t: tool(obj({ a: { ...str, maxLength: 9 } })) });
  const current = surface({ t: tool(obj({ a: { ...str, maxLength: 3 } })) });
  const { breaks } = compareSurfaces(base, current);
  const id = breaks[0]?.id as string;

  it("ids name the tool, field and kind", () => {
    expect(id).toMatch(/^tool:t\|\.a\|bound-tightened:maxLength\|[0-9a-f]{8}$/);
  });

  it("clears a break with a matching acknowledgement", () => {
    const result = resolveAcknowledgements(breaks, [{ id, reason: "agreed in review" }]);
    expect(result.unacknowledged).toEqual([]);
    expect(result.acknowledged[0]).toMatchObject({ id, reason: "agreed in review" });
    expect(result.stale).toEqual([]);
  });

  it("does not stretch to a further tightening of the same field", () => {
    const tighter = surface({ t: tool(obj({ a: { ...str, maxLength: 1 } })) });
    const result = resolveAcknowledgements(compareSurfaces(base, tighter).breaks, [
      { id, reason: "agreed in review" },
    ]);
    expect(result.unacknowledged).toHaveLength(1);
    expect(result.stale.map((ack) => ack.id)).toEqual([id]);
  });

  it("reports an acknowledgement that matches nothing as stale", () => {
    const result = resolveAcknowledgements([], [{ id, reason: "agreed in review" }]);
    expect(result.stale.map((ack) => ack.id)).toEqual([id]);
  });

  it("reports each identical finding once", () => {
    const union = (variant: JsonSchema): JsonSchema =>
      obj({ a: { anyOf: [{ ...variant }, { ...variant, description: "same" }] } });
    const result = compareSurfaces(
      surface({ t: tool(union(str)) }),
      surface({ t: tool(obj({ a: num })) }),
    );
    expect(result.breaks).toHaveLength(1);
  });
});
