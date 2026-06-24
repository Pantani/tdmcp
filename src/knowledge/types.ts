export interface OperatorParameter {
  name: string;
  label?: string;
  group?: string;
  page?: string;
  type?: string;
  dataType?: string;
  defaultValue?: unknown;
  minValue?: unknown;
  maxValue?: unknown;
  menuItems?: string[];
  menuLabels?: string[];
  description?: string;
}

export interface OperatorDoc {
  id?: string | null;
  name: string;
  displayName?: string;
  category?: string;
  subcategory?: string;
  version?: string;
  description?: string;
  summary?: string;
  usage?: string;
  tips?: string[];
  warnings?: string[];
  parameters?: OperatorParameter[];
  pythonExamples?: unknown[];
  codeExamples?: unknown[];
  expressions?: unknown[];
  commonInputs?: unknown;
  commonOutputs?: unknown;
  relatedOperators?: string[];
  workflowPatterns?: string[];
  keywords?: string[];
  tags?: string[];
}

export interface OperatorSummary {
  slug: string;
  name: string;
  displayName: string;
  category: string;
  subcategory: string;
  summary: string;
  keywords: string[];
}

export interface OperatorConnectionEntry {
  op: string;
  port?: string;
  reason?: string;
}

export interface OperatorWorkflowHit {
  patternId: string;
  patternName: string;
  category?: string;
  useCase?: string;
  workflow: string[];
  position: number;
  previousOperator?: string;
  nextOperator?: string;
}

export interface OperatorConnectionsGuide {
  operator: Pick<OperatorSummary, "slug" | "name" | "displayName" | "category">;
  inputs: OperatorConnectionEntry[];
  outputs: OperatorConnectionEntry[];
  relatedOperators: string[];
  workflowPatterns: string[];
  workflowHits: OperatorWorkflowHit[];
  usage?: string;
  notes?: string;
}

export interface OperatorWorkflowSuggestion {
  operator: string;
  reason: string;
  confidence: number;
  source: "commonOutput" | "workflowPattern" | "relatedOperator";
  portHint?: string;
  complexity: "simple" | "medium" | "complex";
  estimatedNodes: string;
  minVersion: string;
  patternId?: string;
  useCase?: string;
}

export interface OperatorCodeExample {
  title: string;
  language?: string;
  code: string;
  description?: string;
}

export interface OperatorExamplesGuide {
  operator: Pick<OperatorSummary, "slug" | "name" | "displayName" | "category">;
  pythonExamples: OperatorCodeExample[];
  codeExamples: OperatorCodeExample[];
  expressions: OperatorCodeExample[];
  usagePatterns: OperatorCodeExample[];
  usage?: string;
  tips: string[];
}

export interface PythonMember {
  name?: string;
  id?: string;
  returnType?: string;
  readOnly?: boolean;
  description?: string;
}

export interface PythonMethodParam {
  name?: string;
  type?: string;
}

export interface PythonMethod {
  name?: string;
  parameters?: PythonMethodParam[];
  returns?: string;
  signature?: string;
  description?: string;
}

export interface PythonClass {
  className: string;
  displayName?: string;
  description?: string;
  category?: string;
  members?: PythonMember[];
  methods?: PythonMethod[];
}

export interface PythonClassSummary {
  className: string;
  displayName: string;
  category: string;
  methodCount: number;
  memberCount: number;
}

export interface Pattern {
  id: string;
  name: string;
  description?: string;
  category?: string;
  workflow?: string[];
  use_case?: string;
}

export interface PatternSummary {
  id: string;
  name: string;
  category: string;
  description: string;
}

export interface GlslCode {
  language?: string;
  filename?: string;
  snippet?: string;
}

export interface GlslTechnique {
  id: string;
  name: string;
  subcategory?: string;
  description?: string;
  difficulty?: string;
  operators?: string[];
  tags?: string[];
  notes?: string;
  code?: GlslCode;
  setup?: string;
}

export interface GlslSummary {
  id: string;
  name: string;
  description: string;
  difficulty: string;
}

export interface Tutorial {
  id: string;
  name: string;
  displayName?: string;
  category?: string;
  subcategory?: string;
  description?: string;
  summary?: string;
  content?: string;
  keywords?: string[];
  tags?: string[];
}

export interface TutorialSummary {
  id: string;
  name: string;
  category: string;
  summary: string;
}

export interface KnowledgeStats {
  source: "local" | "bottobot" | "empty";
  operators: number;
  pythonClasses: number;
  patterns: number;
  glsl: number;
  tutorials: number;
  tdVersions?: number;
  releaseHighlights?: number;
  operatorCompatibility?: number;
  pythonApiCompatibility?: number;
  experimentalBuildSeries?: number;
  techniquePacks?: number;
  techniques?: number;
  tdClasses?: number;
}

