export interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

export interface CoverageSummaryFile {
  lines: CoverageMetric;
  statements: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
}

export type CoverageSummary = Record<string, CoverageSummaryFile> & {
  total: CoverageSummaryFile;
};

export interface CoverageHarnessOptions {
  limit: number;
  minLines?: number;
  output: string;
  summaryOnly: boolean;
}

export interface CoverageRow {
  file: string;
  lines: CoverageMetric;
  statements: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
}

export interface CoverageSurfaceSummary {
  surface: string;
  files: number;
  covered: number;
  total: number;
  missing: number;
  pct: number;
  topFiles: CoverageRow[];
}

export function parseArgs(argv: string[]): CoverageHarnessOptions;
export function fileRows(summary: CoverageSummary): CoverageRow[];
export function summarizeSurfaces(rows: CoverageRow[]): CoverageSurfaceSummary[];
export function makeMarkdown(
  summary: CoverageSummary,
  rows: CoverageRow[],
  options: Pick<CoverageHarnessOptions, "limit">,
): string;
export function main(argv?: string[]): number;
