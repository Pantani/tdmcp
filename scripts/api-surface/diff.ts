// Backward-compatibility differ for the pinned tool API surface
// (docs/reference/API_STABILITY.md). The question it answers for every tool is:
// "does the new schema still accept everything the old schema accepted?"
//
// It fails closed: a JSON Schema keyword it does not understand counts as a
// break, because a false alarm costs one acknowledgement and a miss ships a break.
import { createHash } from "node:crypto";

export type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | false;
  prefixItems?: JsonSchema[];
  propertyNames?: JsonSchema;
  default?: unknown;
  [keyword: string]: unknown;
};

export interface ToolSnapshot {
  schema: JsonSchema;
  /** Refinements and transforms JSON Schema cannot show, as source text by field path. */
  checks: Record<string, string[]>;
  deprecated: boolean;
}

export interface ContextField {
  optional: boolean;
  type: string;
}

export interface ApiSurface {
  tools: Record<string, ToolSnapshot>;
  toolContext: { heritage: string[]; fields: Record<string, ContextField> };
}

export interface Finding {
  path: string;
  kind: string;
  was?: unknown;
  now?: unknown;
}

export interface ApiBreak extends Finding {
  scope: "tool" | "context";
  name: string;
  /** Stable identifier an acknowledgement refers to. Pins the exact change, not just the field. */
  id: string;
}

export interface Comparison {
  breaks: ApiBreak[];
  notices: string[];
}

export interface CompareOptions {
  baselineVersion?: string;
  packageVersion?: string;
}