export interface TechniqueCode {
  language?: string;
  filename?: string;
  snippet?: string;
}

export interface TechniqueWorkflow {
  description?: string;
  chain?: string[];
  steps?: string[];
}

export interface TouchDesignerTechnique {
  id: string;
  name: string;
  subcategory?: string;
  description?: string;
  difficulty?: string;
  operators?: string[];
  tags?: string[];
  notes?: string;
  requiresVersion?: string;
  code?: TechniqueCode;
  workflow?: TechniqueWorkflow;
}

export interface TouchDesignerTechniquePack {
  category: string;
  displayName: string;
  description?: string;
  versionRequirement?: string;
  techniques: TouchDesignerTechnique[];
  resources?: unknown;
}

export interface TechniquePackSummary {
  id: string;
  name: string;
  description?: string;
  count?: number;
}

export interface TechniqueSearchSummary {
  id: string;
  name: string;
  description?: string;
}

export interface TouchDesignerClassReference {
  id: string;
  name: string;
  displayName?: string;
  category?: string;
  subcategory?: string;
  type?: string;
  description?: string;
  summary?: string;
  url?: string;
  usage?: string;
  tips?: string[];
  warnings?: string[];
  relatedOperators?: string[];
  workflowPatterns?: string[];
  keywords?: string[];
  tags?: string[];
}

export interface TouchDesignerClassSummary {
  id: string;
  name: string;
  description?: string;
}

export interface TdVersionInfo {
  id: string;
  label: string;
  majorVersion?: number;
  buildRange?: { min?: number; max?: number | null };
  releaseYear?: number;
  pythonVersion?: string;
  pythonMajorMinor?: string;
  supportStatus?: string;
  notes?: string;
}

export interface TdVersionManifest {
  schemaVersion?: string;
  description?: string;
  versions: TdVersionInfo[];
  versionOrder?: string[];
  currentStable?: string;
  pythonVersionMap?: Record<string, string>;
}

export interface TdReleaseHighlight {
  label?: string;
  releaseYear?: number;
  theme?: string;
  highlights: string[];
  newOperators: string[];
  pythonHighlights: string[];
  breakingChanges: string[];
}

export interface TdReleaseHighlights {
  schemaVersion?: string;
  description?: string;
  releases: Record<string, TdReleaseHighlight>;
}

export interface TdCompatibilityChange {
  version: string;
  change: string;
}

export interface TdOperatorCompatibility {
  name: string;
  category?: string;
  addedIn?: string;
  changedIn?: TdCompatibilityChange[];
  removedIn?: string | null;
  notes?: string;
}

export interface TdOperatorCompatibilityIndex {
  schemaVersion?: string;
  description?: string;
  operators: Record<string, TdOperatorCompatibility>;
}

export interface TdPythonApiCompatibilityEntry {
  class: string;
  name: string;
  kind: "method" | "member";
  signature?: string;
  addedIn?: string;
  changedIn?: TdCompatibilityChange[];
  description?: string;
}

export interface TdPythonApiCompatibilityClass {
  description?: string;
  addedIn?: string;
  methods?: Record<string, Omit<TdPythonApiCompatibilityEntry, "class" | "name" | "kind">>;
  members?: Record<string, Omit<TdPythonApiCompatibilityEntry, "class" | "name" | "kind">>;
}

export interface TdPythonApiCompatibilityIndex {
  schemaVersion?: string;
  description?: string;
  classes: Record<string, TdPythonApiCompatibilityClass>;
}

export interface TdExperimentalBuildOperator {
  name: string;
  family?: string;
  status?: string;
  description?: string;
  notes?: string;
}

export interface TdExperimentalBuildSeries {
  seriesId: string;
  label: string;
  buildRange?: { min?: number; max?: number | null };
  basedOnStable?: string;
  releaseYear?: number;
  stabilityStatus?: string;
  stabilityNotes?: string;
  featureFlags?: Record<string, boolean>;
  newFeatures?: string[];
  experimentalOperators?: TdExperimentalBuildOperator[];
  breakingChangesVsStable?: string[];
  pythonApiAdditions?: Array<Record<string, unknown>>;
  featureAreas?: string[];
}

export interface TdExperimentalBuilds {
  schemaVersion?: string;
  description?: string;
  trackInfo?: Record<string, string>;
  currentExperimentalSeries?: string;
  buildSeries: TdExperimentalBuildSeries[];
}
