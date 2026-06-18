/**
 * Build the optional "try Project RAG too" stderr tip shown after a
 * `tdmcp creative-rag search` run that returned few results.
 *
 * Returns `undefined` (so the caller can simply skip writing) when:
 *   - JSON output mode is on (`--json`), OR
 *   - Project RAG is not enabled (TDMCP_PROJECT_RAG_ENABLED unset/0), OR
 *   - the result count is above the threshold (default 2), OR
 *   - the query is empty/whitespace.
 *
 * The tip is informational only; it never alters search behavior.
 */
export interface CrossLinkOptions {
  query: string;
  resultCount: number;
  projectRagEnabled: boolean;
  json: boolean;
  threshold?: number;
}

const DEFAULT_THRESHOLD = 2;

export function buildProjectRagCrossLinkTip(opts: CrossLinkOptions): string | undefined {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  if (opts.json) return undefined;
  if (!opts.projectRagEnabled) return undefined;
  if (opts.resultCount > threshold) return undefined;
  const trimmed = opts.query.trim();
  if (trimmed.length === 0) return undefined;
  const quoted = `"${trimmed.replace(/"/g, '\\"')}"`;
  return `tip: also try \`tdmcp project-rag search ${quoted}\` — more sources may match in the local project repertoire.`;
}
