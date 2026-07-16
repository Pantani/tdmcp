/** Pure deterministic planner for annotation-aware TouchDesigner network layout. */

const HORIZONTAL_GAP = 200;
const VERTICAL_GAP = 140;
const MAX_HOSTS = 512;
const MAX_ANNOTATIONS = 64;
const MAX_TOUCHED = 1024;
const MAX_PATH = 1024;
const MAX_PADDING = 1000;
const MAX_COORDINATE = 1_000_000;
const MAX_SIZE = 1_000_000;

export interface AnnotationLayoutRect {
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnnotationLayoutInput extends AnnotationLayoutRect {
  enclosed_paths: readonly string[];
}

export interface DockedLayoutInput extends AnnotationLayoutRect {
  host_path: string;
}

export interface AnnotationLayoutEdge {
  from: string;
  to: string;
}

export interface AnnotationAwareLayoutInput {
  nodes: readonly AnnotationLayoutRect[];
  annotations: readonly AnnotationLayoutInput[];
  docked?: readonly DockedLayoutInput[];
  edges?: readonly AnnotationLayoutEdge[];
  include_docked?: boolean;
  resize_annotations?: boolean;
  annotation_padding?: number;
}

export interface PlannedBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlannedAnnotationBounds extends PlannedBounds {
  resized: boolean;
}

export interface AnnotationLayoutUnitPlan {
  id: string;
  kind: "annotation" | "node";
  layer: number;
  annotation_path?: string;
  host_paths: string[];
  docked_paths: string[];
  delta: [number, number];
  source_bounds: PlannedBounds;
  target_bounds: PlannedBounds;
}

export interface AnnotationAwareLayoutPlan {
  positions: Record<string, [number, number]>;
  annotation_bounds: Record<string, PlannedAnnotationBounds>;
  units: AnnotationLayoutUnitPlan[];
  collapsed_edges: AnnotationLayoutEdge[];
  counts: {
    units: number;
    hosts: number;
    docked: number;
    annotations: number;
    resized_annotations: number;
  };
}

export type AnnotationAwareLayoutErrorCode =
  | "invalid_layout_input"
  | "capacity_exceeded"
  | "duplicate_path"
  | "ambiguous_annotation_geometry"
  | "ambiguous_annotation_membership"
  | "unknown_annotation_member"
  | "unknown_docked_host";

export class AnnotationAwareLayoutError extends Error {
  readonly code: AnnotationAwareLayoutErrorCode;

  constructor(code: AnnotationAwareLayoutErrorCode, message: string) {
    super(message);
    this.name = "AnnotationAwareLayoutError";
    this.code = code;
  }
}

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface WorkingUnit {
  id: string;
  kind: "annotation" | "node";
  annotation?: AnnotationLayoutInput;
  annotationBounds?: Bounds;
  hosts: AnnotationLayoutRect[];
  docked: DockedLayoutInput[];
  bounds: Bounds;
}

interface PreparedInput {
  nodes: AnnotationLayoutRect[];
  annotations: AnnotationLayoutInput[];
  docked: DockedLayoutInput[];
  edges: AnnotationLayoutEdge[];
  includeDocked: boolean;
  resizeAnnotations: boolean;
  padding: number;
}

function fail(code: AnnotationAwareLayoutErrorCode, message: string): never {
  throw new AnnotationAwareLayoutError(code, message);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") && path.length <= MAX_PATH && !/[\0\r\n]/.test(path);
}

function validatePath(path: string, field: string): void {
  if (!isAbsolutePath(path)) fail("invalid_layout_input", `${field} must be an absolute path`);
}

function validateInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    fail("invalid_layout_input", `${field} must be a safe integer`);
  }
}

function validateRect(rect: AnnotationLayoutRect, field: string): void {
  validatePath(rect.path, `${field}.path`);
  validateInteger(rect.x, `${field}.x`);
  validateInteger(rect.y, `${field}.y`);
  validateInteger(rect.w, `${field}.w`);
  validateInteger(rect.h, `${field}.h`);
  if (rect.w <= 0 || rect.h <= 0) {
    fail("invalid_layout_input", `${field} width and height must be positive`);
  }
  if (Math.abs(rect.x) > MAX_COORDINATE || Math.abs(rect.y) > MAX_COORDINATE) {
    fail("invalid_layout_input", `${field} position exceeds the supported range`);
  }
  if (rect.w > MAX_SIZE || rect.h > MAX_SIZE) {
    fail("invalid_layout_input", `${field} size exceeds the supported range`);
  }
}