/** Keywords that carry no acceptance constraint. */
const META_KEYWORDS = new Set([
  "description",
  "title",
  "$schema",
  "$defs",
  "definitions",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
const NUMERIC_BOUNDS = ["minimum", "exclusiveMinimum", "maximum", "exclusiveMaximum"];
const SIZE_BOUNDS: Array<[string, 1 | -1]> = [
  ["minLength", 1],
  ["minItems", 1],
  ["minProperties", 1],
  ["maxLength", -1],
  ["maxItems", -1],
  ["maxProperties", -1],
];
const EXACT_CONSTRAINTS = ["pattern", "format", "contentEncoding", "multipleOf"];
/** Everything `covers` reasons about. A constraint outside this list fails closed. */
const UNDERSTOOD_KEYWORDS = new Set([
  ...META_KEYWORDS,
  ...NUMERIC_BOUNDS,
  ...SIZE_BOUNDS.map(([keyword]) => keyword),
  ...EXACT_CONSTRAINTS,
  "$ref",
  "type",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "propertyNames",
]);
const MAX_DEPTH = 40;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const has = (object: object, key: string): boolean => Object.hasOwn(object, key);

interface Walk {
  oldRoot: JsonSchema;
  newRoot: JsonSchema;
  /** $ref pairs already being compared, so recursive schemas terminate. */
  refPairs: Set<string>;
}

function resolveRef(node: JsonSchema, root: JsonSchema): JsonSchema {
  const seen = new Set<string>();
  let current = node;
  while (current.$ref) {
    if (seen.has(current.$ref)) return {};
    seen.add(current.$ref);
    let target: unknown = root;
    for (const part of current.$ref.replace(/^#\/?/, "").split("/").filter(Boolean)) {
      target = (target as Record<string, unknown> | undefined)?.[part];
    }
    const { $ref: _ref, ...rest } = current;
    current = { ...(target as JsonSchema | undefined), ...rest };
  }
  return current;
}

function isUnconstrained(node: JsonSchema): boolean {
  return Object.keys(node).every((key) => META_KEYWORDS.has(key));
}

function constraints(node: JsonSchema): JsonSchema {
  return Object.fromEntries(Object.entries(node).filter(([key]) => !META_KEYWORDS.has(key)));
}

function variantsOf(node: JsonSchema): JsonSchema[] | undefined {
  return node.anyOf ?? node.oneOf;
}

function enumOf(node: JsonSchema): unknown[] | undefined {
  if (has(node, "const")) return [node.const];
  return Array.isArray(node.enum) ? node.enum : undefined;
}

function typesOf(node: JsonSchema): string[] | undefined {
  if (node.type) return ([] as string[]).concat(node.type);
  const values = enumOf(node);
  if (!values) return undefined;
  return [...new Set(values.map((value) => (value === null ? "null" : typeof value)))];
}

/**
 * A tuple without a rest element has a fixed length whether or not the serialiser
 * spells it out, and Zod versions differ on that. A loosened tuple still shows up,
 * because the new side then declares a lower `minItems` or a rest element.
 */
function normalizeTuple(node: JsonSchema): JsonSchema {
  if (!node.prefixItems || node.items) return node;
  const length = node.prefixItems.length;
  return { minItems: length, maxItems: length, ...node };
}

/** Rewrite integer exclusive bounds as inclusive and drop Zod's safe-integer limits. */
function normalizeInteger(node: JsonSchema): JsonSchema {
  if (([] as string[]).concat(node.type ?? []).join() !== "integer") return node;
  const out = { ...node };
  if (typeof out.exclusiveMinimum === "number") {
    out.minimum = Math.max((out.minimum as number) ?? -Infinity, out.exclusiveMinimum + 1);
    delete out.exclusiveMinimum;
  }
  if (typeof out.exclusiveMaximum === "number") {
    out.maximum = Math.min((out.maximum as number) ?? Infinity, out.exclusiveMaximum - 1);
    delete out.exclusiveMaximum;
  }
  if ((out.maximum as number) >= Number.MAX_SAFE_INTEGER) delete out.maximum;
  if ((out.minimum as number) <= Number.MIN_SAFE_INTEGER) delete out.minimum;
  return out;
}

interface Bound {
  value: number;
  exclusive: boolean;
}

function effectiveBound(node: JsonSchema, side: "minimum" | "maximum"): Bound | undefined {
  const exclusiveKey = side === "minimum" ? "exclusiveMinimum" : "exclusiveMaximum";
  const inclusive = node[side];
  const exclusive = node[exclusiveKey];
  const candidates: Bound[] = [];
  if (typeof inclusive === "number") candidates.push({ value: inclusive, exclusive: false });
  if (typeof exclusive === "number") candidates.push({ value: exclusive, exclusive: true });
  const direction = side === "minimum" ? 1 : -1;
  return candidates.sort(
    (a, b) => (b.value - a.value) * direction || Number(b.exclusive) - Number(a.exclusive),
  )[0];
}

function boundTightened(
  was: Bound | undefined,
  now: Bound | undefined,
  direction: 1 | -1,
): boolean {
  if (!now) return false;
  if (!was) return true;
  const delta = (now.value - was.value) * direction;
  return delta > 0 || (delta === 0 && now.exclusive && !was.exclusive);
}

function coverNumericBounds(o: JsonSchema, n: JsonSchema, path: string): Finding[] {
  const out: Finding[] = [];
  for (const [side, direction] of [
    ["minimum", 1],
    ["maximum", -1],
  ] as const) {
    const was = effectiveBound(o, side);
    const now = effectiveBound(n, side);
    if (boundTightened(was, now, direction)) {
      out.push({ path, kind: `bound-tightened:${side}`, was, now });
    }
  }
  return out;
}

function coverSizeBounds(o: JsonSchema, n: JsonSchema, path: string): Finding[] {
  const out: Finding[] = [];
  for (const [keyword, direction] of SIZE_BOUNDS) {
    const now = n[keyword];
    const was = o[keyword];
    if (typeof now !== "number" || now === was) continue;
    if (typeof was !== "number" || (now - was) * direction > 0) {
      out.push({ path, kind: `bound-tightened:${keyword}`, was, now });
    }
  }
  return out;
}

/** Zod labels some string checks as a `format`, but `pattern` is the actual constraint. */
const PATTERN_LABEL_FORMATS = new Set([
  "starts_with",
  "ends_with",
  "includes",
  "regex",
  "lowercase",
  "uppercase",
]);

function constrainingValue(node: JsonSchema, keyword: string): unknown {
  const value = node[keyword];
  const isLabel = keyword === "format" && node.pattern !== undefined;
  return isLabel && PATTERN_LABEL_FORMATS.has(String(value)) ? undefined : value;
}

function coverExactConstraints(o: JsonSchema, n: JsonSchema, path: string): Finding[] {
  return EXACT_CONSTRAINTS.flatMap((keyword) => {
    const was = constrainingValue(o, keyword);
    const now = constrainingValue(n, keyword);
    if (now === undefined || now === was) return [];
    return [{ path, kind: `constraint-changed:${keyword}`, was, now }];
  });
}

function coverUnknownKeywords(o: JsonSchema, n: JsonSchema, path: string): Finding[] {
  return Object.keys(n)
    .filter((keyword) => !UNDERSTOOD_KEYWORDS.has(keyword) && !same(o[keyword], n[keyword]))
    .map((keyword) => ({
      path,
      kind: `unsupported-keyword:${keyword}`,
      was: o[keyword],
      now: n[keyword],
    }));
}

function coverEnum(o: JsonSchema, newValues: unknown[], path: string): Finding[] {
  const oldValues = enumOf(o);
  if (!oldValues) {
    return [{ path, kind: "tightened-to-enum", was: constraints(o), now: newValues }];
  }
  const removed = oldValues.filter((value) => !newValues.some((other) => same(other, value)));
  return removed.length
    ? [{ path, kind: "enum-values-removed", was: removed, now: newValues }]
    : [];
}

function coverTypes(o: JsonSchema, n: JsonSchema, path: string): Finding[] {
  const oldTypes = typesOf(o);
  const newTypes = typesOf(n);
  if (!newTypes) return [];
  if (!oldTypes) return [{ path, kind: "type-added", now: newTypes }];
  const lost = oldTypes.filter(
    (type) => !(newTypes.includes(type) || (type === "integer" && newTypes.includes("number"))),
  );
  return lost.length ? [{ path, kind: "type-changed", was: oldTypes, now: newTypes }] : [];
}

function coverProperties(
  o: JsonSchema,
  n: JsonSchema,
  path: string,
  walk: Walk,
  depth: number,
): Finding[] {
  const out: Finding[] = [];
  const oldProps = o.properties ?? {};
  const newProps = n.properties ?? {};
  const oldRequired = new Set(o.required ?? []);
  const newRequired = new Set(n.required ?? []);
  const open = n.additionalProperties;
  for (const key of Object.keys(oldProps)) {
    const field = `${path}.${key}`;
    const oldField = oldProps[key] as JsonSchema;
    const newField = newProps[key];
    if (newField) {
      out.push(...covers(oldField, newField, field, walk, depth + 1));
    } else if (open && typeof open === "object") {
      // A record still accepting the key is not a removal.
      out.push(...covers(oldField, open, field, walk, depth + 1));
    } else {
      out.push({ path: field, kind: "field-removed", was: oldRequired.has(key) });
    }
    if (newRequired.has(key) && !oldRequired.has(key)) {
      out.push({ path: field, kind: "optional-became-required" });
    }
  }
  for (const key of newRequired) {
    if (!has(oldProps, key) && !oldRequired.has(key)) {
      out.push({ path: `${path}.${key}`, kind: "new-required-field" });
    }
  }
  return out;
}

function coverAdditionalProperties(
  o: JsonSchema,
  n: JsonSchema,
  path: string,
  walk: Walk,
  depth: number,
): Finding[] {
  const was = o.additionalProperties;
  const now = n.additionalProperties;
  if (now === false && was !== false && typesOf(o)?.includes("object")) {
    return [{ path, kind: "object-became-strict" }];
  }
  if (was === undefined || was === false) return [];
  if (now === undefined && n.properties && !o.properties) {
    return [{ path, kind: "additional-properties-closed" }];
  }
  if (typeof was === "object" && now && typeof now === "object") {
    return covers(was, now, `${path}{}`, walk, depth + 1);
  }
  return [];
}

function coverPropertyNames(
  o: JsonSchema,
  n: JsonSchema,
  path: string,
  walk: Walk,
  depth: number,
): Finding[] {
  if (!n.propertyNames) return [];
  // An object key is always a string, so "no propertyNames" means "any string".
  const was = o.propertyNames ?? { type: "string" };
  return covers(was, n.propertyNames, `${path}{key}`, walk, depth + 1);
}

function coverArray(
  o: JsonSchema,
  n: JsonSchema,
  path: string,
  walk: Walk,
  depth: number,
): Finding[] {
  const out: Finding[] = [];
  // `items: false` closes a tuple. Opening one is a widening, so there is nothing to compare.
  if (n.items && o.items !== false) {
    out.push(...covers(o.items ?? {}, n.items, `${path}[]`, walk, depth + 1));
  }
  if (o.prefixItems || n.prefixItems) {
    const was = o.prefixItems ?? [];
    const now = n.prefixItems ?? [];
    if (was.length !== now.length) {
      out.push({ path, kind: "tuple-arity-changed", was: was.length, now: now.length });
    }
    was.forEach((schema, index) => {
      const next = now[index];
      if (next) out.push(...covers(schema, next, `${path}[${index}]`, walk, depth + 1));
    });
  }
  return out;
}

function coverUnionTarget(
  o: JsonSchema,
  newVariants: JsonSchema[],
  path: string,
  walk: Walk,
  depth: number,
): Finding[] {
  const attempts = newVariants.map((variant) => covers(o, variant, path, walk, depth + 1));
  // Report the closest variant so the message names the real tightening.
  const score = (findings: Finding[]) =>
    findings.length +
    (findings.some((item) => item.kind === "type-changed" && item.path === path) ? 1000 : 0);
  return attempts.sort((a, b) => score(a) - score(b))[0] ?? [];
}

/** Findings where `newSchema` rejects something `oldSchema` accepted. Empty means compatible. */
function covers(
  oldSchema: JsonSchema,
  newSchema: JsonSchema,
  path: string,
  walk: Walk,
  depth: number,
): Finding[] {
  if (depth > MAX_DEPTH) return [{ path, kind: "schema-too-deep" }];
  if (oldSchema.$ref && newSchema.$ref) {
    const pair = `${oldSchema.$ref}|${newSchema.$ref}`;
    if (walk.refPairs.has(pair)) return [];
    walk.refPairs.add(pair);
  }
  const resolvedOld = resolveRef(oldSchema, walk.oldRoot);
  const resolvedNew = resolveRef(newSchema, walk.newRoot);
  if (isUnconstrained(resolvedNew)) return [];
  if (isUnconstrained(resolvedOld)) {
    return [{ path, kind: "tightened-from-any", now: constraints(resolvedNew) }];
  }
  const oldVariants = variantsOf(resolvedOld);
  if (oldVariants) {
    return oldVariants.flatMap((variant) => covers(variant, resolvedNew, path, walk, depth + 1));
  }
  const newVariants = variantsOf(resolvedNew);
  if (newVariants) return coverUnionTarget(resolvedOld, newVariants, path, walk, depth);

  const o = normalizeTuple(normalizeInteger(resolvedOld));
  const n = normalizeTuple(normalizeInteger(resolvedNew));
  const newValues = enumOf(n);
  if (newValues) return coverEnum(o, newValues, path);
  const typeFindings = coverTypes(o, n, path);
  if (typeFindings.some((item) => item.kind === "type-changed")) return typeFindings;
  return [
    ...typeFindings,
    ...coverNumericBounds(o, n, path),
    ...coverSizeBounds(o, n, path),
    ...coverExactConstraints(o, n, path),
    ...coverUnknownKeywords(o, n, path),
    ...coverProperties(o, n, path, walk, depth),
    ...coverAdditionalProperties(o, n, path, walk, depth),
    ...coverPropertyNames(o, n, path, walk, depth),
    ...coverArray(o, n, path, walk, depth),
  ];
}

/** Schema-level findings only: every input the old schema accepted, the new one must accept. */
export function compareSchemas(oldSchema: JsonSchema, newSchema: JsonSchema): Finding[] {
  const walk: Walk = { oldRoot: oldSchema, newRoot: newSchema, refPairs: new Set() };
  return covers(oldSchema, newSchema, "", walk, 0);
}

interface DefaultChange {
  path: string;
  was: unknown;
  now: unknown;
}

function collectDefaultChanges(
  oldNode: JsonSchema,
  newNode: JsonSchema,
  path: string,
  walk: Walk,
  acc: DefaultChange[],
  depth = 0,
): void {
  if (depth > MAX_DEPTH) return;
  const o = resolveRef(oldNode, walk.oldRoot);
  const n = resolveRef(newNode, walk.newRoot);
  if (has(o, "default") && !same(o.default, n.default)) {
    acc.push({ path, was: o.default, now: n.default });
  }
  for (const [key, value] of Object.entries(o.properties ?? {})) {
    const next = n.properties?.[key];
    if (next) collectDefaultChanges(value, next, `${path}.${key}`, walk, acc, depth + 1);
  }
  if (o.items && n.items)
    collectDefaultChanges(o.items, n.items, `${path}[]`, walk, acc, depth + 1);
}

const PATH_TOKEN = /\.[^.[\]|{}]+|\[\]|\[\d+\]|\|\*|\{\}|\{key\}/g;

function childrenFor(node: JsonSchema, token: string): JsonSchema[] | "new-field" {
  if (token === "[]") return node.items ? [node.items] : [];
  if (token === "{}") {
    return typeof node.additionalProperties === "object" ? [node.additionalProperties] : [];
  }
  if (token === "{key}") return node.propertyNames ? [node.propertyNames] : [];
  if (token === "|*") return variantsOf(node) ?? [node];
  if (token.startsWith("[")) {
    const item = node.prefixItems?.[Number(token.slice(1, -1))];
    return item ? [item] : [];
  }
  const child = node.properties?.[token.slice(1)];
  if (child) return [child];
  return node.properties ? "new-field" : [];
}

/**
 * Whether a check's path names a field the old schema already had. A refinement on
 * a brand-new field is additive; anything uncertain counts as existing (fail closed).
 */
function fieldExisted(schema: JsonSchema, path: string): boolean {
  const tokens = path.match(PATH_TOKEN) ?? [];
  const visit = (node: JsonSchema, index: number): boolean => {
    const resolved = resolveRef(node, schema);
    const token = tokens[index];
    if (token === undefined) return true;
    const variants = token === "|*" ? undefined : variantsOf(resolved);
    if (variants) return variants.some((variant) => visit(variant, index));
    const children = childrenFor(resolved, token);
    if (children === "new-field") return false;
    if (children.length === 0) return true;
    return children.some((child) => visit(child, index + 1));
  };
  return visit(schema, 0);
}

function compareChecks(oldTool: ToolSnapshot, newTool: ToolSnapshot): Finding[] {
  const out: Finding[] = [];
  for (const [path, entries] of Object.entries(newTool.checks)) {
    const before = oldTool.checks[path] ?? [];
    const added = entries.filter((entry) => !before.includes(entry));
    if (added.length === 0 || !fieldExisted(oldTool.schema, path)) continue;
    for (const now of added) {
      const kind = now.startsWith("transform:") ? "transform-changed" : "refinement-added";
      out.push({ path, kind, now });
    }
  }
  return out;
}

export function breakId(scope: ApiBreak["scope"], name: string, finding: Finding): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ was: finding.was, now: finding.now }))
    .digest("hex")
    .slice(0, 8);
  return `${scope}:${name}|${finding.path}|${finding.kind}|${digest}`;
}

