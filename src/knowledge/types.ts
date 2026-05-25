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
  commonInputs?: unknown;
  commonOutputs?: unknown;
  relatedOperators?: string[];
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
}