function validateCaps(input: AnnotationAwareLayoutInput): void {
  if (input.nodes.length > MAX_HOSTS || input.annotations.length > MAX_ANNOTATIONS) {
    fail("capacity_exceeded", "annotation-aware layout input exceeds node or annotation caps");
  }
  const dockedCount = (input.include_docked ?? true) ? (input.docked?.length ?? 0) : 0;
  const touched = input.nodes.length + input.annotations.length + dockedCount;
  if (touched > MAX_TOUCHED) {
    fail("capacity_exceeded", "annotation-aware layout input exceeds the touched-node cap");
  }
}

function validatePadding(value: number): void {
  validateInteger(value, "annotation_padding");
  if (value < 0 || value > MAX_PADDING) {
    fail("invalid_layout_input", `annotation_padding must be between 0 and ${MAX_PADDING}`);
  }
}

function reservePath(paths: Set<string>, path: string): void {
  if (paths.has(path)) fail("duplicate_path", `duplicate operator path: ${path}`);
  paths.add(path);
}

function validatePathsAndRects(input: PreparedInput): void {
  const paths = new Set<string>();
  input.nodes.forEach((node, index) => {
    validateRect(node, `nodes[${index}]`);
    reservePath(paths, node.path);
  });
  input.annotations.forEach((annotation, index) => {
    validateRect(annotation, `annotations[${index}]`);
    reservePath(paths, annotation.path);
    annotation.enclosed_paths.forEach((path, memberIndex) => {
      validatePath(path, `annotations[${index}].enclosed_paths[${memberIndex}]`);
    });
  });
  input.docked.forEach((node, index) => {
    validateRect(node, `docked[${index}]`);
    validatePath(node.host_path, `docked[${index}].host_path`);
    reservePath(paths, node.path);
  });
  input.edges.forEach((edge, index) => {
    validatePath(edge.from, `edges[${index}].from`);
    validatePath(edge.to, `edges[${index}].to`);
  });
}

function prepareInput(input: AnnotationAwareLayoutInput): PreparedInput {
  validateCaps(input);
  const includeDocked = input.include_docked ?? true;
  const prepared = {
    nodes: [...input.nodes],
    annotations: [...input.annotations],
    docked: includeDocked ? [...(input.docked ?? [])] : [],
    edges: [...(input.edges ?? [])],
    includeDocked,
    resizeAnnotations: input.resize_annotations ?? false,
    padding: input.annotation_padding ?? 80,
  };
  validatePadding(prepared.padding);
  validatePathsAndRects(prepared);
  return prepared;
}

function toBounds(rect: Pick<AnnotationLayoutRect, "x" | "y" | "w" | "h">): Bounds {
  return {
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.w,
    bottom: rect.y - rect.h,
  };
}

function toPlannedBounds(bounds: Bounds): PlannedBounds {
  return {
    x: bounds.left,
    y: bounds.top,
    w: bounds.right - bounds.left,
    h: bounds.top - bounds.bottom,
  };
}

function unionBounds(rectangles: readonly Bounds[]): Bounds {
  const first = rectangles[0];
  if (!first) fail("invalid_layout_input", "cannot compute empty layout bounds");
  return rectangles.slice(1).reduce(
    (bounds, rect) => ({
      left: Math.min(bounds.left, rect.left),
      top: Math.max(bounds.top, rect.top),
      right: Math.max(bounds.right, rect.right),
      bottom: Math.min(bounds.bottom, rect.bottom),
    }),
    { ...first },
  );
}

function padBounds(bounds: Bounds, padding: number): Bounds {
  return {
    left: bounds.left - padding,
    top: bounds.top + padding,
    right: bounds.right + padding,
    bottom: bounds.bottom - padding,
  };
}