function toBreak(scope: ApiBreak["scope"], name: string, finding: Finding): ApiBreak {
  return { ...finding, scope, name, id: breakId(scope, name, finding) };
}

function compareToolContext(
  oldContext: ApiSurface["toolContext"],
  newContext: ApiSurface["toolContext"],
): { findings: Finding[]; added: string[] } {
  const findings: Finding[] = [];
  const added: string[] = [];
  if (!same(oldContext.heritage, newContext.heritage)) {
    findings.push({
      path: "",
      kind: "heritage-changed",
      was: oldContext.heritage,
      now: newContext.heritage,
    });
  }
  for (const [field, was] of Object.entries(oldContext.fields)) {
    const path = `.${field}`;
    const now = has(newContext.fields, field) ? newContext.fields[field] : undefined;
    if (!now) {
      findings.push({ path, kind: "field-removed", was: was.type });
      continue;
    }
    if (was.type !== now.type) {
      findings.push({ path, kind: "type-changed", was: was.type, now: now.type });
    }
    if (was.optional !== now.optional) {
      findings.push({
        path,
        kind: was.optional ? "optional-became-required" : "required-became-optional",
      });
    }
  }
  for (const [field, now] of Object.entries(newContext.fields)) {
    if (has(oldContext.fields, field)) continue;
    if (now.optional) added.push(field);
    else findings.push({ path: `.${field}`, kind: "required-field-added", now: now.type });
  }
  return { findings, added };
}

function minorLine(version: string | undefined): string | undefined {
  return version?.split(".").slice(0, 2).join(".");
}

/** A deprecated tool may go in a later minor, never in a patch of the minor that warned. */
function removedInSameMinor(options: CompareOptions): boolean {
  const { baselineVersion, packageVersion } = options;
  return (
    baselineVersion !== undefined &&
    packageVersion !== undefined &&
    baselineVersion !== packageVersion &&
    minorLine(baselineVersion) === minorLine(packageVersion)
  );
}

function compareTools(
  base: ApiSurface,
  current: ApiSurface,
  options: CompareOptions,
  breaks: ApiBreak[],
  notices: string[],
): void {
  for (const [name, oldTool] of Object.entries(base.tools)) {
    const newTool = has(current.tools, name) ? current.tools[name] : undefined;
    if (!newTool) {
      if (!oldTool.deprecated) {
        breaks.push(toBreak("tool", name, { path: "", kind: "tool-removed" }));
      } else if (removedInSameMinor(options)) {
        breaks.push(toBreak("tool", name, { path: "", kind: "deprecated-tool-removed-too-early" }));
      } else {
        notices.push(`deprecated tool removed: ${name} (must ship in a later minor than the warn)`);
      }
      continue;
    }
    const findings = [
      ...compareSchemas(oldTool.schema, newTool.schema),
      ...compareChecks(oldTool, newTool),
    ];
    for (const finding of findings) breaks.push(toBreak("tool", name, finding));
    const walk: Walk = {
      oldRoot: oldTool.schema,
      newRoot: newTool.schema,
      refPairs: new Set(),
    };
    const defaults: DefaultChange[] = [];
    collectDefaultChanges(oldTool.schema, newTool.schema, "", walk, defaults);
    for (const change of defaults) {
      notices.push(
        `default changed: ${name}${change.path} ${JSON.stringify(change.was)} -> ${JSON.stringify(change.now)}`,
      );
    }
  }
  for (const name of Object.keys(current.tools)) {
    if (!has(base.tools, name)) notices.push(`tool added: ${name}`);
  }
}