function translateBounds(bounds: Bounds, dx: number, dy: number): Bounds {
  return {
    left: bounds.left + dx,
    top: bounds.top + dy,
    right: bounds.right + dx,
    bottom: bounds.bottom + dy,
  };
}

function hasPositiveAreaOverlap(left: Bounds, right: Bounds): boolean {
  const horizontal = Math.min(left.right, right.right) > Math.max(left.left, right.left);
  const vertical = Math.min(left.top, right.top) > Math.max(left.bottom, right.bottom);
  return horizontal && vertical;
}

function rejectAmbiguousAnnotationGeometry(annotations: readonly AnnotationLayoutInput[]): void {
  const ordered = [...annotations].sort((left, right) => compareText(left.path, right.path));
  ordered.forEach((annotation, index) => {
    for (const other of ordered.slice(index + 1)) {
      if (hasPositiveAreaOverlap(toBounds(annotation), toBounds(other))) {
        fail(
          "ambiguous_annotation_geometry",
          `annotation boxes overlap or nest: ${annotation.path}, ${other.path}`,
        );
      }
    }
  });
}

function annotationOwnership(
  annotations: readonly AnnotationLayoutInput[],
  nodesByPath: ReadonlyMap<string, AnnotationLayoutRect>,
): Map<string, string> {
  const ownerByPath = new Map<string, string>();
  for (const annotation of [...annotations].sort((a, b) => compareText(a.path, b.path))) {
    const local = new Set<string>();
    for (const path of annotation.enclosed_paths) {
      if (!nodesByPath.has(path)) {
        fail("unknown_annotation_member", `${annotation.path} references unknown host ${path}`);
      }
      if (local.has(path) || ownerByPath.has(path)) {
        fail("ambiguous_annotation_membership", `${path} belongs to multiple annotation entries`);
      }
      local.add(path);
      ownerByPath.set(path, annotation.path);
    }
  }
  return ownerByPath;
}

function dockedByHost(
  docked: readonly DockedLayoutInput[],
  nodesByPath: ReadonlyMap<string, AnnotationLayoutRect>,
): Map<string, DockedLayoutInput[]> {
  const result = new Map<string, DockedLayoutInput[]>();
  for (const child of docked) {
    if (!nodesByPath.has(child.host_path)) {
      fail("unknown_docked_host", `${child.path} references unknown host ${child.host_path}`);
    }
    const children = result.get(child.host_path) ?? [];
    children.push(child);
    result.set(child.host_path, children);
  }
  for (const children of result.values()) {
    children.sort((left, right) => compareText(left.path, right.path));
  }
  return result;
}

function childrenForHosts(
  hosts: readonly AnnotationLayoutRect[],
  byHost: ReadonlyMap<string, DockedLayoutInput[]>,
): DockedLayoutInput[] {
  return hosts.flatMap((host) => byHost.get(host.path) ?? []);
}

function annotationUnit(
  annotation: AnnotationLayoutInput,
  hosts: AnnotationLayoutRect[],
  docked: DockedLayoutInput[],
  resize: boolean,
  padding: number,
): WorkingUnit {
  const content = [...hosts, ...docked].map(toBounds);
  const shouldResize = resize && hosts.length > 0;
  const annotationBounds = shouldResize
    ? padBounds(unionBounds(content), padding)
    : toBounds(annotation);
  const bounds = unionBounds([annotationBounds, ...content]);
  return {
    id: `annotation:${annotation.path}`,
    kind: "annotation",
    annotation,
    annotationBounds,
    hosts,
    docked,
    bounds,
  };
}

function nodeUnit(host: AnnotationLayoutRect, docked: DockedLayoutInput[]): WorkingUnit {
  return {
    id: `node:${host.path}`,
    kind: "node",
    hosts: [host],
    docked,
    bounds: unionBounds([toBounds(host), ...docked.map(toBounds)]),
  };
}