export function compareSurfaces(
  base: ApiSurface,
  current: ApiSurface,
  options: CompareOptions = {},
): Comparison {
  const breaks: ApiBreak[] = [];
  const notices: string[] = [];
  compareTools(base, current, options, breaks, notices);
  const context = compareToolContext(base.toolContext, current.toolContext);
  for (const finding of context.findings) breaks.push(toBreak("context", "ToolContext", finding));
  for (const field of context.added) notices.push(`ToolContext optional field added: ${field}`);
  const unique = new Map(breaks.map((item) => [item.id, item]));
  return { breaks: [...unique.values()], notices };
}

export interface Acknowledgement {
  id: string;
  reason: string;
}

export interface AckResolution {
  unacknowledged: ApiBreak[];
  acknowledged: Array<ApiBreak & { reason: string }>;
  /** Acks matching no current break: stale, or written for a different change. */
  stale: Acknowledgement[];
}

export function resolveAcknowledgements(
  breaks: ApiBreak[],
  acknowledgements: Acknowledgement[],
): AckResolution {
  const reasons = new Map(acknowledgements.map((ack) => [ack.id, ack.reason]));
  const ids = new Set(breaks.map((item) => item.id));
  return {
    unacknowledged: breaks.filter((item) => !reasons.has(item.id)),
    acknowledged: breaks.flatMap((item) => {
      const reason = reasons.get(item.id);
      return reason === undefined ? [] : [{ ...item, reason }];
    }),
    stale: acknowledgements.filter((ack) => !ids.has(ack.id)),
  };
}