function buildUnits(input: PreparedInput): WorkingUnit[] {
  rejectAmbiguousAnnotationGeometry(input.annotations);
  const nodesByPath = new Map(input.nodes.map((node) => [node.path, node]));
  const ownerByPath = annotationOwnership(input.annotations, nodesByPath);
  const children = dockedByHost(input.docked, nodesByPath);
  const includedChildren = input.includeDocked ? children : new Map<string, DockedLayoutInput[]>();
  const units = input.annotations.map((annotation) => {
    const hosts = annotation.enclosed_paths
      .map((path) => nodesByPath.get(path))
      .filter((node): node is AnnotationLayoutRect => node !== undefined)
      .sort((left, right) => compareText(left.path, right.path));
    return annotationUnit(
      annotation,
      hosts,
      childrenForHosts(hosts, includedChildren),
      input.resizeAnnotations,
      input.padding,
    );
  });
  for (const host of input.nodes) {
    if (!ownerByPath.has(host.path)) {
      units.push(nodeUnit(host, childrenForHosts([host], includedChildren)));
    }
  }
  return units.sort((left, right) => compareText(left.id, right.id));
}

function unitByHost(units: readonly WorkingUnit[]): Map<string, WorkingUnit> {
  const result = new Map<string, WorkingUnit>();
  for (const unit of units) {
    for (const host of unit.hosts) result.set(host.path, unit);
  }
  return result;
}

function collapseEdges(
  edges: readonly AnnotationLayoutEdge[],
  units: readonly WorkingUnit[],
): AnnotationLayoutEdge[] {
  const byHost = unitByHost(units);
  const unique = new Map<string, AnnotationLayoutEdge>();
  for (const edge of edges) {
    const from = byHost.get(edge.from);
    const to = byHost.get(edge.to);
    if (!from || !to || from.id === to.id) continue;
    const key = `${from.id}\0${to.id}`;
    unique.set(key, { from: from.id, to: to.id });
  }
  return [...unique.values()].sort(
    (left, right) => compareText(left.from, right.from) || compareText(left.to, right.to),
  );
}

function predecessors(edges: readonly AnnotationLayoutEdge[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    const values = result.get(edge.to) ?? [];
    values.push(edge.from);
    result.set(edge.to, values);
  }
  for (const values of result.values()) values.sort(compareText);
  return result;
}

function layersByLongestPath(
  units: readonly WorkingUnit[],
  edges: readonly AnnotationLayoutEdge[],
): Map<string, number> {
  const preds = predecessors(edges);
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const layer = Math.max(0, ...(preds.get(id) ?? []).map((pred) => depth(pred) + 1));
    visiting.delete(id);
    memo.set(id, layer);
    return layer;
  };
  for (const unit of units) depth(unit.id);
  return memo;
}

function unitsByLayer(
  units: readonly WorkingUnit[],
  layers: ReadonlyMap<string, number>,
): Map<number, WorkingUnit[]> {
  const result = new Map<number, WorkingUnit[]>();
  for (const unit of units) {
    const layer = layers.get(unit.id) ?? 0;
    const values = result.get(layer) ?? [];
    values.push(unit);
    result.set(layer, values);
  }
  for (const values of result.values())
    values.sort((left, right) => compareText(left.id, right.id));
  return result;
}

function addPositions(
  positions: Record<string, [number, number]>,
  rects: readonly AnnotationLayoutRect[],
  dx: number,
  dy: number,
): void {
  for (const rect of rects) positions[rect.path] = [rect.x + dx, rect.y + dy];
}

function placeUnit(
  unit: WorkingUnit,
  layer: number,
  targetLeft: number,
  targetTop: number,
  resizeAnnotations: boolean,
  positions: Record<string, [number, number]>,
  annotationBounds: Record<string, PlannedAnnotationBounds>,
): AnnotationLayoutUnitPlan {
  const dx = targetLeft - unit.bounds.left;
  const dy = targetTop - unit.bounds.top;
  addPositions(positions, unit.hosts, dx, dy);
  addPositions(positions, unit.docked, dx, dy);
  if (unit.annotation && unit.annotationBounds) {
    const bounds = translateBounds(unit.annotationBounds, dx, dy);
    positions[unit.annotation.path] = [bounds.left, bounds.top];
    annotationBounds[unit.annotation.path] = {
      ...toPlannedBounds(bounds),
      resized: resizeAnnotations && unit.hosts.length > 0,
    };
  }
  return {
    id: unit.id,
    kind: unit.kind,
    layer,
    ...(unit.annotation ? { annotation_path: unit.annotation.path } : {}),
    host_paths: unit.hosts.map((host) => host.path),
    docked_paths: unit.docked.map((child) => child.path),
    delta: [dx, dy],
    source_bounds: toPlannedBounds(unit.bounds),
    target_bounds: toPlannedBounds(translateBounds(unit.bounds, dx, dy)),
  };
}

function assertNoUnitOverlap(units: readonly AnnotationLayoutUnitPlan[]): void {
  units.forEach((unit, index) => {
    for (const other of units.slice(index + 1)) {
      if (hasPositiveAreaOverlap(toBounds(unit.target_bounds), toBounds(other.target_bounds))) {
        fail("invalid_layout_input", "planner produced overlapping layout units");
      }
    }
  });
}

function assertBoundedPosition(path: string, position: readonly number[]): void {
  if (position.some((value) => !Number.isSafeInteger(value) || Math.abs(value) > MAX_COORDINATE)) {
    fail("capacity_exceeded", `planned position exceeds the supported range: ${path}`);
  }
}

function assertBoundedBounds(path: string, bounds: PlannedBounds): void {
  assertBoundedPosition(path, [bounds.x, bounds.y]);
  if (bounds.w > MAX_SIZE || bounds.h > MAX_SIZE) {
    fail("capacity_exceeded", `planned bounds exceed the supported range: ${path}`);
  }
}

function assertBoundedPlan(
  positions: Readonly<Record<string, [number, number]>>,
  annotationBounds: Readonly<Record<string, PlannedAnnotationBounds>>,
  units: readonly AnnotationLayoutUnitPlan[],
): void {
  for (const [path, position] of Object.entries(positions)) {
    assertBoundedPosition(path, position);
  }
  for (const [path, bounds] of Object.entries(annotationBounds)) {
    assertBoundedBounds(path, bounds);
  }
  for (const unit of units) assertBoundedBounds(unit.id, unit.target_bounds);
}

function placeUnits(
  units: readonly WorkingUnit[],
  layers: ReadonlyMap<string, number>,
  resizeAnnotations: boolean,
): Pick<AnnotationAwareLayoutPlan, "positions" | "annotation_bounds" | "units"> {
  const grouped = unitsByLayer(units, layers);
  const positions: Record<string, [number, number]> = {};
  const annotationBounds: Record<string, PlannedAnnotationBounds> = {};
  const plans: AnnotationLayoutUnitPlan[] = [];
  let targetLeft = 0;
  for (const [layer, members] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    let targetTop = 0;
    const width = Math.max(...members.map((unit) => unit.bounds.right - unit.bounds.left));
    for (const unit of members) {
      plans.push(
        placeUnit(
          unit,
          layer,
          targetLeft,
          targetTop,
          resizeAnnotations,
          positions,
          annotationBounds,
        ),
      );
      targetTop -= unit.bounds.top - unit.bounds.bottom + VERTICAL_GAP;
    }
    targetLeft += width + HORIZONTAL_GAP;
  }
  assertBoundedPlan(positions, annotationBounds, plans);
  assertNoUnitOverlap(plans);
  return { positions, annotation_bounds: annotationBounds, units: plans };
}

/**
 * Build an exact, deterministic plan for one parent network. The function is
 * pure: it performs no TouchDesigner calls and mutates none of its inputs.
 */
export function planAnnotationAwareLayout(
  input: AnnotationAwareLayoutInput,
): AnnotationAwareLayoutPlan {
  const prepared = prepareInput(input);
  const units = buildUnits(prepared);
  const collapsedEdges = collapseEdges(prepared.edges, units);
  const layers = layersByLongestPath(units, collapsedEdges);
  const placed = placeUnits(units, layers, prepared.resizeAnnotations);
  return {
    ...placed,
    collapsed_edges: collapsedEdges,
    counts: {
      units: units.length,
      hosts: prepared.nodes.length,
      docked: prepared.includeDocked ? prepared.docked.length : 0,
      annotations: prepared.annotations.length,
      resized_annotations: Object.values(placed.annotation_bounds).filter(
        (bounds) => bounds.resized,
      ).length,
    },
  };
}
